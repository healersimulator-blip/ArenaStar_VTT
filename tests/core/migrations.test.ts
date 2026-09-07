import { describe, expect, test } from "vitest";
import {
  applyStep,
  compareVersions,
  migrateDocuments,
  parsePath,
  parseVersion,
  planMigrationChain,
  validateMigrationSteps,
  type MigrationStep,
} from "../../src/core/migrations";
import type { BaseDocument } from "../../src/core/documents";

const doc = (type: string, extra: Record<string, unknown> = {}): BaseDocument =>
  ({
    _id: `d-${type}`,
    type,
    name: type,
    ownership: { default: 2 },
    flags: {},
    system: {},
    ...extra,
  }) as BaseDocument;

describe("semver (§12)", () => {
  test("parse + compare", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(parseVersion("nope").ok).toBe(false);
  });
});

describe("validateMigrationSteps (§12)", () => {
  test("accepts valid steps; rejects bad versions, ops, paths, non-increasing", () => {
    const ok = validateMigrationSteps([
      {
        from: "1.0.0",
        to: "1.1.0",
        transforms: {
          armies: [
            { op: "default", path: "units.*.stats.drill", value: 1 },
            { op: "move", path: "system.note", from: "flags.note" },
            { op: "remove", path: "legacy" },
            { op: "set", path: "system.schemaNote", value: "v1.1" },
          ],
        },
      },
    ]);
    expect(ok.ok).toBe(true);

    expect(validateMigrationSteps("nope").ok).toBe(false);
    expect(validateMigrationSteps([{ from: "1.1.0", to: "1.0.0", transforms: {} }]).ok).toBe(false); // decreasing
    expect(
      validateMigrationSteps([
        { from: "1.0.0", to: "1.1.0", transforms: { a: [{ op: "hack", path: "x" }] } },
      ]).ok,
    ).toBe(false);
    expect(
      validateMigrationSteps([
        {
          from: "1.0.0",
          to: "1.1.0",
          transforms: { a: [{ op: "set", path: "__proto__.x", value: 1 }] },
        },
      ]).ok,
    ).toBe(false);
    expect(
      validateMigrationSteps([
        { from: "1.0.0", to: "1.1.0", transforms: { a: [{ op: "move", path: "x" }] } },
      ]).ok,
    ).toBe(false); // move without from
  });
});

describe("path engine (§12)", () => {
  test("parsePath guards depth and segments", () => {
    expect(parsePath("a.b.*.c").ok).toBe(true);
    expect(parsePath("a..b").ok).toBe(false);
    expect(parsePath("__proto__.pollute").ok).toBe(false);
    expect(parsePath("a.b.c.d.e.f.g.h.i").ok).toBe(false);
  });

  test("set/default/move/remove with * fan-out", () => {
    const step: MigrationStep = {
      from: "1.0.0",
      to: "1.1.0",
      transforms: {
        army: [
          { op: "default", path: "units.*.stats.drill", value: 1 },
          { op: "set", path: "system.schemaNote", value: "v1.1" },
          { op: "move", path: "system.moraleCap", from: "flags.moraleCap" },
          { op: "remove", path: "legacy" },
        ],
      },
    };
    const before = doc("army", {
      units: [{ stats: { strength: 10 } }, { stats: { strength: 5, drill: 9 } }],
      flags: { moraleCap: 7 },
      legacy: "old",
    });
    const after = applyStep(before, step);
    expect(after).not.toBe(before);
    const units = (after as unknown as { units: Array<{ stats: Record<string, number> }> }).units;
    expect(units[0]?.stats.drill).toBe(1); // default applied
    expect(units[1]?.stats.drill).toBe(9); // default kept existing
    const sys = (after as unknown as { system: Record<string, unknown> }).system;
    expect(sys.schemaNote).toBe("v1.1");
    expect(sys.moraleCap).toBe(7); // moved
    expect(
      (after as unknown as { flags: Record<string, unknown> }).flags.moraleCap,
    ).toBeUndefined();
    expect((after as unknown as Record<string, unknown>).legacy).toBeUndefined();

    // untouched doc keeps its reference
    const stranger = doc("scene", { width: 100 });
    expect(applyStep(stranger, step)).toBe(stranger);
  });
});

describe("planMigrationChain + migrateDocuments (§12)", () => {
  const step = (from: string, to: string): MigrationStep => ({ from, to, transforms: {} });

  test("multi-hop chaining, missing links, cycles", () => {
    const chain = planMigrationChain(
      [step("1.0.0", "1.1.0"), step("1.1.0", "2.0.0")],
      "1.0.0",
      "2.0.0",
    );
    expect(chain.ok).toBe(true);
    if (chain.ok) expect(chain.value.map((s) => s.to)).toEqual(["1.1.0", "2.0.0"]);

    const missing = planMigrationChain([step("1.0.0", "1.1.0")], "1.0.0", "2.0.0");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("missing link");

    const cycle = planMigrationChain(
      [step("1.0.0", "1.1.0"), step("1.1.0", "1.0.1"), step("1.0.1", "1.1.0")],
      "1.0.0",
      "2.0.0",
    );
    expect(cycle.ok).toBe(false);

    expect(planMigrationChain([], "1.1.0", "1.1.0").ok).toBe(true); // no-op
  });

  test("migrateDocuments counts changed docs", () => {
    const bump: MigrationStep = {
      from: "1.0.0",
      to: "1.1.0",
      transforms: { actor: [{ op: "set", path: "system.migrated", value: true }] },
    };
    const docs = [doc("actor"), doc("scene"), doc("actor", { system: { migrated: true } })];
    const res = migrateDocuments(docs, [bump]);
    expect(res.changed).toBe(1); // set with the identical value is a no-op
    expect(res.docs[1]).toBe(docs[1]); // untouched keeps ref
  });
});
