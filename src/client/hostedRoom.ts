import {
  authPayload,
  MAX_FRAME,
  STRATEGIC_API,
  STRATEGIC_PROTOCOL,
  STRATEGIC_VIEW_TYPE,
  STRATEGIC_PATCH_TYPE,
  type Baseline,
  type Command,
  type Head,
  type ModelMarker,
  type Receipt,
  type RegionPatch,
  type ReportPage,
  type ServerMessage,
} from "../core/strategicRoom/protocol";
import {
  MissingViewMarkers,
  readView,
  VIEW_ATTEMPTS,
  viewPublicationDelay,
  viewRetryDelay,
} from "../core/strategicRoom/viewWire";
import {
  hostedTurnProgress,
  type TurnProgressStage,
} from "../core/turnProgress";
import { RegionReplica } from "../core/strategicRoom/regionReplica";
import { signText, type Identity } from "../net/identity";

export type HostedState = {
  view: Baseline | null;
  head: Head | null;
  progress: TurnProgressStage | null;
  models: ReadonlyMap<string, ModelMarker>;
  truncated: boolean;
  busy: boolean;
  notice: string;
  receipt: Receipt | null;
};

/** Opt-in adapter at the hosted wire boundary. It never accepts a legacy Snapshot/OpLog. */
export class HostedRoomClient {
  private socket: WebSocket | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 250;
  private requestLifetime = new AbortController();
  private viewRequest: AbortController | undefined;
  private pending: Command | null = null;
  private bearer = "";
  private epoch = "";
  private seq = 0;
  private head: Head | null = null;
  private closingTurn: number | null = null;
  private invite = "";
  private stopped = false;
  private denied = false;
  private tile: { x: number; y: number } | null = null;
  private readonly region = new RegionReplica();
  private regionTask: WebSocket | null = null;
  private wantedRegion = 0;
  private state: HostedState = {
    view: null,
    head: null,
    progress: null,
    models: new Map(),
    truncated: false,
    busy: false,
    notice: "Join with a commander or GM invite.",
    receipt: null,
  };

  constructor(
    private readonly identity: Identity,
    private readonly change: (state: HostedState) => void,
    private readonly apiRoot = STRATEGIC_API,
  ) {}

  private update(change: Partial<HostedState>) {
    const next = { ...this.state, ...change };
    this.state = {
      ...next,
      head: this.head,
      progress: hostedTurnProgress(
        this.head,
        next.view?.head ?? null,
        this.closingTurn !== null &&
          (this.head === null || this.closingTurn === this.head.turnId),
      ),
    };
    this.change(this.state);
  }

  join(invite = "") {
    this.stopSocket();
    this.invite = invite.trim();
    this.stopped = false;
    this.denied = false;
    this.retryDelay = 250;
    this.connect();
  }

