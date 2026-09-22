/**
 * MCP connector §5.2–5.4 — the read surface.
 *
 * Three rules run through all of it:
 *
 * 1. **Every read is a projection, and the view is responsible for it.** These tools receive rows the
 *    view has already narrowed to what the *session* may see. What they add is the second gate — the
 *    **grant** — because a GM session hosting an observer-granted agent must not leak GM-only data
 *    just because the replica has it (§3.1: the host is the authority, the mask is the UX).
 * 2. **Every list is capped and cursor-paged** (§7.4). A helpful tool that returns 25,000 compendium
 *    entries is a tool that ended the session.
 * 3. **The text block is for a model, the structured body is for code.** The text says what it found
 *    in one screen; the body carries ids, so the next call can *point* at a thing instead of
 *    describing it again.
 */
import type { Json } from "../documents";
import { canReadGmOnly } from "./capabilities";
import {
  capOf,
  cursorFor,
  isCursor,
  paginate,
  pageNote,
  parseCursor,
} from "./paging";
import {
  renderMap,
  type RenderGrid,
  type RenderScene,
  type RenderToken,
  type RenderWall,
} from "./mapRender";
import { TOP_LEVEL_COLLECTIONS } from "../documents";
import { num, refusal, str, text } from "./answer";
import type {
  AgentTokenRow,
  Page,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
  ToolResult,
} from "./types";

/** Does this grant let the agent read the GM's own data (hidden tokens, secret text, blind rolls)? */
const gmOnly = (ctx: ToolContext): boolean => canReadGmOnly(ctx.grant);

/**
 * The redaction gate. A hidden token is the classic one: the replica has it, the grant may not.
 * Everything that could carry GM-only data goes through here, so the rule lives in one sentence.
 */
function visibleTokens(
  ctx: ToolContext,
  tokens: readonly AgentTokenRow[],
): AgentTokenRow[] {
  if (gmOnly(ctx)) return [...tokens];
  return tokens.filter((token) => !token.hidden);
}

/**
 * Paging with a checked cursor, over a page the **view** already cut — paging a page is how a
 * "50 of 1,200" answer becomes "all 50".
 *
 * A malformed cursor is **not** treated as "start again": an agent looping over pages with a cursor
 * it built itself would re-read page 1 forever, and the loop looks like progress in a transcript. It
 * is a client bug, so the tool answers -32602.
 *
 * The clamp is the last line of defence for §7.4's cap: the view honours it, but a view that over-ran
 * it would spend the table's context window, and that is the failure the cap exists to prevent.
 */
function pageOf<T>(
  page: Page<T>,
  args: Record<string, Json>,
): { ok: true; page: Page<T> } | { ok: false; error: string } {
  const cursor = args["cursor"];
  if (cursor !== undefined && !isCursor(cursor)) {
    return {
      ok: false,
      error:
        'cursor must look like "o:50" — copy the one a previous answer gave you, do not build one',
    };
  }
  const cap = capOf(args["limit"]);
  if (page.rows.length <= cap) return { ok: true, page };
  const rows = page.rows.slice(0, cap);
  return {
    ok: true,
    page: {
      ...page,
      rows,
      cap,
      next: cursorFor((parseCursor(cursor) ?? 0) + rows.length),
    },
  };
}

const sceneLine = (scene: {
  id: string;
  name: string;
  active: boolean;
  grid: { type: string; size: number; distance: number; units: string };
  width: number;
  height: number;
  tokens: number;
  walls: number | Array<unknown>;
}): string =>
  `${scene.active ? "*" : " "} ${scene.name} [${scene.id}] — ${scene.width}×${scene.height}px, ` +
  `${scene.grid.type} ${scene.grid.size}px (1 cell = ${scene.grid.distance} ${scene.grid.units}), ` +
  `${scene.tokens} tokens, ${Array.isArray(scene.walls) ? scene.walls.length : scene.walls} walls`;

// ── scenes ──────────────────────────────────────────────────────────────────────────────────────

const sceneList: ToolDefinition = {
  name: "scene.list",
  description:
    "Every scene this agent may see: id, name, size, grid and scale, token and wall counts. The active one is marked with *.",
  args: { properties: {} },
  capability: "world.read",
  run(_args, ctx): ToolResult {
    const scenes = ctx.view.scenes();
    if (scenes.length === 0) return text("This world has no scenes yet.");
    return text(
      `${scenes.length} scenes:\n${scenes.map((s) => "  " + sceneLine(s)).join("\n")}`,
      scenes as unknown as Json,
    );
  },
};

