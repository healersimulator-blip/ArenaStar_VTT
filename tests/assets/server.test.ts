import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { AssetServer, sha256Hex, wireManifestToStore } from "../../src/host/assets";
import { MemDirHandle } from "../../src/storage/opfs";
import { DocumentStore, type StoreMeta } from "../../src/core/store";

/** sha256("") / sha256("abc") reference vectors. */
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const meta: StoreMeta = {
  worldId: "w-assets-1",
  name: "W",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};

function bytesOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 256;
  return bytes;
}

describe("sha256Hex (§7 content addressing)", () => {
  test("matches reference vectors", async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(SHA256_EMPTY);
    expect(await sha256Hex(new Uint8Array([97, 98, 99]))).toBe(SHA256_ABC);
  });
});

describe("AssetServer (§7)", () => {
  test("import: sha256 id, OPFS blob /vtt/<worldId>/assets/<hash>, IDB metadata, manifest", async () => {
    const root = new MemDirHandle();
    const worldId = "w-assets-opfs";
    const server = await AssetServer.open({ worldId, root });
    const { hash, entry } = await server.import(
      new Uint8Array([97, 98, 99]),
      "abc.txt",
      "text/plain",
    );

    expect(hash).toBe(SHA256_ABC);
    expect(entry).toEqual({ name: "abc.txt", mime: "text/plain", size: 3, chunks: 1 });

    // OPFS path: root/vtt/<worldId>/assets/<hash>
    const assetsDir = root.dirs.get("vtt")?.dirs.get(worldId)?.dirs.get("assets");
    expect(assetsDir?.files.has(hash)).toBe(true);

    expect(await server.get(hash)).toEqual(new Uint8Array([97, 98, 99]));
    expect(await server.meta(hash)).toEqual(entry);
    expect(Object.keys(await server.manifest())).toEqual([hash]);
    server.close();
  });

  test("chunk count follows chunkSize (70000 B @ 32768 → 3)", async () => {
    const server = await AssetServer.open({ worldId: "w-assets-chunks", root: new MemDirHandle() });
    const { hash, entry } = await server.import(
      bytesOf(70000),
      "big.bin",
      "application/octet-stream",
    );
    expect(entry.size).toBe(70000);
    expect(entry.chunks).toBe(3);
    expect(await server.has(hash)).toBe(true);
    server.close();
  });

  test("re-import of identical content is idempotent (same hash, first name wins)", async () => {
    const server = await AssetServer.open({ worldId: "w-assets-dedupe", root: new MemDirHandle() });
    const first = await server.import(new Uint8Array([1, 2, 3]), "a.png", "image/png");
    const second = await server.import(new Uint8Array([1, 2, 3]), "renamed.png", "image/png");
    expect(second.hash).toBe(first.hash);
    const manifest = await server.manifest();
    expect(Object.keys(manifest)).toHaveLength(1);
    expect(manifest[first.hash]?.name).toBe("a.png");
    server.close();
  });

  test("OPFS unavailable → blob inlined in the IDB record (D-037)", async () => {
    const server = await AssetServer.open({ worldId: "w-assets-fallback", root: null });
    const { hash } = await server.import(
      new Uint8Array([7, 7, 7]),
      "f.bin",
      "application/octet-stream",
    );
    expect(await server.get(hash)).toEqual(new Uint8Array([7, 7, 7]));
    // no OPFS handle was ever created
    const meta2 = await server.meta(hash);
    expect(meta2?.size).toBe(3);
    server.close();
  });

  test("read(): ranged slice with total; unknown asset → undefined", async () => {
    const server = await AssetServer.open({
      worldId: "w-assets-read",
      root: new MemDirHandle(),
      chunkSize: 4,
    });
    const { hash } = await server.import(bytesOf(1000), "r.bin", "application/octet-stream");
    const ranged = await server.read(hash, 100, 4);
    expect([...(ranged?.bytes ?? [])]).toEqual([100, 101, 102, 103]);
    expect(ranged?.total).toBe(1000);
    expect(await server.read("deadbeef", 0, 4)).toBeUndefined();
    server.close();
  });

  test("remove deletes blob + metadata and shrinks the manifest", async () => {
    const server = await AssetServer.open({ worldId: "w-assets-remove", root: new MemDirHandle() });
    const a = await server.import(bytesOf(10), "a.bin", "application/octet-stream");
    const b = await server.import(bytesOf(11), "b.bin", "application/octet-stream");
    expect(Object.keys(await server.manifest())).toHaveLength(2);
    await server.remove(a.hash);
    expect(await server.has(a.hash)).toBe(false);
    expect(await server.get(a.hash)).toBeUndefined();
    expect(Object.keys(await server.manifest())).toEqual([b.hash]);
    server.close();
  });

  test("wireManifestToStore keeps store.world.assetManifest current (D-015)", async () => {
    const store = new DocumentStore({ meta });
    const server = await AssetServer.open({
      worldId: "w-assets-manifest",
      root: new MemDirHandle(),
    });
    wireManifestToStore(server, store);
    const { hash } = await server.import(new Uint8Array([9]), "m.png", "image/png");
    expect(store.world.assetManifest[hash]).toEqual({
      name: "m.png",
      mime: "image/png",
      size: 1,
      chunks: 1,
    });
    server.close();
  });
});
