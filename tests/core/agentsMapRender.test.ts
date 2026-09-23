// MCP connector §5.2 — `map.render`, byte-exact.
//
// The plan asks for renderer tests "with byte-exact expected output", and it is worth being strict
// about it: this is the one tool whose answer a human reads over the model's shoulder, so a change
// that shifts a column by one space is a change that has to be *decided*, not one that slides in.
// The fixture is a 12×9 square scene (100 px cells, 5 ft each) with a vertical wall running down
// column 5, a friendly PC at (350,150), a hostile at (750,450) and a neutral at (150,850).
import { describe, expect, test } from "vitest";
import { renderMap, type RenderScene } from "../../src/core/agents/mapRender";

const SQUARE: RenderScene = {
  width: 1200,
  height: 900,
  grid: {
    type: "square",
    size: 100,
    distance: 5,
    units: "ft",
    hexLayout: "oddQ",
  },
  tokens: [
    {
      id: "t-vex",
      name: "Vex",
      x: 350,
      y: 150,
      disposition: "friendly",
      hidden: false,
      actorId: "a-vex",
    },
    {
      id: "t-gob",
      name: "Goblin",
      x: 750,
      y: 450,
      disposition: "hostile",
      hidden: false,
      actorId: null,
    },
    {
      id: "t-cat",
      name: "Cat",
      x: 150,
      y: 850,
      disposition: "neutral",
      hidden: false,
      actorId: null,
    },
  ],
  walls: [{ c: [500, 0, 500, 400] }, { c: [0, 500, 300, 500] }],
  fog: null,
};

const WHOLE_MAP = [
  "map 12×9 cells (square, 1 cell = 5 ft) — no fog state on this replica",
  "                       1 1",
  "   0 1 2 3 4 5 6 7 8 9 0 1",
  "0  . . . . . | . . . . . .",
  "1  . . . @ . | . . . . . .",
  "2  . . . . . | . . . . . .",
  "3  . . . . . | . . . . . .",
  "4  . . . . . | . H . . . .",
  "5  - - - - . . . . . . . .",
  "6  . . . . . . . . . . . .",
  "7  . . . . . . . . . . . .",
  "8  . N . . . . . . . . . .",
  "",
  "Glyphs: . empty · |-/\\ wall · ▓ unexplored · ░ gm-only · @ party · F friendly · H hostile · N neutral",
  "Legend:",
  "  1 @ Vex — friendly · cell 3,1 · id t-vex",
  "  2 H Goblin — hostile · cell 7,4 · id t-gob",
  "  3 N Cat — neutral · cell 1,8 · id t-cat",
].join("\n");

