/** D-453: the host keeps walking tokens on the ground under them (raised areas), and players get the areas. */
import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { joinHostPlayer, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel } from "../../src/core/levels";
import { traceSurface } from "../../src/core/floorSurface";
import type { LevelSurface, RegionDocument, SceneDocument, TokenDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";

const parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
const area = (id: string, x: number, y: number, height: number, solid: boolean, over: Partial<RegionDocument> = {}): RegionDocument => ({
  _id: id, type: "region", name: id, ownership: { default: 0 }, flags: {}, system: {}, x, y, width: 200, height: 200,
  shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, raised: { height, solid }, ...over,
});
const move = (id: string, diff: Record<string, unknown>): Op => ({ kind: "update", ref: { coll: "tokens", id, parent }, diff } as Op);
const tokenDoc = (id: string, owner: string | null, x: number, y: number, elevation: number, over: Partial<TokenDocument> = {}): TokenDocument => ({
  _id: id, type: "token", name: id, flags: {}, system: {}, ownership: owner ? { default: 0, [owner]: 3 } : { default: 0 }, x, y, width: 100, height: 100,
  rotation: 0, elevation, img: "", vision: true, hidden: false, disposition: "friendly", light: { radius: 0, color: "#fff", alpha: 0 }, ...over,
});

test("walkers climb onto raised areas and come down again; flyers and explicit heights are left alone; players hold the areas", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer();
  try {
    const player = playerApp.client; if (!player?.user) throw new Error("join");
    const original = hostApp.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument | undefined; if (!original) throw new Error("scene");
    const configured: SceneDocument = { ...original, width: 2200, height: 2200,
      regions: [area("crates5", 600, 1400, 5, true), area("crates10", 600, 1200, 10, true), area("scaffold", 1300, 1100, 10, false)],
      tokens: [tokenDoc("hero", player.user.id, 1150, 1750, 0), tokenDoc("bat", null, 1150, 1550, 30)] };
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(configured)) }]);
    await settle(6);
    const at = (id: string) => (hostApp.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument | undefined)?.tokens.find((t) => t._id === id);

    await player.submitAndWait([move("hero", { x: 750, y: 1550 })]);
    expect(at("hero")).toMatchObject({ x: 750, y: 1550, elevation: 5 });
    await player.submitAndWait([move("hero", { x: 750, y: 1250 })]);
    expect(at("hero")).toMatchObject({ elevation: 10 });
    await player.submitAndWait([move("hero", { x: 1450, y: 1250 })]); // the open scaffold is stood on too
    expect(at("hero")).toMatchObject({ elevation: 10 });
    await player.submitAndWait([move("hero", { x: 1150, y: 1750 })]);
    expect(at("hero")).toMatchObject({ elevation: 0 });
    // The player's replica follows, and holds the areas (its client needs them for sight).
    await settle(6);
    const replica = player.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument | undefined;
    expect(replica?.tokens.find((t) => t._id === "hero")?.elevation).toBe(0);
    expect(replica?.regions?.map((r) => [r._id, r.raised])).toEqual([
      ["crates5", { height: 5, solid: true }], ["crates10", { height: 10, solid: true }], ["scaffold", { height: 10, solid: false }]]);

    // A flyer above the crates keeps its height; an explicit height wins.
    await hostApp.gm.client.submitAndWait([move("bat", { x: 750, y: 1550 })]);
    expect(at("bat")).toMatchObject({ elevation: 30 });
    await hostApp.gm.client.submitAndWait([move("hero", { x: 650, y: 1450, elevation: 2 })]);
    expect(at("hero")).toMatchObject({ x: 650, y: 1450, elevation: 2 });
    // Below the top of the area it ends in (here 2 ft, inside the 5-ft crates), a token is lifted onto it.
    await hostApp.gm.client.submitAndWait([move("hero", { x: 650, y: 1250 })]);
    expect(at("hero")).toMatchObject({ elevation: 10 });
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); await deleteWorldData(db, hostApp.worldId); db.close(); }
});

test("G-23 with raised areas: a player cannot walk off a crate into an opening, and floors keep their own areas", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer();
  try {
    const player = playerApp.client; if (!player?.user) throw new Error("join");
    const original = hostApp.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument | undefined; if (!original) throw new Error("scene");
    // Upper floor: solid except an opening at 400–600. A 5-ft crate stands beside it on the upper floor only.
    const opening = traceSurface((x, y) => x < 1000 && y < 1000 && !(x >= 400 && x < 600 && y >= 400 && y < 600), { x: 0, y: 0, width: 1000, height: 1000 }, { cell: 50 }).surface as LevelSurface;
    const crate = area("crate", 600, 400, 5, true, { width: 100, levelScope: { mode: "levels", ids: ["upper"] } });
    const configured: SceneDocument = { ...original, levelMode: "isolated", regions: [crate],
      tokens: [tokenDoc("hero", player.user.id, 650, 450, 10, { levelId: "upper" }), tokenDoc("goblin", null, 650, 450, 0, { levelId: "ground" })],
      levels: [draftLevel("ground", "Ground", 0, 10, 0), { ...draftLevel("upper", "Upper", 10, 20, 1), visibleLevelIds: ["ground"], surface: opening }] };
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(configured)) }]);
    player.requestLevelFocus(DEFAULT_SCENE_ID, null); await settle(6);
    const at = (id: string) => (hostApp.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument | undefined)?.tokens.find((t) => t._id === id);

    // The hero was placed inside the crate at floor height: stepping within it lifts it onto the top.
    await player.submitAndWait([move("hero", { x: 650, y: 550 })]);
    expect(at("hero")).toMatchObject({ elevation: 15, levelId: "upper" });
    await expect(player.submitAndWait([move("hero", { x: 550, y: 550 })])).rejects.toThrow("No floor there: hero would step into an opening on Upper.");
    expect(at("hero")).toMatchObject({ x: 650, y: 550, elevation: 15 });
    await player.submitAndWait([move("hero", { x: 750, y: 550 })]); // down onto solid floor
    expect(at("hero")).toMatchObject({ x: 750, y: 550, elevation: 10 });
    // The crate is on the upper floor only: the goblin below walks under it at floor height.
    await hostApp.gm.client.submitAndWait([move("goblin", { x: 650, y: 550 })]);
    expect(at("goblin")).toMatchObject({ elevation: 0, levelId: "ground" });
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); await deleteWorldData(db, hostApp.worldId); db.close(); }
});
