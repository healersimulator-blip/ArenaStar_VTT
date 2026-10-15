/* ArenaStar-authored Foundry compatibility adapter. Runs only INSIDE an approved AIS guest frame.
 * Two profiles share one file:
 *   - "foundry-v13-scene-tags-fx" (0.1.0, D-4xx): a bundled guest with ArenaStar commands; small,
 *     command-scoped API profile (kept byte-for-byte in behaviour).
 *   - "foundry-module" (0.2.0, D-482): an UNMODIFIED Foundry `module.json` distribution. The
 *     adapter loads the module's own ES modules from blob URLs through an import map, installs
 *     Foundry core globals mapped onto AIS services (settings, i18n, modules, notifications,
 *     hooks, scene documents, FX) and runs the init → setup → ready lifecycle.
 * This is not Foundry core (proprietary; nothing is copied) and not the upstream Sequencer.
 * Unknown calls fail explicitly rather than pretending a feature worked.
 */
(function () {
  "use strict";
  const context = AIS.runtime.context;
  const PROFILES = ["foundry-v13-scene-tags-fx", "foundry-module"];
  if (!context || !PROFILES.includes(context.profile)) throw new Error("Unsupported adapter profile");
  const moduleProfile = context.profile === "foundry-module";
  const config = context.configuration;
  if (!moduleProfile && (!config || typeof config.id !== "string" || typeof config.version !== "string"))
    throw new Error("Runtime configuration needs upstream id/version");
  const unsupported = (name) => { throw new Error(`Foundry compatibility profile does not support ${name}`); };
  /** Foundry `deepClone` semantics: plain data is copied, class instances/functions/DOM nodes are shared. */
  const clone = (value, depth = 0) => {
    if (value === null || typeof value !== "object") return value;
    if (depth > 100) throw new Error("deepClone: maximum depth exceeded");
    if (Array.isArray(value)) return value.map((item) => clone(item, depth + 1));
    if (value instanceof Date) return new Date(value.getTime());
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item, depth + 1);
    return out;
  };
  const duplicate = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const safeParts = (path) => {
    const parts = String(path).split(".");
    if (parts.some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("Unsafe property path");
    return parts;
  };
  const getProperty = (object, path) => safeParts(path).reduce((value, key) => value?.[key], object);
  const hasProperty = (object, path) => getProperty(object, path) !== undefined;
  const setProperty = (object, path, value) => {
    const parts = safeParts(path);
    const last = parts.pop();
    for (const key of parts) {
      if (!Object.hasOwn(object, key) || !object[key] || typeof object[key] !== "object") object[key] = {};
      object = object[key];
    }
    object[last] = value;
    return true;
  };
  const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  const mergeObject = (original, other = {}, options = {}) => {
    const { insertKeys = true, insertValues = true, overwrite = true, recursive = true, inplace = true, performDeletions = false } = options;
    if (!inplace) original = clone(original) ?? {};
    for (const key of Object.keys(other)) {
      safeParts(key);
      const value = other[key];
      if (performDeletions && key.startsWith("-=")) { Reflect.deleteProperty(original, key.slice(2)); continue; }
      if (key.includes(".")) { // expanded-key form, e.g. { "flags.tagger.tags": [...] }
        if (!hasProperty(original, key) ? insertKeys : overwrite) setProperty(original, key, clone(value));
        continue;
      }
      const exists = Object.hasOwn(original, key);
      if (isPlainObject(value) && recursive) {
        if (!exists && !insertKeys) continue;
        if (!isPlainObject(original[key])) { if (!exists || overwrite) original[key] = {}; else continue; }
        mergeObject(original[key], value, { insertKeys: insertValues, insertValues, overwrite, recursive, inplace: true, performDeletions });
      } else if (exists ? overwrite : insertKeys) original[key] = clone(value);
    }
    return original;
  };
  const expandObject = (object) => { const out = {}; for (const [key, value] of Object.entries(object)) setProperty(out, key, isPlainObject(value) ? expandObject(value) : value); return out; };
  const flattenObject = (object, prefix = "", out = {}) => {
    for (const [key, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(value) && Object.keys(value).length) flattenObject(value, path, out); else out[path] = value;
    }
    return out;
  };
  const isNewerVersion = (left, right) => {
    const a = String(left).split(".").map(Number), b = String(right).split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  };
  const randomID = (length = 16) => { let out = ""; while (out.length < length) out += crypto.randomUUID().replaceAll("-", ""); return out.slice(0, length); };
  const debounce = (fn, ms) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; };
  const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  // Local synchronous hooks. In particular a Promise resolving to false is NOT a veto.
  const hooks = new Map();
  let nextHook = 1;
  const on = (name, callback, options = {}) => {
    if (typeof name !== "string" || typeof callback !== "function") throw new Error("Invalid hook");
    const entry = { id: nextHook++, callback, once: options.once === true };
    const rows = hooks.get(name) || [];
    if (rows.length >= 128) throw new Error("Hook listener limit exceeded");
    rows.push(entry); hooks.set(name, rows);
    return entry.id;
  };
  const off = (name, id) => hooks.set(name, (hooks.get(name) || []).filter((entry) => entry.id !== id && entry.callback !== id));
  const hookErrors = [];
  const dispatch = (name, args, cancellable) => {
    for (const entry of [...(hooks.get(name) || [])]) {
      if (entry.once) off(name, entry.id);
      let result;
      try { result = entry.callback(...args); }
      catch (error) {
        // Foundry logs and continues; an unmodified module must not take the whole frame down.
        if (!moduleProfile) throw error;
        if (hookErrors.length < 32) hookErrors.push({ hook: name, error: error instanceof Error ? error.message : String(error) });
        console.error(`Hook ${name} failed`, error);
        continue;
      }
      if (cancellable && result === false) return false;
    }
    return true;
  };
  globalThis.Hooks = Object.freeze({ on, off,
    once: (name, callback) => on(name, callback, { once: true }),
    call: (name, ...args) => dispatch(name, args, true),
    callAll: (name, ...args) => { dispatch(name, args, false); return true; },
    get events() { return Object.fromEntries([...hooks].map(([name, rows]) => [name, rows.map((row) => ({ id: row.id, fn: row.callback, once: row.once }))])); },
  });
  // A Foundry convenience extension, installed in this isolated realm only.
  Object.defineProperty(Array.prototype, "deepFlatten", { configurable: true,
    value: function () { return this.flat(Infinity); } });
  globalThis.randomID = randomID;

  class Collection extends Map {
    constructor(rows = []) { super(rows.map((row) => [row.id ?? row._id, row])); }
    /** Foundry collections iterate VALUES (`for (const token of scene.tokens)`), unlike Map. */
    [Symbol.iterator]() { return this.values(); }
    get contents() { return [...this.values()]; }
    getName(name) { return this.contents.find((row) => row.name === name); }
    find(fn) { return this.contents.find(fn); }
    filter(fn) { return this.contents.filter(fn); }
    map(fn) { return this.contents.map(fn); }
    some(fn) { return this.contents.some(fn); }
    reduce(fn, initial) { return this.contents.reduce(fn, initial); }
    toJSON() { return this.contents.map((row) => (typeof row.toObject === "function" ? row.toObject() : row)); }
  }
  let currentView = null;
  let activeApi = null;
  let activeDeadline = 0;
  let busy = false;
  const types = { tokens: "Token", lights: "AmbientLight", sounds: "AmbientSound", templates: "MeasuredTemplate",
    tiles: "Tile", walls: "Wall", drawings: "Drawing", notes: "Note", regions: "Region" };
  class SceneDocumentView {
    constructor(data, view) {
      this._view = view; this._id = data.id; this.id = data.id; this.name = data.name;
      this.grid = clone(data.grid); this.documentName = "Scene"; this.active = true;
      this.flags = {};
    }
    get uuid() { return `Scene.${this.id}`; }
    get isView() { return true; }
    get dimensions() { return { size: this.grid?.size ?? 100, distance: this.grid?.distance ?? 5 }; }
    getEmbeddedDocument(type, id) {
      const key = Object.keys(types).find((key) => types[key] === type);
      if (!key) return unsupported(`embedded document ${type}`);
      return this[key].get(id);
    }
    getEmbeddedCollection(type) {
      const key = Object.keys(types).find((key) => types[key] === type);
      if (!key) return unsupported(`embedded collection ${type}`);
      return this[key];
    }
    getFlag() { return undefined; }
    toObject() { return { _id: this.id, name: this.name, grid: clone(this.grid), flags: {} }; }
  }
  class DocumentView {
    constructor(data, collection, view) {
      this._data = clone(data); this._collection = collection; this._view = view;
      this._id = data.id; this.id = data.id; this.name = data.name;
      this.x = data.x; this.y = data.y; this.documentName = types[collection];
    }
    get parent() { return this._view.scene; }
    get uuid() { return `Scene.${this.parent.id}.${this.documentName}.${this.id}`; }
    get flags() { return { tagger: { tags: clone(this._data.tags) } }; }
    get isOwner() { return true; } // GM-local profile, NOT a host permission credential.
    /** Foundry placeables expose `.document`; modules normalise with `obj.document ?? obj`. */
    get document() { return this; }
    get object() { return this; }
    getFlag(scope, key) {
      if (scope !== "tagger" || key !== "tags") return moduleProfile ? undefined : unsupported(`flag ${scope}.${key}`);
      return clone(this._data.tags);
    }
    setFlag(scope, key, value) {
      if (scope !== "tagger" || key !== "tags") return unsupported(`flag ${scope}.${key}`);
      return this.update({ "flags.tagger.tags": value });
    }
    unsetFlag(scope, key) { return this.setFlag(scope, key, []); }
    async update(input) {
      if (!moduleProfile && (!this._view.api || !busy || this._view !== currentView)) throw new Error("Use the command-scoped adapter invocation API");
      const changed = {};
      for (const [key, value] of Object.entries(input)) setProperty(changed, key, clone(value));
      if (!Hooks.call(`preUpdate${this.documentName}`, this, changed, {}, "gm")) throw new Error("Document update vetoed by a pre-hook");
      const keys = Object.keys(changed);
      if (keys.some((key) => !["flags.tagger.tags", "flags"].includes(key))) return unsupported("document fields other than tags");
      const flags = changed.flags;
      if (flags && (Object.keys(flags).some((key) => key !== "tagger") ||
          Object.keys(flags.tagger || {}).some((key) => !["tags", "-=tags"].includes(key)))) return unsupported("foreign flag namespace");
      let tags = changed["flags.tagger.tags"] ?? getProperty(changed, "flags.tagger.tags");
      if (getProperty(changed, "flags.tagger.-=tags") === null) tags = [];
      if (!Array.isArray(tags)) throw new Error("Tag updates require an array");
      // Draft hook mutations are only proposals. This reply means the HOST committed.
      const request = { sceneId: this.parent.id, collection: this._collection, id: this.id, tags };
      let result;
      try { result = await this._view.api.sceneTags.update({ ...request, expectedSeq: this._view.seq }); }
      catch (error) {
        // Foundry semantics are last-writer-wins: a stale revision is refreshed once, then retried.
        if (!moduleProfile || !/stale/i.test(error?.message ?? "")) throw error;
        const fresh = await this._view.api.sceneTags.snapshot();
        this._view.seq = fresh.seq;
        result = await this._view.api.sceneTags.update({ ...request, expectedSeq: fresh.seq });
      }
      this._data.tags = clone(result.tags);
      this._view.seq = result.seq;
      Hooks.callAll(`update${this.documentName}`, this, changed, {}, "gm");
      return this;
    }
    toObject() { return { _id: this.id, name: this.name, x: this.x, y: this.y, flags: this.flags }; }
    toJSON() { return this.toObject(); }
  }
  async function hydrate(api) {
    const snapshot = await api.sceneTags.snapshot();
    const view = { api, seq: snapshot.seq, scene: null };
    const scene = new SceneDocumentView(snapshot.scene, view);
    view.scene = scene;
    for (const collection of Object.keys(types)) scene[collection] = new Collection(
      snapshot.collections[collection].map((data) => new DocumentView(data, collection, view)));
    currentView = view;
    return view;
  }
  const bindings = new Map();

  // A deliberately bounded Sequencer-shaped builder over ArenaStar's EXISTING FX runtime.
  // Unsupported methods fail explicitly; this is not the original Sequencer implementation.
  const namedEffects = new Map();
  const ownEffects = (filter = {}) => {
    if (Object.keys(filter).some((key) => key !== "name")) return unsupported("effect filters other than exact name");
    for (const [id, effect] of namedEffects) if (effect.endsAtHostTime <= Date.now()) namedEffects.delete(id);
    return [...namedEffects.values()].filter((effect) => filter.name === undefined || effect.name === filter.name);
  };
  const fxApi = () => moduleProfile ? AIS : activeApi;
  class SequenceBuilder {
    constructor() { this.steps = []; this.cursor = 0; this.last = null; this.refs = {}; this.started = false; }
    section(kind) {
      if (this.started || this.steps.length >= 32) throw new Error("Invalid or oversized FX chain");
      const step = { id: `part-${this.steps.length + 1}`, kind, startMs: this.cursor, durationMs: 1000 };
      if (kind !== "sound" && kind !== "wait") step.at = { kind: "point", x: 0, y: 0 };
      this.steps.push(step); this.last = step; return this;
    }
    effect() { return this.section("image"); }
    sound() { return this.section("sound"); }
    text(text) {
      if (typeof text !== "string") throw new Error("FX text must be a string");
      if (this.last?.kind === "image" && !this.last.assetId) this.last.kind = "text";
      else this.section("text");
      this.last.text = text; this.last.color = "#ffffff"; return this;
    }
    file(path) {
      if (!this.last || !["image", "sound"].includes(this.last.kind)) throw new Error("file needs an effect or sound section");
      const mapped = config?.assets?.[path] ?? path;
      if (typeof mapped !== "string" || !/^[a-f0-9]{64}$/.test(mapped)) return unsupported("remote/file media paths without a local asset mapping");
      this.last.assetId = mapped; return this;
    }
    anchor(location) {
      if (location instanceof DocumentView) {
        if (location._collection !== "tokens" || location.parent.id !== currentView?.scene.id) return unsupported("non-token anchors");
        for (const kind of ["source", "target"]) {
          if (!this.refs[kind] || this.refs[kind] === location.id) { this.refs[kind] = location.id; return { kind }; }
        }
        return unsupported("more than two token anchors per sequence");
      }
      if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) throw new Error("Invalid FX location");
      return { kind: "point", x: location.x, y: location.y };
    }
    atLocation(location) { this.last.at = this.anchor(location); return this; }
    attachTo(location) { this.last.at = this.anchor(location); this.last.follow = true; return this; }
    stretchTo(location) { this.last.to = this.anchor(location); this.last.stretch = true; return this; }
    duration(ms) { this.last.durationMs = ms; return this; }
    name(value) {
      if (typeof value !== "string" || !value || value.length > 80 || (this.runName && this.runName !== value))
        return unsupported("multiple names per transient timeline or invalid effect name");
      this.runName = value; return this;
    }
    scale(value) { this.last.scale = value; return this; }
    opacity(value) { this.last.opacity = value; return this; }
    fadeIn(ms) { this.last.fadeInMs = ms; return this; }
    fadeOut(ms) { this.last.fadeOutMs = ms; return this; }
    tint(color) { this.last.tint = color; return this; }
    volume(value) { this.last.volume = value; return this; }
    wait(ms) { if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid FX wait"); this.cursor += ms; return this; }
    waitUntilFinished(offset = 0) {
      if (!this.last || !Number.isFinite(offset)) throw new Error("Invalid FX finish offset");
      this.cursor = this.last.startMs + this.last.durationMs + offset;
      if (this.cursor < 0) throw new Error("FX start cannot precede the run");
      return this;
    }
    persist() { return unsupported("persistent foreign FX; the native wizard remains available"); }
    async play() {
      const api = fxApi();
      if (this.started || !api) throw new Error("FX playback needs a live command-scoped invocation");
      ownEffects();
      this.started = true;
      const duration = Math.max(0, ...this.steps.map((step) => step.startMs + step.durationMs));
      if (!moduleProfile && Date.now() + duration + 1500 >= activeDeadline) throw new Error("FX timeline cannot finish within this command budget");
      const run = await api.fx.play({ sequence: { version: 1, audience: "scene", persistent: false, sections: this.steps },
        ...(this.refs.source ? { sourceTokenId: this.refs.source } : {}),
        ...(this.refs.target ? { targetTokenId: this.refs.target } : {}) });
      namedEffects.set(run.runId, { ...run, name: this.runName ?? "" });
      const remaining = Math.max(0, run.endsAtHostTime - Date.now());
      if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
      return run;
    }
  }
  globalThis.Sequence = SequenceBuilder;
  globalThis.Sequencer = Object.freeze({
    EffectManager: Object.freeze({
      getEffects: (filter) => ownEffects(filter).map((effect) => ({ ...effect })),
      endEffects: async (filter = {}) => {
        const api = fxApi();
        if (!api || typeof filter.name !== "string" || !filter.name) return unsupported("endEffects needs an exact owned name");
        const effects = ownEffects(filter);
        const results = [];
        for (const effect of effects) {
          results.push(await api.fx.stop(effect.runId));
          namedEffects.delete(effect.runId);
        }
        return results;
      },
    }),
  });

  if (!moduleProfile) {
    // ───────────────────────── profile: foundry-v13-scene-tags-fx (0.1.0 behaviour) ─────────────────────────
    globalThis.foundry = Object.freeze({ utils: Object.freeze({ getProperty, setProperty, mergeObject, isNewerVersion,
      deepClone: clone, randomID }) });
    globalThis.CONST = Object.freeze({ KEYBINDING_PRECEDENCE: Object.freeze({ PRIORITY: 0 }) });
    globalThis.Actor = function Actor() { unsupported("Actor documents in this scene-only profile"); };
    globalThis.Dialog = function Dialog() { unsupported("Foundry dialog/DOM applications"); };
    globalThis.$ = () => unsupported("Foundry/jQuery configuration forms");
    globalThis.game = Object.freeze({
      version: "13", release: Object.freeze({ generation: 13 }),
      user: Object.freeze({ id: "gm", name: "GM", isGM: true }),
      modules: new Collection([{ id: config.id, version: config.version, active: true,
        flags: { ais: { sourceHash: context.sourceHash, runtimeHash: context.runtimeHash } } },
        { id: "sequencer", active: true, flags: { ais: { substitute: "transient-text-image-sound-v1" } } }]),
      scenes: Object.freeze({
        get: (id) => currentView?.scene.id === id ? currentView.scene : undefined,
        [Symbol.iterator]: () => unsupported("all-scene iteration; only the active scene is projected"),
      }),
      get canvas() { return { id: currentView?.scene.id, scene: currentView?.scene, ready: !!currentView }; },
      get actors() { return unsupported("world actors"); },
      settings: Object.freeze({ register: () => unsupported("Foundry settings; use AIS storage in this first profile"),
        get: () => unsupported("Foundry settings"), set: () => unsupported("Foundry settings") }),
      // Declared exclusion: definitions are retained for diagnostics, not installed in parent UI.
      keybindings: Object.freeze({ register: (scope, key, definition) => { bindings.set(`${scope}.${key}`, definition); } }),
    });
    Object.defineProperty(globalThis, "canvas", { configurable: true, get: () => ({
      scene: currentView?.scene, tokens: currentView?.scene.tokens,
      get app() { return unsupported("the host PIXI renderer"); },
    }) });
    globalThis.FoundryAdapter = Object.freeze({
      async invoke(commandContext, callback) {
        if (busy || !commandContext?.ais) throw new Error("An adapter invocation is already running or lacks scoped authority");
        busy = true;
        try {
          activeApi = commandContext.ais;
          activeDeadline = commandContext.deadlineAt;
          const view = await hydrate(activeApi);
          if (view.scene.id !== commandContext.sceneId) throw new Error("The active scene changed before this invocation");
          return await callback();
        } finally { activeApi = null; busy = false; }
      },
      info: () => ({ profile: context.profile, upstreamId: config.id, upstreamVersion: config.version,
        sourceCommit: config.sourceCommit ?? null, runtimeHash: context.runtimeHash,
        scope: "GM-local active-scene tags; transient FX; no Foundry UI, settings or actor/system emulation",
        keybindingsRecordedNotDispatched: bindings.size, hookNames: [...hooks.keys()] }),
    });
    AIS.runtime.initialize(async () => {
      await hydrate(AIS);
      Hooks.callAll("init");
      Hooks.callAll("setup");
      Hooks.callAll("ready");
    });
    return;
  }

  // ═════════════════════════════ profile: foundry-module (0.2.0 D-482, UI layer 0.3.0 D-483) ═════════════════════════════
  const dist = context.distribution;
  if (!dist || typeof dist.foundryId !== "string" || !Array.isArray(dist.files))
    throw new Error("foundry-module profile needs runtimeContext.distribution (import the module.json archive through the package importer)");
  const foundryId = dist.foundryId;
  const diagnostics = { loaded: [], styles: [], languages: [], warnings: [], unsupportedCalls: [] };
  const warn = (text) => { if (diagnostics.warnings.length < 64 && !diagnostics.warnings.includes(text)) diagnostics.warnings.push(text); console.warn(text); };
  const unsupportedCall = (name) => {
    if (diagnostics.unsupportedCalls.length < 64 && !diagnostics.unsupportedCalls.includes(name)) diagnostics.unsupportedCalls.push(name);
    return unsupported(name);
  };
  /** A class whose instances exist (so `class X extends Y` and `instanceof` work) but cannot render/act. */
  const stubClass = (name, base = Object) => {
    const klass = { [name]: class extends base {
      constructor(...args) { super(...(base === Object ? [] : args)); this._stubArgs = args; }
    } }[name];
    for (const method of ["render", "close", "submit", "activateListeners", "getData", "_render", "maximize", "minimize", "bringToTop", "setPosition"])
      if (!Object.hasOwn(klass.prototype, method))
        Object.defineProperty(klass.prototype, method, { configurable: true, writable: true, value: function () { return unsupportedCall(`${name}#${method} (Foundry application UI; R-04)`); } });
    Object.defineProperty(klass, "defaultOptions", { configurable: true, get: () => ({ classes: [], template: null, width: 400, height: "auto" }) });
    Object.defineProperty(klass, "DEFAULT_OPTIONS", { configurable: true, writable: true, value: {} });
    Object.defineProperty(klass, "PARTS", { configurable: true, writable: true, value: {} });
    return klass;
  };

  // ── i18n: the emulator's core keys first (D-484), then the module's own language files (which win). ──
  const translations = globalThis.__aisFoundryCore ? expandObject(clone(globalThis.__aisFoundryCore.lang)) : {};
  const i18n = {
    lang: "en",
    translations,
    has: (key) => typeof getProperty(translations, key) === "string",
    localize: (key) => { const value = getProperty(translations, String(key)); return typeof value === "string" ? value : String(key); },
    format: (key, data = {}) => i18n.localize(key).replace(/\{([^}]+)\}/g, (_m, name) => (data[name] === undefined ? `{${name}}` : String(data[name]))),
    sortObjects: (rows, key) => [...rows].sort((a, b) => String(getProperty(a, key)).localeCompare(String(getProperty(b, key)))),
  };
  const shortText = (text, max) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

  // ── game.settings over AIS declared settings (D-476/D-482): Foundry's sync API, cached locally. ──
  const SETTING_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,47}$/;
  const fnv = (text) => { let h = 0x811c9dc5; for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
  /** Deterministic AIS key for `<namespace>.<key>` (Foundry keys allow dashes/dots/case the AIS schema does not). */
  const aisSettingKey = (namespace, key) => {
    const raw = `${namespace}_${key}`.replace(/[^a-zA-Z0-9_]/g, "_");
    let candidate = (/^[a-z]/.test(raw) ? "" : "s_") + raw;
    if (candidate.length > 48) candidate = `${candidate.slice(0, 39)}_${fnv(raw)}`;
    if (!SETTING_KEY_RE.test(candidate)) candidate = `s_${fnv(raw)}`;
    return candidate;
  };
  const settingRows = new Map(); // "<namespace>.<key>" → { namespace, key, data, aisKey, kind, scope, value, declaration }
  const settingByAisKey = new Map();
  const pendingRegistrations = [];
  let settingsSynced = false;
  const CHOICE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  const declarationFor = (namespace, key, data) => {
    const aisKey = aisSettingKey(namespace, key);
    const scope = data.scope === "world" ? "world" : "device";
    const label = shortText(i18n.localize(data.name ?? key) || key, 48) || key;
    const hint = data.hint ? shortText(i18n.localize(data.hint), 160) : undefined;
    const hidden = data.config === false;
    const type = data.type;
    const base = { key: aisKey, scope, label, ...(hint ? { hint } : {}), ...(hidden ? { hidden: true } : {}) };
    if (type === Boolean) return { kind: "boolean", declaration: { ...base, type: "boolean", default: data.default === true } };
    if (type === Number) {
      const range = data.range && Number.isFinite(data.range.min) && Number.isFinite(data.range.max) && data.range.min <= data.range.max ? data.range : null;
      let fallback = Number.isFinite(data.default) ? data.default : (range ? range.min : 0);
      if (range) fallback = Math.min(range.max, Math.max(range.min, fallback));
      const step = range && Number.isFinite(range.step) && range.step > 0 && Math.abs((fallback - range.min) / range.step - Math.round((fallback - range.min) / range.step)) < 1e-9 ? range.step : null;
      return { kind: "number", declaration: { ...base, type: "number", default: fallback,
        ...(range ? { min: range.min, max: range.max, ...(step ? { step } : {}) } : {}) } };
    }
    if (type === String) {
      const choices = isPlainObject(data.choices) ? Object.entries(data.choices) : [];
      if (choices.length >= 2 && choices.length <= 32 && choices.every(([value]) => CHOICE_VALUE_RE.test(value))) {
        const values = choices.map(([value, text]) => ({ value, label: shortText(i18n.localize(String(text)) || value, 48) || value }));
        const fallback = values.some((row) => row.value === data.default) ? data.default : values[0].value;
        return { kind: "choice", declaration: { ...base, type: "choice", default: fallback, choices: values } };
      }
      return { kind: "string", declaration: { ...base, type: "string", default: typeof data.default === "string" ? data.default.slice(0, 16384) : "", maxLength: 16384 } };
    }
    // Object / Array / DataModel / unspecified → JSON text in a hidden string setting.
    let fallback = data.default;
    if (fallback && typeof fallback.toObject === "function") fallback = fallback.toObject();
    else if (typeof fallback === "function") { try { fallback = new fallback(); } catch { fallback = {}; } }
    if (fallback === undefined && isDataModelClass(type)) { try { fallback = new type({}, { strict: false }).toObject(); } catch { fallback = {}; } }
    if (fallback === undefined) fallback = type === Array ? [] : {};
    let text;
    try { text = JSON.stringify(fallback); } catch { text = "{}"; }
    if (typeof text !== "string") text = "null";
    return { kind: "json", declaration: { ...base, hidden: true, type: "string", default: text.slice(0, 16384), maxLength: 16384 } };
  };
  /** D-484: `type: SomeDataModel` settings travel as the model's source JSON and come back as instances. */
  let dataModelCheck = null; // bound once the UI layer (which owns foundry.abstract.DataModel) is installed below
  const isDataModelClass = (type) => typeof dataModelCheck === "function" && dataModelCheck(type);
  const decodeSetting = (row, raw) => {
    if (row.kind !== "json") return raw;
    let value;
    try { value = JSON.parse(raw); } catch { value = clone(row.data.default) ?? {}; }
    if (isDataModelClass(row.data.type)) { try { return new row.data.type(value && typeof value === "object" ? value : {}, { strict: false }); } catch { return value; } }
    return value;
  };
  const encodeSetting = (row, value) => {
    if (row.kind !== "json") return value;
    const source = value && typeof value.toObject === "function" ? value.toObject() : value;
    const text = JSON.stringify(source === undefined ? null : source);
    if (text.length > 16384) throw new Error(`Setting ${row.namespace}.${row.key} exceeds the 16 KiB JSON cap`);
    return text;
  };
  const settingsMenus = new Map();
  const settings = {
    /** Foundry exposes the registry as a Map keyed by "<namespace>.<key>". */
    settings: settingRows,
    menus: settingsMenus,
    storage: new Map([["client", { getItem: () => null }], ["world", { get: () => undefined }]]),
    register(namespace, key, data = {}) {
      if (typeof namespace !== "string" || typeof key !== "string" || !namespace || !key) throw new Error("game.settings.register needs a namespace and a key");
      const full = `${namespace}.${key}`;
      if (settingRows.has(full)) throw new Error(`Setting ${full} is already registered`);
      const { kind, declaration } = declarationFor(namespace, key, data);
      const row = { namespace, key, data, aisKey: declaration.key, kind, scope: declaration.scope, declaration,
        value: decodeSetting({ kind, data }, declaration.default), synced: false };
      settingRows.set(full, row); settingByAisKey.set(declaration.key, row);
      const registration = AIS.settings.register(declaration).then(() => { row.synced = true; }).catch((error) => {
        warn(`Setting ${full} stays in-memory only: ${error instanceof Error ? error.message : String(error)}`);
      });
      pendingRegistrations.push(registration);
      if (settingsSynced) void registration.then(() => AIS.settings.get(declaration.key)).then((value) => { if (row.synced) row.value = decodeSetting(row, value); }).catch(() => undefined);
    },
    registerMenu(namespace, key, data = {}) { settingsMenus.set(`${namespace}.${key}`, data); },
    get(namespace, key) {
      const row = settingRows.get(`${namespace}.${key}`);
      if (!row) throw new Error(`This is not a registered game setting: ${namespace}.${key}`);
      return isDataModelClass(row.data.type) && row.value && typeof row.value.clone === "function" ? row.value.clone() : clone(row.value);
    },
    async set(namespace, key, value) {
      const row = settingRows.get(`${namespace}.${key}`);
      if (!row) throw new Error(`This is not a registered game setting: ${namespace}.${key}`);
      if (typeof row.data.type === "function" && [Boolean, Number, String].includes(row.data.type)) value = row.data.type(value);
      // D-484: DataModel-typed settings accept an instance or its source; invalid source throws like Foundry's strict construction.
      else if (isDataModelClass(row.data.type) && !(value instanceof row.data.type)) value = new row.data.type(value && typeof value === "object" ? (typeof value.toObject === "function" ? value.toObject() : value) : {});
      const previous = row.value;
      row.value = clone(value);
      await Promise.all(pendingRegistrations);
      if (row.synced) {
        try { await AIS.settings.set(row.aisKey, encodeSetting(row, value)); }
        catch (error) { row.value = previous; throw error; }
      }
      if (typeof row.data.onChange === "function") { try { row.data.onChange(clone(row.value)); } catch (error) { console.error(error); } }
      return clone(row.value);
    },
  };
  const syncSettings = async () => {
    await Promise.all(pendingRegistrations);
    try {
      const listed = await AIS.settings.list();
      for (const entry of listed.settings) {
        const row = settingByAisKey.get(entry.key);
        if (row && row.synced) row.value = decodeSetting(row, entry.value);
      }
    } catch (error) { warn(`Settings could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    settingsSynced = true;
    AIS.settings.onChange(({ key, value }) => {
      const row = settingByAisKey.get(key);
      if (!row) return;
      const next = decodeSetting(row, value);
      if (JSON.stringify(next) === JSON.stringify(row.value)) return;
      row.value = next;
      if (typeof row.data.onChange === "function") { try { row.data.onChange(clone(next)); } catch (error) { console.error(error); } }
    });
  };

  // ── Notifications: ui.notifications → the shell's notice line, GM device. ──
  let notificationId = 0;
  const notify = (level) => (message, options = {}) => {
    const text = options.localize ? i18n.localize(String(message)) : String(message);
    const row = { id: ++notificationId, message: text, type: level, active: true, remove() { this.active = false; }, update() {} };
    void AIS.ui.notify(shortText(text, 240), level === "warning" ? "warn" : level === "error" ? "error" : "info").catch((error) => console.warn(error));
    if (options.console !== false) console[level === "error" ? "error" : level === "warning" ? "warn" : "info"](`Foundry | ${text}`);
    return row;
  };
  globalThis.ui = {
    notifications: { info: notify("info"), warn: notify("warning"), error: notify("error"), notify: (message, type = "info", options) => notify(type)(message, options),
      success: notify("info"), clear() {}, render() {}, active: [] },
    windows: {}, sidebar: { tabs: {}, render() {} }, controls: { controls: [], render() {} }, hotbar: { render() {} },
    chat: { render() {} }, players: { render() {} }, nav: { render() {} }, menu: { render() {} },
  };

  // ── D-485: world documents over the kernel's generic document service (documents.js, loaded before this file). ──
  const documentsLayer = globalThis.__aisFoundryDocuments.install({ AIS, Hooks: globalThis.Hooks, warn, clone, flattenObject, expandObject, getProperty, mergeObject,
    Collection, game: () => globalThis.game });
  const Document = documentsLayer.AISDocument;
  const documentClasses = { ...documentsLayer.classes };
  // Scene/placeable/other documents still only exist for `extends`/`instanceof` (scene services stay dedicated; slice 2).
  for (const name of ["Scene", "TokenDocument", "Cards", "Setting", "AmbientLightDocument", "AmbientSoundDocument", "TileDocument",
    "WallDocument", "DrawingDocument", "MeasuredTemplateDocument", "NoteDocument", "RegionDocument", "RegionBehavior", "Adventure", "FogExploration"])
    documentClasses[name] = stubClass(name, Document);
  for (const [name, klass] of Object.entries(documentClasses)) globalThis[name] = klass;
  // Chat messages are host-stamped: `ChatMessage.create({ content })` posts through the chat service as this user.
  const postChat = async (data = {}) => {
    const content = String(data.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!content) throw new Error("ChatMessage.create needs content");
    await AIS.chat.post(content.slice(0, 2000));
    return new documentClasses.ChatMessage({ content: data.content ?? "", flags: data.flags ?? {}, speaker: data.speaker ?? {} }, { fromSource: true });
  };
  documentClasses.ChatMessage.create = postChat;
  documentClasses.ChatMessage.createDocuments = async (rows = []) => { const out = []; for (const row of rows) out.push(await postChat(row)); return out; };
  documentClasses.ChatMessage.getSpeaker = ({ actor, token, alias } = {}) => ({ actor: actor?.id ?? null, token: token?.id ?? null, alias: alias ?? actor?.name ?? null, scene: null });
  documentClasses.ChatMessage.applyRollMode = (data) => data;
  const PlaceableObject = stubClass("PlaceableObject");
  globalThis.PlaceableObject = PlaceableObject;
  for (const name of ["Token", "Tile", "Drawing", "Wall", "AmbientLight", "AmbientSound", "MeasuredTemplate", "Note", "Region"])
    globalThis[name] = stubClass(name, PlaceableObject);
  // ── D-483: Foundry application UI (hbs.js + jq.js + ui.js, loaded before this file). ──
  const resourceText = new Map();
  const Handlebars = globalThis.__aisFoundryHbs.create();
  const $ = globalThis.__aisFoundryJq.create(document);
  const uiLayer = globalThis.__aisFoundryUi.install({ AIS, game: null, Hooks: globalThis.Hooks, i18n, warn, resources: resourceText, foundryId, Handlebars, $,
    utils: { mergeObject, expandObject, getProperty, escapeHTML } });
  const { Application, FormApplication, DocumentSheet, Dialog, Tabs, FormDataExtended, ApplicationV2, HandlebarsApplicationMixin, DocumentSheetV2, DialogV2,
    renderTemplate, loadTemplates, getTemplate } = uiLayer;
  globalThis.ui.windows = uiLayer.ui.windows;
  Object.defineProperty(globalThis.ui, "activeWindow", { configurable: true, get: () => uiLayer.ui.activeWindow, set: (value) => { uiLayer.ui.activeWindow = value; } });
  Object.assign(globalThis, { Application, FormApplication, DocumentSheet, Dialog, Tabs, FormDataExtended, Handlebars, renderTemplate, loadTemplates, getTemplate, $, jQuery: $,
    ActorSheet: stubClass("ActorSheet", DocumentSheet), ItemSheet: stubClass("ItemSheet", DocumentSheet),
    TokenConfig: stubClass("TokenConfig", DocumentSheet), SidebarTab: stubClass("SidebarTab", Application),
    ContextMenu: stubClass("ContextMenu"), Draggable: stubClass("Draggable"), SearchFilter: stubClass("SearchFilter"),
    FilePicker: stubClass("FilePicker", Application), SettingsConfig: stubClass("SettingsConfig", FormApplication),
    KeybindingsConfig: stubClass("KeybindingsConfig", FormApplication), Roll: stubClass("Roll"), Collection,
    fromUuid: async (uuid) => fromUuidSync(uuid), fromUuidSync: (uuid) => fromUuidSync(uuid),
    duplicate, mergeObject, getProperty, setProperty, hasProperty, expandObject, flattenObject, isNewerVersion, debounce,
  });
  function fromUuidSync(uuid) {
    const parts = String(uuid).split(".");
    if (parts[0] === "Scene" && currentView?.scene.id === parts[1]) {
      if (parts.length === 2) return currentView.scene;
      const key = Object.keys(types).find((key) => types[key] === parts[2]);
      return key ? currentView.scene[key].get(parts[3]) ?? null : null;
    }
    return documentsLayer.fromUuidSync(uuid);
  }
  globalThis.foundry = {
    utils: { getProperty, setProperty, hasProperty, mergeObject, expandObject, flattenObject, isNewerVersion, deepClone: clone, duplicate, randomID,
      debounce, escapeHTML, isEmpty: (value) => value === undefined || value === null || (typeof value === "object" && Object.keys(value).length === 0) || value === "",
      getType: (value) => value === null ? "null" : Array.isArray(value) ? "Array" : typeof value === "object" ? value.constructor?.name ?? "Object" : typeof value,
      fetchJsonWithTimeout: () => unsupportedCall("foundry.utils.fetchJsonWithTimeout (network access)"),
      diffObject: (original, other) => Object.fromEntries(Object.entries(flattenObject(other)).filter(([key, value]) => JSON.stringify(getProperty(original, key)) !== JSON.stringify(value))),
      invertObject: (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [value, key])),
      timeSince: () => "", formatFileSize: (bytes) => `${bytes} B`, Collection, parseUuid: (uuid) => ({ uuid, id: String(uuid).split(".").pop() }),
      Semaphore: class { constructor(max = 1) { this.max = max; } add(fn, ...args) { return Promise.resolve().then(() => fn(...args)); } } },
    applications: { api: { ApplicationV2, DialogV2, HandlebarsApplicationMixin, DocumentSheetV2, Application, FormApplication, DocumentSheet, Dialog },
      fields: uiLayer.fields ? uiLayer.fields.applications : {},
      sheets: { ActorSheetV2: stubClass("ActorSheetV2", DocumentSheetV2), ItemSheetV2: stubClass("ItemSheetV2", DocumentSheetV2) },
      handlebars: { loadTemplates, renderTemplate, getTemplate },
      ux: { ContextMenu: globalThis.ContextMenu, Draggable: globalThis.Draggable, SearchFilter: globalThis.SearchFilter, Tabs, FormDataExtended,
        TextEditor: { enrichHTML: async (html) => String(html ?? ""), implementation: { enrichHTML: async (html) => String(html ?? "") } } },
      apps: { FilePicker: globalThis.FilePicker }, ui: { Notifications: stubClass("Notifications") }, instances: uiLayer.instances },
    documents: { ...documentClasses, collections: { WorldCollection: documentsLayer.WorldCollection, ...Object.fromEntries(["Actors", "Items", "Journal", "RollTables", "Macros", "Folders",
      "Playlists", "CombatEncounters", "Users", "Messages"].map((name) => [name, documentsLayer.WorldCollection])) }, abstract: { Document } },
    canvas: { placeables: { Token: globalThis.Token, Tile: globalThis.Tile, Drawing: globalThis.Drawing, Wall: globalThis.Wall, AmbientLight: globalThis.AmbientLight,
      AmbientSound: globalThis.AmbientSound, MeasuredTemplate: globalThis.MeasuredTemplate, Note: globalThis.Note, Region: globalThis.Region }, layers: {} },
    abstract: { DataModel: uiLayer.fields ? uiLayer.fields.DataModel : stubClass("DataModel"), TypeDataModel: uiLayer.fields ? uiLayer.fields.TypeDataModel : stubClass("TypeDataModel"), Document },
    data: { fields: uiLayer.fields ? uiLayer.fields.fields : {}, validation: uiLayer.fields ? uiLayer.fields.validation : {} },
    dice: { Roll: globalThis.Roll },
    helpers: { Hooks: globalThis.Hooks, Localization: stubClass("Localization") },
    CONST: null,
  };
  globalThis.CONST = {
    KEYBINDING_PRECEDENCE: { PRIORITY: 0, NORMAL: 1, DEFERRED: 2 },
    USER_ROLES: { NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 }, USER_ROLE_NAMES: { 0: "NONE", 1: "PLAYER", 2: "TRUSTED", 3: "ASSISTANT", 4: "GAMEMASTER" },
    DOCUMENT_OWNERSHIP_LEVELS: { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
    CHAT_MESSAGE_STYLES: { OTHER: 0, OOC: 1, IC: 2, EMOTE: 3 }, CHAT_MESSAGE_TYPES: { OTHER: 0, OOC: 1, IC: 2, EMOTE: 3, WHISPER: 4, ROLL: 5 },
    TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 }, GRID_TYPES: { GRIDLESS: 0, SQUARE: 1, HEXODDR: 2, HEXEVENR: 3, HEXODDQ: 4, HEXEVENQ: 5 },
    WALL_SENSE_TYPES: { NONE: 0, LIMITED: 10, NORMAL: 20, PROXIMITY: 30, DISTANCE: 40 }, WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    DOCUMENT_TYPES: Object.keys(documentClasses), SOFTWARE_UPDATE_CHANNELS: {}, ASCII: "ArenaStar AIS Foundry profile",
    // D-484: the enumerations modules turn into form choices (`foundry.utils.invertObject(CONST.X)`).
    TOKEN_DISPLAY_MODES: { NONE: 0, CONTROL: 10, OWNER_HOVER: 20, HOVER: 30, OWNER: 40, ALWAYS: 50 },
    TOKEN_TURN_MARKER_MODES: { DISABLED: 0, DEFAULT: 1, CUSTOM: 2 },
    TOKEN_SHAPES: { ELLIPSE_1: 0, ELLIPSE_2: 1, TRAPEZOID_1: 2, TRAPEZOID_2: 3, RECTANGLE_1: 4, RECTANGLE_2: 5 },
    ACTIVE_EFFECT_MODES: { CUSTOM: 0, MULTIPLY: 1, ADD: 2, DOWNGRADE: 3, UPGRADE: 4, OVERRIDE: 5 },
    DICE_ROLL_MODES: { PUBLIC: "publicroll", PRIVATE: "gmroll", BLIND: "blindroll", SELF: "selfroll" },
    MACRO_TYPES: { SCRIPT: "script", CHAT: "chat" }, MACRO_SCOPES: ["global", "actors", "actor"],
    MEASURED_TEMPLATE_TYPES: { CIRCLE: "circle", CONE: "cone", RECTANGLE: "rect", RAY: "ray" },
    DRAWING_FILL_TYPES: { NONE: 0, SOLID: 1, PATTERN: 2 }, TEXT_ANCHOR_POINTS: { CENTER: 0, BOTTOM: 1, TOP: 2, LEFT: 3, RIGHT: 4 },
    WALL_DIRECTIONS: { BOTH: 0, LEFT: 1, RIGHT: 2 }, WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 }, WALL_RESTRICTION_TYPES: ["light", "sight", "sound", "move"],
    PLAYLIST_MODES: { DISABLED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 }, PLAYLIST_SORT_MODES: { ALPHABETICAL: "a", MANUAL: "m" },
    TABLE_RESULT_TYPES: { TEXT: "text", DOCUMENT: "document", COMPENDIUM: "pack" }, FOLDER_MAX_DEPTH: 4, FOLDER_DOCUMENT_TYPES: ["Actor", "Item", "Scene", "JournalEntry", "Playlist", "RollTable", "Cards", "Macro", "Compendium"],
    LIGHTING_LEVELS: { DARKNESS: -2, HALFDARK: -1, UNLIT: 0, DIM: 1, BRIGHT: 2, BRIGHTEST: 3 },
    CANVAS_PERFORMANCE_MODES: { LOW: 0, MED: 1, HIGH: 2, MAX: 3 },
    DEFAULT_TOKEN: "icons/svg/mystery-man.svg", DEFAULT_MACRO_ICON: "icons/svg/dice-target.svg",
    USER_PERMISSIONS: { ACTOR_CREATE: { label: "Create Actors", defaultRole: 3 }, BROADCAST_AUDIO: { label: "Broadcast Audio", defaultRole: 2 }, SETTINGS_MODIFY: { label: "Modify Settings", defaultRole: 3 }, TOKEN_CREATE: { label: "Create Tokens", defaultRole: 3 } },
    WORLD_DOCUMENT_TYPES: ["Actor", "Cards", "ChatMessage", "Combat", "FogExploration", "Folder", "Item", "JournalEntry", "Macro", "Playlist", "RollTable", "Scene", "Setting", "User"],
    COMPENDIUM_DOCUMENT_TYPES: ["Actor", "Adventure", "Cards", "Item", "JournalEntry", "Macro", "Playlist", "RollTable", "Scene"],
    PRIMARY_DOCUMENT_TYPES: ["Actor", "Adventure", "Cards", "ChatMessage", "Combat", "FogExploration", "Folder", "Item", "JournalEntry", "Macro", "Playlist", "RollTable", "Scene", "Setting", "User"],
    EMBEDDED_DOCUMENT_TYPES: ["ActiveEffect", "ActorDelta", "AmbientLight", "AmbientSound", "Card", "Combatant", "Drawing", "Item", "JournalEntryPage", "MeasuredTemplate", "Note", "PlaylistSound", "Region", "RegionBehavior", "TableResult", "Tile", "Token", "Wall"],
    CORE_SUPPORTED_LANGUAGES: ["en"], SYSTEM_SPECIFIC_COMPENDIUM_TYPES: ["Actor", "Item"],
    TOKEN_HEXAGONAL_SHAPES: { ELLIPSE_1: 0, ELLIPSE_2: 1, TRAPEZOID_1: 2, TRAPEZOID_2: 3, RECTANGLE_1: 4, RECTANGLE_2: 5 },
    REGION_VISIBILITY: { LAYER: 0, GAMEMASTER: 1, ALWAYS: 2 }, REGION_EVENTS: { BEHAVIOR_ACTIVATED: "behaviorActivated", TOKEN_ENTER: "tokenEnter", TOKEN_EXIT: "tokenExit", TOKEN_MOVE_IN: "tokenMoveIn", TOKEN_MOVE_OUT: "tokenMoveOut" },
  };
  // D-484: document type lists modules iterate (`Actor.TYPES.forEach(...)`, `game.documentTypes`).
  const documentTypes = { Actor: ["base", "character", "npc"], Item: ["base"], JournalEntryPage: ["text", "image", "pdf", "video"], Cards: ["deck", "hand", "pile"], Macro: ["script", "chat"], ChatMessage: ["base"], Combatant: ["base"], ActiveEffect: ["base"], RegionBehavior: ["base"], Card: ["base"], TableResult: ["base"] };
  for (const [name, types] of Object.entries(documentTypes)) {
    const klass = documentClasses[name];
    if (klass && !Object.hasOwn(documentsLayer.classes, name)) { Object.defineProperty(klass, "TYPES", { configurable: true, get: () => [...types] }); Object.defineProperty(klass, "documentName", { configurable: true, value: name }); }
  }
  if (uiLayer.fields) dataModelCheck = uiLayer.fields.isDataModelClass;
  globalThis.foundry.CONST = globalThis.CONST;
  globalThis.CONFIG = { debug: { hooks: false }, compatibility: { mode: 0 }, ui: {}, Canvas: { layers: {} }, TextEditor: { enrichers: [] },
    statusEffects: [], specialStatusEffects: {}, controlIcons: {}, sounds: {}, fontDefinitions: {}, Dice: { rolls: [globalThis.Roll], terms: {} },
    ...Object.fromEntries(Object.keys(documentClasses).map((name) => [name.replace(/Document$/, ""), { documentClass: documentClasses[name], sheetClasses: {}, typeLabels: {}, dataModels: {} }])) };

  // ── game ──
  const user = { id: "gm", _id: "gm", name: "GM", isGM: true, isSelf: true, role: 4, active: true, character: null, color: "#e0b341",
    targets: new Set(), viewedScene: null, flags: {}, getFlag: () => undefined, setFlag: () => unsupportedCall("User#setFlag (document CRUD; R-02)"),
    can: () => true, hasRole: () => true, hasPermission: () => true, isTrusted: true, documentName: "User" };
  const selfModule = { id: foundryId, title: dist.title ?? foundryId, version: dist.version ?? "", active: true, api: undefined, socket: dist.socket === true,
    esmodules: new Set(dist.esmodules), scripts: new Set(dist.scripts), styles: new Set(dist.styles), languages: dist.languages, packs: dist.packs,
    flags: { ais: { packageId: context.packageId, sourceHash: context.sourceHash, runtimeHash: context.runtimeHash } },
    compatibility: {}, relationships: { systems: dist.systems, requires: dist.requires }, library: false };
  const modules = new Collection([selfModule, { id: "sequencer", title: "Sequencer (ArenaStar transient FX substitute)", version: "0.0.0", active: true,
    flags: { ais: { substitute: "transient-text-image-sound-v1" } } }]);
  const emptyCollection = (name) => { const c = new Collection([]); c.documentName = name; c.projected = false; return c; };
  const socketListeners = new Map();
  const keybindingActions = new Map();
  const game = {
    version: "13.346", release: { generation: 13, build: 346, version: "13.346", maxGeneration: 13, maxStableGeneration: 13 }, data: { version: "13.346", release: { generation: 13 } }, documentTypes,
    // D-485: `game.user` is this device's User document once the replica is hydrated; the frozen GM row only bridges boot.
    get user() { return documentsLayer.me() ?? user; }, get userId() { return documentsLayer.userId() ?? user.id; },
    users: documentsLayer.collections.users, ready: false, paused: false, debug: false,
    world: { id: "arenastar", title: "ArenaStar world", system: "arenastar", version: "0.0.0" },
    // Deliberately NOT a Foundry system id: modules that need `pf1` must say so and stay inert.
    system: { id: "arenastar", title: "ArenaStar VTT", version: "0.0.0", data: { version: "0.0.0" }, documentTypes: {}, template: {}, flags: {} },
    modules, i18n, settings,
    scenes: emptyCollection("Scene"), actors: documentsLayer.collections.actors, items: documentsLayer.collections.items, journal: documentsLayer.collections.journals,
    tables: documentsLayer.collections.rollTables, macros: documentsLayer.collections.macros, playlists: documentsLayer.collections.playlists,
    combats: documentsLayer.collections.combats, folders: documentsLayer.collections.folders, messages: documentsLayer.collections.messages,
    packs: emptyCollection("CompendiumCollection"), cards: emptyCollection("Cards"),
    get combat() { return documentsLayer.collections.combats.find((row) => (row._source.round ?? 0) > 0) ?? null; },
    get canvas() { return globalThis.canvas; },
    time: { worldTime: 0, serverTime: Date.now(), advance: () => unsupportedCall("game.time.advance (world clock; R-02)") },
    keyboard: { isModifierActive: () => false, downKeys: new Set() }, mouse: {},
    keybindings: { actions: keybindingActions, bindings: new Map(),
      register: (namespace, action, definition) => { bindings.set(`${namespace}.${action}`, definition); keybindingActions.set(`${namespace}.${action}`, definition); },
      get: (namespace, action) => bindings.get(`${namespace}.${action}`)?.editable ?? [], set: async () => undefined },
    socket: { on: (event, handler) => { socketListeners.set(event, handler); }, off: (event) => { socketListeners.delete(event); },
      emit: () => unsupportedCall("game.socket.emit (cross-device module socket; R-06)") },
    audio: { play: () => unsupportedCall("game.audio.play (audio; R-07)"), pending: [] },
    video: {}, tooltip: { activate() {}, deactivate() {} }, clipboard: {}, tours: { register() {} }, issues: { usabilityIssues: {} },
    togglePause: () => unsupportedCall("game.togglePause"), activeTool: "select",
  };
  globalThis.game = game;
  Object.defineProperty(globalThis, "canvas", { configurable: true, get: () => {
    const scene = currentView?.scene;
    const layer = (key) => ({ name: key, placeables: scene ? scene[key].contents : [], get: (id) => scene?.[key].get(id), controlled: [], active: false,
      get documentCollection() { return scene?.[key]; } });
    return { ready: !!scene, id: scene?.id, scene, dimensions: scene?.dimensions, grid: scene?.grid,
      tokens: layer("tokens"), lighting: layer("lights"), sounds: layer("sounds"), templates: layer("templates"), tiles: layer("tiles"),
      walls: layer("walls"), drawings: layer("drawings"), notes: layer("notes"), regions: layer("regions"),
      stage: { addChild: () => unsupportedCall("canvas.stage (the host PIXI renderer)") },
      get app() { return unsupportedCall("canvas.app (the host PIXI renderer)"); },
      draw: () => unsupportedCall("canvas.draw"), pan: async () => undefined, animatePan: async () => undefined, hud: {}, perception: { update() {} } };
  } });
  const refreshScene = async () => {
    await hydrate(AIS);
    game.scenes = new Collection([currentView.scene]);
    game.scenes.active = currentView.scene; game.scenes.current = currentView.scene; game.scenes.viewed = currentView.scene; game.scenes.projected = true;
    user.viewedScene = currentView.scene.id;
  };

  // ── The loader: resources → blobs → import map → classic scripts → ES modules → lifecycle hooks. ──
  const readAll = async (paths) => {
    const queue = [...paths];
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) resourceText.set(path, await AIS.resources.readText(path));
    };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  };
  const blobUrl = (text, type) => URL.createObjectURL(new Blob([text], { type }));
  const loadLanguages = () => {
    const ordered = [...dist.languages].sort((a, b) => (a.lang === "en" ? -1 : b.lang === "en" ? 1 : 0));
    for (const language of ordered) {
      const text = resourceText.get(language.path);
      if (text === undefined) continue;
      try { mergeObject(translations, expandObject(JSON.parse(text))); diagnostics.languages.push(language.lang); }
      catch (error) { warn(`Language file ${language.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
      if (language.lang === "en") break;
    }
  };
  const installStyles = () => {
    for (const path of dist.styles) {
      const text = resourceText.get(path);
      if (text === undefined) continue;
      const style = document.createElement("style"); style.dataset.foundryStyle = path; style.textContent = text;
      document.head.appendChild(style); diagnostics.styles.push(path);
    }
  };
  const installImportMap = () => {
    const imports = {};
    for (const path of dist.files) {
      if (!/\.m?js$/i.test(path)) continue;
      const text = resourceText.get(path);
      if (text === undefined) continue;
      imports[`ais-foundry://${context.packageId}/${path}`] = blobUrl(text, "text/javascript");
    }
    const map = document.createElement("script"); map.type = "importmap"; map.textContent = JSON.stringify({ imports });
    document.head.appendChild(map);
    return imports;
  };
  const runClassicScript = (path, url) => new Promise((resolve, reject) => {
    const script = document.createElement("script"); script.src = url; script.async = false;
    script.onload = () => resolve(); script.onerror = () => reject(new Error(`Classic script ${path} failed to load`));
    document.head.appendChild(script);
  });
  const loadModules = async (imports) => {
    for (const path of dist.scripts) {
      const url = imports[`ais-foundry://${context.packageId}/${path}`];
      if (!url) throw new Error(`Script ${path} is missing from the distribution`);
      await runClassicScript(path, url);
      diagnostics.loaded.push({ path, kind: "script" });
    }
    for (const path of dist.esmodules) {
      const url = imports[`ais-foundry://${context.packageId}/${path}`];
      if (!url) throw new Error(`ES module ${path} is missing from the distribution`);
      try { await import(/* @vite-ignore */ url); }
      catch (error) { throw new Error(`Foundry module ${foundryId}: ${path} failed — ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`, { cause: error }); }
      diagnostics.loaded.push({ path, kind: "esmodule" });
    }
  };
  const jsonSafe = (value, depth = 0) => {
    if (depth > 8) return "[depth]";
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
    if (typeof value?.toObject === "function") return jsonSafe(value.toObject(), depth + 1);
    if (value instanceof Map) return jsonSafe([...value.values()], depth + 1);
    if (value instanceof Set) return jsonSafe([...value], depth + 1);
    if (Array.isArray(value)) return value.slice(0, 256).map((item) => jsonSafe(item, depth + 1));
    if (typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value).slice(0, 128)) out[key] = jsonSafe(item, depth + 1);
      return out;
    }
    return String(value);
  };
  const FORBIDDEN_ROOTS = new Set(["AIS", "eval", "Function", "globalThis", "window", "self", "parent", "top", "document", "fetch", "XMLHttpRequest",
    "WebSocket", "postMessage", "importScripts", "localStorage", "sessionStorage", "indexedDB", "location", "navigator", "history", "open"]);
  const resolveApiPath = (path) => {
    const parts = safeParts(path);
    if (FORBIDDEN_ROOTS.has(parts[0])) throw new Error(`foundry.api cannot reach ${parts[0]}`);
    let holder = globalThis, value = globalThis;
    for (const part of parts) { holder = value; value = value?.[part]; }
    if (value === undefined) {
      // `game.modules.get(id).api.<fn>` is Foundry's conventional module API surface.
      const api = selfModule.api;
      holder = api; value = api;
      for (const part of parts) { holder = value; value = value?.[part]; }
      if (value === undefined) throw new Error(`foundry.api: ${path} is not defined by ${foundryId}`);
    }
    return { holder, value };
  };

  globalThis.FoundryAdapter = Object.freeze({
    info: () => ({ profile: context.profile, foundryId, packageId: context.packageId, title: selfModule.title, version: selfModule.version,
      runtimeHash: context.runtimeHash, systemId: game.system.id, declaredSystems: dist.systems, declaredRequires: dist.requires, socket: dist.socket === true,
      loaded: diagnostics.loaded, styles: diagnostics.styles, languages: diagnostics.languages, unresolvedImports: dist.unresolved ?? [],
      settings: [...settingRows.values()].map((row) => ({ key: `${row.namespace}.${row.key}`, aisKey: row.aisKey, scope: row.scope, kind: row.kind, synced: row.synced, hidden: row.declaration.hidden === true })),
      keybindings: [...bindings.keys()], socketListeners: [...socketListeners.keys()], hookNames: [...hooks.keys()], hookErrors,
      warnings: diagnostics.warnings, unsupportedCalls: diagnostics.unsupportedCalls, moduleApi: selfModule.api ? Object.keys(selfModule.api) : [],
      globals: diagnostics.globals ?? [], loadMs: diagnostics.loadMs ?? null, ready: game.ready,
      windows: uiLayer.describeWindows(), menus: [...settingsMenus].map(([key, menu]) => ({ key, name: menu.name ?? "", label: menu.label ?? "", type: menu.type?.name ?? null, restricted: menu.restricted === true })),
      templates: uiLayer.describeTemplates ? uiLayer.describeTemplates() : { count: uiLayer.templateCount() },
      documents: diagnostics.documents?.error ? diagnostics.documents : documentsLayer.describe() }),
  });

  AIS.commands.on("foundry.info", async () => FoundryAdapter.info());
  // Arguments are JSON; "@uuid:Scene.<id>.Token.<id>" strings (also inside arrays) become the projected documents.
  const materialize = (value, depth = 0) => {
    if (typeof value === "string" && value.startsWith("@uuid:")) {
      const document = fromUuidSync(value.slice(6));
      if (!document) throw new Error(`foundry.api: ${value.slice(6)} is not in the projected scene`);
      return document;
    }
    if (Array.isArray(value) && depth < 2) return value.map((item) => materialize(item, depth + 1));
    return value;
  };
  AIS.commands.on("foundry.api", async (input) => {
    if (!input || typeof input.path !== "string") throw new Error("foundry.api needs { path: \"Global.member\", args?: [] }");
    await refreshScene();
    const args = (Array.isArray(input.args) ? input.args : []).map((arg) => materialize(arg));
    const { holder, value } = resolveApiPath(input.path);
    const result = typeof value === "function" ? await value.apply(holder, args) : value;
    return jsonSafe(result);
  });

  // D-483: open a Foundry window from the shell — a registered settings menu or any Application class the module defined.
  AIS.commands.on("foundry.ui", async (input) => {
    if (!input || (typeof input.menu !== "string" && typeof input.app !== "string")) throw new Error("foundry.ui needs { menu: \"<namespace>.<key>\" } or { app: \"Global.Class\", args?: [] }");
    await refreshScene();
    let app;
    if (typeof input.menu === "string") app = uiLayer.openMenu(input.menu, settingsMenus).app;
    else {
      const { value } = resolveApiPath(input.app);
      if (typeof value !== "function" || typeof value.prototype?.render !== "function") throw new Error(`foundry.ui: ${input.app} is not an Application class`);
      const args = (Array.isArray(input.args) ? input.args : []).map((arg) => materialize(arg));
      app = new value(...args);
      app.render(true);
    }
    if (app instanceof ApplicationV2) await app.render(true);
    else await new Promise((resolve) => setTimeout(resolve, 0));
    return { ...app.toObject(), windows: uiLayer.describeWindows() };
  });

  AIS.runtime.initialize(async () => {
    const started = performance.now();
    // D-485: the document replica hydrates alongside the module's own files; a missing grant degrades to empty collections.
    const hydrateDocuments = documentsLayer.hydrate().then((row) => { diagnostics.documents = row; })
      .catch((error) => { diagnostics.documents = { error: String(error?.message ?? error) }; warn(`World documents unavailable: ${error?.message ?? error}`); });
    await Promise.all([readAll(dist.files), hydrateDocuments]);
    loadLanguages();
    installStyles();
    const imports = installImportMap();
    await refreshScene();
    const before = new Set(Object.keys(globalThis));
    await loadModules(imports);
    diagnostics.loadMs = Math.round(performance.now() - started);
    Hooks.callAll("init");
    Hooks.callAll("i18nInit");
    await syncSettings();
    Hooks.callAll("setup");
    game.ready = true;
    Hooks.callAll("ready");
    Hooks.callAll("canvasInit", globalThis.canvas);
    Hooks.callAll("canvasReady", globalThis.canvas);
    // Globals the module installed itself (e.g. `window.Tagger`): the surface `foundry.api` reaches.
    diagnostics.globals = Object.keys(globalThis).filter((key) => !before.has(key)).slice(0, 64);
  });
})();
