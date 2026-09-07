import { describe, expect, test } from "vitest";
import { applyDiff, diffFlat, jsonEqual, readPaths, type JsonRecord } from "../../src/core/diff";
import type { FlatDiff } from "../../src/core/ops";
import type { Json } from "../../src/core/documents";

const base = (): JsonRecord => ({
  name: "Orc",
  system: { hp: 10, hpMax: 10, tags: ["a", "b"], nested: { deep: 1 } },
  ownership: { default: 2 },
  nulls: null as Json,
});

describe("applyDiff (§4 FlatDiff)", () => {
  test("sets root and dotted nested paths immutably", () => {
    const doc = base();
    const diff: FlatDiff = { name: "Goblin", "system.hp": 3 };
    const res = applyDiff(doc, diff);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.name).toBe("Goblin");
    expect((res.value.system as JsonRecord).hp).toBe(3);
    // original untouched
    expect(doc.name).toBe("Orc");
    expect((doc.system as JsonRecord).hp).toBe(10);
  });

  test("deletes via '-=key': null", () => {
    const res = applyDiff(base(), { "-=system.hp": null });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect("hp" in (res.value.system as JsonRecord)).toBe(false);
    expect((res.value.system as JsonRecord).hpMax).toBe(10);
  });

  test("deleting a missing path is a no-op (idempotent)", () => {
    const res = applyDiff(base(), { "-=system.absent": null });
    expect(res.ok).toBe(true);
  });

  test("missing intermediate path is an error", () => {
    const res = applyDiff(base(), { "system.nope.hp": 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("missing");
  });

  test("traversing a primitive is an error", () => {
    const res = applyDiff(base(), { "name.length.x": 1 });
    expect(res.ok).toBe(false);
  });

  test("array index set works in range; out of range errors", () => {
    const okSet = applyDiff(base(), { "system.tags.1": "z" });
    expect(okSet.ok).toBe(true);
    if (!okSet.ok) return;
    expect((okSet.value.system as JsonRecord).tags).toEqual(["a", "z"]);

    const bad = applyDiff(base(), { "system.tags.5": "z" });
    expect(bad.ok).toBe(false);
  });

  test("deleting an array element by index is rejected (D-012)", () => {
    const res = applyDiff(base(), { "-=system.tags.0": null });
    expect(res.ok).toBe(false);
  });

  test("replacing a whole array value works", () => {
    const res = applyDiff(base(), { "system.tags": ["x", "y", "z"] as Json });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.value.system as JsonRecord).tags).toEqual(["x", "y", "z"]);
  });
});

describe("readPaths (pre-images, §8)", () => {
  test("captures old values for set keys", () => {
    const doc = base();
    expect(readPaths(doc, { "system.hp": 99, name: "X" })).toEqual({
      "system.hp": 10,
      name: "Orc",
    });
  });

  test("set of an absent path pre-images as a delete marker", () => {
    expect(readPaths(base(), { "system.newKey": 5 })).toEqual({ "-=system.newKey": null });
  });

  test("delete of an existing path pre-images the removed value", () => {
    expect(readPaths(base(), { "-=system.hp": null })).toEqual({ "system.hp": 10 });
  });

  test("delete of an absent path has no inverse (no-op)", () => {
    expect(readPaths(base(), { "-=system.ghost": null })).toEqual({});
  });

  test("round-trip: apply diff, then apply pre-image → original", () => {
    const doc = base();
    const diff: FlatDiff = { "system.hp": 0, "system.nested.deep": 42, "-=name": null };
    const step1 = applyDiff(doc, diff);
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;
    const pre = readPaths(doc, diff);
    const step2 = applyDiff(step1.value, pre);
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(jsonEqual(step2.value as unknown as JsonRecord, doc)).toBe(true);
  });
});

describe("diffFlat (canonical diffs)", () => {
  test("empty diff for equal trees", () => {
    expect(diffFlat(base(), base())).toEqual({});
  });

  test("scalar change, addition, deletion", () => {
    const before: JsonRecord = { a: 1, b: { c: 2 } };
    const after: JsonRecord = { a: 2, b: { c: 2, d: 3 } };
    expect(diffFlat(before, after)).toEqual({ a: 2, "b.d": 3 });
    expect(diffFlat(after, before)).toEqual({ a: 1, "-=b.d": null });
  });

  test("arrays compare wholesale", () => {
    const before: JsonRecord = { tags: ["a", "b"] };
    const after: JsonRecord = { tags: ["a", "c"] };
    expect(diffFlat(before, after)).toEqual({ tags: ["a", "c"] });
  });

  test("round-trip with applyDiff", () => {
    const before = base();
    const after = structuredClone(before);
    after.name = "Troll";
    (after.system as JsonRecord).hp = 2;
    (after.system as JsonRecord).nested = { deep: 9 } as Json;
    const diff = diffFlat(before, after);
    const res = applyDiff(before, diff);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(jsonEqual(res.value as unknown as JsonRecord, after)).toBe(true);
  });
});
