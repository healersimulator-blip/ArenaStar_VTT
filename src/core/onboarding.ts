/**
 * §2.3 tail — first-run onboarding (D-263, gap G-41 remainder).
 *
 * A table is set up in a definite order: a map, the party on it, players at the door, the cover
 * that hides what they must not see, and then the first roll. A newcomer's real problem is not
 * that they cannot *find* a control — the rail is labelled — but that they do not know which of
 * twenty controls to reach for first, and a hint that arrives after the mistake has taught them
 * nothing.
 *
 * So a step is **derived from the world's own state**, not tracked: there is nothing to store,
 * nothing to go stale, nothing to reconcile when a table was set up last week, and a GM who
 * already did the work sees it ticked instead of being told to redo it. That is also why the list
 * is short and why it ends: a checklist that never finishes is a nag, and the last step ("start
 * the session") completes on the first message in chat, i.e. at the moment the table is playing.
 *
 * Two audiences, two lists. A GM sets a table up; a player arrives at one, so their steps name
 * what they can see from their own replica (their token, their sheet) and the one thing they can
 * always do (say something), never a control they do not have.
 */

export interface OnboardingFacts {
  /** Scenes in the world (a fresh world ships with one). */
  scenes: number;
  /** The active scene has a background image. */
  map: boolean;
  /** Tokens on the active scene. */
  tokens: number;
  /** The user has a character linked on their own document (player list). */
  character: boolean;
  /** The user may update at least one token on the active scene (player list). */
  owned: number;
  /** User documents with role `PLAYER`. */
  players: number;
  /** The GM has an invite outstanding, or somebody has already joined. */
  invited: boolean;
  /** Fog of war is on for the active scene (GM list). */
  fog: boolean;
  /** Chat messages in the world — the session has actually started. */
  messages: number;
}

/** Every fact unsatisfied: what a how-to list renders from (the Help window's own copy). */
export const NO_ONBOARDING_FACTS: OnboardingFacts = {
  scenes: 0,
  map: false,
  tokens: 0,
  character: false,
  owned: 0,
  players: 0,
  invited: false,
  fog: false,
  messages: 0,
};

export interface OnboardingStep {
  id: string;
  /** Imperative, short — the thing to do. */
  title: string;
  /** The control to reach for, named the way the UI names it. */
  hint: string;
  done: boolean;
}

/**
 * The GM's order of work. Each hint names a control that exists on the GM's own shell, so a step
 * can be acted on without a second window.
 */
export function gmOnboardingSteps(facts: OnboardingFacts): OnboardingStep[] {
  return [
    {
      id: "map",
      title: "Put a map on the table",
      hint: "“Import map” in the sidebar — or Settings ▸ Scene to pick a background for the scene.",
      done: facts.map,
    },
    {
      id: "tokens",
      title: "Place the party",
      hint: "“Add token” in the sidebar, or drag a character out of the Actors window.",
      done: facts.tokens > 0,
    },
    {
      id: "invite",
      title: "Invite your players",
      hint: "“Create invite link”, then paste each player's code back into the sidebar.",
      done: facts.invited,
    },
    {
      id: "fog",
      title: "Turn on fog of war",
      hint: "Settings ▸ Scene ▸ Fog of war — the G key arms the hide/reveal brush.",
      done: facts.fog,
    },
    {
      id: "play",
      title: "Start the session",
      hint: "Roll from the dice tray (R) or the quickbar; chat carries it to the whole table.",
      done: facts.messages > 0,
    },
  ];
}

/** The player's list: what they can see from their own replica, in the order they meet it. */
export function playerOnboardingSteps(facts: OnboardingFacts): OnboardingStep[] {
  return [
    {
      id: "token",
      title: "Find your token",
      hint: "Click it to select, drag to move — fog hides everything your character cannot see.",
      done: facts.owned > 0,
    },
    {
      id: "sheet",
      title: "Open your character sheet",
      hint: "The Sheet tab in the sidebar; ask your GM if your character is not listed.",
      done: facts.character,
    },
    {
      id: "chat",
      title: "Say something",
      hint: "Chat and the quickbar are how the table hears you — the GM sees the rolls.",
      done: facts.messages > 0,
    },
  ];
}

/** One list per role: a GM sets a table up, a player arrives at one. */
export function onboardingSteps(
  facts: OnboardingFacts,
  role: string | null | undefined,
): OnboardingStep[] {
  return role === "PLAYER" ? playerOnboardingSteps(facts) : gmOnboardingSteps(facts);
}

/** How many steps are still open — what a collapsed checklist summarizes. */
export function onboardingRemaining(steps: readonly OnboardingStep[]): number {
  return steps.filter((step) => !step.done).length;
}

/** `false` when there is nothing left to do: a finished checklist folds itself away. */
export function onboardingOpenByDefault(steps: readonly OnboardingStep[]): boolean {
  return onboardingRemaining(steps) > 0;
}
