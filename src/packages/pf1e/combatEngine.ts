/**
 * Pathfinder 1e Vectorized Combat & Attack Resolver with High-Fidelity PF1e Rules, Regeneration, and Trample.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { PRNG } from "../../core/sim";
import { XoshiroPRNG } from "../../sim/prng";
import { applyHealing } from "./healing";

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
  /**
   * M05 — a flat circumstance modifier on every attack roll this resolution makes, applied
   * after the profile's iterative bonuses and the flanking/enhancement/range terms. It exists
   * because the mass-battle scale has rules that *shape* an attack routine without reshaping
   * the profile: a charge's +2 on the charge's single melee attack (CRB p.183) and a
   * combatant fighting defensively' −4 (CRB p.185). Both are per-declaration, not per-creature
   * statistics, so they ride the call — never the compiled profile, which is shared by every
   * unit of the type and would leak the modifier into turns it does not belong to.
   */
  circumstanceMod?: number;
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

/**
 * Does the weapon bypass the defender's DR? CRB "Overcoming DR": magic by any +1, cold iron
 * and silver by +3, adamantine by +4, alignment by +5 (or by a weapon that *is* aligned —
 * `alignmentFlags` nonzero), the physical-type rows by matching damage type. §2.10 fixes:
 * compound forms (DR/magic and cold iron) now require EVERY listed quality — the old
 * first-match OR treated "magic and cold iron" as satisfied by either half alone.
 * `/epic` has no entry: there is no mythic content at either scale and the u8 flag byte is
 * full, so the form is refused rather than approximated (DEVIATIONS).
 */
