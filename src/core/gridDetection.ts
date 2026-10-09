/**
 * Automatic detection of a map's square grid, from pixels alone (no DOM, no network).
 *
 * Method (all at native resolution; nothing is downsampled, because a period error would be
 * multiplied across every square of the map):
 *  1. Edge energy: for every pixel column boundary, sum |ΔL| over all rows; for every row
 *     boundary, sum |ΔL| over all columns. Grid lines add a periodic component to these profiles.
 *  2. Detrend the profiles (remove slow art/shading variation) and autocorrelate them.
 *     The first strong peak in [minPeriod, maxPeriod] is the period.
 *  3. Phase: fold the profile on the period and keep the offset with the highest mean edge energy.
 *  4. Refine: locate the peak of each grid line near its predicted position and fit a line
 *     position = offset + k × period, so long maps do not accumulate a period error.
 *  5. Confidence = the weaker of the two axes' normalised autocorrelation. Below the threshold
 *     the result is "not found": a map with no grid, or art that only looks periodic, must not
 *     be aligned automatically.
 *
 * Positions are pixel-boundary coordinates: a 1 px line in column c reports c + 0.5.
 * The accumulator is fed row strips so the browser only holds a few rows of RGBA at a time.
 */
import type { MapGridEstimate } from "./backgroundTransform";

export const GRID_CONFIDENCE_THRESHOLD = 0.6;
export const GRID_MIN_PERIOD = 8;

/** Index read that is always in range in this module; a missing value reads as 0. */
function at(values: ArrayLike<number>, index: number): number {
  return values[index] ?? 0;
}

/** Streams rows of RGBA pixels and accumulates edge-energy profiles. Rows must arrive top to bottom. */
export class EdgeProfileAccumulator {
  readonly width: number;
  readonly height: number;
  /** dx[i]: energy at the column boundary between pixel i and i+1 (boundary coordinate i+1). */
  readonly dx: Float64Array;
  /** dy[i]: energy at the row boundary between pixel row i and i+1 (boundary coordinate i+1). */
  readonly dy: Float64Array;
  private previous: Float64Array;
  private current: Float64Array;
  private rowsSeen = 0;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
      throw new Error("EdgeProfileAccumulator: image must be at least 2×2 pixels");
    }
    this.width = width;
    this.height = height;
    this.dx = new Float64Array(width - 1);
    this.dy = new Float64Array(height - 1);
    this.current = new Float64Array(width);
    this.previous = new Float64Array(width);
  }

  /** Feed `rows` full rows of RGBA data (4 bytes per pixel, row-major). */
  addRows(rgba: ArrayLike<number>, rows: number): void {
    const { width } = this;
    if (rows < 0 || this.rowsSeen + rows > this.height) {
      throw new Error("EdgeProfileAccumulator: more rows than the image has");
    }
    if (rgba.length < rows * width * 4) throw new Error("EdgeProfileAccumulator: strip is too short");
    for (let r = 0; r < rows; r++) {
      const base = r * width * 4;
      const row = this.current;
      for (let x = 0; x < width; x++) {
        const i = base + x * 4;
        row[x] = 0.299 * at(rgba, i) + 0.587 * at(rgba, i + 1) + 0.114 * at(rgba, i + 2);
      }
      for (let x = 0; x < width - 1; x++) {
        this.dx[x] = at(this.dx, x) + Math.abs(at(row, x + 1) - at(row, x));
      }
      if (this.rowsSeen > 0) {
        const prev = this.previous;
        let sum = 0;
        for (let x = 0; x < width; x++) sum += Math.abs(at(row, x) - at(prev, x));
        const boundary = this.rowsSeen - 1;
        this.dy[boundary] = at(this.dy, boundary) + sum;
      }
      // This row becomes the reference for the next one; swap buffers instead of allocating.
      const spare = this.previous;
      this.previous = row;
      this.current = spare;
      this.rowsSeen++;
    }
  }

  get complete(): boolean {
    return this.rowsSeen === this.height;
  }
}

export type GridDetection =
  | {
      found: true;
      confidence: number;
      grid: MapGridEstimate;
      /** Per-axis autocorrelation strength, for diagnostics. */
      axisConfidence: { x: number; y: number };
    }
  | {
      found: false;
      confidence: number;
      reason: "too-small" | "weak-periodicity";
    };

export interface DetectOptions {
  minPeriod?: number;
  maxPeriod?: number;
  confidenceThreshold?: number;
}

