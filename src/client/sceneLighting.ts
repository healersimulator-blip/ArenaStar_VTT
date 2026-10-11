/** Shared production lighting presentation. Replica-only inputs, latest-scene-wins polygons. */
import type { LevelSurface, LightDocument, SceneDocument, WallDocument } from "../core/documents";
import type { FloorLighting } from "../core/levelPlay";
import type { VisionComputer } from "../workers/visionWorkerClient";
import type { CrossFloorLightingView, LightView } from "../canvas/layers/LightingLayer";
import type { Stage } from "../canvas/stage";
import { DarknessAnimation } from "../canvas/darknessAnimation";
import { sceneLightSources, sceneForLevelPerception } from "../canvas/vision/darkness";
import { sightSegments } from "../canvas/vision/wallSight";
import { flatSegments } from "../core/fogExploration";
import { levelSurfaceError } from "../core/floorSurface";

type LightingView = Pick<Stage, "camera" | "viewport" | "onFrame"> & {getLightingLayer(): Pick<ReturnType<Stage["getLightingLayer"]>, "sync">};

/** G-22 (D-446): other floors' lights and walls, resolved from the replica, ready to draw. */
export interface CrossFloorLightingInput {
  solid: LevelSurface | null;
  belowDarkness: number | null;
  groups: Array<{ key: string; masks: LevelSurface[]; lights: LightDocument[]; walls: WallDocument[] }>;
}

/**
 * Resolves a floor's light links against the full replica (not the floor-filtered scene). Below:
 * each seen floor's lights shine through this floor's openings and every nearer seen floor's; a
 * floor without a surface is solid and ends the chain. Above: the floor above's lights fall
 * through its own openings.
 */
export function crossFloorLightingInput(lighting: FloorLighting | null | undefined, docs: Pick<SceneDocument, "lights" | "walls">): CrossFloorLightingInput | null {
  // Malformed surfaces never reach the renderer: a bad one of this floor's drops it all, a bad link's drops that link.
  if (!lighting || (lighting.surface && levelSurfaceError(lighting.surface))) return null;
  lighting = { ...lighting, links: lighting.links.filter((l) => !l.surface || !levelSurfaceError(l.surface)) };
  const lights = new Map(docs.lights.map((l) => [l._id, l])), walls = new Map(docs.walls.map((w) => [w._id, w]));
  const resolve = <T,>(ids: readonly string[], from: ReadonlyMap<string, T>): T[] => ids.flatMap((id) => { const doc = from.get(id); return doc ? [doc] : []; });
  const groups: CrossFloorLightingInput["groups"] = [];
  const below = lighting.links.filter((l) => l.side === "below").sort((a, b) => a.depth - b.depth);
  if (lighting.surface) {
    const through: LevelSurface[] = [lighting.surface];
    for (const link of below) {
      const own = resolve(link.lightIds, lights);
      if (own.length) groups.push({ key: `below:${link.levelId}`, masks: [...through], lights: own, walls: resolve(link.wallIds, walls) });
      if (!link.surface) break;
      through.push(link.surface);
    }
  }
  for (const link of lighting.links) {
    if (link.side !== "above" || !link.surface) continue;
    const own = resolve(link.lightIds, lights);
    if (own.length) groups.push({ key: `above:${link.levelId}`, masks: [link.surface], lights: own, walls: resolve(link.wallIds, walls) });
  }
  const nearest = below[0];
  const belowDarkness = lighting.surface && nearest ? nearest.darkness : null;
  return groups.length || belowDarkness !== null ? { solid: lighting.surface ?? null, belowDarkness, groups } : null;
}

const validPoly = ({poly}: LightView) => poly !== null && poly.length >= 6 && poly.length % 2 === 0 && poly.every(Number.isFinite);
export class SceneLightingPlayer {
  private animation = new DarknessAnimation();
  private ambientContext = "";
  private readonly media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  private view: LightingView | undefined;
  private unframe: (() => void) | undefined;
  private lights: readonly LightView[] = [];
  private cross: CrossFloorLightingView | null = null;
  private key = "";
  private revision = 0;
  private destroyed = false;
  constructor(private readonly computer: VisionComputer) {}
  sync(scene: SceneDocument | null, view: LightingView, levelId?: string, presentationKey?: string, cross?: CrossFloorLightingInput | null): void {
    if (scene && levelId !== undefined) scene = sceneForLevelPerception(scene, levelId);
    if (this.destroyed) return;
    if (view !== this.view) {
      this.unframe?.();
      this.view = view;
      this.animation = new DarknessAnimation();
      this.unframe = view.onFrame(() => this.draw());
    }
    const ambientContext = JSON.stringify([scene?._id, presentationKey ?? levelId ?? null]);
    if (ambientContext !== this.ambientContext) { this.ambientContext = ambientContext; this.animation = new DarknessAnimation(); }
    this.animation.update(scene, performance.now(), this.media?.matches === true);
    const sources = scene ? sceneLightSources({
      lights: scene.lights,
      tokens: scene.tokens.filter((token) => !token.hidden),
    }) : [];
    // Light restriction is independent of sight (a window can pass light).
    const segments = sightSegments((scene?.walls ?? []).map((wall) => ({...wall, sight:wall.light})));
    // G-22: other floors' lights, each shaped by its own floor's walls (only scoped scenes have them).
    const crossSources = (scene ? cross?.groups ?? [] : []).map((group) => ({ key: group.key, masks: group.masks,
      sources: sceneLightSources({ lights: group.lights, tokens: [] }),
      segments: sightSegments(group.walls.map((wall) => ({...wall, sight:wall.light}))) }));
    const crossKey = scene && cross ? [cross.solid, cross.belowDarkness, crossSources] : null;
    const key = JSON.stringify([scene?._id, presentationKey ?? levelId ?? null, sources, segments, crossKey]);
    if (key !== this.key) {
      this.key = key;
      const revision = ++this.revision;
      // Fail closed while recomputing: never retain a glow through a newly closed wall.
      this.lights = [];
      this.cross = null;
      const views = (list: typeof sources, flat: Float32Array) => Promise.all(list.map(async (source): Promise<LightView> => ({
        light: {_id:source.id, x:source.x, y:source.y, bright:source.bright, dim:source.dim,
          color:source.color ?? "#ffe9b8", alpha: Math.max(0,Math.min(1,source.alpha ?? 0.8))},
        poly: await this.computer.compute(source.x,source.y,flat,source.dim),
      })));
      void Promise.all([views(sources, flatSegments(segments)),
        Promise.all(crossSources.map(async (group) => ({ key: group.key, masks: group.masks, views: (await views(group.sources, flatSegments(group.segments))).filter(validPoly) })))]).then(([lights, groups]) => {
        if (!this.destroyed && revision === this.revision) {
          this.lights = lights.filter(validPoly);
          this.cross = scene && cross ? { solid: cross.solid, belowDarkness: cross.belowDarkness, groups } : null;
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
      {darkness:this.animation.sample(performance.now(),this.media?.matches === true),color:"#0a0e1a"},view.camera,view.viewport,this.cross);
  }
  destroy(): void {
    this.destroyed = true; this.revision++; this.unframe?.(); this.unframe = undefined;
    this.view = undefined; this.computer.terminate();
  }
}
