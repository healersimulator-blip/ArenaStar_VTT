/**
 * D-299: what a visual section is actually rendered with. The plan (defaults,
 * clamping, "no filter means no filter") is pure and lives in core/fx; this file
 * checks the renderer's half — that a plan becomes the *right* pixi filter on the
 * live sprite, not merely that something was applied.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { BlurFilter, ColorMatrixFilter, Container, Sprite, Texture } from "pixi.js";
import { FxLayer, fxPixiFilter } from "../../src/canvas/layers/FxLayer";
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
    expect(fx.inspect("run")).toEqual([{ kind: "image", blend: "screen", filter: "blur:4" }]);
    // The view itself — not just the plan — is what was styled.
    const view = viewOf(fx, "run");
    expect(view.blendMode).toBe("screen");
    expect(view.filters?.[0]).toBeInstanceOf(BlurFilter);
  });

  test("an unstyled visual is normal blending with no filter at all", () => {
    const fx = layer();
    fx.spawn("run", image(), 0, Texture.EMPTY);
    expect(fx.inspect("run")).toEqual([{ kind: "image", blend: "normal", filter: null }]);
    expect(viewOf(fx, "run").filters).toBeFalsy();
  });

  test("inspection is per run and read-only: stopping a cue removes only its own row", () => {
    const fx = layer();
    fx.spawn("a", image({ blend: "add" }), 0, Texture.EMPTY);
    fx.spawn("b", image({ filter: { kind: "grayscale", strength: 0.5 } }), 0, Texture.EMPTY);
    expect(fx.inspect("a")).toEqual([{ kind: "image", blend: "add", filter: null }]);
    expect(fx.inspect().length).toBe(2);
    fx.clear("a");
    expect(fx.inspect("a")).toEqual([]);
    expect(fx.inspect("b")).toEqual([{ kind: "image", blend: "normal", filter: "grayscale:0.5" }]);
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
