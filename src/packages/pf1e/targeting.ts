/**
 * P5/C01 — pure grid targeting for PF1e area spells.
 *
 * Everything here is pure math on **cell coordinates**: cell `(col, row)`
 * occupies the square `[col, col+1) × [row, row+1)` in cell space, and a grid
 * **intersection** is an integer point `(col, row)` shared by four cells. The
 * canvas/host layer converts scene world units ↔ cell space (see
 * `worldToCell` / `cellRect`); nothing in this module knows about Pixi.
 *
 * Rule sources (transcribed 2026-09-11 from Archives of Nethys Rules ID 212
 * "Aiming a Spell", i.e. CRB pp.214–216; the same text appears verbatim on
 * d20pfsrd.com/magic and d20srd.org). Each encoded rule is cited inline.
 *
 * **Shapes resolved here:** burst, emanation, cylinder, spread — the four whose
 * grid templates follow unambiguously from the quoted counting rule. C01 says
 * "burst, cone, line, emanation, spread/cylinder **where supported**".
 *
 * **Not encoded on purpose — cone and line (C01b).** Both have a contested grid
 * discretization that the rules text does not settle:
 *   • Cone: AoN 212 says "a quarter-circle … starts from any corner of your
 *     square and widens out as it goes", but the rules designer's own answer on
 *     the template is "Cones can't be perfect on a square grid. Just pick one,
 *     drop it on the map so its origin point is the corner of one of the
 *     caster's squares, and that's what area the spell effects" (Sean K
 *     Reynolds, Paizo forums). Published templates disagree (1/2/3 rows vs
 *     2/4/6 rows for a 15-ft. cone).
 *   • Line: AoN 212 says it "affects all creatures in squares through which the
 *     line passes", but a zero-width line drawn exactly along grid lines or an
 *     exact diagonal grazes shared edges; the published template is a 5-ft.-wide
 *     corridor, so the two readings differ on every axis-aligned and 45° cast.
 * Per the R01 transcribe-before-fixtures requirement, C01b must fix a named
 * template from a canonical figure before any cone/line fixture is written —
 * a guessed template is exactly the "snapshot a missing table" failure V01
 * forbids, and this slice refuses to invent one.
 */
import { cellDistance, type DiagonalRule } from "../../canvas/grid/measure";
import type { Segment } from "../../canvas/vision/polygon";

/** Area shapes this slice resolves. Cone and line are deferred to C01b. */
export const PF1E_AREA_KINDS = [
  "burst",
  "emanation",
  "cylinder",
  "spread",
] as const;
export type PF1eAreaKind = (typeof PF1E_AREA_KINDS)[number];

/** One grid cell in cell coordinates. */
export interface PF1eCell {
  col: number;
  row: number;
}

/**
 * Scene grid facts. P01 requires these come from scene metadata rather than
 * hardcoded 5/15/30 constants: `cellSize` is `SceneGrid.size` (world units per
 * cell) and `feetPerCell` is `SceneGrid.distance` when `SceneGrid.units` is
 * feet — see `pf1eAreaGridFromScene`, the sanctioned bridge.
 *
 * `diagonals` is the counting rule for area membership. It is a field rather
 * than a constant so the pure math stays general and testable, but real
 * callers must pass `PF1E_AREA_DIAGONALS` ("5105") — AoN 212 fixes it as a
 * rule of spell areas, so the scene's ruler setting must not change it.
 */
export interface PF1eAreaGrid {
  cellSize: number;
  feetPerCell: number;
  diagonals: DiagonalRule;
}

export interface PF1eAreaSpec {
  kind: PF1eAreaKind;
  /** Grid **intersection** in cell coordinates (AoN 212: "always a grid intersection"). */
  origin: PF1eCell;
  /** Radius in feet. */
  radiusFt: number;
}

export interface PF1eAreaIssue {
  field: string;
  message: string;
}

export interface PF1eAreaResolution {
  cells: PF1eCell[];
  /** Named problems; the returned `cells` are still the usable best effort. */
  issues: PF1eAreaIssue[];
}

export interface PF1eAreaOptions {
  /** Cells the effect may not enter (spread) — walls/obstacles as a predicate. */
  isBlocked?: (cell: PF1eCell) => boolean;
  /** Solid barriers for line-of-effect tests (see `hasLineOfEffect`). */
  segments?: readonly Segment[];
  /**
   * Apply line-of-effect from the origin to each cell. Default true for
   * burst/emanation, **false** for cylinder and spread — see `resolveAreaCells`
   * for the reconciled cylinder reading and the quoted spread exemption.
   */
  lineOfEffect?: boolean;
  /** Safety cap on emitted cells (default 4096). */
  maxCells?: number;
}

