/**
 * P7/H02+H03/D-206 — healing, transcribed from Gap List A.13 (CRB p.191,
 * AoN Rules ID 170/171):
 *
 *   "Healing: When you heal hit points, you heal an equal amount of nonlethal
 *   damage. Temporary hit points are never restored by healing."
 *
 *   "Natural Healing: With a full night's rest (8 hours of sleep or more),
 *   you recover 1 hit point per character level. If you undergo complete bed
 *   rest for an entire day and night, you recover twice your character level
 *   in hit points." (Recovery of ability damage: 1 point per affected score
 *   per night, 2 per day of complete rest — in `recovery.ts`; drain never
 *   heals naturally.)
 *
 * This module owns the *instantaneous* hit-point/nonlethal relationship;
 * the day/night multipliers live in `recovery.ts`, which keeps the exact
 * doubling semantics. Fast healing and regeneration tick on top (H03).
 */

export interface PF1eHealInput {
  hp: number;
  hpMax: number;
  nonlethalDamage: number;
  amount: number;
}

export interface PF1eHealResult {
  hp: number;
  nonlethalDamage: number;
  healedHp: number;
  healedNonlethal: number;
  note: string;
}

/**
 * Apply magical (or mundane) healing.
 *
 * Healing restores hit points up to the maximum, and simultaneously removes
 * an equal amount of nonlethal damage — the CRB p.191 sentence. The amount
 * that removes nonlethal is the *rolled amount*, not the amount that
 * actually increased hit points, so a creature already at full hit points
 * still heals nonlethal damage from the same spell.
 *
 * Healing never restores temporary hit points (caller must keep that pool
 * separate via `tempHp.ts`). Inputs that are not integers or are negative
 * produce a named refusal rather than a throw — the combat flow re-uses the
 * prepare/resolve pattern.
 */
export function applyHealing(input: PF1eHealInput): PF1eHealResult | { ok: false; error: string } {
  const { hp, hpMax, nonlethalDamage, amount } = input;
  for (const [field, value] of [
    ["hp", hp],
    ["hpMax", hpMax],
    ["nonlethalDamage", nonlethalDamage],
    ["amount", amount],
  ] as const) {
    if (!Number.isInteger(value) || (field !== "hp" && value < 0)) {
      return { ok: false, error: `heal: ${field} = ${String(value)} is not a valid integer` } as unknown as PF1eHealResult & { ok: false };
    }
    if (field === "amount" && value < 0) {
      return { ok: false, error: `heal: amount = ${String(value)} cannot be negative` } as unknown as PF1eHealResult & { ok: false };
    }
  }
  if (hpMax < 1) {
    return { ok: false, error: `heal: hpMax = ${String(hpMax)} must be at least 1` } as unknown as PF1eHealResult & { ok: false };
  }
  if (amount === 0) {
    return {
      hp,
      nonlethalDamage,
      healedHp: 0,
      healedNonlethal: 0,
      note: "no healing — the amount is 0",
    } as PF1eHealResult;
  }

  // Hit points restored up to the maximum; excess is wasted for hit points
  // but still counts for the simultaneous nonlethal removal.
  const hpDeficit = Math.max(0, hpMax - hp);
  const healedHp = Math.min(amount, hpDeficit);
  const newHp = hp + healedHp;

  // Nonlethal removal: an equal amount to the *rolled* healing, not the
  // amount that actually increased hit points, so healing at full HP still
  // cures nonlethal (the PF1e table gloss). Capped at the damage present.
  const healedNonlethal = Math.min(amount, nonlethalDamage);
  const newNonlethal = Math.max(0, nonlethalDamage - healedNonlethal);

  let note = "";
  if (healedHp > 0 && healedNonlethal > 0) {
    note = `healed ${healedHp} hit point(s) and removed ${healedNonlethal} point(s) of nonlethal damage (CRB p.191)`;
  } else if (healedHp > 0) {
    note = `healed ${healedHp} hit point(s)`;
  } else if (healedNonlethal > 0) {
    note = `removed ${healedNonlethal} point(s) of nonlethal damage (CRB p.191 — hit points already at maximum)`;
  } else {
    note = `healing ${amount} had no effect — already at full hit points with no nonlethal damage`;
  }

  return { hp: newHp, nonlethalDamage: newNonlethal, healedHp, healedNonlethal, note };
}

/**
 * Healing applied as *only* nonlethal removal (e.g. a rest hour that
 * explicitly heals nonlethal without touching lethal bookkeeping). Useful for
 * the tactical rest action (H03) where the two rates may differ; the
 * magical-healing path above covers the common case where healing removes
 * both together.
 */
export function applyNonlethalHealing(input: {
  nonlethalDamage: number;
  amount: number;
}): { nonlethalDamage: number; healed: number; note: string } | { ok: false; error: string } {
  if (!Number.isInteger(input.nonlethalDamage) || input.nonlethalDamage < 0) {
    return { ok: false, error: `nonlethalHeal: nonlethalDamage = ${String(input.nonlethalDamage)} is not a non-negative integer` } as unknown as never;
  }
  if (!Number.isInteger(input.amount) || input.amount < 0) {
    return { ok: false, error: `nonlethalHeal: amount = ${String(input.amount)} is not a non-negative integer` } as unknown as never;
  }
  const healed = Math.min(input.amount, input.nonlethalDamage);
  return {
    nonlethalDamage: input.nonlethalDamage - healed,
    healed,
    note: healed > 0 ? `removed ${healed} point(s) of nonlethal damage` : "no nonlethal damage to remove",
  };
}

