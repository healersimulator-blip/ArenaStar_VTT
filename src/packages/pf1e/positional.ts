/**
 * P04 — **positional defenses**: cover and concealment as pure geometry.
 * Diceless, Pixi-free, store-free. The callers own the facts this module can
 * not know: the scene's sight-blocking wall segments (core's wall system,
 * `sightBlocked`), the squares other creatures occupy, and any concealment
 * sources (lighting/foliage are scene authoring, not grid math).
 *
 * Rules transcribed from the primary text (R02 pass, 2026-09-13):
 *
 * **AoN Rules ID 181 — "Cover", CRB p.195**:
 *   "To determine whether your target has cover from your ranged attack,
 *    choose a corner of your square. If any line from this corner to any
 *    corner of the target's square passes through a square or border that
 *    blocks line of effect or provides cover, or through a square occupied by
 *    a creature, the target has cover (+4 to AC)."
 *   "When making a melee attack against an adjacent target, your target has
 *    cover if any line from any corner of your square to the target's square
 *    goes through a wall (including a low wall). When making a melee attack
 *    against a target that isn't adjacent to you (such as with a reach
 *    weapon), use the rules for determining cover from ranged attacks."
 *   "Low Obstacles and Cover: A low obstacle (such as a wall no higher than
 *    half your height) provides cover, but only to creatures within 30 feet
 *    (6 squares) of it. The attacker can ignore the cover if he's closer to
 *    the obstacle than his target."
 *   "Soft Cover: Creatures, even your enemies, can provide you with cover
 *    against ranged attacks, giving you a +4 bonus to AC. However, such soft
 *    cover provides no bonus on Reflex saves, nor does soft cover allow you
 *    to make a Stealth check."
 *   "Big Creatures and Cover: Any creature with a space larger than 5 feet
 *    (1 square) determines cover against melee attacks slightly differently
 *    than smaller creatures do. Such a creature can choose any square that it
 *    occupies to determine if an opponent has cover against its melee
 *    attacks. Similarly, when making a melee attack against such a creature,
 *    you can pick any of the squares it occupies to determine if it has cover
 *    against you."
 *   "Partial Cover: If a creature has cover, but more than half the creature
 *    is visible, its cover bonus is reduced to a +2 to AC and a +1 bonus on
 *    Reflex saving throws. This partial cover is subject to the GM's
 *    discretion."
 *   "Total Cover: If you don't have line of effect to your target (that is,
 *    you cannot draw any line from your square to your target's square
 *    without crossing a solid barrier), he is considered to have total cover
 *    from you. You can't make an attack against a target that has total
 *    cover."
 *   "Improved Cover: In some cases, such as attacking a target hiding behind
 *    an arrowslit, cover may provide a greater bonus to AC and Reflex saves.
 *    In such situations, the normal cover bonuses to AC and Reflex saves can
 *    be doubled (to +8 and +4, respectively)."
 *   "Cover and Attacks of Opportunity: You can't execute an attack of
 *    opportunity against an opponent with cover relative to you."
 *
 *   The two cover sentences encode **two different aggregations**, and both
 *   are kept exactly as written: a ranged (or reach-weapon, i.e. non-adjacent
 *   melee) attacker **chooses a corner** — no cover only when some corner sees
 *   all four target corners clean — while an adjacent melee attacker has cover
 *   if **any** line from **any** corner is blocked. A Large+ creature (or its
 *   Large+ target) additionally picks **any occupied square** (best square for
 *   the attacker, both directions), so the aggregation runs per square pair
 *   and the attacker's best pair decides.
 *
 * **AoN Rules ID 182 — "Concealment", CRB p.196**:
 *   "Concealment encompasses all circumstances where nothing physically blocks
 *    a blow or shot but where something interferes with an attacker's
 *    accuracy." — 20% typical miss chance, 50% total concealment; "Multiple
 *    concealment conditions do not stack"; a d% roll at or below the miss
 *    chance misses. Total concealment additionally blocks attacks of
 *    opportunity and Stealth-independent targeting; visibility sources are
 *    the caller's (A.8's invisibility table feeds `percent: 50`).
 *
 * **Not encoded here:** Reflex-save bonuses (+2/+1/+4) — the spell save paths
 * in `casting.ts` own saves and will consume `PF1eCoverResult.reflexBonus`;
 * Stealth eligibility — a scene interaction, not a resolution input; the
 * 30-ft low-obstacle *authoring* (which walls are "low") — the caller
 * classifies segments and this module applies the distance rule.
 */
