import { test } from "node:test";
import assert from "node:assert/strict";
import {
  levelAtZ,
  pixelTolerance,
  nearestEndpoint,
  planPlainWallSplit,
  crossHorizontalPlane,
  coveredTokenPresentation,
  fogKey,
} from "./design-kernels.mjs";

const levels = [
  { id: "basement", bottom: -10, top: 0 },
  { id: "ground", bottom: 0, top: 10 },
  { id: "upper", bottom: 10, top: 20 },
  { id: "roof", bottom: 20, top: null },
];

test("adjacent level boundaries belong to exactly one upper band", () => {
  for (const [z, expected] of [
    [-10, "basement"],
    [-0.01, "basement"],
    [0, "ground"],
    [9.99, "ground"],
    [10, "upper"],
    [20, "roof"],
    [100, "roof"],
  ])
    assert.equal(levelAtZ(levels, z), expected);
  assert.equal(levelAtZ(levels, -11), null);
});
test("nonfinite or overlapping membership is not silently guessed", () => {
  assert.throws(() => levelAtZ(levels, Infinity));
  assert.throws(() => levelAtZ(levels, NaN));
  assert.throws(() =>
    levelAtZ([...levels, { id: "overlap", bottom: 5, top: 12 }], 7),
  );
});
test("CSS tolerance scales with zoom, not device pixel ratio", () => {
  assert.equal(pixelTolerance(8, 0.5), 16);
  assert.equal(pixelTolerance(8, 4), 2);
  assert.throws(() => pixelTolerance(8, 0));
});
test("snap never crosses topology/level partition and ignores locked candidates", () => {
  const endpoints = [
    { wallId: "upper", end: 0, x: 0, y: 0, topologyKey: "upper" },
    {
      wallId: "locked",
      end: 0,
      x: 0,
      y: 0,
      topologyKey: "ground",
      locked: true,
    },
    { wallId: "ground", end: 1, x: 3, y: 0, topologyKey: "ground" },
  ];
  assert.equal(
    nearestEndpoint(endpoints, { x: 0, y: 0 }, 8, 1, "ground").wallId,
    "ground",
  );
  assert.equal(
    nearestEndpoint(endpoints, { x: 0, y: 0 }, 8, 4, "ground"),
    null,
  );
});
test("snap tie is independent of input iteration order", () => {
  const a = { wallId: "a", end: 0, x: 1, y: 0, topologyKey: "ground" };
  const b = { wallId: "b", end: 0, x: -1, y: 0, topologyKey: "ground" };
  assert.equal(
    nearestEndpoint([b, a], { x: 0, y: 0 }, 2, 1, "ground").wallId,
    "a",
  );
  assert.equal(
    nearestEndpoint([a, b], { x: 0, y: 0 }, 2, 1, "ground").wallId,
    "a",
  );
});
function wall() {
  return {
    _id: "wall-a",
    type: "wall",
    name: "Stone",
    c: [0, 0, 100, 0],
    door: 0,
    move: 0,
    sight: 0,
    light: 0,
    sound: 0,
    oneWay: false,
    direction: "positiveCross",
    levelScope: { mode: "levels", ids: ["upper"] },
    zSpan: { bottom: 10, top: 20 },
    ownership: { default: 0 },
    flags: {},
    system: {},
  };
}
test("split is a two-op plan, preserves properties and does not mutate input", () => {
  const source = wall();
  const before = JSON.stringify(source);
  const ops = planPlainWallSplit("scene", source, 0.25, "wall-b");
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0].diff.c, [0, 0, 25, 0]);
  assert.deepEqual(ops[1].data.c, [25, 0, 100, 0]);
  assert.deepEqual(ops[1].data.zSpan, source.zSpan);
  assert.deepEqual(ops[1].data.levelScope, source.levelScope);
  assert.equal(ops[1].data.direction, source.direction);
  assert.equal(JSON.stringify(source), before);
  ops[1].data.levelScope.ids.push("roof");
  assert.deepEqual(source.levelScope.ids, ["upper"]);
});
test("split rejects endpoints, degenerate geometry and accidental duplicated portals", () => {
  assert.throws(() => planPlainWallSplit("scene", wall(), 0, "b"));
  assert.throws(() => planPlainWallSplit("scene", wall(), 1, "b"));
  assert.throws(() =>
    planPlainWallSplit("scene", { ...wall(), c: [0, 0, 0, 0] }, 0.5, "b"),
  );
  assert.throws(() =>
    planPlainWallSplit("scene", { ...wall(), move: 1 }, 0.5, "b"),
  );
  assert.throws(() =>
    planPlainWallSplit(
      "scene",
      { ...wall(), portal: { kind: "window" } },
      0.5,
      "b",
    ),
  );
});
test("ray plane crossing uses the actual Z intersection, not its XY midpoint", () => {
  assert.deepEqual(
    crossHorizontalPlane({ x: 0, y: 0, z: 25 }, { x: 10, y: 20, z: 5 }, 10),
    { kind: "point", t: 0.75, x: 7.5, y: 15 },
  );
});
test("parallel/coplanar/endpoint cases remain distinct for the geometry caller", () => {
  const a = { x: 0, y: 0, z: 10 },
    b = { x: 5, y: 5, z: 10 };
  assert.deepEqual(crossHorizontalPlane(a, b, 10), { kind: "coplanar" });
  assert.deepEqual(crossHorizontalPlane(a, b, 0), { kind: "none" });
  assert.equal(crossHorizontalPlane(a, { ...b, z: 20 }, 10).t, 0);
});
test("Faux display preference never discloses an unauthorized token or hidden enemy", () => {
  for (const preference of ["hidden", "ghost", "hitbox", "normal"]) {
    assert.deepEqual(
      coveredTokenPresentation({
        authorized: false,
        visibleByLos: true,
        privileged: true,
        preference,
      }),
      { mode: "hidden", targetCandidate: false, hitTest: false },
    );
    assert.equal(
      coveredTokenPresentation({
        authorized: true,
        visibleByLos: false,
        privileged: false,
        preference,
      }).mode,
      "hidden",
    );
  }
});
test("real LOS yields a ghost; privileged diagnostic display does not grant targeting LOS", () => {
  assert.deepEqual(
    coveredTokenPresentation({
      authorized: true,
      visibleByLos: true,
      privileged: false,
      preference: "hidden",
    }),
    { mode: "ghost", targetCandidate: true, hitTest: true },
  );
  assert.deepEqual(
    coveredTokenPresentation({
      authorized: true,
      visibleByLos: false,
      privileged: true,
      preference: "normal",
    }),
    { mode: "normal", targetCandidate: false, hitTest: true },
  );
});
test("fog identity cannot alias levels/users or delimiter-bearing IDs", () => {
  assert.notEqual(
    fogKey("w", "s", "ground", "u"),
    fogKey("w", "s", "basement", "u"),
  );
  assert.notEqual(
    fogKey("w", "s", "ground", "u"),
    fogKey("w", "s", "ground", "other"),
  );
  assert.notEqual(
    fogKey("w:a", "b", "ground", "u"),
    fogKey("w", "a:b", "ground", "u"),
  );
  assert.throws(() => fogKey("w", "s", "", "u"));
});
