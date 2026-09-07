/**
 * PF1e **round structure** — the parts of the initiative system that core's combat tracker does not
 * model, kept as data under `combat.flags.pf1e` / `combatant.flags.pf1e` (D-112: no core field is
 * added; the FlagStore is the sanctioned extension point, see the note at the top of
 * `src/core/combat.ts`).
 *
 * Division of labour, deliberately lopsided in favour of core:
 *  - core owns `combat.round`, `combat.turn`, initiative ordering, defeated-skipping, delay, and the
 *    per-turn `flags.core.duration` tick (`core/combat.ts:nextTurn` → `tickEffects`);
 *  - this module owns what PF1e adds around it: the **surprise round** (a pre-round that core has no
 *    slot for, so it is resolved here and then handed to core's `startCombat`), **flat-footed until
 *    your first turn** (A.1), the **attacks-of-opportunity budget** (A.10, refreshed at the start of
 *    your turn), **held actions** (the "hold the charge" delivery order, A.10), and the **world clock**
 *    advance that makes "1 minute/level" mean something.
 *
 * Everything is pure: `(combat, state) → (combat, state)` plus hook names, exactly like core's
 * transitions, so the host can submit one diff and every client derives the same thing.
 */
import type {
  CombatDocument,
  CombatantDocument,
  Json,
} from "../../core/documents";
import { err, okVal, type Result } from "../../core/result";
import {
  currentCombatant,
  sortCombatants,
  startCombat,
  nextTurn,
} from "../../core/combat";
import { DEFAULT_SECONDS_PER_ROUND } from "../../core/worldSettings";

/** One combatant's entry under `combatant.flags.pf1e`. */
export type PF1eCombatantState = {
  /** Attacks of opportunity used this round; reset at the start of this combatant's turn (A.10). */
  aooUsed: number;
  /** Highest budget this round, from the derivation — cached here so the ledger is auditable. */
  aooMax: number;
  /** Held action, if any (A.10 "Hold the Charge"). */
  held: PF1eHeldAction | null;
  /** Has had a turn yet this combat? While false the combatant is flat-footed (A.1). */
  acted: boolean;
  /** Set while a surprise round caught this combatant unaware. */
  surprised: boolean;
};

export type PF1eHeldAction = {
  kind: "charge" | "attack" | "spell" | "maneuver";
  /** Round the hold began (mirrors `combat.round` at that moment). */
  since: number;
  /** Friendly turns taken before the holder's next turn; 6+ makes holding a full-round action. */
  alliesBefore: number;
  note?: string;
};

/** The round structure stored under `combat.flags.pf1e`. */
export type PF1eRoundState = {
  v: 1;
  phase: "setup" | "surprise" | "rounds" | "ended";
  /** Combatant ids in surprise-round order (only meaningful while `phase === "surprise"`). */
  surpriseOrder: string[];
  /** Index into `surpriseOrder`. */
  surpriseTurn: number;
  /** Every combatant caught flat-footed by the surprise round (A.1). */
  surprised: string[];
  /** Ids whose initiative was tied and how it broke (reroll = `null` value pending). */
  ties: Array<{ ids: string[]; resolvedBy: "dexterity" | "reroll-needed" }>;
  /** Elapsed world time in seconds; the clock the round timer and durations tick against. */
  clockSeconds: number;
  /** Seconds per round, from world settings (default 6, A.1). */
  secondsPerRound: number;
  /** Set when a round wrapped, so the caller knows to refresh per-round ledgers it also owns. */
  roundRolled: boolean;
};

const SCOPE = "pf1e";

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

function scopeFlags(
  doc: { flags?: unknown },
  scope: string,
): Record<string, unknown> {
  return asRecord(asRecord(doc.flags)[scope]);
}

/**
 * Read the round state off a combat document, tolerating absence and half-written data. Never
 * throws: an unparseable or half-written `flags.pf1e` falls back to the documented default per
 * field, which is what lets `App.svelte` render a combat created before PF1e existed.
 */
