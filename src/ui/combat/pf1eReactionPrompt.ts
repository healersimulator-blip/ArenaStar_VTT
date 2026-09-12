/**
 * P06/D-187 — **the manual prompt**: the table's half of the movement attack of opportunity.
 *
 * D-186 gave the app the ability to resolve the queue itself, which is the default. This
 * module is the path for the worlds that turn that off (and for the case where the app
 * *cannot* spend — no encounter): the drag is held, and the GM is asked, per reactor,
 * whether the creature strikes. Every answer is a real resolution through the same flow:
 * "strike" runs `resolveMovementOpportunities` on **that reactor's** queued interrupts and
 * spends its ledger; "let it pass" is the rules' own option ("you *may* make an attack of
 * opportunity", AoN 102) and spends nothing; "stay put" drops the move entirely.
 *
 * Why the state machine is pure and separate. The GM's decision has to survive the rolls it
 * triggers (an async resolution, a re-render, a second look at the prompt), and it has to be
 * testable without a browser: a prompt whose rows, settledness and filtered queue live in a
 * Svelte component is a prompt whose bugs only a human dragging a token will find. So
 * everything here is data in, data out; the component only holds the current value and
 * calls `resolveMovementOpportunities` when the GM says strike.
 *
 * What it does not do: it does not decide *whether* a reactor may react (the queue did,
 * D-185), it does not roll (the flow does, from the host's protocol), and it does not move
 * the token (the held move's own `commit` does, once the prompt is settled or forgone).
 */
import type { PF1eMovementOpportunityResult } from "../../packages/pf1e/tacticalOpportunity";

/** One reactor awaiting the table's answer. */
export interface ReactionPromptRow {
  reactorId: string;
  /** The square the mover left that this reactor threatens, in `cellKey` form. */
  cell: string;
  /** The seam's own line (D-185's wording) — what the GM reads before deciding. */
  line: string;
  used: number | null;
  max: number | null;
  /** How many interrupts this reactor's answer covers (usually one). */
  queued: number;
}

/** A held move whose queue is waiting on the table. */
export interface PendingReaction {
  /**
   * The scene the held move belongs to. A prompt that outlives its scene (a scene switch,
   * an undo) must not resolve against a different one, so the caller compares this.
   */
  sceneId: string;
  /** The seam's verdict, exactly as the drag produced it. */
  opportunity: PF1eMovementOpportunityResult;
  /** The encounter the ledger is spent against, or null when there is none to spend. */
  combatId: string | null;
  /** Reactors the GM has already answered for (struck or forgiven). */
  decided: readonly string[];
  /** Whether the caller had to assume hostility — carried into every log line. */
  hostilityAssumed: boolean;
}

/** Open the prompt for a held move. The queue's own reactors are the prompt's rows. */
export function openReaction(input: {
  sceneId: string;
  opportunity: PF1eMovementOpportunityResult;
  combatId: string | null;
  hostilityAssumed?: boolean;
}): PendingReaction {
  return {
    sceneId: input.sceneId,
    opportunity: input.opportunity,
    combatId: input.combatId,
    decided: [],
    hostilityAssumed: input.hostilityAssumed === true,
  };
}

/**
 * The reactors still awaiting an answer, in the seam's order — the rows the prompt shows.
 * A reactor with no interrupts (the queue deduped it away) is not asked about.
 */
export function pendingRows(pending: PendingReaction): ReactionPromptRow[] {
  const decided = new Set(pending.decided);
  return pending.opportunity.reactors
    .filter((r) => !decided.has(r.tokenId))
    .filter((r) =>
      pending.opportunity.queued.some((q) => q.reactorId === r.tokenId),
    )
    .map((r) => ({
      reactorId: r.tokenId,
      cell: r.cell,
      line: r.line,
      used: r.used,
      max: r.max,
      queued: pending.opportunity.queued.filter(
        (q) => q.reactorId === r.tokenId,
      ).length,
    }));
}

/** True when every reactor in the queue has been answered for. */
export function isSettled(pending: PendingReaction): boolean {
  return pending.opportunity.queued.every((q) =>
    pending.decided.includes(q.reactorId),
  );
}

/** Record the GM's answer for one reactor (idempotent — a double click cannot double-count). */
export function decideReactor(
  pending: PendingReaction,
  reactorId: string,
): PendingReaction {
  if (pending.decided.includes(reactorId)) return pending;
  return { ...pending, decided: [...pending.decided, reactorId] };
}

/**
 * "Let it pass": answer for every reactor still pending without spending anything. The
 * opportunity is optional by the rules, and a table that wants none of it should need one
 * click, not one per creature.
 */
export function forgoReaction(pending: PendingReaction): PendingReaction {
  const decided = [...pending.decided];
  for (const q of pending.opportunity.queued) {
    if (!decided.includes(q.reactorId)) decided.push(q.reactorId);
  }
  return { ...pending, decided };
}

/**
 * The verdict narrowed to one reactor's interrupts. `resolveMovementOpportunities` resolves
 * a queue; the prompt answers per reactor, so this is the queue it gets — the reactors and
 * refusals lists travel unchanged (they describe the scene, not the decision).
 */
export function opportunityForReactor(
  pending: PendingReaction,
  reactorId: string,
): PF1eMovementOpportunityResult {
  return {
    ...pending.opportunity,
    queued: pending.opportunity.queued.filter((q) => q.reactorId === reactorId),
  };
}

/**
 * The lines the prompt itself contributes to the log: the reactors it decided *not* to
 * strike. Strikes are reported by the resolution (its own entries), so they are not
 * duplicated here.
 */
export function forgoLines(
  pending: PendingReaction,
  reactorIds?: readonly string[],
): string[] {
  const rows = pendingRows(pending).filter(
    (row) => reactorIds === undefined || reactorIds.includes(row.reactorId),
  );
  return rows.map(
    (row) =>
      `${row.reactorId} forgoes the attack of opportunity in (${row.cell}) (the table passed)`,
  );
}

/** A stable key for the prompt's element, so a spec (and the log) can name the held move. */
export function pendingReactionKey(pending: PendingReaction): string {
  return `${pending.sceneId}:${pending.opportunity.path.join(">")}:${pending.opportunity.queued
    .map((q) => q.id)
    .join(",")}`;
}
