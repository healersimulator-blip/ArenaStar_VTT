import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { joinHostPlayer, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel } from "../../src/core/levels";
import { focusedTokenIds, levelFocusView } from "../../src/core/levelNavigation";
import { deleteWorldData, openVttDb } from "../../src/storage/idb";
import type { TokenDocument, ActorDocument } from "../../src/core/documents";
const token = (id: string, levelId: string, elevation: number, owner: string): TokenDocument => ({ _id: id, type: "token", name: id, ownership: { default: 2, [owner]: 3 }, flags: {}, system: {}, x: 100, y: 100, rotation: 0, width: 100, height: 100, img: "", vision: true, hidden: false, disposition: "neutral", light: { radius: 0, color: "#fff", alpha: 0 }, levelId, elevation });

test("real join: owned floors only, host switching, invalid selection, live revocation and private drafts stay private", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer();
  try {
    const client = playerApp.client; if (!client?.user) throw new Error("join failed");
    const gm = hostApp.gm.client, parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
    await gm.submitAndWait([...["a", "b", "secret"].map((id, i) => ({ kind: "create" as const, coll: "levels" as const, parent, data: draftLevel(id, id === "secret" ? "SECRET ROOM" : id, i * 10, i * 10 + 10) })),
      { kind: "create", coll: "tokens", parent, data: token("ta", "a", 0, client.user.id) },
      { kind: "create", coll: "tokens", parent, data: token("tb", "b", 10, client.user.id) },
      { kind: "create", coll: "tokens", parent, data: token("secret-token", "secret", 20, "gm") }]);
    client.requestLevelFocus(DEFAULT_SCENE_ID, null); await settle(6);
    expect(client.levelFocus?.levels.map((l) => l.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(client.levelFocus)).not.toContain("SECRET ROOM");
    expect(client.store.get("scenes", DEFAULT_SCENE_ID)?.levels).toBeUndefined();
    client.requestLevelFocus(DEFAULT_SCENE_ID, "b"); await settle(6);
    expect(client.levelFocus).toMatchObject({ levelId: "b", tokenIds: ["tb"] });
    expect(focusedTokenIds(client.levelFocus, new Set(["ta"]))).toEqual(new Set());
    const worldSeq = gm.store.seq;
    client.requestLevelFocus(DEFAULT_SCENE_ID, "secret"); await settle(6);
    expect(client.levelFocus).toMatchObject({ levelId: null, tokenIds: null, error: "unavailable" });
    const denied = client.levelFocus?.levels;
    client.requestLevelFocus(DEFAULT_SCENE_ID, "nonexistent"); await settle(6);
    expect(client.levelFocus?.levels).toEqual(denied); expect(gm.store.seq).toBe(worldSeq);
    client.requestLevelFocus(DEFAULT_SCENE_ID, "b"); await settle(6);
    await gm.submitAndWait([{ kind: "update", ref: { coll: "tokens", id: "tb", parent }, diff: { ownership: { default: 2, gm: 3 } } }]); await settle(6);
    expect(client.levelFocus).toMatchObject({ levelId: null, error: "unavailable", levels: [{ id: "a", name: "a" }] });
    // Actor ownership is also a valid control source; the client supplies neither geometry nor grants.
    const sc = gm.store.get("scenes", DEFAULT_SCENE_ID); if (!sc) throw new Error("scene missing");
    const copy = structuredClone(sc); const tb = copy.tokens.find((t) => t._id === "tb"); if (!tb) throw new Error("token missing"); tb.actorId = "actor";
    const actor: ActorDocument = { _id: "actor", type: "actor", name: "Owner", ownership: { default: 0, [client.user.id]: 3 }, flags: {}, system: {}, items: [], effects: [] };
    expect(levelFocusView(copy, [actor], client.user, "b").levelId).toBe("b");
    tb.hidden = true; expect(levelFocusView(copy, [actor], client.user, "b").levelId).toBeNull();
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); await deleteWorldData(db, hostApp.worldId); db.close(); }
});

test("D-443: a GM-only change projected away from a player keeps the player's floor focus usable", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer();
  try {
    const client = playerApp.client; if (!client?.user) throw new Error("join failed");
    const gm = hostApp.gm.client, parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
    await gm.submitAndWait([...["a", "b"].map((id, i) => ({ kind: "create" as const, coll: "levels" as const, parent, data: draftLevel(id, id, i * 10, i * 10 + 10) })),
      { kind: "create", coll: "tokens", parent, data: token("tb", "b", 10, client.user.id) }]);
    await gm.submitAndWait([{ kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { levelMode: "isolated" } }]);
    client.requestLevelFocus(DEFAULT_SCENE_ID, null); await settle(6);
    expect(client.levelFocus).toMatchObject({ levelId: "b", isolated: true });
    expect(client.levelFocus?.worldSeq).toBe(client.store.seq);
    // Draft levels never reach players, so this envelope is projected away entirely: the player's
    // replica stays at the older seq, and the focus state must say so rather than the host's seq.
    const before = client.store.seq;
    await gm.submitAndWait([{ kind: "update", ref: { coll: "levels", id: "b", parent }, diff: { visibleLevelIds: ["a"] } }]); await settle(6);
    expect(gm.store.seq).toBeGreaterThan(before);
    expect(client.store.seq).toBe(before);
    expect(client.levelFocus?.presentation?.below).toEqual([{ levelId: "a", depth: 1, tileIds: [], useSceneBackground: false }]);
    expect(client.levelFocus?.worldSeq).toBe(client.store.seq);
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); await deleteWorldData(db, hostApp.worldId); db.close(); }
});
