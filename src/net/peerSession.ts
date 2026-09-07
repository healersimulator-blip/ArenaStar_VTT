/**
 * §6/§6.5 PeerSession layer — turns signaling messages + peer connections
 * into live Transports with heartbeat, staleness cleanup and exponential
 * reconnect.
 *
 *   ClientSession (player)  ── offer ──▶  HostSessions (host)
 *          ◀──── answer / ice / leave ────┘
 *
 * - Heartbeat (§6.5): the client pings every 2 s on `ops`; the host's managed
 *   transport replies pong{t0,t1,t2} and stamps lastSeen. The host closes
 *   sessions silent for > 3 intervals + 1 s (staleness).
 * - Clock (§7 prep): NTP-style offset = ((t1−t0)+(t2−t3))/2, rtt = (t2−t1)+(t3−t0).
 * - Reconnect (§6.5): on failure the client re-offers through signaling with
 *   exponential backoff (1 s → 30 s cap, reset on connect) — with non-trickle
 *   Manual signaling a fresh pre-gathered offer is the ICE-restart equivalent;
 *   the host replaces the old session for that peer.
 * - The heartbeat rides inside the Transport wrapper transparently: HostSync /
 *   ClientSync keep their single onMessage slot and never see ping/pong.
 */
import type {
  ChannelName,
  PeerConnectionState,
  PeerSession,
  PeerSessionStats,
  SignalingAdapter,
  SignalMsg,
  Transport,
  TransportMessageHandler,
} from "../core/net";
import { channelFor, deframeMessage, frameMessage } from "./frame";
import {
  createIncoming,
  createOutgoing,
  DEFAULT_ICE_SERVERS,
  type IncomingConnection,
  type OutgoingConnection,
} from "./webrtc";

// ─── Factory port (injectable; Node tests use a loopback fake) ────────────────

export interface PeerWire {
  readonly transport: Transport;
  offer(): Promise<string>;
  acceptAnswer(answerSdp: string): Promise<void>;
  answer(): Promise<string>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  onStateChange(cb: (state: PeerConnectionState) => void): void;
  close(): void;
}

export interface PeerConnectionFactory {
  /** Player side: creates the peer that will produce the offer. */
  createClientPeer(): PeerWire;
  /** Host side: binds to an arriving offer. */
  createHostPeer(offerSdp: string): Promise<PeerWire>;
}

type EitherConnection = OutgoingConnection | IncomingConnection;

class WiredConnection implements PeerWire {
  constructor(private readonly conn: EitherConnection) {}
  get transport(): Transport {
    return this.conn.transport;
  }
  offer(): Promise<string> {
    return (this.conn as OutgoingConnection).offer();
  }
  acceptAnswer(answerSdp: string): Promise<void> {
    return (this.conn as OutgoingConnection).acceptAnswer(answerSdp);
  }
  answer(): Promise<string> {
    return (this.conn as IncomingConnection).answer();
  }
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    return this.conn.addIceCandidate(candidate);
  }
  onStateChange(cb: (state: PeerConnectionState) => void): void {
    this.conn.onStateChange(cb);
  }
  close(): void {
    this.conn.close();
  }
}

/** Real WebRTC factory (browsers; §6.1 transport). */
export class RtcPeerFactory implements PeerConnectionFactory {
  constructor(private readonly iceServers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS) {}
  createClientPeer(): PeerWire {
    return new WiredConnection(createOutgoing(this.iceServers));
  }
  async createHostPeer(offerSdp: string): Promise<PeerWire> {
    return new WiredConnection(await createIncoming(offerSdp, this.iceServers));
  }
}

// ─── Managed transport: heartbeat interception + stats ────────────────────────

export interface ManagedTransportOptions {
  now?: () => number;
  /** Host side: reply to pings and stamp lastSeen. */
  answerPings?: boolean;
  /** Client side: consume pongs into clock stats. */
  onPong?: (stats: { rttMs: number; clockOffsetMs: number }) => void;
}

export class ManagedTransport implements Transport {
  private consumerHandler: TransportMessageHandler | null = null;
  private readonly now: () => number;
  private readonly answerPings: boolean;
  private readonly onPong: ManagedTransportOptions["onPong"];
  /** Host liveness: last ping arrival (epoch ms). */
  lastSeen = 0;
  /** WebRTC transports expose this; resolves when all channels are open. */
  readonly opened: Promise<void> | null;

  constructor(
    private readonly inner: Transport,
    options: ManagedTransportOptions = {},
  ) {
    this.opened = (inner as { opened?: Promise<void> }).opened ?? null;
    this.now = options.now ?? (() => Date.now());
    this.answerPings = options.answerPings ?? false;
    this.onPong = options.onPong;
    this.lastSeen = this.now();
    inner.onMessage = (channel, bytes) => this.route(channel, bytes);
  }

