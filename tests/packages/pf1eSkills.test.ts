import { describe, expect, it } from "vitest";
import {
  PF1E_SKILLS,
  PF1E_SKILL_MAP,
  derivePF1eSkill,
  normalizeSkillId,
} from "../../src/packages/pf1e/skills";
import { derivePF1eActor } from "../../src/packages/pf1e/actor";

describe("PF1e skills system (G-01 / T1)", () => {
  it("defines standard Pathfinder 1e skills with key abilities", () => {
    expect(PF1E_SKILLS.length).toBeGreaterThanOrEqual(30);
    expect(PF1E_SKILL_MAP["acrobatics"]?.ability).toBe("dex");
    expect(PF1E_SKILL_MAP["acrobatics"]?.armorCheckPenalty).toBe(true);
    expect(PF1E_SKILL_MAP["perception"]?.ability).toBe("wis");
    expect(PF1E_SKILL_MAP["perception"]?.armorCheckPenalty).toBe(false);
    expect(PF1E_SKILL_MAP["climb"]?.ability).toBe("str");
    expect(PF1E_SKILL_MAP["climb"]?.armorCheckPenalty).toBe(true);
    expect(PF1E_SKILL_MAP["disableDevice"]?.trainedOnly).toBe(true);
    expect(PF1E_SKILL_MAP["knowledgeArcana"]?.trainedOnly).toBe(true);
  });

  it("normalizes common Foundry skill aliases and shorthand codes", () => {
    expect(normalizeSkillId("acr")).toBe("acrobatics");
    expect(normalizeSkillId("per")).toBe("perception");
    expect(normalizeSkillId("ste")).toBe("stealth");
    expect(normalizeSkillId("dev")).toBe("disableDevice");
    expect(normalizeSkillId("kar")).toBe("knowledgeArcana");
  });

  it("applies CRB p.86 +3 class skill bonus when ranks >= 1 and classSkill is true", () => {
    const acrobatics = PF1E_SKILL_MAP["acrobatics"];
    expect(acrobatics).toBeDefined();
    if (!acrobatics) return;
    const context = {
      abilities: { str: 0, dex: 3, con: 0, int: 0, wis: 0, cha: 0 },
      armorCheckPenalty: 0,
    };

    // Untrained, class skill = false: mod = Dex (+3)
    const untrained = derivePF1eSkill(acrobatics, undefined, context);
    expect(untrained.ranks).toBe(0);
    expect(untrained.classSkillBonus).toBe(0);
    expect(untrained.total).toBe(3);

    // 1 rank, not a class skill: mod = Dex (+3) + 1 rank = 4
    const rankNoClass = derivePF1eSkill(acrobatics, { ranks: 1, classSkill: false }, context);
    expect(rankNoClass.ranks).toBe(1);
    expect(rankNoClass.classSkillBonus).toBe(0);
    expect(rankNoClass.total).toBe(4);

    // 1 rank, IS a class skill: mod = Dex (+3) + 1 rank + 3 bonus = 7
    const rankWithClass = derivePF1eSkill(acrobatics, { ranks: 1, classSkill: true }, context);
    expect(rankWithClass.ranks).toBe(1);
    expect(rankWithClass.classSkillBonus).toBe(3);
    expect(rankWithClass.total).toBe(7);

    // 0 ranks, IS a class skill: class skill bonus only applies if ranks >= 1!
    const zeroRankClass = derivePF1eSkill(acrobatics, { ranks: 0, classSkill: true }, context);
    expect(zeroRankClass.classSkillBonus).toBe(0);
    expect(zeroRankClass.total).toBe(3);
  });

  it("applies armor check penalty to Str and Dex skills", () => {
    const acrobatics = PF1E_SKILL_MAP["acrobatics"]; // Dex, ACP true
    const perception = PF1E_SKILL_MAP["perception"]; // Wis, ACP false
    expect(acrobatics).toBeDefined();
    expect(perception).toBeDefined();
    if (!acrobatics || !perception) return;
    const context = {
      abilities: { str: 2, dex: 2, con: 0, int: 0, wis: 2, cha: 0 },
      armorCheckPenalty: 3, // penalty of -3
    };

    const acro = derivePF1eSkill(acrobatics, { ranks: 2 }, context);
    expect(acro.armorCheckPenalty).toBe(-3);
    // Dex (2) + ranks (2) + ACP (-3) = 1
    expect(acro.total).toBe(1);

    const perc = derivePF1eSkill(perception, { ranks: 2 }, context);
    expect(perc.armorCheckPenalty).toBe(0);
    // Wis (2) + ranks (2) = 4
    expect(perc.total).toBe(4);
  });

  it("applies negative levels penalty (-1 per level) to skills", () => {
    const perception = PF1E_SKILL_MAP["perception"];
    expect(perception).toBeDefined();
    if (!perception) return;
    const context = {
      abilities: { str: 0, dex: 0, con: 0, int: 0, wis: 2, cha: 0 },
      armorCheckPenalty: 0,
      negativeLevels: 2,
    };
    const derived = derivePF1eSkill(perception, { ranks: 3, classSkill: true }, context);
    // Wis (2) + ranks (3) + classBonus (3) - negLevels (2) = 6
    expect(derived.total).toBe(6);
  });

  it("derives all skills on derivePF1eActor", () => {
    const d = derivePF1eActor({
      system: {
        abilities: { str: 14, dex: 16, con: 12, int: 10, wis: 14, cha: 8 },
        skills: {
          perception: { ranks: 3, classSkill: true },
          stealth: { ranks: 1, classSkill: false },
        },
      },
    });

    expect(d.skills).toBeDefined();
    expect(d.skills.perception?.ranks).toBe(3);
    expect(d.skills.perception?.classSkill).toBe(true);
    expect(d.skills.perception?.classSkillBonus).toBe(3);
    // Wis mod is +2, ranks 3, classSkill 3 => total = 8
    expect(d.skills.perception?.total).toBe(8);

    expect(d.skills.stealth?.ranks).toBe(1);
    expect(d.skills.stealth?.classSkill).toBe(false);
    // Dex mod is +3, ranks 1 => total = 4
    expect(d.skills.stealth?.total).toBe(4);
  });
});
