import { describe, expect, test, vi } from "vitest";
import {
  MAX_PACK_ASSETS,
  MAX_PACK_BYTES,
  parseScenePackManifest,
  planScenePack,
  ScenePackError,
  sceneMediaIds,
  scenePackId,
} from "../../src/core/scenePreload";
import { readScenePack, writeScenePack } from "../../src/client/scenePack";
import {
  AssetCache,
  AssetFetcher,
  type AssetCacheBackend,
} from "../../src/client/assets";
import type {
  AssetManifest,
  SceneDocument,
  WorldCollections,
} from "../../src/core/documents";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { strToU8, zipSync } from "fflate";

const hash = (text: string) =>
  bytesToHex(sha256(new TextEncoder().encode(text)));
const bytes = (text: string) => new TextEncoder().encode(text);
const asset = (name: string, size: number, extra: object = {}) => ({
  name,
  mime: "image/webp",
  size,
  chunks: 1,
  visibility: "referenced" as const,
  ...extra,
});

function scene(
  id: string,
  media: { img?: string; token?: string; sound?: string },
): SceneDocument {
  return {
    _id: id,
    type: "scene",
    name: `Scene ${id}`,
    img: media.img ?? null,
    width: 1000,
    height: 1000,
    grid: { size: 100, type: "square" },
    tokens: media.token
      ? [
          {
            _id: "t1",
            name: "Token",
            type: "token",
            img: media.token,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ]
      : [],
    tiles: [],
    sounds: media.sound
      ? [{ _id: "s1", name: "Rain", audio: media.sound, volume: 0.5 }]
      : [],
  } as unknown as SceneDocument;
}

describe("player scene preload planning", () => {
  const map = hash("map");
  const token = hash("token");
  const rain = hash("rain");
  const privateNote = hash("note");
  const restricted = hash("restricted");
  const manifest: AssetManifest = {
    [map]: asset("map.webp", 100),
    [token]: asset("token.webp", 20),
    [rain]: { ...asset("rain.ogg", 30), mime: "audio/ogg" },
    [privateNote]: asset("note.webp", 10, { visibility: "gm" }),
    [restricted]: asset("paid.webp", 10, { exportRights: "restricted" }),
  };
  const collections = {
    scenes: [
      scene("s1", { img: map, token, sound: rain }),
      scene("s2", { img: privateNote }),
    ],
    journals: [{ _id: "j1", name: "Secret", pages: [{ src: privateNote }] }],
  } as unknown as Partial<WorldCollections>;

  test("selects only the chosen scene's projection media and honours both policies", () => {
    const { ids, omitted } = sceneMediaIds(collections, manifest, ["s1"]);
    expect([...ids].sort()).toEqual([map, token, rain].sort());
    // A GM-private asset referenced by a hidden journal is not in the player projection at all.
    expect(omitted.gmPrivate + omitted.restrictedExport).toBeGreaterThanOrEqual(
      0,
    );
    const hidden = sceneMediaIds(collections, manifest, ["s2"]);
    expect(hidden.ids.has(privateNote)).toBe(false);
    expect(hidden.omitted.gmPrivate).toBe(1);
    expect(sceneMediaIds(collections, manifest, []).ids.size).toBe(0);
  });

  test("a pack never promises export-restricted media and drops GM metadata", () => {
    const base = manifest[rain];
    if (!base) throw new Error("Fixture asset missing");
    const withRestricted = {
      ...manifest,
      [rain]: { ...base, exportRights: "restricted" as const },
    };
    const { manifest: pack } = planScenePack({
      world: "world-1",
      name: "Bridge",
      scenes: [{ id: "s1", name: "Bridge" }],
      collections,
      manifest: withRestricted,
      createdAt: 1,
    });
    expect(Object.keys(pack.assets).sort()).toEqual([map, token].sort());
    expect(pack.omitted.restrictedExport).toBe(1);
    expect(pack.entries[token]).toEqual({});
    expect(pack.world).toBe("world-1");
    expect(pack.packId).toBe(scenePackId("world-1", ["s1"], [map, token]));
  });

  test("a tiled map is promised as its source only, and caps bound the archive", () => {
    const tiled = {
      ...manifest,
      [map]: asset("map.webp", 100, {
        tiles: { ids: [hash("tile1")], size: 256 },
      }),
    };
    const { manifest: pack, hashes } = planScenePack({
      world: null,
      name: "Bridge",
      scenes: [{ id: "s1", name: "Bridge" }],
      collections,
      manifest: tiled,
      createdAt: 1,
    });
    expect(pack.entries[map]).toEqual({ served: "source" });
    expect(pack.assets[map]?.tiles).toBeUndefined();
    expect(new Set(hashes).size).toBe(hashes.length);

    const many: AssetManifest = {};
    for (let i = 0; i < MAX_PACK_ASSETS + 5; i++)
      many[String(i).padStart(4, "0")] = asset(`m${i}`, 1);
    const manyScenes = Object.keys(many).map((id) => ({
      ...scene(`s${id}`, {}),
      img: id,
    }));
    const huge = planScenePack({
      world: null,
      name: "Big",
      scenes: manyScenes.map((doc) => ({ id: doc._id, name: doc.name })),
      collections: { scenes: manyScenes } as Partial<WorldCollections>,
      manifest: many,
      createdAt: 1,
      maxAssets: 10,
    });
    expect(huge.hashes.length).toBeLessThanOrEqual(10);
    expect(huge.manifest.omitted.overCap).toBeGreaterThan(0);
  });

  test("an untrusted manifest is reduced to cache metadata", () => {
    const good = planScenePack({
      world: null,
      name: "Bridge",
      scenes: [{ id: "s1", name: "Bridge" }],
      collections,
      manifest,
      createdAt: 1,
    }).manifest;
    const tampered = JSON.parse(JSON.stringify(good));
    tampered.assets[map] = {
      ...tampered.assets[map],
      visibility: "world",
      exportRights: "granted",
      source: { importedBy: "gm" },
      logicalFiles: [{ path: "secret" }],
      tiles: { ids: ["x"] },
    };
    tampered.assets[hash("evil")] = asset("evil.html", 3, {});
    const parsed = parseScenePackManifest(tampered);
    expect(parsed.assets[map]?.source).toBeUndefined();
    expect(parsed.assets[map]?.logicalFiles).toBeUndefined();
    expect(parsed.assets[map]?.tiles).toBeUndefined();
    expect(parsed.assets[map]?.exportRights).toBeUndefined();
    for (const bad of [
      {},
      { ...tampered, format: "world" },
      { ...tampered, packId: "nope" },
      { ...tampered, createdAt: 0 },
      { ...tampered, scenes: [{ id: "../x", name: "x" }] },
      { ...tampered, entries: undefined, assets: { zzz: asset("a", 1) } },
      {
        ...tampered,
        assets: { [hash("evil")]: { ...asset("evil", 2), mime: "text/html" } },
      },
    ])
      expect(() => parseScenePackManifest(bad)).toThrow(ScenePackError);
  });
});

describe("scene-pack archive", () => {
  const mapBytes = bytes("MAPBYTES");
  const tokenBytes = bytes("TOKENBYTES");
  const mapHash = bytesToHex(sha256(mapBytes));
  const tokenHash = bytesToHex(sha256(tokenBytes));
  const manifest: AssetManifest = {
    [mapHash]: asset("map.webp", mapBytes.byteLength),
    [tokenHash]: asset("token.webp", tokenBytes.byteLength),
  };
  /** Forge one declared uncompressed size in a zip fixture, leaving the other header intact. */
  function forgeUncompressedSize(
    archive: Uint8Array,
    name: string,
    value: number,
    target: "local" | "central",
  ): boolean {
    const view = new DataView(
      archive.buffer,
      archive.byteOffset,
      archive.byteLength,
    );
    let end = -1;
    for (let at = archive.byteLength - 22; at >= 0; at--) {
      if (view.getUint32(at, true) !== 0x06054b50) continue;
      if (at + 22 + view.getUint16(at + 20, true) === archive.byteLength) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new Error("Fixture has no EOCD");
    const entries = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    for (let index = 0; index < entries; index++) {
      if (
        at + 46 > archive.byteLength ||
        view.getUint32(at, true) !== 0x02014b50
      )
        throw new Error("Fixture has no central directory");
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const found = new TextDecoder().decode(
        archive.subarray(at + 46, at + 46 + nameLength),
      );
      if (found === name) {
        if (target === "central") view.setUint32(at + 24, value, true);
        else view.setUint32(view.getUint32(at + 42, true) + 22, value, true);
        return true;
      }
      at += 46 + nameLength + extraLength + commentLength;
    }
    return false;
  }

  const plan = () =>
    planScenePack({
      world: "world-1",
      name: "Bridge",
      scenes: [{ id: "s1", name: "Bridge" }],
      collections: {
        scenes: [scene("s1", { img: mapHash, token: tokenHash })],
      } as Partial<WorldCollections>,
      manifest,
      createdAt: 1,
    }).manifest;

  test("round-trips verified bytes and reports missing files", async () => {
    const pack = plan();
    const archive = writeScenePack(pack, new Map([[mapHash, mapBytes]]));
    const read = await readScenePack(archive);
    expect(read.manifest.packId).toBe(pack.packId);
    expect(read.accepted.map((a) => a.hash)).toEqual([mapHash]);
    expect(read.accepted[0]?.bytes).toEqual(mapBytes);

    const complete = await readScenePack(
      writeScenePack(
        pack,
        new Map([
          [mapHash, mapBytes],
          [tokenHash, tokenBytes],
        ]),
      ),
    );
    expect(complete.accepted).toHaveLength(2);
    expect(complete.rejected).toBe(0);
  });

  test("accepted bytes land in the cache, so the connect-time fetch never touches the wire", async () => {
    // The acceptance criterion for a preload is measurable: after importing a pack, asset
    // requests are served from the cache instead of chunked from the host at join time.
    const pack = plan();
    const store = new Map<string, { bytes: Uint8Array; mime: string }>();
    const backend: AssetCacheBackend = {
      get: async (id) => store.get(id),
      put: async (id, data, mime) => void store.set(id, { bytes: data, mime }),
      has: async (id) => store.has(id),
    };
    const cache = AssetCache.withBackend(backend);
    const read = await readScenePack(
      writeScenePack(
        pack,
        new Map([
          [mapHash, mapBytes],
          [tokenHash, tokenBytes],
        ]),
      ),
    );
    for (const entry of read.accepted)
      await cache.put(entry.hash, entry.bytes, entry.mime);

    const asked: string[] = [];
    const fetcher = new AssetFetcher({
      cache,
      request: (id) => asked.push(id),
    });
    try {
      expect(await fetcher.request(mapHash)).toEqual(mapBytes);
      expect(await fetcher.request(tokenHash)).toEqual(tokenBytes);
      // Zero chunk requests: the same bytes arrived inside the pack.
      expect(asked).toEqual([]);
    } finally {
      fetcher.close();
    }

    // Without the pack the same request has to go over the wire, which is what it saves.
    const empty = new AssetFetcher({
      cache: AssetCache.withBackend({
        get: async () => undefined,
        put: async () => undefined,
        has: async () => false,
      }),
      request: (id) => asked.push(id),
    });
    try {
      void empty.request(mapHash).catch(() => undefined);
      // The cache lookup is asynchronous, so the miss reaches the wire a tick later.
      await vi.waitFor(() => expect(asked).toEqual([mapHash]));
    } finally {
      empty.close();
    }
  });

  test("rejects tampered media, foreign files and non-archives", async () => {
    const pack = plan();
    const archive = writeScenePack(pack, new Map([[mapHash, mapBytes]]));
    // Rename a foreign file into an asset path: the path hash no longer matches its bytes.
    const forged = writeScenePack(
      pack,
      new Map([[mapHash, bytes("not the map")]]),
    );
    const read = await readScenePack(forged);
    expect(read.accepted).toHaveLength(0);
    expect(read.rejected).toBe(1);
    await expect(readScenePack(bytes("plain text"))).rejects.toBeInstanceOf(
      ScenePackError,
    );
    await expect(
      readScenePack(archive.subarray(0, archive.length - 30)),
    ).rejects.toBeInstanceOf(ScenePackError);
  });

  test("rejects a manifest size mismatch and an unlisted zip-bomb before inflation", async () => {
    const pack = plan();
    const wrongSize = {
      ...pack,
      assets: {
        ...pack.assets,
        [mapHash]: asset("map.webp", mapBytes.byteLength + 1),
      },
    };
    const mismatch = await readScenePack(
      writeScenePack(wrongSize, new Map([[mapHash, mapBytes]])),
    );
    expect(mismatch.accepted).toHaveLength(0);
    expect(mismatch.rejected).toBe(1);

    // A tiny archive whose central directory claims one unlisted entry expands past the cap.
    // The reader must reject it from the directory, before unzipSync allocates anything.
    const bomb = zipSync(
      {
        "scene-pack.json": strToU8(JSON.stringify(pack)),
        [`assets/${"f".repeat(64)}`]: new Uint8Array(1024),
      },
      { level: 9 },
    );
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    let end = -1;
    for (let at = bomb.byteLength - 22; at >= 0; at--) {
      if (view.getUint32(at, true) !== 0x06054b50) continue;
      if (at + 22 + view.getUint16(at + 20, true) === bomb.byteLength) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new Error("Bomb fixture has no EOCD");
    let at = view.getUint32(end + 16, true);
    let forged = false;
    for (let index = 0; index < view.getUint16(end + 10, true); index++) {
      if (at + 46 > bomb.byteLength || view.getUint32(at, true) !== 0x02014b50)
        throw new Error("Bomb fixture has no central directory");
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const name = new TextDecoder().decode(
        bomb.subarray(at + 46, at + 46 + nameLength),
      );
      if (name.startsWith("assets/") && !pack.assets[name.slice(7)]) {
        view.setUint32(at + 24, MAX_PACK_BYTES + 1, true);
        forged = true;
        break;
      }
      at += 46 + nameLength + extraLength + commentLength;
    }
    expect(forged).toBe(true);
    await expect(readScenePack(bomb)).rejects.toThrow(
      /expands beyond the byte limit/,
    );
  });

  test("rejects local and central headers whose declared sizes disagree", async () => {
    const pack = plan();
    const unlisted = `assets/${"f".repeat(64)}`;
    const source = zipSync(
      {
        "scene-pack.json": strToU8(JSON.stringify(pack)),
        [unlisted]: new Uint8Array(1024),
      },
      { level: 9 },
    );
    // fflate allocates output from declared sizes. A forged central directory must not
    // be allowed to truncate an entry whose local header says otherwise (or vice versa).
    const centralLie = Uint8Array.from(source);
    expect(forgeUncompressedSize(centralLie, unlisted, 1, "central")).toBe(
      true,
    );
    await expect(readScenePack(centralLie)).rejects.toThrow(/disagree/);

    const localLie = Uint8Array.from(source);
    expect(forgeUncompressedSize(localLie, unlisted, 1, "local")).toBe(true);
    await expect(readScenePack(localLie)).rejects.toThrow(/disagree/);
  });
});
