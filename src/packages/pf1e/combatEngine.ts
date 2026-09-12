/**
 * Pathfinder 1e Vectorized Combat & Attack Resolver with High-Fidelity PF1e Rules, Regeneration, and Trample.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { PRNG } from "../../core/sim";
import { XoshiroPRNG } from "../../sim/prng";
import {
  PF1eCondition,
  PF1eDrType,
  type PF1eProfileRegistry,
  type PF1eUnitProfile,
} from "./schema";

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
  netDamageDealt: number;
  /** Nonlethal damage dealt (SRD: Minimum Damage / Dealing Nonlethal Damage). */
  nonlethalDealt: number;
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
  /**
   * Dice source. Production callers MUST pass a fork of the turn's injected PRNG
   * (`pf1eRngFromPrng(rng.fork(unitIndex))`) so PF1e resolves identically under
   * checkpoint, replay and the §5A hash. `seed` remains as a deterministic fallback for
   * tests and ad-hoc callers.
   */
  rng?: PF1eRng;
  seed?: number;
  targetAcType?: PF1eAcType;
  isRanged?: boolean;
  isFlanked?: boolean;
  /** When true (default), evaluates full PF1e rules: Firearms range/misfires, DR material bypass, and Condition penalties. */
  highFidelity?: boolean;
  /**
   * Cap on how many of the profile's BAB **iterative** attacks each attacker model
   * makes (default: the full routine, e.g. BAB 9 swings twice at 9/+4). This ONLY
   * truncates the iterative routine — it does not model effects that add or reshape
   * attacks outside that routine, such as Haste's extra attack or Vital Strike's
   * standard-action damage dice (D-178). SRD Cleave uses it to swing exactly ONE
   * extra attack at full BAB rather than a whole second full-attack routine.
   */
  maxIterativeAttacks?: number;
}

export interface PF1eCombatResult {
  attacksExecuted: number;
  metrics: PF1eCombatMetrics;
}

/** Minimal dice interface the PF1e kernel needs. */
export interface PF1eRng {
  d(sides: number): number;
}

/**
 * Adapt the sim's §5A PRNG (Xoshiro-identical, `src/sim/prng.ts`, or `BulkDice`) into the
 * kernel's dice source. Replaces the module-local LCG, whose streams were unrelated to the
 * seeded turn and therefore broke replay/checkpoint parity (Gap List §1.5).
 */
export function pf1eRngFromPrng(prng: PRNG): PF1eRng {
  return {
    d(sides: number): number {
      return Math.floor(prng.nextFloat() * sides) + 1;
    },
  };
}

/** Deterministic fallback when no PRNG is injected (tests, offline resolvers). */
export function pf1eRngFromSeed(seed: number): PF1eRng {
  return pf1eRngFromPrng(new XoshiroPRNG(seed >>> 0));
}

/** The three AC flavours the SRD distinguishes, plus the legacy alias for flat-footed. */
export type PF1eAcType = "ac" | "touchAc" | "flatFootedAc" | "flatFooted";

/**
 * `targetAcType` → pool column. `flatFooted` is accepted as an alias so callers written
 * against the old (non-existent-column) spelling still resolve — that spelling is what made
 * flat-footed attacks silently read the *attacker's* AC (Gap List §2.1).
 */
export function pf1eAcColumn(acType: PF1eAcType): "ac" | "touchAc" | "flatFootedAc" {
  switch (acType) {
    case "ac":
      return "ac";
    case "touchAc":
      return "touchAc";
    case "flatFootedAc":
    case "flatFooted":
      return "flatFootedAc";
    default:
      throw new Error(`pf1e: unknown targetAcType ${JSON.stringify(acType)}`);
  }
}

/**
 * Defender's AC of the requested flavour. The pool column is authoritative (it is what the
 * replica and the hash carry); an unset/zero column falls back to the **defender's** profile,
 * and a target with no profile falls back to the SRD base of 10 — never to the attacker's AC.
 */
export function resolveTargetAc(
  pool: ModelPool,
  defenderProfile: PF1eUnitProfile | undefined,
  targetIdx: number,
  acType: PF1eAcType,
): number {
  const column = pf1eAcColumn(acType);
  const fromPool = pool.sys[column]?.[targetIdx] ?? 0;
  if (fromPool > 0) return fromPool;
  if (!defenderProfile) return 10;
  return defenderProfile[column];
}

