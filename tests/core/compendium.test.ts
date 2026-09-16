import { describe, expect, test } from "vitest";
import {
  importEntryOp,
  parseCompendiumPack,
  searchCompendia,
  type CompendiumPack,
} from "../../src/core/compendium";

const entry = (id: string, name: string, keywords: string[] = []) => ({
  id,
  name,
  keywords,
  data: { type: "actor", name, system: { hp: 10 }, items: [], effects: [] },
});

const PACK: CompendiumPack = {
  name: "Monsters",
  type: "actors",
  entries: [
    entry("goblin-warrior", "Goblin Warrior", ["goblin", "humanoid"]),
    entry("goblin-shaman", "Goblin Shaman", ["goblin", "caster"]),
    entry("hobgoblin", "Hobgoblin Captain", ["goblinoid", "elite"]),
    entry("wolf", "Dire Wolf", ["beast"]),
  ],
};

describe("parseCompendiumPack (§12)", () => {
  test("accepts a well-formed pack", () => {
    const res = parseCompendiumPack({
      name: "Monsters",
      type: "actors",
      entries: [entry("goblin-warrior", "Goblin Warrior")],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.type).toBe("actors");
    expect(res.value.entries[0]?.id).toBe("goblin-warrior");
  });

  test("rejects bad type, ids, _id in data, oversized entries", () => {
    expect(parseCompendiumPack({ name: "X", type: "hackers", entries: [] }).ok).toBe(false);
    expect(
      parseCompendiumPack({ name: "X", type: "actors", entries: [{ ...entry("Bad Id", "N") }] }).ok,
    ).toBe(false);
    const withId = parseCompendiumPack({
      name: "X",
      type: "actors",
      entries: [{ ...entry("ok-id", "N", []), data: { type: "actor", name: "N", _id: "steal" } }],
    });
    expect(withId.ok).toBe(false);
    if (withId.ok) return;
    expect(withId.error).toContain("_id");
    expect(
      parseCompendiumPack({
        name: "X",
        type: "actors",
        entries: Array.from({ length: 2001 }, (_, i) => entry(`e-${i}`, `E${i}`)),
      }).ok,
    ).toBe(false);
    expect(parseCompendiumPack(null).ok).toBe(false);
  });
});

describe("searchCompendia (§12)", () => {
  test("empty query lists pack heads; ranked matching otherwise", () => {
    const all = searchCompendia([PACK], "");
    expect(all.length).toBe(4);

    const gob = searchCompendia([PACK], "goblin");
    expect(gob.length).toBe(3); // two name hits + hobgoblin keyword? no — see below
    expect(gob[0]?.entry.id).toBe("goblin-shaman"); // 'goblin' word-prefix both warriors score equal → name order
    expect(gob.map((h) => h.entry.id)).toContain("goblin-warrior");

    const wolf = searchCompendia([PACK], "wolf");
    expect(wolf.length).toBe(1);
    expect(wolf[0]?.entry.id).toBe("wolf");

    const caster = searchCompendia([PACK], "caster");
    expect(caster.map((h) => h.entry.id)).toEqual(["goblin-shaman"]);

    expect(searchCompendia([PACK], "zzz").length).toBe(0);
  });

  test("multi-term queries must match every term", () => {
    const both = searchCompendia([PACK], "goblin caster");
    expect(both.map((h) => h.entry.id)).toEqual(["goblin-shaman"]);
  });

  test("limit caps results", () => {
    expect(searchCompendia([PACK], "goblin", 1).length).toBe(1);
  });

  /**
   * V03/V05 regression — browse mode must not let one large pack hide the rest.
   *
   * The shipped `pf1e-core` (D-234) declares five packs, spells first with 75 entries, and
   * `CompendiaPanel` renders at most 50 rows. Concatenating packs and slicing to the limit
   * therefore showed 50 spells and **zero** bestiary entries: the panel's drag-to-canvas rows
   * for every actor pack were unreachable without a search query, which is what turned the
   * five-pack manifest into a red browser gate (`[data-entry-id="heavy-infantry"]` never
   * rendered). Interleaving keeps the render cap and represents every pack.
   */
  test("browse mode represents every pack within the render limit (no large-pack starvation)", () => {
    const spells: CompendiumPack = {
      name: "Spells",
      type: "items",
      entries: Array.from({ length: 75 }, (_, i) => entry(`spell-${i}`, `Spell ${i}`)),
    };
    const bestiary: CompendiumPack = {
      name: "Bestiary",
      type: "actors",
      entries: [
        entry("heavy-infantry", "Heavy Infantry"),
        entry("heavy-cavalry", "Heavy Cavalry"),
        ...Array.from({ length: 38 }, (_, i) => entry(`mob-${i}`, `Mob ${i}`)),
      ],
    };
    const feats: CompendiumPack = {
      name: "Feats",
      type: "items",
      entries: Array.from({ length: 33 }, (_, i) => entry(`feat-${i}`, `Feat ${i}`)),
    };

    const rows = searchCompendia([spells, bestiary, feats], "", 50);
    expect(rows.length).toBe(50); // the render cap is still honoured
    const ids = rows.map((hit) => hit.entry.id);
    expect(ids).toContain("heavy-infantry");
    expect(ids).toContain("heavy-cavalry");
    // Every declared pack is represented, not just the first ones that fit.
    expect(new Set(rows.map((hit) => hit.pack.name))).toEqual(
      new Set(["Spells", "Bestiary", "Feats"]),
    );
    // A pack's own authored order survives the interleave.
    expect(ids.filter((id) => id.startsWith("spell-"))).toEqual([
      "spell-0",
      "spell-1",
      "spell-2",
      "spell-3",
      "spell-4",
      "spell-5",
      "spell-6",
      "spell-7",
      "spell-8",
      "spell-9",
      "spell-10",
      "spell-11",
      "spell-12",
      "spell-13",
      "spell-14",
      "spell-15",
      "spell-16",
    ]);

    // A limit smaller than the pack count still terminates and never repeats an entry.
    const tiny = searchCompendia([spells, bestiary, feats], "", 2);
    expect(tiny.map((hit) => hit.entry.id)).toEqual(["spell-0", "heavy-infantry"]);
    expect(new Set(rows.map((hit) => hit.pack.name + ":" + hit.entry.id)).size).toBe(rows.length);
  });
});

describe("importEntryOp (§12)", () => {
  test("builds a create op with a fresh _id and full payload", () => {
    const e = PACK.entries[0];
    if (!e) throw new Error("missing entry");
    const op = importEntryOp(PACK, e, "actor-new-1");
    expect(op).toEqual({
      kind: "create",
      coll: "actors",
      data: {
        type: "actor",
        name: "Goblin Warrior",
        system: { hp: 10 },
        items: [],
        effects: [],
        _id: "actor-new-1",
      },
    });
  });
});
