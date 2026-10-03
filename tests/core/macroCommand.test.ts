import { describe, expect, test } from "vitest";
import {
  MACRO_COMMAND_USAGE,
  MACRO_COMMAND_WORDS,
  parseMacroCommand,
  resolveMacroByName,
} from "../../src/core/macroCommand";
import type { MacroDocument } from "../../src/core/documents";

function macro(id: string, name: string, kind: MacroDocument["kind"] = "chat"): MacroDocument {
  return {
    _id: id,
    type: "macro",
    name,
    ownership: { default: 1 },
    flags: {},
    system: {},
    kind,
    command: "hello",
  } as MacroDocument;
}

const MACROS = [
  macro("m-bell", "Courtyard bell", "automation"),
  macro("m-bell-2", "courtyard BELL"),
  macro("m-heal", "Cure light wounds"),
];

describe("the /run chat command (MC-01/MC-03)", () => {
  test("the two command words are the only entry points", () => {
    expect([...MACRO_COMMAND_WORDS]).toEqual(["run", "macro"]);
    expect(MACRO_COMMAND_USAGE).toBe("usage: /run <macro name>");
  });

  test("a name parses with its surrounding space and case-insensitive word", () => {
    expect(parseMacroCommand("/run Courtyard bell")).toEqual({ name: "Courtyard bell", tail: "" });
    expect(parseMacroCommand("  /RUN   Courtyard bell  ")).toEqual({ name: "Courtyard bell", tail: "" });
    expect(parseMacroCommand("/macro Cure light wounds")).toEqual({ name: "Cure light wounds", tail: "" });
    expect(parseMacroCommand("/Run  spaced   name ")).toEqual({ name: "spaced   name", tail: "" });
  });

  test("MC-02: an argument tail follows the name, named or positional", () => {
    // A `key=value` token ends the name even without quotes.
    expect(parseMacroCommand("/run Courtyard bell rounds=2"))
      .toEqual({ name: "Courtyard bell", tail: "rounds=2" });
    expect(parseMacroCommand('/run "Courtyard bell" rounds=2 label="open now"'))
      .toEqual({ name: "Courtyard bell", tail: 'rounds=2 label="open now"' });
    // All-positional tails keep their words; a quoted name is the only way to tell them apart.
    expect(parseMacroCommand('/run "Courtyard bell" 2 loud')).toEqual({ name: "Courtyard bell", tail: "2 loud" });
    expect(parseMacroCommand("/run Courtyard bell")).toEqual({ name: "Courtyard bell", tail: "" });
    expect(parseMacroCommand("'/run'")).toBeNull();
  });

  test("quotes let a name carry deliberate edge spaces", () => {
    expect(parseMacroCommand('/run "Courtyard bell"')).toEqual({ name: "Courtyard bell", tail: "" });
    expect(parseMacroCommand("/run '  padded  '")).toEqual({ name: "padded", tail: "" });
    // A mismatched pair is not a quote pair — it stays literal text.
    expect(parseMacroCommand('/run "Courtyard bell')).toEqual({ name: '"Courtyard bell', tail: "" });
  });

  test("a bare command parses with an empty name so the caller can print usage", () => {
    expect(parseMacroCommand("/run")).toEqual({ name: "", tail: "" });
    expect(parseMacroCommand("/macro   ")).toEqual({ name: "", tail: "" });
  });

  test("everything else is not a macro command", () => {
    for (const line of [
      "hello table",
      "/roll 1d20+5",
      "/gmroll 1d20",
      "/w Ann hello",
      "/runner Courtyard bell",
      "/runx",
      "say /run Courtyard bell",
      "",
      "   ",
    ]) {
      expect(parseMacroCommand(line), line).toBeNull();
    }
  });
});

describe("resolving a typed macro name (MC-01)", () => {
  test("an exact name wins over a different-case sibling", () => {
    expect(resolveMacroByName(MACROS, "Courtyard bell")?._id).toBe("m-bell");
    expect(resolveMacroByName(MACROS, "courtyard BELL")?._id).toBe("m-bell-2");
  });

  test("a case-insensitive match resolves when it is unique", () => {
    expect(resolveMacroByName(MACROS, "CURE LIGHT WOUNDS")?._id).toBe("m-heal");
    expect(resolveMacroByName(MACROS, "courtyard  bell")).toBeNull(); // inner spacing is literal
  });

  test("an ambiguous folded name resolves to nothing rather than a coin flip", () => {
    const ambiguous = [macro("m-a", "Bell"), macro("m-b", "BELL")];
    expect(resolveMacroByName(ambiguous, "bell")).toBeNull();
    expect(resolveMacroByName(ambiguous, "Bell")?._id).toBe("m-a");
  });

  test("a missing or empty name resolves to nothing", () => {
    expect(resolveMacroByName(MACROS, "")).toBeNull();
    expect(resolveMacroByName(MACROS, "   ")).toBeNull();
    expect(resolveMacroByName(MACROS, "Gate bell")).toBeNull();
    expect(resolveMacroByName([], "Courtyard bell")).toBeNull();
  });

  test("resolution never mutates the caller's list", () => {
    const macros = [macro("m-2", "B"), macro("m-1", "A")];
    resolveMacroByName(macros, "a");
    expect(macros.map((m) => m._id)).toEqual(["m-2", "m-1"]);
  });
});
