/**
 * GM-authored active-zone automation (MATT-class graph foundation). Definitions
 * are separate from execution history and are NEVER projected to players. The
 * host resolves every selector against current documents and commits all world
 * writes in one atomic envelope; visual cues are preflighted and sent afterwards.
 *
 * This is a bounded action registry foundation, not the full §5.4 inventory.
 */
import type {
  ActorDocument, AssetManifest, AutomationDocument, BaseDocument, DocRef, Json, MessageDocument,
  SceneDocument, SceneGrid, NoteDocument, TileDocument, TokenDocument, WallDocument, WorldCollections,
} from "./documents";
import { gameTimeAmountError, resolveGameTimeAmount, type GameTimeAmount } from "./gameTimeAmount";
import { healthAmountError, resolveHealthAmount, type HealthAmount } from "./healthAmount";
import { rotationAngleError, resolveRotationAngle, type RotationAngle } from "./rotationAngle";
import { hexCorners, snapTokenCenter, type GridSpec } from "../canvas/grid";
import { moveTableLocation, snapshotMoveDestination, moveDestinationPoint, type MoveDestinationSnapshot } from "./moveDestination";
import { regionTriggerTile } from "./regionGeometry";
import { MOVABLE_COLLECTIONS, applyMovePosition, moveGeometry, type MovePlaceable } from "./movePlaceable";
import { movementWallBlocked, movementFootprintBlocked, movementSpeedDuration } from "./movementPolicy";
import { moveCoordinatesError, resolveMoveCoordinates, type MoveCoordinates } from "./moveCoordinates";
import { isDoorWall } from "./documents";
import { tileTriggerAlphaContains, tileTriggerElevationError, tileTriggerPolygonContains, tileTriggerWorldPolygon } from "./tileTriggerZone";
import { resolveTileImageIndex, tileImageSelectionError, type TileImageList } from "./tileImageSelection";
import { drawFromTable, validateTable } from "./rollTable";
import { applyDiff } from "./diff";
import { DAY_SECONDS, MINUTE_SECONDS } from "./clock";
import { WORLD_SETTINGS_ID, worldSettingsDoc, worldSettingsFrom } from "./worldSettings";
import type { Op } from "./ops";
import type { PermissionUser } from "./ownership";
import { getByTag, listTaggable, normalizeTags, tagMatcher, tagsOf, TAGGABLE_COLLECTIONS, validSceneTagRefs,
  type TagEdit, type TagMatchMode, type TagPattern, type TagSearchCollection } from "./tags";

export type AutomationMethod = "enter" | "exit" | "stop" | "elevation" | "create" | "sceneChange" | "rotate" | "click" | "rightClick" | "doubleClick" | "hoverIn" | "hoverOut" | "manual";
export type AutomationPointerMethod = Extract<AutomationMethod, "click" | "rightClick" | "doubleClick" | "hoverIn" | "hoverOut">;
/** Explicitly bound event fields, never arbitrary code/field paths from a player request. */
export type AutomationScriptBinding = "triggerToken" | "currentToken" | "method" | "user" | "scene" | "tile" | "count";
export interface AutomationGates {
  paused?: boolean;
  /** Direct player click requests; movement triggers always follow GM-published rules. */
  playerRunnable?: boolean;
  oncePerToken?: boolean;
  cooldownMs?: number;
  chance?: number;
  maxRuns?: number;
}
export type AutomationSelector =
  | { kind: "triggering" }
  | { kind: "inside" }
  | { kind: "tile" }
  | { kind: "ids"; refs: DocRef[] }
  | { kind: "tag"; query: string | string[]; mode?: TagMatchMode; pattern?: TagPattern;
      caseSensitive?: boolean; contains?: boolean; collections?: TagSearchCollection[];
      includeRefs?: DocRef[]; excludeRefs?: DocRef[] };
/** Restrict cross-tile calls to this scene; a public trigger never supplies a child graph ID. */
export type AutomationTileTarget =
  | { kind: "id"; tileId: string }
  | { kind: "current" }
  | { kind: "tag"; query: string | string[]; mode?: TagMatchMode; pattern?: TagPattern;
      caseSensitive?: boolean; contains?: boolean; includeRefs?: DocRef[]; excludeRefs?: DocRef[] };
export type AutomationStep =
  | { id: string; kind: "select"; selector: AutomationSelector }
  | { id: string; kind: "filter"; test:
      | { kind: "count" | "tileCount" | "tokenCount"; min: number; max?: number }
      | { kind: "method"; method: AutomationMethod }
      | { kind: "variable"; name: string; equals: string | number | boolean }; otherwise?: string }
  /** MATT collection actions: preserve selection order unless explicitly shuffled. */
  /** MATT Check Variable: compare persistent values on this graph or scene-local
   * ID/current/Tagger tiles. Multi-graph tiles check each private graph state;
   * missing values are null, not zero. Optional failure landing is top-level. */
  | { id: string; kind: "checkVariable"; name: string; target?: AutomationTileTarget;
      mode?: "all" | "any" | "none";
      compare: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "mod";
      value?: string | number | boolean | null; divisor?: number; remainder?: number;
      otherwise?: string }
  /** MATT Check Value (host-observed subset): committed darkness, replicated
   * world-clock minutes after midnight, or triggering-token movement direction.
   * A client-supplied keyboard hint cannot attest a physical key press. */
  | { id: string; kind: "checkValue"; source: "darkness" | "time" | "direction.x" | "direction.y";
      compare: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      value: number | "left" | "right" | "up" | "down"; otherwise?: string }
  /** Compare a bounded own-property path on an awaited Run Macro result.
   * `ok`, `error`, and `value[.path]` are the available roots. */
  | { id: string; kind: "checkScriptResult"; scriptStepId: string; path: string;
      compare: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      value: string | number | boolean | null; otherwise?: string }
  | { id: string; kind: "shuffle" }
  | { id: string; kind: "position"; index: number }
  | { id: string; kind: "distance"; from: "trigger" | "tile"; min?: number; max: number }
  /** MATT Filter by Attributes: compare a bounded own-data path on each
   * selected placeable (or its linked actor). This filters the collection;
   * a following count check decides whether to branch. Never evaluates code. */
  | { id: string; kind: "attributes"; path: string;
      compare: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "has";
      value: string | number | boolean }
  /** MATT Check Data: one tile-only, side-effect-free attribute predicate
   * with a named failure landing. The current selection is unchanged. */
  | { id: string; kind: "checkData"; path: string;
      compare: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "has";
      value: string | number | boolean; otherwise?: string }
  /** MATT Filter by Condition: active actor effects and PF1e native condition
   * names; never infers "doesn't have" from an unlinked/missing actor. */
  | { id: string; kind: "condition"; effect: string; mode: "has" | "lacks" }
  /** MATT Filter by Items in Inventory: count matching actor item DOCUMENTS,
   * not stack quantities. Edge * wildcards only; comparisons are typed. */
  | { id: string; kind: "inventory"; item: string;
      compare: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; count: number }
  /** MATT Filter by Token Trigger Count: keep selected tokens according to
   * THIS graph's per-token host history (including the current trigger). A
   * following entity-count check decides whether to branch. */
  | { id: string; kind: "tokenTriggerCount";
      compare: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; count: number }
  /** Named method/user routing. An unmatched case falls through unless `otherwise` is supplied. */
  | { id: string; kind: "routeMethod"; routes: Partial<Record<AutomationMethod, string>>; otherwise?: string }
  | { id: string; kind: "routeUser"; gm?: string; player?: string; otherwise?: string }
  /** A lexical loop over a snapshot of the current collection; `endId`/`startId` pair by ID. */
  | { id: string; kind: "forEach"; endId: string }
  | { id: string; kind: "endEach"; startId: string }
  | { id: string; kind: "resetHistory" }
  /** Execute queued, coalesced world edits at this point in the graph's atomic plan. */
  | { id: string; kind: "batchFlush" }
  /** Add/remove/replace/clear the current action collection; stable ref identity, no world writes. */
  | { id: string; kind: "collection"; mode: "add" | "remove" | "replace" | "clear"; selector?: AutomationSelector }
  /** Calls manual-method graphs anchored to matching tiles as part of THIS atomic host plan. */
  | { id: string; kind: "triggerTile"; target: AutomationTileTarget;
      tokens: "triggering" | "current" | "inside"; landing?: string; propagateStop?: boolean }
  /** MATT Activate/Deactivate: change the paused gate on all graphs bound to
   * selected tiles. Never changes a tile's visible/hidden state. */
  | { id: string; kind: "setActive"; target: AutomationTileTarget;
      mode: "activate" | "deactivate" | "toggle" }
  /** Suppress later tiles for this movement source after a successful commit. */
  | { id: string; kind: "stopOthers" }
  /** MATT Stop Token Movement: settle the triggering token at its swept enter/exit boundary. */
  | { id: string; kind: "stopMovement"; snapToGrid?: boolean }
  /** Set Active Tiles Variable. Run variables last only for this invocation;
   * tile variables live in the private, undoable graph state across triggers.
   * Numeric addition is bounded and uses zero for a previously unset name.
   * Delete removes one exact key (missing is a no-op); it carries no value. */
  | { id: string; kind: "set"; name: string; value?: string | number | boolean;
      scope?: "run" | "tile"; operation?: "assign" | "add" | "delete";
      /** Optional same-scene MATT tile targeting. All graphs on each selected
       * tile receive the durable value; without a target, only this graph does. */
      target?: AutomationTileTarget }
  /** MATT Game Time: a bounded fixed or dice/math minute delta applied to the host-owned
   * replicated world clock. Later Check Value steps see the staged change. */
  | ({ id: string; kind: "gameTime" } & GameTimeAmount)
  /** Scene-local appearance writes, separate from transient visual FX. */
  | { id: string; kind: "sceneLighting"; mode: "set" | "add"; darkness: number; durationMs?: number }
  | { id: string; kind: "sceneBackground"; image: string | null; targetSceneId?: string }
  /** Static, owned image on the current tile collection; empty clears it. */
  | { id: string; kind: "tileImage"; image: string; images?: never; selection?: never; index?: never; numbers?: never; formula?: never }
  | ({ id: string; kind: "tileImage"; image?: never } & TileImageList)
  /** MATT Hurt / Heal: fixed or dice/math GM-authored whole HP points; positive heals,
   * negative hurts. Current selection may come from Inside/Tagger filters. */
  | ({ id: string; kind: "hurtHeal"; targets: "triggering" | "current" } & HealthAmount)
  /** MATT Move: host-authorized set/add reposition of six movable scene placeable types to an
   * authored point on THIS scene. The committed move goes through the host's
   * normal movement-trigger dispatch, so a destination crossing a tile can
   * legitimately fire that tile; Stop Additional Tiles Triggering suppresses
   * it. A token deleted earlier in the same plan is never rewritten. */
  | ({ id: string; kind: "move"; destination?: { coll: "tokens" | "tiles"; id: string }; destinationTag?: Extract<AutomationSelector, {kind: "tag"}>; destinationResult?: "rollTable"; destinationOriginal?: true; destinationChoice?: "unique" | "random"; destinationPosition?: "center" | "random" | "entry"; snapToGrid?: boolean; wallCollision?: "ignore" | "block" | "footprint"; durationMs?: number; speed?: number; triggerTiles?: boolean; targets: "triggering" | "current" } & MoveCoordinates)
  /** MATT Rotation: set/add token or tile rotation; degrees normalize to [0, 360). */
  | ({ id: string; kind: "rotate"; durationMs?: number; mode?: "set" | "add"; targets: "triggering" | "current" } & RotationAngle)
  /** MATT Delete Entities: remove the current collection's scene placeables
   * (token, tile, wall, drawing, map pin). Deleting a token never touches its
   * linked actor; the collection is empty afterwards. */
  | { id: string; kind: "delete" }
  /** MATT Roll Table: the host rolls a saved roll table with its RNG and posts
   * the result to the scene or GM-only audience. An optional named variable
   * receives the result text for later filters and chat interpolation. */
  | { id: string; kind: "rollTable"; tableId: string; audience: "scene" | "gm"; variable?: string }
  /** MATT Random Number: host RNG sets a typed integer for later value filters/text. */
  | { id: string; kind: "random"; name: string; min: number; max: number }
  | { id: string; kind: "tags"; edit: TagEdit; tags: string[] }
  /** Show/hide selected tokens, tiles or map notes; no arbitrary document fields. */
  | { id: string; kind: "visibility"; mode: "show" | "hide" | "toggle" }
  /** A tagged door's state, not its wall-kind/restriction axes. Locked doors reject toggle/open. */
  | { id: string; kind: "door"; mode: "open" | "close" | "lock" | "unlock" | "toggle" }
  | { id: string; kind: "chat"; content: string; audience: "scene" | "gm" }
  | { id: string; kind: "sequence"; macroId: string; audience: "scene" | "gm" }
  /** Run a separate GM-reviewed, version-pinned script AFTER the graph envelope commits.
   * Its own host RPCs are independently authorized/committed; they are not part of
   * this graph's atomic transaction. No inline code or caller-supplied grants. */
  | { id: string; kind: "script"; macroId: string;
      args?: Record<string, string | number | boolean>;
      bindings?: Record<string, AutomationScriptBinding>;
      /** `approved` uses the published policy; caller can narrow, GM can only
       * be selected when the published policy already grants that elevation. */
      runAs?: "approved" | "caller" | "gm";
      /** A failed awaited action can stop the queue or preserve later authorized actions. */
      onError?: "stop" | "continue";
      /** Yield here and resume with a typed result after the host awaits this call. */
      captureResult?: boolean }
  /** GM-authored, exact preset ID. Post-commit like a reviewed script because
   * a compendium source may need asynchronous resolution. No actor data from
   * the triggering client is accepted; the host creates the linked instance. */
  | { id: string; kind: "summon"; presetId: string; anchor: "tile" | "trigger" | "current";
      onError?: "stop" | "continue" }
  | { id: string; kind: "landing"; name: string }
  | { id: string; kind: "jump"; to: string }
  | { id: string; kind: "stop" };

export interface AutomationDefinition {
  version: 1;
  sceneId: string;
  /** Source collection; omission preserves legacy tile-anchored graphs. */
  sourceKind?: "tile" | "region";
  /** ID of the selected tile or first-class scene region. */
  tileId: string;
  methods: AutomationMethod[];
  gates?: AutomationGates;
  steps: AutomationStep[];
}
export interface AutomationState {
  count: number;
  lastAt: number;
  byToken: Record<string, { count: number; lastAt: number }>;
  /** Bounded, GM-only audit; older worlds may have only the aggregate fields. */
  recent?: Array<{ at: number; method: AutomationMethod; userId: string; tokenId?: string }>;
  /** Per-graph persistent variables; never projected to players. Unlike history,
   * these survive Reset Tile Trigger History until explicitly cleared. */
  variables?: Record<string, string | number | boolean>;
}
export interface AutomationEvent {
  method: AutomationMethod;
  /** Preserved across Trigger Tile calls; child `method` is manual. */
  originMethod?: AutomationMethod;
  originTileId?: string;
  scene: SceneDocument;
  tile: TileDocument;
  /** Original triggering token is immutable even when "current" is replaced by a selector. */
  token?: TokenDocument;
  /** Host-observed vector on committed token movement, never client-supplied. */
  direction?: { x?: "left" | "right"; y?: "up" | "down" };
  /** Private contact snapshot from this tile's committed enter event; not inherited by children. */
  movementEntry?: { tileId: string; tokenId: string; u: number; v: number };
  /** Host-observed intended endpoint for this triggering token's committed movement. */
  movementOriginal?: { tokenId: string; x: number; y: number };
  /** Host-observed swept boundary contact; never sent by a client. */
  movementCrossing?: { tileId: string; tokenId: string; method: "enter" | "exit"; fraction: number; x: number; y: number };
  caller: PermissionUser;
  at: number;
  rng: () => number;
  /** Host-owned manifest check, re-read at execution, never a player callback. */
  imageAssetError?: (hash: string) => string | null;
  /** System-package HP arithmetic. The graph remains pure and refuses the
   * action when the host has no adapter or an actor has unusable HP. */
  hurtHeal?: (actor: ActorDocument, amount: number) =>
    { ok: true; diff: Record<string, Json | null>; note: string } | { ok: false; error: string };
}
export interface AutomationFx {
  macroId: string;
  audience: "scene" | "gm";
  sourceTokenId?: string;
  targetTokenId?: string;
}
export interface AutomationScriptCall {
  stepId: string;
  macroId: string;
  args: Record<string, Json>;
  runAs?: "approved" | "caller" | "gm";
  onError?: "stop" | "continue";
  /** Pause the graph after this awaited call so later steps can branch on its return. */
  captureResult?: true;
}
export type AutomationScriptResult =
  | { ok: true; value: Json }
  | { ok: false; error: string };
export interface AutomationContinuation {
  graphId: string;
  stepIndex: number;
  captureStepId: string;
  current: DocRef[];
  values: Record<string, string | number | boolean>;
  scriptResults: Record<string, AutomationScriptResult>;
  tableResult: { present: false } | { present: true; value: string | null };
  graphSteps: number;
  postActionCount: number;
  budgets: {
    steps: number; invocations: number; attributeReads: number; actorFilterReads: number;
    tileVariableReads: number; imageSelectionRolls: number; healthRolls: number;
    rotationRolls: number; moveRolls: number; gameTimeRolls: number; tableRolls: number;
  };
}
export type AutomationPostAction =
  | ({ kind: "script" } & AutomationScriptCall)
  | { kind: "summon"; stepId: string; presetId: string; at: { x: number; y: number };
      summonerTokenId?: string; onError?: "stop" | "continue" };
export interface AutomationPlan {
  ops: Op[];
  cues: AutomationFx[];
  scripts: AutomationScriptCall[];
  /** Authored order across reviewed scripts and real summons. Separate commits
   * follow the single graph envelope; GM trace reports failures explicitly. */
  postActions: AutomationPostAction[];
  /** Present when an awaited script result suspends the graph at a safe boundary. */
  continuation?: AutomationContinuation;
  trace: string[];
  state: AutomationState;
  /** Suppress later tiles for this moving token after a successful host commit. */
  stopOthers: boolean;
  /** Private per-commit policy, never a document flag or caller-controlled op field. */
  suppressedMovement: string[];
  /** Tokens for which a host-observed Stop Token Movement step actually ran, even if later actions resume them. */
  stoppedMovement: string[];
}
export type AutomationOutcome =
  | { ok: true; plan: AutomationPlan }
  | { ok: false; error: string; trace: string[] }
  | { ok: true; skipped: string; trace: string[] };

