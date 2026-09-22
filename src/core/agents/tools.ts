/**
 * MCP connector §5 — the tool catalogue, and the one place a tool call is answered.
 *
 * Three rules the rest of the feature depends on:
 *
 * 1. **Typed tools, never a raw op channel.** The plan's own argument for §12 modules having eight
 *    methods instead of the document store applies here with more force: an LLM that can submit
 *    arbitrary ops can corrupt a world. Each tool is one named verb with a declared argument shape.
 * 2. **The answer is the post-state read back from the replica**, never an echo of the request — a
 *    refusal, a clamp or a partial application has to be visible to the caller (§6).
 * 3. **A refusal is a tool result, a malformed call is a protocol error.** "You may not delete" is
 *    information the model can act on; `{"name": "delte"}` is a client bug and is answered with
 *    JSON-RPC `-32602` so the caller sees it is not a policy decision.
 *
 * Phase 0 carries two read tools. Everything here is pure: the world is reached through the
 * `AgentWorldView` interface, so the same table runs against the GM's tab and against a host booted
 * in Node by the integration test.
 */
import type { Json, Role } from "../documents";
import {
  AGENT_CAPABILITIES,
  allows,
  type AgentCapability,
  type AgentGrant,
} from "./capabilities";

/** The world, as this agent's user is allowed to read it (§6: reads are the projection). */
export interface AgentWorldView {
  worldInfo(): AgentWorldInfo;
  /** Null before the session has been welcomed — an agent may connect before its grant lands. */
  identity(): AgentIdentity | null;
}

export interface AgentWorldInfo {
  id: string;
  name: string;
  system: string;
  version: string;
  /** The replica's sequence number: what the agent just read is true as of here. */
  seq: number;
  /** Non-empty collections only — a world is mostly empty, and empty rows are noise. */
  collections: Record<string, number>;
}

export interface AgentIdentity {
  id: string;
  name: string;
  role: Role;
}

export type ToolContent = { type: "text"; text: string };

/** MCP's tool result shape (§5): text blocks, an optional machine-readable body, an error flag. */
export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Json;
  isError?: boolean;
}

export interface ToolContext {
  view: AgentWorldView;
  grant: AgentGrant;
}

/**
 * The argument shape, in the only subset this feature needs. Deliberately not a JSON-Schema
 * dependency (§9 risk 1: no SDK in the runtime path) — `inputSchemaOf()` renders the standard form
 * for `tools/list`, and `validateArgs()` enforces it on the way in.
 */
export interface ToolArgsSchema {
  properties: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean" | "array" | "object";
      description: string;
    }
  >;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  /** One sentence, addressed to the model: what it gets back, not how it works. */
  description: string;
  args: ToolArgsSchema;
  /** `null` = needs nothing (the identity probe must always be answerable). */
  capability: AgentCapability | null;
  run(
    args: Record<string, Json>,
    ctx: ToolContext,
  ): ToolResult | Promise<ToolResult>;
}

const text = (body: string): ToolResult => ({
  content: [{ type: "text", text: body }],
});

const refusal = (reason: string): ToolResult => ({
  content: [{ type: "text", text: reason }],
  isError: true,
});

// ── the two Phase 0 tools ──────────────────────────────────────────────────────────────────────

const whoami: ToolDefinition = {
  name: "whoami",
  description:
    "The agent's own identity: its name, role, preset and the capabilities its grant allows. Costs nothing and is never refused — ask first when a call comes back denied.",
  args: { properties: {} },
  capability: null,
  run(_args, ctx): ToolResult {
    const me = ctx.view.identity();
    const granted = ctx.grant.capabilities;
    const withheld = AGENT_CAPABILITIES.filter((c) => !granted.includes(c));
    // Two different roles are in play and they are not the same thing: the **session** is whose
    // replica the reads come from, and the **grant** is what the GM allowed this agent to do with
    // them. In Phase 0 the bridge is hosted by the GM's tab, so the session says GM while a grant
    // may say observer — and an agent that reads "role GM" and stops there would draw exactly the
    // wrong conclusion. Say both, and say which one is the ceiling.
    const narrower = me !== null && ctx.grant.role !== me.role;
    const lines = [
      me
        ? `You are "${me.name}" (${me.id}) — session role ${me.role} (your reads come from this session's replica).`
        : `No session is bound yet.`,
      `Grant: preset "${ctx.grant.preset}", role ${ctx.grant.role}${
        narrower
          ? " — narrower than the session, and it is the ceiling on your tools"
          : ""
      }.`,
      `Capabilities (${granted.length}): ${granted.join(", ") || "none"}.`,
      withheld.length > 0
        ? `Withheld (${withheld.length}): ${withheld.join(", ")}.`
        : "Withheld: none.",
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        identity: me as unknown as Json,
        role: ctx.grant.role,
        preset: ctx.grant.preset,
        capabilities: granted as unknown as Json,
        withheld: withheld as unknown as Json,
      },
    };
  },
};

