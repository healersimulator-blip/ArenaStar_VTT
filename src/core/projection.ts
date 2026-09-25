/**
 * §5 Projection — pure per-user filtering before anything is broadcast.
 * Invariant: no client ever receives data the projection says it may not see.
 *
 *   projectWorld(world, seq, user) → ProjectedWorld
 *   projectEnvelope(env, user, resolver?) → OpEnvelope | null
 *
 * Rules (§5):
 * - hidden tokens omitted unless owner/GM;
 * - docs with effective ownership < LIMITED omitted;
 * - `<secret>` blocks in journal pages, GM-only roll results and whispers
 *   stripped;
 * - walls and lights sent to everyone (within any scene the user receives,
 *   D-022);
 * - hexcrawl cells are per-user too (D-271): a closed cell is not sent to a player at all, and
 *   an open cell arrives without the GM's `description` and without unrevealed features;
 * - GM (and ASSISTANT, D-013) receive everything unfiltered.
 *
 * `resolver` (D-023) lets the host supply current documents for update/delete
 * visibility; it is a pure lookup — these functions never mutate inputs.
 */
import {
  OWNERSHIP_LEVELS,
  TOP_LEVEL_COLLECTIONS,
  type BaseDocument,
  type CellDocument,
  type CellFeature,
  type DocRef,
  type JournalDocument,
  type MacroDocument,
  type MessageDocument,
  type NoteDocument,
  type SceneDocument,
  type TileDocument,
  type TokenDocument,
  type WorldCollections,
} from "./documents";
import type { Op, OpEnvelope } from "./ops";
import { getEffectiveOwnership } from "./permissions";
import type { PermissionUser } from "./ownership";
import type { Json } from "./documents";
import { openCellKeys, projectCellForViewer } from "./hexcrawl/visibility";
import { validateScriptMacro } from "./scriptMacros";
import { summonMarker, validateSummon } from "./summons";

export interface ProjectedWorld {
  seq: number;
  collections: Partial<WorldCollections>;
}

/** Pure lookup into current world state (host passes a store-backed one). */
export interface ProjectionResolver {
  resolve(ref: DocRef): BaseDocument | undefined;
}

