import { gzipSync } from "node:zlib";
import { STRATEGIC_CODEC } from "../../../src/core/strategicRoom/protocol";
import { createMassBattlePf1e } from "../../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../../src/packages/pf1e/schema";
import { SimRunnerCore } from "../../../src/sim/runner";
import { rulesInput, type UnitState } from "./scenario";
import type { Frozen, OutcomeRow, Result } from "./state";

export function resolveFrozen(job: Frozen): Result {
  const begin = performance.now();
  const { ctx, units } = rulesInput(job.scenario, job.start.units);
  const rules = createMassBattlePf1e({ resolvedTurns: job.turnId - 1 });
  let rulesMs = 0;
  const runner = new SimRunnerCore(
    {
      sceneId: ctx.sceneId ?? "",
      ctx,
      units,
      sys: PF1E_MODEL_SCHEMA,
      codecVersion: STRATEGIC_CODEC,
      snapshot: {
        bytes: job.start.bytes,
        maxHpMax: job.start.maxHpMax,
        version: job.start.version,
      },
    },
    {
      ...rules,
      resolveTurn(...args) {
        const start = performance.now();
        rules.resolveTurn(...args);
        rulesMs = performance.now() - start;
      },
    },
  );
  const result = runner.resolve({
    turnNumber: job.turnId,
    seed: job.seed,
    orders: job.orders.map(({ unitId, memberId, order }) => [
      unitId,
      { issuedTurn: job.turnId, issuedBy: memberId, pending: [order] },
    ]),
  });
  const resolved = performance.now();
  if (result.freezeHash !== job.start.hash || result.toVersion !== job.turnId)
    throw new Error("Frozen input does not match its checkpoint.");
  const ranges = new Map(result.rangeDiffs);
  const orders = new Map(job.orders.map((o) => [o.unitId, o.order.kind]));
  const rows: OutcomeRow[] = [];
  const state: UnitState[] = units.map((unit, i) => {
    const before = job.start.units[i];
    if (!before) throw new Error("Missing starting unit state.");
    const range = ranges.has(unit.id)
      ? (ranges.get(unit.id) ?? null)
      : before.range;
    const stats = { ...before.stats, ...result.unitStatDiffs[unit.id] };
    const count = (r: UnitState["range"]) => (r ? r[1] - r[0] : 0);
    rows.push({
      memberId: unit.armyId,
      unitId: unit.id,
      name: unit.name,
      before: count(before.range),
      alive: count(range),
      lost: count(before.range) - count(range),
      order: orders.get(unit.id) ?? null,
    });
    return { range, stats };
  });
  // Raw evidence (including per-turn PF1e analytics) is durable, not sent to players.
  const report = gzipSync(JSON.stringify(result.report), { level: 3 });
  return {
    state: {
      bytes: result.checkpointBytes,
      maxHpMax: result.checkpointMaxHpMax,
      version: result.toVersion,
      hash: result.poolHash,
      units: state,
    },
    rows,
    report,
    metrics: {
      resolveMs: resolved - begin,
      rulesMs,
      artifactMs: performance.now() - resolved,
    },
  };
}
