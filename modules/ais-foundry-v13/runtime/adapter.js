/* ArenaStar-authored compatibility facade. Runs only INSIDE an approved AIS guest frame.
 * This is a deliberately small API profile, not Foundry core and not the upstream Sequencer.
 * Actual document writes and FX always go through the instance-bound AIS broker.
 */
(function () {
  "use strict";
  const context = AIS.runtime.context;
  if (!context || context.profile !== "foundry-v13-scene-tags-fx") throw new Error("Unsupported adapter profile");
  const config = context.configuration;
  if (!config || typeof config.id !== "string" || typeof config.version !== "string")
    throw new Error("Runtime configuration needs upstream id/version");
  const unsupported = (name) => { throw new Error(`Foundry compatibility profile does not support ${name}`); };
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const safeParts = (path) => {
    const parts = String(path).split(".");
    if (parts.some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("Unsafe property path");
    return parts;
  };
  const getProperty = (object, path) => safeParts(path).reduce((value, key) => value?.[key], object);
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
  const mergeObject = (original, other = {}) => {
    for (const key of Object.keys(other)) {
      safeParts(key);
      const value = other[key];
      if (value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
        if (!original[key] || typeof original[key] !== "object") original[key] = {};
        mergeObject(original[key], value);
      } else original[key] = value;
    }
    return original;
  };
  const isNewerVersion = (left, right) => {
    const a = String(left).split(".").map(Number), b = String(right).split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  };

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
  const dispatch = (name, args, cancellable) => {
    for (const entry of [...(hooks.get(name) || [])]) {
      if (entry.once) off(name, entry.id);
      const result = entry.callback(...args);
      if (cancellable && result === false) return false;
    }
    return true;
  };
  globalThis.Hooks = Object.freeze({ on, off,
    once: (name, callback) => on(name, callback, { once: true }),
    call: (name, ...args) => dispatch(name, args, true),
    callAll: (name, ...args) => { dispatch(name, args, false); },
  });
  // A Foundry convenience extension, installed in this isolated realm only.
  Object.defineProperty(Array.prototype, "deepFlatten", { configurable: true,
    value: function () { return this.flat(Infinity); } });
  globalThis.randomID = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  globalThis.foundry = Object.freeze({ utils: Object.freeze({ getProperty, setProperty, mergeObject, isNewerVersion,
    deepClone: clone, randomID: globalThis.randomID }) });
  globalThis.CONST = Object.freeze({ KEYBINDING_PRECEDENCE: Object.freeze({ PRIORITY: 0 }) });
  globalThis.Actor = function Actor() { unsupported("Actor documents in this scene-only profile"); };
  globalThis.Dialog = function Dialog() { unsupported("Foundry dialog/DOM applications"); };
  globalThis.$ = () => unsupported("Foundry/jQuery configuration forms");

  class Collection {
    constructor(rows = []) { this.rows = new Map(rows.map((row) => [row.id, row])); }
    get(id) { return this.rows.get(id); }
    get contents() { return [...this.rows.values()]; }
    get size() { return this.rows.size; }
    find(fn) { return this.contents.find(fn); }
    filter(fn) { return this.contents.filter(fn); }
    map(fn) { return this.contents.map(fn); }
    [Symbol.iterator]() { return this.rows.values(); }
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
      this.grid = clone(data.grid); this.documentName = "Scene";
    }
    getEmbeddedDocument(type, id) {
      const key = Object.keys(types).find((key) => types[key] === type);
      if (!key) return unsupported(`embedded document ${type}`);
      return this[key].get(id);
    }
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
    getFlag(scope, key) {
      if (scope !== "tagger" || key !== "tags") return unsupported(`flag ${scope}.${key}`);
      return clone(this._data.tags);
    }
    setFlag(scope, key, value) {
      if (scope !== "tagger" || key !== "tags") return unsupported(`flag ${scope}.${key}`);
      return this.update({ "flags.tagger.tags": value });
    }
    unsetFlag(scope, key) { return this.setFlag(scope, key, []); }
    async update(input) {
      if (!this._view.api || !busy || this._view !== currentView) throw new Error("Use the command-scoped adapter invocation API");
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
      const result = await this._view.api.sceneTags.update({ sceneId: this.parent.id, collection: this._collection,
        id: this.id, expectedSeq: this._view.seq, tags });
      this._data.tags = clone(result.tags);
      this._view.seq = result.seq;
      Hooks.callAll(`update${this.documentName}`, this, changed, {}, "gm");
      return this;
    }
    toObject() { return { _id: this.id, name: this.name, flags: this.flags }; }
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

  // A deliberately bounded Sequencer-shaped builder over ArenaStar's EXISTING FX runtime.
  // Unsupported methods fail explicitly; this is not the original Sequencer implementation.
  const namedEffects = new Map();
  const ownEffects = (filter = {}) => {
    if (Object.keys(filter).some((key) => key !== "name")) return unsupported("effect filters other than exact name");
    for (const [id, effect] of namedEffects) if (effect.endsAtHostTime <= Date.now()) namedEffects.delete(id);
    return [...namedEffects.values()].filter((effect) => filter.name === undefined || effect.name === filter.name);
  };
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
      const mapped = config.assets?.[path] ?? path;
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
      if (this.started || !activeApi) throw new Error("FX playback needs a live command-scoped invocation");
      ownEffects();
      this.started = true;
      const duration = Math.max(0, ...this.steps.map((step) => step.startMs + step.durationMs));
      if (Date.now() + duration + 1500 >= activeDeadline) throw new Error("FX timeline cannot finish within this command budget");
      const api = activeApi;
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
        if (!activeApi || typeof filter.name !== "string" || !filter.name) return unsupported("endEffects needs an exact owned name");
        const effects = ownEffects(filter);
        const results = [];
        for (const effect of effects) {
          results.push(await activeApi.fx.stop(effect.runId));
          namedEffects.delete(effect.runId);
        }
        return results;
      },
    }),
  });

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
})();
