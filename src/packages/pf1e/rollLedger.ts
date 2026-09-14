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
import { computeInverse, type DocReader } from "../../core/oplog";

/**
 * The ledger window clock for tactical play: the highest live encounter round
 * (CombatDocument.round, 0 before combat starts / after it ends). One helper so
 * host handlers, chat UI and card-authoring flows all read the same clock; the
 * strategic TurnEngine has its own turnNumber and never authorizes these cards.
 */
export function tacticalLedgerTurn(
  combats: readonly { round?: unknown }[],
): number {
  let max = 0;
  for (const c of combats) {
    if (typeof c.round === "number" && Number.isFinite(c.round))
      max = Math.max(max, Math.trunc(c.round));
  }
  return max;
}

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
 * Inverse of a ledger's Ops — the stored pre-images ONLY.
 * There is deliberately no best-effort fallback: replaying the forward Ops in
 * reverse order would re-apply the POST-values and silently fail to revert.
 * Callers refuse by name when no pre-images were captured at authoring time.
 */
export function invertLedger(
  ledger: Pick<RollLedger, "ledgerOps" | "ledgerInverses">,
): Op[] | null {
  if (ledger.ledgerInverses.length === 0) return null;
  return [...ledger.ledgerInverses];
}

/**
 * Capture pre-image inverses for a batch of ledger Ops against the store state
 * BEFORE the Ops are submitted (§8 `computeInverse` semantics). Flows call this
 * at authoring time so Reroll/Revert have real pre-images to replay.
 */
export function captureLedgerInverses(reader: DocReader, ops: readonly Op[]): Op[] {
  const inverses: Op[] = [];
  for (const op of ops) {
    const inverse = computeInverse(reader, op);
    if (inverse !== null) inverses.push(inverse);
  }
  return inverses;
}

/** Read a dotted diff path (with optional `-=` deletion prefix) off a document. */
function readDiffPath(doc: unknown, key: string): unknown {
  const path = key.startsWith("-=") ? key.slice(2) : key;
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Staleness gate for revert/reroll (F01 spec: refuse with
 * "ledger stale — effects changed since"). Every recorded update Op's post-value
 * must still be the current stored value; a later unrelated write that touched
 * the same path makes the inverse diverge. Deleted target documents and missing
 * pre-images are also named refusals. Returns the refusal reason, or null when
 * replaying the inverse is sound.
 */
export function ledgerStaleReason(
  ledger: Pick<RollLedger, "ledgerOps" | "ledgerInverses">,
  reader: DocReader,
): string | null {
  if (ledger.ledgerInverses.length === 0 && ledger.ledgerOps.length > 0)
    return "ledger has no pre-images — authored before F01 inverses, revert is impossible by design";
  for (const op of ledger.ledgerOps) {
    if (op.kind === "update") {
      const doc = reader.resolve(op.ref);
      if (doc === undefined) return "ledger stale — a target document was deleted";
      for (const [key, postValue] of Object.entries(op.diff)) {
        if (key.startsWith("-=")) {
          // A deletion recorded that the path existed before; only requires the doc to exist.
          continue;
        }
        const current = readDiffPath(doc, key);
        if (JSON.stringify(current) !== JSON.stringify(postValue))
          return "ledger stale — effects changed since";
      }
    } else if (op.kind === "create") {
      // Inverse deletes the created doc; it must still exist.
      const id = (op.data as { _id?: string })._id;
      if (typeof id !== "string" || reader.resolve({ coll: op.coll, id, ...(op.parent !== undefined ? { parent: op.parent } : {}) }) === undefined)
        return "ledger stale — a created document is already gone";
    }
    // delete: inverse recreates the doc — always sound.
  }
  return null;
}

/**
 * HP-only delta gate: the honest v1 reroll recompute covers ledgers whose every
 * effect Op is an `update` on `actors` writing exactly one numeric HP path
 * (`system.pf1e.hp` / `system.pf1e.nonlethal`) — plain attack/damage cards.
 * Condition/ammo/temp-HP/anything-else ledgers are refused by name, so a reroll
 * never fabricates effects it cannot recompute.
 */
const DELTA_HP_PATHS = new Set(["system.pf1e.hp", "system.pf1e.nonlethal"]);

function deltaHpKeyOf(op: Op): string | null {
  if (op.kind !== "update" || op.ref.coll !== "actors") return null;
  if (op.ref.parent !== undefined) return null;
  const keys = Object.keys(op.diff);
  if (keys.length !== 1) return null;
  const [key] = keys;
  if (key === undefined) return null;
  return DELTA_HP_PATHS.has(key) ? key : null;
}

/**
 * Recompute effect Ops for a reroll by the damage delta: every HP write shifts
 * by Σ(new damage totals) − Σ(old damage totals), clamped at 0 (a rerolled
 * damage total never heals beyond the recorded post-value going negative).
 * The attack roll is re-rolled for the audit trail by the caller; hit/miss
 * re-adjudication needs a defense snapshot the v1 ledger does not carry, so
 * cards with an attack roll and HP writes keep the recorded hit — the follow-up
 * line states the dice honestly. Refuses by name for anything but HP-only
 * ledgers, and when the ledger carries a damage write but no damage roll.
 */
export function planDamageDeltaReroll(input: {
  ledger: RollLedger;
  newRolls: readonly RollLedgerRoll[];
}): { ok: true; ops: Op[] } | { ok: false; reason: string } {
  const { ledger } = input;
  if (ledger.ledgerOps.length === 0) return { ok: true, ops: [] };
  const oldDamage = ledger.rolls
    .filter((r) => r.kind === "damage")
    .reduce((sum, r) => sum + r.total, 0);
  const newDamage = input.newRolls
    .filter((r) => r.kind === "damage")
    .reduce((sum, r) => sum + r.total, 0);
  if (oldDamage === 0 && !ledger.rolls.some((r) => r.kind === "damage"))
    return { ok: false, reason: "rerolled effects are not damage-driven — revert and roll manually" };
  const delta = newDamage - oldDamage;
  const ops: Op[] = [];
  for (const op of ledger.ledgerOps) {
    const key = deltaHpKeyOf(op);
    if (key === null)
      return {
        ok: false,
        reason: "card writes more than HP — reroll cannot recompute it; revert and roll manually",
      };
    if (op.kind !== "update") return { ok: false, reason: "unsupported op" }; // unreachable: narrowed by deltaHpKeyOf
    const postValue = op.diff[key];
    if (typeof postValue !== "number" || !Number.isFinite(postValue))
      return { ok: false, reason: "ledger HP write is not numeric" };
    const next = Math.max(0, postValue + delta);
    ops.push({ kind: "update", ref: op.ref, diff: { [key]: next as Json } });
  }
  return { ok: true, ops };
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
  if (inverse === null && input.ledger.ledgerOps.length > 0) return null;
  const updated: RollLedger = {
    ...input.ledger,
    rolls: input.newRolls,
    ledgerOps: input.newLedgerOps,
    ledgerInverses: input.newLedgerInverses ?? [],
    rerollCount: input.ledger.rerollCount + 1,
    pendingReroll: null,
  };
  return [
    ...(inverse ?? []),
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
  if (inverse === null && input.ledger.ledgerOps.length > 0) return null;
  const updated: RollLedger = { ...input.ledger, reverted: true, pendingReroll: null };
  return [
    ...(inverse ?? []),
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
