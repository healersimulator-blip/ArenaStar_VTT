/**
 * P5/C05 — pack-driven cast payloads.
 *
 * The strategic engine used to hard-code its Fireball order (`massBattlePf1e.ts`), which
 * is DEVIATIONS D-2: the demo order disagreed with the content pack it claimed to fire.
 * This module is the seam between them — it reads the `massBattle` block a content pack
 * ships on a spell and produces a validated cast payload, so the numbers come from the
 * pack rather than from a literal at the call site.
 *
 * Packs are content, not code: nothing in `src/` reads `systems/**` at runtime, so the
 * caller supplies the pack entry it loaded. `PF1E_PACK_FIREBALL_MASS_BATTLE` mirrors the
 * shipped `systems/pf1e-core/packs/spells.json` block for the reference system, and
 * `tests/packages/pf1eSpellPacks.test.ts` asserts the mirror against the real file.
 */

import type { PF1eCastingIssue } from "./concentration";

export const PF1E_PACK_SPELL_SHAPES = ["circle", "cone", "line"] as const;
export type PF1ePackSpellShape = (typeof PF1E_PACK_SPELL_SHAPES)[number];

export const PF1E_PACK_SAVE_TYPES = ["ref", "fort", "will"] as const;
export type PF1ePackSaveType = (typeof PF1E_PACK_SAVE_TYPES)[number];

/**
 * The standard range categories (CRB p.213, "Range"): a spell's range is "the maximum
 * distance from you that the spell's effect can occur, as well as the maximum distance
 * at which you can designate the spell's point of origin". Personal, touch and unlimited
 * ranges have no point of origin to designate, and "range expressed in feet" spells would
 * need their own field — none of those ship a massBattle block today.
 */
export const PF1E_PACK_SPELL_RANGES = ["close", "medium", "long"] as const;
export type PF1ePackSpellRange = (typeof PF1E_PACK_SPELL_RANGES)[number];

/**
 * The `system.massBattle` block a pack ships on a spell. Fields mirror the shipped
 * `pf1e-core` pack so a pack author can read one and know the other.
 */
export interface PF1ePackSpellMassBattle {
  shape: PF1ePackSpellShape;
  /**
   * Circle: the radius ("20-ft.-radius spread"). Cone: the cone's length — the spell's
   * own Range entry, since a cone "shoots away from you" (CRB p.214). Line: the line's
   * length, likewise ("extends to the limit of its range").
   */
  radiusFeet: number;
  /**
   * The spell's standard range category (CRB p.213); feet are derived at caster level.
   * Required only for `circle` — the shape where the caster designates a remote point of
   * origin. Cones and lines start at the caster and reach exactly their length, so they
   * carry no category; one authored on them is ignored.
   */
  rangeCategory?: PF1ePackSpellRange | undefined;
  /** Line shape only: corridor width in feet (CRB p.214's published lines are 5 ft wide). */
  widthFeet?: number | undefined;
  /**
   * Cone/line shapes only, and only where the published area scales with the caster: Lightning
   * Bolt's "100 ft. + 10 ft./level" line (CRB p.296 in the print edition's Conjuration page,
   * R02-transcribed here by its own text, not by a page reference the corpus does not carry).
   * `radiusFeet` is the base and this is what each caster level adds, so the length at level
   * `L` is `base + per × L` — PF1e's "+X ft./level" ranges include the 1st level, unlike the
   * close/medium/long categories, whose arithmetic `spellRangeFeet` owns. A circle's radius
   * never scales in the published blast spells, so the field is refused on a circle rather than
   * ignored: an author who reaches for it there has almost certainly meant `rangeCategory`.
   */
  lengthFeetPerCasterLevel?: number | undefined;
  saveType: PF1ePackSaveType;
  halfOnSave: boolean;
  /** True when Evasion/Improved Evasion can apply — the spell must be Reflex half. */
  evasion: boolean;
  damageDiceCount: number;
  damageDiceSides: number;
  /** True when the dice scale with caster level ("1d6 per caster level"). */
  dicePerCasterLevel?: boolean | undefined;
  /** The cap on scaled dice ("maximum 10d6"). */
  maxDice?: number | undefined;
  damageType?: string | undefined;
}

