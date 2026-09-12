/**
 * P06/D-185 — the **tactical** AoO scene seam: one dragged token's movement, decided by
 * D-184's interrupt queue rather than by a prompt.
 *
 * The strategic sim is the queue's first consumer (D-184) and this is its second, on the
 * other scale: a canvas drag moves a token between two world points, `cellsAlongSegment`
 * walks the squares between them, each left square is tested against the other tokens'
 * threatened sets (the same `threatPreview` composition the flanking overlay and the sheet
 * read), and the reactors that still have a budget end up in the queue. The module is pure
 * and Pixi-free — the canvas passes world coordinates, the e2e surface passes the same
 * coordinates through the real op path, and neither has to re-derive a rule.
 *
 * **What "budget" means here.** The ledger itself is `combatState`'s (`aooUsed`/`aooMax`
 * per combatant, reset on the owner's turn) and the number comes from the actor derivation
 * (`PF1eDerived.aooPerRound`, D-183). This module takes the ledger as a plain
 * `{used, max}` map because it must also answer for scenes with no encounter running, and
 * it refuses an exhausted reactor with `interrupts.ts`'s own reason string — one
 * vocabulary, so the panel's tooltip and the log cannot disagree.
 *
 * **Named limitations.** (1) A mover that occupies more than one square is walked between
 * its **centres**, so the squares its trailing footprint leaves are not tested — a
 * footprint-aware walk is P05's movement slice, and the module reports the assumption
 * instead of guessing. (2) The withdraw exemption is applied to every reactor: this
 * package has no visibility model, so "any opponent you can see" is read as "every
 * opponent" — the same reading D-184 recorded for the sim. (3) Hostility is the caller's
 * fact (`isEnemy`), exactly as `pf1eThreatModel` takes it, and its absence is a named
 * default rather than a silent "everybody is an enemy".
 */
import {
  areaPreviewRects,
  cellKey,
  pf1eAreaGridFromScene,
  tokenCells,
  type PF1eAreaGrid,
  type PF1eAreaIssue,
  type PF1eCell,
} from "./targeting";
import { cellsAlongSegment, FEET_PER_SQUARE } from "./geometry";
import {
  aooRefusal,
  createInterruptQueue,
  queueMovementAoOs,
  squaresLeft as squaresLeftOf,
  type PF1eInterrupt,
  type PF1eInterruptQueue,
} from "./interrupts";
import {
  pf1eThreatModel,
  type PF1eThreatRect,
  type PF1eThreatToken,
} from "./threatPreview";

/** One combatant's opportunity ledger, as `combatState` keeps it (aooUsed/aooMax). */
export interface PF1eOpportunityLedger {
  used: number;
  max: number;
}

export interface PF1eMovementOpportunityInput {
  /** Scene grid facts (`SceneGrid` shape: size/distance/units). */
  grid: { size: number; distance: number; units: string };
  /** The scene's tokens with their actor-derived creature facts. */
  tokens: readonly PF1eThreatToken[];
  /** Whose move, and where it lands: the token's **new centre** in world units. */
  mover: { tokenId: string; to: { x: number; y: number } };
  /** A withdraw exempts the square the mover started in and nothing else (CRB p.188). */
  withdraw?: boolean;
  isEnemy?: (a: string, b: string) => boolean;
  /** Token id → ledger. An absent entry means "nothing spent yet, one opportunity". */
  ledgers?: Record<string, PF1eOpportunityLedger>;
  /** The turn the queue is labelled with (the queue is turn-local, D-184). */
  turn?: number;
}

export interface PF1eOpportunityReactor {
  tokenId: string;
  /** The square the mover left that this reactor threatens, in `cellKey` form. */
  cell: string;
  /** Its world rect — the square to highlight while the attack is offered. */
  rect: PF1eThreatRect;
  /** The ledger's own numbers at the moment of the decision. */
  used: number | null;
  max: number | null;
  /** What the log should say: names the reactor's own remaining budget. */
  line: string;
}

export interface PF1eMovementOpportunityResult {
  ok: boolean;
  /** Fatal, named problems (unusable grid, a mover that covers no square). */
  issues: readonly PF1eAreaIssue[];
  /** Non-fatal named assumptions (no hostility supplied, multi-square mover, …). */
  defaults: readonly PF1eAreaIssue[];
  grid: PF1eAreaGrid | null;
  /** A named refusal when there was no walk to make (mover missing / no squares). */
  refusal: string | null;
  /** The walk in travel order, `cellKey` form. */
  path: readonly string[];
  /** The squares the walk left, withdraw's start square already excluded. */
  squaresLeft: readonly string[];
  /** The same squares as world rects — the highlight draw list. */
  leftRects: readonly PF1eThreatRect[];
  /** Every token that threatened a left square, whether or not it can still react. */
  reactors: readonly PF1eOpportunityReactor[];
  /** Reactors whose ledger refused them, with `interrupts.ts`'s own reason string. */
  refused: readonly { tokenId: string; reason: string }[];
  /** The queue after this movement (entries carry reactor, provoker, square). */
  queue: PF1eInterruptQueue;
  queued: readonly PF1eInterrupt[];
}

const emptyResult = (
  issues: readonly PF1eAreaIssue[],
  defaults: readonly PF1eAreaIssue[],
  refusal: string,
  turn: number,
): PF1eMovementOpportunityResult => ({
  ok: false,
  issues,
  defaults,
  grid: null,
  refusal,
  path: [],
  squaresLeft: [],
  leftRects: [],
  reactors: [],
  refused: [],
  queue: createInterruptQueue(turn, "move"),
  queued: [],
});

