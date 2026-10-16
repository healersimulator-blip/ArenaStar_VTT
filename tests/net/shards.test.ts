/**
 * D-488: transport frame sharding — shard codec, reassembly limits, and the real
 * `WebRTCTransport` send/receive path over fake DataChannels (the real-WebRTC
 * round-trip runs in the browser via `e2e/webrtc.spec.ts` → `runWebrtcLoopback`).
 */
import { describe, expect, test } from "vitest";
import { deframeMessage } from "../../src/net/frame";
import {
  DEFAULT_SHARD_PAYLOAD,
  SHARD_MARKER,
  ShardReassembler,
  parseShardEnvelope,
  shardFrame,
} from "../../src/net/shards";
import { WebRTCTransport } from "../../src/net/webrtc";

function pattern(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

describe("shardFrame / parseShardEnvelope (§6.1)", () => {
  test("frames at or under the cap travel untouched — zero overhead", () => {
    const frame = pattern(1_000);
    const parts = shardFrame(frame, 256 * 1024);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(frame); // same object: the common path is byte-preserving
    expect(parseShardEnvelope(frame)).toBeNull();
  });

  test("a 300 000-byte frame splits into envelopes under the cap, reassembles byte-identical", () => {
    const frame = pattern(300_000);
    const parts = shardFrame(frame, 256 * 1024, 42);
    expect(parts.length).toBe(Math.ceil(300_000 / DEFAULT_SHARD_PAYLOAD));
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(256 * 1024);
      expect(part[0]).toBe(SHARD_MARKER);
    }
    const reassembler = new ShardReassembler();
    let done: Uint8Array | null = null;
    for (const part of parts) {
      const envelope = parseShardEnvelope(part);
      expect(envelope).not.toBeNull();
      if (!envelope) throw new Error("unreachable");
      expect(envelope.streamId).toBe(42);
      done = reassembler.push("ops", envelope) ?? done;
    }
    expect(done).not.toBeNull();
    expect(equalBytes(done as Uint8Array, frame)).toBe(true);
    expect(reassembler.stats()).toMatchObject({ streams: 0, bytes: 0 });
  });

  test("a small maxMessageSize shrinks the payload slice to fit the cap", () => {
    const frame = pattern(20_000);
    const parts = shardFrame(frame, 1_024);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1_024);
    const reassembler = new ShardReassembler();
    let done: Uint8Array | null = null;
    for (const part of parts) {
      const envelope = parseShardEnvelope(part);
      if (!envelope) throw new Error("unreachable");
      done = reassembler.push("ephemeral", envelope) ?? done;
    }
    expect(equalBytes(done as Uint8Array, frame)).toBe(true);
  });

  test("an envelope is never a valid framed message — unsharded peers reject it safely", () => {
    const parts = shardFrame(pattern(300_000), 256 * 1024, 1);
    const decoded = deframeMessage(parts[0] as Uint8Array);
    expect(decoded.ok).toBe(false);
  });

  test("malformed envelopes parse as null (bad version, count, index)", () => {
    const parts = shardFrame(pattern(300_000), 256 * 1024, 1);
    const bad = new Uint8Array(parts[0] as Uint8Array);
    bad[1] = 0x02; // unknown version
    expect(parseShardEnvelope(bad)).toBeNull();
    const badCount = new Uint8Array(parts[0] as Uint8Array);
    new DataView(badCount.buffer).setUint32(10, 1); // count < 2
    expect(parseShardEnvelope(badCount)).toBeNull();
    const badIndex = new Uint8Array(parts[1] as Uint8Array);
    new DataView(badIndex.buffer).setUint32(6, 99); // index ≥ count
    expect(parseShardEnvelope(badIndex)).toBeNull();
  });
});

