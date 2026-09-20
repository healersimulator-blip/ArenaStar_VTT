/**
 * T3/T6 transcription fixtures for plan §1.3 — **carrying capacity and encumbrance** (T3) and
 * **consumables** (T6).
 *
 * Every expected number in this file is read off a printed table or a named rule, and the
 * citation is on the fixture. The point of pinning them here is the same as
 * `pf1eFixtures.test.ts`: the module must reproduce the book, row for row, and a later
 * "simplification" of the arithmetic has to argue with the book rather than with the code.
 *
 * - **Table 7-4: Carrying Capacity** — CRB p.169, AoN *Carrying Capacity* (Rules ID 118).
 *   The printed rows are verbatim in `PF1E_CARRYING_CAPACITY_TABLE`; this file checks the
 *   reader against them *and* checks a sample of rows against literals, so editing the table
 *   to make a test pass is not possible without editing the test.
 * - **Bigger and Smaller Creatures / Quadrupeds** — the size multipliers, including the
 *   quadruped column that *replaces* the biped one.
 * - **Tremendous Strength** — the ×4-per-10-points rule for Strength above 29.
 * - **Table 7-5: Encumbrance Effects** — max Dex, check penalty, run multiplier, and the
 *   "use the worse figure … do not stack the penalties" sentence.
 * - **Armor and Encumbrance for Other Base Speeds** — the reduced-speed table, 5–120 ft.
 * - **Slow and Steady** (dwarf) — speed never modified by armor or encumbrance.
 * - **Coins** — "fifty coins to the pound".
 * - **Consumables (T6)** — a wand holds 50 charges and cannot be recharged, a staff 10 and can
 *   be, a scroll and a potion are single-use; the wand's caster level is 5 (`Craft Wand`) and
 *   its save DC is the item's own: `10 + spell level + the minimum ability modifier`.
 */
import { describe, expect, test } from "vitest";
import {
  PF1E_CARRYING_CAPACITY_TABLE,
  PF1E_ENCUMBRANCE_EFFECTS,
  carriedWeightLb,
  carryingCapacityOf,
  coinWeightLb,
  encumbranceReadout,
  equippedArmorEntry,
  inventoryTree,
  inventoryValueGp,
  loadLevelFor,
  type PF1eInventoryItem,
  readCurrency,
  readInventoryItems,
  reducedSpeedFt,
  slowAndSteadyOf,
  worseOfArmorAndLoad,
} from "../../src/packages/pf1e/inventory";
import { deriveFromActorDocument } from "../../src/packages/pf1e/actor";
import type { ActorDocument } from "../../src/core/documents";
import {
  addWorldItemOp,
  worldItemRows,
} from "../../src/ui/sheets/pf1eItemsTab";
import {
  CONSUMABLE_CHARGES,
  CONSUMABLE_DEFAULT_CASTER_LEVEL,
  consumableCastAuthored,
  consumableSaveDc,
  itemCastSource,
  itemSpellDc,
  minimumCasterLevel,
  planConsumable,
  restoreUse,
  spendUse,
  weaponItemsOf,
  attackEntryFromWeapon,
} from "../../src/packages/pf1e/consumables";

/** The single read item, asserted present (an empty read is a failure, not a crash). */
function firstItem(items: readonly PF1eInventoryItem[]): PF1eInventoryItem {
  const [item] = items;
  expect(item).toBeDefined();
  return item as PF1eInventoryItem;
}

/** A minimal embedded item document, as the converter writes one. */
function item(system: Record<string, unknown>, name = "Item"): Record<string, unknown> {
  return { _id: `i-${name}`, type: "item", name, system, effects: [] };
}

