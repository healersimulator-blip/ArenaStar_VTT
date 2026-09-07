/**
 * §8A After-action replay controller.
 * Reconstructs ModelPool snapshots and steps through historical turn checkpoints/reports.
 */
import type { ModelPool } from "../core/strategic";
import type { TurnReport } from "../core/sim";
import type { CheckpointRecord } from "../storage/strategicStore";
import type { SysSchema } from "./pool";
import { decodeSimSnapshot, poolFromSnapshot } from "./codec";

export interface ReplayFrame {
  turnNumber: number;
  tick: number | null;
  hash: string;
  pool: ModelPool;
  report: TurnReport | null;
}

export interface ReplayState {
  index: number;
  total: number;
  playing: boolean;
  speed: number;
  frame: ReplayFrame | null;
}

export class ReplayEngine {
  private checkpoints: CheckpointRecord[] = [];
  private reportsByTurn = new Map<number, TurnReport>();
  private sys: SysSchema;
  private index = 0;
  private playing = false;
  private speedMultiplier = 1;
  private stepIntervalMs = 1200; // ms per turn step at 1x
  private onStateChange?: ((state: ReplayState) => void) | undefined;

  constructor(sys: SysSchema, onStateChange?: ((state: ReplayState) => void) | undefined) {
    this.sys = sys;
    this.onStateChange = onStateChange;
  }

  public load(checkpoints: CheckpointRecord[], reports: TurnReport[] = []): void {
    this.pause();
    this.checkpoints = [...checkpoints].sort((a, b) => a.slot - b.slot);
    this.reportsByTurn.clear();
    for (const r of reports) {
      this.reportsByTurn.set(r.turn, r);
    }
    this.index = 0;
    this.notify();
  }

  public get count(): number {
    return this.checkpoints.length;
  }

  public getState(): ReplayState {
    const frame = this.getFrame(this.index);
    return {
      index: this.index,
      total: this.checkpoints.length,
      playing: this.playing,
      speed: this.speedMultiplier,
      frame,
    };
  }

  public getFrame(idx: number): ReplayFrame | null {
    if (this.checkpoints.length === 0 || idx < 0 || idx >= this.checkpoints.length) {
      return null;
    }
    const rec = this.checkpoints[idx];
    if (!rec) return null;
    const snap = decodeSimSnapshot(rec.pool).snapshot;
    const pool = poolFromSnapshot(snap, rec.maxHpMax, this.sys, Math.max(rec.pool.length, 64));
    const report = this.reportsByTurn.get(rec.turnNumber) ?? null;

    return {
      turnNumber: rec.turnNumber,
      tick: rec.tick,
      hash: rec.hash,
      pool,
      report,
    };
  }

  public seek(index: number): void {
    if (this.checkpoints.length === 0) {
      this.index = 0;
    } else {
      this.index = Math.max(0, Math.min(this.checkpoints.length - 1, Math.floor(index)));
    }
    this.notify();
  }

  public play(): void {
    if (this.checkpoints.length === 0) return;
    if (this.index >= this.checkpoints.length - 1) {
      this.index = 0;
    }
    this.playing = true;
    this.notify();
  }

  public pause(): void {
    this.playing = false;
    this.notify();
  }

  public togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  public stepForward(): void {
    if (this.checkpoints.length === 0) return;
    if (this.index < this.checkpoints.length - 1) {
      this.index++;
      this.notify();
    } else {
      this.pause();
    }
  }

  public stepBack(): void {
    if (this.checkpoints.length === 0) return;
    if (this.index > 0) {
      this.index--;
      this.notify();
    }
  }

  public setSpeed(speed: number): void {
    if (speed > 0) {
      this.speedMultiplier = speed;
      this.notify();
    }
  }

  public tick(dtMs: number): boolean {
    if (!this.playing || this.checkpoints.length === 0) return false;
    const effectiveInterval = this.stepIntervalMs / this.speedMultiplier;
    const steps = dtMs / effectiveInterval;
    if (steps >= 1) {
      const advance = Math.floor(steps);
      if (this.index + advance >= this.checkpoints.length - 1) {
        this.index = this.checkpoints.length - 1;
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
