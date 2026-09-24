import { describe, expect, test } from "vitest";
import {
  TagIndex, expandTagTemplate, getByTag, groupTagsByScene, normalizeTags, sidebarTagMatch,
  sidebarTagTerm, sidebarTagTerms, tagEditOps, tagMatcher, tagRuleOps, tagsOf, validWorldTagRefs,
} from "../../src/core/tags";
import { DocumentStore } from "../../src/core/store";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type { SceneDocument, TokenDocument, TileDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";

const meta = { worldId: "world", name: "Tags", system: "test", systemVersion: "1" };
const gm = { id: "gm", role: "GM" as const };
const player = { id: "p", role: "PLAYER" as const };

function token(id: string, tags: string[] = [], hidden = false): TokenDocument {
  return { _id: id, type: "token", name: id, system: {}, flags: {}, ownership: { default: 0 },
    taggerTags: tags, x: 0, y: 0, width: 60, height: 60, img: "", rotation: 0,
    hidden, disposition: "neutral", vision: true, light: { radius: 0, color: "#fff", alpha: 0 } };
}
function tile(id: string, tags: string[] = []): TileDocument {
  return { _id: id, type: "tile", name: id, system: {}, flags: {}, ownership: { default: 0 },
    taggerTags: tags, x: 0, y: 0, width: 100, height: 100, img: "", above: false,
    occlusion: { mode: "roof", alpha: 0.5 } };
}
function scene(id: string): SceneDocument {
  return { _id: id, type: "scene", name: id, system: {}, flags: {}, ownership: { default: 2 },
    active: id === "s1", img: null, width: 500, height: 500, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [], walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [] };
}
function env(seq: number, ops: Op[]): OpEnvelope {
  return { seq, ops, by: "gm", ts: 1000 + seq, txId: `tx-${seq}` };
}

describe("Tagger-compatible query semantics", () => {
  test("explicit multi-scene refs have full parent identity and a bounded, strict shape", () => {
    const local = { coll: "tiles", id: "same", parent: { coll: "scenes", id: "s1" } };
    const remote = { coll: "tiles", id: "same", parent: { coll: "scenes", id: "s2" } };
    expect(validWorldTagRefs([local, remote, { coll: "scenes", id: "s3" }])).toBe(true);
    expect(validWorldTagRefs([local, local])).toBe(false);
    expect(validWorldTagRefs([{ ...local, parent: { coll: "actors", id: "s1" } }])).toBe(false);
    expect(validWorldTagRefs([{ ...local, parent: { coll: "scenes", id: "s2", extras: true } }])).toBe(false);
    expect(validWorldTagRefs([{ coll: "tiles", id: "same" }])).toBe(false);
    expect(validWorldTagRefs([{ coll: "tiles", id: "same", parent: { coll: "scenes", id: "" } }])).toBe(false);
    expect(validWorldTagRefs([{ coll: "tiles", id: "bad\nref", parent: { coll: "scenes", id: "s1" } }])).toBe(false);
    expect(validWorldTagRefs([{ coll: "scenes", id: "s1", parent: { coll: "scenes", id: "s2" } }])).toBe(false);
    expect(validWorldTagRefs(Array.from({ length: 101 }, (_, i) => ({ coll: "scenes", id: `s${i}` })))).toBe(false);
  });

  test("API is case-sensitive and exact by default; all/any/exactSet are different", () => {
    const tags = ["enemy", "EnemyBoss", "arch-enemy"];
    expect(tagMatcher("enemy")(tags)).toBe(true);
    expect(tagMatcher("Enemy")(tags)).toBe(false);
    expect(tagMatcher(["enemy", "boss"], { mode: "all" })(tags)).toBe(false);
    expect(tagMatcher(["enemy", "boss"], { mode: "any" })(tags)).toBe(true);
    expect(tagMatcher(["enemy", "EnemyBoss"], { mode: "exactSet" })(tags)).toBe(false);
    expect(tagMatcher(tags, { mode: "exactSet" })(tags)).toBe(true);
    expect(tagMatcher(["door*", "door-1"], { mode: "exactSet", pattern: "wildcard" })(["door-1"]))
      .toBe(false); // one tag cannot satisfy two terms
    expect(tagMatcher(["door*", "door-1"], { mode: "exactSet", pattern: "wildcard" })(["door-1", "door-2"]))
      .toBe(true); // distinct assignment even when wildcard overlaps a literal
    expect(tagMatcher("enemy", { contains: true })(["arch-enemy"])).toBe(true);
    expect(tagMatcher("enemy", { caseSensitive: false })(["Enemy"])).toBe(true);
  });

  test("wildcard, bounded regex, safe input, and sidebar substring semantics", () => {
    expect(tagMatcher("guard*", { pattern: "wildcard" })(["guardian"])).toBe(true);
    expect(tagMatcher("a?c", { pattern: "wildcard" })(["abc"])).toBe(true);
    expect(tagMatcher("a.b*", { pattern: "wildcard" })(["a.boss"])).toBe(true);
    expect(tagMatcher("^boss-[0-9]+$", { pattern: "regex" })(["boss-12"])).toBe(true);
    expect(() => tagMatcher("(a+)+$", { pattern: "regex" })).toThrow(/unsafe/);
    expect(() => tagMatcher("a+a+", { pattern: "regex" })).toThrow(/unsafe/);
    expect(() => tagMatcher("[invalid", { pattern: "regex" })).toThrow(/invalid/);
    expect(sidebarTagTerm('torch tag:"Boss Fight" guard')).toBe("Boss Fight");
    expect(sidebarTagTerms('guard tag:"Boss Fight" tag:door-*')).toEqual(["Boss Fight", "door-*"]);
    expect(sidebarTagMatch(token("t", ["boss fight", "Door-A"]), 'tag:"Boss Fight" tag:door-*')).toBe(true);
    expect(sidebarTagMatch(token("t", ["boss fight", "Door-A"]), 'tag:"Boss Fight" tag:door-B')).toBe(false);
    expect(sidebarTagMatch(token("t", ["EnemyBoss"]), "tag:boss")).toBe(true);
    expect(tagMatcher("boss")(["EnemyBoss"])).toBe(false);
  });

  test("legacy flags read, normalization preserves case/order; clone placeholders", () => {
    const legacy: TileDocument = { ...tile("tile"), flags: { tagger: { tags: ["old", "Old"] } } };
    delete legacy.taggerTags;
    expect(tagsOf(legacy)).toEqual(["old", "Old"]);
    expect(normalizeTags([" A ", "B", "A", "a"])).toEqual(["A", "B", "a"]);
    expect(() => normalizeTags(["\u0000"])).toThrow();
    expect(expandTagTemplate("gate-{#}-{id}", 4, "own-id")).toBe("gate-4-own-id");
  });

  test("mixed placeables and inactive scenes, scene/type filters, projected visibility", () => {
    const w = emptyWorld();
    const s1 = scene("s1");
    const s2 = scene("s2");
    s1.tokens.push(token("visible", ["trap"]), token("secret", ["trap"], true));
    s1.tiles.push(tile("tile", ["trap"]));
    s2.tokens.push(token("far", ["trap"]));
    w.scenes.push(s1, s2);
    expect(getByTag(w, "trap").map((r) => r.doc._id)).toEqual(["visible", "secret", "tile", "far"]);
    expect(getByTag(w, "trap", { sceneId: "s1", collections: ["tiles"] }).map((r) => r.doc._id)).toEqual(["tile"]);
    expect(getByTag(w, "trap", { viewer: player }).map((r) => r.doc._id)).toEqual(["visible", "tile", "far"]);
    expect(getByTag(w, "trap", { viewer: gm })).toHaveLength(4);
    s1.tokens.push(token("same", ["trap"]));
    s2.tokens.push(token("same", ["trap"]));
    const onlyFar = { coll: "tokens" as const, id: "same", parent: { coll: "scenes" as const, id: "s2" } };
    expect(getByTag(w, "trap", { viewer: player, includeRefs: [onlyFar] }).map((r) => r.sceneId))
      .toEqual(["s2"]);
    expect(getByTag(w, "trap", { viewer: player, includeRefs: [onlyFar], excludeRefs: [onlyFar] }))
      .toEqual([]);
    const grouped = groupTagsByScene(getByTag(w, "trap", { viewer: player }));
    expect(Object.keys(grouped)).toEqual(["s1", "s2"]);
    expect(grouped.s1?.some((row) => row.doc._id === "secret")).toBe(false);
    expect(grouped.s2?.map((row) => row.doc._id)).toEqual(["far", "same"]);
  });

  test("Tagger applyTagRules allocates current-scene {#}/{id} per object in one undoable batch", () => {
    const store = new DocumentStore({ meta });
    const s1 = scene("s1"), s2 = scene("s2");
    s1.tokens.push(token("used", ["trap-1"]));
    s1.tiles.push(tile("a", ["trap-{#}", "self-{id}"]), tile("b", ["trap-{#}", "other-{id}"]));
    s2.tiles.push(tile("far", ["trap-{#}"]));
    expect(store.applyEnvelope(env(1, [
      { kind: "create", coll: "scenes", data: s1 }, { kind: "create", coll: "scenes", data: s2 },
    ]))).toMatchObject({ ok: true });
    const refs = [{ coll: "tiles" as const, id: "a", parent: { coll: "scenes" as const, id: "s1" } },
      { coll: "tiles" as const, id: "b", parent: { coll: "scenes" as const, id: "s1" } },
      { coll: "tiles" as const, id: "far", parent: { coll: "scenes" as const, id: "s2" } }];
    const docs = refs.map((ref) => ({ ref, sceneId: ref.parent.id,
      doc: store.resolve(ref) as TileDocument }));
    const firstRef = refs[0], secondRef = refs[1], firstDoc = docs[0];
    if (!firstRef || !secondRef || !firstDoc) throw new Error("tag-rule fixture incomplete");
    const ops = tagRuleOps(store.world, docs);
    expect(ops.map((op) => op.kind === "update" ? op.diff.taggerTags : null)).toEqual([
      ["trap-2", "self-a"], ["trap-3", "other-b"], ["trap-1"],
    ]);
    expect((store.resolve(firstRef) as TileDocument).taggerTags).toEqual(["trap-{#}", "self-{id}"]);
    const applied = store.applyEnvelope(env(2, ops));
    expect(applied.ok).toBe(true);
    expect(getByTag(store.world, "trap-3", { sceneId: "s1" }).map((hit) => hit.ref.id)).toEqual(["b"]);
    expect(getByTag(store.world, "trap-1", { sceneId: "s2" }).map((hit) => hit.ref.id)).toEqual(["far"]);
    if (!applied.ok) return;
    expect(store.applyEnvelope(env(3, [...applied.value.inverses].reverse())).ok).toBe(true);
    expect((store.resolve(firstRef) as TileDocument).taggerTags).toEqual(["trap-{#}", "self-{id}"]);
    expect(() => tagRuleOps(store.world, [firstDoc, firstDoc])).toThrow(/duplicate/);
    const bad = tile("c", ["x".repeat(125) + "{id}"]);
    expect(() => tagRuleOps(store.world, [...docs, { ref: { coll: "tiles", id: "c",
      parent: { coll: "scenes", id: "s1" } }, sceneId: "s1", doc: bad }])).toThrow(/128/);
    expect((store.resolve(secondRef) as TileDocument).taggerTags).toEqual(["trap-{#}", "other-{id}"]);
  });

  test("bulk edits are transactional, undoable, and invalidate scene index", () => {
    const store = new DocumentStore({ meta });
    const s = scene("s1");
    s.tokens.push(token("a", ["old"]));
    s.tiles.push(tile("b", ["old"]));
    expect(store.applyEnvelope(env(1, [{ kind: "create", coll: "scenes", data: s }])).ok).toBe(true);
    const index = new TagIndex(store);
    const refs = index.query("old");
    expect(refs.map((r) => r.ref.coll)).toEqual(["tokens", "tiles"]);
    const ops = tagEditOps(refs, "add", ["new"]);
    const change = store.applyEnvelope(env(2, ops));
    expect(change.ok).toBe(true);
    expect(index.query("new").map((r) => r.doc._id)).toEqual(["a", "b"]);
    if (change.ok) {
      expect(store.applyEnvelope(env(3, [...change.value.inverses].reverse())).ok).toBe(true);
    }
    expect(index.query("new")).toEqual([]);
    expect(index.query("old")).toHaveLength(2);
    expect(tagEditOps(index.query("old"), "toggle", ["old"]).length).toBe(2);
    index.dispose();
  });
});
