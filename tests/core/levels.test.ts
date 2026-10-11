import { expect, test } from "vitest";
import { draftLevel, levelDraftAudit, levelDraftOps, levelTransactionError, sceneLevelsError } from "../../src/core/levels";
import { DocumentStore } from "../../src/core/store";
import { projectEnvelope, projectWorld } from "../../src/core/projection";
import { can } from "../../src/core/permissions";
import { planDuplicateSceneOps } from "../../src/core/sceneCopy";
import type { LevelDocument, SceneDocument } from "../../src/core/documents";
import type { Op, OpEnvelope } from "../../src/core/ops";
import { emptyWorld } from "../net/fixtures";
const levels = () => [draftLevel("base", "Base", 0, 10), draftLevel("upper", "Upper", 10, null, 1)];
function scene(): SceneDocument {
  return { _id: "s", type: "scene", name: "Scene", active: true, ownership: { default: 3 }, flags: {}, system: {},
    img: null, width: 100, height: 100, darkness: 0, grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [], walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [], levels: levels() };
}
const parent = { coll: "scenes" as const, id: "s" };
const envelope = (ops: Op[], seq = 1): OpEnvelope => ({ seq, ts: 0, txId: `tx-${seq}`, by: "gm", ops });
const player = { id: "p", role: "PLAYER" as const };

test("draft validation accepts legacy scenes and adjacent half-open bands, rejects overlaps and bad references", () => {
  expect(sceneLevelsError({})).toBeNull(); expect(sceneLevelsError({ levels: [] })).toBeNull();
  expect(sceneLevelsError({ levels: levels() })).toBeNull();
  const bad = levels(); const upper = bad[1]; if (!upper) throw new Error("fixture");
  upper.bottom = 9; expect(sceneLevelsError({ levels: bad })).toContain("overlap");
  upper.bottom = 10; upper.visibleLevelIds = ["missing"]; expect(sceneLevelsError({ levels: bad })).toContain("missing");
  upper.visibleLevelIds = ["base"]; expect(sceneLevelsError({ levels: bad })).toBeNull();
});
test.each([NaN, Infinity, 1_000_001])("invalid height %s fails closed", (n) => {
  expect(sceneLevelsError({ levels: [draftLevel("a", "A", n, null)] })).not.toBeNull();
});
test("drafts reject sparse rows, duplicate IDs, invalid floors and budgets", () => {
  expect(sceneLevelsError({ levels: new Array(2) })).not.toBeNull();
  expect(sceneLevelsError({ levels: [draftLevel("a", "A"), draftLevel("a", "B", 10, 20)] })).toContain("identity");
  const level = draftLevel("a", "A"); level.floorZ = 10;
  expect(sceneLevelsError({ levels: [level] })).toContain("floor");
  expect(sceneLevelsError({ levels: new Array(33) })).toContain("32");
});
test("audit warns on gaps and unmatched feet without altering elevations", () => {
  const s = scene(); s.levels = [draftLevel("a", "A", 0, 5), draftLevel("b", "B", 10, 20)];
  s.tokens = [{ _id: "token", elevation: 7 } as never];
  const before = structuredClone(s);
  expect(levelDraftAudit(s)).toHaveLength(2); expect(s).toEqual(before);
});
test("embedded store operations and final staged bands are atomic and reversible", () => {
  const s = scene(), store = new DocumentStore({ meta: { worldId: "w", name: "W", system: "s", systemVersion: "1" } });
  store.hydrate({ scenes: [s] }, 0);
  const ops: Op[] = [
    { kind: "update", ref: { coll: "levels", id: "base", parent }, diff: { top: 12 } },
    { kind: "update", ref: { coll: "levels", id: "upper", parent }, diff: { bottom: 12, floorZ: 12 } },
  ];
  expect(levelTransactionError([ops[0] as Op], (ref) => store.resolve(ref))).toContain("overlap");
  expect(levelTransactionError(ops, (ref) => store.resolve(ref))).toBeNull();
  const result = store.applyEnvelope(envelope(ops)); if (!result.ok) throw new Error(result.error);
  expect(store.resolve({ coll: "levels", id: "upper", parent })).toMatchObject({ floorZ: 12 });
  expect(store.applyEnvelope(envelope([...result.value.inverses].reverse(), 2)).ok).toBe(true);
  expect(store.get("scenes", "s")?.levels).toEqual(s.levels);
});
test("minimal draft diffs preserve metadata and no-op plans are empty", () => {
  const before = levels(), after = structuredClone(before);
  const first = after[0]; if (!first) throw new Error("fixture"); first.name = "Ground";
  expect(levelDraftOps("s", before, after)).toEqual([{ kind: "update", ref: { coll: "levels", id: "base", parent }, diff: { name: "Ground" } }]);
  expect(levelDraftOps("s", before, before)).toEqual([]);
});
test("copy rekeys level identities and all directed visibility links without touching source", () => {
  const s = scene(), first = s.levels?.[0]; if (!first) throw new Error("fixture"); first.visibleLevelIds = ["base", "upper"];
  const before = structuredClone(s), plan = planDuplicateSceneOps({ scene: s, id: "copy" });
  if (!plan.ok) throw new Error(plan.error);
  expect(plan.copy.levels?.map((l) => l._id)).not.toEqual(["base", "upper"]);
  expect(plan.copy.levels?.[0]?.visibleLevelIds).toEqual(plan.copy.levels?.map((l) => l._id));
  expect(sceneLevelsError(plan.copy)).toBeNull(); expect(s).toEqual(before);
});
test("player owner cannot read or mutate draft records and receives no snapshot metadata", () => {
  const s = scene(), first = s.levels?.[0]; if (!first) throw new Error("fixture"); first.ownership = { default: 3 };
  for (const action of ["read", "create", "update", "delete"] as const) expect(can(player, action, first, "levels", { parent: s })).toBe(false);
  const world = emptyWorld(); world.scenes = [s];
  expect(projectWorld(world, 0, player).collections.scenes?.[0]).not.toHaveProperty("levels");
  expect(projectWorld(world, 0, { id: "gm", role: "GM" }).collections.scenes?.[0]?.levels).toEqual(s.levels);
});
test("player projection strips create, direct embedded ops, whole-array/dotted/deletion updates even without a resolver", () => {
  const s = scene(), level = s.levels?.[0] as LevelDocument;
  const ref = { coll: "levels" as const, id: "base", parent };
  for (const op of [
    { kind: "create", coll: "levels", parent, data: level },
    { kind: "update", ref, diff: { name: "Secret" } },
    { kind: "delete", ref },
  ] as Op[]) expect(projectEnvelope(envelope([op]), player)).toBeNull();
  for (const key of ["levels", "levels.0.name", "-=levels", "-=levels.0"]) {
    const projected = projectEnvelope(envelope([{ kind: "update", ref: parent, diff: { [key]: "Secret", name: "Public" } }]), player);
    expect(projected?.ops).toEqual([{ kind: "update", ref: parent, diff: { name: "Public" } }]);
  }
  const created = projectEnvelope(envelope([{ kind: "create", coll: "scenes", data: s }]), player);
  expect(created?.ops[0]).not.toHaveProperty("data.levels");
  expect(JSON.stringify(created)).not.toContain("Upper");
});