export interface ProjectionFns {
  projectWorld(world: WorldCollections, seq: number, user: PermissionUser): ProjectedWorld;
  /** null ⇒ the recipient gets nothing from this envelope. */
  projectEnvelope(
    envelope: OpEnvelope,
    user: PermissionUser,
    resolver?: ProjectionResolver,
  ): OpEnvelope | null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const SECRET_BLOCK = /<secret>[\s\S]*?<\/secret>/gi;
const HAS_SECRET = /<secret[\s>]/i;

export function stripSecretText(text: string): string {
  return text.replace(SECRET_BLOCK, "");
}

function isGm(user: PermissionUser): boolean {
  return user.role === "GM" || user.role === "ASSISTANT";
}

type MessageAccess = "omit" | "redact" | "full";

/** §5: whispers + GM-only roll results (§10/§11 modes). */
function messageAccess(user: PermissionUser, msg: MessageDocument): MessageAccess {
  if (isGm(user)) return "full";
  const isAuthor = msg.author === user.id;
  const isTarget = msg.whisper.includes(user.id);
  if (msg.whisper.length > 0 && !(isAuthor || isTarget)) return "omit";
  if (msg.rollMode === "selfroll" && !isAuthor) return "omit";
  if (msg.roll) {
    if (msg.rollMode === "blindroll") return "redact"; // GM eyes only
    if (msg.rollMode === "gmroll" && !isAuthor) return "redact"; // GM + roller
  }
  return "full";
}

function redactMessage(msg: MessageDocument): MessageDocument {
  return { ...msg, roll: null };
}

function projectMessage(user: PermissionUser, msg: MessageDocument): MessageDocument | null {
  const access = messageAccess(user, msg);
  if (access === "omit") return null;
  if (access === "redact") return redactMessage(msg);
  return msg;
}

/** §5: hidden tokens omitted unless owner (≥ OWNER, cascade-aware) or GM. */
function tokenVisible(
  user: PermissionUser,
  token: TokenDocument,
  scene: SceneDocument,
): boolean {
  if (!token.hidden) return true;
  return getEffectiveOwnership(user, token, scene) >= OWNERSHIP_LEVELS.OWNER;
}

/**
 * D-256: the one visibility rule, shared by the world snapshot (`projectWorld`), the per-op
 * projection (`projectEnvelope`) and the host's boundary-crossing rewrite (§5, host/sync.ts).
 * Keeping one predicate is what makes the three agree — a session that "gains" visibility on a
 * document it never received has to be sent a full create, and that is only sound if all three
 * read the same rule.
 *
 * Map pins are the one special case: a note is a *pin*, and Roll20 keeps a pin hidden until the
 * GM toggles it visible, whatever the scene it sits in grants. Ownership alone cannot express
 * that here, because effective ownership cascades from the scene (which every player may read)
 * and would publish a hidden pin; so for notes the flag is the gate. The GM's write path keeps
 * `ownership.default` in step with the flag, so the ownership ledger stays honest for the
 * permission engine while the projection reads the flag.
 */
export function docVisibleTo(
  user: PermissionUser,
  doc: BaseDocument,
  parent?: BaseDocument,
): boolean {
  if (isGm(user)) return true;
  if (doc.type === "automation" || doc.type === "prefab" || doc.type === "fxInstance") return false; // host-owned definitions and instances
  // A GM-audience timeline's authored media names/hashes are also private;
  // omitting just its cue while publishing its sequence would leak assets.
  if (doc.type === "macro" && (doc as MacroDocument).kind === "summon" &&
      !(validateSummon((doc as MacroDocument).summon).ok &&
        (doc as MacroDocument).summon?.playerCallable === true)) return false;
  if (doc.type === "macro" && (doc as MacroDocument).kind === "sequence" &&
      (doc as MacroDocument).sequence?.audience === "gm") return false;
  // D-310: a preset is an authoring aid — its own name and the media it references are
  // a GM's library, not table state. A player never receives one (an assistant does).
  if (doc.type === "macro" && (doc as MacroDocument).kind === "fxPreset") return false;
  if ((doc.type === "token" && (doc as TokenDocument).hidden ||
       doc.type === "tile" && (doc as TileDocument).hidden) && parent?.type === "scene") {
    return getEffectiveOwnership(user, doc, parent) >= OWNERSHIP_LEVELS.OWNER;
  }
  if (doc.type === "note") {
    const note = doc as NoteDocument;
    // An explicit pin state wins. `visible: false` is the GM's "not yet"; `visible: true` is
    // "publish it". Notes written before D-256 carry no flag at all — those fall through to
    // ownership, which is how the starter world's pins have always been published.
    if (note.visible === false) return false;
    if (note.visible === true) return true;
  }
  return getEffectiveOwnership(user, doc, parent) >= OWNERSHIP_LEVELS.LIMITED;
}

/**
 * Fields whose change can move a document across a session's read boundary: the ownership map
 * everywhere, plus hidden flags on tokens/tiles and pin visibility on notes. `host/sync.ts`
 * watches updates that touch these to rewrite the envelope per session (grant → create,
 * revoke → delete).
 */
export function visibilityFields(doc: BaseDocument): readonly string[] {
  return doc.type === "note" ? ["ownership", "visible"]
    : doc.type === "token" || doc.type === "tile" ? ["ownership", "hidden"]
      : doc.type === "macro" ? ["ownership", "kind", "sequence", "summon"] : ["ownership"];
}

/**
 * D-271: the hexcrawl half of a scene's projection. A cell the table has not opened is **not
 * sent** (D-256's rule for pins), and an open one arrives without the GM's text. The array is
 * rebuilt only when a cell actually needed projecting, so a scene whose cells are already
 * player-shaped keeps its identity.
 */
function projectSceneCells(scene: SceneDocument): CellDocument[] | null {
  const cells = scene.cells;
  if (!cells || cells.length === 0) return null;
  const open = openCellKeys(scene);
  let changed = false;
  const out: CellDocument[] = [];
  for (const cell of cells) {
    const projected = projectCellForViewer(cell, open);
    if (projected === null) {
      changed = true;
      continue;
    }
    if (projected !== cell) changed = true;
    out.push(projected);
  }
  return changed ? out : null;
}

/** Scene-visible placeables may belong to a secret nested hierarchy. Instance
 * IDs, invisible parent IDs and the GM's source-scene ID are never needed by
 * player rendering; only the authoritative host retains attachment metadata. */
const PREFAB_PARTS = ["tokens", "tiles", "walls", "lights", "sounds", "drawings", "templates", "notes"] as const;
function stripPrefabMarker<T extends BaseDocument>(doc: T): T {
  if (doc.flags?.prefab === undefined && doc.flags?.summon === undefined &&
      doc.flags?.summonStatus === undefined) return doc;
  const { prefab: _hostOnly, summon: _summon, summonStatus: _status, ...flags } = doc.flags;
  void _hostOnly; void _summon; void _status;
  const marker = doc.type === "token" ? summonMarker(doc) : null;
  return { ...doc, flags: marker ? { ...flags, summonStatus: {
    ownerId: marker.ownerId, ...(marker.expiresAt !== undefined ? { expiresAt: marker.expiresAt } : {})
  } } : flags };
}

function projectPrefabCreate(op: Extract<Op, { kind: "create" }>): Op {
  if (op.coll !== "actors" && (!PREFAB_PARTS.some((part) => part === op.coll) || !op.parent)) return op;
  if (op.data.flags?.prefab === undefined && op.data.flags?.summon === undefined &&
      op.data.flags?.summonStatus === undefined) return op;
  return { ...op, data: stripPrefabMarker(op.data) };
}

function projectPrefabDiff(op: Extract<Op, { kind: "update" }>): Op | null {
  if (op.ref.coll !== "actors" && (!PREFAB_PARTS.some((part) => part === op.ref.coll) || !op.ref.parent)) return op;
  const diff: Record<string, Json | null> = {};
  let changed = false;
  for (const [key, value] of Object.entries(op.diff)) {
    const path = key.startsWith("-=") ? key.slice(2) : key;
    if (["prefab", "summon", "summonStatus"].some((marker) => path === `flags.${marker}` || path.startsWith(`flags.${marker}.`))) {
      changed = true;
      continue;
    }
    if (path === "flags" && value && typeof value === "object" && !Array.isArray(value) &&
        (Object.hasOwn(value, "prefab") || Object.hasOwn(value, "summon") ||
          Object.hasOwn(value, "summonStatus"))) {
      const { prefab: _hostOnly, summon: _summon, summonStatus: _status, ...flags } = value;
      void _hostOnly; void _summon; void _status;
      diff[key] = flags;
      changed = true;
      continue;
    }
    diff[key] = value;
  }
  if (Object.keys(diff).length === 0) return null;
  return changed ? { ...op, diff } : op;
}

/** Scene updates can carry whole embedded arrays as well as individual child
 * ops. Replace any touched array with its player-shaped committed version so a
 * parent update cannot smuggle hidden children or prefab metadata past projection. */
function projectSceneEmbedUpdate(
  user: PermissionUser, op: Extract<Op, { kind: "update" }>, scene: SceneDocument,
): Op {
  const touched = PREFAB_PARTS.filter((part) => Object.keys(op.diff).some((key) => {
    const path = key.startsWith("-=") ? key.slice(2) : key;
    return path === part || path.startsWith(`${part}.`);
  }));
  if (touched.length === 0) return op;
  const projected = projectScene(user, scene);
  const diff: Record<string, Json | null> = {};
  for (const [key, value] of Object.entries(op.diff)) {
    const path = key.startsWith("-=") ? key.slice(2) : key;
    if (!touched.some((part) => path === part || path.startsWith(`${part}.`))) diff[key] = value;
  }
  for (const part of touched) diff[part] = projected[part] as unknown as Json;
  return { ...op, diff };
}

function projectScene(user: PermissionUser, scene: SceneDocument): SceneDocument {
  const tokens = scene.tokens.filter((t) => tokenVisible(user, t, scene)).map(stripPrefabMarker);
  const tiles = scene.tiles.filter((t) => docVisibleTo(user, t, scene)).map(stripPrefabMarker);
  const notes = scene.notes.filter((n) => docVisibleTo(user, n, scene)).map(stripPrefabMarker);
  const cells = projectSceneCells(scene);
  const markers = PREFAB_PARTS.some((coll) => scene[coll].some((doc) => doc.flags?.prefab !== undefined || doc.flags?.summon !== undefined ||
    doc.flags?.summonStatus !== undefined));
  if (tokens.length === scene.tokens.length && tiles.length === scene.tiles.length &&
      notes.length === scene.notes.length && !cells && !markers) return scene;
  return { ...scene, tokens, tiles, notes,
    ...(markers ? { walls: scene.walls.map(stripPrefabMarker), lights: scene.lights.map(stripPrefabMarker),
      sounds: scene.sounds.map(stripPrefabMarker), drawings: scene.drawings.map(stripPrefabMarker),
      templates: scene.templates.map(stripPrefabMarker) } : {}),
    ...(cells ? { cells } : {}) };
}

function projectMacro(macro: MacroDocument): MacroDocument {
  if (macro.kind === "summon") {
    const check = validateSummon(macro.summon);
    // A published preset is a safe catalog entry, not a copy of its source
    // reference or GM flags. Every update replaces this shape, too.
    const safe: MacroDocument = { ...macro, command: "", system: {}, flags: {},
      ...(check.ok && check.definition.playerCallable
        ? { summon: { version: 1 as const, sceneId: check.definition.sceneId, playerCallable: true as const,
          maxDistance: check.definition.maxDistance,
          ...(check.definition.size !== undefined ? { size: check.definition.size } : {}),
          ...(check.definition.requireLoS !== undefined ? { requireLoS: check.definition.requireLoS } : {}),
          ...(check.definition.durationMs !== undefined ? { durationMs: check.definition.durationMs } : {}) } }
        : {}) };
    if (!check.ok || !check.definition.playerCallable) delete safe.summon;
    delete safe.script; delete safe.scriptState; delete safe.sequence;
    return safe;
  }
  if (macro.kind !== "script") {
    if (macro.scriptState === undefined && macro.summon === undefined) return macro;
    const safe = { ...macro };
    delete safe.scriptState; delete safe.summon;
    return safe;
  }
  // Public macros are a CALLABLE CATALOG, never a copy of source, grants,
  // approval hash, execution history or arbitrary author metadata. Apply the
  // identical shape to snapshots, creates and every subsequent update.
  const core = macro.flags?.core;
  const slot = core && typeof core === "object" && !Array.isArray(core) ? core.slot : undefined;
  const validated = validateScriptMacro(macro);
  const callable = validated.ok && validated.policy.playerCallable;
  const safe: MacroDocument = { ...macro, command: "", system: {},
    flags: { core: { playerCallable: callable,
      ...(typeof slot === "number" && slot >= 1 && slot <= 5 ? { slot } : {}) } },
    // Publish only validated input fields. A malformed import cannot smuggle
    // private metadata inside a plausible input schema.
    script: { version: 1, approvedHash: "", sceneId: "", runAs: "caller",
      playerCallable: callable, grants: [],
      inputs: validated.ok ? validated.policy.inputs.map(({ name, type, required }) =>
        ({ name, type, ...(required !== undefined ? { required } : {}) })) : [] } };
  delete safe.scriptState;
  delete safe.sequence;
  delete safe.summon;
  return safe;
}

function projectJournal(journal: JournalDocument): JournalDocument {
  let changed = false;
  const pages = journal.pages.map((page) => {
    if (typeof page.text === "string" && HAS_SECRET.test(page.text)) {
      changed = true;
      return { ...page, text: stripSecretText(page.text) };
    }
    return page;
  });
  return changed ? { ...journal, pages } : journal;
}

// ─── projectWorld ─────────────────────────────────────────────────────────────

export function projectWorld(
  world: WorldCollections,
  seq: number,
  user: PermissionUser,
): ProjectedWorld {
  if (isGm(user)) return { seq, collections: world };
  const out: Partial<WorldCollections> = {
    users: world.users, // D-021: player list / whisper targets for everyone
  };
  for (const coll of TOP_LEVEL_COLLECTIONS) {
    if (coll === "users") continue;
    if (coll === "automations") { out.automations = []; continue; }
    if (coll === "actionReceipts") { out.actionReceipts = []; continue; }
    if (coll === "prefabs") { out.prefabs = []; continue; }
    if (coll === "fxInstances") { out.fxInstances = []; continue; }
    const docs = world[coll] as readonly BaseDocument[];
    const kept: BaseDocument[] = [];
    for (const doc of docs) {
      if (getEffectiveOwnership(user, doc) < OWNERSHIP_LEVELS.LIMITED ||
          coll === "macros" && !docVisibleTo(user, doc)) continue;
      switch (coll) {
        case "scenes":
          kept.push(projectScene(user, doc as SceneDocument));
          break;
        case "journals":
          kept.push(projectJournal(doc as JournalDocument));
          break;
        case "messages": {
          const msg = projectMessage(user, doc as MessageDocument);
          if (msg) kept.push(msg);
          break;
        }
        case "macros":
          kept.push(projectMacro(doc as MacroDocument));
          break;
        case "actors":
          kept.push(stripPrefabMarker(doc));
          break;
        default:
          kept.push(doc);
      }
    }
    (out[coll] as unknown) = kept;
  }
  // assetManifest deliberately not projected here — it travels in
  // SnapshotMsg.manifest (D-021).
  return { seq, collections: out };
}

// ─── projectEnvelope ──────────────────────────────────────────────────────────

function stripSecretsFromDiff(diff: Record<string, Json | null>): Record<string, Json | null> {
  const out: Record<string, Json | null> = {};
  let changed = false;
  for (const [key, value] of Object.entries(diff)) {
    const path = key.startsWith("-=") ? key.slice(2) : key;
    if (
      path.split(".").pop() === "text" &&
      typeof value === "string" &&
      HAS_SECRET.test(value)
    ) {
      out[key] = stripSecretText(value);
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : diff;
}

function createVisible(
  user: PermissionUser,
  op: Extract<Op, { kind: "create" }>,
  resolver?: ProjectionResolver,
): Op | null {
  if (op.coll === "automations" || op.coll === "actionReceipts" || op.coll === "prefabs" || op.coll === "fxInstances") return null;
  if (op.coll === "macros" && !docVisibleTo(user, op.data)) return null;
  if (op.coll === "walls" || op.coll === "lights") return projectPrefabCreate(op); // §5/D-022
  // D-019 accepts creates without common fields; DocumentStore adds private ownership
  // on its clone, not on the original envelope. Projection must use the same default,
  // otherwise one sparse compendium actor can throw and stop a peer's whole broadcast
  // (including a public linked-token create in the same transaction).
  const authored = op.data as BaseDocument;
  const data = authored.ownership
    ? authored
    : { ...authored, ownership: { default: 0 as const } };
  const parent = op.parent !== undefined ? resolver?.resolve(op.parent) : undefined;
  if (op.coll === "messages") {
    const access = messageAccess(user, data as MessageDocument);
    if (access === "omit") return null;
    if (access === "redact") {
      return { ...op, data: redactMessage(data as MessageDocument) };
    }
    return op;
  }
  if (op.coll === "tokens" && (data as TokenDocument).hidden) {
    // Hidden token creation: owner (via token/parent ownership) or GM only.
    if (
      parent
        ? getEffectiveOwnership(user, data, parent) < OWNERSHIP_LEVELS.OWNER
        : getEffectiveOwnership(user, data) < OWNERSHIP_LEVELS.OWNER
    ) {
      return null;
    }
    return projectPrefabCreate(op);
  }
  if ((op.coll === "notes" || op.coll === "tiles") && !docVisibleTo(user, data, parent)) {
    return null; // A concealed pin/tile never reaches a player, even as a create op.
  }
  if (op.coll === "cells") {
    // D-271: a closed cell never reaches a player, even as a create. The reveal set lives on
    // the parent scene, so without it we cannot answer the question — and refusing to guess is
    // the only safe default.
    const scene = parent?.type === "scene" ? (parent as SceneDocument) : undefined;
    if (!scene) return null;
    const projected = projectCellForViewer(data as CellDocument, openCellKeys(scene));
    return projected === null ? null : { ...op, data: projected as BaseDocument };
  }
  if (getEffectiveOwnership(user, data, parent) >= OWNERSHIP_LEVELS.LIMITED) {
    if (op.coll === "macros") return { ...op, data: projectMacro(data as MacroDocument) };
    if (op.coll === "scenes") return { ...op, data: projectScene(user, data as SceneDocument) };
    if (op.coll === "journals") return { ...op, data: projectJournal(data as JournalDocument) };
    return projectPrefabCreate(op);
  }
  // Embedded create in a parent we cannot resolve (envelope-only mode): the
  // recipient sees the parent (host projects to connected users only), keep.
  return op.parent !== undefined && parent === undefined ? projectPrefabCreate(op) : null;
}

function updateVisible(
  user: PermissionUser,
  op: Extract<Op, { kind: "update" }>,
  resolver?: ProjectionResolver,
): Op | null {
  if (op.ref.coll === "automations" || op.ref.coll === "actionReceipts" || op.ref.coll === "prefabs" || op.ref.coll === "fxInstances") return null;
  if (op.ref.coll === "walls" || op.ref.coll === "lights") return projectPrefabDiff(op);
  const doc = resolver?.resolve(op.ref);
  if (!doc) return projectPrefabDiff(op); // envelope-only mode (D-023): host always passes a resolver
  if (op.ref.coll === "macros" && !docVisibleTo(user, doc)) return null;
  const parent = op.ref.parent !== undefined ? resolver?.resolve(op.ref.parent) : undefined;
  if (op.ref.coll === "messages") {
    const access = messageAccess(user, doc as MessageDocument);
    if (access === "omit") return null;
    if (access === "redact" && "roll" in op.diff) {
      return { ...op, diff: { ...op.diff, roll: null } };
    }
    return op;
  }
  if (op.ref.coll === "tokens" && (doc as TokenDocument).hidden) {
    if (getEffectiveOwnership(user, doc, parent) < OWNERSHIP_LEVELS.OWNER) return null;
  }
  if (op.ref.coll === "notes" && !docVisibleTo(user, doc, parent)) {
    // Making a pin hidden again is a delete for the player (it leaves their replica).
    return { kind: "delete", ref: op.ref };
  }
  if (op.ref.coll === "tiles" && !docVisibleTo(user, doc, parent)) return null;
  if (getEffectiveOwnership(user, doc, parent) < OWNERSHIP_LEVELS.LIMITED) return null;
  if (op.ref.coll === "scenes") return projectSceneEmbedUpdate(user, op, doc as SceneDocument);
  if (op.ref.coll === "macros" && (["script", "summon"].includes((doc as MacroDocument).kind) ||
      Object.keys(op.diff).some((key) => ["kind", "script", "scriptState", "summon"].includes(key)))) {
    const safe = projectMacro(doc as MacroDocument);
    // A kind transition can leave a previous script's code in a client's replica;
    // replace all macro-specific fields rather than forwarding a partial diff.
    return { ...op, diff: { name: safe.name, kind: safe.kind, command: safe.command,
      script: (safe.script as unknown as Json | undefined) ?? null, scriptState: null,
      sequence: (safe.sequence as unknown as Json | undefined) ?? null,
      summon: (safe.summon as unknown as Json | undefined) ?? null,
      flags: safe.flags, system: safe.system, ownership: safe.ownership } };
  }
  if (op.ref.coll === "pages" || op.ref.coll === "journals") {
    const diff = stripSecretsFromDiff(op.diff);
    if (diff !== op.diff) return { ...op, diff };
  }
  if (op.ref.coll === "cells") {
    // D-271: a cell that is closed, or has just been closed, leaves this session's replica —
    // the same rewrite D-256 gives a pin that is hidden again.
    const scene = parent?.type === "scene" ? (parent as SceneDocument) : undefined;
    if (!scene) return null;
    const open = openCellKeys(scene);
    if (!open.has((doc as CellDocument).key)) return { kind: "delete", ref: op.ref };
    const diff = projectCellDiff(op.diff, open.has((doc as CellDocument).key));
    if (!diff) return null;
    return diff === op.diff ? op : { ...op, diff };
  }
  if ((op.ref.coll === "tokens" || op.ref.coll === "actors") &&
      (doc.flags?.summon !== undefined || doc.flags?.summonStatus !== undefined ||
        Object.keys(op.diff).some((key) => key.startsWith("flags.summon") || key.startsWith("-=flags.summon") ||
          (key === "flags" && op.diff.flags && typeof op.diff.flags === "object" &&
            (Object.hasOwn(op.diff.flags, "summon") || Object.hasOwn(op.diff.flags, "summonStatus")))))) {
    const safe = stripPrefabMarker(doc);
    const diff: Record<string, Json | null> = {};
    for (const [key, value] of Object.entries(op.diff)) {
      if (key === "flags" || key.startsWith("flags.") || key.startsWith("-=flags.")) continue;
      diff[key] = value;
    }
    diff.flags = safe.flags as unknown as Json;
    return { ...op, diff };
  }
  return projectPrefabDiff(op);
}

/**
 * The player-shaped subset of a cell diff: the GM's `description` never travels, and the
 * `features` array travels only with the entries this viewer may see. Returns null when nothing
 * is left to say.
 */
function projectCellDiff(
  diff: Record<string, Json | null>,
  open: boolean,
): Record<string, Json | null> | null {
  const out: Record<string, Json | null> = {};
  let changed = false;
  for (const [key, value] of Object.entries(diff)) {
    const path = key.startsWith("-=") ? key.slice(2) : key;
    if (path === "description") {
      changed = true;
      continue;
    }
    if (!open && (path === "playerText" || path === "tables")) {
      changed = true;
      continue;
    }
    if (path === "features" && Array.isArray(value)) {
      const kept = value.filter(
        (f) => (f as CellFeature | null)?.state?.revealed === true,
      );
      if (kept.length !== value.length) {
        out[key] = kept as unknown as Json;
        changed = true;
        continue;
      }
    }
    out[key] = value;
  }
  if (Object.keys(out).length === 0) return null;
  return changed ? out : diff;
}

function deleteVisible(
  user: PermissionUser,
  op: Extract<Op, { kind: "delete" }>,
  resolver?: ProjectionResolver,
): Op | null {
  if (op.ref.coll === "automations" || op.ref.coll === "actionReceipts" || op.ref.coll === "prefabs" || op.ref.coll === "fxInstances") return null;
  if (op.ref.coll === "walls" || op.ref.coll === "lights") return op;
  const doc = resolver?.resolve(op.ref);
  if (!doc) return op;
  if (op.ref.coll === "macros" && !docVisibleTo(user, doc)) return null;
  const parent = op.ref.parent !== undefined ? resolver?.resolve(op.ref.parent) : undefined;
  if (op.ref.coll === "messages" && messageAccess(user, doc as MessageDocument) === "omit")
    return null;
  if (op.ref.coll === "tokens" && (doc as TokenDocument).hidden) {
    if (getEffectiveOwnership(user, doc, parent) < OWNERSHIP_LEVELS.OWNER) return null;
  }
  if ((op.ref.coll === "notes" || op.ref.coll === "tiles") && !docVisibleTo(user, doc, parent)) return null;
  if (getEffectiveOwnership(user, doc, parent) < OWNERSHIP_LEVELS.LIMITED) return null;
  return op;
}

export function projectEnvelope(
  envelope: OpEnvelope,
  user: PermissionUser,
  resolver?: ProjectionResolver,
): OpEnvelope | null {
  if (isGm(user)) return envelope;
  const ops: Op[] = [];
  let modified = false;
  for (const op of envelope.ops) {
    let projected: Op | null = null;
    switch (op.kind) {
      case "create":
        projected = createVisible(user, op, resolver);
        break;
      case "update":
        projected = updateVisible(user, op, resolver);
        break;
      case "delete":
        projected = deleteVisible(user, op, resolver);
        break;
    }
    if (projected !== null) {
      if (projected !== op) modified = true; // e.g. redacted roll, stripped secrets
      ops.push(projected);
    }
  }
  if (ops.length === 0) return null;
  // Return the original envelope object only when every op passed through as-is.
  return modified || ops.length !== envelope.ops.length ? { ...envelope, ops } : envelope;
}
