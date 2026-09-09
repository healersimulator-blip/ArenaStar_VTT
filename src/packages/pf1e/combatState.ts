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
  endCombat,
} from "../../core/combat";
import { DEFAULT_SECONDS_PER_ROUND } from "../../core/worldSettings";
import {
  readActionLedger,
  spendAction,
  startOfTurnLedger,
  type PF1eActionLedger,
  type PF1eActionSpend,
} from "./actions";

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
  /** Per-turn action budget (T05: standard/move/swift/full-round, 5-ft step, movement). */
  actions: PF1eActionLedger;
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
    actions: readActionLedger(raw.actions),
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
  /** The combatants caught flat-footed: the UNAWARE ones only (A.1). */
  flatFooted: string[];
  /** Combatants that started the battle aware — they act in the surprise round (A.1). */
  aware: string[];
  /** Why there was no surprise round, for the roll log. */
  note: string | null;
}

/**
 * Surprise round (A.1 as corrected D-129, CRB p.178): it happens when **some but not all**
 * combatants are aware. Awareness is per combatant: a defender is aware when their Perception
 * matches or beats **any one** attacker's Stealth (they noticed someone); attackers are aware by
 * the model (they are the ones initiating). The aware combatants — defenders included — each act
 * in the surprise round with one standard or move action plus free/swift actions; the unaware do
 * not act and are flat-footed until they do. No surprise round when every defender noticed
 * someone ("if no one or everyone is surprised, no surprise round occurs"). A defender with no
 * Perception authored cannot notice anyone and counts as unaware.
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
      aware: [],
      note: "no stealth vs perception comparison was made",
    };
  }
  const unaware: string[] = [];
  const awareDefenders: string[] = [];
  for (const target of targets) {
    const perception = check.perception[target];
    const noticed =
      perception !== undefined &&
      attackers.some((a) => (check.stealth[a] ?? 0) <= perception);
    if (noticed) awareDefenders.push(target);
    else unaware.push(target);
  }
  const aware = [...attackers, ...awareDefenders];
  if (unaware.length === 0) {
    return {
      surpriseRound: false,
      flatFooted: [],
      aware,
      note: "every defender noticed an attacker — no surprise round",
    };
  }
  return { surpriseRound: true, flatFooted: unaware, aware, note: null };
}

/**
 * The GM's explicit awareness marks → the same outcome shape `checkSurprise` produces. The
 * unaware are exactly the marked combatants (unknown ids ignored); "if no one or everyone is
 * surprised, no surprise round occurs" covers both degenerate splits.
 */
