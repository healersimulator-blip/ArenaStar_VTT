/**
 * MC-02 — **typed invocation arguments** for a callable macro.
 *
 * A macro that declares inputs publishes a small, bounded schema; a caller may send only
 * those keys, each with the declared type. The schema IS the callable metadata, so a
 * player receives it (unlike an automation binding's graph id) — it is exactly what the
 * caller needs to call the macro correctly.
 *
 * Three rules keep this from being a smuggling route:
 *
 * - **Declared keys only.** An undeclared key is refused, so a caller cannot push arbitrary
 *   data into a graph's interpolation context.
 * - **Typed and bounded.** A string is ≤256 characters, a number is finite and ≤1e9, a
 *   boolean is a boolean, and a `token` id must exist and be visible to the caller — the
 *   same rules the reviewed-script path already enforces.
 * - **Namespaced at interpolation.** Arguments surface as `{{arg.<name>}}`, which is not a
 *   legal durable-variable name, so an imported world can never shadow one.
 *
 * D-388 adds the caller's **selection** as a default source: an input declared
 * `from: "selected"` is filled from the token the caller has selected on the canvas when the
 * caller does not spell it out (`token` → the token, `actor` → the actor it links to). The
 * default is a *caller-side* convenience — the host validates the resulting id exactly like a
 * spelled-out one, so a client cannot select its way past visibility.
 * D-393 adds `item`: a world item id or actorId/itemId, with `from: "selected"`
 * taking the caller's most recently focused open item window, independently of tokens.
 */
import { parseMacroItemRef } from "./macroItems";
export const MACRO_ARG_LIMITS = { inputs: 16, bytes: 8192, string: 256, number: 1e9 } as const;

export type MacroArgType = "string" | "number" | "boolean" | "token" | "actor" | "item";

export interface MacroArgInput {
  name: string;
  type: MacroArgType;
  required?: boolean;
  /** `"selected"`: omit the value to use the caller's canvas token or independent item window. */
  from?: "selected";
}

/** The caller's local token and item-window selection, as their own replica knows it. */
export interface MacroSelection {
  tokenId: string | null;
  /** The actor the selected token links to, or null (no token / an unlinked token). */
  actorId: string | null;
  /** D-393: exact world/embedded item reference, independent of the token selection. */
  itemRef?: string;
}

/** Combine optional token/item context; null only when neither source is present and valid. */
export function macroSelection(
  token: { _id: string; actorId?: string | null } | null | undefined, itemReference: string | null = null,
): MacroSelection | null {
  const itemRef = parseMacroItemRef(itemReference) ? itemReference : null;
  return token || itemRef ? { tokenId: token?._id ?? null, actorId: token?.actorId ?? null,
    ...(itemRef ? { itemRef } : {}) } : null;
}

export type MacroArgValue = string | number | boolean;
export type MacroArgs = Record<string, MacroArgValue>;

/** The same identifier rule the reviewed-script input schema uses. */
const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
/** A document id, as everywhere else on the wire. */
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The declared schema, validated at authoring and re-read at execution. */
export function macroArgSchemaError(inputs: unknown): string | null {
  if (inputs === undefined) return null;
  if (!Array.isArray(inputs)) return "declared inputs must be a list";
  if (inputs.length > MACRO_ARG_LIMITS.inputs)
    return `a macro declares at most ${MACRO_ARG_LIMITS.inputs} inputs`;
  const names = new Set<string>();
  for (const field of inputs) {
    if (!isObject(field) ||
        Object.keys(field).some((key) => !["name", "type", "required", "from"].includes(key)))
      return "invalid input schema";
    if (typeof field.name !== "string" || !NAME.test(field.name) || names.has(field.name))
      return "invalid input schema";
    if (!["string", "number", "boolean", "token", "actor", "item"].includes(String(field.type)))
      return "invalid input schema";
    if (field.required !== undefined && typeof field.required !== "boolean")
      return "invalid input schema";
    // Tokens/linked actors come from the canvas; an item comes from its item window.
    // Literal string/number/boolean fields have no selection to default to.
    if (field.from !== undefined &&
        !(field.from === "selected" && (field.type === "token" || field.type === "actor" || field.type === "item")))
      return "invalid input schema";
    names.add(field.name);
  }
  return null;
}

/** Read a validated schema, or an empty list — a malformed import declares nothing. */
export function macroArgInputs(inputs: unknown): MacroArgInput[] {
  return macroArgSchemaError(inputs) === null && Array.isArray(inputs)
    ? (inputs as MacroArgInput[])
    : [];
}

