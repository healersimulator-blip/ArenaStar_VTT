/**
 * PF1e **tactical attack eligibility and arithmetic** (P3/A02) — the pure attack
 * layer A03 (damage/crits), A04 (range legality) and A06 (sheet buttons) build
 * on. It reads weapon descriptors (A01's `weapons.ts`) and base attacker facts;
 * it never touches a ModelPool (the strategic loops in `combatEngine.ts` stay
 * independent per D-113's "two implementations, shared numbers" decision).
 *
 * Every number in this file is verified:
 * - **Two-Weapon Fighting, Table 8-7** (CRB p.202, AoN Rules ID 198): normal
 *   −6/−10; off-hand weapon light −4/−8; feat −4/−4; feat + light −2/−2. Double
 *   weapons apply the penalties as if the off-hand end were light; an unarmed
 *   strike is always light; thrown-from-each-hand follows the same rules
 *   (dart/shuriken light, bolas/javelin/net/sling one-handed).
 * - **Natural attacks** (CRB p.182, AoN Rules ID 131 + Bestiary UMR "Natural
 *   Attacks"): primary at full BAB with full Str to damage; secondary at
 *   BAB − 5 with ½ Str; natural attacks never iterate with BAB; a creature
 *   with **only one** natural attack adds 1½ Str to damage with it (two claws
 *   do not qualify — and the increase never applies to "multiple attacks but
 *   takes only one"); a creature whose only attacks are all one type treats
 *   them as primary regardless of type; mixing manufactured/unarmed attacks
 *   with natural attacks makes **all** the natural attacks secondary, and each
 *   limb wielding a weapon forfeits its natural attack.
 * - **Unarmed** (CRB p.182, AoN Rules ID 131): attacking unarmed provokes from
 *   the armed target only; an unarmed strike is light, nonlethal (Medium 1d3);
 *   dealing lethal damage without Improved Unarmed Strike takes −4; a monk, an
 *   IUS character, a touch-spell caster and a creature with natural weapons
 *   count as armed.
 * - **Nonproficiency**: weapons −4 on attack rolls (CRB p.144, "the standard
 *   −4" per AoN's Firearm Rules); nonproficient armor and/or shield applies
 *   its armor check penalty to attack rolls too, and the armor and shield
 *   penalties stack (CRB p.153, AoN Rules ID 361).
 * - **Shooting or Throwing into a Melee** (CRB p.182, AoN Rules ID 131): −4;
 *   reduced to −2 when the target is two size categories larger than the
 *   friendly characters it is engaged with; no penalty at three or more.
 *   Precise Shot removes it; a target at least 10 ft from the nearest friendly
 *   character avoids it entirely (a geometry fact the caller supplies — the
 *   "engaged" definition is quoted in `shootingIntoMeleePenalty`).
 * - **The attack roll** (A.2): 1d20 + BAB + Str (melee)/Dex (ranged) + size +
 *   misc; natural 20 = automatic hit and a threat; natural 1 = automatic miss;
 *   a threat range below 20 does not make the roll an automatic hit, and a
 *   roll that does not hit is not a threat (CRB p.182 Critical Hits).
 * - Situational modifiers already verified in the Gap List: flanking +2
 *   (§2.2), charge +2 attack (§6.5), an invisible attacker strikes at +2
 *   (A.8), squeezing −4 (A.7).
 *
 * A03 (damage and critical arithmetic), verified before encoding:
 * - **Critical Hits** (CRB p.182, AoN Rules ID 131): the confirmation is
 *   "another attack roll with all the same modifiers as the attack roll you
 *   just made" — it must hit the target's AC (natural 20 always confirms,
 *   natural 1 never does, the attack-roll extremes apply; it does not need to
 *   be a 20 again). "A critical hit means that you roll your damage more than
 *   once, with all your usual bonuses, and add the rolls together." Exception:
 *   precision damage and additional damage dice from weapon special abilities
 *   (flaming) are **not** multiplied on a critical hit.
 * - **Multiplying Damage** (CRB p.179, AoN Rules ID 100): "Roll the damage
 *   (with all modifiers) multiple times and total the results" — Str,
 *   enhancement and other static modifiers are multiplied with the dice. "When
 *   you multiply damage more than once, each multiplier works off the original,
 *   unmultiplied damage" (×2 and ×2 ⇒ ×3; ×3 and ×3 ⇒ ×5 — the mounted-lance
 *   spirited-charge crit). Extra damage dice over and above a weapon's normal
 *   damage are never multiplied.
 * - **Strength Bonus** (CRB p.179, AoN Rules ID 100): melee and thrown weapons
 *   (including slings) add the full Strength modifier to damage; a Strength
 *   **penalty**, but not a bonus, applies with a non-composite bow. Off-hand
 *   weapons add **half** the Strength bonus ("If you have a Strength penalty,
 *   the entire penalty applies"). Two-handed wielding adds **1½ times the
 *   Strength bonus** ("Strength penalties are not multiplied"; no increase for
 *   a light weapon held in two hands). Secondary natural attacks add ½ Str;
 *   the sole natural attack adds 1½ (Bestiary UMR, carried by A02's
 *   `oneAndHalfStr` flag).
 * - **Minimum Damage** (CRB p.179, AoN Rules ID 100): "If penalties reduce the
 *   damage result to less than 1, a hit still deals 1 point of nonlethal
 *   damage."
 * - **Nonlethal swap** (CRB p.191, AoN Rules ID 172): a weapon that deals
 *   lethal damage can deal nonlethal instead, and a nonlethal weapon —
 *   including an unarmed strike — can deal lethal instead; **both** directions
 *   take a −4 penalty on the attack roll. Improved Unarmed Strike waives the
 *   penalty for unarmed strikes only (AoN ID 131), never for other nonlethal
 *   weapons.
 * - **Magic weapons** (CRB p.468, AoN Rules ID 377): enhancement bonuses apply
 *   to attack **and** damage rolls; special-ability bonuses modify neither
 *   except where noted.
 * - **Threat-range expansion** (Improved Critical / keen, CRB): the threat
 *   range is doubled; "this effect doesn't stack with any other effect that
 *   expands the threat range" — a single doubling flag, never two.
 * - **Critical-hit and precision immunities are separate defender properties**
 *   (Bestiary creature types via the rogue's Precision Damage & Critical Hits
 *   sidebar): elementals, oozes and incorporeal creatures are immune to both;
 *   swarms and aeons are immune to critical hits only. Crit immunity means
 *   "they do not take any additional damage from critical hits" — a confirmed
 *   crit deals normal (×1) damage.
 *
 * Deliberately **not** here: range increments/penalties and splash scatter
 * (A04), DR/ER/hardness mitigation (A05), feat/stance modifiers like Power
 * Attack and fighting defensively (A07 — the numbers are verified but belong
 * to the feat slice), and any dice rolling — callers pass rolled results,
 * keeping this file deterministic and trivially fixture-able.
 */

