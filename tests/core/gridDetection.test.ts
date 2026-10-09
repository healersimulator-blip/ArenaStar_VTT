import { describe, expect, test } from "vitest";
import {
  EdgeProfileAccumulator,
  GRID_CONFIDENCE_THRESHOLD,
  detectMapGrid,
} from "../../src/core/gridDetection";

/** Deterministic PRNG so the synthetic maps are identical on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

interface SynthOptions {
  noise?: number;
  /** Smooth, non-periodic blobs standing in for painted art. */
  art?: boolean;
  /** Pure random texture with no grid at all. */
  textureOnly?: boolean;
  seed?: number;
}

/** RGBA image with 1px dark grid lines at floor(ox + k·sizeX) and floor(oy + k·sizeY). */
function gridImage(
  width: number,
  height: number,
  sizeX: number,
  sizeY: number,
  ox: number,
  oy: number,
  options: SynthOptions = {},
): Uint8ClampedArray {
  const random = rng(options.seed ?? 7);
  const lum = new Float64Array(width * height);
  if (options.textureOnly) {
    for (let i = 0; i < lum.length; i++) lum[i] = 128 + (random() - 0.5) * 80;
  } else {
    lum.fill(235);
    if (options.art) {
      for (let b = 0; b < 60; b++) {
        const cx = random() * width;
        const cy = random() * height;
        const r = 20 + random() * 100;
        const depth = 20 + random() * 100;
        for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, Math.ceil(cy + r)); y++) {
          for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, Math.ceil(cx + r)); x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) lum[y * width + x] = (lum[y * width + x] ?? 0) - depth;
          }
        }
      }
    }
    for (let k = -200; k <= 200; k++) {
      const x = Math.floor(ox + k * sizeX);
      if (x >= 0 && x < width) for (let y = 0; y < height; y++) lum[y * width + x] = 40;
      const y = Math.floor(oy + k * sizeY);
      if (y >= 0 && y < height) for (let x = 0; x < width; x++) lum[y * width + x] = 40;
    }
  }
  const noise = options.noise ?? 0;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < lum.length; i++) {
    const v = Math.max(0, Math.min(255, (lum[i] ?? 0) + (noise ? (random() - 0.5) * 2 * noise : 0)));
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function accumulate(rgba: Uint8ClampedArray, width: number, height: number, strip = height): EdgeProfileAccumulator {
  const acc = new EdgeProfileAccumulator(width, height);
  for (let y = 0; y < height; y += strip) {
    const rows = Math.min(strip, height - y);
    acc.addRows(rgba.subarray(y * width * 4, (y + rows) * width * 4), rows);
  }
  return acc;
}

/** Circular distance between two positions on a period. */
function circularError(a: number, b: number, period: number): number {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
}

describe("detectMapGrid — synthetic grids", () => {
  const cases: Array<{ w: number; h: number; size: number; ox: number; oy: number; noise: number; art: boolean }> = [
    { w: 800, h: 600, size: 64, ox: 10, oy: 20, noise: 6, art: true },
    { w: 1600, h: 1200, size: 70, ox: 13, oy: 5, noise: 6, art: true },
    { w: 1200, h: 900, size: 100, ox: 0, oy: 0, noise: 0, art: false },
    { w: 2000, h: 1500, size: 48, ox: 7, oy: 31, noise: 6, art: true },
    { w: 3000, h: 2000, size: 140, ox: 55, oy: 22, noise: 6, art: true },
    { w: 640, h: 480, size: 37, ox: 4, oy: 9, noise: 6, art: true },
  ];

  for (const c of cases) {
    test(`finds a ${c.size}px grid at offset (${c.ox},${c.oy}) on a ${c.w}×${c.h} map`, () => {
      const rgba = gridImage(c.w, c.h, c.size, c.size, c.ox, c.oy, { noise: c.noise, art: c.art });
      const result = detectMapGrid(accumulate(rgba, c.w, c.h));
      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.confidence).toBeGreaterThan(GRID_CONFIDENCE_THRESHOLD);
      // Lines are drawn in the pixel column floor(o + kL), so their centre is o + 0.5.
      expect(Math.abs(result.grid.sizeX - c.size)).toBeLessThan(0.1);
      expect(Math.abs(result.grid.sizeY - c.size)).toBeLessThan(0.1);
      expect(circularError(result.grid.offsetX, c.ox + 0.5, c.size)).toBeLessThan(1);
      expect(circularError(result.grid.offsetY, c.oy + 0.5, c.size)).toBeLessThan(1);
    });
  }

  test("a stretched grid (different X and Y pitch) reports both sizes", () => {
    const rgba = gridImage(1600, 1400, 50, 62, 12, 9, { noise: 4, art: true });
    const result = detectMapGrid(accumulate(rgba, 1600, 1400));
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(Math.abs(result.grid.sizeX - 50)).toBeLessThan(0.2);
    expect(Math.abs(result.grid.sizeY - 62)).toBeLessThan(0.2);
  });

  test("a fractional period is recovered without accumulating drift across the map", () => {
    // 37.3 px pitch over 2400 px is about 64 squares; a period error of 0.05 would be 3 px at the far edge.
    const width = 2400;
    const height = 2400;
    const rgba = gridImage(width, height, 37.3, 37.3, 3, 6, { noise: 3, art: true, seed: 11 });
    const result = detectMapGrid(accumulate(rgba, width, height));
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(Math.abs(result.grid.sizeX - 37.3)).toBeLessThan(0.05);
    expect(Math.abs(result.grid.sizeY - 37.3)).toBeLessThan(0.05);
  });

  test("the result does not depend on how the image is split into strips", () => {
    const rgba = gridImage(900, 700, 60, 60, 20, 14, { noise: 5, art: true, seed: 3 });
    const whole = detectMapGrid(accumulate(rgba, 900, 700));
    const strips = detectMapGrid(accumulate(rgba, 900, 700, 37));
    expect(strips).toEqual(whole);
  });
});

