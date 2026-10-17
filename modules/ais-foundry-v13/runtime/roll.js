/* ArenaStar-authored, CSP-safe Foundry dice compatibility. No dynamic code generation. */
(function () {
  "use strict";
  // Recursive-descent arithmetic grammar: bounded, explicit, and CSP-safe.
  const functions = Object.freeze({
    abs: Math.abs,
    ceil: Math.ceil,
    floor: Math.floor,
    round: Math.round,
    trunc: Math.trunc,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
    sqrt: Math.sqrt,
    sign: Math.sign,
  });
  function arithmetic(source, custom = {}) {
    if (typeof source !== "string" || !source.trim() || source.length > 16384)
      throw new Error("Invalid roll expression");
    const tokens =
      source.replace(/\[[^\]]*\]/g, "").match(
        /(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|===|!==|==|!=|>=|<=|&&|\|\||\*\*|[^\s]/gi,
      ) || [];
    let at = 0;
    let depth = 0;
    const peek = () => tokens[at];
    const take = () => tokens[at++];
    const expect = (token) => {
      if (take() !== token)
        throw new Error(`Expected ${token} in roll expression`);
    };
    const primary = () => {
      if (++depth > 128)
        throw new Error("Roll expression nesting limit exceeded");
      try {
        const token = take();
        if (token === "+") return primary();
        if (token === "-") return -primary();
        if (token === "(") {
          const value = conditional();
          expect(")");
          return value;
        }
        if (token && /^(?:\d|\.)/.test(token)) {
          const value = Number(token);
          if (!Number.isFinite(value)) throw new Error("Invalid roll number");
          return value;
        }
        if (token && (Object.hasOwn(functions, token) || Object.hasOwn(custom, token))) {
          expect("(");
          const args = [conditional()];
          while (peek() === ",") {
            take();
            args.push(conditional());
          }
          expect(")");
          const arity =
            token === "pow" ? 2 : token === "min" || token === "max" || Object.hasOwn(custom, token) ? null : 1;
          if (arity !== null && args.length !== arity)
            throw new Error(`Invalid argument count for ${token}`);
          return (custom[token] ?? functions[token])(...args);
        }
        throw new Error(
          `Unsupported roll token: ${token ?? "end of expression"}`,
        );
      } finally {
        depth--;
      }
    };
    const power = () => {
      const left = primary();
      if (peek() !== "**") return left;
      take();
      if (++depth > 128)
        throw new Error("Roll expression nesting limit exceeded");
      try {
        return left ** power();
      } finally {
        depth--;
      }
    };
    const product = () => {
      let value = power();
      while (["*", "/", "%"].includes(peek())) {
        const op = take(),
          right = power();
        value =
          op === "*"
            ? value * right
            : op === "/"
              ? value / right
              : value % right;
      }
      return value;
    };
    const sum = () => {
      let value = product();
      while (peek() === "+" || peek() === "-") {
        const op = take(),
          right = product();
        value = op === "+" ? value + right : value - right;
      }
      return value;
    };
    const comparison = () => {
      let value = sum();
      while (["==", "===", "!=", "!==", ">", ">=", "<", "<="].includes(peek())) {
        const op = take(), right = sum();
        value = Number(op === "==" || op === "===" ? value === right : op === "!=" || op === "!==" ? value !== right : op === ">" ? value > right : op === ">=" ? value >= right : op === "<" ? value < right : value <= right);
      }
      return value;
    };
    const logical = () => { let value = comparison(); while (["&&", "||"].includes(peek())) { const op = take(), right = comparison(); value = Number(op === "&&" ? !!value && !!right : !!value || !!right); } return value; };
    const conditional = () => {
      const value = logical();
      if (peek() !== "?") return value;
      if (++depth > 128) throw new Error("Roll expression nesting limit exceeded");
      take(); const yes = conditional(); expect(":"); const no = conditional(); depth--;
      return value ? yes : no;
    };
    const result = conditional();
    if (at !== tokens.length || !Number.isFinite(result))
      throw new Error("Invalid or non-finite roll result");
    return result;
  }
  globalThis.__aisFoundryRoll = {
    install({ clone, getProperty, postMessage }) {
      class RollTerm {
        constructor(data = {}) { Object.assign(this, data); this.options ??= {}; this._evaluated ??= false; }
        get isDeterministic() { return true; }
        get flavor() { return this.options.flavor ?? ""; }
        evaluate(options = {}) { return this.evaluateSync(options); }
        evaluateSync() { this._evaluated = true; return this; }
        toJSON() { return { ...this, class: this.constructor.name }; }
        static fromData(data) { const Class = termTypes[data.class]; if (!Class) throw new Error(`Unknown roll term ${data.class}`); return new Class(data); }
      }
      class NumericTerm extends RollTerm { get formula() { return String(this.number); } get expression() { return this.formula; } get total() { return this.number; } }
      class OperatorTerm extends RollTerm { get formula() { return this.operator; } get expression() { return this.operator; } get total() { return this.operator; } }
      class StringTerm extends RollTerm { get formula() { return this.term ?? this._expression ?? ""; } get expression() { return this.formula; } }
      class DiceTerm extends RollTerm { get isDeterministic() { return false; } }
      class Die extends DiceTerm {
        constructor(data = {}) { super(data); this.number ??= 1; this.results ??= []; }
        get formula() { return `${this.number}d${this.faces}${(this.modifiers ?? []).join("")}`; }
        get expression() { return this.formula; }
        get total() { return this.results.filter((r) => r.active !== false).reduce((sum, r) => sum + r.result, 0); }
        evaluateSync(options = {}) {
          if (this._evaluated) return this;
          const r = new Roll(this.formula);
          r._evaluationOptions = options;
          this.results = r._parseAndRollDice(this.formula).diceTerms[0]?.results ?? []; this._evaluated = true; return this;
        }
        getTooltipData() { return { formula: this.formula, total: this.total, faces: this.faces, results: this.results }; }
      }
      class ParentheticalTerm extends RollTerm {
        constructor(data = {}) { super(data); this.roll = data.roll ?? new Roll(data.term ?? "0"); }
        get formula() { return `(${this.roll.formula})`; } get expression() { return this.formula; }
        get isDeterministic() { return this.roll.isDeterministic; } get total() { return this.roll.total; }
        evaluateSync(options = {}) { this.roll.evaluateSync(options); this._evaluated = true; return this; }
      }
      class MathTerm extends ParentheticalTerm {
        get formula() { return this.roll.formula; }
        evaluateSync(options = {}) {
          if (this._evaluated) return this;
          this.roll._evaluationOptions = options;
          this.roll._dice = [];
          const { newExpr } = this.roll._parseAndRollDice(this.roll._prepareFormula(this.roll.formula));
          this.roll._total = this.roll._safeEval(newExpr);
          this.roll._evaluated = true; this._evaluated = true; return this;
        }
      }
      class FunctionTerm extends MathTerm {}
      const termTypes = { RollTerm, NumericTerm, OperatorTerm, StringTerm, DiceTerm, Die, ParentheticalTerm, MathTerm, FunctionTerm };
      // ── Roll (independent dice engine, NOT native action card / revert) ──
      class Roll {
        constructor(formula, data = {}, options = {}) {
          this._formula = String(formula ?? "");
          this.data = data && typeof data === "object" ? data : {};
          this.options = options && typeof options === "object" ? options : {};
          this._terms = undefined;
          this._dice = [];
          this._total = undefined;
          this._evaluated = false;
          this._result = null;
        }
        get terms() { return this._terms ??= this.constructor.parse(this._formula, this.data); }
        set terms(value) { this._terms = value; }
        get formula() {
          return this._formula;
        }
        get total() {
          return this._total;
        }
        get dice() {
          return this._dice;
        }
        get result() {
          return this._result;
        }
        get isDeterministic() {
          return !/d\d|d%/i.test(this._formula);
        }
        // Parse without evaluating dice or consuming randomness. Parenthetical and
        // function expressions remain composite terms, preserving their formula.
        static get defaultImplementation() { return globalThis.CONFIG?.Dice?.rolls?.[0] ?? this; }
        static replaceFormulaData(formula, data = {}, { missing = "0" } = {}) {
          return String(formula ?? "").replace(/@([a-zA-Z0-9_.]+)/g, (_match, path) => {
            const value = getProperty(data, path);
            if (value === undefined || value === null) return String(missing);
            if (typeof value === "number" && Number.isFinite(value)) return String(value);
            if (typeof value === "string") return value;
            if (typeof value === "boolean") return String(Number(value));
            return String(missing);
          });
        }
        static parse(formula, data = {}) {
          const roll = new Roll(formula, data);
          const source = roll._prepareFormula(String(formula ?? ""));
          if (!source.trim()) return [];
          if (!this.validate(source)) throw new Error(`Invalid roll expression: ${source.slice(0, 160)}`);
          if (/[?:<>=&|]/.test(source)) return [new MathTerm({ roll: new Roll(source) })];
          const terms = [];
          let at = 0;
          while (at < source.length) {
            if (/\s/.test(source[at])) { at++; continue; }
            const rest = source.slice(at);
            const opening = /^(?:[A-Za-z_][A-Za-z_0-9]*\s*)?\(/.exec(rest);
            let token;
            if (opening) {
              let depth = 1, end = at + opening[0].length;
              while (depth && end < source.length) {
                if (source[end] === "(") depth++;
                else if (source[end] === ")") depth--;
                end++;
              }
              token = source.slice(at, end);
            } else token = /^(?:\d*d(?:\d+|%)(?:[kd][hl]?\d*)?|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\*\*|[+*/%-])/i.exec(rest)?.[0];
            if (!token) throw new Error("Unsupported roll term");
            let term;
            const dice = /^(\d*)d(\d+|%)(.*)$/i.exec(token);
            if (dice) term = new Die({ number: Number(dice[1] || 1), faces: dice[2] === "%" ? 100 : Number(dice[2]), modifiers: dice[3] ? [dice[3]] : [] });
            else if (/^(?:\*\*|[+*/%-])$/.test(token)) term = new OperatorTerm({ operator: token });
            else if (/^(?:\d|\.)/.test(token)) term = new NumericTerm({ number: Number(token) });
            else if (token.startsWith("(")) term = new ParentheticalTerm({ term: token.slice(1, -1) });
            else term = new MathTerm({ roll: new Roll(token) });
            terms.push(term);
            at += token.length;
          }
          return terms;
        }
        static create(formula, data, options) {
          return new this(formula, data, options);
        }
        static getFormula(terms) { return terms.map(term => term.formula ?? String(term)).join(" "); }
        static fromTerms(terms) {
          const formula = terms.map((t) => t.formula ?? String(t)).join("");
          return new this(formula);
        }
        clone() {
          return new this.constructor(this._formula, clone(this.data), clone(this.options));
        }
        toJSON() {
          return {
            formula: this._formula,
            total: this._total,
            evaluated: this._evaluated,
            dice: this._dice,
          };
        }
        toObject() {
          return this.toJSON();
        }
        toString() {
          return this._formula;
        }
        _interpolateData(formula) {
          return formula.replace(/@([a-zA-Z0-9_.]+)/g, (m, path) => {
            try {
              const v = getProperty(this.data, path);
              if (v === undefined || v === null) return "0";
              if (typeof v === "number" && Number.isFinite(v)) return `(${v})`;
              if (typeof v === "string") {
                const n = Number(v);
                return Number.isFinite(n) ? `(${n})` : "0";
              }
              if (
                typeof v === "object" &&
                v !== null &&
                typeof v.value === "number"
              )
                return `(${v.value})`;
              return "0";
            } catch {
              return "0";
            }
          });
        }
        _prepareFormula(formula) {
          let source = this._interpolateData(formula).replace(/\[[^\]]*\]/g, "");
          for (let end = 0; end < source.length; end++) {
            if (source[end] !== ")" || !/^d(?:\d+|%)/i.test(source.slice(end + 1))) continue;
            let start = end - 1, nesting = 1;
            for (; start >= 0; start--) { if (source[start] === ")") nesting++; else if (source[start] === "(" && --nesting === 0) break; }
            if (start < 0) throw new Error("Unbalanced dice count");
            const count = this._safeEval(source.slice(start + 1, end));
            if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error("Dice count/faces exceed supported bounds");
            source = source.slice(0, start) + count + source.slice(end + 1); end = start + String(count).length - 1;
          }
          return source;
        }
        _rollDie(faces) {
          return Math.floor(Math.random() * faces) + 1;
        }
        _parseAndRollDice(expr) {
          if (expr.length > 16384)
            throw new Error("Roll expression is too long");
          const diceTerms = [];
          let diceCount = 0;
          let out = "";
          let lastIndex = 0;
          const diceRe = /(\d*)d(\d+|%)(?:([kK][hHlL]?|[dD][hHlL]?)?(\d+)?)?/g;
          let m;
          while ((m = diceRe.exec(expr)) !== null) {
            out += expr.slice(lastIndex, m.index);
            lastIndex = m.index + m[0].length;
            const numStr = m[1];
            const facesStr = m[2];
            const keepDropOp = (m[3] || "").toLowerCase();
            const keepDropNumStr = m[4];
            const num = numStr ? parseInt(numStr, 10) : 1;
            const faces = facesStr === "%" ? 100 : parseInt(facesStr, 10);
            if (
              !Number.isFinite(num) ||
              num < 0 ||
              num > 1000 ||
              !Number.isFinite(faces) ||
              faces <= 0 ||
              faces > 10000
            ) {
              throw new Error("Dice count/faces exceed supported bounds");
            }
            diceCount += num;
            if (diceCount > 10000) throw new Error("Roll dice budget exceeded");
            const results = [];
            for (let i = 0; i < num; i++) results.push(this._evaluationOptions?.minimize ? 1 : this._evaluationOptions?.maximize ? faces : this._rollDie(faces));
            let kept = [...results];
            if (keepDropOp) {
              const k = keepDropNumStr ? parseInt(keepDropNumStr, 10) : 1;
              if (Number.isFinite(k) && k >= 0) {
                const sorted = [...results].sort((a, b) => a - b);
                if (keepDropOp === "kh" || keepDropOp === "k")
                  kept = k === 0 ? [] : sorted.slice(-k);
                else if (keepDropOp === "kl") kept = sorted.slice(0, k);
                else if (keepDropOp === "dh")
                  kept = sorted.slice(0, Math.max(0, sorted.length - k));
                else if (keepDropOp === "dl") kept = sorted.slice(k);
              }
            }
            const total = kept.reduce((s, v) => s + v, 0);
            const activeCounts = new Map(); for (const value of kept) activeCounts.set(value, (activeCounts.get(value) ?? 0) + 1);
            const termResults = results.map((result) => { const remaining = activeCounts.get(result) ?? 0; activeCounts.set(result, Math.max(0, remaining - 1)); return { result, active: remaining > 0 }; });
            diceTerms.push({
              formula: m[0],
              number: num,
              faces,
              results: termResults,
              kept,
              total,
              expression: String(total),
            });
            this._dice.push(new Die({ faces, number: num, results: termResults, _evaluated: true }));
            out += String(total);
          }
          out += expr.slice(lastIndex);
          return { newExpr: out, diceTerms };
        }
        _safeEval(expr) {
          const custom = Object.fromEntries(Object.entries(globalThis.CONFIG?.Dice?.functions ?? {}).filter(([, fn]) => typeof fn === "function").map(([name, fn]) => [name, (...args) => {
            if (this._validating) return 0;
            const context = { terms: [], rolls: [] };
            const value = fn.apply(context, args);
            return value + context.rolls.reduce((sum, roll) => {
              roll.evaluateSync({ ...this._evaluationOptions, strict: false });
              this._dice.push(...roll.dice);
              return sum + roll.total;
            }, 0);
          }]));
          return arithmetic(expr, custom);
        }
        async evaluate() { return this.evaluateSync({ strict: false }); }
        evaluateSync({ strict = true, minimize = false, maximize = false } = {}) {
          this._evaluationOptions = { minimize, maximize };
          if (strict && !minimize && !maximize && !this.isDeterministic) throw new Error("Synchronous evaluation requires a deterministic Roll");
          if (this._evaluated) return this;
          this._dice = [];
          const interpolated = this._prepareFormula(this._formula);
          // Evaluate the term tree once. Re-evaluating the original expression
          // would roll custom functions and nested dice twice and lose metadata.
          this._terms ??= this.constructor.parse(interpolated);
          let diceCount = 0;
          for (const term of this.terms) {
            term.evaluateSync({ minimize, maximize, strict: false });
            const dice = term instanceof Die ? [term] : term.roll?.dice ?? [];
            this._dice.push(...dice);
            diceCount += dice.reduce((sum, die) => sum + die.number, 0);
            if (diceCount > 10000) throw new Error("Roll dice budget exceeded");
          }
          const newExpr = this.terms.map(term => term instanceof OperatorTerm ? term.operator : `(${term.total})`).join("");
          const total = arithmetic(newExpr);
          this._total = total;
          this._result = newExpr;
          this._evaluated = true;
          return this;
        }
        async roll({ async: isAsync = false } = {}) {
          return this.evaluate({ async: isAsync });
        }
        toAnchor({ classes = [], label } = {}) {
          if (!this._evaluated) throw new Error("Roll must be evaluated before creating an anchor");
          const anchor = document.createElement("a");
          anchor.classList.add("inline-roll", "inline-result", ...classes);
          anchor.dataset.formula = this.formula;
          const bytes = new TextEncoder().encode(JSON.stringify(this.toJSON()));
          let encoded = ""; for (const byte of bytes) encoded += String.fromCharCode(byte);
          anchor.dataset.roll = btoa(encoded);
          anchor.textContent = String(label ?? this.total);
          return anchor;
        }
        async toMessage(messageData = {}, { rollMode, create = true } = {}) {
          void rollMode;
          if (!this._evaluated) await this.evaluate();
          const flavor = messageData.flavor
            ? String(messageData.flavor)
            : this._formula;
          const content = messageData.content
            ? String(messageData.content)
            : `${flavor} = ${this._total}`;
          if (create)
            return postMessage({
              content,
              flavor,
              roll: {
                formula: this._formula,
                total: this._total,
                dice: this._dice,
              },
            });
          return {
            content,
            flavor,
            roll: { formula: this._formula, total: this._total },
          };
        }
        static async fromFormula(formula, data) {
          return new Roll(formula, data).evaluate();
        }
        static validate(formula) {
          if (
            typeof formula !== "string" ||
            !formula.trim() ||
            formula.length > 16384
          )
            return false;
          try {
            const roll = new Roll(formula);
            roll._evaluationOptions = { minimize: true };
            roll._validating = true;
            roll._rollDie = () => 1; // Validate syntax without consuming randomness.
            roll._safeEval(
              roll._parseAndRollDice(roll._prepareFormula(formula)).newExpr,
            );
            return true;
          } catch {
            return false;
          }
        }
        static isDeterministic(formula) {
          try {
            return !/d\d|d%/i.test(String(formula ?? ""));
          } catch {
            return true;
          }
        }
      }
      return { Roll, terms: termTypes };
    },
  };
})();
