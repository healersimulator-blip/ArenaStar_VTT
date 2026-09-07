/**
 * §10 chat — pure command parsing and message construction. Inline
 * `[[formula]]` rolls are evaluated up-front and rewritten to the
 * `[[total|formula]]` chip format the chat renderer understands (evaluation
 * happens host/client-side with an injected rng, §11).
 */
import type { MessageDocument } from "./documents";
import type { UserId } from "./ids";
import type { OwnershipLevel } from "./documents";
import { evaluateFormula, type RngFn } from "../dice/engine";

export type ChatCommandKind =
  "say" | "emote" | "roll" | "gmroll" | "blindroll" | "selfroll" | "whisper" | "ooc";

export interface ParsedCommand {
  kind: ChatCommandKind;
  /** Remaining text after the command word (whisper targets stripped). */
  text: string;
  /** /w <name> [<name>…]: resolved user ids (caller resolves names → ids). */
  whisperTo: string[];
  /** Raw target tokens as typed (for "unknown user" feedback). */
  whisperNames: string[];
  /** Formula for roll commands (text after the command, inline rolls kept). */
  formula: string;
}

const ROLL_KINDS = new Set<RollCommand>(["roll", "gmroll", "blindroll", "selfroll"]);
type RollCommand = "roll" | "gmroll" | "blindroll" | "selfroll";

/** Parse a chat input line into a command (default: say). */
export function parseChatCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  const slash = /^\/(\w+)\s*([\s\S]*)$/.exec(trimmed);
  if (!slash) return { kind: "say", text: trimmed, whisperTo: [], whisperNames: [], formula: "" };
  const word = (slash[1] ?? "").toLowerCase();
  const rest = (slash[2] ?? "").trim();
  if (ROLL_KINDS.has(word as RollCommand)) {
    return {
      kind: word as RollCommand,
      text: rest,
      whisperTo: [],
      whisperNames: [],
      formula: rest,
    };
  }
  if (word === "emote" || word === "me") {
    return { kind: "emote", text: rest, whisperTo: [], whisperNames: [], formula: "" };
  }
  if (word === "ooc") {
    return { kind: "ooc", text: rest, whisperTo: [], whisperNames: [], formula: "" };
  }
  if (word === "w" || word === "whisper") {
    // /w <name[,name…]> <message…> — first token names recipients (comma
    // separated for multiples), the rest is the message (D-077).
    const tokens = rest.split(/\s+/).filter(Boolean);
    const first = tokens[0] ?? "";
    const names = first
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    return {
      kind: "whisper",
      text: tokens.slice(1).join(" "),
      whisperTo: [],
      whisperNames: names,
      formula: "",
    };
  }
  // Unknown slash command — treat the whole line as speech (Foundry echoes).
  return { kind: "say", text: trimmed, whisperTo: [], whisperNames: [], formula: "" };
}

export interface InlineRollOutcome {
  /** Text with `[[formula]]` replaced by `[[total|formula]]` chips. */
  content: string;
  /** Rolls in order of appearance (message.roll uses the FIRST). */
  rolls: Array<{ formula: string; total: number; terms: unknown[] }>;
  /** Formulas that failed to evaluate (kept verbatim in content). */
  errors: string[];
}

const INLINE = /\[\[([^[\]]{1,160})\]\]/g;

/** Evaluate every `[[formula]]` in text against the dice engine. */
export function evaluateInlineRolls(text: string, rng: RngFn = Math.random): InlineRollOutcome {
  const rolls: InlineRollOutcome["rolls"] = [];
  const errors: string[] = [];
  const content = text.replace(INLINE, (whole, formula: string) => {
    const result = evaluateFormula(formula.trim(), undefined, rng);
    if (!result.ok) {
      errors.push(formula.trim());
      return whole;
    }
    const { total, terms } = result.value;
    rolls.push({ formula: formula.trim(), total, terms });
    return `[[${round2(total)}|${formula.trim()}]]`;
  });
  return { content, rolls, errors };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface BuildMessageInput {
  author: UserId;
  parsed: ParsedCommand;
  /** Whisper name → user id resolution (empty → unresolved, kept as name). */
  resolveUser?: (name: string) => UserId | null;
  rng?: RngFn;
  now?: () => string;
}

/** Build the message document for a parsed command (pure). */
export function buildChatMessage(input: BuildMessageInput): {
  message: MessageDocument;
  errors: string[];
} {
  const { author, parsed } = input;
  const rng = input.rng ?? Math.random;
  const errors: string[] = [];
  let whisper: string[] = [];
  if (parsed.kind === "whisper") {
    whisper = parsed.whisperNames.map((n) => input.resolveUser?.(n) ?? "");
    if (whisper.some((id) => !id)) errors.push("unknown whisper recipient");
  }
  const base = {
    _id: cryptoUuid(),
    type: "message" as const,
    name: "message",
    ownership: { default: 1 as OwnershipLevel },
    flags: {},
    system: {},
    author,
    whisper,
    flavor: "",
  };

  switch (parsed.kind) {
    case "say":
    case "ooc":
      return {
        message: {
          ...base,
          content: parsed.text,
          roll: null,
          flavor: parsed.kind === "ooc" ? "ooc" : "",
        },
        errors,
      };
    case "emote":
      return { message: { ...base, content: parsed.text, roll: null, flavor: "emote" }, errors };
    case "whisper":
      return { message: { ...base, content: parsed.text, roll: null, flavor: "whisper" }, errors };
    case "roll":
    case "gmroll":
    case "blindroll":
    case "selfroll": {
      // The whole argument is the formula (D-077): /roll 1d20+5.
      const evaluated = evaluateFormula(parsed.formula, undefined, rng);
      if (!evaluated.ok) {
        errors.push(parsed.formula);
        return { message: { ...base, content: parsed.text, roll: null, flavor: "roll" }, errors };
      }
      const { total, terms } = evaluated.value;
      const roll = {
        formula: parsed.formula,
        total,
        terms,
        seedClient: null,
        seedHost: null,
      };
      return {
        message: {
          ...base,
          content: `[[${round2(total)}|${parsed.formula}]]`,
          roll,
          rollMode: parsed.kind,
          flavor: "roll",
        },
        errors,
      };
    }
  }
}

/** Browser/node-safe uuid (crypto.randomUUID with fallback). */
function cryptoUuid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return "m-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
