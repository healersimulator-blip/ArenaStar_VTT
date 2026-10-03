/**
 * MC-01/MC-03 — the `/run <macro name>` chat command: a pure parser plus a
 * name → macro resolver, so the chat line dispatches exactly like the
 * directory and the hotbar (`src/ui/macros/run.ts`). The wire never carries a
 * graph id: an automation macro sends only its own id and the host re-validates
 * it, and an undelivered (unreadable) macro is simply not in the caller's store,
 * so the command cannot widen anyone's reach.
 */
import type { MacroDocument } from "./documents";

/** Command words, case-insensitive: `/run` and its `/macro` alias. */
export const MACRO_COMMAND_WORDS = ["run", "macro"] as const;

/** Shown for a bare command (no name) — the discoverable usage line. */
export const MACRO_COMMAND_USAGE = "usage: /run <macro name>";

export interface MacroCommand {
  /** The requested macro name, unquoted; empty for a bare command. */
  name: string;
  /** MC-02 (D-387): the argument tail as typed — named `key=value` pairs and positional
   * words, bound to the macro's declared inputs by `bindMacroArgs`. */
  tail: string;
}

/**
 * Parse a chat line as a macro command. Returns `null` for anything that is not
 * `/run` / `/macro`, so ordinary speech (and `/roll`, `/w`, …) is untouched.
 * A bare command returns an empty name so the caller can print the usage line.
 */
export function parseMacroCommand(input: string): MacroCommand | null {
  const match = /^\/(\w+)\s*([\s\S]*)$/.exec(input.trim());
  if (!match) return null;
  const word = (match[1] ?? "").toLowerCase();
  if (!(MACRO_COMMAND_WORDS as readonly string[]).includes(word)) return null;
  const rest = (match[2] ?? "").trim();
  // A quoted name keeps its surrounding spaces; an argument tail follows the name.
  const quoted = /^(["'])([\s\S]*?)\1\s*([\s\S]*)$/.exec(rest);
  if (quoted) return { name: (quoted[2] ?? "").trim(), tail: (quoted[3] ?? "").trim() };
  // Unquoted: the name runs up to the first `key=value` token, so `Name rounds=2` works
  // without quoting the name.
  const firstArg = rest.search(/(?:^|\s)[A-Za-z][A-Za-z0-9_]*=/);
  if (firstArg > 0) {
    const name = rest.slice(0, firstArg).trim();
    return { name, tail: rest.slice(firstArg).trim() };
  }
  return { name: rest, tail: "" };
}

/**
 * Resolve a typed name against the macros this caller actually received.
 * Exact (`_id`-ordered) first, then a case-insensitive match when it is unique —
 * an ambiguous name resolves to nothing rather than to an arbitrary macro.
 */
export function resolveMacroByName(
  macros: readonly MacroDocument[],
  name: string,
): MacroDocument | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const ordered = [...macros].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  const exact = ordered.find((macro) => macro.name === wanted);
  if (exact) return exact;
  const folded = wanted.toLowerCase();
  const matches = ordered.filter((macro) => macro.name.toLowerCase() === folded);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
