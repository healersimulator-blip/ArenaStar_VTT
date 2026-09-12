/**
 * P02 — space, natural reach and threatened-square geometry.
 *
 * Pure math on grid squares. Cell `(col, row)` is the square
 * `[col, col+1) × [row, row+1)` in cell space — the convention `targeting.ts`
 * already pins — and nothing here touches Pixi, scenes or documents. The caller
 * supplies positions; the strategic layer converts squares to its own
 * feet-per-cell scale (P01/D-177), because reach in *squares* is the rule's
 * figure while feet-per-square is the scene's.
 *
 * Rule sources (R02, transcribed 2026-09-12 from Archives of Nethys; the
 * space/reach numbers themselves live in `rulesTables.ts` A.5 and are read from
 * there, never duplicated here):
 *
 * **AoN Rules ID 179 — "Big and Little Creatures in Combat", CRB p.194** (with
 * Table 8-4: Creature Size and Scale):
 *   "Very small creatures take up less than 1 square of space. This means that
 *    more than one such creature can fit into a single square. A Tiny creature
 *    typically occupies a space only 2-1/2 feet across, so four can fit into a
 *    single square. 25 Diminutive creatures or 100 Fine creatures can fit into
 *    a single square."
 *   "Creatures that take up less than 1 square of space typically have a
 *    natural reach of 0 feet, meaning they can't reach into adjacent squares.
 *    They must enter an opponent's square to attack in melee. This provokes an
 *    attack of opportunity from the opponent. You can attack into your own
 *    square if you need to, so you can attack such creatures normally. Since
 *    they have no natural reach, they do not threaten the squares around them.
 *    You can move past them without provoking attacks of opportunity. They also
 *    can't flank an enemy."
 *   "Very large creatures take up more than 1 square. Creatures that take up
 *    more than 1 square typically have a natural reach of 10 feet or more,
 *    meaning that they can reach targets even if they aren't in adjacent
 *    squares. Unlike when someone uses a reach weapon, a creature with greater
 *    than normal natural reach (more than 5 feet) still threatens squares
 *    adjacent to it."
 *   "Large or larger creatures using reach weapons can strike up to double
 *    their natural reach but can't strike at their natural reach or less."
 *   Table 8-4 prints **two** natural-reach columns for the four multi-square
 *   sizes — "Large (tall) · 10 ft. · 10 ft." beside "Large (long) · 10 ft. ·
 *    5 ft.", Huge 15/15 beside 15/10, Gargantuan 20/20 beside 20/15, Colossal
 *   30/30 beside 30/20 — under the footnote "These values are typical for
 *   creatures of the indicated size. Some exceptions exist." Fine through
 *   Medium get one figure each, so body shape is only ever a question for
 *   Large and larger; a shape authored for a smaller size names no second
 *   number and is ignored rather than invented.
 *
 * **AoN Rules ID 102 — "Attacks of Opportunity", CRB p.180**:
 *   "Threatened Squares: You threaten all squares into which you can make a
 *    melee attack, even when it is not your turn. Generally, that means
 *    everything in all squares adjacent to your space (including diagonally).
 *    An enemy that takes certain actions while in a threatened square provokes
 *    an attack of opportunity from you. If you're unarmed, you don't normally
 *    threaten any squares and thus can't make attacks of opportunity."
 *   "Reach Weapons: Most creatures of Medium or smaller size have a reach of
 *    only 5 feet. This means that they can make melee attacks only against
 *    creatures up to 5 feet (1 square) away. However, Small and Medium
 *    creatures wielding reach weapons threaten more squares than a typical
 *    creature."
 *
 * **AoN Rules ID 131 — "Attack", CRB p.182** (the Small/Medium half of the
 * reach-weapon band; ID 179 above states the Large+ half, and both are the same
 * band — beyond natural reach, up to double it):
 *   "With a normal melee weapon, you can strike any opponent within 5 feet.
 *    (Opponents within 5 feet are considered adjacent to you.) Some melee
 *    weapons have reach, as indicated in their descriptions. With a typical
 *    reach weapon, you can strike opponents 10 feet away, but you can't strike
 *    adjacent foes (those within 5 feet)."
 *
 * **AoN Rules ID 175 — "Measuring Distance", CRB p.192** (the diagonal rule
 * P02 names):
 *   "As a general rule, distance is measured assuming that 1 square equals 5
 *    feet."
 *   "Diagonals: When measuring distance, the first diagonal counts as 1 square,
 *    the second counts as 2 squares, the third counts as 1, the fourth as 2,
 *    and so on."
 *
 * **AoN Rules ID 176 — "Moving Through a Square", CRB p.193** (occupancy facts
 * only — the movement legality around them is P03's):
 *   "Very Small Creature: A Fine, Diminutive, or Tiny creature can move into or
 *    through an occupied square. The creature provokes attacks of opportunity
 *    when doing so."
 *   "Ending Your Movement: You can't end your movement in the same square as
 *    another creature unless it is helpless."
 *
 * **Not encoded here, on purpose:**
 *   • Threatened-square **highlighting** — the canvas draw list and overlay
 *     follow this pure layer, exactly as D-154's `areaPreview.ts` followed
 *     D-148's `targeting.ts`.
 *   • **Flanking** (opposite borders, threatening ally) — P04 consumes
 *     `threatenedCells` + `footprintCells`; the angle rule is its own slice.
 *   • **Attacks of opportunity** — P06's interrupt queue consumes the same two;
 *     a threat set is not an interrupt.
 *   • **Unarmed** creatures threatening nothing (AoN 102) — that is a fact
 *     about what the creature is wielding, so the caller expresses it the only
 *     way the rule does: reach 0 threatens no squares.
 *   • Squeezing, corners and movement cost — P03.
 */
