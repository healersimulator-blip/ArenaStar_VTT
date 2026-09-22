/**
 * MCP connector §5.2/5.3/5.5 — the write half of the catalogue.
 *
 * Four rules shape every tool here, and they are all the same rule seen from different sides:
 * **an agent's write is a human's write.** It travels the ordinary op path, so it is validated,
 * rate-limited, replicated, attributed and undoable exactly like the GM's own click — the bridge
 * has no privilege to grant and no shortcut to take.
 *
 * 1. **One call, one envelope.** A tool builds one `Op[]` and submits it once, so the GM's undo is
 *    one click and the OpLog has one line to attribute (§6.2). Never a loop of submissions: a
 *    half-applied batch is a world nobody can describe.
 * 2. **The answer is the post-state, read back** (§6.3), never an echo of the request. "Created
 *    actor `Vex` [a-1]" is true; "created the actor you asked for" is a guess.
 * 3. **`dryRun` before `confirm`.** Anything destructive describes what it would do first, and a
 *    real delete is a separate, explicit act (§7.4).
 * 4. **A refusal is the host's own sentence.** The bridge does not guess why an op failed; it
 *    passes the host's reason through, because "forbidden: delete scenes" tells a model something
 *    that "could not delete" does not.
 *
 * The path whitelist is the reason these are *typed* tools (§5.3): the agent can write `name` and
 * `system.*`, and it cannot write `ownership`, `_id`, or anyone's `flags`.
 */
import type {
  BaseDocument,
  CollectionName,
  Json,
  SceneDocument,
  SceneGrid,
} from "../documents";
import { OWNERSHIP_LEVELS, TOP_LEVEL_COLLECTIONS } from "../documents";
import type { Op } from "../ops";
import { bool, invalid, num, numIn, obj, refusal, str, text } from "./answer";
import {
  ROUNDS_PER_DAY,
  ROUNDS_PER_HOUR,
  ROUNDS_PER_MINUTE,
} from "../clock";
import { canReadGmOnly } from "./capabilities";
import type {
  AgentCombatTurn,
  AgentTimeOps,
  AgentTokenRow,
  AgentWorldView,
  AgentWriter,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
} from "./types";

/** §7.4: one call may not rewrite the world. A batch that large is a conversation, not a tool. */
export const MAX_OPS_PER_CALL = 25;

export const NO_WRITER =
  "this connection cannot write — no agent session is bound, so there is nothing to attribute a change to";

// ─── What may be created, and what may be edited ───────────────────────────────────────────────

interface CollectionSpec {
  /** The `type` field the document carries. */
  type: string;
  /** Arguments beyond `name` this collection needs, arg → what it is for. */
  requires?: Record<string, string> | undefined;
  /** The document's non-base fields. */
  fill(args: Record<string, Json>): Record<string, Json>;
  /** Path prefixes an update may write (§5.3's whitelist). */
  writable: readonly string[];
}

const spec = (
  type: string,
  fill: CollectionSpec["fill"],
  writable: readonly string[] = ["name", "system"],
  requires?: Record<string, string>,
): CollectionSpec => ({ type, fill, writable, requires });

/**
 * The collections an agent may create in. The omissions are deliberate and each has a reason:
 * `users` (the host assigns identity — an agent that can mint a GM is the whole security model
 * inverted), `settings` (world settings and agent grants have their own tools), `compendia`
 * (asset-backed and read-only by design), `scenes` (a scene is 14 fields and a grid — that is
 * `scene.create`), and the sim's own collections (`combats`, `turns`, `armies`, …) which the
 * turn channel owns.
 */
const CREATE_SPECS: Record<string, CollectionSpec> = {
  actors: spec("actor", () => ({ items: [], effects: [] })),
  items: spec("item", () => ({ effects: [] })),
  journals: spec("journal", () => ({ pages: [] })),
  folders: spec(
    "folder",
    (args) => ({
      parent: null,
      targetType: str(args["targetType"]) ?? "actors",
    }),
    ["name", "system", "targetType", "parent"],
    {
      targetType:
        "the collection this folder holds (actors, items, journals, scenes)",
    },
  ),
  messages: spec(
    "message",
    (args) => ({
      // The host re-stamps `author` from the session (host/sync.ts:854), so the value here is
      // deliberately empty: an agent cannot claim to be somebody it is not.
      author: "",
      content: str(args["content"]) ?? "",
      flavor: str(args["flavor"]) ?? "",
      whisper: [],
      roll: null,
    }),
    ["content", "flavor"],
    { content: "the message text" },
  ),
  macros: spec(
    "macro",
    (args) => ({ kind: "chat", command: str(args["command"]) ?? "" }),
    ["name", "command"],
    { command: "the chat command the macro runs" },
  ),
  playlists: spec("playlist", () => ({ mode: "sequential", sounds: [] }), [
    "name",
    "system",
    "mode",
  ]),
  cards: spec("cards", () => ({ cards: [] }), ["name"]),
  rollTables: spec(
    "rollTable",
    (args) => ({ formula: str(args["formula"]) ?? "1d20", results: [] }),
    ["name", "formula", "results"],
    { formula: "the dice formula the table rolls (1d20, 2d6, …)" },
  ),
};

/** Collections a create is refused for, with the reason — the same list `document.list` reads. */
const CREATE_REFUSALS: Record<string, string> = {
  users: "users are assigned by the host — an agent may not mint an identity",
  settings:
    "settings are edited through world settings and agent grants, not as documents",
  compendia: "compendia are asset-backed and read-only",
  scenes: "a scene has a grid and fourteen fields — use scene.create",
  combats: "combat is run through the turn tracker (Phase 4)",
  turns: "turns belong to the strategic channel (Phase 4)",
  armies: "armies belong to the strategic layer (Phase 4)",
  factions: "factions belong to the strategic layer (Phase 4)",
  encounterTables: "encounter tables belong to the hexcrawl tools (Phase 5)",
};

const CREATABLE = Object.keys(CREATE_SPECS);
const COLLECTION_HELP = `collections: ${TOP_LEVEL_COLLECTIONS.join(", ")}`;

const writableFor = (coll: string): readonly string[] =>
  CREATE_SPECS[coll]?.writable ?? ["name", "system"];

/**
 * §5.3: a path is writable when its **first segment** is on the list, so `system.hp.value` is a
 * write to `system` and nothing else. `_id`, `type`, `ownership` and `flags` are never writable —
 * the whole point of typed tools is that the agent cannot rewrite who owns a thing.
 */
export function writablePath(path: string, coll: string): boolean {
  const head = path.split(".")[0] ?? "";
  if (head === "" || head === "_id" || head === "type" || head === "ownership")
    return false;
  if (head === "flags") return false;
  return writableFor(coll).includes(head);
}

// ─── The shared shape of a write ───────────────────────────────────────────────────────────────

/** Every write tool starts here: no writer, no write, and the model is told why in one sentence. */
function beginWrite(
  ctx: ToolContext,
): { writer: AgentWriter } | { refused: ToolOutcome } {
  if (!ctx.writer) return { refused: refusal(NO_WRITER) };
  return { writer: ctx.writer };
}

const describeOp = (op: Op): string => {
  switch (op.kind) {
    case "create":
      return `create ${op.coll}${op.parent ? ` in ${op.parent.coll}/${op.parent.id}` : ""}`;
    case "update": {
      const paths = Object.keys(op.diff).join(", ");
      return `update ${op.ref.coll}/${op.ref.id} (${paths || "no changes"})`;
    }
    case "delete":
      return `delete ${op.ref.coll}/${op.ref.id}`;
  }
};

const dryRunAnswer = (ops: Op[], what: string): ToolOutcome =>
  text(
    [
      `dry run — ${what} would apply ${ops.length} op(s) in one envelope, and nothing was changed:`,
      ...ops.map((op) => `  ${describeOp(op)}`),
      `Call again without dryRun (and with confirm: true where a delete is involved) to do it.`,
    ].join("\n"),
    { dryRun: true, ops } as unknown as Json,
  );

/** The host said no: pass its reason through, in its words, not a summary of them. */
const hostRefused = (reason: string, error: string): ToolOutcome =>
  refusal(`the host refused this change (${reason}): ${error}`);

async function submit(
  ops: Op[],
  writer: AgentWriter,
): Promise<
  { ok: true; seq: number; txId: string } | { ok: false; answered: ToolOutcome }
> {
  if (ops.length === 0) {
    return {
      ok: false,
      answered: refusal(
        "nothing to do — every value named is already what it is",
      ),
    };
  }
  if (ops.length > MAX_OPS_PER_CALL) {
    return {
      ok: false,
      answered: refusal(
        `that would be ${ops.length} ops in one call, and one call is capped at ${MAX_OPS_PER_CALL} — narrow it, or the GM's undo stops being one click`,
      ),
    };
  }
  const answered = await writer.submit(ops);
  if (!answered.ok) {
    return {
      ok: false,
      answered: hostRefused(answered.reason, answered.error),
    };
  }
  return { ok: true, seq: answered.seq, txId: answered.txId };
}

const newId = (): string => globalThis.crypto.randomUUID();

const baseDoc = (type: string, name: string) => ({
  _id: newId(),
  type,
  name,
  // LIMITED, the same default the GM's own "new journal" uses: readable at the table, editable
  // only by an owner. An agent that hands the players OWNER on a whim is a privilege escalation.
  ownership: { default: OWNERSHIP_LEVELS.LIMITED },
  flags: {},
  system: {} as Record<string, Json>,
});

