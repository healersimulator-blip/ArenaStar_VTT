import { MarchReservation } from "./marchReservation";
import { gzipSync } from "node:zlib";
import { STRATEGIC_CODEC } from "../../../src/core/strategicRoom/protocol";
import { frozenEntangleAction, projectEntangleAction } from "../../../src/core/strategicRoom/pf1eActionProjection";
import { createMassBattlePf1e } from "../../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../../src/packages/pf1e/schema";
import { SimRunnerCore } from "../../../src/sim/runner";
import { rulesInput, type UnitState } from "./scenario";
import type { ActionCard } from "../../../src/core/action";
import type { Frozen, OutcomeRow, Result } from "./state";

export const MAX_PUBLISHED_ACTIONS = 64;
export const MAX_PUBLISHED_ACTION_BYTES = 128 * 1024;

/** Newest-first retention bounded by both cardinality and encoded publication size. */
export function boundedActionHistory(actions: readonly ActionCard[]): ActionCard[] {
  const retained: ActionCard[] = [];
  let bytes = 0;
  for (let index = actions.length - 1; index >= 0 && retained.length < MAX_PUBLISHED_ACTIONS; index--) {
    const action = actions[index];
    if (!action) continue;
    const size = Buffer.byteLength(JSON.stringify(action), "utf8");
    if (size > MAX_PUBLISHED_ACTION_BYTES - bytes) continue;
    retained.push(action);
    bytes += size;
  }
  return retained.reverse();
}

export function resolveFrozen(job: Frozen): Result {
  const begin = performance.now();
  const { ctx, units } = rulesInput(job.scenario, job.start.units);
  const scenarioUnits = job.scenario.commanders.flatMap((commander) => commander.units);
  const orderedUnits = new Set<string>();
  for (const entry of job.orders) {
    if (orderedUnits.has(entry.unitId))
      throw new Error("Frozen turn contains duplicate orders for one unit.");
    orderedUnits.add(entry.unitId);
  }
  const carriedHazards = (job.start.hazards ?? []).filter((hazard) =>
    (hazard.expiresAfterTurn ?? Number.MAX_SAFE_INTEGER) >= job.turnId);
  const casts = job.orders.flatMap(({ unitId, order }) => {
    if (order.kind !== "cast") return [];
    const index = scenarioUnits.findIndex((unit) => unit.id === unitId);
    const caster = scenarioUnits[index]?.spellcasting;
    const state = job.start.units[index];
    if (!caster || caster.itemId !== order.itemId || (state?.stats.entangleSlots ?? 0) < 1)
      throw new Error("Frozen Entangle cast lacks its projected caster or available slot.");
    const casterFactionId = units[index]?.factionId;
    if (!casterFactionId) throw new Error("Frozen Entangle cast lacks its caster faction.");
    const input = { actionId: `entangle-${job.turnId}-${unitId}`,
      sceneId: ctx.sceneId ?? "strategic-scene", actorId: caster.actorId, itemId: caster.itemId,
      unitId, originFeet: order.origin, saveDc: 11 + caster.castingAbilityMod,
      startsTurn: job.turnId, casterLevel: caster.casterLevel, casterFactionId };
    const action = frozenEntangleAction(input);
    const hazard = projectEntangleAction({ action, grid: { size: 5, distance: 5, units: "ft" },
      startsTurn: job.turnId, casterLevel: caster.casterLevel, casterFactionId });
    return [{ action, hazard }];
  });
  const castHazards = casts.map((cast) => cast.hazard);
  const castActions = casts.map((cast) => cast.action);
  // This cast is sourced by the Army unit's leader Actor, so it belongs to the
  // player-character/leader class. Formation and per-model policies must not leak across classes.
  const publishCastActions = job.scenario.actionCards?.playerCharacters !== false;
  const publishedCastActions = publishCastActions ? castActions : [];
  const hazards = [...(job.scenario.hazards ?? []), ...carriedHazards, ...castHazards];
  const march = new MarchReservation(job.scenario.bounds, hazards, job.turnId);
  const rules = createMassBattlePf1e({
    resolvedTurns: job.turnId - 1,
    simultaneousStride: march.plan.bind(march),
    ...(hazards.length ? { spellHazards: hazards } : {}),
  });
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
      { issuedTurn: job.turnId, issuedBy: memberId,
        pending: [order.kind === "cast" ? { kind: "hold" as const, stance: "hold" } : order] },
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
    if (job.orders.some((entry) => entry.unitId === unit.id && entry.order.kind === "cast"))
      stats.entangleSlots = Math.max(0, (stats.entangleSlots ?? 0) - 1);
    const count = (r: UnitState["range"]) => (r ? r[1] - r[0] : 0);
    rows.push({
      memberId: unit.armyId,
      unitId: unit.id,
      name: unit.name,
      before: count(before.range),
      alive: count(range),
      lost: count(before.range) - count(range),
      order: orders.get(unit.id) ?? null,
      ...(march.blocked.has(unit.id) ? { marchBlocked: true as const } : {}),
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
      ...(carriedHazards.length || castHazards.length
        ? { hazards: [...carriedHazards, ...castHazards] } : {}),
      ...((job.start.actions?.length ?? 0) || publishedCastActions.length
        ? { actions: boundedActionHistory([...(job.start.actions ?? []), ...publishedCastActions]) } : {}),
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