const METHODS: readonly AutomationMethod[] = ["enter", "exit", "stop", "elevation", "create", "sceneChange", "rotate", "click", "rightClick", "doubleClick", "hoverIn", "hoverOut", "manual"];
const SCRIPT_BINDINGS: readonly AutomationScriptBinding[] = ["triggerToken", "currentToken", "method", "user", "scene", "tile", "count"];
const IDENT = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const INPUT_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
/** Runtime bindings cannot be shadowed by durable user-defined variables. */
const RESERVED_VARIABLES = new Set(["method", "originMethod", "originTile", "user", "count", "index",
  "currentId", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"]);
const VARIABLE_LIMIT = 64;
const VARIABLE_NUMBER_LIMIT = 1_000_000_000;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const validVariable = (value: unknown): value is string | number | boolean =>
  typeof value === "boolean" || typeof value === "string" && value.length <= 256 ||
  typeof value === "number" && finite(value, -VARIABLE_NUMBER_LIMIT, VARIABLE_NUMBER_LIMIT);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every((k) => allowed.includes(k));
const nonEmptyId = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
const SCRIPT_RESULT_SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;
const SCRIPT_RESULT_UNSAFE = new Set(["__proto__", "prototype", "constructor"]);
function validScriptResultPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 128) return false;
  const parts = path.split(".");
  if (parts.length < 1 || parts.length > 8 || parts.some((part) =>
    !SCRIPT_RESULT_SEGMENT.test(part) || SCRIPT_RESULT_UNSAFE.has(part))) return false;
  return ["ok", "error", "value"].includes(parts[0] ?? "") &&
    (parts[0] === "value" || parts.length === 1);
}
function validScriptResultValue(value: unknown): value is string | number | boolean {
  return typeof value === "boolean" || typeof value === "number" && finite(value, -1e9, 1e9) ||
    typeof value === "string" && value.length <= 256 &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/** These world-image actions intentionally accept no remote URLs or arbitrary MIME types.
 * Publishing to a scene/tile must not smuggle GM-only imported FX media into a public ref.
 * Permission to redistribute the world remains a separate export-time policy. */
export function automationImageError(hash: string, manifest: AssetManifest): string | null {
  if (!/^[a-f0-9]{64}$/.test(hash)) return "image must be an owned asset hash";
  const entry = Object.hasOwn(manifest, hash) ? manifest[hash] : undefined;
  if (!entry || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(entry.mime))
    return "image asset is missing or its format is unsupported";
  if (entry.visibility === "gm") return "image is GM-only; approve player sharing before using it in a world-image action";
  return null;
}

/** Filter by Attributes is a *data* query, not an expression evaluator. The
 * allowlisted roots prevent reading ownership, media, hidden document internals,
 * or walking a prototype; nested system/flags keys are own-data only. */
const ATTRIBUTE_DIRECT = new Set(["_id", "type", "name", "x", "y", "width", "height", "rotation",
  "hidden", "vision", "disposition", "sort", "above", "door", "oneWay", "kind"]);
const ATTRIBUTE_ACTOR_DIRECT = new Set(["_id", "type", "name"]);
const ATTRIBUTE_SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;
const ATTRIBUTE_UNSAFE = new Set(["__proto__", "prototype", "constructor"]);
function validAttributePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 160) return false;
  const parts = path.split(".");
  if (parts.length > 8 || parts.some((part) => !ATTRIBUTE_SEGMENT.test(part) || ATTRIBUTE_UNSAFE.has(part))) return false;
  const [root, next] = parts;
  if (root === "actor") return parts.length === 2 && ATTRIBUTE_ACTOR_DIRECT.has(next ?? "") ||
    parts.length >= 3 && (next === "system" || next === "flags");
  if (root === "system" || root === "flags") return parts.length >= 2;
  return parts.length === 1 && ATTRIBUTE_DIRECT.has(root ?? "");
}
const validAttributeValue = (value: unknown): value is string | number | boolean =>
  typeof value === "boolean" || typeof value === "number" && finite(value, -1e9, 1e9) ||
  typeof value === "string" && value.length <= 256 &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const validFilterName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128 && value.trim().length > 0 &&
  !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function validInventoryName(value: unknown): value is string {
  if (!validFilterName(value)) return false;
  const trimmed = value.trim();
  const core = trimmed.slice(trimmed.startsWith("*") ? 1 : 0, trimmed.length - (trimmed.endsWith("*") ? 1 : 0));
  return core.length > 0 && !core.includes("*");
}

export const PINNABLE_COLLECTIONS = ["tokens", "tiles", "walls", "drawings", "notes", "lights", "sounds", "templates"] as const;
/** Pinned selection is exact: missing references reject, never silently shrink selection. */
export function pinnedSelectorError(scene: SceneDocument, selector: AutomationSelector): string | null {
  if (selector.kind !== "ids") return null;
  for (const ref of selector.refs) {
    const coll = ref.coll as typeof PINNABLE_COLLECTIONS[number];
    if (!PINNABLE_COLLECTIONS.includes(coll) || ref.parent?.coll !== "scenes" || ref.parent.id !== scene._id ||
        !scene[coll].some((doc) => doc._id === ref.id))
      return `Pinned entity is unavailable: ${ref.coll}/${ref.id}`;
  }
  return null;
}

/** Shared publish-time selector check for collection edits and Tagger tile targets. */
function selectorError(s: unknown, sceneId: string, tileOnly = false): string | null {
  if (!isObject(s)) return "invalid selector";
  if (s.kind === "ids") {
    return tileOnly || !keys(s, ["kind", "refs"]) || !Array.isArray(s.refs) || s.refs.length < 1 ||
      !validSceneTagRefs(s.refs, sceneId) || s.refs.some((ref) => !PINNABLE_COLLECTIONS.includes(ref.coll as typeof PINNABLE_COLLECTIONS[number]))
      ? "Pinned entities need 1–100 distinct same-scene placeable references" : null;
  }
  if (s.kind !== "tag") {
    if (tileOnly || !["triggering", "inside", "tile"].includes(String(s.kind)) || !keys(s, ["kind"]))
      return "unknown selector";
    return null;
  }
  const allowed = ["kind", "query", "mode", "pattern", "caseSensitive", "contains",
    "includeRefs", "excludeRefs", ...(!tileOnly ? ["collections"] : [])];
  if (!keys(s, allowed) ||
      !(typeof s.query === "string" || Array.isArray(s.query) &&
        s.query.every((term: unknown) => typeof term === "string")) ||
      (s.mode !== undefined && !["all", "any", "exactSet"].includes(String(s.mode))) ||
      (s.pattern !== undefined && !["literal", "wildcard", "regex"].includes(String(s.pattern))) ||
      (s.caseSensitive !== undefined && typeof s.caseSensitive !== "boolean") ||
      (s.contains !== undefined && typeof s.contains !== "boolean") ||
      (!tileOnly && s.collections !== undefined && (!Array.isArray(s.collections) || s.collections.length > 10 ||
        s.collections.some((c: unknown) => ![...TAGGABLE_COLLECTIONS, "scenes"].includes(c as TagSearchCollection)) ||
        new Set(s.collections).size !== s.collections.length)) ||
      !validSceneTagRefs(s.includeRefs, sceneId) || !validSceneTagRefs(s.excludeRefs, sceneId) ||
      (tileOnly && [...(s.includeRefs ?? []), ...(s.excludeRefs ?? [])].some((ref) => ref.coll !== "tiles")))
    return "invalid tag selector";
  try {
    // Compile/verify every pattern at publish time. Regex safety is the shared Tagger API's contract.
    tagMatcher(s.query as string | string[], {
      ...(s.mode !== undefined ? { mode: s.mode as TagMatchMode } : {}),
      ...(s.pattern !== undefined ? { pattern: s.pattern as TagPattern } : {}),
      ...(s.caseSensitive !== undefined ? { caseSensitive: s.caseSensitive as boolean } : {}),
      ...(s.contains !== undefined ? { contains: s.contains as boolean } : {}),
    });
  } catch { return "invalid or unsafe tag selector pattern"; }
  return null;
}

/** The same bounded, same-scene tile target grammar for child triggers, gate
 * changes and durable variables. This is never a client-requested graph ID. */
function tileTargetError(target: unknown, sceneId: string): string | null {
  if (!isObject(target)) return "invalid tile target";
  if (target.kind === "id") {
    return !keys(target, ["kind", "tileId"]) || typeof target.tileId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(target.tileId) ? "invalid tile target ID" : null;
  }
  if (target.kind === "current") return keys(target, ["kind"]) ? null : "invalid current tile target";
  return selectorError(target, sceneId, true);
}

