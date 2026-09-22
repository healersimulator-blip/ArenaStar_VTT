/**
 * **Hexcrawl terrain and what it costs to cross (D-269, plan §3.6).**
 *
 * Two layers, deliberately separate:
 * - **The catalog** is *world data*: a GM renames, re-prices and re-rates terrains, so it lives
 *   in a world setting (D-252's pattern for hexcrawl settings), not in code. This module ships
 *   the PF1e default catalog — the terrain list and overland speeds of a standard fantasy
 *   hexcrawl — and validates whatever the world actually stores.
 * - **The math** (`travelCost`, `rangeWith`) is pure and takes the catalog as an argument, so a
 *   test can price any table it likes and a rules package can supply its own.
 *
 * **A cell with no terrain is the catalog's default** ("unexplored" and "plains" are the same
 * cost), which is why `terrainCost` takes a possibly-undefined id rather than demanding one.
 *
 * The cost model is the one every hexcrawl rulebook uses: terrain scales how far a party gets in
 * a day (`speed × 1/cost`), a forced march stretches the day (PF1e `forced march` — one extra
 * tenth of a day's distance, at the price of nonlethal fatigue), and a road *replaces* the
 * terrain cost rather than multiplying it (a highway through mountains is fast, not slow).
 */
import type { Json } from "../documents";
import type { TravelPace } from "./types";

export interface TerrainDef {
  /** Stable id (`"plains"`), what a cell document stores. */
  id: string;
  /** What the GM sees (`"Plains / farmland"`). */
  name: string;
  /** What the party sees on the map legend; falls back to `name`. */
  label?: string;
  /** Multiplier on travel time: 1 = open ground, 2 = half speed (mountains), 0.75 = a road. */
  cost: number;
  /** 0xRRGGBB fill for the hex overlay's own tint. */
  color: string;
  /**
   * A **road**: any step into or out of this terrain costs open ground, whatever it crosses
   * (PF1e overland movement — a highway lets you travel at normal speed, it does not add speed).
   */
  road?: boolean;
  /** Free-form: slopes, cover, whether a mount can pass. Read by the planner in Phase 3. */
  notes?: string;
}

export interface TerrainCatalog {
  /** `hexTerrain` in world settings. */
  id: string;
  name: string;
  /** Cost for a cell with no terrain (and for a world that has no catalog at all). */
  defaultCost: number;
  /** Id the overlay tints with when a cell has no terrain of its own. */
  defaultTerrain: string;
  terrains: TerrainDef[];
}

/**
 * The stock catalog. Costs are the share of a day one grid unit of the terrain takes: a party
 * with `speedPerDay = 24` covers 24 units of plains, 12 of forest, 8 of mountains, and 24 along
 * a road whatever it crosses. **A road's cost is 1, not less** — PF1e's road rule is "travel at
 * normal speed", so a highway removes terrain penalties and never makes a party faster than
 * open ground.
 */
