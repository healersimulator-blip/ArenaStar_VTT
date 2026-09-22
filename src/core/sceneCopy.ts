/**
 * D-274 (plan §5.6) — **duplicating a scene**, which is what requirement 5d's *linked battle scene*
 * is made of: *"optional linked battle scene (offer on trigger, copy, spread tokens)"*.
 *
 * A scene's children are **embedded arrays on the scene document** (`tokens`, `walls`, `lights`,
 * `sounds`, `tiles`, `drawings`, `templates`, `notes`, `cells` — `core/documents.ts`), so a copy is
 * one `create` with everything re-keyed, and there is no ordering problem to solve: the host's rule
 * that a `create` may not reference a document created beside it (D-270) never comes up, because
 * every child travels *inside* the thing that is being created.
 *
 * What is deliberately **shared, not copied**: the map image. `SceneDocument.img` is a world asset
 * hash (§7), so the copy points at the same bytes — copying the picture is the one thing a battle
 * scene genuinely must not do.
 *
 * And one thing this module had to learn the hard way: the copy's own `active` flag rides **inside**
 * the create, never in a follow-up `update`. `host/sync.ts`'s `validateOps` resolves every `update`
 * ref against the store *as it stands before the batch*, so an op that touches a document created
 * beside it is rejected — and a rejected intent takes the whole envelope down with it, which is how
 * "the battle scene never appeared" looked in the browser (D-273's own lesson, one layer up).
 */
import type {
  CellDocument,
  NoteDocument,
  SceneDocument,
  TokenDocument,
  WallDocument,
} from "./documents";
import type { DocId } from "./ids";
import type { Op } from "./ops";

export interface DuplicateSceneInput {
  /** The scene to copy. */
  scene: SceneDocument;
  /** The new scene's id (`scene-xxxx`); the caller makes it unique. */
  id: DocId;
  /** Defaults to `"<name> (copy)"` — the tables window's own duplicate convention (D-272). */
  name?: string;
  /** Make the copy active, deactivating `scenes` (usually every other scene). */
  activate?: boolean;
  /** The scenes to deactivate when `activate` is set. */
  scenes?: readonly SceneDocument[];
  /**
   * Extra tokens for the copy, already positioned — the encounter's own creatures, built by
   * `core/hexcrawl/placement.ts`. They are appended to the copy's tokens, never to the original.
   */
  extraTokens?: readonly TokenDocument[];
  /** Re-key one child id at a time; defaults to a counter-based suffix (`t1-1`, …). */
  nextId?: (kind: string, id: DocId) => DocId;
}

/** `"Forest road"` → `"Forest road (copy)"`. */
export function copyName(name: string): string {
  return /\s\(copy( \d+)?\)$/.test(name) ? name : `${name} (copy)`;
}

/**
 * The ops that duplicate a scene. One `create` (the copy, children inside) plus — when `activate`
 * is set — one `update` per scene that has to stop being active; both address documents that
 * already exist, so the envelope is safe in one batch.
 */
export function duplicateSceneOps(input: DuplicateSceneInput): Op[] {
  const { scene, id } = input;
  const nextId =
    input.nextId ??
    ((kind: string, old: DocId) => `${kind}-${id.slice(-4)}-${String(old).slice(-6)}`);
  const tokens = (scene.tokens ?? []).map((token) => ({
    ...token,
    _id: nextId("t", token._id),
  })) as TokenDocument[];
  const walls = (scene.walls ?? []).map((wall) => ({
    ...wall,
    _id: nextId("w", wall._id),
  })) as WallDocument[];
  const notes = (scene.notes ?? []).map((note) => ({
    ...note,
    _id: nextId("n", note._id),
  })) as NoteDocument[];
  const cells = (scene.cells ?? []).map((cell) => ({
    ...cell,
    _id: nextId("c", cell._id),
  })) as CellDocument[];

  const copy: SceneDocument = {
    ...scene,
    _id: id,
    name: input.name ?? copyName(scene.name ?? "Scene"),
    // Set here, not by a follow-up update: see the module note above.
    active: input.activate === true,
    tokens: [...tokens, ...(input.extraTokens ?? [])],
    walls,
    notes,
    cells,
    lights: (scene.lights ?? []).map((light) => ({ ...light, _id: nextId("l", light._id) })),
    sounds: (scene.sounds ?? []).map((sound) => ({ ...sound, _id: nextId("s", sound._id) })),
    tiles: (scene.tiles ?? []).map((tile) => ({ ...tile, _id: nextId("tl", tile._id) })),
    drawings: (scene.drawings ?? []).map((drawing) => ({
      ...drawing,
      _id: nextId("d", drawing._id),
    })),
    templates: (scene.templates ?? []).map((template) => ({
      ...template,
      _id: nextId("tp", template._id),
    })),
  };

  const ops: Op[] = [{ kind: "create", coll: "scenes", data: copy }];
  if (input.activate) {
    for (const other of input.scenes ?? []) {
      if (other._id === scene._id || other._id === id || !other.active) continue;
      ops.push({
        kind: "update",
        ref: { coll: "scenes", id: other._id },
        diff: { active: false },
      });
    }
  }
  return ops;
}
