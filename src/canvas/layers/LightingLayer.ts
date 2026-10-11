/**
 * §9 Lighting — colored ambient darkness with additive light gradients
 * clipped by each light's visibility polygon (computed by vision.worker).
 * Pure helpers (lightAffectsViewport, parseLightColor, gradient stops) are
 * separated for Node tests; the layer itself is Pixi-only.
 */
import { Container, FillGradient, Graphics } from "pixi.js";
import type { RadialGradientOptions } from "pixi.js";
import type { Camera, Viewport } from "../camera";
import type { LevelSurface, LightDocument } from "../../core/documents";
import { surfaceRings } from "../../core/floorSurface";

import type { AmbientLighting } from "../vision/lights";
import { lightAffectsViewport, parseLightColor, rgba } from "../vision/lights";

export type { AmbientLighting as Ambient } from "../vision/lights";

export interface LightView {
  light: LightDocument | Pick<LightDocument, "_id" | "x" | "y" | "dim" | "bright" | "color" | "alpha">;
  /** Visibility polygon (flat [x,y,…]) from the vision worker, or null. */
  poly: Float32Array | null;
}

export { lightAffectsViewport, parseLightColor };

/**
 * G-22 (D-446): light between floors, drawn only where this floor is open. Through the openings
 * the floors below show under their own ambient darkness and lights; the floor above's lights
 * fall through its own openings. Untraced floors are solid: nothing crosses them.
 */
export interface CrossFloorLightingView {
  /** This floor's solid area; null = solid everywhere. */
  solid: LevelSurface | null;
  /** Ambient darkness seen through the openings (the nearest seen floor below's); null = this floor's own everywhere. */
  belowDarkness: number | null;
  /** Other floors' lights, each group clipped to the openings of every surface in `masks`. */
  groups: ReadonlyArray<{ key: string; masks: readonly LevelSurface[]; views: readonly LightView[] }>;
}

/** What the cross-floor lighting currently draws (e2e readback). */
export interface CrossFloorLightingState {
  split: boolean;
  belowDarkness: number | null;
  groups: Array<{ key: string; masks: number; lights: string[] }>;
}

