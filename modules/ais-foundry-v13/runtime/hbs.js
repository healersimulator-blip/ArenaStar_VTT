/**
 * hbs.js — an ArenaStar-authored, Handlebars-compatible template engine (D-483, R-04).
 *
 * Foundry modules ship `.hbs` templates and call `renderTemplate`, `Handlebars.registerHelper`
 * and `Handlebars.registerPartial`. The AIS sandbox cannot load Handlebars itself (no network,
 * single reviewed source), so this file implements the language subset those templates use:
 *
 *   {{expr}} {{{expr}}} {{&expr}} {{!comment}} {{!-- comment --}} {{~ ~}} whitespace control,
 *   {{#helper params key=value as |a b|}} … {{else}} / {{else if …}} … {{/helper}}, {{^inverted}},
 *   built-ins if/unless/each/with/lookup/log (@index @key @first @last @root @../x), ../paths,
 *   this/./[literal segments]/a.b.c/a/b, string/number/boolean/null literals, (subexpressions),
 *   {{> partial}} {{> partial context key=value}} {{> (dynamic)}} {{#> partial}}fallback{{/partial}},
 *   helpers receive (…params, options{name,hash,data,fn,inverse,lookupProperty}) with `this` = context,
 *   SafeString / escapeExpression (same characters as Handlebars), standalone-line stripping.
 *
 * Not implemented (explicit errors): raw blocks {{{{…}}}}, inline partials {{#*inline}}, decorators,
 * precompiled templates, strict/assumeObjects modes.
 */
