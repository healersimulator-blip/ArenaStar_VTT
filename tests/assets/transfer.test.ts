import { describe, expect, test } from "vitest";
import { AssetTransfer } from "../../src/net/transfer";
import type { AssetChunkMsg } from "../../src/core/messages";
import type { AssetId, PeerId } from "../../src/core/ids";

type Sent = Array<{ peerId: PeerId; chunk: AssetChunkMsg }>;

function makeSource(sizes: Record<string, number>): {
  sent: Sent;
  transfer: (options?: ConstructorParameters<typeof AssetTransfer>[2]) => AssetTransfer;
} {
  const blobs = new Map<AssetId, Uint8Array>(
    Object.entries(sizes).map(([id, size]) => {
      const bytes = new Uint8Array(size);
      bytes.fill(0xab);
      return [id, bytes];
    }),
  );
  const sent: Sent = [];
  const transfer = (options: ConstructorParameters<typeof AssetTransfer>[2] = {}) =>
    new AssetTransfer(
      async (assetId, offset, length) => {
        const bytes = blobs.get(assetId);
        if (!bytes) return undefined;
        return { bytes: bytes.slice(offset, offset + length), total: bytes.length };
      },
      {
        send: (peerId, chunk) => {
          sent.push({ peerId, chunk });
        },
      },
      { bytesPerSecond: Number.POSITIVE_INFINITY, ...options },
    );
  return { sent, transfer };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AssetTransfer (§7 chunked transfer)", () => {
  test("chunks an asset at chunkSize with offsets, totals and done flags", async () => {
    const { sent, transfer } = makeSource({ asset: 70000 });
    const t = transfer({ chunkSize: 32768 });
    t.request("p1", "asset", 0, "scene");
    await settle();
    expect(t.queued).toBe(0);
    expect(sent.map((s) => s.chunk.offset)).toEqual([0, 32768, 65536]);
    expect(sent.map((s) => s.chunk.bytes.length)).toEqual([32768, 32768, 4464]);
    expect(sent.map((s) => s.chunk.done)).toEqual([false, false, true]);
    expect(sent.every((s) => s.chunk.total === 70000 && s.chunk.assetId === "asset")).toBe(true);
  });

  test("priority: scene outranks preload regardless of arrival order", async () => {
    const { sent, transfer } = makeSource({ low: 100, high: 100 });
    const t = transfer({ chunkSize: 100 });
    t.request("p1", "low", 0, "preload");
    t.request("p1", "high", 0, "scene");
    await settle();
    expect(sent.map((s) => s.chunk.assetId)).toEqual(["high", "low"]);
  });

  test("FIFO within one priority class", async () => {
    const { sent, transfer } = makeSource({ a: 50, b: 50, c: 50 });
    const t = transfer({ chunkSize: 50 });
    t.request("p1", "a", 0, "ui");
    t.request("p1", "b", 0, "ui");
    t.request("p1", "c", 0, "ui");
    await settle();
    expect(sent.map((s) => s.chunk.assetId)).toEqual(["a", "b", "c"]);
  });

  test("resume: request at offset starts streaming from there", async () => {
    const { sent, transfer } = makeSource({ asset: 2500 });
    const t = transfer({ chunkSize: 1000 });
    t.request("p1", "asset", 1500, "scene");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chunk.offset).toBe(1500);
    expect(sent[0]?.chunk.bytes.length).toBe(1000);
    expect(sent[0]?.chunk.done).toBe(true); // 1500 + 1000 ≥ 2500
  });

  test("re-request upgrades priority and moves the offset (resume + reprioritize)", async () => {
    const { transfer } = makeSource({ asset: 5000 });
    const t = transfer({ chunkSize: 1024, now: () => 1_000_000 }); // never-due gate is per-peer; single job
    t.request("p1", "asset", 0, "preload");
    t.request("p1", "asset", 2048, "scene");
    const job = t.snapshot()[0];
    expect(job?.offset).toBe(2048);
    expect(job?.priority).toBe("scene");
  });

  test("unknown asset → miss sentinel {offset:0, total:0, done:true} (D-039)", async () => {
    const { sent, transfer } = makeSource({});
    const t = transfer({ chunkSize: 100 });
    t.request("p1", "missing", 0, "scene");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chunk).toMatchObject({ offset: 0, total: 0, done: true });
    expect(sent[0]?.chunk.bytes.length).toBe(0);
    expect(t.queued).toBe(0);
  });

  test("bandwidth cap paces each peer at bytesPerSecond (D-040)", async () => {
    const { sent, transfer } = makeSource({ asset: 2500 });
    let now = 0;
    const delays: number[] = [];
    const t = transfer({
      chunkSize: 1000,
      bytesPerSecond: 1000, // 1000 bytes ≙ 1000 ms
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms);
        now += ms;
      },
    });
    t.request("p1", "asset", 0, "scene");
    await settle();
    expect(delays).toEqual([1000, 1000]); // one wait between each 1000-byte chunk
    expect(sent).toHaveLength(3);
    expect(sent[2]?.chunk.done).toBe(true);
  });

  test("cap is per-peer: other peers are not gated", async () => {
    const { sent, transfer } = makeSource({ a: 1000, b: 1000 });
    let now = 0;
    const delays: number[] = [];
    const t = transfer({
      chunkSize: 1000,
      bytesPerSecond: 1000,
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms);
        now += ms;
      },
    });
    t.request("p1", "a", 0, "scene");
    t.request("p2", "b", 0, "scene");
    await settle();
    // both first chunks go out immediately; nothing is left queued
    expect(delays).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.peerId))).toEqual(new Set(["p1", "p2"]));
    expect(t.queued).toBe(0);
  });
});