import {
  iterativeAttackBonuses,
  sizeEntry,
  type PF1eSize,
} from "./rulesTables";
import type { AcBreakdown } from "./rulesTables";
import {
  brokenWeaponAdjustments,
  type PF1eWeaponDescriptor,
  type PF1eWeaponProficiency,
} from "./weapons";

/** Feat ids this layer recognizes. A07 generalizes feat handling; these are the three A02's rules name. */
export const PF1E_FEAT_TWO_WEAPON_FIGHTING = "two-weapon-fighting";
export const PF1E_FEAT_PRECISE_SHOT = "precise-shot";
export const PF1E_FEAT_IMPROVED_UNARMED_STRIKE = "improved-unarmed-strike";

/** One labeled contribution to an attack roll — the chat breakdown line is built from these. */
export interface PF1eModifierPart {
  label: string;
  value: number;
}

/**
 * Table 8-7: Two-Weapon Fighting Penalties (CRB p.202). The penalties apply to
 * every primary-hand attack and to the one extra off-hand attack. "Light" is
 * the off-hand weapon's handedness; an unarmed strike is always light, and a
 * double weapon's off-hand end counts as light.
 */
export function twfPenalties(input: {
  feat?: boolean | undefined;
  offHandLight?: boolean | undefined;
}): { primaryHand: number; offHand: number } {
  const light = input.offHandLight === true;
  if (input.feat === true) {
    return light
      ? { primaryHand: -2, offHand: -2 }
      : { primaryHand: -4, offHand: -4 };
  }
  return light
    ? { primaryHand: -4, offHand: -8 }
    : { primaryHand: -6, offHand: -10 };
}

/**
 * Shooting or Throwing into a Melee (CRB p.182): −4 on the attack roll when the
 * target is engaged in melee with a friendly character. "Engaged" means the two
 * are enemies of each other and either threatens the other (an unconscious or
 * otherwise immobilized character is not engaged unless actually attacked), and
 * a target at least 10 feet from the nearest friendly character avoids the
 * penalty — both are geometry facts the caller resolves (A04/C01 own distance).
 * Here only the size-relationship exceptions apply: two size categories larger
 * than the friendly characters it is engaged with ⇒ −2; three or more ⇒ none.
 * Precise Shot removes the penalty entirely.
 */
export function shootingIntoMeleePenalty(input: {
  sizeCategoriesLarger?: number | undefined;
  preciseShot?: boolean | undefined;
}): number {
  if (input.preciseShot === true) return 0;
  const larger = input.sizeCategoriesLarger ?? 0;
  if (larger >= 3) return 0;
  if (larger === 2) return -2;
  return -4;
}

/**
 * The defense AC an attack resolves against (A.2, the formulas
 * `acFromBreakdown` already verifies — this covers the two-flavor combinations
 * the cached three-flavor set cannot express). Touch drops armor, shield and
 * natural armor (dodge applies); flat-footed drops Dex and dodge; both drop all
 * five, leaving 10 + size + misc.
 */
export function selectDefenseAc(
  b: AcBreakdown,
  selection: { touch?: boolean; flatFooted?: boolean },
): number {
  const base =
    10 +
    (b.size ?? 0) +
    (b.misc ?? 0) +
    (selection.touch !== true
      ? (b.armor ?? 0) + (b.shield ?? 0) + (b.natural ?? 0)
      : 0) +
    (selection.flatFooted !== true ? (b.dex ?? 0) + (b.dodge ?? 0) : 0);
  return base;
}

/** The hand a planned attack is made with. */
export type PF1eAttackHand = "primary" | "off-hand" | "natural";

/** What an attacker brings to one attack series. */
export interface PF1eAttackActor {
  bab: number;
  strMod: number;
  dexMod: number;
  size: PF1eSize;
  /** Stat-block override of the size attack/AC modifier (A.4's published-mod deviation). */
  sizeAttackMod?: number | undefined;
  /** Weapon groups the attacker is proficient with. Absent ⇒ treated as proficient. */
  proficientWith?: readonly PF1eWeaponProficiency[] | undefined;
  feats?: readonly string[] | undefined;
  /**
   * Armor check penalty applied to attack rolls because the attacker wears
   * nonproficient armor and/or shield (CRB p.153) — armor and shield stack.
   * Proficient-worn armor never applies ACP to attack rolls; compute the number
   * from the worn items (A01's `resolvePF1eArmor` + proficiency).
   */
  armorNonproficiencyAcp?: number | undefined;
}

/** Situational modifiers with Gap-List-verified values. */
export interface PF1eSituationalModifiers {
  /** Flanking: +2 on the attack roll (§2.2 — the erroneous AC penalty is gone). */
  flanking?: boolean | undefined;
  /** Charging: +2 on the attack roll, −2 AC (the AC half is the defender-facing concern of the caller). */
  charging?: boolean | undefined;
  /** The attacker is invisible: +2 on the attack roll (A.8), defender denied Dex. */
  attackerInvisible?: boolean | undefined;
  /** Squeezing: −4 on attack rolls and −4 AC (A.7). */
  squeezing?: boolean | undefined;
}

