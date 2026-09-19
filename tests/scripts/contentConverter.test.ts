/**
 * PF1e content converter (tools/convert/) — the mappers checked against REAL source
 * samples (tests/content/fixtures/ are the actual files at the pinned commits, see
 * tools/adopt/INVENTORY.md), plus the drop-report contract and a small end-to-end CLI
 * run against a staged vendor dir.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BAB_PROGRESSION,
  SAVE_PROGRESSION,
  htmlToMarkdown,
  mapEntry,
  mapItem,
  newReport,
  slugify,
  stripHtml,
  type MappedEntry,
} from "../../tools/convert/mappers.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(repoRoot, "tests/content/fixtures", name), "utf8"));
const yamlFixture = (name: string): unknown => parseYaml(readFileSync(join(repoRoot, "tests/content/fixtures", name), "utf8"));

const used = () => new Set<string>();
/** The mapped entry's system block (cast to the concrete shape a test reads — no `any`). */
const sysOf = (e: MappedEntry): Record<string, unknown> => e.data.system ?? {};
/** Same, for a nullable entry (the dispatch test). */
const sysOfOpt = (e: MappedEntry | null | undefined): Record<string, unknown> | undefined => e?.data.system;
const take = (e: MappedEntry | null): MappedEntry => {
  expect(e).not.toBeNull();
  if (e === null) throw new Error("mapper returned null");
  return e;
};

describe("tables", () => {
  test("class progressions match the in-repo levels-table convention (D-234)", () => {
    // barbarian (good BAB, fort high / ref,will low), levels 1..5, as shipped in
    // systems/pf1e-core/packs/classes.json:
    expect([1, 2, 3, 4, 5].map((n) => BAB_PROGRESSION.good(n))).toEqual([1, 2, 3, 4, 5]);
    expect([1, 2, 3, 4, 5].map((n) => SAVE_PROGRESSION.high(n))).toEqual([2, 3, 3, 4, 4]);
    expect([1, 2, 3, 4, 5].map((n) => SAVE_PROGRESSION.low(n))).toEqual([0, 1, 1, 2, 2]);
  });
});

describe("helpers", () => {
  test("slugify lowercases, dashes, caps length, dedupes", () => {
    const u = new Set<string>();
    expect(slugify("Power Attack (Mythic)", u)).toBe("power-attack-mythic");
    expect(slugify("Power Attack (Mythic)", u)).toBe("power-attack-mythic-2");
    expect(slugify("  ", u)).toBe("entry");
    // leading garbage trims away; a digit lead is legal
    expect(slugify("!!!weird", u)).toBe("weird");
    expect(slugify("9-lives", u)).toBe("9-lives");
  });

  test("stripHtml flattens the Foundry description HTML", () => {
    expect(stripHtml("<p>A <i>fireball</i> deals <b>1d6</b> damage.</p><p>More.</p>")).toBe(
      "A fireball deals 1d6 damage. More.",
    );
    // one pass: `&amp;` decodes to `&`, and the following `quot;` is literal text, not an entity
    expect(stripHtml("Tom &amp; Jerry &amp;quot;quoted&quot;")).toBe("Tom & Jerry &quot;quoted\"");
    expect(stripHtml(42 as unknown as string)).toBeUndefined();
  });
});

