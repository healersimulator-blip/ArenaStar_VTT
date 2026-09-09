/**
 * PF1e **equipment descriptors** — armor, shields and the item-wear arithmetic
 * every owned object shares (P3/A01).
 *
 * This is a data contract, not a resolver: AC assembly stays in `actor.ts`
 * (`PF1eAcComponents` + `derivePF1eActor`), sunder the maneuver is P6, and the
 * tactical consumer of the broken-armor adjustments lands with A02+/A05. What
 * lives here is the typed authored shape (`system.pf1e`, per D-113: derive on
 * read, never persist derived totals), its total validator, and the two
 * verified arithmetic rules that only need the item:
 *
 * - hardness before HP (Gap List A.17: "damage − hardness, then subtract from
 *   object HP; hardness applies to objects only");
 * - the broken thresholds (AoN Rules ID 413, Conditions › Broken: items that
 *   have taken damage **in excess of half** their total hit points are broken —
 *   i.e. `hp < hpMax / 2`; the Gap List A.9 sunder row's "≤ ½ HP" paraphrase is
 *   corrected against the primary text, which the sunder maneuver itself cites).
 *
 * No material-specific HP/hardness table is encoded: the Gap List has no
 * verified one (A.17 only names "a weapon with hardness 10 (iron)" as an
 * example), so `itemHp`/`hardness` are authored per item and never defaulted.
 */

/** @srd CRB Equipment — armor slots the tactical side distinguishes. */
export type PF1eArmorSlot = "armor" | "shield";

/**
 * Armor proficiency categories. Nonproficiency consequences (ACP on attack
 * rolls and Dex/Str skills) are applied by the attack/skill paths (A02+), not
 * carried here; `"none"` marks a worn item with no proficiency class authored.
 */
export type PF1eArmorProficiency =
  "light" | "medium" | "heavy" | "shield" | "none";

/** Wear state shared by weapons (`weapons.ts`) and armor alike. */
export interface PF1eItemWear {
  /** Item hit points. Absent ⇒ sunder/object damage cannot be tracked for this item. */
  itemHp?: number | undefined;
  /** Hardness subtracted before damage reaches item HP (A.17). */
  itemHardness?: number | undefined;
  /** Authored broken state (misfire, sunder, or a pre-broken item). */
  broken?: boolean | undefined;
}

/** Everything an author may write for one armor/shield item under `system.pf1e.armor`-style entries. */
export interface PF1eArmorAuthored extends PF1eItemWear {
  name?: string;
  slot?: PF1eArmorSlot;
  proficiency?: PF1eArmorProficiency;
  /** Armor bonus for a worn suit (slot `"armor"`). */
  armorBonus?: number;
  /** Shield bonus for a wielded shield (slot `"shield"`). */
  shieldBonus?: number;
  /** Maximum Dexterity bonus the item allows; the lower of wearer Dex and this wins (A.2). */
  maxDexBonus?: number;
  /** Armor check penalty (already negative-agnostic: authored as a positive number). */
  checkPenalty?: number;
  /** Arcane spell failure chance, percent. */
  spellFailure?: number;
}

/** One armor item, normalized. */
export interface PF1eArmorDescriptor extends PF1eItemWear {
  name: string;
  slot: PF1eArmorSlot;
  proficiency: PF1eArmorProficiency;
  armorBonus: number;
  shieldBonus: number;
  maxDexBonus: number | null;
  checkPenalty: number;
  spellFailure: number;
}

export interface PF1eArmorResolution {
  /** True when `raw` was a record with no unusable field (issues may still carry notes). */
  ok: boolean;
  armor: PF1eArmorDescriptor;
  issues: string[];
}

const ARMOR_SLOTS: readonly PF1eArmorSlot[] = ["armor", "shield"];
const ARMOR_PROFICIENCIES: readonly PF1eArmorProficiency[] = [
  "light",
  "medium",
  "heavy",
  "shield",
  "none",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readNonNegativeNumber(
  raw: Record<string, unknown>,
  key: string,
  issues: string[],
  where: string,
): number | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    issues.push(
      `${where}.${key} = ${String(v)} is not a non-negative number — ignored`,
    );
    return null;
  }
  return n;
}

/**
 * Total armor validator: garbage in ⇒ a usable no-bonus item out, with every
 * malformed field named in `issues` (the `derivePF1eActor` convention — never
 * throw, never guess). A negative-penalty trick is not "fixed" silently:
 * `checkPenalty` must be authored non-negative; the sign is applied by the AC
 * and skill consumers, which own the arithmetic.
 */
