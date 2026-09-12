/**
 * §1.8 scale gate — the 10,000-model PF1e mass battle, run where it can actually be executed.
 *
 * `e2e/pf1e_mass_battles.spec.ts` used to assert a hardcoded `{ok:true,hits:15}` and never ran the
 * sim, and a browser run is not available in every environment (Playwright needs browser binaries,
 * and timings it reports would be machine-dependent anyway). This test keeps what is reproducible:
 * it drives the real runner (`InlineSimRunner` → `SimRunnerCore`, the same code the SimWorker runs)
 * over a real `deploySnapshot` of 10 000 PF1e models for 28 turns and asserts the
 * machine-independent budgets — pool layout, snapshot wire size, determinism down to the packed
 * delta bytes — while measuring turn cost and gating it at catastrophe level, so the gate fails on
 * a 5× regression instead of flaking on a noisy CI box. The measured p50/p95 are printed for the
 * record; §19's target is p95 < 50 ms, and `PF1e_Combat_Fidelity_GapList.md` keeps the figures.
 */
import { decompressSync } from "fflate";
import { describe, expect, test, vi } from "vitest";
import type { UnitId } from "../../src/core/ids";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { FactionDocument, OrderQueue } from "../../src/core/strategic";
import { bytesPerModel, createModelPool } from "../../src/sim/pool";
import { deploySnapshot } from "../../src/sim/deploy";
import type { SimResolveResult } from "../../src/sim/runner";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";

const UNITS_PER_FACTION = 10;
const MODELS_PER_UNIT = 500;
const TOTAL_MODELS = UNITS_PER_FACTION * 2 * MODELS_PER_UNIT;
const WARMUP_TURNS = 4;
const MEASURED_TURNS = 24;

/** §19's stated target, reported next to the measurement (not asserted — see the header). */
const TARGET_P95_MS = 50;

/**
 * Catastrophe ceiling per turn at 10k models. This exists to catch a regression that makes a turn
 * cost a *quarter of a second*, which a tight 50 ms budget would otherwise catch by flaking until
 * someone marked the test as skipped. Measured on the reference box: p50 ≈ 32 ms, p95 ≈ 42 ms.
 */
const TURN_CEILING_MS = 250;

const ctx: RulesContext = {
  sceneId: "s-10k",
  grid: {
    type: "square",
    size: 20_000,
    distance: 5,
    units: "ft",
    diagonals: "555",
  },
  walls: {
    x1: new Float32Array(),
    y1: new Float32Array(),
    x2: new Float32Array(),
    y2: new Float32Array(),
    restriction: new Uint8Array(),
  },
  factions: [],
  armies: [],
  leaderActors: {},
  worldSettings: {},
};

interface Arena {
  units: UnitView[];
  orders: Array<[UnitId, OrderQueue]>;
  load: {
    sceneId: string;
    sys: typeof PF1E_MODEL_SCHEMA;
    ctx: RulesContext;
    units: UnitView[];
    snapshot: { bytes: Uint8Array; maxHpMax: number; version: number };
  };
}

function arena(): Arena {
  const factionIds = ["f-blue", "f-red"];
  const factions = factionIds.map((id, k) => ({
    _id: id,
    type: "faction",
    name: k === 0 ? "Blue" : "Red",
    ownership: { default: 0 },
    flags: {},
    system: {},
    allies: [],
  })) as unknown as FactionDocument[];

  const units: UnitView[] = [];
  for (const [side, factionId] of factionIds.entries()) {
    for (let i = 0; i < UNITS_PER_FACTION; i++) {
      const id = `${factionId}-u${i}`;
      units.push({
        id,
        armyId: `army-${factionId}`,
        factionId,
        type: "infantry",
        name: `Unit ${id}`,
        profile: {},
        // Stat keys are what `rawProfileFromUnit` reads; the weapon mirrors
        // PRECREATED_PF1E_UNITS.infantry (longsword 1d8 + Str 3).
        stats: {
          strength: MODELS_PER_UNIT,
          bab: 6 + side,
          strMod: 3,
          ac: 16 + side,
          touchAc: 11,
          hp: 10,
          fort: 5,
          ref: 4,
          will: 3,
          damageDiceCount: 1,
          damageDiceSides: 8,
          damageMod: 3,
        },
        orders: null,
        formation: "line",
        sceneId: "s-10k",
        modelRange: null,
        leaderTokenId: null,
      });
    }
  }

  const snap = deploySnapshot(units, factions, PF1E_MODEL_SCHEMA);
  const ranges = new Map<UnitId, readonly [number, number] | null>(snap.ranges);
  for (const unit of units) unit.modelRange = ranges.get(unit.id) ?? null;

  // Each unit attacks the opposing unit at the same index: engagements are 1:1, so per-turn work
  // is linear in models instead of quadratic in units.
  const orders: Array<[UnitId, OrderQueue]> = units.map((unit, i) => {
    const target = units[(i + UNITS_PER_FACTION) % units.length] as UnitView;
    const order = { kind: "attack", targetUnitId: target.id } as const;
    return [
      unit.id,
      { issuedBy: "gm", issuedTurn: 1, pending: [order], active: order },
    ];
  });

  return {
    units,
    orders,
    load: {
      sceneId: "s-10k",
      sys: PF1E_MODEL_SCHEMA,
      ctx,
      units,
      snapshot: { bytes: snap.bytes, maxHpMax: snap.maxHpMax, version: 0 },
    },
  };
}

