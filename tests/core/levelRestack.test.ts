/** G-31 (D-439): merge, move and rescale floors as single atomic plans. */
import { describe, expect, test } from "vitest";
import { draftLevel, sceneLevelsError } from "../../src/core/levels";
import { defaultMergeTarget, mergeLevelPlan, mergeStairLevels, moveLevelPlan, rescaleLevelsPlan, roundElevation, stackOrder } from "../../src/core/levelRestack";
import { applyDiff } from "../../src/core/diff";
import type { LevelDocument, RegionDocument, SceneDocument, TileDocument, TokenDocument, WallDocument, LightDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type { StairBehaviorV2 } from "../../src/core/levelPlay";

const base = { ownership: { default: 0 as const }, flags: {}, system: {} };
const levels = (): LevelDocument[] => [
  draftLevel("cellar", "Cellar", -10, 0, 0), draftLevel("ground", "Ground", 0, 10, 1), draftLevel("mezz", "Mezzanine", 10, 15, 2),
  draftLevel("upper", "Upper", 15, 25, 3), draftLevel("roof", "Roof", 25, null, 4),
];
const token = (id: string, levelId: string | undefined, elevation: number): TokenDocument => ({ ...base, _id: id, type: "token", name: id, x: 50, y: 50, width: 50, height: 50, rotation: 0,
  elevation, ...(levelId ? { levelId } : {}), img: "", hidden: false, disposition: "neutral", vision: false, light: { radius: 0, color: "#fff", alpha: 0 } });
const wall = (id: string, levelScope?: WallDocument["levelScope"]): WallDocument => ({ ...base, _id: id, type: "wall", name: id, c: [0, 0, 100, 0], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0,
  ...(levelScope ? { levelScope } : {}) });
const light = (id: string, levelScope?: LightDocument["levelScope"]): LightDocument => ({ ...base, _id: id, type: "light", name: id, x: 0, y: 0, dim: 10, bright: 5, color: "#fff", alpha: 0.5,
  ...(levelScope ? { levelScope } : {}) });
const region = (id: string, over: Partial<RegionDocument> = {}): RegionDocument => ({ ...base, _id: id, type: "region", name: id, hidden: true, x: 0, y: 0, width: 100, height: 100,
  shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, ...over });
const tile = (id: string, over: Partial<TileDocument> = {}): TileDocument => ({ ...base, _id: id, type: "tile", name: id, x: 0, y: 0, width: 100, height: 100, img: "", above: false,
  occlusion: { mode: "fade", alpha: 0 }, ...over });
const well = (over: Partial<StairBehaviorV2> = {}): StairBehaviorV2 => ({ version: 2, levels: ["ground", "mezz", "upper"], mode: "prompt", ...over });
const only = (...ids: string[]) => ({ mode: "levels" as const, ids });

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  const ls = levels();
  (ls[1] as LevelDocument).tileIds = ["groundArt"];
  (ls[2] as LevelDocument).tileIds = ["mezzArt", "groundArt"];
  (ls[3] as LevelDocument).visibleLevelIds = ["mezz", "ground"];
  (ls[2] as LevelDocument).visibleLevelIds = ["ground"];
  return { ...base, _id: "s", type: "scene", name: "Tower", active: true, img: null, width: 1000, height: 1000,
    grid: { type: "square", size: 100, distance: 5, units: "ft" } as SceneDocument["grid"], darkness: 0, levelMode: "isolated", levels: ls,
    tokens: [token("onMezz", "mezz", 12), token("highMezz", "mezz", 14.5), token("onGround", "ground", 0), token("floating", undefined, 11), token("inCellar", "cellar", -1)],
    walls: [wall("mezzWall", only("mezz")), wall("bothWall", only("ground", "mezz")), wall("allWall", { mode: "all" }), wall("legacyWall")],
    lights: [light("mezzLamp", only("mezz", "upper"))], sounds: [],
    tiles: [tile("groundArt"), tile("mezzArt"), tile("trap", { triggerElevation: { min: 10, max: 12 } })],
    regions: [
      region("well", { stairs: well({ arrivals: [{ levelId: "mezz", x: 1, y: 1 }, { levelId: "ground", x: 2, y: 2 }] }) }),
      region("pair", { stairs: well({ levels: ["ground", "mezz"] }) }),
      region("legacy", { stairs: { from: "mezz", to: "upper" } }),
      region("directed", { stairs: well({ edges: [{ from: "ground", to: "mezz" }, { from: "mezz", to: "ground" }, { from: "mezz", to: "upper" }] }) }),
      region("mezzTrigger", { triggerElevation: { min: 10, max: 15 } }),
      region("tallTrigger", { triggerElevation: { min: 0, max: 20 } }),
      region("cover", { hidden: false, ownership: { default: 1 }, fauxOverhead: { kind: "fauxOverhead", coverZ: 15, affectedElevation: { bottom: 10, top: 15 } } }),
    ],
    drawings: [], templates: [], notes: [], ...over };
}
/** Apply a plan's ops to a copy, the way the store would. */
function apply(s: SceneDocument, ops: readonly Op[]): SceneDocument {
  let next = structuredClone(s);
  for (const op of ops) {
    if (op.kind === "create") throw new Error("plans never create");
    const coll = op.ref.coll;
    if (coll === "scenes") { const r = applyDiff(next, op.kind === "update" ? op.diff : {}); if (!r.ok) throw new Error(r.error); next = r.value; continue; }
    const rows = (next as unknown as Record<string, Array<{ _id: string }>>)[coll] as Array<{ _id: string }>;
    const i = rows.findIndex((r) => r._id === op.ref.id);
    if (i < 0) throw new Error(`missing ${coll}/${op.ref.id}`);
    if (op.kind === "delete") rows.splice(i, 1);
    else { const r = applyDiff(rows[i] as object, op.diff); if (!r.ok) throw new Error(r.error); rows[i] = r.value as { _id: string }; }
  }
  return next;
}
const byId = <T extends { _id: string }>(rows: readonly T[] | undefined, id: string) => rows?.find((r) => r._id === id);

