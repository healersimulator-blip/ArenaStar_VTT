/**
 * Versioned, data-only action cards.
 *
 * An action card is the durable connection between a rules flow, chat and presentation. It says
 * what committed, where it happened and what happened to each target. It does NOT authorize a
 * world write and it does not contain executable callbacks. Rules code still owns HP, effects,
 * resources and movement; FX may consume {@link ActionFxContext} only after the message carrying
 * this card has committed.
 *
 * The schema is deliberately system-neutral. PF1e casts are the first producer, but attacks,
 * checks, item uses and automation can publish the same bounded target/result vocabulary.
 */
import type { Json, MessageDocument } from "./documents";

export const ACTION_CARD_VERSION = 1 as const;
export const ACTION_TARGET_MAX = 64;
export const ACTION_NOTE_MAX = 32;
/** Conditions are projected to FX, so their cardinality/text budget is intentionally tighter. */
export const ACTION_CONDITION_MAX = 16;
export const ACTION_CONDITION_NAME_MAX = 80;
export const ACTION_EVIDENCE_JSON_MAX = 4_096;
/** ASCII JSON from a schema-maximal FX projection remains below this regression budget. */
export const ACTION_FX_CONTEXT_JSON_MAX = 256_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const LABEL_MAX = 160;
const NOTE_LENGTH_MAX = 500;

export type ActionKind =
  | "attack"
  | "cast"
  | "save"
  | "check"
  | "ability"
  | "item"
  | "movement"
  | "custom";

export type ActionState =
  | "pending"
  | "resolved"
  | "partial"
  | "failed"
  | "cancelled"
  | "expired";

export type ActionTargetState = "pending" | "resolved" | "skipped" | "expired";

/** Closed vocabulary usable by rendering and FX without parsing prose. */
export type ActionTargetOutcome =
  | "pending"
  | "saved"
  | "failedSave"
  | "hit"
  | "miss"
  | "succeeded"
  | "failed"
  | "resisted"
  | "affected"
  | "unaffected"
  | "rolled"
  | "skipped"
  | "expired";

export interface ActionEntityRef {
  name: string;
  actorId?: string;
  tokenId?: string;
  itemId?: string;
}

export interface ActionArea {
  sceneId: string;
  /** A durable area owner when one exists. Coordinates remain useful before that slice lands. */
  ref?: { kind: "template" | "region"; id: string };
  shape: "burst" | "circle" | "cone" | "line" | "cylinder" | "spread" | "emanation" | "rect" | "polygon";
  origin: { x: number; y: number };
  radius?: number;
  width?: number;
  direction?: { x: number; y: number };
  units?: string;
}

export interface ActionCheck {
  kind: "attack" | "save" | "check" | "concentration";
  status: "pending" | "resolved" | "skipped" | "expired";
  formula: string;
  dc: number | null;
  total: number | null;
  /** PF1e saves use this; other systems omit it. */
  saveType?: "fort" | "ref" | "will";
  passed?: boolean;
  automatic?: "success" | "failure" | null;
  /** Links the host-owned pending-roll resolution to exactly one target row. */
  pendingRollId?: string;
}

export interface ActionEvidence {
  /** Names a host-side, versioned verifier; unknown adapters remain reported. */
  adapter: string;
  /** Adapter input only. It is bounded JSON, never executable state. */
  payload: Json;
}

export interface ActionTarget {
  /** Stable within this action; never inferred from a display name. */
  key: string;
  /** Canonical entity name; `label` carries a client-authored stage/check description. */
  name: string;
  label?: string;
  actorId?: string;
  tokenId?: string;
  state: ActionTargetState;
  outcome: ActionTargetOutcome;
  /** Host-owned provenance. Submitted terminal results are normalized from verified evidence. */
  provenance?: "host" | "reported";
  evidence?: ActionEvidence;
  check?: ActionCheck;
  damage?: { dealt: number; prevented?: number };
  healing?: { applied: number };
  conditions?: { applied?: string[]; removed?: string[] };
  notes?: string[];
}

