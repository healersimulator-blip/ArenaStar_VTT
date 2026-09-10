/**
 * PF1e **action economy** — the action types, the provoke table and the per-turn budget
 * (T05). The table is the verified Table 7-2 "Actions in Combat" (CRB p.182, AoN Rules
 * ID 128, re-verified 2026-09-09 for D-131 — the earlier Gap List A.6 transcription had
 * wrong provoke flags and invented rows and was repaired against this source). The
 * budget follows the "Action Types" text on the same page:
 *
 *  - a normal round = one standard + one move, **or** one full-round action, plus one
 *    swift and any number of free actions;
 *  - a move action may always substitute for the standard (so "two moves" is legal,
 *    "two standards" never is);
 *  - restricted activity (surprise round, staggered, slowed) = a single standard OR a
 *    single move action, plus free and swift actions as normal — no full-round action,
 *    but a full-round action may still be **started or completed** with a standard
 *    action (CRB p.185), and swift actions are legal in surprise rounds because a swift
 *    may be taken "anytime you would normally be allowed to take a free action";
 *  - an immediate action taken off-turn consumes the **next** turn's swift action.
 *
 * The ledger is bookkeeping only: it answers "what can still be spent this turn and
 * why not" — it does not execute attacks, cast spells or roll anything (that is P3+/P6,
 * which will call `actionRefusal`/`spendAction` as their legality gate). Movement and
 * the 5-foot-step interact by rule: any movement in a round blocks the 5-foot step, and
 * a 5-foot step blocks any other movement (CRB p.189).
 */
import { err, okVal, type Result } from "../../core/result";

/** Action types from CRB p.181 — plus the two table-only kinds ("no-action", "varies"). */
export type PF1eActionCategory =
  | "standard"
  | "move"
  | "full-round"
  | "swift"
  | "immediate"
  | "free"
  | "no-action"
  | "varies";

/** The Table 7-2 "Attack of Opportunity?" column. "usually"/"maybe" carry a note. */
export type PF1eProvokes = "no" | "yes" | "usually" | "maybe" | "varies";

export interface PF1eActionEntry {
  id: string;
  name: string;
  category: PF1eActionCategory;
  provokes: PF1eProvokes;
  /** The table footnote or condition, when the row is not a plain yes/no. */
  note?: string;
}

/**
 * Table 7-2, Actions in Combat (CRB p.182). The provoke column answers "does the action
 * itself provoke" — moving out of a threatened square provokes regardless of the action
 * (footnote 1).
 */
