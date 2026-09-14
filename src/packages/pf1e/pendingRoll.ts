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

export interface PendingRoll {
  v: 1;
  kind: PendingRollKind;
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

/** Build a pending roll for a fresh card. */
export function buildPendingRoll(input: {
  kind: PendingRollKind;
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
    kind: input.kind,
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

/** True when a player may press Roll for this card. */
export function canPlayerRoll(
  pending: Pick<PendingRoll, "resolved" | "expiresTurn">,
  currentTurn: number,
  _playerId: UserId,
  _ownerIds?: readonly UserId[],
): boolean {
  if (pending.resolved) return false;
  if (isPendingExpired(pending, currentTurn)) return false;
  // Ownership check is caller-owned: pass ownerIds when available.
  // If no owner list is supplied we treat window as sufficient (tests pin window).
  if (_ownerIds !== undefined && _ownerIds.length === 0) return false;
  if (_ownerIds !== undefined && !_ownerIds.includes(_playerId as unknown as UserId)) return false;
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

/** Which cards are still pending and inside window. */
export function pendingActive<T extends { system?: { pendingRoll?: PendingRoll } }>(
  messages: readonly T[],
  currentTurn: number,
): T[] {
  return messages.filter((m) => {
    const p = (m.system as unknown as { pendingRoll?: PendingRoll } | undefined)?.pendingRoll;
    if (!p) return false;
    if (p.resolved) return false;
    return !isPendingExpired(p, currentTurn);
  });
}

/** Ops that prune the pendingRoll payload from cards whose window closed (keeps content). */
export function pendingPruneOps(
  messages: ReadonlyArray<{ _id: DocId; system?: { pendingRoll?: PendingRoll } }>,
  currentTurn: number,
): Op[] {
  const ops: Op[] = [];
  for (const m of messages) {
    const p = m.system?.pendingRoll;
    if (!p) continue;
    if (isPendingExpired(p, currentTurn) && !p.resolved) {
      ops.push({
        kind: "update",
        ref: { coll: "messages", id: m._id },
        diff: {
          "system.pendingRoll": null,
          "system.pendingRollPrunedAt": currentTurn,
        } as unknown as Record<string, Json>,
      });
    }
  }
  return ops;
}