export interface PF1eAttackModifierInput {
  attacker: PF1eAttackActor;
  weapon: PF1eWeaponDescriptor;
  hand?: PF1eAttackHand | undefined;
  /** Melee use of a throwable weapon; defaults from the weapon class. */
  mode?: "melee" | "ranged" | undefined;
  /**
   * Intent to deal lethal damage with a nonlethal weapon (unarmed strike, sap):
   * −4 (CRB p.191). Improved Unarmed Strike waives it for unarmed strikes only.
   */
  lethalIntent?: boolean | undefined;
  /** Intent to deal nonlethal damage with a lethal weapon: −4 (CRB p.191). Mutually exclusive with `lethalIntent`. */
  nonlethalIntent?: boolean | undefined;
  /** Two-weapon style is active (an extra off-hand attack exists in the plan). */
  twoWeaponStyle?: boolean | undefined;
  /** The off-hand weapon is light (unarmed/double-weapon off end always are). */
  offHandLight?: boolean | undefined;
  /** All natural attacks are secondary this round (manufactured attacks present, CRB p.182). */
  naturalAsSecondary?: boolean | undefined;
  situational?: PF1eSituationalModifiers | undefined;
  shootingIntoMelee?:
    | {
        /** Target size categories larger than the friendly characters it is engaged with. */
        sizeCategoriesLarger?: number | undefined;
      }
    | undefined;
  /** Untyped caller-supplied modifier, labeled as given. */
  misc?: number | undefined;
}

export interface PF1eAttackModifierResult {
  parts: PF1eModifierPart[];
  total: number;
  notes: string[];
  /** The BAB part, so iteratives can be rebuilt without re-deriving the flat stack. */
  bab: number;
}

/**
 * Assemble one attack's modifier stack (A.2 + A02's verified penalties). Every
 * contribution is a labeled part; `total` is their sum. The BAB part is exposed
 * separately because iteratives (full attack) replace it with the ladder.
 */
export function attackModifierParts(
  input: PF1eAttackModifierInput,
): PF1eAttackModifierResult {
  const { attacker, weapon } = input;
  const notes: string[] = [];
  const feats = attacker.feats ?? [];
  const mode =
    input.mode ??
    (weapon.class === "melee" || weapon.natural ? "melee" : "ranged");
  const parts: PF1eModifierPart[] = [
    { label: "BAB", value: Math.trunc(attacker.bab) },
    {
      label: mode === "melee" ? "Str" : "Dex",
      value: mode === "melee" ? attacker.strMod : attacker.dexMod,
    },
    {
      label: "size",
      value: attacker.sizeAttackMod ?? sizeAttackAc(attacker.size),
    },
  ];
  if (weapon.enhancementBonus > 0) {
    parts.push({ label: "enhancement", value: weapon.enhancementBonus });
  }

  // Broken weapon (AoN Rules ID 413): −2 on attack rolls.
  const broken = brokenWeaponAdjustments(weapon);
  if (broken.attack !== 0) {
    parts.push({ label: "broken weapon", value: broken.attack });
  }

  // Weapon nonproficiency (CRB p.144): −4. Natural weapons and unarmed strikes
  // are exempt — a creature is proficient with its own attacks, and every
  // character can throw a punch without a proficiency group.
  if (
    !weapon.natural &&
    !weapon.unarmed &&
    attacker.proficientWith !== undefined &&
    !attacker.proficientWith.includes(weapon.proficiency)
  ) {
    parts.push({ label: "nonproficient", value: -4 });
    notes.push(
      `not proficient with ${weapon.proficiency} weapons: −4 on attack rolls`,
    );
  }

  // Nonproficient armor/shield ACP on attack rolls (CRB p.153); armor and shield stack.
  if (
    attacker.armorNonproficiencyAcp !== undefined &&
    attacker.armorNonproficiencyAcp > 0
  ) {
    parts.push({
      label: "armor nonproficiency (ACP)",
      value: -attacker.armorNonproficiencyAcp,
    });
  }

  // Two-weapon penalties (Table 8-7) — they apply only while the style is on.
  if (input.twoWeaponStyle === true) {
    const penalties = twfPenalties({
      feat: feats.includes(PF1E_FEAT_TWO_WEAPON_FIGHTING),
      offHandLight: input.offHandLight === true,
    });
    const own =
      input.hand === "off-hand" ? penalties.offHand : penalties.primaryHand;
    if (own !== 0) {
      parts.push({ label: "two-weapon fighting", value: own });
    }
  }

  // Secondary natural attacks (CRB p.182): BAB − 5 — authored secondary, or any
  // natural attack made alongside manufactured attacks. The follow-up sentence
  // ("feats such as Two-Weapon Fighting and Multiattack can reduce these
  // penalties") is deliberately not interpreted here — Multiattack is A07 and
  // no unverified feat interaction is encoded.
  const secondary =
    weapon.naturalSecondary === true ||
    (weapon.natural === true && input.naturalAsSecondary === true);
  if (secondary) {
    parts.push({ label: "secondary natural attack", value: -5 });
  }

  // Lethal damage with a nonlethal weapon (CRB p.191, AoN ID 172): −4 — the
  // rule covers every nonlethal weapon, "including an unarmed strike". IUS
  // waives it for unarmed strikes only (AoN ID 131), never for a sap/whip.
  if (
    weapon.nonlethal === true &&
    input.lethalIntent === true &&
    !(
      weapon.unarmed === true &&
      feats.includes(PF1E_FEAT_IMPROVED_UNARMED_STRIKE)
    )
  ) {
    parts.push({ label: "lethal damage with a nonlethal weapon", value: -4 });
  }

  // Nonlethal damage with a lethal weapon (CRB p.191): −4. No feat waives it.
  if (weapon.nonlethal !== true && input.nonlethalIntent === true) {
    parts.push({ label: "nonlethal damage with a lethal weapon", value: -4 });
  }

  const sit = input.situational;
  if (sit?.flanking === true) parts.push({ label: "flanking", value: 2 });
  if (sit?.charging === true) parts.push({ label: "charge", value: 2 });
  if (sit?.attackerInvisible === true)
    parts.push({ label: "invisible attacker", value: 2 });
  if (sit?.squeezing === true) parts.push({ label: "squeezing", value: -4 });

  if (input.shootingIntoMelee !== undefined && mode === "ranged") {
    const penalty = shootingIntoMeleePenalty({
      ...(input.shootingIntoMelee.sizeCategoriesLarger !== undefined
        ? { sizeCategoriesLarger: input.shootingIntoMelee.sizeCategoriesLarger }
        : {}),
      preciseShot: feats.includes(PF1E_FEAT_PRECISE_SHOT),
    });
    if (penalty !== 0) {
      parts.push({ label: "shooting into melee", value: penalty });
    }
  }

  if (input.misc !== undefined && input.misc !== 0) {
    parts.push({ label: "misc", value: input.misc });
  }

  return {
    parts,
    total: parts.reduce((sum, p) => sum + p.value, 0),
    notes,
    bab: Math.trunc(attacker.bab),
  };
}

