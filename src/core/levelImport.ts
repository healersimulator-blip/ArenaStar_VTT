/**
 * G-29 (D-441): import another scene as a floor of this one. Levels' "a scene per floor" habit
 * (and Foundry V14's per-level backgrounds) becomes one undoable envelope: the source map becomes a
 * floor map tile, its tiles, walls and lights are copied with fresh ids and stamped with the floor,
 * and the floor is either an existing one or a new floor stacked on top.
 *
 * Deliberately not copied: tokens (they belong to the encounter, not the map), regions (stairs,
 * triggers and covers point at the source's floors and automation), notes, drawings, templates and
 * sounds (sounds have no floor scope yet, so they would play on every floor), flags and tags (they
 * can bind automation to the source scene). A per-level `background` field is not added: a floor
 * map tile already is a per-floor background, with the same editing tools as every other tile.
 */
import type { DocRef, LevelDocument, LightDocument, SceneDocument, TileDocument, WallDocument } from "./documents";
import type { Op } from "./ops";
import { draftLevel, levelTransactionError } from "./levels";
import { regionTransactionError } from "./regionValidation";
import { scopeIncludes } from "./levelMembership";
import { backgroundRect, backgroundTransformOf } from "./backgroundTransform";

export interface ImportFloorInput {
  target: SceneDocument;
  source: SceneDocument;
  /** Required when the source has floors: which of them to import. */
  sourceLevelId?: string | null;
  /** An existing floor of the target, or a new floor stacked on top of the stack. */
  into: { levelId: string } | { newLevel: { id: string; name: string; height: number } };
  /** Where the source's top-left corner lands, in target scene pixels. */
  offset?: { x: number; y: number };
  /** Scale the source so its grid cells match this scene's (default on). */
  matchGrid?: boolean;
  /** The source map's natural pixel size (the asset manifest knows it); else the scene rectangle is used. */
  backgroundSize?: { width: number; height: number } | null;
  include?: { background?: boolean; tiles?: boolean; walls?: boolean; lights?: boolean };
  /** A fresh id per copied document. */
  nextId: (kind: "tile" | "wall" | "light") => string;
  /** `false` skips the staged check (live previews); submitting must validate. */
  validate?: boolean;
}
export interface ImportFloorPlan {
  ops: Op[];
  summary: string[];
  notes: string[];
  error: string | null;
  /** The floor the content lands on (the new floor's id when one is created). */
  levelId: string | null;
}

