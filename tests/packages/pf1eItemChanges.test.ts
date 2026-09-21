/**
 * **C1 corpus** — the `changes[]` fixture set (plan §1.3 item 6, `tools/adopt/README.md`).
 *
 * C1 is defined as "golden converted items that must derive the same stats". This file is the
 * corpus for the *mechanic* half of that promise: each fixture is a real converted item — its
 * `changes[]` copied from the pinned packs, with the pack and the item name in the fixture —
 * and the assertion is that the mods reach `deriveFromActorDocument` and land on the numbers
 * the printed item promises.
 *
 * Two rules the fixtures enforce, both from the design:
 *
 * - **D-112**: no path-overwrite mechanic. A `set` operator is refused *by name*; a formula
 *   this mapper cannot evaluate (a reference, an expression) is refused with its reason. The
 *   fixture set therefore also pins what is *not* applied, so an item can never quietly do
 *   nothing.
 * - **The mapped subset is deliberate**: the targets the PF1e system actually publishes
 *   (`ac`, `allSavingThrows`, `skill.per`, `str`, `landSpeed`, …) and the full-path spellings
 *   of the same concepts. Anything else is listed in `unmapped` for the item window.
 *
 * Sources of the 248-item `/ 416-change` corpus: the 28 converted packs in
 * `dist/content/pf1e/packs` (see `REPORT.md`, "system.changes (carried raw)"). The fixtures
 * below sample that corpus by shape: a resistance cloak (saves), an enhancement to AC, a skill
 * item (short `skill.<code>` target), a belt (ability score), boots (speed), a natural-armor
 * amulet (`nac`), a morale bonus to attack, and the refusal cases.
 */
import { describe, expect, test } from "vitest";
import { deriveFromActorDocument } from "../../src/packages/pf1e/actor";
import { actorItemEffects, itemChangeReport, itemChangesToMods } from "../../src/packages/pf1e/itemChanges";
import { readInventoryItems, type PF1eInventoryItem } from "../../src/packages/pf1e/inventory";
import { resolveTacticalEffects } from "../../src/packages/pf1e/effectOps";

/** The single read item, asserted present (an empty read is a failure, not a crash). */
function firstItem(items: readonly PF1eInventoryItem[]): PF1eInventoryItem {
  const [item] = items;
  expect(item).toBeDefined();
  return item as PF1eInventoryItem;
}

/** A converted item document: `system` exactly as the pack writes it (id aside). */
function convertedItem(
  name: string,
  system: Record<string, unknown>,
): Record<string, unknown> {
  return { _id: `c1-${name.toLowerCase().replace(/\W+/g, "-")}`, type: "item", name, system, effects: [] };
}

/** The actor the fixtures derive against: a 10s-across human with no authored armor. */
function actorWithItems(items: Array<Record<string, unknown>>): {
  system: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
} {
  return {
    system: {
      pf1e: {
        abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 },
        baseAttack: 1,
        hpMax: 10,
        hitDice: 1,
      },
    },
    items,
  };
}