function sizeAttackAc(size: PF1eSize): number {
  // A.4's shared ladder (Fine +8 … Colossal −8 on attack and AC alike) — read
  // from `rulesTables`, never duplicated here.
  return sizeEntry(size).attackAc;
}

/** One attack series in a full-attack plan. */
export interface PF1ePlannedAttack {
  name: string;
  hand: PF1eAttackHand;
  weapon: PF1eWeaponDescriptor;
  /** Final attack bonus per roll (iteratives included; a natural attack has exactly one). */
  attackBonuses: number[];
  /** The modifier stack of the first roll (later iteratives shift only via the BAB ladder). */
  parts: PF1eModifierPart[];
  notes: string[];
  /** Unarmed attacks provoke from the armed target (CRB p.182) unless the attacker counts as armed. */
  provokes: boolean;
  /** The attacker has exactly one natural attack overall: 1½ Str to damage with it (A03 consumes). */
  oneAndHalfStr: boolean;
}

export interface PF1eFullAttackInput {
  attacker: PF1eAttackActor;
  /** Primary-hand (or only) weapon. */
  weapon: PF1eWeaponDescriptor;
  /** Off-hand weapon — its presence turns the two-weapon style on (Table 8-7). */
  offHandWeapon?: PF1eWeaponDescriptor | undefined;
  /** Natural weapons available on limbs not wielding the manufactured ones. */
  naturalWeapons?: readonly PF1eWeaponDescriptor[] | undefined;
  lethalIntent?: boolean | undefined;
  nonlethalIntent?: boolean | undefined;
  situational?: PF1eSituationalModifiers | undefined;
  shootingIntoMelee?: { sizeCategoriesLarger?: number | undefined } | undefined;
  misc?: number | undefined;
}

/**
 * Lay out a full attack (CRB p.182 "Multiple Attacks" + Table 8-7 + the natural
 * attack rules): manufactured iteratives from the BAB ladder, one extra
 * off-hand attack when a second weapon is wielded (or a double weapon's second
 * head), and the natural attacks — which never iterate, become secondary when
 * any manufactured attack is made, and are all primary when they are the only
 * attacks and all one type. The limb-sharing rule (a weapon clutched in a limb
 * forfeits that limb's natural attack) is the caller's authoring concern: pass
 * only the natural weapons whose limbs are actually free.
 */
export function fullAttackPlan(input: PF1eFullAttackInput): {
  attacks: PF1ePlannedAttack[];
  notes: string[];
} {
  const { attacker } = input;
  const notes: string[] = [];
  const feats = attacker.feats ?? [];
  const weapon = input.weapon;
  const doubleOff =
    weapon.doubleHead !== null && input.offHandWeapon === undefined;
  const twoWeaponStyle = input.offHandWeapon !== undefined || doubleOff;
  const offHandLight =
    input.offHandWeapon !== undefined
      ? input.offHandWeapon.handedness === "light" ||
        input.offHandWeapon.unarmed === true
      : doubleOff; // the off-hand end of a double weapon counts as light (CRB p.202)
  // A natural primary weapon means the routine has no manufactured attacks, which
  // is what makes the UMR "only one type of attack" rule (all primary) apply and
  // keeps natural attacks primary instead of secondary.
  const manufacturedPresent = weapon.natural !== true;
  const naturals = input.naturalWeapons ?? [];
  const naturalAsSecondary = naturals.length > 0 && manufacturedPresent;

  const attacks: PF1ePlannedAttack[] = [];

  // Primary hand: iteratives for manufactured weapons; naturals never iterate.
  const primaryParts = attackModifierParts({
    attacker,
    weapon,
    hand: "primary",
    lethalIntent: input.lethalIntent,
    nonlethalIntent: input.nonlethalIntent,
    twoWeaponStyle,
    offHandLight,
    naturalAsSecondary,
    situational: input.situational,
    shootingIntoMelee: input.shootingIntoMelee,
    misc: input.misc,
  });
  const primaryFlat = primaryParts.total - primaryParts.bab;
  const ladder = weapon.natural
    ? [primaryParts.bab]
    : iterativeAttackBonuses(primaryParts.bab);
  // "Only one natural attack" (two claws do not qualify) ⇒ 1½ Str to damage with
  // it, and the increase never applies to one of several attacks (Bestiary UMR).
  const soleNaturalAttack = weapon.natural === true && naturals.length === 0;
  attacks.push({
    name: weapon.name,
    hand: "primary",
    weapon,
    attackBonuses: ladder.map((b) => b + primaryFlat),
    parts: primaryParts.parts,
    notes: primaryParts.notes,
    provokes: false,
    oneAndHalfStr: soleNaturalAttack,
  });

  // Off hand (Table 8-7): one extra attack — no iterative ladder.
  if (input.offHandWeapon !== undefined) {
    const offParts = attackModifierParts({
      attacker,
      weapon: input.offHandWeapon,
      hand: "off-hand",
      lethalIntent: input.lethalIntent,
      nonlethalIntent: input.nonlethalIntent,
      twoWeaponStyle,
      offHandLight,
      naturalAsSecondary,
      situational: input.situational,
      shootingIntoMelee: input.shootingIntoMelee,
      misc: input.misc,
    });
    attacks.push({
      name: input.offHandWeapon.name,
      hand: "off-hand",
      weapon: input.offHandWeapon,
      attackBonuses: [offParts.total],
      parts: offParts.parts,
      notes: offParts.notes,
      provokes:
        input.offHandWeapon.unarmed === true &&
        !feats.includes(PF1E_FEAT_IMPROVED_UNARMED_STRIKE) &&
        naturals.length === 0,
      oneAndHalfStr: false,
    });
  } else if (doubleOff) {
    // A double weapon's off-hand head attacks with the same weapon descriptor;
    // its damage line is the doubleHead (A03 consumes that).
    const offParts = attackModifierParts({
      attacker,
      weapon,
      hand: "off-hand",
      lethalIntent: input.lethalIntent,
      nonlethalIntent: input.nonlethalIntent,
      twoWeaponStyle,
      offHandLight,
      naturalAsSecondary,
      situational: input.situational,
      shootingIntoMelee: input.shootingIntoMelee,
      misc: input.misc,
    });
    attacks.push({
      name: `${weapon.name} (off-hand head)`,
      hand: "off-hand",
      weapon,
      attackBonuses: [offParts.total],
      parts: offParts.parts,
      notes: offParts.notes,
      provokes: false,
      oneAndHalfStr: false,
    });
  }

  // Natural attacks: one roll each, primary or secondary. Mixed with a
  // manufactured routine they are ALL secondary (CRB p.182); as the only
  // attacks, all of one type, they are ALL primary regardless of type (UMR).
  const naturalOnly = !manufacturedPresent && naturals.length > 0;
  const singleType =
    naturalOnly &&
    new Set([weapon, ...naturals].map((w) => w.name.trim().toLowerCase()))
      .size === 1;
  if (singleType) {
    notes.push(
      "all natural attacks are one type and the only attacks — treated as primary (Bestiary UMR)",
    );
  }
  for (const natural of naturals) {
    const asSecondary = singleType
      ? false
      : natural.naturalSecondary === true || naturalAsSecondary;
    const parts = attackModifierParts({
      attacker,
      // singleType overrides the authored secondary classification too (UMR:
      // "treated as a primary attack, regardless of its type")
      weapon: singleType ? { ...natural, naturalSecondary: false } : natural,
      hand: "natural",
      lethalIntent: input.lethalIntent,
      nonlethalIntent: input.nonlethalIntent,
      naturalAsSecondary: asSecondary,
      situational: input.situational,
      misc: input.misc,
    });
    attacks.push({
      name: natural.name,
      hand: "natural",
      weapon: natural,
      attackBonuses: [parts.total],
      parts: parts.parts,
      notes: parts.notes,
      provokes: false,
      oneAndHalfStr: false,
    });
  }
  // The primary natural weapon's own secondary status follows the same rules:
  // a sole natural attack is ALWAYS made at full BAB (UMR "only one natural
  // attack"), and a single-type natural-only routine is primary regardless of
  // type — both override an authored `naturalSecondary`.
  if (weapon.natural === true && (soleNaturalAttack || singleType)) {
    const rebuilt = attackModifierParts({
      attacker,
      weapon: { ...weapon, naturalSecondary: false },
      hand: "primary",
      lethalIntent: input.lethalIntent,
      nonlethalIntent: input.nonlethalIntent,
      naturalAsSecondary: false,
      situational: input.situational,
      misc: input.misc,
    });
    const rebuiltFlat = rebuilt.total - rebuilt.bab;
    const primary = attacks[0];
    if (primary) {
      primary.attackBonuses = [rebuilt.bab + rebuiltFlat];
      primary.parts = rebuilt.parts;
      primary.notes = rebuilt.notes;
    }
  }

  // Unarmed primary weapon: provokes from the armed target unless the attacker
  // counts as armed (IUS or natural weapons — monks and touch casters are
  // authored through feats/class data the caller maps).
  if (weapon.unarmed === true) {
    const armed =
      feats.includes(PF1E_FEAT_IMPROVED_UNARMED_STRIKE) || naturals.length > 0;
    const primary = attacks[0];
    if (primary) primary.provokes = !armed;
    if (!armed) {
      notes.push(
        "unarmed attack provokes an attack of opportunity from the armed target (CRB p.182)",
      );
    }
  }

  return { attacks, notes };
}

