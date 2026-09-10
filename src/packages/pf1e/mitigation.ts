/**
 * PF1e **defensive mitigation** (P3/A05) — damage reduction, energy
 * resistance/immunity/vulnerability, and object hardness, applied to the typed
 * damage components A03's `resolveDamageRoll` produces. Pure and diceless: the
 * caller supplies the attack's weapon facts and the defender's authored
 * defenses; this file never rolls and never touches a ModelPool (the strategic
 * engine's own DR/ER path stays independent per the D-113 decision — its
 * reconciliation is M01).
 *
 * Every rule here was verified against primary text before encoding:
 * - **Damage Reduction** (CRB p.561, AoN Rules ID 424): "The numerical part of
 *   a creature's damage reduction (or DR) is the amount of damage the creature
 *   ignores from normal attacks… DR 5/magic means that a creature takes 5 less
 *   points of damage from all weapons that are not magic. If a dash follows
 *   the slash, then the damage reduction is effective against any attack that
 *   does not ignore damage reduction." Multiple DR sources never stack — "the
 *   creature gets the benefit of the best damage reduction in a given
 *   situation." DR applies regardless of whether the damage is lethal or
 *   nonlethal (no rule distinguishes them; the Paizo rules-forum answer:
 *   "DR makes no consideration whether the damage is lethal or not"), and it
 *   can negate the minimum-damage 1 point of nonlethal outright.
 * - **Riders** (CRB p.561): "Whenever damage reduction completely negates the
 *   damage from an attack, it also negates most special effects that accompany
 *   the attack, such as injury poison, a monk's stunning, and injury-based
 *   disease. Damage reduction does not negate touch attacks, energy damage
 *   dealt along with an attack, or energy drains. Nor does it affect poisons
 *   or diseases delivered by inhalation, ingestion, or contact."
 * - **DR applies to physical damage only**: "Spells, spell-like abilities, and
 *   energy attacks (even nonmagical fire) ignore damage reduction." Precision
 *   damage is part of the attack's physical total and is reduced by DR with it
 *   (verified in R02/D-129 — the Gap List §2.10 claim that precision ignores
 *   DR is wrong; its own Appendix A.17 correction and the designer
 *   clarification agree).
 * - **Overcoming DR** (CRB p.561): special materials, magic weapons ("any
 *   weapon with a +1 or higher enhancement bonus"), certain weapon damage
 *   types, and alignment. Enhancement ladder: +3 ⇒ cold iron/silver, +4 ⇒
 *   adamantine ("this does not give the ability to ignore hardness, like an
 *   actual adamantine weapon does"), +5 ⇒ alignment. Ammunition fired from a
 *   +1-or-higher projectile weapon "is treated as a magic weapon for the
 *   purpose of overcoming damage reduction" — magic only, never the +3/+4/+5
 *   ladder — and "gains the alignment of that projectile weapon" on top of its
 *   own.
 * - **DR/epic** (Bestiary p.299 UMR + Mythic Adventures glossary, confirmed by
 *   the Paizo FAQ): overcome by an enhancement bonus of +6 or greater, **or**
 *   by a total effective bonus (enhancement + special-ability equivalents) of
 *   +6 or greater — special abilities count only here, never on the
 *   +1/+3/+4/+5 ladder.
 * - **Energy Resistance** (CRB p.563, AoN Rules ID 429): "the ability… to
 *   ignore some damage of a certain type **per attack**" — subtracted once per
 *   attack per type, regardless of mundane or magical source; spell-granted
 *   resistance does not stack with it.
 * - **Energy Immunity and Vulnerability** (CRB p.563 / Bestiary UMR
 *   "Vulnerabilities", AoN): immunity — "never takes damage from that energy
 *   type"; vulnerability — "takes half again as much (+50%) damage as normal
 *   from that energy type, regardless of whether a saving throw is allowed or
 *   if the save is a success or failure."
 * - **Order of vulnerability vs resistance** — deliberately decided (see
 *   DECISIONS D-138): PF1e print is silent (3.5's resist-first frost-giant
 *   paragraph was dropped), and the Paizo developer rulings (the Iron Gods
 *   robot answer; James Jacobs) direct: determine the damage the creature
 *   **would** take first — apply vulnerability, then hardness and resistance.
 *   Encoded as vulnerability ×1.5 → energy resistance → object halvings →
 *   hardness.
 * - **Objects** (CRB p.173 "Smashing an Object", AoN Rules ID 126): "When an
 *   object is damaged, subtract its hardness from the damage. Only damage in
 *   excess of its hardness is deducted from the object's hit points." Energy
 *   attacks deal **half** damage to most objects — "divide the damage by 2
 *   before applying the object's hardness" — and objects take half damage from
 *   ranged weapons the same way. "Objects are immune to nonlethal damage and
 *   to critical hits" (crit immunity is attack-side: the caller simply must
 *   not confirm a crit — noted, not enforced here). An actual adamantine
 *   weapon bypasses hardness (CRB p.561's table footnote); the +4 enhancement
 *   equivalent does not.
 *
 * Deliberately **not** here: spell resistance (C02), regeneration and fast
 * healing (H03), temp HP absorption (a P4/P7 bookkeeping concern), saving
 * throws and their half-damage interactions (C02), and any strategic-loop
 * wiring (M01).
 */

