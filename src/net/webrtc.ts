/**
 * §6.1 WebRTCTransport — RTCPeerConnection + the four DataChannels exposed as
 * the core Transport interface (same one InMemoryTransport implements).
 *
 *   ops       reliable + ordered
 *   ephemeral unreliable + unordered, maxRetransmits: 0
 *   assets    reliable + ordered, backpressure via bufferedAmountLowThreshold
 *   sim       reliable + ordered, backpressure-aware
 *
 * Connection shape (§2 star topology): the PLAYER initiates (createOutgoing →
 * offer SDP), the HOST accepts (createIncoming(offerSdp) → answer SDP). Both
 * sides use NON-TRICKLE descriptions with pre-gathered ICE (§6.2 Manual
 * signaling exchanges exactly one code each way).
 */
import type { ChannelName, Transport, TransportMessageHandler, TransportStats } from "../core/net";

/** §6.3 public STUN list (no TURN by default; user-supplied later, §6.3). */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: ["stun:stun.cloudflare.com:3478"] },
];

const CHANNEL_ORDER: readonly ChannelName[] = ["ops", "ephemeral", "assets", "sim"];

const CHANNEL_INIT: Record<ChannelName, RTCDataChannelInit> = {
  ops: { ordered: true },
  ephemeral: { ordered: false, maxRetransmits: 0 },
  assets: { ordered: true },
  sim: { ordered: true },
};

/** Backpressure band (§6.1): drain resumes at LOW, queuing starts above HIGH. */
const BUFFER_LOW = 256 * 1024;
const BUFFER_HIGH = 1024 * 1024;
/** Pending-send cap per channel before declaring the transport wedged. */
const MAX_PENDING = 256;
/** Wait for full ICE gathering at most this long before shipping the SDP. */
const GATHER_TIMEOUT_MS = 3_000;

function hasRTC(): boolean {
  return typeof globalThis.RTCPeerConnection === "function";
}

function newPeer(iceServers: readonly RTCIceServer[]): RTCPeerConnection {
  if (!hasRTC()) throw new Error("webrtc: RTCPeerConnection unavailable in this environment");
  return new RTCPeerConnection({ iceServers: [...iceServers] });
}