/** The result of resolving one attack roll against one AC. */
export type PF1eAttackRollResult =
  | {
      ok: true;
      /** The d20 did not land on 1 or 20. */
      natural: 1 | 20 | null;
      hits: boolean;
      /** A hit that is also a critical threat (confirmation is A03). */
      threat: boolean;
      /** die + bonus − ac; negative on a miss. */
      margin: number;
    }
  | { ok: false; error: string };

/**
 * Resolve one attack roll (A.2 + CRB p.182 Critical Hits): natural 20 = hit and
 * a threat; natural 1 = automatic miss; otherwise hit when die + bonus ≥ AC. A
 * threat range below 20 does not make a roll an automatic hit, and a roll that
 * does not hit is never a threat. The die is supplied — this file never rolls.
 */
export function resolveAttackRoll(input: {
  die: number;
  bonus: number;
  ac: number;
  /** Lowest threatening face; 20 = 20 only (A01 carries it, broken weapons force 20). */
  critThreatMin?: number | undefined;
}): PF1eAttackRollResult {
  const die = input.die;
  if (!Number.isInteger(die) || die < 1 || die > 20) {
    return { ok: false, error: `die = ${String(die)} is not an integer 1–20` };
  }
  const threatMin = input.critThreatMin ?? 20;
  if (die === 1) {
    return {
      ok: true,
      natural: 1,
      hits: false,
      threat: false,
      margin: 1 + input.bonus - input.ac,
    };
  }
  if (die === 20) {
    return {
      ok: true,
      natural: 20,
      hits: true,
      threat: true,
      margin: 20 + input.bonus - input.ac,
    };
  }
  const hits = die + input.bonus >= input.ac;
  return {
    ok: true,
    natural: null,
    hits,
    threat: hits && die >= threatMin,
    margin: die + input.bonus - input.ac,
  };
}

/**
 * Attack eligibility (the weapon-side half; distance is A04): a ranged weapon
 * with no range increment cannot attack at range; nonproficiency penalizes but
 * never forbids; an unarmed attacker without IUS/natural weapons provokes.
 */
