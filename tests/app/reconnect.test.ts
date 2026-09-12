import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { ManualSignalingAdapter } from "../../src/net/signaling/manual";
import { DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import { startHostShare, type HostShare } from "../../src/app/hostShare";
import { bootPlayerApp } from "../../src/app/joinBoot";
import { openVttDb } from "../../src/storage/idb";
import type { ClientSync } from "../../src/client/sync";
import type { TokenDocument } from "../../src/core/documents";
import { boot, ManualPump, MemFactory, settle } from "./fakes";

const token = (id: string, x: number, y: number): TokenDocument => ({
  _id: id,
  type: "token",
  name: id,
  ownership: { default: 3, gm: 3 },
  flags: {},
  system: {},
  x,
  y,
  rotation: 0,
  width: 100,
  height: 100,
  img: "",
  hidden: false,
  disposition: "neutral",
  vision: true,
  light: { radius: 0, color: "#fff", alpha: 0.5 },
});

function addToken(app: HostApp, doc: TokenDocument): void {
  app.gm.client.submit([
    {
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: DEFAULT_SCENE_ID },
      data: doc,
    },
  ]);
}

describe("GM crash & recovery (§6.5/§14)", () => {
  test("host dies → player notified → host reopens from IDB → player reattaches with lastSeq and converges", async () => {
    const db = await openVttDb();
    const hostApp = await boot();
    addToken(hostApp, token("t-1", 1000, 750));
    await settle();

    const pump = new ManualPump();
    const factory = new MemFactory();
    const share: HostShare = await startHostShare(hostApp, {
      adapter: new ManualSignalingAdapter(),
      secret: "crash-secret",
      factory,
    });
    pump.addSide(share.adapter);
    pump.start();

    const playerAdapter = new ManualSignalingAdapter();
    const playerApp = await bootPlayerApp({
      invite: { roomId: share.roomId, secret: "crash-secret" },
      adapter: playerAdapter,
      factory,
      db,
    });
    pump.addSide(playerAdapter);
    await Promise.race([
      playerApp.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("join timeout")), 5_000)),
    ]);
    const clientBefore: ClientSync | null = playerApp.client;
    expect(clientBefore).not.toBeNull();

    // player moves the owned token; host applies
    playerApp.client?.submit([
      {
        kind: "update",
        ref: { coll: "tokens", id: "t-1", parent: { coll: "scenes", id: DEFAULT_SCENE_ID } },
        diff: { x: 400, y: 300 },
      },
    ]);
    await settle(6);
    expect(hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens[0]).toMatchObject({
      x: 400,
      y: 300,
    });

    let disconnected: string | null = null;
    playerApp.onDisconnected = (reason) => {
      disconnected = reason;
    };

    // ── HOST CRASH: share closed, world flushed and shut down ──
    const worldId = hostApp.worldId;
    const seqAtCrash = hostApp.store.seq;
    share.close();
    await hostApp.persister.flush();
    await hostApp.close();

    // player sees the drop ("Host disconnected" equivalent)
    await new Promise((r) => setTimeout(r, 300));
    expect(disconnected).not.toBeNull();

    // ── HOST RECOVERY: same IDB → same world, same stored room secret ──
    const hostApp2 = await boot();
    expect(hostApp2.worldId).toBe(worldId);
    expect(hostApp2.store.seq).toBe(seqAtCrash); // oplog/documents survived
    // the host moves on while the player is still reconnecting (ops-since payload)
    addToken(hostApp2, token("t-2", 800, 600));

    const share2 = await startHostShare(hostApp2, {
      adapter: new ManualSignalingAdapter(),
      factory, // same factory: reconnect pairs with the pending client half
    }); // no explicit secret → the STORED one (same room key)
    expect(share2.secret).toBe("crash-secret");
    pump.addSide(share2.adapter);

    // player auto-reconnects (backoff ~1 s) and converges via ops-since-seq
    await Promise.race([
      (async () => {
        while (
          playerApp.client?.store.seq !== hostApp2.store.seq ||
          playerApp.client.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.length !== 2
        ) {
          await new Promise((r) => setTimeout(r, 50));
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("reconnect timeout")), 10_000)),
    ]);

    // SAME client instance (reattach, not a fresh ClientSync) — §5/D-031
    expect(playerApp.client).toBe(clientBefore);
    const scene = playerApp.client?.store.get("scenes", DEFAULT_SCENE_ID);
    expect(scene?.tokens.map((t) => t._id).sort()).toEqual(["t-1", "t-2"]);
    expect(scene?.tokens[0]).toMatchObject({ x: 400, y: 300 }); // pre-crash move survived
    expect(playerApp.client?.store.seq).toBe(hostApp2.store.seq);

    pump.stop();
    playerApp.close();
    await hostApp2.persister.flush();
    await hostApp2.close();
  }, 20_000);
});
