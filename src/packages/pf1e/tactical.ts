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
 * Deliberately **not** here: damage rolls and crit confirmation (A03), range
 * increments/penalties and splash scatter (A04), DR/ER mitigation (A05), feat
 * stances like Power Attack or fighting defensively (A07 — the exact numbers
 * are now verified on AoN Rules ID 131 but belong to the feat slice), and any
 * dice rolling — callers pass the d20 result, keeping this file deterministic
 * and trivially fixture-able.
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
  /** Intent to deal lethal damage with an unarmed strike without IUS: −4 (CRB p.182). */
  lethalIntent?: boolean | undefined;
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

  // Lethal damage with an unarmed strike without IUS (CRB p.182): −4.
  if (
    weapon.unarmed === true &&
    input.lethalIntent === true &&
    !feats.includes(PF1E_FEAT_IMPROVED_UNARMED_STRIKE)
  ) {
    parts.push({ label: "unarmed lethal damage", value: -4 });
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
