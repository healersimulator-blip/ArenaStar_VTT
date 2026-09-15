/**
 * M05 — the movement *legality and cost* rules a mass-battle march obeys, as a pure module.
 *
 * The strategic scale moves a formation by translating it along an ordered waypoint path
 * (D-173/D-175); what it did **not** do was price that walk against the rules the pace
 * carries. This module is that pricing, shared by both movement paths (stepwise and
 * simultaneous), so a formation cannot dodge the charge bar by playing in the other turn
 * mode. It deliberately mirrors — and cites — the same rules `movement.ts` (P03/D-198)
 * encodes for the tactical scale, because two scales inventing their own movement maths is
 * how the project ends up with a hero who cannot do what his unit can.
 *
 * Transcribed rules (R02 — CRB "Movement in Combat", as `movement.ts`'s Gap List A.7
 * rendering records them):
 *  • a **run** is ×4 speed **in a straight line** (CRB p.188) — a multi-waypoint run is
 *    refused, not quietly truncated to its first leg;
 *  • a **charge** is ×2 speed, also a straight line, over **at least 10 feet** (2 squares),
 *    and **cannot cross difficult terrain** (CRB p.188: "you can't charge … across difficult
 *    terrain") — refused, not slowed, because a charge is a declaration, not a distance;
 *  • **difficult terrain** doubles what a square costs to cross (CRB p.188), so the walk
 *    spends the extra feet per difficult square it enters and stops short when the budget is
 *    gone — a formation never enters more bad ground than it has already paid for;
 *  • **withdraw** (the `retreat` order) is ×2 speed with the start square exempt from
 *    attacks of opportunity — the exemption itself is the caller's AoO seam (D-184), not
 *    this module's, exactly as in the tactical layer.
 *
 * Like `movement.ts`, this is **not a pathfinder**: it prices the line the order draws.
 * Routing around a wall or an enemy is a different decision, made by whoever draws the path.
 *
 * With no difficult squares supplied and a single-leg march, the arithmetic reduces to the
 * plain Euclidean walk the strategic sim has always used, bit for bit — which is what lets
 * this land without rewriting the seeded-replay goldens.
 */
import { cellsAlongSegment } from "./geometry";

/** The paces a formation march is priced at, in feet-per-cell multiples (CRB p.188). */
export type PF1eStridePace = "march" | "run" | "charge" | "withdraw";

/** The SRD's per-pace speed factor: a walk is your speed, a charge or withdraw is double, a run is four times. */
export function stridePaceFactor(pace: PF1eStridePace): number {
  if (pace === "run") return 4;
  if (pace === "charge" || pace === "withdraw") return 2;
  return 1;
}

/** A charge must cover at least this much ground (CRB p.188: "You must … move at least 10 feet"). */
export const PF1E_CHARGE_MIN_FEET = 10;

export interface PF1eStrideInput {
  from: { x: number; y: number };
  /** The ordered waypoints, in world feet. A zero-length leg is walked through, not refused. */
  path: ReadonlyArray<{ x: number; y: number }>;
  pace: PF1eStridePace;
  /** The unit type's movement, in grid cells (scene metadata, per P01 — never a constant). */
  movePoints: number;
  /** One grid cell in feet, from the scene's `grid.distance` (D-177's scale-relative reading). */
  cellFeet: number;
  /** Cell keys (`col,row`) of difficult squares; absent or empty prices the walk as open ground. */
  difficult?: ReadonlySet<string> | undefined;
  /**
   * Fraction (0..1) along the given segment where a movement-blocking wall first crosses it,
   * or `null` for an open segment. Supplied by the caller because wall *storage* is a scene
   * concern; what a blocking wall does to a march is a movement rule, and both belong to
   * whoever walks the line (D-174's clipping, applied here so both turn modes share it).
   */
  blockAt?:
    | ((
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
      ) => number | null)
    | undefined;
  /** The epsilon a clipped march keeps short of the wall (see `MOVE_BLOCK_EPSILON`). */
  blockEpsilon?: number | undefined;
}