describe("T3 — Table 7-4 carrying capacity (CRB p.169, AoN Rules ID 118)", () => {
  // Transcribed from the printed table: a sample that spans the shape of it (the small rows
  // that round independently, the tens that double, and the 21–29 rows that are their own
  // numbers rather than a doubling of 11–19).
  const PRINTED: Array<[number, number, number, number]> = [
    [1, 3, 6, 10],
    [3, 10, 20, 30],
    [6, 20, 40, 60],
    [10, 33, 66, 100],
    [13, 50, 100, 150],
    [17, 86, 173, 260],
    [20, 133, 266, 400],
    [24, 233, 466, 700],
    [29, 466, 933, 1400],
  ];

  test.each(PRINTED)("Strength %i carries %i / %i / %i lb", (str, light, medium, heavy) => {
    const capacity = carryingCapacityOf({ strength: str, size: "Medium" });
    expect([capacity.light, capacity.medium, capacity.heavy]).toEqual([light, medium, heavy]);
  });

  test("the table has every row the book prints, 1 through 29", () => {
    expect(Object.keys(PF1E_CARRYING_CAPACITY_TABLE).map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 29 }, (_, i) => i + 1),
    );
  });

  test("Tremendous Strength: Strength 39 reads the 29 row ×4 (39 is 10 above 29)", () => {
    const capacity = carryingCapacityOf({ strength: 39, size: "Medium" });
    expect(capacity.tableStrength).toBe(29);
    expect(capacity.tremendousMultiplier).toBe(4);
    // 466 / 933 / 1400 lb ×4.
    expect([capacity.light, capacity.medium, capacity.heavy]).toEqual([1864, 3732, 5600]);
  });

  test("Tremendous Strength: Strength 40 reads the 20 row ×16 (20 above 20)", () => {
    const capacity = carryingCapacityOf({ strength: 40, size: "Medium" });
    expect(capacity.tableStrength).toBe(20);
    expect(capacity.tremendousMultiplier).toBe(16);
    // 133 / 266 / 400 lb ×16 — the printed table's own "+10 → ×4" row applied twice.
    expect([capacity.light, capacity.medium, capacity.heavy]).toEqual([2128, 4256, 6400]);
  });

  test("a Strength bonus for capacity only (Muleback-style) raises the score, not the rolls", () => {
    const base = carryingCapacityOf({ strength: 10, size: "Medium" });
    const boosted = carryingCapacityOf({ strength: 10, size: "Medium", strengthForCapacity: 8 });
    expect([base.light, base.medium, base.heavy]).toEqual([33, 66, 100]);
    expect(boosted.effectiveStrength).toBe(18);
    expect([boosted.light, boosted.medium, boosted.heavy]).toEqual([100, 200, 300]);
  });

  test("a malformed Strength is read at 1 and named, never silently 10", () => {
    const capacity = carryingCapacityOf({ strength: Number.NaN, size: "Medium" });
    expect(capacity.effectiveStrength).toBe(1);
    expect(capacity.issues.join(" ")).toMatch(/strength: not a number/);
  });
});

describe("T3 — size multipliers (Bigger and Smaller Creatures, and Quadrupeds)", () => {
  test("bipedal: Small is ×3/4 and Large is ×2 of the Medium row", () => {
    const medium = carryingCapacityOf({ strength: 10, size: "Medium" });
    const small = carryingCapacityOf({ strength: 10, size: "Small" });
    const large = carryingCapacityOf({ strength: 10, size: "Large" });
    // Medium 33/66/100 → Small 24/49/75 (floored), Large 66/132/200.
    expect([small.light, small.medium, small.heavy]).toEqual([24, 49, 75]);
    expect([large.light, large.medium, large.heavy]).toEqual([66, 132, 200]);
    expect(medium.sizeMultiplier).toBe(1);
  });

  test("quadrupeds replace the bipedal column: Horse-shaped Medium is ×1-1/2", () => {
    const biped = carryingCapacityOf({ strength: 10, size: "Medium" });
    const quad = carryingCapacityOf({ strength: 10, size: "Medium", quadruped: true });
    expect(quad.sizeMultiplier).toBe(1.5);
    expect([quad.light, quad.medium, quad.heavy]).toEqual([49, 99, 150]);
    expect(quad.heavy).toBeGreaterThan(biped.heavy);
  });

  test("Colossal quadruped is ×24 (per the printed quadruped row)", () => {
    const quad = carryingCapacityOf({ strength: 20, size: "Colossal", quadruped: true });
    expect(quad.sizeMultiplier).toBe(24);
    expect(quad.heavy).toBe(400 * 24);
  });

  test("lifting, staggering and pushing are the heavy column ×1 / ×2 / ×5", () => {
    const c = carryingCapacityOf({ strength: 10, size: "Medium" });
    expect([c.liftLb, c.liftOffGroundLb, c.pushDragLb]).toEqual([100, 200, 500]);
  });
});

