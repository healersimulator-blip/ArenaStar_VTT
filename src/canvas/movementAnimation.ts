import type { BaseDocument } from "../core/documents";
export interface MovementPoint { x: number; y: number }
/** Endpoint-only hint: no private origin/path is replicated. */
export function movementDuration(doc: Pick<BaseDocument, "flags"> & MovementPoint): number | undefined {
  const hint = doc.flags.arenaMove;
  if (!hint || typeof hint !== "object" || Array.isArray(hint) || hint.x !== doc.x || hint.y !== doc.y) return undefined;
  return typeof hint.durationMs === "number" && Number.isFinite(hint.durationMs) && hint.durationMs >= 0 && hint.durationMs <= 60000 ? hint.durationMs : undefined;
}
/** Local presentation of committed moves. First appearance/reload cuts to the destination.
 * Unrelated syncs never restart; superseding moves start from the currently drawn point. */
export class MovementAnimation {
  private target: MovementPoint | undefined;
  private hint: string | undefined;
  private run: { from: MovementPoint; to: MovementPoint; at: number; duration: number } | undefined;
  update(to: MovementPoint, from: MovementPoint, duration: number | undefined, now: number, hint?: string): void {
    // A manual edit returning to an old endpoint must not resurrect its unchanged hint.
    const fresh = hint === undefined || hint !== this.hint;
    this.hint = hint;
    if (this.target?.x === to.x && this.target.y === to.y) return;
    this.run = this.target && fresh && duration !== undefined && duration > 0
      ? { from: { ...from }, to: { ...to }, at: now, duration } : undefined;
    this.target = { ...to };
  }
  isRunning(now: number): boolean {
    return this.run !== undefined && now < this.run.at + this.run.duration;
  }
  sample(now: number): MovementPoint | null {
    const run = this.run;
    if (!run) return null;
    const progress = Math.max(0, Math.min(1, (now - run.at) / run.duration));
    if (progress === 1) this.run = undefined;
    return { x: run.from.x + (run.to.x-run.from.x)*progress, y: run.from.y + (run.to.y-run.from.y)*progress };
  }
  cancel(): void { this.run = undefined; }
}