/** Stable string key for a cell (Set/Map membership, dedupe). */
export function cellKey(cell: PF1eCell): string {
  return `${cell.col},${cell.row}`;
}

/** Set of cell keys, for fast `affectedTokens` membership tests. */
export function cellKeySet(cells: readonly PF1eCell[]): Set<string> {
  return new Set(cells.map(cellKey));
}

/** Rows of a resolved area keyed by row — the readable form used by fixtures. */
export function cellsByRow(cells: readonly PF1eCell[]): Map<number, number[]> {
  const rows = new Map<number, number[]>();
  for (const c of cells) {
    const cols = rows.get(c.row);
    if (cols) cols.push(c.col);
    else rows.set(c.row, [c.col]);
  }
  for (const cols of rows.values()) cols.sort((a, b) => a - b);
  return rows;
}

// ─── counting (AoN 212) ──────────────────────────────────────────────────────

/**
 * Distance in **squares** from a grid intersection to a cell, counted the way
 * AoN 212 prescribes: intersection to intersection, "every second diagonal
 * counts as 2 squares", measured to the cell's **far** corner.
 *
 * The far corner is what makes the inclusion rule come out right — "If the far
 * edge of a square is within the spell's area, anything within that square is
 * within the spell's area. If the spell's area only touches the near edge of a
 * square, however, anything within that square is unaffected." A 5-ft. radius
 * from an intersection must cover exactly the four cells sharing that corner
 * (a 10-ft. square); measuring to the near corner instead would wrongly add the
 * cells beyond them, and measuring to the centre would wrongly shrink it to a
 * single cell.
 */
export function areaCellDistance(
  cell: PF1eCell,
  origin: PF1eCell,
  grid: PF1eAreaGrid,
): number {
  // Offset of the corner farthest from the origin. A cell on the origin's
  // positive side has its far edge one cell further out; a cell on the negative
  // side has its far edge at its own low edge.
  const farCol =
    cell.col >= origin.col ? cell.col + 1 - origin.col : origin.col - cell.col;
  const farRow =
    cell.row >= origin.row ? cell.row + 1 - origin.row : origin.row - cell.row;
  return cellDistance(grid.diagonals, farCol, farRow);
}

/** Feet → whole cells, rounding up (a 12-ft. radius on a 5-ft. grid is 3 cells). */
export function feetToCells(feet: number, grid: PF1eAreaGrid): number {
  if (grid.feetPerCell <= 0) return 0;
  return Math.max(0, Math.ceil(feet / grid.feetPerCell));
}

/**
 * The diagonal rule PF1e spell areas are counted with. Pinned to 5-10-5
 * because AoN 212 states it as a rule of spell areas — "you can count
 * diagonally across a square, but remember that every second diagonal counts
 * as 2 squares of distance" — not as a measurement preference.
 *
 * This is deliberately **not** the scene's `SceneGrid.diagonals`: that setting
 * configures the VTT ruler, and this repository's default scene ships
 * `"555"`. Letting it drive area counting would silently change which squares
 * a fireball covers whenever a GM retunes their ruler. The scene supplies the
 * cell size and the feet-per-cell scale; the counting rule is the rules'.
 */
export const PF1E_AREA_DIAGONALS: DiagonalRule = "5105";

/**
 * Build the area grid from a scene's grid metadata (P01: scene data, never
 * hardcoded constants). Only feet-based scenes can be resolved — a metric
 * scene gets a named issue rather than an invented conversion, and the caller
 * sees an unusable `feetPerCell` of 0.
 */
export function pf1eAreaGridFromScene(grid: {
  size: number;
  distance: number;
  units: string;
}): { grid: PF1eAreaGrid; issues: PF1eAreaIssue[] } {
  const issues: PF1eAreaIssue[] = [];
  if (!Number.isFinite(grid.size) || grid.size <= 0) {
    issues.push({
      field: "grid.size",
      message: "scene grid size must be a positive number",
    });
  }
  const feet = grid.units === "ft";
  if (!feet) {
    issues.push({
      field: "grid.units",
      message: `PF1e area targeting needs a feet-based grid (scene units are "${grid.units}")`,
    });
  }
  if (feet && (!Number.isFinite(grid.distance) || grid.distance <= 0)) {
    issues.push({
      field: "grid.distance",
      message: "scene grid distance must be a positive number",
    });
  }
  return {
    grid: {
      cellSize: Number.isFinite(grid.size) && grid.size > 0 ? grid.size : 0,
      feetPerCell:
        feet && Number.isFinite(grid.distance) && grid.distance > 0
          ? grid.distance
          : 0,
      diagonals: PF1E_AREA_DIAGONALS,
    },
    issues,
  };
}

