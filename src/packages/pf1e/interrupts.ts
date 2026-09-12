/**
 * PF1e **interrupts** — the queue attacks of opportunity resolve through (P06, D-184). The
 * module owns the *order* and the *legality* of an interrupt; it rolls nothing, writes no
 * actor state and knows nothing about tokens, pools or sheets, so both scales use it: the
 * tactical tracker spends `combatState`'s per-combatant ledger, the strategic sim spends
 * `sys.aooUsed`.
 *
 * **Verified transcription** (Archives of Nethys, fetched and re-read 2026-09-12):
 *
 * AoN Rules ID 102 — "Attacks of Opportunity", CRB p.180:
 *   "Two kinds of actions can provoke attacks of opportunity: moving out of a threatened
 *    square and performing certain actions within a threatened square."
 *   "Moving out of a threatened square usually provokes attacks of opportunity from
 *    threatening opponents. There are two common methods of avoiding such an attack — the
 *    5-foot step and the withdraw action."
 *   "An attack of opportunity is a single melee attack, and most characters can only make
 *    one per round. You don't have to make an attack of opportunity if you don't want to.
 *    You make your attack of opportunity at your normal attack bonus, even if you've
 *    already attacked in the round."
 *   "An attack of opportunity 'interrupts' the normal flow of actions in the round. If an
 *    attack of opportunity is provoked, immediately resolve the attack of opportunity,
 *    then continue with the next character's turn (or complete the current turn, if the
 *    attack of opportunity was provoked in the midst of a character's turn)."
 *   "If you have the Combat Reflexes feat, you can add your Dexterity bonus to the number
 *    of attacks of opportunity you can make in a round. This feat does not let you make
 *    more than one attack for a given opportunity, but if the same opponent provokes two
 *    attacks of opportunity from you, you could make two separate attacks of opportunity
 *    (since each one represents a different opportunity). Moving out of more than one
 *    square threatened by the same opponent in the same round doesn't count as more than
 *    one opportunity for that opponent. All these attacks are at your full normal attack
 *    bonus."
 *
 * AoN Rules ID 151 — "Withdraw", CRB p.188:
 *   "The square you start out in is not considered threatened by any opponent you can see,
 *    and therefore visible enemies do not get attacks of opportunity against you when you
 *    move from that square. Invisible enemies still get attacks of opportunity against
 *    you, and you can't withdraw from combat if you're blinded. … If, during the process
 *    of withdrawing, you move out of a threatened square (other than the one you started
 *    in), enemies get attacks of opportunity as normal."
 *
 * AoN Rules ID 135 — "Total Defense", CRB p.185:
 *   "You can't make attacks of opportunity while using total defense."
 *
 * AoN Rules ID 147 — "Cast a Spell" (full-round/full-round-and-longer casting), CRB p.187:
 *   "You only provoke attacks of opportunity when you begin casting a spell, even though
 *    you might continue casting for at least 1 full round. While casting a spell, you
 *    don't threaten any squares around you."
 *
 * AoN Rules ID 133 — "Cast a Spell" (standard action), CRB p.183:
 *   "Ranged touch attacks provoke an attack of opportunity, even if the spell that causes
 *    the attacks was cast defensively."
 *   "If you take damage from an attack of opportunity, you must make a concentration check
 *    (DC 10 + points of damage taken + the spell's level) or lose the spell."
 *
 * AoN Rules ID 161 — "Take 5-Foot Step", CRB p.189:
 *   "Taking this 5-foot step never provokes an attack of opportunity."
 *
 * The provoke *table* is not retranscribed here: `actions.ts` already carries the verified
 * Table 7-2, and `actionTrigger` reads that table rather than keeping a second copy of its
 * flags. The budget is `rulesTables.attacksOfOpportunityPerRound` for the same reason
 * (D-183 corrected it against the Combat Reflexes entry: one per round, plus the Dexterity
 * bonus with the feat).
 *
 * **What the queue guarantees.**
 *   • **One opportunity per (reactor, action).** A creature that leaves three squares an
 *     opponent threatens provokes one attack from that opponent, not three (AoN 102,
 *     "Moving out of more than one square threatened by the same opponent in the same
 *     round doesn't count as more than one opportunity"). Two *different* provoking actions
 *     — a move and then a ranged attack — are two opportunities, and the queue accepts both.
 *   • **The withdraw exemption** is applied where the rule applies it: to the square the
 *     withdrawing creature started in, and to nothing else ("other than the one you started
 *     in").
 *   • **The damage is carried with the interrupt**, because the rules make it matter:
 *     "If you take damage from an attack of opportunity, you must make a concentration
 *     check (DC 10 + points of damage taken + the spell's level) or lose the spell." The
 *     queue records what the reactor dealt so the caller can feed that check — it does not
 *     compute the check itself (`concentrationDc` owns that formula).
 *
 * **What it deliberately does not do.** The 5-foot step's exemption is a *kind* of movement
 * (`squaresLeft` is simply never called for a step, and the trigger table has no step row);
 * visibility is not modelled (`withdraw` is exempt for every reactor the caller passes,
 * and a reactor the mover cannot see is the caller's to exclude); "you don't have to make
 * an attack of opportunity" is a choice the caller makes by not queuing.
 *
 * **Ordering is a table convention, not transcribed text.** The rules say an opportunity
 * is resolved immediately, and say nothing about which of two creatures reacts first when
 * both threaten the same square. `orderInterrupts` keeps the caller's own order by default
 * (the order the reactors were listed) and, when the caller supplies initiative, resolves
 * higher initiative first with ties keeping insertion order. That choice is named here so a
 * table can see it and override it.
 */
