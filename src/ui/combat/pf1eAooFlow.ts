/**
 * P06/D-186 — **auto-resolution** of the movement attacks of opportunity the tactical seam
 * queues (D-185), so the table does not have to hand-roll each one. This is what the world
 * option `autoResolveAoos` (`packages/pf1e/aooSettings.ts`) turns on, and it is on unless a
 * world explicitly turns it off.
 *
 * The rules order is the whole point of this module, and the caller keeps it: the
 * opportunity resolves **before** the mover leaves the square (AoN 102: "If an attack of
 * opportunity is provoked, immediately resolve the attack of opportunity, then continue with
 * … the current turn"). The canvas holds the move Op while this runs (D-185's `onTokenMove`
 * `"cancel"`), so the attack is rolled from the geometry the mover was actually standing in,
 * and the caller submits the move only afterwards.
 *
 * What it does per queued interrupt, in resolution order (D-184's initiative convention, read
 * off the encounter; ties keep the queue's insertion order):
 *   1. resolve the reacting creature's **melee** attack — "an attack of opportunity is a
 *      single melee attack … at your normal attack bonus" — through the sheet's own
 *      `resolveAttackFlow`, so the roll, the threat/confirmation, the damage, the mitigation
 *      and the HP write are the same code path a sheet attack uses, and the public chat card
 *      is the same card, labelled with the opportunity;
 *   2. spend the reactor's ledger through `spendAttackOfOpportunityAuthorized`, which writes
 *      `aooUsed`/`aooMax` and whose refusal wording is `interrupts.aooRefusal`'s;
 *   3. report the outcome for the log and the caller's notification surface.
 *
 * Hit or miss, the budget is spent: "you can only make one attack of opportunity per round"
 * is the cost of reacting, not of connecting.
 *
 * What it deliberately does not do: it rolls no die itself (every die comes from the host's
 * roll protocol through `resolveAttackFlow`), it invents no budget (that is `actionBudget`'s,
 * which is `combatState`'s), and it never re-decides that a reactor *may* react — the queue
 * decided that; this module only carries it out. It does not move the token either.
 *
 * Named limitations. (1) **An encounter is required.** The budget is per round and per
 * combatant, so with no `combats` document there is no ledger to spend and nothing is
 * auto-resolved: the caller gets `needsEncounter: true` and falls back to reporting the
 * queue's lines, exactly as D-185 did. (2) A reactor whose only lines are **ranged** cannot
 * take the opportunity at all — that is reported as a skip with its reason rather than
 * resolved with a ranged line, and no budget is spent. (3) The attack carries no situational
 * modifiers of its own: the queue knows the square, not whether the provoker has cover or
 * concealed, and inventing a bonus here would be a second rules layer (cover and concealment
 * belong to P04, per its own open list). (4) An unarmed reactor's own strike provokes in
 * turn, which this flow does not recurse into: the queue is built for movement, and the
 * unarmed-provoke chain is P07's ordering work.
 */