export function resolvePF1eArmor(raw: unknown): PF1eArmorResolution {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    return {
      ok: false,
      armor: {
        name: "Armor",
        slot: "armor",
        proficiency: "none",
        armorBonus: 0,
        shieldBonus: 0,
        maxDexBonus: null,
        checkPenalty: 0,
        spellFailure: 0,
        itemHp: undefined,
        itemHardness: undefined,
        broken: undefined,
      },
      issues: ["armor: not an object — empty descriptor returned"],
    };
  }
  const slot =
    typeof raw.slot === "string" &&
    (ARMOR_SLOTS as readonly string[]).includes(raw.slot)
      ? (raw.slot as PF1eArmorSlot)
      : null;
  if (raw.slot !== undefined && slot === null) {
    issues.push(
      `armor.slot = ${String(raw.slot)} is not "armor" | "shield" — defaulted to "armor"`,
    );
  }
  const proficiency =
    typeof raw.proficiency === "string" &&
    (ARMOR_PROFICIENCIES as readonly string[]).includes(raw.proficiency)
      ? (raw.proficiency as PF1eArmorProficiency)
      : null;
  if (raw.proficiency !== undefined && proficiency === null) {
    issues.push(
      `armor.proficiency = ${String(raw.proficiency)} is not a known category — defaulted to "none"`,
    );
  }
  const name =
    typeof raw.name === "string" && raw.name.trim() !== ""
      ? raw.name.trim()
      : null;
  const armorBonus =
    readNonNegativeNumber(raw, "armorBonus", issues, "armor") ?? 0;
  const shieldBonus =
    readNonNegativeNumber(raw, "shieldBonus", issues, "armor") ?? 0;
  const maxDexBonus = readNonNegativeNumber(
    raw,
    "maxDexBonus",
    issues,
    "armor",
  );
  const checkPenalty =
    readNonNegativeNumber(raw, "checkPenalty", issues, "armor") ?? 0;
  const spellFailure =
    readNonNegativeNumber(raw, "spellFailure", issues, "armor") ?? 0;
  if (spellFailure > 100) {
    // A percent cannot exceed certainty; carried as authored, flagged as data noise.
    issues.push(
      `armor.spellFailure = ${spellFailure} exceeds 100 — carried, treated as certainty`,
    );
  }
  const itemHp = readNonNegativeNumber(raw, "itemHp", issues, "armor");
  const itemHardness = readNonNegativeNumber(
    raw,
    "itemHardness",
    issues,
    "armor",
  );
  const broken = raw.broken === true ? true : undefined;
  if (raw.broken !== undefined && typeof raw.broken !== "boolean") {
    issues.push(
      `armor.broken = ${String(raw.broken)} is not a boolean — ignored`,
    );
  }
  const slotResolved = slot ?? "armor";
  // A suit of armor granting a shield bonus (or vice versa) is authored nonsense for
  // this contract's slot model: keep the numbers (they may be a mithral-style hybrid
  // in the source data) but name the mismatch so the sheet can surface it.
  if (slotResolved === "armor" && shieldBonus > 0) {
    issues.push(
      'armor: shieldBonus authored on slot "armor" — carried, AC assembly decides',
    );
  }
  if (slotResolved === "shield" && armorBonus > 0) {
    issues.push(
      'armor: armorBonus authored on slot "shield" — carried, AC assembly decides',
    );
  }
  return {
    ok: issues.length === 0,
    armor: {
      name: name ?? (slotResolved === "shield" ? "Shield" : "Armor"),
      slot: slotResolved,
      proficiency: proficiency ?? "none",
      armorBonus,
      shieldBonus,
      maxDexBonus,
      checkPenalty,
      spellFailure,
      itemHp: itemHp ?? undefined,
      itemHardness: itemHardness ?? undefined,
      broken,
    },
    issues,
  };
}

/**
 * Broken armor/shield adjustments (AoN Rules ID 413): the AC bonus the item
 * grants is **halved, rounding down**, and broken armor **doubles its armor
 * check penalty**. The glossary writes the doubling for armor; a broken
 * shield's AC bonus is halved the same way. No spell-failure change is listed
 * for broken items — none is applied.
 */
export function brokenArmorAdjustments(
  armor: Pick<
    PF1eArmorDescriptor,
    "armorBonus" | "shieldBonus" | "checkPenalty" | "broken"
  >,
): {
  armorBonus: number;
  shieldBonus: number;
  checkPenalty: number;
} {
  if (armor.broken !== true) {
    return {
      armorBonus: armor.armorBonus,
      shieldBonus: armor.shieldBonus,
      checkPenalty: armor.checkPenalty,
    };
  }
  return {
    armorBonus: Math.floor(armor.armorBonus / 2),
    shieldBonus: Math.floor(armor.shieldBonus / 2),
    checkPenalty: armor.checkPenalty * 2,
  };
}

/**
 * Object-damage arithmetic (A.17): hardness first, the remainder off item HP.
 * The result may be zero or negative — the **caller** owns what that means
 * (sunder A.9: at or below zero the item is destroyed, or may be left at
 * 1 HP + broken). Hardness below zero is treated as zero, and damage at or
 * below the hardness never reaches HP.
 */
export function itemHpAfterDamage(
  damage: number,
  hardness: number,
  itemHp: number,
): number {
  const effective = Math.max(
    0,
    Math.floor(damage) - Math.max(0, Math.floor(hardness)),
  );
  return itemHp - Math.max(0, effective);
}

/**
 * The broken threshold (AoN Rules ID 413): an item is broken once it has taken
 * damage **in excess of half** its total hit points — `hp < hpMax / 2`. Items
 * without a hit-point budget are never broken by damage (an authored `broken`
 * flag still stands). The Gap List A.9 paraphrase "≤ ½ HP" includes the exact
 * half; the primary text does not, and it wins.
 */
export function isBrokenFromDamage(hp: number, hpMax: number): boolean {
  if (!Number.isFinite(hp) || !Number.isFinite(hpMax) || hpMax <= 0)
    return false;
  return hp < hpMax / 2;
}

/**
 * Sunder verdict (A.9, arithmetic only — the maneuver itself is P6): damage is
 * reduced by hardness, then HP; at or below zero the item is destroyed unless
 * the attacker leaves it at 1 HP + broken; below half HP (A.17 glossary) it is
 * broken. `destroyedOrBroken` marks the attacker's choice point.
 */
export function sunderVerdict(input: { hpMax: number; hpAfter: number }): {
  broken: boolean;
  destroyed: boolean;
  destroyedOrBroken: boolean;
} {
  const destroyed = input.hpAfter <= 0;
  return {
    broken: destroyed || isBrokenFromDamage(input.hpAfter, input.hpMax),
    destroyed,
    destroyedOrBroken: destroyed,
  };
}