/** Resolve when ICE gathering completes, or after GATHER_TIMEOUT_MS. */
function waitGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    function done(): void {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange(): void {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export class WebRTCTransport implements Transport {
  onMessage: TransportMessageHandler | null = null;
  private readonly channels = new Map<ChannelName, RTCDataChannel>();
  private readonly pending = new Map<ChannelName, Uint8Array[]>();
  private readonly sent = new Map<ChannelName, { bytes: number; messages: number }>();
  private closed = false;
  private openWaiters: (() => void)[] = [];
  private openCount = 0;

  /** @internal constructed by createOutgoing/createIncoming. */
  constructor(
    private readonly pc: RTCPeerConnection,
    labels: readonly ChannelName[],
  ) {
    for (const label of labels) {
      this.pending.set(label, []);
      this.sent.set(label, { bytes: 0, messages: 0 });
    }
    this.pc.addEventListener("connectionstatechange", () => {
      if (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") {
        this.markClosed();
      }
    });
  }

  /** @internal offerer side: create the four channels before the offer. */
  createChannels(): void {
    for (const label of CHANNEL_ORDER) {
      this.attachChannel(label, this.pc.createDataChannel(label, CHANNEL_INIT[label]));
    }
  }

  /** @internal answerer side: bind an incoming channel by label. */
  attachChannel(label: string, dc: RTCDataChannel): void {
    if (!(CHANNEL_ORDER as readonly string[]).includes(label)) return; // unknown labels ignored
    const name = label as ChannelName;
    if (this.channels.has(name)) return;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.addEventListener("open", () => {
      this.openCount += 1;
      if (this.openCount >= CHANNEL_ORDER.length) {
        const waiters = this.openWaiters;
        this.openWaiters = [];
        for (const w of waiters) w();
      }
    });
    dc.addEventListener("message", (ev) => {
      if (this.closed) return;
      const data = ev.data;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data instanceof Uint8Array
            ? data
            : undefined;
      if (bytes) this.onMessage?.(name, bytes);
    });
    dc.addEventListener("bufferedamountlow", () => {
      this.drain(name);
    });
    dc.addEventListener("close", () => {
      this.markClosed();
    });
    this.channels.set(name, dc);
  }

  /** Resolves when all four channels are open. */
  readonly opened: Promise<void> = new Promise((resolve) => {
    this.openWaiters.push(resolve);
  });

  send(channel: ChannelName, bytes: Uint8Array): void {
    if (this.closed) throw new Error("transport closed");
    const dc = this.channels.get(channel);
    if (!dc || dc.readyState !== "open") throw new Error("transport closed");
    if (dc.bufferedAmount > BUFFER_HIGH) {
      // §6.1 backpressure: hold the frame until the low-water event drains
      const queue = this.pending.get(channel);
      if (!queue || queue.length >= MAX_PENDING) throw new Error("transport closed");
      queue.push(new Uint8Array(bytes));
      return;
    }
    this.sendNow(channel, dc, bytes);
  }

  private sendNow(channel: ChannelName, dc: RTCDataChannel, bytes: Uint8Array): void {
    dc.send(new Uint8Array(bytes)); // strict ArrayBuffer-backed view for lib.dom
    const counter = this.sent.get(channel);
    if (counter) {
      counter.bytes += bytes.length;
      counter.messages += 1;
    }
  }

  private drain(channel: ChannelName): void {
    if (this.closed) return;
    const dc = this.channels.get(channel);
    const queue = this.pending.get(channel);
    if (!dc || !queue) return;
    while (queue.length > 0 && dc.readyState === "open" && dc.bufferedAmount <= BUFFER_HIGH) {
      const next = queue.shift();
      if (next) this.sendNow(channel, dc, next);
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.pending.values()) queue.length = 0;
    this.openWaiters = [];
  }

  close(): void {
    this.markClosed();
    this.pc.close();
  }

  get stats(): TransportStats {
    const connected =
      !this.closed &&
      this.pc.connectionState === "connected" &&
      this.channels.size === CHANNEL_ORDER.length &&
      [...this.channels.values()].every((dc) => dc.readyState === "open");
    const channels = {} as Record<ChannelName, TransportStats["channels"][ChannelName]>;
    for (const name of CHANNEL_ORDER) {
      const dc = this.channels.get(name);
      const counter = this.sent.get(name) ?? { bytes: 0, messages: 0 };
      channels[name] = {
        sentBytes: counter.bytes,
        sentMessages: counter.messages,
        bufferedAmount: dc?.bufferedAmount ?? 0,
      };
    }
    return { connected, channels };
  }
}

// ─── Connection handles (§2: player initiates, host accepts) ──────────────────

export interface Connection {
  readonly transport: WebRTCTransport;
  /** All four channels open. */
  readonly opened: Promise<void>;
  /** Trickle ICE (Manual/non-trickle never calls this; later adapters may). */
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  /** RTCPeerConnection state mapped onto PeerConnectionState (§6). */
  onStateChange(
    cb: (state: "new" | "connecting" | "connected" | "failed" | "closed") => void,
  ): void;
  close(): void;
}

function rtcState(
  state: RTCPeerConnectionState,
): "new" | "connecting" | "connected" | "failed" | "closed" {
  switch (state) {
    case "new":
      return "new";
    case "connecting":
    case "disconnected":
      return "connecting";
    case "connected":
      return "connected";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
  }
}

function wireState(
  pc: RTCPeerConnection,
  cb: (s: "new" | "connecting" | "connected" | "failed" | "closed") => void,
): void {
  cb(rtcState(pc.connectionState));
  pc.addEventListener("connectionstatechange", () => cb(rtcState(pc.connectionState)));
}

export interface OutgoingConnection extends Connection {
  /** Non-trickle offer SDP with pre-gathered ICE (§6.2). */
  offer(): Promise<string>;
  /** Complete the handshake with the host's answer SDP. */
  acceptAnswer(answerSdp: string): Promise<void>;
}

export interface IncomingConnection extends Connection {
  /** Non-trickle answer SDP with pre-gathered ICE. */
  answer(): Promise<string>;
}

export function createOutgoing(
  iceServers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS,
): OutgoingConnection {
  const pc = newPeer(iceServers);
  const transport = new WebRTCTransport(pc, CHANNEL_ORDER);
  transport.createChannels();
  return {
    transport,
    opened: transport.opened,
    async offer(): Promise<string> {
      await pc.setLocalDescription(await pc.createOffer());
      await waitGathered(pc);
      return pc.localDescription?.sdp ?? "";
    },
    async acceptAnswer(answerSdp: string): Promise<void> {
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    },
    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
      await pc.addIceCandidate(candidate);
    },
    onStateChange(
      cb: (state: "new" | "connecting" | "connected" | "failed" | "closed") => void,
    ): void {
      wireState(pc, cb);
    },
    close(): void {
      transport.close();
    },
  };
}

export async function createIncoming(
  offerSdp: string,
  iceServers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS,
): Promise<IncomingConnection> {
  const pc = newPeer(iceServers);
  const transport = new WebRTCTransport(pc, CHANNEL_ORDER);
  pc.addEventListener("datachannel", (ev) => {
    transport.attachChannel(ev.channel.label, ev.channel);
  });
  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  return {
    transport,
    opened: transport.opened,
    async answer(): Promise<string> {
      await pc.setLocalDescription(await pc.createAnswer());
      await waitGathered(pc);
      return pc.localDescription?.sdp ?? "";
    },
    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
      await pc.addIceCandidate(candidate);
    },
    onStateChange(
      cb: (state: "new" | "connecting" | "connected" | "failed" | "closed") => void,
    ): void {
      wireState(pc, cb);
    },
    close(): void {
      transport.close();
    },
  };
}

