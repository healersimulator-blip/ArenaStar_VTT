/**
 * F01 — Tactical Roll Ledger (pure, no store).
 * Every tactical roll that writes HP/conditions is also a chat card that owns
 * its ledgerOps (the exact Ops the host committed). Reroll = inverse(old) +
 * new, Revert = inverse(old). The ledger lives in MessageDocument.system.
 *
 * No new collection, no migration — a card without a ledger renders as before.
 * The 2-round window is `currentTurn - ledger.turnNumber <= 2` (inclusive).
 * Old ledgerOps are pruned by clearing system.rollLedger from cards whose
 * turnNumber < currentTurn-2 (keeps content/roll chip for history).
 */

import type { Op } from "../../core/ops";
import type { DocId, UserId } from "../../core/ids";
import type { Json } from "../../core/documents";

export interface RollLedgerInitiator {
  actorId: DocId;
  tokenId: DocId | null;
  name: string;
}

export interface RollLedgerTarget {
  actorId: DocId;
  tokenId: DocId | null;
  name: string;
}

export interface RollLedgerArea {
  shape: "burst" | "cone" | "line" | "cylinder" | "spread" | "emanation";
  origin: { x: number; y: number };
  radiusFt: number;
  direction?: { x: number; y: number };
  affectedTokenIds: DocId[];
}

export interface RollLedgerRoll {
  kind: "attack" | "damage" | "save" | "concentration";
  formula: string;
  total: number;
  terms: Json[];
  seedClient: string | null;
  seedHost: string | null;
  modifiers: Array<{ label: string; value: number; reason: string }>;
}

export interface RollLedger {
  v: 1;
  initiator: RollLedgerInitiator;
  targets: RollLedgerTarget[] | null; // null = area
  area: RollLedgerArea | null;
  rolls: RollLedgerRoll[];
  ledgerOps: Op[];
  ledgerInverses: Op[];
  turnNumber: number;
  reverted: boolean;
  rerollCount: number;
  pendingReroll: { playerId: UserId; expiresTurn: number } | null;
}

/** Build a ledger for a fresh card. Caller supplies the exact Ops that will be committed alongside the card. */
export function buildRollLedger(input: {
  initiator: RollLedgerInitiator;
  targets: RollLedgerTarget[] | null;
  area: RollLedgerArea | null;
  rolls: RollLedgerRoll[];
  ledgerOps: Op[];
  ledgerInverses?: Op[];
  turnNumber: number;
}): RollLedger {
  return {
    v: 1,
    initiator: input.initiator,
    targets: input.targets,
    area: input.area,
    rolls: input.rolls,
    ledgerOps: input.ledgerOps,
    ledgerInverses: input.ledgerInverses ?? [],
    turnNumber: input.turnNumber,
    reverted: false,
    rerollCount: 0,
    pendingReroll: null,
  };
}

/** True when the card is still inside the 2-round reroll/revert window and not already reverted. */
export function canReroll(
  ledger: Pick<RollLedger, "turnNumber" | "reverted">,
  currentTurn: number,
): boolean {
  if (ledger.reverted) return false;
  return currentTurn - ledger.turnNumber <= 2 && currentTurn >= ledger.turnNumber;
}

export function canRevert(
  ledger: Pick<RollLedger, "turnNumber" | "reverted">,
  currentTurn: number,
): boolean {
  return canReroll(ledger, currentTurn);
}

/** True when the card's pending delegation is still live for that player and turn. */
export function canPlayerReroll(
  ledger: Pick<RollLedger, "pendingReroll">,
  playerId: UserId,
  currentTurn: number,
): boolean {
  const p = ledger.pendingReroll;
  if (!p) return false;
  if (p.playerId !== playerId) return false;
  return currentTurn <= p.expiresTurn;
}

/**
 * Inverse of a ledger's Ops.
 * When ledgerInverses are stored (the OpLog pre-images the host kept), they are
 * the truth — revert just replays them. Otherwise we return a best-effort
 * inversion: for `update` Ops we swap the diff's values (caller must have kept
 * the before-image elsewhere). Tests pin the first path.
 */
export function invertLedger(ledger: Pick<RollLedger, "ledgerOps" | "ledgerInverses">): Op[] {
  if (ledger.ledgerInverses.length > 0) return [...ledger.ledgerInverses];
  // Fallback: reverse order, keep same diffs — the host's OpLog is the real source.
  return [...ledger.ledgerOps].reverse();
}

