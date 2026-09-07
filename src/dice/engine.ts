/**
 * §11 Dice: Foundry-compatible formula grammar and evaluator.
 *
 *   keep/drop kh/kl/dh/dl · exploding x/xo · rerolls r/ro · min/max ·
 *   success counting cs/cf · math functions · @path substitution from
 *   rollData · parentheses · dice pools.
 *
 * ALL randomness flows through the injected RngFn (host crypto for chat rolls,
 * seeded PRNG inside the SimWorker for bulk resolution, §11). The evaluator is
 * pure and deterministic for a given (formula, rollData, rng sequence).
 *
 * Modifier evaluation order and edge semantics: D-024.
 */
import type { Json } from "../core/documents";
import { type OkOrErr, type Result, err, ok, okVal } from "../core/result";

export type RngFn = () => number; // uniform in [0, 1)

export interface RollEvaluation {
  formula: string;
  total: number;
  /** Dice/function terms for roll cards (§10) and TurnReport summaries. */
  terms: Json[];
}

const MAX_FORMULA_LENGTH = 500;
const MAX_DICE_PER_TERM = 1000;
const MAX_DICE_PER_FORMULA = 10_000;

// ─── @path substitution ───────────────────────────────────────────────────────

const AT_PATH = /@([A-Za-z_][A-Za-z0-9_.]*)/g;

function lookupPath(data: Record<string, Json>, path: string): Result<Json> {
  let cursor: Json = data;
  for (const seg of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return err(`@${path}: segment '${seg}' traverses a non-object`);
    }
    const next: Json | undefined = (cursor as Record<string, Json>)[seg];
    if (next === undefined) return err(`@${path}: '${seg}' not found in rollData`);
    cursor = next;
  }
  return okVal(cursor);
}

function substituteValue(value: Json, path: string): Result<string> {
  if (typeof value === "number") return okVal(String(value));
  if (typeof value === "boolean") return okVal(value ? "1" : "0");
  if (typeof value === "string") {
    if (/^-?\d+(\.\d+)?$/.test(value.trim())) return okVal(value.trim());
    return err(`@${path}: string '${value}' is not numeric`);
  }
  return err(`@${path}: unsupported value type`);
}

/** Replace `@dotted.path` tokens with values from `rollData` (§11). */
export function substituteData(formula: string, data: Record<string, Json>): Result<string> {
  let out = "";
  let lastIndex = 0;
  for (const match of formula.matchAll(AT_PATH)) {
    const index = match.index ?? 0;
    const path = match[1] as string;
    const value = lookupPath(data, path);
    if (!value.ok) return value;
    const replaced = substituteValue(value.value, path);
    if (!replaced.ok) return replaced;
    out += formula.slice(lastIndex, index) + replaced.value;
    lastIndex = index + match[0].length;
  }
  return okVal(out + formula.slice(lastIndex));
}

// ─── AST ──────────────────────────────────────────────────────────────────────

type Comparator = ">" | ">=" | "<" | "<=" | "=";

interface MatchArg {
  cmp: Comparator;
  value: number;
}

type Mod =
  | { op: "kh" | "kl" | "dh" | "dl"; n: number }
  | { op: "x" }
  | { op: "xo" }
  | { op: "r"; match: MatchArg }
  | { op: "ro"; match: MatchArg }
  | { op: "min"; n: number }
  | { op: "max"; n: number }
  | { op: "cs"; match: MatchArg }
  | { op: "cf"; match: MatchArg };

type Node =
  | { t: "num"; v: number }
  | { t: "data"; path: string }
  | { t: "dice"; count: number; sides: number; mods: Mod[]; expr: string }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; l: Node; r: Node }
  | { t: "neg"; e: Node }
  | { t: "fn"; name: string; args: Node[] };

const MOD_NAMES = new Set(["kh", "kl", "dh", "dl", "x", "xo", "r", "ro", "min", "max", "cs", "cf"]);
const FN_NAMES = new Set(["floor", "ceil", "round", "abs", "sqrt", "min", "max", "pow"]);

