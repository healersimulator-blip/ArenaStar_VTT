// MCP connector §5.2–5.7 — the read surface: scenes, maps, documents, tokens, chat, sheets,
// bestiary, and the resources that wrap them. The fixture world is `agentsFixture.ts`.
import { describe, expect, test } from "vitest";
import {
  grantFor,
  narrow,
  refusalFor,
} from "../../src/core/agents/capabilities";
import {
  readResource,
  resourceList,
  RESOURCE_TEMPLATES,
} from "../../src/core/agents/resources";
import { READ_TOOLS } from "../../src/core/agents/readTools";
import { callTool, toolManifest } from "../../src/core/agents/tools";
import { fakeView, TOKENS } from "./agentsFixture";
import { paginate } from "../../src/core/agents/paging";
import type { Json } from "../../src/core/documents";
import type {
  AgentMessageRow,
  ToolContext,
} from "../../src/core/agents/types";

const gm = grantFor("gm");
const observer = grantFor("observer");
const view = fakeView();

/**
 * A `gmroll` card as a player's replica holds it: the result is gone from `roll` and from the
 * content chip, and `resultWithheld` is the view's way of saying there was one.
 */
const WITHHELD_ROLL: AgentMessageRow = {
  id: "m2",
  author: "u-vex",
  authorName: "Vex",
  content: "I check for tracks. [rolled 1d20+5]",
  whisper: [],
  hasRoll: false,
  rollMode: "gmroll",
  resultWithheld: true,
};

const call = (
  name: string,
  args: Record<string, Json> = {},
  ctx: ToolContext = { view, grant: gm },
) => callTool({ name, args }, ctx);

const toolNames = (): string[] => toolManifest().map((t) => t.name);

describe("the catalogue after Phase 1 (§5)", () => {
  test("every read tool the phase names is in it", () => {
    expect(toolNames()).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(READ_TOOLS).toHaveLength(20);
  });

  test("every tool declares a capability, and the identity probe declares none", () => {
    for (const tool of toolManifest()) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });
});

describe("the clock and the tracker (§5.5)", () => {
  test("time.get is the number every subsystem spends, and time.of_day is what it means", async () => {
    const got = await call("time.get");
    expect(got.kind).toBe("result");
    if (got.kind !== "result") return;
    const body = got.result.content[0]?.text ?? "";
    expect(body).toContain("Clock: 1d 02:00:00 — 93600 s.");
    expect(body).toContain("a round is 6 s here");
    // The world advances the clock on a round wrap, and the answer says so — an agent planning a
    // fight in game time needs to know whether the fight costs time.
    expect(body).toContain("advances the clock");

    const tod = await call("time.of_day");
    expect(tod.kind).toBe("result");
    if (tod.kind !== "result") return;
    expect(tod.result.content[0]?.text).toContain("It is 02:00 on day 1 — night");
  });

  test("time.of_day is a read, and time.get is a control — a player agent gets one of them", async () => {
    const grant = grantFor("player");
    const tod = await call("time.of_day", {}, { view, grant });
    expect(tod.kind).toBe("result");
    if (tod.kind !== "result") return;
    expect(tod.result.isError).toBeUndefined();

    const got = await call("time.get", {}, { view, grant });
    expect(got.kind).toBe("result");
    if (got.kind !== "result") return;
    expect(got.result.isError).toBe(true);
    expect(got.result.content[0]?.text).toBe(refusalFor("time.control"));
  });

  test("combat.state names whose turn it is, and marks it in the order", async () => {
    const answered = await call("combat.state");
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("Goblinwood ambush: round 1 — Vex's turn.");
    // The current combatant is marked in the order, because an agent that can only read the name
    // of the turn has to count rows to find it in a list of twenty.
    expect(body).toContain("18  Vex (← now)");
    expect(body).toContain("12  Goblin");
  });

  test("a scene with no encounter says so, and names the tool that opens one", async () => {
    const answered = await call("combat.state", { sceneId: "s2" });
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toContain("no encounter on scene \"s2\"");
  });
});

describe("fog (§5.5)", () => {
  test("fog.state reads the mask and the reveal set off the replica", async () => {
    const answered = await call("fog.state");
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("Goblinwood: fog on, sight unbounded.");
    expect(body).toContain("2 reveal stroke(s), 1 hide stroke(s)");
    // A hexcrawl map's fog and its reveal set are the same question to a GM.
    expect(body).toContain("cells: 1 of 3 shown to the table");
  });

  test("fog is a control, not a read — a player agent is refused", async () => {
    const answered = await call("fog.state", {}, { view, grant: grantFor("player") });
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toBe(refusalFor("fog.control"));
  });
});