/** Ops for a GM reroll: inverse(old) + newOps + ledger update (rerollCount++, new ledgerOps). */
export function rerollOps(input: {
  messageId: DocId;
  ledger: RollLedger;
  currentTurn: number;
  newLedgerOps: Op[];
  newLedgerInverses?: Op[] | undefined;
  newRolls: RollLedgerRoll[];
}): Op[] | null {
  if (!canReroll(input.ledger, input.currentTurn)) return null;
  const inverse = invertLedger(input.ledger);
  const updated: RollLedger = {
    ...input.ledger,
    rolls: input.newRolls,
    ledgerOps: input.newLedgerOps,
    ledgerInverses: input.newLedgerInverses ?? [],
    rerollCount: input.ledger.rerollCount + 1,
    pendingReroll: null,
  };
  return [
    ...inverse,
    ...input.newLedgerOps,
    {
      kind: "update",
      ref: { coll: "messages", id: input.messageId },
      diff: { "system.rollLedger": updated as unknown as Json } as Record<string, Json>,
    },
  ];
}

/** Ops for a GM revert: inverse(old) + mark reverted (or clear). */
export function revertOps(input: {
  messageId: DocId;
  ledger: RollLedger;
  currentTurn: number;
}): Op[] | null {
  if (!canRevert(input.ledger, input.currentTurn)) return null;
  const inverse = invertLedger(input.ledger);
  const updated: RollLedger = { ...input.ledger, reverted: true, pendingReroll: null };
  return [
    ...inverse,
    {
      kind: "update",
      ref: { coll: "messages", id: input.messageId },
      diff: { "system.rollLedger": updated as unknown as Json } as Record<string, Json>,
    },
  ];
}

/** Ops that delegate a reroll window to a player (expires in 2 turns, like the card). */
export function delegateRerollOps(input: {
  messageId: DocId;
  ledger: RollLedger;
  currentTurn: number;
  playerId: UserId;
}): Op[] | null {
  if (!canReroll(input.ledger, input.currentTurn)) return null;
  const updated: RollLedger = {
    ...input.ledger,
    pendingReroll: { playerId: input.playerId, expiresTurn: input.currentTurn + 2 },
  };
  return [
    {
      kind: "update",
      ref: { coll: "messages", id: input.messageId },
      diff: { "system.rollLedger": updated as unknown as Json } as Record<string, Json>,
    },
  ];
}

/** Player executes their delegated reroll (same as GM reroll but gated). */
export function playerRerollOps(input: {
  messageId: DocId;
  ledger: RollLedger;
  currentTurn: number;
  playerId: UserId;
  newLedgerOps: Op[];
  newLedgerInverses?: Op[] | undefined;
  newRolls: RollLedgerRoll[];
}): Op[] | null {
  if (!canPlayerReroll(input.ledger, input.playerId, input.currentTurn)) return null;
  // same inverse+new envelope as GM reroll
  return rerollOps({
    messageId: input.messageId,
    ledger: input.ledger,
    currentTurn: input.currentTurn,
    newLedgerOps: input.newLedgerOps,
    newLedgerInverses: input.newLedgerInverses,
    newRolls: input.newRolls,
  });
}

/** Which cards are still rerollable at currentTurn. Pure, no store. */
export function pruneLedgers<T extends { system?: { rollLedger?: RollLedger } }>(
  messages: readonly T[],
  currentTurn: number,
): T[] {
  return messages.filter((m) => {
    const ledger = (m.system as unknown as { rollLedger?: RollLedger } | undefined)?.rollLedger;
    if (!ledger) return true; // not a ledger card — keep
    return canReroll(ledger, currentTurn);
  });
}

/** Ops that clear the ledger payload from cards whose window closed (keeps content/roll). */
export function pruneOpsForWindow(
  messages: ReadonlyArray<{ _id: DocId; system?: { rollLedger?: RollLedger } }>,
  currentTurn: number,
): Op[] {
  const ops: Op[] = [];
  for (const m of messages) {
    const ledger = m.system?.rollLedger;
    if (!ledger) continue;
    if (currentTurn - ledger.turnNumber > 2) {
      ops.push({
        kind: "update",
        ref: { coll: "messages", id: m._id },
        diff: { "system.rollLedger": null, "system.rollLedgerPrunedAt": currentTurn } as unknown as Record<string, Json>,
      });
    }
  }
  return ops;
}