/**
 * Validate a caller's argument record against the schema. `visible` is the host's live
 * read check per reference type — a caller may never name a token, actor or item they cannot read,
 * whether they spelled it out or took it from their selection.
 */
export function validateMacroArgs(
  value: unknown, inputs: readonly MacroArgInput[],
  visible: (type: "token" | "actor" | "item", id: string) => boolean,
): { ok: true; args: MacroArgs } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (value === undefined) value = {};
  if (!isObject(value)) return bad("arguments must be a named record");
  if (Object.keys(value).length > MACRO_ARG_LIMITS.inputs) return bad("too many arguments");
  let bytes: number;
  try {
    bytes = JSON.stringify(value).length;
  } catch {
    return bad("unserializable arguments");
  }
  if (bytes > MACRO_ARG_LIMITS.bytes) return bad("macro input exceeds 8 KiB");
  const declared = new Map(inputs.map((field) => [field.name, field] as const));
  if (Object.keys(value).some((key) => !declared.has(key))) return bad("unknown macro argument");
  const args: MacroArgs = {};
  for (const field of inputs) {
    const supplied = value[field.name];
    if (supplied === undefined || supplied === null) {
      if (field.required) return bad(`missing ${field.name}`);
      continue;
    }
    if (field.type === "string" && (typeof supplied !== "string" || supplied.length > MACRO_ARG_LIMITS.string))
      return bad(`invalid ${field.name}`);
    if (field.type === "number" &&
        (typeof supplied !== "number" || !Number.isFinite(supplied) ||
          Math.abs(supplied) > MACRO_ARG_LIMITS.number))
      return bad(`invalid ${field.name}`);
    if (field.type === "boolean" && typeof supplied !== "boolean") return bad(`invalid ${field.name}`);
    if ((field.type === "token" || field.type === "actor") &&
        (typeof supplied !== "string" || !DOC_ID.test(supplied) || !visible(field.type, supplied)))
      return bad(`invalid or invisible ${field.name}`);
    if (field.type === "item" &&
        (typeof supplied !== "string" || !parseMacroItemRef(supplied) || !visible("item", supplied)))
      return bad(`invalid or invisible ${field.name}`);
    args[field.name] = supplied as MacroArgValue;
  }
  return { ok: true, args };
}

/**
 * Coerce one **text** token (a `/run` word, a form field) into the declared type.
 * Returns `null` when the text cannot be that type — the caller reports it.
 */
export function coerceMacroArgText(field: MacroArgInput, raw: string): MacroArgValue | null {
  const text = raw.trim();
  if (field.type === "string") return text.length <= MACRO_ARG_LIMITS.string ? text : null;
  if (field.type === "number") {
    if (text === "") return null;
    const value = Number(text);
    return Number.isFinite(value) && Math.abs(value) <= MACRO_ARG_LIMITS.number ? value : null;
  }
  if (field.type === "boolean") {
    if (["true", "1", "yes", "on"].includes(text.toLowerCase())) return true;
    if (["false", "0", "no", "off"].includes(text.toLowerCase())) return false;
    return null;
  }
  if (field.type === "item") return parseMacroItemRef(text) ? text : null;
  // A token/actor argument is an id; whether it is *readable* is the host's call.
  return DOC_ID.test(text) ? text : null;
}

/**
 * Split a `/run <name> …` tail into named (`key=value`) and positional tokens.
 * A quoted value keeps its spaces; the mapping onto declared inputs happens in
 * `bindMacroArgs`, which is where the schema is known.
 */
export function splitMacroArgTokens(tail: string): { named: Array<[string, string]>; positional: string[] } {
  const named: Array<[string, string]> = [];
  const positional: string[] = [];
  // One scan: `key="quoted value"`, `key='quoted'`, `key=bare`, then quoted or bare words.
  // A `key=` token is always named; an unmatched quote is kept verbatim in its value.
  const pattern = /([A-Za-z][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|(\S*))|"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of tail.matchAll(pattern)) {
    if (match[1] !== undefined) named.push([match[1], match[3] ?? match[4] ?? match[5] ?? ""]);
    else if (match[6] !== undefined) positional.push(match[6]);
    else if (match[7] !== undefined) positional.push(match[7]);
    else positional.push(match[8] ?? "");
  }
  return { named, positional };
}

