/**
 * F03 — Player Reaction Pending Rolls (pure, no store).
 *
 * Non-strategic only. When a reaction roll (save, concentration, AoO/parry)
 * targets a player-owned token, the host creates a pending chat card instead
 * of rolling immediately. The card holds `PendingRoll` in
 * `MessageDocument.system.pendingRoll` (versioned v:1). The roll stays
 * unresolved (no total, no seedHost) until the owning player presses Roll —
 * the host then evaluates deterministically (seedClient commit-reveal) and
 * writes HP/condition Ops authoritatively in one envelope.
 *
 * World settings: `playerPendingRollMode` = "auto" (never pending) |
 * "savesChecksAuto" (only attack/AoO pending, saves auto) | "manual" (all).
 * Default "savesChecksAuto". Strategic (simultaneous mass-battle) never
 * pending — see `shouldDeferToPlayer`.
 */

import type { DocId, UserId } from "../../core/ids";
import type { Json, Ownership, RollMode } from "../../core/documents";
import type { Op } from "../../core/ops";
import type { CoreWorldSettings } from "../../core/worldSettings";
import { playerPendingRollModeOf } from "../../core/worldSettings";
import { actionAsJson, actionCardOf, expireActionPendingTarget } from "../../core/action";

export type PendingRollKind = "attack" | "save" | "check" | "concentration";

export interface PendingRollInitiator {
  actorId: DocId;
  tokenId: DocId | null;
  name: string;
  actionLabel: string;
}

export interface PendingRollTarget {
  actorId: DocId;
  tokenId: DocId | null;
  name: string;
}

export const PENDING_ROLL_MAX = 64;
export const PENDING_ROLL_MODIFIER_MAX = 32;
const PENDING_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PENDING_TEXT_MAX = 300;

