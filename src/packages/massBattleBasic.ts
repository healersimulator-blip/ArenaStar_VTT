/**
 * §12 reference system "mass-battle-basic" (WHFB/KoW-like): move, shoot,
 * melee, saves, wounds, morale/rout, simple supply attrition. Pure, seeded,
 * deterministic; used by tests and benchmarks. Runs inside the SimWorker.
 */
import type { RulesContext, RulesModule, UnitView } from "../core/rules";
import type { ModelPool, Order } from "../core/strategic";
import { ModelStatus } from "../core/strategic";
import type { PRNG } from "../core/sim";
import { err, ok, type OkOrErr } from "../core/result";

interface UnitTypeProfile {
  move: number;
  shoot: number;
  fight: number;
  defense: number;
  courage: number;
  points: number;
}

const UNIT_TYPES: Record<string, UnitTypeProfile> = {
  infantry: { move: 4, shoot: 12, fight: 3, defense: 4, courage: 3, points: 5 },
  cavalry: { move: 8, shoot: 8, fight: 4, defense: 3, courage: 4, points: 9 },
  artillery: { move: 2, shoot: 24, fight: 1, defense: 2, courage: 2, points: 15 },
};

const KNOWN_FORMATIONS = ["line", "column", "wedge", "square", "skirmish"];

const FALLBACK_PROFILE: UnitTypeProfile = UNIT_TYPES.infantry ?? {
  move: 4,
  shoot: 12,
  fight: 3,
  defense: 4,
  courage: 3,
  points: 5,
};

const PACE_VERB: Record<string, string> = { march: "marches", run: "runs", charge: "charges" };

const profileOf = (unit: UnitView): UnitTypeProfile => {
  const own = (unit.profile as { move?: number }).move;
  if (typeof own === "number") return unit.profile as unknown as UnitTypeProfile;
  return UNIT_TYPES[unit.type] ?? FALLBACK_PROFILE;
};

/** factionId → enemy factionIds (allies excluded). */
function enemiesOf(ctx: RulesContext): (factionId: string) => Set<string> {
  const allies = new Map<string, Set<string>>();
  for (const f of ctx.factions) {
    allies.set(
      f._id,
      new Set([f._id, ...f.allies.map((a) => (typeof a === "string" ? a : String(a)))]),
    );
  }
  return (factionId) => {
    const own = allies.get(factionId) ?? new Set([factionId]);
    return new Set(ctx.factions.filter((f) => !own.has(f._id)).map((f) => f._id));
  };
}

const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(ax - bx, ay - by);

