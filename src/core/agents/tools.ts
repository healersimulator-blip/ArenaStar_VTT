/**
 * MCP connector §5 — the tool catalogue, assembled, and the one place a tool call is answered.
 *
 * The tools themselves live in `baseTools.ts` (session and world) and `readTools.ts` (the read
 * surface, Phase 1); writes will join them in Phase 2. This module is the registry and the rules:
 *
 * 1. **Typed tools, never a raw op channel.** The plan's own argument for §12 modules having eight
 *    methods instead of the document store applies here with more force: an LLM that can submit
 *    arbitrary ops can corrupt a world. Each tool is one named verb with a declared argument shape.
 * 2. **A refusal is a tool result, a malformed call is a protocol error.** "You may not delete" is
 *    information the model can act on; `{"name": "delte"}` is a client bug and is answered with
 *    JSON-RPC `-32602` so the caller sees it is not a policy decision.
 * 3. **Never throw.** An exception inside a tool becomes an error *result*, because a crashed tool
 *    that leaves the request unanswered hangs an MCP client waiting on its id.
 */
import type { Json } from "../documents";
import { allows, type AgentCapability } from "./capabilities";
import { BASE_TOOLS } from "./baseTools";
import { READ_TOOLS } from "./readTools";
import type {
  ToolArgsSchema,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
  ToolResult,
} from "./types";
import { isInvalid } from "./types";

export * from "./types";
export { BASE_TOOLS } from "./baseTools";
export { READ_TOOLS } from "./readTools";

/** The catalogue, in the order `tools/list` shows it: identity first, then reads, then writes. */
export const AGENT_TOOLS: readonly ToolDefinition[] = [
  ...BASE_TOOLS,
  ...READ_TOOLS,
];

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

// ── argument validation ─────────────────────────────────────────────────────────────────────────

const typeOf = (value: Json): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

/**
 * A number is accepted where an integer was asked for only when it *is* one — a model that guesses
 * `2.5` rows of output should be told, not silently truncated.
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
    const value = args[key];
    if (value === undefined) continue;
    if (!matches(spec.type, value)) {
      return {
        ok: false,
        error: `argument "${key}" must be a ${spec.type} (got ${typeOf(value)})`,
      };
    }
  }
  return { ok: true };
}

// ── the call ────────────────────────────────────────────────────────────────────────────────────

export type ToolCall =
  /** Answered: a result, or a refusal the model is meant to read. */
  | { kind: "result"; result: ToolResult }
  /** Not a policy decision — the call itself is malformed. Answered as JSON-RPC -32602. */
  | { kind: "invalid"; error: string };

const text = (body: string): ToolResult => ({
  content: [{ type: "text", text: body }],
});

const refusal = (reason: string): ToolResult => ({
  content: [{ type: "text", text: reason }],
  isError: true,
});

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

  const gate = allows(ctx.grant, tool.capability as AgentCapability | null);
  if (!gate.ok) return { kind: "result", result: refusal(gate.error) };

  try {
    const outcome: ToolOutcome = await tool.run(args, ctx);
    if (isInvalid(outcome)) return { kind: "invalid", error: outcome.invalid };
    return { kind: "result", result: outcome };
  } catch (error) {
    return {
      kind: "result",
      result: text(
        `"${tool.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
}
