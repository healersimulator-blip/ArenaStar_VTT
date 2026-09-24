/**
 * D-294 — camera cues are pure view math. Three properties are the whole point,
 * and each is a decision rather than an implementation detail:
 *
 *  - a pan interpolates the viewport CENTRE, so a zoom change cannot make the
 *    destination drift,
 *  - a shake stays inside a fixed screen-space budget and decays to zero,
 *  - `cameraAt` answers `null` exactly when a section is over, which is the
 *    caller's cue to release the view (pan: stay on the destination; path: park on
 *    its last waypoint; shake: restore the base).
 */
import { describe, expect, test } from "vitest";
import {
  SHAKE_AMPLITUDE_PX, cameraAt, cameraCentredOn, cameraCentre, cameraEnd, cameraPanEnd, cameraPathEnd,
  panCamera, pathCamera, shakeCamera,
  type ResolvedCameraPan, type ResolvedCameraPath, type ResolvedCameraShake,
} from "../../src/canvas/fxCamera";
import type { Camera, Viewport } from "../../src/canvas/camera";

const viewport: Viewport = { width: 800, height: 600 };
const base: Camera = { x: 0, y: 0, scale: 1 };
/** Deterministic stand-in for Math.random: an alternating ±1 stream. */
const alternating = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] as number;
};

describe("cameraCentre / cameraCentredOn", () => {
  test("round-trip a point through the centre of the viewport at any scale", () => {
    for (const scale of [0.25, 1, 2.5]) {
      const camera = cameraCentredOn({ x: 1200, y: 640 }, viewport, scale);
      expect(cameraCentre(camera, viewport)).toEqual({ x: 1200, y: 640 });
    }
  });

  test("a zero/negative scale cannot produce NaN coordinates", () => {
    expect(cameraCentredOn({ x: 10, y: 20 }, viewport, 0)).toEqual({ x: -390, y: -280, scale: 1 });
  });
});

describe("panCamera", () => {
  const to = { x: 1000, y: 400 };

  test("progress 0 is the base camera, progress 1 is the destination centred", () => {
    expect(panCamera(base, to, viewport, 0)).toEqual(base);
    const end = panCamera(base, to, viewport, 1);
    expect(cameraCentre(end, viewport)).toEqual(to);
    expect(end.scale).toBe(base.scale);
  });

  test("the centre moves monotonically from where the viewer is toward the destination", () => {
    const centres = [0, 0.25, 0.5, 0.75, 1].map((p) => cameraCentre(panCamera(base, to, viewport, p), viewport));
    for (let i = 1; i < centres.length; i++) {
      const previous = centres[i - 1];
      const current = centres[i];
      if (!previous || !current) throw new Error("pan centre missing");
      expect(current.x).toBeGreaterThan(previous.x);
    }
    expect(centres.at(-1)).toEqual(to);
  });

  test("a pan-and-zoom keeps the destination centred WHILE the scale changes", () => {
    for (const p of [0, 0.3, 0.7, 1]) {
      const camera = panCamera(base, to, viewport, p, 2);
      expect(camera.scale).toBeCloseTo(1 + p, 10);
      const expected = { x: (base.x || 0) + viewport.width / 2 + (to.x - (base.x + viewport.width / 2)) * p,
        y: base.y + viewport.height / 2 + (to.y - (base.y + viewport.height / 2)) * p };
      expect(cameraCentre(camera, viewport).x).toBeCloseTo(expected.x, 6);
      expect(cameraCentre(camera, viewport).y).toBeCloseTo(expected.y, 6);
    }
    // …and the destination is exactly centred at the end, not merely near it.
    expect(cameraCentre(panCamera(base, to, viewport, 1, 2), viewport)).toEqual(to);
  });

  test("out-of-range progress is clamped instead of extrapolating past the destination", () => {
    expect(cameraCentre(panCamera(base, to, viewport, 4), viewport)).toEqual(to);
    expect(panCamera(base, to, viewport, -1)).toEqual(base);
  });

  test("cameraPanEnd is the same camera as progress 1 — the frame the caller writes", () => {
    const section: ResolvedCameraPan = { kind: "camera", mode: "pan", startMs: 0, durationMs: 1000,
      toX: to.x, toY: to.y, zoom: 1.5 };
    expect(cameraPanEnd(section, base, viewport)).toEqual(panCamera(base, to, viewport, 1, 1.5));
  });
});

