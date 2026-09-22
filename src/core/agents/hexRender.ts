/**
 * MCP connector §5.6 (F1) — `hexmap.render`: the **hexcrawl layer** as text a model can reason about.
 *
 * `map.render` draws a *tactical* scene: tokens, walls, fog, one glyph per grid cell. This draws the
 * overworld the party walks — one glyph per **authored cell**, lettered by terrain, with the party
 * marked and unrevealed ground left as cover. Same two forms, same reasons:
 *
 * - **ASCII** — one character per hex, column and row rulers, so "12,7" in the legend and "12,7" on
 *   the map are the same hex, and a human can read over the model's shoulder.
 * - **JSON** — the same grid with a key on every glyph, so the model can *point* at a hex
 *   (`hex.read key=12,7`) instead of guessing which one the prose meant.
 *
 * What it deliberately does **not** do is decide what a caller may see. A cell the projection did not
 * send is simply absent from `glyphs`, and a cell that is present but unrevealed is drawn as cover —
 * the renderer draws what it is handed, the view and the projection decide what that is (§5.2's
 * redaction, D-271's rule for one cell).
 *
 * Pure, DOM-free, and byte-exact tested (`tests/core/agentsHexRender.test.ts`).
 */
import type { HexLayout } from "../documents";

/** A cell as the map draws it. */
export interface HexGlyph {
  /** The cell key, `q,r` — the id every other hexcrawl tool takes. */
  key: string;
  col: number;
  row: number;
  /** The terrain's letter (see `terrainLetters`), or "" when the cell names no terrain. */
  letter: string;
  /** The terrain's display name, or "" when the cell names no terrain. */
  name: string;
  /** Revealed to the table. A closed cell is drawn as cover. */
  open: boolean;
  /** The party stands here. */
  party: boolean;
}

/** One terrain's entry in the legend. */
export interface HexTerrainEntry {
  id: string;
  name: string;
  /** The letter the map draws it with. */
  letter: string;
  /** How many of the drawn hexes carry it. */
  count: number;
  /** Travel cost multiplier: 1 = open ground, 2 = half speed. Omitted when unknown. */
  cost?: number;
}

export interface HexMapOptions {
  sceneName: string;
  grid: {
    type: "square" | "hex" | "gridless";
    size: number;
    distance: number;
    units: string;
    hexLayout: HexLayout;
  };
  /** The region being drawn, in cells. */
  col0: number;
  row0: number;
  cols: number;
  rows: number;
  /** How many cells the scene holds, and how many the map drew — a 20 000-hex world says so. */
  totalCells: number;
  /** Terrains in catalog order; the legend is printed in this order. */
  terrains: readonly HexTerrainEntry[];
  /** Set when the region was clamped: the map is a window, not the world. */
  clamped?: boolean;
}

export interface RenderedHexMap {
  cols: number;
  rows: number;
  /** One string per row, one character per cell — the ASCII form without the rulers. */
  rowsGlyphs: string[];
  ascii: string;
  legend: string[];
  json: {
    grid: HexMapOptions["grid"];
    region: { col0: number; row0: number; cols: number; rows: number };
    rows: string[];
    cells: Array<{
      key: string;
      col: number;
      row: number;
      glyph: string;
      terrain: string;
      open: boolean;
      party: boolean;
    }>;
    legend: readonly HexTerrainEntry[];
    totalCells: number;
  };
}

/** No cell authored here — the ring paints ground nobody wrote. */
export const NO_CELL = "·";
/** A cell with no terrain of its own (the catalog's `defaultTerrain` covers it). */
export const BLANK_CELL = ".";
/** Unrevealed: the party has not been shown this ground. Drawn, not described. */
export const COVER = "▓";
/** The party. */
export const PARTY = "@";

/**
 * One letter per terrain, derived from its name so a custom catalog reads the same way: the first
 * letter of the label, and on a collision the next unused letter of the name, then the next unused
 * letter of the alphabet. Deterministic for a given catalog order, which is what a byte-exact test
 * and a stable legend both need.
 */
