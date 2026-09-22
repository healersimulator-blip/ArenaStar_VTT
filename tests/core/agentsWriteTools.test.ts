// MCP connector §5.2/5.3/5.5 — the write half: the gate, the whitelist, dryRun/confirm, and the
// promise that one tool call is one envelope. The host is faked here (a writer that records), so
// what these tests prove is the *tool's* judgement; `mcpBridge.test.ts` proves the real one.
import { describe, expect, test } from "vitest";
import {
  AGENT_PRESETS,
  grantFor,
  narrow,
} from "../../src/core/agents/capabilities";
import { refusalFor } from "../../src/core/agents/capabilities";
import {
  WRITE_TOOLS,
  MAX_OPS_PER_CALL,
  NO_WRITER,
} from "../../src/core/agents/writeTools";
import { AGENT_TOOLS, callTool } from "../../src/core/agents/tools";
import type { Json } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type {
  AgentSubmitResult,
  AgentWriter,
  ToolContext,
} from "../../src/core/agents/types";
import { fakeView, TOKENS } from "./agentsFixture";

/** A writer that records what it was asked to do and answers with a canned verdict. */
function fakeWriter(
  verdict: AgentSubmitResult = { ok: true, seq: 91, txId: "tx-1" },
) {
  const calls: Op[][] = [];
  const writer: AgentWriter = {
    async submit(ops) {
      calls.push(ops);
      return verdict;
    },
    async undoOwn() {
      return { ok: true, what: "2 op(s) from seq 91" };
    },
  };
  return { writer, calls };
}

const view = fakeView();

function ctxWith(
  writer: AgentWriter | undefined,
  grant = grantFor("gm"),
): ToolContext {
  return writer ? { view, grant, writer } : { view, grant };
}

const call = (name: string, args: Record<string, Json>, ctx: ToolContext) =>
  callTool({ name, args }, ctx);

const textOf = async (
  name: string,
  args: Record<string, Json>,
  ctx: ToolContext,
) => {
  const answered = await call(name, args, ctx);
  expect(answered.kind).toBe("result");
  if (answered.kind !== "result") return "";
  return answered.result.content[0]?.text ?? "";
};

describe("the gate: the grant matrix (§8 Phase 2)", () => {
  test("every preset is allowed or refused exactly as its capability list says", async () => {
    const args: Record<string, Record<string, Json>> = {
      "document.create": { coll: "actors", name: "Goblin" },
      "document.update": { coll: "actors", id: "a1", diff: { "system.hp": 5 } },
      "document.delete": { coll: "scenes", id: "s2", confirm: true },
      "token.move": { tokenId: "t-vex", col: 2, row: 2 },
      "token.properties": { tokenId: "t-vex", disposition: "hostile" },
      "scene.create": { name: "Camp" },
      "scene.update": { diff: { name: "Camp" } },
      "scene.activate": { sceneId: "s2" },
      "chat.post": { text: "hello" },
      "undo.last": {},
    };

    for (const preset of AGENT_PRESETS) {
      const grant = grantFor(preset);
      const { writer } = fakeWriter();
      for (const tool of WRITE_TOOLS) {
        const answered = await call(
          tool.name,
          args[tool.name] ?? {},
          ctxWith(writer, grant),
        );
        expect(answered.kind, `${preset} / ${tool.name}`).toBe("result");
        if (answered.kind !== "result") continue;
        // Every write tool declares a capability (asserted below), so this is never null.
        const capability = tool.capability;
        if (!capability) throw new Error(`${tool.name} declares no capability`);
        const allowed = grant.capabilities.includes(capability);
        if (allowed) {
          expect(
            answered.result.isError,
            `${preset} / ${tool.name} should be allowed`,
          ).toBeUndefined();
        } else {
          expect(
            answered.result.isError,
            `${preset} / ${tool.name} should be refused`,
          ).toBe(true);
          expect(answered.result.content[0]?.text).toBe(refusalFor(capability));
        }
      }
    }
  });

  test("a write with no session to attribute it to says so, rather than failing oddly", async () => {
    const args: Record<string, Record<string, Json>> = {
      "document.create": { coll: "actors", name: "Goblin" },
      "document.update": { coll: "scenes", id: "s1", diff: { name: "Camp" } },
      "document.delete": { coll: "scenes", id: "s2", confirm: true },
      "token.move": { tokenId: "t-vex", col: 2, row: 2 },
      "token.properties": { tokenId: "t-vex", disposition: "hostile" },
      "scene.create": { name: "Camp" },
      "scene.update": { diff: { name: "Camp" } },
      "scene.activate": { sceneId: "s2" },
      "chat.post": { text: "hello" },
      "undo.last": {},
    };
    for (const tool of WRITE_TOOLS) {
      const answered = await call(
        tool.name,
        args[tool.name] ?? {},
        ctxWith(undefined),
      );
      expect(answered.kind).toBe("result");
      if (answered.kind !== "result") continue;
      expect(answered.result.isError).toBe(true);
      expect(answered.result.content[0]?.text).toBe(NO_WRITER);
    }
  });
});

