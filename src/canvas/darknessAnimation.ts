import type { SceneDocument } from "../core/documents";
import { MovementAnimation } from "./movementAnimation";

export type DarknessScene = Pick<SceneDocument, "_id" | "darkness" | "flags">;
export function darknessDuration(scene: DarknessScene): number | undefined {
  const hint = scene.flags.arenaDarkness;
  if (!hint || typeof hint !== "object" || Array.isArray(hint) || hint.darkness !== scene.darkness) return undefined;
  return typeof hint.durationMs === "number" && Number.isFinite(hint.durationMs) && hint.durationMs >= 0 && hint.durationMs <= 60000
    ? hint.durationMs : undefined;
}
/** Receipt-time presentation only. Scene entry never replays a stored hint. */
export class DarknessAnimation {
  private sceneId: string | undefined;
  private motion = new MovementAnimation();
  private target = 0;
  private drawn = 0;
  update(scene: DarknessScene | null, now: number, reducedMotion = false): void {
    if (this.sceneId !== scene?._id) {
      this.motion = new MovementAnimation();
      this.sceneId = scene?._id;
    }
    this.sample(now, reducedMotion);
    this.target = scene && Number.isFinite(scene.darkness) ? Math.max(0, Math.min(1, scene.darkness)) : 0;
    this.motion.update({x:this.target,y:0},{x:this.drawn,y:0}, reducedMotion ? 0 : scene ? darknessDuration(scene) : 0,
      now, JSON.stringify(scene?.flags.arenaDarkness ?? null));
    this.drawn = this.motion.sample(now)?.x ?? this.target;
  }
  sample(now: number, reducedMotion = false): number {
    if (reducedMotion) this.motion.cancel();
    this.drawn = this.motion.sample(now)?.x ?? this.target;
    return this.drawn;
  }
}
