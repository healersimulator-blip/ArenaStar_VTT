/**
 * MCP connector §5.7 — resources: the world's read surface as **URIs a client can subscribe to**.
 *
 * The rule that shaped this file: a resource is not a second implementation of a tool, it is the same
 * answer wearing a URI. Every resource below is dispatched to the tool that owns the data and rendered
 * from its result — so a grant that refuses `world.read` refuses `vtt://world/<id>/overview` too, and
 * there is exactly one place a redaction rule can be forgotten.
 *
 * `resources/list` enumerates the cheap, bounded ones (overview, tokens, chat, packages, and each
 * scene with its map); the open-ended ones — a sheet per actor, a map per scene — are advertised as
 * **templates**, which is what MCP has them for. Listing 5,000 actor URIs would be a resource list
 * nobody can read and a client that hangs on startup.
 */
import type { Json } from "../documents";
import { callTool } from "./tools";
import type { AgentGrant, AgentWorldView, ToolResult } from "./types";

export interface AgentResource {
  uri: string;
  name: string;
  mimeType: string;
  description: string;
}

export interface AgentResourceTemplate {
  uriTemplate: string;
  name: string;
  mimeType: string;
  description: string;
}

/** A scene list longer than this stops producing per-scene resources. */
const SCENE_RESOURCE_CAP = 20;

export function worldUri(view: AgentWorldView, path: string): string {
  return `vtt://world/${encodeURIComponent(view.worldInfo().id)}/${path}`;
}

export function resourceList(view: AgentWorldView): AgentResource[] {
  const world = view.worldInfo();
  const id = encodeURIComponent(world.id);
  const out: AgentResource[] = [
    {
      uri: `vtt://world/${id}/overview`,
      name: "World overview",
      mimeType: "text/markdown",
      description:
        "World name and system, the clock, and how many documents each collection holds.",
    },
    {
      uri: `vtt://world/${id}/tokens`,
      name: "Tokens on the active scene",
      mimeType: "text/plain",
      description:
        "Token table with ids, grid cells and dispositions (hidden ones only with gmOnly.read).",
    },
    {
      uri: `vtt://world/${id}/chat`,
      name: "Chat",
      mimeType: "text/plain",
      description:
        "The messages this agent may see. Add ?since=<seq> to read only what is new.",
    },
    {
      uri: `vtt://world/${id}/packages`,
      name: "Installed packages",
      mimeType: "text/plain",
      description: "The installed rulesets and content packs (§12).",
    },
  ];
  for (const scene of view.scenes().slice(0, SCENE_RESOURCE_CAP)) {
    const sceneId = encodeURIComponent(scene.id);
    out.push(
      {
        uri: `vtt://world/${id}/scene/${sceneId}`,
        name: `Scene: ${scene.name}`,
        mimeType: "application/json",
        description:
          "Scene metadata, its tokens and the rendered map grid, as JSON.",
      },
      {
        uri: `vtt://world/${id}/scene/${sceneId}/map.txt`,
        name: `Map: ${scene.name}`,
        mimeType: "text/plain",
        description:
          "The scene rendered as a text map, one character per cell.",
      },
    );
  }
  return out;
}

export const RESOURCE_TEMPLATES: readonly AgentResourceTemplate[] = [
  {
    uriTemplate: "vtt://world/{worldId}/scene/{sceneId}",
    name: "Any scene, as JSON",
    mimeType: "application/json",
    description:
      "Scene metadata, tokens and the rendered grid. Use resources/list for the ones already known.",
  },
  {
    uriTemplate: "vtt://world/{worldId}/scene/{sceneId}/map.txt",
    name: "Any scene, as a text map",
    mimeType: "text/plain",
    description:
      "One character per cell, with rulers and a legend of token ids.",
  },
  {
    uriTemplate: "vtt://world/{worldId}/sheet/{actorId}",
    name: "Any actor's derived sheet",
    mimeType: "text/markdown",
    description:
      "hp, AC, saves, attacks, skills and feats — the same numbers sheet.read returns.",
  },
];

/**
 * Hexcrawl resources are Phase 5's (`hexmap.render` is **[F1]**): the URI is reserved here so a client
 * that guesses it gets "not yet" rather than "not found" — the difference between a roadmap and a gap.
 */
const DEFERRED: Record<string, string> = {
  hexmap:
    "hexmap is Phase 5 of the connector plan (it needs the hexcrawl tools)",
};

export interface ReadResource {
  uri: string;
  mimeType: string;
  text: string;
}

export type ResourceRead =
  | { ok: true; resource: ReadResource }
  | {
      ok: false;
      code: "invalid_uri" | "not_found" | "not_implemented";
      message: string;
    };

