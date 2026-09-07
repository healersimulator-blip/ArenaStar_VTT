/**
 * §10/§11 roll tables — pure draw over RollTableDocument using the dice
 * engine for the table formula. Ranges are inclusive [lo, hi]; a draw lands
 * in the result whose range contains the roll. Gaps between ranges re-roll
 * (bounded attempts) so sparse tables still resolve; overlap is a data error.
 */
import type { RollTableDocument, RollTableResult, RollRecord } from "./documents";
import { evaluateFormula, type RngFn } from "../dice/engine";

export interface TableDraw {
  roll: RollRecord;
  result: RollTableResult | null;
  /** True when no range matched after maxAttempts (sparse/empty table). */
  missed: boolean;
}

export function validateTable(table: RollTableDocument): string | null {
  if (table.results.length === 0) return "table has no results";
  const sorted = [...table.results].sort((a, b) => (a.range[0] ?? 0) - (b.range[0] ?? 0));
  let prevHi = -Infinity;
  for (const r of sorted) {
    const lo = r.range[0] ?? 0;
    const hi = r.range[1] ?? 0;
    if (lo > hi) return `range [${lo},${hi}] is inverted`;
    if (lo <= prevHi) return `range [${lo},${hi}] overlaps a previous result`;
    prevHi = hi;
  }
  return null;
}

/**
 * Draw once. `evaluate` defaults to the dice engine with the injected rng so
 * tests (and the host, §11) control randomness.
 */
export function drawFromTable(
  table: RollTableDocument,
  rng: RngFn = Math.random,
  maxAttempts = 25,
): TableDraw {
  const evalResult = evaluateFormula(table.formula, undefined, rng);
  if (!evalResult.ok) {
    // A broken formula must not throw mid-chat; surface a missed draw with a
    // zero roll record so callers can show an error chip.
    return {
      roll: { formula: table.formula, total: 0, terms: [], seedClient: null, seedHost: null },
      result: null,
      missed: true,
    };
  }
  const total = evalResult.value.total;
  const direct = table.results.find((r) => {
    const lo = r.range[0] ?? 0;
    const hi = r.range[1] ?? 0;
    return total >= lo && total <= hi;
  });
  if (direct) {
    return {
      roll: {
        formula: table.formula,
        total,
        terms: evalResult.value.terms,
        seedClient: null,
        seedHost: null,
      },
      result: direct,
      missed: false,
    };
  }
  // Gap (or empty ranges): re-roll up to maxAttempts, then give up.
  for (let i = 0; i < maxAttempts; i++) {
    const retry = evaluateFormula(table.formula, undefined, rng);
    if (!retry.ok) break;
    const t = retry.value.total;
    const hit = table.results.find((r) => {
      const lo = r.range[0] ?? 0;
      const hi = r.range[1] ?? 0;
      return t >= lo && t <= hi;
    });
    if (hit) {
      return {
        roll: {
          formula: table.formula,
          total: t,
          terms: retry.value.terms,
          seedClient: null,
          seedHost: null,
        },
        result: hit,
        missed: false,
      };
    }
  }
  return {
    roll: {
      formula: table.formula,
      total,
      terms: evalResult.value.terms,
      seedClient: null,
      seedHost: null,
    },
    result: null,
    missed: true,
  };
}
