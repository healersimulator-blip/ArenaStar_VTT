import "fake-indexeddb/auto";
import { describe, expect, test, vi } from "vitest";
import {
  fitWithin,
  tileGrid,
  type DerivedImage,
  type DeriveTarget,
  type ImageCodec,
} from "../../src/workers/assetJob";
import { AssetServer, wireManifestToStore } from "../../src/host/assets";
import { ImportPipeline } from "../../src/host/import";
import { DocumentStore, type StoreMeta } from "../../src/core/store";
import { renderChain, loadProgressive } from "../../src/client/assets";
import { openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import type { AssetManifest } from "../../src/core/documents";
import type { AssetId } from "../../src/core/ids";
import { pngHeaderForTest } from "../helpers/imageBytes";

/** Deterministic fake codec: variant bytes = source bytes + tag, so hashes are stable. */
class FakeCodec implements ImageCodec {
  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {}

  async metadata(): Promise<{ width: number; height: number }> {
    return { width: this.width, height: this.height };
  }

  async derive(
    bytes: Uint8Array,
    _mime: string,
    targets: readonly DeriveTarget[],
  ): Promise<DerivedImage[]> {
    return targets.map((t) => {
      const size = fitWithin(this.width, this.height, t.maxEdge);
      const out = new Uint8Array(bytes.length + 1);
      out.set(bytes);
      out[bytes.length] = (t.maxEdge >> 8) & 0xff; // 256→1, 1024→4: distinct variant tags
      return { bytes: out, mime: t.mime, width: size.width, height: size.height };
    });
  }

  async tile(
    bytes: Uint8Array,
    _mime: string,
    tileSize: number,
  ): Promise<{
    cols: number;
    rows: number;
    size: number;
    tiles: DerivedImage[];
  }> {
    const grid = tileGrid(this.width, this.height, tileSize);
    const tiles: DerivedImage[] = [];
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const w = Math.min(tileSize, this.width - c * tileSize);
        const h = Math.min(tileSize, this.height - r * tileSize);
        const out = new Uint8Array(bytes.length + 2);
        out.set(bytes);
        out[bytes.length] = c;
        out[bytes.length + 1] = r;
        tiles.push({ bytes: out, mime: "image/webp", width: w, height: h });
      }
    }
    return { ...grid, tiles };
  }
}

async function makeServer(worldId: string): Promise<{ server: AssetServer; store: DocumentStore }> {
  const server = await AssetServer.open({
    worldId,
    db: await openVttDb(),
    root: new MemDirHandle(),
  });
  const store = new DocumentStore({
    meta: {
      worldId,
      name: "W",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    } satisfies StoreMeta,
  });
  wireManifestToStore(server, store);
  return { server, store };
}

describe("pure geometry (§7)", () => {
  test("fitWithin never upscales and keeps aspect ratio", () => {
    expect(fitWithin(2000, 1000, 256)).toEqual({ width: 256, height: 128 });
    expect(fitWithin(100, 80, 256)).toEqual({ width: 100, height: 80 }); // small images stay
    expect(fitWithin(1000, 4000, 1000)).toEqual({ width: 250, height: 1000 });
    expect(() => fitWithin(0, 10, 256)).toThrow();
  });

  test("tileGrid row-major counts with partial edge tiles", () => {
    expect(tileGrid(6000, 3000, 1024)).toEqual({ cols: 6, rows: 3, size: 1024 });
    expect(tileGrid(4096, 4096, 1024)).toEqual({ cols: 4, rows: 4, size: 1024 });
    expect(tileGrid(4097, 100, 1024)).toEqual({ cols: 5, rows: 1, size: 1024 });
    expect(() => tileGrid(100, 100, 0)).toThrow();
  });
});