export function readRoundState(combat: CombatDocument): PF1eRoundState {
  const raw = scopeFlags(combat, SCOPE);
  const secondsPerRound =
    typeof raw.secondsPerRound === "number" &&
    Number.isFinite(raw.secondsPerRound) &&
    raw.secondsPerRound > 0
      ? Math.trunc(raw.secondsPerRound)
      : DEFAULT_SECONDS_PER_ROUND;
  const phase = raw.phase;
  return {
    v: 1,
    phase:
      phase === "surprise" ||
      phase === "rounds" ||
      phase === "ended" ||
      phase === "setup"
        ? phase
        : combat.round >= 1
          ? "rounds"
          : "setup",
    surpriseOrder: Array.isArray(raw.surpriseOrder)
      ? raw.surpriseOrder.filter((s): s is string => typeof s === "string")
      : [],
    surpriseTurn:
      typeof raw.surpriseTurn === "number" && raw.surpriseTurn > 0
        ? Math.trunc(raw.surpriseTurn)
        : 0,
    surprised: Array.isArray(raw.surprised)
      ? raw.surprised.filter((s): s is string => typeof s === "string")
      : [],
    ties: Array.isArray(raw.ties)
      ? raw.ties.flatMap((t) => {
          const o = asRecord(t);
          if (!Array.isArray(o.ids)) return [];
          const ids = o.ids.filter((s): s is string => typeof s === "string");
          return ids.length >= 2
            ? [
                {
                  ids,
                  resolvedBy:
                    o.resolvedBy === "reroll-needed"
                      ? ("reroll-needed" as const)
                      : ("dexterity" as const),
                },
              ]
            : [];
        })
      : [],
    clockSeconds:
      typeof raw.clockSeconds === "number" && Number.isFinite(raw.clockSeconds)
        ? Math.max(0, Math.trunc(raw.clockSeconds))
        : 0,
    secondsPerRound,
    roundRolled: raw.roundRolled === true,
  };
}

/**
 * The returned combat always carries the state that produced it, and this is the matching FlatDiff
 * entry for the `update` op that submits it (`diff: roundStateDiff(state)`).
 */
export function roundStateDiff(state: PF1eRoundState): Record<string, Json> {
  return { [`flags.${SCOPE}`]: { ...state } as unknown as Json };
}

/** The per-combatant variant, for `update` ops on a combatant. */
export function combatantStateDiff(
  state: PF1eCombatantState,
): Record<string, Json> {
  return { [`flags.${SCOPE}`]: { ...state } as unknown as Json };
}

/** Write the round state back onto a combat document, leaving every other scope alone. */
function withRoundState(
  combat: CombatDocument,
  state: PF1eRoundState,
): CombatDocument {
  return { ...combat, flags: { ...combat.flags, [SCOPE]: { ...state } } };
}

/** Per-combatant PF1e state, read defensively. */
export function readCombatantState(
  combatant: CombatantDocument,
): PF1eCombatantState {
  const raw = scopeFlags(combatant, SCOPE);
  const held = asRecord(raw.held);
  const kind = held.kind;
  return {
    aooUsed:
      typeof raw.aooUsed === "number" && raw.aooUsed > 0
        ? Math.trunc(raw.aooUsed)
        : 0,
    aooMax:
      typeof raw.aooMax === "number" && Number.isFinite(raw.aooMax)
        ? Math.trunc(raw.aooMax)
        : 0,
    acted: raw.acted === true,
    surprised: raw.surprised === true,
    held:
      kind === "charge" ||
      kind === "attack" ||
      kind === "spell" ||
      kind === "maneuver"
        ? {
            kind,
            since:
              typeof held.since === "number" && Number.isFinite(held.since)
                ? Math.trunc(held.since)
                : 0,
            alliesBefore:
              typeof held.alliesBefore === "number" && held.alliesBefore > 0
                ? Math.trunc(held.alliesBefore)
                : 0,
            ...(typeof held.note === "string" ? { note: held.note } : {}),
          }
        : null,
  };
}

