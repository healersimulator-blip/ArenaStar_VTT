/**
 * D-488: transport frame sharding — the frame layer's answer to the per-message cap.
 *
 * One WebRTC user message caps at `RTCDataChannel.maxMessageSize` (256 KiB on the Chromium
 * paths this product targets; the historical API ceiling is 256 KiB and `dc.send` throws
 * above it, killing the channel's session). Frames ride wire-multiplexed by `frameMessage`'s
 * MsgKind byte, and several legitimate frames are inherently bigger than the cap:
 * `fog.put`/`fog.state` carry whole fog PNGs (capped at 1 MiB by `MAX_FOG_PNG_BYTES`, already
 * 4× the wire cap before this fix), `snapshot` carries a projected world + asset manifest,
 * `ais.profile` carries composed module source (`payloadZ` deflates it, but incompressible
 * sources still land over the cap). Splitting each such frame into shards **below** the
 * transport keeps every message kind correct-by-construction: no message schema, no
 * per-kind plumbing, and `peerRelay` hops are covered too because the split happens in
 * `WebRTCTransport.send`.
 *
 * Wire format of one shard envelope (all integers big-endian):
 *
 * ```
 *   [0]      0x00            marker — never a valid MsgKind (0x01…0x63), so `deframeMessage`
 *                             on an unsharded peer rejects the envelope instead of misrouting
 *   [1]      0x01            version
 *   [2..5]   u32 streamId    sender-chosen; unique per open stream on that channel
 *   [6..9]   u32 index       0-based shard index
 *   [10..13] u32 count       total shards of the stream (≥ 2, or why shard at all)
 *   [14..]   payload         this shard's slice of the original frame
 * ```
 *
 * Frames that fit one user message are sent untouched — zero overhead on the common path.
 * Reassembly is per (channel, streamId) on the receiving transport, tolerates out-of-order
 * arrival (the `ephemeral` channel is `ordered: false`), and refuses floods: bounded
 * concurrent streams, bounded total bytes, TTL sweep of abandoned halves.
 */
import type { ChannelName } from "../core/net";

export const SHARD_MARKER = 0x00;
export const SHARD_VERSION = 0x01;
export const SHARD_ENVELOPE_BYTES = 14;
/** Default payload slice per shard; shrinks to fit `maxMessageSize` when that is smaller. */
export const DEFAULT_SHARD_PAYLOAD = 64 * 1024;
/** Historical WebRTC user-message ceiling — fallback when `dc.maxMessageSize` is unavailable. */
export const FALLBACK_MAX_MESSAGE_SIZE = 256 * 1024;

const MAX_CONCURRENT_STREAMS = 16;
const MAX_TOTAL_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_BYTES = MAX_TOTAL_PENDING_BYTES;
const MAX_STREAM_SHARDS = 4096;
const STREAM_TTL_MS = 60_000;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Splits `frame` into shard envelopes for a channel whose per-message cap is
 * `maxMessageSize`. Returns `[frame]` untouched when it fits — the whole point of the
 * design: ordinary frames keep their exact current wire bytes.
 */
export function shardFrame(
  frame: Uint8Array,
  maxMessageSize: number = FALLBACK_MAX_MESSAGE_SIZE,
  streamId: number = 1,
): Uint8Array[] {
  if (frame.length <= maxMessageSize) return [frame];
  const payloadSize = Math.min(DEFAULT_SHARD_PAYLOAD, maxMessageSize - SHARD_ENVELOPE_BYTES);
  if (payloadSize <= 0) throw new Error(`shardFrame: maxMessageSize ${maxMessageSize} too small for an envelope`);
  const count = Math.ceil(frame.length / payloadSize);
  if (count > MAX_STREAM_SHARDS) throw new Error(`shardFrame: frame of ${frame.length} bytes needs ${count} shards`);
  const out: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * payloadSize;
    const slice = frame.subarray(start, Math.min(start + payloadSize, frame.length));
    const envelope = new Uint8Array(SHARD_ENVELOPE_BYTES + slice.length);
    const dv = view(envelope);
    dv.setUint8(0, SHARD_MARKER);
    dv.setUint8(1, SHARD_VERSION);
    dv.setUint32(2, streamId >>> 0);
    dv.setUint32(6, index);
    dv.setUint32(10, count);
    envelope.set(slice, SHARD_ENVELOPE_BYTES);
    out.push(envelope);
  }
  return out;
}

