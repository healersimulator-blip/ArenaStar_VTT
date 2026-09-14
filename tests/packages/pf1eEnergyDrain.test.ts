/**
 * P7/H04/D-207 — energy drain infliction, saves and restoration.
 * Wraps `energyDrain.ts` which itself wraps `negativeLevels.ts` totals/verdicts.
 */
import { describe, expect, test } from "vitest";
import {
  inflictNegativeLevels,
  removeNegativeLevels,
  saveOneNegativeLevel,
} from "../../src/packages/pf1e/energyDrain";

describe("D-207 — inflictNegativeLevels", () => {
  test("inflicts temporary and permanent, preserving the other bucket", () => {
    const r1 = inflictNegativeLevels({ current: undefined, count: 1, kind: "temporary" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("failed");
    expect(r1.result.levels).toEqual({ temporary: 1 });
    expect(r1.result.note).toContain("temporary");
    expect(r1.result.note).toContain("save each day");

    const r2 = inflictNegativeLevels({ current: { temporary: 2 }, count: 1, kind: "permanent" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("failed");
    expect(r2.result.levels).toEqual({ temporary: 2, permanent: 1 });
    expect(r2.result.note).toContain("permanent");
  });

  test("validates count and kind", () => {
    expect(inflictNegativeLevels({ current: undefined, count: 0, kind: "temporary" })).toMatchObject({ ok: false });
    expect(inflictNegativeLevels({ current: undefined, count: 1.5, kind: "temporary" })).toMatchObject({ ok: false });
    expect(inflictNegativeLevels({ current: undefined, count: 1, kind: "permanent" })).toEqual(expect.objectContaining({ ok: true }));
    // @ts-expect-error intentional bad kind
    expect(inflictNegativeLevels({ current: undefined, count: 1, kind: "foo" }).ok).toBe(false);
  });

  test("plural note and total tally", () => {
    const r = inflictNegativeLevels({ current: { permanent: 1 }, count: 2, kind: "temporary" });
    if (!r.ok) throw new Error("failed");
    expect(r.result.note).toContain("2 temporary");
    expect(r.result.note).toContain("3 total");
  });
});

describe("D-207 — removeNegativeLevels (restoration)", () => {
  test("any prefers temporary, then permanent; deletes when empty", () => {
    const r = removeNegativeLevels({ current: { temporary: 1, permanent: 1 }, count: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("failed");
    expect(r.result.levels).toEqual({ permanent: 1 });
    expect(r.result.note).toContain("1 remain");

    const r2 = removeNegativeLevels({ current: { temporary: 1 }, count: 1, kind: "any" });
    if (!r2.ok) throw new Error("failed");
    expect(r2.result.levels).toBeNull();
    expect(r2.result.note).toContain("none remain");

    // any with 2 should take temp first then perm
    const r3 = removeNegativeLevels({ current: { temporary: 1, permanent: 2 }, count: 2 });
    if (!r3.ok) throw new Error("failed");
    expect(r3.result.levels).toEqual({ permanent: 1 });
  });

  test("temporary-only and permanent-only respect their bucket", () => {
    const ok = removeNegativeLevels({ current: { temporary: 1, permanent: 1 }, count: 1, kind: "temporary" });
    if (!ok.ok) throw new Error("failed");
    expect(ok.result.levels).toEqual({ permanent: 1 });

    const fail = removeNegativeLevels({ current: { temporary: 1 }, count: 2, kind: "temporary" });
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.error).toContain("only 1 temporary");

    const permOk = removeNegativeLevels({ current: { permanent: 2 }, count: 2, kind: "permanent" });
    if (!permOk.ok) throw new Error("failed");
    expect(permOk.result.levels).toBeNull();
  });

  test("validates count and empty", () => {
    expect(removeNegativeLevels({ current: undefined, count: 1 }).ok).toBe(false);
    expect(removeNegativeLevels({ current: { temporary: 1 }, count: 0 }).ok).toBe(false);
  });

  test("any with insufficient total names the total", () => {
    const r = removeNegativeLevels({ current: { temporary: 1 }, count: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("only 1 negative");
  });
});

describe("D-207 — saveOneNegativeLevel (daily / 24h)", () => {
  test("temporary success removes one", () => {
    const r = saveOneNegativeLevel({ current: { temporary: 2, permanent: 1 }, kind: "temporary", die: 15, fortBonus: 5, dc: 17 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("failed");
    expect(r.result.removed).toBe(true);
    expect(r.result.becomesPermanent).toBe(false);
    expect(r.result.levels).toEqual({ temporary: 1, permanent: 1 });
    expect(r.result.note).toContain("goes away");
  });

  test("temporary failure keeps the level (another save tomorrow) — no deletion", () => {
    const r = saveOneNegativeLevel({ current: { temporary: 1 }, kind: "temporary", die: 10, fortBonus: 2, dc: 17 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("failed");
    expect(r.result.removed).toBe(false);
    expect(r.result.becomesPermanent).toBe(false);
    expect(r.result.levels).toEqual({ temporary: 1 });
    expect(r.result.note).toContain("a new save comes tomorrow");
  });

  test("energy-drain success removes, failure becomes permanent", () => {
    const success = saveOneNegativeLevel({ current: { temporary: 1 }, kind: "energy-drain", die: 15, fortBonus: 5, dc: 17 });
    if (!success.ok) throw new Error("failed");
    expect(success.result.removed).toBe(true);
    expect(success.result.levels).toBeNull();

    const failure = saveOneNegativeLevel({ current: { temporary: 1, permanent: 0 }, kind: "energy-drain", die: 10, fortBonus: 2, dc: 17 });
    if (!failure.ok) throw new Error("failed");
    expect(failure.result.removed).toBe(false);
    expect(failure.result.becomesPermanent).toBe(true);
    expect(failure.result.levels).toEqual({ permanent: 1 });
    expect(failure.result.note).toContain("becomes permanent");
  });

  test("requires a pending temporary level", () => {
    const r = saveOneNegativeLevel({ current: { permanent: 1 }, kind: "temporary", die: 10, fortBonus: 2, dc: 13 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no temporary");
  });

  test("validates die face", () => {
    const r = saveOneNegativeLevel({ current: { temporary: 1 }, kind: "temporary", die: 21, fortBonus: 0, dc: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("natural d20");
  });
});
