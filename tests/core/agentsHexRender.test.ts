// MCP connector §5.6 (F1) — `hexmap.render`, byte-exact.
//
// The map is the one read that hands a model *arrangement* rather than records, which is exactly why
// it is worth pinning character by character: a legend that disagrees with the grid, or a ruler that
// is off by one, is a model pointing at the wrong hex and a GM who cannot see why.
import { describe, expect, test } from "vitest";
import {
  COVER,
  PARTY,
  glyphFor,
  renderHexmap,
  terrainLetters,
  type HexGlyph,
  type HexMapOptions,
} from "../../src/core/agents/hexRender";

const grid = {
  type: "hex" as const,
  size: 100,
  distance: 6,
  units: "mi",
  hexLayout: "oddQ" as const,
};

const cell = (
  col: number,
  row: number,
  over: Partial<HexGlyph> = {},
): HexGlyph => ({
  key: `${col},${row}`,
  col,
  row,
  letter: "P",
  name: "Plains / farmland",
  open: true,
  party: false,
  ...over,
});

function options(over: Partial<HexMapOptions> = {}): HexMapOptions {
  return {
    sceneName: "Goblinwood",
    grid,
    col0: 0,
    row0: 0,
    cols: 5,
    rows: 3,
    totalCells: 15,
    terrains: [
      { id: "plains", name: "Plains / farmland", letter: "P", count: 0, cost: 1 },
      { id: "forest", name: "Forest / woods", letter: "F", count: 0, cost: 2 },
      { id: "hills", name: "Hills / scrub", letter: "H", count: 0, cost: 1.5 },
    ],
    ...over,
  };
}

describe("terrain letters", () => {
  test("first letter of the label, and the next free one on a collision", () => {
    // "Hills / scrub" would be H — and so would "Highway". The second one moves down its own name
    // rather than sharing a glyph, because a map that draws two terrains alike is a lie.
    const letters = terrainLetters([
      { id: "highway", name: "Highway / road", label: "Highway" },
      { id: "hills", name: "Hills / scrub" },
      { id: "plains", name: "Plains / farmland" },
      { id: "water", name: "Lake / sea" },
    ]);
    expect(letters).toEqual({
      highway: "H",
      hills: "I", // the next unused letter of "HILLS / SCRUB"
      plains: "P",
      water: "L",
    });
  });

  test("a custom catalog reads the same way", () => {
    const letters = terrainLetters([
      { id: "a", name: "Ashen waste" },
      { id: "b", name: "Blightwood" },
    ]);
    expect(letters).toEqual({ a: "A", b: "B" });
  });
});

describe("glyphs", () => {
  test("the party wins, then cover, then the terrain letter", () => {
    expect(glyphFor(cell(1, 1, { party: true }))).toBe(PARTY);
    expect(glyphFor(cell(1, 1, { open: false }))).toBe(COVER);
    expect(glyphFor(cell(1, 1, { letter: "", name: "" }))).toBe(".");
    expect(glyphFor(cell(1, 1, { letter: "F" }))).toBe("F");
  });
});

describe("renderHexmap", () => {
  test("draws a sparse region with rulers, and says what the glyphs mean", () => {
    const glyphs = [
      cell(0, 0),
      cell(1, 0, { letter: "F", name: "Forest / woods" }),
      // 2,0 is missing: no cell was authored there.
      cell(3, 0, { open: false }),
      cell(4, 0, { letter: "H", name: "Hills / scrub" }),
      cell(2, 1, { party: true }),
      cell(0, 2, { letter: "F", name: "Forest / woods" }),
    ];
    const map = renderHexmap(glyphs, options());
    // `rowsGlyphs` is the grid itself; the ASCII form spaces it out under the rulers.
    expect(map.rowsGlyphs).toEqual(["PF·▓H", "··@··", "F····"]);
    expect(map.ascii).toBe(
      [
        "hexmap Goblinwood 5×3 cells (hex oddQ, 1 cell = 6 mi)",
        "   0 1 2 3 4",
        "0  P F · ▓ H",
        "1  · · @ · ·",
        "2  F · · · ·",
        "",
        "Glyphs: · no cell · . no terrain · ▓ unrevealed · @ party · terrain letters below",
        "Terrain:",
        // Only the hex drawn as P is counted: the covered hex and the party's are not Ps on the map.
        "  P Plains / farmland — 1 cell(s) · cost 1 (open ground)",
        "  F Forest / woods — 2 cell(s) · cost 2×",
        "  H Hills / scrub — 1 cell(s) · cost 1.5×",
      ].join("\n"),
    );
  });

  test("the JSON form carries a key per glyph, so the model can point instead of count", () => {
    const map = renderHexmap([cell(0, 0), cell(1, 0, { open: false })], options());
    expect(map.json.cells).toEqual([
      {
        key: "0,0",
        col: 0,
        row: 0,
        glyph: "P",
        terrain: "Plains / farmland",
        open: true,
        party: false,
      },
      {
        key: "1,0",
        col: 1,
        row: 0,
        glyph: COVER,
        terrain: "Plains / farmland",
        open: false,
        party: false,
      },
    ]);
    expect(map.json.region).toEqual({ col0: 0, row0: 0, cols: 5, rows: 3 });
  });

  test("a window of a bigger world says it is a window", () => {
    const map = renderHexmap([cell(12, 7)], {
      ...options({ col0: 10, row0: 5, cols: 4, rows: 2, totalCells: 20_000, clamped: true }),
    });
    expect(map.ascii.split("\n")[0]).toBe(
      "hexmap Goblinwood 4×2 cells (hex oddQ, 1 cell = 6 mi) — a 4×2 window of 20000 cells; ask for one region at a time",
    );
    // Two-digit columns get a tens ruler, and the row labels line up under it.
    expect(map.ascii.split("\n").slice(1, 4)).toEqual([
      "   1 1 1 1",
      "   0 1 2 3",
      "5  · · · ·",
    ]);
  });

  test("a scene with no scale in its grid says so rather than inventing one", () => {
    const map = renderHexmap([], options({ grid: { ...grid, distance: 0 } }));
    expect(map.ascii.split("\n")[0]).toContain("no scale");
  });
});
