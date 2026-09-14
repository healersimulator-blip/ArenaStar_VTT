/**
 * P7/H04/D-207 — negative-level infliction, daily / 24h saves and restoration as pure plans.
 *
 * Each plan is the same shape as `pf1eFirstAid.planFirstAid` so the sheet and
 * any future combat UI drive the same submit path: the caller supplies dice,
 * the plan returns the exact ops the host authorizes.
 */
import type { ActorDocument } from "../../core/documents";
import type { FlatDiff, Op } from "../../core/ops";
import {
  inflictNegativeLevels,
  removeNegativeLevels,
  saveOneNegativeLevel,
} from "../../packages/pf1e/energyDrain";

export interface PF1eEnergyDrainInflictPlanInput {
  defender: ActorDocument;
  count: number;
  kind: "temporary" | "permanent";
  attackerName?: string;
}

export interface PF1eEnergyDrainPlan {
  ops: Op[];
  note: string;
}

function negativeLevelsOf(actor: ActorDocument): unknown {
  return (actor.system as { pf1e?: { negativeLevels?: unknown } }).pf1e?.negativeLevels;
}

function diffForNegativeLevels(
  _actorId: string,
  next: Record<string, number> | null,
): Record<string, unknown> {
  if (next === null) return { "-=system.pf1e.negativeLevels": null };
  return { "system.pf1e.negativeLevels": next as unknown as Record<string, unknown> };
}

export function planEnergyDrainInflict(
  input: PF1eEnergyDrainInflictPlanInput,
): { ok: true; plan: PF1eEnergyDrainPlan } | { ok: false; error: string } {
  const current = negativeLevelsOf(input.defender);
  const res = inflictNegativeLevels({ current, count: input.count, kind: input.kind });
  if (!res.ok) return { ok: false, error: res.error };
  const attacker = input.attackerName ?? "Energy drain";
  const note = `${attacker} — ${input.defender.name}: ${res.result.note}`;
  const diff = diffForNegativeLevels(input.defender._id, res.result.levels as Record<string, number>);
  return {
    ok: true,
    plan: {
      ops: [{ kind: "update" as const, ref: { coll: "actors" as const, id: input.defender._id }, diff: diff as FlatDiff }],
      note,
    },
  };
}

export interface PF1eRestorationInput {
  actor: ActorDocument;
  count: number;
  kind?: "temporary" | "permanent" | "any";
}

export function planRestoration(
  input: PF1eRestorationInput,
): { ok: true; plan: PF1eEnergyDrainPlan } | { ok: false; error: string } {
  const current = negativeLevelsOf(input.actor);
  const res = removeNegativeLevels({ current, count: input.count, ...(input.kind ? { kind: input.kind } : {}) });
  if (!res.ok) return { ok: false, error: res.error };
  const diff = diffForNegativeLevels(input.actor._id, res.result.levels as Record<string, number> | null);
  const note = `${input.actor.name}: ${res.result.note} — restoration (AoN 427: level drain can be removed through spells like restoration)`;
  return {
    ok: true,
    plan: {
      ops: [{ kind: "update" as const, ref: { coll: "actors" as const, id: input.actor._id }, diff: diff as FlatDiff }],
      note,
    },
  };
}

export interface PF1eNegativeLevelSaveInput {
  actor: ActorDocument;
  kind: "temporary" | "energy-drain";
  die: number;
  fortBonus: number;
  dc: number;
}

export function planNegativeLevelSave(
  input: PF1eNegativeLevelSaveInput,
): { ok: true; plan: PF1eEnergyDrainPlan } | { ok: false; error: string } {
  const current = negativeLevelsOf(input.actor);
  const res = saveOneNegativeLevel({
    current,
    kind: input.kind,
    die: input.die,
    fortBonus: input.fortBonus,
    dc: input.dc,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const diff = diffForNegativeLevels(input.actor._id, res.result.levels as Record<string, number> | null);
  const note = `${input.actor.name}: ${res.result.note}`;
  // Temporary failed save: no count change → no op, just the note (another save tomorrow).
  if (!res.result.removed && !res.result.becomesPermanent) {
    return { ok: true, plan: { ops: [], note } };
  }
  const ops: Op[] = [{ kind: "update" as const, ref: { coll: "actors" as const, id: input.actor._id }, diff: diff as FlatDiff }];
  return { ok: true, plan: { ops, note } };
}