const sceneRead: ToolDefinition = {
  name: "scene.read",
  description:
    "One scene's metadata: size, grid and layout, scale, darkness, fog configuration and counts. Pass no id for the active scene. Use scene.describe for the contents, map.render for the picture.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "Scene id; omit for the active scene",
      },
    },
  },
  capability: "world.read",
  run(args, ctx): ToolOutcome {
    const scene = ctx.view.scene(str(args["sceneId"]) ?? null);
    if (!scene)
      return refusal(
        `no scene "${String(args["sceneId"] ?? "active")}" — scene.list names the ones you may see`,
      );
    const fog = scene.fog
      ? `fog ${scene.fog.enabled ? "on" : "off"} (${scene.fog.mode})`
      : "no fog";
    return text(
      `${sceneLine(scene)}\n  darkness ${scene.darkness}, ${fog}, grid layout ${scene.grid.hexLayout}`,
      scene as unknown as Json,
    );
  },
};

/**
 * §5.2's `scene.describe` — the *representation*: the scene as a paragraph, with the token list and
 * the text map inline. It is `map.render` plus the metadata, and it exists because "what is on the
 * table" is the single question a GM agent asks most.
 */
const sceneDescribe: ToolDefinition = {
  name: "scene.describe",
  description:
    "The scene as an agent would want it: metadata, every token with its cell and disposition, the wall count, fog, and the rendered text map inline. One call instead of four.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "Scene id; omit for the active scene",
      },
    },
  },
  capability: "world.read",
  run(args, ctx): ToolOutcome {
    const scene = ctx.view.scene(str(args["sceneId"]) ?? null);
    if (!scene)
      return refusal(
        `no scene "${String(args["sceneId"] ?? "active")}" — scene.list names the ones you may see`,
      );
    const tokens = visibleTokens(ctx, scene.tokenRows);
    const map = renderMap(toRenderScene(scene, tokens), { format: "ascii" });
    const fog = scene.fog
      ? `fog ${scene.fog.enabled ? "on" : "off"} (${scene.fog.mode})`
      : "no fog";
    const lines = [
      sceneLine(scene),
      `  darkness ${scene.darkness}, ${fog}, layout ${scene.grid.hexLayout}`,
      `${tokens.length} token(s) you may see${tokens.length < scene.tokenRows.length ? ` (${scene.tokenRows.length - tokens.length} withheld)` : ""}:`,
      ...(tokens.length > 0
        ? tokens.map(
            (t) =>
              `  ${t.name} [${t.id}] — ${t.disposition}${t.hidden ? ", hidden" : ""} · cell ${t.col},${t.row}${t.actorId ? ` · actor ${t.actorId}` : ""}`,
          )
        : ["  none"]),
      "",
      map.ascii,
    ];
    return text(lines.join("\n"), {
      scene: scene as unknown as Json,
      tokens: tokens as unknown as Json,
      map: map.json as unknown as Json,
    });
  },
};

/** The view's scene shape → the renderer's. One adaptation, so the renderer stays pure. */
function toRenderScene(
  scene: {
    width: number;
    height: number;
    grid: AgentSceneDetailLike["grid"];
    fogCells: { cols: number; rows: number; cells: Uint8Array } | null;
  },
  tokens: readonly AgentTokenRow[],
): RenderScene {
  const grid: RenderGrid = {
    type:
      scene.grid.type === "hex"
        ? "hex"
        : scene.grid.type === "gridless"
          ? "gridless"
          : "square",
    size: scene.grid.size,
    distance: scene.grid.distance,
    units: scene.grid.units,
    hexLayout: (scene.grid.hexLayout === "evenQ" ||
    scene.grid.hexLayout === "oddQ" ||
    scene.grid.hexLayout === "evenR" ||
    scene.grid.hexLayout === "oddR"
      ? scene.grid.hexLayout
      : "oddQ") as RenderGrid["hexLayout"],
  };
  const renderTokens: RenderToken[] = tokens.map((t) => ({
    id: t.id,
    name: t.name,
    x: t.x,
    y: t.y,
    disposition: t.disposition,
    hidden: t.hidden,
    actorId: t.actorId,
  }));
  return {
    width: scene.width,
    height: scene.height,
    grid,
    tokens: renderTokens,
    walls: [] as RenderWall[],
    fog: scene.fogCells,
  };
}

