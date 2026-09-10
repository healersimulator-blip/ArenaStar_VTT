import { describe, expect, test } from "vitest";
import {
  applyMitigation,
  damageComponentsFromRoll,
  drAttackFacts,
  drBypasses,
  type PF1eDamageComponent,
  type PF1eDrAttackFacts,
} from "../../src/packages/pf1e/mitigation";
import { resolveDamageRoll } from "../../src/packages/pf1e/tactical";
import { resolvePF1eWeapon } from "../../src/packages/pf1e/weapons";

function facts(overrides: Partial<PF1eDrAttackFacts> = {}): PF1eDrAttackFacts {
  return {
    enhancementBonus: 0,
    effectiveBonusTotal: 0,
    material: "none",
    alignment: [],
    damageType: "slashing",
    ...overrides,
  };
}

function physical(amount: number, extra: Partial<PF1eDamageComponent> = {}) {
  return {
    label: "weapon damage",
    amount,
    kind: "physical" as const,
    ...extra,
  };
}

function energy(
  amount: number,
  type: "acid" | "cold" | "electricity" | "fire" | "sonic",
  extra: Partial<PF1eDamageComponent> = {},
) {
  return {
    label: `${type} rider`,
    amount,
    kind: "energy" as const,
    energyType: type,
    ...extra,
  };
}

