/**
 * P5/C01 (D-154) — the area preview model: the single seam the canvas overlay
 * and any future casting UI consume. The geometry itself is D-148's covered
 * targeting; these tests pin the COMPOSITION — scene grid bridging, wall
 * segment forwarding, the world-space draw lists, the affected-token
 * highlights, and named-issue refusals (never a guess, never an exception).
 */
import { describe, expect, it } from "vitest";
import {
  pf1eAreaPreviewModel,
  type PF1eAreaPreviewToken,
} from "../../src/packages/pf1e/areaPreview";
import type { PF1eAreaSpec } from "../../src/packages/pf1e/targeting";
import type { Segment } from "../../src/canvas/vision/polygon";

/** The default scene grid as hostBoot ships it: 5-ft squares, 100 units each. */
const SCENE_GRID = { size: 100, distance: 5, units: "ft" };

const token = (
  _id: string,
  x: number,
  y: number,
  w = 80,
  h = 80,
): PF1eAreaPreviewToken => ({ _id, x, y, width: w, height: h });

function rectKeys(rects: readonly { x: number; y: number; size: number }[]) {
  return rects.map((r) => `${r.x},${r.y}:${r.size}`).sort();
}

describe("pf1eAreaPreviewModel — clean resolution", () => {
  const spec: PF1eAreaSpec = {
    kind: "burst",
    origin: { col: 0, row: 0 },
    radiusFt: 5,
  };

  it("resolves a 5-ft burst to the four cells sharing the origin intersection, in world coords", () => {
    const model = pf1eAreaPreviewModel(
      { grid: SCENE_GRID, tokens: [], segments: [] },
      spec,
    );
    expect(model.ok).toBe(true);
    expect(model.issues).toEqual([]);
    expect(model.cells).toBe(4);
    // AoN 212 far-corner rule: a 5-ft radius from an intersection covers
    // exactly the four cells sharing that corner — the D-148 hand fixture.
    expect(rectKeys(model.rects)).toEqual([
      "-100,-100:100",
      "-100,0:100",
      "0,-100:100",
      "0,0:100",
    ]);
    expect(model.label).toBe("5-ft. radius burst");
  });

  it("highlights exactly the tokens whose square is in the area", () => {
    // (50,50) sits inside cell (0,0); (-250,50) sits in cell (-3,0), outside
    // the 2x2.
    const tokens = [token("in", 50, 50), token("out", -250, 50)];
    const model = pf1eAreaPreviewModel(
      { grid: SCENE_GRID, tokens, segments: [] },
      spec,
    );
    expect(model.affectedTokenIds).toEqual(["in"]);
    expect(model.highlightRects).toEqual([
      { x: 10, y: 10, width: 80, height: 80 },
    ]);
  });

  it("keeps rects intact when no tokens exist", () => {
    const model = pf1eAreaPreviewModel(
      { grid: SCENE_GRID, tokens: [], segments: [] },
      spec,
    );
    expect(model.cells).toBe(4);
    expect(model.affectedTokenIds).toEqual([]);
    expect(model.highlightRects).toEqual([]);
  });
});

describe("pf1eAreaPreviewModel — wall segments are forwarded to line of effect", () => {
  // The D-148 LoE fixture: a solid barrier on the grid line x = 250.
  const wall: Segment[] = [{ x1: 250, y1: -5000, x2: 250, y2: 5000 }];
  const spec: PF1eAreaSpec = {
    kind: "burst",
    origin: { col: 0, row: 0 },
    radiusFt: 20,
  };

  it("drops cells the origin has total cover to, and their tokens with them", () => {
    const open = pf1eAreaPreviewModel(
      { grid: SCENE_GRID, tokens: [], segments: [] },
      spec,
    );
    const blocked = pf1eAreaPreviewModel(
      { grid: SCENE_GRID, tokens: [], segments: wall },
      spec,
    );
    expect(blocked.ok).toBe(true);
    expect(blocked.cells).toBeLessThan(open.cells);
    // No surviving rect lies wholly beyond the barrier (col >= 3 ⇒ x >= 300).
    for (const r of blocked.rects) expect(r.x).toBeLessThan(300);
    // A token in cell (3,0), wholly behind the wall, is not highlighted…
    const tokens = [token("behind", 350, 50), token("near", 50, 50)];
    const withTokens = pf1eAreaPreviewModel(
      { grid: SCENE_GRID, tokens, segments: wall },
      spec,
    );
    expect(withTokens.affectedTokenIds).toEqual(["near"]);
  });
});

describe("pf1eAreaPreviewModel — named refusals, never guesses", () => {
  it("propagates the metric-scene refusal with empty draw lists", () => {
    const model = pf1eAreaPreviewModel(
      {
        grid: { size: 100, distance: 1, units: "m" },
        tokens: [],
        segments: [],
      },
      { kind: "burst", origin: { col: 0, row: 0 }, radiusFt: 5 },
    );
    expect(model.ok).toBe(false);
    expect(model.issues.map((i) => i.field)).toEqual(["grid.units"]);
    expect(model.cells).toBe(0);
    expect(model.rects).toEqual([]);
    expect(model.affectedTokenIds).toEqual([]);
    expect(model.highlightRects).toEqual([]);
    expect(model.label).toBe("5-ft. radius burst");
  });

  it("propagates the cone/line C01b refusal instead of inventing a shape", () => {
    const model = pf1eAreaPreviewModel(
      { grid: SCENE_GRID, tokens: [], segments: [] },
      {
        kind: "cone" as PF1eAreaSpec["kind"],
        origin: { col: 0, row: 0 },
        radiusFt: 15,
      },
    );
    expect(model.ok).toBe(false);
    expect(model.issues).toHaveLength(1);
    expect(model.issues[0]?.field).toBe("kind");
    expect(model.issues[0]?.message).toContain("C01b");
  });

  it("propagates a non-intersection origin refusal", () => {
    const model = pf1eAreaPreviewModel(
      { grid: SCENE_GRID, tokens: [], segments: [] },
      { kind: "burst", origin: { col: 0.5, row: 0 }, radiusFt: 5 },
    );
    expect(model.ok).toBe(false);
    expect(model.issues.map((i) => i.field)).toEqual(["origin"]);
  });
});