type AgentSceneDetailLike = {
  width: number;
  height: number;
  grid: {
    type: string;
    size: number;
    distance: number;
    units: string;
    hexLayout: string;
  };
  walls: Array<{ c: [number, number, number, number] }>;
  fogCells: { cols: number; rows: number; cells: Uint8Array } | null;
};

const mapRender: ToolDefinition = {
  name: "map.render",
  description:
    "The scene as text: one character per cell, with column and row rulers, a glyph key and a legend of token ids. format 'json' returns the same grid with ids so you can point at things; 'ascii' is the picture. Region: omit for the whole scene, or give a rect in world pixels.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "Scene id; omit for the active scene",
      },
      format: { type: "string", description: "ascii (default) or json" },
      rect: {
        type: "object",
        description:
          "World-pixel region {x, y, w, h} to render instead of the whole scene",
      },
      showWalls: { type: "boolean", description: "Draw walls (default true)" },
      showFog: { type: "boolean", description: "Draw fog (default true)" },
      showTokens: {
        type: "boolean",
        description: "Draw tokens (default true)",
      },
    },
  },
  capability: "world.read",
  run(args, ctx): ToolOutcome {
    const scene = ctx.view.scene(str(args["sceneId"]) ?? null);
    if (!scene)
      return refusal(
        `no scene "${String(args["sceneId"] ?? "active")}" — scene.list names the ones you may see`,
      );
    const tokens = visibleTokens(ctx, scene.tokenRows);
    const rectRaw = args["rect"];
    const rect =
      rectRaw !== null && typeof rectRaw === "object" && !Array.isArray(rectRaw)
        ? {
            x: num((rectRaw as Record<string, Json>)["x"]) ?? 0,
            y: num((rectRaw as Record<string, Json>)["y"]) ?? 0,
            w: num((rectRaw as Record<string, Json>)["w"]) ?? scene.width,
            h: num((rectRaw as Record<string, Json>)["h"]) ?? scene.height,
          }
        : null;
    const base = toRenderScene(scene, tokens);
    const rendered = renderMap(
      { ...base, walls: scene.walls.map((w) => ({ c: w.c })) },
      {
        rect,
        showWalls: args["showWalls"] !== false,
        showFog: args["showFog"] !== false,
        showTokens: args["showTokens"] !== false,
      },
    );
    if (args["format"] === "json") {
      return text(
        `${rendered.cols}×${rendered.rows} cells, ${tokens.length} tokens, ${rendered.json.walls} wall cells.`,
        rendered.json as unknown as Json,
      );
    }
    return text(rendered.ascii, rendered.json as unknown as Json);
  },
};

// ── documents ───────────────────────────────────────────────────────────────────────────────────

const COLLECTION_HELP = `collections: ${TOP_LEVEL_COLLECTIONS.join(", ")}`;

const documentList: ToolDefinition = {
  name: "document.list",
  description:
    "Id, name and type of the documents in one collection, capped and cursor-paged. " +
    COLLECTION_HELP,
  args: {
    properties: {
      coll: { type: "string", description: "Collection name" },
      limit: {
        type: "integer",
        description: "Rows to return (default 50, max 500)",
      },
      cursor: {
        type: "string",
        description: 'Cursor from a previous call, e.g. "o:50"',
      },
    },
    required: ["coll"],
  },
  capability: "world.read",
  run(args, ctx): ToolOutcome {
    const coll = str(args["coll"]);
    if (!coll)
      return refusal(
        "document.list needs a collection name — " + COLLECTION_HELP,
      );
    if (!(TOP_LEVEL_COLLECTIONS as readonly string[]).includes(coll)) {
      // A model guessing "spells" or "monsters" should be told the real names, not handed an empty
      // page and left to conclude the world is empty.
      return refusal(`no collection "${coll}" — ${COLLECTION_HELP}`);
    }
    const paged = pageOf(
      ctx.view.documents(coll, {
        limit: args["limit"],
        cursor: args["cursor"],
      }),
      args,
    );
    if (!paged.ok) return { invalid: paged.error };
    const page = paged.page;
    const lines = page.rows.map(
      (row) =>
        `  ${row.name} [${row.id}]${row.parent ? ` · in ${row.parent}` : ""}`,
    );
    return text(
      [
        `${coll}: ${pageNote(page, coll)}`,
        ...(lines.length > 0 ? lines : ["  none"]),
        ...(page.next
          ? [`  next: document.list with cursor "${page.next}"`]
          : []),
      ].join("\n"),
      page as unknown as Json,
    );
  },
};

