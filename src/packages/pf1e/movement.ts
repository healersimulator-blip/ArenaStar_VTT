/**
 * P03/D-198 — movement legality and cost, the pure layer. Gap List A.7,
 * transcribed:
 *
 *   "1 square = 5 ft; **5-10-5** diagonals by default; difficult terrain = ×2
 *   per square (×4 double-doubled, ×8 triple-doubled); squeezing = 2 squares
 *   of movement per square entered, −4 to attack, −4 to AC; minimum-movement
 *   full-round action = 5 ft (provokes, is **not** a 5-foot step); you can
 *   never end movement in an illegal square; leaving a threatened square
 *   provokes. 5-foot step: allowed only if you (and your mount) have not
 *   moved at all this turn."
 *
 * Plus the mode half the same appendix names through the action table: a
 * **walk** is one move action at speed; a **run** is a full-round action at
 * ×4 speed in a straight line (CRB p.188); a **withdraw** is a full-round
 * action at ×2 speed whose first 5 ft never provokes (CRB p.188 — the
 * opportunity half is the AoO seam's `withdraw` flag, not this module's); a
 * **charge** is a full-round action at ×2 speed, at least 10 ft, through no
 * difficult terrain (CRB p.188); a **5-foot step** is not an action at all
 * and never provokes (CRB p.189).
 *
 * What this module deliberately is **not**: a pathfinder. It prices the
 * *straight* walk a drag describes (the same `cellsAlongSegment` line the AoO
 * seam walks) and names every rule that walk breaks. Routing around a wall or
 * an enemy is a different action — the caller drags somewhere else. The
 * squeeze *state* (−4 attack/−4 AC) is `tactical.ts`'s situational part; here
 * it is only a cost the caller declares, because a scene authors no corridor
 * widths to detect it from.
 */
import { cellsAlongSegment, FEET_PER_SQUARE } from "./geometry";
import type { PF1eCell } from "./targeting";
import {
  cellKey,
  pf1eAreaGridFromScene,
  tokenCells,
  type PF1eAreaGrid,
  type PF1eAreaIssue,
} from "./targeting";
import type { PF1eThreatToken } from "./threatPreview";
import type { PF1eWorldSegment } from "./positional";

/** The declared mode of a move; `walk` is the drag default. */
export type PF1eMoveMode =
  | "walk"
  | "run"
  | "withdraw"
  | "charge"
  | "five-foot-step";

export const MOVE_MODES: readonly PF1eMoveMode[] = [
  "walk",
  "run",
  "withdraw",
  "charge",
  "five-foot-step",
];

/** The mode's own speed multiplier (run ×4, withdraw/charge ×2, else ×1). */
export function moveModeSpeedFactor(mode: PF1eMoveMode): number {
  if (mode === "run") return 4;
  if (mode === "withdraw" || mode === "charge") return 2;
  return 1;
}

