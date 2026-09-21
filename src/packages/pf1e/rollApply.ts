/**
 * §2.2 item 3 (G-20, D-261) — **apply / heal from an arbitrary roll card**.
 *
 * The plan's own description: "apply/heal intent on arbitrary rolls, host-authoritative — the
 * verified-roll plumbing already exists; this is UI + one intent + a permission check."
 *
 * The plumbing is that a roll is a *document*: the host evaluates the formula and commits a
 * `messages` document carrying `roll.total` (`host/sync.ts:handleRoll`), so the number a card shows
 * is already the host's. The intent therefore carries **no number at all** — it names the card and
 * the actor, and the host re-reads the total from its own store (`roll.apply`). A client cannot
 * claim a damage figure; it can only ask "apply that card to that actor", and the host decides.
 *
 * This module owns the arithmetic and the diff, and nothing else: temp HP absorbs first (H02/D-206,
 * the same rule the attack resolver uses), healing restores hit points up to the maximum *and*
 * removes an equal amount of nonlethal damage (CRB p.191), and the result is a flat diff the host
 * commits on the actor document. Permission, idempotence and the wire are the host's.
 */
import type { Json } from "../../core/documents";
import { applyHealing } from "./healing";
import { absorbDamageWithTempHp, type PF1eTempHpSources } from "./tempHp";

/** The two verbs a roll card offers. */
export type PF1eRollApplyMode = "damage" | "healing";

/** One card's record of what was applied to one actor, as it rides `flags.pf1e.applied`. */
export interface PF1eRollApplication {
  damage?: number;
  healing?: number;
}

export interface PF1eRollApplyPlan {
  /** The flat diff to commit on the actor document (empty when the apply changed nothing). */
  diff: Record<string, Json | null>;
  hpBefore: number;
  hpAfter: number;
  tempHpBefore: number;
  tempHpAfter: number;
  nonlethalBefore: number;
  nonlethalAfter: number;
  /** One line for the table, e.g. `8 damage — hp 12 → 4 (temporary hit points absorbed 4)`. */
  note: string;
}

export interface PF1eRollApplyInput {
  mode: PF1eRollApplyMode;
  /** The host-verified total of the card being applied. */
  amount: number;
  hp: number;
  hpMax: number;
  nonlethalDamage: number;
  tempHpSources: PF1eTempHpSources;
  /**
   * Whether the actor authors per-source temporary HP. A legacy document (`system.pf1e.tempHp`, a
   * bare scalar) keeps its scalar: the pool still absorbs (that is the CRB p.191 rule), but the
   * plan spends the scalar itself and never invents a source map over it — migrating a document is
   * the sheet editor's job, not a card's (`tempHp.ts`).
   */
  legacyTempHp?: boolean;
}

/**
 * Plan one apply. Refusals are named, never silent: a non-integer or negative amount, an
 * unauthored maximum, or an amount that would change nothing.
 */