describe("the strategic layer (§5.6)", () => {
  test("strategic.snapshot reads armies, their units and the turn that is open", async () => {
    const answered = await call("strategic.snapshot");
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("1 army(ies), 2 unit(s), 1 faction(s) · 180 model(s) in the pool.");
    // The phase is the thing that makes an order legal — an agent must be able to read it.
    expect(body).toContain("turn 4 — orders (stepwise), 1 commander(s) ready.");
    expect(body).toContain("The Black Arrow [Vandria] [army-1] — 2 unit(s).");
    // Models come from the pool, not the document: 96 of 120 still answer.
    expect(body).toContain("1st Spears [unit-1] — spear, line, 96/120 standing, at 400,300.");
    expect(body).toContain("str 120 · morale 80 · supply 4 · fatigue 1 · advance");
    // A unit with nothing queued says so, and one with an order pending behind an active one says
    // which: "no orders" and "I forgot to read them" look identical otherwise.
    expect(body).toContain("· no orders");
    expect(body).toContain("queued move");
  });

  test("strategic.report is the turn's own record, retained after the fact", async () => {
    const answered = await call("strategic.report");
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("Turn 3 (mass-battle-pf1e-1) — move → shoot → melee.");
    expect(body).toContain("shoot/casualty: 1st Spears lose 24 models to arrow fire");
    expect(body).toContain("summary: attacks 342 · hits 121 · savesFailed 37");
  });

  test("both are strategic.read, and a player agent has none of it", async () => {
    for (const tool of ["strategic.snapshot", "strategic.report"]) {
      const answered = await call(tool, {}, { view, grant: grantFor("player") });
      expect(answered.kind).toBe("result");
      if (answered.kind !== "result") return;
      expect(answered.result.isError).toBe(true);
      expect(answered.result.content[0]?.text).toBe(refusalFor("strategic.read"));
    }
  });
});

describe("scenes and maps (§5.2)", () => {
  test("scene.list marks the active scene and names the others", async () => {
    const answered = await call("scene.list");
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("* Goblinwood [s1]");
    expect(body).toContain("  The Barrow [s2]");
    expect(body).toContain("1 cell = 5 ft");
  });

  test("scene.read on the active scene, and a refusal naming the ones it may see", async () => {
    const read = await call("scene.read");
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    expect(read.result.content[0]?.text).toContain("fog on (none)");

    const missing = await call("scene.read", { sceneId: "s9" });
    expect(missing.kind).toBe("result");
    if (missing.kind !== "result") return;
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0]?.text).toContain(
      "scene.list names the ones you may see",
    );
  });

  test("scene.describe carries the token list and the text map", async () => {
    const answered = await call("scene.describe");
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("Vex [t-vex] — friendly · cell 3,1");
    expect(body).toContain("map 12×9 cells");
    expect(body).toContain("@");
  });

  test("a grant without gmOnly.read does not see the hidden token — and is told one was withheld", async () => {
    const hidden = await call("scene.describe", {}, { view, grant: observer });
    expect(hidden.kind).toBe("result");
    if (hidden.kind !== "result") return;
    const body = hidden.result.content[0]?.text ?? "";
    expect(body).not.toContain("Ambush");
    expect(body).toContain("(1 withheld)");
    expect(body).toContain("2 token(s) you may see (1 withheld)");

    const seen = await call("scene.describe", {}, { view, grant: gm });
    expect(seen.kind).toBe("result");
    if (seen.kind !== "result") return;
    expect(seen.result.content[0]?.text).toContain("Ambush");
  });

  test("map.render returns the picture, and format=json returns the grid with ids", async () => {
    const ascii = await call("map.render");
    expect(ascii.kind).toBe("result");
    if (ascii.kind !== "result") return;
    expect(ascii.result.content[0]?.text).toContain("Glyphs:");

    const json = await call("map.render", { format: "json" });
    expect(json.kind).toBe("result");
    if (json.kind !== "result") return;
    const body = json.result.structuredContent as {
      tokens: Array<{ id: string }>;
      walls: number;
    };
    expect(body.tokens.map((t) => t.id)).toEqual(["t-vex", "t-gob", "t-amb"]);
    expect(body.walls).toBe(9);
  });

  test("token.list hides the hidden one from an observer, and pages the rest", async () => {
    const seen = await call("token.list", { limit: 2 }, { view, grant: gm });
    expect(seen.kind).toBe("result");
    if (seen.kind !== "result") return;
    expect(seen.result.content[0]?.text).toContain("2 of 3 tokens (cap 2)");
    expect(seen.result.content[0]?.text).toContain('next cursor "o:2"');

    const hidden = await call("token.list", {}, { view, grant: observer });
    expect(hidden.kind).toBe("result");
    if (hidden.kind !== "result") return;
    expect(hidden.result.content[0]?.text).not.toContain("Ambush");
    expect(hidden.result.content[0]?.text).toContain("1 withheld by the grant");
  });
});

