import { expect, test } from "vitest";
import { draftLevel } from "../../src/core/levels";
import { levelScopeError, wallTopologyKey, wallsForAuthoring } from "../../src/core/levelMembership";
import { joinedWallEndpoints } from "../../src/core/wallEditing";
import { DRAFT_LEVELS_FEATURE, LEVEL_SCOPES_FEATURE, requiredOpFeatures, requiredWorldFeatures } from "../../src/core/capabilities";
import type { WallDocument } from "../../src/core/documents";
const levels = [draftLevel("a", "A"), draftLevel("b", "B", 10, 20)];
test.each([null, {}, { mode: "levels", ids: [] }, { mode: "levels", ids: ["a", "a"] }, { mode: "levels", ids: ["missing"] }, { mode: "all", ids: ["a"] }, { mode: "levels", ids: new Array(1) }])("rejects invalid scope %j", (s) => {
  expect(levelScopeError(s, levels)).not.toBeNull();
});
test("authoring partitions do not merge coincident joints on unrelated floors", () => {
  const walls = [undefined, { mode: "all" }, { mode: "levels", ids: ["a"] }, { mode: "levels", ids: ["b"] }, { mode: "levels", ids: ["a"] }].map((levelScope, i) => ({ _id: String(i), c: [0, 0, 10, 10], flags: {}, levelScope } as WallDocument));
  expect(wallsForAuthoring(walls, null).map((w) => w._id)).toEqual(["0"]);
  expect(wallsForAuthoring(walls, "*").map((w) => w._id)).toEqual(["1"]);
  expect(wallsForAuthoring(walls, "a").map((w) => w._id)).toEqual(["2", "4"]);
  expect(joinedWallEndpoints(walls, { wallId: "2", end: 0, point: { x: 0, y: 0 } }, true)).toMatchObject({ ok: true, value: [{ wallId: "2" }, { wallId: "4" }] });
  expect(wallTopologyKey({ levelScope: { mode: "levels", ids: ["b", "a"] } })).toBe(wallTopologyKey({ levelScope: { mode: "levels", ids: ["a", "b"] } }));
});
test("scope wire gate is separate from drafts and never required from players", () => {
  const required = [DRAFT_LEVELS_FEATURE, LEVEL_SCOPES_FEATURE];
  expect(requiredOpFeatures([{ kind: "update", ref: { coll: "tokens", id: "t", parent: { coll: "scenes", id: "s" } }, diff: { levelId: "a" } }])).toEqual(required);
  expect(requiredOpFeatures([{ kind: "update", ref: { coll: "scenes", id: "s" }, diff: { "walls.0.levelScope.ids": ["a"] } }])).toEqual(required);
  const scene = { levels, tokens: [{ levelId: "a" }], walls: [] } as never;
  expect(requiredWorldFeatures([scene], "GM")).toEqual(required);
  expect(requiredWorldFeatures([scene], "PLAYER")).toEqual([]);
});