/**
 * Cells within a radius of the origin intersection — the shape shared by burst,
 * emanation and cylinder (AoN 212: for a cylinder "you select the spell's point
 * of origin. This point is the center of a horizontal circle, and the spell
 * shoots down from the circle, filling a cylinder").
 */
export function radiusCells(
  origin: PF1eCell,
  radiusFt: number,
  grid: PF1eAreaGrid,
): PF1eCell[] {
  const radius = feetToCells(radiusFt, grid);
  if (radius <= 0) return [];
  const out: PF1eCell[] = [];
  for (let row = origin.row - radius - 1; row <= origin.row + radius; row++) {
    for (let col = origin.col - radius - 1; col <= origin.col + radius; col++) {
      if (areaCellDistance({ col, row }, origin, grid) <= radius)
        out.push({ col, row });
    }
  }
  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}

// ─── line of effect (AoN 212) ────────────────────────────────────────────────

/** True when segment a crosses segment b (proper crossing or collinear overlap). */
function segmentsIntersect(a: Segment, b: Segment): boolean {
  const d1x = a.x2 - a.x1;
  const d1y = a.y2 - a.y1;
  const d2x = b.x2 - b.x1;
  const d2y = b.y2 - b.y1;
  const denom = d1x * d2y - d1y * d2x;
  const ex = b.x1 - a.x1;
  const ey = b.y1 - a.y1;
  if (Math.abs(denom) < 1e-12) {
    // Parallel: only collinear overlap counts.
    if (Math.abs(ex * d1y - ey * d1x) > 1e-9) return false;
    const len2 = d1x * d1x + d1y * d1y;
    if (len2 < 1e-18) return false;
    const t0 = (ex * d1x + ey * d1y) / len2;
    const t1 = t0 + (d2x * d1x + d2y * d1y) / len2;
    return Math.max(t0, t1) >= 0 && Math.min(t0, t1) <= 1;
  }
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9;
}

function blockedByAny(
  a: { x: number; y: number },
  b: { x: number; y: number },
  segments: readonly Segment[],
): boolean {
  const probe: Segment = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  for (const s of segments) {
    if (segmentsIntersect(probe, s)) return true;
  }
  return false;
}

/**
 * Line of effect from an origin **point** (world units) to a cell.
 *
 * AoN 212: "A burst, cone, cylinder, or emanation spell affects only an area,
 * creature, or object to which it has line of effect from its origin"; a burst
 * "can't affect creatures with total cover from its point of origin (in other
 * words, its effects don't extend around corners)". Total cover means *no* line
 * reaches the square, so LoE exists when any probe line is unblocked. The four
 * corners plus the centre are probed; a barrier that blocks all five while
 * leaving some other point of the square open is not modelled.
 *
 * The "hole of at least 1 square foot … does not block a spell's line of
 * effect" clause needs no special case here: this model authors such a barrier
 * as two segments with a gap, and a probe through the gap crosses nothing.
 */
export function hasLineOfEffect(
  originWorld: { x: number; y: number },
  cell: PF1eCell,
  grid: PF1eAreaGrid,
  segments: readonly Segment[],
): boolean {
  if (segments.length === 0) return true;
  const r = cellRect(cell, grid);
  const probes = [
    { x: r.x, y: r.y },
    { x: r.x + grid.cellSize, y: r.y },
    { x: r.x, y: r.y + grid.cellSize },
    { x: r.x + grid.cellSize, y: r.y + grid.cellSize },
    { x: r.x + grid.cellSize / 2, y: r.y + grid.cellSize / 2 },
  ];
  for (const p of probes) {
    if (!blockedByAny(originWorld, p, segments)) return true;
  }
  return false;
}

/** Drop the cells the origin has no line of effect to (AoN 212). */
export function applyLineOfEffectFromOrigin(
  cells: readonly PF1eCell[],
  originWorld: { x: number; y: number },
  grid: PF1eAreaGrid,
  segments: readonly Segment[],
): PF1eCell[] {
  if (segments.length === 0) return cells as PF1eCell[];
  return cells.filter((c) => hasLineOfEffect(originWorld, c, grid, segments));
}