describe("merge into level", () => {
  test("adjacent floors: tokens keep their height above the floor, scopes/stairs/visibility remap, the band grows, one op per document", () => {
    const s = scene();
    const plan = mergeLevelPlan(s, "mezz", "ground");
    expect(plan.error).toBeNull();
    const keys = plan.ops.map((op) => op.kind === "create" ? "" : `${op.ref.coll}/${op.ref.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.ops.at(-1)).toEqual({ kind: "delete", ref: { coll: "levels", id: "mezz", parent: { coll: "scenes", id: "s" } } });
    const after = apply(s, plan.ops);
    expect(sceneLevelsError(after)).toBeNull();
    expect(after.levels?.map((l) => l._id)).toEqual(["cellar", "ground", "upper", "roof"]);
    expect(byId(after.levels, "ground")).toMatchObject({ bottom: 0, top: 15, floorZ: 0, tileIds: ["groundArt", "mezzArt"], visibleLevelIds: [] });
    expect(byId(after.levels, "upper")?.visibleLevelIds).toEqual(["ground"]);
    expect(byId(after.tokens, "onMezz")).toMatchObject({ levelId: "ground", elevation: 2 });
    expect(byId(after.tokens, "highMezz")).toMatchObject({ levelId: "ground", elevation: 4.5 });
    expect(byId(after.tokens, "onGround")).toMatchObject({ levelId: "ground", elevation: 0 });
    expect(byId(after.tokens, "floating")).toMatchObject({ elevation: 1 }); // floorless, but its feet were on the mezzanine
    expect(byId(after.tokens, "floating")?.levelId).toBeUndefined();
    expect(byId(after.tokens, "inCellar")).toMatchObject({ levelId: "cellar", elevation: -1 });
    expect(byId(after.walls, "mezzWall")?.levelScope).toEqual(only("ground"));
    expect(byId(after.walls, "bothWall")?.levelScope).toEqual(only("ground"));
    expect(byId(after.walls, "allWall")?.levelScope).toEqual({ mode: "all" });
    expect(byId(after.walls, "legacyWall")?.levelScope).toBeUndefined();
    expect(byId(after.lights, "mezzLamp")?.levelScope).toEqual(only("ground", "upper"));
    expect(byId(after.regions, "well")?.stairs).toEqual(well({ levels: ["ground", "upper"], arrivals: [{ levelId: "ground", x: 2, y: 2 }] }));
    expect(byId(after.regions, "pair")?.stairs).toBeUndefined();
    expect(byId(after.regions, "pair")).toBeDefined(); // the region itself stays
    expect(byId(after.regions, "legacy")?.stairs).toEqual({ from: "ground", to: "upper" });
    expect((byId(after.regions, "directed")?.stairs as StairBehaviorV2).edges).toEqual([{ from: "ground", to: "upper" }]);
    expect(byId(after.regions, "mezzTrigger")?.triggerElevation).toEqual({ min: 0, max: 5 });
    expect(byId(after.regions, "tallTrigger")?.triggerElevation).toEqual({ min: 0, max: 20 });
    expect(byId(after.regions, "cover")?.fauxOverhead).toEqual({ kind: "fauxOverhead", coverZ: 5, affectedElevation: { bottom: 0, top: 5 } });
    expect(byId(after.tiles, "trap")?.triggerElevation).toEqual({ min: 0, max: 2 });
    expect(plan.summary.join("\n")).toMatch(/Moves 2 tokens from Mezzanine to Ground/);
    expect(plan.summary.join("\n")).toMatch(/2 walls, 1 light now belong to Ground/);
    expect(plan.summary.join("\n")).toMatch(/1 stairwell would only connect Ground to itself/);
    expect(plan.summary.join("\n")).toMatch(/Ground's band grows to 0–15/);
    expect(plan.summary.at(-1)).toMatch(/Deletes Mezzanine\. Undo brings it back/);
    expect(plan.notes.join("\n")).toMatch(/1 elevation range spans several floors/);
  });

  test("floors that do not touch: the destination band stays, feet are clamped into it, and the empty band is reported", () => {
    const s = scene();
    const plan = mergeLevelPlan(s, "cellar", "upper");
    expect(plan.error).toBeNull();
    const after = apply(s, plan.ops);
    expect(byId(after.levels, "upper")).toMatchObject({ bottom: 15, top: 25 });
    expect(byId(after.tokens, "inCellar")).toMatchObject({ levelId: "upper", elevation: 24 });
    expect(plan.notes.join("\n")).toMatch(/Cellar's band \(-10–0\) is left empty/);
    // A token whose relative height does not fit lands on the destination floor.
    const tall = scene({ tokens: [token("deep", "upper", 24)] });
    const down = apply(tall, mergeLevelPlan(tall, "upper", "cellar").ops);
    expect(byId(down.tokens, "deep")).toMatchObject({ levelId: "cellar", elevation: -1 });
    const short: SceneDocument = { ...tall, levels: (tall.levels ?? []).map((l) => l._id === "cellar" ? { ...l, bottom: -4, floorZ: -4 } : l) };
    expect(byId(apply(short, mergeLevelPlan(short, "upper", "cellar").ops).tokens, "deep")).toMatchObject({ levelId: "cellar", elevation: -4 });
  });

  test("stair remapping keeps the destination's landing, drops self-moves and stops at one floor", () => {
    expect(mergeStairLevels({ from: "a", to: "b" }, "a", "b")).toBeNull();
    expect(mergeStairLevels({ version: 2, levels: ["a", "b"], mode: "auto" }, "b", "a")).toBeNull();
    expect(mergeStairLevels({ version: 2, levels: ["a", "b", "c"], mode: "auto", edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] }, "b", "a")).toBeNull();
    expect(mergeStairLevels({ version: 2, levels: ["a", "b", "c"], mode: "auto", arrivals: [{ levelId: "b", x: 1, y: 1 }] }, "b", "c"))
      .toEqual({ version: 2, levels: ["a", "c"], mode: "auto", arrivals: [{ levelId: "c", x: 1, y: 1 }] });
  });

  test("invalid requests and the default target", () => {
    expect(mergeLevelPlan(scene(), "mezz", "mezz").error).toBe("Choose two different floors");
    expect(mergeLevelPlan(scene(), "nope", "ground").error).toBe("Choose two different floors");
    expect(defaultMergeTarget(levels(), "mezz")).toBe("ground");
    expect(defaultMergeTarget(levels(), "cellar")).toBe("ground");
    expect(defaultMergeTarget([draftLevel("solo", "Solo")], "solo")).toBeNull();
    // Isolated floor play survives a merge down to a single floor.
    const two = scene({ levels: [draftLevel("ground", "Ground", 0, 10, 0), draftLevel("upper", "Upper", 10, 20, 1)], tokens: [token("t", "upper", 12)], walls: [], lights: [], tiles: [], regions: [] });
    const plan = mergeLevelPlan(two, "upper", "ground");
    expect(plan.error).toBeNull();
    expect(apply(two, plan.ops).levels).toEqual([{ ...draftLevel("ground", "Ground", 0, 20, 0) }]);
  });
});

describe("move a floor up or down", () => {
  test("swaps bands with the neighbour, keeps heights and gaps, carries tokens and ranges, swaps display order", () => {
    const s = scene();
    const plan = moveLevelPlan(s, "ground", "up");
    expect(plan.error).toBeNull();
    const after = apply(s, plan.ops);
    expect(sceneLevelsError(after)).toBeNull();
    expect(byId(after.levels, "mezz")).toMatchObject({ bottom: 0, top: 5, floorZ: 0, sort: 1 });
    expect(byId(after.levels, "ground")).toMatchObject({ bottom: 5, top: 15, floorZ: 5, sort: 2 });
    expect(byId(after.tokens, "onGround")).toMatchObject({ levelId: "ground", elevation: 5 });
    expect(byId(after.tokens, "onMezz")).toMatchObject({ levelId: "mezz", elevation: 2 });
    expect(byId(after.tokens, "floating")).toMatchObject({ elevation: 1 });
    expect(byId(after.regions, "mezzTrigger")?.triggerElevation).toEqual({ min: 0, max: 5 });
    expect(byId(after.regions, "tallTrigger")?.triggerElevation).toEqual({ min: 0, max: 20 });
    expect(byId(after.tiles, "trap")?.triggerElevation).toEqual({ min: 0, max: 2 });
    expect(stackOrder(after.levels ?? []).map((l) => l._id)).toEqual(["cellar", "mezz", "ground", "upper", "roof"]);
    expect(plan.summary[0]).toBe("Mezzanine moves below Ground: Mezzanine 0–5, Ground 5–15.");
    // Down is the same swap seen from the other floor.
    expect(apply(s, moveLevelPlan(s, "mezz", "down").ops).levels).toEqual(after.levels);
    // A gap between the floors stays between them.
    const gapped = scene({ levels: [draftLevel("a", "A", 0, 10, 0), draftLevel("b", "B", 12, 15, 1)], tokens: [token("t", "a", 3)], walls: [], lights: [], tiles: [], regions: [] });
    const swapped = apply(gapped, moveLevelPlan(gapped, "a", "up").ops);
    expect(swapped.levels).toEqual([{ ...draftLevel("a", "A", 5, 15, 1) }, { ...draftLevel("b", "B", 0, 3, 0) }]);
    expect(byId(swapped.tokens, "t")?.elevation).toBe(8);
  });

  test("ends of the stack and open bands are refused with a reason", () => {
    expect(moveLevelPlan(scene(), "cellar", "down").error).toBe("Cellar is already the bottom floor");
    expect(moveLevelPlan(scene(), "roof", "up").error).toBe("Roof is already the top floor");
    expect(moveLevelPlan(scene(), "roof", "down").error).toBe("Floors with an open (unbounded) band stay at the ends of the stack");
    expect(moveLevelPlan(scene(), "upper", "up").error).toBe("Floors with an open (unbounded) band stay at the ends of the stack");
  });
});

describe("rescale elevations", () => {
  test("multiplies every elevation without float noise and can set the grid distance", () => {
    const s = scene({ foreground: { img: null, elevation: 30 } });
    const plan = rescaleLevelsPlan(s, 0.3, { gridDistance: true });
    expect(plan.error).toBeNull();
    const after = apply(s, plan.ops);
    expect(sceneLevelsError(after)).toBeNull();
    expect(after.levels?.map((l) => [l.bottom, l.top, l.floorZ])).toEqual([[-3, 0, -3], [0, 3, 0], [3, 4.5, 3], [4.5, 7.5, 4.5], [7.5, null, 7.5]]);
    expect(byId(after.tokens, "onMezz")?.elevation).toBe(3.6);
    expect(byId(after.tokens, "highMezz")?.elevation).toBe(4.35);
    expect(byId(after.regions, "cover")?.fauxOverhead).toEqual({ kind: "fauxOverhead", coverZ: 4.5, affectedElevation: { bottom: 3, top: 4.5 } });
    expect(byId(after.tiles, "trap")?.triggerElevation).toEqual({ min: 3, max: 3.6 });
    expect(after.foreground?.elevation).toBe(9);
    expect(after.grid.distance).toBe(1.5);
    expect(plan.summary).toContain("Grid distance 5 → 1.5 ft per cell.");
    expect(roundElevation(-0.0000001)).toBe(0);
    expect(Object.is(roundElevation(-0.0000001), -0)).toBe(false);
  });

  test("bad factors and out-of-range results are refused", () => {
    for (const f of [0, -1, Number.NaN, Infinity, 1001]) expect(rescaleLevelsPlan(scene(), f).error).toBe("Scale by a positive factor up to 1000");
    expect(rescaleLevelsPlan(scene(), 1).error).toBe("A factor of 1 changes nothing");
    const far = scene({ levels: [draftLevel("g", "G", 0, 600_000, 0)], tokens: [], regions: [], tiles: [], walls: [], lights: [] });
    expect(rescaleLevelsPlan(far, 2).error).toBe("Rescaled elevations must stay within ±1,000,000 scene units");
    const { levelMode: _mode, ...flat } = scene({ levels: [], tokens: [], regions: [], tiles: [], walls: [], lights: [] }); void _mode;
    expect(rescaleLevelsPlan(flat, 2).error).toBe("Nothing in this scene has an elevation to rescale");
  });
});