describe("map.render (MCP plan §5.2)", () => {
  test("the whole scene, byte for byte", () => {
    expect(renderMap(SQUARE).ascii).toBe(WHOLE_MAP);
  });

  test("the JSON form carries an id on every glyph, so the model can point instead of guess", () => {
    const map = renderMap(SQUARE);
    expect(map.json.region).toEqual({ col0: 0, row0: 0, cols: 12, rows: 9 });
    expect(map.json.tokens).toEqual([
      {
        id: "t-vex",
        name: "Vex",
        col: 3,
        row: 1,
        glyph: "@",
        disposition: "friendly",
        hidden: false,
        actorId: "a-vex",
      },
      {
        id: "t-gob",
        name: "Goblin",
        col: 7,
        row: 4,
        glyph: "H",
        disposition: "hostile",
        hidden: false,
        actorId: null,
      },
      {
        id: "t-cat",
        name: "Cat",
        col: 1,
        row: 8,
        glyph: "N",
        disposition: "neutral",
        hidden: false,
        actorId: null,
      },
    ]);
    // Wall cells are counted, not listed: the ASCII says where they are, and a list of 400 segments
    // would cost more context than it is worth.
    expect(map.json.walls).toBe(9);
    expect(map.json.fog).toBeNull();
    expect(map.rowsGlyphs).toHaveLength(9);
  });

  test("friendly with an actor behind it is the party (@); friendly without one is an ally (F)", () => {
    const map = renderMap({
      ...SQUARE,
      tokens: [
        {
          id: "t-pc",
          name: "Hero",
          x: 50,
          y: 50,
          disposition: "friendly",
          hidden: false,
          actorId: "a-1",
        },
        {
          id: "t-ally",
          name: "Guard",
          x: 150,
          y: 50,
          disposition: "friendly",
          hidden: false,
          actorId: null,
        },
      ],
      walls: [],
    });
    expect(map.rowsGlyphs[0]).toBe("@F..........");
  });

  test("several tokens in one cell fall back to a letter from the name", () => {
    const map = renderMap({
      ...SQUARE,
      tokens: [
        {
          id: "t-g1",
          name: "Goblin",
          x: 750,
          y: 450,
          disposition: "hostile",
          hidden: false,
          actorId: null,
        },
        {
          id: "t-g2",
          name: "Goblin Archer",
          x: 790,
          y: 470,
          disposition: "hostile",
          hidden: false,
          actorId: null,
        },
      ],
      walls: [],
    });
    expect(map.rowsGlyphs[4]?.[7]).toBe("G");
    // …and both are in the legend, because the glyph is not the answer — the id is.
    expect(map.json.tokens.map((t) => t.id)).toEqual(["t-g1", "t-g2"]);
    expect(map.legend).toEqual([
      "  1 G Goblin — hostile · cell 7,4 · id t-g1",
      "  2 G Goblin Archer — hostile · cell 7,4 · id t-g2",
    ]);
  });

  test("a region renders just the rect, with its own rulers", () => {
    const map = renderMap(SQUARE, { rect: { x: 300, y: 100, w: 300, h: 200 } });
    expect(map.ascii).toBe(
      [
        "map 4×3 cells (square, 1 cell = 5 ft) — no fog state on this replica",
        "   3 4 5 6",
        "1  @ . | .",
        "2  . . | .",
        "3  . . | .",
        "",
        "Glyphs: . empty · |-/\\ wall · ▓ unexplored · ░ gm-only · @ party · F friendly · H hostile · N neutral",
        "Legend:",
        "  1 @ Vex — friendly · cell 3,1 · id t-vex",
      ].join("\n"),
    );
    expect(map.json.region).toEqual({ col0: 3, row0: 1, cols: 4, rows: 3 });
  });

  test("fog is drawn, and a wall is drawn *over* it — a map that hides every door is unusable", () => {
    const fog = { cols: 12, rows: 9, cells: new Uint8Array(12 * 9) };
    for (let i = 0; i < fog.cells.length; i += 1)
      fog.cells[i] = i < 30 ? 1 : i > 100 ? 2 : 0;
    const map = renderMap({ ...SQUARE, fog });
    expect(map.rowsGlyphs[0]).toBe("▓▓▓▓▓|▓▓▓▓▓▓");
    // The cat at (1,8) still wins over the fog it is standing in — tokens are never occluded.
    expect(map.rowsGlyphs[8]).toBe(".N...░░░░░░░");
    // No fog on this replica ⇒ the map says so rather than drawing an empty grid and letting the
    // model conclude the scene is unexplored.
    expect(renderMap(SQUARE).ascii).toContain("no fog state on this replica");
    expect(renderMap({ ...SQUARE, fog }).ascii).not.toContain("no fog state");
  });

  test("hex scenes place tokens through the §9 grid math, not by division", () => {
    const map = renderMap({
      width: 600,
      height: 520,
      grid: {
        type: "hex",
        size: 60,
        distance: 5,
        units: "ft",
        hexLayout: "oddQ",
      },
      tokens: [
        {
          id: "t-h",
          name: "Hero",
          x: 180,
          y: 104,
          disposition: "friendly",
          hidden: false,
          actorId: "a-h",
        },
      ],
      walls: [],
      fog: null,
    });
    expect(map.json.grid.type).toBe("hex");
    expect(map.json.tokens[0]).toMatchObject({ id: "t-h", col: 2, row: 1 });
    expect(map.ascii).toContain("hex oddQ");
    expect(map.rowsGlyphs[1]?.[2]).toBe("@");
  });

  test("the switches switch", () => {
    const bare = renderMap(SQUARE, { showWalls: false, showTokens: false });
    expect(bare.ascii).toContain("walls hidden, tokens hidden");
    expect(bare.rowsGlyphs.join("")).toBe(".".repeat(12 * 9));
    expect(bare.json.walls).toBe(0);
    expect(bare.json.tokens).toEqual([]);
  });
});
