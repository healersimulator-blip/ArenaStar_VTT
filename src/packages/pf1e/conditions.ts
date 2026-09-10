/**
 * PF1e **condition library** (P4/E03) — the named SRD conditions encoded as
 * `flags.pf1e` effect payloads, so the existing derivation/stacking machinery
 * consumes them like any other effect ("its mechanics are in mods" — the P0
 * contract; the `condition` field stays display/immunity data).
 *
 * Every number below was transcribed from the canonical conditions text
 * (d20pfsrd Conditions page, fetched and read in full for this slice — the
 * same verification discipline as R02; the A.14 modifier table agrees). The
 * consequence of the library: applying "Fatigued" is exactly applying
 * `mods: [{ability.str, -6-untyped...}]` — nothing new runs at derivation
 * time, so expiry and suppression stay free (D-142).
 *
 * Deliberate classifications:
 *  - **Fear penalties are `morale`** (shaken/frightened/panicked/cowering) —
 *    the SRD's fear effects impose morale penalties, so two fear conditions to
 *    the same key take the worse rather than stack, which is the printed rule.
 *  - **Every other condition penalty is `untyped` carrying its own source
 *    string** — the print does not type them (fatigued's Str/Dex loss, prone's
 *    attack penalty, blinded's AC penalty), and inventing types would change
 *    stacking behavior the text does not state.
 *  - **Fear tags `mindAffecting`** (plus Confused); `conditionRefusalFor`
 *    refuses those against a target whose effects grant mind-affecting
 *    immunity, and against `immune.conditions` by name.
 *
 * What the contract cannot express is recorded in each definition's `notes` —
 * never silently dropped (e.g. prone's ranged/melee AC split, blinded's 50%
 * concealment, Dex-0 bookkeeping). Those notes are the handoff list for the
 * positioning (P-sections) and spell (C) phases.
 */
import { err, okVal, type Result } from "../../core/result";
import type { PF1eEffectPayload, PF1eMod } from "./effects";
import type { ResolvedEffects } from "./effects";
import type { PF1eEffectRequest } from "./effectOps";

/** Deny tokens reused across conditions (action ids + ledger kinds). */
const NO_ACTIONS = [
  "standard",
  "move",
  "swift",
  "full-round",
  "five-foot-step",
  "attack-melee",
  "attack-ranged",
  "cast-spell",
] as const;

const NO_MOVE_ACTIONS = ["move", "five-foot-step"] as const;

export interface PF1eConditionDef {
  /** The exact SRD condition name (also the payload's `condition` label). */
  name: string;
  /** Condensed canonical text — every encoded number is visible here. */
  summary: string;
  /** Mind-affecting causes (fear, confusion); refused by mind-affecting immunity. */
  mindAffecting: boolean;
  /** The fear subgroup (morale penalties; do not stack with each other). */
  fear: boolean;
  /** The mechanical payload: mods, flags, denies — validated by construction. */
  build: () => PF1eEffectPayload;
  /** Canonical consequences the current contract cannot express (caller-owned). */
  notes: readonly string[];
}

const mod = (
  key: PF1eMod["key"],
  value: number,
  source: string,
  type: PF1eMod["type"] = "untyped",
): PF1eMod => ({ key, type, value, source });

