/**
 * P7/H04/D-207 — negative-level infliction, 24-hour saves and restoration.
 *
 * AoN 427 + UMR Energy Drain (CRB p.562):
 *  - each negative level is -1 on attacks/saves/skills/ability checks/CMB/CMD,
 *    -5 current and total HP, one level lower for level-dependent variables,
 *    death when levels ≥ Hit Dice (already `negativeLevelDeath`);
 *  - temporary levels get a new save each day at the causing effect's DC;
 *  - energy-drain levels get ONE save after 24h (DC 10 + 1/2 racial HD + Cha),
 *    failure makes the level permanent;
 *  - permanent drain allows no save, removal only via restoration-class magic.
 *
 * This module is pure count arithmetic — no dice, no store. The caller supplies
 * the die face for saves; `negativeLevelSaveVerdict` still owns the d20 math.
 */

import {
  negativeLevelSaveVerdict,
  negativeLevelTotalsOf,
  type PF1eNegativeLevelsAuthored,
} from "./negativeLevels";

export interface EnergyDrainInflictInput {
  /** Current authored counts (may be empty / malformed — normalized). */
  current: unknown;
  /** Whole levels to add, must be ≥1. */
  count: number;
  /** Which bucket the new levels land in. Energy-drain's pending levels are `temporary` until the 24h save. */
  kind: "temporary" | "permanent";
}

export interface EnergyDrainInflictResult {
  levels: PF1eNegativeLevelsAuthored;
  /** Human note for the card / sheet line. */
  note: string;
}

/**
 * Add `count` levels to `kind`. Returns the new authored object the caller writes to
 * `system.pf1e.negativeLevels`. On bad count the caller gets a named error via throw-like return.
 */
export function inflictNegativeLevels(
  input: EnergyDrainInflictInput,
): { ok: true; result: EnergyDrainInflictResult } | { ok: false; error: string } {
  if (!Number.isSafeInteger(input.count) || input.count <= 0) {
    return { ok: false, error: "count must be a positive whole number (≥1)" };
  }
  if (input.kind !== "temporary" && input.kind !== "permanent") {
    return { ok: false, error: `kind must be "temporary" or "permanent", got ${JSON.stringify(input.kind)}` };
  }
  const totals = negativeLevelTotalsOf(input.current);
  const next: PF1eNegativeLevelsAuthored = {};
  const temp = input.kind === "temporary" ? totals.temporary + input.count : totals.temporary;
  const perm = input.kind === "permanent" ? totals.permanent + input.count : totals.permanent;
  if (temp > 0) (next as Record<string, number>).temporary = temp;
  if (perm > 0) (next as Record<string, number>).permanent = perm;
  // Omit zero buckets so an empty write can be deleted with `-=`.
  const total = temp + perm;
  const note =
    input.kind === "temporary"
      ? `inflicted ${input.count} temporary negative level${input.count === 1 ? "" : "s"} — ${total} total (${temp} temporary, ${perm} permanent) — save each day at the effect's DC (AoN 427)`
      : `inflicted ${input.count} permanent negative level${input.count === 1 ? "" : "s"} — ${total} total — restoration only (raise-dead style)`;
  return { ok: true, result: { levels: next, note } };
}

export interface EnergyDrainRemoveInput {
  current: unknown;
  count: number;
  /** Which bucket to drain first. `any` prefers temporary, then permanent. */
  kind?: "temporary" | "permanent" | "any";
}

export interface EnergyDrainRemoveResult {
  /** Null means delete the authored object (`-=system.pf1e.negativeLevels`). */
  levels: PF1eNegativeLevelsAuthored | null;
  note: string;
}

