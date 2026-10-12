/**
 * G-31 (D-439): merge, move and rescale floors, each as one atomic, undoable plan.
 *
 * A plan carries every elevation and floor reference along with the floor it belongs to, so the
 * staged scene passes the same validation as any other level transaction (`levelTransactionError`
 * runs on the host and here, for the preview). Fog history is never touched: a merged-away floor's
 * explored map simply stops being reachable, and undo brings the floor back with it.
 */
import type { DocRef, Json, LevelDocument, LevelScope, SceneDocument } from "./documents";
import type { Op } from "./ops";
import { inElevationBand, type ElevationBand } from "./multilevelGeometry";
import type { StairArrival, StairBehavior, StairEdge } from "./levelPlay";
import { SCOPED_COLLECTIONS, type ScopedCollection } from "./levelMembership";
import { levelTransactionError } from "./levels";
import { regionTransactionError } from "./regionValidation";

export interface LevelPlan {
  ops: Op[];
  /** What the plan does, in reading order. */
  summary: string[];
  /** What it deliberately leaves alone. */
  notes: string[];
  /** Staged validation; a plan with an error must not be submitted. */
  error: string | null;
}

const LIMIT = 1_000_000;
/** Elevations are authored by hand; keep rescaled values free of binary noise (0.1 × 3). */
export function roundElevation(z: number): number {
  const r = Math.round(z * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}
const fmt = (z: number | null) => z === null ? "∞" : String(roundElevation(z));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How one old floor band moves. `into` clamps moved values into a destination (merge). */
interface BandMove { level: LevelDocument; offset: number; into?: { band: ElevationBand; floorZ: number } }

/** Piecewise elevation map: each old band moves by its own offset; values outside every band stay. */
class Restack {
  constructor(private readonly moves: readonly BandMove[]) {}
  private byPoint(z: number, levelId?: string): BandMove | undefined {
    return levelId !== undefined ? this.moves.find((m) => m.level._id === levelId) : this.moves.find((m) => inElevationBand(m.level, z));
  }
  point(z: number, levelId?: string): number {
    const move = this.byPoint(z, levelId);
    if (!move || !move.offset && !move.into) return z;
    const next = roundElevation(z + move.offset);
    return move.into && !inElevationBand(move.into.band, next) ? move.into.floorZ : next;
  }
  /**
   * A closed range belongs to the band that contains it (its top may touch the band's top).
   * `span` = it straddles bands and at least one of them moves, so it is left for the GM.
   */
  range(min: number, max: number, clamp = true): { min: number; max: number } | "span" | null {
    const holds = (m: BandMove) => (m.level.bottom === null || m.level.bottom <= min) && (m.level.top === null || max <= m.level.top);
    const owners = this.moves.filter(holds);
    const owner = owners.find((m) => inElevationBand(m.level, min)) ?? owners[0];
    if (!owner) {
      const touches = this.moves.some((m) => (m.offset || m.into) && (m.level.top === null || min < m.level.top) && (m.level.bottom === null || max >= m.level.bottom));
      return touches ? "span" : null;
    }
    if (!owner.offset && !owner.into) return null;
    let lo = roundElevation(min + owner.offset), hi = roundElevation(max + owner.offset);
    const into = clamp ? owner.into : undefined;
    if (into) {
      if (into.band.bottom !== null) lo = Math.max(lo, into.band.bottom);
      if (into.band.top !== null) hi = Math.min(hi, into.band.top);
      if (lo > hi) lo = hi = into.floorZ;
    }
    return lo === min && hi === max ? null : { min: lo, max: hi };
  }
}

/** Per-document diffs, merged so each document gets exactly one update op. */
class DiffBook {
  private readonly diffs = new Map<string, { ref: DocRef; diff: Record<string, Json> }>();
  set(coll: string, id: string, parent: DocRef | undefined, key: string, value: Json): void {
    const k = `${coll}\u0000${id}`;
    const row = this.diffs.get(k) ?? { ref: { coll, id, ...(parent ? { parent } : {}) } as DocRef, diff: {} };
    row.diff[key] = value;
    this.diffs.set(k, row);
  }
  has(coll: string, id: string): boolean { return this.diffs.has(`${coll}\u0000${id}`); }
  ops(): Op[] { return [...this.diffs.values()].map(({ ref, diff }) => ({ kind: "update", ref, diff })); }
}

interface ElevationCounts { tokens: number; ranges: number; spans: number }
/** Carry token feet, region/tile trigger ranges, Faux Overhead covers and the foreground with their floors. */
function carryElevations(scene: SceneDocument, map: Restack, book: DiffBook, tokenLevel: (levelId: string | undefined) => string | undefined): ElevationCounts {
  const parent: DocRef = { coll: "scenes", id: scene._id };
  const counts: ElevationCounts = { tokens: 0, ranges: 0, spans: 0 };
  for (const t of scene.tokens) {
    const z = t.elevation ?? 0;
    const next = map.point(z, t.levelId);
    const level = tokenLevel(t.levelId);
    if (level !== t.levelId && level !== undefined) book.set("tokens", t._id, parent, "levelId", level);
    if (next !== z) book.set("tokens", t._id, parent, "elevation", next);
    if (next !== z || level !== t.levelId) counts.tokens++;
  }
  const range = (coll: "regions" | "tiles", id: string, value: { min: number; max: number } | undefined) => {
    if (!value) return;
    const next = map.range(value.min, value.max);
    if (next === "span") counts.spans++;
    else if (next) { book.set(coll, id, parent, "triggerElevation", next); counts.ranges++; }
  };
  for (const r of scene.regions ?? []) {
    range("regions", r._id, r.triggerElevation);
    const cover = r.fauxOverhead;
    if (!cover) continue;
    const { bottom, top } = cover.affectedElevation;
    if (bottom === null || top === null) continue; // a cover for every height belongs to no floor
    // Covers move by their floor's offset without clamping: the band is about who walks under them.
    const next = map.range(bottom, top, false);
    if (next === "span") { counts.spans++; continue; }
    if (!next) continue;
    const shift = next.min - bottom;
    book.set("regions", r._id, parent, "fauxOverhead.affectedElevation", { bottom: next.min, top: next.max });
    book.set("regions", r._id, parent, "fauxOverhead.coverZ", Math.max(-LIMIT, Math.min(LIMIT, roundElevation(cover.coverZ + shift))));
    counts.ranges++;
  }
  for (const tile of scene.tiles) range("tiles", tile._id, tile.triggerElevation);
  const fg = scene.foreground;
  if (fg && Number.isFinite(fg.elevation)) {
    const next = map.point(fg.elevation);
    if (next !== fg.elevation) { book.set("scenes", scene._id, undefined, "foreground.elevation", next); counts.ranges++; }
  }
  return counts;
}

/** `validate: false` skips the staged check (cheap live previews); submitting must validate. */
export interface PlanOptions { validate?: boolean }
function staged(scene: SceneDocument, ops: readonly Op[], options: PlanOptions): string | null {
  if (options.validate === false) return null;
  const resolve = (ref: DocRef) => ref.coll === "scenes" && ref.id === scene._id && !ref.parent ? scene : undefined;
  return levelTransactionError(ops, resolve) ?? regionTransactionError(ops, resolve);
}
function levelRef(scene: SceneDocument, id: string): DocRef { return { coll: "levels", id, parent: { coll: "scenes", id: scene._id } }; }
const unique = <T>(rows: readonly T[]) => [...new Set(rows)];
const bandText = (l: Pick<LevelDocument, "bottom" | "top">) => `${fmt(l.bottom)}–${fmt(l.top)}`;

/** Floors are stacked by band; the lowest unbounded bottom sorts first. */
export function stackOrder(levels: readonly LevelDocument[]): LevelDocument[] {
  return [...levels].sort((a, b) => (a.bottom ?? -Infinity) - (b.bottom ?? -Infinity) || a.floorZ - b.floorZ || a._id.localeCompare(b._id));
}
function adjacent(a: LevelDocument, b: LevelDocument): boolean {
  return (a.top !== null && a.top === b.bottom) || (b.top !== null && b.top === a.bottom);
}

/** Merge a stairwell's floors: `from` becomes `into`; returns null when it no longer connects two floors. */
export function mergeStairLevels(s: StairBehavior, from: string, into: string): StairBehavior | null {
  const map = (id: string) => id === from ? into : id;
  if (!("version" in s)) { const next = { from: map(s.from), to: map(s.to) }; return next.from === next.to ? null : next; }
  const levels = unique(s.levels.map(map));
  if (levels.length < 2) return null;
  let edges: StairEdge[] | undefined;
  if (s.edges) {
    const seen = new Set<string>();
    edges = [];
    for (const e of s.edges) {
      const next = { from: map(e.from), to: map(e.to) }, key = `${next.from}\u0000${next.to}`;
      if (next.from !== next.to && !seen.has(key)) { seen.add(key); edges.push(next); }
    }
    if (!edges.length) return null;
  }
  let arrivals: StairArrival[] | undefined;
  if (s.arrivals) {
    // The destination's own landing wins over the merged-away floor's.
    const own = s.arrivals.filter((a) => a.levelId !== from), moved = s.arrivals.filter((a) => a.levelId === from);
    arrivals = [...own, ...moved.filter(() => !own.some((a) => a.levelId === into)).map((a) => ({ ...a, levelId: into }))];
  }
  const { edges: _e, arrivals: _a, ...rest } = s; void _e; void _a;
  return { ...rest, levels, ...(edges ? { edges } : {}), ...(arrivals ? { arrivals } : {}) };
}

/**
 * "Merge into level" (Levels 7): everything on `fromId` moves to `intoId` and `fromId` is deleted.
 * Token feet keep their height above the floor (clamped into the destination band). Scopes,
 * stairs and visibility lists are remapped and deduplicated; a stairwell left with one floor stops
 * being stairs. When the two bands touch, the destination grows over the removed band so the stack
 * stays contiguous.
 */
export function mergeLevelPlan(scene: SceneDocument, fromId: string, intoId: string, options: PlanOptions = {}): LevelPlan {
  const levels = scene.levels ?? [];
  const from = levels.find((l) => l._id === fromId), into = levels.find((l) => l._id === intoId);
  if (!from || !into || fromId === intoId) return { ops: [], summary: [], notes: [], error: "Choose two different floors" };
  const parent: DocRef = { coll: "scenes", id: scene._id };
  const book = new DiffBook(), summary: string[] = [], notes: string[] = [];
  const absorb = adjacent(from, into);
  const band: ElevationBand = absorb
    ? { bottom: from.bottom === null || into.bottom === null ? null : Math.min(from.bottom, into.bottom), top: from.top === null || into.top === null ? null : Math.max(from.top, into.top) }
    : { bottom: into.bottom, top: into.top };
  const map = new Restack(levels.map((l) => l._id === fromId ? { level: l, offset: into.floorZ - from.floorZ, into: { band, floorZ: into.floorZ } } : { level: l, offset: 0 }));
  const carried = carryElevations(scene, map, book, (levelId) => levelId === fromId ? intoId : levelId);
  const moved = scene.tokens.filter((t) => t.levelId === fromId).length;
  if (moved) summary.push(`Moves ${plural(moved, "token")} from ${from.name} to ${into.name}, keeping their height above the floor.`);
  // Floor scopes.
  const scoped: string[] = [];
  for (const coll of SCOPED_COLLECTIONS) {
    let n = 0;
    for (const row of (scene[coll] ?? []) as ReadonlyArray<{ _id: string; levelScope?: LevelScope }>) {
      const scope = row.levelScope;
      if (scope?.mode !== "levels" || !scope.ids.includes(fromId)) continue;
      book.set(coll, row._id, parent, "levelScope", { mode: "levels", ids: unique(scope.ids.map((id) => id === fromId ? intoId : id)) });
      n++;
    }
    if (n) scoped.push(plural(n, SINGULAR[coll], coll));
  }
  if (scoped.length) summary.push(`${scoped.join(", ")} now belong to ${into.name}.`);
  // Stairs.
  let updated = 0, dropped = 0;
  for (const region of scene.regions ?? []) {
    if (!region.stairs) continue;
    const next = mergeStairLevels(region.stairs, fromId, intoId);
    if (next === null) { book.set("regions", region._id, parent, "-=stairs", null); dropped++; }
    else if (JSON.stringify(next) !== JSON.stringify(region.stairs)) { book.set("regions", region._id, parent, "stairs", next as unknown as Json); updated++; }
  }
  if (updated) summary.push(`${plural(updated, "stairwell")} now ${updated === 1 ? "serves" : "serve"} ${into.name} instead of ${from.name}.`);
  if (dropped) summary.push(`${plural(dropped, "stairwell")} would only connect ${into.name} to itself and ${dropped === 1 ? "stops" : "stop"} being stairs (the region stays).`);
  // Levels: destination art, background, band and visibility; other floors' visibility lists.
  const intoDiff: Record<string, Json> = {};
  const art = unique([...(into.tileIds ?? []), ...(from.tileIds ?? [])]);
  const newArt = art.length - (into.tileIds ?? []).length;
  if (newArt) { intoDiff.tileIds = art; summary.push(`${plural(newArt, "map tile")} ${newArt === 1 ? "joins" : "join"} ${into.name}'s floor art.`); }
  if (from.useSceneBackground === true && into.useSceneBackground !== true) { intoDiff.useSceneBackground = true; summary.push(`${into.name} now shows the scene background.`); }
  if (band.bottom !== into.bottom) intoDiff.bottom = band.bottom;
  if (band.top !== into.top) intoDiff.top = band.top;
  if (absorb) summary.push(`${into.name}'s band grows to ${bandText(band)}, covering ${from.name}'s.`);
  else notes.push(`${from.name}'s band (${bandText(from)}) is left empty; the floors do not touch.`);
  const visible = unique([...into.visibleLevelIds, ...from.visibleLevelIds].map((id) => id === fromId ? intoId : id)).filter((id) => id !== intoId);
  if (JSON.stringify(visible) !== JSON.stringify(into.visibleLevelIds)) intoDiff.visibleLevelIds = visible;
  const ops: Op[] = [...book.ops()];
  if (Object.keys(intoDiff).length) ops.push({ kind: "update", ref: levelRef(scene, intoId), diff: intoDiff });
  for (const other of levels) {
    if (other._id === fromId || other._id === intoId || !other.visibleLevelIds.includes(fromId)) continue;
    ops.push({ kind: "update", ref: levelRef(scene, other._id), diff: { visibleLevelIds: unique(other.visibleLevelIds.map((id) => id === fromId ? intoId : id)).filter((id) => id !== other._id) } });
  }
  ops.push({ kind: "delete", ref: levelRef(scene, fromId) });
  if (carried.ranges) summary.push(`${plural(carried.ranges, "elevation range")} on regions, tiles or the foreground ${carried.ranges === 1 ? "follows" : "follow"} the floor.`);
  if (carried.spans) notes.push(`${plural(carried.spans, "elevation range")} ${carried.spans === 1 ? "spans" : "span"} several floors and ${carried.spans === 1 ? "is" : "are"} left unchanged.`);
  if (from.darkness !== undefined && from.darkness !== into.darkness) notes.push(`${from.name}'s ambient darkness override is dropped; ${into.name} keeps its own.`);
  summary.push(`Deletes ${from.name}. Undo brings it back, explored fog included.`);
  return { ops, summary, notes, error: staged(scene, ops, options) };
}
const SINGULAR: Record<ScopedCollection, string> = { walls: "wall", lights: "light", regions: "region", drawings: "drawing", templates: "template", notes: "note" };

/**
 * Reorder (G-31): swap a floor with its neighbour in the stack. Each keeps its height (and any
 * gap between them stays where it was); everything on either floor moves with it; display
 * orders swap so the list follows. Unbounded floors stay at the ends of the stack.
 */
export function moveLevelPlan(scene: SceneDocument, levelId: string, direction: "up" | "down", options: PlanOptions = {}): LevelPlan {
  const stack = stackOrder(scene.levels ?? []);
  const index = stack.findIndex((l) => l._id === levelId);
  const fail = (error: string): LevelPlan => ({ ops: [], summary: [], notes: [], error });
  if (index < 0) return fail("Choose a floor");
  const other = stack[direction === "up" ? index + 1 : index - 1];
  const level = stack[index] as LevelDocument;
  if (!other) return fail(direction === "up" ? `${level.name} is already the top floor` : `${level.name} is already the bottom floor`);
  const [lower, upper] = direction === "up" ? [level, other] : [other, level];
  if (lower.bottom === null || lower.top === null || upper.bottom === null || upper.top === null)
    return fail("Floors with an open (unbounded) band stay at the ends of the stack");
  const hLower = lower.top - lower.bottom, hUpper = upper.top - upper.bottom, gap = upper.bottom - lower.top;
  const upperBottom = lower.bottom, lowerBottom = roundElevation(lower.bottom + hUpper + gap);
  const offUpper = roundElevation(upperBottom - upper.bottom), offLower = roundElevation(lowerBottom - lower.bottom);
  const map = new Restack(stack.map((l) => ({ level: l, offset: l._id === upper._id ? offUpper : l._id === lower._id ? offLower : 0 })));
  const book = new DiffBook();
  const carried = carryElevations(scene, map, book, (id) => id);
  const ops: Op[] = [
    { kind: "update", ref: levelRef(scene, upper._id), diff: { bottom: upperBottom, top: roundElevation(upperBottom + hUpper), floorZ: roundElevation(upper.floorZ + offUpper), sort: lower.sort } },
    { kind: "update", ref: levelRef(scene, lower._id), diff: { bottom: lowerBottom, top: roundElevation(lowerBottom + hLower), floorZ: roundElevation(lower.floorZ + offLower), sort: upper.sort } },
    ...book.ops(),
  ];
  const summary = [`${upper.name} moves below ${lower.name}: ${upper.name} ${bandText({ bottom: upperBottom, top: upperBottom + hUpper })}, ${lower.name} ${bandText({ bottom: lowerBottom, top: lowerBottom + hLower })}.`];
  if (carried.tokens) summary.push(`${plural(carried.tokens, "token")} ${carried.tokens === 1 ? "moves" : "move"} with ${carried.tokens === 1 ? "its" : "their"} floor.`);
  if (carried.ranges) summary.push(`${plural(carried.ranges, "elevation range")} on regions, tiles or the foreground ${carried.ranges === 1 ? "moves" : "move"} with ${carried.ranges === 1 ? "its" : "their"} floor.`);
  const notes: string[] = [];
  if (carried.spans) notes.push(`${plural(carried.spans, "elevation range")} ${carried.spans === 1 ? "spans" : "span"} several floors and ${carried.spans === 1 ? "is" : "are"} left unchanged.`);
  notes.push("Stairs, scopes, map tiles and fog stay with each floor; stair directions follow the new order.");
  return { ops, summary, notes, error: staged(scene, ops, options) };
}

/**
 * Rescale (Levels API `rescaleGridDistance`): multiply every elevation in the scene by `factor`,
 * e.g. 0.3 when a 5 ft grid becomes 1.5 m. Optionally sets the grid distance to match.
 */
export function rescaleLevelsPlan(scene: SceneDocument, factor: number, options: PlanOptions & { gridDistance?: boolean } = {}): LevelPlan {
  const fail = (error: string): LevelPlan => ({ ops: [], summary: [], notes: [], error });
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1000) return fail("Scale by a positive factor up to 1000");
  if (factor === 1 && !options.gridDistance) return fail("A factor of 1 changes nothing");
  const scale = (z: number) => roundElevation(z * factor);
  const book = new DiffBook(), parent: DocRef = { coll: "scenes", id: scene._id };
  const levels = scene.levels ?? [];
  const ops: Op[] = [];
  for (const l of levels) {
    const diff: Record<string, Json> = {};
    if (l.bottom !== null && scale(l.bottom) !== l.bottom) diff.bottom = scale(l.bottom);
    if (l.top !== null && scale(l.top) !== l.top) diff.top = scale(l.top);
    if (scale(l.floorZ) !== l.floorZ) diff.floorZ = scale(l.floorZ);
    if (Object.keys(diff).length) ops.push({ kind: "update", ref: levelRef(scene, l._id), diff });
  }
  let tokens = 0, ranges = 0;
  for (const t of scene.tokens) if (t.elevation !== undefined && scale(t.elevation) !== t.elevation) { book.set("tokens", t._id, parent, "elevation", scale(t.elevation)); tokens++; }
  for (const r of scene.regions ?? []) {
    if (r.triggerElevation) { book.set("regions", r._id, parent, "triggerElevation", { min: scale(r.triggerElevation.min), max: scale(r.triggerElevation.max) }); ranges++; }
    const cover = r.fauxOverhead;
    if (cover) {
      const { bottom, top } = cover.affectedElevation;
      book.set("regions", r._id, parent, "fauxOverhead.affectedElevation", { bottom: bottom === null ? null : scale(bottom), top: top === null ? null : scale(top) });
      book.set("regions", r._id, parent, "fauxOverhead.coverZ", scale(cover.coverZ));
      ranges++;
    }
  }
  for (const tile of scene.tiles) if (tile.triggerElevation) { book.set("tiles", tile._id, parent, "triggerElevation", { min: scale(tile.triggerElevation.min), max: scale(tile.triggerElevation.max) }); ranges++; }
  if (scene.foreground && Number.isFinite(scene.foreground.elevation) && scene.foreground.elevation !== 0) { book.set("scenes", scene._id, undefined, "foreground.elevation", scale(scene.foreground.elevation)); ranges++; }
  const distance = roundElevation(scene.grid.distance * factor);
  if (options.gridDistance) book.set("scenes", scene._id, undefined, "grid.distance", distance);
  ops.push(...book.ops());
  const values = ops.flatMap((op) => op.kind === "update" ? Object.values(op.diff) : []).flatMap(function flat(v: Json): number[] {
    return typeof v === "number" ? [v] : v && typeof v === "object" ? Object.values(v as Record<string, Json>).flatMap(flat) : [];
  });
  if (values.some((v) => Math.abs(v) > LIMIT)) return fail("Rescaled elevations must stay within ±1,000,000 scene units");
  const summary: string[] = [];
  if (levels.length) summary.push(`${plural(levels.length, "floor band")} ×${factor}.`);
  if (tokens) summary.push(`${plural(tokens, "token elevation")} ×${factor}.`);
  if (ranges) summary.push(`${plural(ranges, "elevation range")} on regions, tiles or the foreground ×${factor}.`);
  if (options.gridDistance) summary.push(`Grid distance ${scene.grid.distance} → ${distance} ${scene.grid.units || "units"} per cell.`);
  if (!ops.length) return fail("Nothing in this scene has an elevation to rescale");
  return { ops, summary, notes: ["Token sight and darkvision ranges are authored in feet and are not changed."], error: staged(scene, ops, options) };
}

/** Pick the merge target a GM most likely means: the floor directly below, else above. */
export function defaultMergeTarget(levels: readonly LevelDocument[], fromId: string): string | null {
  const stack = stackOrder(levels), index = stack.findIndex((l) => l._id === fromId);
  if (index < 0) return null;
  return (stack[index - 1] ?? stack[index + 1])?._id ?? null;
}