import { cellDistance, type DiagonalRule } from "../../canvas/grid/measure";
import { sizeEntry } from "./rulesTables";
import type { PF1eCell } from "./targeting";

/**
 * AoN 175: "As a general rule, distance is measured assuming that 1 square
 * equals 5 feet." This is the rule's own unit — Table 8-4's Medium space is
 * "5 ft." and its reach "5 ft.", one square each — **not** a scene constant:
 * P01's scene-derived figure is the feet-per-cell *scale*, which the strategic
 * layer multiplies by a reach measured in squares.
 */
export const FEET_PER_SQUARE = 5;

/**
 * The diagonal counting reach and threat are measured with, pinned to 5-10-5
 * because AoN 175 states it as a rule of measuring distance ("the first
 * diagonal counts as 1 square, the second counts as 2 squares … and so on") —
 * the same counting `targeting.ts` pins for spell areas from AoN 212.
 *
 * Deliberately **not** the scene's `SceneGrid.diagonals`: that setting
 * configures the VTT ruler, and this repository's default scene ships `"555"`.
 * Letting it drive threat would silently change which squares a creature
 * threatens whenever a GM retunes their ruler. The scene owns the scale, the
 * rules own the counting.
 */
export const PF1E_DISTANCE_DIAGONALS: DiagonalRule = "5105";

/** Table 8-4's two body-form columns (AoN 179): "Large (tall)" and "Large (long)". */
export const PF1E_REACH_SHAPES = ["tall", "long"] as const;
export type PF1eReachShape = (typeof PF1E_REACH_SHAPES)[number];

/**
 * Canonical spelling of an authored body form, or null when the value names
 * neither of Table 8-4's columns. A null never becomes a guessed shape: the
 * caller keeps the table's single printed figure.
 */
export function normalizeReachShape(value: unknown): PF1eReachShape | null {
  if (typeof value !== "string") return null;
  const needle = value.trim().toLowerCase();
  return PF1E_REACH_SHAPES.find((s) => s === needle) ?? null;
}

/**
 * Natural reach in **squares** (Table 8-4, AoN 179). `shape` selects the long
 * column where the table prints one — Large 1, Huge 2, Gargantuan 3, Colossal
 * 4 — and is ignored for Fine through Medium, whose single figure (0, 5 ft,
 * 5 ft) the table prints for both body forms. A missing or unrecognized size
 * is Medium, per `sizeEntry`'s contract: an absent field must never invent a
 * reach.
 *
 * 0 means no natural reach at all: "Creatures that take up less than 1 square
 * of space typically have a natural reach of 0 feet, meaning they can't reach
 * into adjacent squares."
 */
export function naturalReachSquares(
  size: string | undefined | null,
  shape?: PF1eReachShape | null,
): number {
  const entry = sizeEntry(size);
  if (shape === "long" && entry.longReachSquares !== null) {
    return entry.longReachSquares;
  }
  return entry.reachSquares;
}

/**
 * The same reach in **feet** — the unit AoN 131/179 speak in ("a reach of only
 * 5 feet", "a natural reach of 10 feet or more") and the unit
 * `meleeReachLegality`'s `naturalReachFt` / `distanceFt` contract expects.
 */
export function naturalReachFt(
  size: string | undefined | null,
  shape?: PF1eReachShape | null,
): number {
  return naturalReachSquares(size, shape) * FEET_PER_SQUARE;
}

/**
 * Squares on a side this size occupies: 1 for Fine through Medium, then 2, 3,
 * 4 and 5 — Table 8-4's space column (10, 15, 20 and 30 ft across) divided by
 * its own 5-ft square.
 *
 * Fine, Diminutive and Tiny are printed as taking up *less* than one square
 * (½, 1 and 2½ ft across). On a grid they still occupy the one square they are
 * in — a model has to be somewhere — and `occupancy()` reports how many of them
 * share it. A footprint of zero squares would be a creature no attack, area or
 * threat test could ever locate, which the rules do not describe.
 */
