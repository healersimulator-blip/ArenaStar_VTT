/**
 * P7/H02/D-206 — temporary hit points, transcribed from Gap List A.13
 * (CRB p.191, AoN Rules ID 171) + Paizo FAQ CRB p.208 Combining Magical Effects:
 *
 *   "Temporary hit points: a buffer — damage reduces them first, never restored
 *   by healing real hit points; the same source does not stack (highest
 *   applies), different sources do stack — track them separately."
 *
 * Tactical truth: an actor may receive temporary hit points from several
 * effects at once (e.g. *aid* 8 + *false life* 6 ⇒ 14). Re-applying the same
 * spell must not add (second *aid* 6 does not make 14), it overlaps — the
 * highest remaining of that source wins. When the effect that granted them
 * expires, its contribution vanishes, even if damage has already been absorbed
 * from the pool.
 *
 * This module is pure, diceless, and total on malformed input: every entry
 * is validated, named in `issues`, and contributes zero when malformed.
 */

export type PF1eTempHpSources = Readonly<Record<string, number>>;

export interface PF1eTempHpRead {
  sources: PF1eTempHpSources;
  total: number;
  issues: readonly string[];
}

/**
 * Read the authored temporary-HP block.
 *
 * Backwards compatible: legacy `system.pf1e.tempHp` stored a bare scalar —
 * it is read as a single unnamed source `"legacy"` so old documents keep
 * their value through the new derivation. New documents author
 * `system.pf1e.tempHpSources` (sourceId → remaining). When both exist the
 * map wins; the scalar is reported as ignored so an editor can migrate.
 */
export function readTempHpSources(raw: Record<string, unknown>): PF1eTempHpRead {
  const issues: string[] = [];
  let sources: Record<string, number> = {};
  const rawMap = raw.tempHpSources;
  const rawScalar = raw.tempHp;

  if (rawMap !== undefined) {
    if (
      rawMap !== null &&
      typeof rawMap === "object" &&
      !Array.isArray(rawMap)
    ) {
      for (const [key, value] of Object.entries(rawMap as Record<string, unknown>)) {
        if (key.trim() === "") {
          issues.push(`tempHpSources[""]: source id must be non-empty — ignored`);
          continue;
        }
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          issues.push(
            `tempHpSources[${JSON.stringify(key)}] = ${JSON.stringify(value)} is not a nonnegative whole number — using 0`,
          );
          sources[key] = 0;
          continue;
        }
        sources[key] = value;
      }
    } else {
      issues.push("tempHpSources: expected an object of source → remaining — using 0");
    }
    if (rawScalar !== undefined) {
      issues.push("tempHp: legacy scalar ignored because tempHpSources is authored");
    }
  } else if (rawScalar !== undefined) {
    if (typeof rawScalar === "number" && Number.isSafeInteger(rawScalar) && rawScalar >= 0) {
      if (rawScalar > 0) sources = { legacy: rawScalar };
    } else {
      issues.push(`tempHp: expected a nonnegative safe integer — using 0`);
    }
  }

  let total = 0;
  for (const v of Object.values(sources)) total += v;

  return { sources: Object.freeze({ ...sources }), total, issues };
}

/** Sum of all remaining temporary hit points. */
export function totalTempHp(sources: PF1eTempHpSources): number {
  let sum = 0;
  for (const v of Object.values(sources)) sum += v;
  return sum;
}

/**
 * Grant temporary hit points from one source.
 *
 * Same source: highest remaining wins — `max(existing remaining, amount)`.
 * Different source: stacks (the map keeps both). Malformed amounts are
 * ignored with an issue; empty source ids are refused.
 *
 * The rule is A.13's "the same source does not stack (highest applies),
 * different sources do stack — track them separately" (Paizo FAQ, CRB p.208).
 */
