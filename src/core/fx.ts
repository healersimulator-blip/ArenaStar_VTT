/**
 * Versioned, data-only FX timeline. Visual sections have NO mechanical effect;
 * a host validates the definition, resolves anchors and chooses recipients.
 * Times are offsets from one host-clock timestamp, so lanes naturally overlap.
 * This is the first sequence format, not the full Sequencer action catalogue.
 */
import type { SceneDocument, TokenDocument } from "./documents";
import { CROSSHAIR_DEFAULT_SPREAD, crosshairArea, crosshairPxPerUnit,
  type CrosshairPoint, type CrosshairShape } from "./crosshair";
import { SOUND_RADIUS_LIMITS } from "./fxSound";
import { segmentCrossingPoint, visibilityPolygon } from "../canvas/vision/polygon";
import { distanceToSegment } from "../canvas/vision/wallKinds";
import { sightSegments } from "../canvas/vision/wallSight";
import { isSoundChannel, type FxSoundChannel } from "./fxSound";

export type FxAnchor = { kind: "point"; x: number; y: number } | { kind: "source" | "target" };

/** Explicit, independent rights declarations for user-provided FX media. */
export interface FxImportPermissions {
  /** Serving media bytes to connected players also requires appropriate permission. */
  shareWithPlayers: boolean;
  /** Embedding bytes in a downloadable world archive needs redistribution rights. */
  includeInWorldFile: boolean;
}
export type FxLayerName = "belowTokens" | "aboveTokens";

/**
 * How a visual section composites onto what is already under it. A closed set, because
 * an unknown blend would silently render as `normal` while the author believed they had
 * a glow; every name is one the renderer genuinely supports.
 */
export type FxBlendMode = "normal" | "add" | "multiply" | "screen" | "overlay" | "darken" | "lighten";
const BLEND_MODE_SET: readonly string[] = ["normal", "add", "multiply", "screen", "overlay", "darken", "lighten"];
const isBlendMode = (value: unknown): value is FxBlendMode =>
  typeof value === "string" && BLEND_MODE_SET.includes(value);

/**
 * SQ-19: a visual can be confined to a region (`mask`) or have a region cut out of it
 * (`invert: true`). The region is one of the **shared crosshair's** shapes — the same
 * geometry the author sees when placing an anchor, so "a 15 ft circle" means the same
 * thing whether it is a placement or a mask — measured in scene units against the
 * scene's own grid metric.
 *
 * A mask is authored around the visual's **own anchor** and travels with it: the host
 * resolves the shape into a polygon of offsets, so a followed aura's mask moves with
 * the token instead of staying behind where the host last saw it.
 */
export interface FxMask {
  /**
   * `point` is deliberately absent: a region with no area hides everything or nothing.
   * `polygon` (D-315) is the authored shape: `points` are scene units **relative to the
   * anchor**, so a hand-drawn room, ridge or cone of cold is a region like any other — and
   * with `walls` it is cut against the scene's own sight exactly as the four shapes are.
   */
  kind: "circle" | "cone" | "ray" | "rect" | "polygon";
  /**
   * Scene units: a circle/cone's radius, a ray/rect's depth. **Required on the four shapes
   * and absent on a polygon**, which is measured by its own points instead — the host
   * enforces that (a shape without a usable length is refused), because a hand-written
   * document never passed a type checker.
   */
  length?: number;
  /** Scene units, ray/rect only. */
  width?: number;
  /** Degrees, 0 = east, growing clockwise on screen. Cone/ray/rect only. */
  angle?: number;
  /** Aperture in degrees for a cone (1–359); defaults to the crosshair's 53.13. */
  spread?: number;
  /**
   * SQ-05/D-307: stop the region where a wall blocks sight. The host trims the resolved
   * polygon against the scene's own sight segments — the same rule the fog uses, doors
   * included — and bakes the result, because a client has no walls to trim against (and
   * must not be handed them). It therefore cannot animate: the trim depends on geometry a
   * recipient never sees.
   */
  walls?: boolean;
  /**
   * SQ-05/D-305: animate the region itself. `lengthTo` is the reach it grows to — on its
   * own the whole region scales about its anchor, so a rectangle's width grows with its
   * depth (a growing sliver would be a different shape, not a bigger one), and beside a
   * `widthTo`/`spreadTo` it becomes the *along* axis alone, because then every axis has
   * been pinned to its own number; `spinDeg` turns the region, accumulating across
   * `repeats` like the visual's own spin. All of them are eased by the section's curve,
   * and the same two rules the visual's transform follows — a size (reach or width or
   * aperture) restarts in each cycle, only a bearing keeps going.
   */
  lengthTo?: number;
  spinDeg?: number;
  /**
   * D-315: the authored region, in scene units **from the anchor**, in order around it.
   * 3–64 points: three is the least that has an area, and 64 keeps the trim's angular sweep
   * and the wire bounded. The region must not cross itself, and a wall-bounded one must be
   * star-shaped about the anchor (see `walls`) — both refused by name rather than resolved
   * into something the author did not draw.
   */
  points?: Array<{ x: number; y: number }>;
  /**
   * D-315: a polygon's own growth. It has no "length" to grow to, so it grows by a **ratio**
   * — the same 0.05–10 the visual's own `scaleTo` uses, and the same number the region
   * already travels with. (Only a polygon has it: the four crosshair shapes keep `lengthTo`,
   * which is measured in the scene.)
   */
  scaleTo?: number;
  /**
   * D-314: the **cross axis** animates too, on the same curve and cycle — and it means its
   * own number. `widthTo` is the width a ray/rect widens to (scene units), perpendicular to
   * its own axis, so a beam thickens without gaining a single unit of reach; `spreadTo` is
   * the aperture a cone opens to (degrees), its points keeping their radius. A circle has no
   * cross axis and a ray has no aperture, so each field belongs to its own shapes and the
   * others refuse it by name.
   */
  widthTo?: number;
  spreadTo?: number;
  /** Keep the *outside* of the shape — a cutout — instead of the inside. */
  invert?: boolean;
}
/**
 * A mask as it travels: a closed polygon **relative to the visual's anchor** (world
 * px offsets, not scene units) plus which side of it survives. Relative, because the
 * anchor may be a followed token that moves every frame.
 */
export interface ResolvedFxMask {
  area: CrosshairPoint[];
  invert: boolean;
  /**
   * The region's own animation, in the two unit-free forms the rest of the vocabulary
   * uses: `scale` is the ratio it grows by (never an authored scene-unit length, so a
   * client never re-derives the scene's metric) and `spinDeg` is the turn. Absent when
   * the author animated nothing, and a still region is still built exactly once.
   */
  animate?: {
    scale?: number; spinDeg?: number;
    /**
     * D-314: the cross axis's own end, in the shape's own frame. `ratio` is the anonymous
     * scale the width (or the aperture) walks to — a ratio, never the authored scene-unit
     * number, so a client still learns no metric; `axisDeg` is the screen bearing that
     * frame points along, carried because a polygon alone does not say which way a
     * rectangle is facing; and `fan` marks a cone, whose cross axis is an **angle**, so it
     * opens by swinging its points about the apex instead of stretching them sideways.
     * Present only when the author pinned the cross axis — every stored timeline and every
     * still region travels exactly as it did before.
     */
    cross?: { ratio: number; axisDeg: number; fan?: boolean };
  };
}
/**
 * SQ-05/D-307: the region a wall-bounded mask actually covers. `area` is the authored
 * shape as offsets from its anchor and `segments` are the scene's sight blockers in that
 * same offset space; both are star-shaped about the anchor, so the region is exactly the
 * smaller of the two radial extents, sampled where either one bends: at every vertex angle
 * of either polygon, and at every crossing of their edges (so a switch between the mask's
 * boundary and a wall's inside one span is not chorded). The result is therefore the same
 * polygon the eye would draw — cut at the wall, not near it.
 *
 * Pure and total: no segments, a degenerate shape, or a shadowed anchor all produce a
 * shorter (possibly empty) polygon rather than NaN.
 */