/**
 * Bind tokens onto a declared schema: named keys by name, positional words by order,
 * each coerced to its declared type. Every declared required input must receive a value,
 * and a named key that is not declared is an error (never silently dropped). A field
 * declared `from: "selected"` that received no explicit value takes the caller's selection.
 */
export function bindMacroArgs(
  inputs: readonly MacroArgInput[], tail: string, selection: MacroSelection | null = null,
): { ok: true; args: MacroArgs } | { ok: false; error: string } {
  const { named, positional } = splitMacroArgTokens(tail);
  const args: MacroArgs = {};
  const byName = new Map(inputs.map((field) => [field.name, field] as const));
  for (const [key, raw] of named) {
    const field = byName.get(key);
    if (!field) return { ok: false, error: `unknown argument ${key}` };
    const value = coerceMacroArgText(field, raw);
    if (value === null) return { ok: false, error: `invalid ${field.name}` };
    args[field.name] = value;
  }
  if (positional.length > 0) {
    // Explicit words come before the selection default, in declaration order.
    const free = inputs.filter((field) => args[field.name] === undefined);
    if (positional.length > free.length) return { ok: false, error: "too many arguments" };
    for (const [index, word] of positional.entries()) {
      const field = free[index];
      if (!field) return { ok: false, error: "too many arguments" };
      const value = coerceMacroArgText(field, word);
      if (value === null) return { ok: false, error: `invalid ${field.name}` };
      args[field.name] = value;
    }
  }
  return fillSelection(inputs, args, selection);
}

/**
 * The run form's binder: the same rules for a per-field text record (the caller typed some
 * values and left others blank), so a selection default works identically there.
 */
export function bindMacroArgFields(
  inputs: readonly MacroArgInput[], raw: Readonly<Record<string, string>>, selection: MacroSelection | null = null,
): { ok: true; args: MacroArgs } | { ok: false; error: string } {
  const args: MacroArgs = {};
  for (const field of inputs) {
    const text = (raw[field.name] ?? "").trim();
    if (text === "") continue; // blank means "not spelled out": the selection or required check decides
    const value = coerceMacroArgText(field, text);
    if (value === null) return { ok: false, error: `invalid ${field.name}` };
    args[field.name] = value;
  }
  const known = new Set(inputs.map((field) => field.name));
  const stray = Object.keys(raw).find((key) => !known.has(key) && (raw[key] ?? "").trim() !== "");
  if (stray) return { ok: false, error: `unknown argument ${stray}` };
  return fillSelection(inputs, args, selection);
}

/** Apply `from: "selected"` defaults, then enforce `required` with a reason that names the remedy. */
function fillSelection(
  inputs: readonly MacroArgInput[], args: MacroArgs, selection: MacroSelection | null,
): { ok: true; args: MacroArgs } | { ok: false; error: string } {
  for (const field of inputs) {
    if (args[field.name] !== undefined || field.from !== "selected" || !selection) continue;
    if (field.type === "token") {
      if (selection.tokenId) args[field.name] = selection.tokenId;
      continue;
    }
    if (field.type === "item") {
      if (selection.itemRef && parseMacroItemRef(selection.itemRef)) args[field.name] = selection.itemRef;
      continue;
    }
    // An unlinked token has no actor; an item-only selection does not invent one.
    if (field.type === "actor") {
      if (!selection.actorId) {
        if (field.required && selection.tokenId) return { ok: false, error: "the selected token has no actor" };
        continue;
      }
      args[field.name] = selection.actorId;
    }
  }
  const missing = inputs.filter((field) => field.required && args[field.name] === undefined);
  if (missing.length === 0) return { ok: true, args };
  const fromItems = missing.filter((field) => field.from === "selected" && field.type === "item");
  if (fromItems.length > 0)
    return { ok: false, error: `select an item for ${fromItems.map((field) => field.name).join(", ")}` };
  const fromSelection = missing.filter((field) => field.from === "selected");
  if (fromSelection.length > 0 && !selection?.tokenId)
    return { ok: false, error: `select a token for ${fromSelection.map((field) => field.name).join(", ")}` };
  return { ok: false, error: `missing ${missing.map((field) => field.name).join(", ")}` };
}

/** The interpolation context a graph sees: `arg.<name>` for every supplied argument. */
export function macroArgValues(args: MacroArgs | undefined): Record<string, MacroArgValue> {
  const values: Record<string, MacroArgValue> = Object.create(null) as Record<string, MacroArgValue>;
  for (const [name, value] of Object.entries(args ?? {})) values[`arg.${name}`] = value;
  return values;
}
