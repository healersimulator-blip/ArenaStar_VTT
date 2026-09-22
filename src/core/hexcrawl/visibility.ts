/**
 * **Hexcrawl visibility — the open set, the party's ring, and the one projection rule (Phase 2,
 * plan §3.5/§4).**
 *
 * Three questions live here and nowhere else:
 *
 * 1. *What can the party see?* `partySightKeys` — the ring around the party token, counted in
 *    cells (`sight.radiusCells`; 0 = its own cell) or in world units on a gridless map
 *    (`sight.radiusWorldUnits`), and **only** in `gm+party` mode. In `gm` mode the GM decides
 *    what is open and the party's position adds nothing.
 * 2. *What is open to the table?* `openCellKeys` = the replicated `revealed` set ∪ the ring.
 *    The client paints exactly this, and `sightReconcileOps` is what the plan's "the ring adds
 *    to the set every time it moves" means as a write: one `revealCellsOps` call, or `[]`.
 * 3. *What may a player receive?* `projectCellForViewer` — the security-relevant one, and the
 *    reason `projection.ts` imports this module. A player never receives the GM's
 *    `description`, never receives a cell's `playerText` while the cell is closed, and never
 *    receives an unrevealed `CellFeature`: D-256's lesson for map pins, generalised — the world
 *    asset manifest lists every hash, so the only gate that matters is which *documents* a
 *    player is sent.
 *
 * The reveal set is a property of the **party**, not of the player who happens to be driving
 * the token (plan §4): a per-user explored map is the tactical scene's model, and mixing the
 * two produces the classic "one player sees the map, the other one does not" bug.
 */
import type { CellDocument, SceneDocument } from "../documents";
import type { Op } from "../ops";
import {
  cellAtPoint,
  cellByKey,
  cellsOf,
  cellsWithin,
  zonesWithinRadius,
} from "./cells";
import { profileOf, revealCellsOps } from "./scene";
import { partyCentreOf } from "./travel";

/**
 * The world-pixel point the party's ring counts from — the token's own centre (`partyCentreOf`,
 * which is also where the projection's `hexPartyPoint()` readback comes from).
 */
export function partyPointOf(
  scene: SceneDocument | null | undefined,
): { x: number; y: number } | null {
  return partyCentreOf(scene);
}

/** The cell the party token stands in, or null (no party, or a gridless point outside every zone). */
export function partyCellKey(
  scene: SceneDocument | null | undefined,
): string | null {
  const point = partyPointOf(scene);
  if (!point || !scene) return null;
  return cellAtPoint(scene, point.x, point.y);
}

/**
 * The cells the party's own eyes cover. Empty in `gm` mode, without a party token, or when a
 * gridless party stands outside every authored zone. A radius of 0 is the party's own cell —
 * requirement 3's "own hex" option — and the ring is capped by `cellsWithin` itself.
 */
export function partySightKeys(
  scene: SceneDocument | null | undefined,
): string[] {
  if (!scene) return [];
  const profile = profileOf(scene);
  if (profile.sight.mode !== "gm+party") return [];
  const point = partyPointOf(scene);
  if (!point) return [];
  if (scene.grid?.type === "gridless") {
    const own = partyCellKey(scene);
    const keys = zonesWithinRadius(
      scene,
      point,
      profile.sight.radiusWorldUnits,
    );
    if (own !== null && !keys.includes(own)) keys.push(own);
    return keys;
  }
  const own = partyCellKey(scene);
  if (own === null) return [];
  return cellsWithin(scene, own, profile.sight.radiusCells);
}

/** The open set: the replicated `revealed` list ∪ the party's ring. */
export function openCellKeys(
  scene: SceneDocument | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!scene) return out;
  for (const key of profileOf(scene).revealed) out.add(key);
  for (const key of partySightKeys(scene)) out.add(key);
  return out;
}

/** Is this cell open to the table right now? */
export function isCellOpen(
  scene: SceneDocument | null | undefined,
  key: string,
): boolean {
  return openCellKeys(scene).has(key);
}

/**
 * The write the party's ring owes the world: every ring cell that is not in `revealed` yet, as
 * one `revealCellsOps` call (the builder collapses to `[]` when there is nothing to add, so the
 * caller may submit unconditionally). Called where the party *moves* — a token drag, a travel
 * step — by whichever client moved it.
 */
export function sightReconcileOps(
  scene: SceneDocument | null | undefined,
): Op[] {
  if (!scene) return [];
  const profile = profileOf(scene);
  if (profile.sight.mode !== "gm+party") return [];
  const known = new Set(profile.revealed);
  const add = partySightKeys(scene).filter((key) => !known.has(key));
  return add.length === 0 ? [] : revealCellsOps(scene, add);
}

/**
 * **The one projection rule for one cell** (D-271): what a player may hold of it, or `null` when
 * the answer is "nothing at all".
 *
 * A **closed** cell is not sent to a player — the same shape as D-256's hidden pin, and for the
 * same reason: the asset manifest lists every hash, so the only gate that matters is which
 * documents a session is handed. Opening a cell therefore *is* a create for that session, and
 * closing it is a delete (`cellVisibilityChanges` + the host's boundary rewrite in
 * `host/sync.ts`). The cover a player sees over unexplored ground is painted from the *open*
 * cells — a full-map cover with the open cells cut out of it — so nothing about a closed cell
 * has to exist on the player's replica for the map to render correctly.
 *
 * An **open** cell keeps its `playerText` and its `tables`, still loses the GM's `description`
 * (which is never a player's to read), and keeps only the features whose own `state.revealed`
 * is true.
 */
export function projectCellForViewer(
  cell: CellDocument,
  open: ReadonlySet<string>,
): CellDocument | null {
  if (!open.has(cell.key)) return null;
  const all = cell.features ?? [];
  const features = all.filter((f) => f.state?.revealed === true);
  const featuresHidden = features.length !== all.length;
  // Nothing to strip: hand back the very same document, so a scene that is already
  // player-shaped keeps its identity and a replica is not rebuilt for no reason.
  if (cell.description === undefined && !featuresHidden) return cell;
  const out: CellDocument = { ...cell };
  delete out.description;
  if (featuresHidden) out.features = features;
  return out;
}

/** The cell ids a scene holds — used by the host's boundary rewrite to find them. */
export function cellIdsOf(scene: SceneDocument | null | undefined): string[] {
  return cellsOf(scene).map((c) => c._id);
}

/**
 * Which cells changed visibility between two states of the same scene — the host's boundary
 * rewrite (`host/sync.ts`) reads this off a scene-flag update and then, per session, sends a
 * full `create` for every cell that opened and a `delete` for every cell that closed. Without
 * it a player who is told "this hex is now open" would hold a document that was stripped when
 * it was closed, and the reveal would show an empty box.
 */
export function cellVisibilityChanges(
  before: SceneDocument,
  after: SceneDocument,
): { opened: string[]; closed: string[] } {
  const was = openCellKeys(before);
  const now = openCellKeys(after);
  const opened: string[] = [];
  const closed: string[] = [];
  for (const key of now) if (!was.has(key)) opened.push(key);
  for (const key of was) if (!now.has(key)) closed.push(key);
  return { opened, closed };
}

/** Does this key name an authored cell of the scene? (A ring paints cells nobody wrote.) */
export function isAuthoredCell(
  scene: SceneDocument | null | undefined,
  key: string,
): boolean {
  return cellByKey(scene, key) !== null;
}