export function fxSightTrim(
  area: readonly CrosshairPoint[],
  segments: readonly { x1: number; y1: number; x2: number; y2: number }[],
  reach: number,
): CrosshairPoint[] {
  if (area.length < 3 || segments.length === 0 || !Number.isFinite(reach) || reach <= 0) return [...area];
  const sight = visibilityPolygon(0, 0, segments, reach);
  const visible: CrosshairPoint[] = [];
  for (let i = 0; i + 1 < sight.length; i += 2) {
    const x = sight[i]; const y = sight[i + 1];
    if (x !== undefined && y !== undefined) visible.push({ x, y });
  }
  if (visible.length < 3) return [];
  const angleOf = (point: CrosshairPoint): number => {
    const angle = Math.atan2(point.y, point.x);
    return angle < 0 ? angle + Math.PI * 2 : angle;
  };
  const angles = [...area, ...visible].map(angleOf);
  // A crossing point of the two boundaries lies on both, so sampling there keeps the
  // result exact where the region stops following one polygon and starts following the other.
  for (let i = 0; i < area.length; i += 1) {
    const a = area[i]; const b = area[(i + 1) % area.length];
    if (!a || !b) continue;
    for (let j = 0; j < visible.length; j += 1) {
      const c = visible[j]; const d = visible[(j + 1) % visible.length];
      if (!c || !d) continue;
      const crossing = segmentCrossingPoint(a, b, c, d);
      if (crossing) angles.push(angleOf(crossing));
    }
  }
  angles.sort((left, right) => left - right);
  /** The farthest point of a star-shaped polygon along the ray at `angle`, or 0. */
  const radial = (polygon: readonly CrosshairPoint[], angle: number): number => {
    const dx = Math.cos(angle); const dy = Math.sin(angle);
    let best = 0;
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i]; const b = polygon[(i + 1) % polygon.length];
      if (!a || !b) continue;
      const ex = b.x - a.x; const ey = b.y - a.y;
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-12) continue;
      const along = (a.x * ey - a.y * ex) / denom; // distance along the ray
      const edge = (a.x * dy - a.y * dx) / denom; // position along the edge
      if (along > best && edge >= -1e-9 && edge <= 1 + 1e-9) best = along;
    }
    return best;
  };
  const out: CrosshairPoint[] = [];
  let previous: number | null = null;
  for (const angle of angles) {
    // Near-duplicate angles would emit duplicate vertices; exact repeats are dropped and
    // closer ones are harmless (they lie on the same boundary within a pixel).
    if (previous !== null && angle - previous < 1e-9) continue;
    previous = angle;
    const distance = Math.min(radial(area, angle), radial(visible, angle));
    if (distance <= 0) continue;
    out.push({ x: Math.cos(angle) * distance, y: Math.sin(angle) * distance });
  }
  return out;
}

/** Where two segments cross, or `null` (endpoints count for a T-junction). */
const MASK_FIELDS: Record<FxMask["kind"], readonly string[]> = {
  // A circle has no facing, so it takes no angle — and therefore no turn either.
  circle: ["kind", "length", "lengthTo", "walls", "invert"],
  cone: ["kind", "length", "lengthTo", "angle", "spread", "spreadTo", "spinDeg", "walls", "invert"],
  ray: ["kind", "length", "lengthTo", "width", "widthTo", "angle", "spinDeg", "walls", "invert"],
  rect: ["kind", "length", "lengthTo", "width", "widthTo", "angle", "spinDeg", "walls", "invert"],
  // A polygon is its own geometry: no length, no width, no angle, and no cross axis. It
  // grows by a ratio, turns about the anchor, and takes the same wall bound and cutout.
  polygon: ["kind", "points", "scaleTo", "spinDeg", "walls", "invert"],
};
/** The least and most points an authored region may have. */
export const FX_POLYGON_POINTS = { min: 3, max: 64 } as const;

/**
 * D-315: is this authored region **star-shaped about the anchor**? The wall trim answers
 * "how far can you see this way" with one distance per angle, so a region whose boundary a
 * ray can cross twice has no single answer — the trim would silently take a slice of it. The
 * test is the definition: walking the vertices, the direction from the anchor must always
 * turn the same way (mod a full turn), which is exactly "each ray meets the boundary once".
 */
export function fxPolygonStarShaped(points: readonly { x: number; y: number }[]): boolean {
  if (points.length < 3) return false;
  let total = 0;
  // The walk is a *loop*: the step from the last point back to the first is an edge like any
  // other, and leaving it out would reject every shape whose seam happens to be closed there.
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    if (!from || !to) return false;
    let delta = Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x);
    // Unwrap to the nearest equivalent turn, so a crossing of the ±π seam is not a reversal.
    while (delta <= -Math.PI) delta += Math.PI * 2;
    while (delta > Math.PI) delta -= Math.PI * 2;
    if (Math.abs(delta) < 1e-9) return false; // two points on one ray: no single extent
    if (delta * total < 0) return false;      // the walk turned back on itself
    total += delta;
  }
  // Exactly one turn: every ray from the anchor leaves through the boundary once.
  return Math.abs(Math.abs(total) - Math.PI * 2) < 1e-6;
}

/** Twice the signed area of an authored region — zero for anything without a region. */
export function fxPolygonArea(points: readonly { x: number; y: number }[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    if (!from || !to) continue;
    sum += from.x * to.y - to.x * from.y;
  }
  return sum;
}

/**
 * D-315: does the authored region cross itself? A bow-tie is not a region an author drew on
 * purpose, and the fill a renderer gives it (even-odd) would show fields the author never
 * asked for — refused instead, by name, with the two offending edges named by position.
 * Touching at a shared vertex is fine: that is how a polygon is closed.
 */
export function fxPolygonSelfCrossing(points: readonly { x: number; y: number }[]): boolean {
  const crosses = (a: { x: number; y: number }, b: { x: number; y: number },
    c: { x: number; y: number }, d: { x: number; y: number }): boolean => {
    const orient = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = orient(a, b, c); const d2 = orient(a, b, d);
    const d3 = orient(c, d, a); const d4 = orient(c, d, b);
    return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
      ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
  };
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    for (let j = i + 1; j < points.length; j += 1) {
      // Adjacent edges share a vertex by construction; the last and first share one too.
      if (j === i || j === (i + 1) % points.length || (i === 0 && j === points.length - 1)) continue;
      const c = points[j]; const d = points[(j + 1) % points.length];
      if (!c || !d) continue;
      if (crosses(a, b, c, d)) return true;
    }
  }
  return false;
}
/** Authored metric bounds, in scene units / degrees. */
export const FX_MASK_LIMITS = { min: 0.5, max: 5_000, spreadMin: 1, spreadMax: 359 } as const;

/**
 * Who a run — or one camera section of it — is delivered to. The same three words at
 * both levels, so an author does not have to learn a second vocabulary for "the GM's
 * view only"; the sequence level has always had them.
 */
export type FxSectionAudience = "scene" | "gm" | "caller";
const AUDIENCES: readonly string[] = ["scene", "gm", "caller"];
export const isFxSectionAudience = (value: unknown): value is FxSectionAudience =>
  typeof value === "string" && AUDIENCES.includes(value);

export type FxFilterKind = "blur" | "grayscale" | "brightness" | "saturate";
/**
 * One filter, with the kind carrying its own range: a blur is measured in pixels and a
 * colour adjustment is a scale, so a single 0–1 bound would make "blur 8" unwritable and
 * "brightness 8" a white square. `strength` is optional — omitted means the kind's
 * default, which is the value the wizard offers first.
 */
export interface FxVisualFilter {
  kind: FxFilterKind;
  strength?: number;
}

/**
 * D-313: one entry of a **chain**. A real look is usually more than one filter — a
 * desaturated, dimmed ghost; a blurred silhouette — and a single field could only express
 * those by picking one. A step is the same shape as the shorthand filter plus its own
 * animation end (`to`), because a chain's entries animate independently: the blur can
 * deepen while the brightness holds.
 *
 * **Two spellings, one document.** One filter stays what it always was (`filter` +
 * `filterTo`), so every stored timeline keeps its meaning; a chain is `filters`, and it is
 * **2–4 entries** — a one-entry chain would be a second spelling of the shorthand, which is
 * exactly the kind of ambiguity the preset rule refuses. An author may not write both.
 */