/** What `parseShardEnvelope` saw — `null` when `bytes` is a plain frame (or malformed). */
export interface ShardEnvelope {
  streamId: number;
  index: number;
  count: number;
  payload: Uint8Array;
}

export function parseShardEnvelope(bytes: Uint8Array): ShardEnvelope | null {
  if (bytes.length <= SHARD_ENVELOPE_BYTES) return null;
  const dv = view(bytes);
  if (dv.getUint8(0) !== SHARD_MARKER || dv.getUint8(1) !== SHARD_VERSION) return null;
  const streamId = dv.getUint32(2);
  const index = dv.getUint32(6);
  const count = dv.getUint32(10);
  if (count < 2 || count > MAX_STREAM_SHARDS || index >= count) return null;
  return { streamId, index, count, payload: bytes.subarray(SHARD_ENVELOPE_BYTES) };
}

interface PendingStream {
  channel: ChannelName;
  count: number;
  slots: Array<Uint8Array | undefined>;
  received: number;
  bytes: number;
  touched: number;
}

export interface ReassemblyStats {
  streams: number;
  bytes: number;
  /** Streams refused by the flood limits since construction. */
  refusedStreams: number;
  /** Streams dropped by the TTL sweep since construction. */
  expiredStreams: number;
}

/**
 * Reassembles shard envelopes back into frames, one instance per transport (keyed
 * internally by channel). `push` returns the complete frame exactly once per stream.
 */
export class ShardReassembler {
  /** Keyed `${channel}:${streamId}` — the sender's streamId space is shared across channels. */
  private readonly streams = new Map<string, PendingStream>();
  private totalBytes = 0;
  private refusedStreams = 0;
  private expiredStreams = 0;
  private lastSweep = 0;

  push(channel: ChannelName, envelope: ShardEnvelope, now: number = Date.now()): Uint8Array | null {
    this.sweep(now);
    const key = `${channel}:${envelope.streamId}`;
    let stream = this.streams.get(key);
    if (!stream) {
      const open = [...this.streams.values()].filter((s) => s.channel === channel).length;
      if (open >= MAX_CONCURRENT_STREAMS || this.totalBytes + envelope.payload.length > MAX_TOTAL_PENDING_BYTES) {
        this.refusedStreams += 1;
        return null;
      }
      stream = {
        channel,
        count: envelope.count,
        slots: new Array<Uint8Array | undefined>(envelope.count),
        received: 0,
        bytes: 0,
        touched: now,
      };
      this.streams.set(key, stream);
    }
    if (stream.count !== envelope.count || stream.channel !== channel) {
      // Confused or hostile sender — drop the whole stream rather than guess.
      this.drop(key, false);
      return null;
    }
    const slot = stream.slots[envelope.index];
    if (slot) return null; // duplicate shard: ignore, keep the first copy
    if (stream.bytes + envelope.payload.length > MAX_STREAM_BYTES) {
      this.drop(key, true);
      return null;
    }
    stream.slots[envelope.index] = envelope.payload;
    stream.received += 1;
    stream.bytes += envelope.payload.length;
    stream.touched = now;
    this.totalBytes += envelope.payload.length;
    if (stream.received < stream.count) return null;
    // Complete — release the stream's budget and hand the frame over.
    let total = 0;
    for (const part of stream.slots) total += part?.length ?? 0;
    const frame = new Uint8Array(total);
    let offset = 0;
    for (const part of stream.slots) {
      if (!part) return null; // impossible: received === count
      frame.set(part, offset);
      offset += part.length;
    }
    this.drop(key, false);
    return frame;
  }

  stats(): ReassemblyStats {
    return {
      streams: this.streams.size,
      bytes: this.totalBytes,
      refusedStreams: this.refusedStreams,
      expiredStreams: this.expiredStreams,
    };
  }

  private drop(key: string, countedAsRefused: boolean): void {
    const stream = this.streams.get(key);
    if (!stream) return;
    this.totalBytes -= stream.bytes;
    this.streams.delete(key);
    if (countedAsRefused) this.refusedStreams += 1;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 1_000) return;
    this.lastSweep = now;
    for (const [key, stream] of [...this.streams]) {
      if (now - stream.touched > STREAM_TTL_MS) {
        this.drop(key, false);
        this.expiredStreams += 1;
      }
    }
  }
}