import type { PF1eEnergyType } from "./healthState";
import { PF1E_ENERGY_TYPES } from "./healthState";
import type {
  PF1ePhysicalDamageType,
  PF1eWeaponAlignment,
  PF1eWeaponDescriptor,
  PF1eWeaponMaterial,
} from "./weapons";

/** One typed piece of an attack's damage, as the mitigation layer sees it. */
export interface PF1eDamageComponent {
  label: string;
  amount: number;
  /**
   * Physical (weapon) damage — reduced by DR as one combined total per attack;
   * energy damage ignores DR entirely and is mitigated by energy resistance
   * instead (CRB p.561).
   */
  kind: "physical" | "energy";
  /** Required when kind = "energy"; ignored for physical components. */
  energyType?: PF1eEnergyType;
  nonlethal?: boolean;
  /** Precision damage is still part of the physical total — reduced by DR with it (D-129). */
  precision?: boolean;
}

/** One authored DR entry: a value plus the OR-list of conditions that bypass it ("—" or empty = nothing bypasses). */
export interface PF1eDrEntry {
  value: number;
  bypass: readonly string[];
}

/** The defender's authored defenses. */
export interface PF1eMitigationDefender {
  /** Compound DR entries; multiple entries never stack — the best applies (CRB p.561). */
  dr?: readonly PF1eDrEntry[];
  /** Per-type energy resistance — subtracted once per attack per type (CRB p.563). */
  energyResistance?: Partial<Record<PF1eEnergyType, number>>;
  /** Energy immunities: components of that type are dropped entirely. */
  immuneEnergy?: readonly PF1eEnergyType[];
  /** Energy vulnerabilities: +50% of that type (Bestiary UMR "Vulnerabilities"). */
  vulnerableEnergy?: readonly PF1eEnergyType[];
  /** Authored physical-damage immunity: all physical components are dropped. */
  immunePhysical?: boolean;
  /**
   * Object defender: hardness applies after the energy/ranged halvings, and the
   * object is immune to nonlethal damage (CRB p.173).
   */
  object?: { hardness: number };
}

/** The attack-side facts the DR bypass ladder reads. Build with `drAttackFacts`. */
export interface PF1eDrAttackFacts {
  /**
   * The weapon's own enhancement bonus. For a projectile attack this is the
   * **ammunition's** own bonus — the launcher transfers magic status and
   * alignment only, never the +3/+4/+5 ladder (CRB p.561).
   */
  enhancementBonus: number;
  /** Total effective bonus (enhancement + special-ability equivalents) — counts only toward DR/epic. */
  effectiveBonusTotal: number;
  material: PF1eWeaponMaterial;
  alignment: readonly PF1eWeaponAlignment[];
  damageType: PF1ePhysicalDamageType;
  /** Ammunition fired from a projectile weapon with a +1-or-higher enhancement: the attack counts as magic (CRB p.561). */
  countsAsMagic?: boolean;
  /** The weapon's name, for notes. */
  name?: string;
}

/**
 * Build the DR bypass facts from a weapon descriptor. For a projectile attack,
 * pass the **ammunition** as `weapon` (its own enhancement/material/alignment —
 * authored ammunition facts) and the launcher's enhancement/alignment via
 * `firedFrom`, so the "ammunition counts as magic and gains the launcher's
 * alignment, but not its enhancement ladder" rule is applied exactly. When
 * ammunition is not modeled separately, pass the bow with `firedFrom: undefined`
 * and the bow's own facts stand (a conservative fallback the caller controls).
 */
