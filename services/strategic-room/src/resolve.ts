import { MarchReservation } from "./marchReservation";
import { gzipSync } from "node:zlib";
import { firstMoveBlock } from "../../../src/core/detection";
import { ModelStatus, type Order } from "../../../src/core/strategic";
import {
  STRATEGIC_CODEC,
  STRATEGIC_SPELL_CATALOG,
  type HostedFxCue,
  type Point,
  type StrategicSpellId,
} from "../../../src/core/strategicRoom/protocol";
import {
  frozenBlastSpellAction,
  frozenItemUseAction,
  frozenReactionAction,
  frozenSpellHazardAction,
  projectSpellHazardAction,
} from "../../../src/core/strategicRoom/pf1eActionProjection";
import { createMassBattlePf1e } from "../../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../../src/packages/pf1e/schema";
import {
  canonicalPoolHash,
  decodeSimSnapshot,
  encodeSimSnapshot,
  poolFromSnapshot,
  snapshotFromPool,
} from "../../../src/sim/codec";
import { SimRunnerCore } from "../../../src/sim/runner";
import { initialUnitResources, rulesInput, type ScenarioUnit, type UnitState } from "./scenario";
import type { ActionCard } from "../../../src/core/action";
import {
  checkpointPool,
  type Control,
  type Frozen,
  type OutcomeRow,
  type Result,
  type UnitRuntimeResources,
  type VersionExtras,
} from "./state";

export const MAX_PUBLISHED_ACTIONS = 64;
export const MAX_PUBLISHED_ACTION_BYTES = 128 * 1024;

/** Newest-first retention bounded by both cardinality and encoded publication size. */
export function boundedActionHistory(actions: readonly ActionCard[]): ActionCard[] {
  const retained: ActionCard[] = [];
  let bytes = 0;
  for (
    let index = actions.length - 1;
    index >= 0 && retained.length < MAX_PUBLISHED_ACTIONS;
    index--
  ) {
    const action = actions[index];
    if (!action) continue;
    const size = Buffer.byteLength(JSON.stringify(action), "utf8");
    if (size > MAX_PUBLISHED_ACTION_BYTES - bytes) continue;
    retained.push(action);
    bytes += size;
  }
  return retained.reverse();
}

function findUnitSpell(unit: ScenarioUnit | undefined, spellId: StrategicSpellId) {
  const fromSpells = unit?.spells?.find((s) => s.id === spellId);
  if (fromSpells) return fromSpells;
  if (spellId === "entangle" && unit?.spellcasting) {
    return {
      id: "entangle" as const,
      itemId: unit.spellcasting.itemId,
      actorId: unit.spellcasting.actorId,
      casterLevel: unit.spellcasting.casterLevel,
      castingAbilityMod: unit.spellcasting.castingAbilityMod,
      slots: unit.spellcasting.entangleSlots,
    };
  }
  return null;
}

function unitCentroidFromPool(
  pool: ReturnType<typeof checkpointPool>,
  range: [number, number] | null | undefined,
): Point | null {
  if (!range) return null;
  const [start, end] = range;
  let sx = 0,
    sy = 0,
    n = 0;
  for (let i = start; i < end && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
    sx += pool.x[i] ?? 0;
    sy += pool.y[i] ?? 0;
    n++;
  }
  return n > 0 ? { x: sx / n, y: sy / n } : null;
}

