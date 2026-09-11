import { describe, expect, test } from "vitest";
import {
  srAlreadyOvercome,
  srOvercomeBlobFromFlags,
  srOvercomeDiff,
  srOvercomeKey,
} from "../../src/packages/pf1e/srLedger";

describe("P5/C02 round-scoped SR ledger (D-156)", () => {
  test("keys are (caster, target) pairs, and only this round's entry counts", () => {
    expect(srOvercomeKey("wiz", "ogre")).toBe("wiz:ogre");
    const blob = { "wiz:ogre": 3 };
    expect(srAlreadyOvercome(blob, "wiz", "ogre", 3)).toBe(true);
    // A different round is stale: the check must happen again.
    expect(srAlreadyOvercome(blob, "wiz", "ogre", 4)).toBe(false);
    // A different pair never reuses another creature's overcome check.
    expect(srAlreadyOvercome(blob, "wiz", "troll", 3)).toBe(false);
    expect(srAlreadyOvercome(blob, "cleric", "ogre", 3)).toBe(false);
  });

  test("malformed blobs and rounds read as empty rather than throwing", () => {
    for (const blob of [null, undefined, "x", 3, [], { wiz: "3" }]) {
      expect(srAlreadyOvercome(blob, "wiz", "ogre", 1)).toBe(false);
    }
    // Rounds must be positive integers: combat starts at round 1.
    expect(srAlreadyOvercome({ "wiz:ogre": 0 }, "wiz", "ogre", 0)).toBe(false);
    expect(srAlreadyOvercome({ "wiz:ogre": 1 }, "wiz", "ogre", 1.5)).toBe(
      false,
    );
  });

  test("the flags diff is dotted under flags.pf1e.srOvercome", () => {
    expect(srOvercomeDiff("wiz", "ogre", 2)).toEqual({
      "flags.pf1e.srOvercome.wiz:ogre": 2,
    });
  });

  test("blobFromFlags never invents a blob", () => {
    expect(
      srOvercomeBlobFromFlags({ pf1e: { srOvercome: { "wiz:ogre": 2 } } }),
    ).toEqual({ "wiz:ogre": 2 });
    for (const flags of [
      null,
      undefined,
      "x",
      [],
      {},
      { pf1e: null },
      { pf1e: "x" },
      { pf1e: {} },
      { pf1e: { srOvercome: null } },
      { pf1e: { srOvercome: "x" } },
      { pf1e: { srOvercome: [] } },
    ]) {
      expect(srOvercomeBlobFromFlags(flags)).toBeNull();
    }
  });
});
