/**
 * D-269 (plan §3.6) — terrain pricing.
 *
 * The arithmetic here is the kind that looks obvious and is quietly wrong for a year: a hex is
 * a *fraction of a day*, so `secondsPerCell` must divide the day by the day's range, and the day
 * must be the clock's day (86 400 s, D-268), not some private number.
 */
import { describe, expect, test } from "vitest";
import {
  FORCED_MARCH_BONUS,
  isRoadTerrain,
  PF1E_TERRAIN_CATALOG,
  catalogToJson,
  paceMultiplier,
  rangeWith,
  secondsForCost,
  secondsPerCell,
  terrainById,
  terrainCatalogOrDefault,
  terrainCost,
  travelCost,
  validateTerrainCatalog,
} from "../../src/core/hexcrawl/terrain";
import { DAY_SECONDS, ROUNDS_PER_DAY } from "../../src/core/clock";

const catalog = PF1E_TERRAIN_CATALOG;

describe("the stock catalog", () => {
  test("every terrain has a unique id, a positive cost and a colour", () => {
    const ids = catalog.terrains.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of catalog.terrains) {
      expect(t.cost).toBeGreaterThan(0);
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(ids).toContain("plains");
    expect(ids).toContain("mountains");
    expect(ids).toContain("road");
  });

  test("an unknown or missing terrain prices as the default", () => {
    expect(terrainCost(catalog, null)).toBe(catalog.defaultCost);
    expect(terrainCost(catalog, "atlantis")).toBe(catalog.defaultCost);
    expect(terrainById(catalog, "forest")?.cost).toBe(2);
  });
});

describe("validateTerrainCatalog", () => {
  test("a custom catalog round-trips through JSON", () => {
    const custom = {
      id: "my-world",
      name: "My World",
      defaultCost: 1.25,
      defaultTerrain: "ash",
      terrains: [
        {
          id: "ash",
          name: "Ash waste",
          cost: 1.5,
          color: "#444444",
          notes: "Nothing grows.",
        },
        { id: "sky", name: "Sky islands", cost: 0.5, color: "#88ccff" },
      ],
    };
    const parsed = validateTerrainCatalog(custom);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe("my-world");
    expect(parsed?.terrains).toHaveLength(2);
    expect(parsed?.defaultTerrain).toBe("ash");
    expect(catalogToJson(parsed as never)).toEqual({
      id: "my-world",
      name: "My World",
      defaultCost: 1.25,
      defaultTerrain: "ash",
      terrains: [
        {
          id: "ash",
          name: "Ash waste",
          cost: 1.5,
          color: "#444444",
          notes: "Nothing grows.",
        },
        { id: "sky", name: "Sky islands", cost: 0.5, color: "#88ccff" },
      ],
    });
  });

  test("garbage is rejected or repaired field by field, never thrown", () => {
    expect(validateTerrainCatalog(null)).toBeNull();
    expect(validateTerrainCatalog("nope")).toBeNull();
    expect(validateTerrainCatalog({ terrains: [] })).toBeNull();
    const repaired = validateTerrainCatalog({
      terrains: [
        { id: "", cost: 2 }, // no id → dropped
        { id: "dup", cost: -3, color: "blue" }, // bad cost + colour → defaults
        { id: "dup", cost: 2 }, // duplicate id → dropped
        { id: "ok", name: "", cost: "3" }, // unreadable cost → 1
      ],
      defaultCost: -5,
    });
    expect(repaired?.terrains.map((t) => t.id)).toEqual(["dup", "ok"]);
    expect(repaired?.terrains[0]?.cost).toBe(1);
    expect(repaired?.terrains[0]?.color).toBe("#999999");
    expect(repaired?.terrains[1]?.name).toBe("ok");
    expect(repaired?.defaultCost).toBe(1);
    expect(repaired?.defaultTerrain).toBe("dup");
  });

  test("a world with no catalog gets the stock one", () => {
    expect(terrainCatalogOrDefault(undefined)).toBe(PF1E_TERRAIN_CATALOG);
    expect(terrainCatalogOrDefault({ terrains: [] })).toBe(
      PF1E_TERRAIN_CATALOG,
    );
    expect(
      terrainCatalogOrDefault({ terrains: [{ id: "x", cost: 2 }] })?.id,
    ).toBe("custom");
  });
});

