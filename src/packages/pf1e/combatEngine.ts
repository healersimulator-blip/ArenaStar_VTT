/**
 * Pathfinder 1e Vectorized Combat & Attack Resolver with High-Fidelity PF1e Rules, Regeneration, and Trample.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import { PF1eCondition, PF1eDrType, type PF1eProfileRegistry } from "./schema";

export interface PF1eCombatMetrics {
  totalAttacks: number;
  hits: number;
  misses: number;
  critThreats: number;
  critsConfirmed: number;
  misfiresCount: number;
  rawDamageDealt: number;
  drAbsorbed: number;
  drBypassed: number;
  srBlocked: number;
  netDamageDealt: number;
  killsCount: number;
  aooExecuted: number;
  aooHits: number;
  cmbSuccesses: number;
}

export interface PF1eCombatOptions {
  pool: ModelPool;
  attackers: number[];
  defenders: number[];
  registry: PF1eProfileRegistry;
  seed: number;
  targetAcType?: "ac" | "touchAc" | "flatFooted";
  isRanged?: boolean;
  isFlanked?: boolean;
  /** When true (default), evaluates full PF1e rules: Firearms range/misfires, DR material bypass, and Condition penalties. */
  highFidelity?: boolean;
}

export interface PF1eCombatResult {
  attacksExecuted: number;
  metrics: PF1eCombatMetrics;
}

// Linear congruential generator for deterministic rolls inside worker
export class SimpleRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  d(sides: number): number {
    return Math.floor(this.next() * sides) + 1;
  }
}

/** Check distance between two models in the ModelPool */
export function getModelDistance(pool: ModelPool, idxA: number, idxB: number): number {
  const xA = pool.x[idxA] ?? 0;
  const yA = pool.y[idxA] ?? 0;
  const xB = pool.x[idxB] ?? 0;
  const yB = pool.y[idxB] ?? 0;
  return Math.hypot(xB - xA, yB - yA);
}

/** Check if weapon material/enhancement/type bypasses defender's DR */
export function isDrBypassed(
  enhancement: number,
  material: "cold_iron" | "silver" | "adamantine" | "none",
  damageType: "slashing" | "piercing" | "bludgeoning",
  drTypeFlags: number
): boolean {
  if (drTypeFlags === PF1eDrType.NONE) return false;

  // Magic DR bypass (+1 enhancement)
  if ((drTypeFlags & PF1eDrType.MAGIC) !== 0 && enhancement >= 1) return true;

  // Cold Iron DR bypass
  if ((drTypeFlags & PF1eDrType.COLD_IRON) !== 0 && (material === "cold_iron" || enhancement >= 3)) return true;

  // Silver DR bypass
  if ((drTypeFlags & PF1eDrType.SILVER) !== 0 && (material === "silver" || enhancement >= 3)) return true;

  // Adamantine DR bypass
  if ((drTypeFlags & PF1eDrType.ADAMANTINE) !== 0 && (material === "adamantine" || enhancement >= 4)) return true;

  // Damage type bypass (Slashing / Piercing / Bludgeoning)
  if ((drTypeFlags & PF1eDrType.SLASHING) !== 0 && damageType === "slashing") return true;
  if ((drTypeFlags & PF1eDrType.PIERCING) !== 0 && damageType === "piercing") return true;
  if ((drTypeFlags & PF1eDrType.BLUDGEONING) !== 0 && damageType === "bludgeoning") return true;

  return false;
}

