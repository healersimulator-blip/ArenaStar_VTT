import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import { startHostShare, type HostShare } from "../../src/app/hostShare";
import { bootPlayerApp, type PlayerApp } from "../../src/app/joinBoot";
import { ensureIdentity } from "../../src/net/identityStore";
import { openVttDb } from "../../src/storage/idb";
import type { TokenDocument } from "../../src/core/documents";
import { ManualSignalingAdapter } from "../../src/net/signaling/manual";
import { boot, ManualPump, MemFactory, settle } from "./fakes";

const hero: TokenDocument = {
  _id: "t-1",
  type: "token",
  name: "Hero",
  ownership: { default: 3, gm: 3 },
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

async function joinedPair(): Promise<{
  hostApp: HostApp;
  playerApp: PlayerApp;
  share: HostShare;
  pump: ManualPump;
}> {
  const db = await openVttDb();
  const hostApp = await boot();
  hostApp.gm.client.submit([
    {
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: DEFAULT_SCENE_ID },
      data: hero,
    },
  ]);
  await settle();

  const pump = new ManualPump();
  const factory = new MemFactory(); // one factory: client+host halves of each pair
  const share = await startHostShare(hostApp, {
    adapter: new ManualSignalingAdapter(),
    secret: "test-secret",
    factory,
  });
  const playerAdapter = new ManualSignalingAdapter();
  pump.addSide(share.adapter);
  pump.addSide(playerAdapter);
  pump.start();

  const playerApp = await bootPlayerApp({
    invite: { roomId: share.roomId, secret: "test-secret" },
    adapter: playerAdapter,
    factory,
    db,
  });
  await Promise.race([
    playerApp.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("join timeout")), 5_000)),
  ]);
  return { hostApp, playerApp, share, pump };
}

describe("player join (§2/§6.4/§5)", () => {
  test("joins over the manual-signaling path: welcome, snapshot, role, identity", async () => {
    const { hostApp, playerApp, pump } = await joinedPair();
    try {
      const client = playerApp.client;
      expect(client).not.toBeNull();
      expect(client?.user?.role).toBe("PLAYER");
      expect(client?.world?.name).toBe("World One");
      const scene = client?.store.get("scenes", DEFAULT_SCENE_ID);
      expect(scene?.tokens.length).toBe(1); // default:3 → visible to players
      expect(client?.store.seq).toBe(hostApp.store.seq);

      // identity persisted per-browser (§6.4): stable across loads
      const again = await ensureIdentity(await openVttDb());
      expect(again.publicKeyHex).toBe(playerApp.identity.publicKeyHex);
    } finally {
      pump.stop();
      playerApp.close();
      await hostApp.persister.flush();
      hostApp.close();
    }
  });

  test("player moves an OWNED token — host applies it (GM sees the move)", async () => {
    const { hostApp, playerApp, pump } = await joinedPair();
    try {
      playerApp.client?.submit([
        {
          kind: "update",
          ref: { coll: "tokens", id: "t-1", parent: { coll: "scenes", id: DEFAULT_SCENE_ID } },
          diff: { x: 400, y: 300 },
        },
      ]);
      await settle(6);
      const token = hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens[0];
      expect(token).toMatchObject({ x: 400, y: 300 });
    } finally {
      pump.stop();
      playerApp.close();
      await hostApp.persister.flush();
      hostApp.close();
    }
  });

  test("player CANNOT mutate documents they do not own (§5 enforced host-side)", async () => {
    const { hostApp, playerApp, pump } = await joinedPair();
    try {
      const rejections: string[] = [];
      playerApp.bus.on("rejected", (r) => rejections.push(r.reason));
      playerApp.client?.submit([
        { kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { name: "Hacked" } },
      ]);
      await settle(6);
      expect(rejections).toContain("forbidden");
      expect(hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.name).toBe("Scene 1");
    } finally {
      pump.stop();
      playerApp.close();
      await hostApp.persister.flush();
      hostApp.close();
    }
  });
});
