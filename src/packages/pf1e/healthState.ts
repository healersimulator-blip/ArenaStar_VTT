/**
 * P1 authored health/defense readout, NOT a damage resolver.
 * CRB p.191 Temporary Hit Points: separate from current/max HP (and from Con increases).
 * https://aonprd.com/Rules.aspx?ID=171
 * Energy resistance is per energy type, not immunity or a consumable HP pool:
 * https://www.d20pfsrd.com/gamemastering/special-abilities/#energy_resistance
 * Source stacking/expiry and automatic absorption are P4/P7, not implemented here.
 */
export const PF1E_ENERGY_TYPES = ["acid", "cold", "electricity", "fire", "sonic"] as const;
export type PF1eEnergyType = (typeof PF1E_ENERGY_TYPES)[number];
export interface PF1eHealthAuthored {
  /** Manually adjudicated remaining temporary HP; never folded into hp/hpMax. */
  tempHp?: number;
  /** Manually adjudicated per-type values; this editor never adds overlapping sources. */
  energyResistance?: Partial<Record<PF1eEnergyType, number>>;
}
export interface PF1eHealthReadout {
  tempHp: number;
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
  return { tempHp: amount(raw.tempHp, "tempHp"), energyResistance, issues };
}
