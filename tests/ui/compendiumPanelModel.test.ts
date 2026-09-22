// Checklist: G-45 — the compendium reader's pure model (filters, detail fields, previews).
/**
 * The panel's decisions that need no DOM: which facets are on, what the filter summary says, and
 * what the detail pane shows for a document. These are pinned here rather than through the
 * component because they are the parts a reviewer can argue about ("does the pane invent a level
 * for a sword?"), and because the component only wires them to markup.
 */
import { describe, expect, test } from "vitest";
import type { CompendiumEntry } from "../../src/core/compendium";
import { entryFacetsOf } from "../../src/core/compendiumIndex";
import {
  activeFilterCount,
  facetChipGroups,
  detailFieldsOf,
  documentPreview,
  emptyFilters,
  filterSummary,
  labelOf,
  summarizeValue,
  toggleFilter,
} from "../../src/ui/compendia/panelModel";

const entry = (over: Partial<CompendiumEntry>): CompendiumEntry => ({
  id: "fireball",
  name: "Fireball",
  keywords: ["spell", "evocation", "fire"],
  data: {
    type: "item",
    name: "Fireball",
    system: { school: "evocation", level: { sorcererWizard: 3 }, range: "long" },
    effects: [],
  },
  ...over,
});

describe("G-45 — filter state", () => {
  test("toggleFilter adds, removes and never mutates its input", () => {
    const base = ["a"];
    const added = toggleFilter(base, "b");
    expect(added).toEqual(["a", "b"]);
    expect(base).toEqual(["a"]);
    const removed = toggleFilter(added, "a");
    expect(removed).toEqual(["b"]);
    expect(added).toEqual(["a", "b"]);
  });

  test("counts and summary read like a sentence, in a fixed order", () => {
    const f = emptyFilters();
    expect(activeFilterCount(f)).toBe(0);
    expect(filterSummary(f)).toBe("");
    const one = { ...f, packs: ["Bestiary"], kinds: ["Spell"] };
    expect(activeFilterCount(one)).toBe(2);
    expect(filterSummary(one)).toBe("1 pack · 1 kind");
    const many = {
      packs: ["Bestiary", "Feats"],
      kinds: ["Spell", "Feat", "Weapon"],
      schools: ["Evocation"],
      levels: ["1", "3"],
    };
    expect(activeFilterCount(many)).toBe(8);
    expect(filterSummary(many)).toBe("2 packs · 3 kinds · 1 school · 2 levels");
  });
});

describe("G-45 — facet chips", () => {
  test("every chip option carries a defined, unique value (the panel keys rows by it)", () => {
    const groups = facetChipGroups({
      packs: [
        { name: "PF1e Feats (Expanded)", count: 3541 },
        { name: "PF1e Spells (Core)", count: 3028 },
        { name: "PF1e Bestiary", count: 40 },
      ],
      kinds: [
        { value: "Feat", count: 3609 },
        { value: "Spell", count: 3028 },
      ],
      schools: [
        { value: "Evocation", count: 519 },
        { value: "Illusion", count: 241 },
      ],
      levels: [
        { value: "1", count: 300 },
        { value: "3", count: 210 },
      ],
    });
    // A group with more than one option is shown; the surfaces where packs carry `name` are
    // normalized to `value` here, which is exactly what the panel crashed on before.
    expect(groups.map((g) => g.key)).toEqual(["kinds", "packs", "schools", "levels"]);
    for (const group of groups) {
      const values = group.options.map((o) => o.value);
      expect(values.every((v) => typeof v === "string" && v.length > 0), group.key).toBe(true);
      expect(new Set(values).size, group.key).toBe(values.length);
      for (const option of group.options) expect(typeof option.count).toBe("number");
    }
    // Packs are biggest-first, so the useful ones are on screen without scrolling the chips.
    expect(groups[1]?.options.map((o) => o.value)).toEqual([
      "PF1e Feats (Expanded)",
      "PF1e Spells (Core)",
      "PF1e Bestiary",
    ]);
  });

  test("a one-option group is hidden; a long group is capped", () => {
    const groups = facetChipGroups(
      {
        packs: [{ name: "Only Pack", count: 3 }],
        kinds: Array.from({ length: 40 }, (_, i) => ({ value: `Kind ${i}`, count: 40 - i })),
        schools: [{ value: "Evocation", count: 1 }],
        levels: [],
      },
      10,
    );
    expect(groups.map((g) => g.key)).toEqual(["kinds"]);
    expect(groups[0]?.options).toHaveLength(10);
  });
});