/** Detect the square grid of a fully accumulated image. */
export function detectMapGrid(acc: EdgeProfileAccumulator, options: DetectOptions = {}): GridDetection {
  if (!acc.complete) throw new Error("detectMapGrid: the image has not been fully accumulated");
  const minPeriod = options.minPeriod ?? GRID_MIN_PERIOD;
  const threshold = options.confidenceThreshold ?? GRID_CONFIDENCE_THRESHOLD;
  const shortest = Math.min(acc.width, acc.height);
  // At least three full periods must fit, or autocorrelation has nothing to compare.
  const maxPeriod = options.maxPeriod ?? Math.floor(shortest / 3);
  if (maxPeriod <= minPeriod + 2) return { found: false, confidence: 0, reason: "too-small" };

  const qx = detrend(acc.dx);
  const qy = detrend(acc.dy);
  const lags: number[] = [];
  for (let L = minPeriod; L <= maxPeriod; L++) lags.push(L);
  const rx = autocorrelation(qx, lags);
  const ry = autocorrelation(qy, lags);
  const rCombined = rx.map((v, i) => (v + at(ry, i)) / 2);

  const combined = pickFundamental(rCombined, lags);
  const px = pickFundamental(rx, lags);
  const py = pickFundamental(ry, lags);
  const confidence = Math.max(0, Math.min(px.r, py.r));
  const axisConfidence = { x: px.r, y: py.r };

  // The gate is on the weaker axis: a square grid must show up in both directions.
  if (confidence < threshold) {
    return { found: false, confidence, reason: "weak-periodicity" };
  }

  // A square grid has equal periods on both axes; use one shared estimate for both.
  const fitted = Math.abs(px.lag - py.lag) <= Math.max(0.02 * combined.lag, 0.5);
  const periodX0 = fitted ? combined.lag : refinePeak(rx, lags, px.index);
  const periodY0 = fitted ? combined.lag : refinePeak(ry, lags, py.index);
  const lineX = refineLines(qx, periodX0, bestPhase(qx, periodX0));
  const lineY = refineLines(qy, periodY0, bestPhase(qy, periodY0));

  // Same period on both axes (a square grid): one shared size, the average of the two refinements.
  const shared = fitted ? (lineX.period + lineY.period) / 2 : 0;
  const sizeX = fitted ? shared : lineX.period;
  const sizeY = fitted ? shared : lineY.period;
  return {
    found: true,
    confidence,
    grid: {
      sizeX,
      sizeY,
      offsetX: wrap(lineX.offset, sizeX),
      offsetY: wrap(lineY.offset, sizeY),
    },
    axisConfidence,
  };
}

// ─── signal processing ─────────────────────────────────────────────────────────

function detrend(p: Float64Array): Float64Array {
  const n = p.length;
  let w = Math.max(9, Math.floor(n / 8));
  if (w % 2 === 0) w += 1;
  const half = Math.floor(w / 2);
  // Reflect padding: zero padding would fabricate large residuals at both ends.
  const reflect = (i: number): number => {
    let j = i;
    if (j < 0) j = -j;
    if (j >= n) j = 2 * (n - 1) - j;
    return Math.min(n - 1, Math.max(0, j));
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = i - half; k <= i + half; k++) sum += at(p, reflect(k));
    out[i] = at(p, i) - sum / w;
  }
  return out;
}

/** Normalised autocorrelation at each lag, corrected for the shrinking overlap. */
function autocorrelation(q: Float64Array, lags: number[]): Float64Array {
  const n = q.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += at(q, i);
  mean /= n;
  const centred = new Float64Array(n);
  let energy = 1e-12;
  for (let i = 0; i < n; i++) {
    const c = at(q, i) - mean;
    centred[i] = c;
    energy += c * c;
  }
  const out = new Float64Array(lags.length);
  for (let j = 0; j < lags.length; j++) {
    const L = at(lags, j);
    let dot = 0;
    for (let i = 0; i + L < n; i++) dot += at(centred, i) * at(centred, i + L);
    out[j] = (dot / energy) * (n / (n - L));
  }
  return out;
}

/**
 * First local maximum at or above 75% of the global maximum. Taking the global maximum alone
 * would often pick a multiple of the period (2L, 3L…) when the peaks are close in strength.
 */
