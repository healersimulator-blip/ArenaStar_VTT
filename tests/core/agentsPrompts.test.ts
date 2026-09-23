// MCP connector §5.7 — the prompts: the recipes a client can offer as one action.
//
// The invariant these tests exist for is not "the templates render" — it is **a prompt names only
// tools the bridge serves**. A recipe is a promise about the catalogue, and one that names a tool
// that does not exist is invisible until a client follows it and gets a method error in return.
import { describe, expect, test } from "vitest";
import {
  AGENT_PROMPTS,
  promptGet,
  promptList,
  promptToolNames,
  SERVED_TOOL_NAMES,
} from "../../src/core/agents/prompts";

describe("the prompt catalogue (§5.7)", () => {
  test("every tool a recipe names is one the bridge serves", () => {
    const served = new Set(SERVED_TOOL_NAMES);
    for (const name of promptToolNames()) {
      expect(served.has(name), `prompt names a tool the bridge does not serve: ${name}`).toBe(true);
    }
  });

  test("the eight recipes §5.7 names are all here, with titles and descriptions", () => {
    expect(AGENT_PROMPTS.map((row) => row.name)).toEqual([
      "gm.narrate_scene",
      "gm.run_encounter",
      "gm.improvise_npc",
      "player.describe_action",
      "referee.rule_question",
      "strategic.advise_turn",
      "hexcrawl.travel_day",
      "hexcrawl.author_region",
    ]);
    for (const prompt of AGENT_PROMPTS) {
      expect(prompt.title.length).toBeGreaterThan(3);
      expect(prompt.description.length).toBeGreaterThan(40);
      expect(prompt.tools.length).toBeGreaterThan(0);
    }
  });

  test("prompts/list is the catalogue in MCP's shape", () => {
    const listed = promptList();
    expect(listed).toHaveLength(AGENT_PROMPTS.length);
    for (const row of listed) {
      expect(typeof row.name).toBe("string");
      expect(typeof row.title).toBe("string");
      expect(typeof row.description).toBe("string");
    }
    // player.describe_action needs the action; narrating a scene takes nothing it could not do
    // without — both fill-ins are optional, and a client may offer the recipe with no questions.
    const narrate = listed.find((row) => row.name === "gm.narrate_scene");
    expect(narrate?.arguments?.length).toBeGreaterThan(0);
    expect(narrate?.arguments?.every((row) => row.required !== true)).toBe(true);
    const act = listed.find((row) => row.name === "player.describe_action");
    expect(act?.arguments?.some((row) => row.name === "action" && row.required === true)).toBe(true);
  });

  test("every recipe tells the model that a refusal is an answer", () => {
    // The one line that keeps a model from routing around a locked door.
    for (const prompt of AGENT_PROMPTS) {
      const text = prompt.render({});
      expect(text, prompt.name).toContain("you may not do something");
      expect(text.toLowerCase(), prompt.name).toContain("do not work around it");
    }
  });

  test("a recipe renders its arguments, and stands up without them", () => {
    const travel = AGENT_PROMPTS.find((row) => row.name === "hexcrawl.travel_day");
    expect(travel).toBeDefined();
    if (!travel) return;
    const bare = travel.render({});
    expect(bare).toContain("You are the GM running a day on the road.");
    expect(bare).not.toContain("undefined");
    const filled = travel.render({ destination: "3,-2", hours: "8" });
    expect(filled).toContain("to 3,-2");
    expect(filled).toContain("by 8 hours");
  });

  test("the rules question is the one recipe that admits to guessing", () => {
    const referee = AGENT_PROMPTS.find((row) => row.name === "referee.rule_question");
    expect(referee).toBeDefined();
    if (!referee) return;
    const text = referee.render({ question: "Does a prone archer take the penalty?" });
    expect(text).toContain("Does a prone archer take the penalty?");
    // A confident citation the world cannot back is worse than an admitted guess.
    expect(text).toContain("marked as a ruling and");
  });

  test("advising on orders is not the same as giving them", () => {
    const advise = AGENT_PROMPTS.find((row) => row.name === "strategic.advise_turn");
    expect(advise).toBeDefined();
    if (!advise) return;
    expect(advise.render({ brief: "hold the ford" })).toContain(
      "**only** if you were explicitly told to issue them",
    );
  });

  test("prompts/get renders one message, and an unknown prompt is nothing at all", () => {
    const got = promptGet("gm.run_encounter", { sceneId: "s1" });
    expect(got).not.toBeNull();
    expect(got?.messages).toHaveLength(1);
    expect(got?.messages[0]?.role).toBe("user");
    expect(got?.messages[0]?.content.type).toBe("text");
    expect(got?.messages[0]?.content.text).toContain('scene "s1"');
    expect(got?.description.length).toBeGreaterThan(20);
    expect(promptGet("gm.do_everything")).toBeNull();
  });
});
