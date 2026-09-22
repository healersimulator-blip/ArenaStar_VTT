/**
 * MCP connector §5.7 — the third primitive. Resources are what a client can *read*, tools are what
 * it can *do*, and prompts are the **recipes**: a named way to use the tool table for one job, so a
 * client can offer "Run this encounter as the GM" as a single action instead of asking its model to
 * invent the sequence.
 *
 * Two rules shape every template here:
 *
 * 1. **A prompt names the tools it expects, and only tools that exist.** The list is asserted
 *    against the real catalogue in the tests, because a recipe that names a tool the bridge does not
 *    serve is a lie a client cannot detect until it calls it.
 * 2. **A prompt never claims a capability the grant may not hold.** Each one tells the model that a
 *    refusal is an answer — "say so plainly rather than working around it" — because a model told to
 *    achieve an outcome will route around a locked door if the recipe implies the door is open.
 *
 * Prompts are pure: they render text from their arguments and nothing else. They read no world, so
 * they cannot leak one.
 */
import { AGENT_TOOLS } from "./tools";

export interface AgentPromptArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface AgentPrompt {
  name: string;
  /** A label a client can put on a button. */
  title: string;
  description: string;
  /** Fill-ins the client supplies; the template falls back to the active scene/party without them. */
  args?: readonly AgentPromptArg[];
  /** The tools this recipe reaches for, in the order it reaches for them. */
  tools: readonly string[];
  /** The text handed to the model. */
  render(args: Record<string, string>): string;
}

/** The sentence every prompt closes with: a refusal is an answer, not an obstacle. */
const REFUSAL_RULE = [
  "If a tool answers that you may not do something, say so plainly and stop — do not work around it,",
  "and do not describe having done it. Every refusal names what is missing; quote it.",
].join("\n");

const arg = (
  name: string,
  description: string,
  required = false,
): AgentPromptArg => ({ name, description, ...(required ? { required: true } : {}) });

const sceneArg = arg(
  "sceneId",
  "the scene to work on; the active one when omitted",
);
const noteArg = arg(
  "notes",
  "anything the table has said that matters — what the party is here for, who is with them",
);

