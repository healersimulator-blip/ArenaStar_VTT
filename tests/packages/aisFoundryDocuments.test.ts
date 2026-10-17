/**
 * D-485: the adapter's Foundry Document emulation (`runtime/documents.js`) over a kernel double that
 * runs the REAL request normalization / change derivation / paging from `src/core/aisDocuments.ts`,
 * so the adapter is tested against the exact contract the kernel enforces.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { aisDocumentChanges, normalizeAisDocumentMutations, pageAisDocuments, AIS_DOCUMENT_COLLECTIONS, AIS_DOCUMENTS_LIMITS } from "../../src/core/aisDocuments";
import type { AisDocumentCollection } from "../../src/core/aisDocuments";
import type { BaseDocument, Json } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";

type Row = Record<string, unknown> & { _id: string };

const source = readFileSync(new URL("../../modules/ais-foundry-v13/runtime/documents.js", import.meta.url), "utf8");
const realm = globalThis as unknown as { __aisFoundryDocuments?: { install: (deps: Record<string, unknown>) => Record<string, unknown> } };
new Function(source)();

// ── Minimal foundry.utils equivalents (the adapter passes its own; these mirror their contract). ──
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const clone = <T,>(value: T): T => (Array.isArray(value) ? value.map(clone) : isPlain(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) : value) as T;
const flattenObject = (object: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> => {
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlain(value) && Object.keys(value).length) flattenObject(value, path, out); else out[path] = value;
  }
  return out;
};
const expandObject = (flat: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split("."); let cursor = out;
    for (const part of parts.slice(0, -1)) { if (!isPlain(cursor[part])) cursor[part] = {}; cursor = cursor[part] as Record<string, unknown>; }
    cursor[parts[parts.length - 1] ?? ""] = value;
  }
  return out;
};
const getProperty = (object: unknown, path: string): unknown => path.split(".").reduce<unknown>((cursor, part) => (isPlain(cursor) ? cursor[part] : undefined), object);
const mergeObject = (target: Record<string, unknown>, other: Record<string, unknown>): Record<string, unknown> => expandObject({ ...flattenObject(clone(target)), ...flattenObject(clone(other)) });
class Collection extends Map<string, Row> {
  constructor(rows: Row[] = []) { super(rows.map((row) => [(row as { id?: string }).id ?? row._id, row])); }
  // Foundry collections iterate VALUES; the adapter's Collection does the same (typed loosely here on purpose).
  override [Symbol.iterator]() { return this.values() as unknown as MapIterator<[string, Row]>; }
  get contents() { return [...this.values()]; }
  find(fn: (row: Row) => boolean) { return this.contents.find(fn); }
  filter(fn: (row: Row) => boolean) { return this.contents.filter(fn); }
  map<T>(fn: (row: Row) => T) { return this.contents.map(fn); }
  some(fn: (row: Row) => boolean) { return this.contents.some(fn); }
}

// ── Kernel double: real normalization/paging/changes over an in-memory world. ──
const byteLength = (value: unknown): number | null => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const boundedJson = (value: unknown): value is Json => { try { JSON.stringify(value); return true; } catch { return false; } };
type World = Record<AisDocumentCollection, Row[]>;
const baseRow = (id: string, type: string, extra: Record<string, unknown> = {}): Row => ({ _id: id, type, name: id, ownership: { default: 0 }, flags: {}, system: {}, ...extra });

function makeKernel(world: World, userId: string) {
  const listeners: Array<(payload: unknown) => void> = [];
  let seq = 10;
  let counter = 0;
  const resolve = (coll: string, id: string, parent?: { coll: string; id: string; parent?: unknown }): { list: Row[]; row: Row | undefined } => {
    if (!parent) { const list = world[coll as AisDocumentCollection]; return { list, row: list.find((row) => row._id === id) }; }
    const above = resolve(parent.coll, parent.id, parent.parent as never);
    const list = (above.row?.[coll] ?? []) as Row[];
    return { list, row: list.find((row) => row._id === id) };
  };
  const setPath = (row: Row, path: string, value: unknown): void => {
    const parts = path.split("."); let cursor: Record<string, unknown> = row;
    for (const part of parts.slice(0, -1)) { if (!isPlain(cursor[part])) cursor[part] = {}; cursor = cursor[part] as Record<string, unknown>; }
    cursor[parts[parts.length - 1] ?? ""] = value;
  };
  const deletePath = (row: Row, path: string): void => {
    const parts = path.split("."); let cursor: Record<string, unknown> = row;
    for (const part of parts.slice(0, -1)) { if (!isPlain(cursor[part])) return; cursor = cursor[part] as Record<string, unknown>; }
    Reflect.deleteProperty(cursor, parts[parts.length - 1] ?? "");
  };
  const apply = (ops: Op[]): void => {
    for (const op of ops) {
      if (op.kind === "create") {
        const target = op.parent ? resolve(op.coll, "", op.parent as never).list : world[op.coll as AisDocumentCollection];
        target.push(clone(op.data) as unknown as Row);
      } else {
        const { list, row } = resolve(op.ref.coll, op.ref.id, op.ref.parent as never);
        if (!row) throw new Error(`${op.ref.coll} ${op.ref.id} missing`);
        if (op.kind === "delete") list.splice(list.indexOf(row), 1);
        else for (const [path, value] of Object.entries(op.diff)) if (path.startsWith("-=")) deletePath(row, path.slice(2)); else setPath(row, path, clone(value));
      }
    }
  };
  const emit = (payload: unknown): void => { for (const listener of listeners) listener(payload); };
  const reads: unknown[] = [];
  const AIS = {
    documents: {
      context: async () => ({ userId, userName: userId, limits: { ...AIS_DOCUMENTS_LIMITS },
        collections: (Object.keys(AIS_DOCUMENT_COLLECTIONS) as AisDocumentCollection[]).map((collection) => ({ collection, writable: AIS_DOCUMENT_COLLECTIONS[collection].writable,
          embedded: Object.keys(AIS_DOCUMENT_COLLECTIONS[collection].embedded), size: world[collection].length })) }),
      list: async (collection: AisDocumentCollection, offset?: number, limit?: number) => pageAisDocuments(collection, world[collection] as unknown as BaseDocument[], offset, limit, byteLength),
      get: async (ref: { collection: string; id: string; parent?: unknown }) => {
        reads.push(ref);
        const chain: Array<{ collection: string; id: string }> = []; let cursor: unknown = ref;
        while (isPlain(cursor)) { chain.unshift({ collection: String(cursor.collection), id: String(cursor.id) }); cursor = cursor.parent; }
        let row: Row | undefined = world[chain[0]?.collection as AisDocumentCollection]?.find((entry) => entry._id === chain[0]?.id);
        for (const level of chain.slice(1)) row = ((row?.[level.collection] ?? []) as Row[]).find((entry) => entry._id === level.id);
        return row ? clone(row) : null;
      },
      mutate: async (ops: unknown) => {
        const normalized = normalizeAisDocumentMutations(ops, { userId, newId: () => `doc-${++counter}`, boundedJson });
        if (!normalized.ok) throw new Error(normalized.error);
        apply(normalized.value.ops);
        seq += 1;
        const payload = aisDocumentChanges(seq, userId, normalized.value.ops, byteLength);
        setTimeout(() => emit(payload), 0);
        return { txId: `tx-${seq}`, created: normalized.value.created, seq };
      },
    },
    events: { on: (event: string, callback: (payload: unknown) => void) => { if (event === "documents.changed") listeners.push(callback); return () => undefined; } },
    chat: { post: async () => ({ ok: true }) },
  };
  return { AIS, apply, reads, emitExternal: (ops: Op[]) => { apply(ops); seq += 1; emit(aisDocumentChanges(seq, "u-other", ops, byteLength)); } };
}

function makeHooks() {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const Hooks = {
    on: (name: string, fn: (...args: unknown[]) => unknown) => { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    call: (name: string, ...args: unknown[]) => { calls.push({ name, args }); for (const fn of hooks.get(name) ?? []) if (fn(...args) === false) return false; return true; },
    callAll: (name: string, ...args: unknown[]) => { calls.push({ name, args }); for (const fn of hooks.get(name) ?? []) fn(...args); return true; },
  };
  return { Hooks, calls };
}

function installLayer(world: World, userId = "u-gm") {
  const kernel = makeKernel(world, userId);
  const { Hooks, calls } = makeHooks();
  const warnings: string[] = [];
  const layer = realm.__aisFoundryDocuments?.install({ AIS: kernel.AIS, Hooks, warn: (text: string) => warnings.push(text), clone, flattenObject, expandObject, getProperty, mergeObject,
    Collection, game: () => ({ user: (layer as unknown as { me: () => unknown }).me() }) }) as Record<string, never>;
  return { layer: layer as unknown as LayerApi, kernel, Hooks, calls, warnings, world };
}
interface DocLike { id: string; uuid: string; type: string; name: string; parent: DocLike | null; system: Record<string, unknown>; flags: Record<string, unknown>; isGM?: boolean;
  items: Collection; getFlag(scope: string, key: string): unknown; setFlag(scope: string, key: string, value: unknown): Promise<DocLike>; unsetFlag(scope: string, key: string): Promise<DocLike>;
  update(changes: Record<string, unknown>): Promise<DocLike>; delete(): Promise<DocLike>; createEmbeddedDocuments(name: string, rows: Record<string, unknown>[]): Promise<DocLike[]>;
  deleteEmbeddedDocuments(name: string, ids: string[]): Promise<DocLike[]>; toObject(): Row; isOwner: boolean; _source: Row; }
interface DocClass { create(data: Record<string, unknown>): Promise<DocLike>; TYPES: string[]; documentName: string; new (data: Record<string, unknown>, context?: Record<string, unknown>): DocLike }
interface LayerApi { classes: Record<string, DocClass>; collections: Record<string, Collection>; hydrate(): Promise<{ documents: number; hydrateMs: number }>; me(): DocLike | null;
  fromUuidSync(uuid: string): DocLike | null; describe(): { writes: number; rejectedWrites: number; events: number; hookErrors: unknown[] }; userId(): string | null }

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const cls = (layer: LayerApi, name: string): DocClass => { const klass = layer.classes[name]; if (!klass) throw new Error(`no class ${name}`); return klass; };
const must = <T,>(value: T | undefined | null): T => { if (value === undefined || value === null) throw new Error("missing value"); return value; };
const freshWorld = (): World => ({
  actors: [baseRow("a-npc", "actor", { ownership: { default: 0, "u-gm": 3 }, items: [baseRow("i-sword", "item", { effects: [] })], effects: [] }),
    baseRow("a-pc", "actor", { name: "Valeros", ownership: { default: 0, "u-player": 3 }, items: [], effects: [] })],
  items: [], journals: [baseRow("j1", "journal", { pages: [baseRow("p1", "page", { text: "<p>hi</p>", src: null })] })], rollTables: [], macros: [], folders: [], playlists: [], combats: [],
  users: [baseRow("u-gm", "user", { name: "Game Master", role: "GM" }), baseRow("u-player", "user", { name: "Pat", role: "PLAYER" })], messages: [], scenes: [],
});

describe("ais-foundry-v13 documents layer", () => {
  let t: ReturnType<typeof installLayer>;
  beforeEach(async () => { t = installLayer(freshWorld()); await t.layer.hydrate(); });

  test("compendium identities remain read-only and never alias world document writes", async () => {
    const Item = t.layer.classes.Item;
    if (!Item) throw new Error("Item class missing");
    const doc = new Item({ _id: "source-id", name: "Source", type: "feat" }, { pack: "content.feats" });
    expect(doc.uuid).toBe("Compendium.content.feats.Item.source-id");
    expect(doc.toObject()).not.toHaveProperty("pack");
    await expect(doc.update({ name: "Changed" })).rejects.toThrow("read-only");
    await expect(doc.delete()).rejects.toThrow("read-only");
    expect(t.layer.describe().writes).toBe(0);
  });
  test("hydrates every exposed collection, resolves the device user and derives Foundry subtypes", () => {
    expect(t.layer.collections.actors?.size).toBe(2);
    expect(t.layer.collections.users?.size).toBe(2);
    expect(t.layer.me()?.name).toBe("Game Master");
    expect(t.layer.me()?.isGM).toBe(true);
    const npc = t.layer.collections.actors?.get("a-npc") as unknown as DocLike;
    const pc = t.layer.collections.actors?.get("a-pc") as unknown as DocLike;
    expect(npc.type).toBe("npc");
    expect(pc.type).toBe("character");
    expect(npc.items.size).toBe(1);
    expect(t.layer.fromUuidSync("Actor.a-npc.Item.i-sword")?.parent).toBe(npc);
    expect(t.layer.fromUuidSync("JournalEntry.j1.JournalEntryPage.p1")?.type).toBe("text");
    expect(t.layer.classes.Actor?.TYPES).toEqual(["base", "character", "npc"]);
  });

  test("Actor.create stores the kind marker + subtype flag, returns the replica instance and fires createActor once", async () => {
    const actor = await cls(t.layer, "Actor").create({ name: "Guard", type: "npc", system: { hp: 3 }, flags: { mod: { a: 1 } } });
    expect(actor.uuid).toBe("Actor.doc-1");
    expect(actor.type).toBe("npc");
    expect(actor.system).toEqual({ hp: 3 });
    expect(t.world.actors.find((row) => row._id === "doc-1")).toMatchObject({ type: "actor", flags: { mod: { a: 1 }, "ais-foundry": { type: "npc" } }, ownership: { default: 0, "u-gm": 3 } });
    await flush();
    const created = t.calls.filter((call) => call.name === "createActor");
    expect(created).toHaveLength(1);
    expect(created[0]?.args[0]).toBe(actor);
    expect(created[0]?.args[2]).toBe("u-gm");
    expect(t.layer.collections.actors?.get("doc-1")).toBe(actor);
  });

  test("flags round-trip through dotted diffs, the instance refreshes in place and updateActor carries expanded changes", async () => {
    const actor = t.layer.collections.actors?.get("a-npc") as unknown as DocLike;
    await actor.setFlag("mod", "k", 1);
    await flush();
    expect(actor.getFlag("mod", "k")).toBe(1);
    expect(t.layer.collections.actors?.get("a-npc")).toBe(actor);
    const update = t.calls.find((call) => call.name === "updateActor");
    expect(update?.args[0]).toBe(actor);
    expect(update?.args[1]).toEqual({ flags: { mod: { k: 1 } } });
    await actor.unsetFlag("mod", "k");
    await flush();
    expect(actor.getFlag("mod", "k")).toBeUndefined();
    expect(t.world.actors.find((row) => row._id === "a-npc")?.flags).toEqual({ mod: {} });
    expect(t.calls.filter((call) => call.name === "preUpdateActor")).toHaveLength(2);
  });

  test("Foundry token cells convert to native pixels using the parent scene grid", () => {
    const Scene = cls(t.layer, "Scene"), Token = cls(t.layer, "Token");
    const scene = new Scene({ _id: "grid-scene", grid: { size: 80 } });
    const token = new Token({ _id: "sized", x: 20, y: 30, width: 2, height: 1 }, { parent: scene }) as unknown as { width: number; height: number; center: { x: number; y: number }; _source: Row };
    expect(token._source.width).toBe(160);
    expect(token._source.height).toBe(80);
    expect(token.width).toBe(2);
    expect(token.height).toBe(1);
    expect(token.center).toEqual({ x: 100, y: 70 });
  });

  test("missing update containers are materialized without losing sibling writes", async () => {
    const actor = t.layer.collections.actors?.get("a-npc") as unknown as DocLike;
    await actor.update({ "system.attributes.hp.value": 9, "system.attributes.hp.temp": 2 });
    expect(actor.system.attributes).toEqual({ hp: { value: 9, temp: 2 } });
    expect(t.calls.find((call) => call.name === "updateActor")?.args[1]).toEqual({ system: { attributes: { hp: { value: 9, temp: 2 } } } });
    await expect(actor.update({ "system.__proto__.polluted": true })).rejects.toThrow("Unsafe document update path");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("dependent tokens resolve linked world actors and respect the requested scenes", async () => {
    const actor = t.layer.collections.actors?.get("a-npc") as unknown as DocLike & { getDependentTokens(options?: object): Array<DocLike & { actor: DocLike; isLinked: boolean }> };
    const Scene = t.layer.classes.Scene;
    if (!Scene) throw new Error("Scene class missing");
    const scene = new Scene({ _id: "test-scene", tokens: [{ _id: "test-token", actorId: actor.id, actorLink: true }] });
    const tokens = actor.getDependentTokens({ scenes: [scene] });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.actor).toBe(actor);
    expect(tokens[0]?.isLinked).toBe(true);
    expect(actor.getDependentTokens({ scenes: [] })).toEqual([]);
  });

  test("pre-hooks cancel writes; rejected transactions throw Foundry-style", async () => {
    const actor = t.layer.collections.actors?.get("a-npc") as unknown as DocLike;
    t.Hooks.on("preUpdateActor", () => false);
    await actor.update({ name: "Nope" });
    expect(actor.name).toBe("a-npc");
    expect(t.layer.describe().writes).toBe(0);
    const user = t.layer.collections.users?.get("u-gm") as unknown as DocLike;
    await expect(user.update({ name: "x" })).rejects.toThrow(/Document write rejected: .*read-only/);
    expect(t.layer.describe().rejectedWrites).toBe(1);
  });

  test("embedded documents: create/update/delete under a parent with Foundry hook names and uuids", async () => {
    const actor = t.layer.collections.actors?.get("a-npc") as unknown as DocLike;
    const [torch] = await actor.createEmbeddedDocuments("Item", [{ name: "Torch", type: "weapon", system: { lit: false } }]);
    expect(torch?.parent).toBe(actor);
    expect(torch?.type).toBe("weapon");
    expect(torch?.uuid).toBe("Actor.a-npc.Item.doc-1");
    expect(actor.items.size).toBe(2);
    await flush();
    expect(t.calls.filter((call) => call.name === "createItem").map((call) => call.args[0])).toEqual([torch]);
    await must(torch).update({ "system.lit": true });
    await flush();
    expect(torch?.system).toEqual({ lit: true });
    expect(actor.items.get("doc-1")).toBe(torch);
    expect(t.layer.fromUuidSync("Actor.a-npc.Item.doc-1")).toBe(torch);
    const updateItem = t.calls.find((call) => call.name === "updateItem");
    expect(updateItem?.args[0]).toBe(torch);
    expect(updateItem?.args[1]).toEqual({ system: { lit: true } });
    await actor.deleteEmbeddedDocuments("Item", ["doc-1"]);
    await flush();
    expect(actor.items.size).toBe(1);
    expect(t.calls.find((call) => call.name === "deleteItem")?.args[0]).toBe(torch);
  });

  test("shell-originated changes refresh the replica and fire the same post hooks; deletes drop instances", async () => {
    const actor = t.layer.collections.actors?.get("a-pc") as unknown as DocLike;
    t.kernel.emitExternal([{ kind: "update", ref: { coll: "actors", id: "a-pc" }, diff: { "system.hp.value": 7 } }]);
    await flush();
    expect(actor.system).toEqual({ hp: { value: 7 } });
    expect(t.calls.find((call) => call.name === "updateActor")?.args).toEqual([actor, { system: { hp: { value: 7 } } }, {}, "u-other"]);
    t.kernel.emitExternal([{ kind: "delete", ref: { coll: "actors", id: "a-pc" } }]);
    await flush();
    expect(t.layer.collections.actors?.has("a-pc")).toBe(false);
    expect(t.calls.find((call) => call.name === "deleteActor")?.args[0]).toBe(actor);
    await actor.delete().catch(() => undefined);
  });

  test("replica economy: updates and embedded deletes apply from the inline diff without documents.get; creates re-read the root", async () => {
    const actor = t.layer.collections.actors?.get("a-pc") as unknown as DocLike;
    t.kernel.reads.length = 0;
    // Root update + nested path + key deletion: applied locally with kernel FlatDiff semantics
    // (intermediates must exist, exactly as the store requires of the op itself).
    t.kernel.emitExternal([{ kind: "update", ref: { coll: "actors", id: "a-pc" }, diff: { system: { hp: { value: 5 } }, "flags.other": { seen: true } } }]);
    await flush();
    t.kernel.emitExternal([{ kind: "update", ref: { coll: "actors", id: "a-pc" }, diff: { "system.hp.value": 3, "-=flags.other": null, name: "Renamed" } }]);
    await flush();
    expect(actor.system).toEqual({ hp: { value: 3 } });
    expect(actor.name).toBe("Renamed");
    expect(actor.flags).not.toHaveProperty("other");
    expect(t.kernel.reads).toEqual([]);
    // Embedded create needs the kernel copy (the feed carries no row data); the instance stays stable.
    const createdSword = await (actor as unknown as { createEmbeddedDocuments: (name: string, rows: unknown[]) => Promise<DocLike[]> }).createEmbeddedDocuments("Item", [{ name: "Sword", type: "weapon", system: { dmg: 4 } }]);
    const sword = createdSword[0];
    if (!sword) throw new Error("embedded create returned no row");
    expect(t.kernel.reads).toHaveLength(1);
    expect(t.layer.collections.actors?.get("a-pc")).toBe(actor);
    // Embedded update + embedded delete from another device: no re-read, hooks still fire with the pre-image.
    t.kernel.reads.length = 0;
    t.kernel.emitExternal([{ kind: "update", ref: { coll: "items", id: sword.id, parent: { coll: "actors", id: "a-pc" } }, diff: { "system.dmg": 6 } }]);
    await flush();
    expect((actor as unknown as { items: { get: (id: string) => DocLike } }).items.get(sword.id)).toBe(sword);
    expect(sword.system).toEqual({ dmg: 6 });
    t.kernel.emitExternal([{ kind: "delete", ref: { coll: "items", id: sword.id, parent: { coll: "actors", id: "a-pc" } } }]);
    await flush();
    expect((actor as unknown as { items: { has: (id: string) => boolean } }).items.has(sword.id)).toBe(false);
    expect(t.calls.filter((call) => call.name === "deleteItem").at(-1)?.args[0]).toBe(sword);
    expect(t.kernel.reads).toEqual([]);
    // A diff the replica cannot apply (missing intermediate) falls back to the kernel copy instead of guessing.
    t.kernel.emitExternal([{ kind: "update", ref: { coll: "actors", id: "a-pc" }, diff: { "system.ac.base": 10 } }]);
    await flush();
    expect(t.kernel.reads).toHaveLength(1);
    expect(actor.system).toEqual({ hp: { value: 3 }, ac: { base: 10 } });
  });

  test("JournalEntry.create with inline Foundry pages lands as store-shaped pages", async () => {
    const journal = await cls(t.layer, "JournalEntry").create({ name: "Notes", pages: [{ name: "P1", type: "text", text: { content: "<p>x</p>" } }, { name: "Map", type: "image", src: "a.png" }] });
    expect(t.world.journals.find((row) => row.name === "Notes")?.pages).toMatchObject([
      { type: "page", name: "P1", text: "<p>x</p>", src: null, flags: { "ais-foundry": { type: "text" } } },
      { type: "page", name: "Map", text: "", src: "a.png", flags: { "ais-foundry": { type: "image" } } },
    ]);
    const pages = (journal as unknown as { pages: Collection }).pages.contents as unknown as DocLike[];
    expect(pages.map((page) => page.type)).toEqual(["text", "image"]);
    expect((pages[0] as unknown as { text: { content: string } }).text.content).toBe("<p>x</p>");
  });

  test("macros and folders translate Foundry `type`; creator ownership follows the device user", async () => {
    const macro = await cls(t.layer, "Macro").create({ name: "Hi", type: "script", command: "console.log(1)" });
    expect(t.world.macros[0]).toMatchObject({ type: "macro", kind: "script", command: "console.log(1)" });
    expect(macro.type).toBe("script");
    const folder = await cls(t.layer, "Folder").create({ name: "NPCs", type: "Actor" });
    expect(t.world.folders[0]).toMatchObject({ type: "folder", targetType: "actors", parent: null });
    expect(folder.type).toBe("Actor");
    const player = installLayer(freshWorld(), "u-player");
    await player.layer.hydrate();
    expect(player.layer.me()?.isGM).toBe(false);
    const own = await cls(player.layer, "Item").create({ name: "Rope" });
    expect(player.world.items[0]?.ownership).toEqual({ default: 0, "u-player": 3 });
    expect(own.isOwner).toBe(true);
  });
});