import type { ActorDocument, CombatDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import {
  deriveFromDocuments,
  type PF1eDerived,
  type PF1eDerivedAttack,
} from "../../packages/pf1e/actor";
import { isFlatFootedByRound } from "../../packages/pf1e/combatState";
import { combinedTacticalEffects } from "../../packages/pf1e/effectOps";
import {
  orderInterrupts,
  type PF1eInterrupt,
} from "../../packages/pf1e/interrupts";
import { pf1eAttackRollGroups } from "../../packages/pf1e/rollData";
import type { PF1eMovementOpportunityResult } from "../../packages/pf1e/tacticalOpportunity";
import {
  combatantForToken,
  spendAttackOfOpportunityAuthorized,
} from "./actionBudget";
import {
  resolveAttackFlow,
  type ResolveFlowClient,
} from "../sheets/pf1eResolveFlow";

/** The scene-side facts this flow needs per token (a `TokenDocument` satisfies it). */
export interface AooTokenRef {
  _id: string;
  actorId?: string | null;
}

export interface MovementAooResolutionEntry {
  reactorId: string;
  provokerId: string;
  /** The square the provoker was attacked in (world units), from the queue's trigger. */
  square: { x: number; y: number } | null;
  combatantId: string | null;
  attackName: string;
  outcome: "miss" | "hit" | "crit";
  attackTotal: number;
  defenseAc: number;
  /** Damage dealt after mitigation. */
  damage: number;
  /** Set when the attack resolved but the ledger could not be spent (permission, …). */
  ledgerError: string | null;
  /** Set when the damage rolled but the HP write was refused. */
  hpWriteError: string | null;
  /** The ledger after the spend, when it was written. */
  used: number | null;
  max: number | null;
  /** The provoker's hit points across the attack (equal on a miss). */
  hpBefore: number;
  hpAfter: number;
  /** One line for the log: who struck whom, for how much, and the budget afterwards. */
  line: string;
}

export interface MovementAooResolution {
  entries: readonly MovementAooResolutionEntry[];
  /** Reactors the flow could not resolve, each with the reason — never a silent drop. */
  skipped: readonly { reactorId: string; provokerId: string; reason: string }[];
  /** True when there is no encounter, so nothing was resolved (see the module header). */
  needsEncounter: boolean;
  /** The first hard error (a roll that never arrived, a refused resolution). */
  error: string | null;
}

export interface MovementAooResolutionInput {
  opportunity: PF1eMovementOpportunityResult;
  combat: CombatDocument | null;
  actors: readonly ActorDocument[];
  /** The scene's tokens, for token → actor resolution. */
  tokens: readonly AooTokenRef[];
  /** Commit-reveal rolls (the sheet's Verify option); off by default like the sheet's. */
  verifiable?: boolean;
}

const actorOf = (
  tokenId: string,
  tokens: readonly AooTokenRef[],
  actors: readonly ActorDocument[],
): ActorDocument | null => {
  const token = tokens.find((t) => t._id === tokenId);
  const actorId = token?.actorId ?? null;
  if (actorId === null) return null;
  return actors.find((a) => a._id === actorId) ?? null;
};

/** Feat names as authored — the derivation and the roll groups read the same list. */
function featsOf(actor: ActorDocument): string[] {
  const pf1e = (actor.system as { pf1e?: { feats?: unknown } } | undefined)
    ?.pf1e;
  const feats = pf1e?.feats;
  if (Array.isArray(feats))
    return feats.filter((f): f is string => typeof f === "string");
  if (typeof feats === "string")
    return feats
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f !== "");
  return [];
}

/** How many attack lines the actor authored (0 ⇒ the lines shown are the unarmed fallback). */
function authoredAttackCount(actor: ActorDocument): number {
  const pf1e = (actor.system as { pf1e?: { attacks?: unknown } } | undefined)
    ?.pf1e;
  return Array.isArray(pf1e?.attacks) ? pf1e.attacks.length : 0;
}

/** Derive one creature with its conditions (both effect homes), for attack and defense. */
function derivedFor(
  actor: ActorDocument,
  combat: CombatDocument | null,
  combatantId: string | null,
): PF1eDerived {
  return deriveFromDocuments({
    actor: { system: actor.system as Record<string, unknown> },
    effects: combinedTacticalEffects(actor, combat, combatantId).effects,
  });
}

/**
 * The reactor's melee attack. "An attack of opportunity is a single melee attack": a
 * creature whose every line is ranged cannot make one, so this returns null and the caller
 * reports the skip.
 */
function meleeLine(derived: PF1eDerived): PF1eDerivedAttack | null {
  return derived.attacks.find((line) => !line.ranged) ?? null;
}

/**
 * The decision the caller must make **synchronously**, before it can hold or commit a move:
 * does the app resolve the queue (the world option is on *and* there is an encounter to
 * spend a per-round budget against), and if not, which lines does the table read?
 *
 * It lives here rather than in the Svelte handler so the toggle's behaviour is testable
 * without a browser: the handler is then only "ask, hold, resolve, report, commit".
 */
export type HeldMoveMode =
  /** The app resolves the queue itself, right now, and commits when it is done (D-186). */
  | "auto"
  /** The move is held and the table is asked, per reactor (D-187). */
  | "prompt"
  /** Nobody can spend anything here: report the queue's lines and let the move proceed. */
  | "report";

export interface HeldMovePlan {
  mode: HeldMoveMode;
  /** True when the app resolves the queue itself (`mode === "auto"`). */
  autoResolve: boolean;
  /** The lines to report; empty for `"auto"` and `"prompt"` (they have their own). */
  lines: string[];
}