describe("T3 — Table 7-5 encumbrance effects", () => {
  test("the printed penalties: medium +3 / −3 / run ×4, heavy +1 / −6 / run ×3", () => {
    expect(PF1E_ENCUMBRANCE_EFFECTS.medium).toEqual({
      maxDexBonus: 3,
      checkPenalty: 3,
      runMultiplier: 4,
      speedCapped: true,
    });
    expect(PF1E_ENCUMBRANCE_EFFECTS.heavy).toEqual({
      maxDexBonus: 1,
      checkPenalty: 6,
      runMultiplier: 3,
      speedCapped: true,
    });
    expect(PF1E_ENCUMBRANCE_EFFECTS.none.checkPenalty).toBe(0);
    expect(PF1E_ENCUMBRANCE_EFFECTS.none.maxDexBonus).toBeNull();
  });

  test("load level boundaries are the Table 7-4 maxima (Str 10: 33 / 66 / 100 lb)", () => {
    const capacity = carryingCapacityOf({ strength: 10, size: "Medium" });
    expect(loadLevelFor(0, capacity)).toBe("none");
    expect(loadLevelFor(33, capacity)).toBe("none");
    expect(loadLevelFor(33.5, capacity)).toBe("medium");
    expect(loadLevelFor(66, capacity)).toBe("medium");
    expect(loadLevelFor(66.5, capacity)).toBe("heavy");
    expect(loadLevelFor(100, capacity)).toBe("heavy");
    expect(loadLevelFor(100.5, capacity)).toBe("overloaded");
  });

  test("a medium load at Speed 30 drops to 20 ft., and at 20 ft. to 15 ft.", () => {
    const readout = encumbranceReadout({ strength: 10, size: "Medium", totalLb: 50, baseSpeedFt: 30 });
    expect(readout.level).toBe("medium");
    expect(readout.speedFt).toBe(20);
    const slow = encumbranceReadout({ strength: 10, size: "Medium", totalLb: 50, baseSpeedFt: 20 });
    expect(slow.speedFt).toBe(15);
  });

  test("a heavy load gives the same speed figure as a medium one (both rows → 20/15)", () => {
    const medium = encumbranceReadout({ strength: 10, size: "Medium", totalLb: 60, baseSpeedFt: 30 });
    const heavy = encumbranceReadout({ strength: 10, size: "Medium", totalLb: 90, baseSpeedFt: 30 });
    expect([medium.level, heavy.level]).toEqual(["medium", "heavy"]);
    expect([medium.speedFt, heavy.speedFt]).toEqual([20, 20]);
  });

  test("the reduced-speed table for other base speeds (5–120 ft.), every printed row", () => {
    // Every row of "Armor and Encumbrance for Other Base Speeds", read as the printed ranges
    // (5 ft. → 5; 10–15 ft. → 10; … 115–120 ft. → 80). The ranges are inclusive, so each row
    // is checked at both ends.
    const PRINTED: Array<[readonly number[], number]> = [
      [[5], 5],
      [[10, 15], 10],
      [[20], 15],
      [[25, 30], 20],
      [[35], 25],
      [[40, 45], 30],
      [[50], 35],
      [[55, 60], 40],
      [[65], 45],
      [[70, 75], 50],
      [[80], 55],
      [[85, 90], 60],
      [[95], 65],
      [[100, 105], 70],
      [[110], 75],
      [[115, 120], 80],
    ];
    for (const [bases, reduced] of PRINTED)
      for (const base of bases) expect([base, reducedSpeedFt(base)]).toEqual([base, reduced]);
  });

  test("Slow and Steady (dwarf): the load never changes the speed, penalties still apply", () => {
    const readout = encumbranceReadout({
      strength: 10,
      size: "Medium",
      totalLb: 90,
      baseSpeedFt: 20,
      slowAndSteady: true,
    });
    expect(readout.level).toBe("heavy");
    expect(readout.speedFt).toBe(20);
    expect(readout.checkPenalty).toBe(6);
    expect(readout.maxDexBonus).toBe(1);
  });

  test("use the worse figure (armor or load) for each category; do not stack", () => {
    const load = encumbranceReadout({ strength: 10, size: "Medium", totalLb: 90, baseSpeedFt: 30 });
    // Chainmail: max Dex +2, ACP −5 (CRB Table 6-6). The load's −6 is worse; the armor's
    // +2 Dex cap is worse than the load's +1… no: +1 is worse (lower). Both come out worst.
    const merged = worseOfArmorAndLoad({ maxDexBonus: 2, checkPenalty: 5 }, load);
    expect(merged).toEqual({ maxDexBonus: 1, checkPenalty: 6 });
    // Full plate (max Dex +1, ACP −6) against a medium load (+3, −3): the armor wins both.
    const medium = encumbranceReadout({ strength: 10, size: "Medium", totalLb: 50, baseSpeedFt: 30 });
    expect(worseOfArmorAndLoad({ maxDexBonus: 1, checkPenalty: 6 }, medium)).toEqual({
      maxDexBonus: 1,
      checkPenalty: 6,
    });
  });

  test("an overloaded creature is named, not silently treated as heavy", () => {
    const readout = encumbranceReadout({ strength: 10, size: "Medium", totalLb: 250, baseSpeedFt: 30 });
    expect(readout.level).toBe("overloaded");
    expect(readout.issues.join(" ")).toMatch(/exceeds the heavy column \(100 lb\)/);
  });
});