describe("spell (pf1-system YAML, real Fireball)", () => {
  const entry = () => mapEntry(yamlFixture("fireball.yaml"), newReport(), used());

  interface SpellSystem {
    school?: string;
    descriptors?: string[];
    level?: Record<string, number>;
    levelNumber?: number;
    components?: Record<string, unknown>;
    castingTime?: string;
    range?: string;
    area?: string;
    duration?: string;
    savingThrow?: string;
    notes?: string;
    description?: string;
    foundry?: { learnedAt?: { class?: Record<string, number> }; actions?: unknown[]; sources?: unknown };
  }

  test("maps the in-repo spell shape (level table, school, components, range, save)", () => {
    const e = take(entry());
    const sys = sysOf(e) as SpellSystem;
    expect(e.name).toBe("Fireball");
    expect(e.id).toBe("fireball");
    expect(sys.school).toBe("Evocation");
    expect(sys.descriptors).toEqual(["fire"]);
    expect(sys.level).toMatchObject({ sorcerer: 3, wizard: 3, arcanist: 3, magus: 3 });
    expect(sys.levelNumber).toBe(3);
    expect(sys.components).toMatchObject({
      verbal: true,
      somatic: true,
      material: "a ball of bat guano and sulfur",
    });
    expect(sys.castingTime).toBe("1 standard action");
    expect(sys.range).toBe("long (400 ft. + 40 ft./level)");
    expect(sys.area).toBe("20-ft.-radius spread");
    expect(sys.duration).toBe("instantaneous");
    expect(sys.savingThrow).toBe("Reflex half");
    expect(sys.notes).toBe("1d6 damage per level, 20-ft. radius.");
    expect(typeof sys.description).toBe("string");
    expect(sys.foundry?.learnedAt?.class).toMatchObject({ sorcerer: 3 });
    expect(Array.isArray(sys.foundry?.actions)).toBe(true);
    expect(sys.foundry?.sources).toBeDefined();
  });

  test("keywords carry school + descriptors for compendium search", () => {
    expect(entry()?.keywords).toEqual(["spell", "evocation", "fire"]);
  });
});

describe("class (pf1-system YAML, real Barbarian)", () => {
  interface ClassSystem {
    hd?: string;
    babProgression?: string;
    goodSaves?: string[];
    skillRanksPerLevel?: number;
    classSkills?: string[];
    armorProf?: string[];
    levels: { level: number; bab: number; fort: number; ref: number; will: number }[];
    foundry?: { links?: { supplements?: unknown[] } };
  }

  test("maps hd/bab/goodSaves/skills/armorProf + the 20-level table", () => {
    const e = take(mapEntry(yamlFixture("barbarian.yaml"), newReport(), used()));
    const sys = sysOf(e) as unknown as ClassSystem;
    expect(e.data.type).toBe("actor");
    expect(sys.hd).toBe("d12");
    expect(sys.babProgression).toBe("good");
    expect(sys.goodSaves).toEqual(["fort"]);
    expect(sys.skillRanksPerLevel).toBe(4);
    expect(sys.classSkills).toContain("Acrobatics");
    expect(sys.classSkills).toContain("Knowledge");
    expect(sys.armorProf).toEqual(["light", "medium", "shields"]);
    expect(sys.levels.length).toBe(20);
    expect(sys.levels[0]).toEqual({ level: 1, bab: 1, fort: 2, ref: 0, will: 0 });
    expect(sys.levels[19]).toEqual({ level: 20, bab: 20, fort: 12, ref: 10, will: 10 });
    // the per-level feature links are Foundry-internal uuids — carried, not resolved
    expect(sys.foundry?.links?.supplements?.length).toBeGreaterThan(0);
  });
});

describe("feat (pf1e-content JSON, real Power Attack (Mythic))", () => {
  interface FeatSystem {
    category?: string;
    description?: string;
    foundry?: { uses?: unknown; changes?: unknown };
  }

  test("maps category from the real tags, keeps uses/changes raw", () => {
    const e = take(mapEntry(fixture("feat-power-attack.json"), newReport(), used()));
    const sys = sysOf(e) as FeatSystem;
    expect(e.name).toBe("Power Attack (Mythic)");
    expect(sys.category).toBe("combat");
    expect(typeof sys.description).toBe("string");
    expect(sys.foundry?.uses).toBeDefined();
    expect(sys.foundry?.changes).toBeDefined();
    expect(e.keywords).toContain("feat");
    expect(e.keywords).toContain("combat");
  });
});

describe("item (pf1e-content JSON, real Abjurant Salt)", () => {
  interface ItemSystem {
    category?: string;
    armor?: Record<string, number>;
    hp?: number;
    hardness?: number;
    weight?: number;
  }

  test("maps kind + armor shape (pf1e-content { value, dex, acp }) + item hp/hardness", () => {
    const e = take(mapItem(fixture("item-wondrous.json"), newReport(), used()));
    const sys = sysOf(e) as ItemSystem;
    expect(sys.category).toBe("equipment");
    expect(sys.armor).toMatchObject({ armorBonus: 0, maxDexBonus: 0, checkPenalty: 0 });
    expect(sys.hp).toBe(10);
    expect(sys.hardness).toBe(0);
    expect(sys.weight).toBe(1);
    expect(e.keywords).toEqual(["equipment"]);
  });
});

