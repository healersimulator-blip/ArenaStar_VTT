import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import type { CompendiumPack } from "../../src/core/compendium";
import { filterSummonCatalog, indexSummonCatalog, summonIndexFields } from "../../src/core/summonCatalog";

const actor: ActorDocument = { _id: "wolf", type: "actor", name: "Wolf", ownership: { default: 0 },
  flags: {}, system: { pf1e: { size: "Medium", cr: 1 } }, items: [], effects: [] };
const pack: CompendiumPack = { name: "Bestiary", type: "actors", entries: [
  { id: "hound", name: "Iron Hound", keywords: ["construct", "guardian"], data: {
    name: "Iron Hound", type: "actor", system: { pf1e: { size: "Large" }, mirror: { cr: 0.5 } },
    items: [], effects: [],
  } },
  { id: "dryad", name: "Dryad", data: {
    name: "Dryad", type: "actor", system: { pf1e: { size: "Medium", cr: 4 } },
    items: [], effects: [],
  } },
] };

describe("read-only indexed summon source menu", () => {
  test("searches world actors and pack keywords, filters source pack/CR/size, sorts numerically", () => {
    const all = indexSummonCatalog([actor], [
      { packageId: "bestiary", packFile: "packs/creatures.json", pack },
      { packageId: "extra", packFile: "packs/monsters.json", pack: { ...pack, entries: pack.entries.slice(0, 1) } },
    ]);
    expect(all).toHaveLength(4);
    expect(all[0]?.source).toEqual({ kind: "world", actorId: "wolf" });
    expect(all[1]?.source).toEqual({ kind: "compendium", packageId: "bestiary",
      packFile: "packs/creatures.json", entryId: "hound" });
    expect(all[1]).toMatchObject({ cr: 0.5, size: "Large" });
    expect(filterSummonCatalog(all, { search: "guardian", showWorld: false,
      packKey: "bestiary:packs/creatures.json" }).map((row) => row.key))
      .toEqual(["pack:bestiary:packs/creatures.json:hound"]);
    expect(filterSummonCatalog(all, { showPacks: false, search: "wolf", size: "Medium",
      minCr: 0.5, maxCr: 1 }).map((row) => row.key)).toEqual(["world:wolf"]);
    expect(filterSummonCatalog(all, { showWorld: false, packKey: "bestiary:packs/creatures.json",
      sort: "crDesc" }).map((row) => row.cr)).toEqual([4, 0.5]);
    expect(filterSummonCatalog(all, { minCr: 2 }).map((row) => row.key))
      .toEqual(["pack:bestiary:packs/creatures.json:dryad"]);
    expect(actor._id).toBe("wolf"); // no world import/mutation while indexing or filtering
  });

  test("untyped/malicious index data never becomes a numeric or unsafe size filter", () => {
    expect(summonIndexFields({ system: { pf1e: { cr: Infinity, size: "<script>" }, mirror: { cr: -5 } } }))
      .toEqual({});
    expect(summonIndexFields({ system: { pf1e: { cr: "5", size: "Huge" } } })).toEqual({ size: "Huge" });
    expect(summonIndexFields({ system: null })).toEqual({});
    expect(indexSummonCatalog([], [{ packageId: "bestiary", packFile: "packs/not-actors.json",
      pack: { ...pack, type: "items" } }])).toEqual([]);
  });
});