import { cellRect, type PF1eAreaGrid, type PF1eCell } from "./targeting";
import { footprintDistance } from "./geometry";

/** A world-space blocking segment (a sight-blocking wall or low obstacle edge). */
export interface PF1eWorldSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Typical concealment miss chance (AoN 182). */
export const CONCEALMENT_MISS_CHANCE = 20;
/** Total concealment miss chance (AoN 182). */
export const TOTAL_CONCEALMENT_MISS_CHANCE = 50;
/** Low obstacles only cover creatures within 30 feet — 6 squares (AoN 181). */
export const LOW_OBSTACLE_RANGE_FT = 30;

/** What the geometry can decide about one attacker/defender pair. */
export type PF1eCoverKind = "none" | "soft" | "standard" | "total";

export interface PF1eCoverResult {
  kind: PF1eCoverKind;
  /**
   * The AC bonus this cover grants against the attack (AoN 181): soft and
   * standard +4; total is ∞ in spirit — the number is 0 and the caller must
   * refuse the attack on `kind === "total"` rather than add to AC.
   */
  acBonus: number;
  /** Reflex bonus (soft cover grants none — AoN 181 "Soft Cover"). */
  reflexBonus: number;
  /** Blocked corner-lines in the attacker's best square pair (diagnostics). */
  blockedLines: number;
  /** Clean lines in that pair (0 with `total`). */
  clearLines: number;
  /** The pair's line count (16 — 4 attacker corners × 4 defender corners). */
  totalLines: number;
  /** True when the best pair's clean corner-lines came from creature squares alone. */
  softOnly: boolean;
  /** Non-fatal named assumptions and citations. */
  notes: string[];
}

const NO_COVER: PF1eCoverResult = {
  kind: "none",
  acBonus: 0,
  reflexBonus: 0,
  blockedLines: 0,
  clearLines: 16,
  totalLines: 16,
  softOnly: false,
  notes: [],
};