describe("C1 — the converted `changes[]` corpus reaches the derivation", () => {
  test("Cloak of Resistance +1 (wondrous): +1 resistance on all saving throws", () => {
    // `dist/content/pf1e/packs/wondrous.json` → "Cloak of Resistance +1":
    //   foundry.changes: [{ _id, formula: "+1", operator: "add", subTarget: "allSavingThrows",
    //                       modifier: "resist", priority: 0, value: 1 }]
    const cloak = convertedItem("Cloak of Resistance +1", {
      category: "equipment",
      equipped: true,
      weight: 1,
      value: 1000,
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
        cl: 5,
      },
    });
    const actor = actorWithItems([cloak]);
    const derived = deriveFromActorDocument(actor, { encumbranceRule: "weight" });
    // No class levels are authored, so the base save is 0 and the +1 resistance is the whole
    // story on Fortitude and Will; Reflex adds the +2 Dexterity.
    expect(derived.saves.fort).toBe(1);
    expect(derived.saves.ref).toBe(3);
    expect(derived.saves.will).toBe(1);
    // The mod is typed *resistance*, so the sheet can show its work and the effect list names
    // the item it came from. (Foundry spells the type `resist`; the SRD calls it resistance.)
    expect(derived.effectBreakdown.saves).toBe("+1 (resistance)");
    expect(derived.effects.map((e) => e.id)).toContain("item:c1-cloak-of-resistance-1");
  });

  test("a change is not applied while the item is not equipped, and says so", () => {
    const cloak = convertedItem("Cloak of Resistance +1", {
      category: "equipment",
      equipped: false,
      foundry: { changes: [{ formula: "+1", operator: "add", subTarget: "allSavingThrows", modifier: "resist" }] },
    });
    const derived = deriveFromActorDocument(actorWithItems([cloak]), {});
    expect(derived.saves.fort).toBe(0);
    const { items } = readInventoryItems([cloak]);
    expect(itemChangeReport(firstItem(items)).notes.join(" ")).toMatch(/Not equipped/);
  });

  test("Amulet of Natural Armor +1 (`nac`): +1 normal and flat-footed AC, never touch", () => {
    // The short `nac` spelling is what the pf1 system publishes for natural armor; a change
    // must not be folded into the general AC bonus, or touch AC would be wrong.
    const amulet = convertedItem("Amulet of Natural Armor +1", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+1", operator: "add", subTarget: "nac", modifier: "enh" }] },
    });
    const derived = deriveFromActorDocument(actorWithItems([amulet]), {});
    // 10 + Dex 2 (no armor authored): normal 13, touch 12, flat-footed 11 — plus natural 1 on
    // normal and flat-footed only.
    expect(derived.ac).toEqual({ normal: 13, touch: 12, flatFooted: 11 });
    expect(derived.explain.ac).toMatch(/natural/);
  });

  test("Ring of Protection +2 (magic-items): +2 deflection to AC and to touch", () => {
    const ring = convertedItem("Ring of Protection +2", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+2", operator: "add", subTarget: "ac", modifier: "deflection" }] },
    });
    const derived = deriveFromActorDocument(actorWithItems([ring]), {});
    // A general AC bonus applies to all three figures (A.2). Natural armor would not: that
    // is the case above, and it is why the two have separate keys.
    expect(derived.ac).toEqual({ normal: 14, touch: 14, flatFooted: 12 });
  });

  test("Eyes of the Eagle (items): the short `skill.per` target reads as Perception", () => {
    // `dist/content/pf1e/packs/items.json`-style item: `subTarget: "skill.per"` — the pf1
    // system's three-letter skill code, mapped through `FOUNDRY_SKILL_CODES`.
    const eyes = convertedItem("Eyes of the Eagle", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+5", operator: "add", subTarget: "skill.per", modifier: "competence" }] },
    });
    const derived = deriveFromActorDocument(actorWithItems([eyes]), {});
    const perception = derived.skills.perception;
    // 0 ranks + Wis 0 + the item's +5 competence.
    expect(perception?.total).toBe(5);
    expect(perception?.effectBonus).toBe(5);
  });

  test("Belt of Giant Strength +2 (`str`): the score rises, and every Str statistic with it", () => {
    const belt = convertedItem("Belt of Giant Strength +2", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+2", operator: "add", subTarget: "str", modifier: "enh" }] },
    });
    const derived = deriveFromActorDocument(actorWithItems([belt]), {});
    expect(derived.abilities.str).toBe(12);
    expect(derived.abilityMods.str).toBe(1);
    // CMB = BAB 1 + Str 1 + size 0 (A.9).
    expect(derived.cmb).toBe(2);
  });

  test("Boots of Striding and Springing (`landSpeed`): the base speed moves +10 ft", () => {
    const boots = convertedItem("Boots of Striding and Springing", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+10", operator: "add", subTarget: "landSpeed", modifier: "untyped" }] },
    });
    const plain = deriveFromActorDocument(actorWithItems([]), {});
    const booted = deriveFromActorDocument(actorWithItems([boots]), {});
    expect(plain.speedFt).toBe(30);
    expect(booted.speedFt).toBe(40);
  });

  test("a morale bonus to attack (`mattack`) reaches the melee attack line", () => {
    const sword = convertedItem("Blessed Oil", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+1", operator: "add", subTarget: "mattack", modifier: "morale" }] },
    });
    // A line has to be authored for the +1 to land on: the item's mod rides the same
    // resolver as a spell's morale bonus would, and the line's own explain stays the
    // ability/size arithmetic.
    const system = {
      pf1e: {
        abilities: { str: 12, dex: 14, con: 10, int: 10, wis: 10, cha: 10 },
        baseAttack: 1,
        hpMax: 10,
        attacks: [
          { name: "Longsword", ranged: false, damageDice: "1d8", critThreatMin: 19, critMultiplier: 2 },
        ],
      },
    };
    const plain = deriveFromActorDocument({ system, items: [] }, {});
    const blessed = deriveFromActorDocument({ system, items: [sword] }, {});
    // +1 (Str) + 1 (BAB) either way; the morale bonus is the difference.
    expect(plain.attacks[0]?.attackBonus).toBe(2);
    expect(blessed.attacks[0]?.attackBonus).toBe(3);
    expect(blessed.effectBreakdown.attackMelee).toBe("+1 (morale)");
  });

  test("the full-path spellings of the same concepts map too (pf1e-content shape)", () => {
    const item = convertedItem("Cloak of the Bat", {
      category: "equipment",
      equipped: true,
      foundry: {
        changes: [
          { formula: "2", operator: "+", target: "system.attributes.ac.flat", modifier: "luck" },
          { formula: "1", operator: "add", target: "system.attributes.savingThrows.will.total", modifier: "luck" },
          { formula: "3", operator: "add", target: "system.skills.ste.mod", modifier: "competence" },
        ],
      },
    });
    const derived = deriveFromActorDocument(actorWithItems([item]), {});
    expect(derived.ac.normal).toBe(14);
    expect(derived.saves.will).toBe(1);
    // Stealth: 0 ranks + Dex +2 + the item's +3 competence.
    expect(derived.skills.stealth?.total).toBe(5);
    expect(derived.skills.stealth?.effectBonus).toBe(3);
  });

  test("stacking: two items of the same bonus type keep the best, not the sum", () => {
    const one = convertedItem("Cloak of Resistance +1", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+1", operator: "add", subTarget: "allSavingThrows", modifier: "resist" }] },
    });
    const three = convertedItem("Cloak of Resistance +3", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+3", operator: "add", subTarget: "allSavingThrows", modifier: "resist" }] },
    });
    const both = deriveFromActorDocument(actorWithItems([one, three]), {});
    expect(both.saves.fort).toBe(3); // the better resistance bonus, never +1 +3
    const single = deriveFromActorDocument(actorWithItems([one]), {});
    expect(single.saves.fort).toBe(1);
  });

  test("an unequipped item's mods are not in the effect list at all", () => {
    const stowed = convertedItem("Cloak of Resistance +1", {
      category: "equipment",
      equipped: false,
      foundry: { changes: [{ formula: "+1", operator: "add", subTarget: "allSavingThrows", modifier: "resist" }] },
    });
    expect(actorItemEffects([stowed])).toEqual([]);
    expect(resolveTacticalEffects(actorItemEffects([stowed])).mods.saves).toBeUndefined();
  });

  test("a consumable's changes never ride the actor while it is carried", () => {
    const potion = convertedItem("Potion of Heroism", {
      category: "consumable",
      equipped: true,
      foundry: { changes: [{ formula: "+2", operator: "add", subTarget: "allSavingThrows", modifier: "morale" }] },
    });
    const derived = deriveFromActorDocument(actorWithItems([potion]), {});
    expect(derived.saves.fort).toBe(0);
    expect(derived.effects).toEqual([]);
  });
});