// ─── document.create / update / delete (§5.3) ──────────────────────────────────────────────────

const documentCreate: ToolDefinition = {
  name: "document.create",
  description:
    "Create one document (actor, item, journal, folder, message, macro, playlist, cards or roll table) with a name and optional fields. The document is created as the agent, in one envelope the GM can undo in one click. Answer: the created id and a read-back of the stored document.",
  args: {
    properties: {
      coll: {
        type: "string",
        description: `the collection to create in — ${CREATABLE.join(", ")}`,
      },
      name: { type: "string", description: "the document's name" },
      fields: {
        type: "object",
        description:
          "extra fields, under `system.*` (or `content` for a message, `command` for a macro)",
      },
      content: { type: "string", description: "for a message: the text" },
      command: { type: "string", description: "for a macro: the command" },
      targetType: {
        type: "string",
        description: "for a folder: the collection it holds",
      },
      formula: {
        type: "string",
        description: "for a roll table: the dice formula",
      },
      dryRun: {
        type: "boolean",
        description: "describe the ops without applying them",
      },
    },
    required: ["coll", "name"],
  },
  capability: "doc.create",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;

    const coll = str(args["coll"]);
    const name = str(args["name"]) ?? "";
    if (!coll) return invalid("document.create needs a collection");
    if (name.trim() === "")
      return invalid('document.create needs a non-empty "name"');
    const denied = CREATE_REFUSALS[coll];
    if (denied)
      return refusal(`document.create will not create in "${coll}": ${denied}`);
    const shape = CREATE_SPECS[coll];
    if (!shape) {
      return refusal(
        `no create for collection "${coll}" — ${CREATABLE.join(", ")}. (${COLLECTION_HELP} is the full list, including ones only the host may write.)`,
      );
    }
    for (const [arg, why] of Object.entries(shape.requires ?? {})) {
      if (str(args[arg]) === undefined) {
        return invalid(`creating a ${coll} needs "${arg}" — ${why}`);
      }
    }

    const extra = obj(args["fields"]) ?? {};
    const data = {
      ...baseDoc(shape.type, name),
      ...shape.fill(args),
      // Only `system.*` from `fields`: the typed fields above are the collection's own, and
      // letting `fields` overwrite `_id` or `ownership` would be the hole this whitelist exists
      // to close.
      ...Object.fromEntries(
        Object.entries(extra).filter(([key]) => key.startsWith("system.")),
      ),
    };

    const op: Op = {
      kind: "create",
      coll: coll as CollectionName,
      data: data as unknown as Op extends { data: infer D } ? D : never,
    };
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer([op], `creating ${coll} "${name}"`);

    const done = await submit([op], begun.writer);
    if (!done.ok) return done.answered;
    const id = data._id as string;
    return readBack(ctx.view, coll, id, `created ${coll} "${name}" [${id}]`, {
      seq: done.seq,
    });
  },
};

const documentUpdate: ToolDefinition = {
  name: "document.update",
  description:
    'Patch one document with a flat diff (`{"system.hp": 5}`), on a whitelist of writable paths — `name` and `system.*`, never `_id`, `ownership` or `flags`. One call, one envelope. Answer: the paths that changed and a read-back.',
  args: {
    properties: {
      coll: {
        type: "string",
        description: "the collection the document lives in",
      },
      id: {
        type: "string",
        description: "the document id (from document.list or scene.read)",
      },
      diff: {
        type: "object",
        description:
          'the flat diff: `{"system.attributes.hp": 12, "name": "Vex"}`',
      },
      dryRun: {
        type: "boolean",
        description: "describe the ops without applying them",
      },
    },
    required: ["coll", "id", "diff"],
  },
  capability: "doc.update",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;

    const coll = str(args["coll"]);
    const id = str(args["id"]);
    const diff = obj(args["diff"]);
    if (!coll || !id)
      return invalid("document.update needs a collection and an id");
    if (!diff)
      return invalid("document.update needs a diff object of path → value");

    const refusedPaths = Object.keys(diff).filter(
      (path) => !writablePath(path, coll),
    );
    if (refusedPaths.length > 0) {
      return refusal(
        `document.update may not write ${refusedPaths.map((p) => `"${p}"`).join(", ")} on a ${coll} — writable paths are ${writableFor(
          coll,
        )
          .map((p) => `${p}.*`)
          .join(", ")}`,
      );
    }
    if (Object.keys(diff).length === 0)
      return invalid("the diff is empty — name at least one path");

    const op: Op = {
      kind: "update",
      ref: { coll: coll as CollectionName, id },
      diff: diff as Record<string, Json | null>,
    };
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer([op], `updating ${coll}/${id}`);

    const done = await submit([op], begun.writer);
    if (!done.ok) return done.answered;
    return readBack(
      ctx.view,
      coll,
      id,
      `updated ${coll}/${id} — ${Object.keys(diff).join(", ")} (seq ${done.seq})`,
      { seq: done.seq },
    );
  },
};

const documentDelete: ToolDefinition = {
  name: "document.delete",
  description:
    "Delete one document. Destructive: `dryRun: true` describes what it would remove (including the children a scene takes with it), and the real thing needs `confirm: true`. The GM can still undo it — that is what the OpLog is for — but an agent does not get to delete by accident.",
  args: {
    properties: {
      coll: {
        type: "string",
        description: "the collection the document lives in",
      },
      id: { type: "string", description: "the document id" },
      dryRun: {
        type: "boolean",
        description: "describe what would be removed, change nothing",
      },
      confirm: {
        type: "boolean",
        description: "required: this really is the document to delete",
      },
    },
    required: ["coll", "id"],
  },
  capability: "doc.delete",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;

    const coll = str(args["coll"]);
    const id = str(args["id"]);
    if (!coll || !id)
      return invalid("document.delete needs a collection and an id");
    const before = ctx.view.document(coll, id);
    if (!before) {
      return refusal(
        `no ${coll} "${id}" in this replica — document.list names the ones you may see`,
      );
    }

    const op: Op = {
      kind: "delete",
      ref: { coll: coll as CollectionName, id },
    };
    const what = `would delete ${coll} "${before.name}" [${id}] — and everything embedded in it`;
    if (bool(args["dryRun"]) === true) {
      if (bool(args["confirm"]) === true) {
        return invalid(
          "pass dryRun or confirm, not both — a dry run is the one that changes nothing",
        );
      }
      return text(
        [
          `dry run — ${what}. Nothing was changed.`,
          "",
          "Call again with confirm: true to do it.",
        ].join("\n"),
        {
          dryRun: true,
          ops: [op],
        } as unknown as Json,
      );
    }
    if (bool(args["confirm"]) !== true) {
      return refusal(
        `deleting ${coll} "${before.name}" [${id}] needs confirm: true — pass dryRun: true first if you want to see what it would take with it`,
      );
    }

    const done = await submit([op], begun.writer);
    if (!done.ok) return done.answered;
    // The post-state: gone. Saying so is the read-back, and it is the sentence the model needs.
    return text(`deleted ${coll} "${before.name}" [${id}] (seq ${done.seq}).`, {
      seq: done.seq,
      deleted: id,
    } as unknown as Json);
  },
};

/** §6.3 — the answer to a write is the world as it now is, not the request as it was made. */
function readBack(
  view: AgentWorldView,
  coll: string,
  id: string,
  what: string,
  extra: Record<string, Json>,
): ToolOutcome {
  const now = view.document(coll, id);
  if (!now) {
    // Committed, but not visible to this agent — which is a fact worth stating rather than
    // a success worth claiming: the write landed and the reader is not allowed to see it.
    return text(
      `${what} — but this agent's projection does not include it, so it cannot be read back here.`,
      { ...extra, readBack: null } as unknown as Json,
    );
  }
  const fields = Object.keys(now.fields ?? {});
  const shown = fields
    .slice(0, 12)
    .map((f) => `  ${f}: ${JSON.stringify(now.fields[f])}`);
  return text(
    [
      `${what}.`,
      `Read back: ${now.type} "${now.name}" [${now.id}]${fields.length > 12 ? ` (${fields.length} fields, first 12)` : ""}`,
      ...shown,
    ].join("\n"),
    { ...extra, readBack: now as unknown as Json } as unknown as Json,
  );
}

// ─── tokens (§5.3) ────────────────────────────────────────────────────────────────────────────

/**
 * The token a tool means, and the scene it lives in (the active scene when none is named). The
 * answer is a **row** — what `token.list` showed the model — so the refusal can name the tokens
 * the agent may actually see rather than the ones the document happens to hold.
 */
function tokenTarget(
  ctx: ToolContext,
  args: Record<string, Json>,
):
  | { row: AgentTokenRow; sceneId: string; sceneName: string }
  | { error: string } {
  const sceneId = str(args["sceneId"]);
  const detail = ctx.view.scene(sceneId ?? null);
  if (!detail) {
    return {
      error: sceneId
        ? `no scene "${sceneId}" — scene.list names the ones you may see`
        : "there is no active scene to move a token on",
    };
  }
  const id = str(args["tokenId"]);
  if (!id) return { error: "a token id is needed — token.list gives them" };
  // The redaction gate on the way *in* as well as the way out: an agent that cannot read a hidden
  // token must not be able to move it. `token.list` withholds it, so an id that reaches this tool
  // can only have come from somewhere else — which is exactly the case a write has to refuse.
  const rows = canReadGmOnly(ctx.grant)
    ? detail.tokenRows
    : detail.tokenRows.filter((t) => !t.hidden);
  const row = rows.find((t) => t.id === id);
  if (!row) {
    return {
      error: `no token "${id}" on ${detail.name} — token.list names the ones you may see`,
    };
  }
  // And the ownership gate (Phase 3): a grant that is not the GM's moves its own tokens, not the
  // table's. Seeing a token is not permission to move it — the party's rogue is not the agent's to
  // place, and "I could see it" is the answer a player's client has always refused.
  if (!canReadGmOnly(ctx.grant) && !row.owned) {
    return {
      error: `token "${id}" is not yours to move — token.list marks the tokens you own`,
    };
  }
  return { row, sceneId: detail.id, sceneName: detail.name };
}

