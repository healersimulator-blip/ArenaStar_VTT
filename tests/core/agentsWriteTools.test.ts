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
      "actor.from_compendium": { entryId: "goblin" },
      "actor.from_statblock": { text: "Goblin Warrior CR 1/3" },
      "travel.plan": { path: ["0,0", "1,0"] },
      "travel.advance": { seconds: 3600 },
      "encounter.roll": { key: "1,0" },
      "encounter.place": { actors: [{ actorId: "a-vex", count: 1 }] },
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
      "actor.from_compendium": { entryId: "goblin" },
      "actor.from_statblock": { text: "Goblin Warrior CR 1/3" },
      "travel.plan": { path: ["0,0", "1,0"] },
      "travel.advance": { seconds: 3600 },
      "encounter.roll": { key: "1,0" },
      "encounter.place": { actors: [{ actorId: "a-vex", count: 1 }] },
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

describe("actors from the library and from text (§5.4)", () => {
  test("from_compendium creates the pack's own document, with a fresh id, in one envelope", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "actor.from_compendium",
      { entryId: "goblin" },
      ctxWith(writer),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    const op = calls[0]?.[0];
    expect(op?.kind).toBe("create");
    if (op?.kind !== "create") return;
    // The entry's payload, not a re-derivation of it: what the Compendia panel's Import button
    // would have submitted, with an id of this world's own.
    expect(op.coll).toBe("actors");
    expect(op.data["name"]).toBe("Goblin");
    expect(op.data["system"]).toMatchObject({ pf1e: { hpMax: 6 } });
    expect(String(op.data["_id"])).not.toBe("goblin");
    expect(body).toContain("imported Goblin from bestiary as actor");
  });

  test("placing a token is the same call: two ops, one envelope, and it names the cell", async () => {
    const { writer, calls } = fakeWriter();
    await textOf(
      "actor.from_compendium",
      { entryId: "goblin", col: 4, row: 3 },
      ctxWith(writer),
    );
    // One call, one envelope: the actor and its token land together or not at all.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    const token = calls[0]?.[1];
    expect(token).toMatchObject({
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: "s1" },
    });
    // The actor id the token links to is the one this call created — not the entry's pack id.
    const created = calls[0]?.[0];
    if (created?.kind === "create" && token?.kind === "create") {
      const linked = token.data as unknown as Record<string, Json>;
      expect(linked["actorId"]).toBe(created.data["_id"]);
    }
  });

  test("half a cell is a malformed call, not a refusal", async () => {
    const bad = await call(
      "actor.from_compendium",
      { entryId: "goblin", col: 4 },
      ctxWith(fakeWriter().writer),
    );
    expect(bad.kind).toBe("invalid");
    if (bad.kind === "invalid")
      expect(bad.error).toContain("both col and row");
  });

  test("an off-map cell comes back as the map's own sentence", async () => {
    // The cell is checked where the map is: the tool names a cell, the view owns the geometry.
    const tight = fakeView({
      tokenCreate: () => ({
        error: "cell 40,3 is off Goblinwood — it is 12×9 cells",
      }),
    });
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "actor.from_compendium",
      { entryId: "goblin", col: 40, row: 3 },
      { view: tight, grant: grantFor("gm"), writer },
    );
    expect(body).toContain("it is 12×9 cells");
    expect(calls).toHaveLength(0);
  });

  test("an entry that is not an actor is refused, and the refusal says what to use instead", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "actor.from_compendium",
      { entryId: "fireball" },
      ctxWith(writer),
    );
    expect(body).toContain("not an actor");
    expect(calls).toHaveLength(0);
  });

  test("stocking the bestiary is not permission to put things on the table", async () => {
    // doc.create without token.move: the import is allowed, the placement is not.
    const grant = narrow(grantFor("gm"), ["doc.create"]);
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "actor.from_compendium",
      { entryId: "goblin", col: 1, row: 1 },
      { view, grant, writer },
    );
    expect(body).toContain("not place tokens");
    expect(calls).toHaveLength(0);
  });

  test("a replica with no packs says so, rather than finding nothing", async () => {
    const bare = fakeView();
    delete bare.compendiumEntry; // a replica with the packs runtime not wired up
    const { writer, calls } = fakeWriter();
    const answered = await call(
      "actor.from_compendium",
      { entryId: "goblin" },
      { view: bare, grant: grantFor("gm"), writer },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toContain("no compendium packs");
    expect(calls).toHaveLength(0);
  });

  test("from_statblock reads the stat block and hands the importer's report back", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "actor.from_statblock",
      { text: "Goblin Warrior CR 1/3" },
      ctxWith(writer),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.kind).toBe("create");
    // The report is the point: what came across, and what the source stated that this app does
    // not place. An agent that reads it can tell the table; one that does not, cannot.
    expect(body).toContain("from a stat block");
    expect(body).toContain("hit points: 6/6");
    expect(body).toContain("no ability scores in the text");
  });

  test("from_statblock passes the importer's own refusal through, verbatim", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "actor.from_statblock",
      { text: "a bag of holding and a rope" },
      ctxWith(writer),
    );
    expect(body).toContain("that text did not read as a character");
    expect(body).toContain("a stat block starts with the creature's name and its CR");
    expect(calls).toHaveLength(0);
  });

  test("dryRun describes the import and changes nothing", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "actor.from_compendium",
      { entryId: "goblin", col: 2, row: 2, dryRun: true },
      ctxWith(writer),
    );
    expect(body).toContain("dry run");
    expect(body).toContain("create actors");
    expect(body).toContain("create tokens in scenes/s1");
    expect(calls).toHaveLength(0);
  });
});