export interface ActionCard {
  v: typeof ACTION_CARD_VERSION;
  /** Equal to the containing chat message id after host normalization. */
  id: string;
  /** Increments on every authoritative pending-result transition; FX can deduplicate it. */
  revision: number;
  kind: ActionKind;
  label: string;
  state: ActionState;
  source: ActionEntityRef;
  sceneId?: string;
  area?: ActionArea;
  targets: ActionTarget[];
  notes: string[];
  /** Host-normalized on message creation; updated on a host-owned transition. */
  createdAt: number;
  updatedAt: number;
}

/** Presentation-facing, non-executable context emitted from one committed card revision. */
export interface ActionFxContext {
  v: 1;
  actionId: string;
  revision: number;
  kind: ActionKind;
  label: string;
  /** True only when every target's lifecycle/mechanics is host-proven. */
  verified: boolean;
  state?: ActionState;
  at: number;
  source: ActionEntityRef;
  sceneId?: string;
  area?: ActionArea;
  targets: Array<{
    key: string;
    name: string;
    label?: string;
    actorId?: string;
    tokenId?: string;
    /** False means the target is spatial context only; lifecycle/mechanical fields are absent. */
    verified: boolean;
    state?: ActionTargetState;
    outcome?: ActionTargetOutcome;
    check?: Pick<ActionCheck, "kind" | "status" | "dc" | "total" | "saveType" | "passed" | "automatic">;
    damage?: { dealt: number; prevented?: number };
    healing?: { applied: number };
    conditions?: { applied?: string[]; removed?: string[] };
  }>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const coordinate = (value: unknown): value is number => finite(value) && Math.abs(value) <= 1_000_000;
const safeNonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const validText = (value: unknown, max = LABEL_MAX): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max &&
  ![...value].some((char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t");

const KINDS: readonly ActionKind[] = ["attack", "cast", "save", "check", "ability", "item", "movement", "custom"];
const STATES: readonly ActionState[] = ["pending", "resolved", "partial", "failed", "cancelled", "expired"];
const TARGET_STATES: readonly ActionTargetState[] = ["pending", "resolved", "skipped", "expired"];
const OUTCOMES: readonly ActionTargetOutcome[] = ["pending", "saved", "failedSave", "hit", "miss", "succeeded",
  "failed", "resisted", "affected", "unaffected", "rolled", "skipped", "expired"];
const CHECK_KINDS: readonly ActionCheck["kind"][] = ["attack", "save", "check", "concentration"];
const CHECK_STATES: readonly ActionCheck["status"][] = ["pending", "resolved", "skipped", "expired"];
const AREA_SHAPES: readonly ActionArea["shape"][] = ["burst", "circle", "cone", "line", "cylinder", "spread",
  "emanation", "rect", "polygon"];

function entityError(value: unknown, field: string): string | null {
  if (!object(value) || !exactKeys(value, ["name", "actorId", "tokenId", "itemId"]) ||
      !validText(value.name) || [value.actorId, value.tokenId, value.itemId].some((id) => id !== undefined && !validId(id)))
    return `${field} needs a bounded name and optional actor/token/item ids`;
  return null;
}

function areaError(value: unknown): string | null {
  if (!object(value) || !exactKeys(value, ["sceneId", "ref", "shape", "origin", "radius", "width", "direction", "units"]) ||
      !validId(value.sceneId) || !(AREA_SHAPES as readonly unknown[]).includes(value.shape) || !object(value.origin) ||
      !exactKeys(value.origin, ["x", "y"]) || !coordinate(value.origin.x) || !coordinate(value.origin.y) ||
      (value.radius !== undefined && (!finite(value.radius) || value.radius < 0 || value.radius > 1_000_000)) ||
      (value.width !== undefined && (!finite(value.width) || value.width < 0 || value.width > 1_000_000)) ||
      (value.units !== undefined && !validText(value.units, 32))) return "action area is malformed";
  if (value.ref !== undefined && (!object(value.ref) || !exactKeys(value.ref, ["kind", "id"]) ||
      (value.ref.kind !== "template" && value.ref.kind !== "region") || !validId(value.ref.id)))
    return "action area reference is malformed";
  if (value.direction !== undefined && (!object(value.direction) || !exactKeys(value.direction, ["x", "y"]) ||
      !coordinate(value.direction.x) || !coordinate(value.direction.y))) return "action area direction is malformed";
  return null;
}

function stringListError(value: unknown, field: string): string | null {
  return !Array.isArray(value) || value.length > ACTION_NOTE_MAX || value.some((entry) => !validText(entry, NOTE_LENGTH_MAX))
    ? `${field} needs at most ${ACTION_NOTE_MAX} bounded strings` : null;
}

function checkError(value: unknown): string | null {
  if (!object(value) || !exactKeys(value, ["kind", "status", "formula", "dc", "total", "saveType", "passed",
    "automatic", "pendingRollId"]) || !(CHECK_KINDS as readonly unknown[]).includes(value.kind) ||
      !(CHECK_STATES as readonly unknown[]).includes(value.status) || !validText(value.formula, 160) ||
      !(value.dc === null || finite(value.dc)) || !(value.total === null || finite(value.total)) ||
      (value.saveType !== undefined && !["fort", "ref", "will"].includes(String(value.saveType))) ||
      (value.passed !== undefined && typeof value.passed !== "boolean") ||
      (value.automatic !== undefined && value.automatic !== null && value.automatic !== "success" &&
        value.automatic !== "failure") || (value.pendingRollId !== undefined && !validId(value.pendingRollId)))
    return "action target check is malformed";
  if (value.status === "pending" && (value.total !== null || value.passed !== undefined || !validId(value.pendingRollId)))
    return "a pending action check needs a pending-roll id and no result";
  if (value.status !== "pending" && value.pendingRollId !== undefined)
    return "only a pending action check may carry a pending-roll id";
  if (value.status === "resolved" && value.total === null)
    return "a resolved action check needs a total";
  if (value.status === "resolved" && value.kind === "save" && typeof value.passed !== "boolean")
    return "a resolved save needs a pass/fail result";
  if ((value.status === "skipped" || value.status === "expired") && value.total !== null)
    return "a skipped/expired action check has no total";
  return null;
}

function boundedEvidenceJson(value: unknown, depth = 0, seen = new WeakSet<object>()): value is Json {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 500 &&
    ![...value].some((char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t");
  if (depth >= 5 || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.length <= 32 && value.every((entry) => boundedEvidenceJson(entry, depth + 1, seen));
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 32 && entries.every(([key, entry]) =>
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) && boundedEvidenceJson(entry, depth + 1, seen));
}

function evidenceError(value: unknown): string | null {
  if (!object(value) || !exactKeys(value, ["adapter", "payload"]) || !validText(value.adapter, 80) ||
      !object(value.payload) || !boundedEvidenceJson(value.payload)) return "action target evidence is malformed";
  try {
    if (JSON.stringify(value).length > ACTION_EVIDENCE_JSON_MAX) return "action target evidence is too large";
  } catch {
    return "action target evidence is malformed";
  }
  return null;
}

function targetError(value: unknown): string | null {
  if (!object(value) || !exactKeys(value, ["key", "name", "label", "actorId", "tokenId", "state", "outcome", "provenance", "evidence", "check",
    "damage", "healing", "conditions", "notes"]) || !validId(value.key) || !validText(value.name) ||
      (value.label !== undefined && !validText(value.label)) ||
      (value.actorId !== undefined && !validId(value.actorId)) || (value.tokenId !== undefined && !validId(value.tokenId)) ||
      (value.provenance !== undefined && value.provenance !== "host" && value.provenance !== "reported") ||
      !(TARGET_STATES as readonly unknown[]).includes(value.state) || !(OUTCOMES as readonly unknown[]).includes(value.outcome))
    return "action target is malformed";
  if (value.evidence !== undefined) {
    const error = evidenceError(value.evidence);
    if (error) return error;
  }
  if (value.state === "pending" && value.outcome !== "pending") return "a pending action target needs pending outcome";
  if (value.state === "pending" &&
      (value.damage !== undefined || value.healing !== undefined || value.conditions !== undefined))
    return "a pending action target cannot carry committed mechanics";
  if (value.state === "resolved" && ["pending", "skipped", "expired"].includes(String(value.outcome)))
    return "a resolved action target needs a resolved outcome";
  if (value.state === "expired" && value.outcome !== "expired") return "an expired action target needs expired outcome";
  if (value.state === "skipped" && value.outcome !== "skipped" && value.outcome !== "unaffected")
    return "a skipped action target needs skipped/unaffected outcome";
  if (value.check !== undefined) {
    const error = checkError(value.check);
    if (error) return error;
    const check = value.check as ActionCheck;
    if (check.status !== value.state)
      return "an action check and its target need the same state";
    if (check.automatic === "success" && check.passed !== true ||
        check.automatic === "failure" && check.passed !== false)
      return "an automatic action check disagrees with its result";
    if (check.status === "resolved") {
      if (check.kind === "save" && ((value.outcome === "saved") !== (check.passed === true) ||
          (value.outcome !== "saved" && value.outcome !== "failedSave")))
        return "a save outcome disagrees with its check";
      if (check.kind === "attack" && (value.outcome === "hit" || value.outcome === "miss") &&
          ((value.outcome === "hit") !== (check.passed === true)))
        return "an attack outcome disagrees with its check";
    }
  }
  for (const [field, payload, key] of [["damage", value.damage, "dealt"], ["healing", value.healing, "applied"]] as const) {
    if (payload !== undefined && (!object(payload) || !safeNonNegative(payload[key]) ||
        (field === "damage" && payload.prevented !== undefined && !safeNonNegative(payload.prevented)) ||
        !exactKeys(payload, field === "damage" ? ["dealt", "prevented"] : ["applied"])))
      return `action target ${field} is malformed`;
  }
  if (value.conditions !== undefined) {
    if (!object(value.conditions) || !exactKeys(value.conditions, ["applied", "removed"]))
      return "action target conditions are malformed";
    for (const key of ["applied", "removed"] as const) {
      const entries = value.conditions[key];
      if (entries !== undefined && (!Array.isArray(entries) || entries.length > ACTION_CONDITION_MAX ||
          entries.some((entry) => !validText(entry, ACTION_CONDITION_NAME_MAX))))
        return `action target conditions.${key} needs at most ${ACTION_CONDITION_MAX} bounded names`;
    }
  }
  if (value.notes !== undefined) {
    const error = stringListError(value.notes, "action target notes");
    if (error) return error;
  }
  return null;
}

/** State derived from target rows. Terminal action-level failures/cancellation remain explicit. */
export function deriveActionState(targets: readonly ActionTarget[], fallback: ActionState = "resolved"): ActionState {
  if (targets.some((target) => target.state === "pending")) return "pending";
  const expired = targets.filter((target) => target.state === "expired").length;
  if (expired === targets.length && targets.length > 0) return "expired";
  if (expired > 0) return "partial";
  return fallback === "failed" || fallback === "cancelled" ? fallback : "resolved";
}

export function validateActionCard(value: unknown):
  { ok: true; action: ActionCard } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!object(value) || !exactKeys(value, ["v", "id", "revision", "kind", "label", "state", "source", "sceneId",
    "area", "targets", "notes", "createdAt", "updatedAt"]) || value.v !== ACTION_CARD_VERSION || !validId(value.id) ||
      !safeNonNegative(value.revision) || !(KINDS as readonly unknown[]).includes(value.kind) || !validText(value.label) ||
      !(STATES as readonly unknown[]).includes(value.state) || (value.sceneId !== undefined && !validId(value.sceneId)) ||
      !safeNonNegative(value.createdAt) || !safeNonNegative(value.updatedAt) || value.updatedAt < value.createdAt)
    return bad("invalid action card header");
  const source = entityError(value.source, "action source");
  if (source) return bad(source);
  if (value.area !== undefined) {
    const error = areaError(value.area);
    if (error) return bad(error);
    if (value.sceneId !== undefined && (value.area as ActionArea).sceneId !== value.sceneId)
      return bad("action area and action scene disagree");
  }
  if (!Array.isArray(value.targets) || value.targets.length > ACTION_TARGET_MAX)
    return bad(`action card needs at most ${ACTION_TARGET_MAX} targets`);
  const keys = new Set<string>();
  for (const target of value.targets) {
    const error = targetError(target);
    if (error) return bad(error);
    const key = (target as ActionTarget).key;
    if (keys.has(key)) return bad(`action target key ${key} is duplicated`);
    keys.add(key);
  }
  const notes = stringListError(value.notes, "action notes");
  if (notes) return bad(notes);
  if ((value.state === "failed" || value.state === "cancelled") &&
      (value.targets as ActionTarget[]).some((target) => target.state === "pending"))
    return bad(`terminal action state ${String(value.state)} cannot contain pending targets`);
  if (value.state !== "failed" && value.state !== "cancelled" &&
      deriveActionState(value.targets as ActionTarget[]) !== value.state)
    return bad(`action state ${String(value.state)} disagrees with its targets`);
  return { ok: true, action: value as unknown as ActionCard };
}

/** Read a validated action card from a message; malformed historical payloads render as plain chat. */
export function actionCardOf(message: Pick<MessageDocument, "system"> | null | undefined): ActionCard | null {
  const value = message?.system?.action;
  const checked = validateActionCard(value);
  return checked.ok ? checked.action : null;
}

/** Host normalization for a newly committed card: one identity and one authoritative timestamp. */
export function normalizeNewActionCard(action: ActionCard, messageId: string, at: number): ActionCard {
  const sceneId = action.sceneId ?? action.area?.sceneId;
  return { ...action, ...(sceneId === undefined ? {} : { sceneId }),
    id: messageId, revision: 0, createdAt: at, updatedAt: at };
}

/**
 * Resolve exactly the target linked by a pending roll. This is pure so HostSync, tests and future
 * non-chat action executors share one outcome rule. The pending payload is structural to avoid a
 * core→PF1e dependency.
 */
export function resolveActionPendingTarget(action: ActionCard, pending: {
  id?: string;
  actionId?: string;
  targetKey?: string;
  kind: "attack" | "save" | "check" | "concentration";
  dc: number | null;
}, total: number, at: number): { ok: true; action: ActionCard } | { ok: false; error: string } {
  if (pending.actionId !== action.id || !pending.targetKey)
    return { ok: false, error: "pending roll is not linked to this action" };
  const index = action.targets.findIndex((target) => target.key === pending.targetKey);
  const target = action.targets[index];
  if (!target || target.state !== "pending" || target.check?.status !== "pending")
    return { ok: false, error: "action target is not pending" };
  if (pending.id !== undefined && target.check.pendingRollId !== pending.id)
    return { ok: false, error: "pending roll does not match the action target" };
  const passed = pending.dc === null ? undefined : total >= pending.dc;
  const outcome: ActionTargetOutcome = pending.kind === "save"
    ? passed ? "saved" : "failedSave"
    : pending.kind === "attack" ? passed === undefined ? "rolled" : passed ? "hit" : "miss"
      : passed === undefined ? "rolled" : passed ? "succeeded" : "failed";
  const checkWithoutPendingId = { ...target.check };
  delete checkWithoutPendingId.pendingRollId;
  const nextTarget: ActionTarget = { ...target, state: "resolved", outcome,
    provenance: target.provenance === "host" ? "host" : "reported",
    check: { ...checkWithoutPendingId, status: "resolved", total,
      ...(passed !== undefined ? { passed } : {}) } };
  const targets = action.targets.map((entry, position) => position === index ? nextTarget : entry);
  return { ok: true, action: { ...action, revision: action.revision + 1,
    state: deriveActionState(targets), targets, updatedAt: Math.max(action.updatedAt, Math.trunc(at)) } };
}

/** Expiry is also an explicit card transition; it never silently turns into a failed save. */
export function expireActionPendingTarget(action: ActionCard, pending: {
  id?: string; actionId?: string; targetKey?: string;
}, at: number): ActionCard {
  if (pending.actionId !== action.id || !pending.targetKey) return action;
  const targets: ActionTarget[] = action.targets.map((target) => {
    if (target.key !== pending.targetKey || target.state !== "pending" ||
        (pending.id !== undefined && target.check?.pendingRollId !== pending.id)) return target;
    const provenance = target.provenance === "host" ? "host" as const : "reported" as const;
    if (!target.check) return { ...target, state: "expired", outcome: "expired", provenance };
    const checkWithoutPendingId = { ...target.check };
    delete checkWithoutPendingId.pendingRollId;
    return { ...target, state: "expired", outcome: "expired", provenance,
      check: { ...checkWithoutPendingId, status: "expired", total: null } };
  });
  if (targets.every((target, index) => target === action.targets[index])) return action;
  return { ...action, revision: action.revision + 1, state: deriveActionState(targets), targets,
    updatedAt: Math.max(action.updatedAt, Math.trunc(at)) };
}

/** The exact bounded payload future FX bindings consume after this card revision commits. */
export function actionFxContext(action: ActionCard): ActionFxContext {
  const verified = action.targets.length > 0 &&
    action.targets.every((target) => target.provenance === "host");
  return {
    v: 1,
    actionId: action.id,
    revision: action.revision,
    kind: action.kind,
    label: action.label,
    verified,
    ...(verified ? { state: action.state } : {}),
    at: action.updatedAt,
    source: {
      name: action.source.name,
      ...(action.source.actorId !== undefined ? { actorId: action.source.actorId } : {}),
      ...(action.source.tokenId !== undefined ? { tokenId: action.source.tokenId } : {}),
      ...(action.source.itemId !== undefined ? { itemId: action.source.itemId } : {}),
    },
    ...(action.sceneId !== undefined ? { sceneId: action.sceneId } : {}),
    ...(action.area !== undefined ? { area: {
      sceneId: action.area.sceneId,
      ...(action.area.ref !== undefined ? { ref: { ...action.area.ref } } : {}),
      shape: action.area.shape,
      origin: { ...action.area.origin },
      ...(action.area.radius !== undefined ? { radius: action.area.radius } : {}),
      ...(action.area.width !== undefined ? { width: action.area.width } : {}),
      ...(action.area.direction !== undefined ? { direction: { ...action.area.direction } } : {}),
      ...(action.area.units !== undefined ? { units: action.area.units } : {}),
    } } : {}),
    targets: action.targets.map((target) => {
      const verified = target.provenance === "host";
      return {
        key: target.key,
        name: target.name,
        ...(target.label !== undefined ? { label: target.label } : {}),
        ...(target.actorId !== undefined ? { actorId: target.actorId } : {}),
        ...(target.tokenId !== undefined ? { tokenId: target.tokenId } : {}),
        verified,
        ...(verified ? { state: target.state, outcome: target.outcome } : {}),
        ...(verified && target.check !== undefined ? { check: {
          kind: target.check.kind, status: target.check.status, dc: target.check.dc, total: target.check.total,
          ...(target.check.saveType !== undefined ? { saveType: target.check.saveType } : {}),
          ...(target.check.passed !== undefined ? { passed: target.check.passed } : {}),
          ...(target.check.automatic !== undefined ? { automatic: target.check.automatic } : {}),
        } } : {}),
        ...(verified && target.damage !== undefined ? { damage: { ...target.damage } } : {}),
        ...(verified && target.healing !== undefined ? { healing: { ...target.healing } } : {}),
        ...(verified && target.conditions !== undefined ? { conditions: {
          ...(target.conditions.applied !== undefined ? { applied: [...target.conditions.applied] } : {}),
          ...(target.conditions.removed !== undefined ? { removed: [...target.conditions.removed] } : {}),
        } } : {}),
      };
    }),
  };
}

/** JSON boundary helper with a compile-time assertion at the call site. */
export function actionAsJson(action: ActionCard): Json {
  return action as unknown as Json;
}