const documentRead: ToolDefinition = {
  name: "document.read",
  description:
    "One document whole, as the view holds it (already redacted for this session). Prefer the typed tools when one exists — this is the escape hatch for the long tail.",
  args: {
    properties: {
      coll: { type: "string", description: "Collection name" },
      id: { type: "string", description: "Document id" },
    },
    required: ["coll", "id"],
  },
  capability: "world.read",
  run(args, ctx): ToolOutcome {
    const coll = str(args["coll"]);
    const id = str(args["id"]);
    if (!coll || !id)
      return refusal("document.read needs a collection and an id");
    const doc = ctx.view.document(coll, id);
    if (!doc)
      return refusal(
        `no ${coll} document "${id}" — document.list names the ones you may see`,
      );
    return text(
      `${coll} ${doc.name} [${doc.id}]:\n${JSON.stringify(doc.fields, null, 2)}`,
      doc as unknown as Json,
    );
  },
};

const tokenList: ToolDefinition = {
  name: "token.list",
  description:
    "The tokens on a scene with their ids, world positions, grid cells and dispositions. Hidden tokens appear only for a grant with gmOnly.read, and the ones you own are marked \"yours\" — token.move moves those, and only those, unless your grant is the GM's.",
  args: {
    properties: {
      sceneId: {
        type: "string",
        description: "Scene id; omit for the active scene",
      },
      limit: {
        type: "integer",
        description: "Rows to return (default 50, max 500)",
      },
      cursor: {
        type: "string",
        description: 'Cursor from a previous call, e.g. "o:50"',
      },
    },
  },
  capability: "world.read",
  run(args, ctx): ToolOutcome {
    const sceneId = str(args["sceneId"]) ?? null;
    const scene = ctx.view.scene(sceneId);
    if (!scene)
      return refusal(
        `no scene "${String(sceneId ?? "active")}" — scene.list names the ones you may see`,
      );
    const visible = visibleTokens(ctx, scene.tokenRows);
    const page = paginate(visible, {
      limit: args["limit"],
      cursor: args["cursor"],
    });
    const lines = page.rows.map(
      (t) =>
        `  ${t.name} [${t.id}] — ${t.disposition}${t.hidden ? ", hidden" : ""}${t.owned ? ", yours" : ""} · cell ${t.col},${t.row} · ${Math.round(t.x)},${Math.round(t.y)} px${t.actorId ? ` · actor ${t.actorId}` : ""}`,
    );
    return text(
      [
        `${scene.name}: ${pageNote(page, "tokens")}${
          page.total < scene.tokenRows.length
            ? ` (${scene.tokenRows.length - page.total} withheld by the grant)`
            : ""
        }`,
        ...(lines.length > 0 ? lines : ["  none"]),
      ].join("\n"),
      page as unknown as Json,
    );
  },
};

// ── chat ────────────────────────────────────────────────────────────────────────────────────────

/**
 * §5 projection: a roll's *result* can be GM-only while its card is public. The view hands back the
 * rows the session may see; this hides the roll itself when the grant does not cover GM-only data,
 * and says there was one, because "the GM rolled something" is often the fact the table is waiting on.
 */
const chatRead: ToolDefinition = {
  name: "chat.read",
  description:
    "The most recent chat messages this agent may see, newest last. Use since=<seq> to poll for new ones. Whispers it is not in, and GM-only roll results, are not here — the card is public, the dice may not be.",
  args: {
    properties: {
      limit: {
        type: "integer",
        description: "Messages to return (default 20, max 500)",
      },
      since: {
        type: "integer",
        description: "Only messages after this sequence number",
      },
    },
  },
  capability: "chat.read",
  run(args, ctx): ToolOutcome {
    const since = num(args["since"]);
    const args_ = { ...args, limit: args["limit"] ?? 20 };
    const paged = pageOf(
      ctx.view.messages({
        limit: args_.limit,
        ...(since === undefined ? {} : { since }),
      }),
      args_,
    );
    if (!paged.ok) return { invalid: paged.error };
    const page = paged.page;
    const lines = page.rows.map((m) => {
      const tag = m.whisper.length > 0 ? " (whisper)" : "";
      const roll = m.resultWithheld
        ? " [result withheld from this grant]"
        : m.hasRoll
          ? " [rolled]"
          : "";
      return `  ${m.authorName}: ${m.content}${tag}${roll}`;
    });
    return text(
      [
        `${pageNote(page, "messages")}`,
        ...(lines.length > 0 ? lines : ["  none"]),
      ].join("\n"),
      page as unknown as Json,
    );
  },
};

