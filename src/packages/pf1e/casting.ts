/**
 * P5/C02 — tactical casting and saving-throw resolution.
 *
 * Pure and **diceless**: every caller passes the rolled d20 face and the rolled
 * damage, so each fixture is exact and replayable (the same contract A02/A03
 * use in `tactical.ts`). Nothing here rolls `Math.random()`.
 *
 * Rule sources, transcribed 2026-09-11:
 *   • Archives of Nethys Rules ID 212 / d20pfsrd.com/magic / d20srd.org —
 *     "Saving Throw" and "Saving Throw Difficulty Class".
 *   • Archives of Nethys Rules ID 230 "Saving Throw" — automatic failures and
 *     successes, voluntarily giving up a save, magic-item save bonuses.
 *   • Gap List A.16 "Spellcasting in combat" (already verified by R02/D-129) —
 *     Evasion / Improved Evasion, and the spell-resistance check.
 *   • Universal Monster Rules "Spell Resistance" — SR is overcome, *then* the
 *     creature still gets its saving throw.
 * Each is cited inline.
 *
 * Per controlling decision 1, this is the **tactical** resolver. It shares only
 * data and the energy-mitigation helper with the strategic `spells.ts`; there
 * is no shared resolution kernel and no cross-scale parity gate.
 */
import {
  applyEnergyMitigation,
  type PF1eDamageComponent,
  type PF1eMitigationDefender,
} from "./mitigation";
import { PF1E_ENERGY_TYPES, type PF1eEnergyType } from "./healthState";

export type PF1eSaveType = "fort" | "ref" | "will";

/**
 * The spell's saving-throw entry. AoN 212 defines exactly these:
 *   **Negates** — "The spell has no effect on a subject that makes a
 *     successful saving throw."
 *   **Partial** — "The spell has an effect on its subject. A successful saving
 *     throw means that some lesser effect occurs" (the lesser effect is
 *     spell-specific, so no numeric multiplier is invented for it).
 *   **Half** — "The spell deals damage, and a successful saving throw halves
 *     the damage taken (round down)."
 *   **None** — "No saving throw is allowed."
 *   **Disbelief** — "A successful save lets the subject ignore the spell's
 *     effect" (illusions).
 */
export const PF1E_SAVE_SEVERITIES = [
  "negates",
  "partial",
  "half",
  "none",
  "disbelief",
] as const;
export type PF1eSaveSeverity = (typeof PF1E_SAVE_SEVERITIES)[number];

export interface PF1eCastIssue {
  field: string;
  message: string;
}

// ─── saving throw difficulty class (AoN 212) ─────────────────────────────────

/**
 * "A saving throw against your spell has a DC of 10 + the level of the spell +
 * your bonus for the relevant ability (Intelligence for a wizard, Charisma for
 * a bard, paladin, or sorcerer, or Wisdom for a cleric, druid, or ranger). A
 * spell's level can vary depending on your class. Always use the spell level
 * applicable to your class."
 *
 * `focusBonus` is **caller-derived**: Spell Focus adds +1 to the DC of spells
 * from its school and Greater Spell Focus adds +1 more, stacking. Neither feat
 * is in the A07 contract yet, and per D-141 no feat is silently activated from
 * authored content — so the base formula here is the SRD's, and the feat
 * contribution arrives explicitly once A07 encodes it.
 */
export function spellSaveDc(input: {
  spellLevel: number;
  keyAbilityMod: number;
  focusBonus?: number | undefined;
}): { dc: number; issues: PF1eCastIssue[] } {
  const issues: PF1eCastIssue[] = [];
  if (
    !Number.isInteger(input.spellLevel) ||
    input.spellLevel < 0 ||
    input.spellLevel > 9
  ) {
    issues.push({
      field: "spellLevel",
      message: `spell level ${String(input.spellLevel)} is not an integer 0–9`,
    });
  }
  if (!Number.isInteger(input.keyAbilityMod)) {
    issues.push({
      field: "keyAbilityMod",
      message: `key ability modifier ${String(input.keyAbilityMod)} is not an integer`,
    });
  }
  const focus = input.focusBonus ?? 0;
  if (!Number.isInteger(focus) || focus < 0) {
    issues.push({
      field: "focusBonus",
      message: `focus bonus ${String(focus)} is not a non-negative integer`,
    });
  }
  if (issues.length > 0) return { dc: 0, issues };
  return { dc: 10 + input.spellLevel + input.keyAbilityMod + focus, issues };
}