import type { PF1eCell } from "./targeting";
import { pf1eActionById, type PF1eProvokes } from "./actions";

/** The interrupt kinds the queue speaks. Readied actions are P06's second half (G §4.11). */
export type PF1eInterruptKind = "attack-of-opportunity";

export type PF1eAoOTriggerKind =
  "move-out" | "provoking-action" | "ranged-touch";

export interface PF1eAoOTrigger {
  kind: PF1eAoOTriggerKind;
  /** `provoking-action`: the Table 7-2 row's id in `PF1E_ACTIONS`. */
  actionId?: string;
  /** `move-out`: the square (feet) the provoker walked out of. */
  left?: { x: number; y: number };
  /**
   * `provoking-action`/`ranged-touch`: the square (feet) the provoker occupied
   * when it acted. The rules attack the provoker *in place* — \"if an attack of
   * opportunity is provoked, immediately resolve the attack\" — so the interrupt
   * carries where it happened, exactly as `left` does for a move.
   */
  at?: { x: number; y: number };
  /** `move-out`: true when this square is the exempt start square of a withdraw. */
  withdrawExempt?: boolean;
}

export interface PF1eInterrupt {
  /** Stable for replay: `${turn}:${substep}:${reactorId}:${provokerId}:${actionId}:${n}`. */
  id: string;
  kind: PF1eInterruptKind;
  /** The creature that reacts — the one whose budget is spent. */
  reactorId: string;
  /** The creature whose action provoked. */
  provokerId: string;
  /** The triggering action: the dedupe unit, so one action can provoke at most once each. */
  actionId: string;
  trigger: PF1eAoOTrigger;
  turn: number;
  substep: string;
  /** Insertion order, kept so the default ordering is the caller's. */
  sequence: number;
}

export interface PF1eInterruptQueue {
  turn: number;
  substep: string;
  /** Unresolved interrupts, in resolution order. */
  interrupts: PF1eInterrupt[];
}

export interface PF1eAoOReactor {
  id: string;
  name?: string;
}

export interface PF1eAoORequest {
  turn: number;
  substep: string;
  /** The creature whose action provoked. */
  provokerId: string;
  /** The triggering action's own id (a move order's id, an attack's id, a cast's id…). */
  actionId: string;
  trigger: PF1eAoOTrigger;
  /** Reactors, in the caller's order. The caller has already excluded the ineligible. */
  reactors: readonly PF1eAoOReactor[];
}

export interface PF1eAoOQueueResult {
  queue: PF1eInterruptQueue;
  queued: PF1eInterrupt[];
  /** Reactors that got no interrupt, with the reason (dedupe or eligibility). */
  refused: Array<{ reactorId: string; reason: string }>;
  /**
   * Squares the move walked out of, in travel order (empty for non-movement triggers).
   * Reported so a caller can narrate *where* the opportunity happened.
   */
  squaresLeft: Array<{ x: number; y: number }>;
}

