/**
 * P04 (D-181) — the threat & flanking model: the single seam that turns the
 * active scene's tokens into threatened-square draw lists and AoN 183's
 * flanking facts.
 *
 * Composes P02's geometry (`tokenCells` → `naturalReachSquares` →
 * `threatenedCells` → `occupancy`) with P04's `resolveFlanking`, so the canvas
 * overlay, the sheet's hand-ticked "Flanking +2" checkbox and the e2e surfaces
 * all read ONE composition instead of re-wiring the chain per consumer — the
 * staging D-154 set for `areaPreview.ts` behind D-148's `targeting.ts`.
 *
 * Diceless and Pixi-free like the rest of the package. Creature facts arrive
 * caller-resolved (the app side owns actorId → `deriveFromDocuments` →
 * `size`/`reachShape`), the scene arrives as `SceneGrid` metadata, and a refusal
 * is a named issue rather than a guess. An absent size is a named *default*
 * (Medium — `sizeEntry`'s contract), not an issue, so a scene whose actors are
 * still unresolved yields a usable model that says what it assumed.
 *
 * Reach is the creature's **natural** reach unless the caller overrides it: what
 * a token threatens depends on what it is holding, and this seam is not told.
 * `reachWeapon` selects AoN 179's band, `reachSquares` an authored figure.
 *
 * Cost: the flanking matrix is O(tokens² × tokens) with each creature's threat
 * set computed once, so callers refresh it when the scene or a position changes,
 * not per frame.
 */
import {
  FEET_PER_SQUARE,
  footprintDistance,
  naturalReachSquares,
  occupancy,
  threatenedCells,
  type PF1eReachShape,
} from "./geometry";
import {
  resolveFlanking,
  threatensSpace,
  type PF1eFlankingParticipant,
} from "./flanking";
import { concealmentGrade, coverBetween, type PF1eWorldSegment } from "./positional";
import { normalizeSize, type PF1eSize } from "./rulesTables";
import {
  areaPreviewRects,
  cellKey,
  pf1eAreaGridFromScene,
  tokenCells,
  type PF1eAreaIssue,
  type PF1eCell,
} from "./targeting";

/** A token's replicated footprint facts plus whatever creature facts are known. */
export interface PF1eThreatToken {
  _id: string;
  /** Centre in world units, matching `tokenCells`. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Authored/derived size; absent or unrecognized is Medium (named, not silent). */
  size?: string | null;
  /** Table 8-4's body form for the sizes that print two reach columns. */
  shape?: PF1eReachShape | null;
  /** Authored reach in squares; absent is this size's natural reach. */
  reachSquares?: number;
  /** Threaten the reach weapon's band instead of the filled disc (AoN 179). */
  reachWeapon?: boolean;
}

/** World-space square — the overlay draw list, `areaPreviewRects`' shape. */
export interface PF1eThreatRect {
  x: number;
  y: number;
  size: number;
}

export interface PF1eThreatEntry {
  tokenId: string;
  /** The size the entry was resolved with (`normalizeSize`, or "Medium"). */
  size: PF1eSize;
  /** Squares this token occupies, as `cellKey`s. */
  cells: readonly string[];
  cellRects: readonly PF1eThreatRect[];
  reachSquares: number;
  reachFt: number;
  /** Table 8-4: Fine/Diminutive/Tiny threaten nothing and can't flank. */
  threatensNothing: boolean;
  cannotFlank: boolean;
  /** Threatened squares, as `cellKey`s (row-then-column, `threatenedCells`). */
  threatKeys: readonly string[];
  /** The same squares as world rects — P02's deferred highlighting draw list. */
  threatRects: readonly PF1eThreatRect[];
}

/** AoN 183's fact for one attacker/defender pair on this scene. */
export interface PF1eFlankFact {
  attackerId: string;
  defenderId: string;
  /** Allies that threaten the defender from an opposite border/corner. */
  helperIds: readonly string[];
  /** `PF1E_FLANKING_BONUS` — added to the attack roll, never to AC. */
  bonus: number;
}

