/**
 * PF1e **sheet roll bridge** (P3/A06, first slice) — the pure builders that
 * turn a derived actor into chat-roll specifications: what each sheet button
 * rolls, and how the breakdown line reads. No dice are rolled here, no store
 * is touched: the caller posts `formula` through `ClientSync.roll` (§11 — the
 * host evaluates and posts the card), with `flavor` as the human breakdown
 * ("Longsword +10 = BAB 6 + Str +3, size +0").
 *
 * Numbers come from `derivePF1eActor`'s derived attack lines — the single
 * authoritative derivation that already includes ability, size, handedness,
 * ability damage and live effect modifiers — so the buttons can never disagree
 * with the sheet readout. The A02/A03/A04/A05 resolver layers take the next
 * step (a d20 result against a chosen defense, confirmation, mitigation, HP
 * application) and are deliberately not consulted for the button totals; their
 * importer is the authoritative attack-resolution flow, where a defense and
 * rider choices exist to resolve against.
 *
 * What IS encoded from the resolver layers: the critical-damage arithmetic
 * (CRB p.179/A.3 via D-136) — a ×N critical rolls the weapon damage N times
 * with **all modifiers** and totals the results, so the crit button's formula
 * is N groups of "dice + static" (`1d8 + 4 + 1d8 + 4`), never
 * `(1d8 + 4) × 2`. Bonus-dice and precision riders are not part of a derived
 * line and so cannot be silently multiplied here.
 */

import type { PF1eDerived, PF1eDerivedAttack } from "./actor";

/** What a roll button rolls and how its chat card reads. */
export interface PF1eRollSpec {
  kind: "attack" | "damage" | "critDamage" | "save" | "check";
  /** Button/chat label, e.g. "Longsword" or "Fortitude". */
  label: string;
  /** A §11 dice formula with every modifier resolved: "1d20 + 10", "1d8 + 4". */
  formula: string;
  /** The breakdown line shown on the roll card. */
  flavor: string;
  notes: string[];
}

/** One attack line's roll affordances on the Combat tab. */
export interface PF1eAttackRollGroup {
  label: string;
  /** The single (standard-action) attack at the line's highest bonus. */
  attack: PF1eRollSpec;
  /** Every iterative — one chat roll each (full-attack action). */
  fullAttack: PF1eRollSpec[];
  /** The damage roll, or null when the line has neither dice nor a modifier. */
  damage: PF1eRollSpec | null;
  /** The critical-damage roll (×multiplier, dice + static per step), or null. */
  critDamage: PF1eRollSpec | null;
  /**
   * The attack provokes an attack of opportunity (unarmed, and the attacker
   * does not count as armed): true only for the derived unarmed fallback
   * (no authored attack lines) without Improved Unarmed Strike or natural
   * attacks. Prompt data only — the interrupt itself is P06.
   */
  provokes: boolean;
  notes: string[];
}

/** Author context the unarmed-provoke rule needs; the sheet supplies it from authored data. */
export interface PF1eAttackRollContext {
  /** How many attack lines were authored (`system.pf1e.attacks[]`); 0 ⇒ the lines shown are the unarmed fallback. */
  authoredAttacksCount?: number | undefined;
  /** Feat names as authored (`system.pf1e.feats[]`); Improved Unarmed Strike counts as armed. */
  feats?: readonly string[] | undefined;
  /** Whether any derived line is a natural attack — a creature with natural weapons counts as armed. */
  hasNaturalAttacks?: boolean | undefined;
}

/** "+3" / "−2" / "0" for display text (the formula itself uses ASCII -). */
export function fmtSigned(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "+0";
}

function formulaJoin(parts: string[]): string {
  return parts.join(" + ");
}

/** "1d8 + 4" / "1d8 - 2" / "1d8" / "4"; null when there is nothing to roll. */
function damageFormula(
  dice: string | null,
  staticBonus: number,
): string | null {
  const hasDice = dice !== null && dice.trim() !== "";
  if (!hasDice && staticBonus === 0) return null;
  if (!hasDice) return String(staticBonus);
  if (staticBonus === 0) return dice;
  return staticBonus > 0
    ? `${dice} + ${staticBonus}`
    : `${dice} - ${Math.abs(staticBonus)}`;
}

/**
 * The critical-damage formula (CRB p.179 via D-136): the weapon damage rolled
 * once per multiplier step with all modifiers, totaled — `1d8 + 4 + 1d8 + 4`
 * for a ×2, three groups for a ×3. Dice-less lines multiply the flat modifier
 * once (each step adds the static stack; one baked number reads cleaner than
 * "4 + 4"). A multiplier below 2 is the resolver's clamped domain — here it is
 * refused with a note, never guessed.
 */
function critDamageFormula(
  dice: string | null,
  staticBonus: number,
  multiplier: number,
): { formula: string | null; note: string | null } {
  if (!Number.isInteger(multiplier) || multiplier < 2) {
    return {
      formula: null,
      note: `critical multiplier ${String(multiplier)} is below 2 — no critical damage formula built`,
    };
  }
  const group = damageFormula(dice, staticBonus);
  if (group === null) return { formula: null, note: null };
  if (dice === null || dice.trim() === "") {
    return { formula: String(staticBonus * multiplier), note: null };
  }
  return {
    formula: formulaJoin(Array.from({ length: multiplier }, () => group)),
    note: null,
  };
}