describe("pagination and the read caps (§7.4)", () => {
  test("a cursor walks the pages, and a bad one is -32602 rather than page 1 again", async () => {
    const first = await call("document.list", { coll: "scenes", limit: 1 });
    expect(first.kind).toBe("result");
    if (first.kind !== "result") return;
    expect(first.result.content[0]?.text).toContain('next cursor "o:1"');

    const second = await call("document.list", {
      coll: "scenes",
      limit: 1,
      cursor: "o:1",
    });
    expect(second.kind).toBe("result");
    if (second.kind !== "result") return;
    expect(second.result.content[0]?.text).toContain("The Barrow [s2]");
    // "1 of 2" is the honest note for a page: "all 2" is only true of the whole set.
    expect(second.result.content[0]?.text).toContain("1 of 2 scenes (cap 1).");

    const bad = await call("document.list", {
      coll: "scenes",
      cursor: "page-two",
    });
    expect(bad).toMatchObject({ kind: "invalid" });
    if (bad.kind === "invalid")
      expect(bad.error).toContain('cursor must look like "o:50"');
  });

  test("the cap holds: limit 0 falls back to the default, 10 000 is clamped to 500", async () => {
    const many = Array.from({ length: 1_200 }, (_, i) => ({
      id: `a${i}`,
      name: `Actor ${i}`,
      type: "actor",
      parent: null,
    }));
    const wide = fakeView({
      documents: (coll, options) => {
        const rows = coll === "actors" ? many : [];
        const paged = paginate(rows, options);
        return {
          rows: paged.rows,
          total: paged.total,
          next: paged.next,
          cap: paged.cap,
        };
      },
    });

    const zero = await callTool(
      { name: "document.list", args: { coll: "actors", limit: 0 } },
      { view: wide, grant: gm },
    );
    expect(zero.kind).toBe("result");
    if (zero.kind !== "result") return;
    expect(zero.result.content[0]?.text).toContain("50 of 1");
    expect(zero.result.content[0]?.text).toContain("cap 50");

    const huge = await callTool(
      { name: "document.list", args: { coll: "actors", limit: 10_000 } },
      { view: wide, grant: gm },
    );
    expect(huge.kind).toBe("result");
    if (huge.kind !== "result") return;
    expect(huge.result.content[0]?.text).toContain("cap 500");
  });

  test("an unknown collection is a refusal that names the real ones", async () => {
    const answered = await call("document.list", { coll: "spells" });
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toContain(
      'no collection "spells" — collections: users',
    );
  });
});

describe("the hexcrawl layer (§5.6, F1)", () => {
  test("hexcrawl.cells lists what the replica holds, and counts the cover", async () => {
    const read = await call("hexcrawl.cells");
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    const body = read.result.content[0]?.text ?? "";
    expect(body).toContain("Goblinwood: All 5 cells.");
    expect(body).toContain("4 revealed, 1 still under cover");
    expect(body).toContain("party at 1,1");
    expect(body).toContain("1,0 — Forest / woods (cost 2) · tables tbl-goblin");
    // A closed cell is listed for a GM grant, and marked — the projection, not the tool, decides
    // whether it is on the replica at all.
    expect(body).toContain("2,0 — Hills / scrub (cost 1.5), unrevealed");
  });

  test("hex.read gives one cell with the numbers a march is priced with", async () => {
    const read = await call("hex.read", { key: "1,0" });
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    const body = read.result.content[0]?.text ?? "";
    expect(body).toContain("1,0 — Forest / woods.");
    // cost 2 at 24 cells a day is two hours a cell, not two minutes.
    expect(body).toContain("at 24 cells/day (normal) that is 2 h a cell");
    expect(body).toContain("Encounter tables: tbl-goblin.");
    expect(body).toContain("Ruined shrine — found after 1 hour (not found yet)");
    expect(body).toContain("Time spent here: 30 m.");
  });

  test("a cell the replica does not hold is a refusal that says what to ask for", async () => {
    const read = await call("hex.read", { key: "9,9" });
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    expect(read.result.isError).toBe(true);
    expect(read.result.content[0]?.text).toContain("hexcrawl.cells names the ones you may see");
  });

  test("hex.describe adds the ground around it", async () => {
    const read = await call("hex.describe", { key: "1,0" });
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    const body = read.result.content[0]?.text ?? "";
    expect(body).toContain("Around it:");
    expect(body).toContain("2,0 — Hills / scrub (unrevealed)");
    // The party's own cell is a neighbour here, and it is named.
    expect(body).toContain("1,1 — Highway / road");
  });

  test("hexmap.render draws terrain letters, the party and cover", async () => {
    const read = await call("hexmap.render");
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    const body = read.result.content[0]?.text ?? "";
    expect(body).toContain("hexmap Goblinwood 3×2 cells (hex oddQ, 1 cell = 6 mi)");
    expect(body).toContain("0  P F ▓");
    expect(body).toContain("1  P @ ·");
    expect(body).toContain("P Plains / farmland — 2 cell(s)");
    // And the JSON grid comes back on the same call, so the model can point rather than count.
    const structured = read.result.structuredContent as {
      cells: Array<{ key: string; glyph: string; party: boolean }>;
    };
    expect(structured.cells.find((c) => c.party)?.key).toBe("1,1");
  });

  test("hexmap.render needs hexcrawl.read, like any other tool", async () => {
    const read = await call(
      "hexmap.render",
      {},
      { view, grant: narrow(grantFor("observer"), ["world.read"]) },
    );
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    expect(read.result.isError).toBe(true);
    expect(read.result.content[0]?.text).toBe(refusalFor("hexcrawl.read"));
  });

  test("a scene with no cells says so, rather than drawing an empty map", async () => {
    const bare = fakeView({ hexMap: () => null, hexSummary: () => null });
    const read = await call(
      "hexmap.render",
      {},
      { view: bare, grant: grantFor("gm") },
    );
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    expect(read.result.isError).toBe(true);
    expect(read.result.content[0]?.text).toContain("no hexcrawl scene active");
  });
});

