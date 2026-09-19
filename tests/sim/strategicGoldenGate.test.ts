// Checklist: V06 — the standing deploy / manifest / codec / replay gate this file pins.
/**
 * V06 — the strategic gates, held as one standing check.
 *
 * `tests/packages/pf1eMassBattleScale.test.ts` already proves the budgets (≤200 B/model,
 * checkpoint ≤1.5 MB at 10k, warm-up before timing, real combat events) and that *two runs of
 * the same tree* produce identical wire bytes. What it cannot catch is a strategic rules change
 * that alters outcomes while staying self-consistent: run-to-run equality is satisfied by any
 * deterministic engine, including a wrong one.
 *
 * This file closes that gap with a **pinned golden**: one small, fully-specified PF1e battle at
 * a fixed seed, digested down to the per-turn §5A pool hash, freeze hash, wire lengths and a
 * checksum of the *decompressed* delta. Any change to deployment, the manifest, the codec or the
 * resolution rules moves the golden, and moving it must be a deliberate act recorded in
 * `DECISIONS.md` — not something that slips through because every test still agrees with itself.
 *
 * The digest deliberately covers the uncompressed payload: `encodeSimDelta` gzips with fflate,
 * whose header carries an MTIME, so the compressed bytes are not comparable across runs.
 *
 * @srd §5A determinism: the same turn seed replays to the same pool hash and the same wire bytes.
 */
import { decompressSync } from "fflate";
import { describe, expect, test } from "vitest";
import type { UnitId } from "../../src/core/ids";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { FactionDocument, OrderQueue } from "../../src/core/strategic";
import { bytesPerModel, createModelPool } from "../../src/sim/pool";
import { deploySnapshot } from "../../src/sim/deploy";
import type { SimLoadRequest, SimResolveResult } from "../../src/sim/runner";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { validatePackageManifest } from "../../src/core/packageManifest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Small enough to run in milliseconds, large enough that engagement/compaction really happen. */
const UNITS_PER_FACTION = 3;
const MODELS_PER_UNIT = 20;
const TOTAL_MODELS = UNITS_PER_FACTION * 2 * MODELS_PER_UNIT;
const TURNS = 10;
const BASE_SEED = 0x601d;

/**
 * THE GOLDEN. Update only with a decision entry naming what changed and why the new digest is
 * correct. It is a hex digest of the whole battle, not a single number, so the failure message
 * says which turn moved.
 */
const GOLDEN_DIGEST = [
  "t1 pool=b4040be160b436a9a1e4af0e4927e3fa freeze=88a99c8bdf871259635567cc2b53c92c delta=2453:2ad60ae3 cp=5467:0c8056fb",
  "t2 pool=a9bb3d022a22eecbaacb225b2561ab21 freeze=b4040be160b436a9a1e4af0e4927e3fa delta=1164:7b2f63f5 cp=4997:c8389538",
  "t3 pool=c5aef892150e937ccf4ca4dc44a8fe61 freeze=a9bb3d022a22eecbaacb225b2561ab21 delta=1037:a472714f cp=4574:3e0344e1",
  "t4 pool=76ef0bd57ce71bdcc7fdaaacbb2ad9ee freeze=c5aef892150e937ccf4ca4dc44a8fe61 delta=985:51249258 cp=4245:ddc15560",
  "t5 pool=0a8b1b93b77dfd29d663902f0894223b freeze=76ef0bd57ce71bdcc7fdaaacbb2ad9ee delta=927:213213ea cp=4010:d6caa79f",
  "t6 pool=218710d49c4c48b9559e7f2b584525df freeze=0a8b1b93b77dfd29d663902f0894223b delta=819:b915fd1a cp=3822:bdccc161",
  "t7 pool=966a2116b3cbf099a2071b84e590e8c4 freeze=218710d49c4c48b9559e7f2b584525df delta=813:9c229a38 cp=3681:6d478c9d",
  "t8 pool=693a8b4ed99a9e881a7de48254086df5 freeze=966a2116b3cbf099a2071b84e590e8c4 delta=711:baf47ac7 cp=3587:c4f76ebe",
  "t9 pool=d979f7c76517099364bd00c66ea545c6 freeze=693a8b4ed99a9e881a7de48254086df5 delta=692:f1eaf09b cp=3446:2a5c9090",
  "t10 pool=06389a73457b7d348f2850cb822e81fc freeze=d979f7c76517099364bd00c66ea545c6 delta=187:2c559c11 cp=3301:a08dc01b",
].join("\n");

