import { expect, test } from "vitest";
import { bindingRevision, planTokenBinding, planWallBinding } from "../../src/ui/images/levelBindingEditor";
import { draftLevel, sceneLevelsError } from "../../src/core/levels";
import { DocumentStore } from "../../src/core/store";
import { wallFieldsFor } from "../../src/canvas/vision/wallKinds";
import type { SceneDocument } from "../../src/core/documents";
const scene = (): SceneDocument => ({ _id: "s", type: "scene", name: "S", flags: {}, system: {}, ownership: { default: 0 },
  levels: [draftLevel("base", "Base"), draftLevel("upper", "Upper", 10, 20)],
  tokens: [{ _id: "t", type: "token", name: "T", flags: {}, system: {}, ownership: { default: 0 }, elevation: 3, x: 10, y: 20, rotation: 0, width: 100, height: 100, img: "", vision: true, hidden: false, disposition: "neutral", light: { radius: 0, color: "#fff", alpha: 0 } }],
  walls: [{ _id: "w", type: "wall", name: "W", flags: {}, system: {}, ownership: { default: 0 }, ...wallFieldsFor("wall", [0, 0, 100, 0]) }],
  active: true, img: null, width: 1000, height: 1000, darkness: 0, grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [] });
test("token assignment explicitly relocates feet and clearing preserves elevation; no-op plans stay empty", () => {
  const s = scene(), before = structuredClone(s);
  expect(planTokenBinding(s, "t", "upper")).toMatchObject([{ diff: { levelId: "upper", elevation: 10 } }]);
  expect(s).toEqual(before);
  expect(planTokenBinding(s, "t", null)).toEqual([]);
  const t = s.tokens[0]; if (!t) throw new Error("fixture");
  t.levelId = "upper"; t.elevation = 10;
  expect(planTokenBinding(s, "t", "upper")).toEqual([]);
  expect(planTokenBinding(s, "t", null)).toMatchObject([{ diff: { "-=levelId": null } }]);
  expect(() => planTokenBinding(s, "gone", "upper")).toThrow("no longer exists");
  expect(() => planTokenBinding(s, "t", "gone")).toThrow("does not exist");
  t.flags.prefab = {}; expect(() => planTokenBinding(s, "t", null)).toThrow("owning workflow");
});
test("wall plans preserve geometry and reject locked, missing, duplicate or dangling scopes", () => {
  const s = scene(), before = structuredClone(s);
  expect(planWallBinding(s, "w", { mode: "levels", ids: ["upper", "base"] })).toMatchObject([{ diff: { levelScope: { mode: "levels", ids: ["base", "upper"] } } }]);
  expect(s).toEqual(before); expect(planWallBinding(s, "w", undefined)).toEqual([]);
  for (const ids of [[], ["base", "base"], ["gone"]]) expect(() => planWallBinding(s, "w", { mode: "levels", ids })).toThrow();
  expect(() => planWallBinding(s, "gone", { mode: "all" })).toThrow("no longer exists");
  const w = s.walls[0]; if (!w) throw new Error("fixture");
  w.levelScope = { mode: "levels", ids: ["upper", "base"] };
  expect(planWallBinding(s, "w", { mode: "levels", ids: ["base", "upper"] })).toEqual([]);
  expect(planWallBinding(s, "w", undefined)).toMatchObject([{ diff: { "-=levelScope": null } }]);
  w.flags.core = { wallLocked: true }; expect(() => planWallBinding(s, "w", undefined)).toThrow("Locked");
});
test("selection revision fences external object and level changes but ignores unrelated scene metadata", () => {
  const s = scene(), before = bindingRevision(s, "tokens", "t");
  s.name = "Renamed"; expect(bindingRevision(s, "tokens", "t")).toBe(before);
  const token = s.tokens[0]; if (!token) throw new Error("fixture");
  token.x++; expect(bindingRevision(s, "tokens", "t")).not.toBe(before); token.x--;
  s.levels?.push(draftLevel("third", "Third", 20, 30)); expect(bindingRevision(s, "tokens", "t")).not.toBe(before);
});
test("assignment operations undo and redo as one transaction without mutating XY or wall axes", () => {
  const s = scene(), store = new DocumentStore({ meta: { worldId: "w", name: "W", system: "s", systemVersion: "1" } }); store.hydrate({ scenes: [s] }, 0);
  const ops = [...planTokenBinding(s, "t", "upper"), ...planWallBinding(s, "w", { mode: "all" })];
  const result = store.applyEnvelope({ seq: 1, by: "gm", ts: 0, txId: "binding", ops });
  if (!result.ok) throw new Error(result.error);
  const after = store.get("scenes", "s"); if (!after) throw new Error("fixture");
  expect(sceneLevelsError(after)).toBeNull(); expect(after.tokens[0]).toMatchObject({ x: 10, y: 20, elevation: 10, levelId: "upper" });
  expect(after.walls[0]).toMatchObject({ c: [0, 0, 100, 0], move: 0, levelScope: { mode: "all" } });
  expect(store.applyEnvelope({ seq: 2, by: "gm", ts: 0, txId: "undo", ops: [...result.value.inverses].reverse() }).ok).toBe(true);
  expect(store.get("scenes", "s")).toEqual(s);
  expect(store.applyEnvelope({ seq: 3, by: "gm", ts: 0, txId: "redo", ops }).ok).toBe(true);
  expect(store.get("scenes", "s")).toEqual(after);
});
test("G-06: notes, drawings, templates and regions use the same scope plans", () => {
  const s = scene();
  s.notes = [{ _id: "pin", type: "note", name: "Pin", ownership: { default: 2 }, flags: {}, system: {}, x: 1, y: 1, text: "", icon: "" }];
  expect(planWallBinding(s, "pin", { mode: "levels", ids: ["upper"] }, "notes")).toEqual([{ kind: "update", ref: { coll: "notes", id: "pin", parent: { coll: "scenes", id: s._id } }, diff: { levelScope: { mode: "levels", ids: ["upper"] } } }]);
  expect(() => planWallBinding(s, "missing", { mode: "all" }, "drawings")).toThrow("no longer exists");
  expect(bindingRevision(s, "regions", "none")).toContain(s._id);
});