describe("T3 — coins, weight and value", () => {
  test("fifty coins to the pound: 50 coins of any denomination are 1 lb", () => {
    expect(coinWeightLb({ pp: 0, gp: 50, sp: 0, cp: 0 })).toBe(1);
    expect(coinWeightLb({ pp: 1, gp: 0, sp: 0, cp: 0 })).toBe(0.02);
    // Mixed denominations still count as coins, not value.
    expect(coinWeightLb({ pp: 0, gp: 0, sp: 30, cp: 20 })).toBe(1);
    expect(coinWeightLb(null)).toBe(0);
  });

  test("currency reads pp/gp/sp/cp with garbage named", () => {
    expect(readCurrency({ pp: 1, gp: 2, sp: 3, cp: 4 }).currency).toEqual({ pp: 1, gp: 2, sp: 3, cp: 4 });
    const bad = readCurrency({ gp: "lots" });
    expect(bad.currency.gp).toBe(0);
    expect(bad.issues.join(" ")).toMatch(/currency.gp: not a number/);
  });

  test("carried weight = every carried item's stack weight + the coins", () => {
    const { items } = readInventoryItems([
      item({ quantity: 4, weight: 2 }, "Rations"),
      item({ quantity: 1, weight: 6 }, "Shield"),
      item({ quantity: 1, weight: 10, carried: false }, "Wagon"),
    ]);
    // 8 + 6 = 14 lb of goods, + 50 coins = 1 lb.
    expect(carriedWeightLb(items, { pp: 0, gp: 50, sp: 0, cp: 0 })).toBe(15);
  });

  test("value sums stacks and names the unpriced items instead of assuming 0 gp", () => {
    const { items } = readInventoryItems([
      item({ quantity: 3, value: 2 }, "Torch"),
      item({ weight: 1 }, "Trinket"),
    ]);
    const value = inventoryValueGp(items);
    expect(value.totalGp).toBe(6);
    expect(value.unpriced).toEqual(["Trinket"]);
  });
});

