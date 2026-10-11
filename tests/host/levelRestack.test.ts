/** G-31 (D-439): floor merge / move / rescale plans commit atomically on the host and undo in one step. */
import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { boot, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel } from "../../src/core/levels";
import { mergeLevelPlan, moveLevelPlan, rescaleLevelsPlan } from "../../src/core/levelRestack";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";
import type { RegionDocument, SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";

const parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
const byId = <T extends { _id: string }>(rows: readonly T[] | undefined): T[] => [...(rows ?? [])].sort((a, b) => a._id.localeCompare(b._id));
const base = { ownership: { default: 0 as const }, flags: {}, system: {} };
const token = (id: string, levelId: string, elevation: number): TokenDocument => ({ ...base, _id: id, type: "token", name: id, x: 50, y: 50, width: 50, height: 50, rotation: 0, elevation, levelId,
  img: "", hidden: false, disposition: "neutral", vision: false, light: { radius: 0, color: "#fff", alpha: 0 } });
const wall = (id: string, ids: string[]): WallDocument => ({ ...base, _id: id, type: "wall", name: id, c: [0, 0, 100, 0], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0, levelScope: { mode: "levels", ids } });
const stairs = (levels: string[]): RegionDocument => ({ ...base, _id: `stairs-${levels.join("-")}`, type: "region", name: "Stairs", hidden: true, x: 0, y: 0, width: 100, height: 100,
  shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, stairs: { version: 2, levels, mode: "prompt" } });

test("host: merge, move and rescale commit as one envelope each and a single undo restores everything", async () => {
  const app = await boot();
  try {
    const gm = app.gm.client;
    const original = app.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument;
    const configured: SceneDocument = { ...original, levelMode: "isolated",
      levels: [draftLevel("ground", "Ground", 0, 10, 0), draftLevel("mezz", "Mezzanine", 10, 15, 1), draftLevel("upper", "Upper", 15, 25, 2)],
      tokens: [token("a", "mezz", 12), token("b", "upper", 16)], walls: [wall("w", ["mezz"])], regions: [stairs(["ground", "mezz"]), stairs(["ground", "mezz", "upper"])] };
    await gm.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(configured)) }]);
    const live = () => app.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument;
    const before = structuredClone(live());

    const merge = mergeLevelPlan(live(), "mezz", "ground");
    expect(merge.error).toBeNull();
    await gm.submitAndWait(merge.ops); await settle(4);
    expect(live().levels?.map((l) => [l._id, l.bottom, l.top])).toEqual([["ground", 0, 15], ["upper", 15, 25]]);
    expect(live().tokens.find((t) => t._id === "a")).toMatchObject({ levelId: "ground", elevation: 2 });
    expect(live().walls.find((w) => w._id === "w")?.levelScope).toEqual({ mode: "levels", ids: ["ground"] });
    expect(live().regions?.map((r) => r.stairs ? (r.stairs as { levels: string[] }).levels : null)).toEqual([null, ["ground", "upper"]]);
    expect(app.host.undo().ok).toBe(true); await settle(4);
    // Undoing a delete re-creates the level at the end of the array; order carries no meaning.
    expect(byId(live().levels)).toEqual(byId(before.levels));
    expect(live().tokens).toEqual(before.tokens);
    expect(live().walls).toEqual(before.walls);
    expect(live().regions).toEqual(before.regions);

    const move = moveLevelPlan(live(), "upper", "down");
    expect(move.error).toBeNull();
    await gm.submitAndWait(move.ops); await settle(4);
    expect(live().levels?.find((l) => l._id === "upper")).toMatchObject({ bottom: 10, top: 20, floorZ: 10, sort: 1 });
    expect(live().levels?.find((l) => l._id === "mezz")).toMatchObject({ bottom: 20, top: 25, floorZ: 20, sort: 2 });
    expect(live().tokens.map((t) => [t._id, t.levelId, t.elevation])).toEqual([["a", "mezz", 22], ["b", "upper", 11]]);
    expect(app.host.undo().ok).toBe(true); await settle(4);
    expect(byId(live().levels)).toEqual(byId(before.levels));
    expect(live().tokens).toEqual(before.tokens);

    const rescale = rescaleLevelsPlan(live(), 0.3, { gridDistance: true });
    expect(rescale.error).toBeNull();
    await gm.submitAndWait(rescale.ops); await settle(4);
    expect(byId(live().levels).map((l) => [l._id, l.bottom, l.top, l.floorZ])).toEqual([["ground", 0, 3, 0], ["mezz", 3, 4.5, 3], ["upper", 4.5, 7.5, 4.5]]);
    expect(live().tokens.map((t) => t.elevation)).toEqual([3.6, 4.8]);
    expect(live().grid.distance).toBe(before.grid.distance * 0.3);
    expect(app.host.undo().ok).toBe(true); await settle(4);
    expect(byId(live().levels)).toEqual(byId(before.levels));
    expect(live().grid).toEqual(before.grid);

    // A stale plan (computed before somebody else's change) is refused whole by staged validation.
    const stale = mergeLevelPlan(live(), "mezz", "ground");
    await gm.submitAndWait([{ kind: "create", coll: "tokens", parent, data: token("late", "mezz", 10) }]);
    await expect(gm.submitAndWait(stale.ops)).rejects.toThrow(/Token membership references a missing level/);
    expect(byId(live().levels).map((l) => l._id)).toEqual(["ground", "mezz", "upper"]);
  } finally { await app.close(); const db = await openVttDb(); await deleteWorldData(db, app.worldId); db.close(); }
});
