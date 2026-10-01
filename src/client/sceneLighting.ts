/** Shared production lighting presentation. Replica-only inputs, latest-scene-wins polygons. */
import type { SceneDocument } from "../core/documents";
import type { VisionComputer } from "../workers/visionWorkerClient";
import type { LightView } from "../canvas/layers/LightingLayer";
import type { Stage } from "../canvas/stage";
import { DarknessAnimation } from "../canvas/darknessAnimation";
import { sceneLightSources } from "../canvas/vision/darkness";
import { sightSegments } from "../canvas/vision/wallSight";
import { flatSegments } from "../core/fogExploration";

type LightingView = Pick<Stage, "camera" | "viewport" | "onFrame"> & {getLightingLayer(): Pick<ReturnType<Stage["getLightingLayer"]>, "sync">};
export class SceneLightingPlayer {
  private animation = new DarknessAnimation();
  private readonly media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  private view: LightingView | undefined;
  private unframe: (() => void) | undefined;
  private lights: readonly LightView[] = [];
  private key = "";
  private revision = 0;
  private destroyed = false;
  constructor(private readonly computer: VisionComputer) {}
  sync(scene: SceneDocument | null, view: LightingView): void {
    if (this.destroyed) return;
    if (view !== this.view) {
      this.unframe?.();
      this.view = view;
      this.animation = new DarknessAnimation();
      this.unframe = view.onFrame(() => this.draw());
    }
    this.animation.update(scene, performance.now(), this.media?.matches === true);
    const sources = scene ? sceneLightSources({
      lights: scene.lights,
      tokens: scene.tokens.filter((token) => !token.hidden),
    }) : [];
    // Light restriction is independent of sight (a window can pass light).
    const segments = sightSegments((scene?.walls ?? []).map((wall) => ({...wall, sight:wall.light})));
    const key = JSON.stringify([scene?._id, sources, segments]);
    if (key !== this.key) {
      this.key = key;
      const revision = ++this.revision;
      // Fail closed while recomputing: never retain a glow through a newly closed wall.
      this.lights = [];
      const flat = flatSegments(segments);
      void Promise.all(sources.map(async (source): Promise<LightView> => ({
        light: {_id:source.id, x:source.x, y:source.y, bright:source.bright, dim:source.dim,
          color:source.color ?? "#ffe9b8", alpha: Math.max(0,Math.min(1,source.alpha ?? 0.8))},
        poly: await this.computer.compute(source.x,source.y,flat,source.dim),
      }))).then((lights) => {
        if (!this.destroyed && revision === this.revision) {
          this.lights = lights.filter(({poly}) => poly !== null && poly.length >= 6 && poly.length % 2 === 0 && poly.every(Number.isFinite));
          this.draw();
        }
      }).catch(() => { /* Failed light polygons stay absent; fog/vision is independent. */ });
    }
    this.draw();
  }
  private draw(): void {
    const view = this.view;
    if (!view) return;
    view.getLightingLayer().sync(this.lights,
      {darkness:this.animation.sample(performance.now(),this.media?.matches === true),color:"#0a0e1a"},view.camera,view.viewport);
  }
  destroy(): void {
    this.destroyed = true; this.revision++; this.unframe?.(); this.unframe = undefined;
    this.view = undefined; this.computer.terminate();
  }
}