/**
 * Whether the caster may place the origin at all: "You must have a clear line
 * of effect to the point of origin of any spell you cast" (AoN 212). Probed a
 * hair inside each of the four cells around the intersection so a zero-length
 * test never reports a false block.
 */
export function hasLineOfEffectToOrigin(
  casterWorld: { x: number; y: number },
  origin: PF1eCell,
  grid: PF1eAreaGrid,
  segments: readonly Segment[],
): boolean {
  if (segments.length === 0) return true;
  const o = intersectionToWorld(origin, grid);
  const eps = grid.cellSize * 0.01;
  const probes = [
    { x: o.x + eps, y: o.y + eps },
    { x: o.x - eps, y: o.y + eps },
    { x: o.x + eps, y: o.y - eps },
    { x: o.x - eps, y: o.y - eps },
  ];
  return probes.some((p) => !blockedByAny(casterWorld, p, segments));
}

// ─── spread (AoN 212) ────────────────────────────────────────────────────────

/**
 * Spread cells: a spread "extends out like a burst but can turn corners. You
 * select the point of origin, and the spell spreads out a given distance in all
 * directions. Figure the area the spell effect fills by taking into account any
 * turns the spell effect takes", "count around walls, not through them", and
 * "as with movement, do not trace diagonals across corners".
 *
 * Cost model: Dijkstra over cells where the running cost is the 5-10-5 count of
 * the path actually travelled. An orthogonal step costs 1; a diagonal step
 * costs 1 when the path's diagonal count is even and 2 when it is odd, which
 * reproduces `orthogonal + diagonals + floor(diagonals / 2)` exactly. Only that
 * parity affects the next step's cost, so `(cell, parity)` is a sufficient
 * state. The four cells around the origin intersection are seeded at cost 1 —
 * the effect starts at the intersection, so entering any adjacent cell is one
 * step, matching the 5-ft. burst's 2×2.
 */
export function spreadCells(
  origin: PF1eCell,
  radiusFt: number,
  grid: PF1eAreaGrid,
  isBlocked?: (cell: PF1eCell) => boolean,
  maxCells = 4096,
): PF1eCell[] {
  const budget = feetToCells(radiusFt, grid);
  if (budget <= 0) return [];
  const blocked = isBlocked ?? ((): boolean => false);
  const ORTHO = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  const DIAG = [
    { dx: 1, dy: 1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: 1 },
    { dx: -1, dy: -1 },
  ];
  // Cheapest cost reaching a cell at each diagonal parity — two maps rather
  // than an indexed pair, so no non-null assertions are needed.
  const bestEven = new Map<string, number>();
  const bestOdd = new Map<string, number>();
  const bestFor = (parity: 0 | 1): Map<string, number> =>
    parity === 0 ? bestEven : bestOdd;
  const reached = new Set<string>();
  const queue: Array<{ cell: PF1eCell; parity: 0 | 1; cost: number }> = [];

  // The four cells sharing the origin intersection are one step from it.
  const SEEDS = [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: -1, dy: -1 },
  ];
  for (const s of SEEDS) {
    const cell = { col: origin.col + s.dx, row: origin.row + s.dy };
    if (blocked(cell)) continue;
    bestEven.set(cellKey(cell), 1);
    reached.add(cellKey(cell));
    queue.push({ cell, parity: 0, cost: 1 });
  }

  while (queue.length > 0) {
    // Pop the cheapest frontier entry. Areas are small, so a linear scan keeps
    // this dependency-free and fully deterministic.
    let bi = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i];
      const b = queue[bi];
      if (a && b && a.cost < b.cost) bi = i;
    }
    const cur = queue[bi];
    queue.splice(bi, 1);
    if (!cur) continue;
    const known = bestFor(cur.parity).get(cellKey(cur.cell));
    if (known !== undefined && known < cur.cost) continue;

    const relax = (next: PF1eCell, stepCost: number, parity: 0 | 1): void => {
      const cost = cur.cost + stepCost;
      if (cost > budget) return;
      if (blocked(next)) return;
      const key = cellKey(next);
      if (reached.size >= maxCells && !reached.has(key)) return;
      const table = bestFor(parity);
      const prev = table.get(key);
      if (prev !== undefined && prev <= cost) return;
      table.set(key, cost);
      reached.add(key);
      queue.push({ cell: next, parity, cost });
    };

    for (const s of ORTHO) {
      relax(
        { col: cur.cell.col + s.dx, row: cur.cell.row + s.dy },
        1,
        cur.parity,
      );
    }
    for (const s of DIAG) {
      const nx = cur.cell.col + s.dx;
      const ny = cur.cell.row + s.dy;
      // "Do not trace diagonals across corners": a diagonal step needs at least
      // one of the two orthogonal neighbours to be open.
      const sideOpen =
        !blocked({ col: nx, row: cur.cell.row }) ||
        !blocked({ col: cur.cell.col, row: ny });
      if (!sideOpen) continue;
      relax(
        { col: nx, row: ny },
        cur.parity === 0 ? 1 : 2,
        cur.parity === 0 ? 1 : 0,
      );
    }
  }

  const out: PF1eCell[] = [];
  for (const key of reached) {
    const comma = key.indexOf(",");
    out.push({
      col: Number(key.slice(0, comma)),
      row: Number(key.slice(comma + 1)),
    });
  }
  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return out;
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

