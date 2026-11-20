/** Actual WS(S) + HTTP(S) requests. A protocol benchmark, not a browser/renderer test. */
import { campaignFixture } from "./campaignFixture";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  generateIdentity,
  signText,
  type Identity,
} from "../../src/net/identity";
import {
  authPayload,
  STRATEGIC_API,
  STRATEGIC_PROTOCOL,
  STRATEGIC_VIEW_TYPE,
  STRATEGIC_PATCH_TYPE,
  VIEW_PREFIX_BYTES,
  type Baseline,
  type Command,
  type Head,
  type Receipt,
  type RoomOrder,
  type ServerMessage,
} from "../../src/core/strategicRoom/protocol";
import {
  decodeView,
  VIEW_ATTEMPTS,
  viewPublicationDelay,
  viewRetryDelay,
} from "../../src/core/strategicRoom/viewWire";

const [, , endpoint, credentials, turnsArg = "1", work = "mixed", countArg] =
  process.argv;
if (!endpoint || !credentials)
  throw new Error(
    "Pass origin, invite-file path, turn count, workload, and optionally number of commanders.",
  );
const origin = new URL(endpoint).origin;
const localCampaign = credentials === "--local-campaign";
const saved = localCampaign
  ? null
  : (JSON.parse(await readFile(credentials, "utf8")) as {
      invites: Record<string, string>;
    });
const count = Number(countArg ?? Object.keys(saved?.invites ?? {}).length - 1);
const turns = Number(turnsArg);
const viewMode = process.env.STRATEGIC_LOAD_VIEW ?? "compact";
if (viewMode !== "json" && viewMode !== "compact")
  throw new Error("STRATEGIC_LOAD_VIEW must be compact or json.");
const accept =
  viewMode === "compact" ? STRATEGIC_VIEW_TYPE : "application/json";
const reconnectCount = Number(process.env.STRATEGIC_LOAD_RECONNECT ?? 0);
/**
 * How many peers fully decode a published baseline before its apply time stops counting. 500 clients
 * in one process share two CPUs, so 500 concurrent inflates would measure this sandbox, not a
 * browser. The rest still fetch and validate the response prefix (status, type, metadata head and a
 * non-empty marker table). 0 decodes all.
 */
const decodeSample = Number(process.env.STRATEGIC_LOAD_DECODE_SAMPLE ?? 0);
if (
  !Number.isInteger(decodeSample) ||
  decodeSample < 0 ||
  decodeSample > 500 ||
  !Number.isInteger(reconnectCount) ||
  reconnectCount < 0 ||
  reconnectCount > Math.min(50, count - 1) ||
  !Number.isInteger(turns) ||
  turns < 1 ||
  turns > 500 ||
  !Number.isInteger(count) ||
  count < 2 ||
  count > 500 ||
  !["idle", "mixed", "march", "contact", "dense"].includes(work)
)
  throw new Error("Invalid workload, commander count or turn count.");
const fixture = localCampaign
  ? await campaignFixture(
      origin,
      count,
      Number(process.env.STRATEGIC_LOAD_UNITS ?? 10),
      work,
    )
  : null;
const api = (fixture?.path ?? "") + STRATEGIC_API;
const invites = fixture?.invites ?? saved?.invites ?? {};
const report = (data: Record<string, unknown>) =>
  console.log(JSON.stringify(data));
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * p) - 1)
  ] ?? null;
/** The gate is per turn, so a run of turns is summarized by its worst turn, not its last. */
type TurnSample = {
  turn: number;
  ackP95: number | null;
  closeP95: number | null;
  noticeApplyP95: number | null;
  viewFailed: number;
  defaultPayloadBytesP95: number | null;
};
const summary: TurnSample[] = [];
let lagMax = 0;
const worst = (key: keyof TurnSample) =>
  summary.reduce<number | null>(
    (max, s) =>
      typeof s[key] === "number" && (max === null || s[key] > max)
        ? (s[key] as number)
        : max,
    null,
  );

