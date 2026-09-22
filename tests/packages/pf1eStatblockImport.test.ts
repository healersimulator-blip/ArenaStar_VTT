/**
 * §3.2 (G-08, D-267) — **statblock import**, the parts that are rules rather than wiring.
 *
 * The fixtures are the SRD's own stat blocks as a GM gets them by selecting a creature on a wiki or
 * copying out of a PDF: a **goblin warrior** (Bestiary 1, the `small humanoid` case with two weapon
 * lines and a Racial Modifiers line) and an **imp** (Bestiary 1, the case with natural attacks,
 * `DR 5/good or silver`, spell resistance, a multi-line `Spell-Like Abilities` block, a fly speed
 * with a manoeuvrability word, and `Space`/`Reach`). Both keep their printed layout — section
 * headings, `;`-separated clauses, continuation lines — because that layout is what the reader has
 * to survive. The `imp` block is additionally asserted to be *refused* file-import-shaped text?
 * No: nothing here is asserted to be refused unless it is genuinely unreadable.
 *
 * What the assertions are for is the three house rules `types.ts` states, and every expectation
 * below is one of them:
 *
 * - **never invent** — a block with no ability line leaves `abilities` absent instead of filling in
 *   10s (`a block with no ability line authors none`);
 * - **never double the arithmetic** — `acTotals` + `acMode: "published"` and `savesAsTotal` are
 *   authored as the totals a stat block publishes, and the two printed numbers this app derives
 *   (attack bonuses, skill modifiers) are *not* imported at all, only reported;
 * - **report what was left behind** — the same warnings carry the numbers in the block's own words.
 */
import { describe, expect, test } from "vitest";
import {
  characterImportCheck,
  characterImportOps,
  characterImportReport,
  detectCharacterFormat,
  detectPastedFormat,
  importCharacter,
  importStatblock,
  looksLikeStatblock,
} from "../../src/packages/pf1e/import";
import { normalizePF1eSystem } from "../../src/packages/pf1e/statBlock";
import { parsePF1eActorSystem } from "../../src/packages/pf1e/actor";

/** Bestiary 1, `Goblin Warrior` — as printed, headings and all. */
const GOBLIN = `Goblin Warrior CR 1/3
XP 135
Goblin warrior 1
NE Small humanoid (goblinoid)
Init +6; Senses darkvision 60 ft.; Perception -1

DEFENSE

AC 16, touch 13, flat-footed 14 (+2 armor, +2 Dex, +1 shield, +1 size)
hp 6 (1d10+1)
Fort +3, Ref +4, Will -1

OFFENSE

Speed 30 ft.
Melee short sword +2 (1d4/19-20)
Ranged short bow +4 (1d4/×3)

STATISTICS

Str 11, Dex 15, Con 12, Int 10, Wis 9, Cha 6
Base Atk +1; CMB +1; CMD 12
Feats Improved Initiative
Skills Ride +6, Stealth +10; Racial Modifiers +4 Ride, +4 Stealth
Languages Goblin
SQ darkvision 60 ft.

ECOLOGY

Environment temperate forest and plains (usually coastal regions)
Organization gang (4–9), warband (10–16 with goblin dogs), or tribe (17+)
Treasure NPC gear (leather armor, light wooden shield, short sword, short bow with 20 arrows)`;

/** Bestiary 1, `Imp` — the case with prose that wraps and a spell-like ability list. */
const IMP = `Imp CR 2
XP 600
LE Tiny outsider (devil, evil, extraplanar, lawful)
Init +3; Senses darkvision 60 ft., detect good, detect magic, see in darkness; Perception +7

DEFENSE

AC 17, touch 15, flat-footed 14 (+3 Dex, +2 natural, +2 size)
hp 16 (3d10)
Fort +1, Ref +6, Will +4
DR 5/good or silver; Immune fire, poison; Resist cold 10, acid 10; SR 12

OFFENSE

Speed 20 ft., fly 50 ft. (perfect)
Melee sting +8 (1d4+1 plus poison)
Space 2-1/2 ft.; Reach 0 ft.
Spell-Like Abilities (CL 6th; concentration +7)
Constant—detect good, detect magic, invisibility (self only)
1/day—augury, charm person (DC 13), commune, suggestion (DC 15)
Special Attacks poison

STATISTICS

Str 12, Dex 17, Con 10, Int 13, Wis 12, Cha 14
Base Atk +3; CMB +1; CMD 13
Feats Dodge, Weapon Finesse
Skills Acrobatics +9, Bluff +8, Fly +14, Knowledge (arcana) +7, Perception +7, Stealth +17
Languages Common, Infernal; telepathy 100 ft.
SQ change shape (boar, giant spider, rat, or raven, beast shape I), fast healing 2

ECOLOGY

Environment any (Hell)
Organization solitary, pair, or flock (3–10)
Treasure standard`;

