/**
 * D-299: what a visual section is actually rendered with. The plan (defaults,
 * clamping, "no filter means no filter") is pure and lives in core/fx; this file
 * checks the renderer's half — that a plan becomes the *right* pixi filter on the
 * live sprite, not merely that something was applied.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { BlurFilter, ColorMatrixFilter, Container, Graphics, Sprite, Texture } from "pixi.js";
import { FxLayer, fxMaskGraphics, fxPixiFilter, fxTransform } from "../../src/canvas/layers/FxLayer";
import type { ResolvedFxSection } from "../../src/core/fx";

type ImageSection = Extract<ResolvedFxSection, { kind: "image" }>;
const image = (patch: Partial<ImageSection> = ({})) =>
  ({ kind: "image", id: "glow", assetId: "a".repeat(64), mime: "image/png", x: 100, y: 100,
    startMs: 0, durationMs: 1000, ...patch }) as ImageSection;

const layer = () => new FxLayer(new Container(), new Container());

// pixi's BlurFilter builds its GL programs eagerly and sniffs shader precision from a
// canvas to do it. Node has no DOM; a stub canvas that reports "no WebGL" is exactly
// what pixi's own fallback path expects, so the filter still constructs honestly.
beforeAll(() => {
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
});
afterAll(() => { vi.unstubAllGlobals(); });

/** The live view for a run, reached the same way the layer reaches it (tests only). */
function viewOf(fx: FxLayer, runId: string): Sprite {
  const active = [...(fx as unknown as { visuals: Set<{ runId: string; view: Sprite }> }).visuals]
    .find((item) => item.runId === runId);
  if (!active) throw new Error("no active visual for that run");
  return active.view;
}

describe("FX appearance on the canvas (§SQ-05, D-299)", () => {
  test("a blur is a blur and a colour adjustment is a colour matrix", () => {
    const blur = fxPixiFilter({ kind: "blur", strength: 6 });
    expect(blur).toBeInstanceOf(BlurFilter);
    expect((blur as BlurFilter).strength).toBeCloseTo(6, 5);

    const gray = fxPixiFilter({ kind: "grayscale", strength: 1 }) as ColorMatrixFilter;
    expect(gray).toBeInstanceOf(ColorMatrixFilter);
    // A grey pixel has equal channels, so the red row's three weights are balanced —
    // this is what distinguishes grayscale from, say, a brightness multiply.
    const weight = (index: number) => gray.matrix[index] ?? Number.NaN;
    expect(weight(0)).toBeCloseTo(weight(1), 5);
    expect(weight(0)).toBeCloseTo(weight(2), 5);

    expect(fxPixiFilter({ kind: "brightness", strength: 1.5 })).toBeInstanceOf(ColorMatrixFilter);
    expect(fxPixiFilter({ kind: "saturate", strength: 0 })).toBeInstanceOf(ColorMatrixFilter);
    expect(fxPixiFilter(undefined)).toBeUndefined();
  });

  test("a spawned visual carries its blend and its one filter; inspection reports both", () => {
    const fx = layer();
    fx.spawn("run", image({ blend: "screen", filter: { kind: "blur", strength: 4 } }), 0, Texture.EMPTY);
    expect(fx.inspect("run")).toMatchObject([{ kind: "image", blend: "screen", filter: "blur:4", mask: null }]);
    // The view itself — not just the plan — is what was styled.
    const view = viewOf(fx, "run");
    expect(view.blendMode).toBe("screen");
    expect(view.filters?.[0]).toBeInstanceOf(BlurFilter);
  });

  test("an unstyled visual is normal blending with no filter at all", () => {
    const fx = layer();
    fx.spawn("run", image(), 0, Texture.EMPTY);
    expect(fx.inspect("run")).toMatchObject([{ kind: "image", blend: "normal", filter: null, mask: null }]);
    expect(viewOf(fx, "run").filters).toBeFalsy();
  });

  test("inspection is per run and read-only: stopping a cue removes only its own row", () => {
    const fx = layer();
    fx.spawn("a", image({ blend: "add" }), 0, Texture.EMPTY);
    fx.spawn("b", image({ filter: { kind: "grayscale", strength: 0.5 } }), 0, Texture.EMPTY);
    expect(fx.inspect("a")).toMatchObject([{ kind: "image", blend: "add", filter: null, mask: null }]);
    expect(fx.inspect().length).toBe(2);
    fx.clear("a");
    expect(fx.inspect("a")).toEqual([]);
    expect(fx.inspect("b")).toMatchObject([{ kind: "image", blend: "normal", filter: "grayscale:0.5", mask: null }]);
  });

  test("the filter stays put while the fade moves: alpha is composed per frame, not per filter", () => {
    const fx = layer();
    fx.spawn("run", image({ filter: { kind: "brightness", strength: 2 }, opacity: 0.5,
      fadeInMs: 500 }), 0, Texture.EMPTY);
    const view = viewOf(fx, "run");
    expect(view.alpha).toBeCloseTo(0, 5); // fade-in at t=0, half opacity
    fx.tick(500);
    expect(view.alpha).toBeCloseTo(0.5, 5);
    expect(view.filters?.[0]).toBeInstanceOf(ColorMatrixFilter); // untouched by the tick
  });
});