export function attackEligibility(input: {
  weapon: PF1eWeaponDescriptor;
  mode?: "melee" | "ranged" | undefined;
  feats?: readonly string[] | undefined;
  naturalWeaponsCount?: number | undefined;
}): { canAttack: boolean; refusals: string[]; notes: string[] } {
  const refusals: string[] = [];
  const notes: string[] = [];
  const mode =
    input.mode ?? (input.weapon.class === "melee" ? "melee" : "ranged");
  if (mode === "ranged") {
    if (input.weapon.maxRangeIncrements === 0) {
      refusals.push(
        `${input.weapon.name} has no ranged use (no range increment or class)`,
      );
    } else if (input.weapon.rangeIncrementFt === null) {
      refusals.push(`${input.weapon.name} has no authored range increment`);
    }
  } else if (
    input.weapon.class === "projectile" ||
    input.weapon.class === "firearm"
  ) {
    notes.push(
      `${input.weapon.name} is not a melee weapon — melee use would be improvised (no improvised-weapon rule is encoded)`,
    );
  }
  if (input.weapon.unarmed === true) {
    const armed =
      input.feats?.includes(PF1E_FEAT_IMPROVED_UNARMED_STRIKE) === true ||
      (input.naturalWeaponsCount ?? 0) > 0;
    if (!armed) {
      notes.push(
        "unarmed attack provokes an attack of opportunity from the armed target",
      );
    }
  }
  return { canAttack: refusals.length === 0, refusals, notes };
}

// ======================================================================================
// A03 — threat range, critical confirmation, and damage arithmetic (CRB pp.179/182/191).
// Pure and diceless like the attack half: the caller supplies rolled values, this file
// only encodes the rules. No DR/ER (A05), no range legality (A04), no feats (A07).
// ======================================================================================

/** One extra damage line over and above the weapon's damage — flaming, sneak attack. */
export interface PF1eBonusDamageLine {
  label: string;
  /** The rolled sum of the line's dice (the caller rolls — this file never does). */
  roll: number;
  /**
   * Precision damage (a rogue's sneak attack and friends): never multiplied on a
   * critical hit, dropped against precision immunity, never reduced by DR (A05
   * consumes this flag).
   */
  precision?: boolean;
  /** The line is nonlethal regardless of the weapon's damage bucket. */
  nonlethal?: boolean;
}

/**
 * What the defender is immune to. The two flags are **separate** properties in
 * PF1e (Bestiary creature types via the rogue's Precision Damage & Critical Hits
 * sidebar): elementals, oozes and incorporeal creatures are immune to both;
 * swarms and aeons are immune to critical hits only.
 */
export interface PF1eDamageDefender {
  /** "Not subject to critical hits": a confirmed critical deals normal (×1) damage. */
  immuneToCriticalHits?: boolean | undefined;
  /** "Does not take additional damage from precision-based attacks": precision lines are dropped. */
  immuneToPrecisionDamage?: boolean | undefined;
}

/**
 * The lowest d20 face that threatens, after condition and expansion effects.
 * A broken weapon threatens on a natural 20 **only** (AoN Rules ID 413) — no
 * expansion re-widens it. Otherwise a single doubling applies (Improved Critical
 * / keen / keen edge — "this effect doesn't stack with any other effect that
 * expands the threat range"): the range 21−min faces re-anchors at 2×min−21,
 * so 20 → 19–20, 19–20 → 17–20, 18–20 → 15–20.
 */
export function effectiveCritThreatMin(
  weapon: Pick<PF1eWeaponDescriptor, "critThreatMin" | "broken">,
  options?: { threatRangeExpanded?: boolean | undefined },
): number {
  if (weapon.broken === true) return 20;
  const base = weapon.critThreatMin;
  if (options?.threatRangeExpanded !== true) return base;
  return Math.max(1, 2 * base - 21);
}

export type PF1eConfirmationResult =
  | {
      ok: true;
      confirmed: boolean;
      /** 1 = automatic miss (never confirms), 20 = automatic hit (always confirms). */
      natural: 1 | 20 | null;
      /** die + bonus − ac; negative when the confirmation misses. */
      margin: number;
    }
  | { ok: false; error: string };

/**
 * Resolve one critical-hit confirmation (CRB p.182, AoN Rules ID 131): "another
 * attack roll with all the same modifiers as the attack roll you just made. If
 * the confirmation roll also results in a hit against the target's AC, your
 * original hit is a critical hit." It does not need to be a 20 again — but it
 * is an attack roll, so a natural 20 always confirms and a natural 1 never
 * does. A defender immune to critical hits makes the attempt moot; that flag
 * lives on the damage side (`combinedDamageMultiplier`), not here.
 */
export function confirmCritical(input: {
  die: number;
  /** The full attack bonus of the attack roll that threatened. */
  attackBonus: number;
  ac: number;
}): PF1eConfirmationResult {
  const die = input.die;
  if (!Number.isInteger(die) || die < 1 || die > 20) {
    return {
      ok: false,
      error: `confirmation die = ${String(die)} is not an integer 1–20`,
    };
  }
  if (die === 20) {
    return {
      ok: true,
      confirmed: true,
      natural: 20,
      margin: 20 + input.attackBonus - input.ac,
    };
  }
  if (die === 1) {
    return {
      ok: true,
      confirmed: false,
      natural: 1,
      margin: 1 + input.attackBonus - input.ac,
    };
  }
  return {
    ok: true,
    confirmed: die + input.attackBonus >= input.ac,
    natural: null,
    margin: die + input.attackBonus - input.ac,
  };
}

export type PF1eMultiplierResult =
  { ok: true; multiplier: number } | { ok: false; error: string };

/**
 * The damage multiplier (CRB p.179 "Multiplying Damage"): "When you multiply
 * damage more than once, each multiplier works off the original, unmultiplied
 * damage" — multipliers are **added**, each contributing one less than its
 * value (×2 and ×2 ⇒ ×3; ×3 and ×2 ⇒ ×4; a ×3 lance under a ×3 spirited charge
 * with a ×3 crit ⇒ ×5). A confirmed critical contributes the weapon's
 * multiplier (a broken weapon's ×2, AoN ID 413); `extraMultipliers` carry
 * verified outside multipliers such as the mounted-lance charge (P06/P08 wire
 * them). A defender immune to critical hits contributes no crit multiplier —
 * the extras (a charge is not a critical) still apply.
 */