function explicitAwareness(
  combatants: readonly CombatantDocument[],
  unaware: readonly string[],
): SurpriseOutcome {
  const ids = combatants.filter((c) => !c.defeated).map((c) => c._id);
  const marked = new Set(unaware);
  const unawareIds = ids.filter((id) => marked.has(id));
  const awareIds = ids.filter((id) => !marked.has(id));
  if (unawareIds.length === 0) {
    return {
      surpriseRound: false,
      flatFooted: [],
      aware: awareIds,
      note: "no combatant is unaware — no surprise round",
    };
  }
  if (awareIds.length === 0) {
    return {
      surpriseRound: false,
      flatFooted: unawareIds,
      aware: [],
      note: "no combatant is aware — no surprise round",
    };
  }
  return {
    surpriseRound: true,
    flatFooted: unawareIds,
    aware: awareIds,
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
    /**
     * Explicit awareness marks (the tracker path): the combatants the GM declares caught
     * unaware. Takes precedence over stealth/perception when both are supplied.
     */
    unaware?: readonly string[] | undefined;
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
    opts.unaware !== undefined
      ? explicitAwareness(withInitiative, opts.unaware)
      : opts.stealth !== undefined && opts.perception !== undefined
        ? checkSurprise(opts.targets ?? withInitiative.map((c) => c._id), {
            stealth: opts.stealth,
            perception: opts.perception,
          })
        : null;

  if (surprise?.surpriseRound) {
    // Only the AWARE combatants act in the surprise round (A.1) — aware defenders
    // included; the unaware wait for round 1, flat-footed.
    const order = sortCombatants(withInitiative)
      .filter((c) => !c.defeated && surprise.aware.includes(c._id))
      .map((c) => c._id);
    const surpriseState: PF1eRoundState = {
      ...base,
      phase: "surprise",
      surpriseOrder: order,
      surpriseTurn: 0,
      surprised: surprise.flatFooted,
    };
    // The first surprise actor's turn starts now: they have acted (no longer
    // flat-footed once regular rounds begin) and their budget is restricted to a
    // single standard or move action plus free/swift (A.1/A.6, CRB p.181).
    const firstId = order[0];
    const combatants = withInitiative.map((c) => {
      const cs = readCombatantState(c);
      if (c._id === firstId) {
        return withCombatantState(c, {
          ...cs,
          acted: true,
          actions: {
            ...startOfTurnLedger(cs.actions),
            restriction: "single-standard-or-move",
          },
        });
      }
      if (surprise.flatFooted.includes(c._id) && !cs.surprised) {
        return withCombatantState(c, { ...cs, surprised: true });
      }
      return c;
    });
    return {
      combat: withRoundState({ ...combat, combatants }, surpriseState),
      state: surpriseState,
      hooks: ["combat:combatant:update", "pf1e:combat:surprise"],
      surprise,
    };
  }

  const started = startCombat({ ...combat, combatants: withInitiative });
  const combatants = started.combat.combatants.map((c) => {
    if (c._id !== (currentCombatant(started.combat)?._id ?? "")) return c;
    const cs = readCombatantState(c);
    return withCombatantState(c, {
      ...cs,
      acted: true,
      actions: startOfTurnLedger(cs.actions),
    });
  });
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
      // The next aware combatant's surprise turn starts: they have acted, and their
      // budget is restricted to a single standard or move action plus free/swift (A.1).
      const nextId = state.surpriseOrder[nextIdx];
      const combatants = combat.combatants.map((c) => {
        if (c._id !== nextId) return c;
        const cs = readCombatantState(c);
        return withCombatantState(c, {
          ...cs,
          acted: true,
          actions: {
            ...startOfTurnLedger(cs.actions),
            restriction: "single-standard-or-move",
          },
        });
      });
      return {
        combat: withRoundState({ ...combat, combatants }, surpriseState),
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
    const firstRegular = currentCombatant(started.combat)?._id ?? "";
    const roundOne = started.combat.combatants.map((c) => {
      if (c._id !== firstRegular) return c;
      const cs = readCombatantState(c);
      return withCombatantState(c, {
        ...cs,
        acted: true, // your own turn starting is the flat-footed transition (A.1)
        actions: startOfTurnLedger(cs.actions),
      });
    });
    const afterSurprise: PF1eRoundState = {
      ...state,
      phase: "rounds",
      surpriseTurn: 0,
      roundRolled: false,
    };
    return {
      combat: withRoundState(
        { ...started.combat, combatants: roundOne },
        afterSurprise,
      ),
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
      let actions = cs.actions;
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
      if (active && c._id === active._id) {
        // T05: the action budget resets at the start of your turn; an off-turn immediate
        // action's reservation converts into "swift already used"; a pending full-round
        // action survives to be completed with this turn's standard action.
        const reset = startOfTurnLedger(actions);
        if (!sameLedger(reset, actions)) {
          actions = reset;
          changed = true;
        }
      }
      if (!changed) return c;
      return withCombatantState(c, { ...cs, aooUsed, held, acted, actions });
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

/** Field-wise ledger equality (the reset builds a fresh object every time). */
function sameLedger(a: PF1eActionLedger, b: PF1eActionLedger): boolean {
  return (
    a.standardUsed === b.standardUsed &&
    a.moveUsed === b.moveUsed &&
    a.swiftUsed === b.swiftUsed &&
    a.swiftReserved === b.swiftReserved &&
    a.fiveFootStepUsed === b.fiveFootStepUsed &&
    a.movementFt === b.movementFt &&
    a.fullRoundPending === b.fullRoundPending &&
    a.restriction === b.restriction
  );
}

/**
 * Spend from one combatant's action budget (T05). Pure: returns the combat whose
 * combatant carries the updated ledger, or the refusal reason — the UI/host turns the
 * result into a `combats` update op.
 */
export function spendCombatantAction(
  combat: CombatDocument,
  combatantId: string,
  spend: PF1eActionSpend,
): Result<CombatDocument> {
  const target = combat.combatants.find((c) => c._id === combatantId);
  if (!target) return err("combatant is not part of this encounter");
  const cs = readCombatantState(target);
  const next = spendAction(cs.actions, spend);
  if (!next.ok) return err(next.error);
  return okVal({
    ...combat,
    combatants: combat.combatants.map((c) =>
      c._id === combatantId
        ? withCombatantState(c, { ...cs, actions: next.value })
        : c,
    ),
  });
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

/**
 * Who is acting right now, PF1e-aware: during a surprise round the current actor is the
 * surprise order's pointer, not core's `turn` (core has not started a round yet).
 */
export function activePF1eCombatant(
  combat: CombatDocument,
): CombatantDocument | null {
  const state = readRoundState(combat);
  if (state.phase === "surprise") {
    const id = state.surpriseOrder[state.surpriseTurn];
    return id === undefined
      ? null
      : (combat.combatants.find((c) => c._id === id) ?? null);
  }
  return currentCombatant(combat);
}

/**
 * End combat through core, then reset the PF1e round structure to a fresh setup state so a
 * restarted encounter cannot inherit a stale phase, surprise order or clock.
 */
export function pf1eEndCombat(combat: CombatDocument): {
  combat: CombatDocument;
  state: PF1eRoundState;
  hooks: string[];
} {
  const ended = endCombat(combat);
  const state: PF1eRoundState = {
    ...readRoundState(combat),
    phase: "setup",
    surpriseOrder: [],
    surpriseTurn: 0,
    surprised: [],
    roundRolled: false,
    clockSeconds: 0,
  };
  return {
    combat: withRoundState(ended.combat, state),
    state,
    hooks: ended.hooks,
  };
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