const systemOf = (text: string): Record<string, unknown> => {
  const parsed = importStatblock(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.system;
};

const warningsOf = (text: string): string => {
  const parsed = importStatblock(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.warnings.join("\n");
};

describe("statblock import — a goblin warrior", () => {
  test("reads the header: name, CR and the type line", () => {
    const parsed = importStatblock(GOBLIN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.format).toBe("statblock");
    expect(parsed.value.name).toBe("Goblin Warrior");
    expect(parsed.value.items).toEqual([]);
    expect(parsed.value.system.creature).toMatchObject({
      cr: "1/3",
      alignment: "NE",
      type: "humanoid (goblinoid)",
    });
  });

  test("authors the published totals as totals, never as components", () => {
    const system = systemOf(GOBLIN);
    expect(system.size).toBe("Small");
    expect(system).toMatchObject({
      acTotals: { normal: 16, touch: 13, flatFooted: 14 },
      acMode: "published",
      saves: { fort: 3, ref: 4, will: -1 },
      savesAsTotal: true,
      hp: 6,
      hpMax: 6,
      hitDice: 1,
      baseAttack: 1,
      cmb: 1,
      cmd: 12,
      speedFt: 30,
      feats: ["Improved Initiative"],
    });
    // No component was invented from the printed breakdown: the app has no idea how much of the
    // AC is armor and how much is size, and it must not pretend (`(+2 armor, +2 Dex, +1 shield,
    // +1 size)` is reported instead — see the read lines below). And `ac` (the flat stat-block
    // spelling) is not authored either, so `normalizePF1eSystem` does not treat this as a profile.
    expect(system.armorClass).toBeUndefined();
    expect(system.armor).toBeUndefined();
    expect(system.ac).toBeUndefined();
  });

  test("reads both printed attack lines, and refuses the printed attack bonuses", () => {
    const system = systemOf(GOBLIN);
    const attacks = (system.attacks ?? []) as Array<Record<string, unknown>>;
    expect(attacks).toEqual([
      { name: "short sword", damageDice: "1d4", critThreatMin: 19 },
      { name: "short bow", ranged: true, damageDice: "1d4", critMultiplier: 3 },
    ]);
    // The two printed `+2` / `+4` are the app's to derive from Base Atk + Dex + size: importing
    // them would double-count the very components the block already states.
    const warnings = warningsOf(GOBLIN);
    expect(warnings).toContain(
      'printed attack bonus on "short sword" (+2) was not imported',
    );
    expect(warnings).toContain(
      'printed attack bonus on "short bow" (+4) was not imported',
    );
  });

  test("reports the skill modifiers, the XP line and the environment rather than placing them", () => {
    const warnings = warningsOf(GOBLIN);
    expect(warnings).toContain("Ride +6, Stealth +10");
    expect(warnings).toContain("+4 Ride, +4 Stealth");
    expect(warnings).toContain("XP was not placed (135)");
    expect(warnings).toContain("environment was not placed");
    expect(warnings).toContain("organization was not placed");
  });

  test("keeps the block's prose the sheet can show, and names what it read", () => {
    const system = systemOf(GOBLIN);
    expect(system.creature).toMatchObject({
      senses: "darkvision 60 ft.",
      languages: "Goblin",
      treasure:
        "NPC gear (leather armor, light wooden shield, short sword, short bow with 20 arrows)",
    });
    const parsed = importStatblock(GOBLIN);
    if (!parsed.ok) throw new Error(parsed.error);
    const read = parsed.value.read.join("\n");
    expect(read).toContain("abilities: str 11, dex 15, con 12, int 10, wis 9, cha 6");
    expect(read).toContain("initiative +6 (Dex +2, misc +4)");
    expect(read).toContain("armor class: 16, touch 13, flat-footed 14 (published totals)");
    expect(read).toContain("the block's own AC breakdown: +2 armor, +2 Dex, +1 shield, +1 size");
    expect(read).toContain("hit points: 6 (1 Hit Dice)");
    expect(read).toContain("saves: fort +3, ref +4, will -1 (published totals)");
  });

  test("the derived numbers are the same ones the sheet's own parse produces", () => {
    const system = systemOf(GOBLIN);
    const parsed = parsePF1eActorSystem(system);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // AC is the published total, not Dex + armor the app would have had to guess at.
    expect(parsed.value.acTotals).toMatchObject({ normal: 16 });
    expect(parsed.value.savesAsTotal).toBe(true);
    // `normalizePF1eSystem` is the one place a flat profile becomes components. An imported
    // statblock is already the sheet's shape, so it must pass through untouched: no `converted`
    // line, nothing dropped, nothing rewritten.
    const normalized = normalizePF1eSystem(system);
    expect(normalized.converted).toEqual([]);
    expect(normalized.system).toEqual(system);
  });

  test("the whole G-39 pipeline applies unchanged: check, one create op, report", () => {
    const parsed = importStatblock(GOBLIN);
    if (!parsed.ok) throw new Error(parsed.error);
    const character = characterImportCheck(parsed.value);
    expect(character.ok).toBe(true);
    if (!character.ok) return;
    const ops = characterImportOps(character.value, { id: "a-statblock", gmId: "u-gm" });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "create",
      coll: "actors",
      data: { _id: "a-statblock", name: "Goblin Warrior", items: [] },
    });
    const report = characterImportReport(character.value);
    expect(report.format).toBe("statblock");
    expect(report.name).toBe("Goblin Warrior");
    expect(report.counts).toEqual({ items: 0, weapons: 0, attackLines: 2 });
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});

describe("statblock import — an imp, where the prose wraps", () => {
  const system = systemOf(IMP);

  test("multi-line spell-like abilities stay together in the source's words", () => {
    const creature = system.creature as Record<string, string>;
    expect(creature.specialAttacks).toContain("Spell-Like Abilities");
    expect(creature.specialAttacks).toContain("Constant—detect good, detect magic, invisibility");
    expect(creature.specialAttacks).toContain("1/day—augury, charm person (DC 13)");
    expect(creature.specialAttacks).toContain("poison");
    const warnings = warningsOf(IMP);
    expect(warnings).toContain(
      "spell-like abilities are recorded as text on the monster details",
    );
  });

  test("defensive numbers: DR with its bypass list, SR, and the qualities as prose", () => {
    expect(system).toMatchObject({ dr: 5, drBypass: ["good", "silver"], spellResistance: 12 });
    const creature = system.creature as Record<string, string>;
    expect(creature.sq).toContain("Immune: fire, poison");
    expect(creature.sq).toContain("Resist: cold 10, acid 10");
    expect(creature.sq).toContain("fast healing 2");
    // `fast healing 2` is a modelled number, so it is read out of the SQ prose as well as kept.
    expect(system.fastHealing).toBe(2);
  });

  test("mixed speeds, the manoeuvrability word, and the Tininess that follows from the size", () => {
    expect(system).toMatchObject({ size: "Tiny", speedFt: 20, flySpeedFt: 50 });
    expect(warningsOf(IMP)).toContain("fly speed states manoeuvrability \"perfect\"");
    // `Space` and `Reach` are printed together: the space confirms the size the token already
    // takes, the reach (0 ft. for a Tiny creature) is what the app derives from that size too, so
    // both are read lines rather than authored fields.
    const parsed = importStatblock(IMP);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.read.join("\n")).toContain("space: 2-1/2 ft.");
    expect(system.reachSquares).toBeUndefined();
  });

  test("a damage line with an extra effect keeps the dice and reports the effect", () => {
    const attacks = (system.attacks ?? []) as Array<Record<string, unknown>>;
    expect(attacks).toEqual([
      {
        name: "sting",
        natural: true,
        damageDice: "1d4",
        damageBonus: 1,
        abilityDamageIncluded: true,
      },
    ]);
    expect(warningsOf(IMP)).toContain(
      'the extra damage or effect text on "sting" was not imported (poison)',
    );
  });

  test("Perception printed in the Senses line is refused the way a skill total is", () => {
    expect(warningsOf(IMP)).toContain("Perception +7 was not imported");
  });
});

describe("statblock import — never invent", () => {
  test("a block with no ability line authors none, and says why", () => {
    const system = systemOf(`Cave Bat CR 1/4
N Diminutive animal
Init +2; Senses blindsense 30 ft.; Perception +6

DEFENSE
AC 16, touch 16, flat-footed 14
hp 4 (1d8)

OFFENSE
Speed 5 ft., fly 40 ft. (good)
Melee bite +6 (1d3-1)`);
    expect(system.abilities).toBeUndefined();
    expect(system.size).toBe("Diminutive");
    const warnings = warningsOf(`Cave Bat CR 1/4
N Diminutive animal
Init +2; Senses blindsense 30 ft.; Perception +6

DEFENSE
AC 16, touch 16, flat-footed 14
hp 4 (1d8)

OFFENSE
Speed 5 ft., fly 40 ft. (good)
Melee bite +6 (1d3-1)`);
    expect(warnings).toContain("no ability line was found");
    // Initiative is Dex + misc, so without a Dexterity score the printed total is reported too.
    expect(warnings).toContain("initiative 2 was not imported");
    // The Creature's AC and hp are still playable — a bestiary entry with no ability scores is
    // exactly the case the "refuse rather than fill in 10s" rule exists for.
    expect(system).toMatchObject({ hp: 4, acTotals: { normal: 16, touch: 16, flatFooted: 14 } });
    expect(parsePF1eActorSystem(system).ok).toBe(true);
  });

  test("a negative damage modifier is carried with the sign it printed", () => {
    const system = systemOf(`Cave Bat CR 1/4
N Diminutive animal
Str 1, Dex 15, Con 6, Int 2, Wis 14, Cha 5
Base Atk +0; CMB -5; CMD 7
Melee bite +6 (1d3-4)`);
    const attacks = (system.attacks ?? []) as Array<Record<string, unknown>>;
    expect(attacks[0]).toMatchObject({ name: "bite", damageDice: "1d3", damageBonus: -4 });
  });

  test("initiative keeps only the part that is not the Dexterity modifier", () => {
    // `Improved Initiative` is why this block's Initiative is +6 against Dex 15 (+2): the +4 is a
    // feat the app does not model, so it is authored as the misc bonus rather than dropped.
    const system = systemOf(`Goblin Warrior CR 1/3
NE Small humanoid (goblinoid)
Init +6
AC 16, touch 13, flat-footed 14
hp 6 (1d10+1)
Str 11, Dex 15, Con 12, Int 10, Wis 9, Cha 6`);
    expect(system.initiative).toBe(4);
  });

  test("a header line with no home is quoted in the report instead of dropped", () => {
    // `Goblin warrior 1` is the SRD's class line — the creature's level rides its Hit Dice, which
    // the hp line already stated. There is no field for it, so it is named, not swallowed.
    expect(warningsOf(GOBLIN)).toContain('the header line "Goblin warrior 1" was not placed');
  });

  test("prose without a playable number is refused, not created as an empty actor", () => {
    // The header block alone: a name, an XP line and a type line, with no numbers at all. An actor
    // built from this would open as a blank sheet, so it is refused where the GM can see why.
    const parsed = importStatblock(
      "Goblin Warrior CR 1/3\nXP 135\nGoblin warrior 1\nNE Small humanoid (goblinoid)",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("states no number this app can play");
    // And a paste of the name alone has nothing to read at all.
    const bare = importStatblock("Goblin Warrior");
    expect(bare.ok).toBe(false);
    if (bare.ok) return;
    expect(bare.error).toContain("no labelled lines were found");
  });

  test("no name is an error, and so is no text at all", () => {
    const nameless = importStatblock("CR 3\nNE Medium magical beast\nAC 15\nhp 20 (2d10+9)");
    expect(nameless.ok).toBe(false);
    if (!nameless.ok) expect(nameless.error).toContain("states no creature name");
    const empty = importStatblock("   \n  ");
    expect(empty.ok).toBe(false);
  });
});

describe("statblock import — shapes a real paste brings", () => {
  test("an iterated attack line (`+12/+7`) is one line with no printed bonus imported", () => {
    const system = systemOf(`Hill Giant Sniper CR 7
CE Large humanoid (giant)
AC 21, touch 9, flat-footed 21
hp 85 (10d8+40)
Speed 40 ft.
Ranged +1 composite longbow +12/+7 (1d8+8/×3)
Melee greatclub +13/+8 (2d8+10)
Str 25, Dex 10, Con 19, Int 7, Wis 12, Cha 7
Base Atk +7; CMB +14; CMD 24`);
    // Melee lines are read before ranged ones (the sheet's own order), and the iterated sequence
    // is not part of the name.
    expect((system.attacks as Array<Record<string, unknown>>).map((a) => a.name)).toEqual([
      "greatclub",
      "+1 composite longbow",
    ]);
    // The whole printed sequence stays in the report in the source's own spelling.
    expect(warningsOf(`Hill Giant Sniper CR 7
CE Large humanoid (giant)
AC 21, touch 9, flat-footed 21
hp 85 (10d8+40)
Ranged +1 composite longbow +12/+7 (1d8+8/×3)
Str 25, Dex 10, Con 19, Int 7, Wis 12, Cha 7`)).toContain(
      'the printed attack bonus on "+1 composite longbow" (+12/+7) was not imported',
    );
  });

  test("`or` prints a choice between attacks, not one attack with a strange name", () => {
    const system = systemOf(`Ettercap CR 3
NE Medium aberration
AC 15, touch 13, flat-footed 13
hp 30 (4d8+12)
Melee bite +5 (1d8+2 plus poison) or 2 claws +5 (1d4+2)
Str 14, Dex 15, Con 17, Int 6, Wis 13, Cha 8`);
    expect((system.attacks as Array<Record<string, unknown>>).map((a) => a.name)).toEqual([
      "bite",
      "claws",
      "claws",
    ]);
  });

  test("an ability line wrapped by a PDF paste keeps the scores on both lines", () => {
    const system = systemOf(`Wight CR 3
LE Medium undead
AC 15, touch 11, flat-footed 14
hp 26 (4d8+8)
Speed 30 ft.
Melee scimitar +5 (1d6+2/18-20)
Str 14, Dex 12, Con -, Int 11,
Wis 13, Cha 15
Base Atk +3; CMB +5; CMD 16`);
    // The continuation is labelled `Wis`, and its own value carries `Cha`: both are read, and the
    // two abilities printed with a dash (an undead's Constitution) are named, not invented.
    expect(system.abilities).toEqual({ str: 14, dex: 12, int: 11, wis: 13, cha: 15 });
    expect(warningsOf(`Wight CR 3
LE Medium undead
AC 15, touch 11, flat-footed 14
hp 26 (4d8+8)
Str 14, Dex 12, Con -, Int 11,
Wis 13, Cha 15`)).toContain("the ability line prints no score for Con");
  });

  test("CMB and CMD are the totals they print; a conditional modifier is reported", () => {
    const text = `Brown Bear CR 4
N Large animal
AC 16, touch 10, flat-footed 15
hp 42 (5d8+20)
Speed 40 ft.
Melee bite +7 (1d6+5 plus grab) and 2 claws +7 (1d6+5)
Str 21, Dex 13, Con 19, Int 2, Wis 12, Cha 6
Base Atk +3; CMB +9 (+13 grapple); CMD 20 (24 vs. trip)`;
    expect(systemOf(text)).toMatchObject({ cmb: 9, cmd: 20 });
    const warnings = warningsOf(text);
    expect(warnings).toContain("the CMB line's conditional modifier was not imported (+13 grapple)");
    expect(warnings).toContain("the CMD line's conditional modifier was not imported (24 vs. trip)");
  });
});

describe("statblock import — the front door", () => {
  test("a pasted block is recognised, and prose that merely mentions AC is not", () => {
    expect(looksLikeStatblock(GOBLIN)).toBe(true);
    expect(looksLikeStatblock(IMP)).toBe(true);
    expect(looksLikeStatblock("my notes: the goblin had AC 15 and I rolled a 12")).toBe(false);
    expect(
      looksLikeStatblock('{"pages":[{"text":"AC 15 and hp 6, Init +2, Melee sword +1"}]}'),
    ).toBe(false);
  });

  test("the file formats keep winning the sniffer", () => {
    expect(detectCharacterFormat(GOBLIN)).toBeNull();
    expect(detectPastedFormat(GOBLIN)).toBe("statblock");
    expect(detectPastedFormat('{"name":"X","attribs":[{"name":"hp","current":"3"}]}')).toBe(
      "roll20",
    );
    expect(detectPastedFormat("<document><public><character/></public></document>")).toBe(
      "herolab",
    );
    expect(
      detectPastedFormat("<document><public><character/></public></document>"),
    ).toBe(detectCharacterFormat("<document><public><character/></public></document>"));
  });

  test("importCharacter reads a pasted block, and still refuses a stranger", () => {
    const parsed = importCharacter(GOBLIN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.format).toBe("statblock");
    expect(parsed.value.name).toBe("Goblin Warrior");
    const json = importCharacter('{"title":"my campaign notes","pages":[]}');
    expect(json.ok).toBe(false);
    if (json.ok) return;
    expect(json.error).toContain("pasted Pathfinder 1e monster stat block");
  });
});