function unitAnchor(pool: ModelPool, unit: UnitView): { x: number; y: number } {
  const [start, end] = unit.modelRange ?? [0, 0];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = start; i < end && i < pool.count; i++) {
    if ((pool.status[i] ?? 0) & ModelStatus.dead) continue;
    sx += pool.x[i] ?? 0;
    sy += pool.y[i] ?? 0;
    n++;
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

/** d6 roll from a unit sub-stream. */
const d6 = (rng: PRNG): number => 1 + Math.floor(rng.nextFloat() * 6);

export interface MassBattleOptions {
  /** grid units per move point (§12 grid context distance). */
  readonly scale?: number;
}

export function createMassBattleBasic(options: MassBattleOptions = {}): RulesModule {
  const scale = options.scale ?? 1;
  const subPhases = ["move", "shoot", "melee", "morale", "supply"] as const;

  const module: RulesModule = {
    schema: {
      version: "1.0.0",
      modelColumns: { ammo: "u8" },
      unitTypes: UNIT_TYPES as unknown as Record<string, import("../core/documents").Json>,
      orderTypes: ["move", "attack", "hold", "formation", "retreat", "supply", "custom"],
      subPhases: [...subPhases],
    },

    validateOrder(_ctx: RulesContext, _unit: UnitView, order: Order): OkOrErr {
      switch (order.kind) {
        case "move":
          if (order.path.length === 0) return err("move: empty path");
          if (order.path.length > 12) return err("move: path too long (max 12 waypoints)");
          for (const p of order.path) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return err("move: NaN waypoint");
          }
          return ok;
        case "attack":
          return order.targetUnitId ? ok : err("attack: missing targetUnitId");
        case "hold":
          return order.stance.length > 0 ? ok : err("hold: missing stance");
        case "formation":
          return KNOWN_FORMATIONS.includes(order.formation)
            ? ok
            : err(`formation: unknown "${order.formation}"`);
        case "retreat":
          return Number.isFinite(order.toward.x) && Number.isFinite(order.toward.y)
            ? ok
            : err("retreat: NaN toward");
        case "supply":
          return ok;
        case "custom":
          return err(`custom: no custom orders in mass-battle-basic (${order.type})`);
      }
    },

    resolveTurn(ctx, pool, units, orders, rng, emit): void {
      const enemies = enemiesOf(ctx);
      const liveCount = (unit: UnitView): number => {
        const [start, end] = unit.modelRange ?? [0, 0];
        let n = 0;
        for (let i = start; i < end && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) n++;
        }
        return n;
      };
      const startCounts = new Map<string, number>(units.map((u) => [u.id, liveCount(u)]));
      const findUnit = (id: string): UnitView | undefined => units.find((u) => u.id === id);

      // deterministic processing order: unit id ascending (§5A)
      const ordered = [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const isEnemy = (unit: UnitView, other: UnitView): boolean =>
        enemies(unit.factionId).has(other.factionId);

      // ── move ────────────────────────────────────────────────────────────
      for (const unit of ordered) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "move") continue;
        const prof = profileOf(unit);
        const paceMul = order.pace === "march" ? 1 : order.pace === "run" ? 1.5 : 2;
        const budget = prof.move * paceMul * scale;
        const anchor = unitAnchor(pool, unit);
        let remaining = budget;
        let cx = anchor.x;
        let cy = anchor.y;
        let leg = 0;
        const startPt = { x: cx, y: cy };
        while (remaining > 0 && leg < order.path.length) {
          const wp = order.path[leg];
          if (!wp) break;
          const d = dist(cx, cy, wp.x, wp.y);
          if (d <= remaining) {
            cx = wp.x;
            cy = wp.y;
            remaining -= d;
            leg++;
          } else {
            cx += ((wp.x - cx) / (d || 1)) * remaining;
            cy += ((wp.y - cy) / (d || 1)) * remaining;
            remaining = 0;
          }
        }
        const dx = cx - startPt.x;
        const dy = cy - startPt.y;
        if (dx !== 0 || dy !== 0) {
          const [s, e] = unit.modelRange ?? [0, 0];
          for (let i = s; i < e && i < pool.count; i++) {
            if ((pool.status[i] ?? 0) & ModelStatus.dead) continue;
            pool.x[i] = (pool.x[i] ?? 0) + dx;
            pool.y[i] = (pool.y[i] ?? 0) + dy;
            if (order.facing !== undefined) pool.rot[i] = order.facing;
          }
          emit({
            subPhase: "move",
            type: "arrive",
            unitId: unit.id,
            at: { x: cx, y: cy },
            text: `${unit.name} ${PACE_VERB[order.pace] ?? order.pace}s to (${cx.toFixed(1)}, ${cy.toFixed(1)})`,
            data: { pace: order.pace, distance: Math.min(budget, budget - remaining) },
          });
        }
      }

      // ── shoot ───────────────────────────────────────────────────────────
      for (const unit of ordered) {
        const prof = profileOf(unit);
        if (prof.shoot <= 0) continue;
        const [s, e] = unit.modelRange ?? [0, 0];
        const anchor = unitAnchor(pool, unit);
        // pick nearest enemy unit in range (deterministic: id order, nearest first)
        const targets = ordered
          .filter((t) => isEnemy(unit, t) && liveCount(t) > 0)
          .map((t) => ({
            t,
            d: dist(anchor.x, anchor.y, unitAnchor(pool, t).x, unitAnchor(pool, t).y),
          }))
          .filter(({ d }) => d <= prof.shoot)
          .sort((a, b) => a.d - b.d || (a.t.id < b.t.id ? -1 : 1));
        const target = targets[0]?.t;
        if (!target) continue;
        const rngU = rng.fork(unitIndex(unit));
        let shots = 0;
        let hits = 0;
        let wounds = 0;
        const tProf = profileOf(target);
        const targetLive = liveModels(pool, target);
        const ammoCol = pool.sys.ammo;
        for (let i = s; i < e && i < pool.count; i++) {
          if ((pool.status[i] ?? 0) & ModelStatus.dead) continue;
          if ((ammoCol?.[i] ?? 0) <= 0) continue;
          if (ammoCol) ammoCol[i] = (ammoCol[i] ?? 0) - 1;
          shots++;
          if (d6(rngU) + prof.fight >= tProf.defense + 3) {
            hits++;
            if (d6(rngU) < tProf.defense - 1 && targetLive.length > 0) {
              wounds++;
              const victim = targetLive[wounds % targetLive.length] ?? targetLive[0];
              if (victim !== undefined) applyWoundIdx(pool, victim);
            }
          }
        }
        if (shots > 0) {
          emit({
            subPhase: "shoot",
            type: "attack",
            unitId: unit.id,
            targetUnitId: target.id,
            text: `${unit.name} shoots ${target.name}: ${shots} shots, ${hits} hits, ${wounds} wounds`,
            data: { shots, hits, wounds },
          });
        }
      }

      // ── melee ───────────────────────────────────────────────────────────
      for (const unit of ordered) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "attack") continue;
        const target = findUnit(order.targetUnitId);
        if (!target || liveCount(target) <= 0) continue;
        const a = unitAnchor(pool, unit);
        const b = unitAnchor(pool, target);
        if (dist(a.x, a.y, b.x, b.y) > 0.5) continue; // not in contact yet
        const rngU = rng.fork(unitIndex(unit));
        const prof = profileOf(unit);
        const tProf = profileOf(target);
        const attackers = liveCount(unit);
        const targetLive = liveModels(pool, target);
        let hits = 0;
        let wounds = 0;
        for (let m = 0; m < attackers; m++) {
          if (d6(rngU) + prof.fight >= tProf.defense + 2) {
            hits++;
            if (d6(rngU) < tProf.defense - 1 && targetLive.length > 0) {
              wounds++;
              const victim = targetLive[wounds % targetLive.length] ?? targetLive[0];
              if (victim !== undefined) applyWoundIdx(pool, victim);
            }
          }
        }
        // engaged flags
        const [s1, e1] = unit.modelRange ?? [0, 0];
        for (let i = s1; i < e1 && i < pool.count; i++)
          pool.status[i] = (pool.status[i] ?? 0) | ModelStatus.engaged;
        const [s2, e2] = target.modelRange ?? [0, 0];
        for (let i = s2; i < e2 && i < pool.count; i++)
          pool.status[i] = (pool.status[i] ?? 0) | ModelStatus.engaged;
        emit({
          subPhase: "melee",
          type: "attack",
          unitId: unit.id,
          targetUnitId: target.id,
          text: `${unit.name} fights ${target.name}: ${hits} hits, ${wounds} wounds`,
          data: { attackers, hits, wounds },
        });
      }

      // ── morale ──────────────────────────────────────────────────────────
      for (const unit of ordered) {
        const before = startCounts.get(unit.id) ?? 0;
        const after = liveCount(unit);
        if (after === 0 || before === 0) continue;
        const lossFrac = (before - after) / before;
        if (lossFrac < 0.25) continue;
        const rngU = rng.fork(unitIndex(unit));
        const prof = profileOf(unit);
        const roll = d6(rngU) + d6(rngU);
        // break test: 2d6 + courage < 7 (higher courage = steadier)
        if (roll + prof.courage < 7) {
          const [s, e] = unit.modelRange ?? [0, 0];
          for (let i = s; i < e && i < pool.count; i++) {
            if ((pool.status[i] ?? 0) & ModelStatus.dead) continue;
            pool.status[i] = (pool.status[i] ?? 0) | ModelStatus.routed;
            pool.y[i] = (pool.y[i] ?? 0) - 1; // fall back toward own edge
          }
          emit({
            subPhase: "morale",
            type: "rout",
            unitId: unit.id,
            text: `${unit.name} breaks (${(lossFrac * 100) | 0}% losses) and falls back`,
            data: { lossFrac: Number(lossFrac.toFixed(3)), roll },
          });
        }
      }

      // ── supply ──────────────────────────────────────────────────────────
      for (const unit of ordered) {
        const army = ctx.armies.find((a) => a._id === unit.armyId);
        const level = Number(army?.supply.level ?? 1);
        if (level > 0) continue;
        const [s, e] = unit.modelRange ?? [0, 0];
        let attritted = 0;
        for (let i = s; i < e && i < pool.count; i++) {
          if ((pool.status[i] ?? 0) & ModelStatus.dead) continue;
          pool.hp[i] = (pool.hp[i] ?? 0) - 1;
          if ((pool.hp[i] ?? 0) <= 0) markDead(pool, i);
          attritted++;
          break; // one model per unit per turn (simple attrition)
        }
        if (attritted > 0) {
          emit({
            subPhase: "supply",
            type: "attrition",
            unitId: unit.id,
            text: `${unit.name} suffers supply attrition`,
          });
        }
      }
    },

    tick(_ctx, pool, units, orders, _rng, emit, dtSeconds): void {
      // Realtime: movement scaled by dt (5 grid units/s base rate).
      const rate = dtSeconds * 5 * scale;
      const ordered = [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const unit of ordered) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "move" || order.path.length === 0) continue;
        const prof = profileOf(unit);
        const [s, e] = unit.modelRange ?? [0, 0];
        const anchor = unitAnchor(pool, unit);
        const wp = order.path[0];
        if (!wp) continue;
        const d = dist(anchor.x, anchor.y, wp.x, wp.y);
        const step = Math.min(d, prof.move * rate);
        if (d < 1e-6) continue;
        const dx = ((wp.x - anchor.x) / d) * step;
        const dy = ((wp.y - anchor.y) / d) * step;
        for (let i = s; i < e && i < pool.count; i++) {
          if ((pool.status[i] ?? 0) & ModelStatus.dead) continue;
          pool.x[i] = (pool.x[i] ?? 0) + dx;
          pool.y[i] = (pool.y[i] ?? 0) + dy;
        }
        if (d - step < 1e-6) {
          emit({
            subPhase: "move",
            type: "arrive",
            unitId: unit.id,
            at: wp,
            text: `${unit.name} arrives`,
          });
        }
      }
    },

    detection(ctx, unit): number {
      const prof = profileOf(unit);
      const base = unit.type === "cavalry" ? 6 : 5 + (prof.points > 10 ? 1 : 0);
      const mul = Number(ctx.worldSettings.detectionMultiplier ?? 1);
      return base * (Number.isFinite(mul) && mul > 0 ? mul : 1);
    },

    forecast(_ctx, army) {
      const strength = army.units.reduce((acc, u) => acc + (u.stats.strength ?? 0), 0);
      const morale =
        army.units.reduce((acc, u) => acc + (u.stats.morale ?? 0), 0) /
        Math.max(1, army.units.length);
      return {
        summary: `${army.name}: ${strength} strength, morale ${morale.toFixed(1)}`,
        rows: [
          { label: "strength", value: strength },
          { label: "morale", value: Number(morale.toFixed(2)) },
        ],
        data: {},
      };
    },
  };
  return module;
}

/** Stable small integer per unit for fork() sub-streams (id hash). */
function unitIndex(unit: UnitView): number {
  let h = 2166136261;
  for (const ch of unit.id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h & 0xffff;
}

/** Live (not-dead) model indices of a unit, ascending. */
function liveModels(pool: ModelPool, unit: UnitView): number[] {
  const [s, e] = unit.modelRange ?? [0, 0];
  const out: number[] = [];
  for (let i = s; i < e && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) out.push(i);
  }
  return out;
}

function applyWoundIdx(pool: ModelPool, idx: number): void {
  if ((pool.status[idx] ?? 0) & ModelStatus.dead) return;
  pool.hp[idx] = (pool.hp[idx] ?? 0) - 1;
  if ((pool.hp[idx] ?? 0) <= 0) markDead(pool, idx);
}

function markDead(pool: ModelPool, idx: number): void {
  pool.status[idx] = (pool.status[idx] ?? 0) | ModelStatus.dead;
  pool.hp[idx] = 0;
  // free-list push without importing allocator (worker owns pool)
  pool.free[pool.freeTop++] = idx;
}

export const MASS_BATTLE_SCHEMA_COLUMNS = { ammo: "u8" } as const;