const TOKEN_WRITABLE = [
  "name",
  "x",
  "y",
  "hidden",
  "disposition",
  "img",
  "elevation",
  "rotation",
];

const tokenMove: ToolDefinition = {
  name: "token.move",
  description:
    "Move one token to a cell (`col`/`row`) or a point (`x`/`y` in pixels), snapped to the scene's grid. One call, one envelope. Answer: where the token stands now, in both cells and pixels.",
  args: {
    properties: {
      tokenId: {
        type: "string",
        description: "the token id (from token.list)",
      },
      sceneId: {
        type: "string",
        description: "the scene; the active one when omitted",
      },
      col: { type: "integer", description: "the target column" },
      row: { type: "integer", description: "the target row" },
      x: {
        type: "number",
        description: "the target x in pixels (ignored when col/row are given)",
      },
      y: {
        type: "number",
        description: "the target y in pixels (ignored when col/row are given)",
      },
      dryRun: {
        type: "boolean",
        description: "describe the op without applying it",
      },
    },
    required: ["tokenId"],
  },
  capability: "token.move",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;

    const target = tokenTarget(ctx, args);
    if ("error" in target) return refusal(target.error);
    const { sceneId } = target;

    const col = numIn(args["col"], -1_000_000, 1_000_000);
    const row = numIn(args["row"], -1_000_000, 1_000_000);
    const x = num(args["x"]);
    const y = num(args["y"]);
    if (
      col === undefined &&
      row === undefined &&
      (x === undefined || y === undefined)
    ) {
      return invalid("token.move needs col and row, or x and y");
    }
    if ((col === undefined) !== (row === undefined)) {
      return invalid("token.move needs both col and row — a cell is a pair");
    }

    const detail = ctx.view.scene(sceneId);
    const grid = detail?.grid;
    const diff: Record<string, Json | null> = {};
    if (col !== undefined && row !== undefined) {
      // The grid is the scene's, and the cell is the thing a model can reason about: convert here
      // so the agent never has to multiply by a size it read out of another tool.
      const size = grid?.size ?? 100;
      diff["x"] = col * size + size / 2;
      diff["y"] = row * size + size / 2;
    } else {
      diff["x"] = x as number;
      diff["y"] = y as number;
    }

    const op: Op = {
      kind: "update",
      ref: {
        coll: "tokens",
        id: str(args["tokenId"]) as string,
        parent: { coll: "scenes", id: sceneId },
      },
      diff,
    };
    if (bool(args["dryRun"]) === true) {
      return dryRunAnswer([op], `moving token ${str(args["tokenId"])}`);
    }
    const done = await submit([op], begun.writer);
    if (!done.ok) return done.answered;

    const after = ctx.view.scene(sceneId);
    const moved = after?.tokenRows.find((t) => t.id === str(args["tokenId"]));
    if (!moved)
      return text(
        `moved (seq ${done.seq}), but this agent cannot read that token back.`,
        { seq: done.seq } as unknown as Json,
      );
    return text(
      `${moved.name} [${moved.id}] now stands at cell ${moved.col},${moved.row} (${Math.round(moved.x)},${Math.round(moved.y)} px) on ${after?.name ?? sceneId} (seq ${done.seq}).`,
      { seq: done.seq, token: moved as unknown as Json } as unknown as Json,
    );
  },
};

const tokenProperties: ToolDefinition = {
  name: "token.properties",
  description:
    "Change a token's properties — name, disposition (friendly/hostile/neutral), hidden, image, elevation, rotation. One call, one envelope. Answer: the token as it now stands.",
  args: {
    properties: {
      tokenId: {
        type: "string",
        description: "the token id (from token.list)",
      },
      sceneId: {
        type: "string",
        description: "the scene; the active one when omitted",
      },
      name: { type: "string", description: "the token's label" },
      disposition: {
        type: "string",
        description: "friendly, hostile or neutral",
      },
      hidden: { type: "boolean", description: "whether players can see it" },
      img: {
        type: "string",
        description: "asset hash or URL for the token art",
      },
      elevation: { type: "number", description: "elevation in feet" },
      rotation: { type: "number", description: "rotation in degrees" },
      dryRun: {
        type: "boolean",
        description: "describe the op without applying it",
      },
    },
    required: ["tokenId"],
  },
  capability: "token.properties",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const target = tokenTarget(ctx, args);
    if ("error" in target) return refusal(target.error);
    const id = target.row.id;

    const diff: Record<string, Json | null> = {};
    const name = str(args["name"]);
    if (name !== undefined) diff["name"] = name;
    const disposition = str(args["disposition"]);
    if (disposition !== undefined) {
      if (!["friendly", "hostile", "neutral"].includes(disposition)) {
        return invalid(
          'disposition must be "friendly", "hostile" or "neutral"',
        );
      }
      diff["disposition"] = disposition;
    }
    const hidden = bool(args["hidden"]);
    if (hidden !== undefined) diff["hidden"] = hidden;
    const img = str(args["img"]);
    if (img !== undefined) diff["img"] = img;
    const elevation = num(args["elevation"]);
    if (elevation !== undefined) diff["elevation"] = elevation;
    const rotation = num(args["rotation"]);
    if (rotation !== undefined) diff["rotation"] = rotation;
    if (Object.keys(diff).length === 0) {
      return invalid(
        `token.properties needs at least one of ${TOKEN_WRITABLE.filter((p) => p !== "x" && p !== "y").join(", ")}`,
      );
    }

    const op: Op = {
      kind: "update",
      ref: {
        coll: "tokens",
        id,
        parent: { coll: "scenes", id: target.sceneId },
      },
      diff,
    };
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer([op], `changing token ${id}`);
    const done = await submit([op], begun.writer);
    if (!done.ok) return done.answered;

    const after = ctx.view.scene(target.sceneId);
    const row = after?.tokenRows.find((t) => t.id === id);
    return text(
      row
        ? `${row.name} [${row.id}] — ${row.disposition}${row.hidden ? ", hidden" : ""} · cell ${row.col},${row.row} (seq ${done.seq}).`
        : `changed (seq ${done.seq}), but this agent cannot read that token back.`,
      {
        seq: done.seq,
        token: (row ?? null) as unknown as Json,
      } as unknown as Json,
    );
  },
};

// ─── actors from the library and from text (§5.4) ─────────────────────────────────────────────

/**
 * The companion token an import may place. Both importers place the same way, and an error here is
 * about the *cell*, not the creature — the entry was fine, the map did not have that square.
 *
 * Nothing is placed unless `col`/`row` are named: an import is not a placement by default, because
 * an agent that is stocking the bestiary for later does not want a token on the table.
 */
function placeTokenOp(
  ctx: ToolContext,
  args: Record<string, Json>,
  what: string,
  actorId: string,
): { op: Op | null } | { error: string } | { invalid: string } {
  const col = numIn(args["col"], -1_000_000, 1_000_000);
  const row = numIn(args["row"], -1_000_000, 1_000_000);
  if (col === undefined && row === undefined) return { op: null };
  if (col === undefined || row === undefined) {
    // A malformed call, not a refusal (D-279): half a cell is the model's mistake to fix.
    return {
      invalid: `placing ${what} needs both col and row — a cell is a pair`,
    };
  }
  const build = ctx.view.tokenCreate;
  if (!build) {
    return {
      error: `this replica cannot place a token — the app's token shape is wired up by the Agents window`,
    };
  }
  const sceneId = str(args["sceneId"]) ?? ctx.view.scene(null)?.id;
  if (!sceneId) {
    return {
      error: "there is no scene to place a token on — scene.create makes one",
    };
  }
  const made = build({ sceneId, name: what, actorId, col, row });
  return "error" in made ? { error: made.error } : { op: made };
}

/** The sentence a placed token adds to an import's answer, read back rather than echoed. */
function placedLine(
  view: AgentWorldView,
  sceneId: string | undefined,
  actorId: string,
): string | null {
  const detail = view.scene(sceneId ?? null);
  const row = detail?.tokenRows.find((token) => token.actorId === actorId);
  return row
    ? `Token ${row.name} [${row.id}] stands at cell ${row.col},${row.row} on ${detail?.name ?? "the scene"}.`
    : null;
}

/**
 * §5.4 — the compendium's own import, not the character importer's. A pack entry is *already* this
 * app's document shape (`systems/pf1e-core/packs/bestiary.json` authors `system.pf1e` directly), so
 * handing it to `importCharacter` would read none of its fields and author an actor that opens as a
 * blank sheet — the one failure the importer's own header calls worse than a refusal. What the
 * Compendia panel's Import button submits is what an agent gets.
 */
