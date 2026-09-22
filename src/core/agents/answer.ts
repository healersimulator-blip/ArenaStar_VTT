/**
 * MCP connector §5 — the four things every tool does with its answer.
 *
 * They live here, not in the tool modules, because the *shape of an answer* is one decision and a
 * model sees it on every call: a text block it can quote, an optional machine-readable body it can
 * point at, an `isError` that means "refused, and here is why" (never "the world is broken"), and
 * argument readers that never throw on a JSON value of the wrong type.
 */
import type { Json } from "../documents";
import type { ToolContent, ToolOutcome, ToolResult } from "./types";

/** The normal answer: one text block, plus the structured body a client can hold. */
export function text(body: string, structured?: Json): ToolResult {
  const content: ToolContent[] = [{ type: "text", text: body }];
  return structured === undefined
    ? { content }
    : { content, structuredContent: structured };
}

/**
 * A refusal. It is a **result**, not a protocol error (D-278): "you may not delete documents —
 * ask the GM to change its grant" is information a model routes around, where `-32602` is a client
 * bug. The sentence is the whole payload, and it is why `PHRASE` exists in `capabilities.ts`.
 */
export function refusal(reason: string): ToolResult {
  return { content: [{ type: "text", text: reason }], isError: true };
}

/** A malformed call — the bridge turns this into JSON-RPC `-32602` (D-279). */
export function invalid(error: string): ToolOutcome {
  return { invalid: error };
}

export const str = (value: Json | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

export const num = (value: Json | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const bool = (value: Json | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** An object argument, or undefined when it is not one. */
export const obj = (
  value: Json | undefined,
): Record<string, Json> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;

/** A finite number inside `[min, max]` — the guard every pixel/cell argument needs. */
export const numIn = (
  value: Json | undefined,
  min: number,
  max: number,
): number | undefined => {
  const n = num(value);
  if (n === undefined || n < min || n > max) return undefined;
  return n;
};