describe("actor (real sources: companion JSON + NPC YAML)", () => {
  interface Pf1eActor {
    size?: string;
    abilities?: Record<string, number>;
    hp?: number;
    hpMax?: number;
    speedFt?: number;
    saves?: { fort?: number; ref?: number; will?: number };
    savesAsTotal?: boolean;
    acTotals?: { normal: number };
  }

  test("companion (pf1e-content): abilities as scores, hp, speed, saves-as-totals, no fabricated AC", () => {
    const report = newReport();
    const e = take(mapEntry(fixture("companion-allosaurus.json"), report, used()));
    const sys = sysOf(e) as { pf1e: Pf1eActor };
    expect(e.data.type).toBe("actor");
    expect(sys.pf1e.abilities).toEqual({ str: 14, dex: 16, con: 10, int: 2, wis: 15, cha: 10 });
    expect(sys.pf1e.hp).toBe(9);
    expect(sys.pf1e.hpMax).toBe(9);
    expect(sys.pf1e.speedFt).toBe(40);
    expect(sys.pf1e.saves).toEqual({ fort: 2, ref: 5, will: 2 });
    expect(sys.pf1e.savesAsTotal).toBe(true);
    expect(sys.pf1e.size).toBe("Medium");
    // the source authored ac 0 (derived from equipment) — the converter must not fabricate totals
    expect(sys.pf1e.acTotals).toBeUndefined();
    expect(report.fields["ac (authored 0 — derived from equipment, not carried)"]).toBe(1);
    expect(e.keywords).toContain("character");
    expect(e.keywords).toContain("medium");
  });

  test("NPC (pf1-system YAML): size from traits, abilities, and the no-AC drop is counted", () => {
    const report = newReport();
    const e = take(mapEntry(yamlFixture("goblin-npc.yaml"), report, used()));
    const sys = sysOf(e) as { pf1e: Pf1eActor };
    expect(sys.pf1e.size).toBe("Small");
    expect(sys.pf1e.abilities).toBeDefined();
    expect(sys.pf1e.abilities?.str).toBeGreaterThan(0);
    expect(sys.pf1e.speedFt).toBe(30);
    expect(report.fields["ac (absent — composed by the sheet from defaults)"]).toBe(1);
  });
});

describe("htmlToMarkdown (journal pages)", () => {
  test("headings, bold/italic, lists, and Foundry link/source tags", () => {
    expect(htmlToMarkdown("<h1>Title</h1><p><strong>bold</strong> &amp; <em>ital</em></p>")).toBe(
      "# Title\n\n**bold** & *ital*",
    );
    const md = htmlToMarkdown(
      "<p><strong>Source</strong>: @Source[CRB;pages=183]</p><ul><li>one</li><li>two</li></ul>",
    );
    expect(md).toBeDefined();
    expect(md).toContain("**Source**: CRB p. 183");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
    // compendium + uuid links become their label text
    expect(
      htmlToMarkdown("See @Compendium[pf1.pf1e-rules.abc]{Attacks of Opportunity} and @UUID[x.y.z]{Climb}."),
    ).toBe("See Attacks of Opportunity and Climb.");
    expect(htmlToMarkdown("")).toBeUndefined();
    expect(htmlToMarkdown(42 as unknown as string)).toBeUndefined();
  });
});

