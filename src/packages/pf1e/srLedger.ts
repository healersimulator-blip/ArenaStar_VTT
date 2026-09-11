/**
 * P5/C02 (D-156) — the round-scoped spell-resistance bookkeeping.
 *
 * UMR "Spell Resistance": overcoming SR is a caster-level check, and "a caster
 * only has to check SR once per spell per round" — once the resistance of a
 * creature is overcome for a casting, later castings of the same spell that
 * round do not roll again (D-149 verified this against the universal monster
 * rules). Until D-156 the flag was caller-supplied and untracked; this module
 * is the tracked store, keyed `(caster, target)` and stamped with the combat
 * round, carried on the combat document at `flags.pf1e.srOvercome`.
 *
 * The helpers are pure over the flags blob so the sheet flow and the tests
 * share one reading of the shape; the blob never invents rounds — an entry
 * from any other round is simply stale.
 */

/** The `flags.pf1e.srOvercome` blob on a combat document. */
export type PF1eSrOvercomeBlob = Record<string, number>;

export function srOvercomeKey(casterId: string, targetId: string): string {
  return `${casterId}:${targetId}`;
}

/** True when this caster already overcame this target's SR in `round`. */
export function srAlreadyOvercome(
  blob: unknown,
  casterId: string,
  targetId: string,
  round: number,
): boolean {
  if (
    blob === null ||
    typeof blob !== "object" ||
    Array.isArray(blob) ||
    !Number.isInteger(round) ||
    round < 1
  )
    return false;
  const entry = (blob as Record<string, unknown>)[
    srOvercomeKey(casterId, targetId)
  ];
  return entry === round;
}

/**
 * The flags diff that records a newly overcome SR for this round. Dotted under
 * `flags.pf1e.srOvercome` so sibling flags survive the update op.
 */
export function srOvercomeDiff(
  casterId: string,
  targetId: string,
  round: number,
): Record<string, number> {
  return {
    [`flags.pf1e.srOvercome.${srOvercomeKey(casterId, targetId)}`]: round,
  };
}

/**
 * Reads the blob off a combat document's flags (never throws, never invents):
 * anything that is not a plain object reads as empty.
 */
export function srOvercomeBlobFromFlags(
  flags: unknown,
): PF1eSrOvercomeBlob | null {
  if (flags === null || typeof flags !== "object" || Array.isArray(flags))
    return null;
  const pf1e = (flags as Record<string, unknown>).pf1e;
  if (pf1e === null || typeof pf1e !== "object" || Array.isArray(pf1e))
    return null;
  const blob = (pf1e as Record<string, unknown>).srOvercome;
  if (blob === null || typeof blob !== "object" || Array.isArray(blob))
    return null;
  return blob as PF1eSrOvercomeBlob;
}