describe("effect masks on the canvas (§SQ-19, D-301)", () => {
  const circle = (radius: number) => {
    const area = Array.from({ length: 16 }, (_, i) => {
      const angle = (i / 16) * Math.PI * 2;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
    return { area, invert: false };
  };

  test("a mask is a polygon; a cutout is that polygon removed from a rectangle that covers it", () => {
    const ring = circle(40);
    type RecordedPath = { instructions?: Array<{ action: string; data?: unknown[] }> };
    /** The flattened points of the first `poly` subpath inside a recorded path. */
    const polyPoints = (value: unknown): unknown => {
      const path = value as RecordedPath | undefined;
      return path?.instructions?.find((instruction) => instruction.action === "poly")?.data?.[0] ?? null;
    };
    /** A fill instruction's `data` holds the path (and, for a cutout, its hole). */
    const dataOf = (instruction: unknown) =>
      (instruction as { data?: { path?: RecordedPath; hole?: RecordedPath } } | undefined)?.data;

    const ringPoints = ring.area.flatMap((point) => [point.x, point.y]);
    const mask = fxMaskGraphics(ring);
    const filled = dataOf(mask.context.instructions[0]);
    expect(mask.context.instructions.map((instruction) => instruction.action)).toEqual(["fill"]);
    // A plain mask fills the very ring the host resolved.
    expect(polyPoints(filled?.path)).toEqual(ringPoints);
    expect(filled?.hole).toBeFalsy();

    const cutout = fxMaskGraphics({ ...ring, invert: true }, 60);
    const cutFill = dataOf(cutout.context.instructions[0]);
    // A cutout fills a rectangle covering the sprite and carries the ring as its *hole*:
    // the sprite survives outside the shape, which is what "cut out" means.
    expect(cutout.context.instructions.map((instruction) => instruction.action)).toEqual(["fill"]);
    expect(cutFill?.path?.instructions?.some((instruction) => instruction.action === "rect")).toBe(true);
    expect(polyPoints(cutFill?.path)).toBeNull(); // the ring is not also filled
    expect(polyPoints(cutFill?.hole)).toEqual(ringPoints);
  });

  test("a spawned visual is clipped by its mask, and inspection reports the region", () => {
    const fx = layer();
    fx.spawn("run", image({ mask: circle(50) }), 0, Texture.EMPTY);
    expect(fx.inspect("run")).toMatchObject([{ kind: "image", blend: "normal", filter: null,
      mask: { points: 16, invert: false } }]);
    const view = viewOf(fx, "run");
    expect(view.mask).toBeInstanceOf(Graphics);
    // The polygon is an offset polygon, so the mask itself sits on the anchor.
    expect((view.mask as Graphics).position.x).toBe(100);
    expect((view.mask as Graphics).position.y).toBe(100);
  });

  test("the region travels with a followed anchor: moving the token moves the mask, not the art", () => {
    let centre = { x: 100, y: 100 };
    const fx = new FxLayer(new Container(), new Container(), () => centre);
    fx.spawn("run", image({ followTokenId: "t", mask: circle(30) }), 0, Texture.EMPTY);
    const view = viewOf(fx, "run");
    centre = { x: 420, y: 310 };
    fx.tick(16);
    expect(view.position.x).toBe(420);
    expect((view.mask as Graphics).position.x).toBe(420);
    expect((view.mask as Graphics).position.y).toBe(310);
  });

  test("an unmasked visual reports no mask, and stopping the cue destroys the mask with it", () => {
    const fx = layer();
    fx.spawn("plain", image(), 0, Texture.EMPTY);
    fx.spawn("masked", image({ mask: circle(20) }), 0, Texture.EMPTY);
    expect(fx.inspect("plain")[0]?.mask).toBeNull();
    const view = viewOf(fx, "masked");
    const mask = view.mask as Graphics;
    const destroyed = vi.fn();
    mask.on("destroyed", destroyed);
    fx.clear("masked");
    expect(destroyed).toHaveBeenCalled();
    expect(fx.inspect()).toHaveLength(1);
  });
});

describe("animated transform on the canvas (§SQ-05, D-302)", () => {
  test("scale walks from scale to scaleTo on the shared easing, and stops there", () => {
    const section = { scale: 1, scaleTo: 2, easing: "linear" as const, durationMs: 1000 };
    expect(fxTransform(section, 0).scale).toBeCloseTo(1, 5);
    expect(fxTransform(section, 250).scale).toBeCloseTo(1.25, 5);
    expect(fxTransform(section, 1000).scale).toBeCloseTo(2, 5);
    // Past the end and before the start clamp instead of extrapolating.
    expect(fxTransform(section, 5000).scale).toBeCloseTo(2, 5);
    expect(fxTransform(section, -50).scale).toBeCloseTo(1, 5);
    // No target means no animation: the authored scale is the whole story.
    expect(fxTransform({ scale: 3, durationMs: 1000 }, 400).scale).toBeCloseTo(3, 5);
    // A degenerate section (zero duration) still yields a finite still frame.
    expect(fxTransform({ scale: 1, scaleTo: 2, durationMs: 0 }, 10).scale).toBeCloseTo(1, 5);
    expect(fxTransform({ scale: 1, scaleTo: 2, durationMs: 1000 }, Number.NaN).scale).toBeCloseTo(1, 5);
  });

  test("a spin is per cycle: repeats multiply the turn instead of crawling through it", () => {
    // `fxTransform` answers in radians, the renderer's own unit; the numbers read as
    // degrees here because that is how the author wrote them.
    const deg = (input: Parameters<typeof fxTransform>[0], ms: number) =>
      (fxTransform(input, ms).rotation * 180) / Math.PI;
    const once = { spinDeg: 360, durationMs: 1000 };
    expect(deg(once, 0)).toBeCloseTo(0, 4);
    expect(deg(once, 500)).toBeCloseTo(180, 4);
    expect(deg(once, 1000)).toBeCloseTo(360, 4);
    const thrice = { spinDeg: 120, repeats: 3, durationMs: 900, rotation: 45 };
    // Three motion cycles of 120° each, and the turn *accumulates*: at the end of the
    // first cycle the visual is 120° round, not back where it started. The authored base
    // rotation rides along rather than being replaced.
    expect(deg(thrice, 300)).toBeCloseTo(45 + 120, 4);
    expect(deg(thrice, 450)).toBeCloseTo(45 + 180, 4); // cycle two, half eased
    expect(deg(thrice, 600)).toBeCloseTo(45 + 240, 4);
    expect(deg(thrice, 900)).toBeCloseTo(45 + 360, 4);
    expect(deg(thrice, 150)).toBeCloseTo(45 + 60, 4); // half of the first cycle
    // Negative spins go the other way.
    expect(deg({ spinDeg: -90, durationMs: 1000 }, 1000)).toBeCloseTo(-90, 4);
    expect(deg({ durationMs: 1000, rotation: 30 }, 700)).toBeCloseTo(30, 4);
  });

  test("the drawn sprite follows the animation, and a stretched image keeps its bearing", () => {
    const fx = layer();
    fx.spawn("run", image({ scale: 1, scaleTo: 2, spinDeg: 90, durationMs: 1000 }), 0, Texture.EMPTY);
    expect(fx.inspect("run")[0]).toMatchObject({ scale: 1, rotationDeg: 0 });
    fx.tick(500);
    expect(fx.inspect("run")[0]).toMatchObject({ scale: 1.5, rotationDeg: 45 });
    // One tick short of the end: a one-shot's final frame is also its removal, so the
    // drawn end state has to be read just before it.
    fx.tick(499);
    const closing = fx.inspect("run")[0];
    expect(closing?.scale ?? 0).toBeCloseTo(2, 1);
    expect(closing?.rotationDeg ?? 0).toBeCloseTo(90, 0);
    fx.tick(1);
    expect(fx.inspect("run")).toHaveLength(0); // …and then it is gone

    // A bolt with a destination aims at it; its spin adds to that bearing.
    const bolt = layer();
    bolt.spawn("run", image({ x: 100, y: 100, toX: 200, toY: 100, stretch: true,
      spinDeg: 720, durationMs: 2000 }), 0, Texture.EMPTY);
    bolt.tick(1000); // due east is 0°, so halfway through the bolt has turned a full circle
    const [seen] = bolt.inspect("run");
    expect(Math.abs((seen?.rotationDeg ?? 0) - 360)).toBeLessThan(0.01);
    // A stretched sprite's scale.x *is* its drawn width in texture units (pixi's own
    // `width` setter), so the bolt is still 100 px long rather than scaled away.
    expect(seen?.scale ?? 0).toBeCloseTo(100, 5);
  });

  test("a spin is applied from the first drawn frame, not only once the ticker runs", () => {
    const fx = layer();
    // Spawning mid-section (a late join) must start at the correct phase: half of a
    // 400° spin over a 1000 ms section is 200° at 500 ms.
    fx.spawn("run", image({ spinDeg: 400, durationMs: 1000 }), 500, Texture.EMPTY);
    expect(fx.inspect("run")[0]).toMatchObject({ rotationDeg: 200 });
  });
});