describe("shakeCamera", () => {
  test("stays inside the screen-space budget, whatever the zoom", () => {
    for (const scale of [0.2, 1, 4]) {
      const camera = { x: 500, y: 300, scale };
      for (const progress of [0, 0.4, 0.9]) {
        const shaken = shakeCamera(camera, progress, 1, alternating([1, -1]));
        const offsetScreen = Math.abs(shaken.x - camera.x) * scale;
        expect(offsetScreen).toBeLessThanOrEqual(SHAKE_AMPLITUDE_PX + 1e-9);
        expect(shaken.scale).toBe(scale); // a shake never zooms
      }
    }
  });

  test("decays to zero and never leaves the base camera behind", () => {
    const peak = shakeCamera(base, 0, 1, () => 1);
    const late = shakeCamera(base, 0.99, 1, () => 1);
    expect(Math.abs(peak.x - base.x)).toBeGreaterThan(Math.abs(late.x - base.x));
    expect(shakeCamera(base, 1, 1, () => 1)).toEqual(base);
  });

  test("intensity scales the offset linearly", () => {
    const strong = shakeCamera(base, 0, 1, () => 1);
    const weak = shakeCamera(base, 0, 0.25, () => 1);
    expect(Math.abs(strong.x - base.x)).toBeCloseTo(4 * Math.abs(weak.x - base.x), 9);
  });
});