export interface InitiativeRoll {
  combatantId: string;
  /** The Dexterity check result, as rolled by the dice engine. */
  value: number;
  /** Dexterity modifier, used to break ties (A.1: highest Dex bonus wins, else reroll). */
  dexMod?: number;
}

/** Half-point marker used to express a Dex tie-break inside core's integer-sorted initiative. */
export const INITIATIVE_TIE_MARKER = 0.5;

/** What the sheet and the log show for an initiative value: the die result, not the marker. */
export function initiativeDisplay(value: number | null): string {
  if (value === null) return "—";
  return String(Math.floor(value + 1e-9));
}

export interface ResolvedInitiative {
  /** `combatant._id → initiative`, ready for core's `applyInitiative`. */
  values: Record<string, number>;
  ties: PF1eRoundState["ties"];
  /** True when at least one tie could not be broken by Dexterity — those combatants must reroll. */
  needsReroll: boolean;
}

/**
 * Tie-breaking per A.1: highest Dexterity bonus wins; still tied ⇒ the SRD rerolls, so this reports
 * `needsReroll` instead of inventing an order. Equal rolls *and* equal Dex with no reroll is a
 * caller error, and the affected ids are listed so the UI can say "roll again".
 */
export function resolveInitiative(
  rolls: readonly InitiativeRoll[],
): ResolvedInitiative {
  const byValue = new Map<number, InitiativeRoll[]>();
  for (const r of rolls) {
    const list = byValue.get(r.value);
    if (list) list.push(r);
    else byValue.set(r.value, [r]);
  }
  const values: Record<string, number> = {};
  const ties: PF1eRoundState["ties"] = [];
  let needsReroll = false;
  for (const [value, group] of byValue) {
    for (const r of group) values[r.combatantId] = r.value;
    if (group.length < 2) continue;
    const best = Math.max(...group.map((r) => r.dexMod ?? 0));
    const winners = group.filter((r) => (r.dexMod ?? 0) === best);
    if (winners.length === 1) {
      // Core orders purely by `initiative`, so the tie must be expressed in that number. A 0.5
      // marker keeps the die result visible (`initiativeDisplay` floors it for the sheet) and cannot
      // collide with another combatant's whole-number roll.
      const winner = winners[0];
      if (winner) values[winner.combatantId] = value + INITIATIVE_TIE_MARKER;
      ties.push({
        ids: group.map((r) => r.combatantId),
        resolvedBy: "dexterity",
      });
      continue;
    }
    needsReroll = true;
    ties.push({
      ids: group.map((r) => r.combatantId),
      resolvedBy: "reroll-needed",
    });
  }
  return { values, ties, needsReroll };
}

export interface SurpriseCheck {
  /** Attacker id → authored Stealth result. */
  stealth: Record<string, number>;
  /** Target id → passive Perception. */
  perception: Record<string, number>;
}

export interface SurpriseOutcome {
  surpriseRound: boolean;
  /** Targets that were caught flat-footed (all of them when there is a surprise round — A.1). */
  flatFooted: string[];
  /** Why there was no surprise round, for the roll log. */
  note: string | null;
}

/**
 * Surprise round (A.1): it happens only when **every** attacker's Stealth beats **every** defender's
 * Perception; one defender seeing one attacker cancels it for everyone. Attackers act in initiative
 * order and each takes a move or standard action — no free actions beyond the usual, no full attack.
 */