/** Strict publish-time validation; an unknown action NEVER falls back to a no-op. */
export function validateAutomation(value: unknown): { ok: true; definition: AutomationDefinition } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!isObject(value) || value.version !== 1 || !nonEmptyId(value.sceneId) || !nonEmptyId(value.tileId) ||
      !Array.isArray(value.methods) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 2048 ||
      !keys(value, ["version", "sceneId", "sourceKind", "tileId", "methods", "gates", "steps"]) ||
      (value.sourceKind !== undefined && value.sourceKind !== "tile" && value.sourceKind !== "region")) return bad("automation needs version 1, scene/source, methods and 1–2048 steps");
  if (value.methods.length < 1 || value.methods.length > METHODS.length ||
      value.methods.some((m: unknown) => !METHODS.includes(m as AutomationMethod)) ||
      new Set(value.methods).size !== value.methods.length) return bad("unknown/duplicate trigger method");
  if (value.gates !== undefined) {
    const g = value.gates;
    if (!isObject(g) || !keys(g, ["paused", "playerRunnable", "oncePerToken", "cooldownMs", "chance", "maxRuns"]) ||
        [g.paused, g.playerRunnable, g.oncePerToken].some((b) => b !== undefined && typeof b !== "boolean") ||
        (g.cooldownMs !== undefined && !finite(g.cooldownMs, 0, 86_400_000)) ||
        (g.chance !== undefined && !finite(g.chance, 0, 1)) ||
        (g.maxRuns !== undefined && (!Number.isSafeInteger(g.maxRuns) || !finite(g.maxRuns, 1, 1_000_000)))) return bad("invalid trigger gates");
  }
  const ids = new Set<string>();
  const landings = new Set<string>();
  // Loops are lexical: jumps/branches may exit them, but must never enter a body
  // without an iterator frame. All named landings therefore live at depth zero.
  const loopStack: Array<{ id: string; endId: string }> = [];
  let asyncSteps = 0;
  for (const step of value.steps) {
    if (!isObject(step) || typeof step.id !== "string" || !IDENT.test(step.id) || ids.has(step.id)) return bad("step ids must be distinct identifiers");
    ids.add(step.id);
    const common = ["id", "kind"];
    switch (step.kind) {
      case "select": {
        if (!keys(step, [...common, "selector"])) return bad("invalid select step");
        const error = selectorError(step.selector, value.sceneId as string);
        if (error) return bad(error);
        break;
      }
      case "filter": {
        if (!keys(step, [...common, "test", "otherwise"]) || !isObject(step.test) ||
            (step.otherwise !== undefined && (typeof step.otherwise !== "string" || !IDENT.test(step.otherwise)))) return bad("invalid filter");
        const t = step.test;
        if (["count", "tileCount", "tokenCount"].includes(String(t.kind))) {
          if (!keys(t, ["kind", "min", "max"]) || !Number.isSafeInteger(t.min) || !finite(t.min, 0, 10_000) ||
              (t.max !== undefined && (!Number.isSafeInteger(t.max) || !finite(t.max, t.min, 10_000)))) return bad("invalid count filter");
        } else if (t.kind === "method") {
          if (!keys(t, ["kind", "method"]) || !METHODS.includes(t.method as AutomationMethod)) return bad("invalid method filter");
        } else if (t.kind === "variable") {
          if (!keys(t, ["kind", "name", "equals"]) || typeof t.name !== "string" || !IDENT.test(t.name) ||
              !["string", "number", "boolean"].includes(typeof t.equals) ||
              (typeof t.equals === "number" && !Number.isFinite(t.equals))) return bad("invalid variable filter");
        } else return bad("unknown filter");
        break;
      }
      case "checkVariable": {
        if (!keys(step, [...common, "name", "target", "mode", "compare", "value", "divisor", "remainder", "otherwise"]) ||
            typeof step.name !== "string" || !IDENT.test(step.name) || RESERVED_VARIABLES.has(step.name) ||
            (step.mode !== undefined && !["all", "any", "none"].includes(String(step.mode))) ||
            !["eq", "ne", "gt", "gte", "lt", "lte", "mod"].includes(String(step.compare)) ||
            (step.otherwise !== undefined && (typeof step.otherwise !== "string" || !IDENT.test(step.otherwise))))
          return bad("invalid Check Variable name,  aggregation or comparison");
        if (step.target !== undefined) {
          const error = tileTargetError(step.target, value.sceneId as string);
          if (error) return bad(error);
        }
        if (step.compare === "mod" ?
          step.value !== undefined || !Number.isSafeInteger(step.divisor) || !finite(step.divisor, 1, 1_000_000) ||
            !Number.isSafeInteger(step.remainder) || !finite(step.remainder, 0, (step.divisor as number) - 1) :
          step.divisor !== undefined || step.remainder !== undefined ||
            (step.value !== null && !validVariable(step.value)) ||
            (["gt", "gte", "lt", "lte"].includes(String(step.compare)) && typeof step.value !== "number"))
          return bad("Check Variable requires a typed value or bounded integer modulo/divisor");
        break;
      }
      case "checkValue": {
        if (!keys(step, [...common, "source", "compare", "value", "otherwise"]) ||
            !["darkness", "time", "direction.x", "direction.y"].includes(String(step.source)) ||
            !["eq", "ne", "gt", "gte", "lt", "lte"].includes(String(step.compare)) ||
            (step.otherwise !== undefined && (typeof step.otherwise !== "string" || !IDENT.test(step.otherwise))) ||
            (step.source === "darkness" ? !finite(step.value, 0, 1) :
              step.source === "time" ? !Number.isSafeInteger(step.value) || !finite(step.value, 0, 1439) :
                !["eq", "ne"].includes(String(step.compare)) ||
                !(step.source === "direction.x" ? ["left", "right"] : ["up", "down"]).includes(String(step.value))))
          return bad("Check Value requires committed darkness 0–1, time 0–1439, or a movement direction");
        break;
      }
      case "checkScriptResult": {
        if (!keys(step, [...common, "scriptStepId", "path", "compare", "value", "otherwise"]) ||
            typeof step.scriptStepId !== "string" || !IDENT.test(step.scriptStepId) ||
            !validScriptResultPath(step.path) ||
            !["eq", "ne", "gt", "gte", "lt", "lte"].includes(String(step.compare)) ||
            (step.value !== null && !validScriptResultValue(step.value)) ||
            (["gt", "gte", "lt", "lte"].includes(String(step.compare)) && typeof step.value !== "number") ||
            (step.otherwise !== undefined && (typeof step.otherwise !== "string" || !IDENT.test(step.otherwise))))
          return bad("Check Script Result needs a safe path, typed comparison and optional failure landing");
        break;
      }
      case "shuffle":
      case "resetHistory":
      case "batchFlush":
      case "stopOthers":
        if (!keys(step, common)) return bad(`invalid ${String(step.kind)} action`);
        break;
      case "stopMovement":
        if (!keys(step, [...common, "snapToGrid"]) || (step.snapToGrid !== undefined && typeof step.snapToGrid !== "boolean"))
          return bad("Stop Token Movement accepts only the optional Snap to Grid flag");
        break;
      case "collection": {
        if (!keys(step, [...common, "mode", "selector"]) ||
            !["add", "remove", "replace", "clear"].includes(String(step.mode)) ||
            (step.mode === "clear") !== (step.selector === undefined)) return bad("invalid collection action");
        if (step.selector !== undefined) {
          const error = selectorError(step.selector, value.sceneId as string);
          if (error) return bad(error);
        }
        break;
      }
      case "setActive":
      case "triggerTile": {
        if (step.kind === "setActive" ?
          !keys(step, [...common, "target", "mode"]) || !isObject(step.target) ||
          !["activate", "deactivate", "toggle"].includes(String(step.mode)) :
          !keys(step, [...common, "target", "tokens", "landing", "propagateStop"]) ||
          !isObject(step.target) || !["triggering", "current", "inside"].includes(String(step.tokens)) ||
          (step.landing !== undefined && (typeof step.landing !== "string" || !IDENT.test(step.landing))) ||
          (step.propagateStop !== undefined && typeof step.propagateStop !== "boolean"))
          return bad(`invalid ${String(step.kind)} action`);
        const error = tileTargetError(step.target, value.sceneId as string);
        if (error) return bad(error);
        break;
      }
      case "position":
        if (!keys(step, [...common, "index"]) || !Number.isSafeInteger(step.index) || !finite(step.index, 1, 10_000))
          return bad("position must be a 1-based collection index (1–10000)");
        break;
      case "distance":
        if (!keys(step, [...common, "from", "min", "max"]) || !["trigger", "tile"].includes(String(step.from)) ||
            (step.min !== undefined && !finite(step.min, 0, 1_000_000)) ||
            !finite(step.max, step.min === undefined ? 0 : step.min as number, 1_000_000))
          return bad("distance needs an origin and a finite scene-unit range");
        break;
      case "attributes":
      case "checkData":
        if (!keys(step, [...common, "path", "compare", "value",
          ...(step.kind === "checkData" ? ["otherwise"] : [])]) ||
            !validAttributePath(step.path) ||
            (step.kind === "checkData" && (step.path.startsWith("actor.") ||
              step.otherwise !== undefined && (typeof step.otherwise !== "string" || !IDENT.test(step.otherwise)))) ||
            !["eq", "ne", "gt", "gte", "lt", "lte", "has"].includes(String(step.compare)) ||
            !validAttributeValue(step.value) ||
            (["gt", "gte", "lt", "lte"].includes(String(step.compare)) && typeof step.value !== "number"))
          return bad("attribute check needs a safe data path and a bounded, typed comparison");
        break;
      case "condition":
        if (!keys(step, [...common, "effect", "mode"]) || !validFilterName(step.effect) ||
            !["has", "lacks"].includes(String(step.mode))) return bad("condition filter needs an exact effect name and has/lacks mode");
        break;
      case "inventory":
        if (!keys(step, [...common, "item", "compare", "count"]) || !validInventoryName(step.item) ||
            !["eq", "ne", "gt", "gte", "lt", "lte"].includes(String(step.compare)) ||
            !Number.isSafeInteger(step.count) || !finite(step.count, 0, 4096))
          return bad("inventory filter needs an item name with optional edge * and a 0–4096 item count");
        break;
      case "tokenTriggerCount":
        if (!keys(step, [...common, "compare", "count"]) ||
            !["eq", "ne", "gt", "gte", "lt", "lte"].includes(String(step.compare)) ||
            !Number.isSafeInteger(step.count) || !finite(step.count, 0, 1_000_000))
          return bad("token trigger count filter needs a 0–1000000 integer and valid comparison");
        break;
      case "routeMethod": {
        if (!keys(step, [...common, "routes", "otherwise"]) || !isObject(step.routes) ||
            Object.keys(step.routes).length < 1 || !keys(step.routes, METHODS) ||
            Object.values(step.routes).some((name) => typeof name !== "string" || !IDENT.test(name)) ||
            (step.otherwise !== undefined && (typeof step.otherwise !== "string" || !IDENT.test(step.otherwise))))
          return bad("method routes must name valid trigger methods and landings");
        break;
      }
      case "routeUser":
        if (!keys(step, [...common, "gm", "player", "otherwise"]) ||
            (step.gm === undefined && step.player === undefined) ||
            [step.gm, step.player, step.otherwise].some((name) => name !== undefined &&
              (typeof name !== "string" || !IDENT.test(name))))
          return bad("user routing needs at least one GM/player landing");
        break;
      case "forEach":
        if (!keys(step, [...common, "endId"]) || typeof step.endId !== "string" || !IDENT.test(step.endId) ||
            loopStack.length >= 8) return bad("loop needs a closing step and at most 8 nesting levels");
        loopStack.push({ id: step.id, endId: step.endId });
        break;
      case "endEach": {
        const open = loopStack.pop();
        if (!keys(step, [...common, "startId"]) || !open || step.startId !== open.id || step.id !== open.endId)
          return bad("loop closing step does not match its opening step");
        break;
      }
      case "set":
        if (!keys(step, [...common, "name", "value", "scope", "operation", "target"]) ||
            typeof step.name !== "string" || !IDENT.test(step.name) ||
            (step.scope !== undefined && !["run", "tile"].includes(String(step.scope))) ||
            (step.operation !== undefined && !["assign", "add", "delete"].includes(String(step.operation))) ||
            (step.target !== undefined && step.scope !== "tile") ||
            ((step.scope === "tile" || step.operation === "delete") && RESERVED_VARIABLES.has(step.name)) ||
            (step.operation === "delete" && Object.hasOwn(step, "value")) ||
            (step.operation !== "delete" && step.scope === "tile" && !validVariable(step.value)) ||
            (step.operation !== "delete" && step.scope !== "tile" && (!["string", "number", "boolean"].includes(typeof step.value) ||
              typeof step.value === "string" && step.value.length > 256 ||
              typeof step.value === "number" && !Number.isFinite(step.value))) ||
            (step.operation === "add" && typeof step.value !== "number"))
          return bad("invalid variable assignment/scope/operator");
        if (step.target !== undefined) {
          const error = tileTargetError(step.target, value.sceneId as string);
          if (error) return bad(error);
        }
        break;
      case "gameTime": {
        if (!keys(step, [...common, "minutes", "formula"])) return bad("invalid Game Time fields");
        const invalid = gameTimeAmountError(step);
        if (invalid) return bad(invalid);
        break;
      }
      case "hurtHeal": {
        if (!keys(step, [...common, "amount", "formula", "targets"]) ||
            !["triggering", "current"].includes(String(step.targets)))
          return bad("Hurt / Heal needs a fixed HP change or formula and a token target");
        const invalid = healthAmountError(step);
        if (invalid) return bad(`Hurt / Heal: ${invalid}`);
        break;
      }
      case "random":
        if (!keys(step, [...common, "name", "min", "max"]) || typeof step.name !== "string" || !IDENT.test(step.name) ||
            !Number.isSafeInteger(step.min) || !Number.isSafeInteger(step.max) ||
            !finite(step.min, -1e9, 1e9) || !finite(step.max, -1e9, 1e9) ||
            step.min > step.max || step.max - step.min > 1_000_000) return bad("invalid random-number range");
        break;
      case "tags":
        if (!keys(step, [...common, "edit", "tags"]) || !["add", "remove", "toggle", "replace"].includes(String(step.edit)) ||
            !Array.isArray(step.tags)) return bad("invalid tag action");
        try { normalizeTags(step.tags); } catch { return bad("invalid tags"); }
        break;
      case "visibility":
        if (!keys(step, [...common, "mode"]) || !["show", "hide", "toggle"].includes(String(step.mode)))
          return bad("invalid visibility action");
        break;
      case "door":
        if (!keys(step, [...common, "mode"]) || !["open", "close", "lock", "unlock", "toggle"].includes(String(step.mode)))
          return bad("invalid door action");
        break;
      case "sceneLighting":
        if (!keys(step, [...common, "mode", "darkness", "durationMs"]) || !["set", "add"].includes(String(step.mode)) ||
            !finite(step.darkness, step.mode === "add" ? -1 : 0, 1))
          return bad("Scene Lighting needs set/add and a bounded darkness value (set 0–1, add −1–1)");
        if (step.durationMs !== undefined && !finite(step.durationMs, 0, 60_000))
          return bad("Scene Lighting duration must be 0–60000 ms");
        break;
      case "tileImage":
        if (step.images !== undefined) {
          if (!keys(step, [...common, "images", "selection", "index", "numbers", "formula"]) || !Array.isArray(step.images) ||
              step.images.length < 1 || step.images.length > 32 ||
              step.images.some((image) => typeof image !== "string" || !/^[a-f0-9]{64}$/.test(image)) ||
              new Set(step.images).size !== step.images.length)
            return bad("Tile image list needs 1–32 distinct owned images");
          const selectionError = tileImageSelectionError(step, step.images.length);
          if (selectionError) return bad(selectionError);
          break;
        }
        if (!keys(step, [...common, "image"]) || !(step.image === "" ||
            typeof step.image === "string" && /^[a-f0-9]{64}$/.test(step.image)))
          return bad("Tile image needs an owned image hash, explicit clear, or a valid image list");
        break;
      case "sceneBackground":
        if (!keys(step, [...common, "image", "targetSceneId"]) ||
            (step.targetSceneId !== undefined && !nonEmptyId(step.targetSceneId)) || !(typeof step.image === "string" && /^[a-f0-9]{64}$/.test(step.image) ||
            step.image === null))
          return bad("World image actions need an owned image hash, or an explicit clear");
        break;
      case "move":
        if (step.destinationResult !== undefined && (step.destinationResult !== "rollTable" || step.destination !== undefined || step.destinationTag !== undefined || step.destinationOriginal !== undefined))
          return bad("Move result destination must be the last Roll Table result, without another destination");
        if (step.destinationOriginal !== undefined && (step.destinationOriginal !== true || step.destination !== undefined || step.destinationTag !== undefined || step.destinationResult !== undefined))
          return bad("Move Original Destination must be the only destination source");
        if (step.destinationChoice !== undefined && (!step.destinationTag || !["unique", "random"].includes(String(step.destinationChoice))))
          return bad("Move destination choice requires a tag destination and unique/random policy");
        if (step.destinationPosition !== undefined && (!(step.destination || step.destinationTag) || !["center", "random", "entry"].includes(String(step.destinationPosition))))
          return bad("Move destination position requires an entity/tag destination and center/random/entry policy");
        if (step.destinationTag !== undefined) {
          if (!isObject(step.destinationTag) || step.destinationTag.kind !== "tag" || selectorError(step.destinationTag, value.sceneId as string))
            return bad("Move tag destination needs a valid scene-local tag selector");
          const target = step.destinationTag as Extract<AutomationSelector, {kind: "tag"}>;
          if ((target.collections !== undefined && (target.collections.length === 0 ||
                target.collections.some((coll) => coll !== "tokens" && coll !== "tiles"))) ||
              [...(target.includeRefs ?? []), ...(target.excludeRefs ?? [])].some((ref) => ref.coll !== "tokens" && ref.coll !== "tiles") ||
              step.destination !== undefined)
            return bad("Move tag destination needs a same-scene token/tile tag selector, not an entity ID as well");
        }
        if ((step.destination !== undefined || step.destinationTag !== undefined || step.destinationResult !== undefined || step.destinationOriginal !== undefined) &&
            (step.mode !== undefined || step.xMode !== undefined || step.yMode !== undefined))
          return bad("Move entity/tag/result destinations use offset-only coordinates");
        if (step.destination !== undefined && (!isObject(step.destination) ||
            !keys(step.destination, ["coll", "id"]) || !["tokens", "tiles"].includes(String(step.destination.coll)) ||
            !nonEmptyId(step.destination.id) || step.mode !== undefined || step.xMode !== undefined || step.yMode !== undefined))
          return bad("Move entity destination needs a local token/tile ID and offset-only coordinates");
        if (step.speed !== undefined && !finite(step.speed, 0.01, 10000)) return bad("Move speed must be 0.01–10000 grid sizes per second");
        if (step.triggerTiles !== undefined && typeof step.triggerTiles !== "boolean") return bad("Move triggerTiles must be boolean");
        if (step.wallCollision !== undefined && !["ignore", "block", "footprint"].includes(String(step.wallCollision))) return bad("Move wall collision must be ignore/block/footprint");
        if (step.durationMs !== undefined && !finite(step.durationMs, 0, 60000)) return bad("Move duration must be 0–60000 milliseconds");
        if (step.snapToGrid !== undefined && typeof step.snapToGrid !== "boolean") return bad("Move snapToGrid must be boolean");
        if (!keys(step, [...common, "x", "y", "xFormula", "yFormula", "mode", "xMode", "yMode", "snapToGrid", "wallCollision", "durationMs", "speed", "triggerTiles", "destination", "destinationTag", "destinationResult", "destinationOriginal", "destinationChoice", "destinationPosition", "targets"]) ||
            (step.mode !== undefined && !["set", "add"].includes(String(step.mode))) ||
            moveCoordinatesError(step.destination || step.destinationTag || step.destinationResult || step.destinationOriginal ? { ...step, mode: "add" } : step) !== null ||
            !["triggering", "current"].includes(String(step.targets)))
          return bad("Move needs finite scene points and triggering/current targets");
        break;
      case "rotate": {
        if (!keys(step, [...common, "angle", "formula", "mode", "targets", "durationMs"]) ||
            (step.mode !== undefined && !["set", "add"].includes(String(step.mode))) ||
            !["triggering", "current"].includes(String(step.targets)))
          return bad("Rotation needs set/add mode and triggering/current targets");
        if (step.durationMs !== undefined && !finite(step.durationMs, 0, 60_000))
          return bad("Rotation duration must be 0–60000 ms");
        const invalid = rotationAngleError(step);
        if (invalid) return bad(invalid);
        break;
      }
      case "delete":
        if (!keys(step, common)) return bad("invalid delete action");
        break;
      case "rollTable": {
        if (!keys(step, [...common, "tableId", "audience", "variable"]) ||
            typeof step.tableId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(step.tableId) ||
            !["scene", "gm"].includes(String(step.audience)))
          return bad("Roll Table needs a saved table ID and a scene/gm audience");
        if (step.variable !== undefined &&
            (typeof step.variable !== "string" || !IDENT.test(step.variable) || RESERVED_VARIABLES.has(step.variable)))
          return bad("Roll Table needs a valid, non-reserved variable name");
        break;
      }
      case "chat":
        if (!keys(step, [...common, "content", "audience"]) || typeof step.content !== "string" ||
            step.content.length < 1 || step.content.length > 1000 || !["scene", "gm"].includes(String(step.audience))) return bad("invalid chat action");
        break;
      case "sequence":
        if (!keys(step, [...common, "macroId", "audience"]) || !nonEmptyId(step.macroId) ||
            !["scene", "gm"].includes(String(step.audience))) return bad("invalid sequence action");
        break;
      case "script": {
        if (!keys(step, [...common, "macroId", "args", "bindings", "runAs", "onError", "captureResult"]) ||
            typeof step.macroId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(step.macroId) ||
            (step.args !== undefined && !isObject(step.args)) ||
            (step.bindings !== undefined && !isObject(step.bindings)) ||
            (step.runAs !== undefined && !["approved", "caller", "gm"].includes(String(step.runAs))) ||
            (step.onError !== undefined && !["stop", "continue"].includes(String(step.onError))) ||
            (step.captureResult !== undefined && typeof step.captureResult !== "boolean") ||
            (step.captureResult === true && loopStack.length > 0) || ++asyncSteps > 16)
          return bad("a script action needs a saved macro, valid run-as/result/error policy; result capture must be outside loops; at most 16 post-commit actions may run per graph");
        const args = step.args as Record<string, unknown> | undefined;
        const bindings = step.bindings as Record<string, unknown> | undefined;
        if (Object.keys(args ?? {}).length + Object.keys(bindings ?? {}).length > 16 ||
            Object.entries(args ?? {}).some(([name, input]) => !INPUT_NAME.test(name) ||
              !["string", "number", "boolean"].includes(typeof input) ||
              (typeof input === "string" && input.length > 256) ||
              (typeof input === "number" && !finite(input, -1e9, 1e9))) ||
            Object.entries(bindings ?? {}).some(([name, binding]) => !INPUT_NAME.test(name) ||
              !SCRIPT_BINDINGS.includes(binding as AutomationScriptBinding) ||
              Object.hasOwn(args ?? {}, name))) return bad("invalid script inputs/bindings");
        break;
      }
      case "summon":
        if (!keys(step, [...common, "presetId", "anchor", "onError"]) ||
            typeof step.presetId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(step.presetId) ||
            !["tile", "trigger", "current"].includes(String(step.anchor)) ||
            (step.onError !== undefined && !["stop", "continue"].includes(String(step.onError))) || ++asyncSteps > 16)
          return bad("summon needs one saved preset, tile/trigger/current anchor and valid error policy; at most 16 post-commit actions");
        break;
      case "landing":
        if (loopStack.length) return bad("named landings cannot be inside a collection loop");
        if (!keys(step, [...common, "name"]) || typeof step.name !== "string" || !IDENT.test(step.name) || landings.has(step.name)) return bad("duplicate/invalid landing");
        landings.add(step.name);
        break;
      case "jump":
        if (!keys(step, [...common, "to"]) || typeof step.to !== "string" || !IDENT.test(step.to)) return bad("invalid jump");
        break;
      case "stop":
        if (!keys(step, common)) return bad("invalid stop action");
        break;
      default:
        return bad(`unsupported automation action: ${String(step.kind)}`);
    }
  }
  if (loopStack.length) return bad("collection loop is missing its closing step");
  const stepIndexes = new Map<string, number>();
  value.steps.forEach((candidate, index) => {
    if (isObject(candidate) && typeof candidate.id === "string") stepIndexes.set(candidate.id, index);
  });
  for (const [index, step] of value.steps.entries()) {
    if (isObject(step) && step.kind === "checkScriptResult") {
      const sourceIndex = stepIndexes.get(String(step.scriptStepId));
      const source = sourceIndex === undefined ? undefined : value.steps[sourceIndex];
      if (sourceIndex === undefined || sourceIndex >= index || !isObject(source) ||
          source.kind !== "script" || source.captureResult !== true)
        return bad(`Check Script Result source must be an earlier result-capturing script step: ${String(step.scriptStepId)}`);
    }
    if (!isObject(step)) continue;
    const targets = step.kind === "jump" ? [step.to]
      : step.kind === "filter" || step.kind === "routeMethod" ? (step.kind === "routeMethod"
        ? [...Object.values(step.routes as Record<string, unknown>), step.otherwise] : [step.otherwise])
      : step.kind === "routeUser" ? [step.gm, step.player, step.otherwise]
      : ["checkVariable", "checkValue", "checkData", "checkScriptResult"].includes(String(step.kind))
        ? [step.otherwise] : [];
    for (const target of targets) if (target && !landings.has(target as string)) return bad(`landing not found: ${String(target)}`);
  }
  return { ok: true, definition: value as unknown as AutomationDefinition };
}

/** History shape is bounded so a client cannot use a GM edit to create unbounded oplogs. */
export function validateAutomationState(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value) || !keys(value, ["count", "lastAt", "byToken", "recent", "variables"]) || !Number.isSafeInteger(value.count) ||
      !finite(value.count, 0, 1_000_000) || !finite(value.lastAt, 0, 9e15) || !isObject(value.byToken) ||
      Object.keys(value.byToken).length > 4096 ||
      (value.variables !== undefined && (!isObject(value.variables) ||
        Object.keys(value.variables).length > VARIABLE_LIMIT ||
        Object.entries(value.variables).some(([name, entry]) => !IDENT.test(name) ||
          RESERVED_VARIABLES.has(name) || !validVariable(entry)))) ||
      (value.recent !== undefined && (!Array.isArray(value.recent) || value.recent.length > 100 ||
        value.recent.some((entry: unknown) => !isObject(entry) ||
          !keys(entry, ["at", "method", "userId", "tokenId"]) ||
          !finite(entry.at, 0, 9e15) || !METHODS.includes(entry.method as AutomationMethod) ||
          !nonEmptyId(entry.userId) || (entry.tokenId !== undefined && !nonEmptyId(entry.tokenId)))))) return false;
  return Object.entries(value.byToken).every(([key, item]) =>
    key.length <= 128 && isObject(item) && keys(item, ["count", "lastAt"]) &&
    Number.isSafeInteger(item.count) && finite(item.count, 0, 1_000_000) && finite(item.lastAt, 0, 9e15));
}

/** Pointer hit test for the rotated rectangle, polygon, or image-alpha tile-local mask. */
export function tileContainsPoint(tile: TileDocument, point: { x: number; y: number }): boolean {
  if (tile.triggerZone?.kind === "alpha") return tileTriggerAlphaContains(tile, point);
  const polygon = tileTriggerWorldPolygon(tile);
  return polygon !== null && tileTriggerPolygonContains(polygon, point);
}

/** Convert opaque row runs into convex tile-local strips for the common continuous SAT solver. */
function alphaRunTiles(tile: TileDocument): TileDocument[] {
  const mask = tile.triggerZone;
  if (!mask || mask.kind !== "alpha") return [];
  const parts: TileDocument[] = [];
  for (let y = 0; y < mask.height; y++) for (const [start, end] of mask.rows[y] ?? []) {
    const x0 = start / mask.width, x1 = end / mask.width;
    const y0 = y / mask.height, y1 = (y + 1) / mask.height;
    parts.push({ ...tile, triggerZone: { kind: "polygon", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] } });
  }
  return parts;
}

/**
 * Sweep through the union of alpha-mask runs, merging per-strip intervals so a
 * disconnected image produces events only when the footprint enters/exits the union.
 */
function sweptAlphaTileEvents(tile: TileDocument, before: TokenDocument | undefined,
  after: TokenDocument | undefined, grid?: SceneGrid): Array<{ method: AutomationMethod; fraction: number }> {
  const parts = alphaRunTiles(tile);
  if (!parts.length || !after) return [];
  const intervals: Array<{ start: number; end: number }> = [];
  let startsInside = false, endsInside = false;
  for (const part of parts) {
    const events = sweptTileEvents(part, before, after, grid);
    if (!before) {
      if (events.some(({ method }) => method === "create")) return [{ method: "create", fraction: 1 }];
      continue;
    }
    if (events.length === 0) continue;
    const enter = events.find(({ method }) => method === "enter");
    const exit = events.find(({ method }) => method === "exit");
    const stop = events.some(({ method }) => method === "stop");
    const start = enter?.fraction ?? 0;
    const end = exit?.fraction ?? 1;
    if (!enter && (exit || stop)) startsInside = true;
    if (stop) endsInside = true;
    if (end > start + 1e-9) intervals.push({ start, end });
  }
  if (!before) return [];
  const moved = before.x !== after.x || before.y !== after.y;
  if (!moved) return before.rotation !== after.rotation && endsInside ? [{ method: "rotate", fraction: 1 }] : [];
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end + 1e-9) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  const events: Array<{ method: AutomationMethod; fraction: number }> = [];
  for (const interval of merged) {
    if (interval.start > 1e-9 || !startsInside && interval.start === 0)
      events.push({ method: "enter", fraction: interval.start });
    if (interval.end < 1 - 1e-9 || !endsInside && interval.end === 1)
      events.push({ method: "exit", fraction: interval.end });
  }
  if (endsInside) events.push({ method: "stop", fraction: 1 });
  return events;
}