export function drAttackFacts(
  weapon: Pick<
    PF1eWeaponDescriptor,
    | "name"
    | "enhancementBonus"
    | "specialAbilityBonus"
    | "effectiveBonusTotal"
    | "material"
    | "alignment"
    | "damageType"
  >,
  firedFrom?:
    | {
        /** The launching projectile weapon's enhancement bonus — transfers magic status only. */
        enhancementBonus: number;
        /** The launcher's alignments transfer to the ammunition on top of its own (CRB p.561). */
        alignment?: readonly PF1eWeaponAlignment[];
      }
    | undefined,
): PF1eDrAttackFacts {
  const launcherAlignment = firedFrom?.alignment ?? [];
  const merged = firedFrom
    ? Array.from(new Set([...weapon.alignment, ...launcherAlignment]))
    : weapon.alignment;
  return {
    enhancementBonus: weapon.enhancementBonus,
    effectiveBonusTotal: weapon.effectiveBonusTotal,
    material: weapon.material,
    alignment: merged,
    damageType: weapon.damageType,
    ...(firedFrom !== undefined && firedFrom.enhancementBonus >= 1
      ? { countsAsMagic: true as const }
      : {}),
    name: weapon.name,
  };
}

/** Normalize a bypass token: case/whitespace/hyphen-insensitive ("Cold Iron" = "cold-iron"). */
function normalizeToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "");
}

const ALIGNMENT_TOKENS: ReadonlySet<string> = new Set([
  "good",
  "evil",
  "lawful",
  "chaotic",
]);
const DAMAGE_TYPE_TOKENS: ReadonlySet<string> = new Set([
  "slashing",
  "piercing",
  "bludgeoning",
]);

export type PF1eDrBypassResult = {
  /** True when the attack bypasses this DR entry. */
  bypassed: boolean;
  /** What bypassed it, for the chat breakdown ("+3 enhancement (cold iron)"). */
  via: string | null;
  notes: string[];
};

/**
 * Does this attack bypass this DR entry? One bypass condition suffices (DR
 * 5/piercing or slashing is an OR list — each string may itself hold
 * "piercing or slashing", the way stat blocks publish it, so strings are split
 * on " or "). Unknown tokens never bypass and are reported — the caller
 * authors real conditions; nothing is guessed. The
 * enhancement ladder never widens a material's reach: +3 substitutes for cold
 * iron/silver, +4 for adamantine (without ignoring hardness), +5 for any
 * alignment; the +6 total-effective rule is epic-only.
 */
export function drBypasses(
  entry: PF1eDrEntry,
  facts: PF1eDrAttackFacts,
): PF1eDrBypassResult {
  const notes: string[] = [];
  const isAmmo = facts.countsAsMagic === true;
  for (const raw of entry.bypass) {
    for (const piece of String(raw).split(/\s+or\s+/)) {
      const token = normalizeToken(piece);
      if (token === "" || token === "—" || token === "-") continue;
      if (token === "magic") {
        if (facts.enhancementBonus >= 1 || isAmmo) {
          return {
            bypassed: true,
            via:
              facts.enhancementBonus >= 1
                ? `+${facts.enhancementBonus} enhancement (magic)`
                : "magic ammunition (fired from a +1 or higher projectile weapon)",
            notes,
          };
        }
        continue;
      }
      if (token === "coldiron" || token === "silver") {
        const material = token === "coldiron" ? "cold iron" : "silver";
        if (facts.material === material) {
          return { bypassed: true, via: material, notes };
        }
        if (facts.enhancementBonus >= 3) {
          return {
            bypassed: true,
            via: `+${facts.enhancementBonus} enhancement (${material})`,
            notes,
          };
        }
        continue;
      }
      if (token === "adamantine") {
        if (facts.material === "adamantine") {
          return { bypassed: true, via: "adamantine", notes };
        }
        if (facts.enhancementBonus >= 4) {
          return {
            bypassed: true,
            via: `+${facts.enhancementBonus} enhancement (adamantine — hardness is not ignored)`,
            notes,
          };
        }
        continue;
      }
      if (token === "epic") {
        if (facts.enhancementBonus >= 6 || facts.effectiveBonusTotal >= 6) {
          return {
            bypassed: true,
            via:
              facts.enhancementBonus >= 6
                ? `+${facts.enhancementBonus} enhancement (epic)`
                : `total effective bonus +${facts.effectiveBonusTotal} (epic)`,
            notes,
          };
        }
        continue;
      }
      if (ALIGNMENT_TOKENS.has(token)) {
        const alignment = token as PF1eWeaponAlignment;
        if (facts.alignment.includes(alignment)) {
          return { bypassed: true, via: alignment, notes };
        }
        if (facts.enhancementBonus >= 5) {
          return {
            bypassed: true,
            via: `+${facts.enhancementBonus} enhancement (${alignment})`,
            notes,
          };
        }
        continue;
      }
      if (DAMAGE_TYPE_TOKENS.has(token)) {
        if (facts.damageType === token) {
          return { bypassed: true, via: token, notes };
        }
        continue;
      }
      notes.push(
        `DR bypass condition "${piece}" is not a modeled token — it never bypasses here; known: magic, cold iron, silver, adamantine, epic, good, evil, lawful, chaotic, slashing, piercing, bludgeoning, —`,
      );
    }
  }
  return { bypassed: false, via: null, notes };
}

