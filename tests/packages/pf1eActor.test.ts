/**
 * The tactical derivation (plan P0, Gap List §10.1 items 1–2): one authored block in, one derived view
 * out, effects read live, and **no** persisted results. The last group of tests runs the shipped bestiary
 * through the reader, which is what keeps pack data and code from drifting (and is why there is no
 * manifest version bump in this phase: nothing has to migrate, the pack is already the contract).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  deriveFromDocuments,
  derivePF1eActor,
  parsePF1eActorSystem,
  unarmedDamageDice,
} from "../../src/packages/pf1e/actor";
import {
  normalizePF1eSystem,
  scoreFromMod,
} from "../../src/packages/pf1e/statBlock";
import {
  readTacticalEffect,
  resolveEffects,
  type PF1eActiveEffect,
} from "../../src/packages/pf1e/effects";
import {
  compilePF1eProfile,
  type RawPF1eProfile,
} from "../../src/packages/pf1e/schema";
import { abilityMod } from "../../src/packages/pf1e/rulesTables";

const asEffect = (
  payload: unknown,
  id = "e",
  durationLeft: number | null = null,
): PF1eActiveEffect => {
  const r = readTacticalEffect(id, { name: id, flags: { pf1e: payload } });
  if (!r.ok) throw new Error(r.error);
  return { ...r.value, durationLeft };
};

describe("derivation is total", () => {
  test("an empty block is a legal Medium commoner, and says so", () => {
    const d = derivePF1eActor({});
    expect(d.size).toBe("Medium");
    expect(d.abilities.str).toBe(10);
    expect(d.ac.normal).toBe(10);
    expect(d.baseAttack).toBe(0);
    expect(d.hpMax).toBe(0);
    expect(d.attacks).toHaveLength(1);
    expect(d.attacks[0]?.damageDice).toBe("1d3");
    expect(d.defaults.join("\n")).toContain("size: not authored");
    expect(d.issues).toEqual([]);
  });

  test("nothing throws on garbage: every malformed field becomes an issue with the field named", () => {
    const d = derivePF1eActor({
      system: {
        size: "Huge!",
        abilities: { str: "strong", dex: null },
        baseAttack: "six",
        attacks: { name: "bite" },
        initiative: "quick",
      } as unknown as Record<string, unknown>,
    });
    const joined = d.issues.join("\n");
    expect(joined).toContain('size "Huge!"');
    expect(joined).toContain("abilities.str");
    expect(joined).toContain("baseAttack");
    expect(joined).toContain("attacks: expected an array");
    expect(d.ac.normal).toBe(10);
  });

  test("a size outside the ladder never invents a bonus, and out-of-range scores are flagged", () => {
    const d = derivePF1eActor({ system: { abilities: { str: 100 } } });
    expect(d.issues.join("\n")).toContain("outside the 3–55 range");
    expect(d.abilityMods.str).toBe(45);
  });
});

describe("P02 — natural reach derived from Table 8-4 (AoN Rules ID 179, D-180)", () => {
  test("a Medium creature reaches 5 ft and the table prints no body form for it", () => {
    const d = derivePF1eActor({});
    expect(d.reachFeet).toBe(5);
    expect(d.reachShape).toBe("tall");
    expect(d.attacks[0]?.reachSquares).toBe(1);
    // no "reachShape: not authored" note: Small and Medium have one printed figure,
    // so there is nothing the author left out.
    expect(d.defaults.join("\n")).not.toContain("reachShape");
    expect(d.issues).toEqual([]);
  });

  test("a Large creature reaches 10 ft tall, 5 ft long, and says which column was used", () => {
    const tall = derivePF1eActor({ system: { size: "Large" } });
    expect(tall.reachFeet).toBe(10);
    expect(tall.reachShape).toBe("tall");
    expect(tall.attacks[0]?.reachSquares).toBe(2);
    expect(tall.defaults.join("\n")).toContain("reachShape: not authored");
    expect(tall.explain.speed).toContain("10 ft space, 10 ft natural reach");

    const long = derivePF1eActor({
      system: { size: "Large", reachShape: "long" },
    });
    expect(long.reachFeet).toBe(5);
    expect(long.reachShape).toBe("long");
    expect(long.attacks[0]?.reachSquares).toBe(1);
    expect(long.issues).toEqual([]);
    expect(long.explain.speed).toContain(
      "10 ft space, 5 ft natural reach (long)",
    );
  });

  test("the rest of Table 8-4: Huge 15/10, Gargantuan 20/15, Colossal 30/20", () => {
    const reach = (size: string, shape?: string) =>
      derivePF1eActor({
        system: shape === undefined ? { size } : { size, reachShape: shape },
      }).reachFeet;
    expect(reach("Huge")).toBe(15);
    expect(reach("Huge", "long")).toBe(10);
    expect(reach("Gargantuan")).toBe(20);
    expect(reach("Gargantuan", "long")).toBe(15);
    expect(reach("Colossal")).toBe(30);
    expect(reach("Colossal", "long")).toBe(20);
    // Colossal reach is 30 ft = six squares, not the five a "+1 per category" ladder gives.
    expect(
      derivePF1eActor({ system: { size: "Colossal" } }).attacks[0]
        ?.reachSquares,
    ).toBe(6);
  });

  test("Tiny and smaller reach 0 ft — they must enter an opponent's square (AoN 179)", () => {
    for (const size of ["Tiny", "Diminutive", "Fine"] as const) {
      const d = derivePF1eActor({ system: { size } });
      expect(d.reachFeet, size).toBe(0);
      expect(d.attacks[0]?.reachSquares, size).toBe(0);
      expect(d.explain.speed, size).toContain("0 ft natural reach");
      // one printed figure, so nothing was left unauthored
      expect(d.defaults.join("\n"), size).not.toContain("reachShape");
    }
    // Fine is 1/2 ft across, not the "1½ ft" the A.5 transcription once carried.
    expect(
      derivePF1eActor({ system: { size: "Fine" } }).explain.speed,
    ).toContain("0.5 ft space");
  });

  test("a body form on a size the table prints one figure for is reported, and changes nothing", () => {
    const d = derivePF1eActor({
      system: { size: "Medium", reachShape: "long" },
    });
    expect(d.reachFeet).toBe(5);
    expect(d.issues.join("\n")).toContain(
      "does not apply to a Medium creature",
    );
  });

  test("a malformed body form is an issue naming the field, and a rejected block says why", () => {
    const d = derivePF1eActor({
      system: { size: "Large", reachShape: "wide" },
    });
    expect(d.reachShape).toBe("tall");
    expect(d.reachFeet).toBe(10);
    expect(d.issues.join("\n")).toContain(
      'reachShape "wide" is neither "tall" nor "long"',
    );

    expect(parsePF1eActorSystem({ reachShape: "sideways" }).ok).toBe(false);
    expect(parsePF1eActorSystem({ reachShape: " long " }).ok).toBe(true);
  });

  test("an authored per-attack reach still outranks the derived body form", () => {
    const d = derivePF1eActor({
      system: {
        size: "Large",
        reachShape: "long",
        attacks: [{ name: "tongue", damageDice: "1d4", reachSquares: 3 }],
      },
    });
    expect(d.reachFeet).toBe(5); // the creature's natural reach
    expect(d.attacks[0]?.reachSquares).toBe(3); // the attack's own authored reach
  });
});

describe("component sheet (A.2/A.3)", () => {
  const fighter = {
    size: "Medium",
    baseAttack: 6,
    abilities: { str: 18, dex: 16, con: 16, int: 10, wis: 12, cha: 10 },
    armorClass: { armor: 5, shield: 2, natural: 1, dodge: 0, misc: 0 },
    armor: { armorBonus: 5, shieldBonus: 2, maxDexBonus: 6 },
    saves: { fort: 5, ref: 2, will: 2 },
    initiative: 0,
    attacks: [
      {
        name: "longsword",
        damageDice: "1d8",
        twoHanded: true,
        critThreatMin: 19,
        critMultiplier: 3,
      },
    ],
  };

  test("the three ACs compose from components and never disagree", () => {
    const d = derivePF1eActor({ system: fighter });
    expect(d.ac.normal).toBe(10 + 5 + 2 + 3 + 1 + 0 + 0 + 0);
    expect(d.ac.touch).toBe(10 + 3);
    expect(d.ac.flatFooted).toBe(10 + 5 + 2 + 1);
    expect(d.explain.ac).toContain("armor 5");
  });

  test("a lower armor cap than the wearer's Dexterity wins", () => {
    const d = derivePF1eActor({
      system: {
        ...fighter,
        armor: { maxDexBonus: 2 },
        abilities: { ...fighter.abilities, dex: 22 },
      },
    });
    expect(d.abilityMods.dex).toBe(6);
    expect(d.ac.normal).toBe(10 + 5 + 2 + 2 + 1);
  });

  test("two-handed weapons add 1.5× Strength, rounded down", () => {
    const d = derivePF1eActor({ system: fighter });
    expect(d.attacks[0]?.abilityDamage).toBe(6);
    expect(d.attacks[0]?.damageBonus).toBe(6);
  });

  test("BAB 6 gives two iteratives and both carry the same modifiers", () => {
    const d = derivePF1eActor({ system: fighter });
    expect(d.iterativeAttacks).toEqual([6, 1]);
    expect(d.attacks[0]?.attackBonuses).toEqual([10, 5]); // 6+4 and 1+4
  });

  test("saves are base + ability, willpower for Will", () => {
    const d = derivePF1eActor({ system: fighter });
    expect(d.saves).toEqual({ fort: 8, ref: 5, will: 3 });
  });

  test("initiative is the Dexterity check plus authored adjustments", () => {
    const d = derivePF1eActor({ system: { ...fighter, initiative: 4 } });
    expect(d.initiative).toBe(7);
  });

  test("CMB and CMD use the special size ladder and the formula, not an authored total", () => {
    const d = derivePF1eActor({ system: fighter });
    expect(d.cmb).toBe(6 + 4);
    expect(d.cmd).toBe(10 + 6 + 4 + 3);
    expect(d.cmdFlatFooted).toBe(10 + 6 + 4);
  });
});

describe("effects move the numbers they name", () => {
  const base = { baseAttack: 6, abilities: { str: 14, dex: 12, con: 14 } };

  test("bull's strength raises the score, and damage/CMB/CMD with it", () => {
    const strong = derivePF1eActor({
      system: base,
      effects: [
        asEffect({
          mods: [{ key: "ability.str", type: "enhancement", value: 4 }],
        }),
      ],
    });
    expect(strong.abilities.str).toBe(18);
    expect(strong.abilityMods.str).toBe(4);
    expect(strong.attacks[0]?.abilityDamage).toBe(4);
    expect(strong.cmb).toBe(6 + 4);
    expect(strong.cmd).toBe(10 + 6 + 4 + 1);
  });

  test("expiry is free: the same document without the effect reads the old numbers", () => {
    const plain = derivePF1eActor({ system: base });
    expect(plain.attacks[0]?.abilityDamage).toBe(2);
    expect(plain.cmb).toBe(6 + 2);
  });

  test("flat-footed denies Dexterity to AC and CMD, but not initiative, and blocks attacks of opportunity", () => {
    const d = derivePF1eActor({
      system: {
        ...base,
        armorClass: { armor: 3 },
        attacks: [{ damageDice: "1d8" }],
      },
      effects: [asEffect({ flags: { flatFooted: true } })],
    });
    expect(d.ac.normal).toBe(13); // 10 + armor 3, Dexterity denied
    expect(d.ac.flatFooted).toBe(13);
    expect(d.initiative).toBe(1); // CRB p.178 Initiative: Dex 12 still supplies +1
    expect(d.canTakeAoO).toBe(false);
    expect(d.deniedDexToAc).toBe(true);
  });

  test("an effect can deny an action and grant a quality without touching a number", () => {
    const d = derivePF1eActor({
      system: base,
      effects: [
        asEffect({
          denies: ["full-attack"],
          grants: ["uncanny-dodge"],
          condition: "entangled",
        }),
      ],
    });
    expect(d.denies.has("full-attack")).toBe(true);
    expect(d.grants.has("uncanny-dodge")).toBe(true);
    expect(d.conditions).toEqual(["entangled"]);
    expect(d.ac.normal).toBe(11);
  });

  test("a disabled effect is inert, exactly as core's badge treats it", () => {
    const r = readTacticalEffect("e", {
      disabled: true,
      flags: { pf1e: { mods: [{ key: "ac", type: "dodge", value: 4 }] } },
    });
    if (!r.ok) throw new Error(r.error);
    expect(resolveEffects([r.value]).mods.ac).toBeUndefined();
  });
});

describe("attacks of opportunity and natural attacks", () => {
  test("one AoO, one more for a positive Dexterity modifier, and one per point with Combat Reflexes", () => {
    expect(
      derivePF1eActor({ system: { abilities: { dex: 14 } } }).aooPerRound,
    ).toBe(2);
    expect(
      derivePF1eActor({ system: { abilities: { dex: 10 } } }).aooPerRound,
    ).toBe(1);
    expect(
      derivePF1eActor({
        system: {
          abilities: { dex: 14 },
          feats: ["Improved Critical", "Combat Reflexes"],
        },
      }).aooPerRound,
    ).toBe(4);
  });

  test("feats authored as the pack writes them (comma string, JSON blob) still count", () => {
    expect(
      derivePF1eActor({
        system: {
          abilities: { dex: 18 },
          feats: "Combat Reflexes, Power Attack",
        },
      }).aooPerRound,
    ).toBe(6);
    const json = derivePF1eActor({
      system: {
        abilities: { dex: 18 },
        feats: '[{"name":"Combat Reflexes"}]',
      } as unknown as Record<string, never>,
    });
    expect(json.aooPerRound).toBe(6);
  });

  test("natural attacks do not iterate, and secondary natural attacks take half Strength", () => {
    const d = derivePF1eActor({
      system: {
        baseAttack: 11,
        abilities: { str: 18 },
        attacks: [
          { name: "bite", damageDice: "1d6", natural: true },
          { name: "claw", damageDice: "1d4", natural: true, secondary: true },
        ],
      },
    });
    expect(d.attacks[0]?.attackBonuses).toEqual([11 + 4]);
    expect(d.attacks[1]?.abilityDamage).toBe(2);
    expect(d.iterativeAttacks).toEqual([11, 6, 1]);
  });

  test("unarmed strike damage follows size (Small 1d2, Medium 1d3, Large 1d4 — AoN ID 131)", () => {
    expect(unarmedDamageDice("Small")).toBe("1d2");
    expect(unarmedDamageDice("Medium")).toBe("1d3");
    expect(unarmedDamageDice("Large")).toBe("1d4");
    expect(
      derivePF1eActor({ system: { size: "Large", abilities: { str: 20 } } })
        .attacks[0]?.damageDice,
    ).toBe("1d4");
    expect(
      derivePF1eActor({ system: { size: "Medium" } }).attacks[0]?.damageDice,
    ).toBe("1d3");
  });
});

describe("spellcasting (A.16)", () => {
  const wizard = {
    abilities: { int: 18 },
    spells: {
      keyAbility: "int",
      casterLevel: 5,
      mode: "prepared",
      slotsPerDay: { 0: 5, 1: 3, 2: 3, 3: 2 },
    },
  };

  test("save DC per level = 10 + level + 4, and unauthored levels are null", () => {
    const d = derivePF1eActor({ system: wizard });
    expect(d.casting).toBe(true);
    expect(d.spellSaveDc[0]).toBe(14);
    expect(d.spellSaveDc[3]).toBe(17);
    expect(d.spellSaveDc[4]).toBeNull();
    expect(d.spellSlots[1]).toBe(3);
    expect(d.spellCasterLevel).toBe(5);
    expect(d.spellMode).toBe("prepared");
  });

  test("deriveFromDocuments reads the document's system block and reports a rejected block", () => {
    const ok = deriveFromDocuments({
      actor: { system: { pf1e: { size: "Large", abilities: { str: 22 } } } },
    });
    expect(ok.size).toBe("Large");
    expect(ok.abilityMods.str).toBe(6);
    const bad = deriveFromDocuments({
      actor: { system: { pf1e: { size: "Giant" } } },
    });
    expect(bad.issues.join("\n")).toContain("is not a PF1e size category");
    expect(bad.size).toBe("Medium");
  });

  test("an actor with no spellcasting reports none rather than zeros", () => {
    const d = derivePF1eActor({ system: { abilities: { int: 18 } } });
    expect(d.casting).toBe(false);
    expect(d.spellSaveDc.every((v) => v === null)).toBe(true);
  });
});

describe("stat-block adapter (the pack ↔ code seam)", () => {
  test("scores are reconstructed from modifiers as the even score, and it is reported", () => {
    const r = normalizePF1eSystem({ strMod: 3, dexMod: 1 });
    expect(r.system.abilities).toEqual({ str: 16, dex: 12 });
    expect(r.converted.join("\n")).toContain(
      "reconstructed from strMod 3 as the even score 16",
    );
    expect(scoreFromMod(-1)).toBe(8);
  });

  test("a stat block's totals are honoured and marked as totals", () => {
    const d = derivePF1eActor({
      system: {
        bab: 6,
        strMod: 3,
        ac: 18,
        touchAc: 13,
        weapon: { damageDiceCount: 1, damageDiceSides: 8, damageMod: 3 },
      },
    });
    expect(d.ac.normal).toBe(18);
    expect(d.ac.touch).toBe(13);
    expect(d.acFromTotals).toBe(true);
    expect(d.explain.ac).toContain("authored total 18");
  });

  test("published damageMod is not Strength twice", () => {
    const d = derivePF1eActor({
      system: {
        strMod: 3,
        weapon: { damageDiceCount: 1, damageDiceSides: 8, damageMod: 3 },
      },
    });
    expect(d.attacks[0]?.damageBonus).toBe(0);
    expect(d.attacks[0]?.abilityDamage).toBe(0);
  });

  test("published saves are totals, so ability modifiers are not added again", () => {
    const d = derivePF1eActor({ system: { conMod: 4, fort: 8 } });
    expect(d.saves.fort).toBe(8);
    expect(d.converted.join("\n")).toContain("not re-added");
  });

  test("DR objects, SR, and regeneration come across as numbers the later phases can use", () => {
    const d = derivePF1eActor({
      system: {
        dr: { val: 5, bypass: ["magic"] },
        sr: 25,
        regeneration: { value: 5, suppress: ["fire", "acid"] },
      },
    });
    expect(d.dr).toBe(5);
    expect(d.drBypass).toEqual(["magic"]);
    expect(d.spellResistance).toBe(25);
    expect(d.regeneration).toBe(5);
    expect(d.regenerationSuppress).toEqual(["fire", "acid"]);
  });

  test("fields no tactical rule implements yet are listed, not dropped", () => {
    const d = derivePF1eActor({
      system: {
        bab: 4,
        weapon: {
          damageDiceCount: 2,
          damageDiceSides: 6,
          isFirearm: true,
          misfireMin: 4,
        },
        hasTrample: true,
      },
    });
    const text = d.unsupported.join("\n");
    expect(text).toContain("weapon.isFirearm");
    expect(text).toContain("firearm");
    expect(text).toContain("hasTrample");
  });

  test("the conversion is idempotent, so the sheet can round-trip an import", () => {
    const once = normalizePF1eSystem({
      bab: 6,
      strMod: 3,
      ac: 18,
      weapon: { damageDiceCount: 1, damageDiceSides: 8 },
    });
    const twice = normalizePF1eSystem(once.system);
    expect(twice.convertedFromStatBlock).toBe(false);
    expect(twice.system).toEqual(once.system);
  });

  test("a hand-authored component block is left completely alone", () => {
    const sys = {
      size: "Medium",
      abilities: { str: 16 },
      armorClass: { armor: 3 },
    };
    const r = normalizePF1eSystem(sys);
    expect(r.convertedFromStatBlock).toBe(false);
    expect(r.system).toEqual(sys);
  });
});

describe("the shipped bestiary derives cleanly (pack ↔ code parity)", () => {
  const packPath = fileURLToPath(
    new URL("../../systems/pf1e-core/packs/bestiary.json", import.meta.url),
  );
  const pack = JSON.parse(readFileSync(packPath, "utf8")) as {
    entries: Array<{
      id: string;
      name: string;
      data: { system: { pf1e?: Record<string, unknown> } };
    }>;
  };
  const blocks = pack.entries.map((e) => ({
    id: e.id,
    name: e.name,
    block: e.data.system.pf1e ?? {},
  }));

  test("the pack has content to check", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(6);
  });

  test("every entry parses, derives without a single issue, and keeps its published AC", () => {
    for (const { id, block } of blocks) {
      const parsed = parsePF1eActorSystem(block);
      expect(parsed.ok, `${id}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
      const d = derivePF1eActor({ system: parsed.ok ? parsed.value : {} });
      expect(d.issues, `${id}: ${d.issues.join("; ")}`).toEqual([]);
      const published = typeof block.ac === "number" ? block.ac : undefined;
      if (published !== undefined)
        expect(d.ac.normal, `${id} AC`).toBe(published);
      const bab = typeof block.bab === "number" ? block.bab : undefined;
      if (bab !== undefined) expect(d.baseAttack, `${id} BAB`).toBe(bab);
    }
  });

  test("the tactical derivation and the strategic profile compile agree on that same content", () => {
    for (const { id, block } of blocks) {
      const d = derivePF1eActor({ system: block });
      const raw: RawPF1eProfile = {
        bab: typeof block.bab === "number" ? block.bab : 0,
        strMod: typeof block.strMod === "number" ? block.strMod : 0,
        dexMod: typeof block.dexMod === "number" ? block.dexMod : 0,
        conMod: typeof block.conMod === "number" ? block.conMod : 0,
        sizeMod: typeof block.sizeMod === "number" ? block.sizeMod : 0,
        ...(typeof block.ac === "number" ? { ac: block.ac } : {}),
        ...(typeof block.touchAc === "number"
          ? { touchAc: block.touchAc }
          : {}),
        ...(typeof block.flatFootedAc === "number"
          ? { flatFootedAc: block.flatFootedAc }
          : {}),
      };
      const compiled = compilePF1eProfile(1, raw);
      expect(d.ac.normal, `${id} normal AC`).toBe(compiled.ac);
      expect(d.ac.touch, `${id} touch AC`).toBe(compiled.touchAc);
      expect(d.cmb, `${id} CMB`).toBe(compiled.cmb);
      expect(d.cmd, `${id} CMD`).toBe(compiled.cmd);
      expect(d.ac.flatFooted, `${id} flat-footed AC`).toBe(
        compiled.flatFootedAc,
      );
      expect(d.abilityMods.str, `${id} Str`).toBe(compiled.strMod);
      expect(d.abilityMods.dex, `${id} Dex`).toBe(compiled.dexMod);
      // Saves are the one place the two scales knowingly differ: the pool sim uses the published
      // number alone (`fort ?? 0`), while the tactical rules add the ability modifier the SRD says a
      // saving throw contains. P8's "one profile compile" closes it; pinned here so it cannot grow.
      expect(d.saves.fort, `${id} Fort`).toBe(
        compiled.fort + d.abilityMods.con,
      );
      expect(d.saves.ref, `${id} Ref`).toBe(compiled.ref + d.abilityMods.dex);
      expect(d.saves.will, `${id} Will`).toBe(
        compiled.will + d.abilityMods.wis,
      );
      // HP is deliberately not compared: the pool sim defaults an unseeded *unit* to 10 hp, while an
      // actor sheet with no authored hp must show empty rather than a made-up number.
    }
  });

  test("size categories in the pack, when authored, are the SRD ladder and not a float", () => {
    for (const { id, block } of blocks) {
      if (typeof block.size !== "string") continue;
      const d = derivePF1eActor({ system: block });
      expect(abilityMod(d.abilities.dex), id).toBeLessThanOrEqual(10);
      expect(d.sizeEntry.spaceFeet, id).toBeGreaterThan(0);
    }
  });

  test("the iterative ladder the sim rolls with is the ladder the sheet shows", () => {
    const paladin = blocks.find((b) => b.id === "paladin-hero");
    expect(paladin).toBeDefined();
    const d = derivePF1eActor({ system: paladin?.block ?? {} });
    const compiled = compilePF1eProfile(1, { bab: 11, strMod: 5 });
    expect(d.iterativeAttacks).toEqual([11, 6, 1]);
    expect(d.attacks[0]?.attackBonuses).toEqual(compiled.iteratives);
  });
});

/**
 * Ability damage and drain (CRB p.555, AoN Rules ID 416 — verified, not snapshot from code):
 *   • damage does NOT reduce the score; every two full points apply a –1 penalty to the
 *     statistics based on that ability;
 *   • Str: melee attack/damage, CMB (Small+), CMD; Dex: AC, ranged attack, initiative, Ref,
 *     CMB (Tiny−), CMD; Con: Fort plus HD × penalty off current AND max HP; Int/Wis/Cha: the
 *     spell DCs based on that key;
 *   • drain actually reduces the score (everything follows it);
 *   • damage ≥ score ⇒ unconscious (Con ⇒ dead).
 */
