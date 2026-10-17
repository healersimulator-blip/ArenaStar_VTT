/**
 * ais-foundry-v13 — world documents (D-485, R-02).
 *
 * Emulates Foundry's client-side Document surface (`Actor`, `Item`, `JournalEntry`, `RollTable`,
 * `Macro`, `Folder`, `Playlist`, `Combat`, `User`, `ChatMessage` and their embedded documents) on
 * top of the kernel's generic document service (`AIS.documents.*`). Our own implementation of the
 * contract — no Foundry code — with these rules:
 *
 *  - The frame keeps a local replica of every exposed collection, hydrated once before `init` and
 *    kept current by `documents.changed`. Instances are stable: an update refreshes the same object
 *    a module already holds (`actor.system.hp` after `await actor.update(...)`).
 *  - Writes are `AIS.documents.mutate` transactions submitted with the device user's authority; the
 *    host validates them exactly like the shell's own UI. A rejected write throws, Foundry-style.
 *  - `pre*` hooks run locally before a write and may cancel it (`return false`); post hooks
 *    (`createActor`, `updateItem`, `deleteJournalEntry`, …) fire from the replicated change event only,
 *    so a module sees shell-originated edits and its own through one path, once.
 *  - ArenaStar stores the document kind in `type` ("actor"); Foundry's subtype ("npc") lives in
 *    `flags["ais-foundry"].type`, with a deterministic fallback when a document never had one.
 */
