/**
 * SQ-10 (was D-293's anchor picker) — the UI-facing half of the shared crosshair:
 * how a window's wish becomes a checkable request, what a summon asks the
 * crosshair to enforce (exactly what the host enforces), shape switching that
 * never yields an invisible area, and the named-placement bookkeeping that makes
 * "commit once, reuse later" possible. Snapping, bounds and fault text are the
 * core module's own tests (`tests/core/crosshair.test.ts`).
 */
import { describe, expect, test } from "vitest";
import { CROSSHAIR_SHAPE_DEFAULTS, rememberPlacement, resolveCrosshairPick,
  shapeWithExtent, summonCrosshairOptions } from "../../src/ui/macros/crosshairPicker";
import type { SceneDocument, SceneGrid, TokenDocument } from "../../src/core/documents";
import type { SummonPickOptions } from "../../src/ui/macros/summonPicker";

const grid: SceneGrid = { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" };
const caster: TokenDocument = { _id: "caster", type: "token", name: "Caster", ownership: { default: 0 },
  flags: {}, system: {}, x: 250, y: 250, width: 100, height: 100, rotation: 0, img: "", hidden: false,
  disposition: "friendly", vision: true, light: { radius: 0, alpha: 0, color: "#ffffff" } };
const scene: SceneDocument = { _id: "s1", type: "scene", name: "Field", ownership: { default: 2 },
  flags: {}, system: {}, active: true, img: null, width: 1_000, height: 800, darkness: 0, grid,
  tokens: [caster], walls: [{ _id: "w1", type: "wall", name: "Wall", ownership: { default: 0 }, flags: {},
    system: {}, c: [500, 0, 500, 800], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0 }],
  lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [] };

describe("resolveCrosshairPick", () => {
  test("attaches the live scene's bounds, grid and walls, keeping the author's rules", () => {
    const resolved = resolveCrosshairPick(scene, { sceneId: "s1", label: "the destination point",
      constraints: { origin: { x: 100, y: 100 }, maxDistance: 30, requireLoS: true, footprint: 5 } });
    expect(resolved.request.bounds).toEqual({ width: 1_000, height: 800 });
    expect(resolved.request.grid).toBe(scene.grid);
    expect(resolved.request.walls).toHaveLength(1);
    expect(resolved.request.maxDistance).toBe(30);
    expect(resolved.request.requireLoS).toBe(true);
    expect(resolved.options.label).toBe("the destination point");
  });

  test("a scene without walls (or without constraints) is still a valid request", () => {
    const resolved = resolveCrosshairPick({ ...scene, walls: [] }, { sceneId: "s1" });
    expect(resolved.request.walls).toEqual([]);
    expect(resolved.request.maxDistance).toBeUndefined();
  });
});

describe("summonCrosshairOptions", () => {
  const options: SummonPickOptions = { sceneId: "s1", size: 2, maxDistance: 30,
    requireLoS: true, summonerTokenId: "caster" };

  test("mirrors the host's own rules: caster origin, range, line of sight, footprint inset", () => {
    const request = summonCrosshairOptions(scene, options);
    expect(request.constraints).toMatchObject({ origin: { x: 250, y: 250 }, maxDistance: 30, requireLoS: true });
    // A 2-cell footprint at 5 ft per cell is 10 ft — the same half-extent the host
    // keeps inside the map (`cell * size / 2` pixels) once converted back.
    expect(request.constraints?.footprint).toBe(10);
    expect(request.shape).toMatchObject({ kind: "circle", length: 10 });
    expect(request.shapes).toContain("ray");
  });

  test("a GM placing without a caster keeps the host's exemption instead of inventing a range", () => {
    const { summonerTokenId: _without, ...casterless } = options;
    void _without;
    const request = summonCrosshairOptions(scene, { ...casterless, gmManual: true });
    expect(request.constraints?.origin).toBeUndefined();
    expect(request.constraints?.maxDistance).toBeUndefined();
    expect(request.hint).toContain("not enforced");
  });

  test("a caster id that is not in the scene is treated as no caster (no phantom origin)", () => {
    const request = summonCrosshairOptions(scene, { ...options, summonerTokenId: "someone-else" });
    // No origin means no range fault and no line-of-sight fault: the preview stays
    // silent rather than red, because the *host* is what refuses this summon.
    expect(request.constraints?.origin).toBeUndefined();
    expect(request.constraints?.maxDistance).toBeUndefined();
    expect(request.constraints?.requireLoS).toBeUndefined();
  });
});

describe("shape switching", () => {
  test("every non-point shape starts with a visible extent", () => {
    for (const kind of ["circle", "cone", "ray", "rect"] as const) {
      const shape = shapeWithExtent(kind, { kind: "point" });
      expect(shape.kind).toBe(kind);
      expect(shape.length).toBeGreaterThan(0);
      if (kind === "ray" || kind === "rect") expect(shape.width).toBeGreaterThan(0);
    }
    expect(shapeWithExtent("point", CROSSHAIR_SHAPE_DEFAULTS.ray)).toEqual({ kind: "point" });
  });

  test("an extent the author typed survives a shape switch; a bogus one is replaced", () => {
    const typed = shapeWithExtent("ray", { kind: "circle", length: 42, width: 7 });
    expect(typed).toMatchObject({ kind: "ray", length: 42, width: 7 });
    const repaired = shapeWithExtent("circle", { kind: "point", length: Number.NaN });
    expect(repaired.length).toBe(CROSSHAIR_SHAPE_DEFAULTS.circle.length);
  });
});

describe("named placement reuse", () => {
  test("a name replaces its own entry, and a second name appends", () => {
    const first = rememberPlacement([], { name: "Portal", point: { x: 10, y: 20 } });
    expect(first).toEqual([{ name: "Portal", point: { x: 10, y: 20 } }]);
    const moved = rememberPlacement(first, { name: "Portal", point: { x: 30, y: 40 } });
    expect(moved).toEqual([{ name: "Portal", point: { x: 30, y: 40 } }]);
    const both = rememberPlacement(moved, { name: "Wall of fire", point: { x: 1, y: 2 } });
    expect(both.map((entry) => entry.name)).toEqual(["Portal", "Wall of fire"]);
  });

  test("the stored point is a copy, so a later edit cannot move the record", () => {
    const point = { x: 5, y: 6 };
    const list = rememberPlacement([], { name: "Anchor", point });
    point.x = 999;
    expect(list[0]?.point).toEqual({ x: 5, y: 6 });
  });
});