describe("T3 — items, containers and the worn armor entry", () => {
  test("the equipped armor/shield items become the worn entry (shield in its own slot)", () => {
    const { items } = readInventoryItems([
      item({ category: "armor", equipped: true, armor: { slot: "armor", armorBonus: 4, maxDexBonus: 4, checkPenalty: 2 } }, "Chain Shirt"),
      item({ category: "shield", equipped: true, armor: { slot: "shield", shieldBonus: 2, checkPenalty: 2 } }, "Heavy Steel Shield"),
      item({ category: "armor", equipped: false, armor: { slot: "armor", armorBonus: 6 } }, "Breastplate"),
    ]);
    const worn = equippedArmorEntry(items);
    expect(worn).not.toBeNull();
    expect(worn?.armorBonus).toBe(4);
    expect(worn?.shieldBonus).toBe(2);
    expect(worn?.maxDexBonus).toBe(4);
    // Armor and shield check penalties stack (they are separate pieces), so 2 + 2.
    expect(worn?.checkPenalty).toBe(4);
  });

  test("a shield alone is never read as armor (its bonus is a shield bonus)", () => {
    const { items } = readInventoryItems([
      item({ category: "equipment", equipped: true, armor: { slot: "shield", shieldBonus: 4 } }, "Tower Shield"),
    ]);
    const worn = equippedArmorEntry(items);
    // No armor item is worn, so the entry authors no armor bonus at all (the derivation keeps
    // whatever the actor's AC components say); the shield's bonus is its own.
    expect(worn?.armorBonus ?? 0).toBe(0);
    expect(worn?.shieldBonus).toBe(4);
  });

  test("a dwarf trait or an item flag can grant Slow and Steady", () => {
    const { items } = readInventoryItems([
      item({ equipped: true, slowAndSteady: true }, "Dwarven Boulder Helmet"),
    ]);
    expect(slowAndSteadyOf(items, [])).toBe(true);
    // The trait is matched by its exact rule name, case-insensitively — a trait list that
    // says something else is not read as the rule.
    expect(slowAndSteadyOf([], ["Slow and Steady"])).toBe(true);
    expect(slowAndSteadyOf([], ["slow and steady"])).toBe(true);
    expect(slowAndSteadyOf([], ["Darkvision"])).toBe(false);
    // …and an item only grants it while worn.
    const stowed = readInventoryItems([
      item({ equipped: true, slowAndSteady: true }, "Dwarven Boulder Helmet"),
    ]).items;
    expect(slowAndSteadyOf(stowed.map((i) => ({ ...i, equipped: false })), [])).toBe(false);
  });

  test("containers nest: an item inside a pack is a child, a dangling id is an orphan", () => {
    const { items } = readInventoryItems([
      item({ category: "container" }, "Backpack")._id
        ? { _id: "pack", type: "item", name: "Backpack", system: { category: "container" }, effects: [] }
        : {},
      { _id: "rope", type: "item", name: "Rope", system: { weight: 10, containerId: "pack" }, effects: [] },
      { _id: "lost", type: "item", name: "Lost", system: { containerId: "nowhere" }, effects: [] },
    ]);
    const tree = inventoryTree(items);
    // A dangling container id never hides its contents: the item renders at top level *and*
    // is named as an orphan.
    expect(tree.roots.map((n) => n.item.id)).toEqual(["pack", "lost"]);
    expect(tree.roots[0]?.children.map((c) => c.id)).toEqual(["rope"]);
    expect(tree.orphans.map((o) => o.id)).toEqual(["lost"]);
  });

  test("Muleback Cords' capacity-only Strength bonus is read from the item", () => {
    const { items } = readInventoryItems([
      item({ category: "equipment", equipped: true, capacityStrengthBonus: 8 }, "Muleback Cords"),
    ]);
    const capacity = carryingCapacityOf({
      strength: 10,
      size: "Medium",
      strengthForCapacity: items.length > 0 ? 8 : 0,
    });
    expect(capacity.effectiveStrength).toBe(18);
    expect(capacity.heavy).toBe(300);
  });
});