const ctx: RulesContext = {
  sceneId: "s-gate",
  grid: { type: "square", size: 20_000, distance: 5, units: "ft", diagonals: "555" },
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

/** `load` is typed concretely (not `Parameters<…>[0]`) so `snapshot` stays non-optional here. */
function arena(): {
  units: UnitView[];
  orders: Array<[UnitId, OrderQueue]>;
  load: Omit<SimLoadRequest, "snapshot"> & {
    snapshot: { bytes: Uint8Array; maxHpMax: number; version: number };
  };
} {
  const factionIds = ["f-blue", "f-red"];
  const factions = factionIds.map(
    (id, k) =>
      ({
        _id: id,
        type: "faction",
        name: k === 0 ? "Blue" : "Red",
        ownership: { default: 0 },
        flags: {},
        system: {},
        allies: [],
      }) as unknown as FactionDocument,
  );

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
        stats: {
          strength: MODELS_PER_UNIT,
          bab: 6 + side,
          strMod: 3,
          ac: 16 + side,
          touchAc: 11,
          hp: 60,
          fort: 5,
          ref: 4,
          will: 3,
          damageDiceCount: 1,
          damageDiceSides: 8,
          damageMod: 3,
        },
        orders: null,
        formation: "line",
        sceneId: "s-gate",
        modelRange: null,
        leaderTokenId: null,
      });
    }
  }

  const snap = deploySnapshot(units, factions, PF1E_MODEL_SCHEMA);
  const ranges = new Map<UnitId, readonly [number, number] | null>(snap.ranges);
  for (const unit of units) unit.modelRange = ranges.get(unit.id) ?? null;

  const orders: Array<[UnitId, OrderQueue]> = units.map((unit, i) => {
    const target = units[(i + UNITS_PER_FACTION) % units.length] as UnitView;
    const order = { kind: "attack", targetUnitId: target.id } as const;
    return [unit.id, { issuedBy: "gm", issuedTurn: 1, pending: [order], active: order }];
  });

  return {
    units,
    orders,
    load: {
      sceneId: "s-gate",
      sys: PF1E_MODEL_SCHEMA,
      ctx,
      units,
      snapshot: { bytes: snap.bytes, maxHpMax: snap.maxHpMax, version: 0 },
    },
  };
}

async function battle(): Promise<SimResolveResult[]> {
  const a = arena();
  const runner = new InlineSimRunner(createMassBattlePf1e());
  await runner.load(a.load);
  const results: SimResolveResult[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    results.push(
      await runner.resolve({ orders: a.orders, seed: BASE_SEED + turn, turnNumber: turn }),
    );
  }
  return results;
}

/** FNV-1a over bytes — small, dependency-free, and stable across platforms. */
function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Per-turn digest line: version, both §5A hashes, wire lengths, and the decompressed delta. */
function digestOf(results: SimResolveResult[]): string {
  return results
    .map((turn) => {
      const delta = decompressSync(turn.deltaBytes);
      const checkpoint = decompressSync(turn.checkpointBytes);
      return [
        `t${turn.toVersion}`,
        `pool=${turn.poolHash}`,
        `freeze=${turn.freezeHash}`,
        `delta=${delta.length}:${fnv1a(delta)}`,
        `cp=${checkpoint.length}:${fnv1a(checkpoint)}`,
      ].join(" ");
    })
    .join("\n");
}

