/**
 * Bounded adaptive resolution for a busy canvas. It changes only the renderer's
 * backing-store resolution; it never removes an effect, hides a token, changes
 * simulation cadence, or alters host-side mechanics/visibility.
 *
 * Frame intervals are sampled by Pixi's own ticker. A rolling p95 above the
 * visible-frame budget steps resolution down after two evaluation windows;
 * recovery is deliberately slower so quality does not oscillate around a load
 * boundary. The policy is pure apart from the supplied resolution callback.
 */
export interface AdaptiveQualitySnapshot {
  targetFrameMs: number;
  resolution: number;
  level: number;
  levels: readonly number[];
  samples: number;
  recentP95FrameMs: number;
  resolutionChanges: number;
  slowWindows: number;
  recoveryWindows: number;
}

export interface AdaptiveQualityOptions {
  baseResolution?: number;
  targetFrameMs?: number;
  resolutions?: readonly number[];
  windowSize?: number;
  evaluateEvery?: number;
  degradeAfterWindows?: number;
  recoverAfterWindows?: number;
  recoveryFrameMs?: number;
  onResolutionChange?: (resolution: number) => void;
}

function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function normalizedLevels(base: number, supplied?: readonly number[]): number[] {
  const levels = supplied ? [...supplied] : [base, base * 0.75, base * 0.5];
  const valid = levels.filter((value) => Number.isFinite(value) && value >= 0.25 && value <= 2);
  const unique = [...new Set(valid)].sort((a, b) => b - a);
  if (unique.length === 0) return [1, 0.75, 0.5];
  const exactBase = unique.findIndex((value) => Math.abs(value - base) < 1e-6);
  if (exactBase > 0) unique.splice(0, exactBase);
  if (exactBase < 0) unique.unshift(Math.min(2, Math.max(0.25, base)));
  return unique;
}

export class AdaptiveQualityController {
  readonly targetFrameMs: number;
  readonly levels: readonly number[];
  private readonly windowSize: number;
  private readonly evaluateEvery: number;
  private readonly degradeAfterWindows: number;
  private readonly recoverAfterWindows: number;
  private readonly recoveryFrameMs: number;
  private readonly onResolutionChange: (resolution: number) => void;
  private readonly frames: number[] = [];
  private level = 0;
  private samples = 0;
  private framesSinceEvaluation = 0;
  private slowWindows = 0;
  private recoveryWindows = 0;
  private resolutionChanges = 0;
  private recentP95FrameMs = 0;

  constructor(options: AdaptiveQualityOptions = {}) {
    const requestedBase = options.baseResolution;
    const base = typeof requestedBase === "number" && Number.isFinite(requestedBase) ? requestedBase : 1;
    const requestedTarget = options.targetFrameMs;
    this.targetFrameMs = typeof requestedTarget === "number" && Number.isFinite(requestedTarget) && requestedTarget > 0
      ? requestedTarget : 50;
    this.levels = normalizedLevels(base, options.resolutions);
    this.windowSize = Math.max(10, Math.floor(options.windowSize ?? 60));
    this.evaluateEvery = Math.max(5, Math.floor(options.evaluateEvery ?? 20));
    this.degradeAfterWindows = Math.max(1, Math.floor(options.degradeAfterWindows ?? 2));
    this.recoverAfterWindows = Math.max(1, Math.floor(options.recoverAfterWindows ?? 12));
    const requestedRecovery = options.recoveryFrameMs;
    this.recoveryFrameMs = typeof requestedRecovery === "number" && Number.isFinite(requestedRecovery) && requestedRecovery > 0
      ? requestedRecovery : this.targetFrameMs * 0.7;
    this.onResolutionChange = options.onResolutionChange ?? (() => {});
  }

  /** Add one Pixi ticker frame interval; invalid/negative samples are ignored. */
  sample(frameMs: number): void {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return;
    this.samples += 1;
    this.frames.push(frameMs);
    if (this.frames.length > this.windowSize) this.frames.shift();
    this.framesSinceEvaluation += 1;
    if (this.frames.length < Math.min(20, this.windowSize) ||
        this.framesSinceEvaluation < this.evaluateEvery) return;

    this.framesSinceEvaluation = 0;
    this.recentP95FrameMs = percentile95(this.frames);
    if (this.recentP95FrameMs > this.targetFrameMs) {
      this.slowWindows += 1;
      this.recoveryWindows = 0;
      if (this.slowWindows >= this.degradeAfterWindows && this.level < this.levels.length - 1) {
        this.setLevel(this.level + 1);
        this.slowWindows = 0;
      }
      return;
    }
    if (this.recentP95FrameMs < this.recoveryFrameMs) {
      this.recoveryWindows += 1;
      this.slowWindows = 0;
      if (this.recoveryWindows >= this.recoverAfterWindows && this.level > 0) {
        this.setLevel(this.level - 1);
        this.recoveryWindows = 0;
      }
      return;
    }
    this.slowWindows = 0;
    this.recoveryWindows = 0;
  }

  snapshot(): AdaptiveQualitySnapshot {
    return {
      targetFrameMs: this.targetFrameMs,
      resolution: this.levels[this.level] ?? 1,
      level: this.level,
      levels: [...this.levels],
      samples: this.samples,
      recentP95FrameMs: this.recentP95FrameMs,
      resolutionChanges: this.resolutionChanges,
      slowWindows: this.slowWindows,
      recoveryWindows: this.recoveryWindows,
    };
  }

  private setLevel(level: number): void {
    if (level === this.level) return;
    this.level = level;
    this.resolutionChanges += 1;
    this.onResolutionChange(this.levels[this.level] ?? 1);
  }
}