export interface PF1eStrideResult {
  /** Where the formation's anchor ends up. */
  to: { x: number; y: number };
  /** Feet actually covered (never the feet *paid*: a doubled square covers half as far). */
  traveled: number;
  /** Extra feet the difficult squares cost beyond the distance covered. */
  terrainExtra: number;
  /** How many difficult squares were entered on the way. */
  terrainSquares: number;
  /** The march stopped against a movement-blocking wall; later legs were not attempted. */
  hitWall: boolean;
  /**
   * A named refusal, when the *pace* itself is illegal here: the formation does not move at
   * all, and the report says why. Never a silent truncation.
   */
  refusal: string | null;
  /** The path's non-degenerate leg count — reported so a refusal can be checked by a test. */
  legs: number;
}

const OPEN: ReadonlySet<string> = new Set<string>();

const cellKeyOf = (col: number, row: number): string => `${col},${row}`;

/**
 * Walk one leg of the path.
 *
 * Open ground: the whole chord costs its Euclidean length, so the walk is exactly what the
 * strategic sim always did. Difficult ground: the leg is split at the squares it crosses and
 * each piece costs double inside a difficult square, so a formation with 10 feet of budget
 * gets 5 feet across a rough field and no further — the excess is *unspent distance*, not a
 * refund.
 */
function walkLeg(
  from: { x: number; y: number },
  to: { x: number; y: number },
  budget: number,
  cellFeet: number,
  difficult: ReadonlySet<string>,
  blockAt: PF1eStrideInput["blockAt"],
  blockEpsilon: number,
): {
  u: number;
  spent: number;
  blocked: boolean;
  terrainExtra: number;
  terrainSquares: number;
} {
  const full = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(full > 0) || !(budget > 0)) {
    return {
      u: 0,
      spent: 0,
      blocked: false,
      terrainExtra: 0,
      terrainSquares: 0,
    };
  }
  // A wall clips the leg first: the walk is priced over what is traversable at all.
  const block = blockAt ? blockAt(from.x, from.y, to.x, to.y) : null;
  const traversable =
    block === null ? full : Math.max(0, block * full - blockEpsilon);
  if (!(traversable > 0)) {
    return {
      u: 0,
      spent: 0,
      blocked: block !== null,
      terrainExtra: 0,
      terrainSquares: 0,
    };
  }

  if (difficult.size === 0) {
    const step = Math.min(budget, traversable);
    return {
      u: step / full,
      spent: step,
      blocked: block !== null && step >= traversable,
      terrainExtra: 0,
      terrainSquares: 0,
    };
  }

  // Which squares this leg crosses, and how many of them are rough. The square the walker
  // starts in is not "entered", so it is dropped — standing in bad ground costs nothing,
  // moving through it does (CRB p.188).
  const crossed = cellsAlongSegment(
    { x: from.x, y: from.y },
    { x: to.x, y: to.y },
    cellFeet,
  );
  const rough: number[] = [];
  for (let i = 1; i < crossed.length; i++) {
    const c = crossed[i];
    if (c && difficult.has(cellKeyOf(c.col, c.row))) rough.push(i);
  }
  if (rough.length === 0) {
    const step = Math.min(budget, traversable);
    return {
      u: step / full,
      spent: step,
      blocked: block !== null && step >= traversable,
      terrainExtra: 0,
      terrainSquares: 0,
    };
  }

  // The leg is paid for in equal chords through the squares it crosses; a rough chord costs
  // double. Walking the pieces in order is what makes "stops short when the budget is gone"
  // fall out of the arithmetic instead of needing a special case.
  const pieces = Math.max(crossed.length - 1, 1);
  const pieceLength = traversable / pieces;
  let spent = 0;
  let cost = 0;
  let terrainExtra = 0;
  let terrainSquares = 0;
  const roughSet = new Set(rough);
  for (let i = 0; i < pieces; i++) {
    const isRough = roughSet.has(i + 1);
    const pieceCost = pieceLength * (isRough ? 2 : 1);
    if (cost + pieceCost > budget) {
      // The budget dies inside this square: cover what is left of it, at this square's rate.
      const rate = isRough ? 2 : 1;
      const room = (budget - cost) / rate;
      if (room > 0) {
        spent += room;
        if (isRough) terrainExtra += room;
      }
      spent = Math.min(spent, traversable);
      return {
        u: traversable > 0 ? Math.min(1, spent / full) : 0,
        spent,
        blocked: false,
        terrainExtra,
        terrainSquares,
      };
    }
    cost += pieceCost;
    spent += pieceLength;
    if (isRough) {
      terrainExtra += pieceLength;
      terrainSquares += 1;
    }
  }
  const blocked = block !== null && spent >= traversable;
  return {
    u: traversable > 0 ? Math.min(1, spent / full) : 0,
    spent,
    blocked,
    terrainExtra,
    terrainSquares,
  };
}