describe("ImportPipeline (§7)", () => {
  test("stores full + thumb + mid as hash-addressed assets; manifest carries descriptors", async () => {
    const { server, store } = await makeServer("w-imp-a");
    const pipeline = new ImportPipeline(server, new FakeCodec(2000, 1000));
    const { hash, entry } = await pipeline.importImage(
      pngHeaderForTest(2000, 1000, [1, 2, 3]),
      "map.png",
      "image/png",
    );

    expect(entry.width).toBe(2000);
    expect(entry.height).toBe(1000);
    expect(entry.thumb).toEqual({ assetId: entry.thumb?.assetId, width: 256, height: 128 });
    expect(entry.mid).toEqual({ assetId: entry.mid?.assetId, width: 1024, height: 512 });
    expect(entry.tiles).toBeUndefined();

    // three distinct assets: full, thumb, mid
    const manifest = store.world.assetManifest;
    const ids = new Set(
      [hash, entry.thumb?.assetId, entry.mid?.assetId].filter((x): x is AssetId => x !== undefined),
    );
    expect(ids.size).toBe(3);
    for (const id of ids) expect(manifest[id]).toBeDefined();
    expect(manifest[entry.thumb?.assetId ?? ""]?.name).toBe("map.png#thumb");
    expect(manifest[entry.mid?.assetId ?? ""]?.name).toBe("map.png#mid");
    // thumb bytes really are the derived variant (tagged with maxEdge 256)
    expect((await server.get(entry.thumb?.assetId ?? ""))?.at(-1)).toBe(1); // variant tag (256 >> 8)
    server.close();
  });

  test("stores one normalized logical-folder/name alias without retaining unsafe input spellings", async () => {
    const { server } = await makeServer("w-imp-logical-alias-normalized");
    const pipeline = new ImportPipeline(server, new FakeCodec(320, 200));
    const { hash, entry } = await pipeline.importImage(
      pngHeaderForTest(320, 200, [8, 9]),
      "map.png",
      "image/png",
      { logicalFile: { folder: " /Maps/../Dungeon\u0001/ ", name: "  crypt.png  " } },
    );
    expect(entry.logicalFiles).toEqual([{ folder: "Maps/Dungeon", name: "crypt.png" }]);
    expect((await server.meta(hash))?.logicalFiles).toEqual(entry.logicalFiles);
    server.close();
  });

  test("rejects oversized image dimensions from the header before invoking the decoder", async () => {
    const { server } = await makeServer("w-imp-pixel-limit");
    const codec = new FakeCodec(10_001, 10_000);
    const metadata = vi.spyOn(codec, "metadata");
    const pipeline = new ImportPipeline(server, codec);
    await expect(pipeline.importImage(pngHeaderForTest(10_001, 10_000), "decompression-bomb.png", "image/png"))
      .rejects.toThrow(/100,000,000-pixel limit/i);
    expect(metadata).not.toHaveBeenCalled();
    server.close();
  });

  test("re-import of identical bytes is fully idempotent (hashes + entry stable)", async () => {
    const { server } = await makeServer("w-imp-b");
    const pipeline = new ImportPipeline(server, new FakeCodec(2000, 1000));
    const bytes = pngHeaderForTest(2000, 1000, [9, 9]);
    const first = await pipeline.importImage(bytes, "m.png", "image/png");
    const second = await pipeline.importImage(bytes, "m.png", "image/png");
    expect(second.hash).toBe(first.hash);
    expect(second.entry).toEqual(first.entry);
    const manifest = await server.manifest();
    expect(Object.keys(manifest)).toHaveLength(3); // full + thumb + mid only
    server.close();
  });

  test("identical uploads accrue quota bytes per uploader without changing the first provenance record", async () => {
    const { server } = await makeServer("w-imp-upload-attribution");
    const pipeline = new ImportPipeline(server, new FakeCodec(1200, 800));
    const bytes = pngHeaderForTest(1200, 800, [4, 8, 15, 16, 23, 42]);
    const first = await pipeline.importImage(bytes, "map.png", "image/png", {
      source: { kind: "file", originalName: "map.png", importedBy: "player-a", uploadedBytes: bytes.length },
    });
    const second = await pipeline.importImage(bytes, "map-copy.png", "image/png", {
      source: { kind: "paste", originalName: "map-copy.png", importedBy: "player-b", uploadedBytes: bytes.length },
    });
    const sameUploader = await pipeline.importImage(bytes, "map-again.png", "image/png", {
      source: { kind: "url", originalName: "map-again.png", importedBy: "player-a", uploadedBytes: bytes.length },
    });

    expect(second.hash).toBe(first.hash);
    expect(sameUploader.hash).toBe(first.hash);
    expect(sameUploader.entry.source).toMatchObject({
      importedBy: "player-a",
      originalName: "map.png",
      uploadedBytes: bytes.length,
      uploadedBytesByUser: {
        "player-a": bytes.length * 2,
        "player-b": bytes.length,
      },
    });
    server.close();
  });

  test("concurrent identical uploads preserve every uploader's quota attribution", async () => {
    const { server } = await makeServer("w-imp-concurrent-attribution");
    const pipeline = new ImportPipeline(server, new FakeCodec(900, 600));
    const bytes = pngHeaderForTest(900, 600, [5, 6, 7]);
    const [first, second] = await Promise.all([
      pipeline.importImage(bytes, "one.png", "image/png", {
        source: { kind: "file", importedBy: "player-one", uploadedBytes: bytes.length },
      }),
      pipeline.importImage(bytes, "two.png", "image/png", {
        source: { kind: "file", importedBy: "player-two", uploadedBytes: bytes.length },
      }),
    ]);
    const stored = await server.meta(first.hash);
    expect(second.hash).toBe(first.hash);
    expect(stored?.source?.uploadedBytesByUser).toEqual({
      "player-one": bytes.length,
      "player-two": bytes.length,
    });
    server.close();
  });

  test("maps > 4096 px on a side are split into hash-addressed tiles", async () => {
    const { server, store } = await makeServer("w-imp-c");
    const pipeline = new ImportPipeline(server, new FakeCodec(6000, 3000), { tileSize: 1024 });
    const { entry } = await pipeline.importImage(pngHeaderForTest(6000, 3000, [5]), "big.png", "image/png");

    expect(entry.tiles).toMatchObject({ size: 1024, cols: 6, rows: 3 });
    expect(entry.tiles?.ids).toHaveLength(18);
    for (const id of entry.tiles?.ids ?? []) {
      expect(store.world.assetManifest[id]).toBeDefined();
      expect(await server.get(id)).toBeDefined();
    }
    server.close();
  });

  test("exactly 4096 px is not tiled", async () => {
    const { server } = await makeServer("w-imp-d");
    const pipeline = new ImportPipeline(server, new FakeCodec(4096, 512));
    const { entry } = await pipeline.importImage(pngHeaderForTest(4096, 512, [7]), "edge.png", "image/png");
    expect(entry.tiles).toBeUndefined();
    server.close();
  });

  test("describe() enriches an entry and persists descriptors across reopen", async () => {
    const { server, store } = await makeServer("w-imp-e");
    const { hash } = await server.import(
      new Uint8Array([3]),
      "plain.bin",
      "application/octet-stream",
    );
    await server.describe(hash, { width: 640, height: 480 });
    expect(store.world.assetManifest[hash]).toMatchObject({ width: 640, height: 480 });
    await expect(server.describe("nonexistent", { width: 1 })).rejects.toThrow("unknown asset");
    server.close();
  });
});