// ─── In-page loopback self-test (e2e: two peers in one page, §14) ─────────────

export interface LoopbackResult {
  ok: boolean;
  channels: ChannelName[];
  frames: number;
  errors: string[];
}

/**
 * Wire two RTCPeerConnections back-to-back inside one page (no server, no
 * STUN) and push one frame through each channel in both directions. Used by
 * the e2e hook to prove the real bundled transport works from file://.
 */
export async function runWebrtcLoopback(): Promise<LoopbackResult> {
  const errors: string[] = [];
  const outgoing = createOutgoing([]);
  const offerSdp = await outgoing.offer();
  const incoming = await createIncoming(offerSdp, []);
  const answerSdp = await incoming.answer();
  await outgoing.acceptAnswer(answerSdp);
  await Promise.all([outgoing.opened, incoming.opened]);

  const frames = { count: 0 };
  const expected = CHANNEL_ORDER.length * 2;

  const collect = (t: WebRTCTransport): void => {
    t.onMessage = () => {
      frames.count += 1;
    };
  };
  collect(outgoing.transport);
  collect(incoming.transport);

  const payload = new Uint8Array([1, 2, 3, 4]);
  for (const name of CHANNEL_ORDER) {
    outgoing.transport.send(name, payload);
    incoming.transport.send(name, payload);
  }

  // DataChannel delivery is async; poll briefly (loopback is immediate)
  for (let i = 0; i < 100 && frames.count < expected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (frames.count < expected) errors.push(`loopback: only ${frames.count}/${expected} frames`);
  const connected = outgoing.transport.stats.connected && incoming.transport.stats.connected;
  if (!connected) errors.push("loopback: transports not connected");

  outgoing.close();
  incoming.close();
  return { ok: errors.length === 0, channels: [...CHANNEL_ORDER], frames: frames.count, errors };
}
