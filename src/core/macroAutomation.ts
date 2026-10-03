/**
 * TR-12 / MC-01 — an **automation macro**: a saved graph, callable by reference.
 *
 * TR-12 asks that "door/journal/macro triggers can fire a named automation without
 * recreating it", and MC-01 lists `automation` among the macro kinds a common
 * directory, hotbar and chat command may execute. Both describe the same missing
 * half of the graph model: today a graph can call *out* (Run Macro, Trigger Tile,
 * reviewed scripts), but nothing outside a graph can call *in* without carrying a
 * private graph id — which a player must never hold.
 *
 * This module is that missing edge. An automation macro is a `MacroDocument` of
 * `kind: "automation"` whose **binding** names one saved graph. The binding is
 * GM-only state: players receive the macro as a *callable catalog* entry (name,
 * kind, hotbar slot) and never the graph id, the graph name or its definition, so
 * the host — not the client — decides which graph a click actually fires.
 *
 * The macro carries no actions of its own. It is a reference, and every authority
 * question is settled where the graph already lives: the host re-validates the
 * definition, checks that the graph subscribes to the invocation method (`manual`),
 * and for a player additionally requires a published, visible tile anchor, the
 * `playerRunnable` gate and the player's own scene. A macro can therefore never
 * widen a graph's audience, only make an already-published one easier to reach.
 */
import type { MacroDocument } from "./documents";

/** The same bound the client uses for document ids everywhere else. */
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const MACRO_AUTOMATION_LIMITS = { name: 64 } as const;

/** The versioned payload of an automation macro: one graph, by reference. */
export interface MacroAutomationBinding {
  /** The saved graph this macro invokes. Never projected to a player. */
  graphId: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The invocation kind a macro uses: the graph's own `manual` trigger. */
export const MACRO_AUTOMATION_METHOD = "manual" as const;

/** Validate just the binding, so an editor can report the field-level problem. */
export function macroAutomationBindingError(binding: unknown): string | null {
  if (binding === undefined) return "an automation macro needs a graph binding";
  if (!isObject(binding)) return "an automation binding must be an object";
  const keys = Object.keys(binding);
  if (keys.length !== 1 || keys[0] !== "graphId")
    return "an automation binding carries exactly one graph id";
  const graphId = binding.graphId;
  if (typeof graphId !== "string" || !DOC_ID.test(graphId))
    return "an automation binding needs a bounded graph id";
  return null;
}

/** Read a *validated* binding id, or null — never guess at a malformed import. */
export function macroAutomationGraphId(doc: Pick<MacroDocument, "kind" | "automation">): string | null {
  if (doc.kind !== "automation") return null;
  return macroAutomationBindingError(doc.automation) === null
    ? (doc.automation as MacroAutomationBinding).graphId
    : null;
}

/**
 * The full document rule, applied by the host on create and on every update (and
 * by imports that care to check). An automation macro carries a reference and a
 * name — never a chat command, sequence, script, summon, preset or execution
 * history, and never a stray binding on a macro of another kind.
 */
export function macroAutomationDocumentError(doc: MacroDocument): string | null {
  if (doc.kind !== "automation") return null;
  const binding = macroAutomationBindingError(doc.automation);
  if (binding) return binding;
  const command = doc.command ?? "";
  if (typeof command !== "string" || command.trim().length > 0)
    return "an automation macro runs a saved graph, not a chat command";
  const name = typeof doc.name === "string" ? doc.name.trim() : "";
  if (name.length === 0 || name.length > MACRO_AUTOMATION_LIMITS.name ||
      [...name].some((char) => char.charCodeAt(0) < 32))
    return `an automation macro needs a name of 1–${MACRO_AUTOMATION_LIMITS.name} characters`;
  const stray = (["sequence", "script", "scriptState", "summon", "preset", "composite"] as const)
    .filter((key) => doc[key] !== undefined);
  if (stray.length > 0) return `an automation macro carries a graph reference, not ${stray.join("/")}`;
  return null;
}

/** The mirror of the rule above: only `kind: "automation"` may carry a binding. */
export function macroStrayAutomationError(doc: MacroDocument): string | null {
  if (doc.kind === "automation" || doc.automation === undefined) return null;
  return "an automation binding belongs to an automation macro, not another kind";
}