export function checkSurprise(
  targets: readonly string[],
  check: SurpriseCheck,
): SurpriseOutcome {
  const attackers = Object.keys(check.stealth);
  if (attackers.length === 0 || targets.length === 0) {
    return {
      surpriseRound: false,
      flatFooted: [],
      note: "no stealth vs perception comparison was made",
    };
  }
  let lowestMargin = Number.POSITIVE_INFINITY;
  let seenBy: string | null = null;
  for (const target of targets) {
    const perception = check.perception[target];
    if (perception === undefined) continue; // unaware targets are skipped, not assumed to notice
    for (const attacker of attackers) {
      const margin = (check.stealth[attacker] ?? 0) - perception;
      if (margin < lowestMargin) {
        lowestMargin = margin;
        seenBy = margin <= 0 ? target : null;
      }
    }
  }
  if (seenBy !== null) {
    return {
      surpriseRound: false,
      flatFooted: [],
      note: `${seenBy} noticed at least one attacker — no surprise round`,
    };
  }
  return {
    surpriseRound: true,
    flatFooted: [...targets],
    note: null,
  };
}

/**
 * Begin combat: resolve initiative, decide the surprise round, and either enter it (round stays 0)
 * or hand the sorted combat to core's `startCombat`. `combat.round` is never written by us while a
 * surprise round is pending — that is what keeps `CombatPanel` honest about "not started yet".
 */
export function startWithSurprise(
  combat: CombatDocument,
  opts: {
    initiative: readonly InitiativeRoll[];
    targets?: readonly string[] | undefined;
    stealth?: Record<string, number> | undefined;
    perception?: Record<string, number> | undefined;
    secondsPerRound?: number | undefined;
    clockSeconds?: number | undefined;
  },
): {
  combat: CombatDocument;
  state: PF1eRoundState;
  hooks: string[];
  surprise: SurpriseOutcome | null;
} {
  const resolved = resolveInitiative(opts.initiative);
  const withInitiative = combat.combatants.map((c) =>
    c._id in resolved.values
      ? { ...c, initiative: resolved.values[c._id] as number }
      : c,
  );
  const base: PF1eRoundState = {
    ...readRoundState(combat),
    v: 1,
    ties: resolved.ties,
    secondsPerRound:
      opts.secondsPerRound ?? readRoundState(combat).secondsPerRound,
    clockSeconds: opts.clockSeconds ?? readRoundState(combat).clockSeconds,
    roundRolled: false,
  };
  const surprise =
    opts.stealth !== undefined && opts.perception !== undefined
      ? checkSurprise(opts.targets ?? withInitiative.map((c) => c._id), {
          stealth: opts.stealth,
          perception: opts.perception,
        })
      : null;

  if (surprise?.surpriseRound) {
    // Only the aware act in the surprise round (A.1); the flat-footed wait for round 1.
    const order = sortCombatants(withInitiative)
      .filter((c) => !c.defeated && !surprise.flatFooted.includes(c._id))
      .map((c) => c._id);
    const surpriseState: PF1eRoundState = {
      ...base,
      phase: "surprise",
      surpriseOrder: order,
      surpriseTurn: 0,
      surprised: surprise.flatFooted,
    };
    return {
      combat: withRoundState(
        { ...combat, combatants: withInitiative },
        surpriseState,
      ),
      state: surpriseState,
      hooks: ["combat:combatant:update", "pf1e:combat:surprise"],
      surprise,
    };
  }

  const started = startCombat({ ...combat, combatants: withInitiative });
  const combatants = started.combat.combatants.map((c) =>
    c._id === (currentCombatant(started.combat)?._id ?? "")
      ? {
          ...c,
          flags: {
            ...asRecord(c.flags),
            [SCOPE]: { ...readCombatantState(c), acted: true },
          },
        }
      : c,
  );
  const roundsState: PF1eRoundState = {
    ...base,
    phase: "rounds",
    surpriseOrder: [],
    surpriseTurn: 0,
    surprised: surprise?.flatFooted ?? [],
  };
  return {
    combat: withRoundState({ ...started.combat, combatants }, roundsState),
    state: roundsState,
    hooks: started.hooks,
    surprise,
  };
}

