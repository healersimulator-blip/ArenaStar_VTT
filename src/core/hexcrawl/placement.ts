/**
 * D-274 (plan §5.5) — **where the rolled creatures stand**.
 *
 * Requirement 5c's own words are the spec: the tokens are *"not in one spot, but near each other"*.
 * So placement is a small piece of geometry — a spiral outwards from the GM's drop point (or the
 * encounter's own hex), one position per creature, never closer than one grid cell, and never on a
 * wall — and it is pure, because a `.svelte` file cannot be unit-tested in this repo and the
 * arithmetic here is exactly the kind that goes wrong quietly.
 *
 * Two rules that matter more than they look:
 *
 * 1. **Exactly `count` positions, always.** A dungeon corridor can reject a lot of candidates
 *    (a wall runs through the ring), so the spiral keeps looking outwards and only falls back to
 *    the least-obstructed candidate it saw — a placement that refuses to place would be a GM
 *    clicking *Place all* and watching nothing happen.
 * 2. **Wall-aware, via the vision code's own primitive.** `distanceToSegment` is what `wallPickAt`
 *    uses to decide whether the GM hit a wall; using the same function means "a token lands on a
 *    wall" means the same thing here as it does in the picker.
 */
import type { SceneDocument, TokenDocument, WallDocument } from "../documents";
import { distanceToSegment } from "../../canvas/vision/wallKinds";

export interface PlacementPoint {
  x: number;
  y: number;
  /** True when the position had to accept a wall it could not avoid (see rule 1 above). */
  blocked: boolean;
}

/** How wide one creature's space is: a grid cell, or 100 px on a gridless map (the token default). */
export function placementSpacing(scene: SceneDocument | null | undefined): number {
  const size = scene?.grid?.size;
  return typeof size === "number" && Number.isFinite(size) && size > 0
    ? size
    : 100;
}

/** The wall clearance a position must keep: half a space, i.e. the token's own body. */
function clearance(spacing: number): number {
  return spacing / 2;
}

function insideScene(scene: SceneDocument, point: { x: number; y: number }, spacing: number): boolean {
  const half = spacing / 2;
  return (
    point.x >= half &&
    point.y >= half &&
    point.x <= scene.width - half &&
    point.y <= scene.height - half
  );
}

/** The distance from a point to the nearest wall segment (a `-1` wall is not a wall). */
export function wallDistance(
  walls: readonly WallDocument[] | undefined,
  point: { x: number; y: number },
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const wall of walls ?? []) {
    const [x1, y1, x2, y2] = wall.c;
    const d = distanceToSegment(point, { x: x1, y: y1 }, { x: x2, y: y2 });
    if (d < best) best = d;
  }
  return best;
}

/**
 * The candidate positions for one placement: the origin, then rings of six, then twelve, … Each
 * ring's radius is a whole multiple of the spacing, so neighbours on a ring and neighbours between
 * rings are both at least one space apart.
 */
function* spiral(
  origin: { x: number; y: number },
  spacing: number,
  maxRings: number,
): Generator<{ x: number; y: number }> {
  yield { x: origin.x, y: origin.y };
  for (let ring = 1; ring <= maxRings; ring += 1) {
    const radius = spacing * ring;
    const seats = 6 * ring;
    for (let i = 0; i < seats; i += 1) {
      const angle = (i / seats) * Math.PI * 2;
      yield {
        x: Math.round(origin.x + Math.cos(angle) * radius),
        y: Math.round(origin.y + Math.sin(angle) * radius),
      };
    }
  }
}

export interface PlaceInput {
  scene: SceneDocument;
  origin: { x: number; y: number };
  count: number;
  /** Defaults to one grid cell (`placementSpacing`). */
  spacing?: number;
  /** How far the spiral may look before it starts accepting obstructed ground. Default 6. */
  maxRings?: number;
}

/**
 * `count` positions around `origin`, in the order they should be filled. The first is the origin
 * itself (the GM dropped *there*), the rest spiral outwards; a candidate is taken when it is on the
 * map and clear of every wall, and the search only falls back to a blocked-but-on-the-map candidate
 * when the rings run out.
 */
export function placeEncounterTokens(input: PlaceInput): PlacementPoint[] {
  const spacing = input.spacing ?? placementSpacing(input.scene);
  const count = Math.max(0, Math.trunc(input.count));
  const out: PlacementPoint[] = [];
  if (count === 0) return out;
  const clear = clearance(spacing);
  let fallback: PlacementPoint | null = null;
  for (const point of spiral(input.origin, spacing, input.maxRings ?? 6)) {
    if (!insideScene(input.scene, point, spacing)) continue;
    const open = wallDistance(input.scene.walls, point) >= clear;
    if (open) {
      out.push({ ...point, blocked: false });
    } else if (fallback === null) {
      fallback = { ...point, blocked: true };
    }
    if (out.length === count) return out;
  }
  // The rings ran out (a tiny map, or a room walled off from the drop point): rather than place
  // nothing, keep the ring's positions so the GM gets the tokens to drag.
  for (const point of spiral(input.origin, spacing, (input.maxRings ?? 6) + 4)) {
    if (out.length === count) break;
    if (insideScene(input.scene, point, spacing)) out.push({ ...point, blocked: true });
  }
  while (out.length < count && fallback) out.push({ ...fallback });
  return out.slice(0, count);
}

/** One creature to place: what the results window's roll resolved to. */
export interface PlacementEntry {
  /** The actor the token links to; null for a bare text row (an unnamed noise in the trees). */
  actorId: string | null;
  name: string;
  img: string;
  /** The token prototype's own size, when the source actor has one (§ the bestiary's footprint). */
  width?: number;
  height?: number;
}

/**
 * The token documents one placement makes, with fresh ids. Kept here (rather than in `App.svelte`)
 * because the battle-scene copy needs the *same* tokens to be created inside a scene it is already
 * writing, and two builders would drift.
 */
export function encounterTokenData(
  entries: readonly PlacementEntry[],
  points: readonly PlacementPoint[],
  nextId: () => string,
): TokenDocument[] {
  const out: TokenDocument[] = [];
  entries.forEach((entry, i) => {
    const point = points[i];
    if (!point) return;
    // The literal lives here for the same reason `newPartyTokenDoc` does (scene.ts): app → core is
    // the dependency direction, so core cannot call the app's `makeToken`.
    out.push({
      _id: nextId(),
      type: "token",
      name: entry.name,
      // D-061's tabletop default: the table may see and move it — an encounter's tokens are the
      // players' to fight, not the GM's to keep hidden.
      ownership: { default: 3 },
      flags: {},
      system: {},
      x: point.x,
      y: point.y,
      rotation: 0,
      width: entry.width && entry.width > 0 ? entry.width : 100,
      height: entry.height && entry.height > 0 ? entry.height : 100,
      img: entry.img,
      hidden: false,
      // Requirement 5c's creatures arrive hostile; the GM flips one in the token menu if the roll
      // was a merchant caravan rather than a warband.
      disposition: "hostile",
      actorId: entry.actorId ?? undefined,
      vision: true,
      light: { radius: 0, color: "#ffffff", alpha: 0.5 },
    } as TokenDocument);
  });
  return out;
}