describe("overcoming DR: the bypass ladder (CRB p.561, AoN Rules ID 424)", () => {
  test("DR/magic needs a +1 weapon; DR/— is bypassed by nothing", () => {
    const dr5magic = { value: 5, bypass: ["magic"] };
    expect(drBypasses(dr5magic, facts())).toMatchObject({
      bypassed: false,
      via: null,
    });
    expect(drBypasses(dr5magic, facts({ enhancementBonus: 1 }))).toMatchObject({
      bypassed: true,
      via: "+1 enhancement (magic)",
    });
    const dr5dash = { value: 5, bypass: [] };
    expect(
      drBypasses(
        dr5dash,
        facts({ enhancementBonus: 5, material: "adamantine" }),
      ),
    ).toMatchObject({ bypassed: false });
    expect(
      drBypasses({ value: 5, bypass: ["—"] }, facts({ enhancementBonus: 5 })),
    ).toMatchObject({
      bypassed: false,
    });
  });

  test("materials bypass their own DR; the ladder substitutes at +3 cold iron/silver, +4 adamantine, +5 alignment", () => {
    const coldIron = { value: 10, bypass: ["cold iron"] };
    expect(
      drBypasses(coldIron, facts({ material: "cold iron" })),
    ).toMatchObject({
      bypassed: true,
      via: "cold iron",
    });
    expect(drBypasses(coldIron, facts({ enhancementBonus: 3 }))).toMatchObject({
      bypassed: true,
      via: "+3 enhancement (cold iron)",
    });
    expect(drBypasses(coldIron, facts({ enhancementBonus: 2 }))).toMatchObject({
      bypassed: false,
    });
    const silver = { value: 10, bypass: ["silver"] };
    expect(drBypasses(silver, facts({ enhancementBonus: 3 }))).toMatchObject({
      bypassed: true,
    });
    const adamantine = { value: 10, bypass: ["adamantine"] };
    expect(
      drBypasses(adamantine, facts({ enhancementBonus: 4 })),
    ).toMatchObject({
      bypassed: true,
      via: "+4 enhancement (adamantine — hardness is not ignored)",
    });
    expect(
      drBypasses(adamantine, facts({ enhancementBonus: 3 })),
    ).toMatchObject({
      bypassed: false,
    });
    const good = { value: 10, bypass: ["good"] };
    expect(drBypasses(good, facts({ alignment: ["good"] }))).toMatchObject({
      bypassed: true,
      via: "good",
    });
    expect(drBypasses(good, facts({ enhancementBonus: 5 }))).toMatchObject({
      bypassed: true,
      via: "+5 enhancement (good)",
    });
    expect(drBypasses(good, facts({ enhancementBonus: 4 }))).toMatchObject({
      bypassed: false,
    });
  });

  test("DR/epic: +6 enhancement OR +6 total effective — special abilities count only here (Bestiary UMR + Mythic)", () => {
    const epic = { value: 10, bypass: ["epic"] };
    // A +5 flaming weapon is effective +6: NOT epic-ladder bypass via enhancement…
    expect(
      drBypasses(epic, facts({ enhancementBonus: 5, effectiveBonusTotal: 6 })),
    ).toMatchObject({ bypassed: true, via: "total effective bonus +6 (epic)" });
    expect(drBypasses(epic, facts({ enhancementBonus: 6 }))).toMatchObject({
      bypassed: true,
      via: "+6 enhancement (epic)",
    });
    expect(
      drBypasses(epic, facts({ enhancementBonus: 5, effectiveBonusTotal: 5 })),
    ).toMatchObject({ bypassed: false });
    // The special-ability total never feeds the +3/+4/+5 ladder.
    const coldIron = { value: 10, bypass: ["cold iron"] };
    expect(
      drBypasses(
        coldIron,
        facts({ enhancementBonus: 1, effectiveBonusTotal: 6 }),
      ),
    ).toMatchObject({ bypassed: false });
  });

  test("damage-type DR matches the weapon's type; compound bypass is an OR list; tokens are case/hyphen-insensitive", () => {
    const bludgeoning = { value: 5, bypass: ["bludgeoning"] };
    expect(
      drBypasses(bludgeoning, facts({ damageType: "bludgeoning" })),
    ).toMatchObject({
      bypassed: true,
      via: "bludgeoning",
    });
    expect(
      drBypasses(bludgeoning, facts({ damageType: "slashing" })),
    ).toMatchObject({
      bypassed: false,
    });
    const compound = { value: 5, bypass: ["piercing or slashing"] };
    expect(
      drBypasses(compound, facts({ damageType: "slashing" })),
    ).toMatchObject({
      bypassed: true,
      via: "slashing",
    });
    expect(
      drBypasses(compound, facts({ damageType: "bludgeoning" })),
    ).toMatchObject({
      bypassed: false,
    });
    const materialOrAlignment = { value: 10, bypass: ["cold iron or good"] };
    expect(
      drBypasses(materialOrAlignment, facts({ alignment: ["good"] })),
    ).toMatchObject({ bypassed: true, via: "good" });
    expect(drBypasses(materialOrAlignment, facts())).toMatchObject({
      bypassed: false,
    });
    expect(drBypasses({ value: 5, bypass: ["vorpal"] }, facts())).toMatchObject(
      {
        bypassed: false,
        notes: [
          'DR bypass condition "vorpal" is not a modeled token — it never bypasses here; known: magic, cold iron, silver, adamantine, epic, good, evil, lawful, chaotic, slashing, piercing, bludgeoning, —',
        ],
      },
    );
    expect(
      drBypasses(
        { value: 5, bypass: ["Piercing", "Slashing"] },
        facts({ damageType: "slashing" }),
      ),
    ).toMatchObject({ bypassed: true, via: "slashing" });
    expect(
      drBypasses(
        { value: 5, bypass: ["Cold-Iron"] },
        facts({ material: "cold iron" }),
      ),
    ).toMatchObject({ bypassed: true });
  });

  test("ammunition: a +1+ launcher makes the ammo magic and transfers alignment, but never the +3/+4/+5 ladder (CRB p.561)", () => {
    const arrow = resolvePF1eWeapon({
      name: "Arrow",
      class: "projectile",
      handedness: "light",
      proficiency: "simple",
      damageDice: "1d8",
      damageType: "piercing",
    }).weapon;
    const plus3Bow = resolvePF1eWeapon({
      name: "Longbow",
      class: "projectile",
      handedness: "two-handed",
      proficiency: "martial",
      damageDice: "1d8",
      damageType: "piercing",
      rangeIncrementFt: 100,
      enhancementBonus: 3,
      alignment: ["good"],
    }).weapon;
    const shotFacts = drAttackFacts(arrow, {
      enhancementBonus: plus3Bow.enhancementBonus,
      alignment: plus3Bow.alignment,
    });
    // Magic: yes (fired from a +3 bow).
    expect(
      drBypasses({ value: 5, bypass: ["magic"] }, shotFacts),
    ).toMatchObject({
      bypassed: true,
      via: "magic ammunition (fired from a +1 or higher projectile weapon)",
    });
    // Alignment transfers to the ammunition.
    expect(
      drBypasses({ value: 10, bypass: ["good"] }, shotFacts),
    ).toMatchObject({
      bypassed: true,
      via: "good",
    });
    // The +3 bow's enhancement does NOT put the arrow on the cold-iron ladder.
    expect(
      drBypasses({ value: 10, bypass: ["cold iron"] }, shotFacts),
    ).toMatchObject({ bypassed: false });
    // The ammunition's OWN enhancement does.
    const plus3Arrow = resolvePF1eWeapon({
      name: "Arrow +3",
      class: "projectile",
      handedness: "light",
      proficiency: "simple",
      damageDice: "1d8",
      damageType: "piercing",
      enhancementBonus: 3,
    }).weapon;
    expect(
      drBypasses(
        { value: 10, bypass: ["cold iron"] },
        drAttackFacts(plus3Arrow, { enhancementBonus: 0 }),
      ),
    ).toMatchObject({ bypassed: true, via: "+3 enhancement (cold iron)" });
  });
});