describe("document.create (§5.3)", () => {
  test("builds one create op, submits it once, and reads the result back", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "document.create",
      { coll: "actors", name: "Goblin" },
      ctxWith(writer),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    const op = calls[0]?.[0];
    expect(op?.kind).toBe("create");
    if (op?.kind !== "create") return;
    expect(op.coll).toBe("actors");
    const data = op.data as unknown as Record<string, Json>;
    expect(data).toMatchObject({
      type: "actor",
      name: "Goblin",
      items: [],
      effects: [],
    });
    expect(data["ownership"]).toEqual({ default: 1 }); // LIMITED, the app's own default
    expect(typeof data["_id"]).toBe("string");
    expect(body).toContain('created actors "Goblin"');
  });

  test("a create in a collection the host owns is refused with the reason", async () => {
    const { writer, calls } = fakeWriter();
    const users = await textOf(
      "document.create",
      { coll: "users", name: "Impostor" },
      ctxWith(writer),
    );
    expect(users).toContain("users are assigned by the host");
    const scenes = await textOf(
      "document.create",
      { coll: "scenes", name: "Board" },
      ctxWith(writer),
    );
    expect(scenes).toContain("use scene.create");
    expect(calls).toHaveLength(0);
  });

  test("a collection with no create says which ones do", async () => {
    const body = await textOf(
      "document.create",
      { coll: "spells", name: "Fireball" },
      ctxWith(fakeWriter().writer),
    );
    expect(body).toContain('no create for collection "spells"');
    expect(body).toContain("actors, items, journals");
  });

  test("a required argument is a malformed call, not a refusal", async () => {
    const answered = await call(
      "document.create",
      { coll: "messages", name: "note" },
      ctxWith(fakeWriter().writer),
    );
    expect(answered).toMatchObject({ kind: "invalid" });
    if (answered.kind === "invalid")
      expect(answered.error).toContain('needs "content"');
  });
});

describe("document.update is a whitelist (§5.3)", () => {
  test("ownership, _id and flags are never writable, and the refusal names what is", async () => {
    const { writer, calls } = fakeWriter();
    for (const diff of [
      { ownership: { default: 3 } },
      { _id: "stolen" },
      { "flags.core.evil": true },
      { "system.hp": 5, ownership: { default: 3 } },
    ]) {
      const body = await textOf(
        "document.update",
        { coll: "actors", id: "a1", diff: diff as unknown as Json },
        ctxWith(writer),
      );
      expect(body).toContain("may not write");
      expect(body).toContain("writable paths are name.*, system.*");
    }
    expect(calls).toHaveLength(0);
  });

  test("`system.*` is writable, and only the named paths go in the diff", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "document.update",
      {
        coll: "actors",
        id: "a-vex",
        diff: { "system.hp": 12, name: "Vex the Brave" },
      },
      ctxWith(writer),
    );
    expect(calls[0]?.[0]).toMatchObject({
      kind: "update",
      ref: { coll: "actors", id: "a-vex" },
      diff: { "system.hp": 12, name: "Vex the Brave" },
    });
    expect(body).toContain("updated actors/a-vex");
  });
});