  private connect() {
    if (this.stopped || this.denied) return;
    const url = new URL(`${this.apiRoot}/socket`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.socket = new WebSocket(url, STRATEGIC_PROTOCOL));
    this.update({ notice: "Connecting…", view: null });
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      void this.read(socket, event.data as string).catch(() => socket.close());
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.clearView();
      this.socket = undefined;
      if (event.code === 4001) {
        // A GM kick ends this live session only: a fresh challenge resumes the same seat.
        this.update({
          notice: "The GM disconnected this session. Rejoining…",
        });
      }
      if (!this.stopped && !this.denied) {
        this.update({ notice: "Disconnected. Rejoining…" });
        this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 5000);
      }
    };
  }

  private async read(socket: WebSocket, raw: string) {
    const message = JSON.parse(raw) as ServerMessage;
    switch (message.kind) {
      case "challenge": {
        const signature = await signText(
          this.identity,
          authPayload(message.room, location.origin, message.nonce),
        );
        if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              kind: "auth",
              publicKey: this.identity.publicKeyHex,
              signature,
              ...(this.invite ? { invite: this.invite } : {}),
            }),
          );
        }
        break;
      }
      case "welcome":
        this.epoch = message.epoch;
        this.denied = false;
        this.bearer = message.bearer;
        this.invite = "";
        this.seq = 0;
        this.retryDelay = 250;
        this.region.clear(this.epoch);
        this.update({ notice: "Loading authorized view…" });
        if (this.pending) this.sendPending();
        break;
      case "head": {
        if (message.epoch !== this.epoch || message.seq !== this.seq + 1) {
          socket.close();
          return;
        }
        this.seq = message.seq;
        this.head = message.head;
        if (message.head.phase !== "orders") this.closingTurn = null;
        const view = this.state.view;
        // Phase-only heads don't need a new battlefield or discard the displayed map.
        // A roster/control change keeps the same version but invalidates `own` and the GM roster.
        if (
          view &&
          view.head.version === message.head.version &&
          view.head.turnId === message.head.turnId &&
          (view.head.members ?? 0) === (message.head.members ?? 0)
        ) {
          this.update({ view: { ...view, head: message.head } });
        } else {
          this.update({}); // The headline can render while fetching a new durable version.
          this.refresh();
        }
        break;
      }
      case "receipt": {
        const command = this.pending;
        if (command?.requestId !== message.requestId) return;
        if (message.status === "rejected") this.closingTurn = null;
        if (
          message.status === "accepted" ||
          (message.code !== "unavailable" && message.code !== "busy")
        )
          this.pending = null;
        this.update({
          receipt: message,
          busy: false,
          notice: message.status === "accepted" ? "Connected" : message.detail,
        });
        if (message.status === "accepted" && command.kind === "orders.submit") {
          const view = this.state.view;
          if (
            view &&
            view.head.turnId === message.turnId &&
            message.revision !== undefined &&
            message.revision > view.orders.revision
          ) {
            if (view.orders.revision === command.expectedRevision) {
              // The private durable ACK is the delta; don't reload the battlefield per order.
              const orders = new Map(
                view.orders.edits.map((edit) => [edit.unitId, edit]),
              );
              for (const edit of command.unitEdits) {
                if (edit.order === null) orders.delete(edit.unitId);
                else orders.set(edit.unitId, edit);
              }
              this.update({
                view: {
                  ...view,
                  orders: {
                    revision: message.revision,
                    edits: [...orders.values()],
                  },
                },
              });
            } else this.refresh();
          }
        } else if (
          message.status === "rejected" &&
          message.code === "stale_revision"
        )
          this.refresh();
        break;
      }
      case "error":
        if (message.code === "not_admitted") {
          this.denied = true;
          this.invite = "";
          this.pending = null;
          this.update({
            notice: this.state.view
              ? "Not admitted. Membership may be revoked, or the invite may be invalid or expired."
              : "Not admitted. Membership may be revoked, the invite may be invalid or expired, or another browser holds this seat.",
            receipt: null,
            busy: false,
          });
        }
        break;
    }
  }

  private clearView() {
    this.bearer = "";
    this.epoch = "";
    this.head = null;
    this.closingTurn = null;
    this.viewRequest?.abort();
    this.requestLifetime.abort();
    this.requestLifetime = new AbortController();
    this.region.clear("");
    this.update({
      view: null,
      models: this.region.models,
      truncated: false,
      busy: false,
      receipt: null,
    });
  }

  private stopSocket() {
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.clearView();
  }

  close() {
    this.stopped = true;
    this.pending = null;
    this.stopSocket();
  }

  private async request(
    path: string,
    signal = this.requestLifetime.signal,
    accept = "application/json",
  ) {
    const res = await fetch(`${this.apiRoot}${path}`, {
      signal,
      cache: "no-store",
      headers: { Authorization: `Bearer ${this.bearer}`, Accept: accept },
    });
    if (!res.ok) throw new Error(String(res.status));
    return res;
  }

  private async api<T>(path: string): Promise<T> {
    return (await (await this.request(path)).json()) as T;
  }

  private refresh() {
    this.viewRequest?.abort();
    const head = this.head;
    if (!head || !this.bearer) return;
    const signal = (this.viewRequest = new AbortController()).signal;
    const epoch = this.epoch;
    const socket = this.socket;
    const stopped = () => signal.aborted || epoch !== this.epoch;
    const previous = this.state.view;
    let base =
      previous?.epoch === epoch &&
      (previous.head.version === head.version ||
        previous.head.version + 1 === head.version)
        ? previous
        : undefined;
    const compact = typeof DecompressionStream === "function";
    void (async () => {
      if (previous && previous.head.version < head.version)
        await new Promise((resolve) =>
          setTimeout(resolve, viewPublicationDelay()),
        );
      // Database reads racing a publication may need a fresh baseline.
      for (let attempt = 0; attempt < VIEW_ATTEMPTS && !stopped(); attempt++) {
        try {
          const path =
            compact && base
              ? `/view?markersVersion=${base.head.version}`
              : "/view";
          const view = await readView(
            await this.request(
              path,
              signal,
              compact
                ? base && base.head.version < head.version
                  ? STRATEGIC_PATCH_TYPE
                  : STRATEGIC_VIEW_TYPE
                : undefined,
            ),
            base,
          );
          if (stopped()) return;
          if (view.epoch !== epoch) throw new Error("View epoch mismatch.");
          if (
            view.head.version < head.version ||
            view.head.turnId < head.turnId
          )
            throw new Error("409");
          // Do not backdate a phase-only notification overtaking an in-flight HTTPS response.
          const latest = this.head;
          if (
            latest &&
            view.head.turnId === latest.turnId &&
            view.head.version === latest.version
          )
            view.head = latest;
          const displayed = this.state.view;
          if (
            displayed?.head.turnId === view.head.turnId &&
            displayed.orders.revision > view.orders.revision
          )
            view.orders = displayed.orders;
          const receipt = this.state.receipt;
          if (
            receipt?.status === "accepted" &&
            receipt.turnId === view.head.turnId &&
            (receipt.revision ?? 0) > view.orders.revision
          )
            throw new Error("409");
          const models =
            this.region.version === view.head.version
              ? this.region.models
              : new Map<string, ModelMarker>();
          this.update({ view, models, notice: "Connected" });
          this.wantedRegion++;
          this.requestRegion();
          return;
        } catch (error) {
          if (stopped()) return;
          if (error instanceof MissingViewMarkers && base) {
            base = undefined;
            continue;
          }
          if (
            !(error instanceof Error) ||
            !["409", "429", "503"].includes(error.message)
          )
            break;
          await new Promise((resolve) =>
            setTimeout(resolve, viewRetryDelay(attempt)),
          );
        }
      }
      if (!stopped()) socket?.close();
    })();
  }

  submit(command: Command): boolean {
    if (!this.bearer || this.pending) return false;
    this.pending = command;
    if (this.sendPending()) return true;
    // Nothing reached the wire: unlike a missing durable receipt this is safe to discard.
    this.pending = null;
    this.update({
      busy: false,
      receipt: null,
      notice: "Order not sent. Connection busy; submit again.",
    });
    return false;
  }

  retry(): boolean {
    return this.pending !== null && this.sendPending();
  }

  private sendPending() {
    if (
      !this.pending ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > MAX_FRAME
    )
      return false;
    this.closingTurn =
      this.pending.kind === "turn.close" || this.pending.kind === "turn.retry"
        ? this.pending.turnId
        : null;
    this.socket.send(JSON.stringify(this.pending));
    this.update({ busy: true, receipt: null, notice: "Sending…" });
    return true;
  }

  selectRegion(tile: { x: number; y: number } | null) {
    if (this.tile?.x === tile?.x && this.tile?.y === tile?.y) return;
    this.tile = tile;
    this.region.clear(this.epoch);
    this.update({ models: this.region.models, truncated: false });
    this.wantedRegion++;
    this.requestRegion();
  }

  private requestRegion() {
    const tile = this.tile;
    const socket = this.socket;
    const view = this.state.view;
    if (!tile || !view || !socket || socket === this.regionTask) return;
    const epoch = this.epoch;
    const { version } = view.head;
    const task = this.wantedRegion;
    this.regionTask = socket;
    const latest = () =>
      task === this.wantedRegion &&
      epoch === this.epoch &&
      socket === this.socket;
    void (async () => {
      for (let attempt = 0; attempt < 3 && latest(); attempt++) {
        const params = new URLSearchParams({
          x: String(tile.x),
          y: String(tile.y),
          version: String(version),
        });
        if (this.region.cursor !== null)
          params.set("cursor", String(this.region.cursor));
        try {
          const patch = await this.api<RegionPatch>(`/region?${params}`);
          if (!latest()) return;
          if (this.region.apply(patch, version)) {
            this.update({
              models: this.region.models,
              truncated: patch.truncated,
            });
            return;
          }
          this.region.clear(epoch);
          this.update({ models: this.region.models });
        } catch (error) {
          if (!latest()) return;
          if (error instanceof Error && error.message === "401") {
            socket.close();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    })().finally(() => {
      if (this.regionTask === socket) this.regionTask = null;
      if (this.socket === socket && task !== this.wantedRegion)
        this.requestRegion();
    });
  }

  async report(version: number, page: number): Promise<ReportPage | null> {
    const epoch = this.epoch;
    const result = await this.api<ReportPage>(
      `/report?version=${version}&page=${page}`,
    );
    return result.epoch === epoch && epoch === this.epoch ? result : null;
  }
}