export function terrainLetters(
  terrains: ReadonlyArray<{ id: string; name: string; label?: string | undefined }>,
): Record<string, string> {
  const taken = new Set<string>([NO_CELL, BLANK_CELL, COVER, PARTY]);
  const out: Record<string, string> = {};
  for (const terrain of terrains) {
    const source = `${terrain.label ?? terrain.name}ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
    let letter = "";
    for (const char of source.toUpperCase()) {
      if (!/[A-Z]/.test(char)) continue;
      if (taken.has(char)) continue;
      letter = char;
      break;
    }
    if (letter === "") {
      // Every letter is taken: fall back to a digit, so two terrains never share a glyph.
      for (let i = 0; i < 10; i++) {
        const digit = String(i);
        if (!taken.has(digit)) {
          letter = digit;
          break;
        }
      }
    }
    if (letter === "") continue;
    taken.add(letter);
    out[terrain.id] = letter;
  }
  return out;
}

/** The glyph one cell draws as. Exported so the tool and the map never disagree. */
export function glyphFor(cell: HexGlyph): string {
  if (cell.party) return PARTY;
  if (!cell.open) return COVER;
  return cell.letter === "" ? BLANK_CELL : cell.letter;
}

/**
 * Draw the region. `glyphs` may be sparse — a hex with no cell document is simply missing, and its
 * place in the grid is drawn as `NO_CELL`, which is how the reader tells "empty ground" from
 * "ground the party has not been shown".
 */
export function renderHexmap(
  glyphs: readonly HexGlyph[],
  options: HexMapOptions,
): RenderedHexMap {
  const { col0, row0, cols, rows } = options;
  const at = new Map<string, HexGlyph>();
  for (const cell of glyphs) at.set(`${cell.col},${cell.row}`, cell);

  const lines: string[] = [];
  const drawn: RenderedHexMap["json"]["cells"] = [];
  const counts = new Map<string, number>();
  for (let r = 0; r < rows; r++) {
    const line: string[] = [];
    for (let c = 0; c < cols; c++) {
      const col = col0 + c;
      const row = row0 + r;
      const cell = at.get(`${col},${row}`);
      if (!cell) {
        line.push(NO_CELL);
        continue;
      }
      const glyph = glyphFor(cell);
      line.push(glyph);
      drawn.push({
        key: cell.key,
        col,
        row,
        glyph,
        terrain: cell.name,
        open: cell.open,
        party: cell.party,
      });
      // Counted by the glyph actually drawn: a hex under cover or under the party is not a "P" the
      // reader can find on the map, and a legend that claims three of them when one is drawn is a
      // model pointing at terrain that is not there.
      if (glyph === cell.letter && cell.letter !== "") {
        counts.set(cell.letter, (counts.get(cell.letter) ?? 0) + 1);
      }
    }
    lines.push(line.join(""));
  }

  // Rulers, in map.render's shape: a tens row when the columns need one, then the units row, then
  // each row labelled. "3,1" in the legend and "3,1" on the map are the same cell.
  const labelWidth = String(row0 + rows - 1).length;
  const indent = " ".repeat(labelWidth + 2);
  const header: string[] = [];
  if (col0 + cols > 10) {
    header.push(
      indent +
        Array.from({ length: cols }, (_, i) => {
          const col = col0 + i;
          return col >= 10 ? String(Math.floor(col / 10) % 10) : " ";
        }).join(" "),
    );
  }
  header.push(
    indent + Array.from({ length: cols }, (_, i) => String((col0 + i) % 10)).join(" "),
  );
  const body = lines.map(
    (line, i) =>
      `${String(row0 + i).padStart(labelWidth)}  ${line.split("").join(" ")}`,
  );

  const kind =
    options.grid.type === "hex"
      ? `${options.grid.type} ${options.grid.hexLayout}`
      : options.grid.type;
  const scale =
    options.grid.distance > 0
      ? `1 cell = ${options.grid.distance} ${options.grid.units}`
      : "no scale";
  const window =
    options.clamped === true
      ? ` — a ${cols}×${rows} window of ${options.totalCells} cells; ask for one region at a time`
      : "";

  const legend: string[] = options.terrains
    .filter((terrain) => (counts.get(terrain.letter) ?? 0) > 0)
    .map((terrain) => {
      const count = counts.get(terrain.letter) ?? 0;
      const cost =
        terrain.cost === undefined
          ? ""
          : ` · cost ${terrain.cost === 1 ? "1 (open ground)" : `${terrain.cost}×`}`;
      return `  ${terrain.letter} ${terrain.name} — ${count} cell(s)${cost}`;
    });
  const glyphKey = [
    `${NO_CELL} no cell`,
    `${BLANK_CELL} no terrain`,
    `${COVER} unrevealed`,
    `${PARTY} party`,
  ].join(" · ");

  const head = `hexmap ${options.sceneName} ${cols}×${rows} cells (${kind}, ${scale})${window}`;
  const ascii = [
    head,
    ...header,
    ...body,
    "",
    `Glyphs: ${glyphKey} · terrain letters below`,
    ...(legend.length > 0 ? ["Terrain:", ...legend] : []),
  ].join("\n");

  return {
    cols,
    rows,
    rowsGlyphs: lines,
    ascii,
    legend,
    json: {
      grid: options.grid,
      region: { col0, row0, cols, rows },
      rows: lines,
      cells: drawn,
      legend: options.terrains,
      totalCells: options.totalCells,
    },
  };
}
