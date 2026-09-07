import { describe, expect, test } from "vitest";
import {
  ATLAS_FRAMES_PER_ATLAS,
  MAX_BOUND_ATLASES,
  atlasFrameRect,
  atlasKey,
  bindDecision,
  fnv8,
  planAtlases,
} from "../../src/canvas/layers/ModelLayer/atlases";

describe("atlas keys (§7)", () => {
  test("hash-addressed, stable, palette- and type-sensitive", () => {
    const a = atlasKey({ unitType: "infantry", palette: 0xc0392b });
    expect(a).toBe(atlasKey({ unitType: "infantry", palette: 0xc0392b }));
    expect(a).not.toBe(atlasKey({ unitType: "cavalry", palette: 0xc0392b }));
    expect(a).not.toBe(atlasKey({ unitType: "infantry", palette: 0x2e6f9e }));
    expect(fnv8("x")).toBe(fnv8("x"));
    expect(fnv8("x")).not.toBe(fnv8("y"));
  });
});

describe("planAtlases (§7)", () => {
  test("dedupes, packs 16 frames per atlas, hashes the base", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      unitType: `t${Math.floor(i / 10)}`,
      palette: 0x101010 * (i % 10),
    }));
    const { plans, dropped } = planAtlases(entries);
    expect(plans).toHaveLength(2); // 20 unique → 16 + 4
    expect(plans[0]?.frames).toHaveLength(ATLAS_FRAMES_PER_ATLAS);
    expect(plans[1]?.frames).toHaveLength(4);
    expect(dropped).toEqual([]);
    expect(plans[0]?.baseKey).not.toBe(plans[1]?.baseKey);
    // frame slots map to grid rects
    expect(plans[0]?.frames[5]?.rect).toEqual(atlasFrameRect(5));
  });

  test("duplicate entries collapse; overflow beyond 16 atlases drops", () => {
    const { plans } = planAtlases([
      { unitType: "infantry", palette: 1 },
      { unitType: "infantry", palette: 1 },
      { unitType: "infantry", palette: 2 },
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.frames).toHaveLength(2);

    const many = Array.from({ length: 300 }, (_, i) => ({
      unitType: `type-${i}`,
      palette: i,
    }));
    const overflow = planAtlases(many);
    expect(overflow.plans).toHaveLength(MAX_BOUND_ATLASES);
    expect(overflow.dropped.length).toBe(300 - MAX_BOUND_ATLASES * ATLAS_FRAMES_PER_ATLAS);
  });
});

describe("bindDecision (§7 budget)", () => {
  test("newest wanted entries win; oldest bound evict", () => {
    const bound = ["a", "b", "c"];
    const wanted = ["a", "d", "b", "c"]; // d fresh; recency order a oldest
    const d = bindDecision(bound, wanted, 3);
    expect(d.evict).toEqual(["a"]); // a is the oldest — dropped from budget
    expect(d.keep).toEqual(["d", "b", "c"]);
    expect(d.admit).toEqual(["d"]);
  });

  test("under budget: nothing evicts", () => {
    const d = bindDecision(["a"], ["a", "b"], 16);
    expect(d.evict).toEqual([]);
    expect(d.admit).toEqual(["b"]);
  });

  test("unwanted bound atlases always evict", () => {
    const d = bindDecision(["a", "b"], ["b"], 16);
    expect(d.evict).toEqual(["a"]);
    expect(d.keep).toEqual(["b"]);
  });
});