// ─── the save itself (AoN 230) ───────────────────────────────────────────────

export interface PF1eSaveResult {
  passed: boolean;
  total: number;
  /** Non-null when the outcome was decided by the die face, not the total. */
  automatic: "failure" | "success" | null;
  issues: PF1eCastIssue[];
}

/**
 * Resolve one saving throw. AoN 230: "A natural 1 (the d20 comes up 1) on a
 * saving throw is always a failure… A natural 20 (the d20 comes up 20) is
 * always a success." Otherwise the save passes on a total that **equals or
 * exceeds** the DC.
 *
 * `foregone` models "A creature can voluntarily forego a saving throw and
 * willingly accept a spell's result" — no roll is read in that case.
 */
export function resolveSpellSave(input: {
  /** The d20 face, 1–20. Ignored when `foregone` is set. */
  die?: number | undefined;
  saveBonus: number;
  dc: number;
  foregone?: boolean | undefined;
}): PF1eSaveResult {
  if (input.foregone === true) {
    return { passed: false, total: 0, automatic: null, issues: [] };
  }
  const die = input.die;
  if (
    typeof die !== "number" ||
    !Number.isInteger(die) ||
    die < 1 ||
    die > 20
  ) {
    return {
      passed: false,
      total: 0,
      automatic: null,
      issues: [
        {
          field: "die",
          message: `save die ${String(die)} is not an integer 1–20`,
        },
      ],
    };
  }
  if (!Number.isInteger(input.saveBonus)) {
    return {
      passed: false,
      total: 0,
      automatic: null,
      issues: [
        {
          field: "saveBonus",
          message: `save bonus ${String(input.saveBonus)} is not an integer`,
        },
      ],
    };
  }
  if (!Number.isInteger(input.dc)) {
    return {
      passed: false,
      total: 0,
      automatic: null,
      issues: [
        {
          field: "dc",
          message: `save DC ${String(input.dc)} is not an integer`,
        },
      ],
    };
  }
  const total = die + input.saveBonus;
  if (die === 1)
    return { passed: false, total, automatic: "failure", issues: [] };
  if (die === 20)
    return { passed: true, total, automatic: "success", issues: [] };
  return { passed: total >= input.dc, total, automatic: null, issues: [] };
}

// ─── what a successful save does (AoN 212 + A.16 evasion) ────────────────────

export type PF1eSaveOutcome =
  /** Full effect applies. */
  | { kind: "full"; multiplier: 1; note: string | null }
  /** Half damage, rounded down. */
  | { kind: "half"; multiplier: 0.5; note: string | null }
  /** The spell has no effect. */
  | { kind: "none"; multiplier: 0; note: string | null }
  /**
   * "Partial" and "disbelief" saves succeed into a *lesser* effect that the
   * spell itself defines. Refusing to invent a number for them is the point of
   * this variant — callers must read the spell's text.
   */
  | { kind: "lesser"; multiplier: 1; note: string };

/**
 * Turn the save entry and the roll into a damage multiplier.
 *
 * Evasion (A.16/D-129): "Evasion: Reflex half ⇒ 0; Improved Evasion: Reflex
 * half ⇒ 0, Reflex fail ⇒ half." Both apply only to a **Reflex** save whose
 * entry is **half** — Evasion is defined against "an attack that normally
 * allows a Reflex saving throw for half damage", so it does nothing to a
 * Fortitude-negates spell.
 */
