/**
 * P05/D-208 — maneuver planners: the check's verdict turned into the exact
 * ops the host authorizes. Each planner is pure (no dice, no store): the
 * caller supplies the die face, the derivation's CMB/CMD and every state
 * fact; the planner returns the ops the sheet/CombatPanel submit.
 *
 * Trip / overrun / dirty trick write the prone/condition that the aftermath
 * names — the same `system.pf1e.conditions` list `pf1eDyingTick` writes.
 * Bull rush / drag / reposition are *movement* — the note carries the
 * distance and the caller moves the token (the map, not this module).
 * Disarm / steal are item concerns — the note is the contract, the item
 * write is the sheet's own editor (no silent inventory mutation here).
 */
import type { ActorDocument } from "../../core/documents";
import type { Op } from "../../core/ops";
import {
  pf1eBullRush,
  pf1eDirtyTrick,
  pf1eDisarm,
  pf1eDrag,
  pf1eOverrun,
  pf1eReposition,
  pf1eSteal,
  pf1eTrip,
  type PF1eManeuverCheckInput,
} from "../../packages/pf1e/maneuvers";

export interface PF1eManeuverPlan {
  ops: Op[];
  note: string;
}

function conditionsOf(actor: ActorDocument): string[] {
  const pf1e = (actor.system as { pf1e?: Record<string, unknown> }).pf1e ?? {};
  const raw = pf1e.conditions;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

function conditionOps(actor: ActorDocument, add: string | null): Op[] {
  if (!add) return [];
  const before = conditionsOf(actor);
  if (before.some((c) => c.toLowerCase() === add.toLowerCase())) return [];
  const next = [...before, add];
  return [
    {
      kind: "update" as const,
      ref: { coll: "actors" as const, id: actor._id },
      diff: { "system.pf1e.conditions": next as unknown as Record<string, unknown> },
    } as unknown as Op,
  ];
}

function attackerNameOf(actor: ActorDocument): string {
  return actor.name;
}

// Each planner mirrors the pure aftermath's input shape, plus the defender
// document the condition lands on.

export function planTrip(input: {
  attacker: ActorDocument;
  defender: ActorDocument;
  check: Omit<PF1eManeuverCheckInput, "kind">;
}): { ok: true; plan: PF1eManeuverPlan } | { ok: false; error: string } {
  const res = pf1eTrip({ check: input.check });
  if (!res.ok) return res;
  const ops: Op[] = [];
  if (res.targetProne) ops.push(...conditionOps(input.defender, "Prone"));
  if (res.attackerProne) ops.push(...conditionOps(input.attacker, "Prone"));
  const note = `${attackerNameOf(input.attacker)} — ${res.notes.join(" · ")}`;
  return { ok: true, plan: { ops, note } };
}

export function planBullRush(input: {
  attacker: ActorDocument;
  defender: ActorDocument;
  check: Omit<PF1eManeuverCheckInput, "kind">;
}): { ok: true; plan: PF1eManeuverPlan } | { ok: false; error: string } {
  const res = pf1eBullRush({ check: input.check });
  if (!res.ok) return res;
  // movement note only — token movement is the caller's map concern
  const note = `${attackerNameOf(input.attacker)} — ${res.notes.join(" · ")}`;
  return { ok: true, plan: { ops: [], note } };
}

export function planDisarm(input: {
  attacker: ActorDocument;
  defender: ActorDocument;
  check: Omit<PF1eManeuverCheckInput, "kind">;
  attackerUnarmed?: boolean;
  disarmedWithoutWeapon?: boolean;
}): { ok: true; plan: PF1eManeuverPlan } | { ok: false; error: string } {
  const res = pf1eDisarm({ check: input.check, ...(input.attackerUnarmed !== undefined ? { attackerUnarmed: input.attackerUnarmed } : {}), ...(input.disarmedWithoutWeapon !== undefined ? { disarmedWithoutWeapon: input.disarmedWithoutWeapon } : {}) });
  if (!res.ok) return res;
  const note = `${attackerNameOf(input.attacker)} — ${res.notes.join(" · ")}`;
  return { ok: true, plan: { ops: [], note } };
}

export function planOverrun(input: {
  attacker: ActorDocument;
  defender: ActorDocument;
  check?: Omit<PF1eManeuverCheckInput, "kind">;
  targetAvoids?: boolean;
}): { ok: true; plan: PF1eManeuverPlan } | { ok: false; error: string } {
  const res = pf1eOverrun({ ...(input.check ? { check: input.check } : {}), ...(input.targetAvoids !== undefined ? { targetAvoids: input.targetAvoids } : {}) });
  if (!res.ok) return res;
  const ops = res.targetProne ? conditionOps(input.defender, "Prone") : [];
  const note = `${attackerNameOf(input.attacker)} — ${res.notes.join(" · ")}`;
  return { ok: true, plan: { ops, note } };
}

export function planDirtyTrick(input: {
  attacker: ActorDocument;
  defender: ActorDocument;
  check: Omit<PF1eManeuverCheckInput, "kind">;
  condition?: string;
  hasGreaterDirtyTrick?: boolean;
  greaterDie?: number;
}): { ok: true; plan: PF1eManeuverPlan } | { ok: false; error: string } {
  const res = pf1eDirtyTrick({ check: input.check, ...(input.condition !== undefined ? { condition: input.condition } : {}), ...(input.hasGreaterDirtyTrick !== undefined ? { hasGreaterDirtyTrick: input.hasGreaterDirtyTrick } : {}), ...(input.greaterDie !== undefined ? { greaterDie: input.greaterDie } : {}) });
  if (!res.ok) return res;
  const ops = res.condition ? conditionOps(input.defender, res.condition.charAt(0).toUpperCase() + res.condition.slice(1)) : [];
  const note = `${attackerNameOf(input.attacker)} — ${res.notes.join(" · ")}`;
  return { ok: true, plan: { ops, note } };
}

export function planDrag(input: {
  attacker: ActorDocument;
  defender: ActorDocument;
  check: Omit<PF1eManeuverCheckInput, "kind">;
}): { ok: true; plan: PF1eManeuverPlan } | { ok: false; error: string } {
  const res = pf1eDrag({ check: input.check });
  if (!res.ok) return res;
  const note = `${attackerNameOf(input.attacker)} — ${res.notes.join(" · ")}`;
  return { ok: true, plan: { ops: [], note } };
}

export function planReposition(input: {
  attacker: ActorDocument;
  defender: ActorDocument;
  check: Omit<PF1eManeuverCheckInput, "kind">;
}): { ok: true; plan: PF1eManeuverPlan } | { ok: false; error: string } {
  const res = pf1eReposition({ check: input.check });
  if (!res.ok) return res;
  const note = `${attackerNameOf(input.attacker)} — ${res.notes.join(" · ")}`;
  return { ok: true, plan: { ops: [], note } };
}

export function planSteal(input: {
  attacker: ActorDocument;
  defender: ActorDocument;
  check: Omit<PF1eManeuverCheckInput, "kind">;
  attackerFreeHand?: boolean;
}): { ok: true; plan: PF1eManeuverPlan } | { ok: false; error: string } {
  const res = pf1eSteal({ check: input.check, ...(input.attackerFreeHand !== undefined ? { attackerFreeHand: input.attackerFreeHand } : {}) });
  if (!res.ok) return res;
  const note = `${attackerNameOf(input.attacker)} — ${res.notes.join(" · ")}`;
  return { ok: true, plan: { ops: [], note } };
}
