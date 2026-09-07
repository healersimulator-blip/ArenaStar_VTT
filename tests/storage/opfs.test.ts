import { describe, expect, test } from "vitest";
import { MemDirHandle, OpfsAssetStore, opfsRoot } from "../../src/storage/opfs";

describe("OpfsAssetStore (§7/§8)", () => {
  test("opfsRoot returns null where OPFS is unavailable (node)", async () => {
    expect(await opfsRoot()).toBeNull();
  });

  test("open(null) yields null (fallback signal)", async () => {
    expect(await OpfsAssetStore.open("w1", null)).toBeNull();
  });

  test("put/get/has/remove round-trips bytes under /vtt/<world>/assets/<hash>", async () => {
    const root = new MemDirHandle();
    const store = await OpfsAssetStore.open("w1", root);
    expect(store).not.toBeNull();
    if (!store) return;

    const hash = "a".repeat(64);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.put(hash, bytes);

    // exact path structure (§8)
    const vtt = root.dirs.get("vtt");
    const worldDir = vtt?.dirs.get("w1");
    const assets = worldDir?.dirs.get("assets");
    expect(assets?.files.has(hash)).toBe(true);

    const back = await store.get(hash);
    expect([...(back ?? [])]).toEqual([...bytes]);
    expect(await store.has(hash)).toBe(true);
    expect(await store.get("b".repeat(64))).toBeUndefined();

    await store.remove(hash);
    expect(await store.has(hash)).toBe(false);
    await store.remove(hash); // idempotent
  });

  test("worlds are isolated per worldId directory", async () => {
    const root = new MemDirHandle();
    const a = await OpfsAssetStore.open("wA", root);
    const b = await OpfsAssetStore.open("wB", root);
    if (!a || !b) throw new Error("open failed");
    await a.put("c".repeat(64), new Uint8Array([9]));
    expect(await b.has("c".repeat(64))).toBe(false);
  });

  test("list() discovers which of the known hashes are present", async () => {
    const root = new MemDirHandle();
    const store = await OpfsAssetStore.open("w1", root);
    if (!store) throw new Error("open failed");
    await store.put("1".repeat(64), new Uint8Array(1));
    await store.put("2".repeat(64), new Uint8Array(1));
    const known = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    expect(await store.list(known)).toEqual(["1".repeat(64), "2".repeat(64)]);
  });
});