export function spellSaveOutcome(input: {
  severity: PF1eSaveSeverity;
  saveType: PF1eSaveType;
  passed: boolean;
  evasion?: boolean | undefined;
  improvedEvasion?: boolean | undefined;
}): PF1eSaveOutcome {
  const reflexHalf = input.saveType === "ref" && input.severity === "half";
  switch (input.severity) {
    case "none":
      return {
        kind: "full",
        multiplier: 1,
        note: "no saving throw is allowed — the effect applies in full",
      };
    case "negates":
      return input.passed
        ? {
            kind: "none",
            multiplier: 0,
            note: "successful save negates the spell",
          }
        : { kind: "full", multiplier: 1, note: null };
    case "half": {
      if (input.passed) {
        if (reflexHalf && (input.improvedEvasion || input.evasion)) {
          return {
            kind: "none",
            multiplier: 0,
            note: input.improvedEvasion
              ? "Improved Evasion — no damage on a successful Reflex save"
              : "Evasion — no damage on a successful Reflex save",
          };
        }
        return {
          kind: "half",
          multiplier: 0.5,
          note: "successful save halves the damage",
        };
      }
      if (reflexHalf && input.improvedEvasion) {
        return {
          kind: "half",
          multiplier: 0.5,
          note: "Improved Evasion — only half damage on a failed Reflex save",
        };
      }
      return { kind: "full", multiplier: 1, note: null };
    }
    case "partial":
      return {
        kind: "lesser",
        multiplier: 1,
        note: "partial: a successful save produces a lesser effect defined by the spell — no numeric multiplier is invented here",
      };
    case "disbelief":
      return {
        kind: "lesser",
        multiplier: 1,
        note: "disbelief: a successful save lets the subject ignore the effect — no numeric multiplier is invented here",
      };
    default:
      return {
        kind: "lesser",
        multiplier: 1,
        note: `unknown save severity "${String(input.severity)}" — no multiplier invented`,
      };
  }
}

// ─── spell resistance (A.16) ─────────────────────────────────────────────────

export interface PF1eSrResult {
  /** True when the spell does not affect the creature at all. */
  resisted: boolean;
  /** The caster-level check total (null when no check was needed). */
  total: number | null;
  /** True when no roll was made because SR was already overcome this round. */
  reused: boolean;
  issues: PF1eCastIssue[];
}

/**
 * The caster-level check against spell resistance.
 *
 * A.16, verified against the Universal Monster Rules: "caster-level check
 * 1d20 + CL ≥ SR — there is **no** natural-20 auto-success and no natural-1
 * auto-fail". D-129 recorded the `if (srRoll !== 20)` short-circuit in the
 * strategic resolver as a house rule; it does not exist here, and a fixture
 * pins a natural 20 that still fails and a natural 1 that still succeeds.
 *
 * "Resistance is overcome once per spell per round": when
 * `alreadyOvercomeThisRound` is set, no roll is made and the spell proceeds.
 * And per the UMR, overcoming SR does **not** skip the saving throw — that is
 * the caller's next step, not this function's.
 */
export function spellResistanceCheck(input: {
  /** The d20 face, 1–20. Ignored when no check is needed. */
  die?: number | undefined;
  casterLevel: number;
  /** The creature's SR; 0/absent means it has none. */
  spellResistance?: number | undefined;
  alreadyOvercomeThisRound?: boolean | undefined;
}): PF1eSrResult {
  const sr = input.spellResistance ?? 0;
  if (sr <= 0) {
    return { resisted: false, total: null, reused: false, issues: [] };
  }
  if (!Number.isInteger(sr)) {
    return {
      resisted: false,
      total: null,
      reused: false,
      issues: [
        {
          field: "spellResistance",
          message: `SR ${String(sr)} is not an integer`,
        },
      ],
    };
  }
  if (input.alreadyOvercomeThisRound === true) {
    return { resisted: false, total: null, reused: true, issues: [] };
  }
  const die = input.die;
  if (
    typeof die !== "number" ||
    !Number.isInteger(die) ||
    die < 1 ||
    die > 20
  ) {
    return {
      resisted: false,
      total: null,
      reused: false,
      issues: [
        {
          field: "die",
          message: `SR check die ${String(die)} is not an integer 1–20`,
        },
      ],
    };
  }
  if (!Number.isInteger(input.casterLevel) || input.casterLevel < 0) {
    return {
      resisted: false,
      total: null,
      reused: false,
      issues: [
        {
          field: "casterLevel",
          message: `caster level ${String(input.casterLevel)} is not a non-negative integer`,
        },
      ],
    };
  }
  const total = die + input.casterLevel;
  // Equal or greater overcomes it; no natural-die special cases.
  return { resisted: total < sr, total, reused: false, issues: [] };
}