/** Continuous swept-token intersection against a rotated rectangle or convex tile-local zone. */
export function sweptTileEvents(
  tile: TileDocument, before: TokenDocument | undefined, after: TokenDocument | undefined, grid?: SceneGrid,
): Array<{ method: AutomationMethod; fraction: number }> {
  if (!after || ![tile.x, tile.y, tile.width, tile.height, tile.rotation ?? 0].every(Number.isFinite) ||
      tile.width <= 0 || tile.height <= 0 || !Number.isFinite(after.x) || !Number.isFinite(after.y) ||
      (after.elevation !== undefined && !Number.isFinite(after.elevation)) ||
      tileTriggerElevationError(tile.triggerElevation) !== null ||
      (before !== undefined && (!Number.isFinite(before.x) || !Number.isFinite(before.y) ||
        (before.elevation !== undefined && !Number.isFinite(before.elevation))))) return [];
  if (tile.triggerZone?.kind === "alpha") return sweptAlphaTileEvents(tile, before, after, grid);
  const polygon = tileTriggerWorldPolygon(tile);
  if (!polygon || polygon.length < 3) return [];
  const tileCenter = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
  type Axis = { x: number; y: number };
  const tileAxes: Axis[] = polygon.map((point, i) => {
    const next = polygon[(i + 1) % polygon.length] as { x: number; y: number };
    const dx = next.x - point.x, dy = next.y - point.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: -dy / length, y: dx / length };
  });
  type TokenGeometry = { axes: Axis[]; offsets: Axis[]; radius: number };
  const isHex = grid?.type === "hex" && Number.isFinite(grid.size) && grid.size > 0 &&
    ["oddQ", "evenQ", "oddR", "evenR"].includes(grid.hexLayout);
  const geometry = (token: TokenDocument): TokenGeometry => {
    const halfWidth = Number.isFinite(token.width) && token.width > 0 ? token.width / 2 : 0;
    const halfHeight = Number.isFinite(token.height) && token.height > 0 ? token.height / 2 : 0;
    const rotation = Number.isFinite(token.rotation) ? token.rotation * Math.PI / 180 : 0;
    const offsets: Axis[] = [];
    const axes: Axis[] = [];
    if (isHex) {
      // Grid occupancy is a regular hex inscribed into the square token bounds,
      // not the full rectangular artwork. Use the same layout orientation as
      // the canvas grid renderer, including odd/even row and column layouts.
      const corners = hexCorners({ type: "hex", size: Math.min(halfWidth, halfHeight), layout: grid.hexLayout },
        { x: 0, y: 0 });
      offsets.push(...corners);
      for (let i = 0; i < 3; i++) {
        const a = corners[i] as Axis, b = corners[(i + 1) % corners.length] as Axis;
        const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
        axes.push({ x: -dy / length, y: dx / length });
      }
      // Hex-grid token occupancy follows its grid orientation, not artwork rotation.
    } else {
      const cosine = Math.cos(rotation), sine = Math.sin(rotation);
      const xAxis = { x: cosine, y: sine }, yAxis = { x: -sine, y: cosine };
      axes.push(xAxis, yAxis);
      for (const [x, y] of [[-halfWidth, -halfHeight], [halfWidth, -halfHeight],
        [halfWidth, halfHeight], [-halfWidth, halfHeight]] as const)
        offsets.push({ x: x * cosine - y * sine, y: x * sine + y * cosine });
    }
    if (axes.length === 0) axes.push({ x: 1, y: 0 }, { x: 0, y: 1 });
    return { axes, offsets, radius: Math.max(0, ...offsets.map((point) => Math.hypot(point.x, point.y))) };
  };
  const afterGeometry = geometry(after);
  const beforeGeometry = before ? geometry(before) : afterGeometry;
  // A movement normally preserves footprint. If one Op also resizes/rotates the token,
  // use the enclosing circle for the swept portion so a changing footprint cannot tunnel.
  const footprintChanged = !!before && (before.width !== after.width || before.height !== after.height ||
    (!isHex && before.rotation !== after.rotation));
  const sweptRadius = footprintChanged ? Math.max(beforeGeometry.radius, afterGeometry.radius) : undefined;
  const axes = [...tileAxes, ...afterGeometry.axes];
  const projectionRadius = (shape: TokenGeometry, axis: Axis) =>
    Math.max(0, ...shape.offsets.map((point) => Math.abs(point.x * axis.x + point.y * axis.y)));
  const tileRange = (axis: Axis) => {
    const projections = polygon.map((point) => (point.x - tileCenter.x) * axis.x + (point.y - tileCenter.y) * axis.y);
    return { min: Math.min(...projections), max: Math.max(...projections) };
  };
  const footprintRadius = (axis: Axis) => sweptRadius ?? projectionRadius(afterGeometry, axis);
  const elevationInterval = (from: number, to: number): [number, number] | null => {
    const range = tile.triggerElevation;
    if (!range) return [0, 1];
    if (from === to) return from >= range.min && from <= range.max ? [0, 1] : null;
    const a = (range.min - from) / (to - from), b = (range.max - from) / (to - from);
    const lo = Math.max(0, Math.min(a, b)), hi = Math.min(1, Math.max(a, b));
    return hi >= lo - 1e-9 ? [lo, hi] : null;
  };
  const inside = (token: TokenDocument) => {
    const elevation = token.elevation ?? 0;
    if (tile.triggerElevation && (elevation < tile.triggerElevation.min || elevation > tile.triggerElevation.max)) return false;
    const shape = geometry(token);
    const endpointAxes = [...tileAxes, ...shape.axes];
    return endpointAxes.every((axis) => {
      const range = tileRange(axis);
      const center = (token.x - tileCenter.x) * axis.x + (token.y - tileCenter.y) * axis.y;
      const radius = projectionRadius(shape, axis);
      return center + radius > range.min + 1e-9 && center - radius < range.max - 1e-9;
    });
  };
  if (!before) return inside(after) ? [{ method: "create", fraction: 1 }] : [];
  const moved = before.x !== after.x || before.y !== after.y;
  const elevationChanged = (before.elevation ?? 0) !== (after.elevation ?? 0);
  if (!moved && !elevationChanged) return before.rotation !== after.rotation && inside(after)
    ? [{ method: "rotate", fraction: 1 }] : [];

  // Continuous SAT: for each polygon/token edge normal, the valid token-center
  // positions form an expanded slab. Intersect those slabs with the movement ray.
  let lo = 0, hi = 1;
  const dx = after.x - before.x, dy = after.y - before.y;
  for (const axis of axes) {
    const range = tileRange(axis);
    const radius = footprintRadius(axis);
    const low = range.min - radius, high = range.max + radius;
    const start = (before.x - tileCenter.x) * axis.x + (before.y - tileCenter.y) * axis.y;
    const delta = dx * axis.x + dy * axis.y;
    if (Math.abs(delta) < 1e-12) {
      if (start <= low + 1e-9 || start >= high - 1e-9) return [];
      continue;
    }
    const a = (low - start) / delta;
    const b = (high - start) / delta;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
    if (lo > hi + 1e-9) return [];
  }
  if (hi < 0 || lo > 1) return [];
  const elevation = elevationInterval(before.elevation ?? 0, after.elevation ?? 0);
  if (!elevation) return [];
  lo = Math.max(lo, elevation[0]);
  hi = Math.min(hi, elevation[1]);
  if (hi < lo - 1e-9) return [];
  const from = inside(before), to = inside(after);
  const events: Array<{ method: AutomationMethod; fraction: number }> = [];
  if (!from) events.push({ method: "enter", fraction: Math.max(0, Math.min(1, lo)) });
  if (!to) events.push({ method: "exit", fraction: Math.max(0, Math.min(1, hi)) });
  if (to && moved) events.push({ method: "stop", fraction: 1 });
  if (elevationChanged) events.push({ method: "elevation", fraction: 1 });
  return events;
}

/** Resolve tag and spatial selectors against CURRENT host documents, never author-time IDs. */
function resolveContinuationTargets(scene: SceneDocument, refs: readonly DocRef[]): Target[] {
  return refs.flatMap((ref) => {
    if (ref.parent?.coll !== "scenes" || ref.parent.id !== scene._id ||
        !PINNABLE_COLLECTIONS.includes(ref.coll as typeof PINNABLE_COLLECTIONS[number])) return [];
    const collection = ref.coll as typeof PINNABLE_COLLECTIONS[number];
    const doc = scene[collection].find((item) => item._id === ref.id);
    return doc ? [{ ref, doc }] : [];
  });
}

function select(
  world: Readonly<WorldCollections>, event: AutomationEvent, selector: AutomationSelector,
): Array<{ ref: DocRef; doc: BaseDocument }> {
  const parent: DocRef = { coll: "scenes", id: event.scene._id };
  const token = (t: TokenDocument): { ref: DocRef; doc: BaseDocument } =>
    ({ ref: { coll: "tokens", id: t._id, parent }, doc: t });
  switch (selector.kind) {
    case "ids": return selector.refs.flatMap((ref) => {
      const doc = event.scene[ref.coll as typeof PINNABLE_COLLECTIONS[number]].find((item) => item._id === ref.id);
      return doc ? [{ref,doc}] : [];
    });
    case "triggering": return event.token ? [token(event.token)] : [];
    case "tile": return [{ ref: { coll: "tiles", id: event.tile._id, parent }, doc: event.tile }];
    case "inside": return event.scene.tokens.filter((t) =>
      sweptTileEvents(event.tile, undefined, t, event.scene.grid).some((e) => e.method === "create")).map(token);
    case "tag": return getByTag(world, selector.query, { sceneId: event.scene._id,
      ...(selector.mode ? { mode: selector.mode } : {}),
      ...(selector.pattern ? { pattern: selector.pattern } : {}),
      ...(selector.caseSensitive !== undefined ? { caseSensitive: selector.caseSensitive } : {}),
      ...(selector.contains !== undefined ? { contains: selector.contains } : {}),
      ...(selector.collections ? { collections: selector.collections } : {}),
      ...(selector.includeRefs ? { includeRefs: selector.includeRefs } : {}),
      ...(selector.excludeRefs ? { excludeRefs: selector.excludeRefs } : {}),
    }).map(({ ref, doc }) => ({ ref, doc }));
  }
}

/** Same bounded, scene-local targeting contract for Trigger Tile and
 * Activate/Deactivate. Resolve from staged Tagger data at the action position. */
function tileTargets(
  world: Readonly<WorldCollections>, event: AutomationEvent,
  current: ReadonlyArray<{ ref: DocRef; doc: BaseDocument }>, target: AutomationTileTarget,
): { ok: true; tiles: TileDocument[] } | { ok: false; error: string } {
  if (target.kind === "id" && !event.scene.tiles.some((tile) => tile._id === target.tileId))
    return { ok: false, error: `tile target ${target.tileId} unavailable in this scene` };
  const candidates = target.kind === "id"
    ? event.scene.tiles.filter((tile) => tile._id === target.tileId)
    : target.kind === "current"
      ? current.filter(({ ref }) => ref.coll === "tiles" && ref.parent?.id === event.scene._id)
        .flatMap(({ ref }) => event.scene.tiles.filter((tile) => tile._id === ref.id))
      : select(world, event, { ...target, collections: ["tiles"] }).map(({ doc }) => doc as TileDocument);
  // A repeated current ref must not invert a toggle twice.
  const tiles = [...new Map(candidates.map((tile) => [tile._id, tile])).values()];
  return tiles.length > 32 ? { ok: false, error: "tile target fanout exceeds 32 tiles" } : { ok: true, tiles };
}

/** Resolve Move/Rotation target tokens from the staged scene. A token deleted
 * earlier in the same plan is already gone and is never rewritten. */
function motionTargets(
  event: AutomationEvent, targets: "triggering" | "current",
  current: ReadonlyArray<Target>,
): TokenDocument[] {
  const alive = new Set(event.scene.tokens.map((item) => item._id));
  return targets === "triggering"
    ? (event.token && alive.has(event.token._id) ? [event.token] : [])
    : current
      .filter((row) => row.ref.coll === "tokens" && row.doc.type === "token")
      .map((row) => row.doc as TokenDocument)
      .filter((item) => alive.has(item._id));
}