export interface FxFilterStep {
  kind: FxFilterKind;
  strength?: number;
  /** This step's own animation end (D-304's rule, per entry). */
  to?: number;
}
/** The most filters one section may stack: enough for a look, bounded for the frame budget. */
export const FX_FILTER_CHAIN_MAX = 4;

/** The chain an author wrote, whichever spelling they used (the wizard's read). */
export function fxAuthoredFilters(section: {
  filter?: FxVisualFilter; filterTo?: number; filters?: readonly FxFilterStep[];
}): FxFilterStep[] {
  if (section.filters !== undefined)
    return section.filters.map((step) => ({ ...step }));
  if (section.filter === undefined) return [];
  return [{ ...section.filter, ...(section.filterTo === undefined ? {} : { to: section.filterTo }) }];
}

/**
 * The canonical **write** shape for a chain: nothing for an empty chain, the shorthand for
 * one filter, the chain for two or more. The wizard saves through this, so a look that was
 * built up to three filters and then trimmed back to one is stored as the same document a
 * hand-authored single filter would be — not as a one-entry chain.
 */
export function fxFilterFields(steps: readonly FxFilterStep[]): {
  filter?: FxVisualFilter; filterTo?: number; filters?: FxFilterStep[];
} {
  if (steps.length === 0) return {};
  if (steps.length === 1) {
    const [step] = steps as [FxFilterStep];
    return { filter: { kind: step.kind, ...(step.strength === undefined ? {} : { strength: step.strength }) },
      ...(step.to === undefined ? {} : { filterTo: step.to }) };
  }
  return { filters: steps.map((step) => ({ ...step })) };
}
export const FX_FILTER_RANGES: Record<FxFilterKind, { min: number; max: number; default: number; unit: string }> = {
  blur: { min: 1, max: 32, default: 8, unit: "px" },
  grayscale: { min: 0, max: 1, default: 1, unit: "×" },
  brightness: { min: 0, max: 2, default: 1.5, unit: "×" },
  saturate: { min: 0, max: 2, default: 0.5, unit: "×" },
};
export interface FxFilterPlan {
  kind: FxFilterKind;
  strength: number;
  /** `to` is present only when the author animated *this* entry's strength (D-304/D-313). */
  to?: number;
}
export interface FxVisualStyle {
  blend: FxBlendMode;
  /** The chain in authored order, each entry resolved and clamped. Empty = no filters. */
  filters: FxFilterPlan[];
}
/**
 * Turn an author's choice into the numbers a renderer applies: an absent blend is
 * `normal`, a filter without a strength takes its kind's default, and a strength
 * outside its kind's range is clamped. The host validates all of this, but a client
 * must not render a nonsense value just because a cue was hand-written.
 */
export function fxStylePlan(section: {
  blend?: FxBlendMode; filter?: FxVisualFilter; filterTo?: number; filters?: readonly FxFilterStep[];
}): FxVisualStyle {
  const blend = section.blend ?? "normal";
  const filters: FxFilterPlan[] = [];
  for (const step of fxAuthoredFilters(section)) {
    const kind = step.kind;
    if (!(kind in FX_FILTER_RANGES)) continue; // a forged kind renders as no filter, never as a guess
    const range = FX_FILTER_RANGES[kind];
    const clamp = (value: number): number => Math.min(range.max, Math.max(range.min, value));
    const strength = clamp(step.strength ?? range.default);
    // An animation's end is clamped like its start, and stays *absent* when the author did
    // not ask for one: a stored end equal to the start would be a claim, not a no-op.
    filters.push(step.to === undefined ? { kind, strength } : { kind, strength, to: clamp(step.to) });
  }
  return { blend, filters };
}

/**
 * D-313: every entry's strength at a point inside its section — the chain's per-frame answer.
 * Each entry walks its own `to` on the section's shared curve and cycle, so one filter can
 * pulse while the next holds exactly as authored.
 */
export function fxFilterStrengths(
  filters: readonly FxFilterPlan[],
  section: { easing?: FxEasing; repeats?: number; durationMs: number },
  elapsedMs: number,
): number[] {
  return filters.map((filter) => fxFilterStrength(filter, section, elapsedMs));
}
/**
 * D-304: the filter's strength at a point inside its section — `strength` walking to
 * `to`, eased with the section's own curve and, exactly like scale, restarted per motion
 * cycle (so `repeats` turns a ramp into a pulse: a heartbeat of blur, not one long fade).
 * Pure and total: no animation, a non-finite age or a zero-length section gives the
 * authored start rather than NaN, and either end is clamped to its kind's own range.
 */
export function fxFilterStrength(
  filter: { kind: FxFilterKind; strength: number; to?: number },
  section: { easing?: FxEasing; repeats?: number; durationMs: number },
  elapsedMs: number,
): number {
  const range = FX_FILTER_RANGES[filter.kind];
  const clamp = (value: number): number => Math.min(range.max, Math.max(range.min, value));
  const start = clamp(filter.strength);
  if (filter.to === undefined || !Number.isFinite(elapsedMs) || section.durationMs <= 0) return start;
  const progress = Math.min(1, Math.max(0, elapsedMs / section.durationMs));
  const cycles = section.repeats ?? 1;
  const phase = progress === 1 ? 1 : (progress * cycles) % 1;
  const eased = fxEase(section.easing, phase);
  return clamp(start + (filter.to - start) * eased);
}
export type FxEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";
const EASINGS: readonly FxEasing[] = ["linear", "easeIn", "easeOut", "easeInOut"];
/** Validation reads untyped JSON: narrow rather than cast an arbitrary value. */
const isEasing = (value: unknown): value is FxEasing =>
  typeof value === "string" && (EASINGS as readonly string[]).includes(value);

/**
 * The one easing curve both the canvas visuals and the camera use, so a section
 * cannot move at one rate while its audition moves at another (WZ-09).
 */
export function fxEase(easing: FxEasing | undefined, progress: number): number {
  const phase = Math.min(1, Math.max(0, progress));
  if (easing === "easeIn") return phase * phase;
  if (easing === "easeOut") return 1 - (1 - phase) ** 2;
  if (easing === "easeInOut")
    return phase < 0.5 ? 2 * phase * phase : 1 - (-2 * phase + 2) ** 2 / 2;
  return phase;
}

interface FxBase {
  id: string;
  startMs: number;
  durationMs: number;
  /** One-shot media replays; distinct from located-section `repeats`, which
   * controls motion cycles inside a SINGLE playback window. Waits/persistent
   * loops cannot use this. Host expands into bounded clock-aligned cues. */
  repeatCount?: number;
  repeatDelayMs?: number;
}
interface FxLocated extends FxBase {
  at: FxAnchor;
  /** Local scale, not world/grid size. */
  scale?: number;
  opacity?: number;
  rotation?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  layer?: FxLayerName;
  /** Composite this visual with the layers beneath it (glow, shadow, screen). */
  blend?: FxBlendMode;
  /** One bounded filter: blur, grayscale, brightness or saturation (the D-313 shorthand). */
  filter?: FxVisualFilter;
  /**
   * SQ-05/D-313: a bounded **chain** of filters, applied in the author's order — a
   * desaturated dimmed ghost is two entries, not a compromise between two fields. One
   * filter keeps the D-304 shorthand (`filter` + `filterTo`); two or more use `filters`,
   * and a section may not carry both spellings. Each entry animates its own strength.
   */
  filters?: FxFilterStep[];
  /**
   * SQ-05/D-304: animate the filter's own strength. `filter.strength` (or the kind's
   * default) is where it starts, this is where it ends; the section's own `easing`
   * carries it and with `repeats` it pulses instead of ramping once. Needs a kind to
   * animate: there is nothing to reach without one.
   */
  filterTo?: number;
  /** Confine this visual to a region, or cut that region out of it (SQ-19). */
  mask?: FxMask;
  /** Follow visible source/target token anchors on each recipient's canvas. Only host-resolved IDs travel. */
  follow?: boolean;
  /** Host-resolved destination: tween from `at`, or stretch an image along the segment. */
  to?: FxAnchor;
  easing?: FxEasing;
  /** Number of movement cycles inside this section's fixed duration. */
  repeats?: number;
  /**
   * SQ-05: animate the visual's own scale. `scale` is where it starts, `scaleTo` where
   * it ends; the same easing curve carries it, and with `repeats` it cycles.
   */
  scaleTo?: number;
  /**
   * Degrees turned over the section (negative spins the other way), applied **per
   * cycle**: with `repeats: 3` a 120° spin turns 120° three times rather than crawling
   * 40° each. Bounded, because a cue that spins forever is a loop, not a section.
   */
  spinDeg?: number;
}
/** The animation a located visual's transform is built from, both ends. */
export const FX_SCALE_LIMITS = { min: 0.05, max: 10 } as const;
export const FX_SPIN_LIMIT = 3_600;
/**
 * A camera section claims the **viewer's own view** for its duration. It is not a
 * document change: the host resolves and authorizes the destination exactly as it
 * does for any other anchor, and each recipient's client moves only its own
 * camera. Two rules follow from that, and both are enforced here rather than in a
 * client: a camera cue can never loop (a persistent timeline must not hold a view
 * forever), and it can never replay.
 */
