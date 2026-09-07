/**
 * Pathfinder 1e Mass Battles Reference System ("pf1e-mass-battles").
 * Integrates d20 attack routines, DR/SR, spatial envelopment, AOE spell scatter,
 * player hero participation, and detailed combat analytics.
 */
import type { RulesContext, RulesModule, UnitView } from "../core/rules";
import type { Order } from "../core/strategic";
import { ModelStatus } from "../core/strategic";
import { err, ok, type OkOrErr } from "../core/result";
import { PF1E_MODEL_SCHEMA, PF1eProfileRegistry } from "./pf1e/schema";
import { resolvePF1eAttacks } from "./pf1e/combatEngine";
import { calculatePF1eEnvelopment } from "./pf1e/envelopment";
import { resolvePF1eAOESpell } from "./pf1e/spells";
import { applyHeroLeadershipAuras, applyHeroCleaveOverkill } from "./pf1e/heroBridge";
import { PF1eBattleAnalyticsCollector } from "./pf1e/analytics";
import { SpatialGrid } from "../core/spatialGrid";

export function createMassBattlePf1e(): RulesModule {
  const registry = new PF1eProfileRegistry();
  const grid = new SpatialGrid(5);

  const subPhases = ["move", "shoot", "melee", "spell", "morale"] as const;

  const module: RulesModule = {
    schema: {
      version: "1.0.0",
      modelColumns: PF1E_MODEL_SCHEMA,
      unitTypes: {
        infantry: { move: 4, ac: 16, bab: 6, drVal: 0 },
        cavalry: { move: 8, ac: 18, bab: 8, drVal: 2 },
        artillery: { move: 2, ac: 12, bab: 4, drVal: 0 },
        hero: { move: 6, ac: 20, bab: 11, drVal: 5 },
      },
      orderTypes: ["move", "attack", "custom", "hold", "retreat"],
      subPhases: [...subPhases],
    },

    validateOrder(_ctx: RulesContext, _unit: UnitView, order: Order): OkOrErr {
      switch (order.kind) {
        case "move":
          if (order.path.length === 0) return err("move: empty path");
          return ok;
        case "attack":
          return order.targetUnitId ? ok : err("attack: missing targetUnitId");
        case "custom":
          return ok;
        case "hold":
          return ok;
        case "retreat":
          return ok;
        default:
          return ok;
      }
    },

    resolveTurn(_ctx, pool, units, orders, _rng, emit): void {
      grid.rebuild(pool);
      const analytics = new PF1eBattleAnalyticsCollector();

      // Register profiles for units
      for (const unit of units) {
        registry.register({
          name: unit.name,
          bab: (unit.stats["bab"] as number) ?? 6,
          strMod: (unit.stats["strMod"] as number) ?? 3,
          ac: (unit.stats["ac"] as number) ?? 15,
          touchAc: (unit.stats["touchAc"] as number) ?? 12,
          fort: (unit.stats["fort"] as number) ?? 4,
          ref: (unit.stats["ref"] as number) ?? 4,
          will: (unit.stats["will"] as number) ?? 2,
          dr: { val: (unit.stats["drVal"] as number) ?? 0 },
        });
      }

      // Check for Heroes and apply Leadership Auras
      for (let i = 0; i < pool.count; i++) {
        const isHero = (pool.sys["profileIdx"]?.[i] ?? 0) === 4; // Hero profile
        if (isHero) {
          applyHeroLeadershipAuras({ pool, grid, heroModelIdx: i, radius: 30, moraleBonus: 2 });
        }
      }

      // Resolve Melee Engagements & Envelopment
      for (const unit of units) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "attack" || !order.targetUnitId) continue;

        const targetUnit = units.find((u) => u.id === order.targetUnitId);
        if (!targetUnit) continue;

        const targetUnitIdx = units.indexOf(targetUnit);
        const attackerUnitIdx = units.indexOf(unit);

        // Calculate Spatial Envelopment
        const envRes = calculatePF1eEnvelopment({
          pool,
          grid,
          attackerUnitIdx,
          defenderUnitIdx: targetUnitIdx,
        });

        // Collect attacker and defender model indices
        const [aStart, aEnd] = unit.modelRange ?? [0, 0];
        const [dStart, dEnd] = targetUnit.modelRange ?? [0, 0];

        const attackers: number[] = [];
        for (let i = aStart; i < aEnd && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) attackers.push(i);
        }

        const defenders: number[] = [];
        for (let i = dStart; i < dEnd && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) defenders.push(i);
        }

        // Resolve PF1e Attack Loop
        const combatRes = resolvePF1eAttacks({
          pool,
          attackers,
          defenders,
          registry,
          seed: Math.floor(Math.random() * 100000),
          isFlanked: envRes.envelopedDefenders.length > 0,
        });

        // Check for Hero Cleave Overkill on slay
        for (const atkIdx of attackers) {
          if ((pool.sys["profileIdx"]?.[atkIdx] ?? 0) === 4 && defenders.length > 0) {
            applyHeroCleaveOverkill({
              pool,
              grid,
              targetModelIdx: defenders[0] ?? 0,
              damageDealt: 25,
              enemyUnitIdx: targetUnitIdx,
            });
          }
        }

        analytics.recordCombat(unit.id, combatRes.metrics);

        emit({
          subPhase: "melee",
          type: "attack",
          unitId: unit.id,
          targetUnitId: targetUnit.id,
          text: `${unit.name} attacks ${targetUnit.name}: ${combatRes.metrics.hits} hits, ${combatRes.metrics.netDamageDealt} damage, ${combatRes.metrics.killsCount} kills`,
          data: combatRes.metrics as unknown as Record<string, import("../core/documents").Json>,
        });
      }

      // Resolve AOE Spells
      for (const unit of units) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "custom" || order.type !== "spell_aoe") continue;

        const spellRes = resolvePF1eAOESpell({
          pool,
          grid,
          spell: {
            spellName: "Fireball",
            shape: "circle",
            x: 10,
            y: 10,
            radius: 15,
            dc: 16,
            damageDiceCount: 6,
            damageDiceSides: 6,
            saveType: "ref",
          },
          seed: Math.floor(Math.random() * 100000),
        });

        analytics.recordSpell(unit.id, spellRes.metrics);

        emit({
          subPhase: "spell",
          type: "spell",
          unitId: unit.id,
          text: `${unit.name} casts Fireball: ${spellRes.metrics.damageDealt} damage, ${spellRes.metrics.killsCount} kills`,
          data: spellRes.metrics as unknown as Record<string, import("../core/documents").Json>,
        });
      }
    },

    tick(ctx, pool, units, orders, rng, emit, dtSeconds): void {
      void ctx; void pool; void units; void orders; void rng; void emit; void dtSeconds;
    },

    detection(ctx, unit): number {
      void ctx; void unit;
      return 6;
    },

    forecast(_ctx, army) {
      return {
        summary: `PF1e Army ${army.name}`,
        rows: [],
        data: {},
      };
    },
  };

  return module;
}