describe("applying DR (CRB p.561)", () => {
  test("DR subtracts once from the combined physical total — precision included (D-129)", () => {
    const result = applyMitigation({
      attack: facts(),
      components: [
        physical(10),
        {
          label: "sneak attack 2d6",
          amount: 9,
          kind: "physical",
          precision: true,
        },
      ],
      defender: { dr: [{ value: 5, bypass: [] }] },
    });
    expect(result).toMatchObject({
      ok: true,
      lethal: 14,
      nonlethal: 0,
      drApplied: 5,
      physicalDamageNegated: false,
    });
  });

  test("DR bypassed by the ladder deals full damage and names the route", () => {
    const result = applyMitigation({
      attack: facts({ enhancementBonus: 3 }),
      components: [physical(12)],
      defender: { dr: [{ value: 10, bypass: ["cold iron"] }] },
    });
    expect(result).toMatchObject({
      ok: true,
      lethal: 12,
      drApplied: 0,
      drBypassedVia: "+3 enhancement (cold iron)",
    });
  });

  test("energy riders ignore DR entirely; energy drains and touch attacks are DR-irrelevant by construction", () => {
    const result = applyMitigation({
      attack: facts(),
      components: [physical(6), energy(7, "fire")],
      defender: { dr: [{ value: 10, bypass: [] }] },
    });
    expect(result).toMatchObject({ ok: true, lethal: 7, drApplied: 6 });
    if (result.ok) {
      expect(result.components).toEqual([
        {
          label: "weapon damage",
          dealt: 0,
          nonlethal: false,
          kind: "physical",
        },
        { label: "fire rider", dealt: 7, nonlethal: false, kind: "energy" },
      ]);
    }
  });

  test("DR completely negating the damage negates injury riders — and can negate the minimum 1 nonlethal", () => {
    const negated = applyMitigation({
      attack: facts(),
      components: [physical(4)],
      defender: { dr: [{ value: 10, bypass: [] }] },
    });
    expect(negated).toMatchObject({
      ok: true,
      lethal: 0,
      drApplied: 4,
      physicalDamageNegated: true,
    });
    if (negated.ok) {
      expect(
        negated.notes.some((n) =>
          n.includes("injury poison, stunning and injury-based disease"),
        ),
      ).toBe(true);
    }
    const minimum = applyMitigation({
      attack: facts(),
      components: [physical(1, { nonlethal: true })],
      defender: { dr: [{ value: 5, bypass: [] }] },
    });
    expect(minimum).toMatchObject({ ok: true, nonlethal: 0, lethal: 0 });
  });

  test("multiple DR entries never stack — the best applies in this situation", () => {
    const result = applyMitigation({
      attack: facts({ enhancementBonus: 1 }),
      components: [physical(20)],
      defender: {
        dr: [
          { value: 5, bypass: ["magic"] }, // bypassed
          { value: 10, bypass: ["good"] }, // not bypassed — applies
        ],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      lethal: 10,
      drApplied: 10,
      drBypassedVia: null,
    });
  });

  test("DR applies to nonlethal damage; a mixed attack loses the lethal bucket first (named choice)", () => {
    const result = applyMitigation({
      attack: facts(),
      components: [
        physical(6),
        {
          label: "merciful rider",
          amount: 4,
          kind: "physical",
          nonlethal: true,
        },
      ],
      defender: { dr: [{ value: 8, bypass: [] }] },
    });
    expect(result).toMatchObject({
      ok: true,
      lethal: 0,
      nonlethal: 2,
      drApplied: 8,
    });
  });
});

describe("energy resistance, immunity, vulnerability (CRB p.563 + Bestiary UMR)", () => {
  test("resistance subtracts once per attack per type, across components", () => {
    const result = applyMitigation({
      attack: facts(),
      components: [energy(6, "fire"), energy(8, "fire"), energy(5, "cold")],
      defender: { energyResistance: { fire: 10 } },
    });
    expect(result).toMatchObject({
      ok: true,
      lethal: 4 + 5,
      erApplied: { fire: 10 },
    });
  });

  test("immunity drops the typed components entirely", () => {
    const result = applyMitigation({
      attack: facts(),
      components: [energy(20, "fire"), energy(5, "cold")],
      defender: { immuneEnergy: ["fire"] },
    });
    expect(result).toMatchObject({ ok: true, lethal: 5 });
    if (result.ok) {
      expect(result.notes.some((n) => n.includes("immunity to fire"))).toBe(
        true,
      );
    }
  });

  test("vulnerability is +50% (floored) applied before resistance (D-138)", () => {
    // 30 fire, vulnerable: 45; resist 10: 35.
    const result = applyMitigation({
      attack: facts(),
      components: [energy(30, "fire")],
      defender: {
        vulnerableEnergy: ["fire"],
        energyResistance: { fire: 10 },
      },
    });
    expect(result).toMatchObject({ ok: true, lethal: 35 });
    // 25 fire, vulnerable: 37 (floor of 37.5); no resistance.
    const odd = applyMitigation({
      attack: facts(),
      components: [energy(25, "fire")],
      defender: { vulnerableEnergy: ["fire"] },
    });
    expect(odd).toMatchObject({ ok: true, lethal: 37 });
  });
});

describe("object hardness (CRB p.173, AoN Rules ID 126)", () => {
  test("hardness subtracts once per attack; only excess damages the object", () => {
    const result = applyMitigation({
      attack: facts(),
      components: [physical(12)],
      defender: { object: { hardness: 10 } },
    });
    expect(result).toMatchObject({
      ok: true,
      lethal: 2,
      hardnessApplied: 10,
    });
  });

  test("energy and ranged-weapon damage halve (floored) before hardness", () => {
    // 20 fire → 10 vs the object → hardness 10 ⇒ 0.
    const energyHit = applyMitigation({
      attack: facts(),
      components: [energy(20, "fire")],
      defender: { object: { hardness: 10 } },
    });
    expect(energyHit).toMatchObject({
      ok: true,
      lethal: 0,
      hardnessApplied: 10,
    });
    // 15 slashing from a ranged weapon → 7 → hardness 5 ⇒ 2.
    const rangedHit = applyMitigation({
      attack: facts(),
      components: [physical(15)],
      defender: { object: { hardness: 5 } },
      rangedWeaponAgainstObject: true,
    });
    expect(rangedHit).toMatchObject({
      ok: true,
      lethal: 2,
      hardnessApplied: 5,
    });
  });

  test("an actual adamantine weapon ignores hardness; the +4 enhancement equivalent does not (CRB p.561 footnote)", () => {
    const adamantine = applyMitigation({
      attack: facts({ material: "adamantine", enhancementBonus: 0 }),
      components: [physical(12)],
      defender: { object: { hardness: 10 } },
    });
    expect(adamantine).toMatchObject({
      ok: true,
      lethal: 12,
      hardnessApplied: 0,
    });
    const plus4 = applyMitigation({
      attack: facts({ material: "none", enhancementBonus: 4 }),
      components: [physical(12)],
      defender: { object: { hardness: 10 } },
    });
    expect(plus4).toMatchObject({ ok: true, lethal: 2, hardnessApplied: 10 });
  });

  test("objects are immune to nonlethal damage (CRB p.173)", () => {
    const result = applyMitigation({
      attack: facts(),
      components: [physical(12, { nonlethal: true })],
      defender: { object: { hardness: 0 } },
    });
    expect(result).toMatchObject({ ok: true, lethal: 0, nonlethal: 0 });
  });
});

describe("the A03 → A05 composition seam", () => {
  const sword = resolvePF1eWeapon({
    name: "Longsword",
    class: "melee",
    handedness: "one-handed",
    proficiency: "martial",
    damageDice: "1d8",
    damageType: "slashing",
  }).weapon;

  test("a resolved roll becomes typed components: weapon physical, flaming energy, sneak precision", () => {
    const roll = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6],
      bonusLines: [
        { label: "flaming 1d6 fire", roll: 6, energyType: "fire" },
        { label: "sneak attack 2d6", roll: 9, precision: true },
      ],
    });
    expect(roll).toMatchObject({ ok: true, lethal: 25 });
    if (!roll.ok) throw new Error("unreachable");
    const components = damageComponentsFromRoll(roll);
    expect(components).toEqual([
      {
        label: "weapon damage",
        amount: 10,
        kind: "physical",
        nonlethal: false,
      },
      {
        label: "flaming 1d6 fire",
        amount: 6,
        kind: "energy",
        energyType: "fire",
        nonlethal: false,
        precision: false,
      },
      {
        label: "sneak attack 2d6",
        amount: 9,
        kind: "physical",
        nonlethal: false,
        precision: true,
      },
    ]);
    // End to end vs DR 10/—: the physical total (10 + 9) is reduced to 9…
    // wait: 19 − 10 = 9; the flaming 6 ignores DR ⇒ 15.
    const mitigated = applyMitigation({
      attack: drAttackFacts(sword),
      components,
      defender: { dr: [{ value: 10, bypass: [] }] },
    });
    expect(mitigated).toMatchObject({ ok: true, lethal: 15, drApplied: 10 });
  });

  test("the weaponContribution buckets keep the invariant lethal = weapon + lethal lines", () => {
    const roll = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6],
      bonusLines: [{ label: "flaming 1d6 fire", roll: 6, energyType: "fire" }],
    });
    if (!roll.ok) throw new Error("unreachable");
    expect(roll.weaponContribution).toEqual({ lethal: 10, nonlethal: 0 });
    expect(roll.lethal).toBe(
      roll.weaponContribution.lethal +
        roll.bonusContributions
          .filter((c) => !c.nonlethal)
          .reduce((sum, c) => sum + c.amount, 0),
    );
    // The minimum rule collapses the weapon buckets to 1 nonlethal.
    const minimum = resolveDamageRoll({
      weapon: sword,
      staticDamage: -4,
      weaponDamageRolls: [2],
    });
    if (!minimum.ok) throw new Error("unreachable");
    expect(minimum.weaponContribution).toEqual({ lethal: 0, nonlethal: 1 });
  });
});

