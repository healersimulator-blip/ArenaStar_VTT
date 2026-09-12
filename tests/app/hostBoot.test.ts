import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { bootHostApp, DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import { openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import type { DerivedImage, DeriveTarget, ImageCodec } from "../../src/workers/assetJob";
import type { TokenDocument } from "../../src/core/documents";

const settle = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

class FakeCodec implements ImageCodec {
  constructor(
    private readonly w = 2000,
    private readonly h = 1500,
  ) {}
  async metadata(): Promise<{ width: number; height: number }> {
    return { width: this.w, height: this.h };
  }
  async derive(
    bytes: Uint8Array,
    _m: string,
    targets: readonly DeriveTarget[],
  ): Promise<DerivedImage[]> {
    return targets.map((t, i) => ({
      bytes: new Uint8Array([...bytes, i]),
      mime: t.mime,
      width: this.w,
      height: this.h,
    }));
  }
  async tile(): Promise<never> {
    throw new Error("no tiling in this fake");
  }
}

async function boot(): Promise<HostApp> {
  return bootHostApp({
    db: await openVttDb(),
    root: new MemDirHandle(),
    codec: new FakeCodec(),
  });
}

describe("GM-tab boot (§2/§8/§14)", () => {
  test("fresh world: seed envelope, GM loopback snapshot, world record", async () => {
    const app = await boot();
    expect(app.worldId).toMatch(/^w-/);
    expect(app.store.seq).toBe(1); // seed (gm user + scene)
    const client = app.gm.client;
    expect(client.user?.role).toBe("GM"); // trusted loopback session
    expect(client.store.get("scenes", DEFAULT_SCENE_ID)?.name).toBe("Scene 1");
    expect(client.store.get("users", "gm")?.role).toBe("GM");
    await app.persister.drain();
    await app.close();
  });

  test("add token + move via the GM CLIENT (never host internals) round-trips", async () => {
    const app = await boot();
    const client = app.gm.client;
    await settle();

    const hero: TokenDocument = {
      _id: "t-1",
      type: "token",
      name: "Hero",
      ownership: { default: 0 },
      flags: {},
      system: {},
      x: 1000,
      y: 750,
      rotation: 0,
      width: 100,
      height: 100,
      img: "",
      hidden: false,
      disposition: "neutral",
      vision: true,
      light: { radius: 0, color: "#fff", alpha: 0.5 },
    };
    client.submit([
      {
        kind: "create",
        coll: "tokens",
        parent: { coll: "scenes", id: DEFAULT_SCENE_ID },
        data: hero,
      },
    ]);
    await settle();
    expect(client.store.seq).toBe(2);
    expect(client.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.length ?? 0).toBe(1);

    client.submit([
      {
        kind: "update",
        ref: { coll: "tokens", id: "t-1", parent: { coll: "scenes", id: DEFAULT_SCENE_ID } },
        diff: { x: 400, y: 300 },
      },
    ]);
    await settle();
    const token = client.store.get("scenes", DEFAULT_SCENE_ID)?.tokens[0];
    expect(token).toMatchObject({ x: 400, y: 300 });

    await app.persister.drain();
    await app.close();
  });

  test("reload: reboots into the SAME world, replays the oplog tail (§8)", async () => {
    const first = await boot();
    const worldId = first.worldId;
    first.gm.client.submit([
      {
        kind: "update",
        ref: { coll: "scenes", id: DEFAULT_SCENE_ID },
        diff: { name: "Renamed Scene" },
      },
    ]);
    await settle();
    await first.persister.drain();
    await first.close();

    const second = await boot(); // no worldId → most recent world
    expect(second.worldId).toBe(worldId);
    // whatever seq the first run reached survived the restart (oplog replay)
    expect(second.store.seq).toBe(first.store.seq);
    expect(second.gm.client.store.get("scenes", DEFAULT_SCENE_ID)?.name).toBe("Renamed Scene");
    await second.persister.drain();
    await second.close();
  });

  test("map import → manifest + scene.img; bytes stream back over the loopback (§7)", async () => {
    const app = await boot();
    await settle();
    const { hash, entry } = await app.pipeline.importImage(
      new Uint8Array([1, 2, 3, 4]),
      "map.png",
      "image/png",
    );
    expect(entry.width).toBe(2000);
    app.gm.client.submit([
      { kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { img: hash } },
    ]);
    await settle();
    expect(app.gm.client.store.get("scenes", DEFAULT_SCENE_ID)?.img).toBe(hash);

    const bytes = await app.gm.fetcher.request(hash, "scene"); // loopback fetch
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    await app.persister.drain();
    await app.close();
  });
});
