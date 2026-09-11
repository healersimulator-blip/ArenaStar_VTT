/**
 * Pathfinder 1e Mass Battles Reference System ("pf1e-mass-battles").
 * Integrates d20 attack routines, DR/SR, spatial envelopment, pack-driven AOE spells,
 * player hero participation, and detailed combat analytics.
 */
import type { RulesContext, RulesModule, UnitView } from "../core/rules";
import type { PRNG } from "../core/sim";
import type { Order } from "../core/strategic";
import { ModelStatus } from "../core/strategic";
import { err, ok, type OkOrErr } from "../core/result";
import { PF1E_MODEL_SCHEMA, PF1eProfileRegistry } from "./pf1e/schema";
import { buildUnitProfiles, seedPF1ePool } from "./pf1e/deploySeed";
import {
  pf1eRngFromPrng,
  resolvePF1eAttacks,
  type PF1eRng,
} from "./pf1e/combatEngine";
import { calculatePF1eEnvelopment } from "./pf1e/envelopment";
import { resolvePF1eAOESpell } from "./pf1e/spells";
import { PF1E_PACK_FIREBALL_MASS_BATTLE, parsePackSpellOrder } from "./pf1e/spellPacks";
import { spellSaveDc } from "./pf1e/casting";
import { applyHeroLeadershipAuras, applyHeroCleaveOverkill } from "./pf1e/heroBridge";
import { PF1eBattleAnalyticsCollector } from "./pf1e/analytics";
import { SpatialGrid } from "../core/spatialGrid";

/**
 * The reference system's demo caster, named rather than buried in a literal: a 5th-level
 * wizard with Intelligence 18 (+4) casting Fireball, a 3rd-level spell (CRB p.283). The DC
 * is computed by the same `spellSaveDc` the tactical engine uses, so the strategic and
 * tactical paths cannot drift apart.
 */