export const PF1E_ACTIONS: readonly PF1eActionEntry[] = [
  // Standard actions
  {
    id: "attack-melee",
    name: "Attack (melee)",
    category: "standard",
    provokes: "no",
  },
  {
    id: "attack-ranged",
    name: "Attack (ranged)",
    category: "standard",
    provokes: "yes",
  },
  {
    id: "attack-unarmed",
    name: "Attack (unarmed)",
    category: "standard",
    provokes: "yes",
  },
  {
    id: "activate-magic-item",
    name: "Activate a magic item other than a potion or oil",
    category: "standard",
    provokes: "no",
  },
  {
    id: "aid-another",
    name: "Aid another",
    category: "standard",
    provokes: "maybe",
    note: "Provokes if the aided action itself provokes.",
  },
  {
    id: "cast-spell",
    name: "Cast a spell (1 standard action casting time)",
    category: "standard",
    provokes: "yes",
  },
  {
    id: "channel-energy",
    name: "Channel energy",
    category: "standard",
    provokes: "no",
  },
  {
    id: "concentrate",
    name: "Concentration to maintain an active spell",
    category: "standard",
    provokes: "no",
  },
  {
    id: "dismiss-spell",
    name: "Dismiss a spell",
    category: "standard",
    provokes: "no",
  },
  {
    id: "draw-hidden-weapon",
    name: "Draw a hidden weapon (Sleight of Hand)",
    category: "standard",
    provokes: "no",
  },
  {
    id: "drink-potion",
    name: "Drink a potion or apply an oil",
    category: "standard",
    provokes: "yes",
  },
  {
    id: "escape-grapple",
    name: "Escape a grapple",
    category: "standard",
    provokes: "no",
  },
  { id: "feint", name: "Feint", category: "standard", provokes: "no" },
  {
    id: "light-torch-tindertwig",
    name: "Light a torch with a tindertwig",
    category: "standard",
    provokes: "yes",
  },
  {
    id: "lower-sr",
    name: "Lower spell resistance",
    category: "standard",
    provokes: "no",
  },
  {
    id: "read-scroll",
    name: "Read a scroll",
    category: "standard",
    provokes: "yes",
  },
  {
    id: "ready",
    name: "Ready (triggers a standard action)",
    category: "standard",
    provokes: "no",
  },
  {
    id: "stabilize-friend",
    name: "Stabilize a dying friend (Heal)",
    category: "standard",
    provokes: "yes",
  },
  {
    id: "total-defense",
    name: "Total defense",
    category: "standard",
    provokes: "no",
  },
  {
    id: "use-extraordinary-ability",
    name: "Use extraordinary ability",
    category: "standard",
    provokes: "no",
  },
  {
    id: "use-skill-standard",
    name: "Use skill that takes 1 action",
    category: "standard",
    provokes: "usually",
  },
  {
    id: "use-spell-like-ability",
    name: "Use spell-like ability",
    category: "standard",
    provokes: "yes",
  },
  {
    id: "use-supernatural-ability",
    name: "Use supernatural ability",
    category: "standard",
    provokes: "no",
  },
  // Move actions
  { id: "move", name: "Move", category: "move", provokes: "yes" },
  {
    id: "control-frightened-mount",
    name: "Control a frightened mount",
    category: "move",
    provokes: "yes",
  },
  {
    id: "direct-spell",
    name: "Direct or redirect an active spell",
    category: "move",
    provokes: "no",
  },
  {
    id: "draw-weapon",
    name: "Draw a weapon",
    category: "move",
    provokes: "no",
    note: "BAB +1: combine with a regular move.",
  },
  {
    id: "load-light-crossbow",
    name: "Load a hand crossbow or light crossbow",
    category: "move",
    provokes: "yes",
  },
  {
    id: "open-close-door",
    name: "Open or close a door",
    category: "move",
    provokes: "no",
  },
  {
    id: "mount-dismount",
    name: "Mount/dismount a steed",
    category: "move",
    provokes: "no",
  },
  {
    id: "move-heavy-object",
    name: "Move a heavy object",
    category: "move",
    provokes: "yes",
  },
  {
    id: "pick-up-item",
    name: "Pick up an item",
    category: "move",
    provokes: "yes",
  },
  {
    id: "sheathe-weapon",
    name: "Sheathe a weapon",
    category: "move",
    provokes: "yes",
  },
  {
    id: "stand-up",
    name: "Stand up from prone",
    category: "move",
    provokes: "yes",
  },
  {
    id: "ready-drop-shield",
    name: "Ready or drop a shield",
    category: "move",
    provokes: "no",
    note: "BAB +1: combine with a regular move; Two-Weapon Fighting draws two weapons.",
  },
  {
    id: "retrieve-stored-item",
    name: "Retrieve a stored item",
    category: "move",
    provokes: "yes",
  },
  // Full-round actions
  {
    id: "full-attack",
    name: "Full attack",
    category: "full-round",
    provokes: "no",
  },
  {
    id: "charge",
    name: "Charge",
    category: "full-round",
    provokes: "no",
    note: "May be taken as a standard action when limited to a single action: move up to your speed only, no weapon draw without Quick Draw. +2 attack, −2 AC until your next turn (A.6/D-129).",
  },
  {
    id: "coup-de-grace",
    name: "Deliver coup de grâce",
    category: "full-round",
    provokes: "yes",
  },
  {
    id: "escape-net",
    name: "Escape from a net",
    category: "full-round",
    provokes: "yes",
  },
  {
    id: "extinguish-flames",
    name: "Extinguish flames",
    category: "full-round",
    provokes: "no",
  },
  {
    id: "light-torch",
    name: "Light a torch",
    category: "full-round",
    provokes: "yes",
  },
  {
    id: "load-heavy-crossbow",
    name: "Load a heavy or repeating crossbow",
    category: "full-round",
    provokes: "yes",
  },
  {
    id: "locked-gauntlet",
    name: "Lock or unlock weapon in locked gauntlet",
    category: "full-round",
    provokes: "yes",
  },
  {
    id: "prepare-splash-weapon",
    name: "Prepare to throw splash weapon",
    category: "full-round",
    provokes: "yes",
  },
  { id: "run", name: "Run", category: "full-round", provokes: "yes" },
  {
    id: "use-skill-round",
    name: "Use skill that takes 1 round",
    category: "full-round",
    provokes: "usually",
  },
  {
    id: "touch-spell-six-friends",
    name: "Use a touch spell on up to six friends",
    category: "full-round",
    provokes: "yes",
  },
  {
    id: "withdraw",
    name: "Withdraw",
    category: "full-round",
    provokes: "no",
    note: "The first 5 ft never provoke; the rest of the movement does. You lose Dex/dodge to AC and take −4 AC until your next turn. May be taken as a standard action when limited to a single action.",
  },
  // Free actions
  {
    id: "cease-concentration",
    name: "Cease concentration on a spell",
    category: "free",
    provokes: "no",
  },
  { id: "drop-item", name: "Drop an item", category: "free", provokes: "no" },
  {
    id: "drop-to-floor",
    name: "Drop to the floor",
    category: "free",
    provokes: "no",
  },
  {
    id: "prepare-components",
    name: "Prepare spell components to cast spell",
    category: "free",
    provokes: "no",
    note: "Unless the component is extremely large or awkward.",
  },
  { id: "speak", name: "Speak", category: "free", provokes: "no" },
  // Swift / immediate
  {
    id: "cast-quickened",
    name: "Cast a quickened spell",
    category: "swift",
    provokes: "no",
  },
  {
    id: "cast-feather-fall",
    name: "Cast feather fall",
    category: "immediate",
    provokes: "no",
  },
  // No action
  { id: "delay", name: "Delay", category: "no-action", provokes: "no" },
  {
    id: "five-foot-step",
    name: "5-foot step",
    category: "no-action",
    provokes: "no",
  },
  // Action type varies
  {
    id: "combat-maneuver",
    name: "Perform a combat maneuver",
    category: "varies",
    provokes: "yes",
    note: "Many maneuvers substitute for a melee attack — usable in an attack, charge or full attack, or as an attack of opportunity.",
  },
  { id: "use-feat", name: "Use feat", category: "varies", provokes: "varies" },
];

