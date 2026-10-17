/**
 * D-485: the kernel's generic document service — request normalization, change derivation and
 * paging. Authority is never decided here (the host validates the resulting transaction), so these
 * tests pin what the kernel adds (defaults, kind markers, bounds) and what it refuses.
 */
import { describe, expect, test } from "vitest";
import {
  AIS_DOCUMENTS_LIMITS,
  AIS_DOCUMENT_COLLECTION_NAMES,
  aisDiffPathError,
  aisDocumentChanges,
  normalizeAisDocumentMutations,
  pageAisDocuments,
  resolveAisDocumentRef,
} from "../../src/core/aisDocuments";
import type { BaseDocument, Json } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";

const byteLength = (value: unknown): number | null => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const boundedJson = (value: unknown): value is Json => { try { JSON.stringify(value); return true; } catch { return false; } };
const input = { userId: "u-player", newId: () => "doc-new", boundedJson };

describe("AIS document service: refs and collections", () => {
  test("exposes world collections, never host-only ones", () => {
    expect(AIS_DOCUMENT_COLLECTION_NAMES).toEqual(["scenes", "actors", "items", "journals", "rollTables", "macros", "folders", "playlists", "combats", "users", "messages"]);
    for (const hidden of ["settings", "automations", "actionReceipts", "fxInstances", "compendia", "prefabs"])
      expect(resolveAisDocumentRef(hidden, undefined)).toMatchObject({ ok: false });
  });

  test("resolves embedded chains against the parent kind", () => {
    const item = resolveAisDocumentRef("items", { collection: "actors", id: "a1" });
    expect(item).toMatchObject({ ok: true, value: { coll: "items", kind: "item", root: "actors", parent: { coll: "actors", id: "a1" } } });
    const effect = resolveAisDocumentRef("effects", { collection: "items", id: "i1", parent: { collection: "actors", id: "a1" } });
    expect(effect).toMatchObject({ ok: true, value: { coll: "effects", kind: "effect", root: "actors", parent: { coll: "items", id: "i1", parent: { coll: "actors", id: "a1" } } } });
    expect(resolveAisDocumentRef("pages", { collection: "actors", id: "a1" })).toMatchObject({ ok: false, error: expect.stringContaining("not an embedded collection of actor") });
    expect(resolveAisDocumentRef("items", { collection: "actors" })).toMatchObject({ ok: false });
  });

  test("diff paths: kernel-owned heads and prototype segments are refused", () => {
    expect(aisDiffPathError("system.hp.value")).toBeNull();
    expect(aisDiffPathError("-=flags.mod.key")).toBeNull();
    expect(aisDiffPathError("_id")).toMatch(/kernel-owned/);
    expect(aisDiffPathError("type")).toMatch(/kernel-owned/);
    expect(aisDiffPathError("flags.__proto__.x")).toMatch(/not allowed/);
    expect(aisDiffPathError("flags..x")).toMatch(/empty segment/);
  });
});