export interface PF1eMitigationInput {
  attack: PF1eDrAttackFacts;
  components: readonly PF1eDamageComponent[];
  defender: PF1eMitigationDefender;
  /**
   * The attack was made with a ranged weapon and the defender is an object:
   * halve the damage before hardness (CRB p.173). Melee attacks and creature
   * defenders ignore this.
   */
  rangedWeaponAgainstObject?: boolean;
}

export type PF1eMitigationResult =
  | {
      ok: true;
      /** Per-component dealt damage after mitigation. */
      components: {
        label: string;
        dealt: number;
        nonlethal: boolean;
        kind: "physical" | "energy";
      }[];
      lethal: number;
      nonlethal: number;
      /** How much DR absorbed (0 when bypassed or no DR). */
      drApplied: number;
      /** The bypass route when DR was bypassed, for the chat breakdown. */
      drBypassedVia: string | null;
      /** Energy resistance absorbed, per type. */
      erApplied: Partial<Record<PF1eEnergyType, number>>;
      /** Hardness absorbed (objects only). */
      hardnessApplied: number;
      /**
       * True when DR (or physical immunity) reduced the physical damage to
       * nothing: injury poison, stunning and injury-based disease riders are
       * negated too (CRB p.561). Energy riders, energy drains and touch
       * attacks are NOT affected by DR — model them as energy components.
       */
      physicalDamageNegated: boolean;
      notes: string[];
    }
  | { ok: false; error: string };

/**
 * Apply the defender's DR, energy resistance/immunity/vulnerability and (for
 * objects) hardness to one attack's typed damage components. Order: energy
 * immunity drops → vulnerability ×1.5 (floor) → energy resistance (once per
 * attack per type) → object energy/ranged halving (floor) → DR against the
 * combined physical total (best entry only) → object hardness → nonlethal
 * dropped against objects. The two allocation choices PF1e print leaves open
 * are deterministic and named in `notes`: per-type resistance is spent on the
 * first component of that type, and DR against a mixed lethal/nonlethal total
 * comes off the lethal bucket first.
 */
