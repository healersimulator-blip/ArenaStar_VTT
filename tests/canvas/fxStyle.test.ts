/**
 * D-299: what a visual section is actually rendered with. The plan (defaults,
 * clamping, "no filter means no filter") is pure and lives in core/fx; this file
 * checks the renderer's half — that a plan becomes the *right* pixi filter on the
 * live sprite, not merely that something was applied.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { BlurFilter, ColorMatrixFilter, Container, Graphics, Sprite, Texture } from "pixi.js";
import { FxLayer, fxFilterReadback, fxMaskGraphics, fxMaskReadback, fxMaskTransform, fxPixiFilter,
  fxSetFilterStrength, fxTransform } from "../../src/canvas/layers/FxLayer";
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

/** The drawn polygon of a mask, read out of the graphics it was drawn into. */
const drawnPoints = (graphics: Graphics): Array<{ x: number; y: number }> => {
  type RecordedPath = { instructions?: Array<{ action: string; data?: unknown[] }> };
  for (const instruction of graphics.context.instructions) {
    const data = (instruction as { data?: { path?: RecordedPath; hole?: RecordedPath } }).data;
    for (const path of [data?.path, data?.hole]) {
      const poly = path?.instructions?.find((entry) => entry.action === "poly");
      const flat = poly?.data?.[0];
      if (Array.isArray(flat) && flat.every((value) => typeof value === "number")) {
        const out: Array<{ x: number; y: number }> = [];
        for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i] as number, y: flat[i + 1] as number });
        return out;
      }
    }
  }
  return [];
};

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
    expect(fx.inspect("run")).toMatchObject([{ kind: "image", blend: "screen", filters: ["blur:4"], mask: null }]);
    // The view itself — not just the plan — is what was styled.
    const view = viewOf(fx, "run");
    expect(view.blendMode).toBe("screen");
    expect(view.filters?.[0]).toBeInstanceOf(BlurFilter);
  });

  test("an unstyled visual is normal blending with no filter at all", () => {
    const fx = layer();
    fx.spawn("run", image(), 0, Texture.EMPTY);
    expect(fx.inspect("run")).toMatchObject([{ kind: "image", blend: "normal", filters: [], mask: null }]);
    expect(viewOf(fx, "run").filters).toBeFalsy();
  });

  test("inspection is per run and read-only: stopping a cue removes only its own row", () => {
    const fx = layer();
    fx.spawn("a", image({ blend: "add" }), 0, Texture.EMPTY);
    fx.spawn("b", image({ filter: { kind: "grayscale", strength: 0.5 } }), 0, Texture.EMPTY);
    expect(fx.inspect("a")).toMatchObject([{ kind: "image", blend: "add", filters: [], mask: null }]);
    expect(fx.inspect().length).toBe(2);
    fx.clear("a");
    expect(fx.inspect("a")).toEqual([]);
    expect(fx.inspect("b")).toMatchObject([{ kind: "image", blend: "normal", filters: ["grayscale:0.5"], mask: null }]);
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
    // The readback is the drawn polygon itself, so a still circle reports its reach and —
    // honestly — that a circle has no facing to report (D-305).
    expect(fx.inspect("run")).toMatchObject([{ kind: "image", blend: "normal", filters: [],
      mask: { points: 16, radius: 50, bearingDeg: null, invert: false } }]);
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

/**
 * D-305: a region animates by the two rules the visual's own transform already follows —
 * a size restarts per cycle, a turn accumulates — and the drawing is read back, not the
 * plan, so "the mask grew" is a claim about the polygon that is actually clipping.
 */
describe("animated regions on the canvas (§SQ-05, D-305)", () => {
  const circle = (radius: number, animate?: { scale?: number; spinDeg?: number }) => ({
    area: Array.from({ length: 16 }, (_, i) => {
      const angle = (i / 16) * Math.PI * 2;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    }),
    invert: false,
    ...(animate ? { animate } : {}),
  });
  /** A cone points along +x at angle 0; its far arc is symmetric about its own axis. */
  const cone = (length: number, animate: { spinDeg: number }) => ({
    area: [{ x: 0, y: 0 }, ...Array.from({ length: 9 }, (_, i) => {
      const angle = (-26.565 + (i / 8) * 53.13) * (Math.PI / 180);
      return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
    })],
    invert: false,
    animate,
  });

  test("the region's transform is the visual's own two rules: a size restarts, a turn accumulates", () => {
    const section = { durationMs: 1000 };
    // A still region is the authored geometry, whatever the clock says.
    expect(fxMaskTransform(undefined, section, 500)).toEqual({ scale: 1, rotation: 0 });
    expect(fxMaskTransform({ scale: 3, spinDeg: 90 }, section, Number.NaN)).toEqual({ scale: 1, rotation: 0 });
    expect(fxMaskTransform({ scale: 3 }, { durationMs: 0 }, 100)).toEqual({ scale: 1, rotation: 0 });
    // Growth walks from the authored geometry (ratio 1) to the authored target ratio.
    expect(fxMaskTransform({ scale: 3 }, section, 0).scale).toBeCloseTo(1, 6);
    expect(fxMaskTransform({ scale: 3 }, section, 500).scale).toBeCloseTo(2, 6);
    expect(fxMaskTransform({ scale: 3 }, { ...section, easing: "easeIn" }, 500).scale).toBeCloseTo(1.5, 6);
    // A circle-like region has one rule only; a turn of zero degrees is still a turn.
    expect(fxMaskTransform({ spinDeg: 180 }, section, 500).rotation).toBeCloseTo(Math.PI / 2, 6);
    expect(fxMaskTransform({ spinner: 1 } as never, section, 500)).toEqual({ scale: 1, rotation: 0 });
    // Two cycles: the growth runs twice (a pulse), the turn covers the full 360°.
    const pulsed = { ...section, repeats: 2 };
    expect(fxMaskTransform({ scale: 3, spinDeg: 180 }, pulsed, 250).scale).toBeCloseTo(2, 6);
    expect(fxMaskTransform({ scale: 3, spinDeg: 180 }, pulsed, 499).scale).toBeCloseTo(3, 2);
    expect(fxMaskTransform({ scale: 3, spinDeg: 180 }, pulsed, 500).scale).toBeCloseTo(1, 6);
    expect(fxMaskTransform({ scale: 3, spinDeg: 180 }, pulsed, 500).rotation)
      .toBeCloseTo((180 * Math.PI) / 180, 6);
  });

  test("a drawn region is the host's polygon scaled and turned about its anchor", () => {
    const ring = circle(40);
    const grown = fxMaskGraphics(ring, 0, { scale: 2, rotation: 0 });
    for (const point of drawnPoints(grown)) expect(Math.hypot(point.x, point.y)).toBeCloseTo(80, 6);
    // A turn moves every vertex, and a quarter turn sends the first vertex north.
    const turned = fxMaskGraphics(ring, 0, { scale: 1, rotation: Math.PI / 2 });
    const first = drawnPoints(turned)[0];
    expect(first?.x ?? 1).toBeCloseTo(0, 6);
    expect(first?.y ?? 0).toBeCloseTo(40, 6);
    // The readback says what the polygon says: a cone's bearing is its axis, a circle's is
    // nothing at all, and a cutout's reach still covers a region that grew.
    expect(fxMaskReadback(fxMaskGraphics(ring)).bearingDeg).toBeNull();
    const pointing = fxMaskReadback(fxMaskGraphics(cone(60, { spinDeg: 0 })));
    expect(pointing.bearingDeg).toBeCloseTo(0, 0);
    expect(fxMaskReadback(fxMaskGraphics(cone(60, { spinDeg: 0 }), 0, { scale: 1, rotation: Math.PI / 2 }))
      .bearingDeg).toBeCloseTo(90, 0);
    const cut = fxMaskGraphics({ ...ring, invert: true }, 20, { scale: 2, rotation: 0 });
    const cover = cut.context.instructions[0] as { data?: { path?: { instructions?: Array<{ action: string; data?: unknown[] }> } } };
    const rect = cover.data?.path?.instructions?.find((entry) => entry.action === "rect")?.data;
    expect(Number(rect?.[2])).toBeGreaterThan(80 * 2); // half-width still covers the grown ring
  });

  test("a growing region is redrawn per frame on the same graphics; a still one never moves", () => {
    const fx = layer();
    fx.spawn("grow", image({ mask: circle(50, { scale: 4 }) }), 0, Texture.EMPTY);
    fx.spawn("still", image({ mask: circle(50) }), 0, Texture.EMPTY);
    const growView = viewOf(fx, "grow").mask as Graphics;
    const stillView = viewOf(fx, "still").mask as Graphics;
    const stillPoints = drawnPoints(stillView);
    expect(fx.inspect("grow")[0]?.mask).toMatchObject({ radius: 50 });
    // The anchored polygon: the mask itself sits on the anchor so the region travels with
    // a followed visual, while `radius` is measured about that anchor.
    expect(growView.position.x).toBe(100);

    fx.tick(500);
    expect(fx.inspect("grow")[0]?.mask).toMatchObject({ radius: 125 });
    expect(fx.inspect("still")[0]?.mask).toMatchObject({ radius: 50 });
    expect(viewOf(fx, "grow").mask).toBe(growView); // redrawn, never rebuilt
    // One tick short of the end: a one-shot's final frame is also its removal.
    fx.tick(499);
    expect(fx.inspect("grow")[0]?.mask?.radius).toBeCloseTo(200, 0);
    // Untouched from spawn to end: a still region is drawn once and only ever moved.
    expect(drawnPoints(stillView)).toEqual(stillPoints);
    expect(stillPoints).toHaveLength(16);
    fx.tick(1);
    expect(fx.inspect("grow")).toHaveLength(0);
  });

  test("a region that grows from a late spawn starts mid-animation, like the visual's own", () => {
    const fx = layer();
    fx.spawn("grow", image({ mask: circle(50, { scale: 5 }) }), 400, Texture.EMPTY);
    // Ratio 1 + (5 - 1) * 0.4 = 2.6, so 50 px of authored reach is drawn as 130 px.
    expect(fx.inspect("grow")[0]?.mask).toMatchObject({ radius: 130 });
  });
});

/**
 * D-304: an animated filter keeps the ONE filter instance the section was built with and
 * only changes its strength, so "it deepened" is a claim about the drawn filter rather
 * than about a plan. `fxFilterReadback` is the reading; these tests round-trip it first,
 * so a pixi change fails here instead of silently misreporting in `inspect`.
 */
describe("animated filter strength on the canvas (§SQ-05, D-304)", () => {
  const strengthOf = (fx: FxLayer, runId: string): number => {
    const label = fx.inspect(runId)[0]?.filters[0] ?? "";
    return Number(label.slice(label.indexOf(":") + 1));
  };

  test("a strength read back out of a live filter is the strength it was given, twice over", () => {
    const kinds = [
      { kind: "blur", from: 6 }, { kind: "grayscale", from: 0.5 },
      { kind: "brightness", from: 0.5 }, { kind: "saturate", from: 0.5 },
    ] as const;
    for (const { kind, from } of kinds) {
      const filter = fxPixiFilter({ kind, strength: from });
      if (!filter) throw new Error(`no ${kind} filter`);
      expect(fxFilterReadback(kind, filter)).toBeCloseTo(from, 5);
      fxSetFilterStrength(kind, filter, 1);
      expect(fxFilterReadback(kind, filter)).toBeCloseTo(1, 5);
      // Setting is absolute, never compounding: pixi's colour setters multiply onto the
      // current matrix unless it is reset first, which would look right on frame one and
      // drift every frame after — exactly the bug this pair guards.
      fxSetFilterStrength(kind, filter, 1);
      expect(fxFilterReadback(kind, filter)).toBeCloseTo(1, 5);
    }
  });

  test("a deepening blur is one filter instance, nudged per frame and read back each time", () => {
    const fx = layer();
    fx.spawn("run", image({ filter: { kind: "blur", strength: 2 }, filterTo: 10 }), 0, Texture.EMPTY);
    const built = viewOf(fx, "run").filters?.[0];
    expect(strengthOf(fx, "run")).toBeCloseTo(2, 5); // the authored start, from frame one

    fx.tick(250);
    expect(strengthOf(fx, "run")).toBeCloseTo(4, 5);
    // The drawn filter itself, not just the label the layer prints.
    expect((viewOf(fx, "run").filters?.[0] as BlurFilter).strength).toBeCloseTo(4, 5);
    expect(viewOf(fx, "run").filters?.[0]).toBe(built); // rebuilt never, nudged only
    fx.tick(250);
    expect(strengthOf(fx, "run")).toBeCloseTo(6, 5);
    // One tick short of the end: a one-shot's final frame is also its removal.
    fx.tick(499);
    expect(strengthOf(fx, "run")).toBeCloseTo(9.988, 2);
    fx.tick(1);
    expect(fx.inspect("run")).toHaveLength(0);
  });

  test("a colour-matrix animation stays absolute: no compounding, and a still filter never moves", () => {
    const fx = layer();
    fx.spawn("fade", image({ filter: { kind: "grayscale", strength: 0 }, filterTo: 1 }), 0, Texture.EMPTY);
    fx.spawn("still", image({ filter: { kind: "brightness", strength: 1.5 } }), 0, Texture.EMPTY);
    const still = viewOf(fx, "still").filters?.[0];
    for (const expected of [0.25, 0.5, 0.75]) {
      fx.tick(250);
      expect(strengthOf(fx, "fade")).toBeCloseTo(expected, 5);
      // A constant filter is spawned once and then never touched: the D-299 property.
      expect(viewOf(fx, "still").filters?.[0]).toBe(still);
      expect(strengthOf(fx, "still")).toBeCloseTo(1.5, 5);
    }
  });

  test("a filter animation starts mid-way for a late join, like the transform does", () => {
    const fx = layer();
    fx.spawn("run", image({ filter: { kind: "blur", strength: 2 }, filterTo: 10 }), 500, Texture.EMPTY);
    expect(strengthOf(fx, "run")).toBeCloseTo(6, 5);
  });
});

/**
 * D-313: a **chain** of filters. What matters on the canvas is that the author's order is the
 * order pixi applies, that each entry is its own instance (a blur deepening must not rebuild the
 * brightness beside it), and that an entry's animation moves only that entry.
 */
describe("filter chains on the canvas (§SQ-05, D-313)", () => {
  const strengthsOf = (fx: FxLayer, runId: string): number[] => (fx.inspect(runId)[0]?.filters ?? [])
    .map((label) => Number(label.slice(label.indexOf(":") + 1)));

  test("the chain renders in the order it was written, one instance per entry", () => {
    const fx = layer();
    fx.spawn("run", image({ filters: [{ kind: "grayscale", strength: 0.5 },
      { kind: "blur", strength: 6 }, { kind: "brightness", strength: 1.2 }] }), 0, Texture.EMPTY);
    expect(fx.inspect("run")).toMatchObject([{ filters: ["grayscale:0.5", "blur:6", "brightness:1.2"] }]);
    // The drawn array, not just the label: three filters, in that order, of the right kinds.
    const drawn = viewOf(fx, "run").filters ?? [];
    expect(drawn).toHaveLength(3);
    expect(drawn[0]).toBeInstanceOf(ColorMatrixFilter);
    expect(drawn[1]).toBeInstanceOf(BlurFilter);
    expect(drawn[2]).toBeInstanceOf(ColorMatrixFilter);

    // A still chain is spawned once and never touched again — the D-299 property, now per entry.
    const built = [...drawn];
    fx.tick(300);
    expect(viewOf(fx, "run").filters).toEqual(built);
    expect(strengthsOf(fx, "run")).toEqual([0.5, 6, 1.2]);
  });

  test("each entry animates its own strength and never its neighbour's", () => {
    const fx = layer();
    fx.spawn("run", image({ filters: [
      { kind: "grayscale", strength: 0.5 },
      { kind: "blur", strength: 2, to: 10 },
      { kind: "saturate", strength: 1.5 },
    ] }), 0, Texture.EMPTY);
    const blur = viewOf(fx, "run").filters?.[1];
    expect(strengthsOf(fx, "run")).toEqual([0.5, 2, 1.5]);
    fx.tick(250);
    expect(strengthsOf(fx, "run")[1]).toBeCloseTo(4, 5);
    // The animated entry is the same instance nudged; the two constants are untouched.
    expect(viewOf(fx, "run").filters?.[1]).toBe(blur);
    expect(strengthsOf(fx, "run")[0]).toBe(0.5);
    expect(strengthsOf(fx, "run")[2]).toBe(1.5);
    fx.tick(250);
    expect(strengthsOf(fx, "run")[1]).toBeCloseTo(6, 5);
  });

  test("two entries may animate at once, each on its own end and range", () => {
    const fx = layer();
    fx.spawn("run", image({ filters: [
      { kind: "blur", strength: 2, to: 16 },
      { kind: "brightness", strength: 0.5, to: 2 },
    ] }), 0, Texture.EMPTY);
    fx.tick(500);
    const [blur, brightness] = strengthsOf(fx, "run");
    expect(blur).toBeCloseTo(9, 5);
    expect(brightness).toBeCloseTo(1.25, 5);
    // …and a late join takes each entry's start from the same elapsed time the rest does.
    const late = layer();
    late.spawn("run", image({ filters: [{ kind: "blur", strength: 2, to: 16 },
      { kind: "brightness", strength: 0.5, to: 2 }] }), 500, Texture.EMPTY);
    expect(strengthsOf(late, "run")[0]).toBeCloseTo(9, 5);
    expect(strengthsOf(late, "run")[1]).toBeCloseTo(1.25, 5);
  });

  test("the single-filter shorthand renders exactly as the same one-entry chain would", () => {
    // The two spellings are one look: the renderer must not care which the author used. (A
    // one-entry *chain* is refused by the host, so this compares against the plan directly.)
    const shorthand = layer();
    shorthand.spawn("run", image({ filter: { kind: "blur", strength: 4 }, filterTo: 12 }), 250, Texture.EMPTY);
    expect(strengthsOf(shorthand, "run")).toHaveLength(1);
    expect(strengthsOf(shorthand, "run")[0]).toBeCloseTo(6, 5); // mid-animation, from `filterTo`
  });
});