export function planHeldMove(input: {
  opportunity: PF1eMovementOpportunityResult;
  /** The world option (`aooSettings.autoResolveAoosOf`). */
  autoResolve: boolean;
  /** Whether the caller found an encounter to spend against. */
  hasEncounter: boolean;
  /** True when the caller had to assume hostility — named, never silent (D-185). */
  hostilityAssumed?: boolean;
}): HeldMovePlan {
  const assumption =
    input.hostilityAssumed === true
      ? ["(hostility assumed — tokens without a disposition)"]
      : [];
  if (input.autoResolve && input.hasEncounter)
    return { mode: "auto", autoResolve: true, lines: [] };
  if (
    !input.autoResolve &&
    input.hasEncounter &&
    input.opportunity.queued.length > 0
  )
    // The world turned auto-resolution off and there is a ledger to spend: hold the move
    // and ask. The prompt shows the seam's own lines per reactor (D-187).
    return { mode: "prompt", autoResolve: false, lines: [] };
  const lines = input.opportunity.reactors.map((r) => r.line);
  if (input.autoResolve && !input.hasEncounter) {
    // The option asked for auto-resolution and there is nothing to spend: saying so is
    // the difference between "the table resolves this" and "the app silently did not".
    lines.push(
      "(no encounter — the AoO budget is per round and per combatant, so these were left to the table)",
    );
  }
  return {
    mode: "report",
    autoResolve: false,
    lines: lines.concat(assumption),
  };
}

/**
 * The log lines for a resolution that ran: every attack it made, every reactor it had to
 * skip with its reason, the first hard error, and the caller's named assumption.
 */
export function resolutionLines(
  resolution: MovementAooResolution,
  opts: { hostilityAssumed?: boolean } = {},
): string[] {
  const lines = resolution.entries.map((e) => e.line);
  for (const skip of resolution.skipped) {
    lines.push(
      `${skip.reactorId} forgoes the attack of opportunity — ${skip.reason}`,
    );
  }
  const assumption =
    opts.hostilityAssumed === true
      ? ["(hostility assumed — tokens without a disposition)"]
      : [];
  return lines.concat(assumption);
}

