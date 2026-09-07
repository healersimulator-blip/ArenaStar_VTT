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