interface Line {
  px: number;
  py: number;
  qx: number;
  qy: number;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/**
 * Does the corner-line cross the wall? A **proper crossing** (both segments
 * strictly straddle each other), a wall endpoint lying strictly inside the
 * corner-line, or a collinear overlap all block — the line passes through the
 * wall or runs along it. A wall that merely *touches* the corner-line at the
 * line's own endpoints does not: "crosses" is not "starts on", and a wall
 * ending exactly at an attacker's corner must not blind every line leaving
 * that corner. The epsilon admits wall endpoints authored on grid
 * intersections (float JSON coordinates).
 */
function lineBlockedByWall(line: Line, w: PF1eWorldSegment): boolean {
  const d1 = cross(w.x2 - w.x1, w.y2 - w.y1, line.px - w.x1, line.py - w.y1);
  const d2 = cross(w.x2 - w.x1, w.y2 - w.y1, line.qx - w.x1, line.qy - w.y1);
  const d3 = cross(line.qx - line.px, line.qy - line.py, w.x1 - line.px, w.y1 - line.py);
  const d4 = cross(line.qx - line.px, line.qy - line.py, w.x2 - line.px, w.y2 - line.py);
  const e = 1e-9;
  if (((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e)))
    return true;
  // Wall endpoints strictly interior to the corner-line: the line passes
  // through the wall's end (a corner of a wall juts across the line).
  if (Math.abs(d3) <= e && strictlyInside(line, w.x1, w.y1)) return true;
  if (Math.abs(d4) <= e && strictlyInside(line, w.x2, w.y2)) return true;
  // Collinear overlap: the line runs along the wall for some stretch. For
  // collinear segments that is ordinary interval overlap on both axes.
  if (
    Math.abs(d1) <= e &&
    Math.abs(d2) <= e &&
    Math.abs(d3) <= e &&
    Math.abs(d4) <= e
  ) {
    const overlap =
      Math.min(w.x1, w.x2) <= Math.max(line.px, line.qx) + e &&
      Math.max(w.x1, w.x2) >= Math.min(line.px, line.qx) - e &&
      Math.min(w.y1, w.y2) <= Math.max(line.py, line.qy) + e &&
      Math.max(w.y1, w.y2) >= Math.min(line.py, line.qy) - e;
    return overlap;
  }
  return false;
}

/** Is `(x, y)` strictly between the line's endpoints (not at one)? */
function strictlyInside(line: Line, x: number, y: number): boolean {
  const e = 1e-9;
  return (
    x > Math.min(line.px, line.qx) - e &&
    x < Math.max(line.px, line.qx) + e &&
    y > Math.min(line.py, line.qy) - e &&
    y < Math.max(line.py, line.qy) + e &&
    !(Math.abs(x - line.px) <= e && Math.abs(y - line.py) <= e) &&
    !(Math.abs(x - line.qx) <= e && Math.abs(y - line.qy) <= e)
  );
}

/**
 * Does the corner-line pass through a square occupied by a creature (AoN
 * 181)? A creature fills its square, so border contact counts; but the line
 * must reach the square at some point *strictly between* its endpoints — a
 * line merely starting on the creature's border (the attacker stands adjacent
 * and fires from the shared corner) does not pass *through* it.
 */
function lineBlockedByCell(line: Line, cell: PF1eCell, grid: PF1eAreaGrid): boolean {
  const r = cellRect(cell, grid);
  // Liang–Barsky clip of the segment against the closed cell rect; blocked
  // when the clipped parameter interval has interior length.
  const dx = line.qx - line.px;
  const dy = line.qy - line.py;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, line.px - r.x],
    [dx, r.x + r.size - line.px],
    [-dy, line.py - r.y],
    [dy, r.y + r.size - line.py],
  ];
  for (const [den, num] of edges) {
    if (Math.abs(den) < 1e-12) {
      if (num < -1e-9) return false; // parallel and outside this edge
      continue;
    }
    const t = num / den;
    if (den < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t1 - t0 > 1e-9;
}

function cellCenters(cells: readonly PF1eCell[], grid: PF1eAreaGrid): Array<{ x: number; y: number }> {
  return cells.map((c) => {
    const r = cellRect(c, grid);
    return { x: r.x + r.size / 2, y: r.y + r.size / 2 };
  });
}

/** Squared distance from a point to a segment (world units). */
function segmentDistanceSq(
  p: { x: number; y: number },
  s: PF1eWorldSegment,
): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    const ex = p.x - s.x1;
    const ey = p.y - s.y1;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const ex = p.x - (s.x1 + t * dx);
  const ey = p.y - (s.y1 + t * dy);
  return ex * ex + ey * ey;
}

function footprintDistanceToFt(
  cells: readonly PF1eCell[],
  s: PF1eWorldSegment,
  grid: PF1eAreaGrid,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const c of cellCenters(cells, grid)) {
    best = Math.min(best, segmentDistanceSq(c, s));
  }
  return Math.sqrt(best) / grid.cellSize * grid.feetPerCell;
}

/** The four world corners of a cell. */
function cornersOf(cell: PF1eCell, grid: PF1eAreaGrid): Array<{ x: number; y: number }> {
  const r = cellRect(cell, grid);
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.size, y: r.y },
    { x: r.x, y: r.y + r.size },
    { x: r.x + r.size, y: r.y + r.size },
  ];
}

/**
 * One attacker/defender pair's cover, decided from corner-to-corner lines.
 *
 * - `ranged: true` (or a non-adjacent melee attack, which AoN 181 routes
 *   through the same rules): the attacker **chooses a corner**; cover only
 *   when every corner has at least one blocked line. Creatures count (soft
 *   cover).
 * - adjacent melee: cover when **any** line from **any** corner is blocked by
 *   a wall; creatures never count (soft cover is ranged-only).
 * - A Large+ side picks **any** occupied square: every (attacker cell ×
 *   defender cell) pair is scored and the attacker's best pair decides.
 * - Total cover: the best pair has no clean line at all — "you cannot draw
 *   any line … without crossing a solid barrier".
 */