const actorFromCompendium: ToolDefinition = {
  name: "actor.from_compendium",
  description:
    "Import one compendium entry as an actor — the same document the Compendia panel's Import button creates — and, with col/row, put a token for it on a scene at that cell. One call, one envelope. Answer: the new actor's id, a read-back, and where the token stands. bestiary.search finds the ids.",
  args: {
    properties: {
      entryId: {
        type: "string",
        description: "the compendium entry id (from bestiary.search)",
      },
      name: {
        type: "string",
        description: "a name for the actor; the entry's own name when omitted",
      },
      sceneId: {
        type: "string",
        description: "the scene to place a token on; the active one when omitted",
      },
      col: { type: "integer", description: "place a token at this column" },
      row: { type: "integer", description: "place a token at this row" },
      dryRun: {
        type: "boolean",
        description: "describe the ops without applying them",
      },
    },
    required: ["entryId"],
  },
  capability: "doc.create",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;

    const entryId = str(args["entryId"]);
    if (!entryId)
      return invalid(
        "actor.from_compendium needs an entryId — bestiary.search gives them",
      );
    if (!ctx.view.compendiumEntry) {
      return refusal(
        "this replica holds no compendium packs — bestiary.search and actor.from_compendium need the packages runtime, which the Agents window wires up",
      );
    }
    const entry = await ctx.view.compendiumEntry(entryId);
    if (!entry) {
      return refusal(
        `no compendium entry "${entryId}" — bestiary.search names the ones installed`,
      );
    }
    if (entry.coll !== "actors") {
      return refusal(
        `"${entry.name}" lives in a ${entry.coll} pack, so it is not an actor — document.create makes anything else, and actor.from_statblock makes an actor out of text`,
      );
    }
    // Placing a token is a second capability (§5.4): an agent allowed to stock the bestiary is not
    // automatically allowed to put things on the table.
    const placing = numIn(args["col"], -1_000_000, 1_000_000) !== undefined;
    if (placing && !ctx.grant.capabilities.includes("token.move")) {
      return refusal(
        "this agent may import actors but not place tokens — ask the GM to change its grant",
      );
    }

    const actorId = newId();
    const data: Record<string, Json> = {
      ...(entry.data as Record<string, Json>),
      _id: actorId,
    };
    if (typeof data["name"] !== "string")
      data["name"] = str(args["name"]) ?? entry.name;
    const name = String(data["name"]);
    const ops: Op[] = [
      {
        kind: "create",
        coll: entry.coll as CollectionName,
        // The entry's own payload with a fresh id — exactly what `importEntryOp` builds for the
        // panel's Import button. The cast is the importer's own, and the whitelist this file
        // applies to `document.create` does not apply here on purpose: a pack entry *is* the
        // document, and editing it on the way in would be the drift this tool exists to avoid.
        data: data as unknown as BaseDocument,
      },
    ];
    const placed = await placeTokenOp(ctx, args, name, actorId);
    if ("invalid" in placed) return invalid(placed.invalid);
    if ("error" in placed) return refusal(placed.error);
    if (placed.op) ops.push(placed.op);

    const what = `importing ${entry.name} from ${entry.pack}${placed.op ? ` and placing a token` : ""}`;
    if (bool(args["dryRun"]) === true) return dryRunAnswer(ops, what);

    const done = await submit(ops, begun.writer);
    if (!done.ok) return done.answered;

    const answered = readBack(
      ctx.view,
      "actors",
      actorId,
      `imported ${entry.name} from ${entry.pack} as actor "${name}" [${actorId}]${placed.op ? " and placed its token" : ""} (seq ${done.seq})`,
      { seq: done.seq, entryId: entry.id, pack: entry.pack },
    );
    const line = placed.op ? placedLine(ctx.view, str(args["sceneId"]), actorId) : null;
    if (line === null || "invalid" in answered) return answered;
    return text(
      `${answered.content[0]?.text ?? ""}
${line}`,
      answered.structuredContent,
    );
  },
};

/**
 * §5.4 — the D-264/D-267 front door for *text*: a Pathfinder stat block pasted off a wiki, or a
 * Foundry/Roll20/Hero Lab export. The importer validates what it read before anything is created
 * (`characterImportCheck`), so a sheet that would open blank is refused instead — and the report's
 * own `read`/`warnings` lines come back, because "the export states no hit-point maximum" is
 * exactly the sort of thing an agent should tell the table rather than discover later.
 */
const actorFromStatblock: ToolDefinition = {
  name: "actor.from_statblock",
  description:
    "Turn pasted text into an actor: a Pathfinder 1e monster stat block, or a Foundry/Roll20/Hero Lab character export. The importer reads it and validates what it read before creating anything, so a sheet that would open blank is refused instead. With col/row it also puts a token on a scene. One call, one envelope.",
  args: {
    properties: {
      text: {
        type: "string",
        description:
          "the stat block or export, pasted whole — start at the creature's name",
      },
      name: {
        type: "string",
        description: "a name for the actor; the importer's when omitted",
      },
      sceneId: {
        type: "string",
        description: "the scene to place a token on; the active one when omitted",
      },
      col: { type: "integer", description: "place a token at this column" },
      row: { type: "integer", description: "place a token at this row" },
      dryRun: {
        type: "boolean",
        description: "describe the ops without applying them",
      },
    },
    required: ["text"],
  },
  capability: "doc.create",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;

    const body = str(args["text"]);
    if (!body || body.trim() === "") {
      return invalid(
        "actor.from_statblock needs the text — paste the stat block from its first line (the creature's name and its CR)",
      );
    }
    const importer = ctx.view.importCharacter;
    if (!importer) {
      return refusal(
        "this replica has no character importer — actor.from_statblock needs the packages runtime, which the Agents window wires up",
      );
    }
    // The id is this call's, not the importer's to invent: it is what the token links to, and it is
    // what the answer names.
    const actorId = newId();
    const plan = importer(body, { id: actorId });
    if ("error" in plan) {
      return refusal(`that text did not read as a character: ${plan.error}`);
    }
    const placing = numIn(args["col"], -1_000_000, 1_000_000) !== undefined;
    if (placing && !ctx.grant.capabilities.includes("token.move")) {
      return refusal(
        "this agent may import actors but not place tokens — ask the GM to change its grant",
      );
    }

    const name = str(args["name"]) ?? plan.name;
    const ops: Op[] = [...plan.ops];
    const placed = await placeTokenOp(ctx, args, name, actorId);
    if ("invalid" in placed) return invalid(placed.invalid);
    if ("error" in placed) return refusal(placed.error);
    if (placed.op) ops.push(placed.op);

    const what = `importing ${plan.name} (${plan.format})${placed.op ? " and placing a token" : ""}`;
    if (bool(args["dryRun"]) === true) return dryRunAnswer(ops, what);

    const done = await submit(ops, begun.writer);
    if (!done.ok) return done.answered;

    const lines = [
      `imported ${plan.name} from a ${plan.format} as actor [${actorId}]${placed.op ? " and placed its token" : ""} (seq ${done.seq}).`,
      ...(plan.read.length > 0
        ? ["Read:", ...plan.read.map((line) => `  ${line}`)]
        : []),
      ...(plan.warnings.length > 0
        ? ["The importer could not place:", ...plan.warnings.map((line) => `  ${line}`)]
        : []),
    ];
    const placed_ = placed.op ? placedLine(ctx.view, str(args["sceneId"]), actorId) : null;
    if (placed_) lines.push(placed_);
    return text(lines.join("\n"), {
      seq: done.seq,
      format: plan.format,
      actorId,
      read: plan.read,
      warnings: plan.warnings,
    } as unknown as Json);
  },
};

// ─── the march and the encounter (§5.6, F1) ────────────────────────────────────────────────────

/**
 * §5.6 — the route. A march is not a token drag: the party walks a *path*, the terrain prices it,
 * and the clock moves by the price. Committed as one envelope, because a route that is half written
 * is a march nobody can describe.
 */
const travelPlan: ToolDefinition = {
  name: "travel.plan",
  description:
    'Commit a route for the party: an ordered list of cell keys ("col,row"), with an optional pace and speed. An empty path calls the march off. One call, one envelope. Answer: the route as it now stands, and the seconds walking the rest of it costs.',
  args: {
    properties: {
      path: {
        type: "array",
        description: 'the cell keys, in order — ["0,0", "1,0", "1,1"]',
        items: { type: "string" },
      },
      sceneId: {
        type: "string",
        description: "the hexcrawl scene; the active one when omitted",
      },
      speedPerDay: {
        type: "integer",
        description: "cells a day at open-ground cost (the scene's own when omitted)",
      },
      pace: {
        type: "string",
        description: '"normal" or "forced"',
      },
      dryRun: {
        type: "boolean",
        description: "describe the ops without applying them",
      },
    },
  },
  capability: "hexcrawl.travel",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const sceneId = str(args["sceneId"]) ?? null;
    const raw = args["path"];
    const path = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : [];
    if (raw !== undefined && !Array.isArray(raw))
      return invalid("travel.plan needs `path` as a list of cell keys");
    const made = ctx.view.travelPlanOps(sceneId, {
      path,
      ...(num(args["speedPerDay"]) === undefined
        ? {}
        : { speedPerDay: Math.trunc(num(args["speedPerDay"]) as number) }),
      ...(str(args["pace"]) === undefined ? {} : { pace: str(args["pace"]) as string }),
    });
    if ("error" in made) return refusal(made.error);
    if (made.length === 0) {
      return text(
        "the march is called off — there is no route on this scene now.",
        { route: null } as unknown as Json,
      );
    }
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer(made, `committing a route of ${path.length} cells`);
    const done = await submit(made, begun.writer);
    if (!done.ok) return done.answered;
    const plan = ctx.view.hexTravel(sceneId);
    if (!plan) {
      return text(
        `route committed (seq ${done.seq}), but this agent cannot read it back.`,
        { seq: done.seq } as unknown as Json,
      );
    }
    return text(
      [
        `route committed: ${plan.path.length} cells, ${plan.pace} pace at ${plan.speedPerDay} cells/day (seq ${done.seq}).`,
        `  path: ${plan.path.join(" → ")}`,
        `  party at ${plan.party?.key ?? "—"} · ${plan.remaining.length} cells ahead · ${formatHours(plan.remainingSeconds / 3600)} of marching left.`,
      ].join("\n"),
      { seq: done.seq, plan } as unknown as Json,
    );
  },
};

