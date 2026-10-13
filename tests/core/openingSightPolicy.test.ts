/** Scene-level proximity LOS defaults, overrides, validation and wire compatibility. */
import { describe, expect, test } from "vitest";
import type { Json, LevelDocument, SceneDocument, WallDocument } from "../../src/core/documents";
import {
  defaultOpeningSightPolicy,
  levelApertureSightOverrideOp,
  openingSightConeAt,
  openingSightCurveError,
  openingSightOverrideError,
  openingSightPolicyError,
  openingSightWorldDataError,
  sceneOpeningSightPolicyOp,
  wallOpeningSightOverrideOp,
  type OpeningSightCurve,
  type SceneOpeningSightPolicy,
} from "../../src/core/openingSightPolicy";
import { OPENING_SIGHT_FEATURE, opsNeedOpeningSight, requiredOpFeatures, requiredWorldFeatures } from "../../src/core/capabilities";
import { openingSightTransactionError } from "../../src/core/openingSightPolicy";

const curve: OpeningSightCurve = {
  partialAt: 30,
  partial: { depth: 10, widthDeg: 20 },
  fullAt: 10,
  full: { depth: 50, widthDeg: 100 },
};
const policy: SceneOpeningSightPolicy = {
  enabled: true,
  applyTo: { windows: true, doors: true, apertures: false },
  ...curve,
};

function wall(over: Partial<WallDocument> = {}): WallDocument {
  return {
    _id: "wall-1", type: "wall", name: "Window", ownership: { default: 2 }, flags: {}, system: {},
    c: [100, 0, 100, 200], door: 0, oneWay: false, move: 0, sight: 2, sound: 0, light: 2,
    ...over,
  };
}

describe("opening-sight policy", () => {
  test("legacy scenes default Off with grid-relative editable defaults", () => {
    expect(defaultOpeningSightPolicy({ distance: 10 })).toEqual({
      enabled: false,
      applyTo: { windows: true, doors: true, apertures: true },
      partialAt: 60,
      partial: { depth: 20, widthDeg: 35 },
      fullAt: 10,
      full: { depth: 120, widthDeg: 120 },
    });
    expect(openingSightPolicyError(undefined)).not.toBeNull();
  });

  test("validates the two-keyframe cone and linearly interpolates depth and width", () => {
    expect(openingSightCurveError(curve)).toBeNull();
    expect(openingSightConeAt(curve, 40)).toBeNull();
    expect(openingSightConeAt(curve, 30)).toEqual(curve.partial);
    expect(openingSightConeAt(curve, 20)).toEqual({ depth: 30, widthDeg: 60 });
    expect(openingSightConeAt(curve, 10)).toEqual(curve.full);
    expect(openingSightCurveError({ ...curve, partialAt: 10 })).toMatch(/greater/);
    expect(openingSightCurveError({ ...curve, partial: { depth: 51, widthDeg: 20 } })).toMatch(/cannot be deeper/);
  });

  test("local full/custom overrides are sparse, validated and removable", () => {
    expect(openingSightOverrideError({ mode: "full" })).toBeNull();
    expect(openingSightOverrideError({ mode: "custom", curve })).toBeNull();
    expect(openingSightOverrideError({ mode: "inherit" })).toMatch(/inherit by removing/);
    expect(wallOpeningSightOverrideOp("scene-1", "wall-1", null).diff).toEqual({ "-=openingSightOverride": null });
    expect(wallOpeningSightOverrideOp("scene-1", "wall-1", { mode: "full" }).diff).toEqual({ openingSightOverride: { mode: "full" } });

    const level = { _id: "upper", apertureSightOverrides: { "ap-0123456789abcdef": { mode: "full" as const } } };
    expect(levelApertureSightOverrideOp("scene-1", level, "ap-1111111111111111", { mode: "custom", curve }).diff)
      .toEqual({ apertureSightOverrides: { ...level.apertureSightOverrides, "ap-1111111111111111": { mode: "custom", curve } } });
    expect(levelApertureSightOverrideOp("scene-1", level, "ap-0123456789abcdef", null).diff)
      .toEqual({ "-=apertureSightOverrides": null });
  });

  test("scene writes preserve unrelated flags and world validation rejects malformed policy data", () => {
    const op = sceneOpeningSightPolicyOp({ _id: "scene-1", flags: { core: { scale: "strategic" }, module: { other: true } } }, policy);
    expect(op.diff.flags).toMatchObject({ core: { scale: "strategic", openingSight: policy }, module: { other: true } });
    expect(openingSightWorldDataError({ flags: { core: { openingSight: policy as unknown as Json } }, walls: [wall()] })).toBeNull();
    expect(openingSightWorldDataError({ flags: { core: { openingSight: { ...policy, enabled: "yes" } as unknown as Json } } })).toMatch(/enabled/);
    expect(openingSightWorldDataError({ flags: {}, walls: [wall({ openingSightOverride: { mode: "custom", curve: { ...curve, partialAt: 1 } } })] })).toMatch(/greater/);
  });

  test("the host validates final wall overrides, and new data declares the wire feature", () => {
    const existing = wall();
    const ref = { coll: "walls" as const, id: existing._id, parent: { coll: "scenes" as const, id: "scene-1" } };
    const resolve = () => existing;
    expect(openingSightTransactionError([
      { kind: "update", ref, diff: { openingSightOverride: { mode: "custom", curve: { ...curve, fullAt: 40 } } as never } },
    ], resolve)).toMatch(/greater/);
    const valid = wallOpeningSightOverrideOp("scene-1", existing._id, { mode: "full" });
    expect(openingSightTransactionError([valid], resolve)).toBeNull();

    const setting = { kind: "update" as const, ref: { coll: "scenes" as const, id: "scene-1" }, diff: { flags: { core: { openingSight: policy as unknown as Json } } } };
    const wallOverride = wallOpeningSightOverrideOp("scene-1", existing._id, { mode: "full" });
    expect(opsNeedOpeningSight([setting])).toBe(true);
    expect(opsNeedOpeningSight([wallOverride])).toBe(true);
    expect(requiredOpFeatures([setting])).toContain(OPENING_SIGHT_FEATURE);
    const scene = { _id: "scene-1", type: "scene", flags: { core: { openingSight: policy as unknown as Json } } } as unknown as SceneDocument;
    expect(requiredWorldFeatures([scene], "PLAYER")).toContain(OPENING_SIGHT_FEATURE);
    expect(requiredWorldFeatures([scene], "GM")).toContain(OPENING_SIGHT_FEATURE);

    const draftLevel = { _id: "upper", apertureSightOverrides: { "ap-0123456789abcdef": { mode: "full" } } } as unknown as LevelDocument;
    expect(opsNeedOpeningSight([{ kind: "create", coll: "levels", parent: { coll: "scenes", id: "scene-1" }, data: draftLevel }])).toBe(true);
  });
});
