/**
 * GM-authored active-zone automation (MATT-class graph foundation). Definitions
 * are separate from execution history and are NEVER projected to players. The
 * host resolves every selector against current documents and commits all world
 * writes in one atomic envelope; visual cues are preflighted and sent afterwards.
 *
 * This is a bounded action registry foundation, not the full §5.4 inventory.
 */
import type {
  ActorDocument, AutomationDocument, BaseDocument, DocRef, Json, MessageDocument, SceneDocument,
  NoteDocument, TileDocument, TokenDocument, WallDocument, WorldCollections,
} from "./documents";
import { isDoorWall } from "./documents";
import { applyDiff } from "./diff";
import { DAY_SECONDS, MINUTE_SECONDS } from "./clock";
import { WORLD_SETTINGS_ID, worldSettingsDoc, worldSettingsFrom } from "./worldSettings";
import type { Op } from "./ops";
import type { PermissionUser } from "./ownership";
import { getByTag, listTaggable, normalizeTags, tagMatcher, tagsOf, TAGGABLE_COLLECTIONS, validSceneTagRefs,
  type TagEdit, type TagMatchMode, type TagPattern, type TagSearchCollection } from "./tags";

export type AutomationMethod = "enter" | "exit" | "stop" | "create" | "rotate" | "click" | "manual";
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
  /** Set Active Tiles Variable. Run variables last only for this invocation;
   * tile variables live in the private, undoable graph state across triggers.
   * Numeric addition is bounded and uses zero for a previously unset name. */
  | { id: string; kind: "set"; name: string; value: string | number | boolean;
      scope?: "run" | "tile"; operation?: "assign" | "add";
      /** Optional same-scene MATT tile targeting. All graphs on each selected
       * tile receive the durable value; without a target, only this graph does. */
      target?: AutomationTileTarget }
  /** MATT Game Time: a bounded fixed minute delta applied to the host-owned
   * replicated world clock. Later Check Value steps see the staged change. */
  | { id: string; kind: "gameTime"; minutes: number }
  /** MATT Hurt / Heal: fixed, GM-authored whole HP points; positive heals,
   * negative hurts. Current selection may come from Inside/Tagger filters. */
  | { id: string; kind: "hurtHeal"; amount: number; targets: "triggering" | "current" }
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
      bindings?: Record<string, AutomationScriptBinding> }
  /** GM-authored, exact preset ID. Post-commit like a reviewed script because
   * a compendium source may need asynchronous resolution. No actor data from
   * the triggering client is accepted; the host creates the linked instance. */
  | { id: string; kind: "summon"; presetId: string; anchor: "tile" | "trigger" | "current" }
  | { id: string; kind: "landing"; name: string }
  | { id: string; kind: "jump"; to: string }
  | { id: string; kind: "stop" };

export interface AutomationDefinition {
  version: 1;
  sceneId: string;
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
  caller: PermissionUser;
  at: number;
  rng: () => number;
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
}
export type AutomationPostAction =
  | ({ kind: "script" } & AutomationScriptCall)
  | { kind: "summon"; stepId: string; presetId: string; at: { x: number; y: number };
      summonerTokenId?: string };
export interface AutomationPlan {
  ops: Op[];
  cues: AutomationFx[];
  scripts: AutomationScriptCall[];
  /** Authored order across reviewed scripts and real summons. Separate commits
   * follow the single graph envelope; GM trace reports failures explicitly. */
  postActions: AutomationPostAction[];
  trace: string[];
  state: AutomationState;
  /** Suppress later tiles for this moving token after a successful host commit. */
  stopOthers: boolean;
}
export type AutomationOutcome =
  | { ok: true; plan: AutomationPlan }
  | { ok: false; error: string; trace: string[] }
  | { ok: true; skipped: string; trace: string[] };

const METHODS: readonly AutomationMethod[] = ["enter", "exit", "stop", "create", "rotate", "click", "manual"];
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