export const AGENT_PROMPTS: readonly AgentPrompt[] = [
  {
    name: "gm.narrate_scene",
    title: "Narrate the scene",
    description:
      "Read the active scene — its map, its tokens, what is written about it — and open it for the table in the GM's voice.",
    args: [sceneArg, noteArg],
    tools: ["scene.read", "map.render", "token.list", "document.read", "chat.post"],
    render(args) {
      const where = args["sceneId"] ? `scene "${args["sceneId"]}"` : "the active scene";
      return [
        `You are the GM. Open ${where} for the players.`,
        "",
        `1. ${"scene.read"} on ${where} — the geometry, the light, who is on it.`,
        `2. ${"map.render"} — the ASCII map is what you can actually picture; read it before you describe a room.`,
        `3. ${"token.list"} — who the table can see. A token you cannot see is not in the room.`,
        `4. ${"document.read"} any journal the scene names, so the description is the world's and not an invention.`,
        `5. ${"chat.post"} two or three sentences: what the senses give, then the thing that invites a choice.`,
        "",
        "Describe what is there. Do not decide what the players do, and do not roll anything.",
        args["notes"] ? `The table has said: ${args["notes"]}` : "",
        "",
        REFUSAL_RULE,
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  },
  {
    name: "gm.run_encounter",
    title: "Run this encounter",
    description:
      "Take an encounter from the top of the order to the end of a round: whose turn it is, what they do, what it costs.",
    args: [sceneArg],
    tools: [
      "combat.state",
      "combat.start",
      "combat.next",
      "dice.roll",
      "dice.apply",
      "sheet.read",
      "chat.post",
    ],
    render(args) {
      const where = args["sceneId"] ? `scene "${args["sceneId"]}"` : "the active scene";
      return [
        `You are the GM running the fight on ${where}.`,
        "",
        `1. ${"combat.state"} — whose turn it is and the order. Never guess the turn.`,
        `2. For the combatant whose turn it is: ${"sheet.read"} if you need their numbers.`,
        `3. ${"dice.roll"} every die in the open, with a \`flavor\` naming what the roll is for. The host owns the dice.`,
        `4. ${"dice.apply"} the card to the target — name the card, never the amount.`,
        `5. ${"combat.next"} only when the turn is genuinely over; a round wrap moves the world clock by itself.`,
        `6. ${"chat.post"} what the table sees, in one or two sentences per turn.`,
        "",
        "If the encounter has not started, `combat.start` it first (PF1e wants an initiative for every combatant).",
        "If a combatant is dying and owes a stabilization check, `combat.next` names it — roll it, do not skip it.",
        "",
        REFUSAL_RULE,
      ].join("\n");
    },
  },
  {
    name: "gm.improvise_npc",
    title: "Improvise an NPC",
    description:
      "Make up a person the party has just met: find the nearest thing in the compendia, or build one from a description, and put them in the scene.",
    args: [arg("concept", "who they are — \"a nervous harbourmaster\", \"a goblin Warchanter CR 2\"")],
    tools: [
      "bestiary.search",
      "actor.from_compendium",
      "actor.from_statblock",
      "sheet.read",
      "chat.post",
    ],
    render(args) {
      return [
        `You are the GM. The party has just met: ${args["concept"] ?? "someone you have not cast yet"}.`,
        "",
        `1. ${"bestiary.search"} the compendia for the closest thing. A real stat block beats an invention.`,
        `2. Found one? ${"actor.from_compendium"} it. Not found? ${"actor.from_statblock"} with a stat block you write yourself.`,
        `3. ${"sheet.read"} what you just made, so the voice you give them matches the numbers they have.`,
        `4. ${"chat.post"} them: one sentence of appearance, one of voice, and the thing they want.`,
        "",
        "Give them a name, a want, and one detail the players can grab hold of. Do not place a token unless you were asked to.",
        "",
        REFUSAL_RULE,
      ].join("\n");
    },
  },
  {
    name: "player.describe_action",
    title: "Describe your action",
    description:
      "Speak and act as one character: look at the scene, declare the action, and roll the dice the table can see.",
    args: [
      arg("action", "what your character is trying to do", true),
      arg("character", "your character's name; your token when omitted"),
    ],
    tools: ["scene.read", "token.list", "sheet.read", "dice.roll", "chat.post", "token.move"],
    render(args) {
      return [
        `You are ${args["character"] ?? "your character"}, a player at this table.`,
        "",
        `The action: ${args["action"] ?? "(none given — ask what the player wants)"}`,
        "",
        `1. ${"scene.read"} and ${"token.list"} — where you are standing and who is near you.`,
        `2. ${"sheet.read"} your own sheet if the action needs a number.`,
        `3. ${"dice.roll"} whatever the action calls for, publicly, with a \`flavor\` naming it.`,
        `4. ${"token.move"} only if the action moves you, and only your own token.`,
        `5. ${"chat.post"} the action in character, then the roll that answers it.`,
        "",
        "You may only move and speak for yourself. You never grant yourself hit points, gold or success.",
        "",
        REFUSAL_RULE,
      ].join("\n");
    },
  },
  {
    name: "referee.rule_question",
    title: "Answer a rules question",
    description:
      "Answer a question about the rules from what this world has actually loaded — its journals and its rule packages — and say when you are guessing.",
    args: [arg("question", "the question the table is asking", true)],
    // `packages` is a resource, not a tool: reading what this world has loaded is
    // `vtt://world/<id>/packages`, and a recipe that named it as a tool would be promising a
    // method the bridge does not serve.
    tools: ["document.list", "document.read", "chat.post"],
    render(args) {
      return [
        `You are the referee. The table asks: ${args["question"] ?? "(no question given)"}`,
        "",
        `1. Read the resource \`vtt://world/<id>/packages\` — which ruleset this world actually has. An answer from a book that is not loaded is not an answer.`,
        `2. ${"document.list"} and ${"document.read"} the journals for the house rule or the spell the question is about.`,
        `3. ${"chat.post"} the ruling, citing where it came from.`,
        "",
        "If the loaded material does not settle it, say so and give the ruling you would make, marked as a ruling and",
        "not as a rule. A confident citation the world cannot back is worse than an admitted guess.",
        "",
        REFUSAL_RULE,
      ].join("\n");
    },
  },
  {
    name: "strategic.advise_turn",
    title: "Advise on the turn's orders",
    description:
      "Read the order of battle and the last report, then say what the orders should be — and issue them only if you are told to.",
    args: [arg("brief", "what the commander is trying to achieve this turn")],
    tools: [
      "strategic.snapshot",
      "strategic.report",
      "strategic.order",
      "time.of_day",
      "chat.post",
    ],
    render(args) {
      return [
        `You are advising a commander. ${args["brief"] ? `Their intent: ${args["brief"]}` : "No intent given — infer one from the positions and say what you inferred."}`,
        "",
        `1. ${"strategic.snapshot"} — the armies, each unit's strength and morale, where they stand, and the turn's phase.`,
        `2. ${"strategic.report"} — what last turn cost, if there has been one.`,
        `3. ${"time.of_day"} if the light or the hour matters to the plan.`,
        `4. ${"chat.post"} the advice: what each unit should do and why, in the commander's terms.`,
        `5. ${"strategic.order"} — **only** if you were explicitly told to issue them. Advising and commanding are different acts.`,
        "",
        "A unit's models are the pool's truth: `96/120 standing` means twenty-four of them are gone.",
        "",
        REFUSAL_RULE,
      ].join("\n");
    },
  },
  {
    name: "hexcrawl.travel_day",
    title: "Run a day on the road",
    description:
      "March the party through a day of overland travel: the ground, the hours it costs, what they find, and what finds them.",
    args: [
      arg("destination", "the cell they are heading for, \"col,row\""),
      arg("hours", "how long they march; a full day when omitted"),
    ],
    tools: [
      "hexcrawl.cells",
      "hexmap.render",
      "hex.read",
      "time.of_day",
      "travel.plan",
      "travel.advance",
      "encounter.roll",
      "encounter.place",
      "combat.start",
      "chat.post",
    ],
    render(args) {
      return [
        "You are the GM running a day on the road.",
        "",
        `1. ${"hexcrawl.cells"} — the map as the party has seen it. A cell that is not listed is one they have not been shown.`,
        `2. ${"hexmap.render"} — the shape of the ground around them.`,
        `3. ${"time.of_day"} — the hour they set out at, and the light they have left.`,
        `4. ${"travel.plan"} the route${args["destination"] ? ` to ${args["destination"]}` : ""}, then ${"travel.advance"}${args["hours"] ? ` by ${args["hours"]} hours` : " a day's march"}. One call moves the clock, the party and anything they find, together.`,
        `5. ${"hex.read"} the cell they end in, then ${"encounter.roll"} it. A roll that fires names the table and the entry.`,
        `6. ${"encounter.place"} puts tokens down — only once you have described what they see.`,
        `7. ${"chat.post"} the day: the ground, the hours, the weather of it, and the moment something happens.`,
        "",
        "Terrain prices the march: forest is two hours a hex at a normal pace, plains one. The clock is the world's,",
        "so night falls when it falls — if they are still walking in the dark, say so.",
        "",
        REFUSAL_RULE,
      ].join("\n");
    },
  },
];

/** `prompts/list` — the catalogue, in the shape MCP returns it. */
export function promptList(): Array<{
  name: string;
  title: string;
  description: string;
  arguments?: AgentPromptArg[];
}> {
  return AGENT_PROMPTS.map((prompt) => ({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    ...(prompt.args && prompt.args.length > 0 ? { arguments: [...prompt.args] } : {}),
  }));
}

/** `prompts/get` — one recipe, as a single user message. Null when no such prompt exists. */
export function promptGet(
  name: string,
  args: Record<string, string> = {},
): { description: string; messages: Array<{ role: "user"; content: { type: "text"; text: string } }> } | null {
  const prompt = AGENT_PROMPTS.find((row) => row.name === name);
  if (!prompt) return null;
  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text: prompt.render(args) },
      },
    ],
  };
}

/**
 * Every tool a recipe names must be one the bridge actually serves. Checked in the tests against
 * `AGENT_TOOLS`, because a prompt is a promise about the catalogue and a broken one is invisible
 * until a client follows it.
 */
export function promptToolNames(): string[] {
  const out = new Set<string>();
  for (const prompt of AGENT_PROMPTS) for (const tool of prompt.tools) out.add(tool);
  return [...out].sort();
}

export const SERVED_TOOL_NAMES: readonly string[] = AGENT_TOOLS.map((tool) => tool.name);