/** An empty queue for a turn/substep. */
export function createInterruptQueue(
  turn = 1,
  substep = "start",
): PF1eInterruptQueue {
  return { turn, substep, interrupts: [] };
}

/**
 * The squares a walk leaves, from the cells `cellsAlongSegment` reports: everything but
 * the square it ends in — and, for a withdraw, everything but the square it started in as
 * well (AoN 151's "other than the one you started in" — the exemption is that one square,
 * so leaving a second threatened square still provokes).
 */
export function squaresLeft(
  path: readonly PF1eCell[],
  opts: { withdraw?: boolean } = {},
): PF1eCell[] {
  const walked = path.slice(0, Math.max(0, path.length - 1));
  return opts.withdraw === true ? walked.slice(1) : walked;
}

/**
 * The eligibility of one reactor for one opportunity. Returns null when it may react, or
 * the reason it may not — a reason string is the product's language, and the caller puts
 * it in the log rather than silently dropping the reaction.
 *
 * Every clause is a verified rule; the caller supplies the state it knows. `budgetMax`
 * comes from `rulesTables.attacksOfOpportunityPerRound`, so the numbers cannot drift.
 */
export interface PF1eAoOState {
  /**
   * The **derivation's** own combined refusal (`PF1eDerived.canTakeAoO`, D-183): a
   * helpless creature, a creature that threatens nothing, a character without Combat
   * Reflexes while flat-footed — the states the sheet already folds into one boolean.
   * Passed here so the tactical panel and this queue refuse with one vocabulary
   * (D-185) instead of the UI inventing its own wording.
   */
  cannotTakeAoO?: boolean;
  /** The Flat-Footed condition: "cannot make attacks of opportunity" (conditions.ts). */
  flatFooted?: boolean;
  /** Combat Reflexes: "you may also make attacks of opportunity while flat-footed". */
  combatReflexes?: boolean;
  /** Total defense: "You can't make attacks of opportunity while using total defense." */
  totalDefense?: boolean;
  /**
   * "You threaten all squares into which you can make a melee attack" — a creature that
   * threatens nothing (0 reach: unarmed, or a sub-square creature) has no squares to
   * react in.
   */
  threatensSquares?: boolean;
  /** While casting a spell "you don't threaten any squares around you" (AoN 147). */
  casting?: boolean;
  /** Dead, unconscious, helpless, paralyzed, stunned… — the caller's own state. */
  incapacitated?: boolean;
  /** Opportunities already spent this round, and the round's budget. */
  used?: number;
  budgetMax?: number;
}

export function aooRefusal(state: PF1eAoOState): string | null {
  if (state.cannotTakeAoO === true) return "cannot take attacks of opportunity";
  if (state.incapacitated === true) return "cannot act";
  if (state.threatensSquares === false) return "threatens no squares";
  if (state.casting === true) return "casting a spell — does not threaten";
  if (state.totalDefense === true) return "using total defense";
  if (state.flatFooted === true && state.combatReflexes !== true) {
    return "flat-footed (no Combat Reflexes)";
  }
  const used = state.used ?? 0;
  const max = state.budgetMax ?? 1;
  if (used >= max) return `no opportunities left (${used}/${max})`;
  return null;
}

/**
 * Queue the attacks of opportunity one provoking action earns. Pure: the returned queue is
 * a new object, and nothing is spent here — the caller spends the reactor's budget when it
 * resolves the interrupt (`resolveNextInterrupt`), which is what makes the queue and the
 * ledger agree.
 *
 * Dedupe is per (reactor, `actionId`): the same reactor is refused for the same action, so
 * a creature that walks out of three threatened squares provokes once from that opponent.
 */