export function resolvePF1eAttacks(opts: PF1eCombatOptions): PF1eCombatResult {
  const {
    pool,
    attackers,
    defenders,
    registry,
    seed,
    targetAcType = "ac",
    isRanged = false,
    isFlanked = false,
    highFidelity = true,
  } = opts;

  const rng = new SimpleRng(seed);

  const metrics: PF1eCombatMetrics = {
    totalAttacks: 0,
    hits: 0,
    misses: 0,
    critThreats: 0,
    critsConfirmed: 0,
    misfiresCount: 0,
    rawDamageDealt: 0,
    drAbsorbed: 0,
    drBypassed: 0,
    srBlocked: 0,
    netDamageDealt: 0,
    killsCount: 0,
    aooExecuted: 0,
    aooHits: 0,
    cmbSuccesses: 0,
  };

  if (attackers.length === 0 || defenders.length === 0) {
    return { attacksExecuted: 0, metrics };
  }

  let defIdxPtr = 0;

  for (const atkIdx of attackers) {
    const atkStatus = pool.status[atkIdx] ?? 0;
    if ((atkStatus & ModelStatus.dead) !== 0) continue;
    if (highFidelity && (atkStatus & PF1eCondition.STUNNED) !== 0) continue; // Stunned models cannot act

    const profileId = pool.sys["profileIdx"]?.[atkIdx] ?? 1;
    const profile = registry.get(profileId);
    if (!profile) continue;

    for (const attackBonus of profile.iteratives) {
      if (defIdxPtr >= defenders.length) break;
      let targetIdx = defenders[defIdxPtr] ?? 0;

      // Skip dead defenders
      while (defIdxPtr < defenders.length && ((pool.status[targetIdx] ?? 0) & ModelStatus.dead) !== 0) {
        defIdxPtr++;
        if (defIdxPtr < defenders.length) targetIdx = defenders[defIdxPtr] ?? 0;
      }
      if (defIdxPtr >= defenders.length) break;

      metrics.totalAttacks++;

      const defStatus = pool.status[targetIdx] ?? 0;

      // Calculate Target AC with High-Fidelity Firearms & Touch AC rules
      let effectiveAcType = targetAcType;
      const distance = getModelDistance(pool, atkIdx, targetIdx);
      let rangePenalty = 0;

      if (highFidelity && profile.isFirearm) {
        if (distance <= profile.rangeIncrement) {
          effectiveAcType = "touchAc"; // Touch AC within 1st range increment
        } else if (profile.isEarlyFirearm) {
          // Early firearms target Standard AC beyond 1st range increment with -2 per increment
          const increments = Math.min(5, Math.ceil(distance / profile.rangeIncrement));
          rangePenalty = (increments - 1) * 2;
        }
      }

      let targetAc = pool.sys[effectiveAcType]?.[targetIdx] ?? profile.ac;
      if (isFlanked || (defStatus & PF1eCondition.FLANKED) !== 0) {
        targetAc = Math.max(0, targetAc - 2);
      }

      if (highFidelity) {
        // Prone AC modifier: -4 vs Melee, +4 vs Ranged
        if ((defStatus & PF1eCondition.PRONE) !== 0) {
          if (isRanged) targetAc += 4;
          else targetAc = Math.max(0, targetAc - 4);
        }
        if ((defStatus & PF1eCondition.BLINDED) !== 0 || (defStatus & PF1eCondition.STUNNED) !== 0) {
          targetAc = Math.max(0, targetAc - 2);
        }
      }

      // Check Firearm Misfire
      const d20 = rng.d(20);
      let effectiveMisfireMin = profile.misfireMin;
      if (highFidelity && ((atkStatus & PF1eCondition.MISFIRED) !== 0 || (atkStatus & PF1eCondition.BROKEN) !== 0)) {
        effectiveMisfireMin += 4; // Misfired/Broken gun increases misfire threshold by +4
      }

      if (highFidelity && profile.isFirearm && d20 <= effectiveMisfireMin && effectiveMisfireMin > 0) {
        metrics.misfiresCount++;
        metrics.misses++;
        pool.status[atkIdx] = (pool.status[atkIdx] ?? 0) | PF1eCondition.MISFIRED | PF1eCondition.BROKEN;
        continue;
      }

      // Apply Attacker Condition & Range Modifiers
      let attackMod = attackBonus + (isFlanked ? 2 : 0) + profile.enhancementBonus - rangePenalty;
      if (highFidelity) {
        if ((atkStatus & PF1eCondition.SHAKEN) !== 0) attackMod -= 2;
        if ((atkStatus & PF1eCondition.SICKENED) !== 0) attackMod -= 2;
        if ((atkStatus & PF1eCondition.PRONE) !== 0) attackMod -= 4;
      }

      const totalAttack = d20 + attackMod;

      const isNatural20 = d20 === 20;
      const isNatural1 = d20 === 1;

      const isHit = isNatural20 || (!isNatural1 && totalAttack >= targetAc);

      if (!isHit) {
        metrics.misses++;
        continue;
      }

      metrics.hits++;

      // Check Critical Threat
      let mult = 1;
      if (d20 >= profile.critThreatMin) {
        metrics.critThreats++;
        const confirmD20 = rng.d(20);
        const confirmTotal = confirmD20 + attackMod;
        if (confirmD20 === 20 || (confirmD20 !== 1 && confirmTotal >= targetAc)) {
          metrics.critsConfirmed++;
          mult = profile.critMultiplier;
        }
      }

      // Roll Base Damage
      let rawDamage = 0;
      for (let m = 0; m < mult; m++) {
        let diceTotal = 0;
        for (let d = 0; d < profile.damageDiceCount; d++) {
          diceTotal += rng.d(profile.damageDiceSides);
        }
        let dmgMod = profile.damageMod;
        if (highFidelity && (atkStatus & PF1eCondition.SICKENED) !== 0) dmgMod -= 2;
        rawDamage += Math.max(1, diceTotal + dmgMod);
      }

      metrics.rawDamageDealt += rawDamage;

      // Calculate Damage Reduction (DR) with Material Bypass
      const drVal = pool.sys["drVal"]?.[targetIdx] ?? profile.drVal;
      const drTypeFlags = (pool.sys["drType"]?.[targetIdx] ?? 0) || profile.drTypeFlags;
      let effectiveDr = Math.min(rawDamage, drVal);

      if (highFidelity) {
        const bypassed = isDrBypassed(
          profile.enhancementBonus,
          profile.material,
          profile.damageType,
          drTypeFlags
        );
        if (bypassed) {
          metrics.drBypassed += effectiveDr;
          effectiveDr = 0;
        }
      }

      metrics.drAbsorbed += effectiveDr;

      const netDamage = Math.max(0, rawDamage - effectiveDr);
      metrics.netDamageDealt += netDamage;

      // Apply Damage to Model HP / Lethal Damage
      const targetProfile = registry.get(pool.sys["profileIdx"]?.[targetIdx] ?? 1);
      const isRegenMonster = targetProfile && targetProfile.regenerationVal > 0;
      const isLethalType = (profile.elementalType & (targetProfile?.regenerationSuppressFlags ?? 0)) !== 0;

      if (highFidelity && isRegenMonster) {
        if (isLethalType) {
          // Fire / Acid damage deals LETHAL damage to regenerating creature!
          const curLethal = pool.sys["lethalDmg"]?.[targetIdx] ?? 0;
          const newLethal = curLethal + netDamage;
          if (pool.sys["lethalDmg"]) {
            pool.sys["lethalDmg"][targetIdx] = newLethal;
          }

          const maxHp = pool.hpMax[targetIdx] ?? 20;
          if (newLethal >= maxHp) {
            pool.status[targetIdx] = (pool.status[targetIdx] ?? 0) | ModelStatus.dead | PF1eCondition.DEAD;
            metrics.killsCount++;
            defIdxPtr++; // Permanent Death!
          }
        } else {
          // Non-suppressing damage deals NON-LETHAL damage to regenerating creature!
          const currentHp = pool.hp[targetIdx] ?? 0;
          const newHp = Math.max(0, currentHp - netDamage);
          pool.hp[targetIdx] = newHp;
          if (newHp === 0) {
            pool.status[targetIdx] = (pool.status[targetIdx] ?? 0) | PF1eCondition.DISRUPTED;
          }
        }
      } else {
        // Standard Damage & Death Resolution
        const currentHp = pool.hp[targetIdx] ?? 0;
        const newHp = Math.max(0, currentHp - netDamage);
        pool.hp[targetIdx] = newHp;

        if (newHp === 0) {
          pool.status[targetIdx] = (pool.status[targetIdx] ?? 0) | ModelStatus.dead | PF1eCondition.DEAD;
          metrics.killsCount++;
          defIdxPtr++; // Target slain
        }
      }
    }
  }

  return { attacksExecuted: metrics.totalAttacks, metrics };
}

