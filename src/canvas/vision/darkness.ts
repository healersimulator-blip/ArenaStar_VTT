/**
 * §9 tactical vision bounded by light (plan §2.1 / G-24) — the pure half.
 *
 * Before this module, light and sight were two unrelated systems: `lights.ts` knew how to draw
 * a light, and the fog loop knew how far a token sees, but nothing connected them, so a token in
 * an unlit room saw the whole room. The rule this module encodes is the table's:
 *
 *   a viewer sees as far as the light at the viewer's own position lets it, never farther than
 *   its own sight range — and darkvision is a second, independent sense that works in the dark.
 *
 * Concretely, per viewer:
 *
 *   effective radius = max(darkvision, min(sight, lit radius))
 *
 * where `lit radius` is how far the illumination reaching the viewer carries (infinite under a
 * non-total ambient light — the ordinary "the map is lit" case, which is why every scene that
 * does not set a darkness value behaves exactly as it did before this module existed).
 *
 * **Units.** Ranges are authored in **feet** (a PF1e stat block says "darkvision 60 ft."), and
 * the scene grid converts them to pixels: `feet / grid.distance × grid.size`. Light radii stay
 * in scene pixels because that is what `LightDocument` (the rail's light tool) already writes.
 *
 * **What this is not.** It is not a lighting simulation: illumination is a distance test from a
 * light's centre, not a wall-clipped gradient, so a torch behind a wall can still count as
 * lighting the tile on the far side of it. Wall-clipped light polygons (the render side, where
 * a glow visibly stops at a wall) are the G-26 follow-up, and the asymmetry is deliberate —
 * erring toward "a bit too much light reaches" keeps a hall lit by a torch in the next room
 * playable instead of silently black. Recorded in D-260.
 */
import type { SceneDocument, SceneGrid, TokenDocument } from "../../core/documents";

/** One light that lights the scene: a scene light or a light a token carries. */
export interface PF1eLightSource {
  /** The document the light came from (for renderer bookkeeping). */
  id: string;
  x: number;
  y: number;
  /** The fully lit radius, in scene pixels. */
  bright: number;
  /** The outer (dim) radius, in scene pixels. */
  dim: number;
  /** Render colour; absent = the layer's default torch tone. */
  color?: string;
  /** Render alpha; absent = the layer's default. */
  alpha?: number;
}

/**
 * The lighting state one vision question is answered against. `darkness === 1` is **total
 * darkness**: only lights and darkvision reveal. Anything below 1 is ambient light, which
 * reveals at the viewer's own sight range — the pre-§2.1 behaviour, so a scene that never
 * touches its darkness slider never changes.
 */
export interface PF1eLighting {
  /** Ambient darkness 0…1 (`SceneDocument.darkness`). */
  darkness: number;
  lights: readonly PF1eLightSource[];
}

/** A token's authored vision, in feet, already validated. */
export interface PF1eTokenVision {
  /** Normal sight range; `null` = unlimited (the fog range / scene cap applies). */
  sightFeet: number | null;
  /** Darkvision range; 0 = none. */
  darkvisionFeet: number;
}