describe("V06 — deploy gate: the same units and seed deploy identically", () => {
  test("deployment is content-addressed and reproducible", () => {
    const a = arena();
    const b = arena();
    // fflate's gzip header includes the current second as MTIME; compare the
    // content-addressed payload rather than incidental compression metadata.
    expect(Array.from(decompressSync(a.load.snapshot.bytes))).toEqual(
      Array.from(decompressSync(b.load.snapshot.bytes)),
    );
    expect(a.load.snapshot.maxHpMax).toBe(b.load.snapshot.maxHpMax);
    expect(a.units.map((u) => u.modelRange)).toEqual(b.units.map((u) => u.modelRange));
    // Every model is placed: one per square, no overlaps, no empty unit.
    const placed = a.units.reduce((n, u) => n + ((u.modelRange?.[1] ?? 0) - (u.modelRange?.[0] ?? 0)), 0);
    expect(placed).toBe(TOTAL_MODELS);
    expect(new Set(a.units.map((u) => u.modelRange?.[0])).size).toBe(a.units.length);
  });
});

describe("V06 — manifest gate: the shipped artifact and the code agree", () => {
  test("the package manifest's modelColumns is exactly PF1E_MODEL_SCHEMA", () => {
    const manifestPath = fileURLToPath(
      new URL("../../systems/pf1e-mass-battles/manifest.json", import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const validated = validatePackageManifest(manifest);
    expect(validated.ok ? null : validated.error).toBeNull();
    if (!validated.ok) return;
    expect(validated.value.rules?.modelColumns).toEqual({ ...PF1E_MODEL_SCHEMA });
  });

  test("the pool still fits the ≤200 B/model budget", () => {
    const bytes = bytesPerModel(createModelPool(TOTAL_MODELS, PF1E_MODEL_SCHEMA));
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(200);
  });
});

describe("V06 — codec/replay gate: pinned golden plus decompressed wire equality", () => {
  test("two independent runs produce byte-identical decompressed wire payloads", async () => {
    const first = await battle();
    const second = await battle();
    expect(second).toHaveLength(first.length);
    for (const [i, turn] of first.entries()) {
      const other = second[i];
      if (!other) throw new Error(`second run is missing turn ${i + 1}`);
      expect(turn.poolHash).toBe(other.poolHash);
      expect(turn.freezeHash).toBe(other.freezeHash);
      expect(Array.from(decompressSync(turn.deltaBytes))).toEqual(
        Array.from(decompressSync(other.deltaBytes)),
      );
      expect(Array.from(decompressSync(turn.checkpointBytes))).toEqual(
        Array.from(decompressSync(other.checkpointBytes)),
      );
    }
  }, 120_000);

  test("the battle is genuine combat, not empty late-turn work", async () => {
    const results = await battle();
    const melee = (r: SimResolveResult): number =>
      (r.report.summary as Record<string, number>)["melee"] ?? 0;
    expect(results.reduce((n, r) => n + melee(r), 0)).toBeGreaterThan(0);
    expect(results.some((r) => r.report.events.some((e) => /attacks/i.test(e.text)))).toBe(true);
    // The pool actually changed across the battle — the hashes are not a constant.
    expect(new Set(results.map((r) => r.poolHash)).size).toBeGreaterThan(1);
    // …and models died, so the late turns are not measuring a settled no-op.
    const last = results[results.length - 1];
    if (!last) throw new Error("no turns resolved");
    const alive = last.rangeDiffs.reduce((n, [, r]) => n + (r ? r[1] - r[0] : 0), 0);
    expect(alive).toBeLessThan(TOTAL_MODELS);
    expect(alive).toBeGreaterThanOrEqual(0);
  }, 120_000);

  test("the golden digest matches — a strategic change must re-pin it deliberately", async () => {
    const digest = digestOf(await battle());
    if (digest !== GOLDEN_DIGEST) {
      // Fail with the digest itself so re-pinning is a copy, not archaeology.
      expect(digest).toBe(
        `${GOLDEN_DIGEST}\n\n--- computed digest (re-pin with a DECISIONS.md entry) ---\n${digest}`,
      );
    }
    expect(digest).toBe(GOLDEN_DIGEST);
  }, 120_000);

  test("the checkpoint stays inside §19's 1.5 MB wire budget at this scale", async () => {
    const results = await battle();
    const largest = Math.max(...results.map((r) => r.checkpointBytes.length));
    expect(largest).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  }, 120_000);
});