describe("ShardReassembler", () => {
  test("out-of-order and interleaved streams complete independently", () => {
    const a = pattern(200_000, 1);
    const b = pattern(150_000, 2);
    const partsA = shardFrame(a, 64 * 1024, 1);
    const partsB = shardFrame(b, 64 * 1024, 2);
    const mixed: Array<ReturnType<typeof parseShardEnvelope>> = [];
    // Interleave the two streams and reverse each stream's shard order (ephemeral is unordered).
    const queueA = [...partsA].reverse();
    const queueB = [...partsB].reverse();
    while (queueA.length > 0 || queueB.length > 0) {
      const nextA = queueA.pop();
      if (nextA) mixed.push(parseShardEnvelope(nextA));
      const nextB = queueB.pop();
      if (nextB) mixed.push(parseShardEnvelope(nextB));
      const lateA = queueA.shift();
      if (lateA) mixed.push(parseShardEnvelope(lateA));
    }
    const reassembler = new ShardReassembler();
    let doneA: Uint8Array | null = null;
    let doneB: Uint8Array | null = null;
    for (const envelope of mixed) {
      if (!envelope) throw new Error("unreachable");
      const done = reassembler.push(envelope.streamId === 1 ? "ops" : "ephemeral", envelope);
      if (done && equalBytes(done, a)) doneA = done;
      if (done && equalBytes(done, b)) doneB = done;
    }
    expect(doneA).not.toBeNull();
    expect(doneB).not.toBeNull();
    expect(reassembler.stats().streams).toBe(0);
  });

  test("same streamId on different channels is not a collision", () => {
    const a = pattern(100_000, 1);
    const parts = shardFrame(a, 64 * 1024, 7);
    const reassembler = new ShardReassembler();
    let done: Uint8Array | null = null;
    for (const part of parts) {
      const envelope = parseShardEnvelope(part);
      if (!envelope) throw new Error("unreachable");
      done = reassembler.push("sim", envelope) ?? done;
    }
    expect(done).not.toBeNull();
  });

  test("duplicate shards are ignored, first copy wins", () => {
    const frame = pattern(150_000);
    const parts = shardFrame(frame, 64 * 1024, 3);
    const reassembler = new ShardReassembler();
    const first = parseShardEnvelope(parts[0] as Uint8Array);
    const second = parseShardEnvelope(parts[1] as Uint8Array);
    if (!first || !second) throw new Error("unreachable");
    expect(reassembler.push("ops", first)).toBeNull();
    expect(reassembler.push("ops", first)).toBeNull(); // duplicate
    for (const part of parts.slice(1)) {
      const envelope = parseShardEnvelope(part);
      if (!envelope) throw new Error("unreachable");
      reassembler.push("ops", envelope);
    }
    expect(reassembler.stats().streams).toBe(0);
  });

  test("a stream whose shards disagree about count is dropped whole", () => {
    const frame = pattern(150_000);
    const parts = shardFrame(frame, 64 * 1024, 5);
    const reassembler = new ShardReassembler();
    const first = parseShardEnvelope(parts[0] as Uint8Array);
    const second = new Uint8Array(parts[1] as Uint8Array);
    new DataView(second.buffer).setUint32(10, 9); // forged count
    const forged = parseShardEnvelope(second);
    if (!first || !forged) throw new Error("unreachable");
    expect(reassembler.push("ops", first)).toBeNull();
    expect(reassembler.push("ops", forged)).toBeNull();
    expect(reassembler.stats()).toMatchObject({ streams: 0, bytes: 0 });
  });

  test("flood: more than 16 concurrent streams per channel is refused", () => {
    const reassembler = new ShardReassembler();
    for (let streamId = 1; streamId <= 17; streamId += 1) {
      const parts = shardFrame(pattern(150_000), 64 * 1024, streamId);
      const first = parseShardEnvelope(parts[0] as Uint8Array);
      if (!first) throw new Error("unreachable");
      reassembler.push("ops", first);
    }
    expect(reassembler.stats().refusedStreams).toBe(1);
  });

  test("abandoned half-streams expire on the TTL sweep", () => {
    const parts = shardFrame(pattern(150_000), 64 * 1024, 9);
    const reassembler = new ShardReassembler();
    const first = parseShardEnvelope(parts[0] as Uint8Array);
    const second = parseShardEnvelope(parts[1] as Uint8Array);
    if (!first || !second) throw new Error("unreachable");
    expect(reassembler.push("ops", first, 0)).toBeNull();
    // 61 s later the sweep drops the stale half; the late shard starts a fresh stream.
    expect(reassembler.push("ops", second, 61_000)).toBeNull();
    expect(reassembler.stats()).toMatchObject({ streams: 1, expiredStreams: 1 });
  });
});