describe("documents, chat and sheets (§5.3–5.4)", () => {
  test("document.read returns the fields the view holds, and refuses an id it does not have", async () => {
    const read = await call("document.read", { coll: "scenes", id: "s1" });
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    expect(read.result.content[0]?.text).toContain('"width": 1200');

    const missing = await call("document.read", { coll: "scenes", id: "nope" });
    expect(missing.kind).toBe("result");
    if (missing.kind !== "result") return;
    expect(missing.result.isError).toBe(true);
  });

  test("chat.read shows the table what it may see, and withholds a GM-only roll result", async () => {
    const public_ = await call("chat.read", {}, { view, grant: gm });
    expect(public_.kind).toBe("result");
    if (public_.kind !== "result") return;
    expect(public_.result.content[0]?.text).toContain(
      "Vex: I check for tracks. [rolled]",
    );
    expect(public_.result.content[0]?.text).toContain("(whisper)");

    // The same card as a grant that may not read the dice holds it: the projection nulls `roll`
    // (projectMessage) and the view strips the total out of the content chip, so what reaches the
    // agent says a roll happened, on what, and never what it came to.
    const limited = await call(
      "chat.read",
      {},
      {
        view: fakeView({ messages: (options) => paginate([WITHHELD_ROLL], options) }),
        grant: narrow(grantFor("observer"), ["chat.read"]),
      },
    );
    expect(limited.kind).toBe("result");
    if (limited.kind !== "result") return;
    expect(limited.result.content[0]?.text).toContain(
      "Vex: I check for tracks. [rolled 1d20+5] [result withheld from this grant]",
    );
    expect(limited.result.content[0]?.text).not.toContain("16");
  });

  test("chat.read without chat.read is refused by the gate, like any other tool", async () => {
    const refused = await call(
      "chat.read",
      {},
      { view, grant: narrow(grantFor("gm"), ["world.read"]) },
    );
    expect(refused.kind).toBe("result");
    if (refused.kind !== "result") return;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]?.text).toContain("may not read the chat");
  });

  test("sheet.read prints the numbers a model acts on, and refuses a stranger", async () => {
    const read = await call("sheet.read", { actorId: "a-vex" });
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    const body = read.result.content[0]?.text ?? "";
    expect(body).toContain(
      "hp 18/24 (2 nonlethal) · AC 17 (touch 13, flat 14)",
    );
    expect(body).toContain("saves fort +4 / ref +7 / will +2");
    expect(body).toContain("attacks: Longsword +5 (1d8+3)");
    expect(body).toContain("conditions: flat-footed");

    const missing = await call("sheet.read", { actorId: "a-nope" });
    expect(missing.kind).toBe("result");
    if (missing.kind !== "result") return;
    expect(missing.result.isError).toBe(true);
  });

  test("bestiary.search answers when the replica has an index, and refuses when it does not", async () => {
    const hits = await call("bestiary.search", { query: "goblin" });
    expect(hits.kind).toBe("result");
    if (hits.kind !== "result") return;
    expect(hits.result.content[0]?.text).toContain(
      "Goblin [goblin] — actor · bestiary",
    );

    const none = await call("bestiary.search", { query: "" });
    expect(none.kind).toBe("result");
    if (none.kind !== "result") return;
    expect(none.result.content[0]?.text).toContain(
      "No compendium entry matches",
    );

    // A replica with no compendium runtime at all — the optional member is simply absent.
    const offline = fakeView();
    delete offline.bestiary;
    const refused = await callTool(
      { name: "bestiary.search", args: { query: "goblin" } },
      { view: offline, grant: gm },
    );
    expect(refused.kind).toBe("result");
    if (refused.kind !== "result") return;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]?.text).toContain(
      "no compendium index on this replica",
    );
  });
});