describe("C1 — what is deliberately *not* applied (D-112, and the honest refusals)", () => {
  test("a `set` operator is refused by name: no path overwrite exists in this engine", () => {
    const outcome = itemChangesToMods(
      [{ formula: "20", operator: "set", target: "system.attributes.ac.flat", type: "untyped" }],
      "Cursed Armor",
    );
    expect(outcome.mods).toEqual([]);
    expect(outcome.unmapped[0]?.reason).toMatch(/`set` overwrites a path/);
  });

  test("a formula the mapper cannot evaluate is named, never guessed at", () => {
    const outcome = itemChangesToMods(
      [{ formula: "@abilities.str.mod", operator: "add", target: "attack", type: "untyped" }],
      "Belt",
    );
    expect(outcome.mods).toEqual([]);
    expect(outcome.unmapped[0]?.reason).toMatch(/not a plain number/);
  });

  test("an unknown target is refused with its own path in the message", () => {
    const outcome = itemChangesToMods(
      [{ formula: "1", operator: "add", target: "system.attributes.hd.total", type: "untyped" }],
      "Odd Item",
    );
    expect(outcome.unmapped[0]).toMatchObject({ target: "system.attributes.hd.total" });
    expect(outcome.unmapped[0]?.reason).toMatch(/no mapping for this path/);
  });

  test("a sub-skill path the app has no key for is refused, not approximated", () => {
    const outcome = itemChangesToMods(
      [{ formula: "2", operator: "add", target: "skill.crf.subSkills.crf1", type: "untyped" }],
      "Odd Tool",
    );
    expect(outcome.mods).toEqual([]);
    expect(outcome.unmapped[0]?.reason).toMatch(/no mapping for this path/);
  });

  test("an unknown bonus type is applied as untyped, and the promotion is noted", () => {
    const outcome = itemChangesToMods(
      [{ formula: "2", operator: "add", target: "ac", type: "weirdness" }],
      "Strange Ring",
    );
    expect(outcome.mods[0]).toMatchObject({ key: "ac", type: "untyped", value: 2 });
    expect(outcome.notes.join(" ")).toMatch(/bonus type "weirdness" is unknown/);
  });

  test("`subtract` negates the formula, and the mapped subset keeps its bonus types", () => {
    const outcome = itemChangesToMods(
      [
        { formula: "2", operator: "subtract", target: "ac", type: "penalty" },
        { formula: "4", operator: "add", target: "skill.ste", modifier: "competence" },
      ],
      "Cursed Boots",
    );
    expect(outcome.mods).toEqual([
      { key: "ac", type: "untyped", value: -2, source: "Cursed Boots" },
      { key: "skill.stealth", type: "competence", value: 4, source: "Cursed Boots" },
    ]);
  });

  test("a scripted item is described, and its script count is reported", () => {
    const item = convertedItem("Scripted Widget", {
      category: "equipment",
      equipped: true,
      scriptCalls: [{ name: "onUse" }, { name: "onEquip" }],
      foundry: { changes: [{ formula: "+1", operator: "add", subTarget: "ac", modifier: "untyped" }] },
    });
    const { items } = readInventoryItems([item]);
    const report = itemChangeReport(firstItem(items));
    expect(report.hasScriptCalls).toBe(true);
    expect(report.notes.join(" ")).toMatch(/2 scripted call\(s\) were dropped/);
    // The passive half still applies — the description and the mechanic are not exclusive.
    expect(deriveFromActorDocument(actorWithItems([item]), {}).ac.normal).toBe(13);
  });

  test("the item effect carries the item as its source, so a reader can name it", () => {
    const cloak = convertedItem("Cloak of Resistance +1", {
      category: "equipment",
      equipped: true,
      foundry: { changes: [{ formula: "+1", operator: "add", subTarget: "allSavingThrows", modifier: "resist" }] },
    });
    const effects = actorItemEffects([cloak]);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.id).toBe("item:c1-cloak-of-resistance-1");
    expect(effects[0]?.payload.source).toEqual({ kind: "item", id: "c1-cloak-of-resistance-1" });
  });
});
