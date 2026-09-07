/**
 * §11 TurnReport summaries: aggregate SimEvents into distributions (by type,
 * damage per unit, break-test roll histogram). Pure + Json-safe — the runner
 * stores the result in TurnReport.summary.distributions and the reports tab
 * renders it without re-parsing event text.
 */
import type { Json } from "./documents";
import type { SimEvent } from "./sim";

export interface UnitDamage {
  unitId: string;
  hits: number;
  wounds: number;
  attacks: number;
}

export interface ReportDistributions {
  byType: Record<string, number>;
  bySubPhase: Record<string, number>;
  totals: { hits: number; wounds: number; attacks: number; attrition: number; routs: number };
  /** Top damage-dealing units (by wounds, then hits), capped. */
  damageByUnit: UnitDamage[];
  /** Break-test rolls (2d6-style values) → counts, keyed by value. */
  routRolls: Record<string, number>;
}

const TOP_UNITS = 6;

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

export function summarizeDistributions(events: readonly SimEvent[]): ReportDistributions {
  const byType: Record<string, number> = {};
  const bySubPhase: Record<string, number> = {};
  const totals = { hits: 0, wounds: 0, attacks: 0, attrition: 0, routs: 0 };
  const perUnit = new Map<string, UnitDamage>();
  const routRolls: Record<string, number> = {};

  for (const e of events) {
    bump(byType, e.type);
    bump(bySubPhase, e.subPhase);
    const data = (e.data ?? {}) as Record<string, unknown>;
    const num = (key: string): number => {
      const v = data[key];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };
    if (e.type === "attack") {
      const hits = num("hits");
      const wounds = num("wounds");
      const attackers = num("attackers");
      totals.attacks += 1;
      totals.hits += hits;
      totals.wounds += wounds;
      const row = perUnit.get(e.unitId) ?? { unitId: e.unitId, hits: 0, wounds: 0, attacks: 0 };
      row.hits += hits;
      row.wounds += wounds;
      row.attacks += attackers;
      perUnit.set(e.unitId, row);
    } else if (e.type === "attrition") {
      totals.attrition += 1;
    } else if (e.type === "rout") {
      totals.routs += 1;
      const roll = num("roll");
      if (roll > 0) bump(routRolls, String(Math.round(roll)));
    }
  }

  const damageByUnit = [...perUnit.values()]
    .sort((a, b) => b.wounds - a.wounds || b.hits - a.hits || (a.unitId < b.unitId ? -1 : 1))
    .slice(0, TOP_UNITS);

  return { byType, bySubPhase, totals, damageByUnit, routRolls };
}

/** Json round-trip (summary travels inside the TurnReport doc/frame). */
export function distributionsToJson(d: ReportDistributions): Json {
  return JSON.parse(JSON.stringify(d)) as Json;
}
