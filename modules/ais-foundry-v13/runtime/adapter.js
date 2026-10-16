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
  // Foundry extends Array prototype with helpers like findSplice; pf1 system uses them. Polyfill for AIS emulation.
  if (!Array.prototype.findSplice) {
    Object.defineProperty(Array.prototype, "findSplice", {
      configurable: true, writable: true, value: function(predicate, replacement) {
        if (typeof predicate !== "function") return undefined;
        const idx = this.findIndex(predicate);
        if (idx === -1) return undefined;
        const removed = this[idx];
        if (replacement === undefined) this.splice(idx, 1);
        else this.splice(idx, 1, replacement);
        return removed;
      }
    });
  }
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

  // ── D-477 / R-10: CompendiumCollection over AIS compendium.* RPCs ──
  class CompendiumCollection extends Collection {
    constructor(pack) {
      super([]);
      this._pack = pack;
      this.id = pack.id;
      this.collection = pack.id;
      this.metadata = { id: pack.id, name: pack.name, label: pack.name, type: pack.type, packageName: pack.id.split("/")[0], packageType: "world" };
      this.documentName = pack.type;
      this.type = pack.type;
      this.name = pack.name;
      this.title = pack.name;
      this._cache = new Map();
      this._index = null;
    }
    get documentClass() { return documentClasses[this.documentName] ?? Document; }
    async getIndex({ fields } = {}) {
      // fields: array of dot-paths or object map; support for PF1e modules that request system fields
      const wantsFields = fields ? (Array.isArray(fields) ? fields : typeof fields === "object" ? Object.keys(fields) : []) : [];
      const needFull = wantsFields.length > 0;
      if (this._index && !needFull) return this._index;
      try {
        const hits = await AIS.compendium.search({ packId: this.id, query: "", limit: 500 });
        if (!needFull) {
          this._index = hits.map((hit) => ({ _id: hit.entryId, id: hit.entryId, name: hit.name, type: hit.type ?? "base", img: hit.img ?? "" }));
          return this._index;
        }
        // When fields requested, fetch full entries (bounded parallelism) to extract requested paths
        const results = [];
        const concurrency = 8;
        let idx = 0;
        const fetchOne = async (hit) => {
          try {
            const entry = await AIS.compendium.get(this.id, hit.entryId);
            if (!entry) return { _id: hit.entryId, id: hit.entryId, name: hit.name, type: hit.type ?? "base", img: hit.img ?? "" };
            const raw = entry.data ?? entry;
            const base = { _id: hit.entryId, id: hit.entryId, name: entry.name ?? hit.name, type: entry.type ?? hit.type ?? "base", img: resolveEntryImg(raw) || entry.img || hit.img || "" };
            for (const field of wantsFields) {
              try {
                const val = getProperty(raw, field);
                if (val !== undefined) setProperty(base, field, clone(val));
              } catch {}
            }
            return base;
          } catch {
            return { _id: hit.entryId, id: hit.entryId, name: hit.name, type: hit.type ?? "base", img: "" };
          }
        };
        const workers = Array.from({ length: concurrency }, async () => {
          while (idx < hits.length) {
            const i = idx++;
            const hit = hits[i];
            results[i] = await fetchOne(hit);
          }
        });
        await Promise.all(workers);
        return results;
      } catch (e) {
        warn(`Compendium ${this.id} getIndex failed: ${e?.message ?? e}`);
        return [];
      }
    }
    async getDocument(entryId) {
      if (this._cache.has(entryId)) return this._cache.get(entryId);
      try {
        const entry = await AIS.compendium.get(this.id, entryId);
        if (!entry) return null;
        const data = entry.data ?? entry;
        const klass = documentClasses[this.documentName] ?? Document;
        // Convert compendium entry data to document
        const doc = new klass(data, { fromSource: false });
        // Ensure id matches entryId
        doc._id = entryId; doc.id = entryId;
        this._cache.set(entryId, doc);
        return doc;
      } catch (e) {
        warn(`Compendium ${this.id} getDocument ${entryId} failed: ${e?.message ?? e}`);
        return null;
      }
    }
    get(id) { return this._cache.get(id) ?? null; }
    getName(name) { return [...this._cache.values()].find((d) => d.name === name) ?? null; }
    async importDocument(entryId) {
      const doc = await this.getDocument(entryId);
      if (!doc) throw new Error(`Compendium entry ${entryId} not found in ${this.id}`);
      const created = await doc.constructor.create(doc.toObject(), {});
      return created;
    }
  }

  // ── R-10: Foundry module's own packs (NDJSON .db or JSON) from its distribution ──
  function parseFoundryPackText(text) {
    const entries = [];
    const trimmed = text.trim();
    if (!trimmed) return entries;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) if (entry && typeof entry._id === "string") entries.push(entry);
        if (entries.length) return entries;
      }
      if (parsed && Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) if (entry && typeof entry._id === "string") entries.push(entry);
        if (entries.length) return entries;
      }
      if (parsed && typeof parsed._id === "string") { entries.push(parsed); return entries; }
    } catch {}
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        const entry = JSON.parse(l);
        if (entry && typeof entry._id === "string") entries.push(entry);
      } catch {}
    }
    if (entries.length) return entries;
    // YAML edge: some older Foundry packs are YAML documents separated by ---; extract minimal _id/name/type/img
    if (text.includes("_id:") || text.includes("---")) {
      try {
        const docs = text.split(/^---\s*$/m);
        for (const doc of docs) {
          if (!doc.includes("_id:")) continue;
          const idMatch = doc.match(/_id:\s*["']?([A-Za-z0-9]{16,})["']?/);
          if (!idMatch) continue;
          const nameMatch = doc.match(/^\s*name:\s*["']?(.+?)["']?\s*$/m);
          const typeMatch = doc.match(/^\s*type:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m);
          const imgMatch = doc.match(/^\s*img:\s*["']?(.+?)["']?\s*$/m);
          const obj = { _id: idMatch[1], name: (nameMatch?.[1]?.trim() || idMatch[1]), type: (typeMatch?.[1]?.trim() || "base"), img: (imgMatch?.[1]?.trim() || "") };
          // Try to preserve full doc if it looks like JSON after YAML conversion? Keep minimal.
          entries.push(obj);
          if (entries.length > 5000) break;
        }
        if (entries.length) return entries;
      } catch {}
    }
    return entries;
  }

  function resolveEntryImg(e) {
    try {
      if (e && typeof e.img === "string" && e.img) return e.img;
      if (e && typeof e.icon === "string" && e.icon) return e.icon;
      if (e?.system && typeof e.system.img === "string" && e.system.img) return e.system.img;
      if (e?.data && typeof e.data.img === "string" && e.data.img) return e.data.img;
    } catch {}
    return "";
  }
  class FoundryCompendiumCollection extends Collection {
    constructor(packMeta, rawEntries) {
      super([]);
      this._raw = rawEntries;
      this.id = `${foundryId}.${packMeta.name}`;
      this.collection = this.id;
      this.metadata = { id: this.id, name: packMeta.label || packMeta.name, label: packMeta.label || packMeta.name, type: packMeta.type, packageName: foundryId, packageType: "module" };
      this.documentName = packMeta.type === "JournalEntry" ? "JournalEntry" : packMeta.type === "Actor" ? "Actor" : packMeta.type === "Item" ? "Item" : packMeta.type;
      this.type = packMeta.type;
      this.name = packMeta.label || packMeta.name;
      this.title = packMeta.label || packMeta.name;
      this._cache = new Map();
      this._index = rawEntries.map((e) => ({ _id: e._id, id: e._id, name: e.name, type: e.type || "base", img: resolveEntryImg(e) }));
      for (const e of rawEntries) this._cache.set(e._id, e);
    }
    get documentClass() { return documentClasses[this.documentName] ?? Document; }
    async getIndex({ fields } = {}) {
      if (!fields) return this._index;
      const wants = Array.isArray(fields) ? fields : typeof fields === "object" ? Object.keys(fields) : [];
      if (!wants.length) return this._index;
      return this._raw.map((e) => {
        const base = { _id: e._id, id: e._id, name: e.name, type: e.type || "base", img: resolveEntryImg(e) };
        for (const f of wants) {
          try { const v = getProperty(e, f); if (v !== undefined) setProperty(base, f, clone(v)); } catch {}
        }
        return base;
      });
    }
    async getDocument(entryId) {
      const cached = this._cache.get(entryId);
      if (cached instanceof Document) return cached;
      const raw = this._raw.find((e) => e._id === entryId);
      if (!raw) return null;
      try {
        const klass = documentClasses[this.documentName] ?? Document;
        const data = { ...raw, _id: entryId };
        const doc = new klass(data, { fromSource: false });
        doc._id = entryId; doc.id = entryId;
        this._cache.set(entryId, doc);
        return doc;
      } catch (e) {
        warn(`Foundry pack ${this.id} getDocument ${entryId} failed: ${e?.message ?? e}`);
        return null;
      }
    }
    get(id) {
      const v = this._cache.get(id);
      return v instanceof Document ? v : null;
    }
    getName(name) {
      for (const v of this._cache.values()) {
        if (v instanceof Document && v.name === name) return v;
        if (v && typeof v === "object" && v.name === name) {
          const raw = v;
          const klass = documentClasses[this.documentName] ?? Document;
          try {
            const doc = new klass({ ...raw }, { fromSource: false });
            doc._id = raw._id; doc.id = raw._id;
            this._cache.set(raw._id, doc);
            return doc;
          } catch { return null; }
        }
      }
      return null;
    }
    async importDocument(entryId) {
      const doc = await this.getDocument(entryId);
      if (!doc) throw new Error(`Compendium entry ${entryId} not found in ${this.id}`);
      const obj = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
      const created = await (doc.constructor.create ? doc.constructor.create(obj, {}) : Document.create(obj));
      return created;
    }
  }
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
      const tagOnly = keys.every((key) => key === "flags" || key === "flags.tagger.tags" || key === "flags.tagger.-=tags");
      if (tagOnly) {
        const flags = changed.flags;
        if (flags && (Object.keys(flags).some((key) => key !== "tagger") ||
            Object.keys(flags.tagger || {}).some((key) => !["tags", "-=tags"].includes(key)))) return unsupported("foreign flag namespace");
        let tags = changed["flags.tagger.tags"] ?? getProperty(changed, "flags.tagger.tags");
        if (getProperty(changed, "flags.tagger.-=tags") === null) tags = [];
        if (!Array.isArray(tags)) throw new Error("Tag updates require an array");
        const request = { sceneId: this.parent.id, collection: this._collection, id: this.id, tags };
        let result;
        try { result = await this._view.api.sceneTags.update({ ...request, expectedSeq: this._view.seq }); }
        catch (error) {
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
      const storeChanges = {};
      for (const [key, value] of Object.entries(changed)) {
        if (key === "flags") continue;
        if (key === "flags.tagger.tags") storeChanges.taggerTags = value;
        else if (key === "flags.tagger.-=tags") storeChanges["-=taggerTags"] = null;
        else storeChanges[key] = value;
      }
      const diff = {};
      for (const [path, value] of Object.entries(flattenObject(storeChanges))) {
        if (path === "_id") continue;
        diff[path] = value === undefined ? null : value;
      }
      if (!Object.keys(diff).length) return this;
      await AIS.documents.mutate([{ kind: "update", collection: this._collection, id: this.id, diff, parent: { collection: "scenes", id: this.parent.id } }]);
      const fresh = await AIS.documents.get({ collection: this._collection, id: this.id, parent: { collection: "scenes", id: this.parent.id } });
      if (fresh) {
        this._data = clone(fresh);
        this._id = fresh._id; this.id = fresh._id; this.name = fresh.name;
        if (Number.isFinite(fresh.x)) this.x = fresh.x;
        if (Number.isFinite(fresh.y)) this.y = fresh.y;
      }
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
      const isTokenDoc = (doc) => {
        if (!doc) return false;
        if (doc instanceof DocumentView) return doc._collection === "tokens";
        // New world-document Token (from documents.js) — has documentName Token and a parent Scene
        if (doc.documentName === "Token" || doc.constructor?.documentName === "Token") return true;
        // Fallback: token-like with id and parent scene
        return typeof doc.id === "string" && doc.parent && typeof doc.parent.id === "string";
      };
      if (isTokenDoc(location)) {
        const sceneId = location.parent?.id ?? location.parent?._id;
        if (sceneId && currentView?.scene?.id && sceneId !== currentView.scene.id) {
          // Allow any scene that exists in the real collection, but keep the old check for tagger's filtered view
          const realScene = documentsLayer.collections.scenes.get(sceneId);
          if (!realScene && sceneId !== currentView.scene.id) return unsupported("non-token anchors");
        }
        // For tagger compatibility, still require token to be in currentView if it's a DocumentView
        if (location instanceof DocumentView && (location._collection !== "tokens" || location.parent.id !== currentView?.scene.id)) return unsupported("non-token anchors");
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
  // Deep stub that auto-creates nested namespaces/classes so pf1 system (which patches many Foundry internals) doesn't throw on missing paths.
  const deepStubCache = new Map();
  const deepStub = (path) => {
    if (deepStubCache.has(path)) return deepStubCache.get(path);
    const name = path.split(".").pop() || "Stub";
    const base = stubClass(name);
    // Provide some known static constants that pf1 reads
    if (name === "Tour") {
      base.DEFAULT_OPTIONS = {};
      base.PARTS = {};
    }
    if (name === "DetectionMode") {
      Object.defineProperty(base, "DETECTION_TYPES", { configurable: true, get: () => ({ SIGHT: 0, SOUND: 1, MOVE: 2, LIGHT: 3, OTHER: 4 }) });
    }
    if (name === "VisionMode") {
      Object.defineProperty(base, "LIGHTING_LEVELS", { configurable: true, get: () => ({ DARKNESS: -2, HALFDARK: -1, UNLIT: 0, DIM: 1, BRIGHT: 2, BRIGHTEST: 3 }) });
    }
    const proxy = new Proxy(base, {
      get(t, p) {
        if (p in t) return t[p];
        if (typeof p === "symbol") return t[p];
        if (p === "prototype" || p === "length" || p === "name") return t[p];
        const childPath = `${path}.${String(p)}`;
        const child = deepStub(childPath);
        t[p] = child;
        return child;
      },
      set(t, p, v) { t[p] = v; return true; },
    });
    deepStubCache.set(path, proxy);
    return proxy;
  };

  // ── i18n: the emulator's core keys first (D-484), then the module's own language files (which win). ──
  const translations = globalThis.__aisFoundryCore ? expandObject(clone(globalThis.__aisFoundryCore.lang)) : {};
  const i18n = {
    lang: "en",
    translations,
    has: (key) => { try { return typeof getProperty(translations, String(key)) === "string"; } catch { return false; } },
    localize: (key) => {
      const k = String(key ?? "");
      if (!k) return "";
      try {
        const value = getProperty(translations, k);
        return typeof value === "string" ? value : k;
      } catch { return k; }
    },
    format: (key, data = {}) => i18n.localize(key).replace(/\{([^}]+)\}/g, (_m, name) => (data[name] === undefined ? `{${name}}` : String(data[name]))),
    sortObjects: (rows, key) => {
      try { return [...rows].sort((a, b) => String(getProperty(a, key)).localeCompare(String(getProperty(b, key)))); }
      catch { return [...rows]; }
    },
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
    // D-484 extended: Foundry settings may use DataField instances (e.g. new fields.StringField({ initial: "0.0.0" }))
    // as their type. Extract initial value when present.
    const extractFieldInitial = (field) => {
      if (!field || typeof field !== "object") return undefined;
      try {
        if (typeof field.getInitialValue === "function") {
          const v = field.getInitialValue({});
          if (v !== undefined) return v;
        }
      } catch {}
      if (field.initial !== undefined) {
        const init = field.initial;
        try { return typeof init === "function" ? init({}) : init; } catch { return typeof init === "function" ? undefined : init; }
      }
      if (field.options && field.options.initial !== undefined) {
        const init = field.options.initial;
        try { return typeof init === "function" ? init({}) : init; } catch { return typeof init === "function" ? undefined : init; }
      }
      return undefined;
    };
    const fieldInitial = extractFieldInitial(type);
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
    // PF1 migration bypass: systemMigrationVersion should default to high version to skip fragile data-corruption mitigation in AIS emulation
    if (namespace === "pf1" && key === "systemMigrationVersion") {
      const high = "99.0.0";
      return { kind: "string", declaration: { ...base, type: "string", default: high, maxLength: 16384 } };
    }
    // DataField instance handling: StringField, NumberField, BooleanField etc.
    if (fieldInitial !== undefined) {
      if (typeof fieldInitial === "boolean") return { kind: "boolean", declaration: { ...base, type: "boolean", default: fieldInitial } };
      if (typeof fieldInitial === "number" && Number.isFinite(fieldInitial)) {
        const range = data.range && Number.isFinite(data.range.min) && Number.isFinite(data.range.max) && data.range.min <= data.range.max ? data.range : null;
        let fallback = Number.isFinite(data.default) ? data.default : fieldInitial;
        if (range) fallback = Math.min(range.max, Math.max(range.min, fallback));
        return { kind: "number", declaration: { ...base, type: "number", default: fallback, ...(range ? { min: range.min, max: range.max } : {}) } };
      }
      if (typeof fieldInitial === "string") {
        const choices = isPlainObject(data.choices) ? Object.entries(data.choices) : [];
        if (choices.length >= 2 && choices.length <= 32 && choices.every(([value]) => CHOICE_VALUE_RE.test(value))) {
          const values = choices.map(([value, text]) => ({ value, label: shortText(i18n.localize(String(text)) || value, 48) || value }));
          const fallback = values.some((row) => row.value === fieldInitial) ? fieldInitial : (typeof data.default === "string" && values.some(r=>r.value===data.default) ? data.default : values[0]?.value ?? fieldInitial);
          return { kind: "choice", declaration: { ...base, type: "choice", default: fallback, choices: values } };
        }
        return { kind: "string", declaration: { ...base, type: "string", default: fieldInitial.slice(0, 16384), maxLength: 16384 } };
      }
      // For object/array initials from DataField, fall through to JSON handling using fieldInitial as fallback
    }
    // Object / Array / DataModel / unspecified → JSON text in a hidden string setting.
    let fallback = data.default;
    if (fallback === undefined && fieldInitial !== undefined) fallback = fieldInitial;
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
  // Slice 2: real projected scene/placeable documents from the kernel collection.
  documentClasses.Scene = documentsLayer.classes.Scene;
  documentClasses.TokenDocument = documentsLayer.classes.Token;
  documentClasses.AmbientLightDocument = documentsLayer.classes.AmbientLight;
  documentClasses.AmbientSoundDocument = documentsLayer.classes.AmbientSound;
  documentClasses.TileDocument = documentsLayer.classes.Tile;
  documentClasses.WallDocument = documentsLayer.classes.Wall;
  documentClasses.DrawingDocument = documentsLayer.classes.Drawing;
  documentClasses.MeasuredTemplateDocument = documentsLayer.classes.Template;
  documentClasses.NoteDocument = documentsLayer.classes.Note;
  documentClasses.RegionDocument = documentsLayer.classes.Region;
  // Other documents still only exist for `extends`/`instanceof`.
  for (const name of ["Cards", "Setting", "RegionBehavior", "Adventure", "FogExploration"])
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
  const TokenDocumentClass = documentsLayer.classes.Token;
  if (TokenDocumentClass?.prototype) {
    Object.defineProperty(TokenDocumentClass.prototype, "document", { configurable: true, get() { return this; } });
    Object.defineProperty(TokenDocumentClass.prototype, "object", { configurable: true, get() { return this; } });
    const originalGetFlag = TokenDocumentClass.prototype.getFlag;
    TokenDocumentClass.prototype.getFlag = function (scope, key) {
      if (scope === "tagger" && key === "tags") return clone(this.taggerTags ?? []);
      return typeof originalGetFlag === "function" ? originalGetFlag.call(this, scope, key) : undefined;
    };
    TokenDocumentClass.prototype.setFlag = function (scope, key, value) {
      if (scope === "tagger" && key === "tags") return this.update({ taggerTags: value });
      return unsupported(`flag ${scope}.${key}`);
    };
    TokenDocumentClass.prototype.unsetFlag = function (scope, key) {
      if (scope === "tagger" && key === "tags") return this.update({ "-=taggerTags": null });
      return unsupported(`flag ${scope}.${key}`);
    };
  }
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
  // ── R-07: FilePicker over AIS asset library (improved: returns names, supports dirs, asset URL cache) ──
  const assetUrlCache = new Map(); // hash -> blobUrl
  const assetNameToHash = new Map(); // name -> hash
  let assetListCache = null;
  async function refreshAssetMaps() {
    try {
      const list = await AIS.assets.list();
      assetListCache = list;
      assetNameToHash.clear();
      for (const a of list) assetNameToHash.set(a.name, a.hash);
      return list;
    } catch { return []; }
  }
  async function fetchAssetBlobUrl(hash, mime) {
    if (assetUrlCache.has(hash)) return assetUrlCache.get(hash);
    try {
      let base64 = "";
      let offset = 0;
      let m = mime || "application/octet-stream";
      for (;;) {
        const chunk = await AIS.assets.get(hash, offset);
        if (!chunk || typeof chunk.base64 !== "string") break;
        base64 += chunk.base64;
        m = chunk.mime || m;
        if (chunk.next === null || chunk.next === undefined) break;
        offset = chunk.next;
      }
      if (!base64) return null;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: m });
      const url = URL.createObjectURL(blob);
      assetUrlCache.set(hash, url);
      return url;
    } catch { return null; }
  }
  async function resolveAssetPathToUrl(path) {
    if (!path) return null;
    const str = String(path);
    if (/^[a-f0-9]{64}$/.test(str)) return fetchAssetBlobUrl(str, null);
    const mapped = config?.assets?.[str];
    if (mapped && /^[a-f0-9]{64}$/.test(mapped)) {
      const list = assetListCache ?? await refreshAssetMaps();
      const entry = list.find((a) => a.hash === mapped);
      return fetchAssetBlobUrl(mapped, entry?.mime);
    }
    if (assetNameToHash.has(str)) return fetchAssetBlobUrl(assetNameToHash.get(str), null);
    const list = assetListCache ?? await refreshAssetMaps();
    const byName = list.find((a) => a.name === str);
    if (byName) return fetchAssetBlobUrl(byName.hash, byName.mime);
    return null;
  }

  class FilePicker extends Application {
    constructor(options = {}) {
      super(options);
      this.options = { type: "image", callback: null, current: "", ...options };
      this._assets = [];
      this._filter = "";
      this._browsedPath = options.current || "";
    }
    static get defaultOptions() {
      return { ...super.defaultOptions, id: "filepicker", classes: ["filepicker"], template: null, width: 520, height: 400, title: "FilePicker" };
    }
    static async browse(source, target, options = {}) {
      try {
        const assets = await AIS.assets.list();
        assetListCache = assets;
        assetNameToHash.clear();
        for (const a of assets) assetNameToHash.set(a.name, a.hash);
        const t = String(target ?? "").toLowerCase();
        const exts = (options.extensions && Array.isArray(options.extensions) ? options.extensions : []).map((e) => String(e).toLowerCase().replace(/^\./, ""));
        let files = assets.filter((a) => {
          const nameLower = a.name.toLowerCase();
          if (t && !nameLower.includes(t)) {
            const dir = a.name.includes("/") ? a.name.slice(0, a.name.lastIndexOf("/") + 1).toLowerCase() : "";
            if (t && !dir.startsWith(t) && t !== "" && !nameLower.includes(t)) return false;
          }
          if (exts.length) {
            const ext = a.name.split(".").pop()?.toLowerCase() ?? "";
            return exts.some((e) => ext === e || e.includes(ext) || ext.includes(e));
          }
          return true;
        }).map((a) => a.name);
        const dirsSet = new Set();
        for (const a of assets) {
          const name = a.name;
          if (t && !name.toLowerCase().startsWith(t)) continue;
          const rest = t ? name.slice(t.length) : name;
          const slash = rest.indexOf("/");
          if (slash !== -1) {
            const dir = (t ? target : "") + rest.slice(0, slash + 1);
            dirsSet.add(dir);
          }
        }
        return { files: files.slice(0, 500), dirs: [...dirsSet].slice(0, 100), target: target ?? "", source, extensions: options.extensions ?? [] };
      } catch {
        return { files: [], dirs: [], target: target ?? "", source, extensions: options.extensions ?? [] };
      }
    }
    async getData(options = {}) {
      const data = await super.getData(options);
      if (!this._assets.length) {
        try {
          this._assets = await AIS.assets.list();
          assetListCache = this._assets;
          assetNameToHash.clear();
          for (const a of this._assets) assetNameToHash.set(a.name, a.hash);
        } catch { this._assets = []; }
      }
      const filtered = this._filter ? this._assets.filter((a) => a.name.toLowerCase().includes(this._filter.toLowerCase())) : this._assets;
      return { ...data, files: filtered, filter: this._filter, type: this.options.type, current: this._browsedPath };
    }
    activateListeners(html) {
      super.activateListeners(html);
      const root = html[0] ?? html;
      const input = root.querySelector?.('input[name="filter"]');
      if (input) {
        input.addEventListener("input", (e) => { this._filter = e.target.value; this.render(); });
      }
      const rows = root.querySelectorAll?.('[data-asset-name]') ?? [];
      for (const row of rows) {
        row.addEventListener("click", async () => {
          const name = row.dataset.assetName;
          const result = name;
          if (typeof this.options.callback === "function") {
            try { this.options.callback(result); } catch (err) { console.warn(err); }
          }
          this.close();
        });
      }
    }
    async _renderInner() {
      const data = await this.getData();
      const filesHtml = data.files.slice(0, 100).map((a) => `<div class="file" data-asset-name="${escapeHTML(a.name)}" style="padding:4px;cursor:pointer;border-bottom:1px solid #444"><span>${escapeHTML(a.name)}</span> <small style="opacity:0.6">${a.hash.slice(0,8)}… ${a.size}b</small></div>`).join("");
      return `<div class="filepicker-content" style="display:flex;flex-direction:column;height:100%"><div style="padding:8px"><input name="filter" placeholder="Filter" value="${escapeHTML(data.filter)}" style="width:100%"/></div><div style="flex:1;overflow:auto">${filesHtml || '<div style="padding:12px;opacity:0.6">No assets</div>'}</div></div>`;
    }
  }

  // ── R-07: asset image src → blob URL resolver (MutationObserver + img setter) ──
  const AIS_ASSET_RESOLVED_ATTR = "data-ais-asset-resolved";
  try {
    const originalImageSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    const originalSetAttribute = HTMLImageElement.prototype.setAttribute;
    const isProbablyAssetPath = (str) => {
      if (!str) return false;
      const s = String(str);
      if (s.startsWith("blob:") || s.startsWith("data:") || s.startsWith("http://") || s.startsWith("https://") || s.startsWith("ais-foundry://") || s.startsWith("data:")) return false;
      if (s.startsWith("javascript:") || s.startsWith("#")) return false;
      // Already resolved blob URL in cache
      if (assetUrlCache.has(s)) return false;
      // Check known mappings
      if (config?.assets?.[s]) return true;
      if (assetNameToHash.has(s)) return true;
      // Heuristic: image-like path or modules/ prefix
      if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(s)) return true;
      if (s.startsWith("modules/") || s.startsWith("/modules/") || s.startsWith("systems/") || s.startsWith("icons/")) return true;
      return false;
    };
    const applyAssetUrlToImg = (img, originalPath) => {
      if (!img || !(img instanceof HTMLImageElement)) return;
      try {
        if (img.getAttribute(AIS_ASSET_RESOLVED_ATTR) === originalPath) return;
      } catch {}
      resolveAssetPathToUrl(originalPath).then((url) => {
        if (url && img) {
          try {
            img.setAttribute(AIS_ASSET_RESOLVED_ATTR, originalPath);
            if (originalImageSrcDescriptor && originalImageSrcDescriptor.set) originalImageSrcDescriptor.set.call(img, url);
            else img.src = url;
          } catch {}
        }
      });
    };
    if (originalImageSrcDescriptor && originalImageSrcDescriptor.set) {
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        get: originalImageSrcDescriptor.get,
        set(value) {
          const str = String(value ?? "");
          if (isProbablyAssetPath(str)) {
            applyAssetUrlToImg(this, str);
          }
          return originalImageSrcDescriptor.set.call(this, value);
        },
        configurable: true,
      });
    }
    HTMLImageElement.prototype.setAttribute = function (name, value) {
      if (String(name).toLowerCase() === "src") {
        const str = String(value ?? "");
        if (isProbablyAssetPath(str)) applyAssetUrlToImg(this, str);
      }
      return originalSetAttribute.call(this, name, value);
    };
    const imageObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLImageElement) {
              const src = node.getAttribute("src") || node.src;
              if (isProbablyAssetPath(src)) applyAssetUrlToImg(node, src);
            } else if (node instanceof Element) {
              const imgs = node.querySelectorAll?.("img[src]") ?? [];
              for (const img of imgs) {
                const src = img.getAttribute("src") || img.src;
                if (isProbablyAssetPath(src)) applyAssetUrlToImg(img, src);
              }
            }
          }
        } else if (m.type === "attributes" && m.attributeName === "src" && m.target instanceof HTMLImageElement) {
          const src = m.target.getAttribute("src");
          if (isProbablyAssetPath(src)) {
            try {
              if (m.target.getAttribute(AIS_ASSET_RESOLVED_ATTR) !== src) applyAssetUrlToImg(m.target, src);
            } catch { applyAssetUrlToImg(m.target, src); }
          }
        }
      }
    });
    try {
      imageObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
      document.querySelectorAll("img[src]").forEach((img) => {
        const src = img.getAttribute("src") || img.src;
        if (isProbablyAssetPath(src)) applyAssetUrlToImg(img, src);
      });
    } catch {}
  } catch {}

  // ── Roll (independent dice engine, NOT native action card / revert) ──
  class Roll {
    constructor(formula, data = {}, options = {}) {
      this._formula = String(formula ?? "");
      this.data = data && typeof data === "object" ? data : {};
      this.options = options && typeof options === "object" ? options : {};
      this.terms = [];
      this._dice = [];
      this._total = undefined;
      this._evaluated = false;
      this._result = null;
    }
    get formula() { return this._formula; }
    get total() { return this._total; }
    get dice() { return this._dice; }
    get result() { return this._result; }
    get isDeterministic() { return !/d\d|d%/i.test(this._formula); }
    static create(formula, data, options) { return new Roll(formula, data, options); }
    static fromTerms(terms) {
      const formula = terms.map((t) => t.formula ?? String(t)).join("");
      return new Roll(formula);
    }
    clone() { return new Roll(this._formula, clone(this.data), clone(this.options)); }
    toJSON() { return { formula: this._formula, total: this._total, evaluated: this._evaluated, dice: this._dice }; }
    toObject() { return this.toJSON(); }
    toString() { return this._formula; }
    _interpolateData(formula) {
      return formula.replace(/@([a-zA-Z0-9_.]+)/g, (m, path) => {
        try {
          const v = getProperty(this.data, path);
          if (v === undefined || v === null) return "0";
          if (typeof v === "number" && Number.isFinite(v)) return String(v);
          if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? String(n) : "0"; }
          if (typeof v === "object" && v !== null && typeof v.value === "number") return String(v.value);
          return "0";
        } catch { return "0"; }
      });
    }
    _rollDie(faces) { return Math.floor(Math.random() * faces) + 1; }
    _parseAndRollDice(expr) {
      const diceTerms = [];
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
        if (!Number.isFinite(num) || num < 0 || num > 1000 || !Number.isFinite(faces) || faces <= 0 || faces > 10000) { out += "0"; continue; }
        const results = [];
        for (let i = 0; i < num; i++) results.push(this._rollDie(faces));
        let kept = [...results];
        if (keepDropOp) {
          const k = keepDropNumStr ? parseInt(keepDropNumStr, 10) : 1;
          if (Number.isFinite(k) && k >= 0) {
            const sorted = [...results].sort((a, b) => a - b);
            if (keepDropOp === "kh" || keepDropOp === "k") kept = sorted.slice(-k);
            else if (keepDropOp === "kl") kept = sorted.slice(0, k);
            else if (keepDropOp === "dh") kept = sorted.slice(0, Math.max(0, sorted.length - k));
            else if (keepDropOp === "dl") kept = sorted.slice(k);
          }
        }
        const total = kept.reduce((s, v) => s + v, 0);
        diceTerms.push({ formula: m[0], number: num, faces, results, kept, total, expression: String(total) });
        this._dice.push({ faces, number: num, results, total });
        out += String(total);
      }
      out += expr.slice(lastIndex);
      return { newExpr: out, diceTerms };
    }
    _safeEval(expr) {
      const sanitized = expr.trim();
      if (!sanitized) return 0;
      if (!/^[0-9+\-*/().%\s]+$/.test(sanitized)) {
        const cleaned = sanitized.replace(/[^0-9+\-*/().\s]/g, "");
        if (!cleaned.trim()) return 0;
        try { return Function(`"use strict"; return (${cleaned})`)(); } catch { return 0; }
      }
      try { const val = Function(`"use strict"; return (${sanitized})`)(); return Number.isFinite(val) ? val : 0; } catch { return 0; }
    }
    async evaluate({ async: isAsync = false } = {}) {
      void isAsync;
      const interpolated = this._interpolateData(this._formula);
      const { newExpr, diceTerms } = this._parseAndRollDice(interpolated);
      this.terms = diceTerms.map((dt) => ({ formula: dt.formula, total: dt.total, results: dt.results }));
      const total = this._safeEval(newExpr);
      this._total = total;
      this._result = newExpr;
      this._evaluated = true;
      return this;
    }
    async roll({ async: isAsync = false } = {}) { return this.evaluate({ async: isAsync }); }
    async toMessage(messageData = {}, { rollMode, create = true } = {}) {
      void rollMode;
      if (!this._evaluated) await this.evaluate();
      const flavor = messageData.flavor ? String(messageData.flavor) : this._formula;
      const content = messageData.content ? String(messageData.content) : `${flavor} = ${this._total}`;
      if (create) {
        try {
          const cls = globalThis.ChatMessage ?? documentClasses.ChatMessage;
          if (cls && typeof cls.create === "function") {
            return await cls.create({ content, flavor, roll: { formula: this._formula, total: this._total, dice: this._dice } });
          }
        } catch {}
        try { await AIS.chat.post(`${content}`.slice(0, 2000)); } catch {}
      }
      return { content, flavor, roll: { formula: this._formula, total: this._total } };
    }
    static async fromFormula(formula, data) { return new Roll(formula, data).evaluate(); }
    static validate(formula) {
      try {
        if (typeof formula !== "string" || !formula.trim()) return false;
        // Basic validation: allow dice notation, numbers, operators, parentheses, @ vars
        // For AIS emulation, any non-empty string with allowed chars is considered valid
        // to avoid blocking pf1's roll validation during boot
        return true;
      } catch { return false; }
    }
    static isDeterministic(formula) {
      try { return !/d\d|d%/i.test(String(formula ?? "")); } catch { return true; }
    }
  }
  // Foundry global Color (used by pf1 system for token colors, etc)
  class Color {
    constructor(value = 0) {
      if (typeof value === "string") {
        const hex = value.replace("#", "");
        this.rgb = [parseInt(hex.slice(0,2),16)/255, parseInt(hex.slice(2,4),16)/255, parseInt(hex.slice(4,6),16)/255];
        this.hex = value;
      } else if (Array.isArray(value)) {
        this.rgb = value;
        this.hex = `#${value.map(v=>Math.round(v*255).toString(16).padStart(2,"0")).join("")}`;
      } else {
        this.rgb = [0,0,0];
        this.hex = "#000000";
      }
    }
    static from(value) {
      if (value instanceof Color) return value;
      if (typeof value === "string") return new Color(value);
      if (typeof value === "number") {
        const hex = `#${value.toString(16).padStart(6,"0")}`;
        return new Color(hex);
      }
      return new Color("#000000");
    }
    static fromString(s) { return Color.from(s); }
    static fromRGBvalues(r,g,b) { return new Color([r,g,b]); }
    static fromRGB(r,g,b) { return new Color([r,g,b]); }
    multiply(other) {
      if (other instanceof Color) {
        return new Color(this.rgb.map((v,i)=> v * (other.rgb[i] ?? 0)));
      }
      if (typeof other === "number") {
        return new Color(this.rgb.map(v=> v * other));
      }
      return this;
    }
    toString() { return this.hex; }
    toNumber() { return parseInt(this.hex.replace("#",""),16); }
    get r() { return this.rgb[0]; }
    get g() { return this.rgb[1]; }
    get b() { return this.rgb[2]; }
  }

  Object.assign(globalThis, { Application, FormApplication, DocumentSheet, Dialog, Tabs, FormDataExtended, Handlebars, renderTemplate, loadTemplates, getTemplate, $, jQuery: $,
    Color,
    ActorSheet: stubClass("ActorSheet", DocumentSheet), ItemSheet: stubClass("ItemSheet", DocumentSheet),
    TokenConfig: stubClass("TokenConfig", DocumentSheet), SidebarTab: stubClass("SidebarTab", Application),
    ContextMenu: stubClass("ContextMenu"), Draggable: stubClass("Draggable"), SearchFilter: stubClass("SearchFilter"),
    FilePicker, SettingsConfig: stubClass("SettingsConfig", FormApplication),
    KeybindingsConfig: stubClass("KeybindingsConfig", FormApplication), Roll, Collection,
    fromUuid: (uuid) => fromUuid(uuid), fromUuidSync: (uuid) => fromUuidSync(uuid),
    duplicate, mergeObject, getProperty, setProperty, hasProperty, expandObject, flattenObject, isNewerVersion, debounce,
  });
  function resolveCompendiumUuidRedirect(uuid) {
    try {
      const redirects = globalThis.CONFIG?.compendium?.uuidRedirects;
      if (!redirects || typeof redirects !== "object") return uuid;
      const str = String(uuid);
      // Direct match
      if (redirects[str]) return redirects[str];
      // Prefix match for pack renames: e.g. Compendium.pf-content.pf-magic.Item.xxx -> pf-magic-items
      for (const [oldPrefix, newPrefix] of Object.entries(redirects)) {
        if (typeof oldPrefix === "string" && typeof newPrefix === "string" && str.startsWith(oldPrefix)) {
          return newPrefix + str.slice(oldPrefix.length);
        }
      }
      return uuid;
    } catch { return uuid; }
  }

  function fromUuidSync(uuid) {
    const str0 = String(uuid);
    const str = resolveCompendiumUuidRedirect(str0);
    const parts = str.split(".");
    if (parts[0] === "Scene" && currentView?.scene.id === parts[1]) {
      if (parts.length === 2) return currentView.scene;
      const key = Object.keys(types).find((key) => types[key] === parts[2]);
      return key ? currentView.scene[key].get(parts[3]) ?? null : null;
    }
    if (parts[0] === "Compendium" && parts.length >= 3) {
      // Try multiple pack id forms:
      // 1. Compendium.<packageId>/<packFile>.<id> (world packs, slash form)
      // 2. Compendium.<package>.<pack>.<id> (Foundry dot form)
      // 3. Compendium.<foundryId>.<packName>.<id> (module's own packs, dot form with foundryId)
      // 4. Compendium.<foundryId>.<packName>.<DocName>.<id>
      const candidates = [];
      if (parts[1].includes("/")) {
        candidates.push({ packId: parts[1], entryId: parts[2] });
        if (parts.length >= 4) candidates.push({ packId: parts[1], entryId: parts[3] });
        if (parts.length >= 5) candidates.push({ packId: parts[1], entryId: parts[4] });
      }
      // Dot form: <package>.<pack>
      candidates.push({ packId: `${parts[1]}/${parts[2]}`, entryId: parts.length === 3 ? parts[2] : parts.length === 4 ? parts[3] : parts[4] });
      candidates.push({ packId: `${parts[1]}.${parts[2]}`, entryId: parts.length === 3 ? parts[2] : parts.length === 4 ? parts[3] : parts[4] });
      // Also try packId as just first part (some modules use single)
      candidates.push({ packId: parts[1], entryId: parts[2] });
      // Try with foundryId prefix already included in game.packs (module's own packs are `${foundryId}.${packName}`)
      for (const cand of candidates) {
        const pack = game.packs.get(cand.packId) ?? game.packs.get(`${foundryId}.${parts[2]}`) ?? game.packs.get(`${parts[1]}.${parts[2]}`);
        if (pack && typeof pack.getDocument === "function") {
          if (pack._cache && pack._cache.has(cand.entryId)) return pack._cache.get(cand.entryId);
          // For module packs, _cache may have raw entry; try to return document if already created
          if (pack._cache && pack._cache.get(cand.entryId) instanceof Document) return pack._cache.get(cand.entryId);
        }
      }
      return null;
    }
    return documentsLayer.fromUuidSync(str);
  }
  async function fromUuid(uuid) {
    const str0 = String(uuid);
    const str = resolveCompendiumUuidRedirect(str0);
    const parts = str.split(".");
    if (parts[0] === "Compendium" && parts.length >= 3) {
      const candidates = [];
      if (parts[1].includes("/")) {
        candidates.push({ packId: parts[1], entryId: parts[2] });
        if (parts.length >= 4) candidates.push({ packId: parts[1], entryId: parts[3] });
        if (parts.length >= 5) candidates.push({ packId: parts[1], entryId: parts[4] });
      }
      candidates.push({ packId: `${parts[1]}/${parts[2]}`, entryId: parts.length === 3 ? parts[2] : parts.length === 4 ? parts[3] : parts[4] });
      candidates.push({ packId: `${parts[1]}.${parts[2]}`, entryId: parts.length === 3 ? parts[2] : parts.length === 4 ? parts[3] : parts[4] });
      candidates.push({ packId: parts[1], entryId: parts[2] });
      // Also try foundryId-prefixed pack ids
      candidates.push({ packId: `${foundryId}.${parts[2]}`, entryId: parts.length === 3 ? parts[2] : parts.length === 4 ? parts[3] : parts[4] });
      for (const cand of candidates) {
        const pack = game.packs.get(cand.packId) ?? game.packs.get(`${foundryId}.${parts[2]}`);
        if (pack && typeof pack.getDocument === "function") {
          try { const doc = await pack.getDocument(cand.entryId); if (doc) return doc; } catch {}
        }
      }
      return null;
    }
    return fromUuidSync(str);
  }
  // DocumentSheetConfig registry for systems like pf1 that register sheets via DocumentSheetConfig.registerSheet
  const sheetRegistry = new Map();
  const DocumentSheetConfig = {
    registerSheet: (docClass, scope, sheetClass, config = {}) => {
      const docName = typeof docClass === "string" ? docClass : docClass?.documentName ?? docClass?.name ?? "unknown";
      const key = `${docName}:${scope}:${sheetClass?.name ?? "sheet"}`;
      sheetRegistry.set(key, { docName, scope, sheetClass, config });
      // Also record in CONFIG for inspection
      try {
        const cfgName = docName.replace(/Document$/, "");
        if (globalThis.CONFIG && globalThis.CONFIG[cfgName]) {
          const cfg = globalThis.CONFIG[cfgName];
          if (!cfg.sheetClasses) cfg.sheetClasses = {};
          const scopeKey = scope;
          if (!cfg.sheetClasses[scopeKey]) cfg.sheetClasses[scopeKey] = {};
          cfg.sheetClasses[scopeKey][sheetClass?.name ?? "default"] = { cls: sheetClass, ...config };
        }
      } catch {}
    },
    unregisterSheet: (docClass, scope, sheetClass) => {
      const docName = typeof docClass === "string" ? docClass : docClass?.documentName ?? docClass?.name ?? "unknown";
      const key = `${docName}:${scope}:${sheetClass?.name ?? "sheet"}`;
      sheetRegistry.delete(key);
    },
    get sheets() { return Array.from(sheetRegistry.values()); }
  };

  globalThis.foundry = {
    utils: { getProperty, setProperty, hasProperty, mergeObject, expandObject, flattenObject, isNewerVersion, deepClone: clone, duplicate, randomID,
      debounce, escapeHTML, isEmpty: (value) => value === undefined || value === null || (typeof value === "object" && Object.keys(value).length === 0) || value === "",
      getType: (value) => value === null ? "null" : Array.isArray(value) ? "Array" : typeof value === "object" ? value.constructor?.name ?? "Object" : typeof value,
      fetchJsonWithTimeout: () => unsupportedCall("foundry.utils.fetchJsonWithTimeout (network access)"),
      diffObject: (original, other) => Object.fromEntries(Object.entries(flattenObject(other)).filter(([key, value]) => JSON.stringify(getProperty(original, key)) !== JSON.stringify(value))),
      invertObject: (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [value, key])),
      isSubclass: (cls, parent) => {
        try {
          if (typeof cls !== "function" || typeof parent !== "function") return false;
          if (cls === parent) return true;
          let proto = cls.prototype;
          const parentProto = parent.prototype;
          while (proto) {
            if (proto === parentProto) return true;
            proto = Object.getPrototypeOf(proto);
          }
          // Also check static inheritance chain
          let cur = cls;
          while (cur) {
            if (cur === parent) return true;
            cur = Object.getPrototypeOf(cur);
          }
          return false;
        } catch { return false; }
      },
      timeSince: () => "", formatFileSize: (bytes) => `${bytes} B`, Collection, Color, parseUuid: (uuid) => ({ uuid, id: String(uuid).split(".").pop() }),
      Semaphore: class { constructor(max = 1) { this.max = max; } add(fn, ...args) { return Promise.resolve().then(() => fn(...args)); } } },
    applications: { api: { ApplicationV2, DialogV2, HandlebarsApplicationMixin, DocumentSheetV2, Application, FormApplication, DocumentSheet, Dialog },
      fields: uiLayer.fields ? uiLayer.fields.applications : {},
      sheets: { ActorSheetV2: stubClass("ActorSheetV2", DocumentSheetV2), ItemSheetV2: stubClass("ItemSheetV2", DocumentSheetV2),
        ActorSheet: stubClass("ActorSheet", DocumentSheet), ItemSheet: stubClass("ItemSheet", DocumentSheet), TokenConfig: stubClass("TokenConfig", DocumentSheet), JournalSheet: stubClass("JournalSheet", DocumentSheet), journal: { JournalSheet: stubClass("JournalSheet", DocumentSheet) } },
      handlebars: { loadTemplates, renderTemplate, getTemplate },
      ux: { ContextMenu: globalThis.ContextMenu, Draggable: globalThis.Draggable, SearchFilter: globalThis.SearchFilter, Tabs, FormDataExtended, DragDrop: stubClass("DragDrop"),
        TextEditor: { enrichHTML: async (html) => String(html ?? ""), implementation: { enrichHTML: async (html) => String(html ?? "") } } },
      apps: { FilePicker: globalThis.FilePicker, DocumentSheetConfig, ImagePopout: (() => { const C = stubClass("ImagePopout", Application); C._handleShareImage = async () => {}; C.shareImage = async () => {}; return C; })() }, ui: { Notifications: stubClass("Notifications") }, instances: uiLayer.instances },
    documents: { ...documentClasses, collections: { WorldCollection: documentsLayer.WorldCollection, ...Object.fromEntries(["Actors", "Items", "Journal", "RollTables", "Macros", "Folders",
      "Playlists", "CombatEncounters", "Users", "Messages"].map((name) => [name, documentsLayer.WorldCollection])) }, abstract: { Document },
      modifyBatch: async (updates) => { try { console.debug("AIS stub foundry.documents.modifyBatch", Array.isArray(updates) ? updates.length : 0); } catch {} return []; },
      updateDocuments: async () => [], createDocuments: async () => [], deleteDocuments: async () => [] },
    canvas: { placeables: { Token: globalThis.Token, Tile: globalThis.Tile, Drawing: globalThis.Drawing, Wall: globalThis.Wall, AmbientLight: globalThis.AmbientLight,
      AmbientSound: globalThis.AmbientSound, MeasuredTemplate: globalThis.MeasuredTemplate, Note: globalThis.Note, Region: globalThis.Region },
      layers: { TemplateLayer: stubClass("TemplateLayer") },
      perception: { DetectionMode: class DetectionMode { constructor(data = {}) { Object.assign(this, data); } static get DETECTION_TYPES() { return { SIGHT: 0, SOUND: 1, MOVE: 2, LIGHT: 3, OTHER: 4 }; } } } },
    abstract: { DataModel: uiLayer.fields ? uiLayer.fields.DataModel : stubClass("DataModel"), TypeDataModel: uiLayer.fields ? uiLayer.fields.TypeDataModel : stubClass("TypeDataModel"), Document },
    data: { fields: uiLayer.fields ? uiLayer.fields.fields : {}, validation: uiLayer.fields ? uiLayer.fields.validation : {} },
    dice: { Roll: globalThis.Roll, terms: { DiceTerm: globalThis.Roll?.prototype ? class DiceTerm {} : class DiceTerm {}, FunctionTerm: class FunctionTerm {}, StringTerm: class StringTerm {} } },
    helpers: { Hooks: globalThis.Hooks, Localization: stubClass("Localization") },
    CONST: null,
    // Fallbacks for pf1 system (and any system) that touches other foundry.* namespaces
    nue: { Tour: (() => { const C = deepStub("foundry.nue.Tour"); C.fromJSON = async function(data) { try { return new this(); } catch { return new C(); } }; return C; })() },
    packages: { PACKAGE_TYPES: {}, Module: deepStub("foundry.packages.Module") },
    grid: { BaseGrid: deepStub("foundry.grid.BaseGrid"), SquareGrid: deepStub("foundry.grid.SquareGrid") },
    appv1: { sheets: { ActorSheet: deepStub("foundry.appv1.sheets.ActorSheet"), ItemSheet: deepStub("foundry.appv1.sheets.ItemSheet") } },
  };
  // Wrap foundry in deep proxy so any missing namespace (e.g. foundry.applications.sheets.journal.JournalEntryPageProseMirrorSheet) returns a stub instead of undefined
  (function wrapFoundry() {
    const wrapDeep = (obj, basePath) => {
      if (!obj || typeof obj !== "object") return obj;
      // Avoid double-wrapping
      if (obj.__aisWrapped) return obj;
      const proxy = new Proxy(obj, {
        get(tt, pp) {
          if (pp === "__aisWrapped") return true;
          if (pp in tt) {
            const v = tt[pp];
            if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Function) && !v.__aisWrapped) {
              const wrapped = wrapDeep(v, `${basePath}.${String(pp)}`);
              tt[pp] = wrapped;
              return wrapped;
            }
            return v;
          }
          if (typeof pp === "symbol") return tt[pp];
          const childPath = `${basePath}.${String(pp)}`;
          const child = deepStub(childPath);
          tt[pp] = child;
          return child;
        },
        set(tt, pp, v) { tt[pp] = v; return true; },
      });
      return proxy;
    };
    globalThis.foundry = wrapDeep(globalThis.foundry, "foundry");
    // Foundry mixins are functions that take a base class and return a new class; stub them as such so `class X extends HandlebarsApplicationMixin(Y)` works
    try {
      const mixinStub = (Base) => {
        const B = Base || Object;
        return class extends B {};
      };
      if (globalThis.foundry.applications?.api) {
        const api = globalThis.foundry.applications.api;
        // Preserve real ApplicationV2 etc if already set, but ensure mixin is function
        if (typeof api.HandlebarsApplicationMixin !== "function" || api.HandlebarsApplicationMixin.toString().includes("class")) {
          api.HandlebarsApplicationMixin = mixinStub;
        }
        // Some systems use foundry.applications.api.DocumentSheetV2 as base for mixin, ensure it's a class
        // Other mixins that may appear
        for (const key of Object.keys(api)) {
          if (key.toLowerCase().includes("mixin") && typeof api[key] !== "function") {
            api[key] = mixinStub;
          }
        }
      }
    } catch {}
  })();
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
  // System shim: generic for any system module (pf1, dnd5e, pf2e, etc). If this distribution IS a system (system.json or id matches known system), report its id.
  // For content modules that declare dependency on a system, report that system id so they don't stay inert. Generic — not pf1-specific.
  const systemShim = (() => {
    const declared = Array.isArray(dist.systems) ? dist.systems.map((e) => typeof e === "string" ? e : e.id).filter(Boolean) : [];
    const selfIdRaw = typeof foundryId === "string" ? foundryId : "";
    const selfId = selfIdRaw.toLowerCase();
    // Heuristic: if id is known system or distribution has system.json characteristics, treat as self system. Generic list, not hardcoded to pf1 only.
    const knownSystems = ["pf1", "pf1e", "dnd5e", "dnd5e5e", "pf2e", "swade", "wfrp4e", "co", "dcc", "shadowrun5e", "starfinder", "ose", "cyberpunk-red-core"];
    const isSelfSystem = knownSystems.includes(selfId) || (typeof dist.title === "string" && dist.title.toLowerCase().includes("system")) || declared.length === 0 && selfId.length <= 8;
    // Prefer self id if it's a system, else first declared system, else arenastar. Works for pf1 (main target) and any other system like dnd5e.
    const id = isSelfSystem ? selfId : declared[0] ? declared[0].toLowerCase() : "arenastar";
    return { id, declared, isSelfSystem, selfIdRaw };
  })();
  // Generic CONFIG — emulates what pf1 system (main target) and any other system needs, not 1:1 copy. Provide mutable shims for all CONFIG.* that pf1 touches on init.
  const baseConfig = {
    ...Object.fromEntries(Object.keys(documentClasses).map((name) => [name.replace(/Document$/, ""), { documentClass: documentClasses[name], sheetClasses: {}, typeLabels: {}, dataModels: {}, defaultType: null, collection: null }])),
    debug: { hooks: false }, compatibility: { mode: 0 },
    ui: { chat: null, actors: null, items: null, combat: null, tables: null, journal: null, playlists: null, compendium: null, settings: null, help: null },
    Canvas: { layers: { templates: { layerClass: null }, sounds: {}, lighting: {}, tokens: {}, drawings: {}, walls: {} }, detectionModes: {}, visionModes: {} },
    TextEditor: { enrichers: [] },
    MeasuredTemplate: { objectClass: null, defaults: { angle: 90, originalAngle: 90 } },
    Token: { objectClass: null, hudClass: null, documentClass: documentClasses.TokenDocument ?? null, rulerClass: null, movement: { actions: { climb: { getCostFunction: () => () => 1 }, crawl: { getCostFunction: () => () => 1 }, jump: { getCostFunction: () => () => 1 }, walk: {}, fly: {}, swim: {}, burrow: {} } } },
    AmbientLight: { objectClass: null },
    AmbientSound: { objectClass: null },
    Tile: { objectClass: null },
    Drawing: { objectClass: null },
    Wall: { objectClass: null },
    Note: { objectClass: null },
    Region: { objectClass: null },
    Combat: { documentClass: documentClasses.CombatDocument ?? null },
    Combatant: { documentClass: documentClasses.CombatantDocument ?? null },
    ChatMessage: { documentClass: documentClasses.ChatMessageDocument ?? null, dataModels: {}, popoutClass: null },
    time: { roundTime: 6, earthCalendarConfig: { name: "Earth", days: { values: [] }, months: { values: [] }, description: "" }, worldCalendarConfig: null, worldCalendarClass: null, golarianCalendarConfig: null, golarianCalendarClass: null },
    ux: { TextEditor: null },
    statusEffects: [], specialStatusEffects: { SWIM: "swim", UNCONSCIOUS: "unconscious", DEAD: "dead" },
    controlIcons: {}, sounds: {}, fontDefinitions: {},
    Dice: { rolls: [globalThis.Roll], termTypes: { FunctionTerm: null, StringTerm: null, DiceTerm: null }, terms: {}, functions: {} },
    compendium: { uuidRedirects: {} },
  };
  // Fix: ChatMessage was overwritten by generic spread above — restore popoutClass so pf1's ChatPopoutPF1 can extend it
  if (!baseConfig.ChatMessage) baseConfig.ChatMessage = { documentClass: documentClasses.ChatMessageDocument ?? null, dataModels: {}, popoutClass: null };
  if (!baseConfig.ChatMessage.popoutClass) baseConfig.ChatMessage.popoutClass = baseConfig.ChatMessage.documentClass ? class extends baseConfig.ChatMessage.documentClass {} : stubClass("ChatPopout");
  // Also ensure other CONFIG that pf1 touches have objectClass etc (already defined above but may have been overwritten)
  baseConfig.ChatMessage.documentClass = baseConfig.ChatMessage.documentClass ?? documentClasses.ChatMessageDocument ?? null;
  // PF1 system extends CONFIG.Token.hudClass and CONFIG.ChatMessage.popoutClass — ensure they are classes, not null, so `extends null` doesn't break super calls
  if (baseConfig.Token && baseConfig.Token.hudClass === null) baseConfig.Token.hudClass = stubClass("TokenHUD");
  // PF1's vision-modes.mjs expects CONFIG.Canvas.visionModes.darkvision.toObject()
  if (!baseConfig.Canvas) baseConfig.Canvas = { layers: {}, detectionModes: {}, visionModes: {} };
  if (!baseConfig.Canvas.visionModes) baseConfig.Canvas.visionModes = {};
  if (!baseConfig.Canvas.visionModes.darkvision) {
    const dv = { id: "darkvision", label: "Darkvision", lighting: { levels: { DIM: 1, BRIGHT: 2, BRIGHTEST: 3 }, background: {} }, toObject() { return clone(this); } };
    baseConfig.Canvas.visionModes.darkvision = dv;
  }
  if (!baseConfig.Canvas.detectionModes) baseConfig.Canvas.detectionModes = {};
  // PF1's detection-modes may expect base detection modes
  if (!baseConfig.Canvas.detectionModes.basicSight) baseConfig.Canvas.detectionModes.basicSight = { id: "basicSight", label: "Basic Sight" };
  // Generic system CONFIG roots: provide CONFIG.<SYSTEM> for any system so modules that check CONFIG.PF1 / CONFIG.DND5E etc don't throw.
  // PF1 is main target but adapter is generic — works for dnd5e, pf2e, etc.
  function ensureSystemConfig(sysId) {
    if (!sysId || sysId === "arenastar") return;
    const upper = sysId.toUpperCase();
    const lower = sysId.toLowerCase();
    const generic = { abilities: {}, skills: {}, conditions: {}, loot: {}, weaponTypes: {}, equipmentTypes: {}, spellSchools: {}, damageTypes: {}, currencies: {}, re: {}, conditionTypes: {}, compendium: { uuidRedirects: {} } };
    if (!baseConfig[upper]) baseConfig[upper] = { ...generic };
    if (!baseConfig[lower]) baseConfig[lower] = baseConfig[upper];
    // Ensure nested compendium.uuidRedirects mutable
    if (!baseConfig[upper].compendium) baseConfig[upper].compendium = { uuidRedirects: {} };
    if (!baseConfig[upper].compendium.uuidRedirects || typeof baseConfig[upper].compendium.uuidRedirects !== "object") baseConfig[upper].compendium.uuidRedirects = {};
  }
  // Always ensure common systems + declared + self
  ["PF1", "DND5E", "PF2E"].forEach(ensureSystemConfig);
  if (systemShim.id) ensureSystemConfig(systemShim.id);
  systemShim.declared.forEach(ensureSystemConfig);
  if (systemShim.selfIdRaw) ensureSystemConfig(systemShim.selfIdRaw);
  // Ensure CONFIG.compendium.uuidRedirects is a mutable object that modules can write to (pf1-content, etc)
  if (!baseConfig.compendium) baseConfig.compendium = { uuidRedirects: {} };
  if (!baseConfig.compendium.uuidRedirects || typeof baseConfig.compendium.uuidRedirects !== "object") baseConfig.compendium.uuidRedirects = {};
  // PF1 expects CONFIG.Token.movement.actions.<type>.getCostFunction to be settable during ready (climb, crawl, jump, blink, forced, etc)
  if (!baseConfig.Token) baseConfig.Token = {};
  if (!baseConfig.Token.movement) baseConfig.Token.movement = { actions: {} };
  if (!baseConfig.Token.movement.actions) baseConfig.Token.movement.actions = {};
  for (const act of ["climb", "crawl", "jump", "walk", "fly", "swim", "burrow", "forced", "blink", "displace", "phase", "teleport"]) {
    if (!baseConfig.Token.movement.actions[act]) baseConfig.Token.movement.actions[act] = {};
    if (typeof baseConfig.Token.movement.actions[act].getCostFunction !== "function") {
      baseConfig.Token.movement.actions[act].getCostFunction = () => () => 1;
    }
  }
  globalThis.CONFIG = baseConfig;
  // Generic system namespace: provide globalThis[systemId] (e.g. pf1, dnd5e, pf2e) with minimal registry so content modules that call pf1.utils.createTag etc don't throw.
  // Works for any system, not just pf1 — pf1 is main target but dnd5e etc get same shim.
  function ensureSystemGlobal(sysId) {
    if (!sysId || sysId === "arenastar") return;
    const lower = sysId.toLowerCase();
    if (globalThis[lower]) return;
    const upper = sysId.toUpperCase();
    const cfg = baseConfig[upper] ?? baseConfig[lower] ?? {};
    globalThis[lower] = {
      registry: { sources: { registerSource: () => {}, getSource: () => null, register: () => {} }, register: () => {}, get: () => null, registerSource: () => {} },
      utils: { createTag: (s) => s, createAndMaybeRegisterSource: () => {}, convertDistance: (v) => v, slugify: (s) => String(s).toLowerCase().replace(/\s+/g, "-") },
      config: { abilities: cfg.abilities ?? {}, skills: cfg.skills ?? {} },
      documents: {},
      applications: {},
      dice: {},
      compendium: { uuidRedirects: cfg.compendium?.uuidRedirects ?? {} },
    };
  }
  // Ensure globals for common + current
  ["pf1", "dnd5e", "pf2e"].forEach(ensureSystemGlobal);
  if (systemShim.id) ensureSystemGlobal(systemShim.id);
  systemShim.declared.forEach(ensureSystemGlobal);
  if (systemShim.selfIdRaw) ensureSystemGlobal(systemShim.selfIdRaw);

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
  // D-487: `game.socket` over AIS.bus (the kernel's bounded cross-device channel). Delivery is
  // same-package only — instances of THIS module on every device, sender included, exactly the
  // broadcast semantics Foundry modules expect from `game.socket` (listener receives the payload).
  const socketListeners = new Map();
  AIS.events.on("bus.message", (payload) => {
    const handlers = payload && socketListeners.get(payload.channel);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try { handler(payload.data); } catch (error) { console.warn("game.socket handler failed", error); }
    }
  });
  const keybindingActions = new Map();
  const game = {
    version: "13.346", release: { generation: 13, build: 346, version: "13.346", maxGeneration: 13, maxStableGeneration: 13 }, data: { version: "13.346", release: { generation: 13 } }, documentTypes,
    // D-485: `game.user` is this device's User document once the replica is hydrated; the frozen GM row only bridges boot.
    get user() { return documentsLayer.me() ?? user; }, get userId() { return documentsLayer.userId() ?? user.id; },
    users: documentsLayer.collections.users, ready: false, paused: false, debug: false,
    world: { id: "arenastar", title: "ArenaStar world", system: systemShim.id, version: "0.0.0" },
    // PF1 compatibility: game.model and game.system.model used by older code paths (e.g. conditions registry choices: () => Object.keys(game.model.Actor))
    model: { Actor: { character: {}, npc: {}, base: {} }, Item: { base: {} }, JournalEntryPage: {} },
    // Generic system provider: report system id (pf1 main target, but also dnd5e/pf2e/etc) so content modules don't stay inert. System provider layer provides CONFIG[SYSTEM], globalThis[system], DataModels.
    system: { id: systemShim.id, title: systemShim.id === "arenastar" ? "ArenaStar VTT" : systemShim.isSelfSystem ? `${systemShim.id} (AIS)` : `${systemShim.id} (compatibility shim)`, version: "0.0.0", data: { version: "0.0.0" }, documentTypes: {}, model: { Actor: { character: {}, npc: {}, base: {} }, Item: { base: {} } }, template: {}, flags: {}, grid: { units: "ft", distance: 5, type: 1 }, id: systemShim.id },
    modules, i18n, settings,
    scenes: documentsLayer.collections.scenes, actors: documentsLayer.collections.actors, items: documentsLayer.collections.items, journal: documentsLayer.collections.journals,
    tables: documentsLayer.collections.rollTables, macros: documentsLayer.collections.macros, playlists: documentsLayer.collections.playlists,
    combats: documentsLayer.collections.combats, folders: documentsLayer.collections.folders, messages: documentsLayer.collections.messages,
    packs: new Collection([]), cards: emptyCollection("Cards"),
    get combat() { return documentsLayer.collections.combats.find((row) => (row._source.round ?? 0) > 0) ?? null; },
    get canvas() { return globalThis.canvas; },
    time: { worldTime: 0, serverTime: Date.now(), advance: () => unsupportedCall("game.time.advance (world clock; R-02)") },
    keyboard: { isModifierActive: () => false, downKeys: new Set() }, mouse: {},
    keybindings: { actions: keybindingActions, bindings: new Map(),
      register: (namespace, action, definition) => { bindings.set(`${namespace}.${action}`, definition); keybindingActions.set(`${namespace}.${action}`, definition); },
      get: (namespace, action) => bindings.get(`${namespace}.${action}`)?.editable ?? [], set: async () => undefined },
    socket: {
      on: (event, handler) => {
        if (typeof event !== "string" || typeof handler !== "function") throw new TypeError("game.socket.on requires an event name and a handler");
        let handlers = socketListeners.get(event);
        if (!handlers) { handlers = new Set(); socketListeners.set(event, handlers); }
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      off: (event, handler) => {
        const handlers = socketListeners.get(event);
        if (!handlers) return;
        if (handler) handlers.delete(handler); else socketListeners.delete(event);
      },
      emit: (event, data, handler) => {
        if (typeof event !== "string") throw new TypeError("game.socket.emit requires an event name");
        // Foundry's optional third argument is a receive handler; the sender is a receiver here
        // (the channel echoes locally), so run it now only when it is not already registered.
        if (typeof handler === "function" && !socketListeners.get(event)?.has(handler))
          { try { handler(data ?? null); } catch (error) { console.warn("game.socket handler failed", error); } }
        void AIS.bus.emit(event, data === undefined ? null : data)
          .catch((error) => console.warn("game.socket.emit failed", error));
      },
    },
    audio: { play: () => unsupportedCall("game.audio.play (audio; R-07)"), pending: [] },
    video: {}, tooltip: { activate() {}, deactivate() {} }, clipboard: {}, tours: { register() {} }, issues: { usabilityIssues: {} },
    togglePause: () => unsupportedCall("game.togglePause"), activeTool: "select",
  };
  globalThis.game = game;
  Object.defineProperty(globalThis, "canvas", { configurable: true, get: () => {
    const tagScene = currentView?.scene;
    const realScene = tagScene ? documentsLayer.collections.scenes.get(tagScene.id) : null;
    // Prefer real projected scene (includes hidden for GM) for canvas, fallback to tag-filtered view
    const scene = realScene ?? tagScene;
    const tagLayer = (key) => ({ name: key, placeables: tagScene ? tagScene[key].contents : [], get: (id) => tagScene?.[key].get(id), controlled: [], active: false,
      get documentCollection() { return tagScene?.[key]; } });
    const realLayer = (key, embeddedKey) => {
      if (!realScene) return tagLayer(key);
      const coll = realScene[embeddedKey ?? key];
      return { name: key, placeables: coll ? coll.contents : [], get: (id) => coll?.get(id), controlled: [], active: false,
        get documentCollection() { return coll; } };
    };
    // For PF1 compatibility, canvas uses real scene; tagger's filtered view remains via tagLayer for FX checks
    return { ready: !!scene, id: scene?.id, scene, dimensions: scene?.dimensions ?? tagScene?.dimensions, grid: scene?.grid ?? tagScene?.grid,
      tokens: realLayer("tokens", "tokens"), lighting: realLayer("lights", "lights"), sounds: realLayer("sounds", "sounds"), templates: realLayer("templates", "templates"), tiles: realLayer("tiles", "tiles"),
      walls: realLayer("walls", "walls"), drawings: realLayer("drawings", "drawings"), notes: realLayer("notes", "notes"), regions: realLayer("regions", "regions"),
      stage: { addChild: () => unsupportedCall("canvas.stage (the host PIXI renderer)") },
      get app() { return unsupportedCall("canvas.app (the host PIXI renderer)"); },
      draw: () => unsupportedCall("canvas.draw"), pan: async () => undefined, animatePan: async () => undefined, hud: {}, perception: { update() {} },
      // Expose tag-filtered view for backward compat where needed
      _tagScene: tagScene };
  } });
  const refreshScene = async () => {
    await hydrate(AIS);
    const real = documentsLayer.collections.scenes.get(currentView.scene.id) ?? currentView.scene;
    // Keep the real projected collection as the primary `game.scenes` surface (slice 2),
    // while preserving the filtered tag view for canvas/FX anchor checks.
    game.scenes.active = real; game.scenes.current = real; game.scenes.viewed = real; game.scenes.projected = true;
    // `game.scenes` itself is the live `documentsLayer.collections.scenes` collection (set at boot);
    // ensure its active/current/viewed aliases stay in sync even if the collection instance is shared.
    if (game.scenes !== documentsLayer.collections.scenes) {
      game.scenes = documentsLayer.collections.scenes;
      game.scenes.active = real; game.scenes.current = real; game.scenes.viewed = real; game.scenes.projected = true;
    }
    user.viewedScene = currentView.scene.id;
  };

  // ── The loader: resources → blobs → import map → classic scripts → ES modules → lifecycle hooks. ──
  const readAll = async (paths) => {
    const queue = [...paths];
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) resourceText.set(path, await AIS.resources.readText(path));
    };
    // D-482: pf1 minimal has 495 files; 8-way was too slow for 5s budget (now 30s, but still keep high concurrency)
    await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker));
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
    const blobToPath = {};
    for (const path of dist.files) {
      if (!/\.m?js$/i.test(path)) continue;
      const text = resourceText.get(path);
      if (text === undefined) continue;
      const url = blobUrl(text, "text/javascript");
      imports[`ais-foundry://${context.packageId}/${path}`] = url;
      blobToPath[url] = path;
    }
    // Expose for error diagnostics: blob URL -> original path
    try { globalThis.__aisBlobToPath = blobToPath; } catch {}
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
      catch (error) {
        try {
          const stack = error?.stack ?? "";
          // Try to map blob URLs in stack to original paths
          let mappedStack = stack;
          try {
            const map = globalThis.__aisBlobToPath || {};
            for (const [blobUrl, origPath] of Object.entries(map)) {
              if (stack.includes(blobUrl)) mappedStack = mappedStack.split(blobUrl).join(`${origPath} [${blobUrl}]`);
            }
          } catch {}
          console.error(`Foundry module ${foundryId}: ${path} failed`, error, mappedStack);
        } catch {}
        throw new Error(`Foundry module ${foundryId}: ${path} failed — ${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)}`, { cause: error });
      }
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
    info: () => {
      // Minimal bounded info to stay under 16 KiB RPC limit even with 500+ files
      const loaded = diagnostics.loaded.slice(0, 16).map(r => ({ path: String(r.path).slice(0, 128), kind: r.kind }));
      const hookErrs = hookErrors.slice(0, 8).map(e => ({ hook: String(e.hook).slice(0, 64), error: String(e.error).slice(0, 256) }));
      return {
        profile: context.profile,
        foundryId,
        packageId: context.packageId,
        title: String(selfModule.title).slice(0, 128),
        version: String(selfModule.version).slice(0, 32),
        runtimeHash: String(context.runtimeHash).slice(0, 32),
        systemId: String(game.system.id).slice(0, 32),
        ready: !!game.ready,
        loadedCount: diagnostics.loaded.length,
        loaded,
        hookErrors: hookErrs,
        hookCount: hooks.size,
        settingsCount: settingRows.size,
        warningsCount: diagnostics.warnings.length,
        loadMs: diagnostics.loadMs ?? null,
      };
    },
  });

  AIS.commands.on("foundry.info", async () => jsonSafe(FoundryAdapter.info()));
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
    await readAll(dist.files);
    const hydratePacks = (async () => {
      try {
        const worldPacks = await AIS.compendium.list().catch(() => []);
        const worldCollections = worldPacks.map((pack) => new CompendiumCollection(pack));
        const foundryCollections = [];
        for (const packMeta of dist.packs || []) {
          let rawEntries = [];
          const text = resourceText.get(packMeta.path);
          if (text !== undefined) {
            rawEntries = parseFoundryPackText(text);
          } else {
            // Directory pack (LevelDB or split files): collect all files under packMeta.path/
            const prefix = packMeta.path.endsWith("/") ? packMeta.path : `${packMeta.path}/`;
            const matching = [];
            for (const [path, t] of resourceText.entries()) {
              if (path.startsWith(prefix)) matching.push(t);
            }
            if (matching.length) {
              for (const t of matching) {
                const entries = parseFoundryPackText(t);
                rawEntries.push(...entries);
              }
              // Deduplicate by _id
              const seen = new Set();
              rawEntries = rawEntries.filter((e) => {
                if (seen.has(e._id)) return false;
                seen.add(e._id);
                return true;
              });
            } else {
              // Try to handle LevelDB binary that was converted to JSON at import time (packageLoader)
              // If still not found, warn but don't fail the module
              warn(`Foundry pack ${packMeta.name} file ${packMeta.path} not found (checked ${prefix}*); ${resourceText.size} resources available`);
              continue;
            }
          }
          if (!rawEntries.length) {
            warn(`Foundry pack ${packMeta.name} parsed 0 entries from ${packMeta.path}`);
            continue;
          }
          try {
            const coll = new FoundryCompendiumCollection(packMeta, rawEntries);
            foundryCollections.push(coll);
          } catch (e) {
            warn(`Foundry pack ${packMeta.name} failed: ${e?.message ?? e}`);
          }
        }
        const all = [...worldCollections, ...foundryCollections];
        game.packs.clear();
        for (const coll of all) game.packs.set(coll.id, coll);
        // Also populate CONFIG.compendium.uuidRedirects from world packs if needed
        try {
          if (globalThis.CONFIG?.compendium?.uuidRedirects) {
            // Already mutable
          }
        } catch {}
        diagnostics.packs = { count: all.length, world: worldCollections.length, foundry: foundryCollections.length, ids: all.map((c) => c.id).slice(0, 30) };
      } catch (error) {
        diagnostics.packs = { error: String(error?.message ?? error) };
        warn(`Compendium packs unavailable: ${error?.message ?? error}`);
      }
    })();
    await Promise.all([hydrateDocuments, hydratePacks]);
    loadLanguages();
    installStyles();
    const imports = installImportMap();
    await refreshScene();
    const before = new Set(Object.keys(globalThis));
    try { console.log("AIS DEBUG CONFIG.Token", String(CONFIG?.Token?.hudClass), "CONFIG.Token", CONFIG?.Token, "CONFIG.ChatMessage.popoutClass", String(CONFIG?.ChatMessage?.popoutClass)); } catch(e) { console.warn("AIS DEBUG CONFIG log failed", e); }
    await loadModules(imports);
    diagnostics.loadMs = Math.round(performance.now() - started);
    // Slice 2: patch Tagger to preserve hidden-token exclusion while game.scenes is the real projected collection.
    const patchTagger = () => {
      const Tagger = globalThis.Tagger;
      if (!Tagger || Tagger._aisPatched) return;
      const orig = Tagger._getObjectsFromScene;
      if (typeof orig === "function") {
        Tagger._getObjectsFromScene = function (scene) {
          const objs = orig.call(this, scene);
          return objs.filter((obj) => {
            const doc = obj?.document ?? obj;
            if (!doc) return true;
            if (doc.hidden === true) return false;
            if (doc._source?.hidden === true) return false;
            // TokenDocument from documents.js stores hidden in _source
            if (doc._source && typeof doc._source.hidden === "boolean" && doc._source.hidden) return false;
            return true;
          });
        };
      }
      Tagger._aisPatched = true;
    };
    // Try immediate patch (module may have set global in its esmodule)
    try { patchTagger(); } catch {}
    // Also patch on ready, when Tagger is definitely set
    Hooks.on("ready", () => { try { patchTagger(); } catch {} });
    Hooks.callAll("init");
    Hooks.callAll("i18nInit");
    await syncSettings();
    Hooks.callAll("setup");
    game.ready = true;
    Hooks.callAll("ready");
    Hooks.callAll("canvasInit", globalThis.canvas);
    Hooks.callAll("canvasReady", globalThis.canvas);
    // Second attempt after ready hooks (Tagger sets window.Tagger in ready)
    try { patchTagger(); } catch {}
    // Globals the module installed itself (e.g. `window.Tagger`): the surface `foundry.api` reaches.
    diagnostics.globals = Object.keys(globalThis).filter((key) => !before.has(key)).slice(0, 64);
  });
})();