export function removeNegativeLevels(
  input: EnergyDrainRemoveInput,
): { ok: true; result: EnergyDrainRemoveResult } | { ok: false; error: string } {
  if (!Number.isSafeInteger(input.count) || input.count <= 0) {
    return { ok: false, error: "count must be a positive whole number (≥1)" };
  }
  const kind = input.kind ?? "any";
  if (kind !== "temporary" && kind !== "permanent" && kind !== "any") {
    return { ok: false, error: `kind must be "temporary", "permanent" or "any"` };
  }
  const totals = negativeLevelTotalsOf(input.current);
  if (totals.total === 0) return { ok: false, error: "no negative levels to remove" };
  let temp = totals.temporary;
  let perm = totals.permanent;
  let remaining = input.count;
  if (kind === "temporary") {
    const take = Math.min(temp, remaining);
    temp -= take;
    remaining -= take;
    if (remaining > 0) return { ok: false, error: `only ${take} temporary negative level${take === 1 ? "" : "s"} to remove` };
  } else if (kind === "permanent") {
    const take = Math.min(perm, remaining);
    perm -= take;
    remaining -= take;
    if (remaining > 0) return { ok: false, error: `only ${take} permanent negative level${take === 1 ? "" : "s"} to remove` };
  } else {
    // any: temporary first, then permanent — matches restoration's narrative (the pending ones go first).
    const takeTemp = Math.min(temp, remaining);
    temp -= takeTemp;
    remaining -= takeTemp;
    const takePerm = Math.min(perm, remaining);
    perm -= takePerm;
    remaining -= takePerm;
    if (remaining > 0) return { ok: false, error: `only ${totals.total} negative level${totals.total === 1 ? "" : "s"} to remove` };
  }
  const next: PF1eNegativeLevelsAuthored | null =
    temp === 0 && perm === 0
      ? null
      : {
          ...(temp > 0 ? { temporary: temp } : {}),
          ...(perm > 0 ? { permanent: perm } : {}),
        };
  const afterTotal = temp + perm;
  const note = next === null
    ? `removed ${input.count} negative level${input.count === 1 ? "" : "s"} — none remain`
    : `removed ${input.count} negative level${input.count === 1 ? "" : "s"} — ${afterTotal} remain (${temp} temporary, ${perm} permanent)`;
  return { ok: true, result: { levels: next, note } };
}

/**
 * One 24-hour / daily save for a single negative level.
 * Temporary: success removes the level, failure keeps it (another save tomorrow).
 * Energy-drain: success removes it, failure makes it permanent (no more saves).
 */
export function saveOneNegativeLevel(
  input: {
    current: unknown;
    kind: "temporary" | "energy-drain";
    /** The die face and bonuses are validated by `negativeLevelSaveVerdict`. */
    die: number;
    fortBonus: number;
    dc: number;
  },
): { ok: true; result: { levels: PF1eNegativeLevelsAuthored | null; removed: boolean; becomesPermanent: boolean; note: string } } | { ok: false; error: string } {
  const totals = negativeLevelTotalsOf(input.current);
  if (totals.temporary === 0) {
    // Energy-drain pending levels are stored as temporary until they resolve.
    return { ok: false, error: "no temporary (pending) negative levels to save against" };
  }
  // Delegate the d20 math to the existing module so the DC text stays in one place.
  const verdict = negativeLevelSaveVerdict({ kind: input.kind, die: input.die, fortBonus: input.fortBonus, dc: input.dc });
  // verdict already validates die 1-20.
  if ((verdict as { note: string }).note.includes("must be a natural d20 face")) {
    return { ok: false, error: (verdict as { note: string }).note };
  }
  const v = verdict as { removed: boolean; becomesPermanent: boolean; note: string };
  let temp = totals.temporary;
  let perm = totals.permanent;
  let removed = false;
  let becomesPermanent = false;
  if (v.removed) {
    temp -= 1;
    removed = true;
  } else if (v.becomesPermanent) {
    temp -= 1;
    perm += 1;
    becomesPermanent = true;
  } else {
    // Temporary failed save: no count change, another save tomorrow.
  }
  const next: PF1eNegativeLevelsAuthored | null =
    temp === 0 && perm === 0
      ? null
      : {
          ...(temp > 0 ? { temporary: temp } : {}),
          ...(perm > 0 ? { permanent: perm } : {}),
        };
  const note = v.note;
  return { ok: true, result: { levels: next, removed, becomesPermanent, note } };
}
