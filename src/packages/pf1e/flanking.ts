/**
 * Flanking (R02 — AoN ID 183, CRB p.197). Pure; no canvas, no store, no dice.
 *
 *   "When making a melee attack, you get a +2 flanking bonus if your opponent is
 *    threatened by another enemy character or creature on its opposite border or
 *    opposite corner. When in doubt about whether two characters flank an
 *    opponent in the middle, trace an imaginary line between the two attackers'
 *    centers. If the line passes through opposite borders of the opponent's
 *    space (including corners of those borders), then the opponent is flanked.
 *    Exception: If a flanker takes up more than 1 square, it gets the flanking
 *    bonus if any square it occupies counts for flanking. Only a creature or
 *    character that threatens the defender can help an attacker get a flanking
 *    bonus. Creatures with a reach of 0 feet can't flank an opponent."
 *
 * Every clause is encoded:
 *
 * - **+2 on the attack roll** — `PF1E_FLANKING_BONUS`. It is *not* an AC
 *   adjustment (Gap List §2.2): this module decides the fact, while
 *   `tactical.ts`'s `situational.flanking` part and `resolvePF1eAttacks`'
 *   `isFlanked` keep applying it to the roll.
 * - **the line test** — `segmentFlanks`. Both endpoints are cell *centers* and
 *   the defender's space is the bounding box of its occupied cells, so
 *   "opposite borders" is left+right or top+bottom of that box. Crossings are
 *   decided exactly in doubled cell coordinates (integers, rational comparison,
 *   no tolerance), and corner contact counts for both borders meeting there —
 *   the parenthetical.
 * - **the multi-square exception** — `footprintsFlank` tries every cell of each
 *   flanker's footprint and succeeds if *any* pair counts.
 * - **threatening ally** — a helper counts only when the defender's space meets
 *   its threatened cells (P02's `threatenedCells`), so reach per size, per shape
 *   and the reach-weapon band all decide it.
 * - **0-foot reach can't flank** — `canFlank` refuses on reach 0 *and* on Table
 *   8-4's sub-square sizes (`occupancy().cannotFlank`), the two ways the rule
 *   states the same exclusion.
 *
 * A segment running ALONG a border crosses nothing and does not flank. That
 * happens when a flanker shares the defender's cell — possible at the strategic
 * scale, where models are points and `deploy.ts`'s default spacing (4 ft) is
 * under one cell, so several models can occupy a 5-ft square. The rule names no
 * such case; calling collinearity a flank would be an invented fill. This is why
 * the strategic `envelopment.ts` FLANKED bit is **not** switched over to this
 * test: its spacing has to ride the scene grid first (P01's named remainder),
 * or the line test would decide flanking from a layout the rules never describe.
 */
import { occupancy, threatenedCells } from "./geometry";
import type { PF1eCell } from "./targeting";

/** AoN 183: "+2 flanking bonus" — added to the attack roll, never to AC. */
export const PF1E_FLANKING_BONUS = 2;

/** The defender: the space whose opposite borders the line must cross. */
export interface PF1eFlankingSpace {
  /** Stable identity for the report (a token id, a unit index, …). */
  id: string;
  /** Squares the creature occupies — `tokenCells` or `footprintCells` output. */
  cells: readonly PF1eCell[];
}

/** A creature that might attack, or help an attacker flank. */
export interface PF1eFlankingParticipant extends PF1eFlankingSpace {
  /**
   * Threat range in squares: `naturalReachSquares(size, shape)` for a natural
   * attack, or an authored figure. 0 threatens nothing (AoN 102/179).
   */
  reachSquares: number;
  /** Threaten the reach weapon's band instead of the filled disc (AoN 179). */
  reachWeapon?: boolean;
  /** Authored size, for Table 8-4's "can't flank" sub-square sizes. */
  size?: string | null;
  /**
   * Threatened squares the caller has already computed. A scene-wide model
   * resolves each creature's threat set once instead of once per attacker/ally
   * pair; the set is `threatenedCells`' either way, so this is bookkeeping and
   * not a second rule.
   */
  threatened?: readonly PF1eCell[];
}