describe("T6 — consumables: charges, caster level and the item's own save DC", () => {
  test("the printed charge budgets: wand 50, staff 10, scroll 1, potion 1", () => {
    expect(CONSUMABLE_CHARGES).toEqual({ wand: 50, staff: 10, scroll: 1, potion: 1 });
  });

  test("wands default to caster level 5 (Craft Wand), staves to 8", () => {
    expect(CONSUMABLE_DEFAULT_CASTER_LEVEL.wand).toBe(5);
    expect(CONSUMABLE_DEFAULT_CASTER_LEVEL.staff).toBe(8);
  });

  test("a potion/scroll's caster level is the minimum for the spell's level (2·L−1, min 1)", () => {
    expect([1, 2, 3, 4, 5].map(minimumCasterLevel)).toEqual([1, 3, 5, 7, 9]);
    expect(minimumCasterLevel(0)).toBe(1);
  });

  test("the item's save DC is 10 + spell level + the minimum ability modifier", () => {
    // A wand of fireball (3rd level) is DC 14: 10 + 3 + 1 (a 13 is the minimum Int for 3rd).
    expect(consumableSaveDc(3)).toBe(14);
    expect(itemSpellDc(3)).toBe(14);
    // Level 1: 10 + 1 + 0 (an 11 is enough) = 11.
    expect(consumableSaveDc(1)).toBe(11);
    // Level 9: 10 + 9 + 4 (a 19) = 23.
    expect(consumableSaveDc(9)).toBe(23);
  });

  test("planConsumable builds the item the app writes: spell, charges and the item's CL", () => {
    const wand = planConsumable({ spell: { name: "Fireball", level: 3 }, kind: "wand" });
    expect(wand.name).toBe("Wand of Fireball");
    expect(wand.system.uses).toEqual({ value: 50, max: 50, per: "charges" });
    expect(wand.casterLevel).toBe(5);
    // Foundry's own item caster-level field, which the properties list reads.
    expect(wand.system.cl).toBe(5);
    expect(wand.system.category).toBe("consumable");
    const potion = planConsumable({ spell: { name: "Cure Light Wounds", level: 1 }, kind: "potion" });
    expect(potion.system.uses).toEqual({ value: 1, max: 1, per: "single" });
    // A potion/scroll's caster level is the minimum for the spell's level, not the wand's 5.
    expect(potion.casterLevel).toBe(1);
  });

  test("spendUse decrements and refuses in words: 0 charges is a refusal, not a negative", () => {
    const { items } = readInventoryItems([
      item({ category: "consumable", uses: { value: 2, max: 2, per: "charges" } }, "Wand"),
    ]);
    const wand = firstItem(items);
    const first = spendUse(wand);
    expect(first.ok).toBe(true);
    expect(first.uses).toEqual({ value: 1, max: 2, per: "charges" });
    const second = spendUse({ ...wand, uses: first.uses });
    expect(second.uses?.value).toBe(0);
    const third = spendUse({ ...wand, uses: second.uses });
    expect(third.ok).toBe(false);
    expect(third.error).toMatch(/out of charges/);
  });

  test("a recharge never passes the item's maximum (a staff refills, a wand's 50 is a cap)", () => {
    const { items } = readInventoryItems([
      item({ category: "consumable", uses: { value: 8, max: 10, per: "charges" } }, "Staff"),
    ]);
    const full = restoreUse(firstItem(items), 9);
    expect(full.uses?.value).toBe(10);
    expect(full.notes.join(" ")).toMatch(/is full \(10\)/);
  });

  test("an item with no charge ledger is not a consumable", () => {
    const { items } = readInventoryItems([item({ category: "equipment" }, "Rock")]);
    const outcome = spendUse(firstItem(items));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no charge ledger/);
  });

  test("itemCastSource reads a generated wand and reports its own DC and CL", () => {
    const plan = planConsumable({ spell: { name: "Fireball", level: 3, saveType: "ref", damageFormula: "5d6" }, kind: "wand" });
    const { items } = readInventoryItems([
      { _id: "wand-1", type: "item", name: plan.name, system: plan.system, effects: [] },
    ]);
    const read = itemCastSource(firstItem(items));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.source.kind).toBe("wand");
    expect(read.source.casterLevel).toBe(5);
    expect(read.source.saveDc).toBe(14);
    expect(read.source.charges).toBe(50);
    expect(read.source.itemId).toBe("wand-1");
  });

  test("the authored payload for a cast from a wand: ref save, half on a damage spell", () => {
    const authored = consumableCastAuthored({
      name: "Fireball",
      level: 3,
      saveType: "ref",
      damageFormula: "5d6",
    });
    expect(authored).toMatchObject({ saveType: "ref", severity: "half", damageFormula: "5d6" });
    const noSave = consumableCastAuthored({ name: "Magic Missile", level: 1 });
    expect(noSave.severity).toBe("none");
    const nonDamaging = consumableCastAuthored({ name: "Sleep", level: 1, saveType: "will" });
    expect(nonDamaging.severity).toBe("negates");
  });
});

describe("T6 — item → attack line (the converted weapon packs)", () => {
  // Exactly what `tools/convert/mappers.mjs` now writes for the pinned pf1-system Longsword
  // (CRB p.142: 1d8 slashing, 19–20/×2, martial, one-handed).
  const LONGSWORD = item(
    {
      category: "weapon",
      weapon: {
        class: "melee",
        handedness: "one-handed",
        proficiency: "martial",
        damageDice: "1d8",
        damageType: "slashing",
        critThreatMin: 19,
        critMultiplier: 2,
      },
      value: 15,
      weight: 4,
    },
    "Longsword",
  );

  test("a converted weapon produces an attack entry with the item's own numbers", () => {
    const { items } = readInventoryItems([LONGSWORD]);
    const entry = attackEntryFromWeapon({ item: firstItem(items), size: "Medium" });
    expect(entry).toMatchObject({
      name: "Longsword",
      itemId: "i-Longsword",
      ranged: false,
      damageDice: "1d8",
      damageType: "slashing",
      critThreatMin: 19,
      critMultiplier: 2,
      twoHanded: false,
    });
  });

  test("a two-handed reach weapon is two-handed and reaches 10 ft", () => {
    const { items } = readInventoryItems([
      item(
        {
          category: "weapon",
          weapon: {
            class: "melee",
            handedness: "two-handed",
            proficiency: "martial",
            damageDice: "1d10",
            critThreatMin: 20,
            critMultiplier: 2,
            reach: true,
          },
        },
        "Lucerne Hammer",
      ),
    ]);
    const entry = attackEntryFromWeapon({ item: firstItem(items), size: "Medium" });
    expect(entry.twoHanded).toBe(true);
    expect(entry.reachSquares).toBe(2);
  });

  test("a composite longbow is ranged with its range increment", () => {
    const { items } = readInventoryItems([
      item(
        {
          category: "weapon",
          weapon: {
            class: "projectile",
            handedness: "two-handed",
            damageDice: "1d8",
            critThreatMin: 20,
            critMultiplier: 3,
            rangeIncrementFt: 110,
          },
        },
        "Composite Longbow",
      ),
    ]);
    const entry = attackEntryFromWeapon({ item: firstItem(items), size: "Medium" });
    expect(entry.ranged).toBe(true);
    expect(entry.rangeIncrementFt).toBe(110);
    // A ranged weapon is never off-hand in the entry's terms.
    expect(entry.offHand).toBe(false);
  });

  test("only items with a weapon block are weapons", () => {
    const { items } = readInventoryItems([
      LONGSWORD,
      item({ category: "loot" }, "Abacus"),
      item({ category: "equipment", armor: { slot: "armor", armorBonus: 4 } }, "Chain Shirt"),
    ]);
    expect(weaponItemsOf(items).map((w) => w.item.name)).toEqual(["Longsword"]);
  });
});

