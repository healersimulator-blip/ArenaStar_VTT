/**
 * D-271 (plan §5.1/§8) — the overlay's paint plan: what the layer is handed, for a GM and for a
 * player, on all three grid kinds.
 */
import { describe, expect, test } from "vitest";
import type {
  CellDocument,
  Json,
  SceneDocument,
} from "../../src/core/documents";
import {
  cellPolygonOf,
  hexOverlayKey,
  hexOverlayPlan,
  parseTerrainColor,
} from "../../src/core/hexcrawl/overlay";
import { PF1E_TERRAIN_CATALOG } from "../../src/core/hexcrawl/terrain";

const flag = (revealed: string[]): Json =>
  ({
    version: 1,
    revealed,
    sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
    partyTokenId: null,
    encounterMode: "prompt",
    daylight: { dawnHour: 6, duskHour: 18 },
    terrain: "pf1e-overland",
    travel: null,
  }) as unknown as Json;

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Overland",
    ownership: { default: 2 },
    flags: { core: { hexcrawl: flag(["0,0"]) } },
    system: {},
    active: true,
    img: null,
    width: 200,
    height: 100,
    darkness: 0,
    grid: {
      type: "hex",
      size: 50,
      distance: 6,
      units: "mi",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    cells: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    ...over,
  };
}

const cell = (key: string, over: Partial<CellDocument> = {}): CellDocument => ({
  _id: `cell-${key.replace(",", "-")}`,
  type: "cell",
  name: key,
  ownership: { default: 0 },
  flags: {},
  system: {},
  key,
  ...over,
});

describe("hexOverlayPlan", () => {
  test("a hex map paints one polygon per cell, with the catalog's fill for its terrain", () => {
    const s = scene({ cells: [cell("0,0", { terrain: "forest" })] });
    const plan = hexOverlayPlan(s, { viewer: "gm" });
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.cells.length).toBeGreaterThan(0);
    expect(plan.cells.length).toBe(plan.openCells + plan.closedCells);
    expect(plan.authoredCells).toBe(1);
    const first = plan.cells.find((c) => c.key === "0,0");
    expect(first?.poly).toHaveLength(12); // six corners
    const forest = PF1E_TERRAIN_CATALOG.terrains.find((t) => t.id === "forest");
    expect(first?.fill).toBe(parseTerrainColor(forest?.color));
    expect(first?.open).toBe(true);
    // A cell nobody authored and nobody opened paints the catalog's default terrain.
    const authored = plan.cells.find((c) => c.key !== "0,0");
    expect(authored?.authored).toBe(false);
    expect(authored?.open).toBe(false);
  });

  test("a player is covered and a GM is not; the covered area needs no closed cell document", () => {
    const withCells = scene({ cells: [cell("0,0")] });
    const asGm = hexOverlayPlan(withCells, { viewer: "gm" });
    const asPlayer = hexOverlayPlan(withCells, { viewer: "player" });
    expect(asGm?.covers).toBe(false);
    expect(asPlayer?.covers).toBe(true);
    expect(asPlayer?.openCells).toBe(1);
    expect(asPlayer?.closedCells).toBe((asPlayer?.cells.length ?? 0) - 1);
    expect(asPlayer?.map).toEqual({ width: 200, height: 100 });
    // The cover follows the closed-cell count, and the GM never gets it.
    expect(asPlayer?.covers).toBe((asPlayer?.closedCells ?? 0) > 0);
    expect(asGm?.covers).toBe(false);
  });

  test("square cells are rects at the grid's own size; gridless paints the authored zones", () => {
    const square = scene({
      width: 200,
      height: 200,
      grid: {
        type: "square",
        size: 100,
        distance: 5,
        units: "ft",
        diagonals: "555",
        hexLayout: "oddQ",
      },
    });
    expect(cellPolygonOf(square, "1,1")).toEqual([
      100, 100, 200, 100, 200, 200, 100, 200,
    ]);

    const gridless = scene({
      grid: {
        type: "gridless",
        size: 100,
        distance: 6,
        units: "mi",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      cells: [
        cell("zone-a", {
          poly: [0, 0, 40, 0, 40, 40, 0, 40],
          terrain: "marsh",
        }),
      ],
    });
    const plan = hexOverlayPlan(gridless, { viewer: "gm" });
    expect(plan?.cells.map((c) => c.key)).toEqual(["zone-a"]);
    expect(plan?.covers).toBe(false);
    expect(cellPolygonOf(gridless, "zone-a")).toHaveLength(8);
    expect(cellPolygonOf(gridless, "zone-missing")).toBeNull();
  });

  test("the key is stable until something the overlay paints actually changes", () => {
    const s = scene({ cells: [cell("0,0", { terrain: "forest" })] });
    const base = hexOverlayKey(s, "gm", PF1E_TERRAIN_CATALOG);
    expect(hexOverlayKey(s, "gm", PF1E_TERRAIN_CATALOG)).toBe(base);
    expect(hexOverlayKey(s, "player", PF1E_TERRAIN_CATALOG)).not.toBe(base);
    const opened = scene({
      flags: { core: { hexcrawl: flag(["0,0", "1,1"]) } },
      cells: [cell("0,0", { terrain: "forest" })],
    });
    expect(hexOverlayKey(opened, "gm", PF1E_TERRAIN_CATALOG)).not.toBe(base);
    const retinted = scene({ cells: [cell("0,0", { terrain: "mountains" })] });
    expect(hexOverlayKey(retinted, "gm", PF1E_TERRAIN_CATALOG)).not.toBe(base);
  });

  test("a scene with no profile still yields a plan (the overlay is a map painting, not a mode)", () => {
    const plan = hexOverlayPlan(scene({ flags: {} }), { viewer: "player" });
    expect(plan?.openCells).toBe(0);
    expect(plan?.covers).toBe(true);
    expect(plan?.closedCells).toBe(plan?.cells.length);
    expect(hexOverlayPlan(null)).toBeNull();
  });

  test("`#rrggbb` parses; anything else is the neutral tint", () => {
    expect(parseTerrainColor("#b7c78a")).toBe(0xb7c78a);
    expect(parseTerrainColor("b7c78a")).toBe(0xb7c78a);
    expect(parseTerrainColor("rebeccapurple")).toBe(0x8a8f96);
    expect(parseTerrainColor(undefined)).toBe(0x8a8f96);
  });
});
