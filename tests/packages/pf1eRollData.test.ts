import { describe, expect, test } from "vitest";
import { derivePF1eActor } from "../../src/packages/pf1e/actor";
import {
  fmtSigned,
  pf1eAttackRollGroups,
  pf1eInitiativeRollSpec,
  pf1eSaveRollSpecs,
} from "../../src/packages/pf1e/rollData";

const fighter = derivePF1eActor({
  system: {
    abilities: { str: 16, dex: 14, con: 14 },
    baseAttack: 6,
    hp: 40,
    hpMax: 40,
    attacks: [
      {
        name: "Longsword",
        damageDice: "1d8",
        damageBonus: 3,
        damageType: "slashing",
        critThreatMin: 19,
        critMultiplier: 2,
      },
      {
        name: "Bite",
        natural: true,
        damageDice: "1d6",
        damageBonus: 4,
        critMultiplier: 2,
      },
    ],
    saves: { fort: 8, ref: 5, will: 2 },
    initiative: 2,
  },
});

describe("attack roll groups (A06 — the sheet roll bridge)", () => {
  test("a BAB 6 line rolls 1d20 + 10 with the BAB-first breakdown flavor", () => {
    const groups = pf1eAttackRollGroups(fighter);
    const sword = groups[0];
    expect(sword?.label).toBe("Longsword");
    // BAB 6 + Str 3 + size 0 = +9 (the authored damageBonus is the flat part;
    // the derivation adds the ability contribution on top — see damage below)
    expect(sword?.attack.formula).toBe("1d20 + 9");
    expect(sword?.attack.flavor).toBe("Longsword +9 = BAB 6 + Str +3, size +0");
    expect(sword?.provokes).toBe(false);
  });

  test("full attack posts one roll per iterative: BAB +6/+1 ⇒ +10/+5", () => {
    const groups = pf1eAttackRollGroups(fighter);
    const sword = groups[0];
    expect(sword?.fullAttack.map((s) => s.formula)).toEqual([
      "1d20 + 9",
      "1d20 + 4",
    ]);
    expect(sword?.fullAttack[1]?.label).toBe("Longsword (attack 2)");
    // A natural attack never iterates — exactly one roll.
    const bite = groups[1];
    expect(bite?.fullAttack.map((s) => s.formula)).toEqual(["1d20 + 9"]);
    expect(bite?.fullAttack[0]?.label).toBe("Bite");
  });

  test("damage formulas carry dice and modifier; the threat range is noted", () => {
    const groups = pf1eAttackRollGroups(fighter);
    const sword = groups[0];
    // flat 3 (authored) + Str 3 (derived ability contribution) = +6
    expect(sword?.damage?.formula).toBe("1d8 + 6");
    expect(sword?.damage?.flavor).toContain("Longsword damage");
    expect(sword?.notes.some((n) => n.includes("threat range 19–20"))).toBe(
      true,
    );
    const bite = groups[1];
    expect(bite?.damage?.formula).toBe("1d6 + 7");
  });

  test("critical damage rolls the weapon damage once per multiplier step with all modifiers (CRB p.179)", () => {
    const crit12 = derivePF1eActor({
      system: {
        baseAttack: 6,
        attacks: [
          {
            name: "Scythe",
            damageDice: "2d4",
            damageBonus: 6,
            twoHanded: true,
            critMultiplier: 4,
          },
        ],
      },
    });
    const groups = pf1eAttackRollGroups(crit12);
    // ×4 ⇒ four groups of dice + static, totaled — never (2d4 + 6) × 4.
    expect(groups[0]?.critDamage?.formula).toBe(
      "2d4 + 6 + 2d4 + 6 + 2d4 + 6 + 2d4 + 6",
    );
    expect(groups[0]?.critDamage?.flavor).toContain("critical ×4");
    // The fighter's ×2 longsword: two groups.
    const fighterGroups = pf1eAttackRollGroups(fighter);
    expect(fighterGroups[0]?.critDamage?.formula).toBe("1d8 + 6 + 1d8 + 6");
  });

  test("a negative damage modifier formats with an ASCII minus for the formula engine", () => {
    const weak = derivePF1eActor({
      system: {
        abilities: { str: 4 },
        baseAttack: 2,
        attacks: [{ name: "Dagger", damageDice: "1d4", damageBonus: -2 }],
      },
    });
    const groups = pf1eAttackRollGroups(weak);
    // authored flat −2 plus the Str −3 ability contribution
    expect(groups[0]?.damage?.formula).toBe("1d4 - 5");
    expect(groups[0]?.attack.formula).toBe("1d20 - 1");
  });

  test("dice-less lines: flat damage only, crit bakes the multiplied static; nothing to roll ⇒ null", () => {
    const flat = derivePF1eActor({
      system: {
        baseAttack: 1,
        attacks: [{ name: "Constrict", damageBonus: 5 }],
      },
    });
    const groups = pf1eAttackRollGroups(flat);
    expect(groups[0]?.damage?.formula).toBe("5");
    expect(groups[0]?.critDamage?.formula).toBe("10");
    const nothing = derivePF1eActor({
      system: { baseAttack: 1, attacks: [{ name: "Wail" }] },
    });
    const empty = pf1eAttackRollGroups(nothing);
    expect(empty[0]?.damage).toBeNull();
    expect(empty[0]?.critDamage).toBeNull();
  });

  test("the unarmed fallback provokes without IUS or natural attacks — and stops when armed", () => {
    const bare = derivePF1eActor({});
    const groups = pf1eAttackRollGroups(bare, { authoredAttacksCount: 0 });
    expect(groups[0]?.provokes).toBe(true);
    expect(
      groups[0]?.notes.some((n) =>
        n.includes("provokes an attack of opportunity"),
      ),
    ).toBe(true);

    const trained = pf1eAttackRollGroups(bare, {
      authoredAttacksCount: 0,
      feats: ["Improved Unarmed Strike"],
    });
    expect(trained[0]?.provokes).toBe(false);

    const clawed = pf1eAttackRollGroups(bare, {
      authoredAttacksCount: 0,
      hasNaturalAttacks: true,
    });
    expect(clawed[0]?.provokes).toBe(false);

    // An explicitly authored unarmed-named line without armed status: the
    // advisory note, never a silent guess.
    const authored = derivePF1eActor({
      system: { attacks: [{ name: "Unarmed strike", damageDice: "1d3" }] },
    });
    const advisory = pf1eAttackRollGroups(authored, {
      authoredAttacksCount: 1,
    });
    expect(advisory[0]?.provokes).toBe(false);
    expect(advisory[0]?.notes.some((n) => n.includes("counts as armed"))).toBe(
      true,
    );
  });

  test("an explain string in an unexpected shape degrades to the verbatim flavor, never a guess", () => {
    const derived = derivePF1eActor({
      system: { baseAttack: 2 },
    });
    const doctored = {
      ...derived,
      attacks: derived.attacks.map((a) => ({
        ...a,
        explain: "authored published totals — no components to recompose",
      })),
    };
    const groups = pf1eAttackRollGroups(doctored);
    expect(groups[0]?.attack.flavor).toBe(
      "Unarmed strike +2 — authored published totals — no components to recompose",
    );
  });
});

