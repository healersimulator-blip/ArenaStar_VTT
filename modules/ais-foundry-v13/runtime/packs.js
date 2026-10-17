/* ArenaStar-authored compendium compatibility over AIS and distribution resources. */
(function () {
  "use strict";
  globalThis.__aisFoundryPacks = {
    install({
      AIS,
      Collection,
      Document,
      documentClasses,
      foundryId,
      clone,
      getProperty,
      setProperty,
      warn,
    }) {
      // ── D-477 / R-10: CompendiumCollection over AIS compendium.* RPCs ──
      const documentNames = {
        actors: "Actor",
        items: "Item",
        journals: "JournalEntry",
        rollTables: "RollTable",
        macros: "Macro",
        playlists: "Playlist",
        scenes: "Scene",
      };
      function resolveCompendiumReference(uuid, packs) {
        if (!String(uuid).startsWith("Compendium.")) return null;
        const reference = String(uuid).slice("Compendium.".length);
        // Match actual pack IDs, longest first; world file names may contain dots.
        for (const key of [...packs.keys()].sort(
          (a, b) => b.length - a.length,
        )) {
          if (!reference.startsWith(`${key}.`)) continue;
          const parts = reference.slice(key.length + 1).split(".");
          const pack = packs.get(key);
          if (parts.length === 1 && parts[0])
            return { pack, entryId: parts[0] };
          if (parts.length === 2 && parts[0] === pack.documentName && parts[1])
            return { pack, entryId: parts[1] };
        }
        return null;
      }
      class CompendiumCollection extends Collection {
        constructor(pack) {
          super([]);
          this._pack = pack;
          this.id = pack.collectionId ?? pack.id;
          this.collection = this.id;
          this.locked = true;
          this.metadata = {
            id: this.id,
            name: pack.name,
            label: pack.name,
            type: pack.type,
            packageName: pack.packageId ?? pack.id.split("/")[0],
            packageType: pack.packageType ?? "world",
          };
          this.documentName = documentNames[pack.type] ?? pack.type;
          this.type = pack.type;
          this.name = pack.name;
          this.title = pack.name;
          this._cache = new Map();
          this._sourceFingerprints = new Map();
          this._index = [];
          this._indexCollection = new Collection();
          this._indexed = false;
        }
        get documentClass() {
          return documentClasses[this.documentName] ?? Document;
        }
        _setIndex(rows) {
          this._index = rows;
          this._indexCollection.clear();
          for (const row of rows) this._indexCollection.set(row._id, row);
          this._indexed = true;
        }
        get index() {
          return this._indexCollection;
        }
        async getIndex({ fields } = {}) {
          // fields: array of dot-paths or object map; support for PF1e modules that request system fields
          const wantsFields = fields
            ? Array.isArray(fields)
              ? fields
              : typeof fields === "object"
                ? Object.keys(fields)
                : []
            : [];
          const needFull = wantsFields.length > 0;
          if (this._indexed && !needFull) return this._index;
          try {
            const hits = await AIS.compendium.index(this._pack.id);
            if (!needFull) {
              this._index = hits.map((hit) => ({
                _id: hit.entryId,
                id: hit.entryId,
                name: hit.name,
                type: hit.type ?? "base",
                img: hit.img ?? "",
              }));
              this._setIndex(this._index);
              return this._index;
            }
            // When fields requested, fetch full entries (bounded parallelism) to extract requested paths
            const results = [];
            const concurrency = 8;
            let idx = 0;
            const fetchOne = async (hit) => {
              try {
                const entry = await AIS.compendium.get(this._pack.id, hit.entryId);
                if (!entry)
                  return {
                    _id: hit.entryId,
                    id: hit.entryId,
                    name: hit.name,
                    type: hit.type ?? "base",
                    img: hit.img ?? "",
                  };
                const raw = entry.data ?? entry;
                const base = {
                  _id: hit.entryId,
                  id: hit.entryId,
                  name: entry.name ?? hit.name,
                  type: entry.type ?? hit.type ?? "base",
                  img: resolveEntryImg(raw) || entry.img || hit.img || "",
                };
                for (const field of wantsFields) {
                  try {
                    const val = getProperty(raw, field);
                    if (val !== undefined) setProperty(base, field, clone(val));
                  } catch {
                    /* Try the next supported representation. */
                  }
                }
                return base;
              } catch {
                return {
                  _id: hit.entryId,
                  id: hit.entryId,
                  name: hit.name,
                  type: hit.type ?? "base",
                  img: "",
                };
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
            this._setIndex(results);
            return results;
          } catch (e) {
            warn(`Compendium ${this.id} getIndex failed: ${e?.message ?? e}`);
            return [];
          }
        }
        async getDocument(entryId) {
          try {
            const entry = await AIS.compendium.get(this._pack.id, entryId);
            if (!entry) return null;
            const data = entry.data ?? entry;
            const fingerprint = JSON.stringify(data);
            if (this._sourceFingerprints.get(entryId) === fingerprint && this._cache.has(entryId)) return this._cache.get(entryId);
            const klass = documentClasses[this.documentName] ?? Document;
            // Convert compendium entry data to document
            const doc = new klass({ ...data, _id: entryId }, { fromSource: false, pack: this.id });
            this._cache.set(entryId, doc);
            this._sourceFingerprints.set(entryId, fingerprint);
            return doc;
          } catch (e) {
            warn(
              `Compendium ${this.id} getDocument ${entryId} failed: ${e?.message ?? e}`,
            );
            return null;
          }
        }
        get(id) {
          return this._cache.get(id) ?? null;
        }
        getName(name) {
          return [...this._cache.values()].find((d) => d.name === name) ?? null;
        }
        async importDocument(entryId) {
          const doc = await this.getDocument(entryId);
          if (!doc)
            throw new Error(
              `Compendium entry ${entryId} not found in ${this.id}`,
            );
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
            for (const entry of parsed)
              if (entry && typeof entry._id === "string") entries.push(entry);
            if (entries.length) return entries;
          }
          if (parsed && Array.isArray(parsed.entries)) {
            for (const entry of parsed.entries)
              if (entry && typeof entry._id === "string") entries.push(entry);
            if (entries.length) return entries;
          }
          if (parsed && typeof parsed._id === "string") {
            entries.push(parsed);
            return entries;
          }
        } catch {
          /* Try the next supported representation. */
        }
        for (const line of text.split("\n")) {
          const l = line.trim();
          if (!l) continue;
          try {
            const entry = JSON.parse(l);
            if (entry && typeof entry._id === "string") entries.push(entry);
          } catch {
            /* Try the next supported representation. */
          }
        }
        if (entries.length) return entries;
        if (text.includes("_id:") || text.includes("---"))
          warn(
            "YAML pack sources need conversion to JSON/NDJSON; refusing a lossy metadata-only import",
          );
        return entries;
      }

      function resolveEntryImg(e) {
        try {
          if (e && typeof e.img === "string" && e.img) return e.img;
          if (e && typeof e.icon === "string" && e.icon) return e.icon;
          if (e?.system && typeof e.system.img === "string" && e.system.img)
            return e.system.img;
          if (e?.data && typeof e.data.img === "string" && e.data.img)
            return e.data.img;
        } catch {
          /* Try the next supported representation. */
        }
        return "";
      }
      class FoundryCompendiumCollection extends Collection {
        constructor(packMeta, rawEntries) {
          super([]);
          this._raw = rawEntries;
          this.id = `${foundryId}.${packMeta.name}`;
          this.collection = this.id;
          this.locked = true;
          this.metadata = {
            id: this.id,
            name: packMeta.label || packMeta.name,
            label: packMeta.label || packMeta.name,
            type: packMeta.type,
            packageName: foundryId,
            packageType: "module",
          };
          this.documentName =
            packMeta.type === "JournalEntry"
              ? "JournalEntry"
              : packMeta.type === "Actor"
                ? "Actor"
                : packMeta.type === "Item"
                  ? "Item"
                  : packMeta.type;
          this.type = packMeta.type;
          this.name = packMeta.label || packMeta.name;
          this.title = packMeta.label || packMeta.name;
          this._cache = new Map();
          this._index = rawEntries.map((e) => ({
            _id: e._id,
            id: e._id,
            name: e.name,
            type: e.type || "base",
            img: resolveEntryImg(e),
          }));
          this._indexCollection = new Collection(this._index);
          for (const e of rawEntries) this._cache.set(e._id, e);
        }
        get documentClass() {
          return documentClasses[this.documentName] ?? Document;
        }
        _setIndex(rows) {
          this._index = rows;
          this._indexCollection.clear();
          for (const row of rows) this._indexCollection.set(row._id, row);
          this._indexed = true;
        }
        get index() {
          return this._indexCollection;
        }
        async getIndex({ fields } = {}) {
          if (!fields) return this._index;
          const wants = Array.isArray(fields)
            ? fields
            : typeof fields === "object"
              ? Object.keys(fields)
              : [];
          if (!wants.length) return this._index;
          const rows = this._raw.map((e) => {
            const base = {
              _id: e._id,
              id: e._id,
              name: e.name,
              type: e.type || "base",
              img: resolveEntryImg(e),
            };
            for (const f of wants) {
              try {
                const v = getProperty(e, f);
                if (v !== undefined) setProperty(base, f, clone(v));
              } catch {
                /* Try the next supported representation. */
              }
            }
            return base;
          });
          this._setIndex(rows);
          return rows;
        }
        async getDocument(entryId) {
          const cached = this._cache.get(entryId);
          if (cached instanceof Document) return cached;
          const raw = this._raw.find((e) => e._id === entryId);
          if (!raw) return null;
          try {
            const klass = documentClasses[this.documentName] ?? Document;
            const data = { ...raw, _id: entryId };
            const doc = new klass(data, { fromSource: false, pack: this.id });
            this._cache.set(entryId, doc);
            return doc;
          } catch (e) {
            warn(
              `Foundry pack ${this.id} getDocument ${entryId} failed: ${e?.message ?? e}`,
            );
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
                this._cache.set(raw._id, doc);
                return doc;
              } catch {
                return null;
              }
            }
          }
          return null;
        }
        async importDocument(entryId) {
          const doc = await this.getDocument(entryId);
          if (!doc)
            throw new Error(
              `Compendium entry ${entryId} not found in ${this.id}`,
            );
          const obj =
            typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
          const created = await (doc.constructor.create
            ? doc.constructor.create(obj, {})
            : Document.create(obj));
          return created;
        }
      }
      return {
        CompendiumCollection,
        FoundryCompendiumCollection,
        parseFoundryPackText,
        resolveCompendiumReference,
      };
    },
  };
})();