/** @deprecated Tests only — production paths inject the turn PRNG via `pf1eRngFromPrng`. */
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

  const rng = opts.rng ?? pf1eRngFromSeed(seed ?? 0);

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
    netDamageDealt: 0,
    nonlethalDealt: 0,
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

    let attacksTaken = 0;
    for (const attackBonus of profile.iteratives) {
      if (opts.maxIterativeAttacks !== undefined && attacksTaken >= opts.maxIterativeAttacks) break;
      if (defIdxPtr >= defenders.length) break;
      let targetIdx = defenders[defIdxPtr] ?? 0;

      // Skip dead defenders
      while (defIdxPtr < defenders.length && ((pool.status[targetIdx] ?? 0) & ModelStatus.dead) !== 0) {
        defIdxPtr++;
        if (defIdxPtr < defenders.length) targetIdx = defenders[defIdxPtr] ?? 0;
      }
      if (defIdxPtr >= defenders.length) break;

      metrics.totalAttacks++;
      attacksTaken++;

      const defStatus = pool.status[targetIdx] ?? 0;

      // The defender's own profile — never the attacker's — backs up missing columns.
      const defProfile = registry.get(pool.sys["profileIdx"]?.[targetIdx] ?? 0);

      // Calculate Target AC with High-Fidelity Firearms & Touch AC rules
      let effectiveAcType: PF1eAcType = targetAcType;
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

      // SRD (Combat Modifiers > Flanking): flanking is a +2 flanking **bonus on the attack
      // roll**, and nothing else — it does not reduce the defender's AC. Applying it to both
      // sides double-counted the bonus (Gap List §2.2).
      const isDefenderFlanked = isFlanked || (defStatus & PF1eCondition.FLANKED) !== 0;
      let targetAc = resolveTargetAc(pool, defProfile, targetIdx, effectiveAcType);

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
      let attackMod = attackBonus + (isDefenderFlanked ? 2 : 0) + profile.enhancementBonus - rangePenalty;
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

      // Roll Base Damage. Multipliers scale the dice *and* the static bonus, and the
      // minimum-damage rule applies to the final result: if penalties drive it below 1 the
      // attack deals 1 point of nonlethal damage instead of 1 point of lethal damage
      // (SRD: Combat Statistics > Damage, "Minimum Damage"; Gap List §2.3).
      let rawDamage = 0;
      let nonlethalDamage = 0;
      {
        let damageTotal = 0;
        for (let m = 0; m < mult; m++) {
          let diceTotal = 0;
          for (let d = 0; d < profile.damageDiceCount; d++) {
            diceTotal += rng.d(profile.damageDiceSides);
          }
          let dmgMod = profile.damageMod;
          if (highFidelity && (atkStatus & PF1eCondition.SICKENED) !== 0) dmgMod -= 2;
          damageTotal += diceTotal + dmgMod;
        }
        if (damageTotal < 1) nonlethalDamage = 1;
        else rawDamage = damageTotal;
      }

      metrics.rawDamageDealt += rawDamage;
      if (nonlethalDamage > 0) {
        metrics.nonlethalDealt += nonlethalDamage;
        const priorNonlethal = pool.sys["nonlethal"]?.[targetIdx] ?? 0;
        const totalNonlethal = priorNonlethal + nonlethalDamage;
        if (pool.sys["nonlethal"]) pool.sys["nonlethal"][targetIdx] = totalNonlethal;
        // SRD: nonlethal damage does not reduce hit points; reaching past current HP makes
        // the target unconscious (staggered-at-equal is Gap List §2.12).
        if (totalNonlethal > (pool.hp[targetIdx] ?? 0)) {
          pool.status[targetIdx] = (pool.status[targetIdx] ?? 0) | PF1eCondition.UNCONSCIOUS;
        }
      }

      // Damage Reduction is a property of the DEFENDER. Reading it as
      // `(pool column ?? 0) || attacker profile` silently applied the attacker's own DR to
      // the blow when the defender's column was 0 (Gap List §2.10, the fallback half).
      const defDrVal = pool.sys["drVal"]?.[targetIdx] ?? 0;
      const defDrType = pool.sys["drType"]?.[targetIdx] ?? 0;
      const drVal = defDrVal > 0 ? defDrVal : (defProfile?.drVal ?? 0);
      const drTypeFlags = defDrType > 0 ? defDrType : (defProfile?.drTypeFlags ?? 0);
      // DR never applies to nonlethal damage.
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
      const targetProfile = defProfile;
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
  const rng = pf1eRngFromSeed(seed);
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
  rng: PF1eRng
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
  rng: PF1eRng
): { executed: number; hits: number; totalDamage: number } {
  let executed = 0;
  let hits = 0;
  let totalDamage = 0;

  for (const enemyIdx of adjacentEnemies) {
    if (((pool.status[enemyIdx] ?? 0) & ModelStatus.dead) !== 0) continue;

    const profile = registry.get(pool.sys["profileIdx"]?.[enemyIdx] ?? 1);
    if (!profile) continue;

    // Check AoO used count vs maxAoos
    const used = pool.sys["aooUsed"]?.[enemyIdx] ?? 0;
    if (used >= profile.maxAoos) continue;

    // A swing is taken (M11: "AoO executed"), even when it misses.
    executed++;
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

  return { executed, hits, totalDamage };
}