// ── actors, sheets, bestiary ────────────────────────────────────────────────────────────────────

const sheetRead: ToolDefinition = {
  name: "sheet.read",
  description:
    "An actor's derived sheet, trimmed: hp, AC (normal/touch/flat-footed), saves, initiative, BAB, CMB/CMD, speed, conditions, attacks, the skills that matter and feats. Not the whole derivation — the numbers you act on.",
  args: {
    properties: {
      actorId: {
        type: "string",
        description:
          "Actor id (see document.list actors, or a token's actorId)",
      },
    },
    required: ["actorId"],
  },
  capability: "world.read",
  run(args, ctx): ToolOutcome {
    const actorId = str(args["actorId"]);
    if (!actorId) return refusal("sheet.read needs an actorId");
    const sheet = ctx.view.sheet(actorId);
    if (!sheet)
      return refusal(
        `no sheet for actor "${actorId}" — document.list actors names the ones you may see`,
      );
    const attacks = sheet.attacks
      .map(
        (a) =>
          `${a.name} ${a.bonus >= 0 ? "+" : ""}${a.bonus} (${a.damage ?? "—"})${a.ranged ? " ranged" : ""}`,
      )
      .join("; ");
    const lines = [
      `${sheet.name} [${sheet.actorId}]`,
      `  hp ${sheet.hp.current}/${sheet.hp.max}${sheet.hp.nonlethal > 0 ? ` (${sheet.hp.nonlethal} nonlethal)` : ""} · AC ${sheet.ac.normal} (touch ${sheet.ac.touch}, flat ${sheet.ac.flatFooted})`,
      `  saves fort ${sheet.saves.fort >= 0 ? "+" : ""}${sheet.saves.fort} / ref ${sheet.saves.ref >= 0 ? "+" : ""}${sheet.saves.ref} / will ${sheet.saves.will >= 0 ? "+" : ""}${sheet.saves.will}`,
      `  init ${sheet.initiative >= 0 ? "+" : ""}${sheet.initiative} · BAB ${sheet.baseAttack >= 0 ? "+" : ""}${sheet.baseAttack} · CMB ${sheet.cmb} / CMD ${sheet.cmd} · speed ${sheet.speedFt} ft`,
      sheet.conditions.length > 0
        ? `  conditions: ${sheet.conditions.join(", ")}`
        : null,
      sheet.attacks.length > 0 ? `  attacks: ${attacks}` : "  attacks: none",
      sheet.skills.length > 0
        ? `  skills: ${sheet.skills.map((s) => `${s.name} ${s.bonus >= 0 ? "+" : ""}${s.bonus}`).join(", ")}`
        : null,
      sheet.feats.length > 0 ? `  feats: ${sheet.feats.join(", ")}` : null,
    ].filter((line): line is string => line !== null);
    return text(lines.join("\n"), sheet as unknown as Json);
  },
};

const bestiarySearch: ToolDefinition = {
  name: "bestiary.search",
  description:
    "Ranked search over the installed compendia: names, kinds and packs. Returns ids to hand to actor.from_compendium (Phase 2). Capped — ask for what you want, not for everything.",
  args: {
    properties: {
      query: {
        type: "string",
        description: "What to look for; empty browses the packs",
      },
      limit: {
        type: "integer",
        description: "Hits to return (default 20, max 100)",
      },
    },
  },
  capability: "world.read",
  async run(args, ctx): Promise<ToolResult> {
    const search = ctx.view.bestiary;
    if (!search) {
      return refusal(
        "no compendium index on this replica — bestiary.search needs the packages runtime, which the Agents window wires up",
      );
    }
    const limit = Math.min(
      Math.max(Math.trunc(num(args["limit"]) ?? 20), 1),
      100,
    );
    const hits = await search(str(args["query"]) ?? "", limit);
    if (hits.length === 0)
      return text(
        `No compendium entry matches "${String(args["query"] ?? "")}".`,
      );
    return text(
      `${hits.length} hit(s):\n${hits.map((h) => `  ${h.name} [${h.id}] — ${h.type} · ${h.pack}`).join("\n")}`,
      hits as unknown as Json,
    );
  },
};

export const READ_TOOLS: readonly ToolDefinition[] = [
  sceneList,
  sceneRead,
  sceneDescribe,
  mapRender,
  documentList,
  documentRead,
  tokenList,
  chatRead,
  sheetRead,
  bestiarySearch,
];
