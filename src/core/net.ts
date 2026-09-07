/**
 * §6 Networking contracts: the four DataChannels, the Transport interface
 * (WebRTCTransport and InMemoryTransport both satisfy it), SignalingAdapter,
 * SignalMsg and the PeerSession wrapper over RTCPeerConnection.
 */
import type { PeerId } from "./ids";

/** §6.1: four channels per peer. */
export type ChannelName = "ops" | "ephemeral" | "assets" | "sim";

export interface ChannelStats {
  sentBytes: number;
  sentMessages: number;
  /** Current bufferedAmount (backpressure signal). */
  bufferedAmount: number;
}

export interface TransportStats {
  connected: boolean;
  channels: Record<ChannelName, ChannelStats>;
}

export type TransportMessageHandler = (channel: ChannelName, bytes: Uint8Array) => void;

/**
 * §6.1: `interface Transport { send(channel, bytes); onMessage; close; stats }`.
 * WebRTCTransport (real peers) and InMemoryTransport (GM tab loopback, §2)
 * both implement this exactly.
 */
export interface Transport {
  send(channel: ChannelName, bytes: Uint8Array): void;
  /** Single handler slot; the session layer installs its router here. */
  onMessage: TransportMessageHandler | null;
  close(): void;
  readonly stats: TransportStats;
}

// ─── Signaling (§6.2) ─────────────────────────────────────────────────────────

/** Application-level signaling payloads; the adapter encrypts these (AES-GCM). */
export type SignalMsg =
  | { t: "offer"; sdp: string }
  | { t: "answer"; sdp: string }
  | { t: "ice"; candidate: RTCIceCandidateInit }
  | { t: "leave" };

/**
 * §6.2 verbatim. Adapters: Manual (copy/paste + QR, non-trickle, pre-gathered
 * ICE), Nostr (default), MQTT-over-WSS, WebTorrent trackers, generic WebSocket.
 */
export interface SignalingAdapter {
  open(roomId: string, key: CryptoKey): Promise<void>;
  send(to: PeerId, msg: SignalMsg): Promise<void>;
  onMessage(cb: (from: PeerId, msg: SignalMsg) => void): void;
  close(): void;
}

// ─── PeerSession (§2, §6) ─────────────────────────────────────────────────────

export type PeerConnectionState =
  "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

export interface PeerSessionStats {
  state: PeerConnectionState;
  rttMs: number | null;
  /** Estimated host-clock offset (NTP-style, §7 audio / clock messages). */
  clockOffsetMs: number | null;
}

/**
 * One reliable session to the host (star topology, §2). Wraps a
 * RTCPeerConnection + the four DataChannels exposed as a Transport; handles
 * heartbeat (2 s), ICE restart and exponential reconnect (§6.5).
 */
export interface PeerSession {
  readonly peerId: PeerId;
  /** Host side accepts; player side initiates. */
  readonly isHostSide: boolean;
  readonly transport: Transport;
  readonly stats: PeerSessionStats;
  close(reason?: string): void;
  readonly onStateChange: ((state: PeerConnectionState) => void) | null;
  readonly onClosed: ((reason: string) => void) | null;
}

/** §6.5 heartbeat interval. */
export const HEARTBEAT_MS = 2_000;
/** §5 ephemeral rate limit per peer. */
export const EPHEMERAL_MAX_HZ = 20;
/** §6.1 asset chunk size bounds. */
export const ASSET_CHUNK_MIN_BYTES = 16 * 1024;
export const ASSET_CHUNK_MAX_BYTES = 64 * 1024;