export function coverBetween(input: {
  attackerCells: readonly PF1eCell[];
  defenderCells: readonly PF1eCell[];
  grid: PF1eAreaGrid;
  /** Sight-blocking wall segments in world units. */
  walls: readonly PF1eWorldSegment[];
  /** Low obstacles: walls no higher than half the creature's height (AoN 181). */
  lowObstacles?: readonly PF1eWorldSegment[];
  /** Squares occupied by other creatures — ranged/non-adjacent-melee soft cover. */
  creatureCells?: readonly PF1eCell[];
  /** True for a ranged attack (or a non-adjacent melee attack). */
  ranged: boolean;
}): PF1eCoverResult {
  const notes: string[] = [];
  if (input.attackerCells.length === 0 || input.defenderCells.length === 0) {
    return {
      ...NO_COVER,
      notes: [
        "cover undecidable — a side occupies no grid square; treated as no cover rather than guessed",
      ],
    };
  }
  if (input.grid.cellSize <= 0 || input.grid.feetPerCell <= 0) {
    return {
      ...NO_COVER,
      notes: ["cover undecidable — the scene grid has no usable scale; treated as no cover"],
    };
  }
  const distance = footprintDistance(input.attackerCells, input.defenderCells);
  // AoN 181: a non-adjacent melee attack (reach weapon) uses the ranged rules.
  const rangedRules = input.ranged || distance > 1;

  // Low obstacles only cover creatures within 30 ft, and only when the
  // attacker is not closer to the obstacle than the target (AoN 181).
  const lowObstacles = input.lowObstacles ?? [];
  const activeLow: PF1eWorldSegment[] = [];
  for (const seg of lowObstacles) {
    const defenderFt = footprintDistanceToFt(input.defenderCells, seg, input.grid);
    if (defenderFt > LOW_OBSTACLE_RANGE_FT) continue;
    const attackerFt = footprintDistanceToFt(input.attackerCells, seg, input.grid);
    if (attackerFt < defenderFt) continue;
    activeLow.push(seg);
  }
  if (lowObstacles.length > 0 && activeLow.length < lowObstacles.length) {
    notes.push(
      `${String(lowObstacles.length - activeLow.length)} low obstacle(s) ignored — beyond 30 ft or the attacker stands closer to it than the target (AoN 181)`,
    );
  }

  const creatures = rangedRules ? (input.creatureCells ?? []) : [];
  const excluded = new Set(
    [...input.attackerCells, ...input.defenderCells].map((c) => `${c.col},${c.row}`),
  );
  const creatureCells = creatures.filter((c) => !excluded.has(`${c.col},${c.row}`));

  // Score every square pair; the attacker's best pair decides (AoN 181 "Big
  // Creatures and Cover" — either side may be the multi-square one, and the
  // chooser is always the attacker).
  let best: {
    blocked: number;
    wallBlocked: number;
    creatureBlocked: number;
    solidBlocked: number;
    cornerBlocked: number[];
    clear: number;
  } | null = null;
  for (const aCell of input.attackerCells) {
    for (const dCell of input.defenderCells) {
      const aCorners = cornersOf(aCell, input.grid);
      const dCorners = cornersOf(dCell, input.grid);
      let blocked = 0;
      let wallBlocked = 0;
      let creatureBlocked = 0;
      let solidBlocked = 0;
      const cornerBlocked = [0, 0, 0, 0];
      for (let ai = 0; ai < 4; ai++) {
        const a = aCorners[ai];
        if (!a) continue;
        for (let di = 0; di < 4; di++) {
          const d = dCorners[di];
          if (!d) continue;
          const line: Line = { px: a.x, py: a.y, qx: d.x, qy: d.y };
          let hitWall = false;
          let hitSolid = false;
          for (const w of input.walls) {
            if (lineBlockedByWall(line, w)) {
              hitWall = true;
              hitSolid = true;
              break;
            }
          }
          if (!hitWall) {
            for (const w of activeLow) {
              if (lineBlockedByWall(line, w)) {
                hitWall = true;
                break;
              }
            }
          }
          let hitCreature = false;
          if (!hitWall) {
            for (const c of creatureCells) {
              if (lineBlockedByCell(line, c, input.grid)) {
                hitCreature = true;
                break;
              }
            }
          }
          if (hitWall || hitCreature) {
            blocked++;
            cornerBlocked[ai] = (cornerBlocked[ai] ?? 0) + 1;
            if (hitWall) wallBlocked++;
            else creatureBlocked++;
            if (hitSolid) solidBlocked++;
          }
        }
      }
      const clear = 16 - blocked;
      if (
        best === null ||
        // The attacker's best pair: the one where the least is blocked —
        // ranged prefers a clean *corner* (choose-a-corner), so a pair with a
        // clean corner always beats one without, then fewer blocked lines win.
        pairBetter({ blocked, cornerBlocked, clear }, best, rangedRules)
      ) {
        best = { blocked, wallBlocked, creatureBlocked, solidBlocked, cornerBlocked, clear };
      }
    }
  }
  if (best === null) return { ...NO_COVER, notes };

  const { blocked, wallBlocked, creatureBlocked, solidBlocked, cornerBlocked, clear } = best;
  // Total cover is a *solid barrier* fact: "you cannot draw any line …
  // without crossing a solid barrier" (AoN 181). An intervening creature
  // never walls a target off — it grants soft cover, not total cover, however
  // many of its squares the lines cross; and a low obstacle only ever covers
  // ("a wall no higher than half your height"), it never blocks line of
  // effect — both stay short of total.
  if (solidBlocked === 16) {
    return {
      kind: "total",
      acBonus: 0,
      reflexBonus: 0,
      blockedLines: blocked,
      clearLines: 0,
      totalLines: 16,
      softOnly: false,
      notes: [
        "total cover — no line from the attacker's best square to the target's square crosses no solid barrier, so no attack can be made (AoN 181)",
        ...notes,
      ],
    };
  }
  const covered = rangedRules
    ? cornerBlocked.every((n) => (n ?? 0) > 0)
    : blocked > 0;
  if (!covered) {
    return {
      kind: "none",
      acBonus: 0,
      reflexBonus: 0,
      blockedLines: blocked,
      clearLines: clear,
      totalLines: 16,
      softOnly: false,
      notes,
    };
  }
  const softOnly = wallBlocked === 0 && creatureBlocked > 0;
  if (softOnly) {
    notes.push(
      "soft cover — only an intervening creature's square blocks the lines (+4 AC, no Reflex bonus, no Stealth; AoN 181)",
    );
  }
  return {
    kind: softOnly ? "soft" : "standard",
    acBonus: 4,
    reflexBonus: softOnly ? 0 : 2,
    blockedLines: blocked,
    clearLines: clear,
    totalLines: 16,
    softOnly,
    notes,
  };
}