const fail = (error: string): ImportFloorPlan => ({ ops: [], summary: [], notes: [], error, levelId: null });
const round = (n: number) => { const r = Math.round(n * 1000) / 1000; return r === 0 ? 0 : r; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function importFloorPlan(input: ImportFloorInput): ImportFloorPlan {
  const { target, source } = input;
  const levels = target.levels ?? [];
  if (levels.length === 0) return fail("Save floors for this scene first, then import into one of them");
  if (source._id === target._id) return fail("Choose another scene to import");
  const sourceLevels = source.levels ?? [];
  const sourceLevel = sourceLevels.length ? sourceLevels.find((l) => l._id === input.sourceLevelId) : undefined;
  if (sourceLevels.length && !sourceLevel) return fail(`Choose which floor of ${source.name} to import`);

  // The destination floor.
  let level: LevelDocument;
  let created = false;
  const into = input.into;
  if ("levelId" in into) {
    const found = levels.find((l) => l._id === into.levelId);
    if (!found) return fail("That floor no longer exists");
    level = found;
  } else {
    const spec = into.newLevel;
    const name = spec.name.trim();
    if (!name || name.length > 64) return fail("Name the new floor (up to 64 characters)");
    if (!Number.isFinite(spec.height) || spec.height <= 0 || spec.height > 10_000) return fail("Give the new floor a height above 0");
    const top = [...levels].sort((a, b) => (b.top ?? Infinity) - (a.top ?? Infinity))[0] as LevelDocument;
    if (top.top === null) return fail(`${top.name} has an open top, so nothing can stack above it; import into an existing floor`);
    level = { ...draftLevel(spec.id, name, top.top, round(top.top + spec.height), Math.max(...levels.map((l) => l.sort)) + 1) };
    created = true;
  }

  const k = input.matchGrid !== false && source.grid.size > 0 && target.grid.size > 0 ? target.grid.size / source.grid.size : 1;
  const ox = input.offset?.x ?? 0, oy = input.offset?.y ?? 0;
  if (![k, ox, oy].every(Number.isFinite)) return fail("Choose a finite offset");
  const px = (x: number) => round(ox + x * k), py = (y: number) => round(oy + y * k);
  const include = { background: true, tiles: true, walls: true, lights: true, ...input.include };
  const scope = { mode: "levels" as const, ids: [level._id] };
  const parent: DocRef = { coll: "scenes", id: target._id };
  const notes: string[] = [];

  // Map art: the source background becomes a floor map tile; the floor's own tiles follow.
  const tiles: TileDocument[] = [];
  const usesBackground = !sourceLevel || sourceLevel.useSceneBackground === true;
  if (include.background && source.img && usesBackground) {
    const t = backgroundTransformOf(source.background);
    const natural = input.backgroundSize && input.backgroundSize.width > 0 && input.backgroundSize.height > 0 ? input.backgroundSize : null;
    const rect = natural ? backgroundRect(natural, t) : { left: 0, top: 0, width: source.width, height: source.height };
    if (!natural) notes.push("The map's pixel size is unknown, so its tile fills the source scene's rectangle; adjust it in the tile editor if it is off.");
    tiles.push({ _id: input.nextId("tile"), type: "tile", name: `${source.name} map`.slice(0, 128), ownership: { default: 0 }, flags: {}, system: {},
      x: px(rect.left), y: py(rect.top), width: round(rect.width * k), height: round(rect.height * k), img: source.img, above: false,
      occlusion: { mode: "fade", alpha: 0 } });
  }
  if (include.tiles) {
    const assigned = new Set(sourceLevels.flatMap((l) => l.tileIds ?? []));
    const picked = source.tiles.filter((tile) => !sourceLevel || (sourceLevel.tileIds ?? []).includes(tile._id));
    const skipped = sourceLevel ? source.tiles.filter((tile) => !assigned.has(tile._id)).length : 0;
    if (skipped) notes.push(`${plural(skipped, "tile")} not assigned to any floor of ${source.name} ${skipped === 1 ? "was" : "were"} skipped.`);
    const groups = new Set(target.tiles.flatMap((tile) => tile.roofGroup ? [tile.roofGroup.id] : []));
    let stripped = 0;
    for (const tile of picked) {
      const { _id: _old, flags: _flags, taggerTags: _tags, triggerZone, triggerElevation, roofGroup, ...rest } = tile;
      void _old; void _flags; void _tags;
      if (triggerZone || triggerElevation) stripped++;
      const group = roofGroup ? { ...roofGroup, id: groups.has(roofGroup.id) ? `${roofGroup.id}-${level._id}`.slice(0, 64) : roofGroup.id } : undefined;
      tiles.push({ ...structuredClone(rest), _id: input.nextId("tile"), flags: {}, x: px(tile.x), y: py(tile.y),
        width: round(tile.width * k), height: round(tile.height * k), ...(group ? { roofGroup: group } : {}) });
    }
    if (stripped) notes.push(`Trigger zones on ${plural(stripped, "tile")} were not copied; re-attach automation on the new floor.`);
  }

  const onSource = (s: WallDocument["levelScope"]) => !sourceLevel || scopeIncludes(s, sourceLevel._id);
  const walls: WallDocument[] = include.walls ? source.walls.filter((w) => onSource(w.levelScope)).map((w) => {
    const { _id: _old, flags: _flags, taggerTags: _tags, levelScope: _scope, ...rest } = w;
    void _old; void _flags; void _tags; void _scope;
    return { ...structuredClone(rest), _id: input.nextId("wall"), flags: {}, levelScope: scope, c: [px(w.c[0]), py(w.c[1]), px(w.c[2]), py(w.c[3])] };
  }) : [];
  const lights: LightDocument[] = include.lights ? source.lights.filter((l) => onSource(l.levelScope)).map((l) => {
    const { _id: _old, flags: _flags, taggerTags: _tags, levelScope: _scope, ...rest } = l;
    void _old; void _flags; void _tags; void _scope;
    return { ...structuredClone(rest), _id: input.nextId("light"), flags: {}, levelScope: scope, x: px(l.x), y: py(l.y),
      dim: round(l.dim * k), bright: round(l.bright * k) };
  }) : [];
  if (tiles.length + walls.length + lights.length === 0) return fail(`${source.name} has nothing to import (no map, tiles, walls or lights${sourceLevel ? ` on ${sourceLevel.name}` : ""})`);

  // Tiles first, then the floor that lists them, then everything scoped to it.
  const ops: Op[] = tiles.map((data) => ({ kind: "create", coll: "tiles", parent, data }));
  const tileIds = [...(level.tileIds ?? []), ...tiles.map((t) => t._id)];
  const floor: LevelDocument = { ...level, tileIds };
  if (created) ops.push({ kind: "create", coll: "levels", parent, data: floor });
  else if (tiles.length) ops.push({ kind: "update", ref: { coll: "levels", id: level._id, parent }, diff: { tileIds } });
  for (const data of walls) ops.push({ kind: "create", coll: "walls", parent, data });
  for (const data of lights) ops.push({ kind: "create", coll: "lights", parent, data });

  const summary = [
    created ? `New floor ${level.name}: Z ${level.bottom}–${level.top}, above ${levels.find((l) => l.top === level.bottom)?.name ?? "the stack"}` : `Into ${level.name}`,
    `${plural(tiles.length, "map tile")}, ${plural(walls.length, "wall")}, ${plural(lights.length, "light")} from ${source.name}${sourceLevel ? ` (${sourceLevel.name})` : ""}`,
  ];
  if (k !== 1) summary.push(`Scaled ×${round(k)} so ${source.grid.size} px cells match this scene's ${target.grid.size} px`);
  if (ox || oy) summary.push(`Offset by ${round(ox)}, ${round(oy)} px`);
  notes.push("Tokens, regions (stairs, triggers, covers), notes, drawings, templates and sounds are not imported.");
  const resolve = (ref: DocRef) => ref.coll === "scenes" && ref.id === target._id && !ref.parent ? target : undefined;
  const error = input.validate === false ? null : levelTransactionError(ops, resolve) ?? regionTransactionError(ops, resolve);
  return { ops, summary, notes, error, levelId: level._id };
}