/** Resolve every queued opportunity for one move, in resolution order. */
export async function resolveMovementOpportunities(
  client: ResolveFlowClient,
  user: PermissionUser | null,
  input: MovementAooResolutionInput,
): Promise<MovementAooResolution> {
  const skipped: Array<{
    reactorId: string;
    provokerId: string;
    reason: string;
  }> = [];
  const entries: MovementAooResolutionEntry[] = [];
  const queued = input.opportunity.queued;
  if (queued.length === 0)
    return { entries, skipped, needsEncounter: false, error: null };
  if (input.combat === null) {
    // No ledger, no initiative, no round: the budget cannot be spent, so the table keeps
    // the decision and the caller reports the queue's lines as it did before this slice.
    return {
      entries,
      skipped: queued.map((q) => ({
        reactorId: q.reactorId,
        provokerId: q.provokerId,
        reason: "no encounter — the AoO budget is per round and per combatant",
      })),
      needsEncounter: true,
      error: null,
    };
  }

  // D-184's ordering convention, read off the encounter: higher initiative first, ties in
  // the queue's own insertion order.
  const initiativeOf = (reactorId: string): number => {
    const combatant = combatantForToken(
      input.combat as CombatDocument,
      reactorId,
    );
    const value = combatant?.initiative;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const ordered: PF1eInterrupt[] = orderInterrupts(queued, { initiativeOf });

  let currentCombat: CombatDocument = input.combat;
  let error: string | null = null;
  for (const interrupt of ordered) {
    const reactor = actorOf(interrupt.reactorId, input.tokens, input.actors);
    const provoker = actorOf(interrupt.provokerId, input.tokens, input.actors);
    if (reactor === null || provoker === null) {
      skipped.push({
        reactorId: interrupt.reactorId,
        provokerId: interrupt.provokerId,
        reason:
          reactor === null
            ? "the reacting token has no actor document to derive an attack from"
            : "the provoking token has no actor document to defend with",
      });
      continue;
    }
    const reactorCombatant = combatantForToken(
      currentCombat,
      interrupt.reactorId,
    );
    const provokerCombatant = combatantForToken(
      currentCombat,
      interrupt.provokerId,
    );
    const reactorDerived = derivedFor(
      reactor,
      currentCombat,
      reactorCombatant?._id ?? null,
    );
    const provokerDerived = derivedFor(
      provoker,
      currentCombat,
      provokerCombatant?._id ?? null,
    );
    const base = meleeLine(reactorDerived);
    if (base === null) {
      skipped.push({
        reactorId: interrupt.reactorId,
        provokerId: interrupt.provokerId,
        reason:
          "no melee attack line — an attack of opportunity is a single melee attack, so no attack was made and no opportunity was spent",
      });
      continue;
    }
    // The card must say why this attack happened; the roll and the resolution are the
    // sheet's own, so only the line's label differs.
    const line: PF1eDerivedAttack = {
      ...base,
      name: `${base.name} — attack of opportunity`,
    };
    const feats = featsOf(reactor);
    const authored = authoredAttackCount(reactor);
    const groups = pf1eAttackRollGroups(reactorDerived, {
      authoredAttacksCount: authored,
      feats,
    });
    const group = groups[reactorDerived.attacks.indexOf(base)];
    if (group === undefined) {
      skipped.push({
        reactorId: interrupt.reactorId,
        provokerId: interrupt.provokerId,
        reason: "the reaction produced no attack group",
      });
      continue;
    }

    // The provoker's defense: flat-footed while it has not acted yet in this encounter
    // (A.1's round structure) — the one defense fact the queue's geometry cannot supply.
    const flatFooted =
      provokerCombatant !== null &&
      isFlatFootedByRound(currentCombat, provokerCombatant).flatFooted;

    const outcome = await resolveAttackFlow(client, user, {
      attackerName: reactor.name,
      line,
      iterative: 0,
      attackFormula: group.attack.formula,
      damageFormula: group.damage?.formula ?? "0",
      critDamageFormula: group.critDamage?.formula ?? null,
      targetName: provoker.name,
      targetActor: provoker,
      targetDerived: provokerDerived,
      defense: flatFooted ? "flatFooted" : "normal",
      ...(authored === 0 ? { unarmed: true } : {}),
      ...(feats.length > 0 ? { feats } : {}),
      ...(input.verifiable === true ? { verifiable: true } : {}),
    });
    if (!outcome.ok) {
      error = error ?? outcome.error;
      skipped.push({
        reactorId: interrupt.reactorId,
        provokerId: interrupt.provokerId,
        reason: `the attack could not be resolved: ${outcome.error}`,
      });
      continue;
    }
    const result = outcome.result;
    if (!result.ok) {
      // `resolveAttackFlow` composes the same resolution the sheet does; a refusal here is
      // the refusal the sheet would have shown, reported rather than swallowed.
      error = error ?? result.error;
      skipped.push({
        reactorId: interrupt.reactorId,
        provokerId: interrupt.provokerId,
        reason: `the attack was refused: ${result.error}`,
      });
      continue;
    }

    // The budget is spent by the fact of the attack, hit or miss — reacting is the cost.
    let ledgerError: string | null = null;
    let used: number | null = null;
    let max: number | null = null;
    if (reactorCombatant === null) {
      ledgerError = "the reacting token is not a combatant in this encounter";
    } else {
      const spent = spendAttackOfOpportunityAuthorized(
        currentCombat,
        reactorCombatant._id,
        user,
        input.actors,
        { reason: "movement" },
      );
      if (spent.error !== null || spent.combat === null) {
        ledgerError = spent.error ?? "the ledger could not be written";
      } else {
        currentCombat = spent.combat;
        if (spent.ops.length > 0) client.submit(spent.ops);
        used = spent.budget?.used ?? null;
        max = spent.budget?.max ?? null;
      }
    }
    const damage = result.damage?.dealt ?? 0;
    entries.push({
      reactorId: interrupt.reactorId,
      provokerId: interrupt.provokerId,
      square: interrupt.trigger.left ?? null,
      combatantId: reactorCombatant?._id ?? null,
      attackName: line.name,
      outcome: result.outcome,
      attackTotal: result.attackTotal,
      defenseAc: result.defenseAc,
      damage,
      ledgerError,
      hpWriteError: outcome.hpWriteError,
      used,
      max,
      hpBefore: result.hp.before,
      hpAfter: result.hp.after,
      line:
        `${reactor.name} ${result.outcome === "miss" ? "misses" : result.outcome === "crit" ? "critically hits" : "hits"} ` +
        `${provoker.name} for ${damage} (${result.attackTotal} vs AC ${result.defenseAc})` +
        (ledgerError === null && used !== null && max !== null
          ? ` — ${used}/${max} opportunities this round`
          : ledgerError !== null
            ? ` — the ledger was not written: ${ledgerError}`
            : ""),
    });
    // A refused HP write (a resolver without permission) is reported but never hides the
    // attack that already happened: the card and this entry both carry it.
    if (outcome.hpWriteError !== null) error = error ?? outcome.hpWriteError;
  }
  return { entries, skipped, needsEncounter: false, error };
}