export interface PF1eFlankingResult {
  /** True when the attacker earns the +2 (AoN 183). */
  flanked: boolean;
  /** `PF1E_FLANKING_BONUS` when flanked, else 0 — the number callers add. */
  bonus: number;
  /**
   * Allies that threaten the defender and sit on an opposite border/corner of
   * its space relative to the attacker. Empty whenever `flanked` is false.
   */
  flankerIds: string[];
  /** True when the attacker cannot flank at all: 0-foot reach (AoN 183/179). */
  attackerCannotFlank: boolean;
  /** True when the attacker does not threaten the defender's space. */
  attackerDoesNotThreaten: boolean;
  /** True when a participant's cells were missing — nothing was guessed. */
  missingSpace: boolean;
}

interface Segment {
  px: number;
  py: number;
  qx: number;
  qy: number;
}

/** A space's borders in doubled cell coordinates (cell `c` spans `[2c, 2c+2]`). */
interface DoubledRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * The rectangle a set of occupied cells covers, in doubled cell coordinates, or
 * null when there are no cells to bound. Doubling keeps every cell center an odd
 * integer and every border an even one, so a center can never lie *on* a border
 * and all crossing arithmetic stays in integers.
 */
export function spaceRect(cells: readonly PF1eCell[]): DoubledRect | null {
  if (cells.length === 0) return null;
  let minCol = Number.POSITIVE_INFINITY;
  let minRow = Number.POSITIVE_INFINITY;
  let maxCol = Number.NEGATIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  for (const c of cells) {
    if (c.col < minCol) minCol = c.col;
    if (c.row < minRow) minRow = c.row;
    if (c.col > maxCol) maxCol = c.col;
    if (c.row > maxRow) maxRow = c.row;
  }
  return {
    x0: minCol * 2,
    x1: (maxCol + 1) * 2,
    y0: minRow * 2,
    y1: (maxRow + 1) * 2,
  };
}

function center(cell: PF1eCell): { x: number; y: number } {
  return { x: cell.col * 2 + 1, y: cell.row * 2 + 1 };
}

/**
 * Does the segment meet the border line `at` — spanning `[lo, hi]` on the other
 * axis — strictly between its endpoints? Exact: the crossing ordinate is
 * compared as a rational (`num/den`), so no floating-point tolerance is
 * involved, and contact exactly at a corner counts for both borders meeting
 * there (AoN 183's parenthetical). A segment parallel to the border, including
 * one running along it, crosses nothing.
 */
function crossesBorder(
  seg: Segment,
  axis: "x" | "y",
  at: number,
  lo: number,
  hi: number,
): boolean {
  const p = axis === "x" ? seg.px : seg.py;
  const q = axis === "x" ? seg.qx : seg.qy;
  const pOther = axis === "x" ? seg.py : seg.px;
  const qOther = axis === "x" ? seg.qy : seg.qx;
  if (p === q) return false;
  if (at <= Math.min(p, q) || at >= Math.max(p, q)) return false;
  const den = q - p;
  const num = pOther * den + (at - p) * (qOther - pOther);
  return den > 0
    ? num >= lo * den && num <= hi * den
    : num <= lo * den && num >= hi * den;
}

/**
 * AoN 183's line test for one pair of flanker squares: "trace an imaginary line
 * between the two attackers' centers. If the line passes through opposite
 * borders of the opponent's space (including corners of those borders), then the
 * opponent is flanked." Opposite means left+right or top+bottom of the space.
 */
export function segmentFlanks(
  defender: readonly PF1eCell[],
  from: PF1eCell,
  to: PF1eCell,
): boolean {
  const rect = spaceRect(defender);
  if (!rect) return false;
  const a = center(from);
  const b = center(to);
  const seg: Segment = { px: a.x, py: a.y, qx: b.x, qy: b.y };
  const verticals =
    crossesBorder(seg, "x", rect.x0, rect.y0, rect.y1) &&
    crossesBorder(seg, "x", rect.x1, rect.y0, rect.y1);
  const horizontals =
    crossesBorder(seg, "y", rect.y0, rect.x0, rect.x1) &&
    crossesBorder(seg, "y", rect.y1, rect.x0, rect.x1);
  return verticals || horizontals;
}