/**
 * §5.6 — one march. The party walks as far as the time and the terrain allow; the clock, the route's
 * progress, the party's move, the time charged to each cell and the features that time earned all
 * land in **one envelope** — the UI submits them as two because it has listeners to keep in step,
 * and an agent has none.
 */
const travelAdvance: ToolDefinition = {
  name: "travel.advance",
  description:
    "Advance the world clock by `seconds` and walk the party along its route for exactly that long: the terrain prices each step, the party stops where the time ran out, and any feature whose time has come is revealed. One call, one envelope. Answer: where the party stands, the borders crossed, and what was found.",
  args: {
    properties: {
      seconds: {
        type: "integer",
        description: "how long to march (seconds; an hour is 3600, a day 86400)",
      },
      sceneId: {
        type: "string",
        description: "the hexcrawl scene; the active one when omitted",
      },
      dryRun: {
        type: "boolean",
        description: "describe the ops without applying them",
      },
    },
    required: ["seconds"],
  },
  capability: "hexcrawl.travel",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const seconds = num(args["seconds"]);
    if (seconds === undefined || seconds <= 0) {
      return invalid(
        "travel.advance needs a positive number of seconds — an hour is 3600, a day 86400",
      );
    }
    const sceneId = str(args["sceneId"]) ?? null;
    const made = ctx.view.travelAdvanceOps(sceneId, Math.trunc(seconds));
    if ("error" in made) return refusal(made.error);
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer(made.ops, `marching for ${formatHours(made.seconds / 3600)}`);
    const done = await submit(made.ops, begun.writer);
    if (!done.ok) return done.answered;

    const lines = [
      `the party marched ${formatHours(made.seconds / 3600)} and stands at ${made.arrival ?? "—"} (seq ${done.seq}).`,
      ...(made.arrived ? [`  the route ends here — the rest of the day was spent in ${made.arrival}.`] : []),
      ...(made.steps.length > 0
        ? [
            "  crossed:",
            ...made.steps.map(
              (step) =>
                `    ${step.cellKey} — ${formatHours(step.seconds / 3600)}${step.triggers.length > 0 ? ` · triggers ${step.triggers.join(", ")}` : ""}`,
            ),
          ]
        : []),
      ...(made.revealed.length > 0
        ? [
            "  revealed:",
            ...made.revealed.map(
              (found) => `    ${found.cellKey} — ${found.names.join(", ")}`,
            ),
          ]
        : []),
    ];
    return text(lines.join("\n"), {
      seq: done.seq,
      arrival: made.arrival,
      steps: made.steps,
      revealed: made.revealed,
    } as unknown as Json);
  },
};

/** Hours, in the shape a table says them in: "45 m", "2 h", "1 h 30 m". */
function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0 m";
  const total = Math.round(hours * 3600);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/**
 * §5.6 — the encounter engine's own check, at the clock as it reads now. A `roll` writes the
 * ledger, because a die you can roll again until it comes up goblins is not a die; the answer names
 * the die face and the table, so the GM's table and the agent's roll tell the same story.
 */
const encounterRoll: ToolDefinition = {
  name: "encounter.roll",
  description:
    "Ask the encounter engine what happens in one cell right now: the tables attached to it, the daylight band, and — when one fires — the die face, the table it came from and the entry it drew. A firing table writes its ledger entry (cooldown included) in one envelope. Nothing is put on the map: encounter.place does that.",
  args: {
    properties: {
      key: {
        type: "string",
        description:
          "the cell key, \"col,row\"; the party's own cell when omitted",
      },
      sceneId: {
        type: "string",
        description: "the hexcrawl scene; the active one when omitted",
      },
      trigger: {
        type: "string",
        description:
          'what the party did — "entering", "moving" (default), "exploring" or "fighting"',
      },
    },
  },
  capability: "hexcrawl.read",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const sceneId = str(args["sceneId"]) ?? null;
    const trigger = str(args["trigger"]) ?? "moving";
    const check = ctx.view.encounterCheckOps(sceneId, {
      ...(str(args["key"]) === null ? {} : { cellKey: str(args["key"]) ?? null }),
      trigger,
    });
    if ("error" in check) return refusal(check.error);

    const lines = [`${check.cellKey} (${check.phase}, ${trigger}):`];
    if (check.action !== "roll" || check.roll === null) {
      // Nothing happened, and the engine says why: "cooldown" and "no-tables" are answers an agent
      // routes around, where a silent empty result is one it cannot.
      lines.push(`  nothing fires — ${check.reason ?? check.action}.`);
      if (check.eligible.length > 0)
        lines.push(
          `  tables attached: ${check.eligible.map((t) => `${t.name} [${t.id}]`).join(", ")}.`,
        );
      return text(lines.join("\n"), { action: check.action } as unknown as Json);
    }
    const roll = check.roll;
    lines.push(
      `  ${roll.tableName} [${roll.tableId}] rolled ${roll.roll} on ${roll.formula} — ${roll.text} ×${roll.count}.`,
    );
    if (roll.actorIds.length > 0)
      lines.push(`  actors: ${roll.actorIds.join(", ")} — encounter.place puts them on the map.`);
    else lines.push("  nothing to place: this entry names no actors.");

    if (check.ops.length === 0)
      return text(lines.join("\n"), { roll } as unknown as Json);
    const done = await submit(check.ops, begun.writer);
    if (!done.ok) return done.answered;
    lines.push(`  ledger written (seq ${done.seq}).`);
    return text(lines.join("\n"), { seq: done.seq, roll } as unknown as Json);
  },
};

/**
 * §5.6 — put the rolled creatures on the map. The geometry is the app's own (`placeEncounterTokens`:
 * the drop point first, then a spiral that respects walls), so a warband lands the way it would if
 * the GM had dropped it there.
 */
const encounterPlace: ToolDefinition = {
  name: "encounter.place",
  description:
    "Put creatures on a hexcrawl scene: one actor id with a count (or several), placed spiralling out from a cell — the drop point first, then outwards, never inside a wall. One call, one envelope. Answer: the tokens as they now stand.",
  args: {
    properties: {
      actors: {
        type: "array",
        description: 'e.g. [{"actorId": "a-goblin", "count": 3}]',
        items: { type: "object" },
      },
      key: {
        type: "string",
        description:
          "the cell to drop them on, \"col,row\"; the party's cell when omitted",
      },
      col: { type: "integer", description: "instead of a key: the column" },
      row: { type: "integer", description: "instead of a key: the row" },
      sceneId: {
        type: "string",
        description: "the hexcrawl scene; the active one when omitted",
      },
      dryRun: {
        type: "boolean",
        description: "describe the ops without applying them",
      },
    },
    required: ["actors"],
  },
  capability: "hexcrawl.travel",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    // Placing is a second capability: an agent allowed to run the hexcrawl is not automatically
    // allowed to put tokens on the table.
    if (!ctx.grant.capabilities.includes("token.move")) {
      return refusal(
        "this agent may run the hexcrawl but not place tokens — ask the GM to change its grant",
      );
    }
    const raw = args["actors"];
    if (!Array.isArray(raw))
      return invalid('encounter.place needs `actors` — [{"actorId": "a-goblin", "count": 3}]');
    const actors: Array<{ actorId: string; count: number }> = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const row = entry as Record<string, Json>;
      const actorId = str(row["actorId"]);
      const count = num(row["count"]) ?? 1;
      if (actorId === undefined) continue;
      actors.push({ actorId, count: Math.max(1, Math.trunc(count)) });
    }
    if (actors.length === 0) {
      return invalid(
        'encounter.place needs at least one actor id — [{"actorId": "a-vex", "count": 2}]',
      );
    }
    const sceneId = str(args["sceneId"]) ?? null;
    const col = numIn(args["col"], -1_000_000, 1_000_000);
    const rowIndex = numIn(args["row"], -1_000_000, 1_000_000);
    if ((col === undefined) !== (rowIndex === undefined)) {
      return invalid("encounter.place needs both col and row — a cell is a pair");
    }
    const made = ctx.view.encounterPlaceOps(sceneId, {
      actors,
      ...(str(args["key"]) === null || str(args["key"]) === undefined
        ? {}
        : { cellKey: str(args["key"]) as string }),
      ...(col === undefined || rowIndex === undefined
        ? {}
        : { col, row: rowIndex }),
    });
    if ("error" in made) return refusal(made.error);
    const total = actors.reduce((sum, entry) => sum + entry.count, 0);
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer(made, `placing ${total} token(s)`);
    const done = await submit(made, begun.writer);
    if (!done.ok) return done.answered;

    const detail = ctx.view.scene(sceneId);
    const placed = (detail?.tokenRows ?? []).filter((token) =>
      actors.some((entry) => entry.actorId === token.actorId),
    );
    return text(
      [
        `placed ${made.length} token(s) on ${detail?.name ?? "the scene"} (seq ${done.seq}).`,
        ...placed.map(
          (token) =>
            `  ${token.name} [${token.id}] — cell ${token.col},${token.row}`,
        ),
      ].join("\n"),
      { seq: done.seq, tokens: placed } as unknown as Json,
    );
  },
};

