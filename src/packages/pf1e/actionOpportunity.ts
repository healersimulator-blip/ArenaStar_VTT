/**
 * P06/D-190 — the **tactical** action-trigger seam: one creature's provoking *action*
 * (casting a spell, making a ranged or ranged-touch attack) decided by D-184's interrupt
 * queue, on the same vocabulary as the movement seam (D-185) so the two scales — and the
 * two kinds of trigger — read one set of rules and one reason vocabulary.
 *
 * The movement seam walks the squares a token *leaves*; this seam tests the squares the
 * provoker *occupies* when it acts, because Table 7-2's provokes are \"performing certain
 * actions within a threatened square\" (AoN 102) — the caster or shooter is attacked where
 * it stood, not where it ends up. The trigger itself is never guessed here: `actionTrigger`
 * reads Table 7-2 out of `actions.ts`, refuses a `no` row by name, and refuses a
 * `usually`/`maybe`/`varies` row *rather than deciding for the table*; the ranged-touch
 * case (AoN 133 — \"ranged touch attacks provoke … even if the spell was cast
 * defensively\") is the one trigger the rules state outright and unconditionally, so the
 * caller asks for it by name (`rangedTouchTrigger`).
 *
 * **What \"budget\" means here** is exactly the movement seam's: the ledger is
 * `combatState`'s (`aooUsed`/`aooMax` per combatant), taken as a plain `{used, max}` map
 * because the seam must also answer for scenes with no encounter running, and an exhausted
 * reactor is refused with `interrupts.ts`'s own reason string — one vocabulary, so the
 * panel's tooltip, the movement log and this log cannot disagree.
 *
 * **Named limitations.** (1) The seam tests the provoker's occupied squares against each
 * reactor's threatened set, so a reactor that does not actually threaten the caster's
 * square is not queued — the caller supplies the threat model, exactly as the movement seam
 * does. (2) The casting exemption is the caller's, not the seam's: a quickened swift cast
 * provokes nothing (the caller simply never calls the seam with `cast-spell` for it), and
 * a defensively cast spell is the caller's concentration gate (C03a) — the *ranged touch*
 * still provokes regardless, which is precisely why `rangedTouchTrigger` is its own kind.
 * (3) \"You don't have to make an attack of opportunity\" is a choice the caller makes by
 * not queuing; this module queues every eligible reactor, exactly as the movement seam
 * does.
 */
import {
  actionTrigger,
  aooRefusal,
  createInterruptQueue,
  queueAoOs,
  type PF1eAoOTrigger,
  type PF1eInterrupt,
  type PF1eInterruptQueue,
} from "./interrupts";
import {
  areaPreviewRects,
  cellKey,
  pf1eAreaGridFromScene,
  tokenCells,
  type PF1eAreaGrid,
  type PF1eAreaIssue,
  type PF1eCell,
} from "./targeting";
import {
  pf1eThreatModel,
  type PF1eThreatRect,
  type PF1eThreatToken,
} from "./threatPreview";
import { footprintDistance } from "./geometry";
import { coverBetween, type PF1eWorldSegment } from "./positional";
import type {
  PF1eOpportunityLedger,
  PF1eOpportunityReactor,
} from "./tacticalOpportunity";

/** What a provoking action is, declared by the caller — never inferred by the seam. */
export interface PF1eActionOpportunityInput {
  /** Scene grid facts (`SceneGrid` shape: size/distance/units). */
  grid: { size: number; distance: number; units: string };
  /** The scene's tokens with their actor-derived creature facts. */
  tokens: readonly PF1eThreatToken[];
  /** Whose action provokes: the token standing in a threatened square. */
  provoker: { tokenId: string };
  /**
   * The Table 7-2 row's id (`cast-spell`, `attack-ranged`, …) — read through
   * `actionTrigger`, which refuses a `no` row by name and a `usually`/`maybe`/`varies`
   * row rather than guessing. Mutually exclusive with `trigger`.
   */
  actionId?: string;
  /**
   * An explicit trigger (`rangedTouchTrigger()` for AoN 133), which the caller states
   * rather than reading off the table. Mutually exclusive with `actionId`.
   */
  trigger?: PF1eAoOTrigger;
  isEnemy?: (a: string, b: string) => boolean;
  /** Token id → ledger. An absent entry means "nothing spent yet, one opportunity". */
  ledgers?: Record<string, PF1eOpportunityLedger>;
  /**
   * An existing queue to append to. Two provokes from one action — the cast and its
   * ranged touch — are two opportunities on one queue (D-191), so the second call hands
   * this the first call's queue rather than starting a fresh one and losing the dedupe.
   */
  queue?: PF1eInterruptQueue;
  /** The turn the queue is labelled with (the queue is turn-local, D-184). */
  turn?: number;
  /**
   * P04 — sight-blocking wall segments in world units; AoN 181's cover
   * exclusion for the queued reactions (see the movement seam's twin). An
   * absent field is a named default, not a silent queue-through.
   */
  coverWalls?: readonly PF1eWorldSegment[];
}

