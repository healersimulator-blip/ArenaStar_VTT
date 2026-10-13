/**
 * G-22 (D-446): what the lighting layer draws when light crosses floors. The ambient darkness
 * splits at the floor's solid area; other floors' lights sit in containers masked to the openings
 * they shine through. Masks carry their holes up front, so Canvas2D clips them too.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Container, DOMAdapter, Graphics } from "pixi.js";
import { LightingLayer, type CrossFloorLightingView, type LightView } from "../../src/canvas/layers/LightingLayer";
import { traceSurface } from "../../src/core/floorSurface";
import type { LevelSurface } from "../../src/core/documents";

const box = { x: 0, y: 0, width: 1000, height: 1000 };
/** A 1000 px floor with a stairwell at 400–600 and a pillar standing in it at 480–520. */
const floor = traceSurface((x, y) => x < 1000 && y < 1000 && (!(x >= 400 && x < 600 && y >= 400 && y < 600) || (x >= 480 && x < 520 && y >= 480 && y < 520)), box, { cell: 20 }).surface as LevelSurface;
/** The floor below: solid but for a hole at 100–200. */
const lower = traceSurface((x, y) => x < 1000 && y < 1000 && !(x >= 100 && x < 200 && y >= 100 && y < 200), box, { cell: 50 }).surface as LevelSurface;
const camera = { x: 0, y: 0, scale: 1 }, viewport = { width: 1000, height: 1000 };
const lamp: LightView = { light: { _id: "lamp", x: 500, y: 500, dim: 300, bright: 100, color: "#ffffff", alpha: 0.8 }, poly: null };

// Light gradients paint a canvas; Node has none, so hand Pixi an inert one.
const context2d = new Proxy({} as Record<string | symbol, unknown>, {
  get: (target, key) => key in target ? target[key] : key === "createRadialGradient" || key === "createLinearGradient" ? () => ({ addColorStop: () => undefined }) : () => undefined,
  set: (target, key, value) => { target[key] = value; return true; },
});
const adapter = DOMAdapter.get();
beforeAll(() => DOMAdapter.set({ ...adapter, createCanvas: (width = 1, height = 1) => ({ width, height, style: {}, getContext: () => context2d }) as unknown as HTMLCanvasElement }));
afterAll(() => DOMAdapter.set(adapter));

/** Is (x, y) inside what this Graphics fills? Holes come from the shapes themselves (as Canvas2D reads them). */
function covers(g: Graphics, x: number, y: number): boolean {
  return g.context.instructions.some((i) => i.action === "fill" && i.data.path.shapePath.shapePrimitives
    .some((p) => p.shape.contains(x, y) && !(p.holes ?? []).some((h) => h.shape.contains(x, y))));
}
const child = <T extends Container>(parent: Container, label: string) => parent.getChildByLabel(label) as T;