describe("client progressive chain (§7 thumbnail → mid → full)", () => {
  const manifest: AssetManifest = {
    full: {
      name: "m.png",
      mime: "image/png",
      size: 10,
      chunks: 1,
      width: 2000,
      height: 1000,
      thumb: { assetId: "t", width: 256, height: 128 },
      mid: { assetId: "mm", width: 1024, height: 512 },
    },
    t: { name: "m.png#thumb", mime: "image/webp", size: 4, chunks: 1 },
    mm: { name: "m.png#mid", mime: "image/webp", size: 6, chunks: 1 },
  };

  test("renderChain orders thumb → mid → full and dedupes", () => {
    expect(renderChain(manifest, "full")).toEqual(["t", "mm", "full"]);
    const tiny: AssetManifest = {
      small: {
        name: "s",
        mime: "image/png",
        size: 1,
        chunks: 1,
        thumb: { assetId: "small", width: 100, height: 50 },
      },
    };
    expect(renderChain(tiny, "small")).toEqual(["small"]); // thumb IS the full asset
    expect(renderChain(manifest, "unknown")).toEqual(["unknown"]); // unknown → full anyway
  });

  test("loadProgressive resolves stages in order with the §7 priority ladder", async () => {
    const calls: Array<[AssetId, string]> = [];
    const stages: string[] = [];
    const bytesOf: Record<string, number> = { t: 1, mm: 2, full: 3 };
    const full = await loadProgressive({
      manifest,
      hash: "full",
      fetcher: {
        request: async (id, priority) => {
          calls.push([id, priority]);
          return new Uint8Array([bytesOf[id] ?? 0]);
        },
      },
      onStage: (stage) => stages.push(stage.assetId),
    });
    expect(calls).toEqual([
      ["t", "scene"],
      ["mm", "scene"],
      ["full", "preload"], // full-res never blocks first paint
    ]);
    expect(stages).toEqual(["t", "mm", "full"]);
    expect(full).toEqual(new Uint8Array([3]));
  });
});