export interface PF1eThreatModel {
  /** True when the scene resolved cleanly (no fatal issues). */
  ok: boolean;
  /** Fatal, named problems: unusable scene grid, a token that covers no square. */
  issues: readonly PF1eAreaIssue[];
  /** Non-fatal named assumptions: an unresolved size, an overridden reach. */
  defaults: readonly PF1eAreaIssue[];
  entries: readonly PF1eThreatEntry[];
  /** Every flanking pair on the scene; empty unless somebody really flanks. */
  flanking: readonly PF1eFlankFact[];
  /** Defender ids that at least one attacker flanks. */
  flankedTokenIds: readonly string[];
}

export interface PF1eThreatInput {
  /** Scene grid facts (`SceneGrid` shape: size/distance/units). */
  grid: { size: number; distance: number; units: string };
  tokens: readonly PF1eThreatToken[];
  /**
   * Is `a` an enemy of `b`? AoN 183 conditions the bonus on the defender being
   * threatened by "another **enemy** character or creature", and hostility is a
   * scene fact geometry cannot supply (`TokenDocument.disposition` is only ever
   * read for an outline colour in this codebase, and a faction model belongs to
   * the strategic layer). So the caller states it — and when it does not, every
   * pair is treated as hostile and the model *says so* in `defaults`, because
   * silently granting the bonus to a defender's friends would be worse than
   * reporting a relation the caller then filters.
   */
  isEnemy?: (a: string, b: string) => boolean;
}

const emptyModel = (
  issues: readonly PF1eAreaIssue[],
  defaults: readonly PF1eAreaIssue[],
): PF1eThreatModel => ({
  ok: false,
  issues,
  defaults,
  entries: [],
  flanking: [],
  flankedTokenIds: [],
});

/** Per-token resolved facts, shared by the entries and the flanking matrix. */
interface Resolved {
  token: PF1eThreatToken;
  size: PF1eSize;
  cells: PF1eCell[];
  reachSquares: number;
  reachWeapon: boolean;
  threatened: PF1eCell[];
  threatKeys: Set<string>;
}

/**
 * Resolve a scene's tokens into threat and flanking facts. A token that covers
 * no square is a named issue and is left out — a creature with no position has
 * no borders to be flanked across, and guessing one would invent geometry.
 */