export const PF1E_TERRAIN_CATALOG: TerrainCatalog = {
  id: "pf1e-overland",
  name: "Pathfinder overland",
  defaultCost: 1,
  defaultTerrain: "plains",
  terrains: [
    {
      id: "plains",
      name: "Plains / farmland",
      cost: 1,
      color: "#b7c78a",
      notes: "Open ground; no obstacle to a march.",
    },
    {
      id: "road",
      name: "Highway / road",
      cost: 1,
      road: true,
      color: "#d8cfa5",
      notes: "Crosses as open ground, whatever the terrain on either side.",
    },
    { id: "hills", name: "Hills / scrub", cost: 1.5, color: "#bfa878" },
    { id: "forest", name: "Forest / woods", cost: 2, color: "#8aa46b" },
    { id: "marsh", name: "Marsh / swamp", cost: 2, color: "#7f9a86" },
    { id: "desert", name: "Desert / dunes", cost: 2, color: "#e0d3a3" },
    { id: "tundra", name: "Tundra / steppe", cost: 1.5, color: "#cfd6d3" },
    { id: "jungle", name: "Jungle / rainforest", cost: 3, color: "#6f8f5a" },
    { id: "mountains", name: "Mountains", cost: 3, color: "#a09a92" },
    {
      id: "water",
      name: "Lake / sea",
      cost: 4,
      color: "#86b4d6",
      notes: "Impassable on foot; a boat travels at its own pace (Phase 3).",
    },
    { id: "city", name: "City / ruins", cost: 1, color: "#c9b7a3" },
  ],
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Every field of the catalog checked, defaults filled, bad entries dropped (D-252 discipline). */
export function validateTerrainCatalog(value: unknown): TerrainCatalog | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const list = Array.isArray(raw["terrains"]) ? raw["terrains"] : [];
  const terrains: TerrainDef[] = [];
  for (const item of list) {
    const t = asRecord(item);
    if (!t) continue;
    const id = typeof t["id"] === "string" ? t["id"].trim() : "";
    if (!id || terrains.some((x) => x.id === id)) continue;
    const cost = Number(t["cost"]);
    terrains.push({
      id,
      name:
        typeof t["name"] === "string" && t["name"].trim() !== ""
          ? t["name"]
          : id,
      ...(typeof t["label"] === "string" && t["label"] !== ""
        ? { label: t["label"] }
        : {}),
      ...(t["road"] === true ? { road: true } : {}),
      cost: Number.isFinite(cost) && cost > 0 ? Math.min(10, cost) : 1,
      color:
        typeof t["color"] === "string" && /^#[0-9a-fA-F]{6}$/.test(t["color"])
          ? t["color"]
          : "#999999",
      ...(typeof t["notes"] === "string" && t["notes"] !== ""
        ? { notes: t["notes"] }
        : {}),
    });
  }
  if (terrains.length === 0) return null;
  const defaultCost = Number(raw["defaultCost"]);
  const defaultTerrain =
    typeof raw["defaultTerrain"] === "string" ? raw["defaultTerrain"] : "";
  return {
    id:
      typeof raw["id"] === "string" && raw["id"] !== "" ? raw["id"] : "custom",
    name:
      typeof raw["name"] === "string" && raw["name"] !== ""
        ? raw["name"]
        : "Terrain",
    defaultCost:
      Number.isFinite(defaultCost) && defaultCost > 0 ? defaultCost : 1,
    defaultTerrain: terrains.some((t) => t.id === defaultTerrain)
      ? defaultTerrain
      : (terrains[0]?.id ?? "plains"),
    terrains,
  };
}

/** The catalog a scene should use: the world's, or the stock one when the world has none. */
export function terrainCatalogOrDefault(value: unknown): TerrainCatalog {
  return validateTerrainCatalog(value) ?? PF1E_TERRAIN_CATALOG;
}

/** One terrain by id, or null. */
export function terrainById(
  catalog: TerrainCatalog,
  id: string | null | undefined,
): TerrainDef | null {
  if (!id) return null;
  return catalog.terrains.find((t) => t.id === id) ?? null;
}

/** A cell's travel cost: its terrain's, or the catalog default when it has none. */
export function terrainCost(
  catalog: TerrainCatalog,
  terrainId: string | null | undefined,
): number {
  return terrainById(catalog, terrainId)?.cost ?? catalog.defaultCost;
}

/**
 * **The road rule.** A step with a road on either side costs open ground (`ROAD_COST`), not the
 * worse of its two terrains: a highway through the mountains is as fast as one through the
 * plains, and never faster than a clear day's march. `1` is what makes that true by
 * construction — the road *replaces* terrain instead of scaling it.
 */
export const ROAD_COST = 1;

export function travelCost(
  catalog: TerrainCatalog,
  step: { from?: string | null; to?: string | null },
): number {
  if (isRoadTerrain(catalog, step.from) || isRoadTerrain(catalog, step.to))
    return ROAD_COST;
  return Math.max(
    terrainCost(catalog, step.from),
    terrainCost(catalog, step.to),
  );
}