interface FxCameraBase extends FxBase {
  kind: "camera";
  /**
   * Who this camera cue moves. Absent means `scene` — every recipient of the run —
   * and a viewer who is not in the target set receives the run *without this section*,
   * so the payload itself carries no trace of where the GM's view went.
   */
  audience?: FxSectionAudience;
}
/** Centre the viewport on `to` over `durationMs`; `zoom` optionally ends at a new scale. */
export interface FxCameraPanSection extends FxCameraBase {
  mode: "pan";
  to: FxAnchor;
  easing?: FxEasing;
  /** Absolute world zoom at the END of the pan (0.1–10); absent keeps the current scale. */
  zoom?: number;
}
/** Bounded, decaying shake around wherever the camera already is. */
export interface FxCameraShakeSection extends FxCameraBase {
  mode: "shake";
  /** Amplitude 0.05–1 of a bounded screen offset; decays to zero by the last frame. */
  intensity: number;
}
/**
 * A path is a pan that keeps going: 2–8 host-resolved waypoints, walked in order
 * from wherever the viewer currently is, each leg eased by the same curve. The view
 * stays on the **last** waypoint, exactly like a single pan stays on its
 * destination (a tour that snapped back would undo its own last move).
 */
export interface FxCameraPathSection extends FxCameraBase {
  mode: "path";
  /** Waypoints in order; every one is resolved and bounds-checked by the host. */
  points: FxAnchor[];
  easing?: FxEasing;
  /** Absolute world zoom at the END of the whole path (0.1–10); absent keeps the scale. */
  zoom?: number;
}
export type FxCameraSection = FxCameraPanSection | FxCameraShakeSection | FxCameraPathSection;

export type FxSection =
  | (FxLocated & { kind: "image"; assetId: string; stretch?: boolean; tint?: string }) // image/* and alpha video
  | (FxLocated & { kind: "text"; text: string; color?: string })
  | (FxBase & { kind: "sound"; assetId: string; volume?: number;
      /** Which fader this sound belongs to (viewer-local mix, D-297). */
      channel?: FxSoundChannel;
      /** Ramp 0→1 over this many ms at the start of the section. */
      fadeInMs?: number;
      /** Ramp 1→0 over the last `fadeOutMs` of the section (ignored by a persistent loop). */
      fadeOutMs?: number;
      /**
       * Where the sound is. Absent means **everywhere** — the authored volume for every
       * recipient, exactly as before D-309 — so adding a position is what makes a cue
       * positional rather than what makes it quiet. The host resolves the anchor at
       * emit (a `source`/`target` token's *current* centre, never a two-way follow).
       */
      at?: FxAnchor;
      /** Scene units at which a positional sound is no longer audible (1–1000). */
      radius?: number;
      /** Stereo-place it from the listener's own view; needs `at`. */
      pan?: boolean;
      /** A sound-blocking wall between the source and a listener dulls it there; needs `at`. */
      muffle?: boolean })
  | FxCameraSection
  | (FxBase & { kind: "wait" });

export interface FxSequence {
  version: 1;
  /** Overlap on the timeline = parallel; different startMs values = ordered. */
  sections: FxSection[];
  audience?: FxSectionAudience;
  /** Host-owned named instance: each visual/audio section loops until explicitly stopped. */
  persistent?: boolean;
}

export type ResolvedFxSection =
  | (Omit<Extract<FxSection, { kind: "image" }>, "at" | "to" | "mask" | "repeatCount" | "repeatDelayMs"> & { x: number; y: number; toX?: number; toY?: number; mime: string; followTokenId?: string; followToTokenId?: string; mask?: ResolvedFxMask })
  | (Omit<Extract<FxSection, { kind: "text" }>, "at" | "to" | "mask" | "repeatCount" | "repeatDelayMs"> & { x: number; y: number; toX?: number; toY?: number; followTokenId?: string; followToTokenId?: string; mask?: ResolvedFxMask })
  | (Omit<Extract<FxSection, { kind: "sound" }>, "repeatCount" | "repeatDelayMs" | "at" | "radius"> &
      { mime: string; x?: number; y?: number; radiusPx?: number;
        /** Host-computed per recipient (D-309): a sound-blocking wall stands between
         * that viewer's own listener and this source. */
        occluded?: boolean })
  /** A pan carries its **host-resolved** destination; a shake carries no anchor at all. */
  | (Omit<FxCameraPanSection, "to" | "repeatCount" | "repeatDelayMs"> & { toX: number; toY: number })
  /** A path carries its **host-resolved** waypoints, in order. */
  | (Omit<FxCameraPathSection, "points" | "repeatCount" | "repeatDelayMs"> & { points: Array<{ x: number; y: number }> })
  | Omit<FxCameraShakeSection, "repeatCount" | "repeatDelayMs">
  | Omit<Extract<FxSection, { kind: "wait" }>, "repeatCount" | "repeatDelayMs">;

const MAX_SECTIONS = 48;
/** A timeline that moved the view eight times would be a slideshow, not an effect. */
const MAX_CAMERA_SECTIONS = 8;
const MIN_CAMERA_MS = 100;
const MAX_PLAYBACKS = 64;
const MAX_TIMELINE_MS = 60_000;
const MAX_SECTION_MS = 30_000;
const HASH = /^[a-f0-9]{64}$/;
const HEX_COLOR = /^#[a-f0-9]{6}$/i;
const VISUAL_MIME = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif",
  "video/webm", "video/mp4",
]);
const AUDIO_MIME = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4", "audio/aac"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function validAnchor(at: unknown): at is FxAnchor {
  return isObject(at) && (
    (at.kind === "point" && Object.keys(at).every((k) => ["kind", "x", "y"].includes(k)) &&
      inRange(at.x, 0, 1_000_000) && inRange(at.y, 0, 1_000_000)) ||
    ((at.kind === "source" || at.kind === "target") && Object.keys(at).length === 1)
  );
}