export function pf1eThreatModel(input: PF1eThreatInput): PF1eThreatModel {
  const { grid, issues } = pf1eAreaGridFromScene(input.grid);
  const defaults: PF1eAreaIssue[] = [];
  const isEnemy = input.isEnemy;
  if (!isEnemy) {
    defaults.push({
      field: "isEnemy",
      message:
        "hostility not supplied — reporting every flanking pair regardless of side (AoN 183 asks for an enemy)",
    });
  }
  if (issues.length > 0) return emptyModel(issues, defaults);

  const resolved: Resolved[] = [];
  const skipped: PF1eAreaIssue[] = [];
  for (const token of input.tokens) {
    const cells = tokenCells(token, grid);
    if (cells.length === 0) {
      skipped.push({
        field: `token:${token._id}`,
        message:
          "token covers no grid square — it has no space to threaten from or be flanked in",
      });
      continue;
    }
    const size = normalizeSize(token.size);
    if (size === null) {
      defaults.push({
        field: `token:${token._id}`,
        message:
          token.size === undefined || token.size === null
            ? "size not resolved from its actor — using Medium"
            : `size ${JSON.stringify(token.size)} is not a PF1e size category — using Medium`,
      });
    }
    const reachSquares =
      typeof token.reachSquares === "number" &&
      Number.isFinite(token.reachSquares)
        ? token.reachSquares
        : naturalReachSquares(size ?? "Medium", token.shape ?? null);
    const reachWeapon = token.reachWeapon === true;
    const threatened = threatenedCells({
      footprint: cells,
      reachSquares,
      reachWeapon,
    });
    resolved.push({
      token,
      size: size ?? "Medium",
      cells,
      reachSquares,
      reachWeapon,
      threatened,
      threatKeys: new Set(threatened.map(cellKey)),
    });
  }
  if (skipped.length > 0) return emptyModel(skipped, defaults);

  const entries: PF1eThreatEntry[] = resolved.map((r) => {
    const occ = occupancy(r.size);
    return {
      tokenId: r.token._id,
      size: r.size,
      cells: r.cells.map(cellKey),
      cellRects: areaPreviewRects(r.cells, grid),
      reachSquares: r.reachSquares,
      reachFt: r.reachSquares * FEET_PER_SQUARE,
      threatensNothing: occ.threatensNothing || r.threatened.length === 0,
      cannotFlank: occ.cannotFlank || r.reachSquares <= 0,
      threatKeys: r.threatened.map(cellKey),
      threatRects: areaPreviewRects(r.threatened, grid),
    };
  });

  // AoN 183 per ordered pair. Helpers are pre-filtered with the module's own
  // predicate (a creature that does not threaten the defender cannot help), and
  // every threat set is computed once above and handed to `resolveFlanking`.
  const participant = (r: Resolved): PF1eFlankingParticipant => ({
    id: r.token._id,
    cells: r.cells,
    reachSquares: r.reachSquares,
    reachWeapon: r.reachWeapon,
    size: r.size,
    threatened: r.threatened,
  });
  const flanking: PF1eFlankFact[] = [];
  const threatOf = (r: Resolved) => ({
    cells: r.cells,
    reachSquares: r.reachSquares,
    reachWeapon: r.reachWeapon,
    threatened: r.threatened,
  });
  for (const defender of resolved) {
    const enemies = resolved.filter(
      (t) =>
        t.token._id !== defender.token._id &&
        (!isEnemy || isEnemy(t.token._id, defender.token._id)),
    );
    const helpers = enemies.filter((h) =>
      threatensSpace(threatOf(h), defender.cells),
    );
    if (helpers.length === 0) continue;
    for (const attacker of enemies) {
      // The attacker has to reach the defender at all; otherwise there is no
      // melee attack for the bonus to attach to (AoN 102's "squares into which
      // you can make a melee attack"). Same predicate `resolveFlanking` uses.
      if (!threatensSpace(threatOf(attacker), defender.cells)) continue;
      const others = helpers.filter((h) => h.token._id !== attacker.token._id);
      if (others.length === 0) continue;
      const res = resolveFlanking({
        defender: { id: defender.token._id, cells: defender.cells },
        attacker: participant(attacker),
        allies: others.map(participant),
      });
      if (res.flanked) {
        flanking.push({
          attackerId: attacker.token._id,
          defenderId: defender.token._id,
          helperIds: res.flankerIds,
          bonus: res.bonus,
        });
      }
    }
  }

  return {
    ok: true,
    issues: [],
    defaults,
    entries,
    flanking,
    flankedTokenIds: [...new Set(flanking.map((f) => f.defenderId))],
  };
}

// ─── P04/D-196 — the attacker/defender pair seam (cover, reach, flanking) ─────

/**
 * One attack's positional facts between two scene tokens: the distance, the
 * melee reach verdict for a derived attack line, AoN 183's flanking bonus,
 * and AoN 181's cover between them. This is the seam the position-aware sheet
 * consumer reads — the hand-ticked checkbox becomes a derived fact with a
 * manual override, exactly the P04 remainder the checklist names — and the
 * one the e2e surface exposes, so the browser asserts the same composition.
 *
 * The caller supplies the sight-blocking wall segments (core's wall system
 * decides blocking; a low-obstacle classification may ride `lowObstacles`)
 * and any concealment sources — the scene carries no concealment authoring
 * yet, so the sheet passes none and the number stays 0 until a source exists.
 *
 * `ranged` decides which of AoN 181's two cover sentences applies, exactly as
 * the rule routes a non-adjacent melee attack through the ranged rules: pass
 * the attack line's own rangedness; a melee line two squares out (reach
 * weapon) still measures cover the ranged way, because distance makes it so.
 */
export interface PF1ePairPositionResult {
  ok: boolean;
  issues: readonly PF1eAreaIssue[];
  defaults: readonly PF1eAreaIssue[];
  /** Footprint distance in feet (0 = sharing a square, e.g. a Tiny striker). */
  distanceFt: number;
  /** AoN 181's adjacency fact: 1 square apart (or sharing one) is adjacent. */
  adjacent: boolean;
  /**
   * Melee reach for the given `reachSquares` (the derived attack line's own
   * figure): canStrike covers the natural band (and the in-square strike for
   * 0-reach attackers). Null for a ranged line — the caller measures range
   * increments instead (`rangedAttackRange`).
   */
  reach: { canStrike: boolean; refusals: readonly string[] } | null;
  flanking: { flanked: boolean; bonus: number; helperIds: readonly string[] };
  cover: ReturnType<typeof coverBetween>;
  /** The collapsed concealment grade the caller supplied (0 when none). */
  concealment: { percent: number; label: string | null };
}

