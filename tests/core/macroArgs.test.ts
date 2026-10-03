/**
 * MC-02 (D-387) — typed invocation arguments. The schema is *callable metadata* (a player
 * needs it to call the macro correctly), while the graph binding beside it is not; and the
 * host accepts only declared keys, each with its declared type and bound, so arguments can
 * never push arbitrary data into a graph's interpolation context.
 */
import { describe, expect, test } from "vitest";
import {
  MACRO_ARG_LIMITS,
  bindMacroArgs,
  coerceMacroArgText,
  macroArgInputs,
  macroArgSchemaError,
  macroArgValues,
  splitMacroArgTokens,
  validateMacroArgs,
  type MacroArgInput,
} from "../../src/core/macroArgs";

const schema: MacroArgInput[] = [
  { name: "rounds", type: "number", required: true },
  { name: "label", type: "string" },
  { name: "loud", type: "boolean" },
  { name: "target", type: "token" },
];

/** Both validators return `{ok:false, error}`; read the message without coupling to shape. */
function errorOf(result: { ok: true } | { ok: false; error: string }): string {
  return result.ok ? "" : result.error;
}

const visible = () => true;
const hidden = () => false;

describe("macro argument schema (MC-02)", () => {
  test("a schema is a bounded list of named, typed, optional-required fields", () => {
    expect(macroArgSchemaError(undefined)).toBeNull();
    expect(macroArgSchemaError(schema)).toBeNull();
    expect(macroArgSchemaError([{ name: "a", type: "string", required: false }])).toBeNull();
    expect(macroArgSchemaError([])).toBeNull();
    expect(macroArgSchemaError("nope")).toContain("list");
    expect(macroArgSchemaError([{ name: "1bad", type: "string" }])).toContain("invalid input schema");
    expect(macroArgSchemaError([{ name: "a", type: "date" }])).toContain("invalid input schema");
    expect(macroArgSchemaError([{ name: "a", type: "string", extra: 1 }])).toContain("invalid input schema");
    expect(macroArgSchemaError([{ name: "a", type: "string", required: "yes" }])).toContain("invalid input schema");
    expect(macroArgSchemaError([{ name: "a", type: "string" }, { name: "a", type: "number" }]))
      .toContain("invalid input schema");
    expect(macroArgSchemaError(Array.from({ length: 17 }, (_, i) => ({ name: `a${i}`, type: "string" }))))
      .toContain("at most");
    expect(MACRO_ARG_LIMITS).toMatchObject({ inputs: 16, bytes: 8192, string: 256, number: 1e9 });
  });

  test("a malformed import declares nothing, and a validated read is defensive", () => {
    expect(macroArgInputs(schema)).toEqual(schema);
    expect(macroArgInputs(undefined)).toEqual([]);
    expect(macroArgInputs([{ name: "1bad", type: "string" }])).toEqual([]);
    expect(macroArgInputs("nope")).toEqual([]);
  });
});

describe("validating a caller's arguments (MC-02)", () => {
  test("only declared keys, with the declared types and bounds", () => {
    expect(validateMacroArgs({ rounds: 2 }, schema, visible)).toEqual({ ok: true, args: { rounds: 2 } });
    expect(validateMacroArgs({ rounds: 2, label: "hello", loud: true }, schema, visible))
      .toEqual({ ok: true, args: { rounds: 2, label: "hello", loud: true } });
    // An optional input left out is simply absent.
    expect(validateMacroArgs({ rounds: 1 }, schema, visible)).toEqual({ ok: true, args: { rounds: 1 } });
    expect(errorOf(validateMacroArgs(undefined, schema, visible))).toContain("missing rounds");
  });

  test("undeclared keys, wrong types, out-of-range numbers and long strings are refused", () => {
    expect(errorOf(validateMacroArgs({ rounds: 2, extra: 1 }, schema, visible))).toContain("unknown macro argument");
    expect(errorOf(validateMacroArgs({ rounds: "2" }, schema, visible))).toContain("invalid rounds");
    expect(errorOf(validateMacroArgs({ rounds: Number.NaN }, schema, visible))).toContain("invalid rounds");
    expect(errorOf(validateMacroArgs({ rounds: 2e9 }, schema, visible))).toContain("invalid rounds");
    expect(errorOf(validateMacroArgs({ rounds: 2, loud: "yes" }, schema, visible))).toContain("invalid loud");
    expect(errorOf(validateMacroArgs({ rounds: 2, label: "x".repeat(257) }, schema, visible))).toContain("invalid label");
    expect(errorOf(validateMacroArgs({ rounds: 2, label: 5 }, schema, visible))).toContain("invalid label");
    expect(errorOf(validateMacroArgs([1, 2], schema, visible))).toContain("named record");
    expect(errorOf(validateMacroArgs({ rounds: 1, ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 1])) },
      schema, visible))).toContain("too many arguments");
  });

  test("a token argument must be a real id the caller can see", () => {
    expect(validateMacroArgs({ rounds: 1, target: "tok-1" }, schema, visible))
      .toEqual({ ok: true, args: { rounds: 1, target: "tok-1" } });
    expect(errorOf(validateMacroArgs({ rounds: 1, target: "tok-1" }, schema, hidden)))
      .toContain("invalid or invisible target");
    expect(errorOf(validateMacroArgs({ rounds: 1, target: "bad id!" }, schema, visible)))
      .toContain("invalid or invisible target");
  });

  test("the 8 KiB ceiling is measured on the serialized record", () => {
    const big: MacroArgInput[] = [{ name: "label", type: "string", required: true }];
    expect(validateMacroArgs({ label: "x".repeat(256) }, big, visible).ok).toBe(true);
    const many: MacroArgInput[] = Array.from({ length: 16 }, (_, i) => ({ name: `a${i}`, type: "string" }));
    const record = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`a${i}`, `v${i}`]));
    expect(validateMacroArgs(record, many, visible).ok).toBe(true);
  });
});

