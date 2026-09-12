/**
 * Pathfinder 1e AOE Spell Avoidance, Scatter, and High-Fidelity SR/Concentration Engine.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { SpatialGrid } from "../../core/spatialGrid";
import type { RulesWallsContext } from "../../core/rules";
import { hasLineOfEffect } from "../../core/detection";
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
  /** Aim direction for cone/line shapes (CRB p.214); unused by circle. */
  dirX?: number;
  dirY?: number;
  /** Line corridor width in feet (CRB p.214's published lines are 5 ft wide). */
  widthFeet?: number;
  casterIdx?: number;
  casterLevel?: number;
  castingStatMod?: number;
  spellPenetration?: number;
}

export interface PF1eSpellMetrics {
  modelsTargeted: number;
  /**
   * Models inside the area but unreachable from the point of origin: "It can't affect
   * creatures with total cover from its point of origin" (CRB p.214, Burst). Reported,
   * never affected.
   */
  modelsBlockedByCover: number;
  savesPassed: number;
  savesFailed: number;
  srBlocked: number;
  damageDealt: number;
  killsCount: number;
  concentrationPassed: number;
  concentrationFailed: number;
  spellInterrupted: boolean;
  /** Attacks of opportunity swung at the caster for casting while threatened (M11). */
  aooExecuted: number;
  /** Of those swings, the ones that hit the caster (M11). */
  aooHits: number;
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
  /**
   * Sight-blocking walls. When present, a model in the area that has no line of effect
   * from the spell's point of origin has total cover and is skipped (CRB p.214: a burst
   * "affects only an area, creature, or object to which it has line of effect from its
   * origin"). Absent walls keep the historic open-field behaviour.
   */
  walls?: RulesWallsContext;
}

export interface PF1eSpellResult {
  affectedModels: number[];
  /**
   * One entry per affected model, in resolution order: the damage actually dealt after the
   * save, whether the model died, and the save outcome. This is what lets a caller
   * attribute the area's effect to the units that own the models (M11).
   */
  perModel: PF1eSpellModelOutcome[];
  metrics: PF1eSpellMetrics;
}

export interface PF1eSpellModelOutcome {
  idx: number;
  damageDealt: number;
  killed: boolean;
  savePassed: boolean;
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
    walls,
  } = opts;

  const rng = opts.rng ?? pf1eRngFromSeed(seed ?? 0);

  const metrics: PF1eSpellMetrics = {
    modelsTargeted: 0,
    modelsBlockedByCover: 0,
    savesPassed: 0,
    savesFailed: 0,
    srBlocked: 0,
    damageDealt: 0,
    killsCount: 0,
    concentrationPassed: 0,
    concentrationFailed: 0,
    spellInterrupted: false,
    aooExecuted: 0,
    aooHits: 0,
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
      metrics.aooExecuted += aooResult.executed;
      metrics.aooHits += aooResult.hits;
      if (aooResult.totalDamage > 0) {
        // Must make secondary concentration check vs 10 + damage + spellLevel
        const damConcDC = 10 + aooResult.totalDamage + spellLevel;
        const damConcRoll = rng.d(20);
        if (damConcRoll + casterLevel + castingStatMod < damConcDC) {
          metrics.spellInterrupted = true;
          return { affectedModels: [], perModel: [], metrics };
        }
      }
    }
  }

  // Shape membership (CRB p.214), resolved in continuous feet. A cone is the
  // quarter-circle that "shoots away from you … and widens out as it goes": within 45°
  // of the designated direction, out to its length. A line "shoots away from you in a
  // line" and affects creatures in the corridor it passes through. Circle keeps the
  // radius check. The tactical cell layer's cone/line discretization remains the C01b
  // refusal; this is the strategic layer's own continuous reading.
  const shape = spell.shape;
  let dirX = 0;
  let dirY = 0;
  if (shape === "cone" || shape === "line") {
    dirX = spell.dirX ?? 0;
    dirY = spell.dirY ?? 0;
    const dirLen = Math.hypot(dirX, dirY);
    if (!Number.isFinite(dirX) || !Number.isFinite(dirY) || dirLen === 0) {
      throw new Error(`${shape} shape requires a non-zero spell.dirX/dirY`);
    }
    dirX /= dirLen;
    dirY /= dirLen;
  }
  const halfExtent = shape === "line" ? spell.radius + (spell.widthFeet ?? 5) / 2 : spell.radius;

  const candidateIndices = grid.queryRect({
    x: spell.x - halfExtent,
    y: spell.y - halfExtent,
    width: halfExtent * 2,
    height: halfExtent * 2,
  });

  const affectedModels: number[] = [];
  const perModel: PF1eSpellModelOutcome[] = [];

  for (const idx of candidateIndices) {
    const status = pool.status[idx] ?? 0;
    if ((status & ModelStatus.dead) !== 0) continue;

    const mx = pool.x[idx] ?? 0;
    const my = pool.y[idx] ?? 0;

    const dx = mx - spell.x;
    const dy = my - spell.y;

    if (shape === "cone") {
      const proj = dx * dirX + dy * dirY; // distance along the aim
      const perp = Math.abs(dx * dirY - dy * dirX); // sideways offset from the aim
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Quarter-circle: within 45° of the aim (perp <= proj) and within the length.
      if (proj < 0 || perp > proj || dist > spell.radius) continue;
    } else if (shape === "line") {
      const proj = dx * dirX + dy * dirY;
      const perp = Math.abs(dx * dirY - dy * dirX);
      if (proj < 0 || proj > spell.radius || perp > (spell.widthFeet ?? 5) / 2) continue;
    } else {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > spell.radius) continue;
    }

    // Total cover: no line of effect from the point of origin (CRB p.214). Checked before
    // targeting so a walled-off model is neither counted nor rolled against.
    if (walls && !hasLineOfEffect(spell.x, spell.y, mx, my, walls)) {
      metrics.modelsBlockedByCover++;
      continue;
    }

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

    const killed = newHp === 0;
    if (killed) {
      pool.status[idx] = (pool.status[idx] ?? 0) | ModelStatus.dead;
      metrics.killsCount++;
    }

    perModel.push({ idx, damageDealt: damage, killed, savePassed });
  }

  return { affectedModels, perModel, metrics };
}