/**
 * Read a `vtt://world/...` URI. Unknown shapes are answered with the shapes that exist — a model that
 * guesses a URI should be told the grammar, not just that it guessed wrong.
 */
export async function readResource(
  view: AgentWorldView,
  grant: AgentGrant,
  rawUri: string,
): Promise<ResourceRead> {
  const uri = rawUri.trim();
  const queryAt = uri.indexOf("?");
  const queryPart = queryAt < 0 ? null : uri.slice(queryAt + 1);
  // Strip the query before matching: `chat?since=1` is the `chat` resource, not a resource named
  // "chat?since=1", and the shape check below would otherwise invent one.
  const match = /^vtt:\/\/world\/([^/]+)(\/.*)?$/.exec(
    queryAt < 0 ? uri : uri.slice(0, queryAt),
  );
  if (!match) {
    return {
      ok: false,
      code: "invalid_uri",
      message:
        "a resource URI looks like vtt://world/<worldId>/overview — overview, tokens, chat, packages, scene/<sceneId>, scene/<sceneId>/map.txt, sheet/<actorId>",
    };
  }
  const worldId = decodeURIComponent(match[1] ?? "");
  const path = (match[2] ?? "/").replace(/^\//, "");
  const world = view.worldInfo();
  if (worldId !== world.id) {
    return {
      ok: false,
      code: "not_found",
      message: `this replica holds world "${world.id}", not "${worldId}"`,
    };
  }

  const [head, second, third] = path.split("/");
  const query = queryPart === null ? null : new URLSearchParams(queryPart);

  const call = async (
    name: string,
    args: Record<string, Json>,
  ): Promise<ToolResult | null> => {
    const answered = await callTool({ name, args }, { view, grant });
    return answered.kind === "result" ? answered.result : null;
  };

  const asText = (
    answered: Awaited<ReturnType<typeof call>>,
    mimeType: string,
  ): ResourceRead =>
    answered === null
      ? {
          ok: false,
          code: "invalid_uri",
          message: "the tool behind this resource refused the call",
        }
      : {
          ok: true,
          resource: {
            uri,
            mimeType,
            text: answered.content.map((block) => block.text).join("\n"),
          },
        };

  if (head === "overview" || path === "") {
    const info = await call("world.info", {});
    const body =
      info === null ? "" : info.content.map((b) => b.text).join("\n");
    return {
      ok: true,
      resource: {
        uri,
        mimeType: "text/markdown",
        text: `# ${world.name}\n\n${body}\n\nClock: ${formatClock(view.clockSeconds())}.`,
      },
    };
  }
  if (head === "tokens") {
    const sceneId = query?.get("sceneId");
    return asText(
      await call(
        "token.list",
        sceneId === null ? {} : { sceneId: sceneId as Json },
      ),
      "text/plain",
    );
  }
  if (head === "chat") {
    const since = query?.get("since");
    return asText(
      await call("chat.read", since === null ? {} : { since: Number(since) }),
      "text/plain",
    );
  }
  if (head === "packages") {
    const packs = view.packages?.() ?? [];
    const text =
      packs.length > 0
        ? packs
            .map((p) => `${p.label} [${p.id}] — ${p.entries} entries`)
            .join("\n")
        : "No packages reported by this replica.";
    return { ok: true, resource: { uri, mimeType: "text/plain", text } };
  }
  if (head === "sheet" && second) {
    return asText(
      await call("sheet.read", { actorId: decodeURIComponent(second) as Json }),
      "text/markdown",
    );
  }
  if (head === "scene" && second) {
    const sceneId = decodeURIComponent(second);
    if (third === "map.txt") {
      const answered = await call("map.render", { sceneId, format: "ascii" });
      return asText(answered, "text/plain");
    }
    if (third === undefined) {
      const answered = await call("scene.describe", { sceneId });
      if (answered === null) {
        return {
          ok: false,
          code: "invalid_uri",
          message: "the scene tool refused the call",
        };
      }
      return {
        ok: true,
        resource: {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            answered.structuredContent ?? answered.content[0]?.text ?? null,
            null,
            2,
          ),
        },
      };
    }
  }
  if (head !== undefined && DEFERRED[head]) {
    return {
      ok: false,
      code: "not_implemented",
      message: DEFERRED[head] ?? "not implemented",
    };
  }
  return { ok: false, code: "not_found", message: `no resource at "${uri}"` };
}

/** The one clock, in the words a table uses — §5.5 keeps the seconds; nobody wants 14,400 of them. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0)
    return `day ${days + 1}, ${hours}:${String(minutes).padStart(2, "0")}`;
  return `${hours}:${String(minutes).padStart(2, "0")} (${total}s)`;
}