// ─── scenes (§5.2) ────────────────────────────────────────────────────────────────────────────

const gridOf = (args: Record<string, Json>): SceneGrid => ({
  type: str(args["gridType"]) === "hex" ? "hex" : "square",
  size: numIn(args["gridSize"], 10, 1000) ?? 100,
  distance: numIn(args["gridDistance"], 1, 1000) ?? 5,
  units: str(args["gridUnits"]) ?? "ft",
  diagonals: "555",
  hexLayout: str(args["hexLayout"]) === "evenQ" ? "evenQ" : "oddQ",
});

const sceneCreate: ToolDefinition = {
  name: "scene.create",
  description:
    "Create an empty scene: name, size in pixels, grid type and cell scale. It is not activated — scene.activate does that, as its own call. Answer: the new scene's id and a read-back.",
  args: {
    properties: {
      name: { type: "string", description: "the scene's name" },
      width: { type: "integer", description: "width in pixels (10–20000)" },
      height: { type: "integer", description: "height in pixels (10–20000)" },
      gridType: { type: "string", description: '"square" or "hex"' },
      gridSize: {
        type: "integer",
        description: "pixels per cell (10–1000, default 100)",
      },
      gridDistance: {
        type: "number",
        description: "world units per cell (default 5)",
      },
      gridUnits: {
        type: "string",
        description: 'the unit name (default "ft")',
      },
      hexLayout: {
        type: "string",
        description: '"oddQ" or "evenQ", for hex grids',
      },
      darkness: { type: "number", description: "0–1" },
      dryRun: {
        type: "boolean",
        description: "describe the op without applying it",
      },
    },
    required: ["name"],
  },
  capability: "scene.manage",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const name = str(args["name"]);
    if (!name || name.trim() === "")
      return invalid('scene.create needs a non-empty "name"');
    const width = numIn(args["width"], 10, 20_000) ?? 1000;
    const height = numIn(args["height"], 10, 20_000) ?? 1000;
    const id = newId();
    const doc = {
      ...baseDoc("scene", name),
      active: false,
      img: null,
      width,
      height,
      grid: gridOf(args),
      darkness: Math.min(1, Math.max(0, num(args["darkness"]) ?? 0)),
      tokens: [],
      walls: [],
      lights: [],
      sounds: [],
      tiles: [],
      drawings: [],
      templates: [],
      notes: [],
      _id: id,
    } as unknown as SceneDocument;
    const op: Op = { kind: "create", coll: "scenes", data: doc };
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer([op], `creating scene "${name}"`);
    const done = await submit([op], begun.writer);
    if (!done.ok) return done.answered;
    return readBack(ctx.view, "scenes", id, `created scene "${name}" [${id}]`, {
      seq: done.seq,
    });
  },
};

const SCENE_WRITABLE = ["name", "darkness", "grid", "img"];

const sceneUpdate: ToolDefinition = {
  name: "scene.update",
  description:
    "Change a scene's name, darkness, image or grid (`grid.size`, `grid.distance`, `grid.type`, …). One call, one envelope; dryRun: true describes it first.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "the scene id; the active scene when omitted",
      },
      diff: {
        type: "object",
        description:
          'the flat diff, e.g. `{"name": "Goblinwood", "grid.size": 150}`',
      },
      dryRun: {
        type: "boolean",
        description: "describe the op without applying it",
      },
    },
    required: ["diff"],
  },
  capability: "scene.manage",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const sceneId = str(args["sceneId"]);
    const scene = ctx.view.scene(sceneId ?? null);
    if (!scene) {
      return refusal(
        sceneId
          ? `no scene "${sceneId}" — scene.list names them`
          : "there is no active scene",
      );
    }
    const diff = obj(args["diff"]);
    if (!diff)
      return invalid("scene.update needs a diff object of path → value");
    const refusedPaths = Object.keys(diff).filter(
      (path) => !SCENE_WRITABLE.includes(path.split(".")[0] ?? ""),
    );
    if (refusedPaths.length > 0) {
      return refusal(
        `scene.update may not write ${refusedPaths.map((p) => `"${p}"`).join(", ")} — writable: ${SCENE_WRITABLE.join(", ")}. (Tokens, walls and fog have their own tools.)`,
      );
    }
    if (Object.keys(diff).length === 0) return invalid("the diff is empty");

    const op: Op = {
      kind: "update",
      ref: { coll: "scenes", id: scene.id },
      diff: diff as Record<string, Json | null>,
    };
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer([op], `updating scene ${scene.id}`);
    const done = await submit([op], begun.writer);
    if (!done.ok) return done.answered;
    return readBack(
      ctx.view,
      "scenes",
      scene.id,
      `updated scene "${scene.name}"`,
      {
        seq: done.seq,
      },
    );
  },
};

const sceneActivate: ToolDefinition = {
  name: "scene.activate",
  description:
    "Make one scene the active scene — what the table is looking at. One envelope: the new scene is switched on and the old one off together, so the world is never briefly showing two.",
  args: {
    properties: {
      sceneId: { type: "string", description: "the scene to activate" },
      dryRun: {
        type: "boolean",
        description: "describe the ops without applying them",
      },
    },
    required: ["sceneId"],
  },
  capability: "scene.activate",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const sceneId = str(args["sceneId"]);
    if (!sceneId) return invalid("scene.activate needs a scene id");
    const scenes = ctx.view.scenes();
    if (!scenes.some((s) => s.id === sceneId)) {
      return refusal(`no scene "${sceneId}" — scene.list names them`);
    }
    const ops: Op[] = scenes
      .filter((s) => s.active !== (s.id === sceneId))
      .map((s) => ({
        kind: "update" as const,
        ref: { coll: "scenes" as const, id: s.id },
        diff: { active: s.id === sceneId },
      }));
    if (ops.length === 0) {
      return refusal(
        `${scenes.find((s) => s.id === sceneId)?.name} is already the active scene`,
      );
    }
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer(ops, `activating scene ${sceneId}`);
    const done = await submit(ops, begun.writer);
    if (!done.ok) return done.answered;
    return text(
      `${scenes.find((s) => s.id === sceneId)?.name} is now the active scene (${ops.length} op(s), seq ${done.seq}).`,
      { seq: done.seq, active: sceneId } as unknown as Json,
    );
  },
};

// ─── chat (§5.5) ──────────────────────────────────────────────────────────────────────────────

const chatPost: ToolDefinition = {
  name: "chat.post",
  description:
    "Post one chat message as the agent — public, or a whisper to named users. The card carries the agent's own name, so the table can see who is speaking. One call, one envelope.",
  args: {
    properties: {
      text: { type: "string", description: "the message" },
      to: {
        type: "array",
        description:
          "user ids to whisper to; leave it out to speak to everyone",
      },
      flavor: {
        type: "string",
        description: 'how to label it: "ooc", "emote", or empty',
      },
      dryRun: {
        type: "boolean",
        description: "describe the op without applying it",
      },
    },
    required: ["text"],
  },
  capability: "chat.speak",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const body = str(args["text"]);
    if (!body || body.trim() === "")
      return invalid("chat.post needs a message");
    const to = args["to"];
    const targets = Array.isArray(to)
      ? to.filter((v): v is string => typeof v === "string")
      : [];
    if (
      targets.length > 0 &&
      !ctx.grant.capabilities.includes("chat.whisper")
    ) {
      return refusal(
        "this agent may not whisper — ask the GM to change its grant",
      );
    }
    const id = newId();
    const data = {
      ...baseDoc("message", "message"),
      author: "",
      content: body,
      flavor: str(args["flavor"]) ?? (targets.length > 0 ? "whisper" : ""),
      whisper: targets,
      roll: null,
      _id: id,
    };
    const op: Op = { kind: "create", coll: "messages", data: data as never };
    if (bool(args["dryRun"]) === true)
      return dryRunAnswer([op], "posting to chat");
    const done = await submit([op], begun.writer);
    if (!done.ok) return done.answered;
    return text(
      targets.length > 0
        ? `whispered to ${targets.length} user(s): "${body}" (seq ${done.seq}).`
        : `said: "${body}" (seq ${done.seq}).`,
      { seq: done.seq, messageId: id } as unknown as Json,
    );
  },
};

// ─── undo (§5.1) ──────────────────────────────────────────────────────────────────────────────

const undoLast: ToolDefinition = {
  name: "undo.last",
  description:
    "Undo the last change, but only if the agent authored it — an agent must never be able to undo the GM's move or another player's. Answer: what was undone, or why there is nothing of yours to undo.",
  args: {
    properties: {
      dryRun: {
        type: "boolean",
        description: "describe whether there is anything to undo",
      },
    },
  },
  capability: "undo",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const undo = begun.writer.undoOwn;
    if (!undo) return refusal("this connection cannot undo");
    if (bool(args["dryRun"]) === true) {
      return text(
        "dry run — undo.last would undo your last undoable change, if it is still the last one.",
      );
    }
    const done = await undo();
    if (!done.ok) return refusal(done.error ?? "nothing to undo");
    return text(`undone: ${done.what ?? "your last change"}.`);
  },
};