const worldInfo: ToolDefinition = {
  name: "world.info",
  description:
    "The world's name, system and version, the replica's sequence number, and how many documents each collection holds. The cheapest way to find out where you are.",
  args: { properties: {} },
  capability: "world.read",
  run(_args, ctx): ToolResult {
    const world = ctx.view.worldInfo();
    const counts = Object.entries(world.collections)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([coll, n]) => `${coll} ${n}`);
    const body = [
      `World "${world.name}" (${world.id}) — system ${world.system} ${world.version}, seq ${world.seq}.`,
      counts.length > 0
        ? `Documents: ${counts.join(", ")}.`
        : "Documents: none yet.",
    ].join("\n");
    return {
      content: [{ type: "text", text: body }],
      structuredContent: {
        id: world.id,
        name: world.name,
        system: world.system,
        version: world.version,
        seq: world.seq,
        collections: world.collections as unknown as Json,
      },
    };
  },
};

export const AGENT_TOOLS: readonly ToolDefinition[] = [whoami, worldInfo];

/** The `tools/list` answer. */
export function toolManifest(): Array<{
  name: string;
  description: string;
  inputSchema: Json;
}> {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchemaOf(tool.args) as unknown as Json,
  }));
}

export function inputSchemaOf(args: ToolArgsSchema): {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
  additionalProperties: false;
} {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const [key, spec] of Object.entries(args.properties)) {
    properties[key] = { type: spec.type, description: spec.description };
  }
  const required =
    args.required && args.required.length > 0 ? [...args.required] : undefined;
  return required
    ? { type: "object", properties, required, additionalProperties: false }
    : { type: "object", properties, additionalProperties: false };
}

// ── argument validation ───────────────────────────────────────────────────────────────────────

const typeOf = (value: Json): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

/**
 * A number is accepted where an integer was asked for only when it *is* one — a model that guesses
 * `2.5` tokens of movement should be told, not silently truncated.
 */
function matches(wanted: string, value: Json): boolean {
  const got = typeOf(value);
  if (wanted === got) return true;
  return wanted === "number" && got === "integer";
}

function validateArgs(
  tool: ToolDefinition,
  args: Record<string, Json>,
): { ok: true } | { ok: false; error: string } {
  const accepted = Object.keys(tool.args.properties);
  for (const key of Object.keys(args)) {
    if (!accepted.includes(key)) {
      const hint =
        accepted.length > 0 ? `; it takes: ${accepted.join(", ")}` : "";
      return {
        ok: false,
        error: `"${tool.name}" takes no argument "${key}"${hint}`,
      };
    }
  }
  for (const key of tool.args.required ?? []) {
    if (!(key in args))
      return { ok: false, error: `"${tool.name}" needs argument "${key}"` };
  }
  for (const [key, spec] of Object.entries(tool.args.properties)) {
    if (!(key in args)) continue;
    if (!matches(spec.type, args[key] as Json)) {
      return {
        ok: false,
        error: `argument "${key}" must be a ${spec.type} (got ${typeOf(args[key] as Json)})`,
      };
    }
  }
  return { ok: true };
}

// ── the call ──────────────────────────────────────────────────────────────────────────────────

export type ToolCall =
  /** Answered: a result, or a refusal the model is meant to read. */
  | { kind: "result"; result: ToolResult }
  /** Not a policy decision — the call itself is malformed. Answered as JSON-RPC -32602. */
  | { kind: "invalid"; error: string };

/**
 * One `tools/call`. Never throws: an exception inside a tool becomes an error result, because a
 * crashed tool that leaves the request unanswered hangs an MCP client that is waiting on its id.
 */
export async function callTool(
  call: { name: unknown; args?: unknown },
  ctx: ToolContext,
): Promise<ToolCall> {
  if (typeof call.name !== "string" || call.name === "") {
    return { kind: "invalid", error: "tools/call needs a tool name" };
  }
  const tool = AGENT_TOOLS.find((t) => t.name === call.name);
  if (!tool) {
    return {
      kind: "invalid",
      error: `no tool named "${call.name}" — tools/list is the catalogue`,
    };
  }
  const raw = call.args;
  if (
    raw !== undefined &&
    raw !== null &&
    (typeof raw !== "object" || Array.isArray(raw))
  ) {
    return {
      kind: "invalid",
      error: `"${tool.name}" arguments must be an object`,
    };
  }
  const args = (raw ?? {}) as Record<string, Json>;
  const check = validateArgs(tool, args);
  if (!check.ok) return { kind: "invalid", error: check.error };

  const gate = allows(ctx.grant, tool.capability);
  if (!gate.ok) return { kind: "result", result: refusal(gate.error) };

  try {
    return { kind: "result", result: await tool.run(args, ctx) };
  } catch (error) {
    return {
      kind: "result",
      result: text(
        `"${tool.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
}