/** Look up one table row by id (the ids this module and the tests share with the UI). */
export function pf1eActionById(id: string): PF1eActionEntry | null {
  return PF1E_ACTIONS.find((a) => a.id === id) ?? null;
}

/**
 * The full-round actions that can never be split across two rounds via
 * start/complete (CRB p.185).
 */
export const NON_SPLITTABLE_FULL_ROUND: readonly string[] = [
  "full-attack",
  "charge",
  "run",
  "withdraw",
];

/** Why a combatant's activity is restricted this turn. */
export type PF1eActivityRestriction = "none" | "single-standard-or-move";

/**
 * One combatant's per-turn action budget (stored under `combatant.flags.pf1e.actions`).
 * A type alias, not an interface, so it is assignable to the Json flags type like
 * every other state shape in this module.
 */
export type PF1eActionLedger = {
  standardUsed: boolean;
  moveUsed: boolean;
  /** Swift action already used this turn. */
  swiftUsed: boolean;
  /** An immediate action used off-turn consumed the NEXT turn's swift action. */
  swiftReserved: boolean;
  fiveFootStepUsed: boolean;
  /** Distance moved this turn — any movement blocks the 5-foot step (CRB p.189). */
  movementFt: number;
  /** A full-round action started with a standard action, awaiting its completing standard. */
  fullRoundPending: string | null;
  restriction: PF1eActivityRestriction;
};