class Parser {
  private pos = 0;
  private diceCount = 0;

  constructor(private readonly src: string) {}

  parse(): Result<Node> {
    const node = this.parseExpr();
    if (!node.ok) return node;
    this.skipWs();
    if (this.pos < this.src.length) {
      return err(`unexpected '${this.src[this.pos]}' at ${this.pos}`);
    }
    if (this.diceCount > MAX_DICE_PER_FORMULA) {
      return err(`too many dice (max ${MAX_DICE_PER_FORMULA})`);
    }
    return node;
  }

  private skipWs(): void {
    while (this.pos < this.src.length && this.src[this.pos] === " ") this.pos++;
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private readNumber(): number | null {
    const start = this.pos;
    while (this.pos < this.src.length && /\d/.test(this.src[this.pos] ?? "")) this.pos++;
    if (this.peek() === "." && /\d/.test(this.src[this.pos + 1] ?? "")) {
      this.pos++;
      while (this.pos < this.src.length && /\d/.test(this.src[this.pos] ?? "")) this.pos++;
    }
    if (this.pos === start) return null;
    return Number(this.src.slice(start, this.pos));
  }

  private readIdent(): string | null {
    const start = this.pos;
    while (this.pos < this.src.length && /[a-zA-Z]/.test(this.src[this.pos] ?? "")) this.pos++;
    if (this.pos === start) return null;
    return this.src.slice(start, this.pos);
  }

  private parseExpr(): Result<Node> {
    let left = this.parseTerm();
    if (!left.ok) return left;
    for (;;) {
      this.skipWs();
      const op = this.peek();
      if (op !== "+" && op !== "-") break;
      this.pos++;
      const right = this.parseTerm();
      if (!right.ok) return right;
      left = okVal({ t: "bin", op, l: left.value, r: right.value });
    }
    return left;
  }

  private parseTerm(): Result<Node> {
    let left = this.parseUnary();
    if (!left.ok) return left;
    for (;;) {
      this.skipWs();
      const op = this.peek();
      if (op !== "*" && op !== "/") break;
      this.pos++;
      const right = this.parseUnary();
      if (!right.ok) return right;
      left = okVal({ t: "bin", op, l: left.value, r: right.value });
    }
    return left;
  }

  private parseUnary(): Result<Node> {
    this.skipWs();
    if (this.peek() === "-") {
      this.pos++;
      const inner = this.parseUnary();
      if (!inner.ok) return inner;
      return okVal({ t: "neg", e: inner.value });
    }
    return this.parseAtom();
  }

  private parseAtom(): Result<Node> {
    this.skipWs();
    const ch = this.peek();
    if (ch === "") return err("unexpected end of formula");

    if (ch === "(") {
      this.pos++;
      const inner = this.parseExpr();
      if (!inner.ok) return inner;
      this.skipWs();
      if (this.peek() !== ")") return err("expected ')'");
      this.pos++;
      return inner;
    }

    if (ch === "@") {
      // §11 data node: @dotted.path resolves from rollData at EVAL time so a
      // formula parses ONCE and evaluates for many rows (bulk sim dice).
      this.pos++;
      const start = this.pos;
      if (!/[a-zA-Z_]/.test(this.peek())) return err("expected identifier after '@'");
      this.pos++;
      while (this.pos < this.src.length && /[a-zA-Z0-9_.]/.test(this.src[this.pos] ?? "")) {
        this.pos++;
      }
      return okVal({ t: "data", path: this.src.slice(start, this.pos) });
    }

    const numStart = this.pos;
    const number = this.readNumber();
    if (number !== null) {
      // `<number>d<sides>` → dice term with explicit count.
      if (this.peek() === "d") {
        const count = Math.trunc(number);
        if (!Number.isInteger(number) || count < 0) return err(`invalid dice count ${number}`);
        return this.parseDice(count, numStart);
      }
      return okVal({ t: "num", v: number });
    }

    const ident = this.readIdent();
    if (ident !== null) {
      if (ident === "d") return this.parseDice(1, this.pos - 1, true);
      this.skipWs();
      if (this.peek() === "(") {
        if (!FN_NAMES.has(ident)) return err(`unknown function '${ident}'`);
        this.pos++;
        const args: Node[] = [];
        this.skipWs();
        if (this.peek() === ")") {
          this.pos++;
          return okVal({ t: "fn", name: ident, args });
        }
        for (;;) {
          const arg = this.parseExpr();
          if (!arg.ok) return arg;
          args.push(arg.value);
          this.skipWs();
          if (this.peek() === ",") {
            this.pos++;
            continue;
          }
          if (this.peek() === ")") {
            this.pos++;
            break;
          }
          return err(`expected ',' or ')' in ${ident}(...)`);
        }
        return okVal({ t: "fn", name: ident, args });
      }
      return err(`unexpected identifier '${ident}'`);
    }

    return err(`unexpected '${ch}' at ${this.pos}`);
  }

  private parseDice(count: number, exprStart: number, dAlreadyConsumed = false): Result<Node> {
    if (!dAlreadyConsumed) this.pos++; // consume 'd'
    const sides = this.readNumber();
    if (sides === null) return err("dice require a number of sides");
    if (!Number.isInteger(sides) || sides < 1) return err(`invalid sides ${sides}`);
    if (count > MAX_DICE_PER_TERM)
      return err(`too many dice in one term (max ${MAX_DICE_PER_TERM})`);
    this.diceCount += count;
    const mods: Mod[] = [];
    for (;;) {
      const save = this.pos;
      this.skipWs();
      const ident = this.readIdent();
      if (ident === null || !MOD_NAMES.has(ident)) {
        this.pos = save;
        break;
      }
      // `min(`/`max(` after a dice term is a math function, not a modifier.
      if (
        (ident === "min" || ident === "max") &&
        (() => {
          this.skipWs();
          return this.peek() === "(";
        })()
      ) {
        this.pos = save;
        break;
      }
      if (ident === "kh" || ident === "kl" || ident === "dh" || ident === "dl") {
        const n = this.readNumber();
        mods.push({ op: ident, n: n === null ? 1 : Math.trunc(n) });
        continue;
      }
      if (ident === "x" || ident === "xo") {
        if (sides < 2) return err("cannot explode a 1-sided die");
        mods.push({ op: ident });
        continue;
      }
      if (ident === "r" || ident === "ro") {
        const match = this.parseMatchArg();
        if (!match.ok) return match;
        if (!match.value) return err(`'${ident}' requires a match argument`);
        mods.push({ op: ident, match: match.value });
        continue;
      }
      if (ident === "min" || ident === "max") {
        const n = this.readNumber();
        if (n === null) return err(`'${ident}' requires a number`);
        mods.push({ op: ident, n });
        continue;
      }
      // cs / cf
      const match = this.parseMatchArg();
      if (!match.ok) return match;
      if (!match.value) return err(`'${ident}' requires a match argument`);
      mods.push({ op: ident as "cs" | "cf", match: match.value });
    }
    return okVal({
      t: "dice",
      count,
      sides: Math.trunc(sides),
      mods,
      expr: this.src.slice(exprStart, this.pos).replace(/\s+/g, ""),
    });
  }

  private parseMatchArg(): Result<MatchArg | null> {
    this.skipWs();
    let cmp: Comparator = "=";
    const two = this.src.slice(this.pos, this.pos + 2);
    if (two === ">=" || two === "<=") {
      cmp = two;
      this.pos += 2;
    } else if (this.peek() === ">" || this.peek() === "<" || this.peek() === "=") {
      cmp = this.peek() as Comparator;
      this.pos += 1;
    }
    const n = this.readNumber();
    if (n === null) {
      return cmp === "=" ? okVal(null) : err(`comparator '${cmp}' requires a number`);
    }
    return okVal({ cmp, value: n });
  }
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

function matches(value: number, match: MatchArg): boolean {
  switch (match.cmp) {
    case ">":
      return value > match.value;
    case ">=":
      return value >= match.value;
    case "<":
      return value < match.value;
    case "<=":
      return value <= match.value;
    case "=":
      return value === match.value;
  }
}

interface DiceEval {
  total: number;
  rolls: number[];
  kept: number[];
}

function evalDiceTerm(node: Extract<Node, { t: "dice" }>, rng: RngFn): Result<DiceEval> {
  const { count, sides, mods } = node;
  const roll = (): number => 1 + Math.floor(rng() * sides);
  let rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(roll());
  const original = [...rolls];

  for (const mod of mods) {
    switch (mod.op) {
      case "x":
      case "xo": {
        const out: number[] = [];
        for (const v of rolls) {
          out.push(v);
          if (v === sides) {
            let nv = roll();
            out.push(nv);
            if (mod.op === "x") {
              let guard = 0;
              while (nv === sides && guard++ < 100) {
                nv = roll();
                out.push(nv);
              }
            }
          }
        }
        rolls = out;
        break;
      }
      case "r":
        rolls = rolls.map((v) => (matches(v, mod.match) ? roll() : v));
        break;
      case "ro": {
        const idx = rolls.findIndex((v) => matches(v, mod.match));
        if (idx >= 0) rolls[idx] = roll();
        break;
      }
      case "min":
        rolls = rolls.map((v) => Math.max(v, mod.n));
        break;
      case "max":
        rolls = rolls.map((v) => Math.min(v, mod.n));
        break;
      case "kh":
      case "kl":
      case "dh":
      case "dl": {
        const n = mod.n;
        if (n < 0 || n >= rolls.length)
          return err(`'${mod.op}${n}' out of range for ${rolls.length} dice`);
        const sorted = [...rolls].sort((a, b) => b - a); // descending
        let kept: number[];
        if (mod.op === "kh") kept = sorted.slice(0, n);
        else if (mod.op === "kl") kept = sorted.slice(rolls.length - n);
        else if (mod.op === "dh") kept = sorted.slice(n);
        else kept = sorted.slice(0, rolls.length - n);
        rolls = kept;
        break;
      }
      case "cs":
      case "cf":
        break; // applied after keep/drop, below
    }
  }

  const successes = mods.some((m) => m.op === "cs")
    ? rolls.filter((v) =>
        matches(v, (mods.find((m) => m.op === "cs") as Extract<Mod, { op: "cs" }>).match),
      ).length
    : 0;
  const failures = mods.some((m) => m.op === "cf")
    ? rolls.filter((v) =>
        matches(v, (mods.find((m) => m.op === "cf") as Extract<Mod, { op: "cf" }>).match),
      ).length
    : 0;

  let total: number;
  if (successes > 0 || failures > 0) {
    total = successes > 0 ? successes - failures : failures; // D-024
  } else {
    total = rolls.reduce((sum, v) => sum + v, 0);
  }
  return okVal({ total, rolls: original, kept: rolls });
}

function evalNode(
  node: Node,
  rng: RngFn,
  terms: Json[],
  data?: Record<string, Json>,
): Result<number> {
  switch (node.t) {
    case "num":
      return okVal(node.v);
    case "data": {
      if (data === undefined) return err(`@${node.path}: no rollData`);
      const value = lookupPath(data, node.path);
      if (!value.ok) return value;
      const numeric = substituteValue(value.value, node.path);
      return numeric.ok ? okVal(Number(numeric.value)) : numeric;
    }
    case "neg": {
      const v = evalNode(node.e, rng, terms, data);
      return v.ok ? okVal(-v.value) : v;
    }
    case "bin": {
      const l = evalNode(node.l, rng, terms, data);
      if (!l.ok) return l;
      const r = evalNode(node.r, rng, terms, data);
      if (!r.ok) return r;
      switch (node.op) {
        case "+":
          return okVal(l.value + r.value);
        case "-":
          return okVal(l.value - r.value);
        case "*":
          return okVal(l.value * r.value);
        case "/":
          if (r.value === 0) return err("division by zero");
          return okVal(l.value / r.value);
      }
      return err("unreachable");
    }
    case "fn": {
      const args: number[] = [];
      for (const arg of node.args) {
        const v = evalNode(arg, rng, terms, data);
        if (!v.ok) return v;
        args.push(v.value);
      }
      if (args.length === 0) return err(`${node.name}() requires arguments`);
      let value: number;
      switch (node.name) {
        case "floor":
          value = Math.floor(args[0] as number);
          break;
        case "ceil":
          value = Math.ceil(args[0] as number);
          break;
        case "round":
          value = Math.round(args[0] as number);
          break;
        case "abs":
          value = Math.abs(args[0] as number);
          break;
        case "sqrt":
          if ((args[0] as number) < 0) return err("sqrt of negative");
          value = Math.sqrt(args[0] as number);
          break;
        case "min":
          value = Math.min(...args);
          break;
        case "max":
          value = Math.max(...args);
          break;
        case "pow":
          value = Math.pow(args[0] as number, args[1] as number);
          break;
        default:
          return err(`unknown function '${node.name}'`);
      }
      terms.push({ kind: "fn", name: node.name, args });
      return okVal(value);
    }
    case "dice": {
      const res = evalDiceTerm(node, rng);
      if (!res.ok) return res;
      terms.push({
        kind: "dice",
        expr: node.expr,
        rolls: res.value.rolls,
        kept: res.value.kept,
        total: res.value.total,
      });
      return okVal(res.value.total);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Parse-check a formula (no evaluation, no rng). @paths are replaced with a
 * dummy 1 so formulas referencing rollData still parse-check (§11). */
export function validateFormula(formula: string): OkOrErr {
  if (formula.trim().length === 0) return err("empty formula");
  if (formula.length > MAX_FORMULA_LENGTH)
    return err(`formula too long (max ${MAX_FORMULA_LENGTH} chars)`);
  const parsed = new Parser(formula).parse(); // @paths parse natively (§11)
  return parsed.ok ? ok : { ok: false, error: parsed.error };
}

/** Substitute @paths, parse and evaluate with the injected rng (§11). */
export function evaluateFormula(
  formula: string,
  data?: Record<string, Json>,
  rng: RngFn = Math.random,
): Result<RollEvaluation> {
  if (formula.trim().length === 0) return err("empty formula");
  if (formula.length > MAX_FORMULA_LENGTH)
    return err(`formula too long (max ${MAX_FORMULA_LENGTH} chars)`);

  const parsed = new Parser(formula).parse();
  if (!parsed.ok) return parsed;

  const terms: Json[] = [];
  const total = evalNode(parsed.value, rng, terms, data);
  if (!total.ok) return total;
  if (!Number.isFinite(total.value)) return err("result is not finite");
  return okVal({ formula, total: total.value, terms });
}

/**
 * §11 bulk path: parse ONCE, evaluate many times (per model / per unit) with
 * varying rollData and the caller's rng — the compile cache lives one level
 * up in dice/bulk.ts (per formula per turn).
 */
export interface CompiledFormula {
  readonly formula: string;
  evaluate(data?: Record<string, Json>, rng?: RngFn): Result<RollEvaluation>;
}

export function compileFormula(formula: string): Result<CompiledFormula> {
  if (formula.trim().length === 0) return err("empty formula");
  if (formula.length > MAX_FORMULA_LENGTH)
    return err(`formula too long (max ${MAX_FORMULA_LENGTH} chars)`);
  const parsed = new Parser(formula).parse();
  if (!parsed.ok) return parsed;
  return okVal({
    formula,
    evaluate(data?: Record<string, Json>, rng: RngFn = Math.random) {
      const terms: Json[] = [];
      const total = evalNode(parsed.value, rng, terms, data);
      if (!total.ok) return total;
      if (!Number.isFinite(total.value)) return err("result is not finite");
      return okVal({ formula, total: total.value, terms });
    },
  });
}