describe("one day, one map", () => {
  test("at the default march a plains cell is exactly 1/24 of a day", () => {
    const seconds = secondsPerCell(catalog, 24, "plains", {
      daySeconds: DAY_SECONDS,
    });
    expect(seconds).toBe(3_600);
    expect(seconds * 24).toBe(DAY_SECONDS);
    // …and the clock's own day is the one used, not a literal.
    expect(DAY_SECONDS).toBe(ROUNDS_PER_DAY * 6);
  });

  test("terrain scales the day's range, and the road rule beats the worst side", () => {
    expect(rangeWith(catalog, 24, "forest")).toBe(12);
    expect(rangeWith(catalog, 24, "mountains")).toBe(8);
    expect(rangeWith(catalog, 12, "mountains")).toBe(4);
    // A road never exceeds an unobstructed day (it removes terrain, it does not add speed):
    // "travel at normal speed" is the PF1e rule, so the road's cost is exactly plains'.
    expect(rangeWith(catalog, 24, "mountains", { road: true })).toBe(24);
    expect(
      secondsPerCell(catalog, 24, "mountains", { daySeconds: DAY_SECONDS }),
    ).toBe(10_800);
    expect(
      secondsPerCell(catalog, 24, "mountains", {
        road: true,
        daySeconds: DAY_SECONDS,
      }),
    ).toBe(3_600);
  });

  test("a step costs the worse of its two sides — unless one carries a road", () => {
    expect(travelCost(catalog, { from: "plains", to: "forest" })).toBe(2);
    expect(travelCost(catalog, { from: "forest", to: "forest" })).toBe(2);
    expect(travelCost(catalog, { from: null, to: "hills" })).toBe(1.5);
    expect(travelCost(catalog, { from: "mountains", to: "road" })).toBe(1);
    expect(travelCost(catalog, { from: "road", to: "mountains" })).toBe(1);
    expect(travelCost(catalog, { from: "road", to: "road" })).toBe(1);
    // …and a *plains* cell is not a road, even though it costs the same: crossing plains into
    // mountains still costs the mountains.
    expect(travelCost(catalog, { from: "plains", to: "mountains" })).toBe(3);
    expect(isRoadTerrain(catalog, "plains")).toBe(false);
    expect(isRoadTerrain(catalog, "road")).toBe(true);
  });

  test("a forced march stretches the day by a tenth", () => {
    expect(paceMultiplier("normal")).toBe(1);
    expect(paceMultiplier("forced")).toBe(1 + FORCED_MARCH_BONUS);
    const normal = secondsPerCell(catalog, 24, "plains", {
      daySeconds: DAY_SECONDS,
    });
    const forced = secondsPerCell(catalog, 24, "plains", {
      pace: "forced",
      daySeconds: DAY_SECONDS,
    });
    expect(forced).toBeLessThan(normal);
    expect(Math.round((normal / forced) * 100) / 100).toBe(1.1);
  });

  test("secondsForCost is total: zero, negative and absurd inputs land somewhere sane", () => {
    expect(secondsForCost(24, 1, { daySeconds: DAY_SECONDS })).toBe(3_600);
    expect(secondsForCost(0, 1, { daySeconds: DAY_SECONDS })).toBe(DAY_SECONDS);
    expect(secondsForCost(24, 0, { daySeconds: DAY_SECONDS })).toBe(3_600); // 0 cost reads as 1
    expect(secondsForCost(24, -4, { daySeconds: DAY_SECONDS })).toBe(3_600);
    expect(secondsForCost(24, 10, { daySeconds: DAY_SECONDS })).toBe(36_000);
    expect(secondsForCost(Number.NaN, 1, { daySeconds: 1_000 })).toBe(1_000);
  });
});

describe("the catalog as world data (round trip)", () => {
  test("a catalog keeps its road flag through storage, so a road is still a road", () => {
    const stored = terrainCatalogOrDefault(catalogToJson(PF1E_TERRAIN_CATALOG));
    const road = stored.terrains.find((t) => t.id === "road");
    expect(road?.road).toBe(true);
    expect(isRoadTerrain(stored, "road")).toBe(true);
    // The rule the flag exists for: crossing into a road costs a plains day, never less —
    // the mountains on the other side are what the road cancels.
    const plains = terrainById(stored, "plains");
    if (!plains)
      throw new Error("the shipped catalog lost its baseline terrain");
    expect(travelCost(stored, { from: "mountains", to: "road" })).toBe(
      plains.cost,
    );
    expect(
      travelCost(stored, { from: "mountains", to: "mountains" }),
    ).toBeGreaterThan(plains.cost);
  });
});