describe("document.delete wants confirming (§7.4)", () => {
  test("without confirm it refuses and offers the dry run", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "document.delete",
      { coll: "scenes", id: "s2" },
      ctxWith(writer),
    );
    expect(body).toContain("needs confirm: true");
    expect(body).toContain("The Barrow");
    expect(calls).toHaveLength(0);
  });

  test("dryRun describes what it would remove and changes nothing", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "document.delete",
      { coll: "scenes", id: "s2", dryRun: true },
      ctxWith(writer),
    );
    expect(body).toContain("dry run");
    expect(body).toContain('would delete scenes "The Barrow"');
    expect(calls).toHaveLength(0);
  });

  test("dryRun and confirm together is a malformed call — pick one", async () => {
    const answered = await call(
      "document.delete",
      { coll: "scenes", id: "s2", dryRun: true, confirm: true },
      ctxWith(fakeWriter().writer),
    );
    expect(answered).toMatchObject({ kind: "invalid" });
  });

  test("with confirm it deletes, and the answer is the post-state (§6.3)", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "document.delete",
      { coll: "scenes", id: "s2", confirm: true },
      ctxWith(writer),
    );
    expect(calls[0]).toHaveLength(1);
    expect(body).toContain('deleted scenes "The Barrow" [s2]');
  });

  test("a delete whose target this agent cannot see names the ones it can", async () => {
    const body = await textOf(
      "document.delete",
      { coll: "scenes", id: "nope", confirm: true },
      ctxWith(fakeWriter().writer),
    );
    expect(body).toContain('no scenes "nope" in this replica');
    expect(body).toContain("document.list names the ones you may see");
  });
});

describe("the host's verdict is passed through, not summarised", () => {
  test("a refusal from the host reaches the model in the host's words", async () => {
    const { writer } = fakeWriter({
      ok: false,
      reason: "forbidden",
      error: "delete scenes",
    });
    const body = await textOf(
      "document.delete",
      { coll: "scenes", id: "s1", confirm: true },
      ctxWith(writer),
    );
    expect(body).toBe(
      "the host refused this change (forbidden): delete scenes",
    );
  });
});

describe("tokens (§5.3)", () => {
  test("a cell is converted with the scene's own grid", async () => {
    const { writer, calls } = fakeWriter();
    await textOf(
      "token.move",
      { tokenId: "t-vex", col: 4, row: 3 },
      ctxWith(writer),
    );
    // 100 px cells, centred: the model names a cell, the op carries pixels.
    expect(calls[0]?.[0]).toMatchObject({ diff: { x: 450, y: 350 } });
    expect(calls[0]?.[0]).toMatchObject({
      ref: {
        coll: "tokens",
        id: "t-vex",
        parent: { coll: "scenes", id: "s1" },
      },
    });
  });

  test("half a cell is a malformed call", async () => {
    const answered = await call(
      "token.move",
      { tokenId: "t-vex", col: 4 },
      ctxWith(fakeWriter().writer),
    );
    expect(answered).toMatchObject({ kind: "invalid" });
    if (answered.kind === "invalid")
      expect(answered.error).toContain("both col and row");
  });

  test("a token this agent cannot see is refused, not invented", async () => {
    const body = await textOf(
      "token.move",
      { tokenId: "t-ghost", col: 1, row: 1 },
      ctxWith(fakeWriter().writer),
    );
    expect(body).toContain('no token "t-ghost" on Goblinwood');
  });

  test("properties are set on the embedded token, and a bad disposition is malformed", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "token.properties",
      { tokenId: "t-gob", disposition: "friendly", hidden: true },
      ctxWith(writer),
    );
    expect(calls[0]?.[0]).toMatchObject({
      diff: { disposition: "friendly", hidden: true },
      ref: {
        coll: "tokens",
        id: "t-gob",
        parent: { coll: "scenes", id: "s1" },
      },
    });
    // The read-back is the replica's own answer, and a fake submit does not change the fixture —
    // which is the point of reading back instead of echoing the request.
    expect(body).toContain("Goblin [t-gob]");

    const bad = await call(
      "token.properties",
      { tokenId: "t-gob", disposition: "grumpy" },
      ctxWith(fakeWriter().writer),
    );
    expect(bad).toMatchObject({ kind: "invalid" });
  });

  test("a hidden token is not addressable without gmOnly.read — the gate is on writes too", async () => {
    // The projection is the first gate, but the bridge in Phase 2 still reads the GM's replica, so
    // the write tools apply the same rule: an id this agent cannot read is not a target it may move.
    const mover = narrow(grantFor("observer"), ["token.move"]);
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "token.move",
      { tokenId: "t-amb", col: 1, row: 1 },
      { view, grant: mover, writer },
    );
    expect(body).toContain('no token "t-amb" on Goblinwood');
    expect(body).toContain("token.list names the ones you may see");
    expect(calls).toHaveLength(0);

    // With gmOnly.read the same call is allowed — the capability is the difference, not the token.
    const allowed = await textOf(
      "token.move",
      { tokenId: "t-amb", col: 1, row: 1 },
      {
        view,
        grant: narrow(grantFor("observer"), ["token.move", "gmOnly.read"]),
        writer: fakeWriter().writer,
      },
    );
    expect(allowed).not.toContain("no token");
    expect(TOKENS.some((t) => t.id === "t-amb")).toBe(true);
  });
});