describe("G-45 — detail pane fields", () => {
  test("identity rows come first, in a fixed order, and absent facts are absent", () => {
    const e = entry({});
    const fields = detailFieldsOf(e, entryFacetsOf(e));
    expect(fields.slice(0, 5).map((f) => f.label)).toEqual([
      "Id",
      "Document",
      "Kind",
      "Level",
      "School",
    ]);
    expect(fields[0]?.value).toBe("fireball");
    expect(fields[2]?.value).toBe("Spell");
    expect(fields[3]?.value).toBe("3"); // the lowest class level of the record
    expect(fields[4]?.value).toBe("Evocation");
    expect(fields.find((f) => f.label === "Keywords")?.value).toBe("spell, evocation, fire");
    expect(fields.find((f) => f.label === "Range")?.value).toBe("long");
  });

  test("an item with no level/school/keywords shows none of those rows (nothing is invented)", () => {
    const e: CompendiumEntry = {
      id: "longsword",
      name: "Longsword",
      data: { type: "item", name: "Longsword", system: { category: "weapon", weight: 4 } },
    };
    const labels = detailFieldsOf(e, entryFacetsOf(e)).map((f) => f.label);
    expect(labels).toEqual(["Id", "Document", "Kind", "Category", "Weight"]);
    expect(labels).not.toContain("Level");
    expect(labels).not.toContain("School");
    expect(labels).not.toContain("Keywords");
  });

  test("system keys are alphabetical, so the pane is stable; effects and items are counted", () => {
    const e: CompendiumEntry = {
      id: "goblin",
      name: "Goblin",
      keywords: ["humanoid"],
      data: {
        type: "actor",
        name: "Goblin",
        system: { pf1e: { size: "Small" }, abilities: { str: 11, dex: 15 }, babProgression: "medium" },
        effects: [{ name: "1" }],
        items: [{ name: "a" }, { name: "b" }],
      },
    };
    const labels = detailFieldsOf(e, entryFacetsOf(e)).map((f) => f.label);
    expect(labels).toEqual([
      "Id",
      "Document",
      "Kind",
      "Keywords",
      "Abilities",
      "Bab progression",
      "Pf1e",
      "Effects",
      "Items",
    ]);
    const fields = detailFieldsOf(e, entryFacetsOf(e));
    expect(fields.find((f) => f.label === "Effects")?.value).toBe("1 active effect(s)");
    expect(fields.find((f) => f.label === "Items")?.value).toBe("2 embedded item(s)");
  });
});

describe("G-45 — value and document summaries", () => {
  test("labels stay unique when a document's own keys repeat an identity row (each-key safety)", () => {
    // A real spell: the facets contribute Level/School and `system.level`/`system.school` say the
    // same words again. Svelte keys the pane's rows by label, so a duplicate is a runtime crash
    // (`each_key_duplicate`) — the second occurrence is qualified instead.
    const e = entry({});
    const fields = detailFieldsOf(e, entryFacetsOf(e));
    const labels = fields.map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("Level");
    expect(labels).toContain("Level (system.level)");
    expect(labels).toContain("School");
    expect(labels).toContain("School (system.school)");
    // The qualified row carries the document's own value, not the facet's.
    expect(fields.find((f) => f.label === "Level (system.level)")?.value).toBe("{ sorcererWizard }");
    expect(fields.find((f) => f.label === "Level")?.value).toBe("3");
  });

  test("summarizeValue describes shape, not content, for collections", () => {
    expect(summarizeValue(["a", "b"])).toBe("[2 entries]");
    expect(summarizeValue(["a"])).toBe("[1 entry]");
    expect(summarizeValue([])).toBe("[0 entries]");
    expect(summarizeValue({ a: 1, b: 2 })).toBe("{ a, b }");
    expect(summarizeValue({})).toBe("{ }");
    expect(summarizeValue({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 })).toBe("{ a, b, c, d, e, f, … }");
    expect(summarizeValue(null)).toBe("null");
    expect(summarizeValue(12)).toBe("12");
    expect(summarizeValue(false)).toBe("false");
    expect(summarizeValue("  two   words  ")).toBe("two words");
  });

  test("long strings are clipped, short ones are not", () => {
    expect(summarizeValue("ok", 10)).toBe("ok");
    expect(summarizeValue("0123456789", 4)).toBe("0123…");
  });

  test("documentPreview is pretty JSON and says how much was cut", () => {
    const e = entry({});
    const preview = documentPreview(e);
    expect(preview).toContain('"type": "item"');
    const clipped = documentPreview(e, 40);
    expect(clipped).toContain("characters total");
    expect(clipped.split("\n").length).toBeGreaterThan(1);
  });

  test("labelOf turns code-ish keys into labels", () => {
    expect(labelOf("castingTime")).toBe("Casting time");
    expect(labelOf("babProgression")).toBe("Bab progression");
    expect(labelOf("saving_throw")).toBe("Saving throw");
    expect(labelOf("range")).toBe("Range");
    expect(labelOf("")).toBe("");
  });
});
