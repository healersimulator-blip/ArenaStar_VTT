// Checklist: G-45 / plan §1.4 — "lazy per-pack parse": parse on demand, once per package record.
/**
 * The parsed-pack memo must be invisible in behaviour and exact about which bytes it serves:
 * asking twice is free, and anything that changes the package record (new import, new version,
 * different file) must produce a fresh parse rather than a stale pack. The last test pins the
 * origin rule D-252 established — packs loaded from a world are validated under the *world*
 * sanity cap, not the 2,000-entry app-body cap.
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
  clearParsedPackCache,
  packCacheKey,
  parsedPackCacheSize,
  parsePackCached,
  type PackCacheKeyParts,
} from "../../src/core/compendiumCache";

const keyOf = (over: Partial<PackCacheKeyParts> = {}): string =>
  packCacheKey({
    worldId: "w1",
    packageId: "pf1e-content",
    version: "1.0.0",
    importedAt: 1_700_000_000_000,
    file: "packs/spells.json",
    ...over,
  });

const packOf = (name: string, entries: number, prefix = "entry"): unknown => ({
  name,
  type: "items",
  entries: Array.from({ length: entries }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `${name} ${i}`,
    data: { type: "item", name: `${name} ${i}`, system: {} },
  })),
});

describe("G-45 — parsed-pack memo", () => {
  beforeEach(() => {
    clearParsedPackCache();
  });

  test("the same key parses once and returns the same pack object", () => {
    const key = keyOf();
    const first = parsePackCached(key, packOf("Spells", 3));
    expect(first?.entries).toHaveLength(3);
    const second = parsePackCached(key, packOf("Spells", 3));
    expect(second).toBe(first);
    expect(parsedPackCacheSize()).toBe(1);
  });

  test("a re-import wins: same id and version, new importedAt, new content", () => {
    const before = parsePackCached(keyOf(), packOf("Spells", 3));
    const after = parsePackCached(keyOf({ importedAt: 1_700_000_000_001 }), packOf("Spells", 4));
    expect(before?.entries).toHaveLength(3);
    expect(after?.entries).toHaveLength(4);
    expect(after).not.toBe(before);
  });

  test("version, file and world are all part of the identity", () => {
    const base = parsePackCached(keyOf(), packOf("Spells", 3));
    expect(parsePackCached(keyOf({ version: "1.0.1" }), packOf("Spells", 3))).not.toBe(base);
    expect(parsePackCached(keyOf({ file: "packs/feats.json" }), packOf("Spells", 3))).not.toBe(base);
    expect(parsePackCached(keyOf({ worldId: "w2" }), packOf("Spells", 3))).not.toBe(base);
    expect(parsedPackCacheSize()).toBe(4);
  });

  test("an invalid pack caches as null instead of being re-validated per call", () => {
    const key = keyOf();
    expect(parsePackCached(key, { name: "Broken", type: "items" })).toBeNull(); // no entries
    expect(parsePackCached(key, packOf("Spells", 3))).toBeNull(); // still the cached verdict
    expect(parsedPackCacheSize()).toBe(1);
  });

  test("world-origin caps apply through the memo (2,001 entries is fine, the app cap is not used)", () => {
    const pack = parsePackCached(keyOf(), packOf("Big", 2_001, "big"));
    expect(pack?.entries).toHaveLength(2_001);
  });
});