export function applyMitigation(
  input: PF1eMitigationInput,
): PF1eMitigationResult {
  const notes: string[] = [];
  // --- validation: components -------------------------------------------------
  for (const component of input.components) {
    if (!Number.isInteger(component.amount) || component.amount < 0) {
      return {
        ok: false,
        error: `damage component "${component.label}" amount ${String(component.amount)} is not a non-negative integer`,
      };
    }
    if (
      component.kind === "energy" &&
      (component.energyType === undefined ||
        !(PF1E_ENERGY_TYPES as readonly string[]).includes(
          component.energyType,
        ))
    ) {
      return {
        ok: false,
        error: `energy component "${component.label}" has no supported energyType`,
      };
    }
    if (component.kind !== "physical" && component.kind !== "energy") {
      return {
        ok: false,
        error: `damage component "${component.label}" kind must be "physical" or "energy"`,
      };
    }
  }
  const defender = input.defender;
  for (const entry of defender.dr ?? []) {
    if (!Number.isInteger(entry.value) || entry.value < 0) {
      return {
        ok: false,
        error: `DR entry value ${String(entry.value)} is not a non-negative integer`,
      };
    }
  }
  if (
    defender.object !== undefined &&
    (!Number.isInteger(defender.object.hardness) ||
      defender.object.hardness < 0)
  ) {
    return {
      ok: false,
      error: `object hardness ${String(defender.object.hardness)} is not a non-negative integer`,
    };
  }

  // --- energy immunity: dropped entirely --------------------------------------
  const immuneEnergy = new Set(defender.immuneEnergy ?? []);
  const vulnerableEnergy = new Set(defender.vulnerableEnergy ?? []);

  type Working = {
    label: string;
    amount: number;
    kind: "physical" | "energy";
    energyType: PF1eEnergyType | null;
    nonlethal: boolean;
    precision: boolean;
  };
  const working: Working[] = [];
  for (const component of input.components) {
    if (component.amount === 0) continue;
    const energyType =
      component.kind === "energy" ? (component.energyType ?? null) : null;
    if (
      component.kind === "energy" &&
      energyType !== null &&
      immuneEnergy.has(energyType)
    ) {
      notes.push(`${component.label}: immunity to ${energyType} — no damage`);
      continue;
    }
    working.push({
      label: component.label,
      amount: component.amount,
      kind: component.kind,
      energyType,
      nonlethal: component.nonlethal === true,
      precision: component.precision === true,
    });
  }

  // --- vulnerability: +50% first (D-138; the developer-ruling order) -----------
  for (const w of working) {
    if (
      w.kind === "energy" &&
      w.energyType !== null &&
      vulnerableEnergy.has(w.energyType)
    ) {
      const boosted = Math.floor(w.amount * 1.5);
      if (boosted !== w.amount) {
        notes.push(
          `${w.label}: vulnerability to ${w.energyType} — ${w.amount} becomes ${boosted} (+50%)`,
        );
      }
      w.amount = boosted;
    }
  }

  // --- energy resistance: once per attack per type -----------------------------
  const erApplied: Partial<Record<PF1eEnergyType, number>> = {};
  const resistance = defender.energyResistance ?? {};
  for (const type of PF1E_ENERGY_TYPES) {
    const pool = resistance[type] ?? 0;
    if (pool <= 0) continue;
    let remaining = pool;
    for (const w of working) {
      if (remaining <= 0) break;
      if (w.kind !== "energy" || w.energyType !== type) continue;
      const absorbed = Math.min(remaining, w.amount);
      w.amount -= absorbed;
      remaining -= absorbed;
    }
    const used = pool - remaining;
    if (used > 0) erApplied[type] = used;
  }

  // --- objects: immune to nonlethal; energy and ranged damage halve ------------
  const isObject = defender.object !== undefined;
  if (isObject) {
    for (const w of working) {
      if (w.nonlethal) {
        notes.push(
          `${w.label}: objects are immune to nonlethal damage — dropped (CRB p.173)`,
        );
        w.amount = 0;
      }
    }
    for (const w of working) {
      if (w.amount <= 0) continue;
      if (w.kind === "energy") {
        const halved = Math.floor(w.amount / 2);
        notes.push(
          `${w.label}: energy attacks deal half damage to most objects — ${w.amount} becomes ${halved} before hardness (CRB p.173)`,
        );
        w.amount = halved;
      }
    }
    if (input.rangedWeaponAgainstObject === true) {
      for (const w of working) {
        if (w.amount <= 0 || w.kind !== "physical") continue;
        const halved = Math.floor(w.amount / 2);
        notes.push(
          `${w.label}: objects take half damage from ranged weapons — ${w.amount} becomes ${halved} before hardness (CRB p.173)`,
        );
        w.amount = halved;
      }
    }
  }

  // --- physical immunity / DR: once against the combined physical total --------
  let drApplied = 0;
  let drBypassedVia: string | null = null;
  let physicalDamageNegated = false;
  if (defender.immunePhysical === true) {
    for (const w of working) {
      if (w.kind === "physical" && w.amount > 0) {
        notes.push(`${w.label}: the defender is immune to physical damage`);
        w.amount = 0;
      }
    }
    physicalDamageNegated = working.some((w) => w.kind === "physical");
  } else if (defender.dr !== undefined && defender.dr.length > 0) {
    const physicalTotal = working
      .filter((w) => w.kind === "physical")
      .reduce((sum, w) => sum + w.amount, 0);
    if (physicalTotal > 0) {
      // Multiple DR entries never stack — the best applies in this situation.
      let bestReduction = 0;
      for (const entry of defender.dr) {
        const verdict = drBypasses(entry, input.attack);
        notes.push(...verdict.notes);
        if (verdict.bypassed) {
          if (bestReduction === 0) drBypassedVia = verdict.via;
          continue; // a bypassed entry contributes nothing
        }
        if (entry.value > bestReduction) {
          bestReduction = entry.value;
          drBypassedVia = null;
        }
      }
      if (bestReduction > 0) {
        drApplied = Math.min(bestReduction, physicalTotal);
        let toAbsorb = drApplied;
        // The rules do not say which bucket DR eats first when an attack deals
        // both lethal and nonlethal physical damage (forum answer: GM fiat) —
        // deterministically lethal first, named here.
        for (const w of working) {
          if (toAbsorb <= 0) break;
          if (w.kind !== "physical" || w.amount <= 0) continue;
          if (w.nonlethal) continue;
          const absorbed = Math.min(toAbsorb, w.amount);
          w.amount -= absorbed;
          toAbsorb -= absorbed;
        }
        for (const w of working) {
          if (toAbsorb <= 0) break;
          if (w.kind !== "physical" || w.amount <= 0 || !w.nonlethal) continue;
          const absorbed = Math.min(toAbsorb, w.amount);
          w.amount -= absorbed;
          toAbsorb -= absorbed;
        }
        if (physicalTotal - drApplied <= 0) {
          physicalDamageNegated = true;
          notes.push(
            "DR completely negated the damage — injury poison, stunning and injury-based disease riders are negated too (CRB p.561)",
          );
        }
      } else if (drBypassedVia !== null) {
        notes.push(`DR bypassed: ${drBypassedVia}`);
      }
    }
  }

  // --- object hardness: subtract once from the (post-halving) total ------------
  let hardnessApplied = 0;
  if (defender.object !== undefined) {
    const preHardness = working.reduce((sum, w) => sum + w.amount, 0);
    if (preHardness > 0) {
      // An actual adamantine weapon ignores hardness; the +4 enhancement
      // equivalent does not (CRB p.561 table footnote).
      const adamantineBypass = input.attack.material === "adamantine";
      if (adamantineBypass) {
        notes.push(
          "an adamantine weapon ignores the object's hardness (CRB p.561)",
        );
      } else {
        hardnessApplied = Math.min(defender.object.hardness, preHardness);
        let toAbsorb = hardnessApplied;
        for (const w of working) {
          if (toAbsorb <= 0) break;
          if (w.amount <= 0) continue;
          const absorbed = Math.min(toAbsorb, w.amount);
          w.amount -= absorbed;
          toAbsorb -= absorbed;
        }
      }
    }
  }

  let lethal = 0;
  let nonlethal = 0;
  const components = working.map((w) => ({
    label: w.label,
    dealt: w.amount,
    nonlethal: w.nonlethal,
    kind: w.kind,
  }));
  for (const c of components) {
    if (c.nonlethal) nonlethal += c.dealt;
    else lethal += c.dealt;
  }
  return {
    ok: true,
    components,
    lethal,
    nonlethal,
    drApplied,
    drBypassedVia,
    erApplied,
    hardnessApplied,
    physicalDamageNegated,
    notes,
  };
}