describe("scenes (§5.2)", () => {
  test("scene.activate switches one on and the other off in a single envelope", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "scene.activate",
      { sceneId: "s2" },
      ctxWith(writer),
    );
    expect(calls).toHaveLength(1); // one envelope, never a per-scene submission
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]).toEqual([
      {
        kind: "update",
        ref: { coll: "scenes", id: "s1" },
        diff: { active: false },
      },
      {
        kind: "update",
        ref: { coll: "scenes", id: "s2" },
        diff: { active: true },
      },
    ]);
    expect(body).toContain("The Barrow is now the active scene");
  });

  test("activating the scene that is already active changes nothing", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "scene.activate",
      { sceneId: "s1" },
      ctxWith(writer),
    );
    expect(body).toBe("Goblinwood is already the active scene");
    expect(calls).toHaveLength(0);
  });

  test("one call is capped, because a batched world is not undoable in one click", async () => {
    // Every scene active is not a world this app makes, but it is what a bad import leaves behind,
    // and activating one of them would then be an op per scene. One call may still not be that.
    const many = fakeView({
      scenes: () =>
        Array.from({ length: MAX_OPS_PER_CALL + 5 }, (_, i) => ({
          id: `s${i}`,
          name: `Scene ${i}`,
          active: true,
          width: 100,
          height: 100,
          grid: {
            type: "square",
            size: 100,
            distance: 5,
            units: "ft",
            hexLayout: "oddQ",
          },
          darkness: 0,
          tokens: 0,
          walls: 0,
          fog: { enabled: false, mode: "none" },
        })),
    });
    const answered = await callTool(
      { name: "scene.activate", args: { sceneId: "s1" } },
      { view: many, grant: grantFor("gm"), writer: fakeWriter().writer },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toContain(
      `capped at ${MAX_OPS_PER_CALL}`,
    );
  });

  test("scene.update refuses to rewrite a scene's tokens — there is a tool for that", async () => {
    const body = await textOf(
      "scene.update",
      { diff: { tokens: [] } },
      ctxWith(fakeWriter().writer),
    );
    expect(body).toContain('scene.update may not write "tokens"');
    expect(body).toContain("Tokens, walls and fog have their own tools");
  });
});

describe("chat and undo (§5.5, §5.1)", () => {
  test("chat.post creates one card with an empty author — the host stamps who spoke", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "chat.post",
      { text: "the door is locked" },
      ctxWith(writer),
    );
    expect(calls[0]?.[0]).toMatchObject({
      kind: "create",
      coll: "messages",
      data: {
        author: "",
        content: "the door is locked",
        whisper: [],
        roll: null,
      },
    });
    expect(body).toContain('said: "the door is locked"');
  });

  test("a whisper needs chat.whisper, even for a GM preset narrowed by hand", async () => {
    const grant = narrow(grantFor("gm"), ["chat.speak"]);
    const body = await textOf(
      "chat.post",
      { text: "psst", to: ["u-vex"] },
      ctxWith(fakeWriter().writer, grant),
    );
    expect(body).toContain("this agent may not whisper");
  });

  test("undo.last undoes the agent's own change and reports what", async () => {
    const { writer } = fakeWriter();
    const body = await textOf("undo.last", {}, ctxWith(writer));
    expect(body).toContain("undone: 2 op(s) from seq 91");
  });

  test("a connection with no undo refuses rather than undoing the GM's move", async () => {
    const { writer } = fakeWriter();
    const readOnly: AgentWriter = { submit: writer.submit };
    const body = await textOf("undo.last", {}, ctxWith(readOnly));
    expect(body).toBe("this connection cannot undo");
  });
});

describe("the catalogue", () => {
  test("every write tool names one capability, and all ten are registered", () => {
    expect(WRITE_TOOLS).toHaveLength(10);
    for (const tool of WRITE_TOOLS) expect(tool.capability).not.toBeNull();
    for (const tool of WRITE_TOOLS) {
      expect(AGENT_TOOLS.map((t) => t.name)).toContain(tool.name);
    }
  });
});
