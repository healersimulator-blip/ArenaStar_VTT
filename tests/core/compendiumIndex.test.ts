// Checklist: G-45 / plan §1.4 — the compendium index: parity with the reference search, the
// keystroke budget at 20k entries, and the facets the browser filters on.
/**
 * G-45 (closure plan §1.4) — "at 20k entries search is type-the-exact-name, browse is a capped
 * list". The fix is an index, and an index is only worth having if it answers **the same
 * question** as the code it replaces and fits in the memory the plan budgeted.
 *
 * Three properties are pinned here:
 *
 *  1. **Parity.** `searchIndex` ≡ `searchCompendia` — same hits, same order, same scores — over
 *     a corpus of queries aimed at every rung of the scorer: name prefix, word prefix, contains
 *     in the middle of a token, keyword substring, multi-term AND, 1- and 2-character terms,
 *     punctuation and possessives (the cases where "substring" and "token substring" could
 *     disagree if the index's shortcut were wrong), and queries that match nothing at all.
 *  2. **Budget.** Summed keystroke cost for a realistic typed query at 20,000 entries, with the
 *     measured number *printed* (the V08 convention: the assertion is loose so the test cannot
 *     flake, the printout is what a reviewer reads).
 *  3. **Footprint.** The accounted index size, asserted ≤ 8 MB — the plan's number — with entry
 *     bodies absent by construction (the index holds ids, names, keywords, facets only).
 *
 * The corpus is synthetic but **shaped like the converted packs** (D-253): spells with a level
 * record and a school, feats with a category keyword, items with the item mapper's `category`,
 * creatures with `system.pf1e`, roll tables and journals. A synthetic corpus is deliberate: the
 * 25,376 real entries need the 262 MB vendor checkout, and a test that skips is a test that
 * hides a regression.
 */
import { describe, expect, test } from "vitest";
import {
  parseCompendiumPack,
  searchCompendia,
  type CompendiumEntry,
  type CompendiumPack,
} from "../../src/core/compendium";
import {
  buildCompendiumIndex,
  entryFacetsOf,
  indexFootprintBytes,
  rankIndex,
  searchIndex,
} from "../../src/core/compendiumIndex";

// ─── corpus ───────────────────────────────────────────────────────────────────

const SCHOOLS = ["Abjuration", "Conjuration", "Divination", "Enchantment", "Evocation", "Illusion", "Necromancy", "Transmutation"];
const DESCRIPTORS = ["acid", "cold", "electricity", "fire", "sonic", "mind-affecting", "fear", "light"];
const FEAT_CATEGORIES = ["combat", "general", "metamagic", "teamwork", "item-creation", "critical"];
const ITEM_KINDS = ["weapon", "armor", "consumable", "wondrous", "artifact", "shield", "gear"];
const CREATURE_TYPES = ["humanoid", "undead", "dragon", "aberration", "outsider", "beast", "construct"];
const SPELL_WORDS = ["acid", "arrow", "ball", "bolt", "burst", "charm", "circle", "cloud", "cone", "cure", "curse", "death", "detect", "dimension", "dispel", "dominate", "elemental", "fire", "flame", "fog", "frost", "gate", "globe", "hand", "heal", "hold", "ice", "light", "lightning", "mage", "magic", "mass", "minor", "monster", "orb", "phantom", "poison", "prayer", "protection", "ray", "resistance", "shield", "silence", "sleep", "spear", "stone", "storm", "summon", "symbol", "wall", "ward", "web", "word"];

/** Test-side totality helper: a missing corpus element is a bug in the corpus, not a case. */
const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`test corpus bug: ${what} is missing`);
  return v;
};

let seed = 12345;
const rnd = (): number => {
  // xorshift32 — deterministic corpus, so a failure is reproducible from the seed alone.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return Math.abs(seed) / 0x7fffffff;
};
const pick = <T>(list: readonly T[]): T =>
  must(list[Math.floor(rnd() * list.length) % list.length], "corpus pick");