export const PF1E_CONDITIONS: readonly PF1eConditionDef[] = [
  {
    name: "Blinded",
    summary:
      "Cannot see: −2 AC, loses Dex bonus to AC, −4 Str/Dex-based skill checks and opposed Perception, vision-reliant checks auto-fail, DC 10 Acrobatics to move faster than half speed.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Blinded",
      mods: [mod("ac", -2, "blinded")],
      flags: { deniedDexToAc: true },
    }),
    notes: [
      "all opponents have total concealment (50% miss chance) against the blinded creature — P5 targeting/geometry",
      "−4 Str/Dex-based skill checks and opposed Perception — no skill-check mod keys in the contract",
      "DC 10 Acrobatics to move faster than half speed — movement legality is P03",
    ],
  },
  {
    name: "Confused",
    summary:
      "Mentally befuddled: rolls d% each round (act normally / babble / 1d8+Str to self / attack nearest); cannot tell ally from foe; no special attack or AC modifiers.",
    mindAffecting: true,
    fear: false,
    build: () => ({ condition: "Confused" }),
    notes: [
      "the behavioral table is nondeterministic — GM-owned; no numeric automation",
      "does not make AoOs against anything it is not already attacking — P06 interrupt queue",
    ],
  },
  {
    name: "Cowering",
    summary:
      "Frozen in fear: can take no actions, −2 AC, loses Dex bonus to AC.",
    mindAffecting: true,
    fear: true,
    build: () => ({
      condition: "Cowering",
      mods: [mod("ac", -2, "cowering")],
      flags: { deniedDexToAc: true },
      denies: [...NO_ACTIONS],
    }),
    notes: [],
  },
  {
    name: "Dazed",
    summary: "Unable to act normally: can take no actions, but no AC penalty.",
    mindAffecting: false,
    fear: false,
    build: () => ({ condition: "Dazed", denies: [...NO_ACTIONS] }),
    notes: [],
  },
  {
    name: "Dazzled",
    summary:
      "Unable to see well: −1 penalty on attack rolls and sight-based Perception checks.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Dazzled",
      mods: [mod("attack", -1, "dazzled")],
    }),
    notes: [
      "the −1 sight-based Perception penalty has no skill-check mod key — caller-owned",
    ],
  },
  {
    name: "Disabled",
    summary:
      "0 HP (or stable and conscious at negative HP): a single move OR standard action each round (never both, no full-round), swift/immediate/free still allowed, half speed, 1 damage after any strenuous standard action.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Disabled",
      denies: ["full-round"],
    }),
    notes: [
      "the move-XOR-standard limit is the action ledger's `single-standard-or-move` restriction — the health path (P7) sets it on the combatant",
      "half speed and the 1-damage-after-strenuous-standard bookkeeping are the P7 health path's",
    ],
  },
  {
    name: "Dying",
    summary:
      "Unconscious and near death (negative HP, not stabilized): can take no actions; DC 10 Con check each turn to stabilize, penalty equal to the negative HP total.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Dying",
      flags: { deniedDexToAc: true },
      denies: [...NO_ACTIONS],
    }),
    notes: [
      "the stabilization check and death-at−Con are the P7 health path's bookkeeping",
    ],
  },
  {
    name: "Entangled",
    summary:
      "Ensnared: half speed, cannot run or charge, −2 on all attack rolls, −4 Dex; casting requires Concentration DC 15 + spell level.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Entangled",
      mods: [
        mod("attack", -2, "entangled"),
        mod("ability.dex", -4, "entangled"),
      ],
      denies: ["run", "charge"],
    }),
    notes: [
      "half speed — no multiplicative speed mod key; caller-owned",
      "Concentration DC 15 + spell level — consumed by C03's casting flow",
    ],
  },
  {
    name: "Exhausted",
    summary:
      "Half speed, cannot run or charge, −6 penalty to Strength and Dexterity. After 1 hour of complete rest becomes fatigued.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Exhausted",
      mods: [
        mod("ability.str", -6, "exhausted"),
        mod("ability.dex", -6, "exhausted"),
      ],
      denies: ["run", "charge"],
    }),
    notes: ["half speed — caller-owned"],
  },
  {
    name: "Fatigued",
    summary:
      "Can neither run nor charge, −2 penalty to Strength and Dexterity. Anything that would cause fatigue makes an exhausted character; 8 hours of rest clears it.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Fatigued",
      mods: [
        mod("ability.str", -2, "fatigued"),
        mod("ability.dex", -2, "fatigued"),
      ],
      denies: ["run", "charge"],
    }),
    notes: [],
  },
  {
    name: "Flat-Footed",
    summary:
      "Has not yet acted: loses Dex bonus to AC and CMD, and cannot make attacks of opportunity (Combat Reflexes/Uncanny Dodge excepted — feat data, not the condition).",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Flat-Footed",
      flags: { flatFooted: true, cannotAoO: true },
    }),
    notes: [
      "immediate actions are impossible while flat-footed — P06 immediate-action gate",
    ],
  },
  {
    name: "Frightened",
    summary:
      "Must flee from the fear source if possible; may fight only if unable to flee. −2 on attack rolls, saving throws, skill checks and ability checks.",
    mindAffecting: true,
    fear: true,
    build: () => ({
      condition: "Frightened",
      mods: [
        mod("attack", -2, "frightened", "morale"),
        mod("saves", -2, "frightened", "morale"),
      ],
    }),
    notes: [
      "the forced-flee behavior (movement away from the source) is caller-owned — morale subsystem/L05",
    ],
  },
  {
    name: "Grappled",
    summary:
      "Restrained: cannot move, −4 Dex, −2 on attack rolls and combat maneuver checks (except grapple/escape), no two-handed actions, Concentration DC 10 + grappler's CMB + spell level, no attacks of opportunity.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Grappled",
      mods: [
        mod("attack", -2, "grappled"),
        mod("cmb", -2, "grappled"),
        mod("ability.dex", -4, "grappled"),
      ],
      flags: { cannotAoO: true },
      denies: [...NO_MOVE_ACTIONS],
    }),
    notes: [
      "the −2 attack/CMB exemptions when grappling or escaping are the caller's to apply (the maneuver target is context)",
      "no two-handed actions and the grapple concentration DC — C03/P05 consumers",
    ],
  },
  {
    name: "Helpless",
    summary:
      "Paralyzed, held, bound, sleeping or unconscious — completely at an opponent's mercy: treated as Dex 0 (−5); melee attacks get +4 (prone-equivalent), ranged get no bonus; coup de grace target.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Helpless",
      flags: { deniedDexToAc: true },
    }),
    notes: [
      "Dex 0 (−5 modifier) is stronger than denied-Dex: the −5 static is caller-owned until the AC contract expresses dex-zero",
      "the attacker's +4 melee (and coup de grace) are attack-side situational parts — P06 seam alongside flanking/charge",
    ],
  },
  {
    name: "Invisible",
    summary:
      "Visually undetectable: +2 bonus on attack rolls against sighted opponents, and ignores opponents' Dexterity bonuses to AC.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Invisible",
      mods: [mod("attack", 2, "invisible", "circumstance")],
    }),
    notes: [
      "the target's denied Dex (and the total-concealment miss chance) live on the defender side — the resolve flow's defense selection consumes them from the fight context, P05",
    ],
  },
  {
    name: "Nauseated",
    summary:
      "Stomach distress: unable to attack, cast, concentrate or do anything requiring attention — only a single move action per turn.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Nauseated",
      denies: [
        "standard",
        "swift",
        "full-round",
        "five-foot-step",
        "attack-melee",
        "attack-ranged",
        "cast-spell",
      ],
    }),
    notes: [],
  },
  {
    name: "Panicked",
    summary:
      "Drops everything held and flees at top speed along a random path; no other actions; −2 on saving throws, skill checks and ability checks (attack rolls are NOT penalized); if cornered, cowers.",
    mindAffecting: true,
    fear: true,
    build: () => ({
      condition: "Panicked",
      mods: [mod("saves", -2, "panicked", "morale")],
      denies: [
        "standard",
        "swift",
        "full-round",
        "five-foot-step",
        "attack-melee",
        "attack-ranged",
        "cast-spell",
      ],
    }),
    notes: [
      "the forced flee, dropped items and cornered-cowering are caller-owned behaviors",
    ],
  },
  {
    name: "Paralyzed",
    summary:
      "Frozen in place: effective Dex and Str 0, helpless, purely mental actions only.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Paralyzed",
      flags: { deniedDexToAc: true },
      denies: [...NO_ACTIONS],
    }),
    notes: [
      "effective Dex/Str 0 (helpless) — same dex-zero bookkeeping note as Helpless",
      "purely mental actions remain possible — the deny list covers physical action kinds only",
    ],
  },
  {
    name: "Petrified",
    summary:
      "Turned to stone: considered unconscious (and therefore helpless).",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Petrified",
      flags: { deniedDexToAc: true },
      denies: [...NO_ACTIONS],
    }),
    notes: [],
  },
  {
    name: "Pinned",
    summary:
      "Tightly bound: cannot move, denied Dex bonus, additional −4 AC; can always attempt to escape; verbal and mental actions only (no somatic/material spells); more severe than grappled and their effects do not stack.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Pinned",
      mods: [mod("ac", -4, "pinned")],
      flags: { deniedDexToAc: true, cannotAoO: true },
      denies: [...NO_MOVE_ACTIONS, "standard", "full-round", "swift"],
    }),
    notes: [
      "'does not stack with grappled' — apply Pinned alone (the apply path is per-payload; the GM drops Grappled)",
      "escape attempts (CMB or Escape Artist) stay allowed — P05's maneuver check",
      "no somatic/material spell components — C03's component flow",
    ],
  },
  {
    name: "Prone",
    summary:
      "Lying on the ground: −4 on melee attack rolls, cannot use ranged weapons (except crossbows); +4 AC against ranged attacks but −4 AC against melee; standing is a move action that provokes.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Prone",
      mods: [mod("attackMelee", -4, "prone")],
      denies: ["ranged-attack", "five-foot-step"],
    }),
    notes: [
      "the AC split (+4 vs ranged / −4 vs melee) has no per-range AC mod key — attacker-side situational part, P06 seam",
      "crossbows-only ranged exception and the provoking stand-up are P03/P06",
    ],
  },
  {
    name: "Shaken",
    summary:
      "−2 penalty on attack rolls, saving throws, skill checks and ability checks. Less severe than frightened or panicked.",
    mindAffecting: true,
    fear: true,
    build: () => ({
      condition: "Shaken",
      mods: [
        mod("attack", -2, "shaken", "morale"),
        mod("saves", -2, "shaken", "morale"),
      ],
    }),
    notes: ["skill/ability check penalties have no mod keys — caller-owned"],
  },
  {
    name: "Sickened",
    summary:
      "−2 penalty on attack rolls, weapon damage rolls, saving throws, skill checks and ability checks.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Sickened",
      mods: [
        mod("attack", -2, "sickened"),
        mod("damage", -2, "sickened"),
        mod("saves", -2, "sickened"),
      ],
    }),
    notes: ["skill/ability check penalties have no mod keys — caller-owned"],
  },
  {
    name: "Stable",
    summary:
      "Was dying, stopped losing HP, still negative and unconscious. May attempt a DC 10 Con check per hour (with aid) to become conscious and disabled.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Stable",
      flags: { deniedDexToAc: true },
      denies: [...NO_ACTIONS],
    }),
    notes: [
      "the per-hour wake-up check and HP bookkeeping are the P7 health path's",
    ],
  },
  {
    name: "Staggered",
    summary:
      "A single move OR standard action each round (never both, no full-round); free, swift and immediate actions still allowed. Nonlethal damage exactly equal to current HP causes it.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Staggered",
      denies: ["full-round"],
    }),
    notes: [
      "the move-XOR-standard limit is the ledger's `single-standard-or-move` restriction — set by the health path (P7)",
    ],
  },
  {
    name: "Stunned",
    summary:
      "Drops everything held, can't take actions, −2 AC, loses Dex bonus to AC; attackers get +4 on combat maneuver checks against the stunned creature.",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Stunned",
      mods: [mod("ac", -2, "stunned")],
      flags: { deniedDexToAc: true, cannotAoO: true },
      denies: [...NO_ACTIONS],
    }),
    notes: [
      "the +4 CMB against a stunned target is the attacker's situational part — P06",
    ],
  },
  {
    name: "Unconscious",
    summary:
      "Knocked out and helpless (negative HP within Con, or nonlethal damage in excess of current HP).",
    mindAffecting: false,
    fear: false,
    build: () => ({
      condition: "Unconscious",
      flags: { deniedDexToAc: true },
      denies: [...NO_ACTIONS],
    }),
    notes: ["same dex-zero note as Helpless"],
  },
];