/**
 * Fast healing and regeneration ticks (H03).
 *
 *   Fast Healing (Bestiary UMR): "A creature with fast healing regains the
 *   listed number of hit points at the start of its turn. … Fast healing
 *   does not restore hit points lost from starvation, thirst, or suffocation,
 *   nor does it allow a creature to regrow lost body parts."
 *
 *   Regeneration (Bestiary UMR, A.18): "A creature with regeneration regains
 *   the listed number of hit points each round at the start of its turn. …
 *   Certain attack forms, typically fire and acid, cause a creature's
 *   regeneration to cease to function on the round following such an attack.
 *   … Regeneration also does not restore hit points lost from starvation,
 *   thirst, or suffocation. … Attack forms that don't deal hit point damage
 *   are not healed by regeneration."
 *
 * Tactically the suppression check is a caller fact: the defender's last
 * round took suppress-type damage ⇒ this round's regeneration does not tick
 * (fire/acid suppress the *next* round, per the Bestiary text). The tick
 * heals real hit points (not temporary) up to the maximum, and also removes
 * an equal amount of nonlethal damage via the same relationship as healing
 * (so a regenerating creature mends its subdual buffer first).
 *
 * Dead creatures never heal (massive-damage death and negative-Con death;
 * A.18's massive-damage toggle is L05 and not automated here).
 */
export function fastHealingTick(input: {
  hp: number;
  hpMax: number;
  nonlethalDamage: number;
  /** Current (possibly negative) hit points — death is checked against Con score, not just 0. */
  amount: number;
  conScore?: number;
}): { hp: number; nonlethalDamage: number; healed: number; note: string } | { ok: false; error: string } {
  if (!Number.isInteger(input.hp) || !Number.isInteger(input.hpMax) || !Number.isInteger(input.amount)) {
    return { ok: false, error: "fastHealingTick: hp/hpMax/amount must be integers" } as unknown as never;
  }
  if (input.amount <= 0) return { hp: input.hp, nonlethalDamage: input.nonlethalDamage, healed: 0, note: "no fast healing — the amount is 0" };
  const dead = isDead(input.hp, input.conScore);
  if (dead) return { hp: input.hp, nonlethalDamage: input.nonlethalDamage, healed: 0, note: "no fast healing — the creature is dead" };
  // Fast healing heals lethal damage up to the maximum; if already at max it has no effect on hit points
  // but the equal-nonlethal removal is still the healing amount (so it still mends subdual).
  const res = applyHealing({ hp: input.hp, hpMax: input.hpMax, nonlethalDamage: input.nonlethalDamage, amount: input.amount });
  if ((res as unknown as { ok: false }).ok === false) return res as unknown as never;
  const r = res as PF1eHealResult;
  return { hp: r.hp, nonlethalDamage: r.nonlethalDamage, healed: r.healedHp, note: `fast healing ${r.healedHp} — ${r.note}` };
}

export function regenerationTick(input: {
  hp: number;
  hpMax: number;
  nonlethalDamage: number;
  amount: number;
  /** Suppress types dealt last round ⇒ this round's regeneration is suppressed (fire/acid, A.18). */
  suppressed?: boolean;
  conScore?: number;
}): { hp: number; nonlethalDamage: number; healed: number; note: string | null } | { ok: false; error: string } {
  if (!Number.isInteger(input.hp) || !Number.isInteger(input.hpMax) || !Number.isInteger(input.amount)) {
    return { ok: false, error: "regenerationTick: hp/hpMax/amount must be integers" } as unknown as never;
  }
  if (input.suppressed === true) {
    return { hp: input.hp, nonlethalDamage: input.nonlethalDamage, healed: 0, note: "regeneration suppressed this round — fire or acid damage last round (A.18)" };
  }
  if (input.amount <= 0) return { hp: input.hp, nonlethalDamage: input.nonlethalDamage, healed: 0, note: null };
  const dead = isDead(input.hp, input.conScore);
  if (dead) return { hp: input.hp, nonlethalDamage: input.nonlethalDamage, healed: 0, note: "no regeneration — the creature is dead" };
  const res = applyHealing({ hp: input.hp, hpMax: input.hpMax, nonlethalDamage: input.nonlethalDamage, amount: input.amount });
  if ((res as unknown as { ok: false }).ok === false) return res as unknown as never;
  const r = res as PF1eHealResult;
  return { hp: r.hp, nonlethalDamage: r.nonlethalDamage, healed: r.healedHp, note: `regeneration ${r.healedHp} — ${r.note}` };
}

function isDead(hp: number, conScore: number | undefined): boolean {
  if (hp >= 0) return false;
  if (conScore === undefined || conScore <= 0) return hp <= 0 ? false : false; // no Con score available — death at negative Con is not computable, so liberal: not dead until caller says so
  return -hp >= conScore;
}