export function queueAoOs(
  queue: PF1eInterruptQueue,
  request: PF1eAoORequest,
): PF1eAoOQueueResult {
  const already = new Set(
    queue.interrupts
      .filter((i) => i.actionId === request.actionId)
      .map((i) => i.reactorId),
  );
  const queued: PF1eInterrupt[] = [];
  const refused: Array<{ reactorId: string; reason: string }> = [];
  let sequence = queue.interrupts.length;
  for (const reactor of request.reactors) {
    if (
      already.has(reactor.id) ||
      queued.some((i) => i.reactorId === reactor.id)
    ) {
      refused.push({
        reactorId: reactor.id,
        reason: "already provoked by this action",
      });
      continue;
    }
    queued.push({
      id: `${request.turn}:${request.substep}:${reactor.id}:${request.provokerId}:${
        request.actionId
      }:${sequence}`,
      kind: "attack-of-opportunity",
      reactorId: reactor.id,
      provokerId: request.provokerId,
      actionId: request.actionId,
      trigger: request.trigger,
      turn: request.turn,
      substep: request.substep,
      sequence,
    });
    sequence++;
  }
  return {
    queue: { ...queue, interrupts: [...queue.interrupts, ...queued] },
    queued,
    refused,
    squaresLeft: [],
  };
}

/**
 * Queue the opportunities a *movement* earns (AoN 102's "Moving out of a threatened square
 * usually provokes"). One call per moving creature per move action: the walk's left squares
 * are tested against each reactor's own threat, and a reactor is queued at most once no
 * matter how many of its squares the mover walked out of.
 *
 * `threatens` is the caller's geometry — at the tactical scale a `threatenedCells` set, at
 * the strategic scale the same thing derived from unit reach (D-180). The module never
 * guesses reach.
 */
export function queueMovementAoOs(
  queue: PF1eInterruptQueue,
  request: {
    turn: number;
    substep: string;
    moverId: string;
    actionId: string;
    /** The walk, from `geometry.cellsAlongSegment`. */
    path: readonly PF1eCell[];
    /** A withdraw exempts the square the mover started in (AoN 151). */
    withdraw?: boolean;
    cellFeet: number;
    reactors: ReadonlyArray<{
      id: string;
      name?: string;
      /** Does this reactor threaten `cell`? */
      threatens: (cell: PF1eCell) => boolean;
    }>;
  },
): PF1eAoOQueueResult {
  const left = squaresLeft(
    request.path,
    request.withdraw === undefined ? {} : { withdraw: request.withdraw },
  );
  if (left.length === 0) {
    return { queue, queued: [], refused: [], squaresLeft: [] };
  }
  const inReach: Array<PF1eAoOReactor & { cell: PF1eCell }> = [];
  const refused: Array<{ reactorId: string; reason: string }> = [];
  for (const reactor of request.reactors) {
    // The *first* square of the walk that this reactor threatens decided it: the provoker
    // is attacked where it stood, not where it ends up (the opportunity interrupts the
    // move). The reported square is the one the log names.
    const cell = left.find((c) => reactor.threatens(c));
    if (cell === undefined) {
      refused.push({
        reactorId: reactor.id,
        reason: "does not threaten a square the mover left",
      });
      continue;
    }
    inReach.push({ ...reactor, cell });
  }
  if (inReach.length === 0) {
    return { queue, queued: [], refused, squaresLeft: [] };
  }
  // A single move earns one opportunity per reactor, whichever square provoked it — but the
  // trigger records *which* square, so the log and the AoO's own reach stay honest. The
  // reactors are listed in the caller's order, so the queue keeps that order too.
  const moved = inReach.map((reactor) => ({
    id: reactor.id,
    name: reactor.name,
    cell: reactor.cell,
  }));
  const unique = new Map<string, { cell: PF1eCell; name?: string }>();
  for (const reactor of moved) {
    if (!unique.has(reactor.id)) {
      unique.set(reactor.id, {
        cell: reactor.cell,
        ...(reactor.name !== undefined ? { name: reactor.name } : {}),
      });
    }
  }
  const queued: PF1eInterrupt[] = [];
  const stillRefused = [...refused];
  let next = queue;
  for (const [reactorId, info] of unique) {
    const result = queueAoOs(next, {
      turn: request.turn,
      substep: request.substep,
      provokerId: request.moverId,
      actionId: request.actionId,
      trigger: {
        kind: "move-out",
        left: {
          x: info.cell.col * request.cellFeet,
          y: info.cell.row * request.cellFeet,
        },
      },
      reactors: [
        {
          id: reactorId,
          ...(info.name !== undefined ? { name: info.name } : {}),
        },
      ],
    });
    next = result.queue;
    queued.push(...result.queued);
    stillRefused.push(...result.refused);
  }
  return {
    queue: next,
    queued,
    refused: stillRefused,
    squaresLeft: left.map((c) => ({
      x: c.col * request.cellFeet,
      y: c.row * request.cellFeet,
    })),
  };
}