export interface PF1ePackSpellOrder {
  spellName: string;
  shape: PF1ePackSpellShape;
  /** Circle radius, or cone/line length (see `PF1ePackSpellMassBattle.radiusFeet`). */
  radius: number;
  /** The pack's range category (circle shapes); null for cone/line, which start at the caster. */
  rangeCategory: PF1ePackSpellRange | null;
  /** Line corridor width in feet; null except for line shapes. */
  widthFeet: number | null;
  saveType: PF1ePackSaveType;
  halfOnSave: boolean;
  evasionApplies: boolean;
  /** Dice actually rolled, after any per-caster-level scaling and cap. */
  damageDiceCount: number;
  damageDiceSides: number;
  damageType: string | null;
  /** The pack's Spell Resistance line. */
  spellResistance: boolean;
}

export interface PF1ePackSpellParse {
  ok: boolean;
  order: PF1ePackSpellOrder | null;
  issues: PF1eCastingIssue[];
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const positiveInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

/**
 * Reads a pack spell entry and resolves it to a cast payload.
 *
 * `casterLevel` is needed because "1d6 points of fire damage per caster level (maximum
 * 10d6)" is a formula, not a number — the pack stores `dicePerCasterLevel` and `maxDice`
 * and this resolves them. The save DC is deliberately **not** derived here: it is
 * `spellSaveDc` in `casting.ts`, which takes the spell level for the caster's class. Pack
 * class tables are a content concern, and reading a level from one would put a content
 * bug into the maths.
 */
export function parsePackSpellOrder(input: {
  entry: unknown;
  casterLevel: number;
}): PF1ePackSpellParse {
  const issues: PF1eCastingIssue[] = [];
  const fail = (): PF1ePackSpellParse => ({ ok: false, order: null, issues });

  if (!Number.isInteger(input.casterLevel) || input.casterLevel < 1) {
    issues.push({
      field: "casterLevel",
      message: `caster level ${String(input.casterLevel)} is not an integer >= 1`,
    });
    return fail();
  }

  const root = asRecord(input.entry);
  if (root === null) {
    issues.push({ field: "entry", message: "spell entry is not an object" });
    return fail();
  }
  const spellName =
    typeof root.name === "string" && root.name.length > 0
      ? root.name
      : "(unnamed spell)";
  const system = asRecord(root.system);
  if (system === null) {
    issues.push({
      field: "system",
      message: `${spellName}: missing "system" block`,
    });
    return fail();
  }
  const mb = asRecord(system.massBattle);
  // M15 — a pack entry says which side of the line it is on. `automation: "automated"` means the
  // block below is executed; "descriptive" means the entry exists for the sheet and the
  // compendium search and NOTHING here reads it. The declaration is not decoration: it is
  // cross-checked against the presence of a block, so a spell cannot claim to be live by
  // omission, and one the engine grew cannot stay marked descriptive.
  const automation =
    typeof system.automation === "string"
      ? system.automation.trim().toLowerCase()
      : null;
  if (mb === null) {
    if (automation === "automated") {
      issues.push({
        field: "system.automation",
        message: `${spellName}: declares automation "automated" but ships no "massBattle" block to execute`,
      });
    }
    issues.push({
      field: "system.massBattle",
      message: `${spellName}: no "massBattle" block, so it has no mass-battle area payload`,
    });
    return fail();
  }
  if (automation === "descriptive") {
    issues.push({
      field: "system.automation",
      message: `${spellName}: declares automation "descriptive" but ships a "massBattle" block — the executable key belongs to automated content, and an intended-but-unexecuted payload is authored as "massBattleIntent"`,
    });
    return fail();
  }
  // An entry may document a payload the engine cannot execute yet — that is `massBattleIntent`,
  // which is deliberately NOT parsed here (Magic Missile's `missile` shape is the shipped
  // example: real content, no executor). Marking such a spell "automated" is a content bug, so
  // it is refused rather than quietly downgraded to descriptive.
  if (
    automation === "automated" &&
    asRecord(system.massBattleIntent) !== null
  ) {
    issues.push({
      field: "system.automation",
      message: `${spellName}: declares automation "automated" while its payload sits in "massBattleIntent", which no code reads`,
    });
    return fail();
  }

  const shape = mb.shape;
  if (!(PF1E_PACK_SPELL_SHAPES as readonly string[]).includes(String(shape))) {
    issues.push({
      field: "massBattle.shape",
      message: `${spellName}: shape "${String(shape)}" is not one of ${PF1E_PACK_SPELL_SHAPES.join(", ")}`,
    });
  }
  const radiusFeet = mb.radiusFeet;
  if (
    typeof radiusFeet !== "number" ||
    !Number.isFinite(radiusFeet) ||
    radiusFeet <= 0
  ) {
    issues.push({
      field: "massBattle.radiusFeet",
      message: `${spellName}: radius ${String(radiusFeet)} is not a positive number of feet`,
    });
  }
  // Only the circle shape designates a remote point of origin, so only it needs a range
  // category to check that designation against (CRB p.213). Cones and lines "shoot away
  // from you" (CRB p.214) and reach exactly their length.
  const rangeCategory = mb.rangeCategory;
  if (
    shape === "circle" &&
    !(PF1E_PACK_SPELL_RANGES as readonly string[]).includes(
      String(rangeCategory),
    )
  ) {
    issues.push({
      field: "massBattle.rangeCategory",
      message: `${spellName}: rangeCategory "${String(rangeCategory)}" is not one of ${PF1E_PACK_SPELL_RANGES.join(", ")}`,
    });
  }
  const widthFeet = mb.widthFeet;
  if (
    shape === "line" &&
    (typeof widthFeet !== "number" ||
      !Number.isFinite(widthFeet) ||
      widthFeet <= 0)
  ) {
    issues.push({
      field: "massBattle.widthFeet",
      message: `${spellName}: widthFeet ${String(widthFeet)} is not a positive number of feet`,
    });
  }
  const lengthPerLevel = mb.lengthFeetPerCasterLevel;
  if (lengthPerLevel !== undefined) {
    if (shape === "circle") {
      issues.push({
        field: "massBattle.lengthFeetPerCasterLevel",
        message: `${spellName}: a circle's radius is fixed by its Area line — per-level growth belongs to rangeCategory`,
      });
    } else if (
      typeof lengthPerLevel !== "number" ||
      !Number.isFinite(lengthPerLevel) ||
      lengthPerLevel < 0
    ) {
      issues.push({
        field: "massBattle.lengthFeetPerCasterLevel",
        message: `${spellName}: lengthFeetPerCasterLevel ${String(lengthPerLevel)} is not a non-negative number of feet`,
      });
    }
  }
  const saveType = mb.saveType;
  if (!(PF1E_PACK_SAVE_TYPES as readonly string[]).includes(String(saveType))) {
    issues.push({
      field: "massBattle.saveType",
      message: `${spellName}: saveType "${String(saveType)}" is not one of ${PF1E_PACK_SAVE_TYPES.join(", ")}`,
    });
  }
  const damageDiceCount = positiveInt(mb.damageDiceCount);
  if (damageDiceCount === null) {
    issues.push({
      field: "massBattle.damageDiceCount",
      message: `${spellName}: damageDiceCount ${String(mb.damageDiceCount)} is not a positive integer`,
    });
  }
  const damageDiceSides = positiveInt(mb.damageDiceSides);
  if (damageDiceSides === null) {
    issues.push({
      field: "massBattle.damageDiceSides",
      message: `${spellName}: damageDiceSides ${String(mb.damageDiceSides)} is not a positive integer`,
    });
  }
  if (issues.length > 0) return fail();

  // Resolve "1d6 per caster level (maximum 10d6)".
  let dice = damageDiceCount as number;
  if (mb.dicePerCasterLevel === true) {
    dice = dice * input.casterLevel;
    const maxDice = mb.maxDice;
    if (maxDice === undefined) {
      issues.push({
        field: "massBattle.maxDice",
        message: `${spellName}: dicePerCasterLevel is set but no maxDice cap is authored`,
      });
    } else {
      const cap = positiveInt(maxDice);
      if (cap === null) {
        issues.push({
          field: "massBattle.maxDice",
          message: `${spellName}: maxDice ${String(maxDice)} is not a positive integer`,
        });
      } else {
        dice = Math.min(dice, cap);
      }
    }
  }
  if (issues.length > 0) return fail();

  const halfOnSave = mb.halfOnSave === true;
  const evasion = mb.evasion === true;

  // Cross-check the sim block against the spell's own Saving Throw line. A pack that
  // says "Reflex half" but drives `halfOnSave: false` is self-contradictory, and the
  // contradiction is reported rather than silently resolved.
  const savingThrow =
    typeof system.savingThrow === "string"
      ? system.savingThrow.toLowerCase()
      : "";
  if (savingThrow.length > 0) {
    const saysHalf = savingThrow.includes("half");
    const saysNone = savingThrow === "none" || savingThrow === "no";
    if (saysHalf !== halfOnSave && !saysNone) {
      issues.push({
        field: "savingThrow",
        message: `${spellName}: Saving Throw "${system.savingThrow as string}" does not match massBattle.halfOnSave=${String(halfOnSave)}`,
      });
    }
  }
  // Evasion is defined against "an attack that normally allows a Reflex saving throw for
  // half damage", so a pack flagging evasion on a non-Reflex-half spell is a content bug.
  if (evasion && (saveType !== "ref" || !halfOnSave)) {
    issues.push({
      field: "massBattle.evasion",
      message: `${spellName}: evasion is flagged but the spell is not Reflex half`,
    });
  }
  if (issues.length > 0) return fail();

  const length =
    lengthPerLevel === undefined || shape === "circle"
      ? (radiusFeet as number)
      : (radiusFeet as number) + (lengthPerLevel as number) * input.casterLevel;

  return {
    ok: true,
    order: {
      spellName,
      shape: shape as PF1ePackSpellShape,
      radius: length,
      rangeCategory:
        shape === "circle" ? (rangeCategory as PF1ePackSpellRange) : null,
      widthFeet: shape === "line" ? (widthFeet as number) : null,
      saveType: saveType as PF1ePackSaveType,
      halfOnSave,
      evasionApplies: evasion,
      damageDiceCount: dice,
      damageDiceSides: damageDiceSides as number,
      damageType: typeof mb.damageType === "string" ? mb.damageType : null,
      spellResistance: system.spellResistance === true,
    },
    issues,
  };
}

/**
 * Resolve a standard range category to feet at a caster level (CRB p.213, "Range"):
 *
 * - **Close**: "The spell reaches as far as 25 feet away from you. The maximum range
 *   increases by 5 feet for every two full caster levels."
 * - **Medium**: "The spell reaches as far as 100 feet + 10 feet per caster level."
 * - **Long**: "The spell reaches as far as 400 feet + 40 feet per caster level."
 */
export function spellRangeFeet(
  rangeCategory: PF1ePackSpellRange,
  casterLevel: number,
): number {
  const level = Math.max(1, Math.floor(casterLevel));
  switch (rangeCategory) {
    case "close":
      return 25 + 5 * Math.floor(level / 2);
    case "medium":
      return 100 + 10 * level;
    case "long":
      return 400 + 40 * level;
    default: {
      const never: never = rangeCategory;
      throw new Error(`unknown range category: ${String(never)}`);
    }
  }
}

/**
 * One automated spell, mirrored in code: the pack's executable fields plus the spell level the
 * sim uses for its save DC. The `systems/pf1e-core/packs/spells.json` entry is the authored
 * source; this is the copy the reference system can read at runtime (it cannot fetch `systems/**`),
 * and `tests/packages/pf1eSpellPackSync.test.ts` refuses any difference between the two.
 */
export interface PF1ePackMassSpellMirror {
  /** The pack entry, reduced to the fields `parsePackSpellOrder` reads. */
  readonly entry: Readonly<Record<string, unknown>>;
  /**
   * The verified class level the sim uses as `spellSaveDc`'s spell level (D-151): the pack's own
   * `system.level` table is content the reference system does not read, so this constant is the
   * one the DC comes from — and the sync test pins the table's `sorcererWizard` against it.
   */
  readonly level: number;
}

/**
 * The spells the mass-battle engine executes, keyed by pack entry id. Anything the pack lists
 * with `automation: "descriptive"` is content for the sheet and the compendium search; anything
 * here is a payload the resolver runs. Four rows, all of them area spells whose published shape
 * is one the sim's `circle` / `cone` / `line` geometry can express.
 */
export type PF1ePackMassSpellMirrorTable = {
  fireball: PF1ePackMassSpellMirror;
  "burning-hands": PF1ePackMassSpellMirror;
  "cone-of-cold": PF1ePackMassSpellMirror;
  "lightning-bolt": PF1ePackMassSpellMirror;
};

export const PF1E_PACK_MASS_SPELL_MIRRORS: Readonly<PF1ePackMassSpellMirrorTable> =
  Object.freeze({
    fireball: Object.freeze({
      level: 3,
      entry: Object.freeze({
        name: "Fireball",
        system: Object.freeze({
          automation: "automated",
          savingThrow: "Reflex half",
          spellResistance: true,
          massBattle: Object.freeze({
            shape: "circle",
            radiusFeet: 20,
            rangeCategory: "long",
            saveType: "ref",
            halfOnSave: true,
            evasion: true,
            damageDiceCount: 1,
            damageDiceSides: 6,
            dicePerCasterLevel: true,
            maxDice: 10,
            damageType: "fire",
          }),
        }),
      }),
    }),
    "burning-hands": Object.freeze({
      level: 1,
      entry: Object.freeze({
        name: "Burning Hands",
        system: Object.freeze({
          automation: "automated",
          savingThrow: "Reflex half",
          spellResistance: true,
          massBattle: Object.freeze({
            shape: "cone",
            radiusFeet: 15,
            saveType: "ref",
            halfOnSave: true,
            evasion: true,
            damageDiceCount: 1,
            damageDiceSides: 4,
            dicePerCasterLevel: true,
            maxDice: 5,
            damageType: "fire",
          }),
        }),
      }),
    }),
    "cone-of-cold": Object.freeze({
      level: 5,
      entry: Object.freeze({
        name: "Cone of Cold",
        system: Object.freeze({
          automation: "automated",
          savingThrow: "Reflex half",
          spellResistance: true,
          massBattle: Object.freeze({
            shape: "cone",
            radiusFeet: 60,
            saveType: "ref",
            halfOnSave: true,
            evasion: true,
            damageDiceCount: 1,
            damageDiceSides: 6,
            dicePerCasterLevel: true,
            maxDice: 10,
            damageType: "cold",
          }),
        }),
      }),
    }),
    "lightning-bolt": Object.freeze({
      level: 3,
      entry: Object.freeze({
        name: "Lightning Bolt",
        system: Object.freeze({
          automation: "automated",
          savingThrow: "Reflex half",
          spellResistance: true,
          massBattle: Object.freeze({
            shape: "line",
            radiusFeet: 100,
            lengthFeetPerCasterLevel: 10,
            widthFeet: 5,
            saveType: "ref",
            halfOnSave: true,
            evasion: true,
            damageDiceCount: 1,
            damageDiceSides: 6,
            dicePerCasterLevel: true,
            maxDice: 10,
            damageType: "electricity",
          }),
        }),
      }),
    }),
  });

/**
 * The `massBattle` block of the shipped `pf1e-core` Fireball, mirrored here because the
 * reference system cannot read `systems/**` at runtime. Asserted against the real file by
 * `tests/packages/pf1eSpellPacks.test.ts`, so drift fails a test instead of silently
 * diverging.
 *
 * Values are the pack's: 20-ft.-radius spread, long range (400 ft. + 40 ft./level),
 * Reflex half, 1d6/level capped at 10d6 (CRB p.283).
 *
 * M15 turned this and its Burning Hands sibling into views on
 * `PF1E_PACK_MASS_SPELL_MIRRORS` so the module's registry and the exported constants cannot
 * disagree; the names stay because callers and tests already import them.
 */
export const PF1E_PACK_FIREBALL_MASS_BATTLE: Readonly<Record<string, unknown>> =
  PF1E_PACK_MASS_SPELL_MIRRORS.fireball.entry;

/**
 * The `massBattle` block of the shipped `pf1e-core` Burning Hands, mirrored here for the
 * same reason as Fireball (the reference system cannot read `systems/**` at runtime).
 * Asserted against the real file by `tests/packages/pf1eSpellPacks.test.ts`.
 *
 * Values are the pack's: 15-ft cone-shaped burst, Reflex half, SR yes, 1d4/level fire
 * capped at 5d4 (CRB pg. 251, R02-transcribed D-171). A cone shoots away from the
 * caster, so there is no range category (CRB pp.213-214).
 */
export const PF1E_PACK_BURNING_HANDS_MASS_BATTLE: Readonly<
  Record<string, unknown>
> = PF1E_PACK_MASS_SPELL_MIRRORS["burning-hands"].entry;