export function isDrBypassed(
  enhancement: number,
  material: "cold_iron" | "silver" | "adamantine" | "none",
  damageType: "slashing" | "piercing" | "bludgeoning",
  drTypeFlags: number,
  alignmentFlags = 0,
): boolean {
  if (drTypeFlags === PF1eDrType.NONE) return false;

  const unmet: Array<() => boolean> = [];
  if ((drTypeFlags & PF1eDrType.MAGIC) !== 0) unmet.push(() => enhancement >= 1);
  if ((drTypeFlags & PF1eDrType.COLD_IRON) !== 0)
    unmet.push(() => material === "cold_iron" || enhancement >= 3);
  if ((drTypeFlags & PF1eDrType.SILVER) !== 0)
    unmet.push(() => material === "silver" || enhancement >= 3);
  if ((drTypeFlags & PF1eDrType.ADAMANTINE) !== 0)
    unmet.push(() => material === "adamantine" || enhancement >= 4);
  if ((drTypeFlags & PF1eDrType.SLASHING) !== 0) unmet.push(() => damageType === "slashing");
  if ((drTypeFlags & PF1eDrType.PIERCING) !== 0) unmet.push(() => damageType === "piercing");
  if ((drTypeFlags & PF1eDrType.BLUDGEONING) !== 0) unmet.push(() => damageType === "bludgeoning");
  if ((drTypeFlags & PF1eDrType.ALIGNMENT) !== 0)
    unmet.push(() => alignmentFlags !== 0 || enhancement >= 5);

  return unmet.every((check) => check());
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
    const atkPf = (pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined)?.[atkIdx] ?? 0;
    if ((atkStatus & ModelStatus.dead) !== 0) continue;
    if (highFidelity && (atkPf & PF1eCondition.STUNNED) !== 0) continue; // Stunned models cannot act
    if (highFidelity && (atkPf & PF1eCondition.UNCONSCIOUS) !== 0) continue; // nor can unconscious ones (§2.12)
    // §2.12 — staggered (nonlethal exactly equal to current HP): a single move OR standard
    // action per turn, read at the mass-battle grain as a one-attack routine cap.
    const staggeredCap = highFidelity && (atkPf & PF1eCondition.STAGGERED) !== 0 ? 1 : undefined;

    const profileId = pool.sys["profileIdx"]?.[atkIdx] ?? 1;
    const profile = registry.get(profileId);
    if (!profile) continue;

    let attacksTaken = 0;
    const routineCap = opts.maxIterativeAttacks !== undefined || staggeredCap !== undefined
      ? Math.min(opts.maxIterativeAttacks ?? Number.MAX_SAFE_INTEGER, staggeredCap ?? Number.MAX_SAFE_INTEGER)
      : undefined;
    for (const attackBonus of profile.iteratives) {
      if (routineCap !== undefined && attacksTaken >= routineCap) break;
      if (defIdxPtr >= defenders.length) break;
      let targetIdx = defenders[defIdxPtr] ?? 0;

      // Skip dead defenders
      while (defIdxPtr < defenders.length && ((pool.status[targetIdx] ?? 0) & ModelStatus.dead) !== 0) {
        defIdxPtr++;
        if (defIdxPtr < defenders.length) targetIdx = defenders[defIdxPtr] ?? 0;
      }
      if (defIdxPtr >= defenders.length) break;

      const defPf = (pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined)?.[targetIdx] ?? 0;

      // The defender's own profile — never the attacker's — backs up missing columns.
      const defProfile = registry.get(pool.sys["profileIdx"]?.[targetIdx] ?? 0);

      // §2.8 / §2.9 — one range rule for every weapon, not just firearms: −2 per full range
      // increment beyond the first on the attack roll, touch AC only inside the firearm's
      // class window (early: 1st increment; advanced: 5th), and no attack at all beyond the
      // weapon's maximum increments (thrown 5, projectile 10, early firearms 5, advanced 10).
      // Legality is checked BEFORE the attack is counted: a refused attack consumes neither
      // a die nor the attack slot.
      let effectiveAcType: PF1eAcType = targetAcType;
      const distance = getModelDistance(pool, atkIdx, targetIdx);
      let rangePenalty = 0;

      if (highFidelity && profile.isRanged && distance > 0) {
        const inc = profile.rangeIncrement > 0 ? profile.rangeIncrement : 1;
        const increments = Math.ceil(distance / inc);
        const maxInc = profile.maxIncrements > 0 ? profile.maxIncrements : 10;
        if (increments > maxInc) {
          // Beyond maximum range: the attack is not made (SRD: "you can't attack") — the
          // defender is spared and the pointer moves on.
          defIdxPtr++;
          continue;
        }
        if (profile.isFirearm) {
          const touchWindow = profile.isEarlyFirearm ? 1 : 5;
          if (increments <= touchWindow) effectiveAcType = "touchAc";
        }
        rangePenalty = Math.max(0, increments - 1) * 2;
      }

      metrics.totalAttacks++;
      attacksTaken++;

      // SRD (Combat Modifiers > Flanking): flanking is a +2 flanking **bonus on the attack
      // roll**, and nothing else — it does not reduce the defender's AC. Applying it to both
      // sides double-counted the bonus (Gap List §2.2).
      const isDefenderFlanked = isFlanked || (defPf & PF1eCondition.FLANKED) !== 0;
      let targetAc = resolveTargetAc(pool, defProfile, targetIdx, effectiveAcType);

      if (highFidelity) {
        // Prone AC modifier: -4 vs Melee, +4 vs Ranged
        if ((defPf & PF1eCondition.PRONE) !== 0) {
          if (isRanged) targetAc += 4;
          else targetAc = Math.max(0, targetAc - 4);
        }
        if ((defPf & PF1eCondition.BLINDED) !== 0 || (defPf & PF1eCondition.STUNNED) !== 0) {
          targetAc = Math.max(0, targetAc - 2);
        }
      }

      // §2.9b — weapon state is per-weapon column state, read once per attack: broken weapons
      // escalate misfire +4 and fight at −2/−2 (see below).
      const weaponStateCol = pool.sys["weaponState"] as unknown as Uint8Array | undefined;
      const weaponBroken = weaponStateCol ? ((weaponStateCol[atkIdx] ?? 0) & 1) !== 0 : false;

      // P09/D-219 — ammo gate (§2.9): a firearm with no loaded shot cannot attack (mirrors tactical `firearmShotAmmo`).
      if (highFidelity && profile.isFirearm) {
        const ammoCol = pool.sys["ammo"] as unknown as Uint8Array | undefined;
        const loaded = ammoCol ? (ammoCol[atkIdx] ?? 0) : 1;
        if (loaded <= 0) {
          metrics.misses++;
          continue;
        }
      }

      // Check Firearm Misfire (UC p.135 — natural 20 never misfires, §2.9b defect (f))
      const d20 = rng.d(20);
      let effectiveMisfireMin = profile.misfireMin;
      if (highFidelity && (weaponBroken || (atkPf & PF1eCondition.MISFIRED) !== 0 || (atkPf & PF1eCondition.BROKEN) !== 0)) {
        effectiveMisfireMin += 4; // Misfired/Broken gun increases misfire threshold by +4 (Gun Training +2 variant is actor data, default +4)
      }

      if (highFidelity && profile.isFirearm && d20 !== 20 && d20 <= effectiveMisfireMin && effectiveMisfireMin > 0) {
        metrics.misfiresCount++;
        metrics.misses++;
        {
          const pfCol = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
          if (pfCol) pfCol[atkIdx] = (pfCol[atkIdx] ?? 0) | PF1eCondition.MISFIRED | PF1eCondition.BROKEN;
        }
        if (weaponStateCol) weaponStateCol[atkIdx] = (weaponStateCol[atkIdx] ?? 0) | 1;
        // Consume the shot even on a misfire (tactical ammo decrement mirrors this)
        const ammoCol2 = pool.sys["ammo"] as unknown as Uint8Array | undefined;
        if (ammoCol2) ammoCol2[atkIdx] = Math.max(0, (ammoCol2[atkIdx] ?? 1) - 1);
        // P09/D-219 — second misfire of a broken early firearm explodes (UC p.135). At mass scale, the explosion is not a separate AOE — the weapon is destroyed.
        // The broken state already marks it; destruction is the same bit (weapon stays broken, no further shots until Gunsmithing).
        continue;
      }

      // Consume one shot for this firearm attack (tactical §2.9) — happens before the hit roll so empty stays empty.
      // Advanced firearms with capacity>1 keep firing until this gate above refuses.
      if (highFidelity && profile.isFirearm) {
        const ammoCol3 = pool.sys["ammo"] as unknown as Uint8Array | undefined;
        if (ammoCol3) ammoCol3[atkIdx] = Math.max(0, (ammoCol3[atkIdx] ?? 1) - 1);
      }

      // Apply Attacker Condition & Range Modifiers
      let attackMod =
        attackBonus +
        (isDefenderFlanked ? 2 : 0) +
        profile.enhancementBonus -
        rangePenalty +
        (opts.circumstanceMod ?? 0);
      if (highFidelity) {
        if ((atkPf & PF1eCondition.SHAKEN) !== 0) attackMod -= 2;
        if ((atkPf & PF1eCondition.SICKENED) !== 0) attackMod -= 2;
        if ((atkPf & PF1eCondition.PRONE) !== 0) attackMod -= 4;
        // §2.9b — a broken weapon fights at −2 attack and −2 damage (CRB: Broken condition).
        if (weaponBroken) attackMod -= 2;
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

      // §2.4 — Multiplying Damage: a critical hit multiplies only the weapon's *base* dice and
      // static bonuses (Strength, enhancement, morale, penalties); bonus dice — energy (flaming)
      // or precision (sneak attack) — are rolled exactly once (CRB: "Extra damage dice... are
      // not multiplied when you score a critical hit"). The minimum-damage rule still applies to
      // the weapon blow itself: if penalties drive it below 1 it deals 1 point of *nonlethal*
      // damage instead of lethal (SRD: "Minimum Damage"; Gap §2.3) — bonus dice are never
      // lifted by that floor.
      let baseDamage = 0;
      for (let m = 0; m < mult; m++) {
        let diceTotal = 0;
        for (let d = 0; d < profile.damageDiceCount; d++) {
          diceTotal += rng.d(profile.damageDiceSides);
        }
        let dmgMod = profile.damageMod;
        if (highFidelity && (atkPf & PF1eCondition.SICKENED) !== 0) dmgMod -= 2;
        if (highFidelity && weaponBroken) dmgMod -= 2; // §2.9b
        baseDamage += diceTotal + dmgMod;
      }
      let bonusDamage = 0;
      if (profile.bonusDamageCount > 0 && profile.bonusDamageSides > 0) {
        for (let d = 0; d < profile.bonusDamageCount; d++) {
          bonusDamage += rng.d(profile.bonusDamageSides);
        }
      }
      const nonlethalDamage = baseDamage < 1 ? 1 : 0;
      const rawDamage = baseDamage < 1 ? Math.max(0, bonusDamage) : baseDamage + bonusDamage;

      // Damage Reduction is a property of the DEFENDER. Reading it as
      // `(pool column ?? 0) || attacker profile` silently applied the attacker's own DR to
      // the blow when the defender's column was 0 (Gap List §2.10, the fallback half).
      const defDrVal = pool.sys["drVal"]?.[targetIdx] ?? 0;
      const defDrType = pool.sys["drType"]?.[targetIdx] ?? 0;
      const drVal = defDrVal > 0 ? defDrVal : (defProfile?.drVal ?? 0);
      const drTypeFlags = defDrType > 0 ? defDrType : (defProfile?.drTypeFlags ?? 0);
      // DR never applies to nonlethal damage; and at §2.10's "Overcoming DR" text it never
      // applies to the bonus dice either: energy dice are not weapon damage and precision
      // damage is named exempt. The reduction binds only the weapon blow.
      const drApplicable = baseDamage > 0 ? Math.min(baseDamage, drVal) : 0;
      let effectiveDr = drApplicable;
      let bypassedNow = false;

      if (highFidelity) {
        bypassedNow = isDrBypassed(
          profile.enhancementBonus,
          profile.material,
          profile.damageType,
          drTypeFlags,
          profile.weaponAlignmentFlags
        );
        if (bypassedNow) {
          metrics.drBypassed += effectiveDr;
          effectiveDr = 0;
        }
      }

      metrics.rawDamageDealt += rawDamage;
      if (nonlethalDamage > 0) {
        metrics.nonlethalDealt += nonlethalDamage;
        const priorNonlethal = (pool.sys["nonlethal"]?.[targetIdx] ?? 0) as number;
        const totalNonlethal = priorNonlethal + nonlethalDamage;
        if (pool.sys["nonlethal"]) pool.sys["nonlethal"][targetIdx] = totalNonlethal;
        // §2.12, the full SRD ladder (SRD: Dealing Nonlethal Damage):
        // (a) conversion — once the nonlethal tally equals MAX HP, further subdual damage is
        //     *lethal* ("all further nonlethal damage is treated as lethal"). The converted
        //     slice faces the same DR availability as the blow that dealt it: any reduction
        //     capacity the weapon damage did not consume. Converted HP loss feeds the normal
        //     death path below.
        const hpMaxDef = (pool.hpMax[targetIdx] ?? 0) as number;
        const convertible = Math.max(0, totalNonlethal - Math.max(priorNonlethal, hpMaxDef));
        if (convertible > 0 && hpMaxDef > 0) {
          const residualDr = Math.max(0, drVal - effectiveDr);
          const convertedNet = bypassedNow ? convertible : Math.max(0, convertible - residualDr);
          if (convertedNet > 0) {
            pool.hp[targetIdx] = Math.max(0, (pool.hp[targetIdx] ?? 0) - convertedNet);
          }
        }
        // (b) thresholds against CURRENT hit points: exactly equal ⇒ staggered (a single
        //     move or standard), exceeding ⇒ unconscious. HP ≤ 0 is the lethal ladder's
        //     business (disabled/dying), so nonlethal says nothing there.
        const hpAfter = (pool.hp[targetIdx] ?? 0) as number;
        if (hpAfter > 0 && totalNonlethal > hpAfter) {
          const pfCol2 = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
          if (pfCol2) {
            pfCol2[targetIdx] =
              ((pfCol2[targetIdx] ?? 0) & ~PF1eCondition.STAGGERED) | PF1eCondition.UNCONSCIOUS;
          }
        } else if (hpAfter > 0 && totalNonlethal === hpAfter) {
          const pfCol2 = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
          if (pfCol2) pfCol2[targetIdx] = (pfCol2[targetIdx] ?? 0) | PF1eCondition.STAGGERED;
        }
      }

      metrics.drAbsorbed += effectiveDr;

      const netDamage = Math.max(0, rawDamage - effectiveDr);
      metrics.netDamageDealt += netDamage;

      // Apply Damage to Model HP / Lethal Damage
      const targetProfile = defProfile;
      const isRegenMonster = targetProfile && targetProfile.regenerationVal > 0;
      const isLethalType =
        ((profile.elementalType | profile.bonusDamageTypeFlags) &
          (targetProfile?.regenerationSuppressFlags ?? 0)) !== 0;

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
            pool.status[targetIdx] = (pool.status[targetIdx] ?? 0) | ModelStatus.dead;
            {
              const pfCol3 = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
              if (pfCol3) pfCol3[targetIdx] = (pfCol3[targetIdx] ?? 0) | PF1eCondition.DEAD;
            }
            metrics.killsCount++;
            defIdxPtr++; // Permanent Death!
          }
        } else {
          // Non-suppressing damage deals NON-LETHAL damage to regenerating creature!
          const currentHp = pool.hp[targetIdx] ?? 0;
          const newHp = Math.max(0, currentHp - netDamage);
          pool.hp[targetIdx] = newHp;
          if (newHp === 0) {
            {
              const pfCol5 = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
              if (pfCol5) pfCol5[targetIdx] = (pfCol5[targetIdx] ?? 0) | PF1eCondition.DISRUPTED;
            }
          }
        }
      } else {
        // Standard Damage & Death Resolution
        const currentHp = pool.hp[targetIdx] ?? 0;
        const newHp = Math.max(0, currentHp - netDamage);
        pool.hp[targetIdx] = newHp;

        if (newHp === 0) {
          pool.status[targetIdx] = (pool.status[targetIdx] ?? 0) | ModelStatus.dead;
          {
            const pfCol4 = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
            if (pfCol4) pfCol4[targetIdx] = (pfCol4[targetIdx] ?? 0) | PF1eCondition.DEAD;
          }
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
 *
 * P7/H03 — delegates to `healing.ts`'s `applyHealing` so fast healing and
 * regeneration obey the same nonlethal-removal rule as magical healing
 * (CRB p.191: healing removes equal nonlethal, rolled amount, even at full
 * HP). Dead creatures do not heal; temporary hit points are not restored.
 * When suppression would apply (regeneration ceases after fire/acid, A.18)
 * the caller can pass a per-model suppression map — absent means not
 * suppressed. The ModelPool's `hp` and `nonlethal` columns are both updated
 * atomically; the prior implementation only touched `hp`.
 */
export function resolvePF1eHealing(
  pool: ModelPool,
  modelIndices: number[],
  registry: PF1eProfileRegistry,
  opts?: { suppressed?: ReadonlySet<number> }
): { totalHealed: number; revivedCount: number } {
  let totalHealed = 0;
  let revivedCount = 0;

  for (const idx of modelIndices) {
    const profileId = pool.sys["profileIdx"]?.[idx] ?? 1;
    const profile = registry.get(profileId);
    if (!profile) continue;

    const status = pool.status[idx] ?? 0;
    if ((status & ModelStatus.dead) !== 0) continue;
    const hp = pool.hp[idx] ?? 0;
    const maxHp = pool.hpMax[idx] ?? 20;
    const lethalDmg = pool.sys["lethalDmg"]?.[idx] ?? 0;
    const maxEffectiveHp = Math.max(0, maxHp - lethalDmg);
    const nonlethal = pool.sys["nonlethal"]?.[idx] ?? 0;
    // Constitution score for death check (A.18 dead at -Con). Fall back to not-dead if missing.
    const conScore = pool.sys["con"]?.[idx];

    const healOnce = (amount: number, suppressed = false): void => {
      if (suppressed) return;
      if (amount <= 0) return;
      // Dead check via Con: negative HP reaching Con kills, handled in healing.ts
      const inputHp = pool.hp[idx] ?? hp;
      const inputNonlethal = pool.sys["nonlethal"]?.[idx] ?? nonlethal;
      const res = applyHealing({
        hp: inputHp,
        hpMax: maxEffectiveHp,
        nonlethalDamage: inputNonlethal,
        amount,
      });
      if ((res as { ok?: false }).ok === false) return;
      const r = res as unknown as { hp: number; nonlethalDamage: number; healedHp: number };
      const beforeHp = pool.hp[idx] ?? inputHp;
      pool.hp[idx] = r.hp;
      if (pool.sys["nonlethal"]) pool.sys["nonlethal"][idx] = r.nonlethalDamage;
      totalHealed += r.healedHp;
      if (beforeHp === 0 && (r.hp ?? 0) > 0) {
        {
          const pfCol6 = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
          if (pfCol6) pfCol6[idx] = (pfCol6[idx] ?? 0) & ~PF1eCondition.DISRUPTED;
        }
        revivedCount++;
      }
    };

    // Fast Healing: applies only to living models
    if (profile.fastHealingVal > 0) {
      const wasDead = ((): boolean => {
        if (hp >= 0) return false;
        if (conScore === undefined) return false;
        return -hp >= (conScore as number);
      })();
      if (!wasDead) healOnce(profile.fastHealingVal);
    }

    // Regeneration: heals each round at turn start, unless suppressed (fire/acid last round, A.18)
    if (profile.regenerationVal > 0) {
      const suppressed = opts?.suppressed?.has(idx) ?? false;
      const wasDead = ((): boolean => {
        const curHp = pool.hp[idx] ?? hp;
        if (curHp >= 0) return false;
        if (conScore === undefined) return false;
        return -curHp >= (conScore as number);
      })();
      if (!wasDead) healOnce(profile.regenerationVal, suppressed);
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
        pool.status[dIdx] = (pool.status[dIdx] ?? 0) | ModelStatus.dead;
          {
            const pfColTr = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
            if (pfColTr) pfColTr[dIdx] = (pfColTr[dIdx] ?? 0) | PF1eCondition.DEAD;
          }
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
      const pfColM = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
      if (pfColM) pfColM[defenderIdx] = (pfColM[defenderIdx] ?? 0) | cond;
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