export const EMPTY_ACTION_LEDGER: PF1eActionLedger = {
  standardUsed: false,
  moveUsed: false,
  swiftUsed: false,
  swiftReserved: false,
  fiveFootStepUsed: false,
  movementFt: 0,
  fullRoundPending: null,
  restriction: "none",
};

/** Defensive read: half-written flags degrade to defaults per field, never throw. */
export function readActionLedger(raw: unknown): PF1eActionLedger {
  if (typeof raw !== "object" || raw === null)
    return { ...EMPTY_ACTION_LEDGER };
  const r = raw as Record<string, unknown>;
  return {
    standardUsed: r.standardUsed === true,
    moveUsed: r.moveUsed === true,
    swiftUsed: r.swiftUsed === true,
    swiftReserved: r.swiftReserved === true,
    fiveFootStepUsed: r.fiveFootStepUsed === true,
    movementFt:
      typeof r.movementFt === "number" &&
      Number.isFinite(r.movementFt) &&
      r.movementFt > 0
        ? r.movementFt
        : 0,
    fullRoundPending:
      typeof r.fullRoundPending === "string" ? r.fullRoundPending : null,
    restriction:
      r.restriction === "single-standard-or-move"
        ? "single-standard-or-move"
        : "none",
  };
}

/** What a spend attempts to consume. `action` names the table row for diagnostics. */
export type PF1eActionSpend =
  | { kind: "standard"; action?: string }
  /** `asStandard` spends the standard slot instead of the move slot (move substitution). */
  | { kind: "move"; asStandard?: boolean; action?: string }
  | { kind: "full-round"; action?: string }
  | { kind: "swift"; action?: string }
  /** An immediate action taken on your turn is your swift action for that turn. */
  | { kind: "immediate"; onTurn: boolean; action?: string }
  | { kind: "free"; action?: string }
  | { kind: "five-foot-step" }
  /** Records movement distance — not an action, but it locks the 5-foot step. */
  | { kind: "movement"; feet: number }
  /** CRB p.185: spend a standard now, complete the full-round action next round. */
  | { kind: "start-full-round"; action: string }
  | { kind: "complete-full-round" };

/** The restriction's effect: after either a standard or a move, both slots are gone. */
function restrictedSpent(ledger: PF1eActionLedger): boolean {
  return (
    ledger.restriction === "single-standard-or-move" &&
    (ledger.standardUsed || ledger.moveUsed)
  );
}

/**
 * Why this spend is illegal right now, or null when it is allowed. Pure — the UI uses
 * this to disable buttons with the reason as a tooltip, and P3+/P6 action execution
 * will use it as the legality gate. `denied` carries the deny tokens resolved from the
 * combatant's active effects (E01): a token refuses a spend when it names the spend's
 * action id or its kind.
 */