/**
 * Advance one turn. Inside a surprise round this walks `surpriseOrder` and does not touch core's
 * round/turn; when the surprise round ends it starts round 1 through core. Otherwise it delegates to
 * core's `nextTurn` (so `flags.core.duration` keeps ticking there) and then applies the PF1e round
 * boundaries: AoO refresh, held-action delivery, and the world clock.
 */
export function pf1eNextTurn(
  combat: CombatDocument,
  opts: { advanceClock?: boolean | undefined } = {},
): {
  combat: CombatDocument;
  state: PF1eRoundState;
  hooks: string[];
  expired: Array<{ combatantId: string; effectId: string }>;
  /** Combatants whose AoO budget just refreshed. */
  aooRefreshed: string[];
  /** Held actions that came due at the start of the new round. */
  heldDelivered: Array<{
    combatantId: string;
    kind: PF1eHeldAction["kind"];
    fullRound: boolean;
  }>;
  clockDeltaSeconds: number;
} {
  const state = readRoundState(combat);

  if (state.phase === "surprise") {
    const nextIdx = state.surpriseTurn + 1;
    if (nextIdx < state.surpriseOrder.length) {
      const surpriseState = { ...state, surpriseTurn: nextIdx };
      return {
        combat: withRoundState(combat, surpriseState),
        state: surpriseState,
        hooks: ["combat:turn:end", "combat:turn:start"],
        expired: [],
        aooRefreshed: [],
        heldDelivered: [],
        clockDeltaSeconds: 0,
      };
    }
    // Surprise round over: everyone is now in the initiative order, round 1 begins.
    const started = startCombat(combat);
    const afterSurprise: PF1eRoundState = {
      ...state,
      phase: "rounds",
      surpriseTurn: 0,
      roundRolled: false,
    };
    return {
      combat: withRoundState(started.combat, afterSurprise),
      state: afterSurprise,
      hooks: ["combat:turn:end", ...started.hooks],
      expired: [],
      aooRefreshed: started.combat.combatants.map((c) => c._id),
      heldDelivered: [],
      clockDeltaSeconds: state.secondsPerRound,
    };
  }

  const before = combat.round;
  const core = nextTurn(combat);
  const wrapped = core.combat.round > before;
  const roundRolled = wrapped;
  const aooRefreshed: string[] = [];
  const heldDelivered: Array<{
    combatantId: string;
    kind: PF1eHeldAction["kind"];
    fullRound: boolean;
  }> = [];
  let combatants = core.combat.combatants;
  const active = currentCombatant(core.combat);

  if (roundRolled || active) {
    combatants = combatants.map((c) => {
      const cs = readCombatantState(c);
      let changed = false;
      let aooUsed = cs.aooUsed;
      let held = cs.held;
      let acted = cs.acted;
      if (active && c._id === active._id && aooUsed !== 0) {
        aooUsed = 0; // A.10: the budget comes back at the start of your turn
        changed = true;
        aooRefreshed.push(c._id);
      }
      if (roundRolled && held) {
        const alliesBefore = held.alliesBefore;
        heldDelivered.push({
          combatantId: c._id,
          kind: held.kind,
          // A.10: holding past six friendly turns costs a full-round action to maintain, and the
          // hold then ends — so it is delivered (or lost) at the boundary either way.
          fullRound: alliesBefore >= HELD_FULL_ROUND_ALLIES,
        });
        held = null;
        changed = true;
      }
      if (active && c._id === active._id && !acted) {
        acted = true; // no longer flat-footed "until your first turn" (A.1)
        changed = true;
      }
      if (!changed) return c;
      return withCombatantState(c, { ...cs, aooUsed, held, acted });
    });
  }

  // Count friendly turns taken for held actions, so the 6-allies rule can fire.
  if (active) {
    combatants = combatants.map((c) => {
      const cs = readCombatantState(c);
      if (!cs.held || c._id === active._id) return c;
      const held = cs.held;
      if (!held) return c;
      return withCombatantState(c, {
        ...cs,
        held: { ...held, alliesBefore: held.alliesBefore + 1 },
      });
    });
  }

  const clockDelta =
    roundRolled && opts.advanceClock !== false ? state.secondsPerRound : 0;
  return {
    combat: withRoundState(
      { ...core.combat, combatants },
      {
        ...state,
        phase: "rounds",
        roundRolled,
        clockSeconds: state.clockSeconds + clockDelta,
      },
    ),
    state: {
      ...state,
      phase: "rounds",
      roundRolled,
      clockSeconds: state.clockSeconds + clockDelta,
    },
    hooks: core.hooks,
    expired: core.expired,
    aooRefreshed,
    heldDelivered,
    clockDeltaSeconds: clockDelta,
  };
}