/**
 * Decide the attacks of opportunity one token's move earns. Pure: the caller submits the
 * token update op, then hands the intended destination here; nothing is written and no
 * dice are rolled, so the panel can ask *before* the move commits and a browser spec can
 * assert the same facts the sim would have produced.
 */
export function pf1eMovementOpportunities(
  input: PF1eMovementOpportunityInput,
): PF1eMovementOpportunityResult {
  const turn = input.turn ?? 1;
  const { grid: areaGrid, issues } = pf1eAreaGridFromScene(input.grid);
  const defaults: PF1eAreaIssue[] = [];
  if (input.isEnemy === undefined) {
    defaults.push({
      field: "isEnemy",
      message:
        "hostility not supplied — every other token is treated as an enemy (AoN 102's opportunity is provoked by a threatening opponent)",
    });
  }
  if (issues.length > 0) {
    return emptyResult(issues, defaults, "the scene grid cannot be read", turn);
  }

  const mover = input.tokens.find((t) => t._id === input.mover.tokenId);
  if (mover === undefined) {
    return emptyResult(
      [],
      defaults,
      `no token "${input.mover.tokenId}" on this scene`,
      turn,
    );
  }
  const startCells = tokenCells(mover, areaGrid);
  const toCentre = { x: input.mover.to.x, y: input.mover.to.y };
  const endCells = tokenCells(
    { ...mover, x: toCentre.x, y: toCentre.y },
    areaGrid,
  );
  if (startCells.length === 0 || endCells.length === 0) {
    return emptyResult(
      [],
      defaults,
      "the mover covers no grid square, before or after the move",
      turn,
    );
  }
  if (startCells.length > 1) {
    defaults.push({
      field: `token:${mover._id}`,
      message:
        "multi-square mover — the walk is taken between the token centres, so squares its trailing footprint leaves are not tested (a footprint-aware walk is P05's)",
    });
  }

  // The walk, between the two centres: `cellsAlongSegment` in the scene's own cell size,
  // so world units stay world units and a diagonal never "grazes" a third square (D-182).
  const path = cellsAlongSegment(
    { x: mover.x, y: mover.y },
    toCentre,
    areaGrid.cellSize,
  );
  const left = squaresLeftOf(path, { withdraw: input.withdraw === true });
  if (left.length === 0) {
    return {
      ...emptyResult([], defaults, "", turn),
      ok: true,
      grid: areaGrid,
      refusal: null,
      path: path.map(cellKey),
      queue: createInterruptQueue(turn, "move"),
    };
  }

  // The threatened sets come from the one composition the overlay and the sheet already
  // read — no second threat implementation at this scale.
  const model = pf1eThreatModel({
    grid: input.grid,
    tokens: input.tokens,
    ...(input.isEnemy !== undefined ? { isEnemy: input.isEnemy } : {}),
  });
  if (!model.ok) {
    return emptyResult(
      model.issues,
      [...defaults, ...model.defaults],
      "the scene's threats could not be resolved",
      turn,
    );
  }
  const threatOf = new Map(model.entries.map((e) => [e.tokenId, e]));
  const isEnemy = input.isEnemy;
  const reactors: PF1eOpportunityReactor[] = [];
  const refused: Array<{ tokenId: string; reason: string }> = [];
  const eligible: Array<{
    id: string;
    threatens: (cell: PF1eCell) => boolean;
  }> = [];

  for (const token of input.tokens) {
    if (token._id === mover._id) continue;
    if (isEnemy !== undefined && !isEnemy(token._id, mover._id)) continue;
    const entry = threatOf.get(token._id);
    if (entry === undefined) continue;
    const threatened = new Set(entry.threatKeys);
    const cell = left.find((c) => threatened.has(cellKey(c)));
    if (cell === undefined) continue;

    const ledger = input.ledgers?.[token._id];
    const used = ledger === undefined ? null : ledger.used;
    const max = ledger === undefined ? null : ledger.max;
    const refusal =
      ledger === undefined
        ? null
        : aooRefusal({ used: ledger.used, budgetMax: ledger.max });
    const rect = areaPreviewRects([cell], areaGrid)[0] ?? {
      x: 0,
      y: 0,
      size: areaGrid.cellSize,
    };
    reactors.push({
      tokenId: token._id,
      cell: cellKey(cell),
      rect,
      used,
      max,
      line:
        refusal === null
          ? `${token._id} may strike ${mover._id} as it leaves (${cellKey(cell)})`
          : `${token._id} forgoes the attack of opportunity — ${refusal}`,
    });
    if (refusal === null)
      eligible.push({
        id: token._id,
        threatens: (c) => threatened.has(cellKey(c)),
      });
    else refused.push({ tokenId: token._id, reason: refusal });
  }

  const result = queueMovementAoOs(createInterruptQueue(turn, "move"), {
    turn,
    substep: "move",
    moverId: mover._id,
    actionId: `move:${turn}:${mover._id}`,
    path,
    ...(input.withdraw === true ? { withdraw: true } : {}),
    cellFeet: areaGrid.cellSize,
    reactors: eligible,
  });

  return {
    ok: true,
    issues: [],
    defaults,
    grid: areaGrid,
    refusal: null,
    path: path.map(cellKey),
    squaresLeft: left.map(cellKey),
    leftRects: areaPreviewRects(left, areaGrid),
    reactors,
    refused,
    queue: result.queue,
    queued: result.queued,
  };
}

/** Feet per square for a scene grid — the tactical read of `SceneGrid.distance`. */
export function sceneFeetPerSquare(grid: { distance: number }): number {
  return Number.isFinite(grid.distance) && grid.distance > 0
    ? grid.distance
    : FEET_PER_SQUARE;
}
