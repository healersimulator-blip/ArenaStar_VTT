import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { AssetCache, AssetFetcher, type AssetCacheBackend } from "../../src/client/assets";
import type { AssetChunkMsg } from "../../src/core/messages";

/** In-memory backend (Cache API/IDB logic is covered by the real impls). */
class MemBackend implements AssetCacheBackend {
  readonly map = new Map<string, { bytes: Uint8Array; mime: string }>();
  async get(hash: string) {
    return this.map.get(hash);
  }
  async put(hash: string, bytes: Uint8Array, mime: string) {
    this.map.set(hash, { bytes: new Uint8Array(bytes), mime });
  }
  async has(hash: string) {
    return this.map.has(hash);
  }
}

/** request() checks the cache first (async) — hop one macrotask before feeding. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function chunk(
  assetId: string,
  offset: number,
  total: number,
  length: number,
  done: boolean,
): AssetChunkMsg {
  const bytes = new Uint8Array(length);
  bytes.fill(offset % 251);
  return { kind: "asset.chunk", assetId, offset, total, bytes, done };
}

describe("AssetCache (§7 client cache)", () => {
  test("IDB backend round-trips by hash (put/get/has/miss)", async () => {
    const a = await AssetCache.open(); // node → IDB backend (D-038)
    const b = await AssetCache.open(); // same DB → same content
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await a.put("hash-c1", bytes, "image/png");
    expect(await b.has("hash-c1")).toBe(true);
    const hit = await b.get("hash-c1");
    expect(hit).toBeDefined();
    expect(hit?.bytes).toEqual(bytes);
    expect(hit?.mime).toBe("image/png");
    expect(await a.get("unknown")).toBeUndefined();
    expect(await a.has("unknown")).toBe(false);
  });
});

describe("AssetFetcher (§7 lazy fetch, dedup, resume)", () => {
  test("cache hit resolves immediately without wire traffic", async () => {
    const backend = new MemBackend();
    await backend.put("h", new Uint8Array([5]), "image/png");
    const requests: Array<[string, string, number]> = [];
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(backend),
      request: (id, priority, offset) => requests.push([id, priority, offset]),
    });
    const bytes = await fetcher.request("h");
    expect([...bytes]).toEqual([5]);
    expect(requests).toEqual([]);
  });

  test("assembles chunks in order, resolves on done, fills the cache", async () => {
    const backend = new MemBackend();
    const requests: Array<[string, string, number]> = [];
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(backend),
      request: (id, priority, offset) => requests.push([id, priority, offset]),
    });
    const promise = fetcher.request("k", "scene", "image/png");
    await settle();
    expect(requests).toEqual([["k", "scene", 0]]);
    fetcher.onChunk(chunk("k", 0, 150, 100, false));
    fetcher.onChunk(chunk("k", 100, 150, 50, true));
    const bytes = await promise;
    expect(bytes.length).toBe(150);
    expect(bytes[99]).toBe(0); // chunk@0 filled with 0 % 251
    expect(bytes[100]).toBe(100); // chunk@100 filled with 100 % 251
    expect(await backend.has("k")).toBe(true);
  });

  test("gap triggers a resume request at the expected offset", async () => {
    const backend = new MemBackend();
    const requests: Array<[string, string, number]> = [];
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(backend),
      request: (id, priority, offset) => requests.push([id, priority, offset]),
    });
    const promise = fetcher.request("g", "scene");
    await settle();
    fetcher.onChunk(chunk("g", 100, 200, 100, false)); // gap: expected 0
    expect(requests).toEqual([
      ["g", "scene", 0],
      ["g", "scene", 0],
    ]);
    fetcher.onChunk(chunk("g", 0, 200, 100, false));
    fetcher.onChunk(chunk("g", 100, 200, 100, true));
    expect((await promise).length).toBe(200);
  });

  test("stale duplicate offsets below expected are ignored", async () => {
    const backend = new MemBackend();
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(backend),
      request: () => undefined,
    });
    const promise = fetcher.request("s", "scene");
    await settle();
    fetcher.onChunk(chunk("s", 0, 100, 100, false));
    fetcher.onChunk(chunk("s", 0, 100, 100, true)); // stale replay of the first chunk
    fetcher.onChunk(chunk("s", 100, 100, 0, true)); // real completion
    expect((await promise).length).toBe(100);
  });

  test("miss sentinel rejects the request and allows a later retry", async () => {
    const backend = new MemBackend();
    const requests: string[] = [];
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(backend),
      request: (id) => requests.push(id),
    });
    const first = fetcher.request("m", "scene");
    await settle();
    fetcher.onChunk({
      kind: "asset.chunk",
      assetId: "m",
      offset: 0,
      total: 0,
      bytes: new Uint8Array(0),
      done: true,
    });
    await expect(first).rejects.toThrow("asset not found: m");
    expect(fetcher.pendingCount).toBe(0);
    // retry is a fresh request (memo cleared on failure)
    const second = fetcher.request("m", "scene");
    await settle();
    expect(requests).toEqual(["m", "m"]);
    fetcher.onChunk(chunk("m", 0, 1, 1, true));
    expect((await second).length).toBe(1);
  });

  test("concurrent requests for the same hash are deduped to one wire request", async () => {
    const backend = new MemBackend();
    const requests: string[] = [];
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(backend),
      request: (id) => requests.push(id),
    });
    const p1 = fetcher.request("d", "scene");
    const p2 = fetcher.request("d", "scene");
    await settle();
    expect(requests).toEqual(["d"]);
    fetcher.onChunk(chunk("d", 0, 2, 2, true));
    expect(await p1).toEqual(await p2);
  });
});