/** A.10: six other combatants acting before your turn makes holding a full-round action. */
export const HELD_FULL_ROUND_ALLIES = 6;

/** Write one combatant's PF1e state back into its flags, leaving other scopes untouched. */
function withCombatantState(
  c: CombatantDocument,
  state: PF1eCombatantState,
): CombatantDocument {
  // Other scopes (including core's, which owns `delayed` and the embedded effects) are carried over
  // untouched — this module must never clobber a scope it does not own.
  return { ...c, flags: { ...c.flags, [SCOPE]: { ...state } } };
}

/** Spend one attack of opportunity. Refused once the budget is gone, with a reason the UI can show. */
export function useAttackOfOpportunity(
  combatant: CombatantDocument,
  max: number,
  opts: { reason?: string } = {},
): Result<{
  combatant: CombatantDocument;
  used: number;
  left: number;
  reason: string | null;
}> {
  const cs = readCombatantState(combatant);
  if (cs.aooUsed >= max) {
    return err(
      opts.reason
        ? `no attacks of opportunity left (${opts.reason})`
        : `no attacks of opportunity left (${cs.aooUsed}/${max} used)`,
    );
  }
  const used = cs.aooUsed + 1;
  return okVal({
    combatant: withCombatantState(combatant, {
      ...cs,
      aooUsed: used,
      aooMax: max,
    }),
    used,
    left: Math.max(0, max - used),
    reason: opts.reason ?? null,
  });
}

/** Author a held action ("I'll save the charge for next round"). */
export function holdAction(
  combatant: CombatantDocument,
  kind: PF1eHeldAction["kind"],
  round: number,
  note?: string,
): CombatantDocument {
  const cs = readCombatantState(combatant);
  const held: PF1eHeldAction = {
    kind,
    since: round,
    alliesBefore: 0,
    ...(note !== undefined ? { note } : {}),
  };
  return withCombatantState(combatant, { ...cs, held });
}

/** Is this combatant flat-footed right now for round-structural reasons (A.1 surprise / no turn yet)? */
export function isFlatFootedByRound(
  combat: CombatDocument,
  combatant: CombatantDocument,
): { flatFooted: boolean; why: "surprise" | "no-turn-yet" | null } {
  const state = readRoundState(combat);
  if (state.phase === "surprise" && state.surprised.includes(combatant._id)) {
    return { flatFooted: true, why: "surprise" };
  }
  if (state.phase === "rounds" && !readCombatantState(combatant).acted) {
    return { flatFooted: true, why: "no-turn-yet" };
  }
  return { flatFooted: false, why: null };
}

/** Elapsed combat time in rounds and the remaining grace for a per-minute duration. */
export function clockRounds(state: PF1eRoundState): number {
  return Math.floor(state.clockSeconds / state.secondsPerRound);
}

/**
 * The number of whole minutes of the clock that a `minute/level` duration should consume per round
 * — used by the P4 expiry sweep so a 5-rounds/level buff and a 1-minute/level buff can share one
 * clock instead of two timers.
 */
export function minutesElapsed(state: PF1eRoundState): number {
  return Math.floor(state.clockSeconds / 60);
}
