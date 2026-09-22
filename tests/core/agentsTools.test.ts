// MCP connector §5 — the tool catalogue: the manifest a client sees, and the three ways a call ends
// (answered, refused, or rejected as malformed).
import { describe, expect, test } from "vitest";
import {
  AGENT_CAPABILITIES,
  grantFor,
  narrow,
} from "../../src/core/agents/capabilities";
import {
  AGENT_TOOLS,
  callTool,
  inputSchemaOf,
  toolManifest,
  type AgentWorldView,
} from "../../src/core/agents/tools";
import { fakeView } from "./agentsFixture";

// The full port, from the shared fixture: this file is about the *call* (gate, schema, failure
// modes), but the tools it calls read a real-shaped view.
const view: AgentWorldView = fakeView();

const gm = grantFor("gm");

describe("the tool manifest (MCP plan §5)", () => {
  test("tools/list names every tool, in the order a client should read them", () => {
    const manifest = toolManifest();
    // whoami first: it is the answer to "what am I allowed to do", and nothing else makes sense
    // before it.
    expect(manifest.map((t) => t.name)).toEqual([
      "whoami",
      "world.info",
      "world.snapshot",
      "scene.list",
      "scene.read",
      "scene.describe",
      "map.render",
      "document.list",
      "document.read",
      "token.list",
      "chat.read",
      "sheet.read",
      "bestiary.search",
      "hexcrawl.cells",
      "hex.read",
      "hex.describe",
      "hexmap.render",
      "time.get",
      "time.of_day",
      "combat.state",
      "fog.state",
      "strategic.snapshot",
      "strategic.report",
      "document.create",
      "document.update",
      "document.delete",
      "actor.from_compendium",
      "actor.from_statblock",
      "travel.plan",
      "travel.advance",
      "encounter.roll",
      "encounter.place",
      "time.advance",
      "time.set",
      "combat.start",
      "combat.add",
      "combat.next",
      "combat.end",
      "dice.roll",
      "dice.apply",
      "fog.reveal",
      "fog.hide",
      "strategic.order",
      "token.move",
      "token.properties",
      "scene.create",
      "scene.update",
      "scene.activate",
      "chat.post",
      "undo.last",
    ]);
    for (const tool of manifest) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  test("a schema with no arguments still forbids extra ones", () => {
    expect(inputSchemaOf({ properties: {} })).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(inputSchemaOf({ properties: {}, required: [] })).not.toHaveProperty(
      "required",
    );
    expect(
      inputSchemaOf({
        properties: { id: { type: "string", description: "a scene id" } },
        required: ["id"],
      }),
    ).toMatchObject({ required: ["id"] });
  });
});

describe("tools/call", () => {
  test("world.info reads the world back, and the answer is the replica's state", async () => {
    const answered = await callTool(
      { name: "world.info", args: {} },
      { view, grant: gm },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBeUndefined();
    expect(answered.result.content[0]?.text).toContain('World "World One"');
    expect(answered.result.content[0]?.text).toContain("seq 42");
    expect(answered.result.structuredContent).toMatchObject({
      name: "World One",
      seq: 42,
    });
  });

  test("whoami is never refused, and says what is withheld", async () => {
    const answered = await callTool(
      { name: "whoami" },
      { view, grant: narrow(grantFor("gm"), ["world.read"]) },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("Vex (agent)");
    // The session (whose replica the reads come from) and the grant (the ceiling) are named apart:
    // an agent that reads "role GM" and stops there would draw exactly the wrong conclusion.
    expect(body).toContain("session role ASSISTANT");
    expect(body).toContain(
      'Grant: preset "gm", role GM — narrower than the session',
    );
    expect(body).toContain(`Withheld (${AGENT_CAPABILITIES.length - 1}):`);
    expect(body).toContain("doc.delete");
  });

  test("whoami survives an unbound session", async () => {
    const answered = await callTool(
      { name: "whoami" },
      { view: { ...view, identity: () => null }, grant: gm },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.content[0]?.text).toContain(
      "No session is bound yet",
    );
  });

  test("a refused call is a tool error with the reason in plain words — not a protocol error", async () => {
    const observer = narrow(grantFor("observer"), ["chat.read"]);
    const answered = await callTool(
      { name: "world.info" },
      { view, grant: observer },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toBe(
      "this agent may not read the world — ask the GM to change its grant",
    );
  });

  test("a malformed call is invalid, so the client sees a client bug and not a policy", async () => {
    const unknownTool = await callTool(
      { name: "scene.delete" },
      { view, grant: gm },
    );
    expect(unknownTool).toMatchObject({ kind: "invalid" });
    if (unknownTool.kind === "invalid")
      expect(unknownTool.error).toContain("no tool named");

    const noName = await callTool({ name: 7 }, { view, grant: gm });
    expect(noName).toMatchObject({ kind: "invalid" });

    const notObject = await callTool(
      { name: "world.info", args: [1, 2] },
      { view, grant: gm },
    );
    expect(notObject).toMatchObject({ kind: "invalid" });
    if (notObject.kind === "invalid")
      expect(notObject.error).toContain("must be an object");
  });

  test("an unknown argument is rejected with the accepted list, before the gate is consulted", async () => {
    const answered = await callTool(
      { name: "world.info", args: { sceneId: "s1" } },
      { view, grant: gm },
    );
    expect(answered).toMatchObject({ kind: "invalid" });
    if (answered.kind === "invalid") {
      expect(answered.error).toBe('"world.info" takes no argument "sceneId"');
    }
  });

  test("a tool that throws comes back as an error result, never as an unanswered request", async () => {
    const boom: AgentWorldView = {
      ...view,
      worldInfo: () => {
        throw new Error("the store is gone");
      },
    };
    const answered = await callTool(
      { name: "world.info" },
      { view: boom, grant: gm },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.content[0]?.text).toContain(
      '"world.info" failed: the store is gone',
    );
  });

  test("every tool declares one capability, and the identity probe declares none", () => {
    for (const tool of AGENT_TOOLS) {
      if (tool.name === "whoami") {
        expect(tool.capability).toBeNull();
        continue;
      }
      expect(AGENT_CAPABILITIES).toContain(tool.capability);
    }
  });
});