export interface PF1eActionOpportunityResult {
  /**
   * True when the seam reached a decision: a provoking action (with or without reactors),
   * or a non-provoking action refused by name. False only for fatal scene problems —
   * an unusable grid, a missing provoker, or a provoker that covers no square.
   */
  ok: boolean;
  /** Fatal, named problems (unusable grid, a provoker that covers no square). */
  issues: readonly PF1eAreaIssue[];
  /** Non-fatal named assumptions (no hostility supplied, …). */
  defaults: readonly PF1eAreaIssue[];
  grid: PF1eAreaGrid | null;
  /**
   * A named reason the queue is empty: a `no`/`usually`/`maybe`/`varies` Table row, an
   * unknown action, a missing provoker, or a provoker with no squares. Null when the
   * action provoked (whatever the reactors then did).
   */
  refusal: string | null;
  /** The trigger that actually provoked — null when `refusal` is set. */
  trigger: PF1eAoOTrigger | null;
  /** The provoker's occupied squares in `cellKey` form — where it stood when it acted. */
  squares: readonly string[];
  /** The same squares as world rects — the highlight draw list. */
  rects: readonly PF1eThreatRect[];
  /** Every token that threatened an occupied square, whether or not it can still react. */
  reactors: readonly PF1eOpportunityReactor[];
  /** Reactors whose ledger refused them, with `interrupts.ts`'s own reason string. */
  refused: readonly { tokenId: string; reason: string }[];
  /** The queue after this action (entries carry reactor, provoker, trigger). */
  queue: PF1eInterruptQueue;
  queued: readonly PF1eInterrupt[];
}

const emptyResult = (
  issues: readonly PF1eAreaIssue[],
  defaults: readonly PF1eAreaIssue[],
  refusal: string,
  turn: number,
): PF1eActionOpportunityResult => ({
  ok: false,
  issues,
  defaults,
  grid: null,
  refusal,
  trigger: null,
  squares: [],
  rects: [],
  reactors: [],
  refused: [],
  queue: createInterruptQueue(turn, "action"),
  queued: [],
});

/**
 * Decide the attacks of opportunity one provoking action earns. Pure: nothing is written
 * and no dice are rolled, so the caller can report or resolve the queue *before* the action
 * resolves — the same \"ask first\" contract as the movement seam, because the attack
 * interrupts the action rather than following it.
 */