/**
 * Resolve an area spec to its cells. Garbage input yields named issues and the
 * best usable effort, never a silent empty area — the same contract
 * `resolvePF1eWeapon` uses.
 *
 * **Cylinder vs line of effect.** AoN 212 says two things that must be
 * reconciled: "A cylinder-shaped spell ignores any obstructions within its
 * area", and "A burst, cone, cylinder, or emanation spell affects only an area
 * … to which it has line of effect from its origin (… a cylinder's circle …)".
 * The reading encoded here: the caster still needs LoE to the point of origin
 * (the caller checks `hasLineOfEffectToOrigin`), but once the cylinder exists
 * it fills its whole circle, so per-cell LoE is not applied. That is what
 * "ignores any obstructions within its area" means, and it is why
 * `lineOfEffect` defaults to false for cylinders.
 *
 * **Spread** is likewise exempt: "You must designate the point of origin for
 * such an effect, but you need not have line of effect … to all portions of the
 * effect" — walls are honoured through `isBlocked`, not through LoE pruning.
 */
export function resolveAreaCells(
  spec: PF1eAreaSpec,
  grid: PF1eAreaGrid,
  options: PF1eAreaOptions = {},
): PF1eAreaResolution {
  const issues: PF1eAreaIssue[] = [];
  const maxCells = options.maxCells ?? 4096;
  const segments = options.segments ?? [];

  if (!Number.isFinite(grid.cellSize) || grid.cellSize <= 0) {
    issues.push({
      field: "grid.cellSize",
      message: "cell size must be a positive number",
    });
  }
  if (!Number.isFinite(grid.feetPerCell) || grid.feetPerCell <= 0) {
    issues.push({
      field: "grid.feetPerCell",
      message: "feet per cell must be a positive number",
    });
  }
  if (
    !Number.isInteger(spec.origin.col) ||
    !Number.isInteger(spec.origin.row)
  ) {
    issues.push({
      field: "origin",
      message:
        "the point of origin must be a grid intersection (whole cell coordinates)",
    });
  }
  if (issues.length > 0) return { cells: [], issues };

  if (
    typeof spec.radiusFt !== "number" ||
    !Number.isFinite(spec.radiusFt) ||
    spec.radiusFt <= 0
  ) {
    issues.push({
      field: "radiusFt",
      message: `${spec.kind} needs a positive radius in feet`,
    });
    return { cells: [], issues };
  }

  let cells: PF1eCell[];
  switch (spec.kind) {
    case "burst":
    case "emanation":
    case "cylinder":
      cells = radiusCells(spec.origin, spec.radiusFt, grid);
      break;
    case "spread":
      cells = spreadCells(
        spec.origin,
        spec.radiusFt,
        grid,
        options.isBlocked,
        maxCells,
      );
      break;
    default:
      issues.push({
        field: "kind",
        message: `unsupported area kind "${String(spec.kind)}" (cone and line are C01b)`,
      });
      return { cells: [], issues };
  }

  const wantsLoE =
    options.lineOfEffect ??
    (spec.kind === "burst" || spec.kind === "emanation");
  if (wantsLoE && segments.length > 0) {
    cells = applyLineOfEffectFromOrigin(
      cells,
      intersectionToWorld(spec.origin, grid),
      grid,
      segments,
    );
  }
  if (cells.length > maxCells) {
    issues.push({
      field: "area",
      message: `area capped at ${maxCells} cells (${cells.length} matched)`,
    });
    cells = cells.slice(0, maxCells);
  }
  return { cells, issues };
}