/**
 * The converted packs' own shapes (plan §1.3 items 1/6). Each document below is a verbatim
 * copy of a `dist/content/pf1e/packs/**` row — the shape `tools/convert/mappers.mjs` writes —
 * because these are exactly the documents that reach the Items tab.
 */
describe("§1.3 — converted items read as themselves", () => {
  /** `wondrous.json` → `cloak-of-resistance-1`, verbatim (armor block, uses block, changes). */
  const CLOAK = {
    _id: "cloak-of-resistance-1",
    type: "item",
    name: "Cloak of Resistance +1",
    system: {
      category: "equipment",
      description: "Flecks of silver or steel are often sown amid the fabric of these cloaks.",
      armor: { armorBonus: 0, maxDexBonus: 0, checkPenalty: 0 },
      uses: { per: null, value: 0, maxFormula: "", autoDeductChargesCost: "1" },
      value: 1000,
      weight: 1,
      hp: 10,
      hardness: 0,
      foundry: {
        changes: [
          {
            _id: "uyhcp1t4",
            formula: "+1",
            operator: "add",
            subTarget: "allSavingThrows",
            modifier: "resist",
            priority: 0,
            value: 1,
          },
        ],
        quantity: 1,
        aura: { custom: true, school: "abjuration" },
        cl: 5,
      },
    },
    effects: [],
  };
  /** `armor-shields.json` → `chain-shirt`, verbatim. */
  const CHAIN_SHIRT = {
    _id: "chain-shirt",
    type: "item",
    name: "Chain Shirt",
    system: {
      category: "equipment",
      armor: { slot: "armor", proficiency: "light", armorBonus: 4, maxDexBonus: 4, checkPenalty: 2 },
      value: 100,
      weight: 25,
      hardness: 10,
    },
    effects: [],
  };

  test("an all-zero Foundry armor block is not armor (3,956 converted rows carry one)", () => {
    const cloak = firstItem(readInventoryItems([CLOAK]).items);
    // The block is the base-item artifact of a cloak: reading it as armor would print
    // "armor +0 · max Dex +0" and, with a slot, cap the wearer's Dexterity.
    expect(cloak.armor).toBeNull();
    expect(cloak.category).toBe("equipment");
    // …and it is not a charge ledger either (value 0, no max, no period).
    expect(cloak.uses).toBeNull();
    expect(cloak.casterLevel).toBe(5);
    expect(cloak.priceGp).toBe(1000);
    expect(cloak.weightLb).toBe(1);
    // The real armor row still reads as armor.
    const shirt = firstItem(readInventoryItems([CHAIN_SHIRT]).items);
    expect(shirt.armor?.armorBonus).toBe(4);
    expect(shirt.armor?.maxDexBonus).toBe(4);
    // An authored slot/proficiency is the author saying "armor", so zeros are kept as armor.
    const odd = firstItem(
      readInventoryItems([
        item({ armor: { slot: "armor", armorBonus: 0, maxDexBonus: 0 } }, "Placeholder"),
      ]).items,
    );
    expect(odd.armor?.slot).toBe("armor");
  });

  test("the cloak's converted changes[] reach the derivation once it is equipped", () => {
    // Worn: the converted row authors no `equipped` flag, so the sheet's Equip writes it.
    const wornShirt = { ...CHAIN_SHIRT, system: { ...CHAIN_SHIRT.system, equipped: true } };
    const heroWith = (cloakEquipped: boolean): ActorDocument =>
      ({
        _id: "a-hero",
        type: "actor",
        name: "Hero",
        ownership: { default: 3 },
        flags: {},
        system: {
          pf1e: {
            abilities: { dex: 14, con: 10 },
            baseAttack: 1,
            hp: 10,
            hpMax: 10,
            landSpeedFt: 30,
          },
        },
        items: [wornShirt, { ...CLOAK, system: { ...CLOAK.system, equipped: cloakEquipped } }],
        effects: [],
      }) as unknown as ActorDocument;

    // Chain Shirt worn ⇒ AC 10 + armor 4 + Dex 2; the cloak is carried, so it does nothing yet.
    const bare = deriveFromActorDocument(heroWith(false), {});
    expect(bare.ac.normal).toBe(16);
    expect(bare.ac.touch).toBe(12);
    expect(bare.ac.flatFooted).toBe(14);
    expect(bare.saves).toEqual({ fort: 0, ref: 2, will: 0 });

    // Equipped, the converted `changes[]` block (allSavingThrows / resist / +1) derives: a
    // +1 resistance bonus on every save, from the item's own active effect.
    const worn = deriveFromActorDocument(heroWith(true), {});
    expect(worn.saves).toEqual({ fort: 1, ref: 3, will: 1 });
    expect(worn.effectBreakdown.saves).toBe("+1 (resistance)");
    expect(worn.effects.map((e) => e.id)).toContain("item:cloak-of-resistance-1");
    // …and its zero armor block does not cap Dexterity: the AC is unchanged.
    expect(worn.ac.normal).toBe(16);
    expect(worn.ac.touch).toBe(12);
    expect(worn.speedFt).toBe(30);
  });
});

