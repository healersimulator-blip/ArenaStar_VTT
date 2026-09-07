/**
 * §5A realtime client interpolation: deltas arrive at flush cadence (default
 * 5 Hz); rendering samples positions a fixed delay behind, lerping between
 * the last two received pool states for smooth motion. Pure module — no DOM,
 * no timers; the owner pushes on every replica update and samples per frame.
 * The replica itself is never mutated — sampled arrays are render-side views.
 */
import type { ModelPool } from "../core/strategic";

export const RT_INTERP_DELAY_MS = 240;

export class PoolInterpolator {
  private readonly delayMs: number;
  private prevX = new Float32Array(0);
  private prevY = new Float32Array(0);
  private curX = new Float32Array(0);
  private curY = new Float32Array(0);
  private prevAt = 0;
  private curAt = 0;
  private prevCount = 0;
  private curCount = 0;
  private pushes = 0;
  /** Samples where 0 < alpha < 1 AND a position actually moved (e2e proof). */
  private interpolatedMoves = 0;

  constructor(delayMs = RT_INTERP_DELAY_MS) {
    this.delayMs = delayMs;
  }

  /** Record a freshly applied replica state (call on every sim bus event). */
  push(pool: ModelPool, atMs: number): void {
    this.prevX = this.curX;
    this.prevY = this.curY;
    this.prevAt = this.curAt;
    this.prevCount = this.curCount;
    this.curX = pool.x.slice();
    this.curY = pool.y.slice();
    this.curAt = atMs;
    this.curCount = pool.count;
    this.pushes += 1;
  }

  /** True once two states are held and time sits strictly between them. */
  get interpolating(): boolean {
    return this.prevAt > 0 && this.curAt > this.prevAt;
  }

  /**
   * Interpolated render positions at `nowMs`: lerp between the previous and
   * current received state, sampled `delayMs` behind real time. Returns the
   * current positions unchanged when there is nothing to interpolate (single
   * state, or pool count changed — models never lerped across a boundary).
   */
  sampleXY(nowMs: number): { x: Float32Array; y: Float32Array } {
    if (!this.interpolating) return { x: this.curX, y: this.curY };
    // models never lerped across a deployment/compaction boundary
    if (this.prevCount !== this.curCount) return { x: this.curX, y: this.curY };
    const span = this.curAt - this.prevAt;
    const alpha = Math.min(1, Math.max(0, (nowMs - this.delayMs - this.prevAt) / span));
    if (alpha >= 1) {
      return { x: this.curX, y: this.curY };
    }
    if (alpha <= 0) return { x: this.prevX, y: this.prevY };
    const n = this.curX.length;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    let moved = false;
    for (let i = 0; i < n; i++) {
      const px = this.prevX[i] ?? 0;
      const cx = this.curX[i] ?? 0;
      const py = this.prevY[i] ?? 0;
      const cy = this.curY[i] ?? 0;
      if (px !== cx || py !== cy) moved = true;
      x[i] = px + (cx - px) * alpha;
      y[i] = py + (cy - py) * alpha;
    }
    if (moved) this.interpolatedMoves += 1;
    return { x, y };
  }

  get stats(): { pushes: number; interpolatedMoves: number; interpolating: boolean } {
    return {
      pushes: this.pushes,
      interpolatedMoves: this.interpolatedMoves,
      interpolating: this.interpolating,
    };
  }
}
