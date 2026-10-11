import { expect, test } from "vitest";
import { convexOverlap, levelAuditFixOps, levelPlayAudit } from "../../src/core/levelAudit";
import { draftLevel, sceneLevelsError } from "../../src/core/levels";
import { applyDiff } from "../../src/core/diff";
import { stairMovementPlan } from "../../src/core/levelPlay";
import type { LightDocument, RegionDocument, SceneDocument, TileDocument, TokenDocument, WallDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";

const base = { ownership: { default: 0 as const }, flags: {}, system: {} };
const region = (id: string, stairs: NonNullable<RegionDocument["stairs"]>, x = 100): RegionDocument =>
  ({ ...base, _id: id, type: "region", name: id, hidden: true, x, y: 0, width: 100, height: 100, shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, stairs });
const wall = (id: string, c: WallDocument["c"], scope?: WallDocument["levelScope"]): WallDocument =>
  ({ ...base, _id: id, type: "wall", name: id, c, door: 0, oneWay: false, move: 0, sight: 0, light: 0, sound: 0, ...(scope ? { levelScope: scope } : {}) });
const token = (id: string, elevation: number, levelId?: string): TokenDocument =>
  ({ ...base, _id: id, type: "token", name: id, x: 500, y: 500, width: 50, height: 50, rotation: 0, elevation, ...(levelId ? { levelId } : {}), img: "", vision: false, hidden: false, disposition: "neutral", light: { radius: 0, color: "#fff", alpha: 0 } });
const tile = (id: string): TileDocument => ({ ...base, _id: id, type: "tile", name: id, x: 0, y: 0, width: 10, height: 10, img: "https://example.invalid/a.png", above: false, occlusion: { mode: "fade", alpha: 1 } });
function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return { ...base, _id: "s", type: "scene", name: "s", active: true, img: null, width: 1000, height: 1000, grid: { type: "square", size: 50, distance: 5, units: "ft" } as SceneDocument["grid"],
    darkness: 0, levels: [{ ...draftLevel("ground", "Ground", 0, 10, 0), tileIds: ["g"] }, { ...draftLevel("upper", "Upper", 10, 20, 1), tileIds: ["u"] }, { ...draftLevel("cellar", "Cellar", -10, 0, -1), useSceneBackground: true }],
    tokens: [], walls: [], lights: [], sounds: [], tiles: [tile("g"), tile("u")], drawings: [], templates: [], notes: [], regions: [], ...over };
}
const apply = (s: SceneDocument, ops: Op[]): SceneDocument => {
  let out = structuredClone(s);
  for (const op of ops) {
    const coll = op.kind === "create" ? op.coll : op.ref.coll;
    const rows = out[coll as "walls"] as Array<{ _id: string }>;
    if (op.kind === "delete") { out = { ...out, [coll]: rows.filter((r) => r._id !== op.ref.id) }; continue; }
    if (op.kind !== "update") continue;
    out = { ...out, [coll]: rows.map((r) => { if (r._id !== op.ref.id) return r; const next = applyDiff(r, op.diff); if (!next.ok) throw new Error(next.error); return next.value; }) };
  }
  return out;
};

test("a clean three-floor scene passes; the check names what floor play would get wrong", () => {
  const stairwell = region("well", { version: 2, levels: ["cellar", "ground", "upper"], mode: "auto", label: "Spiral" });
  expect(levelPlayAudit(scene({ regions: [stairwell] }))).toEqual([]);
  expect(levelPlayAudit(scene({ levels: [] }))).toEqual([expect.objectContaining({ code: "no-levels", severity: "error" })]);
  const messy = scene({
    walls: [wall("loose", [0, 0, 10, 0]), wall("scoped", [0, 0, 10, 0], { mode: "all" })],
    lights: [{ ...base, _id: "lamp", type: "light", name: "lamp", x: 1, y: 1, dim: 1, bright: 1, color: "#fff", alpha: 1 } as LightDocument],
    tokens: [token("drifter", 0)], tiles: [tile("g"), tile("u"), tile("orphan")],
    levels: [{ ...draftLevel("ground", "Ground", 0, 10, 0), tileIds: ["g"] }, { ...draftLevel("upper", "Upper", 10, 20, 1) }],
    regions: [region("up", { from: "ground", to: "upper" })],
  });
  const codes = levelPlayAudit(messy).map((f) => `${f.severity}:${f.code}${f.fix ? `→${f.fix}` : ""}`);
  expect(codes).toEqual(["warning:unassigned-walls→walls-all", "warning:unassigned-lights→lights-all", "warning:floorless-tokens→tokens-by-band",
    "warning:floor-without-art", "info:unassigned-tiles", "info:one-way-stairs"]);
  expect(levelPlayAudit(scene({ walls: [wall("loose", [0, 0, 10, 0])] }))[0]?.message).toBe("1 wall has no floor. In floor play they neither show nor block movement or sight.");
});

