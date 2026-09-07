import { describe, expect, test } from "vitest";
import {
  PING_TTL_MS,
  pingPhase,
  rectsOverlap,
  rulerAppend,
  rulerLabel,
  tileAlpha,
  tileTint,
} from "../../src/canvas/ephemera";

describe("pingPhase (§9 ping)", () => {
  test("alive with eased t inside the TTL; dead at/after it", () => {
    expect(pingPhase(0)).toEqual({ alive: true, t: 0 });
    const mid = pingPhase(PING_TTL_MS / 2);
    expect(mid.alive).toBe(true);
    expect(mid.t).toBeGreaterThan(0.7); // ease-out quad: 1 - 0.25
    expect(mid.t).toBeLessThan(0.85);
    expect(pingPhase(PING_TTL_MS - 1).t).toBeCloseTo(1, 1);
    expect(pingPhase(PING_TTL_MS)).toEqual({ alive: false, t: 1 });
    expect(pingPhase(-1)).toEqual({ alive: false, t: 1 });
  });
});

describe("rulerAppend (§9 ruler waypoints)", () => {
  test("appends up to the cap and never mutates the input", () => {
    const base = [{ x: 0, y: 0 }];
    const two = rulerAppend(base, { x: 100, y: 0 });
    expect(two).toHaveLength(2);
    expect(base).toHaveLength(1);
    let pts = Array.from({ length: 12 }, (_, i) => ({ x: i * 50, y: 0 }));
    pts = rulerAppend(pts, { x: 999, y: 999 });
    expect(pts).toHaveLength(12); // capped (§4A max 12)
  });

  test("rulerLabel formats whole units", () => {
    expect(rulerLabel(140.4, "ft")).toBe("140 ft");
    expect(rulerLabel(7, "m")).toBe("7 m");
  });
});

describe("tileAlpha (§9 roof/fade occlusion)", () => {
  const roof = { above: true, occlusion: { mode: "roof" as const, alpha: 0.2 } };
  const fade = { above: true, occlusion: { mode: "fade" as const, alpha: 0.4 } };
  const floor = { above: false, occlusion: { mode: "roof" as const, alpha: 0.2 } };

  test("below always opaque; fade always faded; roof only under occupancy", () => {
    expect(tileAlpha(floor, true)).toBe(1);
    expect(tileAlpha(floor, false)).toBe(1);
    expect(tileAlpha(fade, false)).toBe(0.4);
    expect(tileAlpha(fade, true)).toBe(0.4);
    expect(tileAlpha(roof, false)).toBe(1);
    expect(tileAlpha(roof, true)).toBe(0.2);
  });

  test("rectsOverlap detects edge-touching-free intersections only", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(rectsOverlap(a, { x: 50, y: 50, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 100, y: 0, width: 10, height: 10 })).toBe(false); // touching edge
    expect(rectsOverlap(a, { x: 200, y: 200, width: 10, height: 10 })).toBe(false);
  });

  test("tileTint is deterministic and img-sensitive", () => {
    expect(tileTint("abc")).toBe(tileTint("abc"));
    expect(tileTint("abc")).not.toBe(tileTint("abd"));
    expect(tileTint("")).toBeGreaterThanOrEqual(0);
  });
});
