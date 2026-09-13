/**
 * P7/H03+H04/D-204 — natural recovery, transcribed from AoN Rules ID 170
 * (CRB p.191, "Healing") — re-verified before encoding:
 *
 *   "**Natural Healing**: With a full night's rest (8 hours of sleep or
 *   more), you recover 1 hit point per character level. … If you undergo
 *   complete bed rest for an entire day and night, you recover twice your
 *   character level in hit points."
 *
 *   "**Healing Ability Damage**: Temporary ability damage returns at the
 *   rate of 1 point per night of rest (8 hours) for each affected ability
 *   score. Complete bed rest restores 2 points per day (24 hours) for each
 *   affected ability score." (Ability drain never heals naturally — the
 *   restoration spell is its only cure, a caller fact.)
 *
 * The Heal skill's long-term care doubles these rates for a successfully
 * treated patient (the CRB skill text: 2 ability score points for a full
 * 8 hours' rest, 4 per day of complete rest); `longTermCare` encodes the
 * doubling as a named option, the numbers live in exactly one place.
 */

/** A full night's rest (8 hours of sleep or more). */
export function naturalHpRecovery(input: {
  level: number;
  /** Complete bed rest for an entire day and night doubles the rate. */
  bedRest?: boolean;
  /** The Heal skill's long-term care doubles the rate again. */
  longTermCare?: boolean;
}): number {
  let hp = Math.max(1, Math.floor(input.level));
  if (input.bedRest === true) hp *= 2;
  if (input.longTermCare === true) hp *= 2;
  return hp;
}

/**
 * Ability damage recovery, per affected ability score: 1 point per night of
 * rest, 2 per day of complete bed rest, doubled by long-term care. Drain
 * never recovers naturally.
 */
export function abilityDamageRecovery(input: {
  bedRest?: boolean;
  longTermCare?: boolean;
}): { points: number; note: string } {
  let points = input.bedRest === true ? 2 : 1;
  if (input.longTermCare === true) points *= 2;
  return {
    points,
    note:
      input.bedRest === true
        ? `complete bed rest restores ${String(points)} point(s) of ability damage per affected score per day (CRB p.191)`
        : `a night of rest restores ${String(points)} point(s) of ability damage per affected score (CRB p.191)`,
  };
}