export function grantTempHp(
  sources: PF1eTempHpSources,
  sourceId: string,
  amount: number,
): { sources: PF1eTempHpSources; total: number; note: string | null; issues: string[] } {
  const issues: string[] = [];
  if (typeof sourceId !== "string" || sourceId.trim() === "") {
    return { sources, total: totalTempHp(sources), note: null, issues: ["tempHp grant: source id must be a non-empty string"] };
  }
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return { sources, total: totalTempHp(sources), note: null, issues: [`tempHp grant: amount ${JSON.stringify(amount)} is not a nonnegative whole number`] };
  }
  const id = sourceId.trim();
  const existing = sources[id] ?? 0;
  // Highest remaining of that source wins — Paizo FAQ: "the same source does not stack".
  const nextVal = Math.max(existing, amount);
  if (nextVal === existing && id in sources) {
    const total = totalTempHp(sources);
    return {
      sources,
      total,
      note: `temporary hit points from "${id}" do not stack with themselves — keeping ${existing} (highest of ${existing} and ${amount})`,
      issues,
    };
  }
  const next: Record<string, number> = { ...sources };
  next[id] = nextVal;
  const total = totalTempHp(next);
  const note =
    id in sources
      ? `temporary hit points from "${id}" refreshed to ${nextVal} (highest of ${existing} and ${amount})`
      : `temporary hit points from "${id}" granted — ${amount}${totalTempHp(sources) > 0 ? `, total now ${total}` : ""}`;
  return { sources: Object.freeze(next), total, note, issues };
}

/**
 * Remove a source (expiry, dispel, or the effect that granted it ending).
 * Missing sources are a no-op with a note.
 */
export function expireTempHpSource(
  sources: PF1eTempHpSources,
  sourceId: string,
): { sources: PF1eTempHpSources; total: number; note: string | null } {
  if (!(sourceId in sources)) {
    return { sources, total: totalTempHp(sources), note: null };
  }
  const next: Record<string, number> = { ...sources };
  const removed = next[sourceId] ?? 0;
  delete next[sourceId];
  const total = totalTempHp(next);
  return {
    sources: Object.freeze(next),
    total,
    note: `temporary hit points from "${sourceId}" expired — ${removed} removed, total now ${total}`,
  };
}

/**
 * Absorb damage with temporary hit points first (CRB p.191).
 *
 * Temporary hit points absorb damage before real hit points are touched, and
 * healing never restores them. This consumes the pool in deterministic order:
 * the largest remaining source first, then alphabetically — so the result is
 * fully reproducible and the choice is documented in `notes`.
 *
 * Only the `damage` amount is absorbed; its lethal/nonlethal nature is the
 * caller's. In tactical resolution the caller passes `lethalDealt` after DR;
 * nonlethal accumulation is untouched by temp HP in this model (the SRD text
 * speaks to "damage" as hit-point damage). If a future ruling requires
 * nonlethal to be absorbed too, this function takes the combined total.
 */
export function absorbDamageWithTempHp(
  sources: PF1eTempHpSources,
  damage: number,
): { sources: PF1eTempHpSources; absorbed: number; leftover: number; notes: string[] } {
  const notes: string[] = [];
  if (!Number.isInteger(damage) || damage < 0) {
    return { sources, absorbed: 0, leftover: damage, notes: ["absorb: damage must be a non-negative integer — no temporary HP consumed"] };
  }
  if (damage === 0) return { sources, absorbed: 0, leftover: 0, notes: [] };
  const total = totalTempHp(sources);
  if (total === 0) return { sources, absorbed: 0, leftover: damage, notes: [] };

  const absorbed = Math.min(total, damage);
  const leftover = damage - absorbed;

  // Deterministic allocation: largest remaining first, then alphabetical.
  const entries = Object.entries(sources)
    .map(([id, remaining]) => ({ id, remaining }))
    .sort((a, b) => b.remaining - a.remaining || a.id.localeCompare(b.id));

  let toAbsorb = absorbed;
  const next: Record<string, number> = { ...sources };
  for (const e of entries) {
    if (toAbsorb <= 0) break;
    const take = Math.min(e.remaining, toAbsorb);
    next[e.id] = e.remaining - take;
    toAbsorb -= take;
  }
  // Drop zeroed sources — they are spent, not lingering zeroes.
  for (const [id, v] of Object.entries(next)) if (v === 0) delete next[id];

  if (absorbed === damage) {
    notes.push(`temporary hit points absorbed ${absorbed} damage — ${leftover === 0 ? "no hit-point damage" : `${leftover} passes through`}`);
  } else {
    notes.push(`temporary hit points absorbed ${absorbed} of ${damage} damage — ${leftover} passes through to hit points`);
  }

  return { sources: Object.freeze(next), absorbed, leftover, notes };
}

/**
 * Healing never restores temporary hit points (CRB p.191). Return the sources
 * unchanged, with a named note for the card when a heal would otherwise be
 * thought to top them up.
 */
export function healingDoesNotRestoreTempHp(
  sources: PF1eTempHpSources,
): { sources: PF1eTempHpSources; note: string | null } {
  if (totalTempHp(sources) === 0) return { sources, note: null };
  return {
    sources,
    note: "temporary hit points are not restored by healing (CRB p.191)",
  };
}