// ── the clock and the tracker (§5.5) ─────────────────────────────────────────────────────────
//
// Time is one clock and the tracker is one state machine, so both of these families are thin: the
// tools name what the table said ("three days pass", "next turn") and the world's own builders do
// the rest. The one thing they add is the sweep — advancing the clock ends the clock-counted
// effects exactly as the Settings window's buttons do, in the *same envelope*, because "a night
// passes and your shield has expired" is one event to a reader and two ops to a store.

/** The ladder a table counts time in, read off the world's own clock. */
const TIME_UNITS = ["rounds", "minutes", "hours", "days"] as const;

const timeAdvance: ToolDefinition = {
  name: "time.advance",
  description:
    'Pass time: seconds, or `rounds`/`minutes`/`hours`/`days` on the world\'s own ladder (a round is secondsPerRound, an hour 600 rounds, a day 14 400). The clock and the effect sweep it triggers are one envelope, so "a night passes" ends what a night ends. A negative amount is a GM correction and expires nothing. Answer: the clock afterwards, and anything the new time ended.',
  args: {
    properties: {
      seconds: {
        type: "number",
        description: "seconds to add (negative rewinds the clock and expires nothing)",
      },
      rounds: { type: "integer", description: "combat rounds to pass (6 s each by default)" },
      minutes: { type: "integer", description: "minutes to pass" },
      hours: { type: "integer", description: "hours to pass" },
      days: { type: "integer", description: "days to pass" },
      dryRun: { type: "boolean", description: "describe the ops without applying them" },
    },
  },
  capability: "time.control",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const given = TIME_UNITS.filter((unit) => args[unit] !== undefined);
    const seconds = num(args["seconds"]);
    if (given.length > 1)
      return invalid("time.advance takes one unit — seconds, rounds, minutes, hours or days");
    if (given.length === 1 && seconds !== undefined)
      return invalid("time.advance takes either `seconds` or one unit, not both");
    if (given.length === 0 && seconds === undefined)
      return invalid("time.advance needs `seconds`, or one of rounds/minutes/hours/days");
    // D-268's ladder, not a wall-clock conversion: the Settings window's *minute* button advances
    // what a "1 minute" duration means **in this world** (600 rounds at 6 s a round), so a buff
    // with that duration ends when the button says it should — an hour button that advanced 100
    // rounds would end a one-hour spell after ten minutes of game time.
    const spr = ctx.view.clock().secondsPerRound;
    const perUnit: Record<(typeof TIME_UNITS)[number], number> = {
      rounds: spr,
      minutes: ROUNDS_PER_MINUTE * spr,
      hours: ROUNDS_PER_HOUR * spr,
      days: ROUNDS_PER_DAY * spr,
    };
    let delta = seconds ?? 0;
    if (given.length === 1) {
      const unit = given[0] as (typeof TIME_UNITS)[number];
      const count = num(args[unit]);
      if (count === undefined) return invalid(`time.advance needs \`${unit}\` as a number`);
      delta = Math.trunc(count) * perUnit[unit];
    }
    const made = ctx.view.timeOps({ delta: Math.trunc(delta) });
    if ("error" in made) return refusal(made.error);
    return await answerClock(made, begun.writer, bool(args["dryRun"]) === true, ctx);
  },
};

const timeSet: ToolDefinition = {
  name: "time.set",
  description:
    "Set the world clock to an absolute number of seconds — a GM correction, or a campaign that starts at a given hour. Moving forward sweeps clock-counted effects; moving backward expires nothing, because time un-passing has not cast a spell in reverse.",
  args: {
    properties: {
      seconds: {
        type: "integer",
        description: "the clock, in seconds from the world's zero (never negative)",
      },
      dryRun: { type: "boolean", description: "describe the ops without applying them" },
    },
    required: ["seconds"],
  },
  capability: "time.control",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const seconds = num(args["seconds"]);
    if (seconds === undefined) return invalid("time.set needs `seconds` as a number");
    if (seconds < 0) return invalid("time.set needs a whole number of seconds, zero or more");
    const made = ctx.view.timeOps({ seconds: Math.trunc(seconds) });
    if ("error" in made) return refusal(made.error);
    return await answerClock(made, begun.writer, bool(args["dryRun"]) === true, ctx);
  },
};

/** One answer for both clock tools: the post-state, and what the new time ended. */
async function answerClock(
  made: AgentTimeOps,
  writer: AgentWriter,
  dry: boolean,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (made.ops.length === 0)
    return text(
      `the clock is already at ${made.seconds} s — nothing moved and nothing ended.`,
      made as unknown as Json,
    );
  if (dry) return dryRunAnswer(made.ops, `moving the clock by ${formatDelta(made.delta)}`);
  const done = await submit(made.ops, writer);
  if (!done.ok) return done.answered;
  const clock = ctx.view.clock();
  const lines = [
    `the clock moved ${formatDelta(made.delta)} — it is now ${clock.stamp} (${clock.seconds} s)${made.delta < 0 ? " — a backward jump, so nothing expired" : ""} (seq ${done.seq}).`,
  ];
  if (made.expired.length > 0)
    lines.push(
      `  ${made.expired.length} effect(s) ended: ${made.expired
        .map((row) => `${row.effectId} on ${row.home}/${row.ownerId}`)
        .join(", ")}.`,
    );
  else if (made.delta > 0) lines.push("  nothing expired.");
  return text(lines.join("\n"), { seq: done.seq, clock, expired: made.expired } as unknown as Json);
}

function formatDelta(seconds: number): number | string {
  const abs = Math.abs(seconds);
  if (abs >= 86_400) return `${Math.round((seconds / 86_400) * 100) / 100} day(s)`;
  if (abs >= 3600) return `${Math.round((seconds / 3600) * 100) / 100} hour(s)`;
  if (abs >= 60) return `${Math.round((seconds / 60) * 100) / 100} minute(s)`;
  return `${seconds} s`;
}

/** The tracker's answer: the order after the transition, and the two things it may owe the table. */
async function answerCombat(
  made: AgentCombatTurn,
  sceneId: string | null,
  writer: AgentWriter,
  dry: boolean,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (made.ops.length === 0)
    return text(`${made.name}: ${made.note ?? "nothing to do"} (no ops).`, made as unknown as Json);
  if (dry) return dryRunAnswer(made.ops, `${made.note ?? "moving the tracker"} on ${made.name}`);
  const done = await submit(made.ops, writer);
  if (!done.ok) return done.answered;
  const after = ctx.view.combatState(sceneId);
  const lines = [
    `${made.name}: ${made.note ?? "the tracker moved"} (seq ${done.seq}).`,
    after === null
      ? `  round ${made.round} — ${made.current?.name ?? "nobody"}'s turn.`
      : `  round ${after.round}${after.phase === "surprise" ? " (surprise round)" : ""} — ${after.current?.name ?? "nobody"}'s turn, ${after.order.length} in the order.`,
  ];
  if (made.clockDeltaSeconds > 0)
    lines.push(`  the round wrap advanced the world clock by ${made.clockDeltaSeconds} s.`);
  for (const check of made.dyingChecks)
    lines.push(
      `  ${check.actorName} is dying at ${check.hp} hp and owes this round's stabilization check — dice.roll 1d20 (DC 10, minus the negative hp) resolves it.`,
    );
  return text(lines.join("\n"), { seq: done.seq, combat: after ?? made } as unknown as Json);
}

const combatStart: ToolDefinition = {
  name: "combat.start",
  description:
    "Begin the encounter on a scene: initiative, the surprise round (PF1e), and who is caught flat-footed, all as the tracker itself decides them. With no encounter on the scene, one is opened from its tokens. Answer: the order, whose turn it is, and — when the world advances the clock on a round wrap — the seconds that moved.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "the scene whose encounter to start; the active one when omitted",
      },
      name: {
        type: "string",
        description: "the name to give an encounter opened here (the scene's tokens are its combatants)",
      },
      initiative: {
        type: "object",
        description: "combatant id → the initiative rolled for them, for the ones not yet rolled",
      },
      unaware: {
        type: "array",
        items: { type: "string" },
        description: "combatant ids the GM declares caught unaware (PF1e surprise round)",
      },
      dryRun: { type: "boolean", description: "describe the ops without applying them" },
    },
  },
  capability: "combat.control",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const sceneId = str(args["sceneId"]) ?? null;
    const made = ctx.view.combatStartOps(sceneId, {
      ...(str(args["name"]) === undefined ? {} : { name: str(args["name"]) as string }),
      ...(obj(args["initiative"]) === undefined
        ? {}
        : { initiative: initiativeMap(obj(args["initiative"])) }),
      ...(Array.isArray(args["unaware"])
        ? { unaware: args["unaware"].filter((id): id is string => typeof id === "string") }
        : {}),
    });
    if ("error" in made) return refusal(made.error);
    return await answerCombat(made, sceneId, begun.writer, bool(args["dryRun"]) === true, ctx);
  },
};

/** `{ "c-1": 18 }` — an object arg is Json, and the tracker wants finite numbers. */
function initiativeMap(raw: Record<string, Json> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    const n = num(value);
    if (n !== undefined) out[key] = Math.trunc(n);
  }
  return out;
}