function pickFundamental(
  r: ArrayLike<number>,
  lags: number[],
): { lag: number; r: number; index: number } {
  let max = -Infinity;
  for (let i = 0; i < r.length; i++) max = Math.max(max, at(r, i));
  for (let i = 1; i < r.length - 1; i++) {
    const v = at(r, i);
    if (v >= at(r, i - 1) && v >= at(r, i + 1) && v >= 0.75 * max) {
      return { lag: at(lags, i), r: v, index: i };
    }
  }
  let index = 0;
  for (let i = 1; i < r.length; i++) if (at(r, i) > at(r, index)) index = i;
  return { lag: at(lags, index), r: at(r, index), index };
}

/** Sub-sample peak position by parabolic interpolation over the autocorrelation. */
function refinePeak(r: ArrayLike<number>, lags: number[], index: number): number {
  if (index <= 0 || index >= r.length - 1) return at(lags, index);
  const a = at(r, index - 1);
  const b = at(r, index);
  const c = at(r, index + 1);
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return at(lags, index) + Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Offset in [0, period) that best folds the profile onto the grid. Boundary coordinate b maps to
 * profile index b-1 (index i is the boundary between pixels i and i+1).
 */
function bestPhase(q: Float64Array, period: number): number {
  const n = q.length;
  let best = -Infinity;
  let bestOffset = 0;
  for (let o = 0; o < period; o += 0.25) {
    let sum = 0;
    let count = 0;
    for (let b = o; b <= n; b += period) {
      const idx = b - 1;
      if (idx < 0 || idx > n - 1) continue;
      const i0 = Math.floor(idx);
      const t = idx - i0;
      const v = i0 + 1 < n ? at(q, i0) * (1 - t) + at(q, i0 + 1) * t : at(q, i0);
      sum += v;
      count++;
    }
    if (count > 0 && sum / count > best) {
      best = sum / count;
      bestOffset = o;
    }
  }
  return bestOffset;
}

/**
 * Least-squares line through the located peaks of each grid line. Peaks are searched within a
 * couple of pixels of the predicted position; outliers beyond one pixel are dropped and the fit
 * is repeated once.
 */
function refineLines(q: Float64Array, period0: number, offset0: number): { period: number; offset: number } {
  const n = q.length;
  const window = Math.min(2, period0 / 3);
  const points: Array<{ k: number; b: number }> = [];
  const kMax = Math.ceil((n + 1) / period0) + 1;
  for (let k = -1; k <= kMax; k++) {
    const predicted = offset0 + k * period0;
    // A line within two pixels of an image edge only has energy on one side, so its peak is biased.
    if (predicted < 2 || predicted > n - 2) continue;
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let b = Math.ceil(predicted - window); b <= Math.floor(predicted + window); b++) {
      const idx = b - 1;
      if (idx < 0 || idx > n - 1) continue;
      if (at(q, idx) > bestVal) {
        bestVal = at(q, idx);
        bestIdx = idx;
      }
    }
    if (bestIdx < 0 || bestVal <= 0) continue;
    let boundary = bestIdx + 1;
    if (bestIdx > 0 && bestIdx < n - 1) {
      const a = at(q, bestIdx - 1);
      const bb = at(q, bestIdx);
      const c = at(q, bestIdx + 1);
      const denom = a - 2 * bb + c;
      if (denom < 0) boundary += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
    }
    points.push({ k, b: boundary });
  }
  let fit = leastSquares(points);
  if (!fit) return { period: period0, offset: wrap(offset0, period0) };
  const current = fit;
  const kept = points.filter((p) => Math.abs(p.b - (current.intercept + current.slope * p.k)) <= 1);
  if (kept.length >= 3) fit = leastSquares(kept) ?? fit;
  // A refined period that strays far from the autocorrelation estimate is treated as a failed fit.
  if (Math.abs(fit.slope - period0) > Math.max(1, 0.02 * period0)) {
    return { period: period0, offset: wrap(offset0, period0) };
  }
  return { period: fit.slope, offset: wrap(fit.intercept, fit.slope) };
}

function leastSquares(points: Array<{ k: number; b: number }>): { slope: number; intercept: number } | null {
  if (points.length < 2) return null;
  const n = points.length;
  let sk = 0;
  let sb = 0;
  let skk = 0;
  let skb = 0;
  for (const p of points) {
    sk += p.k;
    sb += p.b;
    skk += p.k * p.k;
    skb += p.k * p.b;
  }
  const denom = n * skk - sk * sk;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * skb - sk * sb) / denom;
  const intercept = (sb - slope * sk) / n;
  return { slope, intercept };
}

function wrap(value: number, period: number): number {
  return ((value % period) + period) % period;
}