export interface PendingRoll {
  v: 1;
  /** Stable selector when an action card contains more than one pending reaction. Optional on legacy cards. */
  id?: string;
  /** Canonical action-card linkage. The host updates that target in the same envelope as this roll. */
  actionId?: string;
  targetKey?: string;
  kind: PendingRollKind;
  /** Save kind is explicit for action/FX consumers; legacy pending saves infer it from their label. */
  saveType?: "fort" | "ref" | "will";
  initiator: PendingRollInitiator;
  target: PendingRollTarget;
  /** The d20 formula the player will roll, e.g. "1d20+5". */
  formula: string;
  /** DC or AC the host evaluates against, null = dynamic (attack vs AC). */
  dc: number | null;
  /** Modifier breakdown without totals — same source as rollLedger. */
  modifiers: Array<{ label: string; value: number; reason: string }>;
  seedClientCommit?: string | null;
  seedHost?: string | null;
  total?: number | null;
  turnNumber: number;
  /** Inclusive upper bound — host refuses after this turn. */
  expiresTurn: number;
  resolved: boolean;
  rollMode: RollMode;
  /** Optional area payload for spell/effect reactions — kept for highlight. */
  area?: {
    shape: "burst" | "cone" | "line" | "cylinder" | "spread" | "emanation";
    origin: { x: number; y: number };
    radiusFt: number;
    direction?: { x: number; y: number };
  } | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const pendingId = (value: unknown): value is string => typeof value === "string" && PENDING_ID.test(value);
const boundedText = (value: unknown, max = PENDING_TEXT_MAX): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max &&
  ![...value].some((char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t");
const safeTurn = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const coordinate = (value: unknown): value is number => finite(value) && Math.abs(value) <= 1_000_000;

/** Strict bounded reader for untrusted/historical pending-roll JSON. */
export function validatePendingRoll(value: unknown):
  { ok: true; pending: PendingRoll } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!record(value) || !exact(value, ["v", "id", "actionId", "targetKey", "kind", "saveType", "initiator",
    "target", "formula", "dc", "modifiers", "seedClientCommit", "seedHost", "total", "turnNumber",
    "expiresTurn", "resolved", "rollMode", "area"]) || value.v !== 1 ||
      !["attack", "save", "check", "concentration"].includes(String(value.kind)) ||
      (value.id !== undefined && !pendingId(value.id)) ||
      (value.actionId !== undefined && !pendingId(value.actionId)) ||
      (value.targetKey !== undefined && !pendingId(value.targetKey)) ||
      ((value.actionId === undefined) !== (value.targetKey === undefined)) ||
      (value.actionId !== undefined && value.id === undefined) ||
      (value.saveType !== undefined && !["fort", "ref", "will"].includes(String(value.saveType))) ||
      !boundedText(value.formula, 160) || !(value.dc === null || finite(value.dc)) ||
      !safeTurn(value.turnNumber) || !safeTurn(value.expiresTurn) || value.expiresTurn < value.turnNumber ||
      value.expiresTurn > (value.turnNumber as number) + 100 || typeof value.resolved !== "boolean" ||
      !["roll", "gmroll", "blindroll", "selfroll"].includes(String(value.rollMode)))
    return bad("pending roll header is malformed");

  const entity = (candidate: unknown, initiator: boolean): boolean => record(candidate) &&
    exact(candidate, initiator ? ["actorId", "tokenId", "name", "actionLabel"] : ["actorId", "tokenId", "name"]) &&
    pendingId(candidate.actorId) && (candidate.tokenId === null || pendingId(candidate.tokenId)) &&
    boundedText(candidate.name, 160) && (!initiator || boundedText(candidate.actionLabel, PENDING_TEXT_MAX));
  if (!entity(value.initiator, true) || !entity(value.target, false))
    return bad("pending roll actors are malformed");

  if (!Array.isArray(value.modifiers) || value.modifiers.length > PENDING_ROLL_MODIFIER_MAX ||
      value.modifiers.some((modifier) => !record(modifier) || !exact(modifier, ["label", "value", "reason"]) ||
        !boundedText(modifier.label, 100) || !finite(modifier.value) || !boundedText(modifier.reason, 160)))
    return bad("pending roll modifiers are malformed");
  for (const seed of [value.seedClientCommit, value.seedHost]) {
    if (seed !== undefined && seed !== null && (!boundedText(seed, 256) || /\s/.test(seed)))
      return bad("pending roll seed is malformed");
  }
  if (value.total !== undefined && value.total !== null && !finite(value.total))
    return bad("pending roll total is malformed");
  if (value.resolved === false && value.total !== undefined && value.total !== null)
    return bad("an unresolved pending roll cannot have a total");
  if (value.resolved === true && !finite(value.total))
    return bad("a resolved pending roll needs a total");

  if (value.area !== undefined && value.area !== null) {
    if (!record(value.area) || !exact(value.area, ["shape", "origin", "radiusFt", "direction"]) ||
        !["burst", "cone", "line", "cylinder", "spread", "emanation"].includes(String(value.area.shape)) ||
        !record(value.area.origin) || !exact(value.area.origin, ["x", "y"]) ||
        !coordinate(value.area.origin.x) || !coordinate(value.area.origin.y) ||
        !finite(value.area.radiusFt) || value.area.radiusFt < 0 || value.area.radiusFt > 1_000_000)
      return bad("pending roll area is malformed");
    if (value.area.direction !== undefined && (!record(value.area.direction) ||
        !exact(value.area.direction, ["x", "y"]) || !coordinate(value.area.direction.x) ||
        !coordinate(value.area.direction.y))) return bad("pending roll area direction is malformed");
  }
  return { ok: true, pending: value as unknown as PendingRoll };
}

/** Build a pending roll for a fresh card. */
export function buildPendingRoll(input: {
  id?: string;
  actionId?: string;
  targetKey?: string;
  kind: PendingRollKind;
  saveType?: "fort" | "ref" | "will";
  initiator: PendingRollInitiator;
  target: PendingRollTarget;
  formula: string;
  dc: number | null;
  modifiers: Array<{ label: string; value: number; reason: string }>;
  turnNumber: number;
  rollMode?: RollMode;
  area?: PendingRoll["area"];
  seedClientCommit?: string | null;
}): PendingRoll {
  const turn = Math.trunc(input.turnNumber);
  return {
    v: 1,
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
    ...(input.targetKey !== undefined ? { targetKey: input.targetKey } : {}),
    kind: input.kind,
    ...(input.saveType !== undefined ? { saveType: input.saveType } : {}),
    initiator: input.initiator,
    target: input.target,
    formula: input.formula,
    dc: input.dc ?? null,
    modifiers: input.modifiers,
    seedClientCommit: input.seedClientCommit ?? null,
    seedHost: null,
    total: null,
    turnNumber: turn,
    expiresTurn: turn + 2,
    resolved: false,
    rollMode: input.rollMode ?? "roll",
    area: input.area ?? null,
  };
}

/** True when the pending card has left the 2-round window. */
export function isPendingExpired(
  pending: Pick<PendingRoll, "expiresTurn">,
  currentTurn: number,
): boolean {
  return currentTurn > pending.expiresTurn;
}

/**
 * True when a player may press Roll for this card. `ownerIds` is the caller's
 * ownership verdict for the roller (initiator for attacks, target otherwise):
 * pass the resolved owner list — the player must be in it. When omitted (unit
 * tests of the window only), the window alone decides.
 */
export function canPlayerRoll(
  pending: Pick<PendingRoll, "resolved" | "expiresTurn">,
  currentTurn: number,
  playerId: UserId,
  ownerIds?: readonly UserId[],
): boolean {
  if (pending.resolved) return false;
  if (isPendingExpired(pending, currentTurn)) return false;
  if (ownerIds !== undefined) return ownerIds.includes(playerId);
  return true;
}

/** GM may always resolve a pending card inside its window (or auto-resolve). */
export function canGMRoll(
  pending: Pick<PendingRoll, "resolved" | "expiresTurn">,
  currentTurn: number,
): boolean {
  if (pending.resolved) return false;
  return !isPendingExpired(pending, currentTurn);
}

/**
 * Whether a reaction for a player-owned target should be deferred to the
 * player instead of host-rolling immediately.
 *
 * - Strategic is never pending (mass-battle TurnReports, no per-model cards).
 * - Non-player targets never pending.
 * - Mode branching: auto = never, savesChecksAuto = attack only, manual = all.
 */
export function shouldDeferToPlayer(input: {
  kind: PendingRollKind;
  targetIsPlayerOwned: boolean;
  worldSettings: CoreWorldSettings;
  isStrategic?: boolean;
  turnMode?: string | null;
}): boolean {
  if (input.isStrategic === true) return false;
  if (input.turnMode === "simultaneous") return false;
  if (!input.targetIsPlayerOwned) return false;
  const mode = playerPendingRollModeOf(input.worldSettings);
  if (mode === "auto") return false;
  if (mode === "savesChecksAuto") return input.kind === "attack";
  if (mode === "manual") return true;
  return false;
}

/** Convenience: player-owned predicate over an Ownership map. */
export function isPlayerOwned(ownership: Ownership | null | undefined): boolean {
  if (!ownership) return false;
  for (const [key, level] of Object.entries(ownership)) {
    if (key === "default") continue;
    if (typeof level === "number" && level >= 1) return true;
  }
  return false;
}

/** Resolve a pending roll: fill total/seeds/resolved, disable buttons. */
export function resolvePendingRoll(
  pending: PendingRoll,
  input: {
    total: number;
    seedClient: string;
    seedHost: string;
  },
): PendingRoll {
  return {
    ...pending,
    total: input.total,
    seedClientCommit: input.seedClient,
    seedHost: input.seedHost,
    resolved: true,
  };
}

/** Ops that mark a pending card as resolved (host envelope will also include HP writes). */
export function pendingResolveOps(input: {
  messageId: DocId;
  pending: PendingRoll;
  total: number;
  seedClient: string;
  seedHost: string;
}): Op[] {
  const updated = resolvePendingRoll(input.pending, {
    total: input.total,
    seedClient: input.seedClient,
    seedHost: input.seedHost,
  });
  return [
    {
      kind: "update",
      ref: { coll: "messages", id: input.messageId },
      diff: { "system.pendingRoll": updated as unknown as Json } as Record<string, Json>,
    },
  ];
}

/** Both storage shapes: legacy/single-target `pendingRoll`, and bounded multi-target `pendingRolls`. */
export function pendingRollsOfSystem(system: unknown): PendingRoll[] {
  if (!system || typeof system !== "object" || Array.isArray(system)) return [];
  const record = system as { pendingRoll?: unknown; pendingRolls?: unknown };
  const rolls: PendingRoll[] = [];
  const singular = validatePendingRoll(record.pendingRoll);
  if (singular.ok) rolls.push(singular.pending);
  if (Array.isArray(record.pendingRolls)) {
    for (const value of record.pendingRolls.slice(0, PENDING_ROLL_MAX)) {
      const checked = validatePendingRoll(value);
      if (checked.ok) rolls.push(checked.pending);
    }
  }
  return rolls;
}

/** Select one pending roll. Omitted id remains compatible only when the card has one candidate. */
export function pendingRollOfSystem(system: unknown, id?: string): PendingRoll | null {
  const rolls = pendingRollsOfSystem(system);
  if (id !== undefined) return rolls.find((roll) => roll.id === id) ?? null;
  return rolls.length === 1 ? rolls[0] ?? null : null;
}

/** Replace one selected roll without trusting a caller-supplied array index. */
export function pendingRollUpdateDiff(system: unknown, before: PendingRoll, after: PendingRoll): Record<string, Json> | null {
  if (!system || typeof system !== "object" || Array.isArray(system)) return null;
  const record = system as { pendingRoll?: unknown; pendingRolls?: unknown };
  if (record.pendingRoll === before || (record.pendingRoll && !Array.isArray(record.pendingRoll) &&
      before.id !== undefined && (record.pendingRoll as PendingRoll).id === before.id))
    return { "system.pendingRoll": after as unknown as Json };
  if (!Array.isArray(record.pendingRolls)) return null;
  const index = record.pendingRolls.findIndex((roll) => roll === before || before.id !== undefined &&
    !!roll && typeof roll === "object" && (roll as PendingRoll).id === before.id);
  if (index < 0) return null;
  const pendingRolls = [...record.pendingRolls] as PendingRoll[];
  pendingRolls[index] = after;
  return { "system.pendingRolls": pendingRolls as unknown as Json };
}

/** Which cards are still pending and inside window. */
export function pendingActive<T extends { system?: Record<string, unknown> }>(
  messages: readonly T[],
  currentTurn: number,
): T[] {
  return messages.filter((message) => pendingRollsOfSystem(message.system)
    .some((pending) => !pending.resolved && !isPendingExpired(pending, currentTurn)));
}

/**
 * Prune expired rolls while keeping their action card honest. Multi-target cards retain active
 * siblings; the expired target transitions explicitly and can never be mistaken for a failed save.
 */
export function pendingPruneOps(
  messages: ReadonlyArray<{ _id: DocId; system?: Record<string, unknown> }>,
  currentTurn: number,
  at: number = currentTurn,
): Op[] {
  const ops: Op[] = [];
  for (const message of messages) {
    const all = pendingRollsOfSystem(message.system);
    const expired = all.filter((pending) => !pending.resolved && isPendingExpired(pending, currentTurn));
    if (expired.length === 0) continue;
    const system = message.system ?? {};
    const hasArray = Array.isArray((system as { pendingRolls?: unknown }).pendingRolls);
    const diff: Record<string, Json | null> = hasArray
      ? { "system.pendingRolls": all.filter((pending) => !expired.includes(pending)) as unknown as Json,
          "system.pendingRollPrunedAt": currentTurn }
      : { "system.pendingRoll": null, "system.pendingRollPrunedAt": currentTurn };
    const action = actionCardOf({ system: system as unknown as Record<string, Json> });
    if (action) {
      let next = action;
      for (const pending of expired) next = expireActionPendingTarget(next, pending, at);
      if (next !== action) diff["system.action"] = actionAsJson(next);
    }
    ops.push({ kind: "update", ref: { coll: "messages", id: message._id }, diff });
  }
  return ops;
}
