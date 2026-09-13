/**
 * P1 authored health/defense readout, NOT a damage resolver.
 * CRB p.191 Temporary Hit Points: separate from current/max HP (and from Con increases).
 * https://aonprd.com/Rules.aspx?ID=171
 * Energy resistance is per energy type, not immunity or a consumable HP pool:
 * https://www.d20pfsrd.com/gamemastering/special-abilities/#energy_resistance
 * P7/H02 (D-206): temporary hit points stack per source — the same source does not stack
 * (highest applies), different sources do (Paizo FAQ, CRB p.208). Absorption is the
 * caller's (resolve.ts) using `tempHp.ts`; this readout only totals the authored pool.
 */
export const PF1E_ENERGY_TYPES = ["acid", "cold", "electricity", "fire", "sonic"] as const;
export type PF1eEnergyType = (typeof PF1E_ENERGY_TYPES)[number];
export interface PF1eHealthAuthored {
  /** Manually adjudicated remaining temporary HP; never folded into hp/hpMax. */
  tempHp?: number;
  /**
   * Per-source remaining temporary hit points (P7/H02). Same source ⇒ highest remaining wins;
   * different sources stack (Paizo FAQ, CRB p.208). Legacy `tempHp` is read as a single
   * `"legacy"` source so old documents keep their value; new documents should author the map.
   */
  tempHpSources?: Record<string, unknown>;
  /** Manually adjudicated per-type values; this editor never adds overlapping sources. */
  energyResistance?: Partial<Record<PF1eEnergyType, number>>;
}
export interface PF1eHealthReadout {
  tempHp: number;
  /** Per-source breakdown (validated), frozen for the derivation — total is `tempHp`. */
  tempHpSources: Readonly<Record<string, number>>;
  energyResistance: Record<PF1eEnergyType, number>;
  issues: string[];
}

/** Total, non-mutating read: malformed values are reported and contribute zero. */
export function readPF1eHealth(raw: Record<string, unknown>): PF1eHealthReadout {
  const issues: string[] = [];
  function amount(value: unknown, path: string): number {
    if (value === undefined) return 0;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    issues.push(`${path}: expected a nonnegative safe integer — using 0`);
    return 0;
  }
  let input: Record<string, unknown> = {};
  if (raw.energyResistance !== undefined) {
    if (
      raw.energyResistance !== null &&
      typeof raw.energyResistance === "object" &&
      !Array.isArray(raw.energyResistance)
    )
      input = raw.energyResistance as Record<string, unknown>;
    else issues.push("energyResistance: expected a per-energy object — using 0");
  }
  const energyResistance = { acid: 0, cold: 0, electricity: 0, fire: 0, sonic: 0 };
  for (const type of PF1E_ENERGY_TYPES)
    energyResistance[type] = amount(input[type], `energyResistance.${type}`);
  for (const type of Object.keys(input))
    if (!(PF1E_ENERGY_TYPES as readonly string[]).includes(type))
      issues.push(
        `energyResistance.${type}: unsupported energy type — retained in authored data, not applied`,
      );
  // P7/H02 — per-source temporary hit points (same source highest, different stack).
  let tempHpSources: Record<string, number> = {};
  let tempHp = 0;
  const rawSources = raw.tempHpSources;
  const rawScalar = raw.tempHp;
  if (rawSources !== undefined) {
    if (
      rawSources !== null &&
      typeof rawSources === "object" &&
      !Array.isArray(rawSources)
    ) {
      for (const [key, value] of Object.entries(rawSources as Record<string, unknown>)) {
        if (key.trim() === "") {
          issues.push(`tempHpSources[""]: source id must be non-empty — ignored`);
          continue;
        }
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          issues.push(
            `tempHpSources[${JSON.stringify(key)}] = ${JSON.stringify(value)} is not a nonnegative whole number — using 0`,
          );
          tempHpSources[key] = 0;
          continue;
        }
        tempHpSources[key] = value;
        tempHp += value;
      }
    } else {
      issues.push("tempHpSources: expected an object of source → remaining — using 0");
    }
    if (rawScalar !== undefined) {
      issues.push("tempHp: legacy scalar ignored because tempHpSources is authored");
    }
  } else if (rawScalar !== undefined) {
    const scalar = amount(rawScalar, "tempHp");
    if (scalar > 0) {
      tempHpSources = { legacy: scalar };
      tempHp = scalar;
    }
  }
  return { tempHp, tempHpSources: Object.freeze({ ...tempHpSources }), energyResistance, issues };
}