// ─── world ↔ cell conversion (scene layer glue) ──────────────────────────────

/** Cell containing a world point. */
export function worldToCell(
  grid: PF1eAreaGrid,
  x: number,
  y: number,
): PF1eCell {
  return {
    col: Math.floor(x / grid.cellSize),
    row: Math.floor(y / grid.cellSize),
  };
}

/** World point of a grid intersection. */
export function intersectionToWorld(
  origin: PF1eCell,
  grid: PF1eAreaGrid,
): { x: number; y: number } {
  return { x: origin.col * grid.cellSize, y: origin.row * grid.cellSize };
}

/** World rect of one cell (for the canvas preview overlay). */
export function cellRect(
  cell: PF1eCell,
  grid: PF1eAreaGrid,
): { x: number; y: number; size: number } {
  return {
    x: cell.col * grid.cellSize,
    y: cell.row * grid.cellSize,
    size: grid.cellSize,
  };
}

/** World rects for every cell — the draw list for a preview overlay. */
export function areaPreviewRects(
  cells: readonly PF1eCell[],
  grid: PF1eAreaGrid,
): Array<{ x: number; y: number; size: number }> {
  return cells.map((c) => cellRect(c, grid));
}

/**
 * Cells a token occupies. `token.x`/`token.y` is the token's **centre** and
 * `width`/`height` are world units, matching `src/canvas/tokens.ts`. A token
 * whose edge lands exactly on a grid line does not spill into the next cell.
 */
export function tokenCells(
  token: { x: number; y: number; width: number; height: number },
  grid: PF1eAreaGrid,
): PF1eCell[] {
  const halfW = Math.max(0, token.width) / 2;
  const halfH = Math.max(0, token.height) / 2;
  const eps = 1e-6;
  const minCol = Math.floor((token.x - halfW + eps) / grid.cellSize);
  const maxCol = Math.floor((token.x + halfW - eps) / grid.cellSize);
  const minRow = Math.floor((token.y - halfH + eps) / grid.cellSize);
  const maxRow = Math.floor((token.y + halfH - eps) / grid.cellSize);
  const out: PF1eCell[] = [];
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) out.push({ col, row });
  }
  return out;
}

/**
 * Tokens an area touches. A token counts when **any** cell it occupies is in
 * the area — AoN 212 measures the area in squares, and a creature is in the
 * area when its square is.
 */
export function affectedTokens<
  T extends { x: number; y: number; width: number; height: number },
>(cells: readonly PF1eCell[], tokens: readonly T[], grid: PF1eAreaGrid): T[] {
  const keys = cellKeySet(cells);
  return tokens.filter((t) =>
    tokenCells(t, grid).some((c) => keys.has(cellKey(c))),
  );
}

// ─── larger creatures (AoN 212, "Bursts and Emanations and Larger Creatures") ─

/**
 * Optional rule + Paizo FAQ: "when a creature casts an emanation or burst spell
 * with the text 'centered on you,' treat the creature's entire space as the
 * spell's point of origin, and measure the spell's area or effect from the edge
 * of the creature's space." Modelled as a radius bonus in feet: the effect
 * starts at the space's edge instead of at a corner, so a 2×2 (10-ft.) caster
 * gains `feetPerCell`.
 *
 * Returns 0 for a 1-cell space (measuring from its edge is the same as the
 * corner origin) and for non-square spaces, where the bonus is
 * direction-dependent and the caller must pick a corner instead.
 */
export function centeredOnYouRadiusBonusFt(
  token: { width: number; height: number },
  grid: PF1eAreaGrid,
): number {
  if (grid.cellSize <= 0) return 0;
  const cols = token.width / grid.cellSize;
  const rows = token.height / grid.cellSize;
  if (cols < 2 || rows < 2 || Math.abs(cols - rows) > 1e-9) return 0;
  return (cols / 2) * grid.feetPerCell;
}

/** Human-readable area label for UI (e.g. "20-ft. radius burst"). */
export function describeArea(
  spec: Pick<PF1eAreaSpec, "kind" | "radiusFt">,
): string {
  const text =
    typeof spec.radiusFt === "number" && Number.isFinite(spec.radiusFt)
      ? `${spec.radiusFt}-ft.`
      : "?-ft.";
  switch (spec.kind) {
    case "cylinder":
      return `${text} radius cylinder`;
    case "spread":
      return `${text} radius spread`;
    case "emanation":
      return `${text} radius emanation`;
    default:
      return `${text} radius burst`;
  }
}
