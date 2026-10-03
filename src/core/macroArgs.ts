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
 */
export const MACRO_ARG_LIMITS = { inputs: 16, bytes: 8192, string: 256, number: 1e9 } as const;

export type MacroArgType = "string" | "number" | "boolean" | "token";

export interface MacroArgInput {
  name: string;
  type: MacroArgType;
  required?: boolean;
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
    if (!isObject(field) || Object.keys(field).some((key) => !["name", "type", "required"].includes(key)))
      return "invalid input schema";
    if (typeof field.name !== "string" || !NAME.test(field.name) || names.has(field.name))
      return "invalid input schema";
    if (!["string", "number", "boolean", "token"].includes(String(field.type)))
      return "invalid input schema";
    if (field.required !== undefined && typeof field.required !== "boolean")
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
 * Validate a caller's argument record against the schema. `tokenVisible` is the host's
 * live visibility check — a caller may never name a token they cannot see.
 */
export function validateMacroArgs(
  value: unknown, inputs: readonly MacroArgInput[], tokenVisible: (id: string) => boolean,
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
    if (field.type === "token" &&
        (typeof supplied !== "string" || !DOC_ID.test(supplied) || !tokenVisible(supplied)))
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
  // A token argument is an id; whether it is *visible* is the host's call.
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
 * and a named key that is not declared is an error (never silently dropped).
 */
export function bindMacroArgs(
  inputs: readonly MacroArgInput[], tail: string,
): { ok: true; args: MacroArgs } | { ok: false; error: string } {
  const { named, positional } = splitMacroArgTokens(tail);
  if (named.length === 0 && positional.length === 0) {
    const required = inputs.filter((field) => field.required);
    return required.length > 0
      ? { ok: false, error: `missing ${required.map((field) => field.name).join(", ")}` }
      : { ok: true, args: {} };
  }
  const byName = new Map(inputs.map((field) => [field.name, field] as const));
  const args: MacroArgs = {};
  for (const [key, raw] of named) {
    const field = byName.get(key);
    if (!field) return { ok: false, error: `unknown argument ${key}` };
    const value = coerceMacroArgText(field, raw);
    if (value === null) return { ok: false, error: `invalid ${field.name}` };
    args[field.name] = value;
  }
  if (positional.length > 0) {
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
  const missing = inputs.filter((field) => field.required && args[field.name] === undefined);
  if (missing.length > 0) return { ok: false, error: `missing ${missing.map((field) => field.name).join(", ")}` };
  return { ok: true, args };
}

/** The interpolation context a graph sees: `arg.<name>` for every supplied argument. */
export function macroArgValues(args: MacroArgs | undefined): Record<string, MacroArgValue> {
  const values: Record<string, MacroArgValue> = Object.create(null) as Record<string, MacroArgValue>;
  for (const [name, value] of Object.entries(args ?? {})) values[`arg.${name}`] = value;
  return values;
}