export function combinedDamageMultiplier(input: {
  weapon: Pick<
    PF1eWeaponDescriptor,
    "critMultiplier" | "critThreatMin" | "broken"
  >;
  confirmedCrit?: boolean | undefined;
  extraMultipliers?: readonly number[] | undefined;
  defender?: { immuneToCriticalHits?: boolean | undefined } | undefined;
}): PF1eMultiplierResult {
  const active: number[] = [];
  if (
    input.confirmedCrit === true &&
    input.defender?.immuneToCriticalHits !== true
  ) {
    active.push(brokenWeaponAdjustments(input.weapon).critMultiplier);
  }
  for (const m of input.extraMultipliers ?? []) {
    if (!Number.isInteger(m) || m < 2) {
      return {
        ok: false,
        error: `extra damage multiplier ${String(m)} is not an integer ≥ 2`,
      };
    }
    active.push(m);
  }
  if (active.length === 0) return { ok: true, multiplier: 1 };
  return {
    ok: true,
    multiplier: 1 + active.reduce((sum, m) => sum + (m - 1), 0),
  };
}

/** How Strength reaches ranged damage (CRB p.179, AoN Rules ID 100). */
export type PF1eRangedStrRule = "full" | "penalty-only" | "none";

/**
 * The default ranged Str rule: thrown weapons add the full modifier, and so does
 * a melee weapon with a range increment — its only ranged use is being thrown
 * (dagger, spear, hand axe). Everything else (bows, crossbows, firearms) adds
 * nothing by default. The verified exceptions are caller-authored through
 * `rangedStrRule`: a **sling** adds the full modifier ("a melee or thrown
 * weapon, **including a sling**"), a **non-composite bow** applies a penalty
 * only, and a composite bow applies its authored Str rating as flat damage
 * (never guessed here).
 */
function defaultRangedStrRule(
  weapon: Pick<PF1eWeaponDescriptor, "class" | "rangeIncrementFt">,
): PF1eRangedStrRule {
  if (weapon.class === "thrown") return "full";
  if (weapon.class === "melee" && weapon.rangeIncrementFt !== null)
    return "full";
  return "none";
}

export interface PF1eDamageModifierInput {
  attacker: PF1eAttackActor;
  weapon: PF1eWeaponDescriptor;
  hand?: PF1eAttackHand | undefined;
  mode?: "melee" | "ranged" | undefined;
  /** The sole natural attack adds 1½ Str (Bestiary UMR) — `fullAttackPlan` carries the flag. */
  oneAndHalfStr?: boolean | undefined;
  /** All natural attacks are secondary this round (manufactured attacks present, CRB p.182): ½ Str. */
  naturalAsSecondary?: boolean | undefined;
  /**
   * The weapon is being wielded in both hands (a one-handed weapon may be).
   * Defaults to true for two-handed weapons; light weapons and unarmed strikes
   * never gain the 1½ Str increase however they are held (CRB p.179).
   */
  wieldingTwoHanded?: boolean | undefined;
  /** Overrides the default ranged Str rule — see `defaultRangedStrRule` for the verified exceptions. */
  rangedStrRule?: PF1eRangedStrRule | undefined;
  /**
   * Static damage from the caller (favored enemy, an authored attack-line bonus,
   * Power Attack once A07 lands). Multiplied on a critical hit like every
   * static modifier ("roll the damage with all modifiers multiple times").
   */
  misc?: number | undefined;
}

/**
 * The labeled static damage stack applied once per damage roll (CRB p.179 +
 * p.468): Strength by hand/handedness/natural status, the weapon's enhancement
 * bonus (magic weapons add to damage; special-ability equivalents never do),
 * the broken weapon's −2, and caller misc. Strength **bonuses** are multiplied
 * by the hand rules and rounded down; Strength **penalties** are never
 * multiplied — the entire penalty applies off-hand, and two-handed wielding
 * does not deepen it.
 */
export function damageModifierParts(input: PF1eDamageModifierInput): {
  parts: PF1eModifierPart[];
  total: number;
  notes: string[];
} {
  const { attacker, weapon } = input;
  const notes: string[] = [];
  const mode =
    input.mode ??
    (weapon.class === "melee" || weapon.natural ? "melee" : "ranged");
  const hand = input.hand ?? (weapon.natural === true ? "natural" : "primary");
  const parts: PF1eModifierPart[] = [];

  if (mode === "ranged") {
    const rule = input.rangedStrRule ?? defaultRangedStrRule(weapon);
    if (rule === "full") {
      if (attacker.strMod !== 0) {
        parts.push({ label: "Str", value: attacker.strMod });
      }
    } else if (rule === "penalty-only") {
      if (attacker.strMod < 0) {
        parts.push({ label: "Str (penalty)", value: attacker.strMod });
        notes.push(
          "non-composite bow: the Strength penalty, but not a bonus, applies to damage",
        );
      }
    }
  } else {
    // Secondary natural attacks take ½ Str (CRB p.182); the sole natural attack
    // takes 1½ (UMR) and overrides the secondary classification.
    const secondaryNatural =
      weapon.natural === true &&
      input.oneAndHalfStr !== true &&
      (weapon.naturalSecondary === true || input.naturalAsSecondary === true);
    let mult = 1;
    if (input.oneAndHalfStr === true) {
      mult = 1.5;
    } else if (hand === "off-hand" || secondaryNatural) {
      mult = 0.5;
    } else {
      const twoHandedWield =
        weapon.handedness === "two-handed" || input.wieldingTwoHanded === true;
      const light = weapon.handedness === "light" || weapon.unarmed === true;
      if (twoHandedWield && !light) mult = 1.5;
    }
    // Bonuses round down after the multiplier; penalties are applied as-is
    // ("the entire penalty applies" off-hand; "not multiplied" two-handed).
    const strDamage =
      attacker.strMod >= 0
        ? Math.floor(attacker.strMod * mult)
        : attacker.strMod;
    parts.push({
      label: mult === 1.5 ? "Str (×1½)" : mult === 0.5 ? "Str (×½)" : "Str",
      value: strDamage,
    });
  }

  if (weapon.enhancementBonus > 0) {
    parts.push({ label: "enhancement", value: weapon.enhancementBonus });
  }

  const broken = brokenWeaponAdjustments(weapon);
  if (broken.damage !== 0) {
    parts.push({ label: "broken weapon", value: broken.damage });
  }

  if (input.misc !== undefined && input.misc !== 0) {
    parts.push({ label: "misc", value: input.misc });
  }

  return {
    parts,
    total: parts.reduce((sum, p) => sum + p.value, 0),
    notes,
  };
}