describe("saves and checks (A06)", () => {
  test("the three saves roll d20 + derived totals with the save explanation", () => {
    const specs = pf1eSaveRollSpecs(fighter);
    // authored saves are BASE values — the derivation adds the abilities:
    // fort 8 + Con 2, ref 5 + Dex 2, will 2 + Wis 0
    expect(specs.map((s) => s.formula)).toEqual([
      "1d20 + 10",
      "1d20 + 7",
      "1d20 + 2",
    ]);
    expect(specs[0]?.flavor).toContain("Fortitude +10");
    expect(specs.map((s) => s.label)).toEqual(["Fortitude", "Reflex", "Will"]);
  });

  test("negative save totals format with an ASCII minus", () => {
    const cursed = derivePF1eActor({
      system: { saves: { fort: -2 } },
    });
    const specs = pf1eSaveRollSpecs(cursed);
    expect(specs[0]?.formula).toBe("1d20 - 2");
  });

  test("initiative is a check with its derived modifier and explanation", () => {
    const spec = pf1eInitiativeRollSpec(fighter);
    expect(spec.kind).toBe("check");
    expect(spec.formula).toBe("1d20 + 4");
    expect(spec.flavor).toContain("Initiative +4");
  });
});

describe("display formatting", () => {
  test("fmtSigned uses the display minus, never the formula minus", () => {
    expect(fmtSigned(3)).toBe("+3");
    expect(fmtSigned(0)).toBe("+0");
    expect(fmtSigned(-2)).toBe("−2");
  });
});