  get onMessage(): TransportMessageHandler | null {
    return this.consumerHandler;
  }

  set onMessage(handler: TransportMessageHandler | null) {
    this.consumerHandler = handler;
  }

  private route(channel: ChannelName, bytes: Uint8Array): void {
    const decoded = deframeMessage(bytes);
    if (decoded.ok) {
      const msg = decoded.value;
      if (msg.kind === "ping") {
        if (this.answerPings) {
          this.lastSeen = this.now();
          const t = this.now();
          this.inner.send(
            channelFor("pong"),
            frameMessage({ kind: "pong", t0: msg.t0, t1: t, t2: t }),
          );
        }
        return; // never surfaced to the session consumer
      }
      if (msg.kind === "pong") {
        const t3 = this.now();
        this.onPong?.({
          rttMs: msg.t2 - msg.t1 + (t3 - msg.t0),
          clockOffsetMs: (msg.t1 - msg.t0 + (msg.t2 - t3)) / 2,
        });
        return;
      }
    }
    this.consumerHandler?.(channel, bytes);
  }

  send(channel: ChannelName, bytes: Uint8Array): void {
    this.inner.send(channel, bytes);
  }

  close(): void {
    this.inner.close();
  }

  get stats() {
    return this.inner.stats;
  }
}

// ─── Host side: session manager over signaling ────────────────────────────────

export interface HostSessionsOptions {
  adapter: SignalingAdapter;
  factory?: PeerConnectionFactory;
  heartbeatMs?: number;
  /** Stale threshold (default 3 × heartbeat + 1 s, §6.5). */
  staleMs?: number;
  now?: () => number;
}

interface HostEntry {
  peerId: string;
  peer: PeerWire;
  managed: ManagedTransport;
}

export class HostSessions {
  onSession: ((peerId: string, transport: Transport) => void) | null = null;
  onClosed: ((peerId: string, reason: string) => void) | null = null;

  private readonly entries = new Map<string, HostEntry>();
  private readonly factory: PeerConnectionFactory;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly now: () => number;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HostSessionsOptions) {
    this.factory = options.factory ?? new RtcPeerFactory();
    this.heartbeatMs = options.heartbeatMs ?? 2_000;
    this.staleMs = options.staleMs ?? 3 * this.heartbeatMs + 1_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Begin listening on the adapter (adapter must be open). */
  start(): void {
    this.options.adapter.onMessage((from, msg) => {
      void this.onSignal(from, msg).catch((error: unknown) => {
        console.error("vtt: host session signal failed", error);
      });
    });
    this.staleTimer = setInterval(() => this.reapStale(), this.heartbeatMs);
  }

  private async onSignal(from: string, msg: SignalMsg): Promise<void> {
    switch (msg.t) {
      case "offer": {
        // Re-offer = reconnect (§6.5): replace any existing session.
        await this.closeSession(from, "replaced by new offer");
        const peer = await this.factory.createHostPeer(msg.sdp);
        const managed = new ManagedTransport(peer.transport, { now: this.now, answerPings: true });
        const entry: HostEntry = { peerId: from, peer, managed };
        this.entries.set(from, entry);
        peer.onStateChange((state) => {
          if (state === "failed" || state === "closed") {
            void this.closeSession(from, `connection ${state}`);
          }
        });
        const answer = await peer.answer();
        await this.options.adapter.send(from, { t: "answer", sdp: answer });
        this.onSession?.(from, managed);
        return;
      }
      case "ice": {
        await this.entries.get(from)?.peer.addIceCandidate(msg.candidate);
        return;
      }
      case "leave": {
        await this.closeSession(from, "leave");
        return;
      }
      case "answer":
        return; // host never receives answers on this side
    }
  }

  private reapStale(): void {
    const cutoff = this.now() - this.staleMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.managed.lastSeen < cutoff) {
        void this.closeSession(entry.peerId, "heartbeat timeout");
      }
    }
  }

  private async closeSession(peerId: string, reason: string): Promise<void> {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    this.entries.delete(peerId);
    entry.peer.close();
    this.onClosed?.(peerId, reason);
  }

  get size(): number {
    return this.entries.size;
  }

  close(): void {
    if (this.staleTimer !== null) clearInterval(this.staleTimer);
    this.staleTimer = null;
    for (const entry of [...this.entries.values()]) {
      entry.peer.close();
      this.onClosed?.(entry.peerId, "host closed");
    }
    this.entries.clear();
  }
}

// ─── Client side: one reconnecting session to the host ────────────────────────

export interface ClientSessionOptions {
  adapter: SignalingAdapter;
  /** Signaling id of the host (adapter target). */
  hostId: string;
  factory?: PeerConnectionFactory;
  heartbeatMs?: number;
  now?: () => number;
  backoff?: { initialMs?: number; maxMs?: number; factor?: number };
}

