/**
 * Pathfinder 1e AOE Spell Avoidance, Scatter, and High-Fidelity SR/Concentration Engine.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { SpatialGrid } from "../../core/spatialGrid";
import { pf1eRngFromSeed, resolvePF1eAoO, type PF1eRng } from "./combatEngine";
import type { PF1eProfileRegistry } from "./schema";

export interface PF1eSpellOrder {
  spellName: string;
  shape: "circle" | "cone" | "line";
  x: number;
  y: number;
  radius: number;
  dc: number;
  spellLevel?: number;
  damageDiceCount: number;
  damageDiceSides: number;
  saveType: "ref" | "fort" | "will";
  /**
   * True when a successful save halves the damage (the usual "Reflex half"); false when a
   * successful save negates the effect entirely. Defaults to true so pre-existing callers
   * keep their behaviour.
   */
  halfOnSave?: boolean;
  evasion?: boolean;
  improvedEvasion?: boolean;
  casterIdx?: number;
  casterLevel?: number;
  castingStatMod?: number;
  spellPenetration?: number;
}

export interface PF1eSpellMetrics {
  modelsTargeted: number;
  savesPassed: number;
  savesFailed: number;
  srBlocked: number;
  damageDealt: number;
  killsCount: number;
  concentrationPassed: number;
  concentrationFailed: number;
  spellInterrupted: boolean;
}

export interface PF1eSpellOptions {
  pool: ModelPool;
  grid: SpatialGrid;
  spell: PF1eSpellOrder;
  /**
   * Dice source. When omitted, `seed` seeds the sim's Xoshiro stream (never
   * `Math.random()`), so the turn stays replayable (Gap List §1.5).
   */
  rng?: PF1eRng;
  seed?: number;
  registry?: PF1eProfileRegistry;
  casterAdjacentEnemies?: number[];
  /** When true (default), evaluates CL vs SR rolls and Concentration/AoO rules. */
  highFidelity?: boolean;
}

export interface PF1eSpellResult {
  affectedModels: number[];
  metrics: PF1eSpellMetrics;
}

export function resolvePF1eAOESpell(opts: PF1eSpellOptions): PF1eSpellResult {
  const {
    pool,
    grid,
    spell,
    seed,
    registry,
    casterAdjacentEnemies = [],
    highFidelity = true,
  } = opts;

  const rng = opts.rng ?? pf1eRngFromSeed(seed ?? 0);

  const metrics: PF1eSpellMetrics = {
    modelsTargeted: 0,
    savesPassed: 0,
    savesFailed: 0,
    srBlocked: 0,
    damageDealt: 0,
    killsCount: 0,
    concentrationPassed: 0,
    concentrationFailed: 0,
    spellInterrupted: false,
  };

  const spellLevel = spell.spellLevel ?? 3;
  const casterLevel = spell.casterLevel ?? 5;
  const castingStatMod = spell.castingStatMod ?? 4;
  const spellPenetration = spell.spellPenetration ?? 0;

  // Defensive Casting & Concentration Check if caster is in melee reach
  if (highFidelity && casterAdjacentEnemies.length > 0 && spell.casterIdx !== undefined && registry) {
    const concDC = 15 + 2 * spellLevel;
    const concRoll = rng.d(20);
    const concTotal = concRoll + casterLevel + castingStatMod;

    if (concTotal >= concDC) {
      metrics.concentrationPassed++;
    } else {
      metrics.concentrationFailed++;
      // Failed defensive casting: provokes Attacks of Opportunity from adjacent enemies!
      const aooResult = resolvePF1eAoO(pool, spell.casterIdx, casterAdjacentEnemies, registry, rng);
      if (aooResult.totalDamage > 0) {
        // Must make secondary concentration check vs 10 + damage + spellLevel
        const damConcDC = 10 + aooResult.totalDamage + spellLevel;
        const damConcRoll = rng.d(20);
        if (damConcRoll + casterLevel + castingStatMod < damConcDC) {
          metrics.spellInterrupted = true;
          return { affectedModels: [], metrics };
        }
      }
    }
  }

  const candidateIndices = grid.queryRect({
    x: spell.x - spell.radius,
    y: spell.y - spell.radius,
    width: spell.radius * 2,
    height: spell.radius * 2,
  });

  const affectedModels: number[] = [];

  for (const idx of candidateIndices) {
    const status = pool.status[idx] ?? 0;
    if ((status & ModelStatus.dead) !== 0) continue;

    const mx = pool.x[idx] ?? 0;
    const my = pool.y[idx] ?? 0;

    const dx = mx - spell.x;
    const dy = my - spell.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > spell.radius) continue;

    metrics.modelsTargeted++;

    // Check Spell Resistance (CL vs SR Roll) in High-Fidelity Mode
    const targetSr = pool.sys["sr"]?.[idx] ?? 0;
    if (highFidelity && targetSr > 0) {
      const srRoll = rng.d(20);
      const srTotal = srRoll + casterLevel + spellPenetration;
      // A caster level check has no natural-die special cases: "if the result equals or
      // exceeds the creature's spell resistance, the spell works normally". The old
      // `srRoll !== 20` short-circuit was the DEVIATIONS D-1 house rule.
      if (srTotal < targetSr) {
        metrics.srBlocked++;
        continue; // Spell resisted by target SR!
      }
    }

    // DEVIATIONS D-1 (removed, D-130/D-151): a model resolves the save in the square it
    // occupies. Nothing in the SRD lets a creature step out of an area before saving.
    affectedModels.push(idx);

    // Roll Saving Throw
    const saveMod = pool.sys[spell.saveType]?.[idx] ?? 0;
    const d20 = rng.d(20);
    const saveTotal = d20 + saveMod;
    const savePassed = d20 === 20 || (d20 !== 1 && saveTotal >= spell.dc);

    if (savePassed) metrics.savesPassed++;
    else metrics.savesFailed++;

    // Roll Damage
    let damage = 0;
    for (let d = 0; d < spell.damageDiceCount; d++) {
      damage += rng.d(spell.damageDiceSides);
    }

    // Save outcome. "Half" halves on a success and rounds down; a spell that is not
    // half-on-save is negated entirely. Evasion is defined against "an attack that normally
    // allows a Reflex saving throw for half damage", so it does nothing to a Fortitude save
    // or to a negates spell.
    const halfOnSave = spell.halfOnSave !== false;
    const reflexHalf = spell.saveType === "ref" && halfOnSave;
    if (savePassed) {
      if (!halfOnSave) damage = 0;
      else if (reflexHalf && (spell.evasion === true || spell.improvedEvasion === true)) damage = 0;
      else damage = Math.floor(damage / 2);
    } else if (reflexHalf && spell.improvedEvasion === true) {
      damage = Math.floor(damage / 2);
    }

    metrics.damageDealt += damage;

    const currentHp = pool.hp[idx] ?? 0;
    const newHp = Math.max(0, currentHp - damage);
    pool.hp[idx] = newHp;

    if (newHp === 0) {
      pool.status[idx] = (pool.status[idx] ?? 0) | ModelStatus.dead;
      metrics.killsCount++;
    }
  }

  return { affectedModels, metrics };
}