// ─── one target, end to end ──────────────────────────────────────────────────

export interface PF1eSpellTargetInput {
  /** Raw rolled spell damage, before the save and before mitigation. */
  damage: number;
  energyType?: PF1eEnergyType | undefined;
  severity: PF1eSaveSeverity;
  saveType: PF1eSaveType;
  dc: number;
  /** The target's bonus for `saveType`. */
  saveBonus: number;
  saveDie?: number | undefined;
  foregone?: boolean | undefined;
  evasion?: boolean | undefined;
  improvedEvasion?: boolean | undefined;
  /** The target's ER/immunity/vulnerability. DR is irrelevant: energy ignores it. */
  defender?: PF1eMitigationDefender | undefined;
  sr?: PF1eSrResult | undefined;
}

export type PF1eSpellTargetResult =
  | {
      ok: true;
      /** The spell never reached the creature. */
      resisted: boolean;
      passed: boolean;
      automatic: "failure" | "success" | null;
      outcome: PF1eSaveOutcome;
      /** Damage after the save and after energy mitigation. */
      dealt: number;
      /** What the save removed (pre-mitigation). */
      saveReduced: number;
      erApplied: Partial<Record<PF1eEnergyType, number>>;
      notes: string[];
    }
  | { ok: false; error: string };

/**
 * Resolve one target of a spell: spell resistance first (a resisted creature is
 * unaffected and gets no save), then the saving throw, then the severity
 * multiplier, then the shared energy pipeline.
 *
 * **Order of halving and mitigation, named because print does not settle it:**
 * the save halves the rolled damage first (round down, per "halves the damage
 * taken (round down)"), and energy immunity/vulnerability/resistance then apply
 * to what the creature actually takes — consistent with A.17's "energy
 * resistance: subtract per damage type, applies once per attack". Recorded here
 * rather than left implicit, the way `applyMitigation` names its own allocation
 * choices.
 *
 * A spell with no energy type is physical-typed only in the sense that no
 * energy mitigation applies to it; DR is never applied to spell damage (CRB
 * p.561 — DR reduces weapon and natural-attack damage), so a spell's damage is
 * passed through the energy pipeline and never through the DR ladder.
 */
