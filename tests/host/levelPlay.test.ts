import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { joinHostPlayer, boot, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel, sceneLevelsError } from "../../src/core/levels";
import { floorScene, stairMovementOps, LEVEL_PLAY_FEATURE } from "../../src/core/levelPlay";
import { levelFocusView } from "../../src/core/levelNavigation";
import { requiredWorldFeatures } from "../../src/core/capabilities";
import { planDuplicateSceneOps } from "../../src/core/sceneCopy";
import { exportWorldZip, importWorldZip } from "../../src/host/worldFile";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";
import type { SceneDocument, TokenDocument, RegionDocument, TileDocument, WallDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
const parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
function token(owner: string): TokenDocument { return { _id: "hero", type: "token", name: "Hero", flags: {}, system: {}, ownership: { default: 2, [owner]: 3 }, x: 50, y: 50, width: 20, height: 20, rotation: 0, elevation: 0, levelId: "base", img: "", vision: true, hidden: false, disposition: "neutral", light: { radius: 0, color: "#fff", alpha: 0 } }; }
function tile(id: string): TileDocument { return { _id: id, type: "tile", name: id, ownership: { default: 2 }, flags: {}, system: {}, x: 0, y: 0, width: 1000, height: 1000, img: `https://example.invalid/${id}.png`, above: false, occlusion: { mode: "fade", alpha: 1 } }; }
function stairs(id: string, from: string, to: string): RegionDocument { return { _id: id, type: "region", name: "Private stairs", ownership: { default: 0 }, flags: {}, system: {}, hidden: true, x: 100, y: 0, width: 100, height: 100, shape: { kind: "polygon", points: [[0,0],[1,0],[1,1],[0,1]] }, stairs: { from, to } }; }
const move = (x: number, y = 50): Op => ({ kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { x, y } });
function configure(scene: SceneDocument, owner: string): SceneDocument {
  return { ...scene, levelMode: "isolated", img: "https://example.invalid/legacy.png", foreground: { img: "https://example.invalid/roof.png", elevation: 20 },
    levels: [{ ...draftLevel("base", "Ground"), tileIds: ["ground-map"], useSceneBackground: true }, { ...draftLevel("upper", "Upper", 10, 20), tileIds: ["upper-map"], darkness: 1 }],
    tokens: [token(owner)], tiles: [tile("ground-map"), tile("upper-map"), tile("unassigned-map")],
    regions: [stairs("up", "base", "upper"), stairs("down", "upper", "base")] };
}

test("isolated canvas excludes every other map; entry changes floor atomically, default follows token, return does not bounce", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer(); const copies: string[] = [];
  try {
    const player = playerApp.client; if (!player?.user) throw new Error("join");
    const original = hostApp.store.get("scenes", DEFAULT_SCENE_ID); if (!original) throw new Error("scene");
    const scene = configure(original, player.user.id);
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(scene)) }]);
    player.requestLevelFocus(DEFAULT_SCENE_ID, null); await settle(6);
    expect(player.levelFocus).toMatchObject({ isolated: true, mode: "follow", levelId: "base", presentation: { tileIds: ["ground-map"] } });
    const rendered = floorScene(scene, player.levelFocus);
    expect(rendered.tiles.map((t) => t._id)).toEqual(["ground-map"]); expect(rendered.img).toBe(scene.img); expect(rendered.foreground).toBeUndefined();
    expect(floorScene(scene, null).tiles).toEqual([]); expect(floorScene(scene, null).img).toBeNull();
    expect(player.store.get("scenes", DEFAULT_SCENE_ID)?.regions).toEqual([]);
    expect(player.store.get("scenes", DEFAULT_SCENE_ID)?.levels).toBeUndefined();
    // Other floors are neither fog-readable nor directly assignable by the player.
    expect(await player.requestFog(DEFAULT_SCENE_ID, "upper", "")).toBeNull();
    await expect(player.submitAndWait([{ kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { levelId: "upper", elevation: 10 } }])).rejects.toThrow();
    player.sendFogPng(DEFAULT_SCENE_ID, new Uint8Array([1,2,3]), "base", ""); await settle(6);
    expect(await player.requestFog(DEFAULT_SCENE_ID, "base", "")).toEqual(new Uint8Array([1,2,3]));
    const seq = hostApp.store.seq;
    await player.submitAndWait([move(150)]); await settle(6);
    expect(hostApp.store.seq).toBe(seq + 1);
    expect(hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens[0]).toMatchObject({ x: 150, levelId: "upper", elevation: 10 });
    expect(player.levelFocus).toMatchObject({ mode: "follow", levelId: "upper", presentation: { tileIds: ["upper-map"], darkness: 1 } });
    const upper = floorScene(scene, player.levelFocus); expect(upper.img).toBeNull(); expect(upper.tiles.map((t) => t._id)).toEqual(["upper-map"]);
    expect(await player.requestFog(DEFAULT_SCENE_ID, "upper", "")).toBeNull();
    await player.submitAndWait([move(160)]); expect(hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens[0]?.levelId).toBe("upper");
    await player.submitAndWait([move(250)]); await player.submitAndWait([move(150)]); await settle(6);
    expect(player.levelFocus?.levelId).toBe("base"); expect(await player.requestFog(DEFAULT_SCENE_ID, "base", "")).toEqual(new Uint8Array([1,2,3]));
    expect(hostApp.host.undo().ok).toBe(true); await settle(6);
    expect(hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens[0]).toMatchObject({ x: 250, levelId: "upper", elevation: 10 });
    // Copy rekeys map references and both directions, export/import declares runtime compatibility.
    const live = hostApp.store.get("scenes", DEFAULT_SCENE_ID); if (!live) throw new Error("scene");
    const plan = planDuplicateSceneOps({ scene: live, id: "copied-floors" }); if (!plan.ok) throw new Error(plan.error);
    expect(sceneLevelsError(plan.copy)).toBeNull(); expect(plan.copy.levels?.[0]?.tileIds?.[0]).not.toBe("ground-map");
    expect((plan.copy.regions?.[0]?.stairs as { from?: string } | undefined)?.from).toBe(plan.copy.levels?.[0]?._id);
    const db = await openVttDb();
    const file = await exportWorldZip({ db, root: null, worldId: hostApp.worldId, persister: hostApp.persister });
    const copy = await importWorldZip({ db, root: null, file, mode: "copy", worldId: "floor-play-copy" }); copies.push(copy.worldId);
    const reopened = await boot(undefined, copy.worldId);
    try { expect(reopened.store.get("scenes", DEFAULT_SCENE_ID)?.levelMode).toBe("isolated"); expect(reopened.store.get("scenes", DEFAULT_SCENE_ID)?.regions?.[0]?.stairs).toEqual({ from: "base", to: "upper" }); }
    finally { await reopened.close(); }
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); for (const id of [hostApp.worldId, ...copies]) await deleteWorldData(db, id); db.close(); }
});