/**
 * The multi-square exception: "If a flanker takes up more than 1 square, it gets
 * the flanking bonus if any square it occupies counts for flanking." So every
 * occupied square of each flanker is tried against every occupied square of the
 * other, and one qualifying pair is enough.
 */
export function footprintsFlank(
  defender: readonly PF1eCell[],
  flankerA: readonly PF1eCell[],
  flankerB: readonly PF1eCell[],
): boolean {
  for (const a of flankerA) {
    for (const b of flankerB) {
      if (segmentFlanks(defender, a, b)) return true;
    }
  }
  return false;
}

/**
 * Can this creature be a flanker at all? "Creatures with a reach of 0 feet can't
 * flank an opponent" (AoN 183), and Table 8-4's Fine/Diminutive/Tiny row says
 * the same from the size side — `occupancy().cannotFlank`. Both are checked
 * because an authored reach of 0 (unarmed, AoN 102) is not a size.
 */
export function canFlank(p: {
  reachSquares: number;
  reachWeapon?: boolean;
  size?: string | null;
}): boolean {
  if (!(p.reachSquares > 0)) return false;
  return !occupancy(p.size).cannotFlank;
}

/**
 * Does `helper` threaten the defender's space? "Only a creature or character
 * that threatens the defender can help an attacker get a flanking bonus" — any
 * occupied square of the defender inside the helper's threat range counts, so a
 * Large defender is threatened from any of its four squares.
 */
export function threatensSpace(
  helper: {
    cells: readonly PF1eCell[];
    reachSquares: number;
    reachWeapon?: boolean;
    threatened?: readonly PF1eCell[];
  },
  defender: readonly PF1eCell[],
): boolean {
  if (helper.cells.length === 0 || defender.length === 0) return false;
  const threatened =
    helper.threatened ??
    threatenedCells({
      footprint: helper.cells,
      reachSquares: helper.reachSquares,
      reachWeapon: helper.reachWeapon === true,
    });
  if (threatened.length === 0) return false;
  const keys = new Set(threatened.map((c) => `${c.col},${c.row}`));
  return defender.some((c) => keys.has(`${c.col},${c.row}`));
}

/**
 * Decide one melee attack's flanking bonus (AoN 183). The attacker must be able
 * to flank and must threaten the defender; each ally must threaten the defender
 * too, and at least one must sit on an opposite border/corner relative to a
 * square the attacker occupies. Nothing is guessed: absent cells are reported,
 * not defaulted.
 */
export function resolveFlanking(opts: {
  defender: PF1eFlankingSpace;
  attacker: PF1eFlankingParticipant;
  allies?: readonly PF1eFlankingParticipant[];
}): PF1eFlankingResult {
  const { defender, attacker } = opts;
  const allies = opts.allies ?? [];
  const missingSpace =
    defender.cells.length === 0 ||
    attacker.cells.length === 0 ||
    allies.some((a) => a.cells.length === 0);
  const attackerCannotFlank = !canFlank(attacker);
  const attackerDoesNotThreaten = !threatensSpace(attacker, defender.cells);
  const flankerIds: string[] = [];
  if (!missingSpace && !attackerCannotFlank && !attackerDoesNotThreaten) {
    for (const ally of allies) {
      // Defensive: two squares of one footprint can only bracket a space that
      // footprint itself covers, and P02 never counts a creature's own squares
      // as threatened — so the identity check is a belt, not the rule.
      if (ally.id === attacker.id) continue;
      if (ally.cells.length === 0) continue;
      if (!canFlank(ally)) continue;
      if (!threatensSpace(ally, defender.cells)) continue;
      if (footprintsFlank(defender.cells, attacker.cells, ally.cells))
        flankerIds.push(ally.id);
    }
  }
  const flanked = flankerIds.length > 0;
  return {
    flanked,
    bonus: flanked ? PF1E_FLANKING_BONUS : 0,
    flankerIds,
    attackerCannotFlank,
    attackerDoesNotThreaten,
    missingSpace,
  };
}