export function footprintSide(size: string | undefined | null): number {
  const entry = sizeEntry(size);
  if (entry.spaceSquares <= 1) return 1;
  const side = Math.round(Math.sqrt(entry.spaceSquares));
  // The table only ever prints perfect squares (4, 9, 16, 25). Anything else
  // would mean data this module cannot lay out, so it falls back to one square
  // rather than inventing a rectangular footprint.
  return side * side === entry.spaceSquares ? side : 1;
}

/**
 * The squares a creature of this size occupies, anchored at `origin` as the
 * footprint's lowest `(col, row)` corner — the same corner `cellRect` and
 * `worldToCell` treat as a cell's origin.
 *
 * For a token already on the canvas, `targeting.ts`'s `tokenCells` derives the
 * same set from its world rect; this is the size-driven form, for a creature
 * whose position is a square rather than a drawn rectangle.
 */
export function footprintCells(
  origin: PF1eCell,
  size: string | undefined | null,
): PF1eCell[] {
  const side = footprintSide(size);
  const out: PF1eCell[] = [];
  for (let row = origin.row; row < origin.row + side; row++) {
    for (let col = origin.col; col < origin.col + side; col++)
      out.push({ col, row });
  }
  return out;
}

/**
 * Distance between two squares in squares, counted AoN 175's way: the first
 * diagonal is 1 square, the second 2, the third 1, the fourth 2. Adjacent
 * squares — orthogonally *or* diagonally — are therefore 1 square apart, which
 * is what makes AoN 102's "all squares adjacent to your space (including
 * diagonally)" come out as the eight surrounding squares.
 */
export function squareDistance(a: PF1eCell, b: PF1eCell): number {
  return cellDistance(PF1E_DISTANCE_DIAGONALS, b.col - a.col, b.row - a.row);
}

/** The same distance in feet (AoN 175: "1 square equals 5 feet"). */
export function squareDistanceFt(a: PF1eCell, b: PF1eCell): number {
  return squareDistance(a, b) * FEET_PER_SQUARE;
}

/**
 * Nearest-square distance between two footprints, in squares: a Large creature
 * reaches from any square it occupies, so the distance to a target is the
 * shortest distance between any square of one space and any square of the
 * other.
 *
 * **0 when the two spaces share a square** — a Fine, Diminutive or Tiny
 * creature "must enter an opponent's square to attack in melee" (AoN 179), and
 * that strike is at distance 0, which `meleeReachLegality` resolves as inside
 * natural reach (and `occupancy` reports as provoking).
 *
 * An empty footprint has no square to measure from, so the distance is
 * `+Infinity`: nothing to reach, and `meleeReachLegality` refuses a
 * non-finite distance by name instead of guessing one.
 */
export function footprintDistance(
  from: readonly PF1eCell[],
  to: readonly PF1eCell[],
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const a of from) {
    for (const b of to) {
      const d = squareDistance(a, b);
      if (d < best) best = d;
    }
  }
  return best;
}

/** The same footprint distance in feet. */
export function footprintDistanceFt(
  from: readonly PF1eCell[],
  to: readonly PF1eCell[],
): number {
  const squares = footprintDistance(from, to);
  return Number.isFinite(squares) ? squares * FEET_PER_SQUARE : squares;
}

/** A reach weapon's legal distance band, in both units. */
export interface PF1eReachBand {
  /** Natural reach — exclusive: "can't strike at their natural reach or less" (AoN 179). */
  minSquares: number;
  /** Double natural reach — inclusive: "can strike up to double their natural reach". */
  maxSquares: number;
  minFt: number;
  maxFt: number;
}

/**
 * The band a reach weapon strikes in: **beyond** natural reach, up to **double**
 * it. AoN 179 states it for Large and larger ("Large or larger creatures using
 * reach weapons can strike up to double their natural reach but can't strike at
 * their natural reach or less") and AoN 131 for Small and Medium ("With a
 * typical reach weapon, you can strike opponents 10 feet away, but you can't
 * strike adjacent foes (those within 5 feet)") — one band, `(natural, 2 ×
 * natural]`, which is the adjacent dead zone `meleeReachLegality` refuses by
 * name.
 *
 * Null when natural reach is 0: there is no band to double, and no invented
 * rule fills it — a Tiny-or-smaller creature "must enter an opponent's square
 * to attack in melee" (AoN 179), which a reach weapon does not do.
 */