class Peer {
  private socket: WebSocket | undefined;
  private bearer = "";
  private epoch = "";
  private seq = 0;
  head: Head | undefined;
  headAt = 0;
  bytes = 0;
  viewBytes = 0;
  viewRetries = 0;
  httpEncodedBytes = 0;
  /** Time spent turning an already-received body into a Baseline (no network). */
  decodeMs = 0;
  private stopped = false;
  closedAt = 0;
  closeCode = 0;
  closeReason = "";
  private wake = new Set<() => void>();
  private receivers = new Map<string, (receipt: Receipt) => void>();

  constructor(
    readonly slot: string,
    private readonly identity: Identity,
    private invite: string | undefined,
  ) {}

  async connect() {
    this.close();
    this.head = undefined;
    this.seq = 0;
    this.stopped = false;
    const socket = (this.socket = new WebSocket(
      `${origin.replace(/^http/, "ws")}${api}/socket`,
      STRATEGIC_PROTOCOL,
      { origin },
    ));
    socket.on("error", (error) =>
      console.error(`peer ${this.slot} socket`, String(error.message ?? error)),
    );
    socket.on("close", (code, reason) => {
      if (this.socket === socket) {
        this.stopped = true;
        this.closedAt = performance.now();
        this.closeCode = code;
        this.closeReason = String(reason);
        this.notify();
      }
    });
    socket.on("message", (payload) => {
      // A replaced (or shed) socket can still deliver frames it buffered. They belong to the
      // previous session, so ignore them instead of treating them as a continuity break.
      if (this.socket !== socket) return;
      this.bytes += Buffer.byteLength(payload.toString());
      const m = JSON.parse(payload.toString()) as ServerMessage;
      if (m.kind === "challenge") {
        void signText(this.identity, authPayload(m.room, origin, m.nonce))
          .then((signature) =>
            socket.send(
              JSON.stringify({
                kind: "auth",
                publicKey: this.identity.publicKeyHex,
                signature,
                ...(this.invite ? { invite: this.invite } : {}),
              }),
            ),
          )
          .catch(() => socket.terminate());
      } else if (m.kind === "welcome") {
        this.epoch = m.epoch;
        this.bearer = m.bearer;
        this.invite = undefined;
      } else if (m.kind === "head") {
        if (m.epoch !== this.epoch || m.seq !== ++this.seq) {
          console.error(
            `peer ${this.slot} head continuity ${m.epoch === this.epoch} ${m.seq} ${this.seq}`,
          );
          socket.terminate();
          return;
        }
        this.head = m.head;
        this.headAt = performance.now();
        this.notify();
      } else if (m.kind === "receipt") this.receivers.get(m.requestId)?.(m);
    });
    await this.waitHead(() => true);
  }
  private notify() {
    for (const cb of this.wake) cb();
  }
  waitHead(accept: (head: Head) => boolean): Promise<Head> {
    // Several probes intentionally stop waiting on a peer (a shed socket, a superseded round).
    // An abandoned waiter must not become an unhandled rejection that ends the generator.
    const pending = new Promise<Head>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.wake.delete(check);
      };
      const check = () => {
        if (this.stopped) {
          finish();
          reject(new Error(`Peer ${this.slot} disconnected.`));
        } else if (this.head && accept(this.head)) {
          finish();
          resolve(this.head);
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`Waiting for ${this.slot} head timed out.`));
      }, 45_000);
      this.wake.add(check);
      check();
    });
    void pending.catch(() => undefined);
    return pending;
  }
  command(cmd: Command): Promise<Receipt> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error(`Peer ${this.slot} disconnected.`));
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        this.receivers.delete(cmd.requestId);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`Waiting for ${this.slot} receipt timed out.`));
      }, 8000);
      this.receivers.set(cmd.requestId, (r) => {
        finish();
        resolve(r);
      });
      socket.send(JSON.stringify(cmd));
    });
  }
  /** Fetch without inflating the marker table; validates the same response contract cheaply. */
  async viewHead(): Promise<{
    version: number;
    epoch: string;
    markerBytes: number;
  }> {
    for (let i = 0; i < VIEW_ATTEMPTS; i++) {
      const res = await fetch(`${origin}${api}/view`, {
        headers: { Authorization: `Bearer ${this.bearer}`, Accept: accept },
        signal: AbortSignal.timeout(6000),
      });
      const body = new Uint8Array(await res.arrayBuffer());
      this.httpEncodedBytes += Number(
        res.headers.get("content-length") ?? body.byteLength,
      );
      this.viewBytes += body.byteLength;
      if (res.ok) {
        const type = res.headers.get("content-type");
        if (viewMode === "compact") {
          if (type !== STRATEGIC_VIEW_TYPE)
            throw new Error("Not a compact view.");
          const sizes = new DataView(
            body.buffer,
            body.byteOffset,
            VIEW_PREFIX_BYTES,
          );
          const metaBytes = sizes.getUint32(0);
          const meta = JSON.parse(
            new TextDecoder().decode(
              body.subarray(VIEW_PREFIX_BYTES, VIEW_PREFIX_BYTES + metaBytes),
            ),
          ) as { epoch: string; head: Head };
          if (this.slot !== "gm" && meta.epoch !== this.epoch)
            throw new Error("View epoch mismatch.");
          return {
            version: meta.head.version,
            epoch: meta.epoch,
            markerBytes: sizes.getUint32(4),
          };
        }
        const v = JSON.parse(new TextDecoder().decode(body)) as Baseline;
        return {
          version: v.head.version,
          epoch: v.epoch,
          markerBytes: v.markers.length,
        };
      }
      this.viewRetries++;
      if (i + 1 === VIEW_ATTEMPTS)
        return { version: -1, epoch: "", markerBytes: 0 };
      await sleep(viewRetryDelay(i));
    }
    return { version: -1, epoch: "", markerBytes: 0 };
  }
  markerChangesApplied = 0;
  async view(base?: Baseline): Promise<Baseline> {
    const changes =
      viewMode === "compact" &&
      base?.epoch === this.epoch &&
      process.env.STRATEGIC_LOAD_FULL_VIEWS !== "1" &&
      base !== undefined;
    const url =
      `${origin}${api}/view` +
      (changes ? `?markersVersion=${base.head.version}` : "");
    for (let i = 0; i < VIEW_ATTEMPTS; i++) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.bearer}`,
          Accept: changes ? STRATEGIC_PATCH_TYPE : accept,
        },
        signal: AbortSignal.timeout(6000),
      });
      const body = new Uint8Array(await res.arrayBuffer());
      this.httpEncodedBytes += Number(
        res.headers.get("content-length") ?? body.byteLength,
      );
      this.viewBytes += body.byteLength;
      if (res.ok) {
        const type = res.headers.get("content-type");
        if (
          viewMode === "compact" &&
          type !== STRATEGIC_VIEW_TYPE &&
          !(changes && type === STRATEGIC_PATCH_TYPE)
        )
          throw new Error("Server did not send a compact view.");
        const decodeStart = performance.now();
        const v = await decodeView(body, type, base);
        if (type === STRATEGIC_PATCH_TYPE) this.markerChangesApplied++;
        this.decodeMs += performance.now() - decodeStart;
        const expected = fixture?.roster.get(this.slot);
        if (
          v.epoch !== this.epoch ||
          (expected &&
            (expected.size !== v.own.length ||
              new Set(v.own.map((u) => u.id)).size !== expected.size)) ||
          (this.slot !== "gm" &&
            v.own.some((u) =>
              expected
                ? !expected.has(u.id)
                : !u.id.startsWith(`unit-${this.slot.split("-")[1]}-`),
            ))
        )
          throw new Error("View escaped its authority.");
        return v;
      }
      if (![409, 429, 503].includes(res.status))
        throw new Error(`View rejected with ${res.status}.`);
      this.viewRetries++;
      await sleep(viewRetryDelay(i));
    }
    throw new Error("View stayed unavailable.");
  }
  close() {
    this.socket?.terminate();
    this.socket = undefined;
    this.bearer = "";
  }
  get currentEpoch() {
    return this.epoch;
  }
  /** Stop reading the transport, like a tab that stopped draining its socket. */
  stall() {
    const raw = (this.socket as unknown as { _socket?: { pause(): void } })
      ?._socket;
    raw?.pause();
    return Boolean(raw);
  }
  /** One unretried view fetch; 401 means this session is no longer admitted. */
  async probeStatus(): Promise<number> {
    try {
      const res = await fetch(`${origin}${api}/view`, {
        headers: { Authorization: `Bearer ${this.bearer}`, Accept: accept },
        signal: AbortSignal.timeout(5000),
      });
      await res.arrayBuffer();
      return res.status;
    } catch {
      return 0;
    }
  }
  /**
   * Wait until the room sheds this session. Its socket is paused, so it cannot answer heartbeats
   * or drain frames; the observable proof is that its own bearer stops being admitted.
   */
  async waitShed(timeoutMs: number) {
    const start = performance.now();
    for (;;) {
      if ((await this.probeStatus()) === 401) return performance.now() - start;
      if (performance.now() - start > timeoutMs) return null;
      await sleep(500);
    }
  }
  resume() {
    (
      this.socket as unknown as { _socket?: { resume(): void } } | undefined
    )?._socket?.resume();
  }
}

/** Half-extent of a deployed line plus the 15-ft march, so no model leaves the field. */
const MARCH_MARGIN = 45;

function orders(view: Baseline, player: number): Command {
  const enemyPlayer = ((player - 1) ^ 1) + 1;
  const markers = new Set(view.markers.map((m) => m.id));
  const unitEdits = view.own.map((u, i) => {
    const paired = `unit-${enemyPlayer}-${i + 1}`;
    let order: RoomOrder | null = u.alive
      ? { kind: "hold", stance: "hold" }
      : null;
    if (u.alive && u.at) {
      if (work === "march" || (work === "mixed" && i % 5 === 1)) {
        const x = Math.max(
          view.bounds.minX + MARCH_MARGIN,
          Math.min(
            view.bounds.maxX - MARCH_MARGIN,
            u.at.x + (player % 2 === 1 ? 10 : -10),
          ),
        );
        const y = Math.max(
          view.bounds.minY + MARCH_MARGIN,
          Math.min(view.bounds.maxY - MARCH_MARGIN, u.at.y - 15),
        );
        // Clamping the centroid is not enough: the authority checks every model, and a line
        // formation reaches ~25 ft from its centroid. Without this margin a legal-looking march
        // near the edge is refused (invalid_order), which would masquerade as order loss.
        if (Math.hypot(x - u.at.x, y - u.at.y) >= 1)
          order = { kind: "move", pace: "march", path: [{ x, y }] };
      }
      if (
        (work === "dense" ||
          work === "contact" ||
          (work === "mixed" && [0, 2].includes(i % 5))) &&
        markers.has(paired)
      ) {
        order = { kind: "attack", targetUnitId: paired, mode: u.weapon };
      }
    }
    return { unitId: u.id, order };
  });
  return {
    kind: "orders.submit",
    requestId: randomUUID(),
    turnId: view.head.turnId,
    expectedRevision: view.orders.revision,
    unitEdits,
  };
}

const peers: Peer[] = [];
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
try {
  const start = performance.now();
  for (let i = 0; i <= count; i += 24) {
    await Promise.all(
      Array.from({ length: Math.min(24, count + 1 - i) }, async (_, j) => {
        const index = i + j,
          slot = index === 0 ? "gm" : `commander-${index}`;
        const code = invites[slot];
        if (!code && !(index === 0 && fixture))
          throw new Error(`A fresh demo invite is required for ${slot}.`);
        const peer = (peers[index] = new Peer(
          slot,
          index === 0 && fixture ? fixture.gm : await generateIdentity(),
          code,
        ));
        await peer.connect();
      }),
    );
  }
  const gm = peers[0];
  if (!gm) throw new Error("GM missing");
  const players = peers.slice(1);
  report({
    stage: "connected",
    peers: peers.length,
    elapsedMs: performance.now() - start,
    tls: origin.startsWith("https:"),
    viewMode,
    work,
  });
  for (let round = 0; round < turns; round++) {
    const head = await gm.waitHead((h) => h.phase === "orders");
    const views: Baseline[] = [];
    for (let i = 0; i < players.length; i += 32)
      views.push(
        ...(await Promise.all(players.slice(i, i + 32).map((p) => p.view()))),
      );
    const units = views.reduce((n, v) => n + v.own.length, 0);
    const modelCountBefore = views.reduce(
      (n, v) => n + v.own.reduce((t, u) => t + u.alive, 0),
      0,
    );
    const preOrders = players.map((peer, i) => {
      const view = views[i];
      if (!view) throw new Error("Missing view.");
      return {
        peer,
        cmd: orders(view, i + 1),
        bytes: peer.bytes,
        viewBytes: peer.viewBytes,
        encodedBytes: peer.httpEncodedBytes,
        decodedMs: peer.decodeMs,
        patches: peer.markerChangesApplied,
        base: process.env.STRATEGIC_LOAD_FULL_VIEWS === "1" ? undefined : view,
        retries: peer.viewRetries,
      };
    });
    // Only the immediately preceding authorized view is retained for change decoding;
    // no renderer/UI tree. The forced full-view control can release every old baseline.
    views.length = 0;
    const orderStart = performance.now();
    const acks = await Promise.all(
      preOrders.map(async ({ peer, cmd }, i) => {
        if (process.env.STRATEGIC_LOAD_SPREAD_MS)
          await sleep(
            (i / count) * Number(process.env.STRATEGIC_LOAD_SPREAD_MS),
          );
        const sent = performance.now();
        const ack = await peer.command(cmd);
        return { ack, ms: performance.now() - sent };
      }),
    );
    const sample = preOrders[0];
    if (!sample || acks[0]?.ack.status !== "accepted")
      throw new Error("Sample order was not committed.");
    const resolving = performance.now();
    // A stalled reader must not stall the room: its own session is expendable, healthy peers are not.
    const stalled =
      process.env.STRATEGIC_LOAD_SLOW === "1" && round + 1 === turns
        ? players.at(-1)
        : undefined;
    if (stalled && !stalled.stall())
      throw new Error("Could not stall a player transport.");
    const close = await gm.command({
      kind: "turn.close",
      turnId: head.turnId,
      requestId: randomUUID(),
    });
    if (close.status !== "accepted")
      throw new Error(`Close not accepted: ${close.code}.`);
    const waits = players.map(async (peer, index) => {
      if (peer === stalled) return { at: 0, ms: NaN, rejoinMs: null };
      let rejoinMs: number | null = null;
      if (index >= players.length - reconnectCount) {
        await peer.waitHead(
          (h) => h.phase === "resolution" || h.version > head.version,
        );
        const disconnectedAt = performance.now();
        await peer.connect();
        const restored = await peer.view();
        const pre = preOrders[index];
        if (pre?.base) pre.base = restored;
        if (restored.head.version < head.version)
          throw new Error("Rejoined an obsolete version.");
        rejoinMs = performance.now() - disconnectedAt;
      }
      await peer.waitHead(
        (h) => h.version > head.version && h.phase === "report",
      );
      return { at: peer.headAt, ms: peer.headAt - resolving, rejoinMs };
    });
    // Settle every waiter now: a shed peer's late rejection must not escape as unhandled.
    const settled = await Promise.allSettled(waits);
    const notifications = settled.map((out, i) => {
      if (players[i] === stalled) return { at: 0, ms: NaN, rejoinMs: null };
      if (out.status === "rejected") throw out.reason;
      return out.value;
    });
    const closeSamples = notifications
      .filter((n, i) => n.rejoinMs === null && players[i] !== stalled)
      .map((n) => n.ms);
    const rejoinSamples = notifications.flatMap((n) =>
      n.rejoinMs === null ? [] : [n.rejoinMs],
    );
    const applicationStart = performance.now();
    const sampleEvery =
      decodeSample > 0 && decodeSample < players.length
        ? Math.ceil(players.length / decodeSample)
        : 0;
    const apply = await Promise.all(
      players.map(async (peer, i) => {
        if (peer === stalled) return { ms: 0, noticeMs: 0, ok: true };
        const notifiedAt = notifications[i]?.at ?? applicationStart;
        await sleep(viewPublicationDelay());
        let ok = false;
        const decoded = sampleEvery === 0 || i % sampleEvery === 0;
        try {
          ok = decoded
            ? (await peer.view(preOrders[i]?.base)).head.version > head.version
            : (await peer.viewHead()).version > head.version;
        } catch {
          // Count failed views in addition to the timings of successful views.
        }
        const appliedAt = performance.now();
        return {
          ms: appliedAt - applicationStart,
          noticeMs: appliedAt - notifiedAt,
          ok,
        };
      }),
    );
    const shedMs = stalled ? await stalled.waitShed(60_000) : null;
    let rejoinAfterShedMs: number | null = null;
    let rejoinAfterShedError: string | null = null;
    if (stalled) {
      if (shedMs === null) throw new Error("A stalled reader was never shed.");
      // The same identity must be able to rejoin and fetch a usable view again.
      const rejoinStart = performance.now();
      try {
        await stalled.connect();
        const recovered = await stalled.view();
        if (recovered.head.version < head.version)
          throw new Error("A rejoined reader got an obsolete view.");
        rejoinAfterShedMs = performance.now() - rejoinStart;
      } catch (error) {
        rejoinAfterShedError = `${String((error as Error).message ?? error)} [${stalled.closeCode} ${stalled.closeReason}]`;
      }
      stalled.resume();
    }
    const retry = await sample.peer.command(sample.cmd);
    const late = await sample.peer.command({
      ...sample.cmd,
      requestId: randomUUID(),
    });
    if (
      retry.status !== "accepted" ||
      late.status !== "rejected" ||
      late.code !== "turn_closed"
    )
      throw new Error("Receipt replay / late fence failed.");
    const first = acks[0]?.ack;
    if (
      !first ||
      first.status !== "accepted" ||
      retry.requestId !== first.requestId ||
      retry.revision !== first.revision ||
      retry.turnId !== first.turnId
    )
      throw new Error("Retry changed durable receipt.");
    const refused = acks.reduce<Record<string, number>>((out, { ack }) => {
      if (ack.status !== "rejected") return out;
      const key =
        ack.code === "invalid_order" && ack.detail
          ? `${ack.code}: ${ack.detail}`
          : ack.code;
      out[key] = (out[key] ?? 0) + 1;
      return out;
    }, {});
    const turnSample = {
      turn: head.turnId,
      ackP95: percentile(
        acks.map((a) => a.ms),
        0.95,
      ),
      closeP95: percentile(closeSamples, 0.95),
      noticeApplyP95: percentile(
        apply.filter((v) => v.ok).map((v) => v.noticeMs),
        0.95,
      ),
      viewFailed: apply.filter((v) => !v.ok).length,
      defaultPayloadBytesP95: percentile(
        preOrders.map(
          (p) =>
            p.peer.bytes - p.bytes + p.peer.httpEncodedBytes - p.encodedBytes,
        ),
        0.95,
      ),
    };
    summary.push(turnSample);
    report({
      stage: "turn",
      turn: head.turnId,
      count,
      work,
      units,
      modelCountBefore,
      refused,
      burstMs: resolving - orderStart,
      ackP95: turnSample.ackP95,
      ackP99: percentile(
        acks.map((a) => a.ms),
        0.99,
      ),
      closeP95: turnSample.closeP95,
      closeP99: percentile(closeSamples, 0.99),
      rejoined: rejoinSamples.length,
      rejoinP95: percentile(rejoinSamples, 0.95),
      viewApplyP95: percentile(
        apply.filter((v) => v.ok).map((v) => v.ms),
        0.95,
      ),
      noticeApplyP95: turnSample.noticeApplyP95,
      viewFailed: turnSample.viewFailed,
      markerChangesApplied: preOrders.reduce(
        (n, p) => n + p.peer.markerChangesApplied - p.patches,
        0,
      ),
      viewRetries: preOrders.reduce(
        (n, p) => n + p.peer.viewRetries - p.retries,
        0,
      ),
      wsBytesP95: percentile(
        preOrders.map((p) => p.peer.bytes - p.bytes),
        0.95,
      ),
      httpBodyBytesP95: percentile(
        preOrders.map((p) => p.peer.viewBytes - p.viewBytes),
        0.95,
      ),
      httpEncodedBytesP95: percentile(
        preOrders.map((p) => p.peer.httpEncodedBytes - p.encodedBytes),
        0.95,
      ),
      defaultPayloadBytesP95: turnSample.defaultPayloadBytesP95,
      // 500 clients share this sandbox's CPUs, so decode time is aggregate throughput, not
      // what one browser on its own machine would spend. Reported to keep apply interpretable.
      viewDecodeMsP95: percentile(
        preOrders.map((p) => p.peer.decodeMs - p.decodedMs),
        0.95,
      ),
      viewDecodeMsSum: preOrders.reduce(
        (n, p) => n + p.peer.decodeMs - p.decodedMs,
        0,
      ),
      stalledPeerShedMs: shedMs,
      stalledPeerRejoinMs: rejoinAfterShedMs,
      stalledPeerRejoinError: rejoinAfterShedError,
      stalledPeerEpoch: stalled?.currentEpoch ?? null,
      generatorLagP95: lag.percentile(95) / 1e6,
      generatorLagMaxP95: lagMax,
      ackSamples: acks.map((a) => a.ms),
      applySamples: apply.map((a) => a.ms),
    });
    if (fixture && (Object.keys(refused).length || turnSample.viewFailed))
      throw new Error("Campaign load gate: order refusals or missing views.");
    lagMax = Math.max(lagMax, lag.percentile(95) / 1e6);
    lag.reset();
    if (round + 1 < turns) {
      const next = await gm.command({
        kind: "turn.next",
        turnId: head.turnId,
        requestId: randomUUID(),
        durationMs: null,
      });
      if (next.status !== "accepted")
        throw new Error("Could not open next turn.");
      await Promise.all(
        players.map((p) =>
          p.waitHead(
            (h) => h.turnId === head.turnId + 1 && h.phase === "orders",
          ),
        ),
      );
    }
  }
  await fixture?.audit(turns);
  report({
    stage: "summary",
    turns: summary.length,
    work,
    viewMode,
    worstAckP95: worst("ackP95"),
    worstCloseP95: worst("closeP95"),
    worstNoticeApplyP95: worst("noticeApplyP95"),
    viewFailures: summary.reduce((n, s) => n + s.viewFailed, 0),
    worstDefaultPayloadBytesP95: worst("defaultPayloadBytesP95"),
    generatorLagMaxP95: lagMax,
  });
} finally {
  lag.disable();
  for (const p of peers) p?.close();
  if (fixture) await fixture.finish();
}