type Rings = ReturnType<typeof surfaceRings>;
function ringInside(inner: readonly number[], outer: readonly number[]): boolean {
  // Valid surfaces never cross, so one vertex decides.
  const x = inner[0] ?? 0, y = inner[1] ?? 0;
  let inside = false;
  for (let i = 0, j = outer.length - 2; i < outer.length; j = i, i += 2) {
    const xi = outer[i] ?? 0, yi = outer[i + 1] ?? 0, xj = outer[j] ?? 0, yj = outer[j + 1] ?? 0;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const ringArea = (ring: readonly number[]): number => {
  let a = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) a += ((ring[j] ?? 0) - (ring[i] ?? 0)) * ((ring[j + 1] ?? 0) + (ring[i + 1] ?? 0));
  return Math.abs(a / 2);
};
/**
 * Pixi gives a fill's last shape its `cut()` holes only when it draws that fill, and Canvas2D
 * masks are never drawn: they read the holes straight off the shapes. Assign them up front.
 */
function assignHoles(g: Graphics): void {
  for (const instruction of g.context.instructions) {
    if (instruction.action !== "fill" || !instruction.data.hole) continue;
    const shapes = instruction.data.path.shapePath.shapePrimitives, last = shapes[shapes.length - 1];
    if (last) last.holes = instruction.data.hole.shapePath.shapePrimitives;
  }
}
/** Fill `outline` minus `cuts` (one cut per fill: a second cut would also hit the fill before). */
function fillCut(g: Graphics, outline: readonly number[] | null, box: readonly number[], cuts: ReadonlyArray<readonly number[]>, color: number): void {
  g.poly([...(outline ?? box)]).fill({ color });
  if (cuts.length) { for (const ring of cuts) g.poly([...ring]); g.cut(); }
}
/** The solid area: each component's outline with its openings cut out. */
function drawSolid(g: Graphics, rings: Rings, color: number): void {
  for (const { outer, holes } of rings) fillCut(g, outer, outer, holes, color);
  assignHoles(g);
}
/**
 * Everything but the solid area, within a box that holds every ring (earcut needs holes inside
 * their outline). Openings in a solid area are filled back, minus any solid area inside them.
 */
function drawOpenings(g: Graphics, rings: Rings, color: number): void {
  const xs: number[] = [], ys: number[] = [];
  for (const { outer } of rings) for (let i = 0; i < outer.length; i += 2) { xs.push(outer[i] ?? 0); ys.push(outer[i + 1] ?? 0); }
  if (!xs.length) return;
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = Math.max(100_000, 4 * Math.max(maxX - minX, maxY - minY));
  const box = [minX - pad, minY - pad, maxX + pad, minY - pad, maxX + pad, maxY + pad, minX - pad, maxY + pad];
  // Each component sits in the smallest opening (of another component) that holds it, or at the top.
  const holes = rings.flatMap((r) => r.holes.map((hole) => ({ hole, owner: r })));
  const parent = new Map(rings.map((r) => {
    const around = holes.filter((h) => h.owner !== r && ringInside(r.outer, h.hole)).sort((a, b) => ringArea(a.hole) - ringArea(b.hole))[0];
    return [r, around?.hole ?? null] as const;
  }));
  const inside = (hole: readonly number[] | null) => rings.filter((r) => parent.get(r) === hole);
  const fill = (outline: readonly number[] | null, depth: number): void => {
    const children = inside(outline);
    fillCut(g, outline, box, children.map((r) => r.outer), color);
    if (depth < 16) for (const child of children) for (const hole of child.holes) fill(hole, depth + 1);
  };
  fill(null, 0);
  assignHoles(g);
}
function drawLight(g: Graphics, light: LightView["light"], poly: Float32Array | null): void {
  g.clear();
  const radius = Math.max(light.dim, light.bright, 1);
  const gradient = lightGradient(light.bright, light.dim, parseLightColor(light.color), light.alpha);
  // draw in a LOCAL frame (light center = origin, 1 = dim radius) so the
  // 0-1 radial gradient aligns; the container translation places it.
  g.position.set(light.x, light.y);
  g.scale.set(radius);
  if (poly && poly.length >= 6) {
    g.moveTo(((poly[0] ?? 0) - light.x) / radius, ((poly[1] ?? 0) - light.y) / radius);
    for (let i = 2; i < poly.length; i += 2) {
      g.lineTo(((poly[i] ?? 0) - light.x) / radius, ((poly[i + 1] ?? 0) - light.y) / radius);
    }
    g.closePath().fill(gradient);
  } else {
    // no polygon (open field): full circle
    g.circle(0, 0, 1).fill(gradient);
  }
}

export function lightGradient(
  bright: number,
  dim: number,
  color: number,
  alpha: number,
): FillGradient {
  // radial gradient in LOCAL 0-1 space (default textureSpace): center 0.5,
  // outerRadius 0.5 covers the (pre-scaled) light shape; the caller draws the
  // polygon/path scaled so 1 = dim radius.
  const radius = Math.max(dim, bright, 1);
  const options: RadialGradientOptions = {
    type: "radial",
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0.5 * Math.max(0, Math.min(bright / radius, 0.999)),
    outerRadius: 0.5,
    colorStops: [
      { offset: 0, color: rgba(color, alpha) },
      { offset: 1, color: rgba(color, 0) },
    ],
  };
  return new FillGradient(options);
}

export class LightingLayer {
  readonly container = new Container();
  private readonly darkness = new Graphics();
  /** G-22: the ambient darkness seen through this floor's openings. */
  private readonly darknessBelow = new Graphics();
  private readonly lights = new Container();
  /** G-22: other floors' lights, clipped to the openings they shine through. */
  private readonly crossLights = new Container();
  private readonly views = new Map<string, Graphics>();
  private key = "";
  private ambientKey = "";
  private lastViews: readonly LightView[] | undefined;
  private cross: CrossFloorLightingView | null = null;
  private crossState: CrossFloorLightingState = { split: false, belowDarkness: null, groups: [] };

  constructor() {
    this.container.label = "lighting";
    this.darkness.label = "darkness";
    // Tint the existing map instead of replacing it with a flat opaque rectangle at night.
    // Fog/vision is the authority for concealment, including darkvision.
    this.darkness.blendMode = "multiply";
    this.lights.label = "lights";
    this.darknessBelow.label = "darknessBelow";
    this.darknessBelow.blendMode = "multiply";
    this.darknessBelow.visible = false;
    this.crossLights.label = "crossFloorLights";
    this.container.addChild(this.darkness, this.darknessBelow, this.lights, this.crossLights);
  }

  sync(
    views: readonly LightView[],
    ambient: AmbientLighting,
    camera: Camera,
    viewport: Viewport,
    cross: CrossFloorLightingView | null = null,
  ): void {
    const view = {
      x: camera.x,
      y: camera.y,
      width: viewport.width / camera.scale,
      height: viewport.height / camera.scale,
    };
    const viewportKey = [view.x, view.y, view.width, view.height].join("|");
    const split = cross?.solid && cross.belowDarkness !== null ? { solid: cross.solid, below: Math.max(0, Math.min(1, cross.belowDarkness)) } : null;
    // A split darkness has fixed geometry: only the plain rectangle follows the viewport.
    const ambientKey = split ? `split|${ambient.color}|${JSON.stringify(split.solid)}` : `${viewportKey}|${ambient.color}`;
    this.darkness.alpha = Math.max(0, Math.min(1, ambient.darkness));
    this.darknessBelow.visible = split !== null;
    if (split) this.darknessBelow.alpha = split.below;
    if (ambientKey !== this.ambientKey) {
      this.ambientKey = ambientKey;
      const color = parseLightColor(ambient.color, 0x0a0e1a);
      this.darkness.clear();
      this.darknessBelow.clear();
      if (split) {
        const rings = surfaceRings(split.solid);
        drawSolid(this.darkness, rings, color);
        drawOpenings(this.darknessBelow, rings, color);
      } else this.darkness.rect(view.x - 2, view.y - 2, view.width + 4, view.height + 4).fill({ color });
    }
    if (cross !== this.cross) this.drawCross(cross);
    this.crossState = { ...this.crossState, split: split !== null, belowDarkness: split ? split.below : null };
    // Interpolation changes only alpha, not geometry or light gradients. New light-view
    // arrays invalidate polygons even when their vertex count is unchanged.
    if (viewportKey === this.key && views === this.lastViews) return;
    this.key = viewportKey;
    this.lastViews = views;

    const seen = new Set<string>();
    for (const { light, poly } of views) {
      if (!lightAffectsViewport(light, view)) continue;
      seen.add(light._id);
      let g = this.views.get(light._id);
      if (!g) {
        g = new Graphics();
        g.blendMode = "add";
        this.views.set(light._id, g);
        this.lights.addChild(g);
      }
      drawLight(g, light, poly);
    }
    for (const [id, g] of this.views) {
      if (!seen.has(id)) {
        this.views.delete(id);
        g.destroy();
      }
    }
  }

  /** G-22 (D-446): what crosses floors right now. */
  crossFloorState(): CrossFloorLightingState {
    return structuredClone(this.crossState);
  }

  /**
   * Each group sits in nested containers, one per surface it shines through, each masked to that
   * surface's openings. Masks are Graphics (Canvas2D clips those, holes included, even-odd).
   */
  private drawCross(cross: CrossFloorLightingView | null): void {
    this.cross = cross;
    for (const child of this.crossLights.removeChildren()) child.destroy({ children: true });
    const groups: CrossFloorLightingState["groups"] = [];
    for (const group of cross?.groups ?? []) {
      if (!group.views.length || !group.masks.length) continue;
      let parent: Container = this.crossLights;
      for (const surface of group.masks) {
        const mask = new Graphics(), holder = new Container();
        mask.label = `crossFloorMask:${group.key}`;
        holder.label = `crossFloor:${group.key}`;
        drawOpenings(mask, surfaceRings(surface), 0xffffff);
        parent.addChild(mask, holder);
        holder.mask = mask;
        parent = holder;
      }
      for (const { light, poly } of group.views) {
        const g = new Graphics();
        g.blendMode = "add";
        drawLight(g, light, poly);
        parent.addChild(g);
      }
      groups.push({ key: group.key, masks: group.masks.length, lights: group.views.map((v) => v.light._id) });
    }
    this.crossState = { ...this.crossState, groups };
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.views.clear();
  }
}
