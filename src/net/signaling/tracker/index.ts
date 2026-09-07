/**
 * §6.2 WebTorrent tracker adapter — swarm discovery via public WebSocket
 * trackers with info_hash = sha1(roomId) (spec-verbatim).
 *
 * Mapping (D-053): the tracker protocol forwards `offers` to swarm peers and
 * routes `answers` back to the offering peer — both opaque to the tracker, so
 * our §6.2 room-crypto code rides inside them untouched. Envelope identity
 * (from/to, authenticated) is independent of tracker peer_ids; the adapter
 * learns envelope-id → tracker-peer_id on first receipt and then routes
 * targeted sends as tracker `answers` (to_peer_id); unknown targets broadcast
 * as `offers`. The tracker only ever sees ciphertext + swarm ids.
 */
import type { PeerId } from "../../../core/ids";
import type { SignalingAdapter, SignalMsg } from "../../../core/net";
import { encryptSignalPayload } from "../crypto";
import { createEnvelopeSink } from "../dispatch";
import { browserRelaySocket, type RelaySocket, type RelaySocketFactory } from "../nostr";

export const DEFAULT_TRACKERS: readonly string[] = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
];

async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export interface TrackerAdapterOptions {
  trackers?: readonly string[];
  socket?: RelaySocketFactory;
  backoff?: { initialMs?: number; maxMs?: number; factor?: number };
}

interface TrackerConn {
  url: string;
  socket: RelaySocket | null;
  open: boolean;
  attempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

interface TrackerAnnounce {
  action?: string;
  info_hash?: string;
  peer_id?: string;
  offer?: unknown;
  offer_id?: string;
  answer?: unknown;
  to_peer_id?: string;
}

export class TrackerSignalingAdapter implements SignalingAdapter {
  readonly selfId: PeerId = globalThis.crypto.randomUUID();

  private readonly trackerUrls: readonly string[];
  private readonly socketFactory: RelaySocketFactory;
  private readonly backoffInitial: number;
  private readonly backoffMax: number;
  private readonly backoffFactor: number;

  private readonly conns: TrackerConn[] = [];
  private readonly seen = new Set<string>();
  /** envelope from-id → tracker peer_id (learned on receipt). */
  private readonly transportPeer = new Map<PeerId, string>();
  /** tracker peer_id → their latest offer_id (for valid answer routing). */
  private readonly lastOfferId = new Map<string, string>();
  private infoHash = "";
  private peerId = "";
  private key: CryptoKey | null = null;
  private cb: ((from: PeerId, msg: SignalMsg) => void) | null = null;
  private closed = false;
  private openedResolve: (() => void) | null = null;
  readonly opened = new Promise<void>((resolve) => {
    this.openedResolve = resolve;
  });

  constructor(options: TrackerAdapterOptions = {}) {
    this.trackerUrls = options.trackers ?? DEFAULT_TRACKERS;
    this.socketFactory = options.socket ?? browserRelaySocket;
    this.backoffInitial = options.backoff?.initialMs ?? 1_000;
    this.backoffMax = options.backoff?.maxMs ?? 30_000;
    this.backoffFactor = options.backoff?.factor ?? 2;
  }

  async open(roomId: string, key: CryptoKey): Promise<void> {
    this.infoHash = await sha1Hex(roomId);
    this.peerId = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    this.key = key;
    this.closed = false;
    for (const url of this.trackerUrls) {
      const conn: TrackerConn = {
        url,
        socket: null,
        open: false,
        attempts: 0,
        reconnectTimer: null,
      };
      this.conns.push(conn);
      this.connect(conn);
    }
  }

  private connect(conn: TrackerConn): void {
    if (this.closed) return;
    let socket: RelaySocket;
    try {
      socket = this.socketFactory(conn.url);
    } catch {
      this.scheduleReconnect(conn);
      return;
    }
    conn.socket = socket;
    socket.onopen = () => {
      conn.open = true;
      conn.attempts = 0;
      this.announce(conn, { offers: [], numwant: 0 }); // join the swarm
      this.openedResolve?.();
      this.openedResolve = null;
    };
    socket.onmessage = (data) => this.onWire(data);
    socket.onclose = () => {
      conn.open = false;
      this.scheduleReconnect(conn);
    };
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(conn: TrackerConn): void {
    if (this.closed || conn.reconnectTimer !== null) return;
    const delay = Math.min(
      this.backoffInitial * this.backoffFactor ** conn.attempts,
      this.backoffMax,
    );
    conn.attempts += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.connect(conn);
    }, delay);
  }

  private announce(conn: TrackerConn, extra: Record<string, unknown>): void {
    conn.socket?.send(
      JSON.stringify({
        action: "announce",
        info_hash: this.infoHash,
        peer_id: this.peerId,
        left: 0,
        ...extra,
      }),
    );
  }

  private onWire(data: string): void {
    let msg: TrackerAnnounce;
    try {
      msg = JSON.parse(data) as TrackerAnnounce;
    } catch {
      return;
    }
    if (msg.action !== "announce" || msg.info_hash !== this.infoHash) return;
    if (!msg.peer_id || msg.peer_id === this.peerId) return;
    if (typeof msg.offer === "string") {
      void this.receive(msg.peer_id, msg.offer, msg.offer_id ?? "");
      return;
    }
    if (typeof msg.answer === "string") {
      void this.receive(msg.peer_id, msg.answer, undefined);
    }
  }

  private async receive(peerId: string, code: string, offerId: string | undefined): Promise<void> {
    const dedupeKey = code.slice(0, 96);
    if (this.seen.has(dedupeKey)) return;
    this.seen.add(dedupeKey);
    if (this.seen.size > 2_000) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    const result = await this.sink.handleCode(code);
    if (result.from !== null) this.transportPeer.set(result.from, peerId);
    if (offerId !== undefined && result.delivered) {
      this.lastOfferId.set(peerId, offerId);
    }
  }

  private readonly sink = createEnvelopeSink({
    key: () => this.key,
    selfId: () => this.selfId,
    cb: () => this.cb,
  });

  async send(to: PeerId, msg: SignalMsg): Promise<void> {
    if (this.closed) throw new Error("tracker signaling: closed");
    if (!this.key) throw new Error("tracker signaling: open() not called");
    const code = await encryptSignalPayload(this.key, { from: this.selfId, to, msg });
    const targetPeer = this.transportPeer.get(to);
    for (const conn of this.conns) {
      if (!conn.open || !conn.socket) continue;
      if (targetPeer !== undefined) {
        this.announce(conn, {
          answer: code,
          to_peer_id: targetPeer,
          offer_id: this.lastOfferId.get(targetPeer) ?? globalThis.crypto.randomUUID().slice(0, 20),
          numwant: 0,
        });
      } else {
        this.announce(conn, {
          offers: [{ offer: code, offer_id: globalThis.crypto.randomUUID().slice(0, 20) }],
          numwant: 8,
        });
      }
    }
  }

  onMessage(cb: (from: PeerId, msg: SignalMsg) => void): void {
    this.cb = cb;
  }

  /** First tracker socket open (adapter registry readiness). */
  ready(): Promise<void> {
    return this.opened;
  }

  close(): void {
    this.closed = true;
    this.cb = null;
    this.key = null;
    for (const conn of this.conns) {
      if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
      conn.socket?.close();
      conn.socket = null;
      conn.open = false;
    }
    this.conns.length = 0;
    this.seen.clear();
    this.transportPeer.clear();
    this.lastOfferId.clear();
  }
}