/**
 * Convert an A03 `resolveDamageRoll` result into the typed components this
 * layer consumes: the weapon damage is one physical component (its bucket from
 * `weaponContribution`), each retained bonus line its own component — energy
 * riders by their `energyType`, precision lines flagged (still physical: DR
 * reduces them with the total, D-129).
 */
export function damageComponentsFromRoll(roll: {
  weaponContribution: { lethal: number; nonlethal: number };
  bonusContributions: readonly {
    label: string;
    amount: number;
    nonlethal: boolean;
    precision: boolean;
    energyType: PF1eEnergyType | null;
  }[];
}): PF1eDamageComponent[] {
  const components: PF1eDamageComponent[] = [];
  const weaponAmount =
    roll.weaponContribution.lethal + roll.weaponContribution.nonlethal;
  if (weaponAmount > 0) {
    components.push({
      label: "weapon damage",
      amount: weaponAmount,
      kind: "physical",
      nonlethal: roll.weaponContribution.nonlethal > 0,
    });
  }
  for (const line of roll.bonusContributions) {
    if (line.amount <= 0) continue;
    components.push({
      label: line.label,
      amount: line.amount,
      kind: line.energyType === null ? "physical" : "energy",
      ...(line.energyType === null ? {} : { energyType: line.energyType }),
      nonlethal: line.nonlethal,
      precision: line.precision,
    });
  }
  return components;
}