test("stair bounds, ambiguity, body clearance, draft activation and explicit relocations fail safely", async () => {
  const app = await boot();
  try {
    const base = app.store.get("scenes", DEFAULT_SCENE_ID); if (!base) throw new Error("scene");
    const scene = configure(base, "p");
    expect(requiredWorldFeatures([scene], "PLAYER")).toContain(LEVEL_PLAY_FEATURE);
    expect(stairMovementOps([move(300)], () => scene)).toHaveLength(1); // crossing without ending inside
    expect(stairMovementOps([move(150)], () => ({ ...scene, levelMode: undefined } as unknown as SceneDocument))).toHaveLength(1);
    expect(stairMovementOps([move(150), { kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { elevation: 1 } }], () => scene)).toHaveLength(2);
    // G-01 (D-430): overlapping stairs combine their destinations instead of refusing the move.
    expect(stairMovementOps([move(150)], () => ({ ...scene, regions: [...(scene.regions ?? []), stairs("ambiguous", "base", "upper")] }))).toHaveLength(2);
    const wall: WallDocument = { _id: "blocking", type: "wall", name: "W", ownership: { default: 2 }, flags: {}, system: {}, c: [155, 0, 155, 100], levelScope: { mode: "levels", ids: ["upper"] }, door: 0, oneWay: false, move: 0, sight: 0, light: 0, sound: 0 };
    expect(() => stairMovementOps([move(150)], () => ({ ...scene, walls: [wall] }))).toThrow("landing");
    wall.levelScope = { mode: "levels", ids: ["base"] }; wall.c = [100, 0, 100, 100];
    expect(() => stairMovementOps([move(150)], () => ({ ...scene, walls: [wall] }))).toThrow("entry");
    expect(sceneLevelsError({ ...scene, levels: [draftLevel("base", "Only floor")] })).not.toBeNull();
    const view = levelFocusView(scene, [], { id: "nobody", role: "PLAYER" }, null);
    expect(view).toMatchObject({ isolated: true, levelId: null, tokenIds: [], levels: [] }); expect(floorScene(scene, view).tiles).toEqual([]);
  } finally { await app.close(); const db = await openVttDb(); await deleteWorldData(db, app.worldId); db.close(); }
});