/** The explain string's non-BAB body: strip the leading "+N = " and the trailing "; damage …". */
function explainBody(line: PF1eDerivedAttack): string | null {
  const head = line.explain.split("; damage ")[0] ?? line.explain;
  const m = head.match(/^[+-]\d+ = /);
  if (m === null) return null; // unexpected shape — the caller falls back to the verbatim string
  return head.slice(m[0].length);
}

function attackFlavor(
  line: PF1eDerivedAttack,
  bonus: number,
  bab: number,
): string {
  const body = explainBody(line);
  if (body === null) {
    return `${line.name} ${fmtSigned(bonus)} — ${line.explain}`;
  }
  return `${line.name} ${fmtSigned(bonus)} = BAB ${bab} + ${body}`;
}

function attackSpec(
  line: PF1eDerivedAttack,
  bonus: number,
  bab: number,
  ordinal: number | null,
): PF1eRollSpec {
  const label =
    ordinal === null ? line.name : `${line.name} (attack ${ordinal})`;
  return {
    kind: "attack",
    label,
    formula: `1d20 ${bonus >= 0 ? `+ ${bonus}` : `- ${Math.abs(bonus)}`}`,
    flavor: attackFlavor(line, bonus, bab),
    notes: [],
  };
}

function hasFeat(
  feats: readonly string[] | undefined,
  needle: string,
): boolean {
  return (feats ?? []).some((f) => f.trim().toLowerCase() === needle);
}

/**
 * Build one roll group per derived attack line: the standard-action attack,
 * the full-attack iteratives (one chat roll each), the damage roll and the
 * critical-damage roll (×multiplier with all modifiers per step). Iteratives
 * come from the derived ladder, so BAB +6/+1 posts two rolls at +10/+5.
 */
export function pf1eAttackRollGroups(
  derived: PF1eDerived,
  context?: PF1eAttackRollContext,
): PF1eAttackRollGroup[] {
  const bab = Math.trunc(derived.baseAttack);
  const authoredCount = context?.authoredAttacksCount ?? derived.attacks.length;
  // PF1eDerivedAttack carries no natural-weapon flag — the sheet supplies it
  // from the authored lines (`natural || secondary`), matching the derivation.
  const armed =
    hasFeat(context?.feats, "improved unarmed strike") ||
    context?.hasNaturalAttacks === true;
  return derived.attacks.map((line) => {
    const notes: string[] = [];
    const bonuses = line.attackBonuses;
    const attack = attackSpec(line, bonuses[0] ?? bab, bab, null);
    const fullAttack = bonuses.map((bonus, i) =>
      attackSpec(line, bonus, bab, bonuses.length > 1 ? i + 1 : null),
    );
    const dmg = damageFormula(line.damageDice, line.damageBonus);
    const crit = critDamageFormula(
      line.damageDice,
      line.damageBonus,
      line.critMultiplier,
    );
    if (crit.note !== null) notes.push(crit.note);
    if (line.critThreatMin < 20) {
      notes.push(`threat range ${line.critThreatMin}–20`);
    }
    // The provoke rule (CRB p.182): the derived fallback line is an unarmed
    // strike; without IUS or natural weapons the attacker is not armed. An
    // explicitly authored line named "unarmed" gets the advisory note —
    // whether its author meant the strike is not guessed here.
    let provokes = false;
    if (authoredCount === 0 && !armed) {
      provokes = true;
      notes.push(
        "unarmed attack provokes an attack of opportunity from the armed target — interrupt resolution is P6",
      );
    } else if (/unarmed/i.test(line.name) && !armed) {
      notes.push(
        "an unarmed attack provokes unless the attacker counts as armed (Improved Unarmed Strike, natural weapons)",
      );
    }
    return {
      label: line.name,
      attack,
      fullAttack,
      damage:
        dmg === null
          ? null
          : {
              kind: "damage" as const,
              label: line.name,
              formula: dmg,
              flavor: `${line.name} damage — ${line.explain}`,
              notes: [],
            },
      critDamage:
        crit.formula === null
          ? null
          : {
              kind: "critDamage" as const,
              label: `${line.name} ×${line.critMultiplier}`,
              formula: crit.formula,
              flavor: `${line.name} critical ×${line.critMultiplier} — weapon damage rolled ${line.critMultiplier} times with all modifiers (CRB p.179)`,
              notes: [],
            },
      provokes,
      notes,
    };
  });
}

/** The three saving throws as roll specs (d20 + derived total). */
export function pf1eSaveRollSpecs(derived: PF1eDerived): PF1eRollSpec[] {
  const explain = derived.explain.saves ?? "base + ability";
  const entries: [string, keyof PF1eDerived["saves"]][] = [
    ["Fortitude", "fort"],
    ["Reflex", "ref"],
    ["Will", "will"],
  ];
  return entries.map(([label, key]) => {
    const bonus = derived.saves[key];
    return {
      kind: "save" as const,
      label,
      formula: `1d20 ${bonus >= 0 ? `+ ${bonus}` : `- ${Math.abs(bonus)}`}`,
      flavor: `${label} ${fmtSigned(bonus)} — ${explain}`,
      notes: [],
    };
  });
}

/** Initiative as a roll spec (a Dexterity check + modifiers, CRB p.178). */
export function pf1eInitiativeRollSpec(derived: PF1eDerived): PF1eRollSpec {
  const bonus = derived.initiative;
  const explain = derived.explain.initiative ?? "Dex + modifiers";
  return {
    kind: "check",
    label: "Initiative",
    formula: `1d20 ${bonus >= 0 ? `+ ${bonus}` : `- ${Math.abs(bonus)}`}`,
    flavor: `Initiative ${fmtSigned(bonus)} — ${explain}`,
    notes: [],
  };
}