export function pf1ePairPosition(input: {
  grid: { size: number; distance: number; units: string };
  tokens: readonly PF1eThreatToken[];
  attackerId: string;
  defenderId: string;
  /** The attack's rangedness (a derived line's `ranged` flag). */
  ranged: boolean;
  /** The attack line's reach in squares (a derived line's `reachSquares`). */
  reachSquares?: number;
  /** Sight-blocking wall segments, world units. */
  walls: readonly PF1eWorldSegment[];
  /** Low obstacles the caller classified (AoN 181's 30-ft rule applies here). */
  lowObstacles?: readonly PF1eWorldSegment[];
  /** Concealment sources — non-stacking (AoN 182); absent means none. */
  concealment?: readonly { percent: number; label?: string }[];
  isEnemy?: (a: string, b: string) => boolean;
}): PF1ePairPositionResult {
  const model = pf1eThreatModel({
    grid: input.grid,
    tokens: input.tokens,
    ...(input.isEnemy ? { isEnemy: input.isEnemy } : {}),
  });
  const { grid } = pf1eAreaGridFromScene(input.grid);
  const byId = new Map(
    input.tokens.map((t) => [t._id, t] as const),
  );
  const attacker = byId.get(input.attackerId);
  const defender = byId.get(input.defenderId);
  if (model.ok && attacker !== undefined && defender !== undefined) {
    const aEntry = model.entries.find((e) => e.tokenId === attacker._id);
    const dEntry = model.entries.find((e) => e.tokenId === defender._id);
    if (aEntry !== undefined && dEntry !== undefined) {
      const aCells = aEntry.cells.map(parseKey);
      const dCells = dEntry.cells.map(parseKey);
      const squares = footprintDistance(aCells, dCells);
      const distanceFt = Number.isFinite(squares)
        ? squares * FEET_PER_SQUARE
        : Number.POSITIVE_INFINITY;
      const adjacent = squares <= 1;
      const reach =
        input.ranged || input.reachSquares === undefined
          ? null
          : {
              canStrike: squares <= input.reachSquares,
              refusals:
                squares <= input.reachSquares
                  ? []
                  : [
                      `the target is ${String(distanceFt)} ft away — the attack line reaches ${String(input.reachSquares * FEET_PER_SQUARE)} ft`,
                    ],
            };
      const flank = model.flanking.find(
        (f) => f.attackerId === attacker._id && f.defenderId === defender._id,
      );
      const cover = coverBetween({
        attackerCells: aCells,
        defenderCells: dCells,
        grid,
        walls: input.walls,
        ...(input.lowObstacles ? { lowObstacles: input.lowObstacles } : {}),
        creatureCells: input.tokens
          .filter((t) => t._id !== attacker._id && t._id !== defender._id)
          .flatMap((t) => tokenCells(t, grid)),
        ranged: input.ranged,
      });
      return {
        ok: true,
        issues: [],
        defaults: model.defaults,
        distanceFt,
        adjacent,
        reach,
        flanking: flank
          ? { flanked: true, bonus: flank.bonus, helperIds: flank.helperIds }
          : { flanked: false, bonus: 0, helperIds: [] },
        cover,
        concealment: (() => {
          const g = concealmentGrade(input.concealment ?? []);
          return { percent: g.percent, label: g.label };
        })(),
      };
    }
  }
  return {
    ok: false,
    issues: model.ok
      ? [
          {
            field: "pair",
            message:
              "attacker or defender is not a placed token on this scene — no positional facts",
          },
        ]
      : model.issues,
    defaults: model.defaults,
    distanceFt: Number.POSITIVE_INFINITY,
    adjacent: false,
    reach: null,
    flanking: { flanked: false, bonus: 0, helperIds: [] },
    cover: coverBetween({
      attackerCells: [],
      defenderCells: [],
      grid,
      walls: input.walls,
      ranged: input.ranged,
    }),
    concealment: { percent: 0, label: null },
  };
}

function parseKey(key: string): PF1eCell {
  const [col, row] = key.split(",").map((n) => Number.parseInt(n, 10));
  return { col: col ?? 0, row: row ?? 0 };
}