test("membership validates final atomic relocation and refuses dangling level deletion", () => {
  const s = scene(); s.tokens = [{ _id: "t", levelId: "base", elevation: 0 } as never];
  const resolve = () => s;
  const move: Op = { kind: "update", ref: { coll: "tokens", id: "t", parent }, diff: { levelId: "upper", elevation: 10 } };
  expect(levelTransactionError([move], resolve)).toBeNull();
  expect(levelTransactionError([{ ...move, diff: { levelId: "upper" } }], resolve)).toContain("elevation");
  const remove: Op = { kind: "delete", ref: { coll: "levels", id: "base", parent } };
  expect(levelTransactionError([remove], resolve)).toContain("missing");
  expect(levelTransactionError([remove, move], resolve)).toBeNull();
  expect(s.tokens[0]?.levelId).toBe("base");
});
test("scoped walls require explicit valid references, and copy rekeys bindings", () => {
  const s = scene();
  s.walls = [{ _id: "w", type: "wall", c: [0, 0, 10, 10], flags: {}, system: {}, ownership: { default: 0 }, levelScope: { mode: "levels", ids: ["base"] } } as never];
  s.tokens = [{ _id: "t", type: "token", flags: {}, system: {}, ownership: { default: 3 }, levelId: "upper", elevation: 10 } as never];
  expect(sceneLevelsError(s)).toBeNull();
  expect(sceneLevelsError({ walls: s.walls })).toContain("explicit");
  const plan = planDuplicateSceneOps({ scene: s, id: "copy" });
  if (!plan.ok) throw new Error(plan.error);
  expect(plan.copy.walls[0]?.levelScope).toEqual({ mode: "levels", ids: [plan.copy.levels?.[0]?._id] });
  expect(plan.copy.tokens[0]?.levelId).toBe(plan.copy.levels?.[1]?._id);
  expect(sceneLevelsError(plan.copy)).toBeNull();
  const world = emptyWorld(); world.scenes = [s];
  const projected = projectWorld(world, 0, player).collections.scenes?.[0];
  expect(projected?.walls[0]).not.toHaveProperty("levelScope");
  expect(projected?.tokens[0]).not.toHaveProperty("levelId");
  expect(s.walls[0]).toHaveProperty("levelScope");
  for (const coll of ["tokens", "walls"] as const) {
    const field = coll === "tokens" ? "levelId" : "levelScope";
    const doc = s[coll][0]; if (!doc) throw new Error("fixture");
    const created = projectEnvelope(envelope([{ kind: "create", coll, parent, data: doc }]), player);
    expect(created?.ops[0]).not.toHaveProperty(`data.${field}`);
    for (const key of [field, `${field}.ids`, `-=${field}`]) {
      expect(projectEnvelope(envelope([{ kind: "update", ref: { coll, id: doc._id, parent }, diff: { [key]: "secret" } }]), player)).toBeNull();
    }
  }
});
test("scene array and dotted replacements never disclose membership in envelope-only projection", () => {
  for (const diff of [
    { walls: [{ _id: "w", levelScope: { mode: "levels", ids: ["secret"] } }] },
    { "tokens.0": { _id: "t", levelId: "secret" } },
    { "tokens.0.levelId": "secret" },
    { "walls.0.levelScope.ids": ["secret"] },
  ]) {
    const projected = projectEnvelope(envelope([{ kind: "update", ref: parent, diff: diff as never }]), player);
    expect(JSON.stringify(projected)).not.toContain("secret");
  }
});