test("stairs: overlaps are explained (and mergeable when they are legacy pairs), blocked landings and isolated floors are flagged", () => {
  const legacy = scene({ regions: [region("up", { from: "ground", to: "upper" }), region("down", { from: "ground", to: "cellar" }), region("back-up", { from: "upper", to: "ground" }), region("back-down", { from: "cellar", to: "ground" })] });
  const overlap = levelPlayAudit(legacy).filter((f) => f.code === "overlapping-stairs");
  expect(overlap).toHaveLength(1);
  expect(overlap[0]).toMatchObject({ ids: ["down", "up"], fix: "merge-stairs" });
  const merged = apply(legacy, levelAuditFixOps(legacy, "merge-stairs"));
  expect(merged.regions?.map((r) => r._id)).toEqual(["up"]);
  expect(merged.regions?.[0]?.stairs).toEqual({ version: 2, levels: ["cellar", "ground", "upper"], mode: "auto",
    edges: [{ from: "ground", to: "upper" }, { from: "ground", to: "cellar" }, { from: "upper", to: "ground" }, { from: "cellar", to: "ground" }] });
  expect(sceneLevelsError(merged)).toBeNull();
  expect(levelPlayAudit(merged)).toEqual([]);
  // Merged, the testers' stairwell offers a choice instead of refusing the move.
  const walker = { ...merged, levelMode: "isolated" as const, tokens: [{ ...token("hero", 0, "ground"), x: 50, y: 50, width: 20, height: 20 }] };
  expect(stairMovementPlan([{ kind: "update", ref: { coll: "tokens", id: "hero", parent: { coll: "scenes", id: "s" } }, diff: { x: 150 } }], () => walker).prompts[0]?.choices.map((c) => c.levelId)).toEqual(["upper", "cellar"]);
  const blocked = scene({ regions: [region("pair", { version: 2, levels: ["ground", "upper"], mode: "auto" })], walls: [wall("w", [150, 0, 150, 100], { mode: "levels", ids: ["upper"] })] });
  expect(levelPlayAudit(blocked).map((f) => f.code)).toEqual(["isolated-floor", "landing-blocked"]);
  const partial = scene({ regions: [region("pair", { version: 2, levels: ["ground", "upper"], mode: "auto", locked: true })] });
  expect(levelPlayAudit(partial).map((f) => f.code)).toEqual(["isolated-floor", "stairs-locked"]);
  expect(convexOverlap([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }])).toBe(false);
});

test("quick fixes are plain undoable plans: walls/lights on every floor, tokens by elevation band", () => {
  const locked = { ...wall("locked", [0, 0, 1, 1]), flags: { core: { wallLocked: true } } } as unknown as WallDocument;
  const s = scene({ walls: [wall("loose", [0, 0, 10, 0]), locked], tokens: [token("high", 12), token("deep", -500), token("set", 0, "ground")],
    lights: [{ ...base, _id: "lamp", type: "light", name: "lamp", x: 1, y: 1, dim: 1, bright: 1, color: "#fff", alpha: 1 } as LightDocument] });
  expect(levelAuditFixOps(s, "walls-all").map((op) => op.kind === "update" ? [op.ref.id, op.diff] : null)).toEqual([["loose", { levelScope: { mode: "all" } }]]);
  expect(levelAuditFixOps(s, "lights-all")).toHaveLength(1);
  const tokens = levelAuditFixOps(s, "tokens-by-band");
  expect(tokens.map((op) => op.kind === "update" ? [op.ref.id, op.diff] : null)).toEqual([["high", { levelId: "upper" }], ["deep", { levelId: "cellar", elevation: -10 }]]);
  expect(sceneLevelsError(apply(s, tokens))).toBeNull();
});