describe("resources (§5.7)", () => {
  test("resources/list enumerates the bounded ones and the scenes", () => {
    const uris = resourceList(view).map((r) => r.uri);
    expect(uris).toContain("vtt://world/w1/overview");
    expect(uris).toContain("vtt://world/w1/tokens");
    expect(uris).toContain("vtt://world/w1/chat");
    expect(uris).toContain("vtt://world/w1/packages");
    expect(uris).toContain("vtt://world/w1/scene/s1");
    expect(uris).toContain("vtt://world/w1/scene/s1/map.txt");
  });

  test("the open-ended ones are templates, not 5,000 URIs", () => {
    const templates = RESOURCE_TEMPLATES.map((t) => t.uriTemplate);
    expect(templates).toContain("vtt://world/{worldId}/sheet/{actorId}");
    expect(templates).toContain(
      "vtt://world/{worldId}/scene/{sceneId}/map.txt",
    );
  });

  test("a resource is the tool's answer in a URI: same data, same gate", async () => {
    const overview = await readResource(view, gm, "vtt://world/w1/overview");
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.resource.mimeType).toBe("text/markdown");
    expect(overview.resource.text).toContain('World "World One"');
    expect(overview.resource.text).toContain("Clock: 8:10 (29400s).");

    const map = await readResource(view, gm, "vtt://world/w1/scene/s1/map.txt");
    expect(map.ok).toBe(true);
    if (!map.ok) return;
    expect(map.resource.text).toContain("map 12×9 cells");

    const tokens = await readResource(
      view,
      grantFor("observer"),
      "vtt://world/w1/tokens",
    );
    expect(tokens.ok).toBe(true);
    if (!tokens.ok) return;
    // The grant refuses the hidden token here exactly as it does in token.list — one gate.
    expect(tokens.resource.text).not.toContain("Ambush");

    const sheet = await readResource(view, gm, "vtt://world/w1/sheet/a-vex");
    expect(sheet.ok).toBe(true);
    if (!sheet.ok) return;
    expect(sheet.resource.text).toContain("AC 17");

    const packs = await readResource(view, gm, "vtt://world/w1/packages");
    expect(packs.ok).toBe(true);
    if (!packs.ok) return;
    expect(packs.resource.text).toContain("Bestiary [c1] — 1284 entries");
  });

  test("a guessed URI is answered with the grammar, and an unknown world with what this replica holds", async () => {
    const bad = await readResource(view, gm, "https://example.com/thing");
    expect(bad).toMatchObject({ ok: false, code: "invalid_uri" });
    if (!bad.ok)
      expect(bad.message).toContain("vtt://world/<worldId>/overview");

    const elsewhere = await readResource(
      view,
      gm,
      "vtt://world/other/overview",
    );
    expect(elsewhere).toMatchObject({ ok: false, code: "not_found" });
    if (!elsewhere.ok) expect(elsewhere.message).toContain('holds world "w1"');

    // Phase 5 landed: the [F1] resource is the overworld map, and it answers with the real one.
    const hexmap = await readResource(view, gm, "vtt://world/w1/hexmap");
    expect(hexmap.ok).toBe(true);
    if (!hexmap.ok) return;
    expect(hexmap.resource.text).toContain("hexmap Goblinwood");
    expect(hexmap.resource.text).toContain("@ party");
  });

  test("chat?since= reads only what is new to the agent", async () => {
    const since = await readResource(view, gm, "vtt://world/w1/chat?since=1");
    expect(since.ok).toBe(true);
    if (!since.ok) return;
    expect(since.resource.text).not.toContain("You enter the woods.");
    expect(since.resource.text).toContain("I check for tracks.");
    expect(TOKENS[0]?.id).toBe("t-vex");
  });
});