/**
 * Reset per-round AoO count for models at start of turn.
 */
export function resetTurnAoOs(pool: ModelPool, modelIndices: number[]): void {
  for (const idx of modelIndices) {
    if (pool.sys["aooUsed"]) {
      pool.sys["aooUsed"][idx] = 0;
    }
  }
}

/**
 * Resolve PF1e Fast Healing & Regeneration for models (Exact PF1e SRD Rules).
 */
export function resolvePF1eHealing(
  pool: ModelPool,
  modelIndices: number[],
  registry: PF1eProfileRegistry
): { totalHealed: number; revivedCount: number } {
  let totalHealed = 0;
  let revivedCount = 0;

  for (const idx of modelIndices) {
    const profileId = pool.sys["profileIdx"]?.[idx] ?? 1;
    const profile = registry.get(profileId);
    if (!profile) continue;

    const status = pool.status[idx] ?? 0;
    const hp = pool.hp[idx] ?? 0;
    const maxHp = pool.hpMax[idx] ?? 20;
    const lethalDmg = pool.sys["lethalDmg"]?.[idx] ?? 0;
    const maxEffectiveHp = Math.max(0, maxHp - lethalDmg);

    // Fast Healing: applies only to living models
    if (profile.fastHealingVal > 0 && (status & ModelStatus.dead) === 0 && hp < maxEffectiveHp) {
      const healAmount = Math.min(maxEffectiveHp - hp, profile.fastHealingVal);
      pool.hp[idx] = hp + healAmount;
      totalHealed += healAmount;
    }

    // Regeneration: heals NON-LETHAL damage every round up to maxEffectiveHp (maxHp - lethalDmg)
    if (profile.regenerationVal > 0 && (status & ModelStatus.dead) === 0) {
      if (hp < maxEffectiveHp) {
        const healAmount = Math.min(maxEffectiveHp - hp, profile.regenerationVal);
        pool.hp[idx] = hp + healAmount;
        totalHealed += healAmount;

        // Revive from unconsciousness if non-lethal damage is healed back above 0 HP
        if (hp === 0 && (pool.hp[idx] ?? 0) > 0) {
          pool.status[idx] = (pool.status[idx] ?? 0) & ~PF1eCondition.DISRUPTED;
          revivedCount++;
        }
      }
    }
  }

  return { totalHealed, revivedCount };
}

