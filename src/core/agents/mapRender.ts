/**
 * MCP connector §5.2 — `map.render`: the scene as **text a model can reason about**.
 *
 * This is the tool that makes "LLM as GM" real, and the reason it is worth writing carefully: every
 * other read hands back records, which a model can only name; a map hands back *arrangement*, which
 * is what "the goblin is two squares from the door" needs. Two forms, same data:
 *
 * - **ASCII** — one character per cell, drawn for a human reading over the model's shoulder.
 * - **JSON** — the same grid with an id on every glyph, so the model can *point* at things
 *   (`token.move` by id) instead of guessing coordinates from prose.
 *
 * Rules the output obeys, because they are what make it usable:
 * - **Tokens win over walls win over fog win over empty** — the thing you are most likely to act on
 *   is the thing that must not be occluded.
 * - **Coordinates are printed, not implied**: column and row rulers, and row labels, so "3,1" in the
 *   legend and "3,1" on the map are the same cell.
 * - **Hidden tokens are the caller's decision, not the renderer's.** It draws what it is handed; the
 *   tool layer withholds what the grant does not cover (§5.2's redaction).
 *
 * Pure, DOM-free, and byte-exact tested on a 12×9 fixture (`tests/core/agentsMapRender.test.ts`).
 */
import type { HexLayout } from "../documents";
import { hexFromPixel } from "../../canvas/grid/hex";

export type Disposition = "hostile" | "neutral" | "friendly";

export interface RenderToken {
  id: string;
  name: string;
  x: number;
  y: number;
  disposition: Disposition;
  hidden: boolean;
  actorId: string | null;
}

export interface RenderWall {
  /** [x1, y1, x2, y2] in world pixels. */
  c: [number, number, number, number];
}

/** 0 = open, 1 = unexplored (▓), 2 = GM-only (░). Sized to the map's own cell grid. */
export interface RenderFog {
  cols: number;
  rows: number;
  cells: Uint8Array;
}

export interface RenderGrid {
  type: "square" | "hex" | "gridless";
  size: number;
  distance: number;
  units: string;
  hexLayout: HexLayout;
}

export interface RenderScene {
  width: number;
  height: number;
  grid: RenderGrid;
  tokens: RenderToken[];
  walls: RenderWall[];
  /** Null when this replica holds no fog state — the legend says so rather than drawing a guess. */
  fog?: RenderFog | null;
}

export interface RenderOptions {
  format?: "ascii" | "json";
  showWalls?: boolean;
  showTokens?: boolean;
  showFog?: boolean;
  /** A world-pixel rectangle to render instead of the whole scene. */
  rect?: { x: number; y: number; w: number; h: number } | null;
  /** Centre on a world point (a token's position) and render `radius` cells around it. */
  around?: { x: number; y: number } | null;
  radius?: number;
}

export interface RenderedToken {
  id: string;
  name: string;
  col: number;
  row: number;
  glyph: string;
  disposition: Disposition;
  hidden: boolean;
  actorId: string | null;
}

export interface RenderedMap {
  cols: number;
  rows: number;
  /** One string per row, one character per cell — the ASCII form without the rulers. */
  rowsGlyphs: string[];
  ascii: string;
  json: {
    grid: {
      type: string;
      size: number;
      distance: number;
      units: string;
      layout: HexLayout;
    };
    region: { col0: number; row0: number; cols: number; rows: number };
    rows: string[];
    tokens: RenderedToken[];
    walls: number;
    fog: { cols: number; rows: number } | null;
    legend: string[];
  };
  legend: string[];
}

const EMPTY = ".";
const WALL_CHARS = { v: "|", h: "-", up: "/", down: "\\" } as const;
const FOG_UNEXPLORED = "▓";
const FOG_GM_ONLY = "░";

const SQRT3 = Math.sqrt(3);

/** Cell pitch in world pixels: how far apart two adjacent columns / rows are. */
function pitch(grid: RenderGrid): { colW: number; rowH: number } {
  const size = grid.size > 0 ? grid.size : 100;
  if (grid.type === "hex") {
    const flat = grid.hexLayout === "evenQ" || grid.hexLayout === "oddQ";
    return flat
      ? { colW: size * 1.5, rowH: size * SQRT3 }
      : { colW: size * SQRT3, rowH: size * 1.5 };
  }
  return { colW: size, rowH: size };
}

/** The scene's whole cell grid, in columns × rows. */
function gridSize(scene: RenderScene): { cols: number; rows: number } {
  const { colW, rowH } = pitch(scene.grid);
  const w = scene.width > 0 ? scene.width : colW * 10;
  const h = scene.height > 0 ? scene.height : rowH * 10;
  return {
    cols: Math.max(
      1,
      Math.ceil(w / colW) + (scene.grid.type === "hex" ? 1 : 0),
    ),
    rows: Math.max(
      1,
      Math.ceil(h / rowH) + (scene.grid.type === "hex" ? 1 : 0),
    ),
  };
}