describe("binding `/run` text onto a schema (MC-02)", () => {
  test("quoted and bare words tokenize, with named pairs separated from positional ones", () => {
    expect(splitMacroArgTokens('rounds=2 label="hello world" tail')).toEqual({
      named: [["rounds", "2"], ["label", "hello world"]], positional: ["tail"],
    });
    expect(splitMacroArgTokens("")).toEqual({ named: [], positional: [] });
    expect(splitMacroArgTokens("3 quiet")).toEqual({ named: [], positional: ["3", "quiet"] });
    // A `key=` token is always named; an unmatched quote stays verbatim in the value.
    expect(splitMacroArgTokens('label="open')).toEqual({ named: [["label", '"open']], positional: [] });
    expect(splitMacroArgTokens("loud=on tail")).toEqual({ named: [["loud", "on"]], positional: ["tail"] });
  });

  test("text coerces to each declared type, or reports null", () => {
    expect(coerceMacroArgText({ name: "n", type: "number" }, " 12 ")).toBe(12);
    expect(coerceMacroArgText({ name: "n", type: "number" }, "twelve")).toBeNull();
    expect(coerceMacroArgText({ name: "n", type: "number" }, "")).toBeNull();
    expect(coerceMacroArgText({ name: "b", type: "boolean" }, "YES")).toBe(true);
    expect(coerceMacroArgText({ name: "b", type: "boolean" }, "0")).toBe(false);
    expect(coerceMacroArgText({ name: "b", type: "boolean" }, "maybe")).toBeNull();
    expect(coerceMacroArgText({ name: "s", type: "string" }, "  hi  ")).toBe("hi");
    expect(coerceMacroArgText({ name: "s", type: "string" }, "x".repeat(257))).toBeNull();
    expect(coerceMacroArgText({ name: "t", type: "token" }, "tok-1")).toBe("tok-1");
    expect(coerceMacroArgText({ name: "t", type: "token" }, "not an id")).toBeNull();
  });

  test("named keys bind by name and positional words fill the remaining inputs in order", () => {
    expect(bindMacroArgs(schema, "rounds=2")).toEqual({ ok: true, args: { rounds: 2 } });
    expect(bindMacroArgs(schema, "2")).toEqual({ ok: true, args: { rounds: 2 } });
    expect(bindMacroArgs(schema, "2 loud=no")).toEqual({ ok: true, args: { rounds: 2, loud: false } });
    expect(bindMacroArgs(schema, "rounds=2 label=x")).toEqual({ ok: true, args: { rounds: 2, label: "x" } });
    // Named values win, so the positional word fills the next free input.
    expect(bindMacroArgs(schema, "rounds=4 quiet")).toEqual({ ok: true, args: { rounds: 4, label: "quiet" } });
    expect(bindMacroArgs([{ name: "s", type: "string" }], "")).toEqual({ ok: true, args: {} });
  });

  test("errors name the offending key rather than silently dropping it", () => {
    expect(errorOf(bindMacroArgs(schema, ""))).toContain("missing rounds");
    expect(errorOf(bindMacroArgs(schema, "nope=1"))).toContain("unknown argument nope");
    expect(errorOf(bindMacroArgs(schema, "rounds=abc"))).toContain("invalid rounds");
    expect(errorOf(bindMacroArgs(schema, "rounds=1 2 3 4 5"))).toContain("too many arguments");
    expect(errorOf(bindMacroArgs([{ name: "a", type: "string", required: true },
      { name: "b", type: "string", required: true }], "x"))).toContain("missing b");
  });

  test("arguments interpolate under an `arg.` namespace no durable variable can occupy", () => {
    expect(macroArgValues({ rounds: 2, label: "open" })).toEqual({ "arg.rounds": 2, "arg.label": "open" });
    expect(macroArgValues(undefined)).toEqual({});
    const values = macroArgValues({ rounds: 2 });
    expect(Object.getPrototypeOf(values)).toBeNull(); // no inherited keys can masquerade
  });
});