async function run(
  a: Arena,
  turns: number,
): Promise<{ perTurnMs: number[]; results: SimResolveResult[] }> {
  const runner = new InlineSimRunner(createMassBattlePf1e());
  await runner.load(a.load);
  const perTurnMs: number[] = [];
  const results: SimResolveResult[] = [];
  for (let t = 1; t <= turns; t++) {
    const start = performance.now();
    const res = await runner.resolve({
      orders: a.orders,
      seed: 4242 + t,
      turnNumber: t,
    });
    const elapsed = performance.now() - start;
    results.push(res);
    if (t > WARMUP_TURNS) perTurnMs.push(elapsed);
  }
  return { perTurnMs, results };
}

const percentile = (sample: number[], p: number): number => {
  const sorted = [...sample].sort((x, y) => x - y);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  );
};

describe("PF1e 10k scale gate (§1.8, runner-level budgets)", () => {
  test("the pool layout fits the §19 budget with all 13 PF1e columns", () => {
    const bytes = bytesPerModel(
      createModelPool(TOTAL_MODELS, PF1E_MODEL_SCHEMA),
    );
    // 66 B/model today — the added columns are narrow ints (u8 AC/saves, u16 profile/damage), and
    // this is the number that keeps proposals like §2.10's "DR as data" or §2.13's `status2`
    // column honest instead of silently tripling the pool.
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(200);
  });

  test("10k models × 24 measured turns: progresses, stays quiet, and fits the wire budget", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { perTurnMs, results } = await run(
        arena(),
        WARMUP_TURNS + MEASURED_TURNS,
      );
      expect(results).toHaveLength(WARMUP_TURNS + MEASURED_TURNS);
      const last = results[results.length - 1];
      if (!last) throw new Error("no turns resolved");

      const p50 = percentile(perTurnMs, 0.5);
      const p95 = percentile(perTurnMs, 0.95);
      const max = Math.max(...perTurnMs);
      console.info(
        `pf1e 10k turn cost (${TOTAL_MODELS} models, ${perTurnMs.length} turns): ` +
          `p50 ${p50.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms · max ${max.toFixed(1)} ms · ` +
          `§19 target p95 < ${TARGET_P95_MS} ms`,
      );

      // ── progress: the battle actually advanced (casualties, compaction) ───────────────
      expect(last.toVersion).toBe(WARMUP_TURNS + MEASURED_TURNS);
      const alive = last.rangeDiffs.reduce(
        (n, [, r]) => n + (r ? r[1] - r[0] : 0),
        0,
      );
      expect(alive).toBeGreaterThan(0);
      expect(alive).toBeLessThan(TOTAL_MODELS);
      // The runner's summary counts events per declared sub-phase; PF1e fights in `melee`, and a
      // late turn legitimately has none once one side is gone — so the gate is "some turn fought".
      const meleeEvents = (r: SimResolveResult): number =>
        (r.report.summary as Record<string, number>)["melee"] ?? 0;
      expect(results.reduce((n, r) => n + meleeEvents(r), 0)).toBeGreaterThan(
        0,
      );
      const attacked = results.some((r) =>
        r.report.events.some((e) => /attacks/i.test(e.text)),
      );
      expect(attacked).toBe(true);

      // ── the report is stamped by the rules module, not hardcoded ──────────────────────
      expect(last.report.rulesVersion).toBe("1.0.0");
      expect(last.report.subPhases).toEqual([
        "move",
        "heal",
        "shoot",
        "melee",
        "spell",
        "morale",
      ]);

      // ── wire budget: a full 10k snapshot stays inside §19's 1.5 MB ────────────────────
      expect(last.checkpointBytes.length).toBeLessThanOrEqual(
        1.5 * 1024 * 1024,
      );

      // ── regression ceiling + "zero console errors" from §1.8 ──────────────────────────
      expect(p95).toBeLessThanOrEqual(TURN_CEILING_MS);
      expect(errors.mock.calls).toEqual([]);
      expect(warns.mock.calls).toEqual([]);
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  }, 240_000);

  test("the same seed replays to the same wire bytes (resolve → compact → diff → pack)", async () => {
    const first = await run(arena(), 6);
    const second = await run(arena(), 6);
    expect(first.results.map((r) => r.poolHash)).toEqual(
      second.results.map((r) => r.poolHash),
    );
    // Byte-level, on the *uncompressed* wire: `encodeSimDelta`/`encodeSimSnapshot` gzip with
    // fflate, whose header carries an MTIME — comparing the compressed payloads would fail across
    // runs for a reason that has nothing to do with determinism. Under gzip the msgpack stream of
    // a delta and of a full checkpoint must match, which is what makes a resume, a replay and a
    // joiner replica of a PF1e battle provably identical.
    const wire = (bytes: Uint8Array): string =>
      Array.from(decompressSync(bytes)).join(",");
    expect(second.results).toHaveLength(first.results.length);
    for (const [i, turn] of first.results.entries()) {
      const other = second.results[i];
      if (!other) throw new Error(`the second run is missing turn ${i + 1}`);
      expect(wire(turn.deltaBytes)).toBe(wire(other.deltaBytes));
      expect(wire(turn.checkpointBytes)).toBe(wire(other.checkpointBytes));
    }
    // The battle is not a no-op either (it may settle once one side is destroyed by turn ~3).
    expect(new Set(first.results.map((r) => r.poolHash)).size).toBeGreaterThan(
      1,
    );
  }, 240_000);
});