function pairBetter(
  candidate: { blocked: number; cornerBlocked: number[]; clear: number },
  incumbent: { blocked: number; cornerBlocked: number[]; clear: number },
  rangedRules: boolean,
): boolean {
  const cleanCorners = (p: { cornerBlocked: number[] }): number =>
    p.cornerBlocked.filter((n) => n === 0).length;
  if (rangedRules) {
    // A pair with a clean corner is strictly better: the attacker chooses
    // that corner and takes no cover at all.
    const a = cleanCorners(candidate);
    const b = cleanCorners(incumbent);
    if (a !== b) return a > b;
  }
  return candidate.blocked < incumbent.blocked;
}

/**
 * The concealment grade a stack of sources collapses to (AoN 182): "Multiple
 * concealment conditions do not stack." — the worst (largest) miss chance
 * wins, and the label names it.
 */
export function concealmentGrade(
  sources: readonly { percent: number; label?: string }[],
): { percent: number; label: string | null; note: string | null } {
  if (sources.length === 0) return { percent: 0, label: null, note: null };
  const sorted = [...sources].sort((a, b) => b.percent - a.percent);
  const worst = sorted[0];
  if (!worst) return { percent: 0, label: null, note: null };
  const note =
    sorted.length > 1
      ? `${String(sorted.length - 1)} lesser concealment condition(s) did not stack (AoN 182)`
      : null;
  return {
    percent: Math.max(0, Math.min(100, Math.floor(worst.percent))),
    label: worst.label ?? null,
    note,
  };
}

/**
 * One concealment miss-chance roll (AoN 182): a d% at or below the miss
 * chance misses. The roll applies to a *hit* — including a natural-20
 * automatic hit and a confirmed critical, because the natural-20 rule speaks
 * to the attack roll against AC while the miss chance is the separate roll
 * concealment adds. `die` is the d% face (1–100).
 */
export function concealmentOutcome(input: {
  percent: number;
  die: number;
}): { miss: boolean } {
  if (input.percent <= 0) return { miss: false };
  return { miss: input.die >= 1 && input.die <= input.percent };
}