export function resolveSpellTarget(
  input: PF1eSpellTargetInput,
): PF1eSpellTargetResult {
  if (!Number.isInteger(input.damage) || input.damage < 0) {
    return {
      ok: false,
      error: `spell damage ${String(input.damage)} is not a non-negative integer`,
    };
  }
  if (
    input.energyType !== undefined &&
    !(PF1E_ENERGY_TYPES as readonly string[]).includes(input.energyType)
  ) {
    return {
      ok: false,
      error: `unknown energy type "${String(input.energyType)}"`,
    };
  }
  if (!(PF1E_SAVE_SEVERITIES as readonly string[]).includes(input.severity)) {
    return {
      ok: false,
      error: `unknown save severity "${String(input.severity)}"`,
    };
  }

  // --- 1. spell resistance ----------------------------------------------------
  if (input.sr?.resisted === true) {
    return {
      ok: true,
      resisted: true,
      passed: false,
      automatic: null,
      outcome: {
        kind: "none",
        multiplier: 0,
        note: "spell resistance overcame the spell",
      },
      dealt: 0,
      saveReduced: 0,
      erApplied: {},
      notes: ["spell resistance: the spell does not affect this creature"],
    };
  }

  // --- 2. saving throw --------------------------------------------------------
  // "None: no saving throw is allowed" — nothing is rolled, so no die is
  // required and the target cannot forego or fail a save that does not exist.
  const allowsSave = input.severity !== "none";
  const save = allowsSave
    ? resolveSpellSave({
        die: input.saveDie,
        saveBonus: input.saveBonus,
        dc: input.dc,
        foregone: input.foregone,
      })
    : {
        passed: false,
        total: 0,
        automatic: null,
        issues: [] as PF1eCastIssue[],
      };
  if (save.issues.length > 0) {
    return {
      ok: false,
      error: save.issues.map((i) => `${i.field}: ${i.message}`).join("; "),
    };
  }

  // --- 3. severity multiplier -------------------------------------------------
  const outcome = spellSaveOutcome({
    severity: input.severity,
    saveType: input.saveType,
    passed: save.passed,
    evasion: input.evasion,
    improvedEvasion: input.improvedEvasion,
  });
  const notes: string[] = [];
  if (outcome.note) notes.push(outcome.note);
  const afterSave = Math.floor(input.damage * outcome.multiplier);
  const saveReduced = input.damage - afterSave;

  // --- 4. energy mitigation (shared with A05; energy ignores DR) ---------------
  if (afterSave <= 0) {
    return {
      ok: true,
      resisted: false,
      passed: save.passed,
      automatic: save.automatic,
      outcome,
      dealt: 0,
      saveReduced,
      erApplied: {},
      notes,
    };
  }
  const component: PF1eDamageComponent =
    input.energyType !== undefined
      ? {
          label: "spell",
          amount: afterSave,
          kind: "energy",
          energyType: input.energyType,
        }
      : { label: "spell", amount: afterSave, kind: "physical" };
  const mitigated = applyEnergyMitigation([component], input.defender ?? {});
  const dealt = mitigated.components.reduce((sum, c) => sum + c.amount, 0);
  notes.push(...mitigated.notes);
  return {
    ok: true,
    resisted: false,
    passed: save.passed,
    automatic: save.automatic,
    outcome,
    dealt,
    saveReduced,
    erApplied: mitigated.erApplied,
    notes,
  };
}

// ─── objects (AoN 230) ───────────────────────────────────────────────────────

/**
 * "A magic item's saving throw bonuses are each equal to 2 + 1/2 the item's
 * caster level" (rounded down). Objects receive saves "only if they are magical
 * or if they are attended … by a creature resisting the spell, in which case
 * the object uses the creature's saving throw bonus unless its own bonus is
 * greater" — so the caller compares, and an unattended non-magical object gets
 * no save at all.
 */
export function magicItemSaveBonus(itemCasterLevel: number): number | null {
  if (!Number.isInteger(itemCasterLevel) || itemCasterLevel < 0) return null;
  return 2 + Math.floor(itemCasterLevel / 2);
}

/**
 * Which save bonus an object uses. Returns null when the object gets no save
 * (unattended and non-magical).
 */
export function objectSaveBonus(input: {
  magical?: boolean;
  attended?: boolean;
  itemCasterLevel?: number | undefined;
  /** The attending creature's bonus for this save type, if it is resisting. */
  holderBonus?: number | undefined;
}): number | null {
  const item =
    input.magical === true && input.itemCasterLevel !== undefined
      ? magicItemSaveBonus(input.itemCasterLevel)
      : null;
  if (input.magical === true) {
    const holder = input.attended === true ? (input.holderBonus ?? null) : null;
    if (item === null) return holder;
    if (holder === null) return item;
    return Math.max(item, holder);
  }
  // Non-magical: only attended objects save, using the holder's bonus.
  if (input.attended !== true) return null;
  return input.holderBonus ?? null;
}

/** Human-readable label for the chat breakdown. */
export function describeSave(
  severity: PF1eSaveSeverity,
  saveType: PF1eSaveType,
): string {
  const type =
    saveType === "fort" ? "Fortitude" : saveType === "ref" ? "Reflex" : "Will";
  switch (severity) {
    case "none":
      return "no save";
    case "negates":
      return `${type} negates`;
    case "half":
      return `${type} half`;
    case "partial":
      return `${type} partial`;
    default:
      return `${type} disbelief`;
  }
}