export function validateFxSequence(value: unknown): { ok: true; sequence: FxSequence } | { ok: false; error: string } {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.sections) ||
    value.sections.length < 1 || value.sections.length > MAX_SECTIONS ||
    (value.audience !== undefined && !["scene", "gm", "caller"].includes(String(value.audience))) ||
    (value.persistent !== undefined && typeof value.persistent !== "boolean")) {
    return { ok: false, error: "FX sequence needs version 1, an audience, persistence flag and 1–48 sections" };
  }
  if (Object.keys(value).some((key) => !["version", "sections", "audience", "persistent"].includes(key))) {
    return { ok: false, error: "unknown FX sequence field" };
  }
  if (value.persistent && (value.sections.length > 16 || value.sections.every((step) => step.kind === "wait") ||
      value.sections.some((step) => step.kind !== "wait" && step.durationMs < 250))) {
    return { ok: false, error: "persistent FX needs a media section of at least 250 ms and at most 16 sections" };
  }
  const ids = new Set<string>();
  let playbackCount = 0;
  let cameraCount = 0;
  for (const section of value.sections as unknown[]) {
    if (!isObject(section) || typeof section.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(section.id) || ids.has(section.id) ||
      !inRange(section.startMs, 0, MAX_TIMELINE_MS) || !inRange(section.durationMs, 0, MAX_SECTION_MS) ||
      section.startMs + section.durationMs > MAX_TIMELINE_MS) {
      return { ok: false, error: "FX section IDs, start and duration must be unique and bounded" };
    }
    ids.add(section.id);
    // A camera cue is not media: it has no replays (a view claim that repeated
    // itself would be a stuck frame), so its repeat fields are unknown fields.
    const repeatFields = section.kind === "wait" || section.kind === "camera"
      ? [] : ["repeatCount", "repeatDelayMs"];
    const fields = section.kind === "sound"
      ? ["assetId", "volume", "channel", "fadeInMs", "fadeOutMs", "at", "radius", "pan", "muffle"] :
      section.kind === "image" ? ["assetId", "at", "to", "stretch", "tint", "easing", "repeats", "scale", "opacity", "rotation", "fadeInMs", "fadeOutMs", "layer", "follow", "blend", "filter", "filterTo", "filters", "mask", "scaleTo", "spinDeg"] :
      section.kind === "text" ? ["text", "color", "at", "to", "easing", "repeats", "scale", "opacity", "rotation", "fadeInMs", "fadeOutMs", "layer", "follow", "blend", "filter", "filterTo", "filters", "mask", "scaleTo", "spinDeg"] :
      section.kind === "camera" ? ["mode", "to", "easing", "zoom", "intensity", "points", "audience"] : [];
    if (Object.keys(section).some((key) => !["id", "kind", "startMs", "durationMs", ...fields, ...repeatFields].includes(key)) ||
      (section.kind !== "wait" && section.durationMs === 0)) {
      return { ok: false, error: "unknown FX section field or zero-duration media" };
    }
    if (section.kind === "camera") {
      if (value.persistent)
        return { ok: false, error: "a persistent timeline cannot move a viewer's camera" };
      if ((cameraCount += 1) > MAX_CAMERA_SECTIONS)
        return { ok: false, error: "at most 8 camera sections per timeline" };
      if (section.durationMs < MIN_CAMERA_MS)
        return { ok: false, error: "camera sections need at least 100 ms" };
      // Targeting is a camera cue's own business: a visual or sound section is still
      // delivered to every recipient, and its `audience` is an unknown field.
      if (section.audience !== undefined && !isFxSectionAudience(section.audience))
        return { ok: false, error: "a camera section's audience must be scene, gm or caller" };
      if (section.mode === "pan") {
        if (!validAnchor(section.to) || section.intensity !== undefined ||
            (section.easing !== undefined && !isEasing(section.easing)) ||
            (section.zoom !== undefined && !inRange(section.zoom, 0.1, 10)))
          return { ok: false, error: "a camera pan needs a destination anchor, optional easing and zoom 0.1–10" };
      } else if (section.mode === "shake") {
        if (section.to !== undefined || section.zoom !== undefined || section.easing !== undefined ||
            !inRange(section.intensity, 0.05, 1))
          return { ok: false, error: "a camera shake needs an intensity 0.05–1 and no destination" };
      } else if (section.mode === "path") {
        // A path is a bounded tour, not a slideshow: 2–8 waypoints, each one an anchor
        // the host will resolve and bounds-check exactly like a pan's destination.
        if (!Array.isArray(section.points) || section.points.length < 2 || section.points.length > 8 ||
            !section.points.every(validAnchor) || section.to !== undefined || section.intensity !== undefined ||
            (section.easing !== undefined && !isEasing(section.easing)) ||
            (section.zoom !== undefined && !inRange(section.zoom, 0.1, 10)))
          return { ok: false, error: "a camera path needs 2–8 waypoint anchors, optional easing and zoom 0.1–10" };
      } else return { ok: false, error: "camera sections are a pan, a shake or a path" };
      continue;
    }
    if (section.kind === "wait") continue;
    const repeatCount = section.repeatCount === undefined ? 1 : section.repeatCount;
    if (typeof repeatCount !== "number" || !Number.isSafeInteger(repeatCount) ||
        (section.repeatCount !== undefined && !inRange(repeatCount, 2, 8)) ||
        (section.repeatDelayMs !== undefined && (section.repeatCount === undefined ||
          !Number.isSafeInteger(section.repeatDelayMs) || !inRange(section.repeatDelayMs, 0, 30_000))) ||
        (value.persistent && section.repeatCount !== undefined) ||
        section.startMs + repeatCount * section.durationMs +
          (repeatCount - 1) * (typeof section.repeatDelayMs === "number" ? section.repeatDelayMs : 0) > MAX_TIMELINE_MS ||
        (playbackCount += repeatCount) > MAX_PLAYBACKS) {
      return { ok: false, error: "FX replays require 2–8 one-shot plays, bounded pause and at most 64 total cues within 60 s" };
    }
    if (section.kind === "sound") {
      if (typeof section.assetId !== "string" || !HASH.test(section.assetId) ||
        (section.volume !== undefined && !inRange(section.volume, 0, 1))) {
        return { ok: false, error: "FX sound needs an imported hash and volume 0–1" };
      }
      // A channel is a closed set, not a free-text field: an unknown one would be
      // silently treated as an effect everywhere and mix wrongly by accident.
      if (section.channel !== undefined && !isSoundChannel(section.channel))
        return { ok: false, error: "FX sound channel must be effects, music, ambience or voice" };
      // Fades are bounded by the section itself, like an image's: a ramp longer than
      // the cue is a fade that never finishes.
      if ((section.fadeInMs !== undefined && !inRange(section.fadeInMs, 0, section.durationMs)) ||
        (section.fadeOutMs !== undefined && !inRange(section.fadeOutMs, 0, section.durationMs)))
        return { ok: false, error: "FX sound fades must fit inside the section duration" };
      // A position is what makes a sound positional; the three fields that only mean
      // something *from* a position are refused without one rather than quietly ignored
      // (SQ-05's "do not offer a UI control that silently does nothing").
      if (section.at === undefined) {
        if (section.radius !== undefined || section.pan !== undefined || section.muffle !== undefined)
          return { ok: false, error: "a positional FX sound needs a position: radius, pan and muffle measure from one" };
      } else {
        if (!validAnchor(section.at))
          return { ok: false, error: "a positional FX sound needs a valid position" };
        if (!inRange(section.radius, SOUND_RADIUS_LIMITS.min, SOUND_RADIUS_LIMITS.max))
          return { ok: false, error: `a positional FX sound needs a radius of ${SOUND_RADIUS_LIMITS.min}–${SOUND_RADIUS_LIMITS.max} scene units` };
        if (section.pan !== undefined && typeof section.pan !== "boolean")
          return { ok: false, error: "a positional FX sound's pan is a yes/no choice" };
        if (section.muffle !== undefined && typeof section.muffle !== "boolean")
          return { ok: false, error: "a positional FX sound's muffle is a yes/no choice" };
      }
      continue;
    }
    if ((section.kind !== "image" && section.kind !== "text") || !validAnchor(section.at) ||
      (section.to !== undefined && !validAnchor(section.to)) ||
      (section.easing !== undefined && !isEasing(section.easing)) ||
      (section.repeats !== undefined && (!Number.isInteger(section.repeats) || !inRange(section.repeats, 1, 20) || !section.to)) ||
      (section.layer !== undefined && section.layer !== "belowTokens" && section.layer !== "aboveTokens") ||
      (section.follow !== undefined && (typeof section.follow !== "boolean" ||
        section.follow && section.at.kind === "point" && (!section.to || section.to.kind === "point"))) ||
      (section.scale !== undefined && !inRange(section.scale, FX_SCALE_LIMITS.min, FX_SCALE_LIMITS.max)) ||
      (section.scaleTo !== undefined && !inRange(section.scaleTo, FX_SCALE_LIMITS.min, FX_SCALE_LIMITS.max)) ||
      (section.spinDeg !== undefined && !inRange(section.spinDeg, -FX_SPIN_LIMIT, FX_SPIN_LIMIT)) ||
      (section.opacity !== undefined && !inRange(section.opacity, 0, 1)) ||
      (section.rotation !== undefined && !inRange(section.rotation, -360, 360)) ||
      (section.fadeInMs !== undefined && !inRange(section.fadeInMs, 0, section.durationMs)) ||
      (section.fadeOutMs !== undefined && !inRange(section.fadeOutMs, 0, section.durationMs))) {
      return { ok: false, error: "FX image/text needs a valid anchor, layer, fade and transform" };
    }
    if (section.mask !== undefined) {
      const mask = section.mask;
      if (!isObject(mask) || typeof mask.kind !== "string")
        return { ok: false, error: "an FX mask needs a shape kind" };
      if (mask.kind === "point")
        return { ok: false, error: "an FX mask cannot be a point: it has no area to mask with" };
      if (!(mask.kind in MASK_FIELDS))
        return { ok: false, error: "an FX mask must be a circle, cone, ray, rect or polygon" };
      // Each shape accepts exactly its own fields: switching a rect to a circle must
      // not leave a stale width that the renderer would then silently ignore.
      if (Object.keys(mask).some((key) => !MASK_FIELDS[mask.kind as FxMask["kind"]].includes(key)))
        return { ok: false, error: `an FX ${mask.kind} mask takes only ${MASK_FIELDS[mask.kind as FxMask["kind"]].join(", ")}` };
      // D-315: the authored region, before anything measures it. Points are scene units from
      // the anchor, in order; the shape must have an area and must not cross itself. (Both
      // refusals name the fault rather than smoothing it into *some* region.)
      if (mask.kind === "polygon") {
        const points = mask.points;
        if (!Array.isArray(points) || points.length < FX_POLYGON_POINTS.min || points.length > FX_POLYGON_POINTS.max)
          return { ok: false, error: `an FX polygon mask takes ${FX_POLYGON_POINTS.min}–${FX_POLYGON_POINTS.max} points` };
        for (const [index, point] of points.entries()) {
          if (!isObject(point) || Object.keys(point).some((key) => key !== "x" && key !== "y") ||
              !inRange(point.x, -FX_MASK_LIMITS.max, FX_MASK_LIMITS.max) ||
              !inRange(point.y, -FX_MASK_LIMITS.max, FX_MASK_LIMITS.max))
            return { ok: false, error: `FX polygon point ${index + 1} needs an x and a y within ±${FX_MASK_LIMITS.max} scene units of the anchor` };
        }
        // Crossed first: a bow-tie's signed area is zero as a *consequence*, and "crosses
        // itself" is the fault the author can act on.
        if (fxPolygonSelfCrossing(points))
          return { ok: false, error: "an FX polygon mask must not cross itself: draw the region in order around it" };
        if (Math.abs(fxPolygonArea(points)) < 1e-6)
          return { ok: false, error: "an FX polygon mask needs an area: its points must not lie in a line" };
        if (mask.walls === true && !fxPolygonStarShaped(points))
          return { ok: false, error: "a wall-bounded FX polygon mask must be star-shaped about its anchor: its points must run in order around it" };
      }
      if (mask.kind !== "polygon" && !inRange(mask.length, FX_MASK_LIMITS.min, FX_MASK_LIMITS.max))
        return { ok: false, error: `an FX mask's length must be ${FX_MASK_LIMITS.min}–${FX_MASK_LIMITS.max} scene units` };
      if ((mask.kind === "ray" || mask.kind === "rect") &&
          !inRange(mask.width, FX_MASK_LIMITS.min, FX_MASK_LIMITS.max))
        return { ok: false, error: `an FX mask's width must be ${FX_MASK_LIMITS.min}–${FX_MASK_LIMITS.max} scene units` };
      if (mask.angle !== undefined && !inRange(mask.angle, -360, 360))
        return { ok: false, error: "an FX mask's angle must be between -360 and 360 degrees" };
      if (mask.spread !== undefined && !inRange(mask.spread, FX_MASK_LIMITS.spreadMin, FX_MASK_LIMITS.spreadMax))
        return { ok: false, error: `a cone mask's spread must be ${FX_MASK_LIMITS.spreadMin}–${FX_MASK_LIMITS.spreadMax} degrees` };
      if (mask.invert !== undefined && typeof mask.invert !== "boolean")
        return { ok: false, error: "an FX mask's invert flag must be true or false" };
      if (mask.lengthTo !== undefined && !inRange(mask.lengthTo, FX_MASK_LIMITS.min, FX_MASK_LIMITS.max))
        return { ok: false, error: `an FX mask's growth must be ${FX_MASK_LIMITS.min}–${FX_MASK_LIMITS.max} scene units` };
      if (mask.widthTo !== undefined && !inRange(mask.widthTo, FX_MASK_LIMITS.min, FX_MASK_LIMITS.max))
        return { ok: false, error: `an FX mask's width can widen to ${FX_MASK_LIMITS.min}–${FX_MASK_LIMITS.max} scene units` };
      if (mask.spreadTo !== undefined && !inRange(mask.spreadTo, FX_MASK_LIMITS.spreadMin, FX_MASK_LIMITS.spreadMax))
        return { ok: false, error: `a cone mask's spread can open to ${FX_MASK_LIMITS.spreadMin}–${FX_MASK_LIMITS.spreadMax} degrees` };
      if (mask.scaleTo !== undefined && !inRange(mask.scaleTo, FX_SCALE_LIMITS.min, FX_SCALE_LIMITS.max))
        return { ok: false, error: `an FX polygon mask's growth must be ${FX_SCALE_LIMITS.min}–${FX_SCALE_LIMITS.max}× its own size` };
      if (mask.spinDeg !== undefined && !inRange(mask.spinDeg, -FX_SPIN_LIMIT, FX_SPIN_LIMIT))
        return { ok: false, error: `an FX mask's turn must be within ±${FX_SPIN_LIMIT} degrees` };
      if (mask.walls !== undefined && typeof mask.walls !== "boolean")
        return { ok: false, error: "an FX mask's wall flag must be true or false" };
      // The trim is resolved against the host's walls and travels as a baked polygon, so a
      // turn or a growth would drag the shape straight through the wall it was cut by. A
      // recipient has no walls to re-trim against and must not be given them (they can be
      // secret), so this is a refusal rather than a per-frame recomputation.
      if (mask.walls === true && (mask.lengthTo !== undefined || mask.spinDeg !== undefined ||
          mask.widthTo !== undefined || mask.spreadTo !== undefined || mask.scaleTo !== undefined))
        return { ok: false, error: "an FX mask bounded by walls cannot animate: the trim is baked against the host's walls" };
    }
    // Appearance is validated before the asset, so a mistyped blend is reported as
    // itself rather than as a bad hash.
    if (section.blend !== undefined && !isBlendMode(section.blend))
      return { ok: false, error: "FX blend must be normal, add, multiply, screen, overlay, darken or lighten" };
    if (section.filter !== undefined) {
      const filter = section.filter;
      if (!isObject(filter) || Object.keys(filter).some((key) => !["kind", "strength"].includes(key)) ||
          typeof filter.kind !== "string" || !(filter.kind in FX_FILTER_RANGES))
        return { ok: false, error: "FX filter must be blur, grayscale, brightness or saturate" };
      const range = FX_FILTER_RANGES[filter.kind as FxFilterKind];
      if (filter.strength !== undefined && !inRange(filter.strength, range.min, range.max))
        return { ok: false, error: `FX ${filter.kind} strength must be ${range.min}–${range.max}` };
      // An animation's two ends live in the same range: a blur that faded to 0 would be
      // a blur that stopped existing, which is what dropping the filter says.
      if (section.filterTo !== undefined) {
        if (!inRange(section.filterTo, range.min, range.max))
          return { ok: false, error: `FX ${filter.kind} must animate between ${range.min} and ${range.max}` };
      }
    }
    // Reported as itself rather than as an unknown field: "you animated nothing" is the
    // useful sentence, and `filterTo` on its own is a mistake worth naming.
    if (section.filterTo !== undefined && section.filter === undefined)
      return { ok: false, error: "FX filterTo needs a filter kind to animate" };
    // D-313 — the chain. Two spellings of the same look would be an ambiguity the host has
    // to resolve, so a section carries one filter *or* a chain, never both.
    if (section.filters !== undefined) {
      if (section.filter !== undefined)
        return { ok: false, error: "an FX section carries either one filter or a chain, not both" };
      const chain = section.filters;
      if (!Array.isArray(chain) || chain.length < 2 || chain.length > FX_FILTER_CHAIN_MAX)
        return { ok: false, error: `an FX filter chain is 2–${FX_FILTER_CHAIN_MAX} filters: stack the look, or use the single filter field for one` };
      for (const [index, step] of chain.entries()) {
        if (!isObject(step) || Object.keys(step).some((key) => !["kind", "strength", "to"].includes(key)) ||
            typeof step.kind !== "string" || !(step.kind in FX_FILTER_RANGES))
          return { ok: false, error: `FX filter ${index + 1} must be blur, grayscale, brightness or saturate` };
        const range = FX_FILTER_RANGES[step.kind as FxFilterKind];
        if (step.strength !== undefined && !inRange(step.strength, range.min, range.max))
          return { ok: false, error: `FX filter ${index + 1} (${step.kind}) strength must be ${range.min}–${range.max}` };
        // Each entry's animation is bounded by its own kind's range, exactly as the single
        // filter's is — a chain does not relax the rule it is built from.
        if (step.to !== undefined && !inRange(step.to, range.min, range.max))
          return { ok: false, error: `FX filter ${index + 1} (${step.kind}) must animate between ${range.min} and ${range.max}` };
      }
    }
    if (section.kind === "image" &&
        (typeof section.assetId !== "string" || !HASH.test(section.assetId) ||
          (section.stretch !== undefined && (typeof section.stretch !== "boolean" || section.stretch && !section.to)) ||
          (section.stretch && section.repeats !== undefined) ||
          (section.tint !== undefined && (typeof section.tint !== "string" || !HEX_COLOR.test(section.tint))))) {
      return { ok: false, error: "FX image needs an imported hash, valid tint and destination for stretch" };
    }
    if (section.kind === "text" && (
      typeof section.text !== "string" || section.text.length < 1 || section.text.length > 256 ||
      (section.color !== undefined && (typeof section.color !== "string" || !HEX_COLOR.test(section.color)))
    )) return { ok: false, error: "FX text needs 1–256 characters and an optional hex color" };
  }
  return { ok: true, sequence: value as unknown as FxSequence };
}