export function actionRefusal(
  ledger: PF1eActionLedger,
  spend: PF1eActionSpend,
  denied?: ReadonlySet<string>,
): string | null {
  if (denied && denied.size > 0) {
    const action =
      "action" in spend && typeof spend.action === "string"
        ? spend.action
        : null;
    if (action !== null && denied.has(action))
      return `an active effect denies this action (${action})`;
    if (denied.has(spend.kind))
      return `an active effect denies this action (${spend.kind})`;
  }
  const restricted = ledger.restriction === "single-standard-or-move";
  switch (spend.kind) {
    case "free":
      return null; // free actions are unlimited (GM discretion on reasonableness)
    case "swift":
      if (ledger.swiftReserved)
        return "an immediate action used off-turn consumed this turn's swift action";
      if (ledger.swiftUsed) return "swift action already used this turn";
      return null;
    case "immediate":
      if (spend.onTurn) return actionRefusal(ledger, { kind: "swift" });
      if (ledger.swiftReserved)
        return "another immediate action is already pending before this combatant's next turn";
      return null;
    case "standard":
      if (restrictedSpent(ledger))
        return "restricted activity: a single standard or move action only";
      if (ledger.standardUsed) return "standard action already spent this turn";
      return null;
    case "move": {
      if (restrictedSpent(ledger))
        return "restricted activity: a single standard or move action only";
      return spend.asStandard
        ? ledger.standardUsed
          ? "standard action already spent this turn"
          : null
        : ledger.moveUsed
          ? "move action already spent this turn"
          : null;
    }
    case "full-round":
      if (ledger.fullRoundPending)
        return `a full-round action (${ledger.fullRoundPending}) is already started — complete it with a standard action`;
      if (ledger.standardUsed || ledger.moveUsed)
        return "a full-round action needs both the standard and the move action";
      if (restricted)
        return "restricted activity: no full-round action (start/complete with a standard action is allowed)";
      return null;
    case "five-foot-step":
      if (ledger.fiveFootStepUsed) return "5-foot step already taken this turn";
      if (ledger.movementFt > 0)
        return "any other movement this round blocks the 5-foot step";
      return null;
    case "movement": {
      if (!Number.isFinite(spend.feet) || spend.feet <= 0)
        return "movement distance must be a positive number of feet";
      if (ledger.fiveFootStepUsed)
        return "you already took a 5-foot step this round — no other movement is allowed";
      return null;
    }
    case "start-full-round": {
      if (NON_SPLITTABLE_FULL_ROUND.includes(spend.action))
        return `${spend.action} cannot be split across two rounds`;
      if (restrictedSpent(ledger))
        return "restricted activity: a single standard or move action only";
      if (ledger.standardUsed) return "standard action already spent this turn";
      return null;
    }
    case "complete-full-round":
      if (!ledger.fullRoundPending) return "no full-round action is pending";
      if (restrictedSpent(ledger))
        return "restricted activity: a single standard or move action only";
      if (ledger.standardUsed) return "standard action already spent this turn";
      return null;
  }
}

/** Spend from the ledger; refused spends return the reason instead of a new ledger. */
export function spendAction(
  ledger: PF1eActionLedger,
  spend: PF1eActionSpend,
  denied?: ReadonlySet<string>,
): Result<PF1eActionLedger> {
  const refusal = actionRefusal(ledger, spend, denied);
  if (refusal !== null) return err(refusal);
  const next: PF1eActionLedger = { ...ledger };
  switch (spend.kind) {
    case "free":
      return okVal(next);
    case "swift":
      next.swiftUsed = true;
      return okVal(next);
    case "immediate":
      if (spend.onTurn) next.swiftUsed = true;
      else next.swiftReserved = true;
      return okVal(next);
    case "standard":
      if (next.restriction === "single-standard-or-move") {
        next.standardUsed = true;
        next.moveUsed = true; // "or" — the restriction allows exactly one of the two
      } else next.standardUsed = true;
      return okVal(next);
    case "move":
      if (next.restriction === "single-standard-or-move") {
        next.standardUsed = true;
        next.moveUsed = true;
      } else if (spend.asStandard) next.standardUsed = true;
      else next.moveUsed = true;
      return okVal(next);
    case "full-round":
      next.standardUsed = true;
      next.moveUsed = true;
      return okVal(next);
    case "five-foot-step":
      next.fiveFootStepUsed = true;
      return okVal(next);
    case "movement":
      next.movementFt = next.movementFt + spend.feet;
      return okVal(next);
    case "start-full-round":
      next.standardUsed = true;
      if (next.restriction === "single-standard-or-move") next.moveUsed = true;
      next.fullRoundPending = spend.action;
      return okVal(next);
    case "complete-full-round":
      next.standardUsed = true;
      if (next.restriction === "single-standard-or-move") next.moveUsed = true;
      next.fullRoundPending = null;
      return okVal(next);
  }
}

/**
 * The ledger at the start of a combatant's turn: action slots and movement reset, an
 * off-turn immediate action's reservation converts into "swift already used", and a
 * pending full-round action survives (it is completed with this turn's standard). The
 * restriction is per-turn context (surprise round, staggered) — cleared here, set by
 * whoever knows the condition.
 */
export function startOfTurnLedger(current: PF1eActionLedger): PF1eActionLedger {
  return {
    standardUsed: false,
    moveUsed: false,
    swiftUsed: current.swiftReserved,
    swiftReserved: false,
    fiveFootStepUsed: false,
    movementFt: 0,
    fullRoundPending: current.fullRoundPending,
    restriction: "none",
  };
}