export function pf1eActionOpportunities(
  input: PF1eActionOpportunityInput,
): PF1eActionOpportunityResult {
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
  if (input.coverWalls === undefined) {
    defaults.push({
      field: "coverWalls",
      message:
        "cover facts not supplied — reactors were queued without AoN 181's cover exclusion",
    });
  }

  // The trigger is decided first: a `no` row (total defense), an unknown action, or a
  // `usually`/`maybe`/`varies` row refuses by name before any scene facts are touched.
  const requested =
    input.trigger !== undefined
      ? { ok: true as const, trigger: input.trigger }
      : actionTrigger(input.actionId ?? "");
  if (!requested.ok) {
    return {
      ...emptyResult([], defaults, requested.reason, turn),
      ok: true,
    };
  }
  const trigger = requested.trigger;

  if (issues.length > 0) {
    return emptyResult(issues, defaults, "the scene grid cannot be read", turn);
  }

  const provoker = input.tokens.find((t) => t._id === input.provoker.tokenId);
  if (provoker === undefined) {
    return emptyResult(
      [],
      defaults,
      `no token "${input.provoker.tokenId}" on this scene`,
      turn,
    );
  }
  const squares = tokenCells(provoker, areaGrid);
  if (squares.length === 0) {
    return emptyResult(
      [],
      defaults,
      "the provoker covers no grid square",
      turn,
    );
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
  const eligible: Array<{ id: string; cell: PF1eCell }> = [];

  for (const token of input.tokens) {
    if (token._id === provoker._id) continue;
    if (isEnemy !== undefined && !isEnemy(token._id, provoker._id)) continue;
    const entry = threatOf.get(token._id);
    if (entry === undefined) continue;
    const threatened = new Set(entry.threatKeys);
    const cell = squares.find((c) => threatened.has(cellKey(c)));
    if (cell === undefined) continue;

    const ledger = input.ledgers?.[token._id];
    const used = ledger === undefined ? null : ledger.used;
    const max = ledger === undefined ? null : ledger.max;
    let refusal =
      ledger === undefined
        ? null
        : aooRefusal({ used: ledger.used, budgetMax: ledger.max });
    const rect = areaPreviewRects([cell], areaGrid)[0] ?? {
      x: 0,
      y: 0,
      size: areaGrid.cellSize,
    };
    if (refusal === null && input.coverWalls !== undefined) {
      const reactorCells = (entry.cells ?? []).map(parseCellKey);
      const cover = coverBetween({
        attackerCells: reactorCells,
        defenderCells: squares,
        grid: areaGrid,
        walls: input.coverWalls,
        creatureCells: input.tokens
          .filter((t) => t._id !== token._id && t._id !== provoker._id)
          .flatMap((t) => tokenCells(t, areaGrid)),
        ranged: footprintDistance(reactorCells, squares) > 1,
      });
      if (cover.kind !== "none") {
        refusal =
          "the provoker has cover — you can't execute an attack of opportunity against an opponent with cover (AoN 181)";
      }
    }
    reactors.push({
      tokenId: token._id,
      cell: cellKey(cell),
      rect,
      used,
      max,
      line:
        refusal === null
          ? `${token._id} may strike ${provoker._id} as it acts (${cellKey(cell)})`
          : `${token._id} forgoes the attack of opportunity — ${refusal}`,
    });
    if (refusal === null) eligible.push({ id: token._id, cell });
    else refused.push({ tokenId: token._id, reason: refusal });
  }

  // The interrupt records *where* the provoker stood. Like `queueMovementAoOs`, each
  // reactor is queued with the square it threatens, so a multi-square provoker attacked
  // from two sides carries two honest squares, and the queue stays self-describing (a
  // caller that resolves it needs no geometry of its own).
  const actionId =
    input.trigger !== undefined
      ? `action:${turn}:${input.provoker.tokenId}:${input.trigger.kind}`
      : `${input.actionId}:${turn}:${input.provoker.tokenId}`;
  const withAt = (cell: PF1eCell): PF1eAoOTrigger => ({
    ...trigger,
    at: { x: cell.col * areaGrid.cellSize, y: cell.row * areaGrid.cellSize },
  });

  let queue = input.queue ?? createInterruptQueue(turn, "action");
  const queued: PF1eInterrupt[] = [];
  for (const reactor of eligible) {
    const result = queueAoOs(queue, {
      turn,
      substep: "action",
      provokerId: input.provoker.tokenId,
      actionId,
      trigger: withAt(reactor.cell),
      reactors: [{ id: reactor.id }],
    });
    queue = result.queue;
    queued.push(...result.queued);
  }

  return {
    ok: true,
    issues: [],
    defaults,
    grid: areaGrid,
    refusal: null,
    trigger,
    squares: squares.map(cellKey),
    rects: areaPreviewRects(squares, areaGrid),
    reactors,
    refused,
    queue,
    queued,
  };
}

/**
 * The log lines for a reported (not yet resolved) action opportunity: every reactor that
 * may strike, every reactor that forgoes with its reason, and the caller's named
 * assumption — the same report the movement seam's `reactors`/`refused` carry, so the two
 * reads of the queue read alike.
 */
export function actionProvokeLines(
  opportunity: PF1eActionOpportunityResult,
  opts: { hostilityAssumed?: boolean } = {},
): string[] {
  const lines: string[] = [];
  for (const reactor of opportunity.reactors) lines.push(reactor.line);
  const assumption =
    opts.hostilityAssumed === true
      ? ["(hostility assumed — tokens without a disposition)"]
      : [];
  return lines.concat(assumption);
}

function parseCellKey(key: string): PF1eCell {
  const [col, row] = key.split(",").map((n) => Number.parseInt(n, 10));
  return { col: col ?? 0, row: row ?? 0 };
}