describe("roll table (pf1-system YAML, real Arcane Malignancies)", () => {
  interface RollTableData {
    type: string;
    formula: string;
    results: { range: [number, number]; text: string; documentRef: null }[];
  }

  test("maps formula + results (range/text/documentRef) into RollTableDocument shape", () => {
    const e = take(mapEntry(yamlFixture("rolltable-arcane-malignancies.yaml"), newReport(), used()));
    const data = e.data as unknown as RollTableData;
    expect(e.name).toBe("Arcane Malignancies");
    expect(data.type).toBe("rollTable");
    expect(data.formula).toBe("1d100");
    expect(data.results.length).toBeGreaterThan(10);
    const r0 = data.results[0];
    if (!r0) throw new Error("roll table has no results");
    expect(r0.documentRef).toBeNull();
    expect(Array.isArray(r0.range)).toBe(true);
    expect(r0.range[0]).toBe(1);
    expect(typeof r0.text).toBe("string");
    expect(r0.text.length).toBeGreaterThan(10);
  });

  test("string ranges parse; unparseable results are counted", () => {
    const report = newReport();
    const e = take(
      mapEntry(
        { _key: "!tables!x", name: "T", formula: "1d6", results: [{ range: "1-2", name: "ok" }, { name: "no range" }] },
        report,
        used(),
      ),
    );
    const data = e.data as unknown as { results: RollTableData["results"] };
    expect(data.results).toEqual([{ range: [1, 2], text: "ok", documentRef: null }]);
    expect(report.fields["roll-table result (unparseable range)"]).toBe(1);
  });
});

describe("journal (rules documents)", () => {
  interface JournalData {
    type: string;
    pages: { name: string; text: string; src: null }[];
  }

  test("pf1-system YAML: pages from the nested text.content, HTML → markdown", () => {
    const e = take(mapEntry(yamlFixture("journal-combat-pf1.yaml"), newReport(), used()));
    const data = e.data as unknown as JournalData;
    expect(data.type).toBe("journal");
    expect(data.pages).toHaveLength(1);
    const page = data.pages[0];
    if (!page) throw new Error("journal has no page");
    expect(page.name).toBe("Attacks of Opportunity");
    expect(page.src).toBeNull();
    expect(page.text).toContain("## Table 8-2: Actions in Combat");
    expect(page.text).toContain("**Source**: CRB p. 183");
    expect(page.text).toContain("- Cast a spell (1 standard action casting time)");
    expect(page.text).toContain("Attacks of Opportunity"); // @Compendium label
    expect(page.text).not.toContain("<");
  });

  test("pf1e-content JSON: top-level content becomes one markdown page", () => {
    const e = take(mapEntry(fixture("journal-vehicles-in-combat.json"), newReport(), used()));
    const data = e.data as unknown as JournalData;
    expect(data.type).toBe("journal");
    expect(data.pages.length).toBeGreaterThan(0);
    const text = data.pages.map((p) => p.text).join("\n");
    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain("@Source[");
    expect(text).not.toContain("@Compendium[");
    expect(text).not.toContain("<h1");
  });
});

describe("dispatch", () => {
  test("routes on the Foundry entry type", () => {
    const mk = (type: string) => ({ type, name: "X", system: {} });
    expect(sysOfOpt(mapEntry(mk("spell"), newReport(), used()))?.category).toBeUndefined();
    expect(sysOfOpt(mapEntry(mk("feat"), newReport(), used()))?.category).toBe("general");
    expect(sysOfOpt(mapEntry(mk("class"), newReport(), used()))?.babProgression).toBe("good");
    expect(sysOfOpt(mapEntry(mk("npc"), newReport(), used()))?.pf1e).toBeDefined();
    expect(sysOfOpt(mapEntry(mk("equipment"), newReport(), used()))?.category).toBe("equipment");
    expect(sysOfOpt(mapEntry(mk("wondrous"), newReport(), used()))?.category).toBe("wondrous");
  });
});

// ─── CLI end-to-end (a staged vendor dir, not the real 150 MB checkouts) ────────

const stage = mkdtempSync(join(tmpdir(), "pf1e-convert-"));
const vendor = join(stage, "vendor");
const out = join(stage, "out");