/** Lookup by the exact SRD name (case-insensitive). */
export function pf1eConditionDef(name: string): PF1eConditionDef | null {
  const needle = name.trim().toLowerCase();
  return (
    PF1E_CONDITIONS.find((def) => def.name.toLowerCase() === needle) ?? null
  );
}

export const PF1E_CONDITION_NAMES: readonly string[] = PF1E_CONDITIONS.map(
  (d) => d.name,
);

/** The validated payload for one condition (the display label is the name). */
export function pf1eConditionPayload(name: string): Result<PF1eEffectPayload> {
  const def = pf1eConditionDef(name);
  if (!def) return err(`pf1e condition: unknown condition "${name}"`);
  return okVal(def.build());
}

/**
 * The apply request for one condition: effect name is the condition name,
 * lasting until removed (conditions are state, not timers — a source that
 * imposes one with a duration wraps this payload itself).
 */
export function pf1eConditionRequest(name: string): Result<PF1eEffectRequest> {
  const def = pf1eConditionDef(name);
  if (!def) return err(`pf1e condition: unknown condition "${name}"`);
  return okVal({
    name: def.name,
    payload: def.build(),
  });
}

/**
 * Immunity check (the E03 "mind-affecting immunity" hook): a named refusal when
 * the target's resolved effects protect it — mind-affecting immunity against
 * the fear/confusion family, or a matching `immune.conditions` entry. Non-null
 * strings are apply refusals, never silent no-ops.
 */
export function conditionRefusalFor(
  def: PF1eConditionDef,
  resolved: ResolvedEffects,
): string | null {
  if (
    def.mindAffecting &&
    (resolved.immuneMindAffecting ||
      resolved.immuneConditions.has("mind-affecting"))
  )
    return `${def.name} is mind-affecting, and this creature is immune to mind-affecting effects.`;
  const needle = def.name.toLowerCase();
  for (const name of resolved.immuneConditions) {
    if (name.toLowerCase() === needle)
      return `${def.name} is named by this creature's condition immunities.`;
  }
  return null;
}
