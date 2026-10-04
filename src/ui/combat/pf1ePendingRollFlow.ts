/**
 * F03 — pending-roll flow gate (pure helper, no Svelte).
 *
 * Every tactical flow that currently does an immediate host roll for a
 * *reaction* (save in pf1eCastFlow/touchSpell, AoO in pf1eAooFlow,
 * parry) calls `shouldDeferToPlayer` BEFORE rolling. If true it returns the
 * single `create messages` Op that hosts the `system.pendingRoll` shell
 * (no `roll` total yet) and the caller returns — the reaction's damage/
 * condition application is deferred until the player's Roll resolves via
 * ChatPanel's `handlePendingRoll` (host-verified, one envelope
 * `[pendingRoll resolved + follow-up + ledgerOps]`).
 *
 * Auto mode skips this and rolls immediately (byte-identical to today).
 * Strategic mass-battle turns never use this gate (they have TurnReports).
 */

import type { Op } from "../../core/ops";
import type { RollMode } from "../../core/documents";
import type { CoreWorldSettings } from "../../core/worldSettings";
import { actionAsJson, type ActionCard } from "../../core/action";
import {
  buildPendingRoll,
  shouldDeferToPlayer,
  type PendingRollKind,
  type PendingRoll,
} from "../../packages/pf1e/pendingRoll";

export interface PendingRollGateInput {
  /** Optional canonical card identity/action link. Omission preserves legacy standalone cards. */
  messageId?: string;
  pendingId?: string;
  action?: ActionCard;
  content?: string;
  kind: PendingRollKind;
  saveType?: "fort" | "ref" | "will";
  initiator: PendingRoll["initiator"];
  target: PendingRoll["target"];
  formula: string;
  dc: number | null;
  modifiers: PendingRoll["modifiers"];
  turnNumber: number;
  rollMode?: RollMode;
  area?: PendingRoll["area"];
  targetIsPlayerOwned: boolean;
  worldSettings: CoreWorldSettings;
  isStrategic?: boolean;
}

/**
 * Return the single Op that creates the pending chat card, or null when the
 * caller should roll immediately (auto / non-player / strategic).
 */
export function pendingRollCreateOp(input: PendingRollGateInput): Op | null {
  const defer = shouldDeferToPlayer({
    kind: input.kind,
    targetIsPlayerOwned: input.targetIsPlayerOwned,
    worldSettings: input.worldSettings,
    ...(input.isStrategic !== undefined ? { isStrategic: input.isStrategic } : {}),
  });
  if (!defer) return null;
  const pending = buildPendingRoll({
    ...(input.pendingId !== undefined ? { id: input.pendingId } : {}),
    ...(input.action !== undefined ? { actionId: input.action.id } : {}),
    ...(input.action?.targets[0]?.key !== undefined ? { targetKey: input.action.targets[0].key } : {}),
    kind: input.kind,
    ...(input.saveType !== undefined ? { saveType: input.saveType } : {}),
    initiator: input.initiator,
    target: input.target,
    formula: input.formula,
    dc: input.dc,
    modifiers: input.modifiers,
    turnNumber: input.turnNumber,
    ...(input.rollMode !== undefined ? { rollMode: input.rollMode } : {}),
    ...(input.area !== undefined ? { area: input.area } : {}),
  });
  const author = input.initiator.actorId as unknown as string;
  return {
    kind: "create",
    coll: "messages",
    data: {
      _id: input.messageId ?? globalThis.crypto?.randomUUID?.() ?? `msg-pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "message",
      name: `${pending.target.name} pending ${pending.kind}`,
      ownership: { default: 1 },
      flags: {},
      system: { pendingRoll: pending,
        ...(input.action !== undefined ? { action: actionAsJson(input.action) } : {}) },
      author,
      content: input.content ?? `${pending.initiator.name} → ${pending.initiator.actionLabel} → ${pending.target.name} — pending (${pending.formula}${pending.dc !== null ? ` vs DC ${pending.dc}` : ""})`,
      whisper: [] as string[],
      roll: null,
      flavor: "",
      rollMode: pending.rollMode,
    },
  } as unknown as Op;
}

/** For tests: the pure predicate, re-exported. */
export { shouldDeferToPlayer };
