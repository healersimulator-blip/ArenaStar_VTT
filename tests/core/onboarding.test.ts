/**
 * §2.3 tail (G-41 remainder, D-263) — the first-run checklist's rules: what each role is asked to
 * do, that every step's tick follows the fact it names and nothing else, and that a finished list
 * offers itself folded (a checklist that never ends is a nag).
 */
import { describe, expect, test } from "vitest";
import {
  NO_ONBOARDING_FACTS,
  gmOnboardingSteps,
  onboardingOpenByDefault,
  onboardingRemaining,
  onboardingSteps,
  playerOnboardingSteps,
  type OnboardingFacts,
} from "../../src/core/onboarding";

const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  ...NO_ONBOARDING_FACTS,
  ...over,
});

/** Every step ticked: the "table is already playing" state. */
const ALL_DONE: OnboardingFacts = {
  scenes: 1,
  map: true,
  tokens: 4,
  character: true,
  owned: 1,
  players: 3,
  invited: true,
  fog: true,
  messages: 7,
};

const ticks = (steps: ReturnType<typeof gmOnboardingSteps>): Record<string, boolean> =>
  Object.fromEntries(steps.map((s) => [s.id, s.done]));

describe("the GM's first-run checklist", () => {
  test("runs in the order a table is actually set up", () => {
    expect(gmOnboardingSteps(NO_ONBOARDING_FACTS).map((s) => s.id)).toEqual([
      "map",
      "tokens",
      "invite",
      "fog",
      "play",
    ]);
  });

  test("every step is open on an empty world, and every hint names a control", () => {
    const steps = gmOnboardingSteps(NO_ONBOARDING_FACTS);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(onboardingRemaining(steps)).toBe(5);
    for (const step of steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.hint.length).toBeGreaterThan(10);
    }
  });

  test("a step ticks on its own fact and nobody else's", () => {
    expect(ticks(gmOnboardingSteps(facts({ map: true })))).toEqual({
      map: true,
      tokens: false,
      invite: false,
      fog: false,
      play: false,
    });
    expect(ticks(gmOnboardingSteps(facts({ tokens: 1 }))).tokens).toBe(true);
    expect(ticks(gmOnboardingSteps(facts({ tokens: 0 }))).tokens).toBe(false);
    expect(ticks(gmOnboardingSteps(facts({ invited: true }))).invite).toBe(true);
    expect(ticks(gmOnboardingSteps(facts({ fog: true }))).fog).toBe(true);
    expect(ticks(gmOnboardingSteps(facts({ messages: 1 }))).play).toBe(true);
    // a table mid-setup: the map is up, the party is placed, nobody has been invited yet
    expect(onboardingRemaining(gmOnboardingSteps(facts({ map: true, tokens: 3 })))).toBe(3);
  });

  test("the world's own player count is not what the invite step reads", () => {
    // `players` alone must not tick "invite your players": a world whose players exist but whose
    // GM has not opened a link is still a GM with work to do, and the fact that says otherwise
    // (`invited`) is the one the sidebar's own panel produces.
    expect(ticks(gmOnboardingSteps(facts({ players: 4 }))).invite).toBe(false);
  });
});

describe("the player's first-run checklist", () => {
  test("asks for what a player can see from their own replica", () => {
    expect(playerOnboardingSteps(NO_ONBOARDING_FACTS).map((s) => s.id)).toEqual([
      "token",
      "sheet",
      "chat",
    ]);
  });

  test("reads the player's own facts: their token and their sheet", () => {
    expect(ticks(playerOnboardingSteps(facts({ owned: 1, character: true, messages: 1 })))).toEqual({
      token: true,
      sheet: true,
      chat: true,
    });
    // a GM-shaped world (tokens, players, fog) tells a player nothing about their own steps…
    const asPlayer = playerOnboardingSteps(facts({ tokens: 9, players: 4, fog: true, map: true }));
    expect(ticks(asPlayer)).toEqual({ token: false, sheet: false, chat: false });
    // …and the GM's list is what sees the map and the fog
    expect(ticks(gmOnboardingSteps(facts({ tokens: 9, players: 4, fog: true, map: true })))).toEqual({
      map: true,
      tokens: true,
      invite: false,
      fog: true,
      play: false,
    });
  });
});

describe("one list per role", () => {
  test("PLAYER gets the arrival list, everything else the setup list", () => {
    expect(onboardingSteps(NO_ONBOARDING_FACTS, "PLAYER").map((s) => s.id)).toEqual([
      "token",
      "sheet",
      "chat",
    ]);
    // a GM *and* an assistant (and a shell that has not resolved a role yet) set tables up
    for (const role of ["GM", "ASSISTANT", null, undefined, ""]) {
      expect(onboardingSteps(NO_ONBOARDING_FACTS, role).map((s) => s.id)).toEqual([
        "map",
        "tokens",
        "invite",
        "fog",
        "play",
      ]);
    }
  });

  test("a finished list folds itself away, an unfinished one does not", () => {
    expect(onboardingOpenByDefault(gmOnboardingSteps(NO_ONBOARDING_FACTS))).toBe(true);
    expect(onboardingOpenByDefault(gmOnboardingSteps(ALL_DONE))).toBe(false);
    expect(onboardingRemaining(gmOnboardingSteps(ALL_DONE))).toBe(0);
  });

  test("the shared empty fact set is never mutated by a render", () => {
    const before = JSON.stringify(NO_ONBOARDING_FACTS);
    gmOnboardingSteps(NO_ONBOARDING_FACTS);
    playerOnboardingSteps(NO_ONBOARDING_FACTS);
    expect(JSON.stringify(NO_ONBOARDING_FACTS)).toBe(before);
  });
});