(function () {
  "use strict";

  const SUBTYPE_SCOPE = "ais-foundry";

  /** Exposed kernel collections ↔ Foundry document names (the kernel itself knows no Foundry names). */
  const ROOTS = [
    { collection: "actors", documentName: "Actor", gameKey: "actors", embedded: { Item: "items", ActiveEffect: "effects" }, types: ["base", "character", "npc"] },
    { collection: "items", documentName: "Item", gameKey: "items", embedded: { ActiveEffect: "effects" }, types: ["base"] },
    { collection: "journals", documentName: "JournalEntry", gameKey: "journal", embedded: { JournalEntryPage: "pages" }, types: ["base"] },
    { collection: "rollTables", documentName: "RollTable", gameKey: "tables", embedded: {}, types: ["base"] },
    { collection: "macros", documentName: "Macro", gameKey: "macros", embedded: {}, types: ["chat", "script"] },
    { collection: "folders", documentName: "Folder", gameKey: "folders", embedded: {}, types: ["Actor", "Item", "JournalEntry", "RollTable", "Macro", "Playlist", "Scene"] },
    { collection: "playlists", documentName: "Playlist", gameKey: "playlists", embedded: {}, types: ["base"] },
    { collection: "scenes", documentName: "Scene", gameKey: "scenes", embedded: { Token: "tokens", Wall: "walls", AmbientLight: "lights", AmbientSound: "sounds", Tile: "tiles", Region: "regions", Level: "levels", Drawing: "drawings", Template: "templates", Note: "notes" }, types: ["base"] },
    { collection: "combats", documentName: "Combat", gameKey: "combats", embedded: { Combatant: "combatants" }, types: ["base"] },
    { collection: "users", documentName: "User", gameKey: "users", embedded: {}, types: ["base"], readOnly: true },
    { collection: "messages", documentName: "ChatMessage", gameKey: "messages", embedded: {}, types: ["base"], readOnly: true },
  ];
  const EMBEDDED = {
    Item: { collection: "items", embedded: { ActiveEffect: "effects" }, types: ["base"] },
    ActiveEffect: { collection: "effects", embedded: {}, types: ["base"] },
    JournalEntryPage: { collection: "pages", embedded: {}, types: ["text", "image"] },
    Combatant: { collection: "combatants", embedded: {}, types: ["base"] },
    Token: { collection: "tokens", embedded: {}, types: ["base"] },
    Wall: { collection: "walls", embedded: {}, types: ["base"] },
    AmbientLight: { collection: "lights", embedded: {}, types: ["base"] },
    AmbientSound: { collection: "sounds", embedded: {}, types: ["base"] },
    Tile: { collection: "tiles", embedded: {}, types: ["base"] },
    Region: { collection: "regions", embedded: {}, types: ["base"] },
    Level: { collection: "levels", embedded: {}, types: ["base"] },
    Drawing: { collection: "drawings", embedded: {}, types: ["base"] },
    Template: { collection: "templates", embedded: {}, types: ["base"] },
    Note: { collection: "notes", embedded: {}, types: ["base"] },
  };
  const FOLDER_TARGETS = { Actor: "actors", Item: "items", JournalEntry: "journals", RollTable: "rollTables", Macro: "macros", Playlist: "playlists", Scene: "scenes" };
  const ROLE_NAMES = { GM: 4, ASSISTANT: 3, TRUSTED: 2, PLAYER: 1 };

  function install(deps) {
    const { AIS, Hooks, warn, clone, flattenObject, expandObject, getProperty } = deps;
    const game = () => deps.game();
    const stats = { documents: 0, collections: {}, hydrateMs: null, events: 0, writes: 0, rejectedWrites: 0, hookErrors: [] };
    const collections = {};
    const classes = {};
    let userId = null;
    let userName = "GM";

    const configuredClass = (name) => globalThis.CONFIG?.[name]?.documentClass ?? classes[name];
    class WorldCollection extends deps.Collection {
      constructor(documentName) { super([]); this.documentName = documentName; this.projected = true; }
      get documentClass() { return configuredClass(this.documentName); }
      get name() { return `${this.documentName}s`; }
      get folders() { return new deps.Collection(collections.folders ? collections.folders.filter((folder) => folder.type === this.documentName) : []); }
      getName(name, { strict = false } = {}) {
        const found = this.contents.find((row) => row.name === name);
        if (!found && strict) throw new Error(`${this.documentName} "${name}" does not exist`);
        return found;
      }
      get invalidDocumentIds() { return new Set(); }
      fromCompendium(data) { return clone(data); }
      importFromCompendium() { throw new Error("Foundry compatibility profile: importFromCompendium (packs; R-10)"); }
      render() {}
      get directory() { return null; }
      /** Foundry's `search({query})`: substring match on names, case-insensitive. */
      search({ query = "" } = {}) { const needle = String(query).toLowerCase(); return this.contents.filter((row) => String(row.name).toLowerCase().includes(needle)); }
    }

    class EmbeddedCollection extends deps.Collection {
      constructor(parent, documentName, rows) { super(rows); this.parent = parent; this.documentName = documentName; }
      get documentClass() { return configuredClass(this.documentName); }
      get invalidDocumentIds() { return new Set(); }
    }

    const userLevel = (ownership) => {
      const me = game()?.user;
      if (me?.isGM) return 3;
      if (!ownership) return 0;
      return typeof ownership[userId] === "number" ? ownership[userId] : typeof ownership.default === "number" ? ownership.default : 0;
    };
    const uuidOf = (doc) => (doc.parent ? `${doc.parent.uuid}.${doc.documentName}.${doc.id}` : doc.pack ? `Compendium.${doc.pack}.${doc.documentName}.${doc.id}` : `${doc.documentName}.${doc.id}`);
    /** Foundry `{ "a.-=b": null }` and `{ "-=a": null }` → kernel `{ "-=a.b": null }`. */
    const toKernelDiff = (changes, source = {}) => {
      const flat = flattenObject(changes ?? {});
      const diff = {};
      for (const [path, value] of Object.entries(flat)) {
        if (path.includes("-=")) {
          const key = path.replace(/(^|\.)-=/, "$1");
          diff[`-=${key}`] = null;
        } else if (path !== "_id") diff[path] = value === undefined ? null : value;
      }
      // Foundry updates may create missing containers; the kernel deliberately
      // rejects missing dotted intermediates. Materialize only the first missing
      // branch, retaining the kernel's strict diff and schema validation.
      const result = {};
      for (const [path, value] of Object.entries(diff)) {
        if (path.startsWith("-=")) { result[path] = value; continue; }
        const parts = path.split(".");
        if (parts.some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("Unsafe document update path");
        let cursor = source, missing = -1;
        for (let i = 0; i < parts.length - 1; i++) {
          if (cursor?.[parts[i]] == null) { missing = i; break; }
          cursor = cursor[parts[i]];
        }
        if (missing < 0) { result[path] = value; continue; }
        const prefix = parts.slice(0, missing + 1).join(".");
        let branch = result[prefix] ??= {};
        for (const part of parts.slice(missing + 1, -1)) branch = branch[part] ??= {};
        branch[parts.at(-1)] = value;
      }
      return result;
    };
    const fromKernelDiff = (diff) => {
      const changes = {};
      for (const [path, value] of Object.entries(diff ?? {})) {
        if (path.startsWith("-=")) {
          const parts = path.slice(2).split("."); const last = parts.pop();
          changes[`${parts.length ? `${parts.join(".")}.` : ""}-=${last}`] = null;
        } else changes[path] = value;
      }
      return expandObject(changes);
    };
    const refOf = (doc) => (doc.parent ? { collection: doc.constructor.aisCollection, id: doc.id, parent: refOf(doc.parent) } : { collection: doc.constructor.aisCollection, id: doc.id });

    class AISDocument {
      #pack = null;
      constructor(data = {}, context = {}) {
        this.#pack = typeof context.pack === "string" ? context.pack : null;
        Object.defineProperty(this, "parent", { value: context.parent ?? null, writable: true, configurable: true });
        Object.defineProperty(this, "_source", { value: {}, writable: true, configurable: true });
        Object.defineProperty(this, "apps", { value: {}, writable: true, configurable: true });
        Object.defineProperty(this, "_aisSourceKeys", { value: new Set(), configurable: false });
        // Kernel rows (`fromSource`) already carry the store shape; module data is Foundry-shaped.
        this._source = context.fromSource ? clone(data) : this.constructor.toSource(data, context.parent ?? null);
        this._configure(context);
        this._initialize(context);
      }
      _configure() {}
      _initialize() { this._reset(this._source, this.parent === null); }
      static get documentName() { return this.metadata.name; }
      static get collectionName() { return this.metadata.collection; }
      static get aisCollection() { return this.metadata.aisCollection; }
      static get hasTypeData() { return true; }
      static get implementation() { return configuredClass(this.documentName); }
      static get TYPES() { return [...this.metadata.types]; }
      static get hierarchy() { return Object.keys(this.metadata.embedded); }
      static getEmbeddedCollectionName(name) { return this.metadata.embedded[name] ?? null; }
      static get schema() { return { fields: {} }; }
      static canUserCreate(user) { return user?.isGM === true || user?.role >= 2; }
      /** Foundry create data → kernel data: subtype into `flags.ais-foundry.type`, per-document renames, inline embedded rows converted too. */
      static toSource(data, parent) {
        const { type, ...rest } = data ?? {};
        const source = clone(rest);
        if (type !== undefined) {
          if (this.documentName === "Macro") source.kind = type === "script" ? "script" : "chat";
          else if (this.documentName === "Folder") source.targetType = FOLDER_TARGETS[type] ?? "actors";
          else { source.flags = source.flags ?? {}; source.flags[SUBTYPE_SCOPE] = { ...(source.flags[SUBTYPE_SCOPE] ?? {}), type: String(type) }; }
        }
        if (this.documentName === "Token") {
          const size = parent?.grid?.size ?? parent?._source?.grid?.size ?? 100;
          for (const key of ["width", "height"]) if (typeof source[key] === "number") source[key] *= size;
        }
        if (this.documentName === "JournalEntryPage") {
          // Foundry pages carry `{ text: { content }, src }`; the store keeps `text` as the HTML string.
          if (source.text && typeof source.text === "object") source.text = String(source.text.content ?? "");
          if (source.src === undefined) source.src = null;
        }
        for (const [documentName, key] of Object.entries(this.metadata.embedded))
          if (Array.isArray(source[key])) source[key] = source[key].map((row) => (row instanceof AISDocument ? row.toObject() : classes[documentName].toSource(row, this.documentName === "Scene" ? { grid: source.grid } : null)));
        void parent;
        return source;
      }
      /** Replace this instance's data in place (identity stays stable for module references). */
      _reset(source, prepare = true) {
        const previousEmbedded = new Map(Object.values(this.constructor.metadata.embedded).map((key) => [key, this[key] instanceof EmbeddedCollection ? this[key] : null]));
        for (const key of this._aisSourceKeys) Reflect.deleteProperty(this, key);
        this._aisSourceKeys.clear();
        this._source = source;
        const prototype = Object.getPrototypeOf(this);
        for (const [key, value] of Object.entries(source)) {
          // Embedded arrays become collections; accessor-backed fields (`type`, `folder`, `role`, …) read `_source`.
          if (key === "_id" || this.constructor.metadata.embeddedKeys.has(key) || key in prototype) continue;
          this[key] = clone(value);
          this._aisSourceKeys.add(key);
        }
        this._id = source._id;
        this.flags = this.flags ?? {};
        this.system = this.system ?? {};
        const Model = globalThis.CONFIG?.[this.documentName]?.dataModels?.[this.type];
        if (typeof Model === "function") this.system = new Model(clone(source.system ?? {}), { parent: this, strict: false });
        this.ownership = this.ownership ?? { default: 0 };
        this.name = this.name ?? "";
        for (const [documentName, key] of Object.entries(this.constructor.metadata.embedded)) {
          const rows = Array.isArray(source[key]) ? source[key] : [];
          const previous = previousEmbedded.get(key) ?? null;
          const instances = rows.map((row) => {
            const existing = previous?.get(row._id);
            if (existing) { existing._reset(row, false); return existing; }
            return new (configuredClass(documentName))(row, { parent: this, fromSource: true });
          });
          this[key] = new EmbeddedCollection(this, documentName, instances);
        }
        try { if (prepare) this.prepareData(); } catch (error) { if (stats.hookErrors.length < 32) stats.hookErrors.push({ hook: "prepareData", error: String(error?.stack ?? error?.message ?? error).slice(0, 3000) }); }
      }
      get id() { return this._id; }
      get documentName() { return this.constructor.documentName; }
      get collectionName() { return this.constructor.collectionName; }
      get collection() { return this.parent ? this.parent.getEmbeddedCollection(this.documentName) : collections[this.constructor.aisCollection]; }
      get uuid() { return uuidOf(this); }
      get isEmbedded() { return this.parent !== null; }
      get type() {
        const stored = this._source.flags?.[SUBTYPE_SCOPE]?.type;
        if (typeof stored === "string") return stored;
        return this.constructor.defaultType(this);
      }
      set type(value) { this._source.flags = this._source.flags ?? {}; this._source.flags[SUBTYPE_SCOPE] = { ...(this._source.flags[SUBTYPE_SCOPE] ?? {}), type: String(value) }; }
      static defaultType() { return "base"; }
      get permission() { return userLevel(this._source.ownership); }
      get isOwner() { return this.testUserPermission(game()?.user, "OWNER"); }
      get visible() { return this.testUserPermission(game()?.user, "LIMITED"); }
      get limited() { return this.permission === 1; }
      get sheet() { return deps.sheetFor?.(this) ?? null; }
      get link() { return `@UUID[${this.uuid}]{${this.name}}`; }
      get compendium() { return this.pack ? game()?.packs?.get(this.pack) ?? null : null; }
      get pack() { return this.parent?.pack ?? this.#pack; }
      get inCompendium() { return this.pack !== null; }
      get folder() { return typeof this._source.folder === "string" ? collections.folders?.get(this._source.folder) ?? null : null; }
      set folder(value) { this._source.folder = value?.id ?? value ?? null; }
      testUserPermission(user, permission, { exact = false } = {}) {
        const levels = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
        const required = typeof permission === "number" ? permission : levels[permission] ?? 0;
        if (user?.isGM) return exact ? required === 3 : true;
        const ownership = this.parent ? this.parent._source.ownership : this._source.ownership;
        const level = typeof ownership?.[user?.id] === "number" ? ownership[user.id] : ownership?.default ?? 0;
        return exact ? level === required : level >= required;
      }
      canUserModify(user, action) { if (this.inCompendium) return false; return action === "create" ? this.constructor.canUserCreate(user) : this.testUserPermission(user, "OWNER"); }
      prepareData() { this.system?.prepareBaseData?.(); this.prepareBaseData(); this.prepareEmbeddedDocuments(); this.system?.prepareDerivedData?.(); this.prepareDerivedData(); }
      async _preUpdate(changes, options, user) { return this.system?._preUpdate?.(changes, options, user); }
      prepareBaseData() {}
      prepareEmbeddedDocuments() {
        for (const key of this.constructor.metadata.embeddedKeys) for (const document of this[key] ?? []) document.prepareData();
      }
      prepareDerivedData() {}
      render() {}
      getFlag(scope, key) { return getProperty(this._source.flags ?? {}, `${scope}.${key}`); }
      async setFlag(scope, key, value) { return this.update({ [`flags.${scope}.${key}`]: value }); }
      async unsetFlag(scope, key) { return this.update({ [`flags.${scope}.-=${key}`]: null }); }
      toObject(source = true) { void source; return clone(this._source); }
      toJSON() { return this.toObject(); }
      clone(data = {}, { save = false, ...context } = {}) {
        const merged = deps.mergeObject(this.toObject(), data, { inplace: false });
        if (save) return this.constructor.create(merged, { parent: this.parent, ...context });
        return new this.constructor(merged, { parent: this.parent, ...context });
      }
      getEmbeddedCollection(name) {
        const key = this.constructor.metadata.embedded[name];
        if (!key) throw new Error(`${this.documentName} has no embedded ${name} documents`);
        return this[key];
      }
      getEmbeddedDocument(name, id, { strict = false } = {}) {
        const found = this.getEmbeddedCollection(name).get(id);
        if (!found && strict) throw new Error(`${name} ${id} not found in ${this.uuid}`);
        return found ?? null;
      }
      async createEmbeddedDocuments(name, data = [], options = {}) {
        if (this.inCompendium) throw new Error("Compendium documents are read-only; import a world copy first");
        const klass = classes[name];
        if (!klass || !this.constructor.metadata.embedded[name]) throw new Error(`${this.documentName} has no embedded ${name} documents`);
        return klass.createDocuments(data, { ...options, parent: this });
      }
      async updateEmbeddedDocuments(name, updates = [], options = {}) {
        if (this.inCompendium) throw new Error("Compendium documents are read-only; import a world copy first");
        const klass = classes[name];
        if (!klass || !this.constructor.metadata.embedded[name]) throw new Error(`${this.documentName} has no embedded ${name} documents`);
        return klass.updateDocuments(updates, { ...options, parent: this });
      }
      async deleteEmbeddedDocuments(name, ids = [], options = {}) {
        if (this.inCompendium) throw new Error("Compendium documents are read-only; import a world copy first");
        const klass = classes[name];
        if (!klass || !this.constructor.metadata.embedded[name]) throw new Error(`${this.documentName} has no embedded ${name} documents`);
        return klass.deleteDocuments(ids, { ...options, parent: this });
      }
      async update(changes = {}, options = {}) {
        if (this.inCompendium) throw new Error("Compendium documents are read-only; import a world copy first");
        const [updated] = await this.constructor.updateDocuments([{ ...changes, _id: this.id }], { ...options, parent: this.parent });
        return updated ?? this;
      }
      async delete(options = {}) {
        if (this.inCompendium) throw new Error("Compendium documents are read-only; import a world copy first");
        await this.constructor.deleteDocuments([this.id], { ...options, parent: this.parent });
        return this;
      }
      static async create(data = {}, context = {}) {
        const [created] = await this.createDocuments([data], context);
        return created;
      }
      static get(id) { return collections[this.aisCollection]?.get(id) ?? null; }
      static async createDocuments(data = [], context = {}) {
        const configured = configuredClass(this.documentName);
        if (this === classes[this.documentName] && configured !== this) return configured.createDocuments(data, context);
        const { parent = null, ...options } = context;
        const prepared = [];
        for (const entry of data) {
          const doc = new this(entry, { parent });
          const allowed = Hooks.call(`preCreate${this.documentName}`, doc, entry, options, userId);
          if (allowed === false) continue;
          prepared.push(doc);
        }
        if (!prepared.length) return [];
        const result = await submit(prepared.map((doc) => ({ kind: "create", collection: this.aisCollection, data: doc.toObject(), ...(parent ? { parent: refOf(parent) } : {}) })));
        return result.created.map((ref) => locate(ref)).filter((doc) => doc !== null);
      }
      static async updateDocuments(updates = [], context = {}) {
        const { parent = null, ...options } = context;
        const ops = [];
        const touched = [];
        for (const entry of updates) {
          const id = entry?._id;
          const doc = parent ? parent.getEmbeddedCollection(this.documentName).get(id) : collections[this.aisCollection]?.get(id);
          if (!doc) throw new Error(`${this.documentName} ${id} does not exist`);
          const source = this.toSource(entry, parent);
          const checkPaths = (value) => {
            if (!value || typeof value !== "object") return;
            for (const [key, child] of Object.entries(value)) {
              if (key.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("Unsafe document update path");
              checkPaths(child);
            }
          };
          checkPaths(source);
          const changes = expandObject(source);
          if (await doc._preUpdate(changes, options, userId) === false) continue;
          const allowed = Hooks.call(`preUpdate${this.documentName}`, doc, changes, options, userId);
          if (allowed === false) continue;
          const diff = toKernelDiff(changes, doc._source);
          if (!Object.keys(diff).length) continue;
          ops.push({ kind: "update", collection: this.aisCollection, id, diff, ...(parent ? { parent: refOf(parent) } : {}) });
          touched.push(doc);
        }
        if (!ops.length) return [];
        await submit(ops);
        return touched;
      }
      static async deleteDocuments(ids = [], context = {}) {
        const { parent = null, ...options } = context;
        const ops = [];
        const removed = [];
        for (const id of ids) {
          const doc = parent ? parent.getEmbeddedCollection(this.documentName).get(id) : collections[this.aisCollection]?.get(id);
          if (!doc) throw new Error(`${this.documentName} ${id} does not exist`);
          const allowed = Hooks.call(`preDelete${this.documentName}`, doc, options, userId);
          if (allowed === false) continue;
          ops.push({ kind: "delete", collection: this.aisCollection, id, ...(parent ? { parent: refOf(parent) } : {}) });
          removed.push(doc);
        }
        if (!ops.length) return [];
        await submit(ops);
        return removed;
      }
      static async fromDropData(data) { return data?.uuid ? fromUuid(data.uuid) : null; }
      static fromSource(data, context = {}) { return new this(data, context); }
    }

    const submit = async (ops) => {
      stats.writes += 1;
      try {
        const result = await AIS.documents.mutate(ops);
        await settle(result.seq);
        return result;
      } catch (error) {
        stats.rejectedWrites += 1;
        throw new Error(`Document write rejected: ${error?.message ?? error}`, { cause: error });
      }
    };
    /** Writes resolve after the host commit; the replica catches up through the change event. */
    let appliedSeq = 0;
    const waiters = new Set();
    const settle = (seq) => {
      if (typeof seq !== "number" || appliedSeq >= seq) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(entry); resolve(); }, 1500);
        const entry = { seq, resolve: () => { clearTimeout(timer); resolve(); } };
        waiters.add(entry);
      });
    };
    const locate = (ref) => {
      if (ref.parent) {
        const root = locate(ref.parent);
        if (!root) return null;
        const key = Object.values(root.constructor.metadata.embedded).find((candidate) => candidate === ref.collection);
        return key ? root[key].get(ref.id) ?? null : null;
      }
      return collections[ref.collection]?.get(ref.id) ?? null;
    };

    // ── Concrete classes ──
    const defineClass = (documentName, metadata) => {
      const klass = { [documentName]: class extends AISDocument {} }[documentName];
      Object.defineProperty(klass, "metadata", { value: Object.freeze({ ...metadata, name: documentName, embeddedKeys: new Set(Object.values(metadata.embedded)) }) });
      classes[documentName] = klass;
      return klass;
    };
    for (const root of ROOTS) defineClass(root.documentName, { collection: root.gameKey, aisCollection: root.collection, embedded: root.embedded, types: root.types });
    for (const [documentName, spec] of Object.entries(EMBEDDED)) defineClass(documentName, { collection: spec.collection, aisCollection: spec.collection, embedded: spec.embedded, types: spec.types });
    // Per-document Foundry fidelity.
    classes.Actor.defaultType = (doc) => {
      const owners = Object.entries(doc._source.ownership ?? {}).filter(([key, level]) => key !== "default" && level >= 3).map(([key]) => key);
      const users = collections.users;
      return owners.some((id) => { const user = users?.get(id); return user ? !user.isGM : true; }) ? "character" : "npc";
    };
    Object.defineProperty(classes.Actor.prototype, "itemTypes", { get() { const out = Object.fromEntries([...new Set(["base", ...Object.keys(globalThis.CONFIG?.Item?.dataModels ?? {})])].map((type) => [type, []])); for (const item of this.items) (out[item.type] = out[item.type] ?? []).push(item); return out; } });
    Object.defineProperty(classes.Actor.prototype, "prototypeToken", { get() { return this._source.prototypeToken ?? { name: this.name, flags: {} }; } });
    Object.defineProperty(classes.ActiveEffect.prototype, "statuses", { get() { return new Set(this._source.statuses ?? []); } });
    Object.defineProperty(classes.ActiveEffect.prototype, "duration", { get() { return this._source.duration ?? {}; } });
    Object.defineProperty(classes.ActiveEffect.prototype, "disabled", { get() { return this._source.disabled === true; } });
    Object.defineProperty(classes.ActiveEffect.prototype, "active", { get() { return !this.disabled && !this.isSuppressed; } });
    classes.Actor.prototype.allApplicableEffects = function* () {
      yield* this.effects ?? [];
      for (const item of this.items ?? []) for (const effect of item.effects ?? []) if (effect.transfer) yield effect;
    };
    Object.defineProperty(classes.Actor.prototype, "appliedEffects", { get() { return [...this.allApplicableEffects()].filter((effect) => !effect.disabled && !effect.isSuppressed); } });
    Object.defineProperty(classes.Actor.prototype, "statuses", { get() { return new Set(this.appliedEffects.flatMap((effect) => [...(effect.statuses ?? [])])); } });
    classes.Actor.prototype.getDependentTokens = function ({ scenes = [...(collections.scenes?.values() ?? [])] } = {}) {
      return scenes.flatMap((scene) => [...(scene.tokens?.values() ?? [])].filter((token) => token._source.actorId === this.id));
    };
    classes.Actor.prototype.getActiveTokens = function () { return this.getDependentTokens({ scenes: [...collections.scenes.values()].filter((scene) => scene.active) }).map((token) => token.object).filter(Boolean); };
    // Foundry token dimensions are grid cells; the native renderer stores pixels.
    for (const key of ["width", "height"]) Object.defineProperty(classes.Token.prototype, key, {
      get() { return this._source[key] / (this.parent?.grid?.size ?? 100); },
    });
    Object.defineProperty(classes.Token.prototype, "center", { get() { return { x: this.x + this._source.width / 2, y: this.y + this._source.height / 2 }; } });
    Object.defineProperty(classes.Token.prototype, "actor", { get() { return this._source.actorId ? collections.actors.get(this._source.actorId) ?? null : null; } });
    Object.defineProperty(classes.Token.prototype, "isLinked", { get() { return this._source.actorLink === true; } });
    classes.Actor.prototype.getRollData = function () { return clone(this.system); };
    classes.Item.prototype.getRollData = function () { return clone(this.system); };
    Object.defineProperty(classes.Item.prototype, "actor", { get() { return this.parent?.documentName === "Actor" ? this.parent : null; } });
    classes.Macro.defaultType = (doc) => (doc._source.kind === "script" ? "script" : "chat");
    Object.defineProperty(classes.Macro.prototype, "canExecute", { get() { return false; } });
    classes.Macro.prototype.execute = function () { throw new Error("Foundry compatibility profile: Macro#execute runs through ArenaStar macros, not the module frame"); };
    classes.Folder.defaultType = (doc) => Object.keys(FOLDER_TARGETS).find((key) => FOLDER_TARGETS[key] === doc._source.targetType) ?? "Actor";
    Object.defineProperty(classes.Folder.prototype, "contents", { get() { const key = ROOTS.find((root) => root.documentName === this.type)?.collection; return key ? collections[key].filter((row) => row._source.folder === this.id) : []; } });
    Object.defineProperty(classes.Folder.prototype, "children", { get() { return collections.folders.filter((row) => row._source.parent === this.id).map((folder) => ({ folder })); } });
    classes.JournalEntryPage.defaultType = (doc) => (typeof doc._source.src === "string" && doc._source.src ? "image" : "text");
    Object.defineProperty(classes.JournalEntryPage.prototype, "text", { get() { return { content: this._source.text ?? "", format: 1, markdown: "" }; } });
    classes.User.defaultType = () => "base";
    Object.defineProperty(classes.User.prototype, "isGM", { get() { return this._source.role === "GM" || this._source.role === "ASSISTANT"; } });
    Object.defineProperty(classes.User.prototype, "isSelf", { get() { return this.id === userId; } });
    Object.defineProperty(classes.User.prototype, "isTrusted", { get() { return (ROLE_NAMES[this._source.role] ?? 1) >= 2; } });
    Object.defineProperty(classes.User.prototype, "role", { get() { return ROLE_NAMES[this._source.role] ?? 1; } });
    Object.defineProperty(classes.User.prototype, "active", { get() { return this._source.active !== false; } });
    Object.defineProperty(classes.User.prototype, "character", { get() { return collections.actors.find((actor) => actor._source.ownership?.[this.id] >= 3 && !actor._source.ownership?.default) ?? null; } });
    Object.defineProperty(classes.User.prototype, "color", { get() { return this._source.color ?? "#e0b341"; } });
    Object.defineProperty(classes.User.prototype, "targets", { get() { return new Set(); } });
    classes.User.prototype.hasRole = function (role) { const want = typeof role === "number" ? role : ROLE_NAMES[String(role).toUpperCase()] ?? 0; return this.role >= want; };
    classes.User.prototype.can = function () { return this.isGM; };
    classes.User.prototype.hasPermission = function () { return this.isGM; };
    classes.ChatMessage.getSpeakerActor = ({ actor } = {}) => actor ? collections.actors.get(actor) ?? null : null;
    Object.defineProperty(classes.ChatMessage.prototype, "speaker", { get() { return this._source.speaker ?? { alias: collections.users.get(this._source.author)?.name ?? userName }; } });
    Object.defineProperty(classes.ChatMessage.prototype, "rolls", { get() { return this._source.rolls ?? []; } });
    Object.defineProperty(classes.ChatMessage.prototype, "isAuthor", { get() { return this._source.author === userId || this._source.user === userId; } });
    Object.defineProperty(classes.Combat.prototype, "started", { get() { return (this._source.round ?? 0) > 0; } });
    Object.defineProperty(classes.Combat.prototype, "combatant", { get() { return this.combatants.contents[this._source.turn ?? 0] ?? null; } });
    Object.defineProperty(classes.Combatant.prototype, "actor", { get() { return this._source.actorId ? collections.actors.get(this._source.actorId) ?? null : null; } });

    for (const root of ROOTS) collections[root.collection] = new WorldCollection(root.documentName);

    // ── Replica: hydrate + change feed ──
    const hydrate = async () => {
      const started = performance.now();
      const context = await AIS.documents.context();
      userId = context.userId; userName = context.userName;
      appliedSeq = 0;
      await Promise.all(context.collections.map(async (entry) => {
        const root = ROOTS.find((candidate) => candidate.collection === entry.collection);
        if (!root) return;
        const collection = collections[root.collection];
        collection.clear();
        let offset = 0;
        for (;;) {
          const page = await AIS.documents.list(root.collection, offset);
          for (const row of page.rows) collection.set(row._id, new (configuredClass(root.documentName))(row, { fromSource: true }));
          if (page.next === null) break;
          offset = page.next;
        }
        stats.collections[root.collection] = collection.size;
      }));
      stats.documents = Object.values(stats.collections).reduce((sum, size) => sum + size, 0);
      stats.hydrateMs = Math.round(performance.now() - started);
      // Events apply strictly in order so `appliedSeq` is monotonic and hooks see consistent replicas.
      let queue = Promise.resolve();
      AIS.events.on("documents.changed", (payload) => { queue = queue.then(() => applyChanges(payload)).catch((error) => warn(`documents.changed failed: ${error?.message ?? error}`)); });
      return stats;
    };

    const chainOf = (change) => { const chain = []; let cursor = change; while (cursor) { chain.unshift({ collection: cursor.collection, id: cursor.id }); cursor = cursor.parent; } return chain; };
    const rootClassFor = (collection) => { const root = ROOTS.find((candidate) => candidate.collection === collection); return root ? configuredClass(root.documentName) : null; };
    const embeddedClassFor = (collection) => { const name = Object.keys(EMBEDDED).find((key) => EMBEDDED[key].collection === collection); return name ? configuredClass(name) : null; };
    const fire = (name, ...args) => {
      try { Hooks.callAll(name, ...args); } catch (error) { if (stats.hookErrors.length < 32) stats.hookErrors.push({ hook: name, error: String(error?.message ?? error) }); }
    };
    const applyChanges = async (payload) => {
      stats.events += 1;
      const by = payload.by ?? null;
      const roots = new Map();
      for (const change of payload.changes) {
        const chain = chainOf(change);
        const key = `${chain[0].collection}:${chain[0].id}`;
        if (!roots.has(key)) roots.set(key, { collection: chain[0].collection, id: chain[0].id, changes: [] });
        roots.get(key).changes.push({ change, chain });
      }
      for (const root of roots.values()) {
        const collection = collections[root.collection];
        const klass = rootClassFor(root.collection);
        if (!collection || !klass) continue;
        const rootDeleted = root.changes.some(({ chain, change }) => chain.length === 1 && change.kind === "delete");
        const existing = collection.get(root.id);
        // Embedded deletions need the pre-image for their hooks.
        const embeddedRemovals = root.changes.filter(({ chain, change }) => chain.length > 1 && change.kind === "delete")
          .map(({ chain, change }) => ({ change, doc: existing ? walk(existing, chain.slice(1)) : null }));
        if (rootDeleted) {
          collection.delete(root.id);
          if (existing) fire(`delete${klass.documentName}`, existing, {}, by);
          continue;
        }
        // Updates and embedded deletions apply to the replica from the inline diffs (one awaited write
        // then costs one RPC, not two); creates, truncated feeds and anything the diff cannot express
        // re-read the root.
        const fresh = (existing && !payload.truncated ? localSource(existing, root.changes) : null)
          ?? await AIS.documents.get({ collection: root.collection, id: root.id });
        if (!fresh) { if (existing) { collection.delete(root.id); fire(`delete${klass.documentName}`, existing, {}, by); } continue; }
        let doc = existing;
        if (!doc) {
          doc = new klass(fresh, { fromSource: true });
          collection.set(root.id, doc);
          fire(`create${klass.documentName}`, doc, {}, by);
          continue;
        }
        doc._reset(fresh);
        for (const { change, chain } of root.changes) {
          if (chain.length === 1) {
            if (change.kind === "update") fire(`update${klass.documentName}`, doc, change.diff ? fromKernelDiff(change.diff) : { _id: doc.id }, {}, by);
            continue;
          }
          const embeddedClass = embeddedClassFor(change.collection);
          if (!embeddedClass) continue;
          if (change.kind === "delete") {
            const removed = embeddedRemovals.find((entry) => entry.change === change)?.doc;
            if (removed) fire(`delete${embeddedClass.documentName}`, removed, {}, by);
            continue;
          }
          const embedded = walk(doc, chain.slice(1));
          if (!embedded) continue;
          if (change.kind === "create") fire(`create${embeddedClass.documentName}`, embedded, {}, by);
          else fire(`update${embeddedClass.documentName}`, embedded, change.diff ? fromKernelDiff(change.diff) : { _id: embedded.id }, {}, by);
        }
      }
      if (typeof payload.seq === "number" && payload.seq > appliedSeq) appliedSeq = payload.seq;
      for (const waiter of [...waiters]) if (waiter.seq <= appliedSeq) { waiters.delete(waiter); waiter.resolve(); }
    };
    /** Kernel FlatDiff semantics (`src/core/diff.ts`): dotted set, `-=path: null` delete, numeric array index; missing intermediates are errors. */
    const applyKernelDiff = (target, diff) => {
      for (const [key, value] of Object.entries(diff)) {
        const isDelete = key.startsWith("-=");
        const segments = (isDelete ? key.slice(2) : key).split(".");
        let cursor = target;
        for (let depth = 0; depth < segments.length - 1; depth += 1) {
          const next = Array.isArray(cursor) ? cursor[Number(segments[depth])] : cursor[segments[depth]];
          if (next === null || typeof next !== "object") throw new Error(`diff path ${key} is missing an intermediate`);
          cursor = next;
        }
        const last = segments[segments.length - 1];
        if (Array.isArray(cursor)) {
          const index = Number(last);
          if (isDelete || !Number.isInteger(index) || index < 0 || index >= cursor.length) throw new Error(`diff path ${key} cannot address the array`);
          cursor[index] = value;
        } else if (isDelete) Reflect.deleteProperty(cursor, last);
        else cursor[last] = value;
      }
    };
    /** The root's next source from inline changes, or null when a change needs the kernel copy. */
    const localSource = (existing, changes) => {
      const source = clone(existing._source);
      try {
        for (const { change, chain } of changes) {
          if (change.kind === "create") return null;
          // Walk the cloned source and the instance tree in parallel (the instances carry the metadata).
          let sourceCursor = source; let instanceCursor = existing;
          for (const level of chain.slice(1)) {
            const key = Object.values(instanceCursor.constructor.metadata.embedded).find((candidate) => candidate === level.collection);
            const rows = key ? sourceCursor[key] : null;
            if (!Array.isArray(rows)) return null;
            if (change.kind === "delete" && level === chain[chain.length - 1]) {
              if (!rows.some((row) => row?._id === level.id)) return null;
              sourceCursor[key] = rows.filter((row) => row?._id !== level.id);
              sourceCursor = null;
              break;
            }
            sourceCursor = rows.find((row) => row?._id === level.id) ?? null;
            instanceCursor = instanceCursor[key]?.get(level.id) ?? null;
            if (!sourceCursor || !instanceCursor) return null;
          }
          if (change.kind === "delete") { if (sourceCursor !== null) return null; continue; }
          if (!change.diff || typeof change.diff !== "object") return null;
          applyKernelDiff(sourceCursor, change.diff);
        }
      } catch { return null; }
      return source;
    };
    const walk = (doc, chain) => {
      let cursor = doc;
      for (const level of chain) {
        const key = Object.values(cursor.constructor.metadata.embedded).find((candidate) => candidate === level.collection);
        cursor = key ? cursor[key].get(level.id) : undefined;
        if (!cursor) return null;
      }
      return cursor;
    };

    // ── UUID resolution for world documents (scenes stay with the scene view in adapter.js). ──
    const fromUuidSyncLocal = (uuid) => {
      const parts = String(uuid ?? "").split(".");
      const root = ROOTS.find((candidate) => candidate.documentName === parts[0]);
      if (!root || parts.length < 2) return null;
      let doc = collections[root.collection].get(parts[1]) ?? null;
      for (let index = 2; doc && index + 1 < parts.length; index += 2) {
        const key = doc.constructor.metadata.embedded[parts[index]];
        doc = key ? doc[key].get(parts[index + 1]) ?? null : null;
      }
      return doc;
    };
    const fromUuid = async (uuid) => fromUuidSyncLocal(uuid);

    const configureDocuments = () => {
      for (const root of ROOTS) {
        const collection = collections[root.collection];
        const Class = configuredClass(root.documentName);
        for (const row of [...collection.values()]) {
          if (row.constructor !== Class) collection.set(row.id, new Class(row.toObject(), { fromSource: true }));
        }
      }
    };
    const describe = () => ({ ...stats, userId, userName, collections: { ...stats.collections } });
    const me = () => (userId ? collections.users.get(userId) ?? null : null);
    return { AISDocument, classes, collections, hydrate, configureDocuments, describe, fromUuidSync: fromUuidSyncLocal, fromUuid, me, gameKeys: Object.fromEntries(ROOTS.map((root) => [root.gameKey, root.collection])),
      userId: () => userId, userName: () => userName, WorldCollection, EmbeddedCollection };
  }

  globalThis.__aisFoundryDocuments = Object.freeze({ install });
})();