function cloneUnitResources(
  scenarioUnits: readonly ScenarioUnit[],
  startUnits: readonly UnitState[],
  extras: VersionExtras | undefined,
  scenario: Frozen["scenario"],
): Record<string, UnitRuntimeResources> {
  const base = initialUnitResources(scenario);
  const out: Record<string, UnitRuntimeResources> = {};
  for (const [uid, val] of Object.entries(base)) {
    out[uid] = {
      ...(val.spells ? { spells: { ...val.spells } } : {}),
      ...(val.items ? { items: { ...val.items } } : {}),
      ...(val.conditions ? { conditions: [...val.conditions] } : {}),
      ...(val.buffs ? { buffs: val.buffs.map((b) => ({ ...b })) } : {}),
    };
  }
  for (const [uid, val] of Object.entries(extras?.unitResources ?? {})) {
    out[uid] = {
      ...(val.spells ? { spells: { ...val.spells } } : {}),
      ...(val.items ? { items: { ...val.items } } : {}),
      ...(val.conditions ? { conditions: [...val.conditions] } : {}),
      ...(val.buffs ? { buffs: val.buffs.map((b) => ({ ...b })) } : {}),
    };
  }
  // Keep legacy stats.entangleSlots synchronized when older checkpoints omitted extras
  scenarioUnits.forEach((u, idx) => {
    const st = startUnits[idx];
    if (st?.stats.entangleSlots !== undefined) {
      const entry = out[u.id] ?? (out[u.id] = {});
      const spells = entry.spells ?? (entry.spells = {});
      if (spells.entangle === undefined || st.stats.entangleSlots < spells.entangle) {
        spells.entangle = st.stats.entangleSlots;
      }
    }
  });
  return out;
}

function authorizedCommanderForUnit(
  commanderId: string,
  unitId: string,
  control: Control | undefined,
): string {
  if (control) {
    for (const [seatId, units] of Object.entries(control)) {
      if (Array.isArray(units) && units.includes(unitId)) return seatId;
    }
  }
  if (!commanderId) return "";
  if (!control || !Object.prototype.hasOwnProperty.call(control, commanderId)) {
    return commanderId;
  }
  const granted = control[commanderId];
  if (granted === null || granted === undefined) return commanderId;
  return granted.includes(unitId) ? commanderId : "";
}