const DEMO_CASTER_LEVEL = 5;
const DEMO_SPELL_LEVEL = 3;
const DEMO_KEY_ABILITY_MOD = 4;
const DEMO_SPELL_ORIGIN = { x: 10, y: 10 } as const;

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

    resolveTurn(_ctx, pool, units, orders, rng, emit): void {
      grid.rebuild(pool);
      const analytics = new PF1eBattleAnalyticsCollector();

      // Profiles + derived pool columns (§1.3/§1.4). Interned from a deterministically
      // sorted unit list, so `profileIdx` values written into the pool stay valid across
      // turns, checkpoints and SimWorker restarts. Seeding also refreshes per-turn state:
      // the AoO budget resets (SRD: your attacks of opportunity refresh at the start of
      // your turn) and save/AC columns are rewritten before leadership auras are added,
      // which is what keeps an aura from stacking once per model per turn.
      const profiles = buildUnitProfiles(units, registry);
      seedPF1ePool(pool, units, profiles);

      // Leadership auras: once per hero unit, anchored on that unit's lead model.
      // "Hero" is a property of the unit (`type: "hero"` or `stats.hero`), not a magic
      // profile id — ids are now assigned by content, so the old `profileIdx === 4` test
      // would have matched whichever unit happened to intern fourth.
      for (const unit of units) {
        if (!isHeroUnit(unit)) continue;
        const anchor = unit.modelRange?.[0];
        if (anchor === undefined) continue;
        applyHeroLeadershipAuras({ pool, grid, heroModelIdx: anchor, radius: 30, moraleBonus: 2 });
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

        // Resolve PF1e Attack Loop. Dice come from the turn PRNG forked per unit
        // (§5A), never Math.random() — a seeded turn must replay identically.
        const combatRes = resolvePF1eAttacks({
          pool,
          attackers,
          defenders,
          registry,
          rng: forkRng(rng, unitIndex(unit), 1),
          isFlanked: envRes.envelopedDefenders.length > 0,
        });

        // Hero Cleave. Once per hero *unit* per engagement: the previous loop re-applied
        // the same cascade for every model of the unit against a fixed `defenders[0]`.
        // (The overkill-cascade model itself is still wrong — see Gap List §5.)
        if (isHeroUnit(unit) && attackers.length > 0 && defenders.length > 0) {
          applyHeroCleaveOverkill({
            pool,
            grid,
            targetModelIdx: defenders[0] ?? 0,
            damageDealt: 25,
            enemyUnitIdx: targetUnitIdx,
          });
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

      // Resolve AOE Spells. The payload comes from the pack's `massBattle` block rather
      // than a literal here, which is what DEVIATIONS D-2 asked P5 to do.
      const packSpell = parsePackSpellOrder({ entry: PF1E_PACK_FIREBALL_MASS_BATTLE, casterLevel: DEMO_CASTER_LEVEL });
      const { dc: packDc, issues: dcIssues } = spellSaveDc({ spellLevel: DEMO_SPELL_LEVEL, keyAbilityMod: DEMO_KEY_ABILITY_MOD });
      const packIssues = [...packSpell.issues, ...dcIssues];

      for (const unit of units) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "custom" || order.type !== "spell_aoe") continue;

        if (!packSpell.ok || packSpell.order === null || dcIssues.length > 0) {
          emit({
            subPhase: "spell",
            type: "spell",
            unitId: unit.id,
            text: `${unit.name} could not cast: ${packIssues.map((i) => i.message).join("; ")}`,
            data: {},
          });
          continue;
        }

        const spellRes = resolvePF1eAOESpell({
          pool,
          grid,
          spell: {
            spellName: packSpell.order.spellName,
            shape: packSpell.order.shape,
            x: DEMO_SPELL_ORIGIN.x,
            y: DEMO_SPELL_ORIGIN.y,
            radius: packSpell.order.radius,
            dc: packDc,
            damageDiceCount: packSpell.order.damageDiceCount,
            damageDiceSides: packSpell.order.damageDiceSides,
            saveType: packSpell.order.saveType,
            halfOnSave: packSpell.order.halfOnSave,
            evasion: packSpell.order.evasionApplies,
            casterLevel: DEMO_CASTER_LEVEL,
          },
          rng: forkRng(rng, unitIndex(unit), 2),
        });

        analytics.recordSpell(unit.id, spellRes.metrics);

        emit({
          subPhase: "spell",
          type: "spell",
          unitId: unit.id,
          text: `${unit.name} casts ${packSpell.order.spellName} (${packSpell.order.radius} ft, DC ${packDc}): ${spellRes.metrics.damageDealt} damage, ${spellRes.metrics.killsCount} kills`,
          // The cast parameters are part of the event, not just the outcome: they are what
          // makes "this order came from the pack" observable to a GM and to a test.
          data: {
            ...(spellRes.metrics as unknown as Record<string, import("../core/documents").Json>),
            spellName: packSpell.order.spellName,
            spellRadius: packSpell.order.radius,
            spellDc: packDc,
            spellLevel: DEMO_SPELL_LEVEL,
            casterLevel: DEMO_CASTER_LEVEL,
            spellDice: `${packSpell.order.damageDiceCount}d${packSpell.order.damageDiceSides}`,
          },
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

/**
 * Stable small integer per unit for `PRNG.fork()` sub-streams — same FNV-1a construction as
 * the reference package, so unit processing order cannot alter a unit's own outcomes (§5A).
 */
function unitIndex(unit: UnitView): number {
  let h = 2166136261;
  for (const ch of unit.id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h & 0xffff;
}

/** Fork a sub-stream per (unit, phase) so the melee and spell loops stay independent. */
function forkRng(rng: PRNG, unitHash: number, phase: number): PF1eRng {
  return pf1eRngFromPrng(rng.fork(((unitHash << 4) | phase) >>> 0));
}

/** A unit led by a player hero (Leadership aura, Cleave). */
function isHeroUnit(unit: UnitView): boolean {
  return unit.type === "hero" || unit.stats["hero"] === 1;
}
