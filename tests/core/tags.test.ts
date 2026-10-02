import { describe, expect, test } from "vitest";
import {
  TagIndex, expandTagTemplate, getByTag, groupTagsByScene, listTaggable, normalizeTags, sidebarSearchMatcher,
  sidebarTagMatch, sidebarTagTerm, sidebarTagTerms, tagAutocompleteSuggestions, tagDataError, tagEditOps,
  taggerTagsError, tagMatcher, tagRuleOps, tagsOf,
  isPrototypeTokenTagRef, isWorldDocumentTagRef, prototypeTokenTagsOf, validGlobalTagRefs, validWorldTagRefs,
} from "../../src/core/tags";
import { DocumentStore } from "../../src/core/store";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type { ActorDocument, ItemDocument, RegionDocument, SceneDocument, TokenDocument, TileDocument } from "../../src/core/documents";
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
    const actor = { coll: "actors", id: "a1" };
    const worldItem = { coll: "items", id: "i1" };
    const embeddedItem = { coll: "items", id: "i2", parent: actor };
    expect(isWorldDocumentTagRef(actor)).toBe(true);
    expect(isWorldDocumentTagRef(worldItem)).toBe(true);
    expect(isWorldDocumentTagRef(embeddedItem)).toBe(true);
    expect(isWorldDocumentTagRef({ ...actor, parent: { coll: "actors", id: "parent" } })).toBe(false);
    expect(isWorldDocumentTagRef({ ...worldItem, parent: { coll: "scenes", id: "s1" } })).toBe(false);
    expect(isWorldDocumentTagRef({ ...embeddedItem, parent: { coll: "actors", id: "a1", extra: true } })).toBe(false);
    expect(validGlobalTagRefs([local, actor, worldItem, embeddedItem])).toBe(true);
    expect(validGlobalTagRefs([actor, { ...actor }])).toBe(false);
    expect(validGlobalTagRefs([{ ...local, parent: { coll: "actors", id: "a1" } }])).toBe(false);
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

  test("sidebar search combines lenient tag clauses with name terms without changing API matching", () => {
    const doc = { ...token("goblin", ["enemy", "EnemyBoss", "arch-enemy", "boss fight", "Door-A"]),
      name: "Goblin Scout" };
    expect(sidebarSearchMatcher('goblin "scout" tag:"BOSS FIGHT" tag:door-*')(doc)).toBe(true);
    expect(sidebarSearchMatcher('"Goblin Scout" tag:enemy tag:door-?')(doc)).toBe(true);
    expect(sidebarSearchMatcher('goblin tag:missing')(doc)).toBe(false);
    expect(sidebarSearchMatcher('orc tag:enemy')(doc)).toBe(false);
    expect(sidebarSearchMatcher('tag:"BOSS FIGHT"')(doc)).toBe(true);
    expect(sidebarSearchMatcher("")(doc)).toBe(true);
    expect(sidebarTagMatch(doc, 'tag:"BOSS FIGHT" tag:door-*')).toBe(true);
    expect(tagMatcher("Enemy")(doc.taggerTags ?? [])).toBe(false); // API stays exact/case-sensitive.
    expect(() => sidebarSearchMatcher("x".repeat(513))).toThrow(/too long/);
    expect(() => sidebarSearchMatcher(Array.from({ length: 33 }, () => "tag:x").join(" ")))
      .toThrow(/too many tag terms/);
  });

  test("Tagger autocomplete completes only the final comma term, safely and deterministically", () => {
    const vocabulary = ["trap-door", "trap-light", "Trap-gate", "other", "trap-door", "invalid\nvalue"];
    expect(tagAutocompleteSuggestions(vocabulary, "trap-door, trap-l")).toEqual(["trap-light"]);
    expect(tagAutocompleteSuggestions(vocabulary, "trap-", 2)).toEqual(["trap-door", "Trap-gate"]);
    expect(tagAutocompleteSuggestions(vocabulary, "trap-door")).toEqual([]);
    expect(tagAutocompleteSuggestions(vocabulary, "other, ")).toEqual([]);
    expect(tagAutocompleteSuggestions(vocabulary, "trap-", 0)).toEqual([]);
  });

  test("legacy flags read, normalization preserves case/order; clone placeholders", () => {
    const legacy: TileDocument = { ...tile("tile"), flags: { tagger: { tags: ["old", "Old"] } } };
    delete legacy.taggerTags;
    expect(tagsOf(legacy)).toEqual(["old", "Old"]);
    expect(normalizeTags([" A ", "B", "A", "a"])).toEqual(["A", "B", "a"]);
    expect(() => normalizeTags(["\u0000"])).toThrow();
    expect(expandTagTemplate("gate-{#}-{id}", 4, "own-id")).toBe("gate-4-own-id");
  });

  test("actor and embedded-item edits use stable refs and stored tags must be canonical", () => {
    const item: ItemDocument = { _id: "blade", type: "item", name: "Blade", ownership: { default: 0 },
      flags: {}, system: {}, effects: [], taggerTags: ["weapon"] };
    const actor: ActorDocument = { _id: "hero", type: "actor", name: "Hero", ownership: { default: 3 },
      flags: {}, system: {}, effects: [], items: [item], taggerTags: ["party"] };
    expect(tagEditOps([{ ref: { coll: "actors", id: actor._id }, doc: actor }], "add", ["quest giver"]))
      .toEqual([{ kind: "update", ref: { coll: "actors", id: "hero" }, diff: { taggerTags: ["party", "quest giver"] } }]);
    expect(tagEditOps([{ ref: { coll: "items", id: item._id, parent: { coll: "actors", id: actor._id } }, doc: item }],
      "replace", ["magic"])).toEqual([{ kind: "update", ref: { coll: "items", id: "blade", parent: { coll: "actors", id: "hero" } },
      diff: { taggerTags: ["magic"] } }]);
    expect(tagDataError({ ...actor, taggerTags: ["hero"], items: [{ ...item, taggerTags: ["weapon"] }],
      prototypeToken: { taggerTags: ["actor-token"] } })).toBeNull();
    expect(tagDataError({ ...actor, items: [{ ...item, taggerTags: [" padded "] }] })).toMatch(/unique, trimmed/);
    expect(tagDataError({ ...actor, prototypeToken: { taggerTags: [" padded "] } })).toMatch(/unique, trimmed/);
    expect(taggerTagsError(["duplicate", "duplicate"])).toMatch(/unique, trimmed/);
    expect(taggerTagsError(["x".repeat(129)])).toMatch(/invalid or oversized/);
    expect(taggerTagsError("not-an-array")).toMatch(/array/);
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

  test("global Tagger queries opt into actors, world items, embedded items, and projected visibility", () => {
    const w = emptyWorld();
    const embedded: ItemDocument = { _id: "embedded", type: "item", name: "Embedded Wand", ownership: { default: 0 },
      flags: {}, system: {}, effects: [], taggerTags: ["world-magic"] };
    const visibleActor: ActorDocument = { _id: "visible-actor", type: "actor", name: "Visible Hero", ownership: { default: 2 },
      flags: {}, system: {}, effects: [], items: [embedded], taggerTags: ["world-party"],
      prototypeToken: { taggerTags: ["world-prototype"] } };
    const hiddenActor: ActorDocument = { _id: "hidden-actor", type: "actor", name: "Hidden Hero", ownership: { default: 0 },
      flags: {}, system: {}, effects: [], items: [], taggerTags: ["world-secret"],
      prototypeToken: { taggerTags: ["world-secret-prototype"] } };
    const worldItem: ItemDocument = { _id: "world-item", type: "item", name: "Public Map", ownership: { default: 2 },
      flags: {}, system: {}, effects: [], taggerTags: ["world-map"] };
    const hiddenItem: ItemDocument = { _id: "hidden-item", type: "item", name: "Private Map", ownership: { default: 0 },
      flags: {}, system: {}, effects: [], taggerTags: ["world-hidden-item"] };
    w.actors.push(visibleActor, hiddenActor);
    w.items.push(worldItem, hiddenItem);

    expect(getByTag(w, "world-party")).toEqual([]); // world scope is opt-in for scene-oriented callers
    const all = getByTag(w, "world*", { includeWorldDocs: true, pattern: "wildcard" });
    expect(all.map((row) => [row.scope, row.collection, row.ref])).toEqual([
      ["world", "actors", { coll: "actors", id: "visible-actor" }],
      ["world", "actors", { coll: "actors", id: "hidden-actor" }],
      ["world", "prototypeTokens", { coll: "actors", id: "visible-actor", target: "prototypeToken" }],
      ["world", "prototypeTokens", { coll: "actors", id: "hidden-actor", target: "prototypeToken" }],
      ["world", "items", { coll: "items", id: "world-item" }],
      ["world", "items", { coll: "items", id: "hidden-item" }],
      ["world", "items", { coll: "items", id: "embedded", parent: { coll: "actors", id: "visible-actor" } }],
    ]);
    expect(getByTag(w, "world-magic", { viewer: player, includeWorldDocs: true }).map((row) => row.ref))
      .toEqual([{ coll: "items", id: "embedded", parent: { coll: "actors", id: "visible-actor" } }]);
    expect(getByTag(w, "world-prototype", { viewer: player, includeWorldDocs: true }).map((row) => row.ref))
      .toEqual([{ coll: "actors", id: "visible-actor", target: "prototypeToken" }]);
    expect(getByTag(w, "world-secret", { viewer: player, includeWorldDocs: true })).toEqual([]);
    expect(getByTag(w, "world-secret-prototype", { viewer: player, includeWorldDocs: true })).toEqual([]);
    expect(getByTag(w, "world-hidden-item", { viewer: player, includeWorldDocs: true })).toEqual([]);
    expect(getByTag(w, "world-map", { viewer: player, collections: ["items"] }).map((row) => row.doc._id))
      .toEqual(["world-item"]);
    expect(getByTag(w, "world-party", { sceneId: "missing", includeWorldDocs: true })).toEqual([]);
    expect(groupTagsByScene(all)[""]?.map((row) => row.scope)).toEqual(Array(7).fill("world"));
  });

  test("prototype tokens have stable actor-qualified tag refs, separate edits, and legacy reads", () => {
    const actor: ActorDocument = { _id: "prototype-owner", type: "actor", name: "Guardian", ownership: { default: 3 },
      flags: {}, system: {}, items: [], effects: [], taggerTags: ["actor-label"],
      prototypeToken: { flags: { tagger: { tags: ["legacy-prototype"] } } } };
    const world = emptyWorld();
    world.actors.push(actor);
    const ref = { coll: "actors" as const, id: actor._id, target: "prototypeToken" as const };
    expect(isPrototypeTokenTagRef(ref)).toBe(true);
    expect(isWorldDocumentTagRef(ref)).toBe(true);
    expect(isWorldDocumentTagRef({ ...ref, extra: true })).toBe(false);
    expect(validGlobalTagRefs([ref])).toBe(true);
    expect(validGlobalTagRefs([ref, { ...ref }])).toBe(false);
    expect(prototypeTokenTagsOf(actor)).toEqual(["legacy-prototype"]);
    const rows = getByTag(world, "legacy-prototype", { collections: ["prototypeTokens"] });
    expect(rows.map((row) => [row.collection, row.ref, row.doc.name, row.tags])).toEqual([
      ["prototypeTokens", ref, "Guardian (prototype token)", ["legacy-prototype"]],
    ]);
    const ops = tagEditOps([{ ref, doc: actor }], "add", ["spawned"]);
    expect(ops).toEqual([{ kind: "update", ref: { coll: "actors", id: actor._id },
      diff: { "prototypeToken.taggerTags": ["legacy-prototype", "spawned"] } }]);
    const store = new DocumentStore({ meta });
    expect(store.applyEnvelope(env(1, [{ kind: "create", coll: "actors", data: actor }])).ok).toBe(true);
    expect(store.applyEnvelope(env(2, ops)).ok).toBe(true);
    const updated = store.get("actors", actor._id) as ActorDocument;
    expect(updated.taggerTags).toEqual(["actor-label"]);
    expect(updated.prototypeToken?.taggerTags).toEqual(["legacy-prototype", "spawned"]);
    expect(tagsOf(updated)).toEqual(["actor-label"]);
  });

  test("TagIndex invalidates global actor/item results for top-level and embedded tag edits", () => {
    const store = new DocumentStore({ meta });
    const item: ItemDocument = { _id: "embedded", type: "item", name: "Embedded", ownership: { default: 0 },
      flags: {}, system: {}, effects: [], taggerTags: ["before"] };
    const actor: ActorDocument = { _id: "actor", type: "actor", name: "Hero", ownership: { default: 3 },
      flags: {}, system: {}, effects: [], items: [item], taggerTags: ["before"],
      prototypeToken: { taggerTags: ["prototype-before"] } };
    expect(store.applyEnvelope(env(1, [{ kind: "create", coll: "actors", data: actor }])).ok).toBe(true);
    const index = new TagIndex(store);
    const initial = index.query("before", { includeWorldDocs: true });
    expect(initial.map((row) => row.ref)).toEqual([
      { coll: "actors", id: "actor" },
      { coll: "items", id: "embedded", parent: { coll: "actors", id: "actor" } },
    ]);
    const prototypeRef = { coll: "actors" as const, id: "actor", target: "prototypeToken" as const };
    expect(index.query("prototype-before", { collections: ["prototypeTokens"] }).map((row) => row.ref))
      .toEqual([prototypeRef]);
    const actorRef = { coll: "actors" as const, id: "actor" };
    const embeddedRef = { coll: "items" as const, id: "embedded", parent: actorRef };
    expect(store.applyEnvelope(env(2, [
      { kind: "update", ref: actorRef, diff: { taggerTags: ["actor-after"] } },
      { kind: "update", ref: actorRef, diff: { "prototypeToken.taggerTags": ["prototype-after"] } },
      { kind: "update", ref: embeddedRef, diff: { taggerTags: ["item-after"] } },
    ])).ok).toBe(true);
    expect(index.query("before", { includeWorldDocs: true })).toEqual([]);
    expect(index.query("prototype-before", { collections: ["prototypeTokens"] })).toEqual([]);
    expect(index.query("*after", { includeWorldDocs: true, pattern: "wildcard" }).map((row) => row.ref))
      .toEqual([actorRef, prototypeRef, embeddedRef]);
    index.dispose();
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

  test("world Tagger rules expand actor, prototype and item templates in one atomic namespace", () => {
    const store = new DocumentStore({ meta });
    const blocker: ActorDocument = { _id: "hidden-rule-blocker", type: "actor", name: "Hidden blocker",
      ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [], taggerTags: ["spawn-1"] };
    const embedded: ItemDocument = { _id: "embedded-rule-item", type: "item", name: "Embedded rule item",
      ownership: { default: 3 }, flags: {}, system: {}, effects: [], taggerTags: ["nested-{id}"] };
    const actor: ActorDocument = { _id: "owner-actor", type: "actor", name: "Rule owner",
      ownership: { default: 3 }, flags: {}, system: {}, items: [embedded], effects: [], taggerTags: ["actor-{id}"],
      prototypeToken: { taggerTags: ["spawn-{#}", "prototype-owner-{id}"], sight: { enabled: true } } };
    const worldItem: ItemDocument = { _id: "world-rule-item", type: "item", name: "World rule item",
      ownership: { default: 3 }, flags: {}, system: {}, effects: [], taggerTags: ["spawn-{#}"] };
    expect(store.applyEnvelope(env(1, [
      { kind: "create", coll: "actors", data: blocker },
      { kind: "create", coll: "actors", data: actor },
      { kind: "create", coll: "items", data: worldItem },
    ])).ok).toBe(true);
    const rows = listTaggable(store.world, { includeWorldDocs: true });
    const actorRef = { coll: "actors" as const, id: actor._id };
    const prototypeRef = { coll: "actors" as const, id: actor._id, target: "prototypeToken" as const };
    const itemRef = { coll: "items" as const, id: worldItem._id };
    const embeddedRef = { coll: "items" as const, id: embedded._id, parent: actorRef };
    const prototypeRow = rows.find((row) => row.collection === "prototypeTokens" && row.ref.id === actor._id);
    const itemRow = rows.find((row) => row.ref.coll === "items" && row.ref.id === worldItem._id);
    const embeddedRow = rows.find((row) => row.ref.coll === "items" && row.ref.id === embedded._id);
    if (!prototypeRow || !itemRow || !embeddedRow) throw new Error("world Tagger rule fixture incomplete");
    const targets = [
      { ref: prototypeRef, sceneId: "", doc: prototypeRow.doc },
      { ref: itemRef, sceneId: "", doc: itemRow.doc },
      { ref: embeddedRef, sceneId: "", doc: embeddedRow.doc },
    ];
    expect(targets.map(({ ref, sceneId, doc }) => [isWorldDocumentTagRef(ref), sceneId, ref.id, doc._id]))
      .toEqual([[true, "", actor._id, actor._id], [true, "", worldItem._id, worldItem._id],
        [true, "", embedded._id, embedded._id]]);
    const ops = tagRuleOps(store.world, targets);
    expect(ops).toEqual([
      { kind: "update", ref: actorRef,
        diff: { "prototypeToken.taggerTags": ["spawn-2", "prototype-owner-owner-actor"] } },
      { kind: "update", ref: itemRef, diff: { taggerTags: ["spawn-3"] } },
      { kind: "update", ref: embeddedRef, diff: { taggerTags: ["nested-embedded-rule-item"] } },
    ]);
    const applied = store.applyEnvelope(env(2, ops));
    expect(applied.ok).toBe(true);
    expect((store.get("actors", actor._id) as ActorDocument).prototypeToken)
      .toMatchObject({ taggerTags: ["spawn-2", "prototype-owner-owner-actor"], sight: { enabled: true } });
    expect((store.get("items", worldItem._id) as ItemDocument).taggerTags).toEqual(["spawn-3"]);
    expect((store.resolve(embeddedRef) as ItemDocument).taggerTags).toEqual(["nested-embedded-rule-item"]);
    expect(getByTag(store.world, "spawn-*", { includeWorldDocs: true, pattern: "wildcard" })
      .map((row) => row.tags)).toEqual([["spawn-1"], ["spawn-2", "prototype-owner-owner-actor"], ["spawn-3"]]);
    if (applied.ok) expect(store.applyEnvelope(env(3, [...applied.value.inverses].reverse())).ok).toBe(true);
    expect((store.get("actors", actor._id) as ActorDocument).prototypeToken?.taggerTags)
      .toEqual(["spawn-{#}", "prototype-owner-{id}"]);
    expect((store.get("items", worldItem._id) as ItemDocument).taggerTags).toEqual(["spawn-{#}"]);
    expect((store.resolve(embeddedRef) as ItemDocument).taggerTags).toEqual(["nested-{id}"]);

    const collisionWorld = structuredClone(store.world);
    const collisionBlocker = collisionWorld.actors.find((candidate) => candidate._id === blocker._id);
    if (!collisionBlocker) throw new Error("world uniqueness fixture incomplete");
    collisionBlocker.taggerTags = [...(collisionBlocker.taggerTags ?? []), "prototype-owner-owner-actor"];
    const collisionPrototype = listTaggable(collisionWorld, { includeWorldDocs: true })
      .find((row) => row.collection === "prototypeTokens" && row.ref.id === actor._id);
    if (!collisionPrototype) throw new Error("world prototype collision fixture incomplete");
    expect(() => tagRuleOps(collisionWorld, [{ ref: prototypeRef, sceneId: "", doc: collisionPrototype.doc }]))
      .toThrow(/no unique Tagger rule allocation/);
  });

  test("first-class regions participate in scene-local Tagger reads and edits", () => {
    const w = emptyWorld();
    const s = scene("s1");
    const region: RegionDocument = { _id: "region-a", type: "region", name: "Ash ring",
      ownership: { default: 3 }, flags: {}, system: {}, taggerTags: ["hazard"],
      x: 100, y: 100, width: 200, height: 120,
      shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] } };
    s.regions = [region];
    w.scenes.push(s);
    expect(getByTag(w, "hazard", { sceneId: "s1" }).map((row) => [row.ref.coll, row.doc._id]))
      .toEqual([["regions", "region-a"]]);
    expect(getByTag(w, "hazard", { sceneId: "s1", viewer: player })).toHaveLength(1);
    const ref = { coll: "regions" as const, id: region._id, parent: { coll: "scenes" as const, id: "s1" } };
    const ops = tagEditOps([{ ref, doc: region }], "add", ["searchable"]);
    expect(ops).toEqual([{ kind: "update", ref, diff: { taggerTags: ["hazard", "searchable"] } }]);
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