describe("§1.3 — importing a world item onto an actor", () => {
  const hero = {
    _id: "a-hero",
    type: "actor",
    name: "Hero",
    ownership: { default: 3 },
    flags: {},
    system: { pf1e: {} },
    items: [],
    effects: [],
  } as unknown as ActorDocument;

  test("the picker rows carry the inventory reading of each world item", () => {
    const rows = worldItemRows([
      {
        _id: "longsword",
        type: "item",
        name: "Longsword",
        system: {
          category: "weapon",
          weapon: { class: "melee", damageDice: "1d8" },
          value: 15,
          weight: 4,
        },
        effects: [],
      },
      { _id: "junk", type: "actor", name: "Not an item" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "longsword",
      name: "Longsword",
      category: "weapon",
      weightLb: 4,
      priceGp: 15,
    });
  });

  test("adding one embeds a copy: a create op with the actor as parent, id preserved", () => {
    const world = {
      _id: "longsword",
      type: "item",
      name: "Longsword",
      ownership: { default: 0 },
      flags: { pf1e: { pack: "PF1e Weapons & Ammo" } },
      system: { category: "weapon", weapon: { class: "melee" }, value: 15, weight: 4 },
      effects: [],
    };
    const built = addWorldItemOp(hero, world);
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.op).toMatchObject({
      kind: "create",
      coll: "items",
      parent: { coll: "actors", id: "a-hero" },
    });
    const data = built.op.kind === "create" ? built.op.data : null;
    expect(data?._id).toBe("longsword");
    expect(data?.flags).toMatchObject({ pf1e: { pack: "PF1e Weapons & Ammo", importedFrom: "longsword" } });
    expect(built.row.name).toBe("Longsword");
  });

  test("a collision and a non-item document are refused with a reason", () => {
    const withSword = { ...hero, items: [{ _id: "longsword", type: "item", name: "Longsword" }] } as unknown as ActorDocument;
    const world = { _id: "longsword", type: "item", name: "Longsword", system: {} };
    const clash = addWorldItemOp(withSword, world);
    expect("error" in clash && clash.error).toBe('"Longsword" is already on Hero.');
    const notItem = addWorldItemOp(hero, { _id: "x", type: "actor", name: "Goblin" });
    expect("error" in notItem && notItem.error).toBe('"Goblin" is not an item document.');
    const nameless = addWorldItemOp(hero, { _id: "", type: "item", name: "" });
    expect("error" in nameless && nameless.error).toBe("That imported item has no id or name.");
  });
});
