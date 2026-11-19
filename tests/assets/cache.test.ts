import "fake-indexeddb/auto";
import { describe, expect, test, vi } from "vitest";
import {
  AssetCache,
  AssetFetcher,
  type AssetCacheBackend,
} from "../../src/client/assets";
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
    a.close();
    b.close();
  });

  test("client boot and fetch still work when both persistent backends are blocked", async () => {
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("Cache Storage blocked");
      },
    });
    vi.stubGlobal("indexedDB", undefined);
    try {
      const cache = await AssetCache.open();
      const fetcher = new AssetFetcher({
        cache,
        request: (id) => fetcher.onChunk(chunk(id, 0, 1, 1, true)),
      });
      expect(await fetcher.request("no-storage")).toHaveLength(1);
      expect(await cache.has("no-storage")).toBe(false);
      fetcher.close();
    } finally {
      vi.unstubAllGlobals();
    }
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

  test("a cache read/quota failure still plays, with in-session reuse", async () => {
    const requests: string[] = [];
    const cache = AssetCache.withBackend({
      async get() {
        throw new Error("Storage unavailable");
      },
      async put() {
        throw new DOMException(
          "No room for more portraits",
          "QuotaExceededError",
        );
      },
      async has() {
        throw new Error("Storage unavailable");
      },
    });
    const fetcher = new AssetFetcher({
      cache,
      request: (id) => {
        requests.push(id);
        fetcher.onChunk(chunk(id, 0, 4, 4, true));
      },
    });
    const art = await fetcher.request("portrait");
    expect(art).toHaveLength(4);
    await settle(); // put really rejected; an unhandled rejection would fail this test run
    expect(await fetcher.request("portrait")).toBe(art);
    expect(requests).toEqual(["portrait"]);
    expect(await cache.has("portrait")).toBe(false);
    fetcher.close();
  });

  test("evicts compressed hot bytes by byte budget without evicting disk data", async () => {
    const backend = new MemBackend();
    for (const id of ["first", "second", "third"])
      await backend.put(id, new Uint8Array(6 * 1024 * 1024), "image/png");
    const get = vi.spyOn(backend, "get");
    const request = vi.fn();
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(backend),
      request,
    });
    await fetcher.request("first");
    await fetcher.request("second");
    await fetcher.request("first"); // make first the newest, so second is evicted
    await fetcher.request("third");
    await fetcher.request("first");
    await fetcher.request("second");
    expect(get.mock.calls.map(([id]) => id)).toEqual([
      "first",
      "second",
      "third",
      "second",
    ]);
    expect(request).not.toHaveBeenCalled();
  });

  test("one outstanding persistence write still shares the answer after hot eviction", async () => {
    const backend = new MemBackend();
    for (let i = 0; i < 128; i++)
      await backend.put(`hot-${i}`, new Uint8Array([1]), "image/png");
    let finishWrite!: () => void;
    const write = new Promise<void>((done) => {
      finishWrite = done;
    });
    const put = vi
      .spyOn(backend, "put")
      .mockImplementationOnce(async (id, bytes, mime) => {
        await write;
        backend.map.set(id, { bytes, mime });
      });
    const request = vi.fn((id: string) =>
      fetcher.onChunk(chunk(id, 0, 4, 4, true)),
    );
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(backend),
      request,
    });
    const first = await fetcher.request("write-pending"); // doesn't wait for disk
    expect(put).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 128; i++) await fetcher.request(`hot-${i}`);
    expect(await fetcher.request("write-pending")).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
    finishWrite();
    await settle();
    expect(await backend.has("write-pending")).toBe(true);
  });

  test("a paused transport queues new work and resumes partial bytes after authentication", async () => {
    const requests: Array<[string, number]> = [];
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(new MemBackend()),
      request: (id, _priority, offset) => requests.push([id, offset]),
    });
    const partial = fetcher.request("partial");
    await settle();
    fetcher.onChunk(chunk("partial", 0, 2, 1, false));
    fetcher.pause();
    const queued = fetcher.request("queued");
    await settle();
    expect(requests).toEqual([["partial", 0]]);
    fetcher.resume();
    expect(requests).toEqual([
      ["partial", 0],
      ["queued", 0],
      ["partial", 1],
    ]);
    fetcher.onChunk(chunk("partial", 1, 2, 1, true));
    fetcher.onChunk(chunk("queued", 0, 1, 1, true));
    expect(await partial).toEqual(new Uint8Array([0, 1]));
    expect(await queued).toHaveLength(1);
    fetcher.close();
  });

  test("does not persist a short final chunk as a complete hash", async () => {
    const cache = AssetCache.withBackend(new MemBackend());
    const fetcher = new AssetFetcher({
      cache,
      request: (id) => fetcher.onChunk(chunk(id, 0, 10, 5, true)),
    });
    await expect(fetcher.request("short")).rejects.toThrow("incomplete asset");
    expect(await cache.has("short")).toBe(false);
  });

  test("paced cold requests let urgent scene media move ahead of queued preloads", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const fetcher = new AssetFetcher({
      cache: AssetCache.withBackend(new MemBackend()),
      request: (id) => {
        sent.push(id);
        fetcher.onChunk(chunk(id, 0, 1, 1, true));
      },
    });
    try {
      const low = Array.from({ length: 22 }, (_, i) =>
        fetcher.request(`preload-${i}`, "preload"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(16);
      const urgent = fetcher.request("preload-21", "scene");
      expect(urgent).toBe(low[21]); // already queued; promote, don't send another request
      await vi.advanceTimersByTimeAsync(125);
      expect(sent[16]).toBe("preload-21");
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(low);
      expect(sent).toHaveLength(22);
      expect(new Set(sent).size).toBe(22);
    } finally {
      fetcher.close();
      vi.useRealTimers();
    }
  });
});