describe("detectMapGrid — no grid", () => {
  test("pure texture is not reported as a grid", () => {
    const rgba = gridImage(1200, 900, 0, 0, 0, 0, { textureOnly: true, seed: 5 });
    const result = detectMapGrid(accumulate(rgba, 1200, 900));
    expect(result.found).toBe(false);
  });

  test("smooth painted art without lines is not reported as a grid", () => {
    const rgba = gridImage(1200, 900, 0, 0, 0, 0, { art: true, seed: 9 });
    const result = detectMapGrid(accumulate(rgba, 1200, 900));
    expect(result.found).toBe(false);
  });

  test("a map too small for three periods reports too-small", () => {
    const rgba = gridImage(20, 20, 6, 6, 0, 0);
    const result = detectMapGrid(accumulate(rgba, 20, 20));
    expect(result).toMatchObject({ found: false, reason: "too-small" });
  });
});

describe("EdgeProfileAccumulator", () => {
  test("rejects rows beyond the image height and an incomplete scan", () => {
    const acc = new EdgeProfileAccumulator(4, 3);
    expect(() => detectMapGrid(acc)).toThrow(/not been fully accumulated/);
    expect(() => acc.addRows(new Uint8ClampedArray(4 * 4 * 4), 4)).toThrow(/more rows/);
  });

  test("rejects images too small for a profile", () => {
    expect(() => new EdgeProfileAccumulator(1, 10)).toThrow(/at least 2/);
  });
});

describe("edge-aligned grids", () => {
  test("a noise-free grid with a line on the first pixel column is measured exactly", () => {
    const width = 960;
    const height = 720;
    const rgba = gridImage(width, height, 64, 64, 0, 0, { noise: 0, art: false });
    const result = detectMapGrid(accumulate(rgba, width, height));
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(Math.abs(result.grid.sizeX - 64)).toBeLessThan(0.01);
    expect(Math.abs(result.grid.sizeY - 64)).toBeLessThan(0.01);
  });
});
