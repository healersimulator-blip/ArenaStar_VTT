import { describe, expect, test } from "vitest";
import {
  FOG_MASK_MAX_OPS,
  appendFogMask,
  fogMaskLog,
  fogMaskOps,
  fogMaskPolys,
  pointInFogMask,
  sceneRectPoly,
  type FogMaskOp,
} from "../../src/core/fogMask";
import type { SceneDocument } from "../../src/core/documents";

const scene = (flags: SceneDocument["flags"] = {}): SceneDocument => ({
  _id: "scene-1",
  type: "scene",
  name: "Scene",
  ownership: { default: 0 },
  flags,
  system: {},
  active: true,
  width: 800,
  height: 600,
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  img: null,
  darkness: 0,
  tokens: [],
  walls: [],
  lights: [],
  sounds: [],
  tiles: [],
  drawings: [],
  templates: [],
  notes: [],
});

const rect = (x1: number, y1: number, x2: number, y2: number): number[] => [
  x1, y1, x2, y1, x2, y2, x1, y2,
];

describe("GM fog mask log", () => {
  test("an absent or malformed flag reads as an empty log", () => {
    expect(fogMaskLog(scene())).toEqual([]);
    expect(fogMaskLog(scene({ core: { fogMask: "nope" } }))).toEqual([]);
    expect(
      fogMaskLog(scene({ core: { fogMask: [{ mode: "nope", poly: rect(0, 0, 1, 1) }] } })),
    ).toEqual([]);
    expect(
      fogMaskLog(scene({ core: { fogMask: [{ mode: "hide", poly: [0, 0, 1] }] } })),
    ).toEqual([]);
  });

  test("the flag round-trips through ops and keeps unrelated core flags", () => {
    const s = scene({ core: { fog: true, fogRange: 6 } });
    const log: FogMaskOp[] = [{ mode: "hide", poly: rect(0, 0, 10, 10) }];
    const ops = fogMaskOps(s, log);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (!op || op.kind !== "update") throw new Error("expected an update op");
    expect(op.ref).toEqual({ coll: "scenes", id: "scene-1" });
    const flags = op.diff["flags"] as SceneDocument["flags"];
    expect(flags["core"]).toMatchObject({ fog: true, fogRange: 6 });
    const written = fogMaskLog(scene(flags));
    expect(written).toEqual(log);
    // an empty log removes the key entirely
    const cleared = fogMaskOps(s, []);
    const clearedOp = cleared[0];
    if (!clearedOp || clearedOp.kind !== "update") throw new Error("expected an update op");
    expect((clearedOp.diff["flags"] as Record<string, Record<string, unknown>>)["core"]).not.toHaveProperty("fogMask");
  });

  test("append keeps order and trims the oldest strokes at the bound", () => {
    let log: FogMaskOp[] = [];
    for (let i = 0; i < FOG_MASK_MAX_OPS + 3; i++) {
      log = appendFogMask(log, { mode: "hide", poly: rect(i, 0, i + 1, 1) });
    }
    expect(log).toHaveLength(FOG_MASK_MAX_OPS);
    expect(log[0]?.poly[0]).toBe(3);
    expect(log.at(-1)?.poly[0]).toBe(FOG_MASK_MAX_OPS + 2);
  });

  test("later strokes win: reveal over hide un-hides, hide over reveal re-hides", () => {
    const area = rect(0, 0, 100, 100);
    const hide: FogMaskOp = { mode: "hide", poly: area };
    const reveal: FogMaskOp = { mode: "reveal", poly: area };
    expect(pointInFogMask([hide], 50, 50)).toBe(true);
    expect(pointInFogMask([hide, reveal], 50, 50)).toBe(false);
    expect(pointInFogMask([hide, reveal, hide], 50, 50)).toBe(true);
    expect(pointInFogMask([hide], 500, 500)).toBe(false);
    expect(fogMaskPolys([hide, reveal], "hide")).toEqual([area]);
    expect(fogMaskPolys([hide, reveal], "reveal")).toEqual([area]);
  });

  test("sceneRectPoly covers the whole scene and clears with an empty log", () => {
    expect(sceneRectPoly({ width: 800, height: 600 })).toEqual([
      0, 0, 800, 0, 800, 600, 0, 600,
    ]);
  });
});