function escapeText(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function textTemplate(text: string, values: Record<string, string | number | boolean>): string {
  return text.replace(/\{\{([a-zA-Z][\w-]{0,63})\}\}/g, (_raw, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? escapeText(values[key]) : "");
}

type Target = { ref: DocRef; doc: BaseDocument };
const ATTRIBUTE_PLACEABLES = new Set(["tokens", "tiles", "drawings", "walls"]);
/** Resolve a property descriptor, never a JS expression, getter, inherited key or
 * numeric array index. Actor paths use the host's linked actor (if it exists). */
function attributeAt(target: Target, parts: string[], actors: ReadonlyMap<string, BaseDocument>): unknown {
  let source: unknown = target.doc;
  let index = 0;
  if (parts[0] === "actor") {
    if (target.ref.coll !== "tokens") return undefined;
    const actorId = (target.doc as TokenDocument).actorId;
    source = actorId ? actors.get(actorId) : undefined;
    index = 1;
  }
  for (; index < parts.length; index++) {
    if (!isObject(source)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(source, parts[index] ?? "");
    if (!descriptor || !("value" in descriptor)) return undefined;
    source = descriptor.value;
  }
  return source;
}
type AttributePredicate = Pick<Extract<AutomationStep, { kind: "attributes" }>, "path" | "compare" | "value">;
function attributeMatches(value: unknown, step: AttributePredicate): boolean {
  if (step.compare === "has") return Array.isArray(value) && value.some((item: unknown) => item === step.value);
  // Missing and mismatched types (including object/array leaves) do not match
  // even for !=. Do not coerce strings to numbers or silently compare null.
  if (typeof value !== typeof step.value || !["string", "number", "boolean"].includes(typeof value)) return false;
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  switch (step.compare) {
    case "eq": return value === step.value;
    case "ne": return value !== step.value;
    case "gt": return typeof value === "number" && typeof step.value === "number" && value > step.value;
    case "gte": return typeof value === "number" && typeof step.value === "number" && value >= step.value;
    case "lt": return typeof value === "number" && typeof step.value === "number" && value < step.value;
    case "lte": return typeof value === "number" && typeof step.value === "number" && value <= step.value;
  }
  return false;
}
function filterByAttributes(ctx: PlanningContext, current: Target[],
  step: AttributePredicate): { ok: true; targets: Target[] } | { ok: false; error: string } {
  const parts = step.path.split("."); // validated on every graph invocation, including imported graphs
  if (parts[0] === "actor") ctx.actorIndex ??= new Map(ctx.world.actors.map((doc) => [doc._id, doc]));
  const actors = ctx.actorIndex ?? new Map<string, BaseDocument>();
  const targets: Target[] = [];
  for (const target of current) {
    if (!ATTRIBUTE_PLACEABLES.has(target.ref.coll)) return { ok: false, error: "attribute filter needs tokens, tiles, drawings or walls" };
    const value = attributeAt(target, parts, actors);
    if (typeof value === "string" && value.length > 4096 || Array.isArray(value) && value.length > 4096)
      return { ok: false, error: "attribute value exceeds 4096-character/element read budget" };
    // The graph's step budget alone cannot bound a repeated filter of 1024
    // entities with 4096-element arrays. Charge the *whole nested plan* for
    // every potential membership comparison, even if `some` returns early.
    ctx.attributeReads += step.compare === "has" && Array.isArray(value) ? Math.max(1, value.length) : 1;
    if (ctx.attributeReads > 100_000)
      return { ok: false, error: "attribute filter exceeds 100000 comparisons per plan" };
    if (attributeMatches(value, step)) targets.push(target);
  }
  return { ok: true, targets };
}

/** Actor-only MATT filters never treat an unlinked token as an empty actor.
 * Share one bounded read budget across child graphs and loop iterations. */
function filterActor(ctx: PlanningContext, target: Target): ActorDocument | undefined {
  if (target.ref.coll !== "tokens") return undefined;
  ctx.actorIndex ??= new Map(ctx.world.actors.map((doc) => [doc._id, doc]));
  const id = (target.doc as TokenDocument).actorId;
  return id ? ctx.actorIndex.get(id) as ActorDocument | undefined : undefined;
}
function chargeActorRead(ctx: PlanningContext, cost: number): boolean {
  ctx.actorFilterReads += Math.max(1, cost);
  return ctx.actorFilterReads <= 100_000;
}
function activeCondition(actor: ActorDocument, name: string, ctx: PlanningContext):
  { ok: true; found: boolean } | { ok: false; error: string } {
  const effects = actor.effects;
  if (!isObject(actor.system) ||
      Object.hasOwn(actor.system, "pf1e") && !isObject(actor.system.pf1e))
    return { ok: false, error: "condition filter actor system data is malformed" };
  const pf1e = isObject(actor.system.pf1e) ? actor.system.pf1e : {};
  const rawConditions = pf1e.conditions;
  if (!Array.isArray(effects) || effects.length > 4096 ||
      rawConditions !== undefined && (!Array.isArray(rawConditions) || rawConditions.length > 4096))
    return { ok: false, error: "condition filter actor data exceeds its 4096-record bound" };
  const conditions: unknown[] = Array.isArray(rawConditions) ? rawConditions : [];
  if (!chargeActorRead(ctx, effects.length + conditions.length))
    return { ok: false, error: "actor filter exceeds 100000 reads per plan" };
  let found = false;
  for (const effect of effects) {
    if (typeof effect?.name !== "string" || effect.name.length > 4096)
      return { ok: false, error: "condition effect name exceeds its 4096-character bound" };
    const payload = effect.flags?.pf1e?.condition;
    if (typeof payload === "string" && payload.length > 4096)
      return { ok: false, error: "condition payload exceeds its 4096-character bound" };
    if (!chargeActorRead(ctx, effect.name.length + (typeof payload === "string" ? payload.length : 0)))
      return { ok: false, error: "actor filter exceeds 100000 reads per plan" };
    if (effect.disabled !== true && (effect.name.trim().toLowerCase() === name ||
        typeof payload === "string" && payload.trim().toLowerCase() === name)) found = true;
  }
  for (const condition of conditions) {
    if (typeof condition !== "string" || condition.length > 4096)
      return { ok: false, error: "condition name exceeds its 4096-character bound" };
    if (!chargeActorRead(ctx, condition.length))
      return { ok: false, error: "actor filter exceeds 100000 reads per plan" };
    if (condition.trim().toLowerCase() === name) found = true;
  }
  return { ok: true, found };
}
function filterByCondition(ctx: PlanningContext, current: Target[],
  step: Extract<AutomationStep, { kind: "condition" }>): { ok: true; targets: Target[] } | { ok: false; error: string } {
  const name = step.effect.trim().toLowerCase();
  const targets: Target[] = [];
  for (const target of current) {
    if (target.ref.coll !== "tokens") return { ok: false, error: "condition filter needs token targets" };
    if (!chargeActorRead(ctx, 1)) return { ok: false, error: "actor filter exceeds 100000 reads per plan" };
    const actor = filterActor(ctx, target);
    if (!actor) continue; // unknown is neither "has" nor "lacks"
    const result = activeCondition(actor, name, ctx);
    if (!result.ok) return result;
    if (result.found === (step.mode === "has")) targets.push(target);
  }
  return { ok: true, targets };
}
function inventoryNameMatches(actual: string, pattern: string): boolean {
  const leading = pattern.startsWith("*"), trailing = pattern.endsWith("*");
  const name = pattern.slice(leading ? 1 : 0, pattern.length - (trailing ? 1 : 0));
  const value = actual.trim().toLowerCase();
  return leading && trailing ? value.includes(name) : leading ? value.endsWith(name) :
    trailing ? value.startsWith(name) : value === name;
}
function boundedCountMatches(actual: number,
  step: Pick<Extract<AutomationStep, { kind: "inventory" }>, "compare" | "count">): boolean {
  switch (step.compare) {
    case "eq": return actual === step.count;
    case "ne": return actual !== step.count;
    case "gt": return actual > step.count;
    case "gte": return actual >= step.count;
    case "lt": return actual < step.count;
    case "lte": return actual <= step.count;
  }
}
function filterByInventory(ctx: PlanningContext, current: Target[],
  step: Extract<AutomationStep, { kind: "inventory" }>): { ok: true; targets: Target[] } | { ok: false; error: string } {
  const pattern = step.item.trim().toLowerCase();
  const targets: Target[] = [];
  for (const target of current) {
    if (target.ref.coll !== "tokens") return { ok: false, error: "inventory filter needs token targets" };
    if (!chargeActorRead(ctx, 1)) return { ok: false, error: "actor filter exceeds 100000 reads per plan" };
    const actor = filterActor(ctx, target);
    if (!actor) continue; // not an empty inventory; fail closed for count == 0
    const items = actor.items;
    if (!Array.isArray(items) || items.length > 4096)
      return { ok: false, error: "inventory exceeds its 4096-record bound" };
    if (!chargeActorRead(ctx, items.length)) return { ok: false, error: "actor filter exceeds 100000 reads per plan" };
    let count = 0;
    for (const item of items) {
      if (typeof item?.name !== "string" || item.name.length > 4096)
        return { ok: false, error: "inventory item name exceeds its 4096-character bound" };
      if (!chargeActorRead(ctx, item.name.length))
        return { ok: false, error: "actor filter exceeds 100000 reads per plan" };
      if (inventoryNameMatches(item.name, pattern)) count++;
    }
    if (boundedCountMatches(count, step)) targets.push(target);
  }
  return { ok: true, targets };
}

type GraphOutcome = { ok: true; skipped?: string; stopped?: boolean; continuation?: AutomationContinuation } | { ok: false; error: string };
interface PlanningContext {
  /** Isolated active-scene tree and remote scene headers for the whole nested call chain. */
  world: Readonly<WorldCollections>;
  originals: Map<string, BaseDocument>;
  ops: Op[];
  cues: AutomationFx[];
  scripts: AutomationScriptCall[];
  postActions: AutomationPostAction[];
  trace: string[];
  rootAutomationId: string;
  scriptResults: Map<string, AutomationScriptResult>;
  postActionCount: number;
  histories: Map<string, AutomationState>;
  historyOps: Map<string, Extract<Op, { kind: "update" }>>;
  /** Same-envelope graph gate edits share an update with trigger history when
   * both touch a graph, so nested calls can observe the staged gate. */
  definitionOps: Map<string, Extract<Op, { kind: "update" }>>;
  /** One clock op for the entire nested plan, coalesced across Game Time steps. */
  clockOp?: Extract<Op, { kind: "update" | "create" }>;
  /** Shared by parent/children: one final appearance update per scene, staged reads stay ordered. */
  sceneAppearanceOps: Map<string, Extract<Op, { kind: "update" }>>;
  pendingTags: Map<string, { ref: DocRef; tags: string[] }>;
  pendingVisibility: Map<string, { ref: DocRef; visible: boolean }>;
  pendingDoors: Map<string, { ref: DocRef; door: 0 | 1 | 2 }>;
  stack: string[];
  steps: number;
  invocations: number;
  attributeReads: number;
  actorFilterReads: number;
  tileVariableReads: number;
  /** Shared work budget for random image selection and dice across nested calls. */
  imageSelectionRolls: number;
  healthRolls: number;
  rotationRolls: number;
  moveRolls: number;
  gameTimeRolls: number;
  tableRolls: number;
  /** Lazy index shared by every nested attribute, condition and inventory filter. */
  actorIndex?: Map<string, BaseDocument>;
  stopOthers: boolean;
  suppressedMovement: Set<string>;
  stoppedMovement: Set<string>;
}
const targetKey = (ref: DocRef) => JSON.stringify([ref.parent?.coll ?? "", ref.parent?.id ?? "", ref.coll, ref.id]);

function writeTileVariable(state: AutomationState, step: Extract<AutomationStep, { kind: "set" }>):
  { ok: true; value: string | number | boolean | undefined } | { ok: false; error: string } {
  if (step.operation === "delete") {
    if (state.variables) Reflect.deleteProperty(state.variables, step.name);
    return { ok: true, value: undefined };
  }
  const stored = state.variables ??= {};
  const prior = Object.hasOwn(stored, step.name) ? stored[step.name] : undefined;
  if (step.operation === "add" && prior !== undefined && typeof prior !== "number")
    return { ok: false, error: `variable ${step.name} is not numeric` };
  const value = step.operation === "add" ? ((prior ?? 0) as number) + (step.value as number) : step.value;
  if (!validVariable(value)) return { ok: false, error: `tile variable ${step.name} exceeds its bounds` };
  if (!Object.hasOwn(stored, step.name) && Object.keys(stored).length >= VARIABLE_LIMIT)
    return { ok: false, error: `tile variable count exceeds ${VARIABLE_LIMIT}` };
  stored[step.name] = value;
  return { ok: true, value };
}

function variableMatches(actual: string | number | boolean | null,
  step: Extract<AutomationStep, { kind: "checkVariable" }>): boolean {
  if (step.compare === "mod") {
    const divisor = step.divisor ?? 0;
    return typeof actual === "number" && Number.isSafeInteger(actual) && divisor > 0 &&
      ((actual % divisor) + divisor) % divisor === step.remainder;
  }
  if (step.compare === "eq") return actual === step.value;
  if (step.compare === "ne") return actual !== step.value;
  if (typeof actual !== "number" || typeof step.value !== "number") return false;
  switch (step.compare) {
    case "gt": return actual > step.value;
    case "gte": return actual >= step.value;
    case "lt": return actual < step.value;
    case "lte": return actual <= step.value;
  }
  return false;
}
function scriptResultPathValue(result: AutomationScriptResult, path: string):
  { found: true; value: string | number | boolean | null } | { found: false } {
  let source: unknown = result;
  for (const part of path.split(".")) {
    if (!isObject(source)) return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(source, part);
    if (!descriptor || !("value" in descriptor)) return { found: false };
    source = descriptor.value;
  }
  if (source === null || typeof source === "string" || typeof source === "boolean" ||
      typeof source === "number" && Number.isFinite(source)) return { found: true, value: source };
  return { found: false };
}
function scriptResultMatches(actual: string | number | boolean | null,
  step: Extract<AutomationStep, { kind: "checkScriptResult" }>): boolean {
  if (step.compare === "eq") return actual === step.value;
  if (step.compare === "ne") return actual !== step.value;
  if (typeof actual !== "number" || typeof step.value !== "number") return false;
  switch (step.compare) {
    case "gt": return actual > step.value;
    case "gte": return actual >= step.value;
    case "lt": return actual < step.value;
    case "lte": return actual <= step.value;
  }
  return false;
}

/** Execute the currently queued batch, not the entire graph. Within each batch,
 * edits to the same document combine; an explicit flush is an ordering barrier
 * for subsequent actions (and child graphs). The host still commits the whole
 * plan as ONE envelope so failure cannot publish a partial secret or world edit.
 * Baselines advance at each barrier: undoing an edit in a *later* batch must
 * generate an inverse update, even if it returns to the pre-graph value. */
function flushBatch(ctx: PlanningContext, sceneId: string):
  { ok: true; targets: number; updates: number } | { ok: false; error: string } {
  const touched = new Set([...ctx.pendingTags.keys(), ...ctx.pendingVisibility.keys(), ...ctx.pendingDoors.keys()]);
  if (!touched.size) return { ok: true, targets: 0, updates: 0 };
  const updates = new Map<string, Extract<Op, { kind: "update" }>>();
  const queue = (ref: DocRef, diff: Record<string, Json | null>) => {
    const id = targetKey(ref);
    const existing = updates.get(id);
    if (existing) Object.assign(existing.diff, diff);
    else updates.set(id, { kind: "update", ref, diff });
  };
  for (const { ref, tags } of ctx.pendingTags.values()) {
    const original = ctx.originals.get(targetKey(ref));
    if (!original) return { ok: false, error: `missing original tag target: ${ref.coll}/${ref.id}` };
    if (JSON.stringify(tagsOf(original)) !== JSON.stringify(tags)) queue(ref, { taggerTags: tags });
  }
  for (const { ref, visible } of ctx.pendingVisibility.values()) {
    const original = ctx.originals.get(targetKey(ref));
    if (!original) return { ok: false, error: `missing original visibility target: ${ref.coll}/${ref.id}` };
    if (original.type === "token" || original.type === "tile") {
      // A legacy tile with no hidden flag needs explicit hidden:false for inverse projection.
      if ((original as TokenDocument | TileDocument).hidden !== !visible)
        queue(ref, { hidden: !visible });
    } else {
      const note = original as NoteDocument;
      const ownerDefault = visible ? 1 : 0;
      if (note.visible !== visible || note.ownership.default !== ownerDefault)
        queue(ref, { visible, ownership: { ...note.ownership, default: ownerDefault } });
    }
  }
  for (const { ref, door } of ctx.pendingDoors.values()) {
    const original = ctx.originals.get(targetKey(ref)) as WallDocument | undefined;
    if (!original) return { ok: false, error: `missing original door target: ${ref.id}` };
    if (original.door !== door) queue(ref, { door });
  }
  if (ctx.ops.length + updates.size > 1024) return { ok: false, error: "automation exceeds 1024 world operations" };
  // Resolve the staged objects before changing any baselines; absent refs fail
  // the whole plan, including batches that were previously flushed in memory.
  const staged = new Map(listTaggable(ctx.world, { sceneId }).map(({ ref, doc }) => [targetKey(ref), doc]));
  const resolved = new Map<string, BaseDocument>();
  for (const id of touched) {
    const doc = staged.get(id);
    if (!doc) return { ok: false, error: `missing staged batch target: ${id}` };
    resolved.set(id, doc);
  }
  ctx.ops.push(...updates.values());
  for (const [id, doc] of resolved) ctx.originals.set(id, structuredClone(doc));
  ctx.pendingTags.clear();
  ctx.pendingVisibility.clear();
  ctx.pendingDoors.clear();
  return { ok: true, targets: touched.size, updates: updates.size };
}

/** Pure dry-run/plan: clone only this scene, share staged reads and budgets across
 * all nested graphs, then return ONE preflightable, undoable envelope. */
export function planAutomation(
  world: Readonly<WorldCollections>, doc: AutomationDocument, event: AutomationEvent, hostUserId: string,
  resume?: AutomationContinuation,
): AutomationOutcome {
  const trace: string[] = [];
  const fail = (error: string): AutomationOutcome => ({ ok: false, error, trace });
  const validated = validateAutomation(doc.definition);
  if (!validated.ok) return fail(validated.error);
  if (resume) {
    const source = validated.definition.steps.find((step) => step.id === resume.captureStepId);
    const sourceIndex = validated.definition.steps.findIndex((step) => step.id === resume.captureStepId);
    const budgetValues = isObject(resume.budgets) ? Object.values(resume.budgets) : [];
    if (resume.graphId !== doc._id || !Number.isSafeInteger(resume.stepIndex) ||
        resume.stepIndex !== sourceIndex + 1 || sourceIndex < 0 ||
        source?.kind !== "script" || source.captureResult !== true ||
        !Array.isArray(resume.current) || resume.current.length > 1024 ||
        resume.current.some((ref) => !isObject(ref) || !PINNABLE_COLLECTIONS.includes(ref.coll as typeof PINNABLE_COLLECTIONS[number]) ||
          ref.parent?.coll !== "scenes" || ref.parent.id !== event.scene._id || !nonEmptyId(ref.id)) ||
        !isObject(resume.values) || Object.entries(resume.values).some(([name, item]) =>
          !IDENT.test(name) || !validVariable(item)) ||
        !isObject(resume.scriptResults) || Object.keys(resume.scriptResults).length > 16 ||
        !isObject(resume.budgets) || budgetValues.length !== 11 ||
        budgetValues.some((item) => !Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 100_000) ||
        !Number.isSafeInteger(resume.postActionCount) || resume.postActionCount < 1 || resume.postActionCount > 16 ||
        !Number.isSafeInteger(resume.graphSteps) || resume.graphSteps < 1 || resume.graphSteps > 25_000 ||
        !(resume.tableResult?.present === false || resume.tableResult?.present === true &&
          (resume.tableResult.value === null || typeof resume.tableResult.value === "string" && resume.tableResult.value.length <= 256)))
      return fail("invalid or stale automation continuation");
  }
  if (!world.scenes.some((s) => s._id === event.scene._id)) return fail("scene unavailable for automation");
  const stagedScene = structuredClone(event.scene);
  const stagedWorld: Readonly<WorldCollections> = {
    ...world, scenes: world.scenes.map((s) => s._id === stagedScene._id ? stagedScene : { ...s }),
    // Share untouched definitions, copy on edit. A paused-gate action must not
    // mutate the authoritative store during dry-run or a failed child plan.
    automations: [...world.automations],
    // Hurt / Heal writes only staged actor copies; child tiles and subsequent
    // actions read those HP values without mutating the host during dry-run.
    actors: [...world.actors],
    // Game Time writes only this staged copy. Check Value (and child graphs)
    // read it in action order without exposing a speculative clock to players.
    settings: structuredClone(world.settings),
  };
  const region = validated.definition.sourceKind === "region"
    ? stagedScene.regions?.find((candidate) => candidate._id === event.tile._id) : undefined;
  const tile = validated.definition.sourceKind === "region"
    ? region ? regionTriggerTile(region) : undefined
    : stagedScene.tiles.find((candidate) => candidate._id === event.tile._id);
  if (!tile) return fail("automation source unavailable");
  const token = event.token ? stagedScene.tokens.find((t) => t._id === event.token?._id) : undefined;
  if (event.token && !token) return fail("automation token unavailable");
  const stagedEvent: AutomationEvent = { ...event, scene: stagedScene, tile,
    ...(token ? { token } : {}) };
  const ctx: PlanningContext = {
    world: stagedWorld,
    originals: new Map(listTaggable(world, { sceneId: stagedScene._id })
      .map(({ ref, doc: original }) => [targetKey(ref), original])),
    ops: [], cues: [], scripts: [], postActions: [], trace, rootAutomationId: doc._id,
    scriptResults: new Map(Object.entries(resume?.scriptResults ?? {})),
    postActionCount: resume?.postActionCount ?? 0, histories: new Map(), historyOps: new Map(),
    definitionOps: new Map(), sceneAppearanceOps: new Map(), pendingTags: new Map(), pendingVisibility: new Map(), pendingDoors: new Map(),
    stack: [], steps: resume?.budgets.steps ?? 0, invocations: resume?.budgets.invocations ?? 0,
    attributeReads: resume?.budgets.attributeReads ?? 0, actorFilterReads: resume?.budgets.actorFilterReads ?? 0,
    tileVariableReads: resume?.budgets.tileVariableReads ?? 0, imageSelectionRolls: resume?.budgets.imageSelectionRolls ?? 0,
    healthRolls: resume?.budgets.healthRolls ?? 0, rotationRolls: resume?.budgets.rotationRolls ?? 0,
    moveRolls: resume?.budgets.moveRolls ?? 0, gameTimeRolls: resume?.budgets.gameTimeRolls ?? 0,
    tableRolls: resume?.budgets.tableRolls ?? 0, stopOthers: false, suppressedMovement: new Set(), stoppedMovement: new Set(),
  };
  const result = planGraph(ctx, doc, stagedEvent, hostUserId, undefined, resume);
  if (!result.ok) return fail(result.error);
  if (result.skipped) return { ok: true, skipped: result.skipped, trace };
  const flushed = flushBatch(ctx, stagedScene._id); // implicit final batch execution
  if (!flushed.ok) return fail(flushed.error);
  if (ctx.ops.length > 1024) return fail("automation exceeds 1024 world operations");
  const state = ctx.histories.get(doc._id);
  if (!state) return fail("root graph did not record its history");
  return { ok: true, plan: { ops: ctx.ops, cues: ctx.cues, scripts: ctx.scripts,
    postActions: ctx.postActions, ...(result.continuation ? { continuation: result.continuation } : {}),
    trace, state, stopOthers: ctx.stopOthers,
    suppressedMovement: [...ctx.suppressedMovement], stoppedMovement: [...ctx.stoppedMovement] } };
}

/** A child is never committed on its own: failures discard ALL staged parent work. */
function planGraph(
  ctx: PlanningContext, doc: AutomationDocument, event: AutomationEvent, hostUserId: string,
  landing?: string, resume?: AutomationContinuation,
): GraphOutcome {
  const fail = (error: string): GraphOutcome => ({ ok: false, error });
  const { world, trace, ops, cues, scripts, postActions, pendingTags, pendingVisibility, pendingDoors } = ctx;
  const definition = validateAutomation(doc.definition);
  if (!definition.ok) return fail(definition.error);
  const d = definition.definition;
  const anchorExists = d.sourceKind === "region"
    ? event.scene.regions?.some((region) => region._id === event.tile._id) === true
    : event.scene.tiles.some((t) => t._id === event.tile._id);
  if (event.scene._id !== d.sceneId || event.tile._id !== d.tileId ||
      !anchorExists || !d.methods.includes(event.method)) return { ok: true, skipped: "method/anchor mismatch" };
  if (ctx.stack.includes(doc._id)) return fail(`trigger tile recursion: ${[...ctx.stack, doc._id].join(" -> ")}`);
  if (ctx.stack.length >= 8 || (!resume && ++ctx.invocations > 128))
    return fail("trigger tile depth/invocation budget (8/128) exceeded");
  if (resume && doc._id !== ctx.rootAutomationId)
    return fail("only the root active-zone graph can resume an awaited script result");
  if (landing && !d.steps.some((step) => step.kind === "landing" && step.name === landing))
    return fail(`landing ${landing} not found in ${doc._id}`);
  const state: AutomationState = ctx.histories.get(doc._id) ?? doc.state ?? { count: 0, lastAt: 0, byToken: {} };
  if (!validateAutomationState(state)) return fail("invalid trigger history");
  const gates = d.gates ?? {};
  const key = event.token?._id ?? `user:${event.caller.id}`;
  let nextState: AutomationState;
  if (resume) {
    // This is another segment of the same invocation; do not consume gates or history twice.
    nextState = structuredClone(state);
  } else {
    if (gates.paused) return { ok: true, skipped: "paused" };
    const history = state.byToken[key];
    if (gates.maxRuns && state.count >= gates.maxRuns) return { ok: true, skipped: "run limit" };
    if (gates.oncePerToken && history?.count) return { ok: true, skipped: "already fired for this token/user" };
    if (gates.cooldownMs && history && event.at - history.lastAt < gates.cooldownMs) return { ok: true, skipped: "cooldown" };
    if (gates.chance !== undefined && event.rng() >= gates.chance) return { ok: true, skipped: "chance gate" };
    if (state.count >= 1_000_000 || (history?.count ?? 0) >= 1_000_000)
      return fail("trigger history count cap reached; reset history before running");
    nextState = {
      count: state.count + 1,
      lastAt: event.at,
      byToken: { ...state.byToken, [key]: { count: (history?.count ?? 0) + 1, lastAt: event.at } },
      recent: [...(state.recent ?? []).slice(-99), {
        at: event.at, method: event.method, userId: event.caller.id,
        ...(event.token ? { tokenId: event.token._id } : {}),
      }],
      ...(state.variables ? { variables: { ...state.variables } } : {}),
    };
    if (Object.keys(nextState.byToken).length > 4096) return fail("trigger history cap reached; reset history before running");
  }

  ctx.histories.set(doc._id, nextState);
  let historyOp = ctx.historyOps.get(doc._id);
  if (!historyOp) {
    historyOp = ctx.definitionOps.get(doc._id);
    if (!historyOp) {
      historyOp = { kind: "update", ref: { coll: "automations", id: doc._id }, diff: {} };
      ops.push(historyOp);
    }
    ctx.historyOps.set(doc._id, historyOp);
  }
  historyOp.diff.state = nextState as unknown as Json;
  // No inherited object keys can masquerade as variables in Check Variable.
  // Event bindings always win over imported state, even on malformed worlds.
  const values: Record<string, string | number | boolean> = Object.assign(Object.create(null) as Record<string, string | number | boolean>,
    resume?.values ?? nextState.variables ?? {}, { method: event.method,
      originMethod: event.originMethod ?? event.method, originTile: event.originTileId ?? event.tile._id,
      user: event.caller.id, count: nextState.count });
  let lastTableResult: string | null | undefined = resume?.tableResult.present ? resume.tableResult.value : undefined;
  let current: Target[] = resume ? resolveContinuationTargets(event.scene, resume.current)
    : select(world, event, { kind: "triggering" });
  const landings = new Map(d.steps.flatMap((s, i) => s.kind === "landing" ? [[s.name, i] as const] : []));
  const loopEnds = new Map(d.steps.flatMap((s, i) => s.kind === "endEach" ? [[s.startId, i] as const] : []));
  type LoopFrame = { start: number; selection: Target[]; index: number;
    priorIndex: string | number | boolean | undefined; priorId: string | number | boolean | undefined };
  const frames: LoopFrame[] = [];
  const restore = (frame: LoopFrame) => {
    current = frame.selection;
    if (frame.priorIndex === undefined) delete values.index;
    else values.index = frame.priorIndex;
    if (frame.priorId === undefined) delete values.currentId;
    else values.currentId = frame.priorId;
  };
  // Landings are top-level only. Exiting a loop via a jump restores its selection
  // and interpolation context; entering its body without a frame is impossible.
  const jumpTo = (name: string) => {
    let frame: LoopFrame | undefined;
    while ((frame = frames.pop())) restore(frame);
    return landings.get(name) ?? d.steps.length;
  };
  const budget = Math.min(25_000, Math.max(10_000, d.steps.length * 16));
  let executed = resume?.graphSteps ?? 0, pc = resume?.stepIndex ?? (landing ? landings.get(landing) ?? 0 : 0);
  ctx.stack.push(doc._id);
  try {
    while (pc < d.steps.length) {
      if (++executed > budget || ++ctx.steps > 25_000)
        return fail(`automation cycle/resource budget (${budget} per graph, 25000 total steps)`);
      const step = d.steps[pc];
      if (!step) break; // defensive for imported sparse arrays
      trace.push(`${pc}: ${step.kind} [${step.id}]`);
      switch (step.kind) {
        case "select": {
          const error = pinnedSelectorError(event.scene, step.selector);
          if (error) return fail(error);
          current = select(world, event, step.selector);
          if (current.length > 1024) return fail("current collection exceeds 1024 targets");
          trace.push(`selected ${current.length} ${step.selector.kind} target(s)`);
          break;
        }
        case "filter": {
          const t = step.test;
          const count = t.kind === "count" ? current.length : t.kind === "tileCount" ? nextState.count
            : t.kind === "tokenCount" ? (nextState.byToken[key]?.count ?? 0) : 0;
          const pass = t.kind === "count" || t.kind === "tileCount" || t.kind === "tokenCount"
            ? count >= t.min && (t.max === undefined || count <= t.max)
            : t.kind === "method" ? event.method === t.method
            : t.kind === "variable" && values[t.name] === t.equals;
          if (!pass) {
            trace.push(`filter failed${step.otherwise ? ` -> ${step.otherwise}` : " (stop)"}`);
            pc = step.otherwise ? jumpTo(step.otherwise) : d.steps.length;
            continue;
          }
          break;
        }
        case "checkVariable": {
          const found: Array<string | number | boolean | null> = [];
          if (step.target === undefined) {
            found.push(Object.hasOwn(nextState.variables ?? {}, step.name)
              ? nextState.variables?.[step.name] ?? null : null);
          } else {
            const resolved = tileTargets(world, event, current, step.target);
            if (!resolved.ok) return fail(resolved.error);
            for (const tile of resolved.tiles) {
              const graphs = world.automations.filter((graph) => graph.definition?.sceneId === event.scene._id &&
                (graph.definition?.sourceKind ?? "tile") === "tile" && graph.definition?.tileId === tile._id);
              // A selected tile without any graph still has a missing (null)
              // variable. Do not silently invent a zero or pick one graph at random.
              if (!graphs.length) found.push(null);
              for (const graph of graphs) {
                const state = ctx.histories.get(graph._id) ?? graph.state;
                if (!validateAutomationState(state)) return fail(`invalid trigger history on ${graph._id}`);
                const variables = state?.variables;
                found.push(variables && Object.hasOwn(variables, step.name) ? variables[step.name] ?? null : null);
              }
              if (found.length > 128) return fail("Check Variable exceeds 128 graph values");
            }
          }
          ctx.tileVariableReads += found.length;
          if (ctx.tileVariableReads > 100_000) return fail("Check Variable exceeds 100000 nested graph reads");
          const matches = found.filter((value) => variableMatches(value, step)).length;
          const passed = found.length > 0 && (step.mode === "none" ? matches === 0
            : step.mode === "any" ? matches > 0 : matches === found.length);
          trace.push(`Check Variable ${step.name}: ${matches}/${found.length} graph value(s) match (${step.mode ?? "all"})`);
          if (!passed) {
            trace.push(`Check Variable failed${step.otherwise ? ` -> ${step.otherwise}` : " (stop)"}`);
            pc = step.otherwise ? jumpTo(step.otherwise) : d.steps.length;
            continue;
          }
          break;
        }
        case "checkValue": {
          // Start from the committed, replicated host clock; an earlier Game
          // Time action in this atomic plan is visible to later predicates.
          // Never trust Date.now() or a browser-provided clock hint.
          const clock = step.source === "time" ? worldSettingsFrom(world.settings).clockSeconds : undefined;
          if (clock !== undefined && !finite(clock, 0, 3_153_600_000))
            return fail("invalid committed world clock");
          const actual = step.source === "darkness" ? event.scene.darkness
            : step.source === "time" ? Math.floor(((clock ?? 0) % DAY_SECONDS) / MINUTE_SECONDS)
              : step.source === "direction.x" ? event.direction?.x : event.direction?.y;
          if (step.source === "darkness" && !finite(actual, 0, 1))
            return fail("invalid committed scene darkness");
          // A click/manual/create/rotation with no host-observed movement must
          // not pass even an inequality check for a missing direction.
          const pass = actual !== undefined && (
            step.compare === "eq" ? actual === step.value
              : step.compare === "ne" ? actual !== step.value
                : typeof actual === "number" && typeof step.value === "number" && (
                    step.compare === "gt" ? actual > step.value : step.compare === "gte" ? actual >= step.value
                      : step.compare === "lt" ? actual < step.value : actual <= step.value));
          trace.push(`Check Value ${step.source}: ${String(actual ?? "missing")} ${step.compare} ${String(step.value)} -> ${pass ? "pass" : "fail"}`);
          if (!pass) {
            pc = step.otherwise ? jumpTo(step.otherwise) : d.steps.length;
            continue;
          }
          break;
        }
        case "checkScriptResult": {
          const result = ctx.scriptResults.get(step.scriptStepId);
          if (!result) return fail(`script result [${step.scriptStepId}] is unavailable in this graph invocation`);
          const actual = scriptResultPathValue(result, step.path);
          const pass = actual.found && scriptResultMatches(actual.value, step);
          trace.push(`Check Script Result [${step.scriptStepId}] ${step.path}: ${actual.found ? String(actual.value) : "missing"} ${step.compare} ${String(step.value)} -> ${pass ? "pass" : "fail"}`);
          if (!pass) {
            pc = step.otherwise ? jumpTo(step.otherwise) : d.steps.length;
            continue;
          }
          break;
        }
        case "shuffle": {
          current = [...current];
          for (let i = current.length - 1; i > 0; i--) {
            const roll = event.rng();
            if (!finite(roll, 0, 1)) return fail("host RNG returned an invalid random number");
            const j = Math.floor(Math.min(roll, 1 - Number.EPSILON) * (i + 1));
            const left = current[i], right = current[j];
            if (!left || !right) return fail("invalid target collection");
            current[i] = right;
            current[j] = left;
          }
          trace.push(`shuffled ${current.length} target(s)`);
          break;
        }
        case "position":
          current = current.slice(step.index - 1, step.index);
          trace.push(`position ${step.index}: ${current.length} target(s)`);
          break;
        case "distance": {
          if (!finite(event.scene.grid.size, Number.EPSILON, 1e9) ||
              !finite(event.scene.grid.distance, Number.EPSILON, 1e9)) return fail("scene grid cannot measure distances");
          const origin = step.from === "tile" ? { x: event.tile.x + event.tile.width / 2,
            y: event.tile.y + event.tile.height / 2 } : event.token;
          if (!origin) return fail("distance filter needs a triggering token");
          if (current.some(({ doc: target }) => target.type !== "token")) return fail("distance filter needs token targets");
          const unitsPerPixel = event.scene.grid.distance / event.scene.grid.size;
          current = current.filter(({ doc: target }) => {
            const tok = target as TokenDocument;
            const distance = Math.hypot(tok.x - origin.x, tok.y - origin.y) * unitsPerPixel;
            return distance >= (step.min ?? 0) && distance <= step.max;
          });
          trace.push(`distance from ${step.from}: ${current.length} token(s) within ${step.min ?? 0}–${step.max} ${event.scene.grid.units}`);
          break;
        }
        case "attributes": {
          const result = filterByAttributes(ctx, current, step);
          if (!result.ok) return fail(result.error);
          current = result.targets;
          trace.push(`attribute filter: ${current.length} matching placeable(s)`);
          break;
        }
        case "checkData": {
          const result = filterByAttributes(ctx, [{ ref: { coll: "tiles", id: event.tile._id,
            parent: { coll: "scenes", id: event.scene._id } }, doc: event.tile }], step);
          if (!result.ok) return fail(result.error);
          const passed = result.targets.length === 1;
          trace.push(`Check Data ${step.path}: ${passed ? "pass" : "fail"}`);
          if (!passed) {
            pc = step.otherwise ? jumpTo(step.otherwise) : d.steps.length;
            continue;
          }
          break;
        }
        case "condition": {
          const result = filterByCondition(ctx, current, step);
          if (!result.ok) return fail(result.error);
          current = result.targets;
          trace.push(`condition filter: ${current.length} matching token(s)`);
          break;
        }
        case "inventory": {
          const result = filterByInventory(ctx, current, step);
          if (!result.ok) return fail(result.error);
          current = result.targets;
          trace.push(`inventory filter: ${current.length} matching token(s)`);
          break;
        }
        case "tokenTriggerCount": {
          if (current.some(({ ref }) => ref.coll !== "tokens" || ref.parent?.id !== event.scene._id))
            return fail("token trigger count filter needs scene-local token targets");
          current = current.filter(({ ref }) => boundedCountMatches(
            Object.hasOwn(nextState.byToken, ref.id) ? nextState.byToken[ref.id]?.count ?? 0 : 0, step));
          trace.push(`token trigger count filter: ${current.length} matching token(s), including this fire`);
          break;
        }
        case "routeMethod": {
          const to = step.routes[event.method] ?? step.otherwise;
          trace.push(`method ${event.method}: ${to ?? "fall through"}`);
          if (to) { pc = jumpTo(to); continue; }
          break;
        }
        case "routeUser": {
          const group = event.caller.role === "GM" || event.caller.role === "ASSISTANT" ? "gm" : "player";
          const to = step[group] ?? step.otherwise;
          trace.push(`user ${group}: ${to ?? "fall through"}`);
          if (to) { pc = jumpTo(to); continue; }
          break;
        }
        case "forEach": {
          if (current.length > 1024) return fail("collection loop exceeds 1024 targets");
          if (!current.length) {
            trace.push("empty collection: skip loop");
            pc = (loopEnds.get(step.id) ?? d.steps.length) + 1;
            continue;
          }
          const first = current[0];
          if (!first) return fail("invalid target collection");
          const frame: LoopFrame = { start: pc, selection: [...current], index: 0,
            priorIndex: values.index, priorId: values.currentId };
          frames.push(frame);
          current = [first];
          values.index = 1;
          values.currentId = first.ref.id;
          trace.push(`loop 1/${frame.selection.length}: ${values.currentId}`);
          break;
        }
        case "endEach": {
          const frame = frames.at(-1);
          if (!frame || d.steps[frame.start]?.id !== step.startId) return fail("invalid runtime loop frame");
          if (++frame.index < frame.selection.length) {
            const target = frame.selection[frame.index];
            if (!target) return fail("invalid target collection");
            current = [target];
            values.index = frame.index + 1;
            values.currentId = target.ref.id;
            trace.push(`loop ${values.index}/${frame.selection.length}: ${values.currentId}`);
            pc = frame.start + 1;
            continue;
          }
          frames.pop();
          restore(frame);
          break;
        }
        case "resetHistory":
          nextState.count = 0;
          nextState.lastAt = 0;
          nextState.byToken = {};
          nextState.recent = [];
          values.count = 0;
          trace.push("cleared tile and token trigger counts/recent history");
          break;
        case "batchFlush": {
          const flushed = flushBatch(ctx, event.scene._id);
          if (!flushed.ok) return fail(flushed.error);
          trace.push(`batch executed: ${flushed.targets} target(s), ${flushed.updates} combined world update(s)`);
          break;
        }
        case "collection": {
          const error = step.selector ? pinnedSelectorError(event.scene, step.selector) : null;
          if (error) return fail(error);
          const selected = step.selector ? select(world, event, step.selector) : [];
          if (selected.length > 1024) return fail("current collection exceeds 1024 targets");
          const matching = new Set(selected.map(({ ref }) => targetKey(ref)));
          if (step.mode === "clear") current = [];
          else if (step.mode === "replace") current = [...selected];
          else if (step.mode === "remove") current = current.filter(({ ref }) => !matching.has(targetKey(ref)));
          else {
            const seen = new Set(current.map(({ ref }) => targetKey(ref)));
            current = [...current, ...selected.filter(({ ref }) => {
              const key = targetKey(ref);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })];
          }
          if (current.length > 1024) return fail("current collection exceeds 1024 targets");
          trace.push(`collection ${step.mode}: ${current.length} target(s)`);
          break;
        }
        case "setActive": {
          const resolved = tileTargets(world, event, current, step.target);
          if (!resolved.ok) return fail(resolved.error);
          let changed = 0;
          for (const tile of resolved.tiles) {
            for (const [index, graph] of world.automations.entries()) {
              if (graph.definition?.sceneId !== event.scene._id || (graph.definition?.sourceKind ?? "tile") !== "tile" ||
                  graph.definition?.tileId !== tile._id) continue;
              const checked = validateAutomation(graph.definition);
              if (!checked.ok) return fail(`tile ${tile._id} graph ${graph._id}: ${checked.error}`);
              const paused = graph.definition.gates?.paused === true;
              const nextPaused = step.mode === "toggle" ? !paused : step.mode === "deactivate";
              if (paused === nextPaused) continue;
              const definition = { ...graph.definition, gates: { ...graph.definition.gates, paused: nextPaused } };
              // Only the staged array changes until the entire root and all
              // post-action preflight checks succeed. Other graphs called later
              // in this SAME plan see the new gate immediately.
              world.automations[index] = { ...graph, definition };
              let update = ctx.definitionOps.get(graph._id);
              if (!update) {
                if (ctx.definitionOps.size >= 128) return fail("graph activation exceeds 128 graph edits");
                update = ctx.historyOps.get(graph._id) ?? { kind: "update", ref: { coll: "automations", id: graph._id }, diff: {} };
                if (!ctx.historyOps.has(graph._id)) {
                  if (ops.length >= 1024) return fail("automation exceeds 1024 world operations");
                  ops.push(update);
                }
                ctx.definitionOps.set(graph._id, update);
              }
              update.diff.definition = definition as unknown as Json;
              changed++;
            }
          }
          trace.push(`${step.mode} ${changed} graph(s) on ${resolved.tiles.length} tile(s); staged gate only, no visibility change`);
          break;
        }
        case "triggerTile": {
          const resolved = tileTargets(world, event, current, step.target);
          if (!resolved.ok) return fail(resolved.error);
          trace.push(`trigger tile ${step.target.kind}: ${resolved.tiles.length} tile(s)`);
          for (const tile of resolved.tiles) {
            const tokens: Array<TokenDocument | undefined> = step.tokens === "triggering"
              ? [event.token] : step.tokens === "inside"
                ? select(world, { ...event, tile }, { kind: "inside" }).map(({ doc }) => doc as TokenDocument)
                : current.filter(({ ref }) => ref.coll === "tokens" && ref.parent?.id === event.scene._id)
                  .map(({ doc }) => doc as TokenDocument);
            if (tokens.length > 32) return fail("trigger tile token fanout exceeds 32 tokens");
            const children = world.automations.filter((child) => child.definition?.sceneId === event.scene._id &&
              (child.definition?.sourceKind ?? "tile") === "tile" && child.definition?.tileId === tile._id).sort((a, b) => a._id.localeCompare(b._id));
            for (const token of tokens) {
              for (const child of children) {
                const checked = validateAutomation(child.definition);
                if (!checked.ok) return fail(`trigger tile ${child._id}: ${checked.error}`);
                if (!checked.definition.methods.includes("manual")) continue;
                trace.push(`tile ${tile._id} -> graph ${child._id}${token ? ` [${token._id}]` : ""}`);
                const result = planGraph(ctx, child, { scene: event.scene, tile, caller: event.caller,
                  at: event.at, rng: event.rng, method: "manual",
                  originMethod: event.originMethod ?? event.method, originTileId: event.originTileId ?? event.tile._id,
                  ...(event.direction ? { direction: event.direction } : {}),
                  ...(event.movementOriginal ? { movementOriginal: event.movementOriginal } : {}),
                  ...(event.imageAssetError ? { imageAssetError: event.imageAssetError } : {}),
                  ...(event.hurtHeal ? { hurtHeal: event.hurtHeal } : {}),
                  ...(token ? { token } : {}) }, hostUserId, step.landing);
                if (!result.ok) return result;
                if (result.skipped) trace.push(`graph ${child._id} skipped: ${result.skipped}`);
                if (step.propagateStop && result.stopped) return { ok: true, stopped: true };
              }
            }
          }
          break;
        }
        case "stopOthers":
          ctx.stopOthers = true;
          trace.push("suppress later movement tiles after commit");
          break;
        case "stopMovement": {
          const crossing = event.movementCrossing;
          if ((event.method !== "enter" && event.method !== "exit") || !event.token || !crossing ||
              crossing.tileId !== event.tile._id || crossing.tokenId !== event.token._id || crossing.method !== event.method ||
              !Number.isFinite(crossing.fraction) || crossing.fraction < 0 || crossing.fraction > 1 ||
              !finite(crossing.x, 0, event.scene.width) || !finite(crossing.y, 0, event.scene.height))
            return fail("Stop Token Movement requires this tile's host-observed enter/exit crossing");
          const flushed = flushBatch(ctx, event.scene._id);
          if (!flushed.ok) return fail(flushed.error);
          const target = event.scene.tokens.find((token) => token._id === event.token?._id);
          if (!target) return fail("Stop Token Movement triggering token is unavailable");
          const geometry = moveGeometry(target);
          if (!geometry) return fail("Stop Token Movement token geometry is invalid");
          let point = {x:crossing.x,y:crossing.y};
          if (step.snapToGrid && event.scene.grid.type !== "gridless") {
            const grid = event.scene.grid;
            if (!finite(grid.size, Number.EPSILON, 1e9) ||
                (grid.type === "hex" && !["oddQ", "evenQ", "oddR", "evenR"].includes(grid.hexLayout)))
              return fail("Stop Token Movement cannot snap to an invalid grid");
            point = snapTokenCenter(grid.type === "hex" ? {type:"hex",size:grid.size,layout:grid.hexLayout}
              : {type:"square",size:grid.size}, point.x, point.y);
          }
          if (!finite(point.x, 0, event.scene.width) || !finite(point.y, 0, event.scene.height))
            return fail("Stop Token Movement endpoint is outside the scene");
          if (ctx.ops.length >= 1024) return fail("automation exceeds 1024 world operations");
          if (target.x !== point.x || target.y !== point.y) {
            const diff = applyMovePosition(target, geometry, point.x, point.y);
            if (target.flags.arenaMove !== undefined) { target.flags = {...target.flags,arenaMove:{}}; diff["flags.arenaMove"] = {}; }
            ctx.ops.push({kind:"update",ref:{coll:"tokens",id:target._id,parent:{coll:"scenes",id:event.scene._id}},diff});
          }
          ctx.suppressedMovement.add(`${event.scene._id}\u0000${target._id}`);
          ctx.stoppedMovement.add(`${event.scene._id}\u0000${target._id}`);
          trace.push(`stopped triggering token at ${point.x},${point.y}${step.snapToGrid ? " (grid snapped)" : ""}`);
          break;
        }
        case "set": {
          if (step.scope === "tile" && step.target) {
            const resolved = tileTargets(world, event, current, step.target);
            if (!resolved.ok) return fail(resolved.error);
            let changed = 0;
            for (const tile of resolved.tiles) {
              // A tile can own multiple graphs; each has its own private
              // variable map. The same graph reached by multiple tiles or
              // calls is updated once per *action*, in deterministic ID order.
              const graphs = world.automations.filter((graph) => graph.definition?.sceneId === event.scene._id &&
                (graph.definition?.sourceKind ?? "tile") === "tile" && graph.definition?.tileId === tile._id).sort((a, b) => a._id.localeCompare(b._id));
              for (const graph of graphs) {
                const checked = validateAutomation(graph.definition);
                if (!checked.ok) return fail(`tile ${tile._id} graph ${graph._id}: ${checked.error}`);
                let state = ctx.histories.get(graph._id);
                if (!state) {
                  if (ctx.histories.size >= 128) return fail("tile variable targeting exceeds 128 graph states");
                  if (!validateAutomationState(graph.state)) return fail(`invalid trigger history on ${graph._id}`);
                  state = structuredClone(graph.state ?? { count: 0, lastAt: 0, byToken: {} });
                }
                const written = writeTileVariable(state, step);
                if (!written.ok) return fail(written.error);
                ctx.histories.set(graph._id, state);
                let update = ctx.historyOps.get(graph._id);
                if (!update) {
                  update = ctx.definitionOps.get(graph._id) ??
                    { kind: "update", ref: { coll: "automations", id: graph._id }, diff: {} };
                  if (!ctx.definitionOps.has(graph._id)) {
                    if (ops.length >= 1024) return fail("automation exceeds 1024 world operations");
                    ops.push(update);
                  }
                  ctx.historyOps.set(graph._id, update);
                }
                update.diff.state = state as unknown as Json;
                if (graph._id === doc._id) {
                  if (written.value === undefined) Reflect.deleteProperty(values, step.name);
                  else values[step.name] = written.value;
                }
                changed++;
              }
            }
            trace.push(`tile variable ${step.name} ${step.operation === "delete" ? "deleted" : step.operation === "add" ? "+=" : "="} on ${changed} graph(s) of ${resolved.tiles.length} tile(s) (private)`);
            break;
          }
          if (step.scope === "tile") {
            // A run-local shadow cannot change the base of a durable counter.
            const written = writeTileVariable(nextState, step);
            if (!written.ok) return fail(written.error);
            if (written.value === undefined) Reflect.deleteProperty(values, step.name);
            else values[step.name] = written.value;
            trace.push(`tile variable ${step.name} ${step.operation === "delete" ? "deleted" : step.operation === "add" ? "+=" : "="} (private)`);
            break;
          }
          if (step.operation === "delete") {
            Reflect.deleteProperty(values, step.name);
            trace.push(`run variable ${step.name} deleted`);
            break;
          }
          const prior = values[step.name];
          if (step.operation === "add" && prior !== undefined && typeof prior !== "number")
            return fail(`variable ${step.name} is not numeric`);
          const value = step.operation === "add" ? ((prior ?? 0) as number) + (step.value as number) : step.value;
          if (typeof value === "number" && !Number.isFinite(value)) return fail(`variable ${step.name} overflowed`);
          if (value === undefined) return fail(`variable ${step.name} needs a value`);
          values[step.name] = value;
          break;
        }
        case "gameTime": {
          const old = worldSettingsFrom(world.settings).clockSeconds;
          if (old !== undefined && !finite(old, 0, 3_153_600_000))
            return fail("invalid committed world clock");
          const amount = resolveGameTimeAmount(step, () => {
            if (++ctx.gameTimeRolls > 1024) throw new Error("Game Time formulas exceed 1024 random draws per graph plan");
            return event.rng();
          });
          if (!amount.ok) return fail(amount.error);
          const minutes = amount.value;
          const next = (old ?? 0) + minutes * MINUTE_SECONDS;
          if (!finite(next, 0, 3_153_600_000))
            return fail("Game Time would move the world clock outside 0–3153600000 seconds");
          let settings = world.settings.find((item) => item._id === WORLD_SETTINGS_ID);
          if (!ctx.clockOp) {
            if (ops.length >= 1024) return fail("automation exceeds 1024 world operations");
            if (settings) {
              ctx.clockOp = { kind: "update", ref: { coll: "settings", id: WORLD_SETTINGS_ID },
                diff: { "system.clockSeconds": next } };
            } else {
              settings = worldSettingsDoc({ clockSeconds: next });
              world.settings.push(settings);
              ctx.clockOp = { kind: "create", coll: "settings", data: settings };
            }
            ops.push(ctx.clockOp);
          } else if (!settings) return fail("staged world clock document disappeared");
          if (settings) settings.system.clockSeconds = next;
          if (ctx.clockOp.kind === "create") ctx.clockOp.data.system.clockSeconds = next;
          else ctx.clockOp.diff["system.clockSeconds"] = next;
          // Legacy worlds may contain later-sorted settings docs. Never claim
          // the time advanced if one of them shadows the canonical clock.
          if (worldSettingsFrom(world.settings).clockSeconds !== next)
            return fail("a noncanonical settings document overrides the world clock");
          trace.push(`Game Time ${minutes >= 0 ? "+" : ""}${minutes} minute(s) -> ${next} host seconds`);
          break;
        }
        case "hurtHeal": {
          if (!event.hurtHeal) return fail("Hurt / Heal has no configured system health adapter");
          const targets = step.targets === "triggering"
            ? event.token ? [event.token] : []
            : current.filter((row) => row.ref.coll === "tokens" && row.doc.type === "token")
              .map((row) => row.doc as TokenDocument);
          if (!targets.length || targets.length > 32)
            return fail("Hurt / Heal requires 1–32 targeted tokens");
          const actorIds: string[] = [];
          for (const token of targets) {
            if (!token.actorId) return fail("Hurt / Heal requires linked actor HP on every token");
            if (!actorIds.includes(token.actorId)) actorIds.push(token.actorId);
          }
          ctx.actorIndex ??= new Map(world.actors.map((actor) => [actor._id, actor]));
          for (const id of actorIds) {
            const actor = ctx.actorIndex.get(id) as ActorDocument | undefined;
            if (!actor) return fail(`Hurt / Heal actor ${id} is missing`);
            const amount = resolveHealthAmount(step, () => {
              if (++ctx.healthRolls > 1024) throw new Error("HP formulas exceed 1024 random draws per graph plan");
              return event.rng();
            });
            if (!amount.ok) return fail(`Hurt / Heal: ${amount.error}`);
            const planned = event.hurtHeal(actor, amount.value);
            if (!planned.ok) return fail(`Hurt / Heal ${actor.name}: ${planned.error}`);
            if (Object.keys(planned.diff).length) {
              if (ops.length >= 1024) return fail("automation exceeds 1024 world operations");
              const updated = applyDiff(actor, planned.diff);
              if (!updated.ok) return fail(`Hurt / Heal ${actor.name}: ${updated.error}`);
              const index = world.actors.findIndex((item) => item._id === id);
              if (index < 0) return fail(`Hurt / Heal actor ${id} disappeared`);
              world.actors[index] = updated.value;
              ctx.actorIndex.set(id, updated.value);
              ops.push({ kind: "update", ref: { coll: "actors", id }, diff: planned.diff });
            }
            trace.push(`Hurt / Heal ${actor.name}: ${planned.note}`);
          }
          break;
        }
        case "random": {
          const roll = event.rng();
          if (!finite(roll, 0, 1)) return fail("host RNG returned an invalid random number");
          values[step.name] = step.min + Math.floor(Math.min(roll, 1 - Number.EPSILON) * (step.max - step.min + 1));
          trace.push(`${step.name} = ${values[step.name]} (host roll)`);
          break;
        }
        case "tags": {
          trace.push(`tag edit ${step.edit}: ${current.length} target(s)`);
          for (const { ref, doc: target } of current) {
            if (ref.coll !== "scenes" && !TAGGABLE_COLLECTIONS.includes(ref.coll as typeof TAGGABLE_COLLECTIONS[number])) return fail(`untaggable target: ${ref.coll}`);
            const id = targetKey(ref);
            const old = tagsOf(target);
            try {
              const tags = step.edit === "replace" ? normalizeTags(step.tags) : step.edit === "add"
                ? normalizeTags([...old, ...step.tags])
                : step.edit === "remove" ? old.filter((tag) => !step.tags.includes(tag))
                : normalizeTags([...old.filter((tag) => !step.tags.includes(tag)), ...step.tags.filter((tag) => !old.includes(tag))]);
              target.taggerTags = tags; // staged scene only; later selectors and children see the edit
              pendingTags.set(id, { ref, tags });
            } catch (cause) {
              return fail(`tag edit failed on ${ref.coll}/${ref.id}: ${cause instanceof Error ? cause.message : "invalid tags"}`);
            }
          }
          break;
        }
        case "visibility": {
          trace.push(`${step.mode} ${current.length} token/tile/pin target(s)`);
          for (const { ref, doc: target } of current) {
            if ((ref.coll !== "tokens" || target.type !== "token") &&
                (ref.coll !== "tiles" || target.type !== "tile") &&
                (ref.coll !== "notes" || target.type !== "note"))
              return fail(`visibility needs a token, tile or map pin, not ${ref.coll}`);
            const id = targetKey(ref);
            // Legacy pins/tiles with no explicit flag follow scene ownership and are visible by default.
            const old = target.type === "token" || target.type === "tile"
              ? !(target as TokenDocument | TileDocument).hidden : (target as NoteDocument).visible !== false;
            const visible = step.mode === "toggle" ? !old : step.mode === "show";
            if (target.type === "token" || target.type === "tile") (target as TokenDocument | TileDocument).hidden = !visible;
            else {
              (target as NoteDocument).visible = visible;
              target.ownership.default = visible ? 1 : 0;
            }
            pendingVisibility.set(id, { ref, visible });
          }
          break;
        }
        case "door": {
          trace.push(`door ${step.mode}: ${current.length} wall target(s)`);
          for (const { ref, doc: target } of current) {
            if (ref.coll !== "walls" || target.type !== "wall" || !isDoorWall(target as WallDocument))
              return fail(`door action requires a conditional-axis wall, not ${ref.coll}/${ref.id}`);
            const wall = target as WallDocument;
            const id = targetKey(ref);
            const old = wall.door;
            if (![0, 1, 2].includes(old)) return fail(`invalid door state on ${ref.id}`);
            if (old === 2 && ["toggle", "open", "close"].includes(step.mode))
              return fail(`locked door ${ref.id}: explicitly unlock it first`);
            const door: 0 | 1 | 2 = step.mode === "lock" ? 2 : step.mode === "unlock" ? (old === 2 ? 0 : old)
              : step.mode === "close" ? 0 : step.mode === "open" ? 1 : old === 0 ? 1 : 0;
            wall.door = door;
            pendingDoors.set(id, { ref, door });
          }
          break;
        }
        case "sceneLighting":
        case "sceneBackground": {
          const target = step.kind === "sceneBackground" && step.targetSceneId
            ? world.scenes.find((scene) => scene._id === step.targetSceneId) : event.scene;
          if (!target) return fail("Scene Background target scene is unavailable");
          let diff: Record<string, Json>;
          if (step.kind === "sceneLighting") {
            if (!finite(event.scene.darkness, 0, 1)) return fail("invalid committed scene darkness");
            const darkness = step.mode === "add" ? event.scene.darkness + step.darkness : step.darkness;
            if (!finite(darkness, 0, 1)) return fail("Scene Lighting would move darkness outside 0–1");
            trace.push(`Scene Lighting: ${event.scene.darkness} -> ${darkness}`);
            if (event.scene.darkness === darkness) break;
            event.scene.darkness = darkness;
            diff = { darkness };
            if (step.durationMs !== undefined) {
              const hint = { darkness, durationMs: step.durationMs };
              event.scene.flags = { ...event.scene.flags, arenaDarkness: hint };
              diff["flags.arenaDarkness"] = hint;
            } else if (event.scene.flags.arenaDarkness !== undefined) {
              event.scene.flags = { ...event.scene.flags, arenaDarkness: {} };
              diff["flags.arenaDarkness"] = {};
            }
          } else {
            if (step.image !== null) {
              const error = event.imageAssetError ? event.imageAssetError(step.image) : "image asset validation unavailable";
              if (error) return fail(`Scene Background: ${error}`);
            }
            trace.push(`Scene Background: ${step.image === null ? "clear" : "owned image"}`);
            if (target.img === step.image) break;
            target.img = step.image;
            diff = { img: step.image };
          }
          let appearance = ctx.sceneAppearanceOps.get(target._id);
          if (!appearance) {
            if (ops.length >= 1024) return fail("automation exceeds 1024 world operations");
            appearance = { kind: "update", ref: { coll: "scenes", id: target._id }, diff: {} };
            ctx.sceneAppearanceOps.set(target._id, appearance);
            ops.push(appearance);
          }
          Object.assign(appearance.diff, diff);
          break;
        }
        case "tileImage": {
          // Validate the complete authored list, not only today's selected image: a
          // revoked/missing alternative must not silently remain in a published action.
          for (const image of step.images ?? (step.image ? [step.image] : [])) {
            const error = event.imageAssetError ? event.imageAssetError(image) : "image asset validation unavailable";
            if (error) return fail(`Switch Tile Image: ${error}`);
          }
          if (current.length < 1 || current.length > 32 || current.some(({ ref, doc }) => ref.coll !== "tiles" || doc.type !== "tile"))
            return fail("Switch Tile Image needs 1–32 current tiles");
          if (ops.length + current.length > 1024) return fail("automation exceeds 1024 world operations");
          for (const { ref, doc } of current) {
            const target = doc as TileDocument;
            let image = step.image ?? "";
            if (step.images) {
              const selected = resolveTileImageIndex(step, step.images.indexOf(target.img), () => {
                if (++ctx.imageSelectionRolls > 1024) throw new Error("image selection exceeds 1024 random draws per graph plan");
                return event.rng();
              });
              if (!selected.ok) return fail(`Switch Tile Image: ${selected.error}`);
              const chosen = step.images[selected.value];
              if (!chosen) return fail("Switch Tile Image selected an unavailable slot");
              image = chosen;
            }
            if (target.img === image) continue;
            target.img = image;
            ops.push({ kind: "update", ref, diff: { img: image } });
          }
          trace.push(`Switch Tile Image: ${current.length} tile(s), ${step.images ? step.selection : step.image === "" ? "clear" : "owned image"}`);
          break;
        }
        case "move": {
          try {
            // Snapshot the destination once per action, so selecting it as a mover cannot
            // change the anchor for later targets. Earlier steps/children remain visible.
            const moveRandom = () => {
              if (++ctx.moveRolls > 1024) throw new Error("Move exceeds 1024 random draws per graph plan");
              const roll = event.rng();
              if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new Error("Move received invalid host RNG");
              return roll;
            };
            let destinationSnapshot: MoveDestinationSnapshot | undefined;
            if (step.destinationOriginal) {
              const originMethod = event.originMethod ?? event.method;
              if (!event.token || event.movementOriginal?.tokenId !== event.token._id ||
                  !["enter", "exit", "stop", "elevation"].includes(originMethod) ||
                  (!finite(event.movementOriginal.x, 0, event.scene.width) || !finite(event.movementOriginal.y, 0, event.scene.height)))
                return fail("Move Original Destination requires the triggering token's host-observed movement event");
              destinationSnapshot = {x:event.movementOriginal.x,y:event.movementOriginal.y};
            } else if (step.destinationResult) {
              if (lastTableResult === undefined) return fail("Move needs a Roll Table result from this graph invocation");
              const point = moveTableLocation(lastTableResult);
              if (!point) return fail('Move Roll Table result must contain exactly numeric {"x":...,"y":...} coordinates (0–1000000000, at most 256 characters)');
              destinationSnapshot = point;
            } else if (step.destination || step.destinationTag) {
              let destination: TokenDocument | TileDocument | undefined;
              if (step.destinationTag) {
                const matches = select(world, event, { ...step.destinationTag,
                  collections: step.destinationTag.collections ?? ["tokens", "tiles"] });
                if (matches.length > 1024) return fail("Move tag destination exceeds 1024 candidates");
                if (!matches.length || (step.destinationChoice !== "random" && matches.length !== 1))
                  return fail(`Move tag destination must match ${step.destinationChoice === "random" ? "at least" : "exactly"} one token or tile (matched ${matches.length})`);
                // One chosen destination per action, independent placement points per mover.
                const match = matches[step.destinationChoice === "random" && matches.length > 1 ? Math.floor(moveRandom() * matches.length) : 0];
                // Read the staged document again; neither a cached selection nor the client is authoritative.
                if (match?.ref.coll === "tokens" || match?.ref.coll === "tiles")
                  destination = event.scene[match.ref.coll].find((item) => item._id === match.ref.id);
              } else if (step.destination) {
                destination = event.scene[step.destination.coll].find((item) => item._id === step.destination?.id);
              }
              if (!destination) return fail("Move destination entity is unavailable in this scene");
              const snapshot = snapshotMoveDestination(destination);
              if (!snapshot) return fail("Move destination has invalid geometry");
              destinationSnapshot = snapshot;
            }
            const parent: DocRef = { coll: "scenes", id: event.scene._id };
            const selected = step.targets === "triggering"
              ? motionTargets(event, "triggering", current).map((doc) => ({ ref: { coll: "tokens" as const, id: doc._id, parent }, doc }))
              : current;
            if (!selected.length) return fail("Move needs at least one live target token, tile, drawing, light, sound or template");
            const targets = new Map<string, { ref: DocRef; doc: MovePlaceable }>();
            for (const row of selected) {
              const list = MOVABLE_COLLECTIONS.includes(row.ref.coll as typeof MOVABLE_COLLECTIONS[number])
                ? event.scene[row.ref.coll as typeof MOVABLE_COLLECTIONS[number]] : null;
              if (!list) return fail("Move only supports tokens and tiles, drawings, lights, sounds and templates");
              const doc = list.find((item) => item._id === row.ref.id);
              if (!doc) return fail("Move target is no longer in the scene");
              targets.set(`${row.ref.coll}/${doc._id}`, { ref: { coll: row.ref.coll, id: doc._id, parent }, doc });
            }
            if (ops.length + targets.size > 1024) return fail("automation exceeds 1024 world operations");
            for (const { ref, doc } of targets.values()) {
              const geometry = moveGeometry(doc);
              if (!geometry) return fail("Move target has invalid committed geometry");
              const {x: oldX, y: oldY, dx, dy} = geometry;
              const animated = doc.type === "token" || doc.type === "tile";
              const anchor = destinationSnapshot ? moveDestinationPoint(destinationSnapshot, step.destinationPosition ?? "center", moveRandom,
                event.method === "enter" && event.movementEntry?.tileId === event.tile._id &&
                  event.movementEntry.tokenId === event.token?._id ? event.movementEntry : undefined) : undefined;
              const coordinates = resolveMoveCoordinates(anchor || step.destinationOriginal ? { ...step, mode: "add" } : step, moveRandom);
              if (!coordinates.ok) return fail(coordinates.error);
              let x = anchor || step.destinationOriginal ? (anchor?.x ?? destinationSnapshot?.x ?? 0) + coordinates.value.x - dx : (step.xMode ?? step.mode) === "add" ? oldX + coordinates.value.x : coordinates.value.x - dx;
              let y = anchor || step.destinationOriginal ? (anchor?.y ?? destinationSnapshot?.y ?? 0) + coordinates.value.y - dy : (step.yMode ?? step.mode) === "add" ? oldY + coordinates.value.y : coordinates.value.y - dy;
              if (step.snapToGrid && event.scene.grid.type !== "gridless") {
                const grid = event.scene.grid;
                if (!Number.isFinite(grid.size) || grid.size <= 0 ||
                    (grid.type === "hex" && !["oddQ", "evenQ", "oddR", "evenR"].includes(grid.hexLayout)))
                  return fail("Move cannot snap to an invalid grid");
                const spec: GridSpec = grid.type === "hex" ? { type: "hex", size: grid.size, layout: grid.hexLayout }
                  : { type: "square", size: grid.size };
                const point = snapTokenCenter(spec, x + dx, y + dy);
                x = point.x - dx; y = point.y - dy;
              }
              if (!finite(x, 0, event.scene.width) || !finite(y, 0, event.scene.height) ||
                  !finite(x + dx, 0, event.scene.width) || !finite(y + dy, 0, event.scene.height) ||
                  (doc.type === "drawing" && (!finite(x + geometry.width, 0, event.scene.width) || !finite(y + geometry.height, 0, event.scene.height))))
                return fail(`Move point ${x + dx},${y + dy} is outside the ${event.scene.width}x${event.scene.height} scene`);
              if (step.wallCollision === "block" && movementWallBlocked(
                { x: oldX + dx, y: oldY + dy }, { x: x + dx, y: y + dy }, event.scene.walls))
                return fail("Move path is blocked by a movement wall");
              if (step.wallCollision === "footprint" && (geometry.point
                ? movementWallBlocked({x:oldX,y:oldY}, {x,y}, event.scene.walls)
                : movementFootprintBlocked(
                  { x: oldX + dx, y: oldY + dy }, { x: x + dx, y: y + dy },
                  Math.max(geometry.width, 1e-7), Math.max(geometry.height, 1e-7), geometry.rotation, event.scene.walls)))
                return fail("Move footprint is blocked by a movement wall");
              let durationMs = animated ? step.durationMs : undefined;
              if (animated && durationMs === undefined && step.speed !== undefined) {
                const calculated = movementSpeedDuration(Math.hypot(x-oldX,y-oldY),event.scene.grid.size,step.speed);
                if (calculated === null) return fail("Move speed requires a valid grid size and a duration no longer than 60000 ms");
                durationMs = calculated;
              }
              if (oldX === x && oldY === y) continue;
              if (doc.type === "token") {
                const key = `${event.scene._id}\u0000${doc._id}`;
                if (step.triggerTiles === false) ctx.suppressedMovement.add(key);
                else ctx.suppressedMovement.delete(key);
              }
              const diff = applyMovePosition(doc, geometry, x, y);
              if (durationMs !== undefined) {
                const hint = { x, y, durationMs };
                doc.flags = { ...doc.flags, arenaMove: hint };
                diff["flags.arenaMove"] = hint;
              } else if (doc.flags.arenaMove !== undefined) {
                doc.flags = { ...doc.flags, arenaMove: {} };
                diff["flags.arenaMove"] = {};
              }
              ops.push({ kind: "update", ref, diff });
            }
            trace.push(`move ${targets.size} placeable target(s): ${step.mode ?? "set"} ${step.xFormula ?? step.x},${step.yFormula ?? step.y}`);
            break;
          } catch (cause) {
            return fail(cause instanceof Error ? cause.message : "Move destination randomization failed");
          }
        }
        case "rotate": {
          const parent: DocRef = { coll: "scenes", id: event.scene._id };
          const selected = step.targets === "triggering"
            ? motionTargets(event, "triggering", current).map((doc) => ({ ref: { coll: "tokens" as const, id: doc._id, parent }, doc }))
            : current;
          if (!selected.length) return fail("Rotation needs at least one live target token or tile");
          const targets = new Map<string, { ref: DocRef; doc: TokenDocument | TileDocument }>();
          for (const row of selected) {
            const list = row.ref.coll === "tokens" ? event.scene.tokens : row.ref.coll === "tiles" ? event.scene.tiles : null;
            if (!list) return fail("Rotation only supports tokens and tiles");
            const doc = list.find((item) => item._id === row.ref.id);
            if (!doc) return fail("Rotation target is no longer in the scene");
            targets.set(`${row.ref.coll}/${doc._id}`, { ref: { coll: row.ref.coll, id: doc._id, parent }, doc });
          }
          if (ops.length + targets.size > 1024) return fail("automation exceeds 1024 world operations");
          for (const { ref, doc } of targets.values()) {
            const old = doc.rotation ?? 0;
            if (!Number.isFinite(old)) return fail("Rotation target has invalid committed rotation");
            const resolved = resolveRotationAngle(step, () => {
              if (++ctx.rotationRolls > 1024) throw new Error("Rotation formulas exceed 1024 random draws per graph plan");
              return event.rng();
            });
            if (!resolved.ok) return fail(`Rotation: ${resolved.error}`);
            const raw = step.mode === "add" ? old + resolved.value : resolved.value;
            const angle = ((raw % 360) + 360) % 360;
            if (old === angle) continue;
            doc.rotation = angle;
            const diff: Record<string, Json> = { rotation: angle };
            if (step.durationMs !== undefined) {
              const hint = { rotation: angle, durationMs: step.durationMs };
              doc.flags = { ...doc.flags, arenaRotation: hint };
              diff["flags.arenaRotation"] = hint;
            } else if (doc.flags.arenaRotation !== undefined) {
              doc.flags = { ...doc.flags, arenaRotation: {} };
              diff["flags.arenaRotation"] = {};
            }
            ops.push({ kind: "update", ref, diff });
          }
          trace.push(`rotate ${targets.size} token/tile target(s): ${step.mode ?? "set"} ${step.formula ?? step.angle} degrees`);
          break;
        }
        case "delete": {
          if (!current.length) return fail("Delete Entities needs a non-empty current collection");
          if (current.some(({ ref }) => !["tokens", "tiles", "walls", "drawings", "notes", "lights", "sounds", "templates"].includes(ref.coll)))
            return fail("Delete Entities only removes scene tokens, tiles, walls, drawings, map pins, lights, sounds or templates");
          if (ops.length + current.length > 1024) return fail("automation exceeds 1024 world operations");
          const sceneList = (coll: string): Array<{ _id: string }> | null =>
            coll === "tokens" ? event.scene.tokens : coll === "tiles" ? event.scene.tiles :
            coll === "walls" ? event.scene.walls : coll === "drawings" ? event.scene.drawings :
            coll === "notes" ? event.scene.notes : coll === "lights" ? event.scene.lights :
            coll === "sounds" ? event.scene.sounds : coll === "templates" ? event.scene.templates : null;
          const names: string[] = [];
          for (const { ref, doc } of current) {
            const list = sceneList(ref.coll);
            const index = list ? list.findIndex((item) => item._id === ref.id) : -1;
            if (index < 0) return fail(`delete target ${ref.coll}/${ref.id} is already gone from the scene`);
            list?.splice(index, 1);
            // Unflushed edits to an entity removed in this transaction are superseded.
            // Previously flushed writes retain their order and normal inverse operations.
            const key = targetKey(ref);
            pendingTags.delete(key); pendingVisibility.delete(key); pendingDoors.delete(key);
            ops.push({ kind: "delete", ref });
            names.push(String(doc.name ?? ref.id));
          }
          trace.push(`delete ${current.length} placeable(s): ${names.slice(0, 8).join(", ")}${
            names.length > 8 ? `, … ${names.length - 8} more` : ""}`);
          current = []; // the collection is empty after its entities are deleted
          break;
        }
        case "rollTable": {
          const table = world.rollTables.find((item) => item._id === step.tableId);
          if (!table) return fail(`roll table ${step.tableId} is missing from the world`);
          const invalid = validateTable(table);
          if (invalid) return fail(`roll table ${table.name}: ${invalid}`);
          let draw: ReturnType<typeof drawFromTable>;
          try {
            draw = drawFromTable(table, () => {
              if (++ctx.tableRolls > 1024) throw new Error("Roll Table exceeds 1024 random draws per graph plan");
              const roll = event.rng();
              if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new Error("Roll Table received invalid host RNG");
              return roll;
            });
          } catch (cause) { return fail(cause instanceof Error ? cause.message : "Roll Table draw failed"); }
          if (draw.result && typeof draw.result.text !== "string") return fail("Roll Table result text must be a string");
          // Even a miss replaces the previous result; never fall back to stale coordinates.
          lastTableResult = draw.result?.text ?? null;
          if (step.variable !== undefined && draw.result && draw.result.text.length > 256)
            return fail(`roll table ${table.name}: result text exceeds the 256-character variable bound`);
          if (step.variable !== undefined) values[step.variable] = draw.result?.text ?? "";
          if (ops.length >= 1024) return fail("automation exceeds 1024 world operations");
          const content = draw.result ? escapeText(draw.result.text) : "(no matching result)";
          ops.push({ kind: "create", coll: "messages", data: {
            _id: globalThis.crypto.randomUUID(), type: "message", name: `Roll table: ${table.name}`,
            ownership: { default: step.audience === "gm" ? 0 : 1 },
            flags: {}, system: {}, author: hostUserId, content,
            whisper: step.audience === "gm" ? [hostUserId] : [],
            roll: draw.result ? draw.roll : null,
            flavor: `${table.formula} -> ${draw.roll.total}`,
          } as MessageDocument });
          trace.push(`rolled ${table.name}: ${table.formula} -> ${draw.roll.total}${draw.result ? "" : " (no matching result)"}`);
          break;
        }
        case "chat": {
          if (ops.length >= 1024) return fail("automation exceeds 1024 world operations");
          const content = textTemplate(step.content, values);
          const id = globalThis.crypto.randomUUID();
          ops.push({ kind: "create", coll: "messages", data: {
            _id: id, type: "message", name: `Automation: ${doc.name}`,
            ownership: { default: step.audience === "gm" ? 0 : 1 },
            flags: {}, system: {}, author: hostUserId, content, whisper: step.audience === "gm" ? [hostUserId] : [],
            roll: null, flavor: `Active zone: ${doc.name}`,
          } as MessageDocument });
          break;
        }
        case "sequence": {
          if (cues.length >= 256) return fail("automation exceeds 256 FX cues");
          const target = current.find((c) => c.doc.type === "token")?.doc;
          cues.push({ macroId: step.macroId, audience: step.audience,
            ...(event.token ? { sourceTokenId: event.token._id } : {}),
            ...(target ? { targetTokenId: target._id } : {}),
          });
          break;
        }
        case "script": {
          if (ctx.postActionCount >= 16) return fail("automation exceeds 16 post-commit actions");
          const captureResult = step.captureResult === true;
          if (captureResult && (doc._id !== ctx.rootAutomationId || ctx.stack.length !== 1 || frames.length > 0))
            return fail("awaited script-result branching must be at the root graph level and outside collection loops");
          const args: Record<string, Json> = { ...step.args };
          const currentToken = current.find((c) => c.doc.type === "token")?.doc._id;
          const bindings: Record<AutomationScriptBinding, Json | undefined> = {
            triggerToken: event.token?._id, currentToken, method: event.method,
            user: event.caller.id, scene: event.scene._id, tile: event.tile._id, count: nextState.count,
          };
          for (const [name, binding] of Object.entries(step.bindings ?? {})) {
            const value = bindings[binding];
            if (value !== undefined) args[name] = value;
          }
          const policy = {
            ...(step.runAs ? { runAs: step.runAs } : {}),
            ...(step.onError ? { onError: step.onError } : {}),
            ...(captureResult ? { captureResult: true as const } : {}),
          };
          scripts.push({ stepId: step.id, macroId: step.macroId, args, ...policy });
          postActions.push({ kind: "script", stepId: step.id, macroId: step.macroId, args, ...policy });
          ctx.postActionCount++;
          trace.push(`queued reviewed script ${step.macroId} (post-commit; ${Object.keys(args).length} input(s); ${step.runAs ?? "approved"} run-as; ${step.onError ?? "stop"} on error${captureResult ? "; result branch boundary" : ""})`);
          if (captureResult) {
            const continuation: AutomationContinuation = {
              graphId: doc._id, stepIndex: pc + 1, captureStepId: step.id,
              current: current.map(({ ref }) => structuredClone(ref)),
              values: { ...values }, scriptResults: Object.fromEntries(ctx.scriptResults),
              tableResult: lastTableResult === undefined ? { present: false } : { present: true, value: lastTableResult },
              graphSteps: executed, postActionCount: ctx.postActionCount,
              budgets: { steps: ctx.steps, invocations: ctx.invocations, attributeReads: ctx.attributeReads,
                actorFilterReads: ctx.actorFilterReads, tileVariableReads: ctx.tileVariableReads,
                imageSelectionRolls: ctx.imageSelectionRolls, healthRolls: ctx.healthRolls,
                rotationRolls: ctx.rotationRolls, moveRolls: ctx.moveRolls,
                gameTimeRolls: ctx.gameTimeRolls, tableRolls: ctx.tableRolls },
            };
            return { ok: true, continuation };
          }
          break;
        }
        case "summon": {
          if (ctx.postActionCount >= 16) return fail("automation exceeds 16 post-commit actions");
          const anchor = step.anchor === "tile"
            ? { x: event.tile.x + event.tile.width / 2, y: event.tile.y + event.tile.height / 2 }
            : step.anchor === "trigger" ? event.token
              : current.find((row) => row.doc.type === "token")?.doc as TokenDocument | undefined;
          if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y))
            return fail(`summon ${step.id} needs a ${step.anchor} token/point`);
          if (event.caller.role !== "GM" && event.caller.role !== "ASSISTANT" && !event.token)
            return fail(`summon ${step.id} needs an owned triggering caster`);
          postActions.push({ kind: "summon", stepId: step.id, presetId: step.presetId,
            at: { x: anchor.x, y: anchor.y },
            ...(event.token ? { summonerTokenId: event.token._id } : {}),
            ...(step.onError ? { onError: step.onError } : {}) });
          ctx.postActionCount++;
          trace.push(`queued summon ${step.presetId} at ${step.anchor} (post-commit; ${step.onError ?? "stop"} on error)`);
          break;
        }
        case "landing": break;
        case "jump": pc = jumpTo(step.to); continue;
        case "stop": return { ok: true, stopped: true };
      }
      pc++;
    }
    return { ok: true };
  } finally {
    ctx.stack.pop();
  }
}
