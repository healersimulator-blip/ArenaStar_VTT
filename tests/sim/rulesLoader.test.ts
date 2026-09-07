import { describe, expect, test } from "vitest";
import {
  evalRulesModule,
  importRulesModule,
  RulesModuleRegistry,
  validateRulesModule,
} from "../../src/sim/rulesLoader";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import type { RulesContext } from "../../src/core/rules";

const GOOD_SOURCE = `
export default {
  schema: {
    version: "1.0.0-probe",
    modelColumns: { morale: "u8" },
    unitTypes: {},
    orderTypes: ["probe"],
    subPhases: ["probe"],
  },
  validateOrder() {
    return { ok: true };
  },
  resolveTurn(ctx, pool, units, orders, rng, emit) {
    emit({
      subPhase: "probe",
      type: "probe",
      unitId: "u-probe",
      text: "probe executed",
      data: { draw: rng.nextFloat(), models: pool.count, units: units.length },
    });
  },
  detection() {
    return 5;
  },
};
`;

const ctx: RulesContext = {
  sceneId: "s-test",
  grid: { type: "gridless", size: 5, distance: 5, units: "m", diagonals: "ignore" },
  walls: {
    x1: new Float32Array(0),
    y1: new Float32Array(0),
    x2: new Float32Array(0),
    y2: new Float32Array(0),
    restriction: Uint8Array.of(),
  },
  factions: [],
  armies: [],
  leaderActors: {},
  worldSettings: {},
};

describe("validateRulesModule (§12 contract)", () => {
  test("accepts a well-formed default export", async () => {
    const res = await importRulesModule(GOOD_SOURCE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.info.version).toBe("1.0.0-probe");
    expect(res.value.info.subPhases).toEqual(["probe"]);
    expect(res.value.info.orderTypes).toEqual(["probe"]);
    expect(res.value.info.urlScheme).toBe("data"); // Node: no createObjectURL
    expect(typeof res.value.module.resolveTurn).toBe("function");
  });

  test("accepts a named `rules` export", async () => {
    const res = await importRulesModule(
      `export const rules = { schema: { version: "2", modelColumns: {}, unitTypes: {}, orderTypes: [], subPhases: [] }, validateOrder(){}, resolveTurn(){}, detection(){} };`,
    );
    expect(res.ok).toBe(true);
  });

  test("rejects missing export, bad schema fields, bad column types, missing fns", async () => {
    const noExport = await importRulesModule("export const x = 1;");
    expect(noExport.ok).toBe(false);
    if (noExport.ok) return;
    expect(noExport.error).toContain("no `default`");
    const noSchema = await importRulesModule(
      `export default { validateOrder(){}, resolveTurn(){}, detection(){} };`,
    );
    if (noSchema.ok) return;
    expect(noSchema.error).toContain("schema");
    const badVersion = (await importRulesModule(
      `export default { schema: { version: 7, modelColumns: {}, unitTypes: {}, orderTypes: [], subPhases: [] }, validateOrder(){}, resolveTurn(){}, detection(){} };`,
    )) as { error: string };
    expect(badVersion.error).toContain("version");
    const badColumn = (await importRulesModule(
      `export default { schema: { version: "1", modelColumns: { ammo: "bytes" }, unitTypes: {}, orderTypes: [], subPhases: [] }, validateOrder(){}, resolveTurn(){}, detection(){} };`,
    )) as { error: string };
    expect(badColumn.error).toContain("ammo");
    const noResolve = (await importRulesModule(
      `export default { schema: { version: "1", modelColumns: {}, unitTypes: {}, orderTypes: [], subPhases: [] }, validateOrder(){}, detection(){} };`,
    )) as { error: string };
    expect(noResolve.error).toContain("resolveTurn");
    const nullNs = validateRulesModule(null);
    expect(nullNs.ok).toBe(false);
    if (nullNs.ok) return;
    expect(nullNs.error).toContain("namespace");
  });

  test("syntax errors surface as Err, never a throw", async () => {
    const res = await importRulesModule("export default {{{{");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // import attempts fail, then the eval fallback reports the syntax error
    expect(res.error).toContain("eval failed");
  });
});

describe("evalRulesModule (WebKit fallback)", () => {
  test("loads the single-`export default`-expression form", () => {
    const res = evalRulesModule(
      `export default { schema: { version: "3.0.0-eval", modelColumns: {}, unitTypes: {}, orderTypes: [], subPhases: [] }, validateOrder(){}, resolveTurn(){}, detection(){} };`,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.schema.version).toBe("3.0.0-eval");
  });

  test("rejects multi-statement sources and bad expressions", () => {
    const multi = evalRulesModule("const x = 1; export default x;");
    expect(multi.ok).toBe(false);
    if (multi.ok) return;
    expect(multi.error).toContain("export default");
    const bad = evalRulesModule("export default {{{{");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toContain("eval failed");
    const wrongShape = evalRulesModule("export default {};");
    expect(wrongShape.ok).toBe(false);
    if (wrongShape.ok) return;
    expect(wrongShape.error).toContain("schema");
  });
});

describe("RulesModuleRegistry", () => {
  test("keys by exact source text", async () => {
    const reg = new RulesModuleRegistry();
    const loaded = await importRulesModule(GOOD_SOURCE);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(reg.size).toBe(0);
    reg.set(GOOD_SOURCE, loaded.value);
    expect(reg.get(GOOD_SOURCE)?.info.version).toBe("1.0.0-probe");
    expect(reg.get("export default 1")).toBeUndefined();
    expect(reg.size).toBe(1);
  });
});

describe("InlineSimRunner package path (§12)", () => {
  test("rulesSource loads a package, resolve runs it with injected PRNG", async () => {
    const runner = new InlineSimRunner();
    const info = await runner.loadRules(GOOD_SOURCE);
    expect(info.version).toBe("1.0.0-probe");

    await runner.load({
      sceneId: "s-test",
      sys: { morale: "u8" },
      ctx,
      units: [],
      rulesSource: GOOD_SOURCE,
    });
    const result = await runner.resolve({ orders: [], seed: 42, turnNumber: 1 });
    expect(result.report.rulesVersion).toBe("1.0.0-probe");
    expect(result.report.subPhases).toEqual(["probe"]);
    expect(result.report.events[0]?.type).toBe("probe");
    expect(result.report.events[0]?.data?.draw).toBeGreaterThan(0);
    expect(result.report.events[0]?.data?.models).toBe(0);

    // determinism: same seed + fresh runner → identical draw
    const again = new InlineSimRunner();
    await again.load({
      sceneId: "s-test",
      sys: { morale: "u8" },
      ctx,
      units: [],
      rulesSource: GOOD_SOURCE,
    });
    const result2 = await again.resolve({ orders: [], seed: 42, turnNumber: 1 });
    expect(result2.report.events[0]?.data?.draw).toBe(result.report.events[0]?.data?.draw);
    runner.terminate();
    again.terminate();
  });

  test("load with an invalid rulesSource rejects with the validator error", async () => {
    const runner = new InlineSimRunner();
    await expect(
      runner.load({
        sceneId: "s-test",
        sys: {},
        ctx,
        units: [],
        rulesSource: "export const nope = true;",
      }),
    ).rejects.toThrow("no `default`");
  });
});