/**
 * Price a whole march: the pace's legality first (a refused pace moves nobody), then the
 * legs, in order, until the budget is gone or a wall stops the formation.
 */
export function planPF1eStride(input: PF1eStrideInput): PF1eStrideResult {
  const {
    from,
    path,
    pace,
    movePoints,
    cellFeet,
    difficult = OPEN,
    blockAt,
    blockEpsilon = 1e-3,
  } = input;
  const legs = path.filter(
    (p) =>
      p !== undefined &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      (p.x !== from.x || p.y !== from.y),
  ).length;

  const refusal = ((): string | null => {
    if (movePoints <= 0)
      return `${pace}: this unit type has no movement to spend`;
    // CRB p.188: both a run and a charge are straight lines of movement.
    if ((pace === "run" || pace === "charge") && legs > 1) {
      return `${pace}: a ${pace} must be a straight line (CRB p.188) — the order names ${legs} destinations`;
    }
    return null;
  })();
  if (refusal !== null) {
    return {
      to: { x: from.x, y: from.y },
      traveled: 0,
      terrainExtra: 0,
      terrainSquares: 0,
      hitWall: false,
      refusal,
      legs,
    };
  }

  let remaining = movePoints * stridePaceFactor(pace) * cellFeet;
  let cx = from.x;
  let cy = from.y;
  let traveled = 0;
  let terrainExtra = 0;
  let terrainSquares = 0;
  let hitWall = false;

  for (const wp of path) {
    if (!wp || !Number.isFinite(wp.x) || !Number.isFinite(wp.y)) break;
    if (wp.x === cx && wp.y === cy) continue;
    const leg = walkLeg(
      { x: cx, y: cy },
      { x: wp.x, y: wp.y },
      remaining,
      cellFeet,
      difficult,
      blockAt,
      blockEpsilon,
    );
    if (leg.u > 0) {
      cx += (wp.x - cx) * leg.u;
      cy += (wp.y - cy) * leg.u;
      traveled += leg.spent;
      terrainExtra += leg.terrainExtra;
      terrainSquares += leg.terrainSquares;
    }
    remaining -= leg.spent + leg.terrainExtra;
    if (leg.blocked) {
      hitWall = true;
      break;
    }
    if (remaining <= 0 || leg.u < 1) break;
  }

  // A charge is a declaration with a floor, not a stroll: "you must … move at least 10 feet"
  // (CRB p.188). The check reads the ground the march actually covered, so a formation that
  // could not afford the charge's double speed does not get to call itself charging either.
  if (pace === "charge" && traveled < PF1E_CHARGE_MIN_FEET) {
    return {
      to: { x: from.x, y: from.y },
      traveled: 0,
      terrainExtra: 0,
      terrainSquares: 0,
      hitWall: false,
      refusal: `charge: the march covers ${Math.round(traveled)} ft, and a charge must cross at least ${PF1E_CHARGE_MIN_FEET} ft of open ground (CRB p.188)`,
      legs,
    };
  }
  // …and through no rough ground at all, however far it would have gone.
  if (pace === "charge" && terrainSquares > 0) {
    return {
      to: { x: from.x, y: from.y },
      traveled: 0,
      terrainExtra: 0,
      terrainSquares: 0,
      hitWall: false,
      refusal: `charge: a charge cannot cross difficult terrain (CRB p.188) — the line crosses ${terrainSquares} rough square(s)`,
      legs,
    };
  }

  return {
    to: { x: cx, y: cy },
    traveled,
    terrainExtra,
    terrainSquares,
    hitWall,
    refusal: null,
    legs,
  };
}