/** The level of light at one point, and how far a viewer standing there may see *by light*. */
export interface PF1eLightLevel {
  /** Ambient light reaches every point (darkness < 1). */
  ambient: boolean;
  /** Inside some light's bright radius. */
  bright: boolean;
  /** Inside some light's dim radius (bright implies lit). */
  lit: boolean;
  /**
   * How far illumination carries from this point: `Infinity` under ambient light, else the
   * farthest remaining distance to a light's dim edge (`0` = standing in the dark).
   */
  litRadiusPx: number;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Clamp a positive range author wrote as a number; `null`/absent/garbage → `null`. */
function positiveOrNull(v: unknown): number | null {
  const n = finiteNumber(v);
  if (n === null || n <= 0) return null;
  return n;
}

/** The scene's pixels-per-foot from its grid (`distance` ft per `size`-px cell). */
export function pixelsPerFoot(grid: Pick<SceneGrid, "size" | "distance"> | null | undefined): number {
  const size = finiteNumber(grid?.size);
  const distance = finiteNumber(grid?.distance);
  const cell = size !== null && size > 0 ? size : 100;
  const feet = distance !== null && distance > 0 ? distance : 5;
  return cell / feet;
}

/** Feet → scene pixels through the grid (a 5-ft grid at 100 px/cell is 20 px per foot). */
export function feetToPixels(
  feet: number,
  grid: Pick<SceneGrid, "size" | "distance"> | null | undefined,
): number {
  const value = finiteNumber(feet);
  if (value === null) return 0;
  return Math.max(0, value) * pixelsPerFoot(grid);
}

/** A token's authored vision, validated (absent sight = unlimited, absent darkvision = none). */
export function tokenVisionOf(token: Pick<TokenDocument, "sight" | "darkvision">): PF1eTokenVision {
  return {
    sightFeet: positiveOrNull(token.sight),
    darkvisionFeet: positiveOrNull(token.darkvision) ?? 0,
  };
}

/**
 * A token's carried light, or `null` when it carries none. `TokenLight.radius` is the **dim**
 * radius (that is what the D-256 rail's light tool writes and what the layer draws); `bright`
 * is authored explicitly or defaults to half, the same proportion the rail uses for scene
 * lights.
 */
export function tokenLightSourceOf(
  token: Pick<TokenDocument, "_id" | "x" | "y" | "light">,
): PF1eLightSource | null {
  const raw = asRecord(token.light);
  if (raw === null) return null;
  const dim = positiveOrNull(raw.radius);
  if (dim === null) return null;
  const bright = positiveOrNull(raw.bright) ?? Math.max(1, Math.round(dim / 2));
  return {
    id: `token:${token._id}`,
    x: token.x,
    y: token.y,
    bright: Math.min(bright, dim),
    dim,
    ...(typeof raw.color === "string" ? { color: raw.color } : {}),
    ...(finiteNumber(raw.alpha) !== null ? { alpha: finiteNumber(raw.alpha) as number } : {}),
  };
}

/**
 * Every light that shines on a scene: the placed ones (`scene.lights`, from the rail's light
 * tool) plus every token-carried one. A light is a light whoever holds it — a torch makes the
 * bearer visible, which is the whole reason a party carries one.
 */
export function sceneLightSources(
  scene: Pick<SceneDocument, "lights" | "tokens">,
): PF1eLightSource[] {
  const out: PF1eLightSource[] = [];
  for (const light of scene.lights ?? []) {
    const dim = positiveOrNull(light.dim);
    if (dim === null) continue;
    const bright = positiveOrNull(light.bright) ?? 0;
    out.push({
      id: light._id,
      x: light.x,
      y: light.y,
      bright: Math.min(bright, dim),
      dim,
      ...(typeof light.color === "string" ? { color: light.color } : {}),
      ...(finiteNumber(light.alpha) !== null ? { alpha: finiteNumber(light.alpha) as number } : {}),
    });
  }
  for (const token of scene.tokens ?? []) {
    const carried = tokenLightSourceOf(token);
    if (carried !== null) out.push(carried);
  }
  return out;
}

/** The lighting state of a scene (`SceneDocument.darkness`, clamped to 0…1). */
export function sceneLighting(
  scene: Pick<SceneDocument, "darkness" | "lights" | "tokens">,
): PF1eLighting {
  const darkness = finiteNumber(scene.darkness) ?? 0;
  return {
    darkness: Math.max(0, Math.min(1, darkness)),
    lights: sceneLightSources(scene),
  };
}

/** The level of light at a point (`{x, y}` in scene pixels). */
export function lightLevelAt(
  point: { x: number; y: number },
  lighting: PF1eLighting,
): PF1eLightLevel {
  const ambient = lighting.darkness < 1;
  let bright = false;
  // Ambient light lights the point itself (dim light, under 1.0 darkness); lights add to that.
  let lit = ambient;
  let litRadiusPx = ambient ? Number.POSITIVE_INFINITY : 0;
  for (const light of lighting.lights) {
    const distance = Math.hypot(point.x - light.x, point.y - light.y);
    if (distance <= light.bright) bright = true;
    if (distance > light.dim) continue;
    lit = true;
    // Standing in this light means seeing everything it reaches from here — out to its edge.
    litRadiusPx = Math.max(litRadiusPx, light.dim - distance);
  }
  return { ambient, bright, lit, litRadiusPx };
}

/** Is a token (or a point) visible *as a lit thing*? Ambient light or any light's dim radius. */
export function isLitAt(point: { x: number; y: number }, lighting: PF1eLighting): boolean {
  return lightLevelAt(point, lighting).lit;
}

export interface EffectiveSightInput {
  /** Where the viewer stands, in scene pixels. */
  x: number;
  y: number;
  vision: PF1eTokenVision;
  lighting: PF1eLighting;
  /** Pixels per foot (`pixelsPerFoot(scene.grid)`), the unit conversion for the ranges. */
  pxPerFoot?: number;
  /** Hard cap on every sense (the scene diagonal or the scene's fog range). */
  capPx?: number;
}

/**
 * The plan's rule, in pixels: `max(darkvision, min(sight, lit radius))`, capped by the scene.
 * A viewer with no darkvision standing in total darkness and outside every light gets `0` —
 * nothing is revealed, which is the point of the slice.
 */
export function effectiveSightRadiusPx(input: EffectiveSightInput): number {
  const perFoot = finiteNumber(input.pxPerFoot) ?? 20;
  const cap = finiteNumber(input.capPx);
  const capPx = cap === null || cap <= 0 ? Number.POSITIVE_INFINITY : cap;
  const darkvisionPx = Math.max(0, input.vision.darkvisionFeet) * perFoot;
  const sightPx =
    input.vision.sightFeet === null ? capPx : Math.max(0, input.vision.sightFeet) * perFoot;
  const { litRadiusPx } = lightLevelAt({ x: input.x, y: input.y }, input.lighting);
  const byLight = Math.min(sightPx, litRadiusPx);
  return Math.max(0, Math.min(capPx, Math.max(darkvisionPx, byLight)));
}

/**
 * The same rule for one token of a scene, with the scene's own grid and lighting — the call
 * the fog loop makes per viewer.
 */
export function viewerSightRadiusPx(
  scene: Pick<SceneDocument, "grid" | "darkness" | "lights" | "tokens">,
  token: TokenDocument,
  capPx: number,
): number {
  return effectiveSightRadiusPx({
    x: token.x,
    y: token.y,
    vision: tokenVisionOf(token),
    lighting: sceneLighting(scene),
    pxPerFoot: pixelsPerFoot(scene.grid),
    capPx,
  });
}

/**
 * Does this token's darkvision reach that point? Independent of walls — the fog loop's
 * polygon already answers "is there a clear line", so this only answers "is it close enough
 * for that sense".
 */
export function withinDarkvision(
  viewer: { x: number; y: number; darkvisionPx: number },
  point: { x: number; y: number },
): boolean {
  if (viewer.darkvisionPx <= 0) return false;
  return Math.hypot(point.x - viewer.x, point.y - viewer.y) <= viewer.darkvisionPx;
}