/** The cell containing a world point — hex through the §9 grid math, square by division. */
function cellOf(
  scene: RenderScene,
  x: number,
  y: number,
): { col: number; row: number } {
  if (scene.grid.type === "hex" && scene.grid.size > 0) {
    const spec = {
      type: "hex" as const,
      size: scene.grid.size,
      layout: scene.grid.hexLayout,
    };
    const cell = hexFromPixel(spec, x, y);
    return { col: cell.q, row: cell.r };
  }
  const { colW, rowH } = pitch(scene.grid);
  return { col: Math.floor(x / colW), row: Math.floor(y / rowH) };
}

const glyphFor = (token: RenderToken): string => {
  if (token.disposition === "hostile") return "H";
  if (token.disposition === "neutral") return "N";
  // Friendly *with* an actor behind it is a player's character — the party. The rest are allies.
  return token.actorId ? "@" : "F";
};

/** Several tokens in one cell: the plan's "letters from the name", so the cell is still readable. */
function sharedGlyph(tokens: RenderToken[]): string {
  const first = tokens[0];
  if (!first) return "*";
  const letter = first.name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 1);
  return letter === "" ? "*" : letter;
}

export function renderMap(
  scene: RenderScene,
  options: RenderOptions = {},
): RenderedMap {
  const showWalls = options.showWalls !== false;
  const showTokens = options.showTokens !== false;
  const showFog = options.showFog !== false;
  const grid = gridSize(scene);
  const cols = grid.cols;
  const rows = grid.rows;

  // ── the region ────────────────────────────────────────────────────────────────────────────────
  let col0 = 0;
  let row0 = 0;
  let col1 = cols - 1;
  let row1 = rows - 1;
  if (options.rect) {
    const r = options.rect;
    const a = cellOf(scene, r.x, r.y);
    const b = cellOf(scene, r.x + Math.max(0, r.w), r.y + Math.max(0, r.h));
    col0 = Math.max(0, Math.min(a.col, b.col));
    col1 = Math.min(cols - 1, Math.max(a.col, b.col));
    row0 = Math.max(0, Math.min(a.row, b.row));
    row1 = Math.min(rows - 1, Math.max(a.row, b.row));
  } else if (options.around) {
    const centre = cellOf(scene, options.around.x, options.around.y);
    const radius = Math.max(1, Math.trunc(options.radius ?? 4));
    col0 = Math.max(0, centre.col - radius);
    col1 = Math.min(cols - 1, centre.col + radius);
    row0 = Math.max(0, centre.row - radius);
    row1 = Math.min(rows - 1, centre.row + radius);
  }
  const width = col1 - col0 + 1;
  const height = row1 - row0 + 1;

  // ── paint: fog, then walls, then tokens ───────────────────────────────────────────────────────
  const cells: string[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => EMPTY),
  );
  const at = (_col: number, row: number): string[] | null => {
    const line = cells[row - row0];
    return line ?? null;
  };
  const put = (col: number, row: number, ch: string): void => {
    const line = at(col, row);
    if (!line) return;
    line[col - col0] = ch;
  };

  if (showFog && scene.fog) {
    for (let row = row0; row <= row1; row += 1) {
      for (let col = col0; col <= col1; col += 1) {
        const value = scene.fog.cells[row * scene.fog.cols + col];
        if (value === 1) put(col, row, FOG_UNEXPLORED);
        else if (value === 2) put(col, row, FOG_GM_ONLY);
      }
    }
  }

  let wallCells = 0;
  if (showWalls) {
    const stampCells: Array<{ col: number; row: number; ch: string }> = [];
    for (const wall of scene.walls) {
      const [x1, y1, x2, y2] = wall.c;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      if (!(length > 0)) continue;
      // Dominant axis picks the glyph; walls are line segments and one character per cell can only
      // say which way the line runs.
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      let ch: string;
      if (Math.abs(dx) < 1) ch = WALL_CHARS.v;
      else if (Math.abs(dy) < 1) ch = WALL_CHARS.h;
      else if (horizontal) ch = dy < 0 ? WALL_CHARS.up : WALL_CHARS.down;
      else ch = dx * dy > 0 ? WALL_CHARS.down : WALL_CHARS.up;
      const steps = Math.max(
        2,
        Math.ceil(length / Math.max(8, pitch(scene.grid).colW / 4)),
      );
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const cell = cellOf(scene, x1 + dx * t, y1 + dy * t);
        if (
          cell.col < col0 ||
          cell.col > col1 ||
          cell.row < row0 ||
          cell.row > row1
        )
          continue;
        stampCells.push({ col: cell.col, row: cell.row, ch });
      }
    }
    for (const stamp of stampCells) {
      // A wall is drawn over fog but never over a token: fog says what a *player* has seen, and a
      // map that hides the door behind every unexplored cell is a map that cannot be navigated.
      const existing = at(stamp.col, stamp.row)?.[stamp.col - col0];
      if (
        existing !== EMPTY &&
        existing !== FOG_UNEXPLORED &&
        existing !== FOG_GM_ONLY
      )
        continue;
      put(stamp.col, stamp.row, stamp.ch);
      wallCells += 1;
    }
  }

  const renderedTokens: RenderedToken[] = [];
  const byCell = new Map<string, RenderToken[]>();
  if (showTokens) {
    for (const token of scene.tokens) {
      const cell = cellOf(scene, token.x, token.y);
      const key = `${cell.col},${cell.row}`;
      const list = byCell.get(key) ?? [];
      list.push(token);
      byCell.set(key, list);
    }
    for (const [key, list] of byCell) {
      const [colText, rowText] = key.split(",");
      const col = Number(colText);
      const row = Number(rowText);
      if (col < col0 || col > col1 || row < row0 || row > row1) continue;
      const glyph =
        list.length > 1 ? sharedGlyph(list) : glyphFor(list[0] as RenderToken);
      put(col, row, list.length > 1 ? sharedGlyph(list) : glyph);
      for (const token of list) {
        renderedTokens.push({
          id: token.id,
          name: token.name,
          col,
          row,
          glyph: list.length > 1 ? glyph : glyphFor(token),
          disposition: token.disposition,
          hidden: token.hidden,
          actorId: token.actorId,
        });
      }
    }
  }
  renderedTokens.sort(
    (a, b) => a.row - b.row || a.col - b.col || a.name.localeCompare(b.name),
  );

  // ── the two forms ─────────────────────────────────────────────────────────────────────────────
  const rowsGlyphs = cells.map((line) => line.join(""));
  const labelWidth = String(row1).length;
  const indent = " ".repeat(labelWidth + 2);
  const header: string[] = [];
  if (width > 10) {
    header.push(
      indent +
        Array.from({ length: width }, (_, i) => {
          const col = col0 + i;
          return col >= 10 ? String(Math.floor(col / 10) % 10) : " ";
        }).join(" "),
    );
  }
  header.push(
    indent +
      Array.from({ length: width }, (_, i) => String((col0 + i) % 10)).join(
        " ",
      ),
  );
  const body = cells.map(
    (line, i) => `${String(row0 + i).padStart(labelWidth)}  ${line.join(" ")}`,
  );

  const kind =
    scene.grid.type === "hex" ? `hex ${scene.grid.hexLayout}` : scene.grid.type;
  const scale =
    scene.grid.distance > 0
      ? `1 cell = ${scene.grid.distance} ${scene.grid.units}`
      : "no scale";

  const legend: string[] = [];
  for (const [index, token] of renderedTokens.entries()) {
    const tag = token.hidden ? "hidden" : token.disposition;
    legend.push(
      `  ${index + 1} ${token.glyph} ${token.name} — ${tag} · cell ${token.col},${token.row} · id ${token.id}`,
    );
  }

  const glyphKey = [
    `${EMPTY} empty`,
    `${WALL_CHARS.v}${WALL_CHARS.h}${WALL_CHARS.up}${WALL_CHARS.down} wall`,
    `${FOG_UNEXPLORED} unexplored`,
    `${FOG_GM_ONLY} gm-only`,
    "@ party",
    "F friendly",
    "H hostile",
    "N neutral",
  ].join(" · ");

  const notes: string[] = [];
  if (!showWalls) notes.push("walls hidden");
  if (!showTokens) notes.push("tokens hidden");
  if (!showFog) notes.push("fog hidden");
  else if (!scene.fog) notes.push("no fog state on this replica");

  const head = `map ${width}×${height} cells (${kind}, ${scale})${notes.length > 0 ? ` — ${notes.join(", ")}` : ""}`;
  const ascii = [
    head,
    ...header,
    ...body,
    "",
    "Glyphs: " + glyphKey,
    ...(legend.length > 0 ? ["Legend:", ...legend] : []),
  ].join("\n");

  return {
    cols: width,
    rows: height,
    rowsGlyphs,
    ascii,
    legend,
    json: {
      grid: {
        type: scene.grid.type,
        size: scene.grid.size,
        distance: scene.grid.distance,
        units: scene.grid.units,
        layout: scene.grid.hexLayout,
      },
      region: { col0, row0, cols: width, rows: height },
      rows: rowsGlyphs,
      tokens: renderedTokens,
      walls: wallCells,
      fog: scene.fog ? { cols: scene.fog.cols, rows: scene.fog.rows } : null,
      legend,
    },
  };
}