export type PF1eDamageRollResult =
  | {
      ok: true;
      /** The effective additive multiplier that was applied to the weapon damage. */
      multiplier: number;
      /** Weapon damage (dice + static, multiplied) before bonus lines and the minimum rule. */
      weaponDamage: number;
      /** Final lethal damage (0 when the minimum rule or nonlethal intent redirects it). */
      lethal: number;
      /** Final nonlethal damage (the weapon's full nonlethal damage, or the 1-point minimum). */
      nonlethal: number;
      /** Retained bonus-line contributions, labeled — the chat breakdown for extra damage. */
      bonusContributions: {
        label: string;
        amount: number;
        nonlethal: boolean;
      }[];
      /** Precision lines dropped by defender immunity. */
      precisionDropped: string[];
      notes: string[];
    }
  | { ok: false; error: string };

/**
 * Resolve one hit's damage (CRB pp.179/182/191). The caller supplies one
 * weapon-dice roll **per multiplier step** (`combinedDamageMultiplier` says how
 * many) plus the static stack (`damageModifierParts`, or a stat-block line's
 * derived bonus) — "roll the damage (with all modifiers) multiple times and
 * total the results": every static modifier is multiplied with the dice, while
 * precision damage and extra damage dice (flaming) are added exactly once.
 * Weapon damage lands in the nonlethal bucket when the weapon is nonlethal
 * (unarmed, saps), unless an intent flips it — both swaps cost −4 on the
 * **attack** roll, which `attackModifierParts` applies. If penalties reduce the
 * total damage result below 1, the hit still deals 1 point of nonlethal damage.
 */
export function resolveDamageRoll(input: {
  weapon: PF1eWeaponDescriptor;
  /** Static weapon damage applied once per roll — a `damageModifierParts` total or a stat-block line's derived damage bonus. */
  staticDamage: number;
  /** One rolled weapon-dice sum per multiplier step; the length must match the multiplier. */
  weaponDamageRolls: readonly number[];
  confirmedCrit?: boolean | undefined;
  extraMultipliers?: readonly number[] | undefined;
  defender?: PF1eDamageDefender | undefined;
  bonusLines?: readonly PF1eBonusDamageLine[] | undefined;
  lethalIntent?: boolean | undefined;
  nonlethalIntent?: boolean | undefined;
}): PF1eDamageRollResult {
  if (input.lethalIntent === true && input.nonlethalIntent === true) {
    return {
      ok: false,
      error: "lethalIntent and nonlethalIntent are mutually exclusive",
    };
  }
  if (!Number.isFinite(input.staticDamage)) {
    return {
      ok: false,
      error: `staticDamage = ${String(input.staticDamage)} is not a finite number`,
    };
  }
  const multiplierResult = combinedDamageMultiplier({
    weapon: input.weapon,
    confirmedCrit: input.confirmedCrit,
    extraMultipliers: input.extraMultipliers,
    defender: input.defender,
  });
  if (!multiplierResult.ok) return multiplierResult;
  const multiplier = multiplierResult.multiplier;

  const rolls = input.weaponDamageRolls;
  if (rolls.length !== multiplier) {
    return {
      ok: false,
      error: `weaponDamageRolls has ${rolls.length} entr${rolls.length === 1 ? "y" : "ies"} but the effective multiplier is ×${multiplier}`,
    };
  }
  for (const roll of rolls) {
    if (!Number.isInteger(roll) || roll < 0) {
      return {
        ok: false,
        error: `weapon damage roll ${String(roll)} is not a non-negative integer`,
      };
    }
  }
  for (const line of input.bonusLines ?? []) {
    if (!Number.isInteger(line.roll) || line.roll < 0) {
      return {
        ok: false,
        error: `bonus damage line "${line.label}" roll ${String(line.roll)} is not a non-negative integer`,
      };
    }
  }

  const notes: string[] = [];
  if (input.confirmedCrit === true && multiplier === 1) {
    notes.push(
      "defender immune to critical hits — the confirmed critical deals normal damage",
    );
  }

  // Each multiplier step adds one dice roll plus the full static stack.
  const weaponDamage =
    rolls.reduce((sum, roll) => sum + roll, 0) +
    multiplier * input.staticDamage;

  const weaponNonlethal =
    input.nonlethalIntent === true
      ? true
      : input.lethalIntent === true
        ? false
        : input.weapon.nonlethal === true;
  let lethal = weaponNonlethal ? 0 : weaponDamage;
  let nonlethal = weaponNonlethal ? weaponDamage : 0;

  const bonusContributions: {
    label: string;
    amount: number;
    nonlethal: boolean;
  }[] = [];
  const precisionDropped: string[] = [];
  for (const line of input.bonusLines ?? []) {
    if (
      line.precision === true &&
      input.defender?.immuneToPrecisionDamage === true
    ) {
      precisionDropped.push(line.label);
      continue;
    }
    const nonlethalLine = line.nonlethal === true;
    bonusContributions.push({
      label: line.label,
      amount: line.roll,
      nonlethal: nonlethalLine,
    });
    if (nonlethalLine) nonlethal += line.roll;
    else lethal += line.roll;
  }
  if (precisionDropped.length > 0) {
    notes.push(
      `precision damage dropped — the defender does not take additional damage from precision-based attacks: ${precisionDropped.join(", ")}`,
    );
  }

  // Minimum Damage (CRB p.179): "If penalties reduce the damage result to less
  // than 1, a hit still deals 1 point of nonlethal damage."
  if (lethal + nonlethal < 1) {
    return {
      ok: true,
      multiplier,
      weaponDamage,
      lethal: 0,
      nonlethal: 1,
      bonusContributions,
      precisionDropped,
      notes: [
        ...notes,
        "damage reduced below 1 — the hit still deals 1 point of nonlethal damage",
      ],
    };
  }
  if (lethal < 0 || nonlethal < 0) {
    // Mixed-sign authoring (a big Strength penalty plus nonlethal bonus dice):
    // damage never heals the target; the negative bucket is clamped at 0.
    notes.push("negative damage clamped to 0 (damage never heals the target)");
    if (lethal < 0) lethal = 0;
    if (nonlethal < 0) nonlethal = 0;
  }
  return {
    ok: true,
    multiplier,
    weaponDamage,
    lethal,
    nonlethal,
    bonusContributions,
    precisionDropped,
    notes,
  };
}