export interface FxViewer {
  id: string;
  isGm: boolean;
}

/**
 * Which sections of a run one viewer may receive. A camera section carries its own
 * audience (SQ-15's "local or recipient-targeted"): `scene` is everyone who gets the
 * run, `gm` is GM/assistant only, `caller` is the session that asked for the run.
 * Everything else is `scene`-equivalent — targeting a visual or sound section would
 * need per-viewer media entitlement, which this helper deliberately does not pretend
 * to do.
 *
 * The filtered array *is the payload*: an excluded viewer never receives the section,
 * so no socket sniffing reveals where someone else's camera went. Returns the original
 * array (same identity) when nothing is excluded, so the host's common case allocates
 * nothing.
 */
export function fxSectionsForViewer(
  sections: readonly ResolvedFxSection[],
  viewer: FxViewer,
  callerId: string,
): readonly ResolvedFxSection[] {
  const allowed = (section: ResolvedFxSection): boolean => {
    if (section.kind !== "camera") return true;
    const audience = section.audience ?? "scene";
    if (audience === "gm") return viewer.isGm;
    if (audience === "caller") return viewer.id === callerId;
    return true;
  };
  return sections.every(allowed) ? sections : sections.filter(allowed);
}

/** Resolve all anchors ON THE HOST using its committed scene state. */
export function resolveFxSequence(
  sequence: FxSequence,
  scene: SceneDocument,
  source: TokenDocument | undefined,
  target: TokenDocument | undefined,
  mimeOf: (assetId: string) => string | undefined,
): { ok: true; sections: ResolvedFxSection[] } | { ok: false; error: string } {
  const validated = validateFxSequence(sequence);
  if (!validated.ok) return validated;
  const sections: ResolvedFxSection[] = [];
  for (const section of sequence.sections) {
    if (section.kind === "wait") { sections.push(section); continue; }
    if (section.kind === "camera" && section.mode === "shake") {
      const { repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
      void _count; void _gap;
      sections.push(projected);
      continue;
    }
    const anchor = (at: FxAnchor): { ok: true; x: number; y: number } | { ok: false; error: string } => {
      let x: number, y: number;
      if (at.kind === "point") ({ x, y } = at);
      else {
        const token = at.kind === "source" ? source : target;
        if (!token) return { ok: false, error: `FX ${at.kind} token is required` };
        // TokenDocument x/y are already the center (see tokenRect); do not
        // offset twice or a saved aura jumps half a token away on playback.
        x = token.x;
        y = token.y;
      }
      if (x < 0 || y < 0 || x > scene.width || y > scene.height)
        return { ok: false, error: "FX anchor lies outside the scene" };
      return { ok: true, x, y };
    };
    if (section.kind === "sound") {
      const mime = mimeOf(section.assetId);
      if (!mime || !AUDIO_MIME.has(mime)) return { ok: false, error: `missing/unsupported sound: ${section.assetId}` };
      const { repeatCount: _count, repeatDelayMs: _gap, at: _at, radius, ...projected } = section;
      void _count; void _gap; void _at;
      // The radius travels in **pixels**, like every other distance a client measures
      // against its own view: the host owns the scene's grid metric, and a client that
      // had to re-derive "60 ft" could disagree with the host that validated it.
      const radiusPx = radius === undefined ? undefined
        : radius * crosshairPxPerUnit(scene.grid);
      const placed = _at === undefined ? null : anchor(_at);
      if (placed && !placed.ok) return placed;
      if (radiusPx !== undefined && (!Number.isFinite(radiusPx) || radiusPx <= 0))
        return { ok: false, error: "a positional FX sound needs a usable scene grid metric" };
      sections.push({ ...projected, mime,
        ...(placed?.ok ? { x: placed.x, y: placed.y } : {}),
        ...(radiusPx !== undefined ? { radiusPx } : {}) });
      continue;
    }
    if (section.kind === "camera") {
      // The host, never the client, decides where a pan may land — same anchor
      // function, same scene bounds, same refusal as every other cue. A path repeats
      // that for every waypoint, and refuses a "path" that never goes anywhere.
      if (section.mode === "path") {
        const points: Array<{ x: number; y: number }> = [];
        for (const waypoint of section.points) {
          const resolvedPoint = anchor(waypoint);
          if (!resolvedPoint.ok) return resolvedPoint;
          points.push({ x: resolvedPoint.x, y: resolvedPoint.y });
        }
        if (points.every((point) => point.x === points[0]?.x && point.y === points[0]?.y))
          return { ok: false, error: "a camera path needs two different waypoints" };
        const { points: _points, repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
        void _points; void _count; void _gap;
        sections.push({ ...projected, points });
        continue;
      }
      const destination = anchor(section.to);
      if (!destination.ok) return destination;
      const { to: _to, repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
      void _to; void _count; void _gap;
      sections.push({ ...projected, toX: destination.x, toY: destination.y });
      continue;
    }
    /**
     * The mask polygon, in world px but **relative to the anchor** (the shape is
     * measured from the origin and then translated by the renderer, so a followed
     * visual's mask travels with it). Refuses a shape that resolves to no geometry:
     * a length that survived validation but produces an empty outline is a control
     * that would do nothing.
     */
    const maskArea = (mask: FxMask, at: CrosshairPoint): ResolvedFxMask | { error: string } => {
      // The four crosshair shapes only: a polygon is its own geometry and never reaches the
      // crosshair's area builder, so narrowing here keeps the kinds honestly separate.
      const shape: CrosshairShape | null = mask.kind === "polygon" || mask.length === undefined ? null
        : { kind: mask.kind, length: mask.length,
          ...(mask.width !== undefined ? { width: mask.width } : {}),
          ...(mask.spread !== undefined ? { spread: mask.spread } : {}) };
      // The scene's own metric decides what "15 ft" is in pixels. A gridless scene has
      // no metric at all and is read 1:1 (the crosshair's own fallback), but a *broken*
      // square/hex grid — distance 0, size NaN — is refused rather than quietly masked
      // at 1 px per unit: the author asked for a distance and would get a dot.
      const grid = scene.grid;
      if (grid.type !== "gridless" &&
          !(Number.isFinite(grid.size) && grid.size > 0 && Number.isFinite(grid.distance) && grid.distance > 0))
        return { error: "an FX mask needs a usable scene grid metric" };
      // D-315: an authored region is measured like any other — the scene's metric turns its
      // authored scene units into the same offsets the four shapes resolve to, so everything
      // downstream (the wall trim, the cutout, the renderer) is unchanged.
      const area = mask.kind === "polygon"
        ? (mask.points ?? []).map((point) => ({ x: point.x * crosshairPxPerUnit(grid),
          y: point.y * crosshairPxPerUnit(grid) }))
        : shape ? crosshairArea({ x: 0, y: 0 }, shape, grid, mask.angle ?? 0) : [];
      if (area.length < 3) return { error: "an FX mask must resolve to a region" };
      // A wall-bounded region is trimmed HERE, against the scene's own sight segments (the
      // same list the fog uses, so a door that is open for sight is open for the trim), and
      // travels as the finished polygon: the client is never handed walls. The segments are
      // shifted into the region's own space, because the polygon travels with its anchor.
      let shaped = area;
      if (mask.walls === true) {
        const reach = Math.max(...area.map((point) => Math.hypot(point.x, point.y)));
        const nearby = sightSegments(scene.walls ?? []).map((segment) => ({
          x1: segment.x1 - at.x, y1: segment.y1 - at.y,
          x2: segment.x2 - at.x, y2: segment.y2 - at.y,
        })).filter((segment) => distanceToSegment({ x: 0, y: 0 },
          { x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }) <= reach + 1);
        // An anchor standing on a wall is degenerate rather than merely tight: every ray
        // starts blocked, and a "region" of zero width is a control that does nothing.
        if (nearby.some((segment) => distanceToSegment({ x: 0, y: 0 },
          { x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }) <= 1))
          return { error: "an FX mask bounded by walls cannot start on a wall" };
        // Nothing in reach means nothing to cut: the authored region stands as it was.
        shaped = nearby.length === 0 ? shaped : fxSightTrim(shaped, nearby, reach);
        // A region with no area is no region: an anchor standing *on* a wall sees nothing
        // in every direction, and a mask that hides or shows nothing is a control that
        // does nothing (the same rule that refuses a point mask).
        const survived = shaped.length >= 3
          && Math.max(...shaped.map((point) => Math.hypot(point.x, point.y))) > 1e-6;
        if (!survived)
          return { error: "an FX mask bounded by walls resolves to no region at its anchor" };
      }
      // The growth travels as a *ratio*, not as the authored length in scene units: the
      // polygon is already host-resolved against the scene's metric, and a ratio is
      // unit-free, so a client still never needs to know what "15 ft" is in pixels.
      const animate = {
        // A polygon has no authored length to divide by: its growth is already a ratio.
        ...(mask.kind === "polygon" && mask.scaleTo !== undefined ? { scale: mask.scaleTo } : {}),
        ...(mask.kind === "polygon" || mask.length === undefined || mask.length <= 0 ? {}
          : mask.lengthTo !== undefined ? { scale: mask.lengthTo / mask.length } : {}),
        ...(mask.spinDeg !== undefined ? { spinDeg: mask.spinDeg } : {}),
        // D-314: the cross axis travels as a ratio plus the frame it lives in. Nothing here
        // tells the client what the mask *is* in scene units, and only one bit of shape
        // leaks — a cone's cross axis is an angle — because the drawing differs: a fan
        // opens, a width stretches.
        ...(mask.spreadTo !== undefined
          ? { cross: { ratio: mask.spreadTo / (mask.spread ?? CROSSHAIR_DEFAULT_SPREAD),
            axisDeg: mask.angle ?? 0, fan: true } }
          : mask.widthTo !== undefined && mask.width !== undefined
            ? { cross: { ratio: mask.widthTo / mask.width, axisDeg: mask.angle ?? 0 } }
            : {}),
      };
      const animated = Object.keys(animate).length > 0;
      return { area: shaped, invert: mask.invert === true, ...(animated ? { animate } : {}) };
    };
    /** The resolved-mask part of a section payload, or a refusal. */
    const maskCoords = (at: CrosshairPoint): { ok: true; mask?: ResolvedFxMask } | { ok: false; error: string } => {
      if (!section.mask) return { ok: true };
      const resolved = maskArea(section.mask, at);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      return { ok: true, mask: resolved };
    };

    const start = anchor(section.at);
    if (!start.ok) return start;
    const destination = section.to ? anchor(section.to) : null;
    if (destination && !destination.ok) return destination;
    // Only explicitly followed, already-authorized token IDs travel to
    // recipients. Other anchors remain frozen at host-approved coordinates.
    // The host rechecks both tokens' visibility on EVERY commit/replay.
    const followed = (at: FxAnchor): string | undefined =>
      at.kind === "source" ? source?._id : at.kind === "target" ? target?._id : undefined;
    const fromId = section.follow ? followed(section.at) : undefined;
    const toId = section.follow && section.to ? followed(section.to) : undefined;
    const coords = { x: start.x, y: start.y,
      ...(destination?.ok ? { toX: destination.x, toY: destination.y } : {}),
      ...(fromId ? { followTokenId: fromId } : {}),
      ...(toId ? { followToTokenId: toId } : {}) };
    const mask = maskCoords({ x: start.x, y: start.y });
    if (!mask.ok) return mask;
    if (section.kind === "text") {
      // The authored `mask` is dropped here and replaced by the resolved one: what
      // travels is a polygon, never the author's scene-unit numbers.
      const { at: _anchor, to: _to, mask: _mask, repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
      void _anchor; void _to; void _mask; void _count; void _gap;
      sections.push({ ...projected, ...coords, ...(mask.mask ? { mask: mask.mask } : {}) });
      continue;
    }
    const mime = mimeOf(section.assetId);
    if (!mime || !VISUAL_MIME.has(mime))
      return { ok: false, error: `missing/unsupported visual: ${section.assetId}` };
    const { at: _anchor, to: _to, mask: _mask, repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
    void _anchor; void _to; void _mask; void _count; void _gap;
    sections.push({ ...projected, ...coords, ...(mask.mask ? { mask: mask.mask } : {}), mime });
  }
  // All authored anchors and media are preflighted before any playback cue is
  // exposed. IDs with '@' cannot collide with an authored section ID (the
  // validator permits only alphanumerics, hyphens and underscores).
  const expanded: ResolvedFxSection[] = [];
  for (const [index, prepared] of sections.entries()) {
    const original = sequence.sections[index];
    if (!original) return { ok: false, error: "FX section lost during preflight" };
    const count = original.repeatCount ?? 1;
    for (let play = 0; play < count; play++) {
      expanded.push(play === 0 ? prepared : { ...prepared, id: `${prepared.id}@${play + 1}`,
        startMs: prepared.startMs + play * (prepared.durationMs + (original.repeatDelayMs ?? 0)) });
    }
  }
  return { ok: true, sections: expanded };
}