/** Strict segment crossing — both segments properly straddle each other. */
function segmentsCross(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  const d = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const p1 = d(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const p2 = d(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const p3 = d(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const p4 = d(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  return ((p1 > 0 && p2 < 0) || (p1 < 0 && p2 > 0)) && ((p3 > 0 && p4 < 0) || (p3 < 0 && p4 > 0));
}

export interface PF1eMovePlanResult {
  ok: boolean;
  /** Fatal, named problems (unreadable grid, a missing mover). */
  issues: readonly PF1eAreaIssue[];
  /** Non-fatal named assumptions (no walls supplied, no terrain authored, …). */
  defaults: readonly PF1eAreaIssue[];
  grid: PF1eAreaGrid | null;
  /** The straight walk in travel order, `cellKey` form. */
  path: readonly string[];
  /** What the walk costs, feet: 5-10-5 steps, terrain ×2, squeeze ×2. */
  costFt: number;
  /** What the mode allows, feet (speed × the mode factor). */
  budgetFt: number;
  /** The named rule the walk broke, or null when it is legal. */
  refusal: string | null;
  /** True when the only reason the walk fit is the minimum-movement rule. */
  minimumMovement: boolean;
  /** The destination footprint, `cellKey` form. */
  destination: readonly string[];
}

/** The named refusal every mode hands back when the walk outspends it. */
function overspendRefusal(mode: PF1eMoveMode, costFt: number, budgetFt: number): string {
  if (mode === "five-foot-step") {
    return `a 5-foot step moves 1 square — this walk costs ${String(costFt)} ft (CRB p.189)`;
  }
  const action =
    mode === "walk" ? "move action" : `full-round ${mode} action`;
  return `the walk costs ${String(costFt)} ft but a ${action} moves ${String(budgetFt)} ft`;
}

/**
 * Price and judge one straight walk. Pure: no dice, no store, no writes. The
 * caller supplies the scene facts (tokens as placed, move-blocking wall
 * segments, difficult cells) and the mover's own facts (speed, size, whether
 * it has already moved this turn); every fact the caller cannot state is a
 * **named default**, never a silent guess.
 */
export function pf1eMovePlan(input: {
  grid: { size: number; distance: number; units: string };
  tokens: readonly PF1eThreatToken[];
  mover: {
    tokenId: string;
    /** The dragged destination: the token's new centre, world units. */
    to: { x: number; y: number };
    mode?: PF1eMoveMode;
    /** Land speed in ft; absent names the 30-ft default. */
    speedFt?: number;
    /** The mover's size (footprint); absent is the threat seam's Medium default. */
    size?: string | null;
    /** Declared squeeze (the −4s live elsewhere; here only the cost doubles). */
    squeezing?: boolean;
    /** Any movement already spent this turn bars the 5-foot step (CRB p.189). */
    movedThisTurn?: boolean;
  };
  /** Move-blocking wall segments, world units; absent = no walls judged. */
  walls?: readonly PF1eWorldSegment[];
  /** Difficult-terrain cells; absent = no terrain authored (named default). */
  difficultCells?: readonly PF1eCell[];
  /** Ally test for pass-through: allies may be moved through, enemies may not. */
  isAlly?: (a: string, b: string) => boolean;
}): PF1eMovePlanResult {
  const mode = input.mover.mode ?? "walk";
  const defaults: PF1eAreaIssue[] = [];
  if (input.mover.mode === undefined) {
    defaults.push({
      field: "mode",
      message: "mode not declared — the walk was judged as a move action (walk)",
    });
  }
  if (input.mover.speedFt === undefined) {
    defaults.push({
      field: "speedFt",
      message:
        "speed not supplied — the walk was judged against the 30-ft default (A.7's 1 square = 5 ft)",
    });
  }
  if (input.walls === undefined) {
    defaults.push({
      field: "walls",
      message:
        "walls not supplied — the walk was judged without wall blocking (§9's move axis)",
    });
  }
  if (input.difficultCells === undefined) {
    defaults.push({
      field: "difficultCells",
      message:
        "difficult terrain not supplied — no square was priced at ×2 (A.7; the scene authors no terrain layer yet)",
    });
  }
  if (input.isAlly === undefined) {
    defaults.push({
      field: "isAlly",
      message:
        "alliance not supplied — no other creature's square may be passed through (CRB p.193's through-allies rule needs the caller's word)",
    });
  }
  const { grid: areaGrid, issues } = pf1eAreaGridFromScene(input.grid);
  const empty = (refusal: string | null): PF1eMovePlanResult => ({
    ok: false,
    issues,
    defaults,
    grid: null,
    path: [],
    costFt: 0,
    budgetFt: 0,
    refusal,
    minimumMovement: false,
    destination: [],
  });
  if (issues.length > 0) return empty("the scene grid cannot be read");

  const mover = input.tokens.find((t) => t._id === input.mover.tokenId);
  if (mover === undefined) {
    return empty(`no token "${input.mover.tokenId}" on this scene`);
  }

  const speedFt = input.mover.speedFt ?? 30;
  const budgetFt = speedFt * moveModeSpeedFactor(mode);

  // The straight walk between the two centres, the AoO seam's own line.
  const path = cellsAlongSegment(
    { x: mover.x, y: mover.y },
    { x: input.mover.to.x, y: input.mover.to.y },
    areaGrid.cellSize,
  );
  if (path.length === 0) {
    return empty("the walk could not be read — non-finite endpoints");
  }

  const difficult = new Set(
    (input.difficultCells ?? []).map((c) => cellKey(c)),
  );
  if (path[0] === undefined || path[path.length - 1] === undefined) {
    return empty("the walk carries no cells");
  }
  // The destination footprint is the mover's own, read at the destination —
  // `tokenCells`' centre-based convention, the same cells a committed drag
  // would occupy (and the same way the AoO seam reads the mover's end).
  const destination = tokenCells(
    { ...mover, x: input.mover.to.x, y: input.mover.to.y },
    areaGrid,
  );

  // 5-10-5 step pricing: every entered square costs its step (orthogonal 1,
  // diagonals alternating 1-2), ×2 for difficult terrain, ×2 for a declared
  // squeeze. Multipliers stack the A.7 way: double-doubled is ×4.
  let diagonalCount = 0;
  let squares = 0;
  const enteredDifficult: string[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1];
    const cell = path[i];
    if (prev === undefined || cell === undefined) continue;
    const diagonal = prev.col !== cell.col && prev.row !== cell.row;
    let step = 1;
    if (diagonal) {
      diagonalCount += 1;
      step = diagonalCount % 2 === 1 ? 1 : 2; // 5-10-5 (AoN 175)
    }
    let squareCost = step;
    if (difficult.has(cellKey(cell))) {
      squareCost *= 2;
      enteredDifficult.push(cellKey(cell));
    }
    if (input.mover.squeezing === true) squareCost *= 2;
    squares += squareCost;
  }
  const costFt = squares * areaGrid.feetPerCell;

  // ── the 5-foot step's own rules (CRB p.189) ──────────────────────────────
  if (mode === "five-foot-step") {
    if (input.mover.movedThisTurn === true) {
      return {
        ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
        refusal:
          "a 5-foot step is legal only when you have not moved at all this turn (CRB p.189)",
      };
    }
    // Terrain is named first: a 1-square step into difficult terrain is
    // barred by the terrain rule, not misreported as an overspend (its
    // doubled cost is how the terrain surfaces in the arithmetic).
    if (enteredDifficult.length > 0) {
      return {
        ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
        refusal:
          "you can't take a 5-foot step when difficult terrain slows your movement (CRB p.189)",
      };
    }
    if (costFt > FEET_PER_SQUARE) {
      return {
        ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
        refusal: overspendRefusal(mode, costFt, budgetFt),
      };
    }
  }

  // ── charge's own rules (CRB p.188) ───────────────────────────────────────
  if (mode === "charge") {
    const distanceFt = path.length > 1 ? costFt : 0;
    if (distanceFt < 2 * FEET_PER_SQUARE) {
      return {
        ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
        refusal:
          "a charge must move at least 10 ft (2 squares) toward the designated opponent (CRB p.188)",
      };
    }
    if (enteredDifficult.length > 0) {
      return {
        ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
        refusal:
          "you can't charge through difficult terrain (CRB p.188) — the straight walk crosses it",
      };
    }
  }

  // ── walls: a move-blocking wall crossing the straight walk refuses ───────
  // Routing around it is a different drag (pathfinding is out of scope, A.7).
  if (input.walls !== undefined && input.walls.length > 0) {
    const cellCentre = (c: PF1eCell): { x: number; y: number } => ({
      x: (c.col + 0.5) * areaGrid.cellSize,
      y: (c.row + 0.5) * areaGrid.cellSize,
    });
    for (let i = 1; i < path.length; i += 1) {
      const prev = path[i - 1];
      const cell = path[i];
      if (prev === undefined || cell === undefined) continue;
      const a = cellCentre(prev);
      const b = cellCentre(cell);
      if (input.walls.some((w) => segmentsCross(
        { x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        w,
      ))) {
        return {
          ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
          refusal:
            "the straight walk crosses a wall — route around it (a drag is a straight line; pathfinding is a different action)",
        };
      }
    }
  }

  // ── occupancy: pass-through and the ending square (CRB p.193) ────────────
  // The mover's own squares never block it. Allies may be passed through
  // (never ended in); enemies may not be passed through at all — the module's
  // named default blocks everyone until the caller states an alliance.
  const others = input.tokens.filter((t) => t._id !== mover._id);
  const occupiedBy = new Map<string, string>();
  for (const t of others) {
    for (const c of tokenCells(t, areaGrid)) occupiedBy.set(cellKey(c), t._id);
  }
  const pathKeys = path.map((c) => cellKey(c));
  // Intermediate cells only: the destination cell's occupier is the ending
  // rule's own fact (an ally at the destination is passable-through but not
  // endable-in; an enemy there is refused by the ending rule's own name).
  const blockedPass = pathKeys.slice(1, -1).find((k) => occupiedBy.has(k));
  if (blockedPass !== undefined) {
    const blocker = occupiedBy.get(blockedPass) ?? "another creature";
    const isAlly =
      input.isAlly !== undefined && input.isAlly(mover._id, blocker);
    if (!isAlly) {
      return {
        ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
        refusal: `the walk passes through ${blocker}'s square — you can only move through an ally's space (CRB p.193)`,
      };
    }
  }
  const endOverlap = destination.find((c) => occupiedBy.has(cellKey(c)));
  if (endOverlap !== undefined) {
    const blocker = occupiedBy.get(cellKey(endOverlap)) ?? "another creature";
    return {
      ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
      refusal: `you can never end movement in an occupied square — the destination overlaps ${blocker}'s space (A.7)`,
    };
  }

  // ── the budget ───────────────────────────────────────────────────────────
  if (costFt > budgetFt) {
    // A.7's minimum-movement rule: a full-round action still moves 5 ft when
    // a reduced speed would otherwise bar all movement — provoking, and never
    // a 5-foot step. It lifts the budget only for that first 5 ft.
    if (budgetFt < FEET_PER_SQUARE && costFt <= FEET_PER_SQUARE) {
      return {
        ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
        minimumMovement: true,
        refusal: null,
      };
    }
    return {
      ...okResult(areaGrid, path, costFt, budgetFt, destination, defaults),
      refusal: overspendRefusal(mode, costFt, budgetFt),
    };
  }

  return okResult(areaGrid, path, costFt, budgetFt, destination, defaults);
}

function okResult(
  areaGrid: PF1eAreaGrid,
  path: readonly PF1eCell[],
  costFt: number,
  budgetFt: number,
  destination: readonly PF1eCell[],
  defaults: readonly PF1eAreaIssue[],
): PF1eMovePlanResult {
  return {
    ok: true,
    issues: [],
    defaults,
    grid: areaGrid,
    path: path.map((c) => cellKey(c)),
    costFt,
    budgetFt,
    refusal: null,
    minimumMovement: false,
    destination: destination.map((c) => cellKey(c)),
  };
}

/**
 * The move-blocking twin of `wallSight`'s `sightSegments` — walls a walker
 * may not cross on the §9 move axis (0 blocks, 1 conditional on the door,
 * 2 permits). Duplicated here, structurally, so the package stays free of
 * canvas imports; the semantics are D-009's own.
 */
export function moveBlocked(wall: {
  move: 0 | 1 | 2;
  door: 0 | 1 | 2;
}): boolean {
  if (wall.move === 2) return false;
  if (wall.move === 0) return true;
  return wall.door !== 1;
}