/** Shared publish-time selector check for collection edits and Tagger tile targets. */
function selectorError(s: unknown, sceneId: string, tileOnly = false): string | null {
  if (!isObject(s)) return "invalid selector";
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
      !keys(value, ["version", "sceneId", "tileId", "methods", "gates", "steps"])) return bad("automation needs version 1, scene/tile, methods and 1–2048 steps");
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
          return bad("invalid Check Variable name, aggregation or comparison");
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
      case "shuffle":
      case "resetHistory":
      case "batchFlush":
      case "stopOthers":
        if (!keys(step, common)) return bad(`invalid ${String(step.kind)} action`);
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
            (step.operation !== undefined && !["assign", "add"].includes(String(step.operation))) ||
            (step.target !== undefined && step.scope !== "tile") ||
            (step.scope === "tile" && RESERVED_VARIABLES.has(step.name)) ||
            (step.scope === "tile" && !validVariable(step.value)) ||
            (step.scope !== "tile" && (!["string", "number", "boolean"].includes(typeof step.value) ||
              typeof step.value === "string" && step.value.length > 256 ||
              typeof step.value === "number" && !Number.isFinite(step.value))) ||
            (step.operation === "add" && typeof step.value !== "number"))
          return bad("invalid variable assignment/scope/operator");
        if (step.target !== undefined) {
          const error = tileTargetError(step.target, value.sceneId as string);
          if (error) return bad(error);
        }
        break;
      case "gameTime":
        if (!keys(step, [...common, "minutes"]) || !Number.isSafeInteger(step.minutes) ||
            !finite(step.minutes, -525_600, 525_600))
          return bad("Game Time requires a fixed whole-minute change within ±525600 minutes");
        break;
      case "hurtHeal":
        if (!keys(step, [...common, "amount", "targets"]) || !Number.isSafeInteger(step.amount) ||
            !finite(step.amount, -100_000, 100_000) || step.amount === 0 ||
            !["triggering", "current"].includes(String(step.targets)))
          return bad("Hurt / Heal needs a fixed nonzero whole HP change within ±100000 and a token target");
        break;
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
      case "chat":
        if (!keys(step, [...common, "content", "audience"]) || typeof step.content !== "string" ||
            step.content.length < 1 || step.content.length > 1000 || !["scene", "gm"].includes(String(step.audience))) return bad("invalid chat action");
        break;
      case "sequence":
        if (!keys(step, [...common, "macroId", "audience"]) || !nonEmptyId(step.macroId) ||
            !["scene", "gm"].includes(String(step.audience))) return bad("invalid sequence action");
        break;
      case "script": {
        if (!keys(step, [...common, "macroId", "args", "bindings"]) ||
            typeof step.macroId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(step.macroId) ||
            (step.args !== undefined && !isObject(step.args)) ||
            (step.bindings !== undefined && !isObject(step.bindings)) || ++asyncSteps > 16)
          return bad("a script action needs a saved macro; at most 16 post-commit actions may run per graph");
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
        if (!keys(step, [...common, "presetId", "anchor"]) ||
            typeof step.presetId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(step.presetId) ||
            !["tile", "trigger", "current"].includes(String(step.anchor)) || ++asyncSteps > 16)
          return bad("summon needs one saved preset and tile/trigger/current anchor; at most 16 post-commit actions");
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
  for (const step of value.steps) {
    const targets = step.kind === "jump" ? [step.to]
      : step.kind === "filter" || step.kind === "routeMethod" ? (step.kind === "routeMethod"
        ? [...Object.values(step.routes), step.otherwise] : [step.otherwise])
      : step.kind === "routeUser" ? [step.gm, step.player, step.otherwise]
      : step.kind === "checkVariable" || step.kind === "checkValue" || step.kind === "checkData"
        ? [step.otherwise] : [];
    for (const target of targets) if (target && !landings.has(target)) return bad(`landing not found: ${target}`);
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

/** A pointer is inside this tile's rotated rectangle. Shared by client picking and host verification. */
export function tileContainsPoint(tile: TileDocument, point: { x: number; y: number }): boolean {
  if (![tile.x, tile.y, tile.width, tile.height, tile.rotation ?? 0, point.x, point.y].every(Number.isFinite) ||
      tile.width <= 0 || tile.height <= 0) return false;
  const cx = tile.x + tile.width / 2, cy = tile.y + tile.height / 2;
  const angle = -((tile.rotation ?? 0) * Math.PI / 180);
  const dx = point.x - cx, dy = point.y - cy;
  const x = dx * Math.cos(angle) - dy * Math.sin(angle);
  const y = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(x) <= tile.width / 2 && Math.abs(y) <= tile.height / 2;
}

/** Ray/rotated-rectangle segment intersection. Return ordered entry/exit, including a fast pass-through. */
export function sweptTileEvents(
  tile: TileDocument, before: TokenDocument | undefined, after: TokenDocument | undefined,
): Array<{ method: AutomationMethod; fraction: number }> {
  if (!after) return [];
  if (![tile.x, tile.y, tile.width, tile.height, tile.rotation ?? 0].every(Number.isFinite) || tile.width <= 0 || tile.height <= 0) return [];
  const cx = tile.x + tile.width / 2, cy = tile.y + tile.height / 2;
  const angle = -((tile.rotation ?? 0) * Math.PI / 180);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const local = (token: TokenDocument) => {
    // TokenDocument positions denote the center, not the upper-left corner.
    const x = token.x - cx, y = token.y - cy;
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  };
  const end = local(after), start = before ? local(before) : end;
  const xmin = -tile.width / 2, xmax = tile.width / 2, ymin = -tile.height / 2, ymax = tile.height / 2;
  const inside = (p: { x: number; y: number }) => p.x >= xmin && p.x <= xmax && p.y >= ymin && p.y <= ymax;
  if (!before) return inside(end) ? [{ method: "create", fraction: 1 }] : [];
  const moved = start.x !== end.x || start.y !== end.y;
  if (!moved) return before.rotation !== after.rotation && inside(end) ? [{ method: "rotate", fraction: 1 }] : [];
  let lo = 0, hi = 1;
  const dx = end.x - start.x, dy = end.y - start.y;
  const bounds: Array<[number, number]> = [[-dx, start.x - xmin], [dx, xmax - start.x], [-dy, start.y - ymin], [dy, ymax - start.y]];
  for (const [p, q] of bounds) {
    if (p === 0) { if (q < 0) return []; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  if (lo > hi) return [];
  const from = inside(start), to = inside(end);
  const events: Array<{ method: AutomationMethod; fraction: number }> = [];
  if (!from) events.push({ method: "enter", fraction: lo });
  if (!to) events.push({ method: "exit", fraction: hi });
  if (to) events.push({ method: "stop", fraction: 1 });
  return events;
}

/** Resolve tag and spatial selectors against CURRENT host documents, never author-time IDs. */
function select(
  world: Readonly<WorldCollections>, event: AutomationEvent, selector: AutomationSelector,
): Array<{ ref: DocRef; doc: BaseDocument }> {
  const parent: DocRef = { coll: "scenes", id: event.scene._id };
  const token = (t: TokenDocument): { ref: DocRef; doc: BaseDocument } =>
    ({ ref: { coll: "tokens", id: t._id, parent }, doc: t });
  switch (selector.kind) {
    case "triggering": return event.token ? [token(event.token)] : [];
    case "tile": return [{ ref: { coll: "tiles", id: event.tile._id, parent }, doc: event.tile }];
    case "inside": return event.scene.tokens.filter((t) => sweptTileEvents(event.tile, undefined, t).some((e) => e.method === "create")).map(token);
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

type GraphOutcome = { ok: true; skipped?: string; stopped?: boolean } | { ok: false; error: string };
interface PlanningContext {
  /** One isolated active-scene clone for the whole nested call chain. */
  world: Readonly<WorldCollections>;
  originals: Map<string, BaseDocument>;
  ops: Op[];
  cues: AutomationFx[];
  scripts: AutomationScriptCall[];
  postActions: AutomationPostAction[];
  trace: string[];
  histories: Map<string, AutomationState>;
  historyOps: Map<string, Extract<Op, { kind: "update" }>>;
  /** Same-envelope graph gate edits share an update with trigger history when
   * both touch a graph, so nested calls can observe the staged gate. */
  definitionOps: Map<string, Extract<Op, { kind: "update" }>>;
  /** One clock op for the entire nested plan, coalesced across Game Time steps. */
  clockOp?: Extract<Op, { kind: "update" | "create" }>;
  pendingTags: Map<string, { ref: DocRef; tags: string[] }>;
  pendingVisibility: Map<string, { ref: DocRef; visible: boolean }>;
  pendingDoors: Map<string, { ref: DocRef; door: 0 | 1 | 2 }>;
  stack: string[];
  steps: number;
  invocations: number;
  attributeReads: number;
  actorFilterReads: number;
  tileVariableReads: number;
  /** Lazy index shared by every nested attribute, condition and inventory filter. */
  actorIndex?: Map<string, BaseDocument>;
  stopOthers: boolean;
}
const targetKey = (ref: DocRef) => JSON.stringify([ref.parent?.coll ?? "", ref.parent?.id ?? "", ref.coll, ref.id]);

function writeTileVariable(state: AutomationState, step: Extract<AutomationStep, { kind: "set" }>):
  { ok: true; value: string | number | boolean } | { ok: false; error: string } {
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
): AutomationOutcome {
  const trace: string[] = [];
  const fail = (error: string): AutomationOutcome => ({ ok: false, error, trace });
  if (!world.scenes.some((s) => s._id === event.scene._id)) return fail("scene unavailable for automation");
  const stagedScene = structuredClone(event.scene);
  const stagedWorld: Readonly<WorldCollections> = {
    ...world, scenes: world.scenes.map((s) => s._id === stagedScene._id ? stagedScene : s),
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
  const tile = stagedScene.tiles.find((t) => t._id === event.tile._id);
  if (!tile) return fail("automation tile unavailable");
  const token = event.token ? stagedScene.tokens.find((t) => t._id === event.token?._id) : undefined;
  if (event.token && !token) return fail("automation token unavailable");
  const stagedEvent: AutomationEvent = { ...event, scene: stagedScene, tile,
    ...(token ? { token } : {}) };
  const ctx: PlanningContext = {
    world: stagedWorld,
    originals: new Map(listTaggable(world, { sceneId: stagedScene._id })
      .map(({ ref, doc: original }) => [targetKey(ref), original])),
    ops: [], cues: [], scripts: [], postActions: [], trace, histories: new Map(), historyOps: new Map(),
    definitionOps: new Map(), pendingTags: new Map(), pendingVisibility: new Map(), pendingDoors: new Map(),
    stack: [], steps: 0, invocations: 0, attributeReads: 0, actorFilterReads: 0,
    tileVariableReads: 0, stopOthers: false,
  };
  const result = planGraph(ctx, doc, stagedEvent, hostUserId);
  if (!result.ok) return fail(result.error);
  if (result.skipped) return { ok: true, skipped: result.skipped, trace };
  const flushed = flushBatch(ctx, stagedScene._id); // implicit final batch execution
  if (!flushed.ok) return fail(flushed.error);
  if (ctx.ops.length > 1024) return fail("automation exceeds 1024 world operations");
  const state = ctx.histories.get(doc._id);
  if (!state) return fail("root graph did not record its history");
  return { ok: true, plan: { ops: ctx.ops, cues: ctx.cues, scripts: ctx.scripts,
    postActions: ctx.postActions, trace, state, stopOthers: ctx.stopOthers } };
}

/** A child is never committed on its own: failures discard ALL staged parent work. */
function planGraph(
  ctx: PlanningContext, doc: AutomationDocument, event: AutomationEvent, hostUserId: string,
  landing?: string,
): GraphOutcome {
  const fail = (error: string): GraphOutcome => ({ ok: false, error });
  const { world, trace, ops, cues, scripts, postActions, pendingTags, pendingVisibility, pendingDoors } = ctx;
  const definition = validateAutomation(doc.definition);
  if (!definition.ok) return fail(definition.error);
  const d = definition.definition;
  if (event.scene._id !== d.sceneId || event.tile._id !== d.tileId ||
      !event.scene.tiles.some((t) => t._id === event.tile._id) || !d.methods.includes(event.method)) return { ok: true, skipped: "method/anchor mismatch" };
  if (ctx.stack.includes(doc._id)) return fail(`trigger tile recursion: ${[...ctx.stack, doc._id].join(" -> ")}`);
  if (ctx.stack.length >= 8 || ++ctx.invocations > 128)
    return fail("trigger tile depth/invocation budget (8/128) exceeded");
  if (landing && !d.steps.some((step) => step.kind === "landing" && step.name === landing))
    return fail(`landing ${landing} not found in ${doc._id}`);
  const state: AutomationState = ctx.histories.get(doc._id) ?? doc.state ?? { count: 0, lastAt: 0, byToken: {} };
  if (!validateAutomationState(state)) return fail("invalid trigger history");
  const gates = d.gates ?? {};
  if (gates.paused) return { ok: true, skipped: "paused" };
  const key = event.token?._id ?? `user:${event.caller.id}`;
  const history = state.byToken[key];
  if (gates.maxRuns && state.count >= gates.maxRuns) return { ok: true, skipped: "run limit" };
  if (gates.oncePerToken && history?.count) return { ok: true, skipped: "already fired for this token/user" };
  if (gates.cooldownMs && history && event.at - history.lastAt < gates.cooldownMs) return { ok: true, skipped: "cooldown" };
  if (gates.chance !== undefined && event.rng() >= gates.chance) return { ok: true, skipped: "chance gate" };
  if (state.count >= 1_000_000 || (history?.count ?? 0) >= 1_000_000)
    return fail("trigger history count cap reached; reset history before running");
  const nextState: AutomationState = {
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
    nextState.variables ?? {}, { method: event.method,
      originMethod: event.originMethod ?? event.method, originTile: event.originTileId ?? event.tile._id,
      user: event.caller.id, count: nextState.count });
  let current: Target[] = select(world, event, { kind: "triggering" });
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
  let executed = 0, pc = landing ? landings.get(landing) ?? 0 : 0;
  ctx.stack.push(doc._id);
  try {
    while (pc < d.steps.length) {
      if (++executed > budget || ++ctx.steps > 25_000)
        return fail(`automation cycle/resource budget (${budget} per graph, 25000 total steps)`);
      const step = d.steps[pc];
      if (!step) break; // defensive for imported sparse arrays
      trace.push(`${pc}: ${step.kind} [${step.id}]`);
      switch (step.kind) {
        case "select":
          current = select(world, event, step.selector);
          if (current.length > 1024) return fail("current collection exceeds 1024 targets");
          trace.push(`selected ${current.length} ${step.selector.kind} target(s)`);
          break;
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
                graph.definition?.tileId === tile._id);
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
              if (graph.definition?.sceneId !== event.scene._id || graph.definition?.tileId !== tile._id) continue;
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
              child.definition?.tileId === tile._id).sort((a, b) => a._id.localeCompare(b._id));
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
                graph.definition?.tileId === tile._id).sort((a, b) => a._id.localeCompare(b._id));
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
                if (graph._id === doc._id) values[step.name] = written.value;
                changed++;
              }
            }
            trace.push(`tile variable ${step.name} ${step.operation === "add" ? "+=" : "="} on ${changed} graph(s) of ${resolved.tiles.length} tile(s) (private)`);
            break;
          }
          if (step.scope === "tile") {
            // A run-local shadow cannot change the base of a durable counter.
            const written = writeTileVariable(nextState, step);
            if (!written.ok) return fail(written.error);
            values[step.name] = written.value;
            trace.push(`tile variable ${step.name} ${step.operation === "add" ? "+=" : "="} (private)`);
            break;
          }
          const prior = values[step.name];
          if (step.operation === "add" && prior !== undefined && typeof prior !== "number")
            return fail(`variable ${step.name} is not numeric`);
          const value = step.operation === "add" ? ((prior ?? 0) as number) + (step.value as number) : step.value;
          if (typeof value === "number" && !Number.isFinite(value)) return fail(`variable ${step.name} overflowed`);
          values[step.name] = value;
          break;
        }
        case "gameTime": {
          const old = worldSettingsFrom(world.settings).clockSeconds;
          if (old !== undefined && !finite(old, 0, 3_153_600_000))
            return fail("invalid committed world clock");
          const next = (old ?? 0) + step.minutes * MINUTE_SECONDS;
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
          trace.push(`Game Time ${step.minutes >= 0 ? "+" : ""}${step.minutes} minute(s) -> ${next} host seconds`);
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
            const planned = event.hurtHeal(actor, step.amount);
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
          if (postActions.length >= 16) return fail("automation exceeds 16 post-commit actions");
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
          scripts.push({ stepId: step.id, macroId: step.macroId, args });
          postActions.push({ kind: "script", stepId: step.id, macroId: step.macroId, args });
          trace.push(`queued reviewed script ${step.macroId} (post-commit; ${Object.keys(args).length} input(s))`);
          break;
        }
        case "summon": {
          if (postActions.length >= 16) return fail("automation exceeds 16 post-commit actions");
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
            ...(event.token ? { summonerTokenId: event.token._id } : {}) });
          trace.push(`queued summon ${step.presetId} at ${step.anchor} (post-commit)`);
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