const combatAdd: ToolDefinition = {
  name: "combat.add",
  description:
    "Put combatants into the encounter — by token, by actor, or by name — with their initiative when it is already rolled. With no encounter on the scene, one is opened first. Answer: the order as it now stands.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "the scene whose encounter to add to; the active one when omitted",
      },
      name: {
        type: "string",
        description: "the name to give an encounter opened here",
      },
      combatants: {
        type: "array",
        items: { type: "object" },
        description:
          'one per combatant: { tokenId } or { actorId } or { name }, plus an optional initiative — [{ "tokenId": "t-3", "initiative": 18 }]',
      },
      dryRun: { type: "boolean", description: "describe the ops without applying them" },
    },
    required: ["combatants"],
  },
  capability: "combat.control",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const sceneId = str(args["sceneId"]) ?? null;
    const raw = args["combatants"];
    if (!Array.isArray(raw)) return invalid("combat.add needs `combatants` as a list");
    const combatants = raw.map((entry) => {
      const row = obj(entry) ?? {};
      return {
        ...(str(row["tokenId"]) === undefined ? {} : { tokenId: str(row["tokenId"]) as string }),
        ...(str(row["actorId"]) === undefined ? {} : { actorId: str(row["actorId"]) as string }),
        ...(str(row["name"]) === undefined ? {} : { name: str(row["name"]) as string }),
        ...(num(row["initiative"]) === undefined
          ? {}
          : { initiative: Math.trunc(num(row["initiative"]) as number) }),
      };
    });
    if (combatants.length === 0) return invalid("combat.add needs at least one combatant");
    const made = ctx.view.combatAddOps(sceneId, {
      ...(str(args["name"]) === undefined ? {} : { name: str(args["name"]) as string }),
      combatants,
    });
    if ("error" in made) return refusal(made.error);
    return await answerCombat(made, sceneId, begun.writer, bool(args["dryRun"]) === true, ctx);
  },
};

const combatNext: ToolDefinition = {
  name: "combat.next",
  description:
    "Advance the turn — the tracker's own transition, so effect durations tick, actions refresh, held actions come due, and a round wrap moves the world clock by the round this world says a round costs. A dying creature that owes a stabilization check is named, not rolled: this tool never rolls a die.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "the scene whose encounter to advance; the active one when omitted",
      },
      count: {
        type: "integer",
        description: "turns to advance (default 1, max 20) — a whole round is one per combatant",
      },
      dryRun: { type: "boolean", description: "describe the ops without applying them" },
    },
  },
  capability: "combat.control",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const sceneId = str(args["sceneId"]) ?? null;
    const count = Math.min(Math.max(Math.trunc(num(args["count"]) ?? 1), 1), 20);
    const made = ctx.view.combatNextOps(sceneId, count);
    if ("error" in made) return refusal(made.error);
    return await answerCombat(made, sceneId, begun.writer, bool(args["dryRun"]) === true, ctx);
  },
};

const combatEnd: ToolDefinition = {
  name: "combat.end",
  description:
    "End the encounter: the round structure is cleared and nobody's turn it is. The combatants stay on the document, so a second fight in the same room is combat.start again.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "the scene whose encounter to end; the active one when omitted",
      },
      dryRun: { type: "boolean", description: "describe the ops without applying them" },
    },
  },
  capability: "combat.control",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const sceneId = str(args["sceneId"]) ?? null;
    const made = ctx.view.combatEndOps(sceneId);
    if ("error" in made) return refusal(made.error);
    return await answerCombat(made, sceneId, begun.writer, bool(args["dryRun"]) === true, ctx);
  },
};

// ── dice (§5.5) ──────────────────────────────────────────────────────────────────────────────
//
// The two tools here are the only ones that **ask the host** instead of submitting ops, and they
// are async for exactly that reason. Dice are the table's: the host owns the RNG, the seed and the
// card, and an agent that could roll its own could quietly roll again until it liked the number.
// So `dice.roll` sends a formula and reads the host's card back, and `dice.apply` names a card and
// an actor — never an amount — and lets the host re-read its own total.

const DICE_MODES = ["roll", "gmroll", "blindroll", "selfroll"] as const;

const diceRollTool: ToolDefinition = {
  name: "dice.roll",
  description:
    'Roll dice as this agent, through the host\'s own dice (commit-reveal, so the number is the table\'s and not the agent\'s to choose): "1d20+5", "2d6+3", "4d6k3". The card lands in chat as this agent unless the mode says otherwise, and the answer is the total plus the individual dice. The one tool here that waits, because the host rolls it.',
  args: {
    properties: {
      formula: {
        type: "string",
        description: 'the dice expression — "1d20+5", "2d6", "1d8+1d4+2"',
      },
      mode: {
        type: "string",
        description:
          'who sees it: "roll" (public, default), "gmroll" (GM only), "blindroll" (GM sees, players see a hidden roll) or "selfroll" (only this agent)',
      },
      to: {
        type: "array",
        items: { type: "string" },
        description: "user ids to whisper the roll to",
      },
      flavor: {
        type: "string",
        description: 'why the roll was made — "attack: goblin 2"; it rides the card as its flavor',
      },
    },
    required: ["formula"],
  },
  capability: "dice.roll",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const formula = str(args["formula"]);
    if (!formula) return invalid('dice.roll needs a formula — "1d20+5"');
    const mode = str(args["mode"]) ?? "roll";
    if (!DICE_MODES.includes(mode as (typeof DICE_MODES)[number])) {
      return invalid(
        `dice.roll knows the modes ${DICE_MODES.map((m) => `"${m}"`).join(", ")} — not "${mode}"`,
      );
    }
    const rolled = await ctx.view.diceRoll({
      formula,
      mode,
      ...(Array.isArray(args["to"])
        ? { to: args["to"].filter((id): id is string => typeof id === "string") }
        : {}),
      ...(str(args["flavor"]) === undefined ? {} : { flavor: str(args["flavor"]) as string }),
    });
    if ("error" in rolled) return refusal(rolled.error);
    const dice = rolled.terms
      .map((term) => {
        const row = obj(term);
        if (!row) return null;
        if (typeof row["result"] === "number" && typeof row["faces"] === "number")
          return `d${row["faces"]}: ${row["result"]}`;
        if (typeof row["operator"] === "string")
          return `${row["operator"]}${String(row["value"] ?? "")}`;
        return null;
      })
      .filter((row): row is string => row !== null);
    return text(
      [
        `${rolled.formula} = ${rolled.total}${dice.length > 0 ? ` (${dice.join(", ")})` : ""} — ${rolled.mode}, rolled by the host.`,
        `  card ${rolled.messageId}${rolled.flavor ? ` — ${rolled.flavor}` : ""}${
          rolled.to.length > 0 ? ` · whispered to ${rolled.to.join(", ")}` : ""
        }`,
        `  dice.apply puts this number on an actor; nothing has been applied.`,
      ].join("\n"),
      rolled as unknown as Json,
    );
  },
};

const diceApplyTool: ToolDefinition = {
  name: "dice.apply",
  description:
    "Apply a roll card's own total to an actor as damage or healing. No amount travels: the agent names the card and the actor, and the host re-reads the card's total and does the arithmetic (temporary hit points absorb first; healing also removes nonlethal). Answer: the amount, and the hit points before and after.",
  args: {
    properties: {
      messageId: {
        type: "string",
        description: "the roll card — dice.roll and chat.read name them",
      },
      actorId: { type: "string", description: "the actor it lands on" },
      mode: {
        type: "string",
        description: '"damage" or "healing"',
      },
    },
    required: ["messageId", "actorId", "mode"],
  },
  capability: "dice.apply",
  async run(args, ctx): Promise<ToolOutcome> {
    const begun = beginWrite(ctx);
    if ("refused" in begun) return begun.refused;
    const messageId = str(args["messageId"]);
    const actorId = str(args["actorId"]);
    const mode = str(args["mode"]) ?? "";
    if (!messageId) return invalid("dice.apply needs `messageId` — the roll card");
    if (!actorId) return invalid("dice.apply needs `actorId` — who it lands on");
    if (mode !== "damage" && mode !== "healing")
      return invalid('dice.apply needs `mode` — "damage" or "healing"');
    const applied = await ctx.view.diceApply({ messageId, actorId, mode });
    if ("error" in applied) return refusal(applied.error);
    const moved = applied.hpAfter - applied.hpBefore;
    return text(
      [
        `${applied.mode === "damage" ? "Damage" : "Healing"} of ${applied.amount} from ${applied.messageId} → ${applied.actorName}.`,
        `  hit points ${applied.hpBefore} → ${applied.hpAfter} (${moved >= 0 ? `+${moved}` : moved}).`,
        applied.note === null
          ? "  the host applied the card's own total — this agent named no number."
          : `  ${applied.note}`,
      ].join("\n"),
      applied as unknown as Json,
    );
  },
};

export const WRITE_TOOLS: readonly ToolDefinition[] = [
  documentCreate,
  documentUpdate,
  documentDelete,
  actorFromCompendium,
  actorFromStatblock,
  travelPlan,
  travelAdvance,
  encounterRoll,
  encounterPlace,
  timeAdvance,
  timeSet,
  combatStart,
  combatAdd,
  combatNext,
  combatEnd,
  diceRollTool,
  diceApplyTool,
  tokenMove,
  tokenProperties,
  sceneCreate,
  sceneUpdate,
  sceneActivate,
  chatPost,
  undoLast,
];