export function planRollApply(
  input: PF1eRollApplyInput,
): { ok: true; plan: PF1eRollApplyPlan } | { ok: false; error: string } {
  const { mode, amount, hp, hpMax, nonlethalDamage, tempHpSources } = input;
  if (!Number.isInteger(amount) || amount < 0) {
    return { ok: false, error: `roll amount ${String(amount)} is not a non-negative whole number` };
  }
  if (!Number.isInteger(hp) || !Number.isInteger(hpMax) || hpMax < 1) {
    return { ok: false, error: `the actor authors no usable hit points (hp ${String(hp)}, max ${String(hpMax)})` };
  }
  if (!Number.isInteger(nonlethalDamage) || nonlethalDamage < 0) {
    return { ok: false, error: `nonlethal damage ${String(nonlethalDamage)} is not a non-negative whole number` };
  }
  if (amount === 0) {
    return { ok: false, error: "a roll of 0 has nothing to apply" };
  }

  if (mode === "healing") {
    const healed = applyHealing({ hp, hpMax, nonlethalDamage, amount });
    if ("ok" in healed) return { ok: false, error: healed.error };
    const diff: Record<string, Json | null> = {};
    if (healed.hp !== hp) diff["system.pf1e.hp"] = healed.hp;
    if (healed.nonlethalDamage !== nonlethalDamage)
      diff["system.pf1e.nonlethalDamage"] = healed.nonlethalDamage;
    return {
      ok: true,
      plan: {
        diff,
        hpBefore: hp,
        hpAfter: healed.hp,
        tempHpBefore: 0,
        tempHpAfter: 0,
        nonlethalBefore: nonlethalDamage,
        nonlethalAfter: healed.nonlethalDamage,
        note:
          `healing ${String(amount)} — ${healed.note}` +
          (healed.healedHp > 0 && hpMax - hp < amount
            ? ` (hit points cap at ${String(hpMax)})`
            : ""),
      },
    };
  }

  const absorbedResult = absorbDamageWithTempHp(tempHpSources, amount);
  const tempHpBefore = Object.values(tempHpSources).reduce((sum, v) => sum + v, 0);
  const tempHpAfter = Object.values(absorbedResult.sources).reduce((sum, v) => sum + v, 0);
  // Damage floors at 0 hit points, exactly as the attack resolver's writes do — the dying state
  // reads `hp <= 0`, it is not a negative ledger (D-206).
  const hpAfter = Math.max(0, hp - absorbedResult.leftover);
  const diff: Record<string, Json | null> = {};
  if (hpAfter !== hp) diff["system.pf1e.hp"] = hpAfter;
  if (tempHpAfter !== tempHpBefore) {
    if (input.legacyTempHp) {
      // Legacy scalar, legacy write: spend it in place so the pool still absorbs, and let the
      // sheet editor be the thing that migrates the document to a source map.
      if (tempHpAfter === 0) diff["-=system.pf1e.tempHp"] = null;
      else diff["system.pf1e.tempHp"] = tempHpAfter;
    } else {
      if (Object.keys(absorbedResult.sources).length === 0) {
        diff["-=system.pf1e.tempHpSources"] = null;
      } else {
        diff["system.pf1e.tempHpSources"] = absorbedResult.sources as unknown as Json;
      }
      // The scalar is superseded the moment a source map is written (tempHp.ts).
      diff["-=system.pf1e.tempHp"] = null;
    }
  }
  const absorbed = amount - absorbedResult.leftover;
  return {
    ok: true,
    plan: {
      diff,
      hpBefore: hp,
      hpAfter,
      tempHpBefore,
      tempHpAfter,
      nonlethalBefore: nonlethalDamage,
      nonlethalAfter: nonlethalDamage,
      note:
        `damage ${String(amount)} — hp ${String(hp)} → ${String(hpAfter)}` +
        (absorbed > 0 ? ` (temporary hit points absorbed ${String(absorbed)})` : "") +
        (hpAfter === 0 ? " — at 0 hit points" : ""),
    },
  };
}

/** The card's applied record, validated from `flags.pf1e.applied` (anything malformed reads as none). */
export function readRollApplications(
  message: { flags?: unknown },
): Record<string, PF1eRollApplication> {
  const flags = message.flags as { pf1e?: { applied?: unknown } } | undefined;
  const applied = flags?.pf1e?.applied;
  if (typeof applied !== "object" || applied === null || Array.isArray(applied)) return {};
  const out: Record<string, PF1eRollApplication> = {};
  for (const [actorId, value] of Object.entries(applied as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const entry: PF1eRollApplication = {};
    if (typeof record.damage === "number" && Number.isFinite(record.damage))
      entry.damage = record.damage;
    if (typeof record.healing === "number" && Number.isFinite(record.healing))
      entry.healing = record.healing;
    if (entry.damage !== undefined || entry.healing !== undefined) out[actorId] = entry;
  }
  return out;
}

/**
 * The record after one apply, for the host to fold into the card's flags. Merging (not replacing)
 * keeps the healing record when damage was applied first, and vice versa.
 */
export function appliedWith(
  existing: Record<string, PF1eRollApplication>,
  actorId: string,
  mode: PF1eRollApplyMode,
  amount: number,
): Record<string, PF1eRollApplication> {
  const current = existing[actorId] ?? {};
  return {
    ...existing,
    [actorId]:
      mode === "damage" ? { ...current, damage: amount } : { ...current, healing: amount },
  };
}