describe("the march and the encounter (§5.6, F1)", () => {
  test("travel.plan commits a route in one envelope and reads it back", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "travel.plan",
      { path: ["0,0", "1,0", "1,1"] },
      ctxWith(writer),
    );
    expect(calls).toHaveLength(1);
    expect(body).toContain("route committed: 3 cells");
    // The answer is the world as it now is, including what walking the rest costs.
    expect(body).toContain("3 cells ahead");
    expect(body).toContain("of marching left");
  });

  test("an empty path calls the march off, and that is not an error", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf("travel.plan", { path: [] }, ctxWith(writer));
    expect(body).toContain("called off");
    expect(calls).toHaveLength(0);
  });

  test("travel.advance walks the party and says what the march found", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "travel.advance",
      { seconds: 3600 },
      ctxWith(writer),
    );
    // One call, one envelope: the clock, the route, the party and the reveals land together.
    expect(calls).toHaveLength(1);
    expect(body).toContain("marched 1 h");
    expect(body).toContain("stands at 1,0");
    expect(body).toContain("crossed:");
    expect(body).toContain("1,0 — 1 h · triggers moving");
  });

  test("a march of no time at all is a malformed call", async () => {
    const answered = await call(
      "travel.advance",
      { seconds: 0 },
      ctxWith(fakeWriter().writer),
    );
    expect(answered.kind).toBe("invalid");
    if (answered.kind === "invalid")
      expect(answered.error).toContain("positive number of seconds");
  });

  test("encounter.roll names the die, the table and the entry", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "encounter.roll",
      { key: "1,0" },
      ctxWith(writer),
    );
    expect(body).toContain("Goblinwood raids [tbl-goblin] rolled 12 on 1d20");
    expect(body).toContain("Goblin warband ×3");
    expect(body).toContain("encounter.place puts them on the map");
    // A firing table writes its ledger: a die you may roll again is not a die.
    expect(calls).toHaveLength(1);
  });

  test("encounter.place puts the actors down, and needs token.move to do it", async () => {
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "encounter.place",
      { actors: [{ actorId: "a-vex", count: 2 }], key: "1,0" },
      ctxWith(writer),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: "s1" },
    });
    expect(body).toContain("placed");

    // hexcrawl.travel alone is not permission to put tokens on the table.
    const narrow_ = narrow(grantFor("gm"), ["hexcrawl.travel"]);
    const refused = await textOf(
      "encounter.place",
      { actors: [{ actorId: "a-vex", count: 1 }] },
      { view, grant: narrow_, writer: fakeWriter().writer },
    );
    expect(refused).toContain("not place tokens");
  });

  test("both dryRun before either of them touches the world", async () => {
    const { writer, calls } = fakeWriter();
    const planned = await textOf(
      "travel.plan",
      { path: ["0,0", "1,0"], dryRun: true },
      ctxWith(writer),
    );
    expect(planned).toContain("dry run");
    const marched = await textOf(
      "travel.advance",
      { seconds: 7200, dryRun: true },
      ctxWith(writer),
    );
    expect(marched).toContain("dry run");
    expect(calls).toHaveLength(0);
  });

  test("a grant without hexcrawl.read does not get to roll the tables", async () => {
    const grant = narrow(grantFor("observer"), ["world.read"]);
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "encounter.roll",
      { key: "1,0" },
      { view, grant, writer },
    );
    expect(body).toBe(refusalFor("hexcrawl.read"));
    expect(calls).toHaveLength(0);
  });
});

describe("token.move is ownership-scoped (§8 Phase 3)", () => {
  test("a grant that is not the GM's moves its own token", async () => {
    const mover = narrow(grantFor("player"), ["token.move"]);
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "token.move",
      { tokenId: "t-vex", col: 2, row: 2 },
      { view, grant: mover, writer },
    );
    expect(calls).toHaveLength(1);
    expect(body).not.toContain("not yours");
  });

  test("the party's other tokens are not the agent's to move, however well it can see them", async () => {
    // Seeing a token is not permission to move it: the player shell has always drawn that line at
    // ownership, and an agent playing one character does not get to place the others.
    const mover = narrow(grantFor("player"), ["token.move"]);
    const { writer, calls } = fakeWriter();
    const body = await textOf(
      "token.move",
      { tokenId: "t-gob", col: 2, row: 2 },
      { view, grant: mover, writer },
    );
    expect(body).toContain('token "t-gob" is not yours to move');
    expect(body).toContain("token.list marks the tokens you own");
    expect(calls).toHaveLength(0);

    // The GM's grant moves anything: the difference is the grant, not the token.
    const gmBody = await textOf(
      "token.move",
      { tokenId: "t-gob", col: 2, row: 2 },
      ctxWith(fakeWriter().writer),
    );
    expect(gmBody).not.toContain("not yours");
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
  test("every write tool names one capability, and all sixteen are registered", () => {
    expect(WRITE_TOOLS).toHaveLength(16);
    for (const tool of WRITE_TOOLS) expect(tool.capability).not.toBeNull();
    for (const tool of WRITE_TOOLS) {
      expect(AGENT_TOOLS.map((t) => t.name)).toContain(tool.name);
    }
  });
});