export function reachWeaponBand(
  size: string | undefined | null,
  shape?: PF1eReachShape | null,
): PF1eReachBand | null {
  const minSquares = naturalReachSquares(size, shape);
  if (minSquares <= 0) return null;
  const maxSquares = 2 * minSquares;
  return {
    minSquares,
    maxSquares,
    minFt: minSquares * FEET_PER_SQUARE,
    maxFt: maxSquares * FEET_PER_SQUARE,
  };
}

/**
 * The squares a creature threatens (AoN 102): "You threaten all squares into
 * which you can make a melee attack, even when it is not your turn. Generally,
 * that means everything in all squares adjacent to your space (including
 * diagonally)."
 *
 * Distance is measured from the nearest square of the footprint, so a Large
 * (tall) creature threatens two squares out from its whole 2×2 space — and,
 * per AoN 179, "a creature with greater than normal natural reach (more than 5
 * feet) still threatens squares adjacent to it", which the `d > 0` test keeps.
 *
 * `reachWeapon: true` replaces the filled disc with the band `(natural, 2 ×
 * natural]` — the reach weapon's dead zone. This is where AoN 179's "Unlike
 * when someone uses a reach weapon" bites: the Large creature's own adjacent
 * squares are threatened by its natural reach but **not** by the polearm.
 *
 * The creature's own squares are never in the result: its space is not a square
 * adjacent to its space. Striking into your own square — "You can attack into
 * your own square if you need to, so you can attack such creatures normally"
 * (AoN 179), i.e. at a Tiny creature sharing it — is strike legality at
 * distance 0, which `meleeReachLegality` resolves, not a threatened square.
 *
 * Reach 0 threatens nothing: "Since they have no natural reach, they do not
 * threaten the squares around them. You can move past them without provoking
 * attacks of opportunity" (AoN 179). Output is ordered row-then-column so a
 * caller's draw list and test fixtures are stable.
 */
export function threatenedCells(input: {
  footprint: readonly PF1eCell[];
  reachSquares: number;
  reachWeapon?: boolean;
}): PF1eCell[] {
  const reach = Number.isFinite(input.reachSquares) ? input.reachSquares : 0;
  if (input.footprint.length === 0 || reach <= 0) return [];
  const min = input.reachWeapon === true ? reach : 0;
  const max = input.reachWeapon === true ? 2 * reach : reach;

  let minCol = Number.POSITIVE_INFINITY;
  let minRow = Number.POSITIVE_INFINITY;
  let maxCol = Number.NEGATIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  for (const c of input.footprint) {
    if (c.col < minCol) minCol = c.col;
    if (c.row < minRow) minRow = c.row;
    if (c.col > maxCol) maxCol = c.col;
    if (c.row > maxRow) maxRow = c.row;
  }

  const out: PF1eCell[] = [];
  for (let row = minRow - max; row <= maxRow + max; row++) {
    for (let col = minCol - max; col <= maxCol + max; col++) {
      const cell = { col, row };
      const d = footprintDistance(input.footprint, [cell]);
      if (d > min && d <= max) out.push(cell);
    }
  }
  return out;
}

/** Table 8-4's occupancy facts for a size (AoN 179 and 176). */
export interface PF1eOccupancy {
  /** How many fit in one 5-ft square: Tiny 4, Diminutive 25, Fine 100, everyone else 1. */
  perSquare: number;
  /** "Very small creatures take up less than 1 square of space." */
  takesLessThanOneSquare: boolean;
  /** "A Fine, Diminutive, or Tiny creature can move into or through an occupied square" (AoN 176). */
  canEnterOccupiedSquare: boolean;
  /** "They must enter an opponent's square to attack in melee" (AoN 179). */
  mustEnterOpponentSquareToAttack: boolean;
  /** "This provokes an attack of opportunity from the opponent" (AoN 179; AoN 176 agrees). */
  enteringProvokes: boolean;
  /** "Since they have no natural reach, they do not threaten the squares around them." */
  threatensNothing: boolean;
  /** "They also can't flank an enemy" — the flag P04's flanking reads. */
  cannotFlank: boolean;
}

/**
 * The occupancy facts Table 8-4's sub-square sizes carry, read from A.5 rather
 * than restated. Every one of them follows from the two figures the table
 * prints — space under one square, natural reach 0 — so nothing here is a
 * judgement call: a size either takes up less than a square or it does not.
 */
export function occupancy(size: string | undefined | null): PF1eOccupancy {
  const entry = sizeEntry(size);
  const subSquare = entry.spaceSquares === 0;
  const noReach = entry.reachSquares === 0;
  return {
    perSquare: entry.perSquare,
    takesLessThanOneSquare: subSquare,
    canEnterOccupiedSquare: subSquare,
    mustEnterOpponentSquareToAttack: noReach,
    enteringProvokes: noReach,
    threatensNothing: noReach,
    cannotFlank: entry.cannotFlank,
  };
}