beforeAll(() => {
  // staged vendor: every entry kind + every drop kind, from the real fixtures
  const fx = (name: string) => readFileSync(join(repoRoot, "tests/content/fixtures", name), "utf8");
  mkdirSync(join(vendor, "pf1-system/packs/spells/evocation"), { recursive: true });
  mkdirSync(join(vendor, "pf1-system/packs/ultimate-equipment"), { recursive: true });
  mkdirSync(join(vendor, "pf1-system/packs/rules"), { recursive: true });
  mkdirSync(join(vendor, "pf1e-content/src/packs/pf-feats"), { recursive: true });
  mkdirSync(join(vendor, "pf1e-content/src/packs/pf-rules"), { recursive: true });
  // YAML: a folder descriptor (must be dropped), a spell, a roll table, a macro (dropped), a journal
  writeFileSync(
    join(vendor, "pf1-system/packs/spells/evocation.school.yaml"),
    "_key: '!folders!evocation-school'\nname: Evocation\nsort: 0\nsorting: a\ntype: Item\n",
  );
  writeFileSync(join(vendor, "pf1-system/packs/spells/evocation/fireball.yaml"), fx("fireball.yaml"));
  writeFileSync(join(vendor, "pf1-system/packs/ultimate-equipment/arcane-malignancies.yaml"), fx("rolltable-arcane-malignancies.yaml"));
  writeFileSync(join(vendor, "pf1-system/packs/ultimate-equipment/roll-skill.yaml"), fx("macro-roll-skill.yaml"));
  writeFileSync(join(vendor, "pf1-system/packs/rules/combat.yaml"), fx("journal-combat-pf1.yaml"));
  // JSON: a feat, a compendium-folder stub (dropped), a rules journal
  writeFileSync(join(vendor, "pf1e-content/src/packs/pf-feats/Power-Attack-(Mythic).json"), fx("feat-power-attack.json"));
  writeFileSync(
    join(vendor, "pf1e-content/src/packs/pf-rules/#[CF_tempEntity]-xyz.json"),
    '{"name": "#[CF_tempEntity]", "flags": {"cf": {"path": "Rules"}}}',
  );
  writeFileSync(join(vendor, "pf1e-content/src/packs/pf-rules/Vehicles.json"), fx("journal-vehicles-in-combat.json"));
  writeFileSync(join(vendor, "pf1e-content/OGL.txt"), "OGL 1.0a (stub for the test)\n");
});

afterAll(() => {
  rmSync(stage, { recursive: true, force: true });
});

test("CLI: converts the staged vendor dir into a package + report", () => {
  const cli = join(repoRoot, "tools/convert/index.mjs");
  execFileSync(
    process.execPath,
    [cli, "--vendor", vendor, "--out", out, "--only", "spells-core,feats,ultimate-equipment,rules-core,rules"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
    id: string;
    type: string;
    packs: { name: string; type: string; file: string }[];
  };
  expect(manifest.id).toBe("pf1e-content");
  expect(manifest.type).toBe("data");
  // config order; roll tables and journals target their own top-level collections
  expect(manifest.packs).toEqual([
    { name: "PF1e Spells (Core)", type: "items", file: "packs/spells-core.json" },
    { name: "PF1e Ultimate Equipment", type: "rollTables", file: "packs/ultimate-equipment.json" },
    { name: "PF1e Rules (Core)", type: "journals", file: "packs/rules-core.json" },
    { name: "PF1e Feats (Expanded)", type: "items", file: "packs/feats.json" },
    { name: "PF1e Rules (Reference)", type: "journals", file: "packs/rules.json" },
  ]);
  const spells = JSON.parse(readFileSync(join(out, "packs/spells-core.json"), "utf8")) as {
    entries: { name: string }[];
  };
  expect(spells.entries.length).toBe(1);
  expect(spells.entries[0]?.name).toBe("Fireball");
  const report = readFileSync(join(out, "REPORT.md"), "utf8");
  expect(report).toContain("folder descriptor, not an entry");
  expect(report).toContain("macro (module-API JS — dropped, P-6 mapping)");
  expect(report).toContain("compendium-folder stub, not an entry");
  expect(report).toContain("5 source entries → 5 pack entries");
  expect(readFileSync(join(out, "OGL.txt"), "utf8")).toContain("OGL 1.0a");
  expect(readFileSync(join(out, "CREDITS.md"), "utf8")).toContain("pf1e-content");
});
