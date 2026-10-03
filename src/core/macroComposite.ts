/**
 * MC-01 — a **composite macro**: one directory entry that runs several saved
 * automation macros, in order.
 *
 * MC-01 lists `composite` among the macro kinds a common directory, hotbar and
 * chat command may execute. A composite is the same shape of thing an automation
 * macro is — a *reference*, never a copy — but it names macros instead of a graph,
 * so it can never smuggle a private graph id into a client either.
 *
 * Two rules keep it from becoming an authority shortcut:
 *
 * - **Children are automation macros only.** A composite chains saved graphs; it is
 *   not a way to nest composites (recursion is MC-02's subject, not this one) and it
 *   cannot chain a chat/script/sequence/summon/preset macro whose own surface owns
 *   inputs, grants or timing.
 * - **The binding is GM-only state.** Like `automation`, `composite` is stripped for
 *   every non-GM copy, so a player receives the composite as a callable catalog entry
 *   and learns neither which children it holds nor their ids. The host resolves the
 *   children against live state and re-applies the *ordinary* automation policy to
 *   each one under the caller's identity, so a composite can never widen a graph's
 *   audience.
 */
import type { MacroDocument } from "./documents";

/** The same bound the client uses for document ids everywhere else. */
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const MACRO_COMPOSITE_LIMITS = { name: 64, children: 8, minimum: 2 } as const;

/** The versioned payload of a composite macro: an ordered list of macros, by reference. */
export interface MacroCompositeBinding {
  /** The children, in execution order. Never projected to a player. */
  macroIds: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Validate just the binding, so an editor can report the field-level problem. */
export function macroCompositeBindingError(binding: unknown): string | null {
  if (binding === undefined) return "a composite macro needs an ordered list of automation macros";
  if (!isObject(binding)) return "a composite binding must be an object";
  const keys = Object.keys(binding);
  if (keys.length !== 1 || keys[0] !== "macroIds")
    return "a composite binding carries exactly one list of macro ids";
  const list = binding.macroIds;
  if (!Array.isArray(list))
    return "a composite binding needs a list of macro ids";
  const { minimum, children } = MACRO_COMPOSITE_LIMITS;
  if (list.length < minimum || list.length > children)
    return `a composite runs ${minimum}–${children} macros`;
  if (list.some((id) => typeof id !== "string" || !DOC_ID.test(id)))
    return "a composite binding needs bounded macro ids";
  if (new Set(list).size !== list.length)
    return "a composite runs each macro once";
  return null;
}

/** Read a *validated* child list, or null — never guess at a malformed import. */
export function macroCompositeMacroIds(
  doc: Pick<MacroDocument, "kind" | "composite">,
): string[] | null {
  if (doc.kind !== "composite") return null;
  return macroCompositeBindingError(doc.composite) === null
    ? (doc.composite as MacroCompositeBinding).macroIds
    : null;
}

/**
 * The full document rule, applied by the host on create and on every update. A
 * composite carries a name and its children — never a chat command, sequence,
 * script, summon, preset, graph binding or execution history.
 */
export function macroCompositeDocumentError(doc: MacroDocument): string | null {
  if (doc.kind !== "composite") return null;
  const binding = macroCompositeBindingError(doc.composite);
  if (binding) return binding;
  const command = doc.command ?? "";
  if (typeof command !== "string" || command.trim().length > 0)
    return "a composite macro runs macros, not a chat command";
  const name = typeof doc.name === "string" ? doc.name.trim() : "";
  if (name.length === 0 || name.length > MACRO_COMPOSITE_LIMITS.name ||
      [...name].some((char) => char.charCodeAt(0) < 32))
    return `a composite macro needs a name of 1–${MACRO_COMPOSITE_LIMITS.name} characters`;
  const stray = (["sequence", "script", "scriptState", "summon", "preset", "automation"] as const)
    .filter((key) => doc[key] !== undefined);
  if (stray.length > 0) return `a composite macro carries a list of macros, not ${stray.join("/")}`;
  return null;
}

/** The mirror of the rule above: only `kind: "composite"` may carry a child list. */
export function macroStrayCompositeError(doc: MacroDocument): string | null {
  if (doc.kind === "composite" || doc.composite === undefined) return null;
  return "a composite binding belongs to a composite macro, not another kind";
}