describe("ability damage and drain (CRB p.555)", () => {
  const hero = {
    size: "Medium",
    baseAttack: 6,
    abilities: { str: 18, dex: 16, con: 16, int: 10, wis: 12, cha: 10 },
    armorClass: { armor: 5, shield: 2, natural: 1 },
    saves: { fort: 5, ref: 2, will: 2 },
    attacks: [{ name: "longsword", damageDice: "1d8", twoHanded: true }],
  };

  test("1 point of damage is no penalty: the score and every statistic are unchanged", () => {
    const d = derivePF1eActor({
      system: { ...hero, abilitiesDamage: { str: 1 } },
    });
    expect(d.abilityDamageTaken.str).toBe(1);
    expect(d.abilityDamagePenalty.str).toBe(0);
    expect(d.abilities.str).toBe(18);
    expect(d.abilityMods.str).toBe(4);
    expect(d.attacks[0]?.attackBonus).toBe(6 + 4);
    expect(d.conditions).toEqual([]);
  });

  test("Str damage 3 → –1: melee attack, two-handed damage, CMB and CMD take it; the score stays 18", () => {
    const d = derivePF1eActor({
      system: { ...hero, abilitiesDamage: { str: 3 } },
    });
    expect(d.abilities.str).toBe(18); // damage never reduces the score
    expect(d.abilityMods.str).toBe(3); // +4 − 1
    expect(d.attacks[0]?.attackBonus).toBe(6 + 3);
    expect(d.attacks[0]?.abilityDamage).toBe(Math.floor(3 * 1.5)); // 4, not 6
    expect(d.cmb).toBe(6 + 3);
    expect(d.cmd).toBe(10 + 6 + 3 + 3); // eff Str 3 + eff Dex 3
    expect(d.abilityMods.dex).toBe(3); // untouched
    expect(d.ac.normal).toBe(10 + 5 + 2 + 3 + 1); // Dex undamaged
    expect(d.explain.abilities).toContain("STR 3 → penalties STR −1");
  });

  test("Dex damage 5 → –2: AC, touch AC, initiative, Ref and CMD take it; flat-footed AC never does", () => {
    const d = derivePF1eActor({
      system: { ...hero, abilitiesDamage: { dex: 5 } },
    });
    expect(d.abilityMods.dex).toBe(1); // +3 − 2
    expect(d.ac.normal).toBe(10 + 5 + 2 + 1 + 1);
    expect(d.ac.touch).toBe(10 + 1);
    expect(d.ac.flatFooted).toBe(10 + 5 + 2 + 1); // Dex already excluded
    expect(d.initiative).toBe(1);
    expect(d.saves.ref).toBe(2 + 1);
    expect(d.cmd).toBe(10 + 6 + 4 + 1);
    expect(d.attacks[0]?.attackBonus).toBe(6 + 4); // melee: Str undamaged
    expect(d.cmb).toBe(6 + 4);
  });

  test("drain actually reduces the score; drain and damage stack (score 14, +2, then –1 damage)", () => {
    const drained = derivePF1eActor({
      system: { ...hero, abilitiesDrain: { str: 4 } },
    });
    expect(drained.abilities.str).toBe(14);
    expect(drained.abilityMods.str).toBe(2);
    expect(drained.attacks[0]?.attackBonus).toBe(6 + 2);
    expect(drained.attacks[0]?.abilityDamage).toBe(Math.floor(2 * 1.5));
    const both = derivePF1eActor({
      system: {
        ...hero,
        abilitiesDrain: { str: 4 },
        abilitiesDamage: { str: 3 },
      },
    });
    expect(both.abilities.str).toBe(14); // damage still never reduces the score
    expect(both.abilityMods.str).toBe(1); // +2 − 1
    expect(both.attacks[0]?.attackBonus).toBe(7);
    expect(both.abilityDrainTaken.str).toBe(4);
  });

  test("Con damage: Fort penalty, and HD × penalty off current AND max HP when Hit Dice are authored", () => {
    const d = derivePF1eActor({
      system: {
        ...hero,
        hp: 25,
        hpMax: 30,
        hitDice: 6,
        abilitiesDamage: { con: 4 },
      },
    });
    expect(d.abilityDamagePenalty.con).toBe(2);
    expect(d.saves.fort).toBe(5 + 3 - 2); // base + Con +3, penalty −2
    expect(d.hp).toBe(25 - 6 * 2);
    expect(d.hpMax).toBe(30 - 6 * 2);
    expect(d.explain.hp).toContain("damage −2 × 6 HD");
    expect(d.unsupported).toEqual([]);
  });

  test("Con drain moves the modifier itself: HP lose Δmod × HD on top of any damage penalty", () => {
    const d = derivePF1eActor({
      system: {
        ...hero,
        hp: 25,
        hpMax: 30,
        hitDice: 6,
        abilitiesDrain: { con: 4 },
        abilitiesDamage: { con: 2 },
      },
    });
    // Con 16→12: mod +3→+1 (Δ −2 ⇒ −12 HP); damage 2 → penalty −1 ⇒ −6 HP
    expect(d.abilities.con).toBe(12);
    expect(d.hp).toBe(25 - 6 * 3);
    expect(d.hpMax).toBe(30 - 6 * 3);
    expect(d.saves.fort).toBe(5 + 1 - 1);
  });

  test("without Hit Dice the Con HP adjustment is reported, never guessed", () => {
    const d = derivePF1eActor({
      system: { ...hero, hp: 25, hpMax: 30, abilitiesDamage: { con: 4 } },
    });
    expect(d.saves.fort).toBe(5 + 3 - 2); // the Fort penalty still applies
    expect(d.hp).toBe(25);
    expect(d.hpMax).toBe(30);
    expect(d.unsupported.join("\n")).toContain("hitDice: not authored");
  });

  test("damage ≥ score ⇒ unconscious (dead for Constitution), per the rule's threshold", () => {
    const out = derivePF1eActor({
      system: { ...hero, abilitiesDamage: { str: 18, con: 2 } },
    });
    expect(out.conditions).toContain("unconscious");
    expect(out.conditions).not.toContain("dead");
    const dead = derivePF1eActor({
      system: {
        ...hero,
        abilities: { ...hero.abilities, con: 12 },
        abilitiesDamage: { con: 12 },
      },
    });
    expect(dead.conditions).toContain("dead");
    expect(dead.explain.abilities).toContain("threshold: dead");
    // the threshold compares against the CURRENT (drained) score
    const drained = derivePF1eActor({
      system: {
        ...hero,
        abilitiesDrain: { str: 10 },
        abilitiesDamage: { str: 8 },
      },
    });
    expect(drained.abilities.str).toBe(8);
    expect(drained.conditions).toContain("unconscious"); // 8 damage ≥ drained score 8
  });

  test("published totals take the penalty on top (saves and AC), like effects do", () => {
    const d = derivePF1eActor({
      system: {
        ...hero,
        saves: { fort: 8, ref: 5, will: 4 },
        savesAsTotal: true,
        acTotals: { normal: 21, touch: 13, flatFooted: 18 },
        abilitiesDamage: { dex: 5, con: 4 },
      },
    });
    expect(d.saves.ref).toBe(5 - 2); // published − Dex penalty
    expect(d.saves.fort).toBe(8 - 2); // published − Con penalty
    expect(d.saves.will).toBe(4); // Wis undamaged
    expect(d.ac.normal).toBe(21 - 2);
    expect(d.ac.touch).toBe(13 - 2);
    expect(d.ac.flatFooted).toBe(18); // Dex already excluded there
    expect(d.explain.ac).toContain("− Dex damage 2");
  });

  test("Int/Wis/Cha damage penalizes the spell DCs based on that key", () => {
    const wizard = {
      abilities: { int: 18 },
      spells: {
        keyAbility: "int",
        casterLevel: 5,
        slotsPerDay: { 1: 3 },
      },
    };
    const d = derivePF1eActor({
      system: { ...wizard, abilitiesDamage: { int: 3 } },
    });
    expect(d.spellSaveDc[1]).toBe(10 + 1 + 3); // 10 + level + eff Int (+4 − 1 damage)
    const drained = derivePF1eActor({
      system: { ...wizard, abilitiesDrain: { int: 4 } },
    });
    expect(drained.spellSaveDc[1]).toBe(10 + 1 + 2); // Int 14 → +2
  });

  test("a stat-block line with the ability included takes the flat Str penalty on damage", () => {
    const d = derivePF1eActor({
      system: {
        ...hero,
        attacks: [
          {
            name: "mw longsword",
            damageDice: "1d8",
            damageBonus: 7, // stat block: includes +4 Str
            abilityDamageIncluded: true,
          },
        ],
        abilitiesDamage: { str: 3 },
      },
    });
    expect(d.attacks[0]?.abilityDamage).toBe(0);
    expect(d.attacks[0]?.damageBonus).toBe(7 - 1);
    expect(d.attacks[0]?.attackBonus).toBe(6 + 3); // attack roll uses eff Str
  });

  test("malformed accumulators are issues that contribute zero, and nothing throws", () => {
    const d = derivePF1eActor({
      system: {
        ...hero,
        abilitiesDamage: { str: -2, dex: 2.5, luck: 3 } as never,
        abilitiesDrain: "nope" as never,
      },
    });
    expect(d.abilityDamageTaken.str).toBe(0);
    expect(d.abilityDamageTaken.dex).toBe(0);
    expect(d.abilityDamagePenalty.str).toBe(0);
    expect(d.issues.join("\n")).toContain("abilitiesDamage.str");
    expect(d.issues.join("\n")).toContain("abilitiesDamage.dex");
    expect(d.issues.join("\n")).toContain("abilitiesDamage.luck");
    expect(d.issues.join("\n")).toContain("abilitiesDrain");
  });

  test("parsePF1eActorSystem rejects bad accumulators before any op is submitted", () => {
    expect(parsePF1eActorSystem({ abilitiesDamage: { str: -1 } }).ok).toBe(
      false,
    );
    expect(parsePF1eActorSystem({ abilitiesDamage: { nope: 1 } }).ok).toBe(
      false,
    );
    expect(parsePF1eActorSystem({ abilitiesDrain: { dex: 1.5 } }).ok).toBe(
      false,
    );
    expect(parsePF1eActorSystem({ abilitiesDrain: { dex: 2 } }).ok).toBe(true);
    expect(parsePF1eActorSystem({ hitDice: -1 }).ok).toBe(false);
    expect(parsePF1eActorSystem({ hitDice: 6 }).ok).toBe(true);
  });

  test("spells.tradition and prepared components validate structurally (D-157)", () => {
    expect(parsePF1eActorSystem({ spells: { tradition: "arcane" } }).ok).toBe(
      true,
    );
    expect(parsePF1eActorSystem({ spells: { tradition: "divine" } }).ok).toBe(
      true,
    );
    expect(parsePF1eActorSystem({ spells: { tradition: "psychic" } }).ok).toBe(
      false,
    );
    expect(
      parsePF1eActorSystem({
        spells: {
          prepared: [{ name: "Shield", level: 1, components: "V, S" }],
        },
      }).ok,
    ).toBe(true);
    expect(
      parsePF1eActorSystem({
        spells: { prepared: [{ name: "Shield", level: 1, components: 7 }] },
      }).ok,
    ).toBe(false);
    expect(
      parsePF1eActorSystem({
        spells: {
          prepared: [{ name: "Shield", level: 1, components: "V".repeat(121) }],
        },
      }).ok,
    ).toBe(false);
  });

  test("every bestiary block derives identically with zero damage/drain fields added", () => {
    const pack = JSON.parse(
      readFileSync(
        new URL("../../systems/pf1e-core/packs/bestiary.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: Array<{ data: { system: Record<string, unknown> } }> };
    for (const entry of pack.entries) {
      const block = (entry.data.system as { pf1e?: Record<string, unknown> })
        .pf1e;
      if (!block) continue;
      const plain = derivePF1eActor({ system: block });
      const labeled = derivePF1eActor({
        system: { ...block, abilitiesDamage: {}, abilitiesDrain: {} },
      });
      expect(labeled.abilities).toEqual(plain.abilities);
      expect(labeled.ac).toEqual(plain.ac);
      expect(labeled.hp).toEqual(plain.hp);
      expect(labeled.unsupported).toEqual(plain.unsupported);
    }
  });
});