// ─── The real WebRTCTransport send/receive path over fake DataChannels ────────

type Listener = (ev: { data: ArrayBuffer }) => void;

class FakeDataChannel {
  binaryType = "";
  readyState: string = "open";
  bufferedAmount = 0;
  maxMessageSize = 256 * 1024;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  addEventListener(name: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  send(bytes: Uint8Array): void {
    if (this.readyState !== "open") throw new Error("invalidState");
    this.sent.push(bytes);
  }

  /** Simulates the wire: delivers one captured frame as an ArrayBuffer message event. */
  deliver(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes); // fresh ArrayBuffer, like binaryType "arraybuffer"
    for (const fn of this.listeners.get("message") ?? []) (fn as Listener)({ data: copy.buffer });
  }
}

function fakePc(): RTCPeerConnection {
  return {
    connectionState: "connected",
    addEventListener: () => undefined,
    close: () => undefined,
  } as unknown as RTCPeerConnection;
}

describe("WebRTCTransport sharding (fake DataChannels)", () => {
  test("send splits over-cap frames into envelopes; receive reassembles before onMessage", () => {
    const t1 = new WebRTCTransport(fakePc(), ["ops"]);
    const t2 = new WebRTCTransport(fakePc(), ["ops"]);
    const dc1 = new FakeDataChannel();
    const dc2 = new FakeDataChannel();
    t1.attachChannel("ops", dc1 as unknown as RTCDataChannel);
    t2.attachChannel("ops", dc2 as unknown as RTCDataChannel);

    const received: Uint8Array[] = [];
    t2.onMessage = (_channel, bytes) => received.push(bytes);

    // Small frame: exactly one wire message, byte-identical.
    const small = pattern(64);
    t1.send("ops", small);
    expect(dc1.sent).toHaveLength(1);
    expect(equalBytes(dc1.sent[0] as Uint8Array, small)).toBe(true);
    expect(parseShardEnvelope(dc1.sent[0] as Uint8Array)).toBeNull();

    // Big frame: envelopes on the wire, one reassembled frame at the handler.
    const big = pattern(300_000);
    t1.send("ops", big);
    expect(dc1.sent.length).toBe(1 + Math.ceil(300_000 / DEFAULT_SHARD_PAYLOAD));
    for (const part of dc1.sent.slice(1)) {
      expect(part[0]).toBe(SHARD_MARKER);
      expect(part.length).toBeLessThanOrEqual(256 * 1024);
      expect(parseShardEnvelope(part)).not.toBeNull();
    }
    expect(t1.stats.channels.ops.sentMessages).toBe(2); // logical frames, not envelopes
    expect(t1.stats.channels.ops.sentBytes).toBe(
      dc1.sent.reduce((sum, part) => sum + part.length, 0),
    );

    // Deliver small then big in REVERSE envelope order — reassembly must still land once.
    dc2.deliver(dc1.sent[0] as Uint8Array);
    expect(received).toHaveLength(1);
    expect(equalBytes(received[0] as Uint8Array, small)).toBe(true);
    for (const part of [...dc1.sent.slice(1)].reverse()) dc2.deliver(part);
    expect(received).toHaveLength(2);
    expect(equalBytes(received[1] as Uint8Array, big)).toBe(true);
  });

  test("shard envelopes addressed to a pre-D-488 handler are dropped, not misrouted", () => {
    const t1 = new WebRTCTransport(fakePc(), ["ops"]);
    const dc1 = new FakeDataChannel();
    t1.attachChannel("ops", dc1 as unknown as RTCDataChannel);
    const received: Uint8Array[] = [];
    t1.onMessage = (_channel, bytes) => received.push(bytes);
    const big = pattern(300_000);
    t1.send("ops", big);
    for (const part of dc1.sent) {
      // An old peer's only path is deframeMessage — every envelope must fail there.
      const decoded = deframeMessage(part);
      if (part[0] === SHARD_MARKER) expect(decoded.ok).toBe(false);
    }
    expect(received).toHaveLength(0);
  });
});