export class ClientPeerSession implements PeerSession {
  readonly peerId: string;
  readonly isHostSide = false as const;

  onStateChange: ((state: PeerConnectionState) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;

  private state: PeerConnectionState = "new";
  private rttMs: number | null = null;
  private clockOffsetMs: number | null = null;
  private peer: PeerWire | null = null;
  private managed: ManagedTransport | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private readonly factory: PeerConnectionFactory;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly backoffInitial: number;
  private readonly backoffMax: number;
  private readonly backoffFactor: number;

  constructor(private readonly options: ClientSessionOptions) {
    this.peerId = globalThis.crypto.randomUUID();
    this.factory = options.factory ?? new RtcPeerFactory();
    this.heartbeatMs = options.heartbeatMs ?? 2_000;
    this.now = options.now ?? (() => Date.now());
    this.backoffInitial = options.backoff?.initialMs ?? 1_000;
    this.backoffMax = options.backoff?.maxMs ?? 30_000;
    this.backoffFactor = options.backoff?.factor ?? 2;
  }

  get transport(): Transport {
    if (!this.managed) throw new Error("session: not connected");
    return this.managed;
  }

  /** Resolves when the CURRENT transport's channels are open (WebRTC fires
   * "connected" before DataChannels open — sends before this throw). */
  async transportOpen(): Promise<void> {
    const opened = this.managed?.opened;
    if (opened) await opened;
  }

  get stats(): PeerSessionStats {
    return {
      state: this.state,
      rttMs: this.rttMs,
      clockOffsetMs: this.clockOffsetMs,
    };
  }

  /** Begin the handshake; reconnects are automatic (§6.5). */
  async connect(): Promise<void> {
    this.closed = false;
    this.options.adapter.onMessage((from, msg) => void this.onSignal(from, msg));
    this.heartbeatTimer = setInterval(() => this.beat(), this.heartbeatMs);
    await this.handshake();
  }

  private async handshake(): Promise<void> {
    if (this.closed) return;
    const peer = this.factory.createClientPeer();
    const managed = new ManagedTransport(peer.transport, {
      now: this.now,
      onPong: ({ rttMs, clockOffsetMs }) => {
        this.rttMs = rttMs;
        this.clockOffsetMs = clockOffsetMs;
      },
    });
    this.peer = peer;
    this.managed = managed;
    peer.onStateChange((state) => this.onPeerState(state));
    this.setState("connecting");
    const sdp = await peer.offer();
    await this.options.adapter.send(this.options.hostId, { t: "offer", sdp });
  }

  private async onSignal(_from: string, msg: SignalMsg): Promise<void> {
    switch (msg.t) {
      case "answer": {
        try {
          await this.peer?.acceptAnswer(msg.sdp);
        } catch (error) {
          // Stale answer (manual copy/paste races re-offers). Only heal when
          // the session is still waiting — a stray late answer must NEVER
          // kill a live connection.
          console.warn("vtt: answer did not match the current offer", error);
          if (this.state !== "connected") {
            this.setState("failed");
            this.scheduleReconnect();
          }
        }
        return;
      }
      case "ice": {
        await this.peer?.addIceCandidate(msg.candidate);
        return;
      }
      case "leave": {
        this.close("host left");
        return;
      }
      case "offer":
        return; // clients never receive offers
    }
  }

  private onPeerState(state: PeerConnectionState): void {
    if (state === "connected") {
      this.attempts = 0; // backoff resets on success (§6.5)
      this.setState("connected");
      return;
    }
    // §6.5: "disconnected" is the early ICE signal (peer vanished); treat it
    // as failure so the backoff re-offers instead of waiting for "failed".
    if ((state === "failed" || state === "disconnected") && !this.closed) {
      this.setState("failed");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = Math.min(
      this.backoffInitial * this.backoffFactor ** this.attempts,
      this.backoffMax,
    );
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Success may have arrived while the timer was armed (e.g. a manual
      // answer landed after a stale one) — never tear down a live session.
      if (this.closed || this.state === "connected") return;
      this.peer?.close();
      this.peer = null;
      this.managed = null;
      void this.handshake();
    }, delay);
  }

  private beat(): void {
    if (this.closed || this.state !== "connected" || !this.managed) return;
    try {
      this.managed.send(channelFor("ping"), frameMessage({ kind: "ping", t0: this.now() }));
    } catch {
      // transport wedged; the failure state path handles reconnect
    }
  }

  private setState(state: PeerConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  close(reason = "closed by caller"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.peer?.close();
    this.peer = null;
    this.managed = null;
    this.setState("closed");
    this.onClosed?.(reason);
  }
}