test("light scope bindings validate, rekey on copy, and stay private in snapshots and envelopes", () => {
  const s = scene(); s.lights = [{ _id: "light", type: "light", flags: {}, system: {}, ownership: { default: 3 }, levelScope: { mode: "levels", ids: ["base"] }, x: 0, y: 0, bright: 10, dim: 20, color: "#fff", alpha: 1 } as never];
  expect(sceneLevelsError(s)).toBeNull();
  expect(levelTransactionError([{ kind: "delete", ref: { coll: "levels", id: "base", parent } }], () => s)).toContain("existing level");
  const plan = planDuplicateSceneOps({ scene: s, id: "copy" }); if (!plan.ok) throw new Error(plan.error);
  expect(plan.copy.lights[0]?.levelScope).toEqual({ mode: "levels", ids: [plan.copy.levels?.[0]?._id] });
  const world = emptyWorld(); world.scenes = [s];
  expect(projectWorld(world, 0, player).collections.scenes?.[0]?.lights[0]).not.toHaveProperty("levelScope");
  for (const diff of [{ lights: s.lights }, { "lights.0": s.lights[0] }, { "lights.0.levelScope": { mode: "levels", ids: ["base"] } }])
    expect(JSON.stringify(projectEnvelope(envelope([{ kind: "update", ref: parent, diff: diff as never }]), player))).not.toContain("levelScope");
});

test.each([null, -0.01, 1.01, NaN, Infinity, "0.5"])("invalid level ambient %s fails closed", (darkness) => {
  const l = { ...draftLevel("a", "A"), darkness };
  expect(sceneLevelsError({ levels: [l] })).toContain("Level darkness");
});
test("level ambient inheritance uses explicit removal, minimal diffs, undo and copy", () => {
  const s = scene(), before = structuredClone(s.levels ?? []), after = structuredClone(before);
  const base = after[0]; if (!base) throw new Error("fixture"); base.darkness = 0;
  const ops = levelDraftOps("s", before, after);
  expect(ops).toEqual([{ kind: "update", ref: { coll: "levels", id: "base", parent }, diff: { darkness: 0 } }]);
  expect(levelDraftOps("s", after, before)).toEqual([{ kind: "update", ref: { coll: "levels", id: "base", parent }, diff: { "-=darkness": null } }]);
  const store = new DocumentStore({ meta: { worldId: "w", name: "W", system: "s", systemVersion: "1" } }); store.hydrate({ scenes: [s] }, 0);
  const result = store.applyEnvelope(envelope(ops)); if (!result.ok) throw new Error(result.error);
  const saved = store.get("scenes", "s"); if (!saved) throw new Error("fixture");
  const copied = planDuplicateSceneOps({ scene: saved, id: "copy" }); if (!copied.ok) throw new Error(copied.error);
  expect(copied.copy.levels?.[0]?.darkness).toBe(0);
  expect(store.applyEnvelope(envelope([...result.value.inverses].reverse(), 2)).ok).toBe(true);
  expect(store.get("scenes", "s")?.levels?.[0]).not.toHaveProperty("darkness");
  const world = emptyWorld(); world.scenes = [saved];
  expect(projectWorld(world, 0, player).collections.scenes?.[0]).not.toHaveProperty("levels");
  expect(projectEnvelope(envelope(ops), player)).toBeNull();
});