export function resolveFrozen(job: Frozen): Result {
  const begin = performance.now();
  const scenarioUnits = job.scenario.commanders.flatMap(
    (commander) => commander.units,
  );
  const unitFactionMap = new Map<string, string>();
  for (const c of job.scenario.commanders) {
    for (const u of c.units) unitFactionMap.set(u.id, u.factionId ?? c.factionId);
  }

  const orderedUnits = new Set<string>();
  for (const entry of job.orders) {
    if (orderedUnits.has(entry.unitId))
      throw new Error("Frozen turn contains duplicate orders for one unit.");
    orderedUnits.add(entry.unitId);
  }

  const nextResources = cloneUnitResources(
    scenarioUnits,
    job.start.units,
    job.start.extras,
    job.scenario,
  );
  // Prune expired buffs at start of turn
  for (const res of Object.values(nextResources)) {
    if (res.buffs) {
      res.buffs = res.buffs.filter((b) => b.expiresAfterTurn >= job.turnId);
      if (res.buffs.length === 0) delete res.buffs;
    }
  }

  const startPool = checkpointPool(job.start);
  const startCentroids = new Map<string, Point | null>();
  scenarioUnits.forEach((u, idx) => {
    startCentroids.set(u.id, unitCentroidFromPool(startPool, job.start.units[idx]?.range));
  });

  const fxCues: HostedFxCue[] = [];
  const itemActions: ActionCard[] = [];
  const reactionActions: ActionCard[] = [];
  const pendingHeals: Array<{ targetUnitId: string; potency: number }> = [];

  // 1. Pre-turn buff/heal consumables (`useItem`) so buffs apply to this turn's resolution
  for (const { unitId, order } of job.orders) {
    if (order.kind !== "useItem") continue;
    const uIndex = scenarioUnits.findIndex((u) => u.id === unitId);
    const scenUnit = scenarioUnits[uIndex];
    const itemDef = scenUnit?.items?.find((it) => it.id === order.itemId);
    const availCharges = nextResources[unitId]?.items?.[order.itemId] ?? 0;
    if (!scenUnit || !itemDef || availCharges < 1) {
      throw new Error("Frozen item use lacks its projected item or remaining charges.");
    }
    const targetId = order.targetUnitId ?? unitId;
    const targetUnit = scenarioUnits.find((u) => u.id === targetId);
    if (!targetUnit || unitFactionMap.get(targetId) !== unitFactionMap.get(unitId)) {
      throw new Error("Item target must be an allied unit.");
    }
    const itemsMap = nextResources[unitId]?.items;
    if (itemsMap) itemsMap[order.itemId] = Math.max(0, availCharges - 1);

    const targetAt = startCentroids.get(targetId) ?? targetUnit.anchor;
    if (itemDef.effect === "heal") {
      pendingHeals.push({ targetUnitId: targetId, potency: itemDef.potency ?? 8 });
      fxCues.push({
        id: `fx-item-${job.turnId}-${unitId}`,
        turnId: job.turnId,
        preset: "heal",
        at: targetAt,
        radius: 15,
        soundCue: "chime",
      });
      itemActions.push(
        frozenItemUseAction({
          actionId: `item-${job.turnId}-${unitId}`,
          sceneId: "battlefield",
          ...(itemDef.actorId ? { actorId: itemDef.actorId } : {}),
          itemId: itemDef.id,
          itemName: itemDef.name,
          unitId,
          targetUnitName: targetUnit.name,
          effect: "heal",
          summary: `Restores up to ${itemDef.potency ?? 8} HP per wounded soldier in ${targetUnit.name}.`,
          turnId: job.turnId,
        }),
      );
    } else {
      const targetRes = nextResources[targetId] ?? (nextResources[targetId] = {});
      const buffs = targetRes.buffs ?? (targetRes.buffs = []);
      buffs.push({ effect: itemDef.effect, expiresAfterTurn: job.turnId + 9 });
      fxCues.push({
        id: `fx-item-${job.turnId}-${unitId}`,
        turnId: job.turnId,
        preset: "buff",
        at: targetAt,
        radius: 20,
        soundCue: "horn",
      });
      itemActions.push(
        frozenItemUseAction({
          actionId: `item-${job.turnId}-${unitId}`,
          sceneId: "battlefield",
          ...(itemDef.actorId ? { actorId: itemDef.actorId } : {}),
          itemId: itemDef.id,
          itemName: itemDef.name,
          unitId,
          targetUnitName: targetUnit.name,
          effect: itemDef.effect,
          summary: `Applies ${itemDef.effect} formation bonus to ${targetUnit.name} for 10 rounds.`,
          turnId: job.turnId,
        }),
      );
    }
  }

  const { ctx, armies, units } = rulesInput(job.scenario, job.start.units, {
    ...(job.live ? { live: job.live } : {}),
    extras: { unitResources: nextResources },
    turnId: job.turnId,
  });

  const carriedHazards = (job.start.hazards ?? []).filter(
    (hazard) =>
      (hazard.expiresAfterTurn ?? Number.MAX_SAFE_INTEGER) >= job.turnId,
  );

  // 2. Persistent hazard spell casts (`entangle`, `burning-entanglement`, `black-tentacles`)
  // and instantaneous pack blast casts (`fireball`, `burning-hands`, `lightning-bolt`, `cone-of-cold`)
  const hazardCasts: Array<{ action: ActionCard; hazard: NonNullable<Frozen["start"]["hazards"]>[number] }> = [];
  const blastCasts: Array<{
    unitId: string;
    actorId: string;
    itemId: string;
    spellId: StrategicSpellId;
    origin: Point;
    dir?: Point;
    saveDc: number;
  }> = [];

  for (const { unitId, order } of job.orders) {
    if (order.kind !== "cast") continue;
    const index = scenarioUnits.findIndex((unit) => unit.id === unitId);
    const scenUnit = scenarioUnits[index];
    const caster = findUnitSpell(scenUnit, order.spellId);
    const availSlots =
      nextResources[unitId]?.spells?.[order.spellId] ??
      (order.spellId === "entangle" ? job.start.units[index]?.stats.entangleSlots : undefined) ??
      0;
    if (!caster || caster.itemId !== order.itemId || availSlots < 1) {
      throw new Error(
        `Frozen ${order.spellId} cast lacks its projected caster or available slot.`,
      );
    }
    const casterFactionId = units[index]?.factionId;
    if (!casterFactionId)
      throw new Error("Frozen spell cast lacks its caster faction.");

    // Spend slot in runtime resources
    const unitRes = nextResources[unitId] ?? (nextResources[unitId] = {});
    const spellsMap = unitRes.spells ?? (unitRes.spells = {});
    spellsMap[order.spellId] = Math.max(0, availSlots - 1);

    const catalog = STRATEGIC_SPELL_CATALOG[order.spellId];
    const saveDc = 10 + catalog.level + caster.castingAbilityMod;
    fxCues.push({
      id: `fx-spell-${job.turnId}-${unitId}`,
      turnId: job.turnId,
      preset: order.spellId,
      at: order.origin,
      ...(order.dir ? { dir: order.dir } : {}),
      radius: catalog.radius,
      soundCue: catalog.kind === "blast" ? "blast" : "vines",
    });

    if (
      order.spellId === "entangle" ||
      order.spellId === "burning-entanglement" ||
      order.spellId === "black-tentacles"
    ) {
      const action = frozenSpellHazardAction({
        actionId: `${order.spellId}-${job.turnId}-${unitId}`,
        sceneId: ctx.sceneId ?? "strategic-scene",
        actorId: caster.actorId ?? unitId,
        itemId: caster.itemId,
        unitId,
        spellId: order.spellId,
        originFeet: order.origin,
        saveDc,
        startsTurn: job.turnId,
        casterLevel: caster.casterLevel,
        casterFactionId,
      });
      const hazard = projectSpellHazardAction({
        action,
        // Frozen-scenario coordinates are feet and the area origin is already in feet.
        grid: { size: 1, distance: 1, units: "ft" },
        startsTurn: job.turnId,
        casterLevel: caster.casterLevel,
        casterFactionId,
      });
      hazardCasts.push({ action, hazard });
    } else {
      blastCasts.push({
        unitId,
        actorId: caster.actorId ?? unitId,
        itemId: caster.itemId,
        spellId: order.spellId,
        origin: order.origin,
        ...(order.dir ? { dir: order.dir } : {}),
        saveDc,
      });
    }
  }

  // 3. Convert orders (including readied reactions!) into RulesModule `Order`s
  const rulesOrders: Array<[string, { issuedTurn: number; issuedBy: string; pending: [Order] }]> = [];
  for (const { unitId, memberId, order } of job.orders) {
    if (order.kind === "ready") {
      const myFaction = unitFactionMap.get(unitId);
      const myAt = startCentroids.get(unitId);
      const myScen = scenarioUnits.find((u) => u.id === unitId);
      let triggeredTarget: { id: string; name: string; at: Point } | null = null;

      if (myAt && myFaction) {
        const rangeLimit = order.response === "shot" ? 120 : 35;
        for (const other of job.orders) {
          const otherFaction = unitFactionMap.get(other.unitId);
          if (!otherFaction || otherFaction === myFaction) continue;
          if (order.targetUnitId && other.unitId !== order.targetUnitId) continue;
          const otherAt = startCentroids.get(other.unitId);
          const otherScen = scenarioUnits.find((u) => u.id === other.unitId);
          if (!otherAt || !otherScen) continue;
          const dist = Math.hypot(otherAt.x - myAt.x, otherAt.y - myAt.y);

          if (
            order.trigger === "enemyCasts" &&
            other.order.kind === "cast" &&
            dist <= Math.max(rangeLimit, 120)
          ) {
            triggeredTarget = { id: other.unitId, name: otherScen.name, at: otherAt };
            break;
          }
          if (
            order.trigger === "enemyEntersReach" &&
            (other.order.kind === "move" || other.order.kind === "attack")
          ) {
            const endPt =
              other.order.kind === "move"
                ? (other.order.path[other.order.path.length - 1] ?? otherAt)
                : otherAt;
            if (Math.hypot(endPt.x - myAt.x, endPt.y - myAt.y) <= rangeLimit) {
              triggeredTarget = { id: other.unitId, name: otherScen.name, at: endPt };
              break;
            }
          }
          if (
            order.trigger === "allyAttacked" &&
            other.order.kind === "attack" &&
            unitFactionMap.get(other.order.targetUnitId) === myFaction &&
            dist <= Math.max(rangeLimit, 80)
          ) {
            triggeredTarget = { id: other.unitId, name: otherScen.name, at: otherAt };
            break;
          }
        }
      }

      if (triggeredTarget && myAt) {
        if (order.response === "countermarch") {
          const dx = triggeredTarget.at.x - myAt.x;
          const dy = triggeredTarget.at.y - myAt.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          const step = Math.min(15, len);
          rulesOrders.push([
            unitId,
            {
              issuedTurn: job.turnId,
              issuedBy: memberId,
              pending: [
                {
                  kind: "move",
                  pace: "march",
                  path: [{ x: myAt.x + (dx / len) * step, y: myAt.y + (dy / len) * step }],
                },
              ],
            },
          ]);
        } else {
          const mode =
            order.response === "shot" && myScen?.weapon === "shot" ? "shot" : "melee";
          rulesOrders.push([
            unitId,
            {
              issuedTurn: job.turnId,
              issuedBy: memberId,
              pending: [{ kind: "attack", targetUnitId: triggeredTarget.id, mode }],
            },
          ]);
        }
        reactionActions.push(
          frozenReactionAction({
            actionId: `react-${job.turnId}-${unitId}`,
            sceneId: ctx.sceneId ?? "battlefield",
            unitId,
            unitName: myScen?.name ?? unitId,
            trigger: order.trigger,
            response: order.response,
            targetName: triggeredTarget.name,
            summary: `Triggered on ${order.trigger} against ${triggeredTarget.name}.`,
            turnId: job.turnId,
          }),
        );
      } else {
        rulesOrders.push([
          unitId,
          { issuedTurn: job.turnId, issuedBy: memberId, pending: [{ kind: "hold", stance: "defend" }] },
        ]);
      }
      continue;
    }

    let mapped: Order;
    switch (order.kind) {
      case "hold":
        mapped = { kind: "hold", stance: order.stance };
        break;
      case "reform":
        mapped = { kind: "custom", type: "reform", data: null };
        break;
      case "move":
        mapped = {
          kind: "move",
          path: order.path,
          pace: order.pace,
          ...(order.reform ? { reform: true } : {}),
        };
        break;
      case "attack":
        mapped = {
          kind: "attack",
          targetUnitId: order.targetUnitId,
          mode: order.mode,
          ...(order.envelop ? { envelop: true } : {}),
        };
        break;
      case "cast": {
        const cat = STRATEGIC_SPELL_CATALOG[order.spellId];
        if (cat.kind === "blast") {
          mapped = {
            kind: "custom",
            type: "spell_aoe",
            data: {
              spell: order.spellId,
              x: order.origin.x,
              y: order.origin.y,
              ...(order.dir ? { dirX: order.dir.x, dirY: order.dir.y } : {}),
            },
          };
        } else {
          mapped = { kind: "hold", stance: "hold" };
        }
        break;
      }
      case "useItem":
        mapped = { kind: "hold", stance: "hold" };
        break;
    }
    rulesOrders.push([
      unitId,
      { issuedTurn: job.turnId, issuedBy: memberId, pending: [mapped] },
    ]);
  }

  const castHazards = hazardCasts.map((cast) => cast.hazard);
  const hazardActions = hazardCasts.map((cast) => cast.action);
  const hazards = [
    ...(job.scenario.hazards ?? []),
    ...carriedHazards,
    ...castHazards,
  ];
  const march = new MarchReservation(job.scenario.bounds, hazards, job.turnId);
  const wallBlock =
    ctx.walls.x1.length > 0
      ? (fx: number, fy: number, tx: number, ty: number) =>
          firstMoveBlock(fx, fy, tx, ty, ctx.walls)
      : undefined;
  const rules = createMassBattlePf1e({
    resolvedTurns: job.turnId - 1,
    simultaneousStride: march.plan.bind(march),
    reformUnit: (pool, unit, stepBudgetFeet) =>
      march.reformUnit(pool, unit, stepBudgetFeet, wallBlock),
    envelopUnit: (input) => march.envelopUnit(input, wallBlock),
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
    orders: rulesOrders,
  });
  const resolved = performance.now();
  if (result.freezeHash !== job.start.hash || result.toVersion !== job.turnId)
    throw new Error("Frozen input does not match its checkpoint.");

  let checkpointBytes = result.checkpointBytes;
  const checkpointMaxHpMax = result.checkpointMaxHpMax;
  let poolHash = result.poolHash;

  // Apply post-resolution healing items to surviving wounded models
  if (pendingHeals.length > 0) {
    const decoded = decodeSimSnapshot(checkpointBytes, STRATEGIC_CODEC);
    const pool = poolFromSnapshot(decoded.snapshot, checkpointMaxHpMax, PF1E_MODEL_SCHEMA);
    const rangesMap = new Map(result.rangeDiffs);
    for (const heal of pendingHeals) {
      const idx = units.findIndex((u) => u.id === heal.targetUnitId);
      const range = rangesMap.has(heal.targetUnitId)
        ? rangesMap.get(heal.targetUnitId)
        : job.start.units[idx]?.range;
      if (!range) continue;
      const [start, end] = range;
      const lethalDmg = pool.sys["lethalDmg"] as Float32Array | undefined;
      for (let i = start; i < end && i < pool.count; i++) {
        if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
        const maxHp = pool.hpMax[i] ?? 1;
        const curHp = pool.hp[i] ?? maxHp;
        if (curHp < maxHp) {
          const nextHp = Math.min(maxHp, curHp + heal.potency);
          pool.hp[i] = nextHp;
          if (lethalDmg) lethalDmg[i] = Math.max(0, maxHp - nextHp);
        }
      }
    }
    const snap = snapshotFromPool(
      pool,
      decoded.snapshot.sceneId,
      result.toVersion,
      PF1E_MODEL_SCHEMA,
      STRATEGIC_CODEC,
    );
    checkpointBytes = encodeSimSnapshot(snap, checkpointMaxHpMax);
    poolHash = canonicalPoolHash(pool, PF1E_MODEL_SCHEMA, STRATEGIC_CODEC);
  }

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
    if (
      job.orders.some(
        (entry) =>
          entry.unitId === unit.id &&
          entry.order.kind === "cast" &&
          entry.order.spellId === "entangle",
      )
    )
      stats.entangleSlots = Math.max(0, (stats.entangleSlots ?? 0) - 1);
    const count = (r: UnitState["range"]) => (r ? r[1] - r[0] : 0);
    const commanderId = armies[i]?.commander[0] ?? "";
    rows.push({
      memberId: authorizedCommanderForUnit(
        commanderId,
        unit.id,
        job.start.control,
      ),
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

  // Build resolved ActionCards for blast spells (`fireball`, `burning-hands`, `lightning-bolt`, `cone-of-cold`)
  const blastActions: ActionCard[] = blastCasts.map((bc) => {
    const cat = STRATEGIC_SPELL_CATALOG[bc.spellId];
    const events = (result.report?.events ?? []) as unknown as Array<Record<string, unknown>>;
    let targeted = 0;
    let damageDealt = 0;
    let kills = 0;
    for (const ev of events) {
      if (ev.kind === "spell_aoe" && ev.unitId === bc.unitId) {
        targeted = typeof ev.modelsTargeted === "number" ? ev.modelsTargeted : 0;
        damageDealt = typeof ev.damageDealt === "number" ? ev.damageDealt : 0;
        kills = typeof ev.kills === "number" ? ev.kills : 0;
      }
    }
    if (targeted === 0) {
      // Fallback estimate from enemy casualties near blast area if event shape varied
      for (const r of rows) {
        if (unitFactionMap.get(r.unitId) !== unitFactionMap.get(bc.unitId) && r.lost > 0) {
          kills += r.lost;
          targeted += r.lost;
          damageDealt += r.lost * 10;
        }
      }
    }
    return frozenBlastSpellAction({
      actionId: `${bc.spellId}-${job.turnId}-${bc.unitId}`,
      sceneId: ctx.sceneId ?? "strategic-scene",
      actorId: bc.actorId,
      itemId: bc.itemId,
      unitId: bc.unitId,
      spellId: bc.spellId,
      label: cat.name,
      shape: cat.shape,
      originFeet: bc.origin,
      radiusFeet: cat.radius,
      saveDc: bc.saveDc,
      turnId: job.turnId,
      targeted,
      damageDealt,
      kills,
    });
  });

  // Record hazard-induced conditions on affected units so UI & reconciliation reflect them
  const activeHazardsNow = [...(job.scenario.hazards ?? []), ...carriedHazards, ...castHazards];
  if (activeHazardsNow.length > 0) {
    const endPool = poolFromSnapshot(
      decodeSimSnapshot(checkpointBytes, STRATEGIC_CODEC).snapshot,
      checkpointMaxHpMax,
      PF1E_MODEL_SCHEMA,
    );
    units.forEach((unit, idx) => {
      const at = unitCentroidFromPool(endPool, state[idx]?.range);
      if (!at) return;
      for (const hz of activeHazardsNow) {
        if ((hz.expiresAfterTurn ?? Number.MAX_SAFE_INTEGER) < job.turnId) continue;
        if (Math.hypot(at.x - hz.at.x, at.y - hz.at.y) <= hz.radius) {
          const condName = hz.spell === "blackTentacles" ? "Grappled" : "Entangled";
          const res = nextResources[unit.id] ?? (nextResources[unit.id] = {});
          const list = res.conditions ?? (res.conditions = []);
          if (!list.includes(condName)) list.push(condName);
        }
      }
    });
  }

  const publishLeaderActions = job.scenario.actionCards?.playerCharacters !== false;
  const publishUnitActions = job.scenario.actionCards?.units !== false;
  const newActions: ActionCard[] = [
    ...(publishLeaderActions ? [...hazardActions, ...blastActions, ...itemActions] : []),
    ...(publishUnitActions ? reactionActions : []),
  ];

  const nextExtras: VersionExtras | undefined =
    fxCues.length > 0 || Object.keys(nextResources).length > 0
      ? {
          ...(fxCues.length > 0 ? { fxCues } : {}),
          ...(Object.keys(nextResources).length > 0 ? { unitResources: nextResources } : {}),
        }
      : undefined;

  // Raw evidence (including per-turn PF1e analytics) is durable, not sent to players.
  const report = gzipSync(JSON.stringify(result.report), { level: 3 });
  return {
    state: {
      bytes: checkpointBytes,
      maxHpMax: checkpointMaxHpMax,
      version: result.toVersion,
      hash: poolHash,
      units: state,
      ...(job.start.control ? { control: job.start.control } : {}),
      ...(carriedHazards.length || castHazards.length
        ? { hazards: [...carriedHazards, ...castHazards] }
        : {}),
      ...((job.start.actions?.length ?? 0) || newActions.length
        ? {
            actions: boundedActionHistory([
              ...(job.start.actions ?? []),
              ...newActions,
            ]),
          }
        : {}),
      ...(nextExtras ? { extras: nextExtras } : {}),
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