const slug = (name: string, i: number): string =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i}`;

const cap = (s: string): string => s.replace(/^./, (c) => c.toUpperCase());

function spellEntry(i: number): CompendiumEntry {
  // Three name shapes, because the search rungs distinguish them: two words ("Acid Arrow"),
  // a compound token ("Fireball" — the case a prefix-only index would get wrong), and a
  // meta-prefixed name ("Greater Fireball").
  const shape = i % 3;
  const name =
    shape === 0
      ? `${cap(pick(SPELL_WORDS))} ${cap(pick(SPELL_WORDS))}`
      : shape === 1
        ? `${cap(pick(SPELL_WORDS))}${pick(SPELL_WORDS)}`
        : `${pick(["Greater ", "Lesser ", "Mass ", "Quickened "])}${cap(pick(SPELL_WORDS))} ${cap(pick(SPELL_WORDS))}`;
  const school = pick(SCHOOLS);
  const descriptors = [pick(DESCRIPTORS), pick(DESCRIPTORS)];
  const level = String(1 + (i % 9));
  return {
    id: slug(name, i),
    name,
    keywords: ["spell", school.toLowerCase(), ...descriptors],
    data: {
      type: "item",
      name,
      system: {
        level: { sorcererWizard: Number(level), cleric: Number(level), witch: Number(level) + 1 },
        school: school.toLowerCase(),
        descriptors,
        castingTime: "1 standard",
        range: "long (400 ft. + 40 ft./level)",
      },
      effects: [],
    },
  };
}

function featEntry(i: number): CompendiumEntry {
  const name = `${pick(["Improved ", "Greater ", "Weapon ", "Combat "])}${pick(["Focus", "Specialization", "Expertise", "Maneuver", "Strike", "Shot", "Guard", "Rush"])}`;
  const category = pick(FEAT_CATEGORIES);
  return {
    id: slug(name, i),
    name,
    keywords: ["feat", category, "pf1"],
    data: { type: "item", name, system: { category, notes: "…" }, effects: [] },
  };
}

function itemEntry(i: number): CompendiumEntry {
  const kind = pick(ITEM_KINDS);
  const name = `${pick(["Adamantine", "Mithral", "Masterwork", "Silver", "+1", "+2"])} ${pick(["Longsword", "Chain Shirt", "Cloak of Resistance", "Ring of Protection", "Potion of Cure Light Wounds", "Wand of Magic Missile"])}`;
  return {
    id: slug(name, i),
    name,
    keywords: [kind, "magic", "loot"],
    data: {
      type: "item",
      name,
      system: { category: kind, weight: 4, price: 15, foundry: { changes: [] } },
      effects: [],
    },
  };
}

function actorEntry(i: number): CompendiumEntry {
  const type = pick(CREATURE_TYPES);
  const name = `${pick(["Ancient", "Young", "Elder", "Feral", "Dire"])} ${pick(["Goblin", "Dragon", "Wolf", "Wraith", "Golem", "Serpent", "Slime", "Harpy"])}`;
  return {
    id: slug(name, i),
    name,
    keywords: [type, "bestiary"],
    data: { type: "actor", name, system: { pf1e: { size: "Medium", abilities: { str: 12 } } }, items: [], effects: [] },
  };
}

function tableEntry(i: number): CompendiumEntry {
  const name = `${pick(["Weapons", "Armor", "Gems", "Goods", "Magic Item"])} Table ${i}`;
  return {
    id: slug(name, i),
    name,
    keywords: ["roll-table"],
    data: { type: "rollTable", name, formula: "1d100", results: [] },
  };
}

function journalEntry(i: number): CompendiumEntry {
  const name = `${pick(["Combat", "Skills", "Environment", "Magic", "Conditions"])} Rules ${i}`;
  return {
    id: slug(name, i),
    name,
    keywords: ["rules", "journal"],
    data: { type: "journal", name, pages: [{ name: "Rules", text: "…" }] },
  };
}

/** 20,000 entries across five packs, in the converted packs' proportions. */
function bigCorpus(): CompendiumPack[] {
  const mk = (name: string, type: "items" | "actors" | "journals" | "rollTables", n: number, make: (i: number) => CompendiumEntry): CompendiumPack => ({
    name,
    type,
    entries: Array.from({ length: n }, (_, i) => make(i)),
  });
  return [
    mk("Spells", "items", 6_000, spellEntry),
    mk("Feats", "items", 4_000, featEntry),
    mk("Equipment", "items", 5_000, itemEntry),
    mk("Bestiary", "actors", 3_000, actorEntry),
    mk("Tables & Rules", "journals", 2_000, (i) => (i % 2 === 0 ? tableEntry(i) : journalEntry(i))),
  ];
}

const SMALL: CompendiumPack = {
  name: "Monsters",
  type: "actors",
  entries: [
    {
      id: "goblin-warrior",
      name: "Goblin Warrior",
      keywords: ["goblin", "humanoid"],
      data: { type: "actor", name: "Goblin Warrior", system: {}, items: [], effects: [] },
    },
    {
      id: "goblin-shaman",
      name: "Goblin Shaman",
      keywords: ["goblin", "caster"],
      data: { type: "actor", name: "Goblin Shaman", system: {}, items: [], effects: [] },
    },
    {
      id: "hobgoblin",
      name: "Hobgoblin Captain",
      keywords: ["goblinoid", "elite"],
      data: { type: "actor", name: "Hobgoblin Captain", system: {}, items: [], effects: [] },
    },
    {
      id: "wolf",
      name: "Dire Wolf",
      keywords: ["beast"],
      data: { type: "actor", name: "Dire Wolf", system: {}, items: [], effects: [] },
    },
  ],
};

// ─── parity ───────────────────────────────────────────────────────────────────

describe("G-45 — the index answers the reference search's question", () => {
  const packs = bigCorpus();
  const index = buildCompendiumIndex(packs);
  // A real, converted-shaped corpus for the semantic cases (the big one is synthetic names).
  const tricky: CompendiumPack = {
    name: "Tricky",
    type: "items",
    entries: [
      { id: "hand", name: "'s Hand", keywords: ["spell"], data: { type: "item", name: "'s Hand", system: { school: "evocation", level: 1 }, effects: [] } },
      { id: "well-read", name: "Well-Read", keywords: ["trait"], data: { type: "item", name: "Well-Read", system: { category: "trait" }, effects: [] } },
      { id: "dragon", name: "Dragonscale Shield", keywords: ["fire", "shield"], data: { type: "item", name: "Dragonscale Shield", system: { category: "shield" }, effects: [] } },
      { id: "greater-fire", name: "Greater Fireball", keywords: ["spell", "evocation", "fire"], data: { type: "item", name: "Greater Fireball", system: { school: "evocation", level: { sorcererWizard: 6 } }, effects: [] } },
      { id: "fire", name: "Fireball", keywords: ["spell", "evocation", "fire"], data: { type: "item", name: "Fireball", system: { school: "evocation", level: { sorcererWizard: 3 } }, effects: [] } },
      { id: "mi", name: "Magic Missile", keywords: ["spell", "evocation", "force"], data: { type: "item", name: "Magic Missile", system: { school: "evocation", level: { sorcererWizard: 1 } }, effects: [] } },
    ],
  };

  const compare = (
    idx: ReturnType<typeof buildCompendiumIndex>,
    packs0: readonly CompendiumPack[],
    query: string,
    limit = 50,
  ): void => {
    const reference = searchCompendia(packs0, query, limit);
    const indexed = searchIndex(idx, query, { limit, sort: "relevance" });
    expect({
      ids: indexed.map((h) => h.entry.id),
      scores: indexed.map((h) => h.score),
      packs: indexed.map((h) => h.pack.name),
    }).toEqual({
      ids: reference.map((h) => h.entry.id),
      scores: reference.map((h) => h.score),
      packs: reference.map((h) => h.pack.name),
    });
  };

  test("identical hits, order and scores across every rung of the scorer", () => {
    for (const q of [
      "fire", // name prefix (many), word prefix, contains
      "ball",
      "greater",
      "fireball",
      "greater fireball", // multi-term AND
      "spell", // keyword
      "evocation", // keyword
      "f", // 1-character term: the vocabulary scan path
      "fi", // 2-character term: same path
      "goblin", // keyword + name, both rungs
      "zzzznope", // nothing matches
      "dragon", // contains in the middle of a token ("Dragonscale")
      "gon",
      "",
    ]) {
      compare(index, packs, q, 50);
    }
  });

  test("parity holds on the raw converted shapes: apostrophes, hyphens, possessives, short terms", () => {
    const trickyIndex = buildCompendiumIndex([tricky]);
    for (const q of ["s hand", "hand", "well", "read", "well-read", "lre", "gon", "shield", "fireball", "greater fireball", "m", "mi", "miss", "evocation", "force", "evoc", "ball fire", "zz"]) {
      compare(trickyIndex, [tricky], q, 50);
    }
  });

  test("parity holds at every limit, including the bounded top-N selection path", () => {
    // Small limits force `pushByRank` into its select-then-stop branch; a 1-character term makes
    // the low-score bucket thousands of entries wide, which is exactly the page the reference
    // search used to build by sorting the whole bucket.
    for (const q of ["e", "a", "fire", "goblin", "greater"]) {
      for (const limit of [1, 3, 17, 50]) compare(index, packs, q, limit);
    }
    // The uncapped path (the panel's browse/full-list mode) must still match exactly.
    compare(index, packs, "ball", Number.MAX_SAFE_INTEGER);
    compare(index, packs, "fire", Number.MAX_SAFE_INTEGER);
  });

  test("browse parity: the round-robin pack interleave survives (no large-pack starvation)", () => {
    // The V03/V05 property the reference search exists to protect.
    const spells: CompendiumPack = {
      name: "Spells",
      type: "items",
      entries: Array.from({ length: 75 }, (_, i) => ({ ...spellEntry(i), id: `spell-${i}` })),
    };
    const bestiary: CompendiumPack = {
      name: "Bestiary",
      type: "actors",
      entries: [
        { ...actorEntry(0), id: "heavy-infantry", name: "Heavy Infantry" },
        { ...actorEntry(1), id: "heavy-cavalry", name: "Heavy Cavalry" },
      ],
    };
    const rows = searchIndex(buildCompendiumIndex([spells, bestiary]), "", { limit: 50 });
    expect(rows.length).toBe(50);
    const ids = rows.map((h) => h.entry.id);
    expect(ids).toContain("heavy-infantry");
    expect(ids).toContain("heavy-cavalry");
    expect(new Set(rows.map((h) => h.pack.name))).toEqual(new Set(["Spells", "Bestiary"]));
  });

  test("the old reference search still answers identically (nothing moved under it)", () => {
    const res = searchCompendia([SMALL], "goblin");
    expect(res.map((h) => h.entry.id)).toEqual(["goblin-shaman", "goblin-warrior", "hobgoblin"]);
  });
});

// ─── facets ───────────────────────────────────────────────────────────────────

describe("G-45 — facets are read from authored fields", () => {
  test("kind: the shapes the shipped and converted packs actually write", () => {
    const of = (data: Record<string, unknown>, keywords?: string[]): string =>
      entryFacetsOf({ id: "x", name: "X", ...(keywords ? { keywords } : {}), data: data as CompendiumEntry["data"] }).kind;

    // ── spells, in both authored shapes ──
    // The hand-authored core pack states the school and no `spell` keyword:
    // `systems/pf1e-core/packs/spells.json` (Fireball: keywords ['evocation','fire','automated']).
    expect(
      of({ type: "item", name: "Fireball", system: { school: "evocation", level: { sorcererWizard: 3 } } }, [
        "evocation",
        "fire",
        "automated",
      ]),
    ).toBe("Spell");
    // The converted corpus's spells often state no school and are marked by the keyword:
    // `dist/content/pf1e/packs/spells-core.json` (917 entries with no `system.school` at all).
    expect(
      of({ type: "item", name: "Acid Splash", system: { level: { sorcererWizard: 0 } } }, ["spell"]),
    ).toBe("Spell");
    expect(
      of({ type: "item", name: "Charm Person", system: { level: { bard: 1 } } }, ["spell", "mindAffecting"]),
    ).toBe("Spell");

    // ── the pf1 system's `feat` item type, by its category ──
    expect(of({ type: "item", name: "Power Attack", system: { category: "combat" } }, ["feat", "combat"])).toBe("Feat");
    expect(of({ type: "item", name: "Extra Channel", system: { category: "channeling" } }, ["feat", "channeling"])).toBe("Feat");
    expect(of({ type: "item", name: "AC Bonus", system: { category: "classFeat" } }, ["feat", "classFeat"])).toBe("Class ability");
    expect(of({ type: "item", name: "A Shining Beacon", system: { category: "trait" } }, ["feat", "trait"])).toBe("Trait");
    expect(of({ type: "item", name: "Airy Step", system: { category: "racial" } }, ["feat", "racial"])).toBe("Racial");
    expect(of({ type: "item", name: "Adamant", system: { category: "misc" } }, ["feat", "misc"])).toBe("Misc");
    // A `feat` keyword with no category is still a feat, never a guess.
    expect(of({ type: "item", name: "X", system: {} }, ["feat"])).toBe("Feat");

    // ── ordinary items: the category is the data's own word ──
    expect(of({ type: "item", name: "Longsword", system: { category: "weapon" } }, ["weapon"])).toBe("Weapon");
    expect(of({ type: "item", name: "Cloak", system: { category: "equipment" } }, ["equipment"])).toBe("Equipment");
    expect(of({ type: "item", name: "Rations", system: { category: "loot" } }, ["loot"])).toBe("Loot");
    expect(of({ type: "item", name: "Bane", system: { category: "buff" } }, ["buff"])).toBe("Buff");
    expect(of({ type: "item", name: "Cybernetic Arm", system: { category: "implant" } }, ["loot"])).toBe("Implant");

    // ── rules tables, in the shapes the core pack and the converter write ──
    // `systems/pf1e-core/packs/equipment.json`: `table` is a *string* and `rows` an object.
    expect(
      of({ type: "item", name: "Unarmed Strike Damage by Size", system: { table: "unarmedStrikeDamageBySize", rows: { Medium: "1d3" } } }, ["weapon", "table"]),
    ).toBe("Table");
    expect(of({ type: "item", name: "X", system: { table: { name: "Weapons" }, rows: [] } }, ["weapon"])).toBe("Table");

    // ── actors ──
    expect(of({ type: "actor", name: "Acolyte", system: { pf1e: { size: "Medium" } } }, ["npc", "medium"])).toBe("Creature");
    expect(of({ type: "actor", name: "Barbarian", system: { hd: { 1: 12 }, babProgression: "good" } }, ["class", "fort"])).toBe("Class");
    // A class block wins over a `pf1e` block: the specific shape decides.
    expect(of({ type: "actor", name: "X", system: { hd: { 1: 8 }, pf1e: { size: "Medium" } } })).toBe("Class");

    // ── and the non-item documents ──
    expect(of({ type: "rollTable", name: "Arcane Malignancies" }, ["roll-table"])).toBe("Roll table");
    expect(of({ type: "journal", name: "Combat" }, ["rules", "journal"])).toBe("Journal");
    // Unknown shapes fall back to the document's own type, never to a guess.
    expect(of({ type: "scene", name: "X" })).toBe("Scene");
    expect(of({ type: "item", name: "X", system: {} })).toBe("Item");
  });

  test("level: a record reports the lowest class level; a number reports itself; nothing else invents one", () => {
    const level = (system: Record<string, unknown>): number | null =>
      entryFacetsOf({ id: "x", name: "X", data: { type: "item", name: "X", system } }).level;
    expect(level({ school: "evocation", level: { sorcererWizard: 3, cleric: 4, witch: 7 } })).toBe(3);
    expect(level({ school: "evocation", level: 5 })).toBe(5);
    expect(level({ category: "weapon" })).toBeNull();
    expect(level({ level: { sorcererWizard: "3rd" } })).toBeNull();
  });

  test("school: title-cased where stated, null where not — and the options carry counts", () => {
    const pack: CompendiumPack = {
      name: "Spells",
      type: "items",
      entries: [
        { id: "a", name: "Fireball", keywords: ["spell"], data: { type: "item", name: "Fireball", system: { school: "evocation", level: { sorcererWizard: 3 } }, effects: [] } },
        { id: "b", name: "Burning Hands", keywords: ["spell"], data: { type: "item", name: "Burning Hands", system: { school: "evocation", level: { sorcererWizard: 1 } }, effects: [] } },
        { id: "c", name: "Shield", keywords: ["spell"], data: { type: "item", name: "Shield", system: { school: "abjuration", level: { sorcererWizard: 1 } }, effects: [] } },
        { id: "d", name: "Longsword", keywords: ["weapon"], data: { type: "item", name: "Longsword", system: { category: "weapon" }, effects: [] } },
      ],
    };
    const index = buildCompendiumIndex([pack]);
    expect(index.facetOptions.schools).toEqual([
      { value: "Abjuration", count: 1 },
      { value: "Evocation", count: 2 },
    ]);
    expect(index.facetOptions.levels).toEqual([
      { value: "1", count: 2 },
      { value: "3", count: 1 },
    ]);
    expect(index.facetOptions.kinds).toEqual([
      { value: "Spell", count: 3 },
      { value: "Weapon", count: 1 },
    ]);
    expect(index.facetOptions.packs).toEqual([{ name: "Spells", type: "items", count: 4 }]);
  });

  test("filters narrow the domain; sort by level/kind/name is deterministic; unfiltered = everything", () => {
    const pack: CompendiumPack = {
      name: "Spells",
      type: "items",
      entries: [
        { id: "a", name: "Fireball", keywords: ["spell"], data: { type: "item", name: "Fireball", system: { school: "evocation", level: { sorcererWizard: 3 } }, effects: [] } },
        { id: "b", name: "Burning Hands", keywords: ["spell"], data: { type: "item", name: "Burning Hands", system: { school: "evocation", level: { sorcererWizard: 1 } }, effects: [] } },
        { id: "c", name: "Shield", keywords: ["spell"], data: { type: "item", name: "Shield", system: { school: "abjuration", level: { sorcererWizard: 1 } }, effects: [] } },
        { id: "d", name: "Longsword", keywords: ["weapon"], data: { type: "item", name: "Longsword", system: { category: "weapon" }, effects: [] } },
      ],
    };
    const index = buildCompendiumIndex([pack]);
    expect(searchIndex(index, "").map((h) => h.entry.id)).toEqual(["a", "b", "c", "d"]);
    expect(searchIndex(index, "", { filters: { kinds: ["Spell"] } }).map((h) => h.entry.id)).toEqual(["a", "b", "c"]);
    expect(searchIndex(index, "", { filters: { schools: ["Abjuration"] } }).map((h) => h.entry.id)).toEqual(["c"]);
    expect(searchIndex(index, "", { filters: { levels: ["1"] } }).map((h) => h.entry.id)).toEqual(["b", "c"]);
    expect(searchIndex(index, "", { filters: { packs: ["Spells"] } }).length).toBe(4);
    expect(searchIndex(index, "", { filters: { packs: ["Nope"] } }).length).toBe(0);
    // Sort by level: level-less entries sort last rather than being invented as level 0.
    expect(searchIndex(index, "", { sort: "level" }).map((h) => h.entry.id)).toEqual(["b", "c", "a", "d"]);
    expect(searchIndex(index, "", { sort: "name" }).map((h) => h.entry.id)).toEqual(["b", "a", "d", "c"]);
    // A query and a filter compose: "fire" restricted to a school it is not in returns nothing.
    expect(searchIndex(index, "fire", { filters: { schools: ["Abjuration"] } }).length).toBe(0);
    expect(searchIndex(index, "shield", { filters: { schools: ["Abjuration"] } }).map((h) => h.entry.id)).toEqual(["c"]);
  });
});

// ─── rankIndex: the reader's contract ─────────────────────────────────────────

describe("G-45 — rankIndex gives the reader an exact total and cheap pages", () => {
  const packs = bigCorpus();
  const index = buildCompendiumIndex(packs);

  test("the ranking is the hit order, and a cap only truncates it", () => {
    for (const q of ["fire", "e", "goblin", "greater fireball", ""]) {
      const full = rankIndex(index, q);
      const hits = searchIndex(index, q);
      expect([...full.indices]).toEqual(hits.map((h) => h.index));
      expect(full.total).toBe(full.indices.length);
      for (const cap of [0, 1, 3, 17, 50]) {
        const capped = rankIndex(index, q, { cap });
        expect(capped.total, `total must stay exact for query "${q}" at cap ${cap}`).toBe(full.total);
        expect([...capped.indices]).toEqual([...full.indices].slice(0, Math.min(cap, full.total)));
      }
      const over = rankIndex(index, q, { cap: full.total + 500 });
      expect([...over.indices]).toEqual([...full.indices]);
    }
  });

  test("filters change the total, and the cap never hides the true count", () => {
    const all = rankIndex(index, "");
    const spells = rankIndex(index, "", { filters: { kinds: ["Spell"] } });
    expect(all.total).toBe(20_000);
    expect(spells.total).toBeGreaterThan(0);
    expect(spells.total).toBeLessThan(all.total);
    const firstPage = rankIndex(index, "", { filters: { kinds: ["Spell"] }, cap: 10 });
    expect(firstPage.total).toBe(spells.total);
    expect(firstPage.indices.length).toBe(10);
    expect([...firstPage.indices]).toEqual([...spells.indices].slice(0, 10));
  });

  test("explicit sorts rank every match, then cut (the panel can page through a sorted list)", () => {
    for (const sort of ["name", "kind", "level"] as const) {
      const full = rankIndex(index, "", { sort, cap: 500 });
      expect(full.total).toBe(20_000);
      expect([...full.indices]).toEqual([...rankIndex(index, "", { sort }).indices].slice(0, 500));
    }
  });
});

// ─── budget ───────────────────────────────────────────────────────────────────

describe("G-45 — budget at 20,000 entries", () => {
  test("index build, keystroke cost and footprint stay inside §1.4's numbers", () => {
    const packs = bigCorpus();
    const total = packs.reduce((n, p) => n + p.entries.length, 0);
    expect(total).toBe(20_000);

    const buildStart = performance.now();
    const index = buildCompendiumIndex(packs);
    const buildMs = performance.now() - buildStart;

    // A realistic typed query: the first keystrokes are the wide ones, then it narrows.
    const typed = ["f", "fi", "fir", "fire", "fireb", "fireba", "firebal", "fireball"];
    // Warm-up (JIT), exactly as V08 does — a cold first keystroke is not what the budget means.
    // The whole typed sequence is warmed, since real typing is warm by the second character.
    for (const q of typed) searchIndex(index, q, { limit: 50 });
    let keystrokeMs = 0;
    let worstKeystrokeMs = 0;
    for (const q of typed) {
      const t0 = performance.now();
      searchIndex(index, q, { limit: 50 });
      const dt = performance.now() - t0;
      keystrokeMs += dt;
      if (dt > worstKeystrokeMs) worstKeystrokeMs = dt;
    }
    // The same eight queries through the linear scan the index replaces — the claim is not
    // just "fast enough" but "faster than what it replaced, on the corpus that motivated it".
    let referenceMs = 0;
    for (const q of typed) {
      const t0 = performance.now();
      searchCompendia(packs, q, 50);
      referenceMs += performance.now() - t0;
    }

    // Browse (no query) is the heaviest single call: it materializes one row per entry.
    const browseStart = performance.now();
    const browsed = searchIndex(index, "");
    const browseMs = performance.now() - browseStart;

    const footprint = indexFootprintBytes(index);
    // The measurement is the deliverable; the assertion is deliberately loose (3× the plan's
    // 16 ms budget) so a slow CI box cannot flake a gate that has no business being tight.
    console.log(
      `[G-45] 20k entries · index build ${buildMs.toFixed(0)} ms · ${typed.length} keystrokes ` +
        `${keystrokeMs.toFixed(1)} ms, worst ${worstKeystrokeMs.toFixed(1)} ms (budget 16/keystroke) ` +
        `vs ${referenceMs.toFixed(0)} ms linear ` +
        `(x${(referenceMs / Math.max(keystrokeMs, 0.001)).toFixed(0)}) · browse ` +
        `${browseMs.toFixed(0)} ms (${browsed.length} rows) · footprint ` +
        `${(footprint / 1024 / 1024).toFixed(2)} MB (budget 8)`,
    );
    expect(browsed.length).toBe(20_000);
    // The plan's number is 16 ms per keystroke; the measured worst is a few ms, so the budget is
    // asserted directly, not slackened — this is a *browser* keystroke budget met by a test-box
    // measurement, which is the conservative direction.
    expect(worstKeystrokeMs).toBeLessThan(16);
    expect(footprint).toBeLessThan(8 * 1024 * 1024);
    // The one comparative claim: a keystroke must beat the scan it replaced. If that ever
    // stops being true the index is no longer earning its memory.
    expect(keystrokeMs).toBeLessThan(referenceMs);
  });

  test("the reference search is what the index exists to replace (no silent O(n) left in the panel path)", () => {
    const packs = bigCorpus();
    const index = buildCompendiumIndex(packs);
    // Queries derived from the corpus itself, so the claim can never degrade into "no hits, and
    // both agree on that": a word-prefix query, a compound-name query (the rung a prefix-only
    // index would get wrong) and a keyword query.
    const spells = must(packs[0], "the Spells pack").entries;
    const twoWord = must(
      spells.find((e) => e.name.includes(" ")),
      "a two-word spell name",
    );
    const compound = must(
      spells.find((e) => !e.name.includes(" ")),
      "a compound spell name",
    );
    const queries = [
      must(twoWord.name.split(" ")[1], "the second word of a spell name").toLowerCase(),
      compound.name.toLowerCase(),
      "spell",
    ];
    for (const q of queries) {
      const indexed = searchIndex(index, q, { limit: 20 });
      const reference = searchCompendia(packs, q, 20);
      expect(indexed.map((h) => h.entry.id)).toEqual(reference.map((h) => h.entry.id));
      expect(indexed.length, `query "${q}" found nothing in either implementation`).toBeGreaterThan(0);
    }
  });
});

// ─── parse-time integration ───────────────────────────────────────────────────

test("the index accepts packs straight from parseCompendiumPack (the real pipeline)", () => {
  const parsed = parseCompendiumPack({ name: SMALL.name, type: SMALL.type, entries: SMALL.entries }, { origin: "world" });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const index = buildCompendiumIndex([parsed.value]);
  expect(index.counts).toEqual({ packs: 1, entries: 4 });
  expect(searchIndex(index, "wolf").map((h) => h.entry.id)).toEqual(["wolf"]);
});
