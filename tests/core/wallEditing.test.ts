import { describe, expect, test } from "vitest";
import type { WallDocument } from "../../src/core/documents";
import { wallFieldsFor } from "../../src/canvas/vision/wallKinds";
import {
  guardedWallEditError, joinedWallEndpoints, nearestWallEndpoint, planWallCorner,
  planWallSplit, wallCoordinatesError, wallEditGuard, wallSceneHash,
} from "../../src/core/wallEditing";
import { DocumentStore } from "../../src/core/store";

const wall = (id: string, c: WallDocument["c"], kind: "wall" | "door" | "window" = "wall"): WallDocument => ({
  _id: id, type: "wall", name: id, ownership: { default: 0 }, flags: {}, system: {}, ...wallFieldsFor(kind, c),
});
const joint = [{ wallId: "a", end: 1 as const, point: { x: 100, y: 0 } }, { wallId: "b", end: 0 as const, point: { x: 100, y: 0 } }];

describe("native wall editor plans", () => {
  test("endpoint tolerance is CSS-pixel sized with stable ID/end ties", () => {
    const walls = [wall("b", [0, 0, 100, 0]), wall("a", [0, 0, 0, 100])];
    expect(nearestWallEndpoint(walls, { x: 7, y: 0 }, 1)?.wallId).toBe("a");
    expect(nearestWallEndpoint([...walls].reverse(), { x: 7, y: 0 }, 1)?.wallId).toBe("a");
    expect(nearestWallEndpoint(walls, { x: 7, y: 0 }, 2)).toBeNull();
    expect(nearestWallEndpoint(walls, { x: 14, y: 0 }, .5)?.point).toEqual({ x: 0, y: 0 });
    expect(nearestWallEndpoint(walls, { x: 0, y: 0 }, 0)).toBeNull();
    expect(nearestWallEndpoint(walls, { x: 0, y: 0 }, 1, [{ wallId: "a", end: 0 }])?.wallId).toBe("b");
  });
  test("snap ignores locked/prefab walls and invalid geometry", () => {
    const walls = [wall("a", [0, 0, 100, 0])];
    const a = walls[0] as WallDocument;
    a.flags.core = { wallLocked: true };
    expect(nearestWallEndpoint(walls, { x: 0, y: 0 }, 1)).toBeNull();
    a.flags = { prefab: { locked: false } };
    expect(nearestWallEndpoint(walls, { x: 0, y: 0 }, 1)).toBeNull();
    a.flags = {}; a.c = [NaN, 0, 100, 0];
    expect(nearestWallEndpoint(walls, { x: 0, y: 0 }, 1)).toBeNull();
  });
  test("moving a joint produces one coordinate update per wall and no preview mutation", () => {
    const walls = [wall("a", [0, 0, 100, 0]), wall("b", [100, 0, 100, 100], "door")];
    const original = structuredClone(walls);
    const result = planWallCorner("scene", walls, joint, { x: 120, y: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.ops).toHaveLength(2);
    expect(result.value.preview.map((w) => w.c)).toEqual([[0, 0, 120, 30], [120, 30, 100, 100]]);
    expect(result.value.preview[1]?.move).toBe(1); // door state/axes preserved
    expect(walls).toEqual(original);
    expect(guardedWallEditError(result.value.guard, { _id: "scene", walls }, result.value.ops)).toBeNull();
  });
  test("joined selection is exact, bounded and refuses tearing away from locked members", () => {
    const walls = [wall("a", [0, 0, 100, 0]), wall("b", [100, 0, 100, 100]), wall("near", [101, 0, 101, 100])];
    const selected = joint[0]; if (!selected) throw new Error("fixture");
    expect(joinedWallEndpoints(walls, selected, true)).toMatchObject({ ok: true, value: joint });
    expect(joinedWallEndpoints(walls, selected, false)).toMatchObject({ ok: true, value: [selected] });
    (walls[1] as WallDocument).flags.core = { wallLocked: true };
    expect(joinedWallEndpoints(walls, selected, true).ok).toBe(false);
    expect(planWallCorner("scene", walls, joint, { x: 150, y: 10 }).ok).toBe(false);
  });
  test("corner plans reject collapsing a segment and no-op plans contain no writes", () => {
    const walls = [wall("a", [0, 0, 100, 0])];
    const selected = joint[0]; if (!selected) throw new Error("fixture");
    expect(planWallCorner("scene", walls, [selected], { x: 0, y: 0 }).ok).toBe(false);
    expect(planWallCorner("scene", walls, [selected], { x: 100, y: 0 })).toMatchObject({ ok: true, value: { ops: [] } });
    expect(wallCoordinatesError([1, 2, 3, Infinity])).not.toBeNull();
    expect(wallCoordinatesError([1, 2, 3, 4, 5])).not.toBeNull();
  });
  test("split projects onto the segment, retains identity, direction and independent metadata", () => {
    const source = wall("a", [100, 0, 0, 0]); source.oneWay = true;
    source.flags = { custom: { note: [1, 2] } }; source.taggerTags = ["exterior"];
    const result = planWallSplit("scene", [source], "a", { x: 60, y: 3 }, "b", 1);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.ops.map((op) => op.kind)).toEqual(["update", "create"]);
    expect(result.value.preview.map((w) => w.c)).toEqual([[100, 0, 60, 0], [60, 0, 0, 0]]);
    expect(result.value.preview[1]).toMatchObject({ _id: "b", oneWay: true, taggerTags: ["exterior"], flags: source.flags });
    expect(result.value.preview[1]?.flags).not.toBe(source.flags);
    expect(source.c).toEqual([100, 0, 0, 0]);
  });
  test.each(["door", "window"] as const)("split refuses %s identities", (kind) => {
    expect(planWallSplit("scene", [wall("a", [0, 0, 100, 0], kind)], "a", { x: 50, y: 0 }, "b", 1).ok).toBe(false);
  });
  test("split rejects endpoints, tiny fragments, duplicates, degenerate and prefab geometry", () => {
    const walls = [wall("a", [0, 0, 100, 0])];
    for (const x of [0, 1, 99, 100]) expect(planWallSplit("scene", walls, "a", { x, y: 0 }, "b", 1).ok).toBe(false);
    expect(planWallSplit("scene", walls, "a", { x: 50, y: 0 }, "a", 1).ok).toBe(false);
    expect(planWallSplit("scene", walls, "a", { x: 50, y: 20 }, "b", 1).ok).toBe(false);
    (walls[0] as WallDocument).flags.prefab = {};
    expect(planWallSplit("scene", walls, "a", { x: 50, y: 0 }, "b", 1).ok).toBe(false);
  });
  test("canonical wall hashes ignore array/property order but detect joint and metadata changes", () => {
    const walls = [wall("b", [0, 0, 0, 100]), wall("a", [0, 0, 100, 0])];
    expect(wallSceneHash(walls)).toBe(wallSceneHash([...walls].reverse().map((w) => ({ ...w, flags: {} }))));
    expect(wallSceneHash(walls)).not.toBe(wallSceneHash([...walls, wall("new", [0, 0, -100, 0])]));
    const before = wallSceneHash(walls);
    (walls[0] as WallDocument).name = "Changed";
    expect(wallSceneHash(walls)).not.toBe(before);
    expect(wallEditGuard("scene", walls).wallsHash).toMatch(/^[a-f0-9]{64}$/);
  });
  test("host guard rejects stale, malformed, foreign-scene and non-coordinate edits", () => {
    const walls = [wall("a", [0, 0, 100, 0])], scene = { _id: "scene", walls };
    const result = planWallSplit("scene", walls, "a", { x: 50, y: 0 }, "b", 1);
    if (!result.ok) throw new Error(result.error);
    const { guard, ops } = result.value;
    expect(guardedWallEditError(guard, scene, [null as never])).toContain("Invalid");
    expect(guardedWallEditError(guard, scene, [{ kind: "update" } as never])).toContain("Invalid");
    expect(guardedWallEditError(guard, scene, [{ kind: "create" } as never])).toContain("Invalid");
    expect(guardedWallEditError(guard, scene, [{ kind: "update", ref: { coll: "walls", id: "a", parent: { coll: "scenes", id: "elsewhere" } }, diff: { c: [0, 0, 50, 0] } }])).toContain("different");
    expect(guardedWallEditError(guard, scene, [{ kind: "update", ref: { coll: "walls", id: "a", parent: { coll: "scenes", id: "scene" } }, diff: { name: "overwrite" } }])).toContain("coordinates");
    scene.walls.push(wall("new", [0, 0, -100, 0]));
    expect(guardedWallEditError(guard, scene, ops)).toContain("changed");
  });
  test("split plans apply as a single reversible envelope; late failure rolls back the first half", () => {
    const source = wall("a", [0, 0, 100, 0]);
    const store = new DocumentStore({ meta: { worldId: "w", name: "W", system: "s", systemVersion: "1" } });
    store.hydrate({ scenes: [{ _id: "scene", type: "scene", name: "Scene", ownership: { default: 0 }, flags: {}, system: {}, walls: [source] } as never] }, 0);
    const plan = planWallSplit("scene", [source], "a", { x: 50, y: 0 }, "b", 1);
    if (!plan.ok) throw new Error(plan.error);
    const result = store.applyEnvelope({ seq: 1, ts: 0, by: "gm", txId: "split", ops: plan.value.ops });
    if (!result.ok) throw new Error(result.error);
    expect(store.get("scenes", "scene")?.walls).toHaveLength(2);
    expect(store.applyEnvelope({ seq: 2, ts: 0, by: "gm", txId: "undo", ops: [...result.value.inverses].reverse() }).ok).toBe(true);
    expect(store.get("scenes", "scene")?.walls).toEqual([source]);
    const create = plan.value.ops[1]; if (!create || create.kind !== "create") throw new Error("fixture");
    const failed = store.applyEnvelope({ seq: 3, ts: 0, by: "gm", txId: "bad", ops: [...plan.value.ops, create] });
    expect(failed.ok).toBe(false);
    expect(store.seq).toBe(2);
    expect(store.get("scenes", "scene")?.walls).toEqual([source]);
  });
});