describe("G-22 cross-floor lighting layer", () => {
  test("the darkness splits at the solid area: openings take the lower floor's darkness, a pillar in the well stays solid", () => {
    const layer = new LightingLayer();
    const cross: CrossFloorLightingView = { solid: floor, belowDarkness: 0.2, groups: [] };
    layer.sync([], { darkness: 1, color: "#000000" }, camera, viewport, cross);
    const dark = child<Graphics>(layer.container, "darkness"), below = child<Graphics>(layer.container, "darknessBelow");
    expect(below.visible).toBe(true);
    expect(below.alpha).toBeCloseTo(0.2);
    expect(dark.alpha).toBe(1);
    for (const [x, y, solid] of [[100, 100, true], [450, 450, false], [500, 500, true], [590, 590, false], [-500, 300, false], [1500, 1500, false]] as const) {
      expect([x, y, covers(dark, x, y)]).toEqual([x, y, solid]);
      expect([x, y, covers(below, x, y)]).toEqual([x, y, !solid]);
    }
    expect(layer.crossFloorState()).toEqual({ split: true, belowDarkness: 0.2, groups: [] });
    // Without cross-floor light the darkness is one rectangle over the viewport again.
    layer.sync([], { darkness: 1, color: "#000000" }, camera, viewport, null);
    expect(below.visible).toBe(false);
    expect([covers(dark, 450, 450), covers(dark, 100, 100)]).toEqual([true, true]);
    expect(layer.crossFloorState()).toEqual({ split: false, belowDarkness: null, groups: [] });
    layer.destroy();
  });

  test("other floors' lights are drawn additively inside nested masks, one per surface they shine through", () => {
    const layer = new LightingLayer();
    const deep: LightView = { light: { _id: "deep", x: 150, y: 150, dim: 200, bright: 50, color: "#ff8800", alpha: 1 }, poly: new Float32Array([0, 0, 300, 0, 300, 300, 0, 300]) };
    const cross: CrossFloorLightingView = { solid: floor, belowDarkness: 0.5, groups: [
      { key: "below:ground", masks: [floor], views: [lamp] },
      { key: "below:cellar", masks: [floor, lower], views: [deep] },
      { key: "below:empty", masks: [floor], views: [] },
    ] };
    layer.sync([], { darkness: 1, color: "#000000" }, camera, viewport, cross);
    const root = child<Container>(layer.container, "crossFloorLights");
    expect(root.children.map((c) => c.label)).toEqual(["crossFloorMask:below:ground", "crossFloor:below:ground", "crossFloorMask:below:cellar", "crossFloor:below:cellar"]);
    const ground = child<Container>(root, "crossFloor:below:ground"), groundMask = child<Graphics>(root, "crossFloorMask:below:ground");
    expect(ground.mask).toBe(groundMask);
    expect([covers(groundMask, 450, 450), covers(groundMask, 500, 500), covers(groundMask, 100, 100)]).toEqual([true, false, false]);
    expect(ground.children).toHaveLength(1);
    expect((ground.children[0] as Graphics).blendMode).toBe("add");
    // The cellar's light shows only where both floors are open.
    const cellar = child<Container>(root, "crossFloor:below:cellar");
    const inner = child<Container>(cellar, "crossFloor:below:cellar"), innerMask = child<Graphics>(cellar, "crossFloorMask:below:cellar");
    expect(inner.mask).toBe(innerMask);
    expect([covers(innerMask, 150, 150), covers(innerMask, 450, 450)]).toEqual([true, false]);
    expect(inner.children.map((c) => (c as Graphics).blendMode)).toEqual(["add"]);
    expect(layer.crossFloorState().groups).toEqual([{ key: "below:ground", masks: 1, lights: ["lamp"] }, { key: "below:cellar", masks: 2, lights: ["deep"] }]);
    // The same input redraws nothing; a new one rebuilds.
    const before = root.children[1];
    layer.sync([], { darkness: 0.9, color: "#000000" }, { ...camera, x: 10 }, viewport, cross);
    expect(root.children[1]).toBe(before);
    layer.sync([], { darkness: 0.9, color: "#000000" }, camera, viewport, { ...cross, groups: [] });
    expect(root.children).toHaveLength(0);
    layer.destroy();
  });

  test("light animation updates alpha per frame without rebuilding geometry and respects reduced motion", () => {
    const layer = new LightingLayer();
    const animated: LightView = { ...lamp, light: { ...lamp.light, animation: { type: "pulse", speed: 1, intensity: 1 } } };
    layer.sync([animated], { darkness: 0, color: "#000000" }, camera, viewport, null, 0);
    const lights = child<Container>(layer.container, "lights"), glow = lights.children[0] as Graphics;
    const minimum = glow.alpha;
    expect(minimum).toBeCloseTo(0.81);
    layer.sync([animated], { darkness: 0, color: "#000000" }, camera, viewport, null, 0.25);
    expect(lights.children[0]).toBe(glow);
    expect(glow.alpha).toBe(1);
    layer.sync([animated], { darkness: 0, color: "#000000" }, camera, viewport, null, 0.5, true);
    expect(glow.alpha).toBe(1);
    layer.destroy();
  });

  test("light from above needs no solid area here: the darkness stays whole, the group still draws", () => {
    const layer = new LightingLayer();
    layer.sync([], { darkness: 0.7, color: "#000000" }, camera, viewport, { solid: null, belowDarkness: null, groups: [{ key: "above:upper", masks: [floor], views: [lamp] }] });
    expect(child<Graphics>(layer.container, "darknessBelow").visible).toBe(false);
    expect(layer.crossFloorState()).toEqual({ split: false, belowDarkness: null, groups: [{ key: "above:upper", masks: 1, lights: ["lamp"] }] });
    layer.destroy();
  });
});