describe("cameraAt", () => {
  const pan: ResolvedCameraPan = { kind: "camera", mode: "pan", startMs: 0, durationMs: 1000,
    toX: 1000, toY: 400, easing: "linear" };

  test("a pan is live for its whole window and over exactly at the end", () => {
    expect(cameraAt(pan, base, viewport, 0)).toEqual(base);
    // The base camera is centred on (400, 300); half of the way to (1000, 400).
    const half = cameraAt(pan, base, viewport, 500);
    expect(half && cameraCentre(half, viewport)).toEqual({ x: 700, y: 350 });
    expect(cameraAt(pan, base, viewport, 1000)).toBeNull();
    expect(cameraAt(pan, base, viewport, 2000)).toBeNull();
  });

  test("a shake is over at the end too, so the caller can restore the exact base", () => {
    const shake: ResolvedCameraShake = { kind: "camera", mode: "shake", startMs: 0, durationMs: 500,
      intensity: 0.5 };
    expect(cameraAt(shake, base, viewport, 0, () => 0.5)).toEqual(base);
    expect(cameraAt(shake, base, viewport, 499, () => 0.9)).not.toEqual(base);
    expect(cameraAt(shake, base, viewport, 500, () => 0.9)).toBeNull();
  });

  test("an easing of easeInOut reaches the midpoint of the path at half time", () => {
    const eased: ResolvedCameraPan = { ...pan, easing: "easeInOut" };
    const easedHalf = cameraAt(eased, base, viewport, 500);
    expect(easedHalf && cameraCentre(easedHalf, viewport)).toEqual({ x: 700, y: 350 });
  });

  test("a non-finite elapsed time releases the view rather than writing NaN", () => {
    expect(cameraAt(pan, base, viewport, Number.NaN)).toBeNull();
    expect(cameraAt(pan, base, viewport, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("pathCamera (D-298: camera waypoints)", () => {
  const route = [{ x: 1_000, y: 300 }, { x: 1_400, y: 700 }, { x: 400, y: 900 }];

  test("progress 0 is the base view, progress 1 is the LAST waypoint centred", () => {
    expect(pathCamera(base, route, viewport, 0)).toEqual(base);
    const end = pathCamera(base, route, viewport, 1);
    const centre = cameraCentre(end, viewport);
    expect(centre.x).toBeCloseTo(400, 6);
    expect(centre.y).toBeCloseTo(900, 6);
    expect(end.scale).toBe(1);
  });

  test("the tour starts from wherever the viewer is, so N waypoints are N legs", () => {
    // The viewer sits at (500, 500) — the first leg runs from there to waypoint 1.
    const offset: Camera = cameraCentredOn({ x: 500, y: 500 }, viewport, 1);
    const legEnd = pathCamera(offset, route, viewport, 1 / 3);
    const centre = cameraCentre(legEnd, viewport);
    expect(centre.x).toBeCloseTo(1_000, 6); // exactly waypoint 1 at the leg boundary…
    expect(centre.y).toBeCloseTo(300, 6);
    // …and halfway through the first leg it is halfway between the two.
    const mid = cameraCentre(pathCamera(offset, route, viewport, 1 / 6), viewport);
    expect(mid.x).toBeCloseTo(750, 6);
    expect(mid.y).toBeCloseTo(400, 6);
  });

  test("the view passes through every waypoint in order and never backtracks", () => {
    const offset: Camera = cameraCentredOn({ x: 200, y: 200 }, viewport, 1);
    const seen = [0, 1 / 3, 2 / 3, 1].map((progress) => cameraCentre(pathCamera(offset, route, viewport, progress), viewport));
    expect(seen[0]).toEqual({ x: 200, y: 200 });
    expect(seen[1]?.x).toBeCloseTo(1_000, 6);
    expect(seen[2]?.x).toBeCloseTo(1_400, 6);
    expect(seen[3]?.x).toBeCloseTo(400, 6);
    // Between waypoints the distance to the next waypoint only shrinks.
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 1.0; step <= 2.0; step += 0.05) {
      const centre = cameraCentre(pathCamera(offset, route, viewport, step / 3), viewport);
      const distance = Math.hypot(centre.x - 1_400, centre.y - 700);
      expect(distance).toBeLessThanOrEqual(previous + 1e-6);
      previous = distance;
    }
  });

  test("easing applies per leg, so every waypoint is still reached exactly", () => {
    const eased = pathCamera(base, route, viewport, 1 / 3, undefined, "easeInOut");
    expect(cameraCentre(eased, viewport).x).toBeCloseTo(1_000, 6);
    // Mid-leg the eased tour is *not* at the linear midpoint, but still on the line.
    const midLinear = cameraCentre(pathCamera(base, route, viewport, 1 / 6), viewport);
    const midEased = cameraCentre(pathCamera(base, route, viewport, 1 / 6, undefined, "easeInOut"), viewport);
    expect(midEased).not.toBeCloseTo(midLinear.x, 3);
    expect(midEased.x).toBeGreaterThan(0);
    expect(midEased.x).toBeLessThan(1_000);
  });

  test("zoom interpolates across the whole path, so the last waypoint is centred at the final scale", () => {
    const half = pathCamera(base, route, viewport, 0.5, 2);
    expect(half.scale).toBeCloseTo(1.5, 6);
    const end = pathCamera(base, route, viewport, 1, 2);
    expect(end.scale).toBeCloseTo(2, 6);
    const centre = cameraCentre(end, viewport);
    expect(centre.x).toBeCloseTo(400, 6); // the destination does not drift with the zoom
    expect(centre.y).toBeCloseTo(900, 6);
  });

  test("degenerate inputs never produce NaN", () => {
    expect(pathCamera(base, [], viewport, 0.5)).toEqual(base);
    // One waypoint is a pan to it — the host refuses that as a *path* (2–8), but the
    // math must still answer something a camera can be set to.
    expect(pathCamera(base, [{ x: 100, y: 100 }], viewport, 1))
      .toEqual(panCamera(base, { x: 100, y: 100 }, viewport, 1));
    // A non-finite progress reads as "no time has passed", not as a blanked map.
    expect(pathCamera(base, route, viewport, Number.NaN)).toEqual(base);
    const camera = pathCamera(base, route, viewport, 0.5);
    expect(Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.scale)).toBe(true);
  });

  test("cameraAt runs a path for its window and cameraPathEnd parks it on the last waypoint", () => {
    const section: ResolvedCameraPath = { kind: "camera", mode: "path", startMs: 0, durationMs: 1_000,
      points: route, easing: "linear", zoom: 2 };
    expect(cameraAt(section, base, viewport, 500)).not.toBeNull();
    expect(cameraAt(section, base, viewport, 1_000)).toBeNull(); // over: the caller releases
    expect(cameraCentre(pathCamera(base, route, viewport, 1, 2), viewport).x).toBeCloseTo(400, 6);
    expect(cameraPathEnd(section, base, viewport)).toEqual(cameraEnd(section, base, viewport));
    // A shake hands the base back through the same helper, a pan parks on its own point.
    const pan: ResolvedCameraPan = { kind: "camera", mode: "pan", startMs: 0, durationMs: 500, toX: 900, toY: 100 };
    expect(cameraEnd(pan, base, viewport)).toEqual(cameraPanEnd(pan, base, viewport));
    expect(cameraEnd({ kind: "camera", mode: "shake", startMs: 0, durationMs: 500, intensity: 0.5 }, base, viewport))
      .toEqual(base);
  });
});
