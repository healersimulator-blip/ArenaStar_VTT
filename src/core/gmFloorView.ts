/**
 * G-12 (D-434): the GM's floor view. A **rendering and picking** filter only — the result must never
 * be written back as document arrays. Objects that belong to no floor stay visible in every mode,
 * because the GM is the one who has to assign them.
 */
import type { LevelDocument, LevelScope, SceneDocument, TokenDocument } from "./documents";
import { scopeIncludes } from "./levelMembership";
import { visibleFloorsBelow } from "./levelPlay";

export type GmFloorMode = "only" | "ghost" | "all";
export interface GmFloorView { levelId: string; mode: GmFloorMode }
export interface GmFloorRender {
  scene: SceneDocument;
  /** Drawn at reduced opacity (other floors in "ghost" mode). */
  ghost: { tokens: Set<string>; tiles: Set<string> };
  /** Tokens the GM may pick and drag in build mode (active floor plus floorless). */
  pickable: (token: TokenDocument) => boolean;
  /** G-19 (D-443): in "only" mode, art of the floors this floor sees below (tile id → depth), as players see it. */
  lower: Map<string, number>;
  /** The depth the scene background is seen at: 0 = this floor's own, null = not drawn or not a floor view. */
  backgroundDepth: number | null;
  /** G-20 (D-445): in "only" mode, tokens on those floors (token id → depth), drawn beneath this floor's art. */
  lowerTokens: Map<string, number>;
}
export const GM_GHOST_ALPHA = 0.25;

function onFloor(scope: LevelScope | undefined, levelId: string, unscoped: boolean): boolean {
  return scope === undefined ? unscoped : scopeIncludes(scope, levelId);
}
export function gmFloorRender(scene: SceneDocument, view: GmFloorView | null): GmFloorRender {
  const all: GmFloorRender = { scene, ghost: { tokens: new Set(), tiles: new Set() }, pickable: () => true, lower: new Map(), backgroundDepth: null, lowerTokens: new Map() };
  const level = view ? scene.levels?.find((l) => l._id === view.levelId) : undefined;
  if (!view || !level || view.mode === "all") return all;
  const levels = scene.levels ?? [];
  const ownTile = new Set(level.tileIds ?? []);
  const anyFloorTile = new Set(levels.flatMap((l) => l.tileIds ?? []));
  const tokenHere = (t: TokenDocument) => t.levelId === undefined || t.levelId === level._id;
  const tileHere = (id: string) => ownTile.has(id) || !anyFloorTile.has(id);
  const someoneUsesBackground = levels.some((l) => l.useSceneBackground === true);
  const background = level.useSceneBackground === true || !someoneUsesBackground ? scene.img : null;
  // Walls/lights without a floor are legacy (shown so the GM sees what still needs assigning);
  // presentation objects without a floor are on every floor by definition (D-432).
  const filtered: SceneDocument = {
    ...scene,
    walls: scene.walls.filter((w) => onFloor(w.levelScope, level._id, true)),
    lights: scene.lights.filter((l) => onFloor(l.levelScope, level._id, true)),
    drawings: scene.drawings.filter((d) => onFloor(d.levelScope, level._id, true)),
    templates: scene.templates.filter((t) => onFloor(t.levelScope, level._id, true)),
    notes: scene.notes.filter((n) => onFloor(n.levelScope, level._id, true)),
    regions: (scene.regions ?? []).filter((r) => r.stairs !== undefined || onFloor(r.levelScope, level._id, true)),
  };
  if (view.mode === "only") {
    // G-19: the floors this one sees below show through its art, dimmed, exactly as players see them.
    const lower = new Map<string, number>(), lowerTokens = new Map<string, number>();
    let backgroundDepth: number | null = background ? 0 : null;
    for (const { level: below, depth } of visibleFloorsBelow(scene, level)) {
      for (const id of below.tileIds ?? []) if (!ownTile.has(id) && !lower.has(id)) lower.set(id, depth);
      if (backgroundDepth === null && below.useSceneBackground === true) backgroundDepth = depth;
      // The GM sees every token down there; only the floor's art decides what shows through.
      for (const t of scene.tokens) if (t.levelId === below._id && !lowerTokens.has(t._id)) lowerTokens.set(t._id, depth);
    }
    return { scene: { ...filtered, img: backgroundDepth !== null ? scene.img : null, tokens: scene.tokens.filter(tokenHere),
      tiles: scene.tiles.filter((t) => tileHere(t._id) || lower.has(t._id)) },
    ghost: { tokens: new Set(), tiles: new Set() }, pickable: tokenHere, lower, backgroundDepth, lowerTokens };
  }
  return { scene: { ...filtered, img: background ?? scene.img },
    ghost: { tokens: new Set(scene.tokens.filter((t) => !tokenHere(t)).map((t) => t._id)), tiles: new Set(scene.tiles.filter((t) => !tileHere(t._id)).map((t) => t._id)) },
    pickable: tokenHere, lower: new Map(), backgroundDepth: null, lowerTokens: new Map() };
}
/** PageUp/PageDown order: by floor elevation, then display order. */
export function adjacentFloor(levels: readonly LevelDocument[], current: string | null, direction: 1 | -1): string | null {
  const sorted = [...levels].sort((a, b) => a.floorZ - b.floorZ || a.sort - b.sort || a._id.localeCompare(b._id));
  if (!sorted.length) return null;
  const index = sorted.findIndex((l) => l._id === current);
  if (index < 0) return (direction > 0 ? sorted[0] : sorted[sorted.length - 1])?._id ?? null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index + direction))]?._id ?? null;
}
/** G-17: who stands on each floor (floorless tokens are reported separately). */
export function floorRoster(scene: SceneDocument, isPc: (token: TokenDocument) => boolean): Array<{ levelId: string | null; tokens: number; pcs: TokenDocument[] }> {
  const rows = [...(scene.levels ?? [])].sort((a, b) => b.floorZ - a.floorZ || a.sort - b.sort).map((l) => ({ levelId: l._id as string | null, tokens: 0, pcs: [] as TokenDocument[] }));
  const none = { levelId: null as string | null, tokens: 0, pcs: [] as TokenDocument[] };
  for (const token of scene.tokens) {
    const row = rows.find((r) => r.levelId === token.levelId) ?? none;
    row.tokens++;
    if (isPc(token)) row.pcs.push(token);
  }
  return none.tokens ? [...rows, none] : rows;
}
