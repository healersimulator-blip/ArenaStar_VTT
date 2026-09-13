/**
 * P7/H03/D-206 — natural recovery rest as a pure plan.
 *
 * AoN 170 (CRB p.191): 1 HP per level per night of rest (2× for complete bed
 * rest), ability damage 1 per affected score per night (2 for bed rest, drain
 * never heals naturally), long-term care doubling both. `recovery.ts` owns the
 * rates; this module turns a chosen rest into the exact ops the sheet submits
 * and the line its warning area shows.
 */
import type { ActorDocument } from "../../core/documents";
import type { Op } from "../../core/ops";
import { abilityDamageRecovery, naturalHpRecovery } from "../../packages/pf1e/recovery";

export interface PF1eRestPlanInput {
  actor: ActorDocument;
  level: number;
  bedRest: boolean;
  longTermCare: boolean;
}

export interface PF1eRestPlan {
  ops: Op[];
  note: string;
}

export function planRest(input: PF1eRestPlanInput): PF1eRestPlan {
  const pf1e =
    (input.actor.system as { pf1e?: Record<string, unknown> }).pf1e ?? {};
  const rawHp = (pf1e as Record<string, unknown>).hp;
  const rawHpMax = (pf1e as Record<string, unknown>).hpMax;
  const hp =
    typeof rawHp === "number" && Number.isFinite(rawHp) ? rawHp : 0;
  const hpMax =
    typeof rawHpMax === "number" && Number.isFinite(rawHpMax) ? rawHpMax : 0;

  const hpRecovered = naturalHpRecovery({
    level: input.level,
    ...(input.bedRest ? { bedRest: true } : {}),
    ...(input.longTermCare ? { longTermCare: true } : {}),
  });
  const clampedHpAfter = hpMax > 0 ? Math.min(hpMax, hp + hpRecovered) : hp + hpRecovered;

  const ability = abilityDamageRecovery({
    ...(input.bedRest ? { bedRest: true } : {}),
    ...(input.longTermCare ? { longTermCare: true } : {}),
  });

  const rawDamage = (pf1e as Record<string, unknown>).abilitiesDamage;
  const damageRecord =
    typeof rawDamage === "object" && rawDamage !== null && !Array.isArray(rawDamage)
      ? (rawDamage as Record<string, unknown>)
      : null;

  const ops: Op[] = [];
  const parts: string[] = [];

  if (hpRecovered > 0 && hp !== clampedHpAfter) {
    ops.push({
      kind: "update" as const,
      ref: { coll: "actors" as const, id: input.actor._id },
      diff: { "system.pf1e.hp": clampedHpAfter },
    });
    parts.push(
      `${String(hpRecovered)} HP (${String(hp)} → ${String(clampedHpAfter)}${hpMax > 0 ? ` / ${String(hpMax)}` : ""})`,
    );
  } else if (hpRecovered > 0) {
    parts.push(`HP already at ${String(hp)} — no HP recovered`);
  }

  if (damageRecord !== null) {
    const nextDamage: Record<string, number> = {};
    let changed = false;
    let anyDamage = false;
    for (const [k, v] of Object.entries(damageRecord)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        if (typeof v === "number" && Number.isFinite(v)) nextDamage[k] = v;
        continue;
      }
      anyDamage = true;
      const remaining = Math.max(0, v - ability.points);
      if (remaining !== v) changed = true;
      if (remaining > 0) nextDamage[k] = remaining;
      // remaining === 0 ⇒ deleted (omit from nextDamage)
    }
    if (anyDamage) {
      parts.push(ability.note);
      if (changed) {
        const diff: Record<string, unknown> = {};
        for (const k of Object.keys(damageRecord)) {
          const val = (nextDamage as Record<string, number>)[k];
          if (val === undefined) diff[`-=system.pf1e.abilitiesDamage.${k}`] = null;
          else diff[`system.pf1e.abilitiesDamage.${k}`] = val;
        }
        if (Object.keys(diff).length > 0) {
          ops.push({
            kind: "update" as const,
            ref: { coll: "actors" as const, id: input.actor._id },
            diff: diff as Record<string, unknown> as any,
          });
        }
      }
    }
  } else {
    parts.push(ability.note);
  }

  const bed = input.bedRest ? "complete bed rest" : "a night's rest";
  const care = input.longTermCare ? " with long-term care" : "";
  const note =
    parts.length > 0
      ? `${input.actor.name} rests (${bed}${care}): ${parts.join(" · ")}`
      : `${input.actor.name} rests (${bed}${care}) — nothing to recover`;

  return { ops, note };
}

/** Level for the recovery rates: authored Hit Dice, falling back to 1. */
export function restLevelOf(actor: ActorDocument): number {
  const pf1e =
    (actor.system as { pf1e?: Record<string, unknown> }).pf1e ?? {};
  const hd = (pf1e as Record<string, unknown>).hitDice;
  if (typeof hd === "number" && Number.isFinite(hd) && hd > 0) return Math.trunc(hd);
  return 1;
}