describe("mitigation input validation — never guess", () => {
  test("malformed components, DR values, energy types and hardness are rejected", () => {
    expect(
      applyMitigation({
        attack: facts(),
        components: [physical(-1)],
        defender: {},
      }),
    ).toMatchObject({ ok: false });
    expect(
      applyMitigation({
        attack: facts(),
        components: [{ label: "odd", amount: 5, kind: "energy" }],
        defender: {},
      }),
    ).toMatchObject({ ok: false });
    expect(
      applyMitigation({
        attack: facts(),
        components: [physical(5)],
        defender: { dr: [{ value: -5, bypass: [] }] },
      }),
    ).toMatchObject({ ok: false });
    expect(
      applyMitigation({
        attack: facts(),
        components: [physical(5)],
        defender: { object: { hardness: -1 } },
      }),
    ).toMatchObject({ ok: false });
    expect(
      applyMitigation({
        attack: facts(),
        components: [
          {
            label: "weird",
            amount: 5,
            kind: "psychic" as never,
            energyType: "fire",
          },
        ],
        defender: {},
      }),
    ).toMatchObject({ ok: false });
  });

  test("zero-amount components are carried as no-ops, not errors", () => {
    const result = applyMitigation({
      attack: facts(),
      components: [physical(0), energy(4, "fire")],
      defender: { energyResistance: { fire: 4 } },
    });
    expect(result).toMatchObject({ ok: true, lethal: 0 });
  });
});
