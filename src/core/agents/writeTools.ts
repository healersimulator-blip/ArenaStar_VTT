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
  CollectionName,
  Json,
  SceneDocument,
  SceneGrid,
} from "../documents";
import { OWNERSHIP_LEVELS, TOP_LEVEL_COLLECTIONS } from "../documents";
import type { Op } from "../ops";
import { bool, invalid, num, numIn, obj, refusal, str, text } from "./answer";
import { canReadGmOnly } from "./capabilities";
import type {
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

export const WRITE_TOOLS: readonly ToolDefinition[] = [
  documentCreate,
  documentUpdate,
  documentDelete,
  tokenMove,
  tokenProperties,
  sceneCreate,
  sceneUpdate,
  sceneActivate,
  chatPost,
  undoLast,
];