describe("AIS document service: mutations", () => {
  test("create fills kernel defaults, forces the kind marker and makes the creator the owner", () => {
    const result = normalizeAisDocumentMutations([
      { kind: "create", collection: "actors", data: { name: "Guard", type: "npc", system: { hp: 3 }, flags: { mod: { a: 1 } } } },
      { kind: "create", collection: "macros", data: { name: "Hi", kind: "script", command: "1" } },
    ], input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [actor, macro] = result.value.ops as Array<Extract<Op, { kind: "create" }>>;
    expect(actor?.data).toMatchObject({ _id: "doc-new", type: "actor", name: "Guard", ownership: { default: 0, "u-player": 3 }, items: [], effects: [], system: { hp: 3 }, flags: { mod: { a: 1 } } });
    expect(macro?.data).toMatchObject({ type: "macro", kind: "script", command: "1", ownership: { default: 0, "u-player": 3 } });
    expect(result.value.created).toEqual([{ collection: "actors", id: "doc-new" }, { collection: "macros", id: "doc-new" }]);
  });

  test("inline embedded rows of a create get ids, kind markers and defaults (recursively)", () => {
    let n = 0;
    const result = normalizeAisDocumentMutations([
      { kind: "create", collection: "actors", data: { name: "Mara", items: [{ name: "Torch", effects: [{ name: "Lit" }] }], effects: [] } },
      { kind: "create", collection: "journals", data: { name: "Notes", pages: [{ name: "P1", text: "<p>x</p>", flags: { "ais-foundry": { type: "text" } } }] } },
    ], { ...input, newId: () => `id-${++n}` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [actor, journal] = result.value.ops as Array<Extract<Op, { kind: "create" }>>;
    expect(actor?.data).toMatchObject({ _id: "id-1", items: [{ _id: "id-3", type: "item", name: "Torch", ownership: { default: 0 }, flags: {}, system: {},
      effects: [{ _id: "id-2", type: "effect", name: "Lit", changes: [], disabled: false }] }], effects: [] });
    expect(journal?.data).toMatchObject({ _id: "id-4", pages: [{ _id: "id-5", type: "page", name: "P1", text: "<p>x</p>", src: null, flags: { "ais-foundry": { type: "text" } } }] });
    expect(normalizeAisDocumentMutations([{ kind: "create", collection: "actors", data: { items: "nope" } }], input)).toMatchObject({ ok: false, error: "ops[0]: items must be an array" });
  });

  test("embedded creates carry the parent ref and inherit no owner entry", () => {
    const result = normalizeAisDocumentMutations([
      { kind: "create", collection: "items", parent: { collection: "actors", id: "a1" }, data: { _id: "i9", name: "Torch" } },
    ], input);
    expect(result).toMatchObject({ ok: true, value: {
      ops: [{ kind: "create", coll: "items", parent: { coll: "actors", id: "a1" }, data: { _id: "i9", type: "item", name: "Torch", effects: [], ownership: { default: 0 } } }],
      created: [{ collection: "items", id: "i9", parent: { collection: "actors", id: "a1" } }],
    } });
  });

  test("update and delete map to store refs; invalid shapes are refused with the op index", () => {
    const ok = normalizeAisDocumentMutations([
      { kind: "update", collection: "actors", id: "a1", diff: { "flags.mod.k": 1, "-=flags.mod.old": null } },
      { kind: "delete", collection: "items", id: "i1", parent: { collection: "actors", id: "a1" } },
    ], input);
    expect(ok).toMatchObject({ ok: true, value: { ops: [
      { kind: "update", ref: { coll: "actors", id: "a1" }, diff: { "flags.mod.k": 1, "-=flags.mod.old": null } },
      { kind: "delete", ref: { coll: "items", id: "i1", parent: { coll: "actors", id: "a1" } } },
    ] } });
    expect(normalizeAisDocumentMutations([{ kind: "update", collection: "actors", id: "a1", diff: { _id: "x" } }], input)).toMatchObject({ ok: false, error: "ops[0]: diff path \"_id\" is kernel-owned" });
    expect(normalizeAisDocumentMutations([{ kind: "update", collection: "users", id: "u1", diff: { name: "x" } }], input)).toMatchObject({ ok: false, error: "ops[0]: users is read-only for modules" });
    expect(normalizeAisDocumentMutations([{ kind: "create", collection: "settings", data: {} }], input)).toMatchObject({ ok: false, error: expect.stringContaining("not exposed") });
    expect(normalizeAisDocumentMutations([{ kind: "create", collection: "actors", data: { ownership: { default: 9 } } }], input)).toMatchObject({ ok: false, error: expect.stringContaining("ownership") });
    expect(normalizeAisDocumentMutations([{ kind: "poke", collection: "actors", id: "a1" }], input)).toMatchObject({ ok: false, error: "ops[0]: kind must be create, update or delete" });
    expect(normalizeAisDocumentMutations([], input)).toMatchObject({ ok: false });
    expect(normalizeAisDocumentMutations(Array.from({ length: AIS_DOCUMENTS_LIMITS.opsPerMutation + 1 }, () => ({ kind: "delete", collection: "actors", id: "a1" })), input))
      .toMatchObject({ ok: false, error: expect.stringContaining("at most 32 ops") });
  });
});

describe("AIS document service: change feed and paging", () => {
  const doc = (id: string, extra: Record<string, Json> = {}): BaseDocument => ({ _id: id, type: "actor", name: id, ownership: { default: 0 }, flags: {}, system: {}, ...extra });

  test("derives per-op changes for exposed roots only and keeps small diffs inline", () => {
    const ops: Op[] = [
      { kind: "create", coll: "actors", data: doc("a1") },
      { kind: "update", ref: { coll: "items", id: "i1", parent: { coll: "actors", id: "a1" } }, diff: { "system.q": 2 } },
      { kind: "delete", ref: { coll: "tokens", id: "t1", parent: { coll: "scenes", id: "s1" } } },
      { kind: "update", ref: { coll: "settings", id: "ais-settings:x" }, diff: { "system.v": 1 } },
      { kind: "update", ref: { coll: "journals", id: "j1" }, diff: { "pages": "x".repeat(AIS_DOCUMENTS_LIMITS.changeDiffBytes) } },
    ];
    expect(aisDocumentChanges(7, "gm", ops, byteLength)).toEqual({ seq: 7, by: "gm", truncated: false, changes: [
      { kind: "create", collection: "actors", id: "a1" },
      { kind: "update", collection: "items", id: "i1", parent: { collection: "actors", id: "a1" }, diff: { "system.q": 2 } },
      { kind: "delete", collection: "tokens", id: "t1", parent: { collection: "scenes", id: "s1" } },
      { kind: "update", collection: "journals", id: "j1" },
    ] });
    expect(aisDocumentChanges(8, "gm", [{ kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { name: "x" } }], byteLength)).toEqual({ seq: 8, by: "gm", truncated: false, changes: [{ kind: "update", collection: "scenes", id: "s1", diff: { name: "x" } }] });
  });

  test("pages by count and bytes with a stable next offset", () => {
    const rows = Array.from({ length: 7 }, (_, index) => doc(`a${index}`, { system: { pad: "p".repeat(index === 3 ? AIS_DOCUMENTS_LIMITS.listBytes : 10) } }));
    const first = pageAisDocuments("actors", rows, 0, 3, byteLength);
    expect(first).toMatchObject({ total: 7, offset: 0, next: 3 });
    expect(first.rows.map((row) => row._id)).toEqual(["a0", "a1", "a2"]);
    // The oversized row still ships (alone), then paging resumes after it.
    const second = pageAisDocuments("actors", rows, 3, 3, byteLength);
    expect(second.rows.map((row) => row._id)).toEqual(["a3"]);
    expect(second.next).toBe(4);
    const last = pageAisDocuments("actors", rows, 4, 500, byteLength);
    expect(last.rows.map((row) => row._id)).toEqual(["a4", "a5", "a6"]);
    expect(last.next).toBeNull();
    expect(pageAisDocuments("actors", rows, 99, undefined, byteLength)).toMatchObject({ offset: 7, rows: [], next: null });
  });
});