(() => {
  "use strict";
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;", "`": "&#x60;", "=": "&#x3D;" };
  const ESCAPE_RE = /[&<>"'`=]/g;
  class SafeString {
    constructor(string) { this.string = string; }
    toString() { return String(this.string); }
    toHTML() { return String(this.string); }
  }
  const escapeExpression = (value) => {
    if (typeof value !== "string") {
      if (value && typeof value.toHTML === "function") return value.toHTML();
      if (value === null || value === undefined) return "";
      if (!value) return String(value);
      value = String(value);
    }
    return ESCAPE_RE.test(value) ? value.replace(ESCAPE_RE, (ch) => ESCAPES[ch]) : value;
  };
  const toText = (value) => value === null || value === undefined ? "" : typeof value?.toHTML === "function" ? value.toHTML() : String(value);
  const isEmpty = (value) => (!value && value !== 0) || (Array.isArray(value) && value.length === 0);
  const isFunction = (value) => typeof value === "function";
  const createFrame = (data) => Object.assign({}, data, { _parent: data });
  const ID_RE = /^[^\s!"#%-,./;->@[-^`{-~]+/;

  // ── Expression tokenizer / parser ──
  const matchPath = (src, start) => {
    let i = start, data = false;
    if (src[i] === "@") { data = true; i += 1; }
    const parts = [];
    let depth = 0, sawSegment = false;
    for (;;) {
      if (src.startsWith("..", i) && (i + 2 >= src.length || /[\s/.)=|]/.test(src[i + 2]))) { depth += 1; i += 2; }
      else if (src[i] === "." && (i + 1 >= src.length || /[\s/)=|]/.test(src[i + 1]))) { i += 1; }
      else if (src[i] === "[") {
        const end = src.indexOf("]", i);
        if (end < 0) throw new Error("Handlebars: unterminated [segment]");
        parts.push(src.slice(i + 1, end)); i = end + 1;
      } else {
        const m = ID_RE.exec(src.slice(i));
        if (!m) break;
        if (m[0] === "this" && parts.length === 0 && !data) { i += 4; }
        else { parts.push(m[0]); i += m[0].length; }
      }
      sawSegment = true;
      if (src[i] === "/" || (src[i] === "." && i + 1 < src.length && !/[\s)=|]/.test(src[i + 1]))) { i += 1; continue; }
      break;
    }
    if (!sawSegment) return null;
    return { token: { t: "path", parts, data, depth, original: src.slice(start, i) }, end: i };
  };
  const tokenizeExpression = (src) => {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i += 1; continue; }
      if ("()=|".includes(ch)) { tokens.push({ t: ch }); i += 1; continue; }
      if (ch === '"' || ch === "'") {
        let j = i + 1, out = "";
        while (j < src.length && src[j] !== ch) {
          if (src[j] === "\\" && src[j + 1] === ch) { out += ch; j += 2; } else out += src[j++];
        }
        if (j >= src.length) throw new Error(`Handlebars: unterminated string in "${src}"`);
        tokens.push({ t: "str", v: out }); i = j + 1; continue;
      }
      const num = /^-?\d+(?:\.\d+)?(?=$|[\s)=|])/.exec(src.slice(i));
      if (num) { tokens.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
      const path = matchPath(src, i);
      if (!path) throw new Error(`Handlebars: unexpected "${src.slice(i, i + 12)}" in "${src}"`);
      tokens.push(path.token); i = path.end;
    }
    return tokens;
  };
  const LITERALS = { true: true, false: false, null: null, undefined };
  const toTerm = (token, cursor) => {
    if (token.t === "str" || token.t === "num") return { type: "lit", value: token.v };
    if (token.t === "path") {
      if (!token.data && token.depth === 0 && token.parts.length === 1 && Object.hasOwn(LITERALS, token.parts[0]) && token.original === token.parts[0])
        return { type: "lit", value: LITERALS[token.parts[0]] };
      return { type: "path", parts: token.parts, data: token.data, depth: token.depth, original: token.original };
    }
    if (token.t === "(") {
      const call = parseCall(cursor, ")");
      return { type: "sub", ...call };
    }
    throw new Error(`Handlebars: unexpected "${token.t}"`);
  };
  /** Parses `callee params… key=value… as |a b|` until `end` (")" or end of tokens). */
  const parseCall = (cursor, end = null) => {
    const { tokens } = cursor;
    const next = () => tokens[cursor.i++];
    const peek = (offset = 0) => tokens[cursor.i + offset];
    const first = next();
    if (!first || (end && first.t === end)) throw new Error("Handlebars: empty expression");
    const callee = toTerm(first, cursor);
    const params = [];
    const hash = {};
    const blockParams = [];
    let sawHash = false;
    for (;;) {
      const token = peek();
      if (!token) { if (end) throw new Error(`Handlebars: expected "${end}"`); break; }
      if (end && token.t === end) { cursor.i += 1; break; }
      if (token.t === "path" && token.original === "as" && peek(1)?.t === "|") {
        cursor.i += 2;
        for (let p = next(); p && p.t !== "|"; p = next()) {
          if (p.t !== "path") throw new Error("Handlebars: invalid block parameter");
          blockParams.push(p.original);
        }
        continue;
      }
      if (token.t === "path" && peek(1)?.t === "=") {
        cursor.i += 2;
        const value = next();
        if (!value) throw new Error("Handlebars: hash value missing");
        hash[token.original] = toTerm(value, cursor);
        sawHash = true;
        continue;
      }
      if (sawHash) throw new Error("Handlebars: positional parameter after hash");
      cursor.i += 1;
      params.push(toTerm(token, cursor));
    }
    return { path: callee, params, hash: sawHash ? hash : null, blockParams };
  };
  const parseExpression = (text) => {
    const cursor = { tokens: tokenizeExpression(text), i: 0 };
    const call = parseCall(cursor);
    if (cursor.i < cursor.tokens.length) throw new Error(`Handlebars: trailing tokens in "${text}"`);
    return call;
  };

  // ── Template tokenizer ──
  const tokenizeTemplate = (src) => {
    const tokens = [];
    let i = 0;
    const pushText = (value) => { if (value) tokens.push({ kind: "text", value }); };
    while (i < src.length) {
      const open = src.indexOf("{{", i);
      if (open < 0) { pushText(src.slice(i)); break; }
      pushText(src.slice(i, open));
      let j = open + 2;
      let type = "mustache", closer = "}}";
      if (src.startsWith("{{{{", open)) throw new Error("Handlebars: raw blocks {{{{…}}}} are not supported");
      if (src[j] === "{") { type = "raw"; closer = "}}}"; j += 1; }
      let stripLeft = false, stripRight = false;
      if (src[j] === "~") { stripLeft = true; j += 1; }
      if (src.startsWith("!--", j)) {
        const end = src.indexOf("--", j + 3);
        const close = end < 0 ? -1 : src.indexOf("}}", end);
        if (close < 0) throw new Error("Handlebars: unterminated comment");
        tokens.push({ kind: "tag", type: "comment", body: "", stripLeft, stripRight: src[close - 1] === "~" });
        i = close + 2; continue;
      }
      const close = src.indexOf(closer, j);
      if (close < 0) throw new Error(`Handlebars: unterminated mustache at ${open}`);
      let body = src.slice(j, close);
      if (body.endsWith("~")) { stripRight = true; body = body.slice(0, -1); }
      body = body.trim();
      if (type === "mustache") {
        if (body.startsWith("!")) type = "comment";
        else if (body.startsWith("#>")) { type = "partialBlock"; body = body.slice(2); }
        else if (body.startsWith("#*")) throw new Error("Handlebars: inline partials/decorators are not supported");
        else if (body.startsWith("#")) { type = "open"; body = body.slice(1); }
        else if (body.startsWith("/")) { type = "close"; body = body.slice(1); }
        else if (body === "^" || body === "else" || /^else\s/.test(body)) { type = "else"; body = body === "^" ? "" : body.slice(4); }
        else if (body.startsWith("^")) { type = "openInverse"; body = body.slice(1); }
        else if (body.startsWith(">")) { type = "partial"; body = body.slice(1); }
        else if (body.startsWith("&")) { type = "raw"; body = body.slice(1); }
      }
      tokens.push({ kind: "tag", type, body: body.trim(), stripLeft, stripRight });
      i = close + closer.length;
    }
    // Whitespace control and standalone-line stripping.
    const STANDALONE = new Set(["comment", "open", "openInverse", "close", "else", "partialBlock"]);
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k];
      if (token.kind !== "tag") continue;
      const prev = tokens[k - 1], next = tokens[k + 1];
      if (token.stripLeft && prev?.kind === "text") prev.value = prev.value.replace(/\s+$/, "");
      if (token.stripRight && next?.kind === "text") next.value = next.value.replace(/^\s+/, "");
      if (!STANDALONE.has(token.type) && token.type !== "partial") continue;
      const prevOk = !prev || (prev.kind === "text" && (/\n[ \t]*$/.test(prev.value) || (k === 1 && /^[ \t]*$/.test(prev.value))));
      const nextOk = !next || (next.kind === "text" && /^[ \t]*(\r?\n|$)/.test(next.value));
      if (!prevOk || !nextOk || (!prev && !next)) continue;
      if (prev && token.type !== "partial") prev.value = prev.value.replace(/[ \t]*$/, "");
      if (next) next.value = next.value.replace(/^[ \t]*(\r?\n|$)/, "");
    }
    return tokens.filter((token) => token.kind !== "text" || token.value !== "");
  };

  // ── Parser → AST ──
  const parseTemplate = (src) => {
    const root = { body: [] };
    const stack = [root];
    const top = () => stack[stack.length - 1];
    const current = () => { const block = top(); return block.inverse && block.inElse ? block.inverse : block.body; };
    for (const token of tokenizeTemplate(src)) {
      if (token.kind === "text") { current().push({ type: "content", value: token.value }); continue; }
      switch (token.type) {
        case "comment": break;
        case "mustache":
        case "raw": {
          const call = parseExpression(token.body);
          current().push({ type: "mustache", ...call, escaped: token.type === "mustache" });
          break;
        }
        case "open":
        case "openInverse": {
          const call = parseExpression(token.body);
          const block = { type: "block", ...call, body: [], inverse: null, inElse: false, inverted: token.type === "openInverse", chained: false };
          current().push(block);
          stack.push(block);
          break;
        }
        case "else": {
          const block = top();
          if (block === root) throw new Error("Handlebars: {{else}} outside of a block");
          if (block.inverse) throw new Error("Handlebars: duplicate {{else}}");
          block.inverse = [];
          block.inElse = true;
          if (token.body) {
            // {{else if x}} — a chained block living in the inverse program; the outer close ends the chain.
            const call = parseExpression(token.body);
            const chained = { type: "block", ...call, body: [], inverse: null, inElse: false, inverted: false, chained: true };
            block.inverse.push(chained);
            stack.push(chained);
          }
          break;
        }
        case "close": {
          let block = top();
          while (block.chained) { stack.pop(); block = top(); }
          if (block === root) throw new Error(`Handlebars: unexpected {{/${token.body}}}`);
          const expected = block.type === "partial" ? (block.name.type === "lit" ? String(block.name.value) : token.body)
            : block.path.type === "path" ? block.path.original : token.body;
          if (token.body !== expected && token.body !== expected.replace(/^this\./, ""))
            throw new Error(`Handlebars: {{/${token.body}}} does not close {{#${expected}}}`);
          stack.pop();
          break;
        }
        case "partial":
        case "partialBlock": {
          const call = parsePartialCall(token.body);
          const node = { type: "partial", ...call, fallback: null, inElse: false };
          current().push(node);
          if (token.type === "partialBlock") { node.fallback = []; node.body = node.fallback; stack.push(node); }
          break;
        }
        default: throw new Error(`Handlebars: unsupported tag ${token.type}`);
      }
    }
    if (stack.length !== 1) {
      const open = top();
      throw new Error(`Handlebars: unclosed {{#${open.path?.type === "path" ? open.path.original : "block"}}}`);
    }
    return root.body;
  };
  /** `{{> name}}`, `{{> "quoted/name.hbs"}}`, `{{> (lookup . "p")}}`, with optional context and hash. */
  const parsePartialCall = (body) => {
    let rest = body.trim(), name;
    if (rest.startsWith("(") || rest.startsWith('"') || rest.startsWith("'")) {
      const cursor = { tokens: tokenizeExpression(rest), i: 0 };
      const first = cursor.tokens[cursor.i++];
      name = toTerm(first, cursor);
      const tail = { tokens: cursor.tokens.slice(cursor.i), i: 0 };
      return { name, ...parsePartialTail(tail) };
    }
    const m = /^\S+/.exec(rest);
    name = { type: "lit", value: m[0] };
    rest = rest.slice(m[0].length);
    return { name, ...parsePartialTail({ tokens: tokenizeExpression(rest), i: 0 }) };
  };
  const parsePartialTail = (cursor) => {
    let context = null;
    const hash = {};
    let sawHash = false;
    while (cursor.i < cursor.tokens.length) {
      const token = cursor.tokens[cursor.i];
      if (token.t === "path" && cursor.tokens[cursor.i + 1]?.t === "=") {
        cursor.i += 2;
        hash[token.original] = toTerm(cursor.tokens[cursor.i++], cursor);
        sawHash = true;
        continue;
      }
      if (context || sawHash) throw new Error("Handlebars: invalid partial parameters");
      cursor.i += 1;
      context = toTerm(token, cursor);
    }
    return { context, hash: sawHash ? hash : null };
  };

  // ── Runtime ──
  const builtinHelpers = {
    if(conditional, options) {
      if (arguments.length !== 2) throw new Error("#if requires exactly one argument");
      if (isFunction(conditional)) conditional = conditional.call(this);
      if ((!options.hash.includeZero && !conditional) || isEmpty(conditional)) return options.inverse(this);
      return options.fn(this);
    },
    unless(conditional, options) {
      if (arguments.length !== 2) throw new Error("#unless requires exactly one argument");
      return builtinHelpers.if.call(this, conditional, { fn: options.inverse, inverse: options.fn, hash: options.hash });
    },
    each(context, options) {
      if (!options) throw new Error("Must pass iterator to #each");
      if (isFunction(context)) context = context.call(this);
      const data = options.data ? createFrame(options.data) : {};
      let out = "", index = 0;
      const emit = (value, key, last) => {
        data.key = key; data.index = index; data.first = index === 0; data.last = last;
        out += options.fn(value, { data, blockParams: [value, key] });
        index += 1;
      };
      if (context && typeof context === "object") {
        if (Array.isArray(context)) context.forEach((value, i) => emit(value, i, i === context.length - 1));
        else if (typeof context[Symbol.iterator] === "function") {
          const items = [...context];
          items.forEach((value, i) => emit(value, i, i === items.length - 1));
        } else {
          const keys = Object.keys(context);
          keys.forEach((key, i) => emit(context[key], key, i === keys.length - 1));
        }
      }
      return index === 0 ? options.inverse(this) : out;
    },
    with(context, options) {
      if (arguments.length !== 2) throw new Error("#with requires exactly one argument");
      if (isFunction(context)) context = context.call(this);
      if (isEmpty(context)) return options.inverse(this);
      return options.fn(context, { data: options.data, blockParams: [context] });
    },
    lookup: (object, field) => (object === null || object === undefined ? undefined : object[field]),
    log: (...args) => { args.pop(); console.log("Handlebars:", ...args); },
  };

  const create = () => {
    const env = {
      helpers: Object.assign(Object.create(null), builtinHelpers),
      partials: Object.create(null),
      /** Optional hook: `(name) => templateSource | compiledFn | undefined` for partials served from elsewhere. */
      partialResolver: null,
      SafeString, escapeExpression, createFrame, isEmpty,
      Utils: { escapeExpression, isEmpty, isFunction, isArray: Array.isArray, toString: toText, extend: Object.assign, createFrame },
      VERSION: "ais-hbs/1 (Handlebars 4 compatible subset)",
    };
    const compiledPartials = new Map();
    const templateCache = new Map();

    const blockParamValue = (frame, name) => {
      for (let f = frame; f; f = f.parent) if (f.blockParams && Object.hasOwn(f.blockParams, name)) return { value: f.blockParams[name] };
      return null;
    };
    const lookupPath = (node, frame) => {
      let f = frame;
      for (let d = 0; d < node.depth; d += 1) { if (!f.parent) return undefined; f = f.parent; }
      let value;
      let parts = node.parts;
      if (node.data) {
        value = f.data;
      } else if (parts.length === 0) {
        return f.context;
      } else {
        const bound = node.depth === 0 ? blockParamValue(f, parts[0]) : null;
        if (bound) { value = bound.value; parts = parts.slice(1); }
        else value = f.context;
      }
      for (const part of parts) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
      }
      return value;
    };
    const evaluate = (term, frame) => {
      if (term.type === "lit") return term.value;
      if (term.type === "sub") return invoke(term, frame, null, true);
      return lookupPath(term, frame);
    };
    const evaluateHash = (hash, frame) => {
      const out = {};
      if (hash) for (const [key, term] of Object.entries(hash)) out[key] = evaluate(term, frame);
      return out;
    };
    const childFrame = (frame, context, options = {}, blockParamNames = []) => {
      const blockParams = blockParamNames.length && options.blockParams
        ? Object.fromEntries(blockParamNames.map((name, i) => [name, options.blockParams[i]])) : null;
      if (context === frame.context && !blockParams) return options.data && options.data !== frame.data ? { ...frame, data: options.data } : frame;
      return { context, parent: frame, data: options.data ?? frame.data, blockParams, noEscape: frame.noEscape };
    };
    const program = (nodes, frame, blockParamNames) => nodes
      ? (context, options = {}) => render(nodes, childFrame(frame, context, options, blockParamNames))
      : () => "";
    const helperFor = (callee, frame) => {
      if (callee.type !== "path" || callee.data || callee.depth !== 0 || callee.parts.length !== 1) return undefined;
      if (blockParamValue(frame, callee.parts[0])) return undefined;
      return env.helpers[callee.parts[0]];
    };
    /** Mustache / subexpression / block invocation following Handlebars' helper-vs-property rules. */
    const invoke = (node, frame, block, mustCall) => {
      const callee = node.path;
      const helper = helperFor(callee, frame);
      const options = {
        name: callee.type === "path" ? callee.original : String(callee.value),
        hash: evaluateHash(node.hash, frame),
        data: frame.data,
        lookupProperty: (object, key) => (object === null || object === undefined ? undefined : object[key]),
        ...(block ? { fn: program(block.body, frame, block.blockParams), inverse: program(block.inverse, frame), blockParams: block.blockParams.length } : {}),
      };
      if (helper) return helper.call(frame.context, ...node.params.map((param) => evaluate(param, frame)), options);
      if (node.params.length || node.hash || mustCall) {
        const missing = env.helpers.helperMissing;
        if (missing) return missing.call(frame.context, ...node.params.map((param) => evaluate(param, frame)), options);
        throw new Error(`Missing helper: "${options.name}"`);
      }
      let value = evaluate(callee, frame);
      if (isFunction(value)) value = value.call(frame.context);
      if (!block) return value;
      // blockHelperMissing
      if (value === true) return options.fn(frame.context);
      if (value === false || value === null || value === undefined) return options.inverse(frame.context);
      if (Array.isArray(value)) return value.length ? builtinHelpers.each.call(frame.context, value, options) : options.inverse(frame.context);
      return options.fn(value);
    };
    const resolvePartial = (name) => {
      let source = env.partials[name];
      if (source === undefined && env.partialResolver) source = env.partialResolver(name);
      if (source === undefined || source === null) return null;
      if (isFunction(source)) return source;
      const cached = compiledPartials.get(name);
      if (cached && cached.source === source) return cached.fn;
      const fn = compile(source);
      compiledPartials.set(name, { source, fn });
      return fn;
    };
    const renderPartial = (node, frame) => {
      const name = node.name.type === "lit" ? String(node.name.value) : toText(evaluate(node.name, frame));
      let context = node.context ? evaluate(node.context, frame) : frame.context;
      if (node.hash) context = Object.assign({}, context, evaluateHash(node.hash, frame));
      const fn = resolvePartial(name);
      if (!fn) {
        if (node.fallback) return render(node.fallback, childFrame(frame, context));
        throw new Error(`The partial ${name} could not be found`);
      }
      return fn(context, { data: frame.data, _frame: frame });
    };
    const render = (nodes, frame) => {
      let out = "";
      for (const node of nodes) {
        if (node.type === "content") out += node.value;
        else if (node.type === "mustache") {
          const value = invoke(node, frame, null, false);
          out += node.escaped && !frame.noEscape ? escapeExpression(value) : toText(value);
        } else if (node.type === "block") {
          const value = node.inverted
            ? invoke({ ...node, params: node.params, hash: node.hash }, frame, { body: node.inverse ?? [], inverse: node.body, blockParams: node.blockParams }, false)
            : invoke(node, frame, { body: node.body, inverse: node.inverse, blockParams: node.blockParams }, false);
          out += toText(value);
        } else if (node.type === "partial") out += renderPartial(node, frame);
      }
      return out;
    };
    const compile = (source, compileOptions = {}) => {
      if (typeof source !== "string") throw new Error("Handlebars.compile needs a template string");
      let ast = templateCache.get(source);
      if (!ast) {
        ast = parseTemplate(source);
        if (templateCache.size >= 512) templateCache.delete(templateCache.keys().next().value);
        templateCache.set(source, ast);
      }
      const noEscape = compileOptions.noEscape === true;
      const template = (context, runtimeOptions = {}) => {
        const parentFrame = runtimeOptions._frame;
        const data = runtimeOptions.data ?? (parentFrame ? parentFrame.data : { root: context });
        if (data && !("root" in data)) data.root = context;
        const frame = { context, parent: parentFrame ?? null, data, blockParams: null, noEscape: noEscape || parentFrame?.noEscape };
        return render(ast, frame);
      };
      template.ast = ast;
      return template;
    };
    env.compile = compile;
    env.precompile = () => { throw new Error("Handlebars.precompile is not available in the AIS sandbox"); };
    env.template = () => { throw new Error("Precompiled Handlebars templates are not available in the AIS sandbox"); };
    env.registerHelper = (name, fn) => {
      if (name && typeof name === "object") { for (const [key, value] of Object.entries(name)) env.helpers[key] = value; return; }
      if (typeof name !== "string" || !isFunction(fn)) throw new Error("Handlebars.registerHelper needs a name and a function");
      env.helpers[name] = fn;
    };
    env.unregisterHelper = (name) => { Reflect.deleteProperty(env.helpers, name); };
    env.registerPartial = (name, source) => {
      if (name && typeof name === "object") { for (const [key, value] of Object.entries(name)) env.partials[key] = value; return; }
      if (typeof name !== "string" || (typeof source !== "string" && !isFunction(source))) throw new Error("Handlebars.registerPartial needs a name and a template");
      env.partials[name] = source;
      compiledPartials.delete(name);
    };
    env.unregisterPartial = (name) => { Reflect.deleteProperty(env.partials, name); compiledPartials.delete(name); };
    env.create = create;
    env.noConflict = () => env;
    env.log = builtinHelpers.log;
    return env;
  };

  globalThis.__aisFoundryHbs = Object.freeze({ create, SafeString, escapeExpression });
})();