/**
 * The trigger for an action, read from Table 7-2 (`actions.ts` — never a second copy of the
 * flags). A row that provokes "usually"/"maybe"/"varies" is **refused rather than guessed**:
 * the table's own note says the judgement is the caller's, and this module does not invent a
 * rule the table declines to state.
 */
export function actionTrigger(
  actionId: string,
): { ok: true; trigger: PF1eAoOTrigger } | { ok: false; reason: string } {
  const row = pf1eActionById(actionId);
  if (row === null)
    return { ok: false, reason: `unknown action "${actionId}"` };
  if (row.provokes === "no") {
    return {
      ok: false,
      reason: `${row.name} does not provoke an attack of opportunity`,
    };
  }
  if (row.provokes !== "yes") {
    return {
      ok: false,
      reason: `${row.name} provokes "${row.provokes}"${
        row.note !== undefined ? ` — ${row.note}` : ""
      }: the caller decides`,
    };
  }
  return { ok: true, trigger: { kind: "provoking-action", actionId } };
}

/** The AoN 133 case: a ranged touch attack provokes, even from a defensively cast spell. */
export function rangedTouchTrigger(): PF1eAoOTrigger {
  return { kind: "ranged-touch" };
}

/** What Table 7-2 says about an action, for a caller that wants to ask without queuing. */
export function actionProvokes(actionId: string): PF1eProvokes | null {
  return pf1eActionById(actionId)?.provokes ?? null;
}

/**
 * Resolution order for the queue: the caller's own insertion order, or — when the caller
 * supplies initiative — higher initiative first with ties in insertion order (the named
 * table convention above, not transcribed text).
 */
export function orderInterrupts(
  interrupts: readonly PF1eInterrupt[],
  opts: { initiativeOf?: (reactorId: string) => number } = {},
): PF1eInterrupt[] {
  const byInsertion = [...interrupts].sort((a, b) => a.sequence - b.sequence);
  if (opts.initiativeOf === undefined) return byInsertion;
  const initiativeOf = opts.initiativeOf;
  return byInsertion.sort(
    (a, b) => initiativeOf(b.reactorId) - initiativeOf(a.reactorId),
  );
}

/** The interrupt that resolves next, or null when the queue is drained. */
export function nextInterrupt(
  queue: PF1eInterruptQueue,
  opts: { initiativeOf?: (reactorId: string) => number } = {},
): PF1eInterrupt | null {
  return orderInterrupts(queue.interrupts, opts)[0] ?? null;
}

/**
 * Take the next interrupt off the queue. The caller resolves it (rolls the attack, applies
 * the damage) and spends the reactor's budget; the returned interrupt carries the provoker,
 * the trigger and the square, which is everything the resolution and the log need. The
 * queue is pure data, so an interrupted round can be replayed from the same seed.
 */
export function resolveNextInterrupt(
  queue: PF1eInterruptQueue,
  opts: { initiativeOf?: (reactorId: string) => number } = {},
): { queue: PF1eInterruptQueue; interrupt: PF1eInterrupt | null } {
  const next = nextInterrupt(queue, opts);
  if (next === null) return { queue, interrupt: null };
  return {
    queue: {
      ...queue,
      interrupts: queue.interrupts.filter((i) => i.id !== next.id),
    },
    interrupt: next,
  };
}

/** Drop every interrupt of a finished turn/substep (a caller that abandoned the round). */
export function clearInterrupts(
  queue: PF1eInterruptQueue,
  turn: number,
): PF1eInterruptQueue {
  return {
    ...queue,
    interrupts: queue.interrupts.filter((i) => i.turn !== turn),
  };
}