/**
 * Resolve PF1e Trample Maneuver (Overrun + Automatic Damage).
 */
export function resolvePF1eTrample(
  pool: ModelPool,
  tramplers: number[],
  targets: number[],
  registry: PF1eProfileRegistry,
  seed: number
): { totalTrampled: number; totalDamage: number } {
  const rng = new SimpleRng(seed);
  let totalTrampled = 0;
  let totalDamage = 0;

  for (const tIdx of tramplers) {
    if (((pool.status[tIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
    const profile = registry.get(pool.sys["profileIdx"]?.[tIdx] ?? 1);
    if (!profile || !profile.hasTrample) continue;

    for (const dIdx of targets) {
      if (((pool.status[dIdx] ?? 0) & ModelStatus.dead) !== 0) continue;

      totalTrampled++;

      // Defender Reflex Save vs Trample DC
      const dc = profile.trampleDc;
      const refMod = pool.sys["ref"]?.[dIdx] ?? profile.ref;
      const saveRoll = rng.d(20);
      const savePassed = saveRoll === 20 || (saveRoll !== 1 && saveRoll + refMod >= dc);

      // Roll Trample Damage (2d6 + 1.5 * STR)
      let diceTotal = 0;
      for (let d = 0; d < profile.trampleDamageDiceCount; d++) {
        diceTotal += rng.d(profile.trampleDamageDiceSides);
      }
      let dmg = diceTotal + Math.floor(profile.strMod * 1.5);
      if (savePassed) dmg = Math.floor(dmg / 2);

      dmg = Math.max(1, dmg);

      const curHp = pool.hp[dIdx] ?? 0;
      pool.hp[dIdx] = Math.max(0, curHp - dmg);
      if (pool.hp[dIdx] === 0) {
        pool.status[dIdx] = (pool.status[dIdx] ?? 0) | ModelStatus.dead | PF1eCondition.DEAD;
      }
      totalDamage += dmg;
    }
  }

  return { totalTrampled, totalDamage };
}

/**
 * Resolve PF1e Combat Maneuvers (Trip, Grapple, Bull Rush, Disarm)
 */
export function resolvePF1eCombatManeuver(
  pool: ModelPool,
  attackerIdx: number,
  defenderIdx: number,
  maneuver: "trip" | "grapple" | "bull_rush" | "disarm",
  registry: PF1eProfileRegistry,
  rng: SimpleRng
): { success: boolean; conditionApplied?: number } {
  const atkProfile = registry.get(pool.sys["profileIdx"]?.[attackerIdx] ?? 1);
  const defProfile = registry.get(pool.sys["profileIdx"]?.[defenderIdx] ?? 1);

  const cmb = atkProfile?.cmb ?? 1;
  const cmd = defProfile?.cmd ?? 10;

  const roll = rng.d(20);
  const total = roll + cmb;

  if (roll === 20 || (roll !== 1 && total >= cmd)) {
    let cond = 0;
    if (maneuver === "trip") cond = PF1eCondition.PRONE;
    else if (maneuver === "grapple") cond = PF1eCondition.GRAPPLED;

    if (cond) {
      pool.status[defenderIdx] = (pool.status[defenderIdx] ?? 0) | cond;
    }
    return { success: true, conditionApplied: cond };
  }

  return { success: false };
}

/**
 * Resolve PF1e Attack of Opportunity (AoO) against a provoking model.
 */
export function resolvePF1eAoO(
  pool: ModelPool,
  provokingModelIdx: number,
  adjacentEnemies: number[],
  registry: PF1eProfileRegistry,
  rng: SimpleRng
): { hits: number; totalDamage: number } {
  let hits = 0;
  let totalDamage = 0;

  for (const enemyIdx of adjacentEnemies) {
    if (((pool.status[enemyIdx] ?? 0) & ModelStatus.dead) !== 0) continue;

    const profile = registry.get(pool.sys["profileIdx"]?.[enemyIdx] ?? 1);
    if (!profile) continue;

    // Check AoO used count vs maxAoos
    const used = pool.sys["aooUsed"]?.[enemyIdx] ?? 0;
    if (used >= profile.maxAoos) continue;

    if (pool.sys["aooUsed"]) {
      pool.sys["aooUsed"][enemyIdx] = used + 1;
    }

    const targetAc = pool.sys["ac"]?.[provokingModelIdx] ?? 10;
    const roll = rng.d(20);
    const attackBonus = profile.iteratives[0] ?? 0;
    const totalAttack = roll + attackBonus;

    if (roll === 20 || (roll !== 1 && totalAttack >= targetAc)) {
      hits++;
      let damage = profile.damageDiceCount * rng.d(profile.damageDiceSides) + profile.damageMod;
      damage = Math.max(1, damage);

      const currentHp = pool.hp[provokingModelIdx] ?? 0;
      pool.hp[provokingModelIdx] = Math.max(0, currentHp - damage);
      if (pool.hp[provokingModelIdx] === 0) {
        pool.status[provokingModelIdx] = (pool.status[provokingModelIdx] ?? 0) | ModelStatus.dead;
      }
      totalDamage += damage;
    }
  }

  return { hits, totalDamage };
}