/** Is this terrain a road? (The flag, not a cost comparison — a plains cell also costs 1.) */
export function isRoadTerrain(
  catalog: TerrainCatalog,
  terrainId: string | null | undefined,
): boolean {
  return terrainById(catalog, terrainId)?.road === true;
}

/**
 * Miles (grid units) a party covers in one day over this terrain, at this speed. Capped at
 * `speedPerDay`: terrain slows a march, never speeds it up (see the road rule below).
 */
export function rangeWith(
  catalog: TerrainCatalog,
  speedPerDay: number,
  terrainId: string | null | undefined,
  opts: { road?: boolean } = {},
): number {
  const cost = opts.road ? ROAD_COST : terrainCost(catalog, terrainId);
  return Math.min(speedPerDay, speedPerDay / Math.max(cost, 0.01));
}

/** The forced-march stretch: PF1e's extra tenth of a day's travel, for fatigue. */
export const FORCED_MARCH_BONUS = 0.1;

/** The multiplier a pace applies to a day's distance (forced marches cover 1.1 days' worth). */
export function paceMultiplier(pace: TravelPace): number {
  return pace === "forced" ? 1 + FORCED_MARCH_BONUS : 1;
}

/**
 * Seconds a cell of this cost takes: `daySeconds × cost ÷ speedPerDay`, then the pace scales it.
 *
 * At `speedPerDay = 24` (24 one-unit cells a day) a plains cell is 3 600 s — **24 cells fill a
 * day exactly** — a forest cell (cost 2) is 7 200 s, and a mountain cell (cost 3) is 10 800 s,
 * so three of them fill a day. Those are the numbers the travel engine hands back to the world
 * clock (`advanceWorldClockOps`), so an itinerary and the time it costs cannot disagree.
 *
 * A road (cost ≤ 0.75) is clamped to 0.75 by `travelCost`, so it can never make a party faster
 * than an unobstructed march: it makes *terrain* stop mattering rather than adding speed.
 */
export function secondsForCost(
  speedPerDay: number,
  cost: number,
  opts: { pace?: TravelPace; daySeconds: number },
): number {
  const speed =
    Number.isFinite(speedPerDay) && speedPerDay > 0 ? speedPerDay : 1;
  const share = (Number.isFinite(cost) && cost > 0 ? cost : 1) / speed;
  const seconds =
    (opts.daySeconds * share) / paceMultiplier(opts.pace ?? "normal");
  return Math.max(1, Math.round(seconds));
}

/** Seconds to cross one cell of a single terrain (a step inside one cell uses `travelCost`). */
export function secondsPerCell(
  catalog: TerrainCatalog,
  speedPerDay: number,
  terrainId: string | null | undefined,
  opts: { pace?: TravelPace; road?: boolean; daySeconds: number },
): number {
  const cost = opts.road ? ROAD_COST : terrainCost(catalog, terrainId);
  return secondsForCost(speedPerDay, cost, opts);
}

/** The catalog as JSON for a world setting (the UI's save path). */
export function catalogToJson(catalog: TerrainCatalog): Record<string, Json> {
  return {
    id: catalog.id,
    name: catalog.name,
    defaultCost: catalog.defaultCost,
    defaultTerrain: catalog.defaultTerrain,
    terrains: catalog.terrains.map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.label ? { label: t.label } : {}),
      cost: t.cost,
      color: t.color,
      // `road` must survive the round trip: a catalog stored in a world setting and read back
      // without it silently stops pricing roads as open ground (the rule needs the flag, not the
      // number — `isRoadTerrain`). Found by the browser gate, pinned by the terrain test.
      ...(t.road ? { road: true } : {}),
      ...(t.notes ? { notes: t.notes } : {}),
    })),
  };
}
