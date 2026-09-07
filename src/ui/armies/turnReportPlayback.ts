/**
 * §9A TurnReport timeline animation controller & playback math.
 * Provides scrubber index tracking, sub-phase mapping, play/pause/step controls,
 * speed multiplier, and GM skip.
 */
import type { SimEvent, TurnReport } from "../../core/sim";

export interface PlaybackState {
  eventIndex: number;
  playing: boolean;
  speed: number; // 0.5 | 1 | 2 | 4
  completed: boolean;
  currentSubPhase: string | null;
  progress: number; // 0.0 to 1.0
  activeEvent: SimEvent | null;
}

export class TurnReportPlayback {
  private report: TurnReport;
  private index = 0;
  private isPlaying = false;
  private speedMultiplier = 1;
  private stepIntervalMs = 800; // base ms per event at 1x
  private onStateChange?: ((state: PlaybackState) => void) | undefined;

  constructor(report: TurnReport, onStateChange?: ((state: PlaybackState) => void) | undefined) {
    this.report = report;
    this.onStateChange = onStateChange;
  }

  public setReport(report: TurnReport): void {
    this.pause();
    this.report = report;
    this.index = 0;
    this.isPlaying = false;
    this.notify();
  }

  public get count(): number {
    return this.report.events.length;
  }

  public getState(): PlaybackState {
    const total = this.report.events.length;
    const activeEvent = total > 0 && this.index < total ? (this.report.events[this.index] ?? null) : null;
    const currentSubPhase = activeEvent ? activeEvent.subPhase : (this.report.subPhases[0] ?? null);
    const progress = total > 0 ? Math.min(1, Math.max(0, this.index / Math.max(1, total - 1))) : 1;
    const completed = total === 0 || this.index >= total - 1;

    return {
      eventIndex: this.index,
      playing: this.isPlaying,
      speed: this.speedMultiplier,
      completed,
      currentSubPhase,
      progress,
      activeEvent,
    };
  }

  public play(): void {
    if (this.report.events.length === 0) return;
    if (this.index >= this.report.events.length - 1) {
      this.index = 0; // restart if at end
    }
    this.isPlaying = true;
    this.notify();
  }

  public pause(): void {
    this.isPlaying = false;
    this.notify();
  }

  public togglePlay(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public setSpeed(speed: number): void {
    if (speed > 0) {
      this.speedMultiplier = speed;
      this.notify();
    }
  }

  public seek(index: number): void {
    const total = this.report.events.length;
    if (total === 0) {
      this.index = 0;
    } else {
      this.index = Math.max(0, Math.min(total - 1, Math.floor(index)));
    }
    this.notify();
  }

  public seekProgress(progressPct: number): void {
    const total = this.report.events.length;
    if (total === 0) {
      this.index = 0;
    } else {
      const idx = Math.round(progressPct * (total - 1));
      this.seek(idx);
    }
  }

  public stepForward(): void {
    if (this.report.events.length === 0) return;
    if (this.index < this.report.events.length - 1) {
      this.index++;
      this.notify();
    } else {
      this.pause();
    }
  }

  public stepBack(): void {
    if (this.report.events.length === 0) return;
    if (this.index > 0) {
      this.index--;
      this.notify();
    }
  }

  /** GM Skip: jumps directly to the end of the timeline animation (§9A). */
  public skip(): void {
    this.pause();
    if (this.report.events.length > 0) {
      this.index = this.report.events.length - 1;
    } else {
      this.index = 0;
    }
    this.notify();
  }

  /** Drive playback step by delta time in ms. Returns true if state updated. */
  public tick(dtMs: number): boolean {
    if (!this.isPlaying || this.report.events.length === 0) return false;
    const effectiveInterval = this.stepIntervalMs / this.speedMultiplier;
    // Advance index based on elapsed time ratio
    const steps = dtMs / effectiveInterval;
    if (steps >= 1) {
      const advance = Math.floor(steps);
      if (this.index + advance >= this.report.events.length - 1) {
        this.index = this.report.events.length - 1;
        this.pause();
      } else {
        this.index += advance;
        this.notify();
      }
      return true;
    }
    return false;
  }

  private notify(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }
}
