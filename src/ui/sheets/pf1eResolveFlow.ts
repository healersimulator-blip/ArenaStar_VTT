/**
 * PF1e attack-resolution flow (P3/A06, second slice) — the UI-side orchestration
 * that turns one sheet attack line and one target actor into public chat rolls,
 * a resolution card and authoritative HP writes. The rules live in
 * `src/packages/pf1e/resolve.ts` (pure); this module only orchestrates the wire:
 *
 * 1. the attack roll rides the existing §11 machinery (`client.roll`, or
 *    `client.rollVerified` when the user opted into commit-reveal) and the
 *    natural d20 face is read back from the replicated roll message's terms
 *    (the host is the only dice authority);
 * 2. a threat rolls the confirmation ("another attack roll with all the same
 *    modifiers", CRB p.182) at the effective bonus `pf1eResolvePrepare` computed;
 * 3. a hit rolls the damage formula (the crit formula's N-group total on a
 *    confirmed crit, D-139);
 * 4. `pf1eResolveAttack` composes the authoritative result from those faces;
 * 5. the resolution card posts through the ordinary `messages` create op, and
 *    the HP writes go through `pf1eSheetEdit` ("hp" / "nonlethalDamage") so
 *    ownership and validation are the sheet's own path — a resolver without
 *    permission narrates but cannot write.
 *
 * Every dice result the card claims comes from a host-evaluated public roll
 * message; nothing is rolled or evaluated client-side.
 */
import type { Op } from "../../core/ops";
import type { PermissionUser } from "../../core/ownership";
import type { ActorDocument, MessageDocument } from "../../core/documents";
import type { PF1eDerived, PF1eDerivedAttack } from "../../packages/pf1e/actor";
import { confirmCritical, shootingIntoMeleePenalty } from "../../packages/pf1e/tactical";
import {
  FIREARM_EXPLOSION_DC,
  FIREARM_RELOAD_ACTION_ID,
  firearmExplosionMitigatedDamage,
  firearmExplosionReflexOutcome,
  firearmShotAmmo,
  type PF1eMisfireFacts,
} from "../../packages/pf1e/firearms";
import { pf1eActionOpportunities } from "../../packages/pf1e/actionOpportunity";
import type { PF1eMountMovement } from "../../packages/pf1e/mounted";
import {
  lanceChargeMultiplier,
  mountedRangedPenalty,
  mountLinkageOf,
} from "../../packages/pf1e/mounted";
import type { PF1eSituationalModifiers } from "../../packages/pf1e/tactical";
import type {
  PF1eDefenseChoice,
  PF1ePositionalDefense,
  PF1eResolveDefender,
  PF1eResolveResult,
} from "../../packages/pf1e/resolve";
import { can } from "../../core/permissions";
import {
  pf1eResolveAttack,
  pf1eResolveManyshot,
  pf1eResolvePrepare,
} from "../../packages/pf1e/resolve";
import { fmtSigned } from "../../packages/pf1e/rollData";
import { featAttackParts, featDamageParts, hasPF1eFeat } from "../../packages/pf1e/feats";
import { buildRollLedger } from "../../packages/pf1e/rollLedger";
import { pf1eSheetEdit } from "./pf1eSheetModel";
import { verifyCommitRoll } from "../../dice/commitReveal";

/** The structural slice of ClientSync the flow needs (tests fake exactly this). */
export interface ResolveFlowClient {
  roll(formula: string, mode?: "roll", to?: string[], flavor?: string): string;
  rollVerified(
    formula: string,
    mode?: "roll",
    to?: string[],
    flavor?: string,
  ): Promise<string>;
  readonly store: { getAll(coll: "messages"): readonly unknown[] };
  submit(ops: Op[]): string;
}

export interface ResolveAttackFlowParams {
  attackerName: string;
  /** The derived attack line being resolved (`PF1eDerived.attacks[i]`). */
  line: PF1eDerivedAttack;
  /** Which iterative (0 = the standard attack). */
  iterative: number;
  /** The roll formulas from the A06a roll group — the host evaluates these. */
  attackFormula: string;
  damageFormula: string;
  critDamageFormula: string | null;
  targetName: string;
  targetActor: ActorDocument;
  targetDerived: PF1eDerived;
  defense: PF1eDefenseChoice;
  situational?: PF1eSituationalModifiers;
  nonlethalDamage?: boolean;
  unarmed?: boolean;
  feats?: readonly string[];
  provokes?: boolean;
  /**
   * P04 — the defender's positional defenses (cover AC fold, concealment miss
   * chance), read off the scene by `pf1eResolvePositionReport`. A live miss
   * chance on a hit rolls its own public d% before the damage formula.
   */
  positional?: PF1ePositionalDefense;
  /**
   * P09/D-202 — per-shot misfire facts the line cannot carry (the loader's
   * nonproficiency, the Expert Loading deed). The line's own `misfire` block
   * and the Gun Training feat are read automatically.
   */
  misfireExtras?:
    | Pick<PF1eMisfireFacts, "nonproficientLoader" | "expertLoading">
    | undefined;
  /** Commit-reveal rolls + a verification chip (the plan's Verify chip). */
  verifiable?: boolean;
  /** A07 — attacker BAB and stance toggles (feat-gated; no silent activation). */
  attackerBab?: number | undefined;
  powerAttack?: boolean | undefined;
  deadlyAim?: boolean | undefined;
  combatExpertise?: boolean | undefined;
  fightingDefensively?: boolean | undefined;
  pointBlankShot?: boolean | undefined;
  distanceFt?: number | undefined;
  /** P04/C01 — shooting-into-melee geometry (ranged only, AoN 131). */
  targetEngaged?: boolean | undefined;
  nearestFriendlyDistanceFt?: number | null | undefined;
  engagedSizeCategoriesLarger?: number | undefined;
  /** P08/D-201 — how the mount moved this round (stationary/single/double/run). */
  mountMovement?: PF1eMountMovement | undefined;
  /** P08/D-201 — how far the mount moved in feet; >5 ft bars a melee full-attack (A.11). */
  mountMovedFt?: number | undefined;
  /** P09/D-202 — loaded shots for the firearm gate (0 ⇒ refusal). */
  shotsAvailable?: number | undefined;
  /** P09/D-202 — attacker for the broken-write when a misfire breaks the weapon. */
  attackerActor?: ActorDocument | undefined;
  attackerAttackIndex?: number | undefined;
}

/** The defender for `pf1eResolveAttack`, straight off the target's derivation. */
export function resolveDefenderFromDerived(
  name: string,
  derived: PF1eDerived,
): PF1eResolveDefender {
  const energyResistance = Object.fromEntries(
    Object.entries(derived.energyResistance).filter(([, v]) => v > 0),
  );
  return {
    name,
    ac: derived.ac,
    hp: derived.hp,
    hpMax: derived.hpMax,
    nonlethalDamage: derived.nonlethalDamage,
    conScore: derived.abilities.con,
    regeneration: derived.regeneration,
    // P7/H02 — temporary HP stacks by source (Paizo FAQ).
    tempHp: derived.tempHp,
    tempHpSources: derived.tempHpSources,
    ...(derived.dr > 0
      ? { dr: [{ value: derived.dr, bypass: derived.drBypass }] }
      : {}),
    ...(Object.keys(energyResistance).length > 0 ? { energyResistance } : {}),
  };
}

/** Wait for the host-evaluated roll message carrying our rollId to replicate. */
export async function awaitRollMessage(
  client: { readonly store: { getAll(coll: "messages"): readonly unknown[] } },
  rollId: string,
  timeoutMs = 10_000,
): Promise<MessageDocument | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const message of client.store.getAll("messages")) {
      const candidate = message as MessageDocument;
      const flags = candidate.flags as
        { core?: { rollId?: unknown } } | undefined;
      if (flags?.core?.rollId === rollId && candidate.roll) return candidate;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The natural d20 face of a roll message — the first dice term's first kept value. */
export function dieFaceOf(message: MessageDocument): number | null {
  const terms = message.roll?.terms;
  if (!Array.isArray(terms)) return null;
  for (const term of terms) {
    if (term === null || typeof term !== "object") continue;
    const dice = term as { kind?: unknown; kept?: unknown };
    if (dice.kind !== "dice" || !Array.isArray(dice.kept)) continue;
    const face = (dice.kept as unknown[])[0];
    if (typeof face === "number" && Number.isInteger(face)) return face;
  }
  return null;
}

/** One chat card sentence per resolution; chips render as `[[text|title]]`. */
export function resolutionCardContent(
  ctx: {
    attackerName: string;
    targetName: string;
    label: string;
    attackFormula: string;
    damageFormula: string;
    defense: string;
  },
  result: PF1eResolveResult,
  hpWriteError: string | null,
  verified: boolean | null,
): { name: string; content: string } {
  if (!result.ok) return { name: "resolution error", content: result.error };
  const verdict =
    result.outcome === "miss"
      ? "misses."
      : result.outcome === "crit"
        ? "CRITS!"
        : "hits.";
  const lines: string[] = [
    `${ctx.attackerName}: ${ctx.label} vs ${ctx.targetName} (${ctx.defense} AC ${String(result.defenseAc)}) — [[${String(result.attackTotal)}|${ctx.attackFormula}]] ${verdict}`,
  ];
  if (result.damage && result.outcome !== "miss") {
    const parts: string[] = [
      `[[${String(result.damage.dealt)}|${ctx.damageFormula}]] damage dealt`,
    ];
    if (result.damage.drApplied > 0) {
      parts.push(`DR absorbed ${String(result.damage.drApplied)}`);
    }
    if (result.damage.drBypassedVia !== null) {
      parts.push(`DR bypassed (${result.damage.drBypassedVia})`);
    }
    if (result.damage.minimumApplied) {
      parts.push("minimum-damage rule: 1 nonlethal");
    }
    if (result.damage.convertedToLethal > 0) {
      parts.push(
        `${String(result.damage.convertedToLethal)} nonlethal converted to lethal at the max-HP boundary`,
      );
    }
    if ((result.damage.tempHpAbsorbed ?? 0) > 0) {
      parts.push(`temp HP absorbed ${String(result.damage.tempHpAbsorbed)}`);
    }
    lines.push(parts.join("; ") + ".");
  }
  const hpBits: string[] = [];
  if (result.hp.after !== result.hp.before) {
    hpBits.push(
      `${ctx.targetName} ${String(result.hp.before)} → ${String(result.hp.after)} HP`,
    );
  }
  if (result.nonlethal.after !== result.nonlethal.before) {
    hpBits.push(
      `nonlethal ${String(result.nonlethal.before)} → ${String(result.nonlethal.after)}`,
    );
  }
  if (result.tempHp.after !== result.tempHp.before) {
    hpBits.push(
      `temp HP ${String(result.tempHp.before)} → ${String(result.tempHp.after)}`,
    );
  }
  if (hpBits.length > 0) lines.push(hpBits.join(", ") + ".");
  for (const note of result.conditionNotes)
    lines.push(`${ctx.targetName} is ${note}.`);
  if (hpWriteError !== null) lines.push(`⚠ HP write rejected: ${hpWriteError}`);
  if (verified === true) {
    lines.push(
      "[[✓ verified|commit-reveal verified — the totals re-derive from the revealed seeds]]",
    );
  } else if (verified === false) {
    lines.push(
      "⚠ commit-reveal verification FAILED — the roll record does not re-derive",
    );
  }
  if (result.notes.length > 0) lines.push(result.notes.join(" "));
  return {
    name: `${ctx.attackerName} vs ${ctx.targetName}`.slice(0, 40),
    content: lines.join("\n"),
  };
}

/**
 * P09/D-202 — the misfire facts for one shot, or null when the line is not a
 * firearm line (or never misfires). The line carries generation/minimum/
 * broken/magical; Gun Training is read off the caller's feat list; the
 * loader's nonproficiency and the Expert Loading deed are per-shot caller
 * facts (`misfireExtras`).
 */
function misfireFactsOf(
  params: ResolveAttackFlowParams,
): PF1eMisfireFacts | null {
  const line = params.line.misfire;
  if (line === undefined) return null;
  return {
    generation: line.generation,
    misfireMinimum: line.misfireMinimum,
    broken: line.broken,
    magical: line.magical,
    gunTraining:
      params.feats?.some((f) => /gun training/i.test(f)) ?? false,
    ...(params.misfireExtras?.nonproficientLoader === true
      ? { nonproficientLoader: true }
      : {}),
    ...(params.misfireExtras?.expertLoading === true
      ? { expertLoading: true }
      : {}),
  };
}

function isLanceWeaponName(name: string): boolean {
  return /lance/i.test(name);
}

function mountedLanceMultiplier(params: ResolveAttackFlowParams): number | null {
  if (params.situational?.charging !== true) return null;
  if (!isLanceWeaponName(params.line.name)) return null;
  if (params.line.ranged === true) return null;
  const mounted =
    params.attackerActor !== undefined &&
    mountLinkageOf(
      (params.attackerActor.system as { pf1e?: { mount?: unknown } })?.pf1e?.mount,
    ) !== null &&
    mountLinkageOf(
      (params.attackerActor.system as { pf1e?: { mount?: unknown } })?.pf1e?.mount,
    )?.actorId !== null;
  if (!mounted) return null;
  const spirited = hasPF1eFeat(params.feats ?? [], "Spirited Charge");
  return lanceChargeMultiplier({ spiritedCharge: spirited });
}

/**
 * Run the full resolution: attack roll → (threat: confirmation) → (hit:
 * damage) → resolution card → HP writes. Every die is a public host-evaluated
 * roll; the card and the HP writes are ordinary replicated ops.
 */
export async function resolveAttackFlow(
  client: ResolveFlowClient,
  user: PermissionUser | null,
  params: ResolveAttackFlowParams,
): Promise<
  | { ok: true; result: PF1eResolveResult; hpWriteError: string | null }
  | { ok: false; error: string }
> {
  const line = params.line;
  const baseBonus = line.attackBonuses[params.iterative] ?? line.attackBonus;
  const featAttackDeltaParts = featAttackParts({
    feats: params.feats,
    bab: params.attackerBab ?? 0,
    ranged: line.ranged === true,
    weaponName: line.name,
    powerAttack: params.powerAttack,
    deadlyAim: params.deadlyAim,
    combatExpertise: params.combatExpertise,
    fightingDefensively: params.fightingDefensively,
    pointBlankShot: params.pointBlankShot,
    distanceFt: params.distanceFt,
  });
  const featAttackDelta = featAttackDeltaParts.reduce((sum, part) => sum + part.value, 0);
  const engagementPenalty = line.ranged && params.targetEngaged === true ? shootingIntoMeleePenalty({
    sizeCategoriesLarger: params.engagedSizeCategoriesLarger ?? 0,
    preciseShot: hasPF1eFeat(params.feats ?? [], "Precise Shot"),
    targetEngaged: true,
    nearestFriendlyDistanceFt: params.nearestFriendlyDistanceFt ?? undefined,
  }) : 0;
  const mountPenaltyPart = line.ranged === true && params.mountMovement !== undefined ? mountedRangedPenalty(params.mountMovement) : null;
  const mountPenalty = mountPenaltyPart?.value ?? 0;
  const bonus = baseBonus + featAttackDelta + engagementPenalty + mountPenalty;
  const featDamageDeltaParts = featDamageParts({
    feats: params.feats,
    bab: params.attackerBab ?? 0,
    ranged: line.ranged === true,
    weaponName: line.name,
    powerAttack: params.powerAttack,
    deadlyAim: params.deadlyAim,
    pointBlankShot: params.pointBlankShot,
    distanceFt: params.distanceFt,
  });
  const featDamageDelta = featDamageDeltaParts.reduce((sum, part) => sum + part.value, 0);
  const effectiveAttackFormula =
    featAttackDelta !== 0 || engagementPenalty !== 0 || mountPenalty !== 0
      ? `1d20 ${bonus >= 0 ? "+ " + bonus : "- " + Math.abs(bonus)}`
      : params.attackFormula;
  const misfireFacts = misfireFactsOf(params);
  const prepareInput = {
    attack: {
      label: line.name,
      bonus,
      critThreatMin: line.critThreatMin,
      critMultiplier: line.critMultiplier,
      ...(line.touchAttack ? { touchAttack: true } : {}),
      ...(line.ranged ? { ranged: true } : {}),
      damageType: line.damageType,
    },
    defense: params.defense,
    defender: resolveDefenderFromDerived(
      params.targetName,
      params.targetDerived,
    ),
    ...(params.situational ? { situational: params.situational } : {}),
    ...(params.nonlethalDamage !== undefined
      ? { nonlethalDamage: params.nonlethalDamage }
      : {}),
    ...(params.unarmed ? { unarmed: true } : {}),
    ...(params.feats ? { feats: params.feats } : {}),
    ...(params.provokes ? { provokes: true } : {}),
    ...(params.positional ? { positional: params.positional } : {}),
    ...(misfireFacts !== null ? { misfire: misfireFacts } : {}),
  };

  const rollOne = async (
    formula: string,
    flavor: string,
  ): Promise<
    { ok: true; message: MessageDocument } | { ok: false; error: string }
  > => {
    const rollId = params.verifiable
      ? await client.rollVerified(formula, "roll", undefined, flavor)
      : client.roll(formula, "roll", undefined, flavor);
    const message = await awaitRollMessage(client, rollId);
    if (message === null) {
      return { ok: false, error: `roll result never arrived: ${formula}` };
    }
    return { ok: true, message };
  };

  const verify = async (message: MessageDocument): Promise<boolean | null> => {
    if (!params.verifiable || message.roll === null) return null;
    if (message.roll.commit === undefined || message.roll.commit === null) {
      return null; // crypto was unavailable — the roll silently fell back
    }
    const check = await verifyCommitRoll(message.roll);
    return check.ok;
  };

  // 0. P04 — total cover refuses before any die is rolled: "You can't make
  // an attack against a target that has total cover" (AoN 181). The resolver
  // reaches the same refusal; this guard keeps the public dice honest.
  if (params.positional?.cover === "total") {
    return {
      ok: false,
      error:
        "the target has total cover — no attack can be made (AoN 181, CRB p.195)",
    };
  }

  // 0b. P09 — ammo gate (§2.9): a firearm without a loaded shot cannot be attacked with.
  if (line.misfire !== undefined) {
    const shots = params.shotsAvailable !== undefined ? params.shotsAvailable : line.ammo?.loaded;
    if (shots !== undefined) {
      const ammo = firearmShotAmmo({ shotsAvailable: shots });
      if (!ammo.canShoot) {
        return { ok: false, error: ammo.refusal ?? "the firearm has no shot loaded (§2.9)" };
      }
    }
  }

  // 0c. P08 — mounted melee full-attack bar (A.11): mount >5 ft ⇒ only one melee attack (no full attack).
  if (line.ranged !== true && params.mountMovedFt !== undefined && params.mountMovedFt > 5 && params.iterative !== 0) {
    return {
      ok: false,
      error: "the mount moved more than 5 ft — only one melee attack at the end of the move, no full attack (A.11)",
    };
  }

  // 1. The attack roll (A07 feat stances fold into the bonus via featAttackParts).
  const attackRoll = await rollOne(
    effectiveAttackFormula,
    `${line.name} ${fmtSigned(bonus)}`,
  );
  if (!attackRoll.ok) return attackRoll;
  const die = dieFaceOf(attackRoll.message);
  if (die === null) {
    return { ok: false, error: "could not read the attack roll's d20 face" };
  }

  const prepared = pf1eResolvePrepare({ ...prepareInput, die });
  if (!prepared.ok) return { ok: false, error: prepared.error };

  // 2. A threat rolls the confirmation at the effective bonus (CRB p.182).
  let confirmDie: number | undefined;
  let confirmedCrit = false;
  if (prepared.roll.ok && prepared.roll.hits && prepared.roll.threat) {
    const confirmFormula = `1d20 ${prepared.attackBonus >= 0 ? `+ ${prepared.attackBonus}` : `- ${Math.abs(prepared.attackBonus)}`}`;
    const confirmRoll = await rollOne(
      confirmFormula,
      `${line.name} critical confirmation`,
    );
    if (!confirmRoll.ok) return confirmRoll;
    const face = dieFaceOf(confirmRoll.message);
    if (face === null) {
      return {
        ok: false,
        error: "could not read the confirmation roll's d20 face",
      };
    }
    confirmDie = face;
    // Which damage formula to roll depends on the confirmation outcome — the
    // same exported A03 call `pf1eResolveAttack` runs internally on the same
    // numbers, so the choice cannot diverge from the authoritative result.
    const confirmation = confirmCritical({
      die: face,
      attackBonus: prepared.attackBonus,
      ac: prepared.defenseAc,
    });
    if (!confirmation.ok) return { ok: false, error: confirmation.error };
    confirmedCrit = confirmation.confirmed;
  }

  // 2b. P04 — concealment (AoN 182): a live miss chance on a hit rolls its
  // own public d% before any damage is rolled; `pf1eResolveAttack` folds the
  // face into the outcome (≤ the miss chance is a miss, damage zeroed).
  let concealmentDie: number | undefined;
  if (
    prepared.roll.ok &&
    prepared.roll.hits &&
    prepared.needsConcealmentRoll !== null
  ) {
    const percent = prepared.needsConcealmentRoll.percent;
    const concealmentRoll = await rollOne(
      "1d100",
      `${line.name} concealment miss chance ${String(percent)}%`,
    );
    if (!concealmentRoll.ok) return concealmentRoll;
    const face = dieFaceOf(concealmentRoll.message);
    if (face === null) {
      return { ok: false, error: "could not read the concealment roll's d% face" };
    }
    concealmentDie = face;
  }

  // P08 — lance charge multiplier (A.11, CRB p.136): a lance while mounted and charging
  // deals ×2, ×3 with Spirited Charge. Combined with a critical, CRB p.179 is
  // additive (×2 + ×2 ⇒ ×3, ×3 + ×2 ⇒ ×4, ×3 + ×3 ⇒ ×5).
  const lanceMult = mountedLanceMultiplier(params);
  // 3. A hit rolls damage (the crit formula on a confirmed threat, D-139, plus
  // the lance multiplier when applicable; additive per CRB p.179 — all
  // modifiers multiply with each dice group).
  let damageTotal = 0;
  let damageFormula = params.damageFormula;
  let combinedMult = 1;
  if (prepared.roll.ok && prepared.roll.hits) {
    combinedMult =
      1 +
      (confirmedCrit ? (line.critMultiplier ?? 2) - 1 : 0) +
      (lanceMult !== null ? lanceMult - 1 : 0);
    if (combinedMult > 1) {
      const baseGroup = params.damageFormula.trim();
      if (baseGroup !== "" && baseGroup !== "0") {
        damageFormula = Array.from({ length: combinedMult }, () => baseGroup).join(" + ");
      } else {
        damageFormula =
          confirmedCrit && params.critDamageFormula !== null
            ? params.critDamageFormula
            : params.damageFormula;
      }
    } else {
      damageFormula = params.damageFormula;
    }
    const damageRoll = await rollOne(
      damageFormula,
      `${line.name} ${confirmedCrit && lanceMult !== null ? "critical lance charge damage" : confirmedCrit ? "critical damage" : lanceMult !== null ? "lance charge damage" : "damage"}${combinedMult > 1 ? ` ×${combinedMult}` : ""}`,
    );
    if (!damageRoll.ok) return damageRoll;
    if (
      damageRoll.message.roll === null ||
      typeof damageRoll.message.roll.total !== "number"
    ) {
      return { ok: false, error: "the damage roll message carries no total" };
    }
    damageTotal = damageRoll.message.roll.total;
    if (featDamageDelta !== 0) {
      damageTotal += featDamageDelta * combinedMult;
    }
  }

  // 4. The authoritative composition.
  let result = pf1eResolveAttack({
    ...prepareInput,
    die,
    ...(confirmDie !== undefined ? { confirmDie } : {}),
    ...(concealmentDie !== undefined ? { concealmentDie } : {}),
    damageTotal,
  });
  // Surface A07 feat labels, the AoN 131 shooting-into-melee ladder, and P08 mounted ranged penalty.
  let lanceNote: string | null = null;
  if (lanceMult !== null) {
    lanceNote = `lance charge ×${lanceMult}${hasPF1eFeat(params.feats ?? [], "Spirited Charge") ? " (Spirited Charge, A.11/CRB p.136)" : " (A.11)"}${combinedMult > lanceMult ? `, combined with critical ×${line.critMultiplier} ⇒ ×${combinedMult} (additive, CRB p.179)` : ""}`;
  }
  if (result.ok && (featAttackDeltaParts.length > 0 || featDamageDeltaParts.length > 0 || engagementPenalty !== 0 || mountPenalty !== 0 || lanceNote !== null)) {
    const featNotes = [
      ...featAttackDeltaParts.map((p) => `${p.label} ${fmtSigned(p.value)}`),
      ...featDamageDeltaParts.map((p) => `${p.label} ${fmtSigned(p.value)}`),
      ...(engagementPenalty !== 0 ? [`shooting into melee ${fmtSigned(engagementPenalty)}`] : []),
      ...(mountPenaltyPart !== null ? [`${mountPenaltyPart.label} ${fmtSigned(mountPenaltyPart.value)}`] : []),
      ...(lanceNote !== null ? [lanceNote] : []),
    ];
    if (featNotes.length > 0) {
      const withNotes: typeof result = {
        ...result,
        notes: [...result.notes, `feats: ${featNotes.join(", ")}`],
      };
      result = withNotes;
    }
  } else if (result.ok && engagementPenalty === 0 && line.ranged && params.targetEngaged === true) {
    // Engaged but the size/distance ladder removed the penalty — name it so the GM sees it was considered.
    const withNotes: typeof result = {
      ...result,
      notes: [...result.notes, `shooting into melee: no penalty (size/distance/Precise Shot)`],
    };
    result = withNotes;
  } else if (result.ok && lanceNote !== null) {
    const withNotes: typeof result = {
      ...result,
      notes: [...result.notes, lanceNote],
    };
    result = withNotes;
  }
  if (!result.ok) return { ok: false, error: result.error };

  // 5. HP writes through the sheet's own validated, permission-checked path.
  const ops: Op[] = [];
  let hpWriteError: string | null = null;
  if (result.hp.after !== result.hp.before) {
    const edit = pf1eSheetEdit(
      params.targetActor,
      user,
      "hp",
      String(result.hp.after),
    );
    if (edit.error !== null) hpWriteError = edit.error;
    else ops.push(...edit.ops);
  }
  if (result.nonlethal.after !== result.nonlethal.before) {
    const edit = pf1eSheetEdit(
      params.targetActor,
      user,
      "nonlethalDamage",
      String(result.nonlethal.after),
    );
    if (edit.error !== null && hpWriteError === null) hpWriteError = edit.error;
    else if (edit.error === null) ops.push(...edit.ops);
  }
  // P7/H02 — temporary HP is a separate map, not a scalar sheet field.
  if (result.tempHp.after !== result.tempHp.before) {
    if (!user || !can(user, "update", params.targetActor, "actors")) {
      if (hpWriteError === null) hpWriteError = "You do not own this PF1e actor.";
    } else {
      const afterSources = result.tempHp.afterSources;
      const diff: Record<string, import("../../core/documents").Json> = {};
      if (Object.keys(afterSources).length === 0) {
        diff["-=system.pf1e.tempHpSources"] = null;
        diff["-=system.pf1e.tempHp"] = null;
      } else {
        diff["system.pf1e.tempHpSources"] = afterSources as unknown as import("../../core/documents").Json;
        diff["-=system.pf1e.tempHp"] = null;
      }
      ops.push({ kind: "update", ref: { coll: "actors", id: params.targetActor._id }, diff });
    }
  }

  // 5b. P09/D-202 — a misfire that breaks the weapon persists the broken condition on the attacker.
  // The resolver already returned the verdict (first misfire → broken; second early → explosion);
  // this is the authoring write so the next shot sees the escalated value.
  // P09/D-218 — also consume one shot of ammo and, when Expert Loading averted an explosion, spend 1 grit.
  // Loading a firearm provokes via `load-firearm` (PF1E_ACTIONS provokes yes) — `firearmReloadOpportunity` exposes that seam for the reload button.
  if (result.ok && result.misfire !== undefined && result.misfire.misfire) {
    const verdict = result.misfire as { breaksWeapon?: boolean; explodes?: boolean; weaponDestroyed?: boolean; notes?: readonly string[] };
    const needsBroken = verdict.breaksWeapon === true || verdict.explodes === true || verdict.weaponDestroyed === true;
    if (needsBroken && params.attackerActor !== undefined && params.attackerAttackIndex !== undefined) {
      if (!user || !can(user, "update", params.attackerActor, "actors")) {
        if (hpWriteError === null) hpWriteError = "You do not own the attacker — the broken condition was not persisted.";
      } else {
        const idx = params.attackerAttackIndex;
        // Only write when the line is not already broken (idempotent guard).
        const alreadyBroken = params.attackerActor.system !== undefined && typeof (params.attackerActor.system as Record<string, unknown>).pf1e === "object"
          ? Array.isArray(((params.attackerActor.system as Record<string, unknown>).pf1e as Record<string, unknown>).attacks)
            ? (((params.attackerActor.system as Record<string, unknown>).pf1e as Record<string, unknown>).attacks as unknown[])[idx] !== undefined
              && typeof ((((params.attackerActor.system as Record<string, unknown>).pf1e as Record<string, unknown>).attacks as unknown[])[idx] as Record<string, unknown>).broken === "boolean"
              ? ((((params.attackerActor.system as Record<string, unknown>).pf1e as Record<string, unknown>).attacks as unknown[])[idx] as Record<string, unknown>).broken === true
              : false
            : false
          : false;
        if (!alreadyBroken) {
          const diff: Record<string, import("../../core/documents").Json> = {};
          diff[`system.pf1e.attacks.${idx}.broken`] = true as unknown as import("../../core/documents").Json;
          ops.push({ kind: "update", ref: { coll: "actors", id: params.attackerActor._id }, diff });
        }
      }
    }
    // P09/D-218 — when Expert Loading averted the explosion, spend 1 grit (UC p.135: Expert Loading costs 1 grit).
    const expertAverted = (verdict.notes ?? []).some((n) => /Expert Loading/.test(n));
    if (expertAverted && params.attackerActor !== undefined) {
      const gritRaw = (params.attackerActor.system as { pf1e?: { grit?: { current?: unknown } } })?.pf1e?.grit?.current;
      const gritCurrent = typeof gritRaw === "number" && Number.isFinite(gritRaw) ? Math.trunc(gritRaw) : 0;
      if (gritCurrent > 0) {
        if (!user || !can(user, "update", params.attackerActor, "actors")) {
          if (hpWriteError === null) hpWriteError = "You do not own the attacker — the grit cost for Expert Loading was not persisted.";
        } else {
          ops.push({ kind: "update", ref: { coll: "actors", id: params.attackerActor._id }, diff: { "system.pf1e.grit.current": (gritCurrent - 1) as unknown as import("../../core/documents").Json } });
        }
      } else if (hpWriteError === null) {
        hpWriteError = "Expert Loading requires 1 grit — the explosion was averted but the grit ledger could not be spent.";
      }
    }
  }
  // P09/D-218 — consume one shot of ammo whether the shot hit, missed, or misfired (§2.9). Idempotent guard uses the authoritative `shotsAvailable` when present, else the derived `line.ammo`.
  if (result.ok && line.misfire !== undefined && params.attackerActor !== undefined && params.attackerAttackIndex !== undefined) {
    const shots = params.shotsAvailable !== undefined ? params.shotsAvailable : line.ammo?.loaded;
    if (shots !== undefined && shots > 0) {
      if (!user || !can(user, "update", params.attackerActor, "actors")) {
        if (hpWriteError === null) hpWriteError = "You do not own the attacker — the ammo count was not decremented.";
      } else {
        const idx = params.attackerAttackIndex;
        const remaining = Math.max(0, shots - 1);
        ops.push({ kind: "update", ref: { coll: "actors", id: params.attackerActor._id }, diff: { [`system.pf1e.attacks.${idx}.firearm.loaded`]: remaining as unknown as import("../../core/documents").Json } });
      }
    }
  }

  // 6. The resolution card (public narrative; names a rejected write honestly).
  const card = resolutionCardContent(
    {
      attackerName: params.attackerName,
      targetName: params.targetName,
      label: line.name,
      attackFormula: effectiveAttackFormula,
      damageFormula,
      defense:
        result.defenseUsed !== params.defense
          ? `${result.defenseUsed} (forced)`
          : params.defense,
    },
    result,
    hpWriteError,
    await verify(attackRoll.message),
  );
  // F01 — build ledger for this tactical roll (non-strategic only).
  // We always attach a shell so the card shows who→what→whom + roll chips;
  // strategic games never use this flow.
  let rollLedger: ReturnType<typeof buildRollLedger> | null = null;
  try {
    const combats = (client.store as unknown as { getAll?: (c: string) => readonly unknown[] })?.getAll?.("combats") as readonly unknown[] | undefined;
    const roundRaw = (combats?.[0] as { system?: { round?: unknown } } | undefined)?.system?.round;
    const turnNumber = typeof roundRaw === "number" && Number.isFinite(roundRaw) ? roundRaw : 0;
    const initiator: import("../../packages/pf1e/rollLedger").RollLedgerInitiator = {
      actorId: (params.attackerActor?._id ?? params.attackerName) as string,
      tokenId: null,
      name: params.attackerName,
    };
    const targets: import("../../packages/pf1e/rollLedger").RollLedgerTarget[] = [{ actorId: params.targetActor._id as string, tokenId: null, name: params.targetName }];
    const rolls: import("../../packages/pf1e/rollLedger").RollLedgerRoll[] = [
      {
        kind: "attack" as const,
        formula: effectiveAttackFormula,
        total: result.attackTotal,
        terms: (attackRoll.message.roll?.terms as unknown as import("../../core/documents").Json[]) ?? [],
        modifiers: [
          ...featAttackDeltaParts.map((pa) => ({ label: pa.label, value: pa.value, reason: pa.label })),
          ...(engagementPenalty !== 0 ? [{ label: "shooting into melee", value: engagementPenalty, reason: "shooting into melee" }] : []),
          ...(mountPenaltyPart !== null ? [{ label: mountPenaltyPart.label, value: mountPenaltyPart.value, reason: mountPenaltyPart.label }] : []),
        ],
        seedClient: (attackRoll.message.roll?.seedClient as string | null) ?? null,
        seedHost: (attackRoll.message.roll?.seedHost as string | null) ?? null,
      } as unknown as import("../../packages/pf1e/rollLedger").RollLedgerRoll,
      ...(damageTotal !== 0 || result.damage !== undefined
        ? [
            {
              kind: "damage" as const,
              formula: damageFormula,
              total: damageTotal,
              terms: [] as unknown as import("../../core/documents").Json[],
              modifiers: featDamageDeltaParts.map((pa) => ({ label: pa.label, value: pa.value, reason: pa.label })),
              seedClient: null as string | null,
              seedHost: null as string | null,
            } as unknown as import("../../packages/pf1e/rollLedger").RollLedgerRoll,
          ]
        : []),
    ];
    rollLedger = buildRollLedger({
      initiator,
      targets,
      area: null,
      rolls,
      ledgerOps: ops as unknown as never,
      ledgerInverses: [],
      turnNumber,
    });
  } catch {}
  const cardMessage: MessageDocument = {
    _id: globalThis.crypto.randomUUID(),
    type: "message",
    name: card.name,
    ownership: { default: 1 },
    flags: {},
    // F01: attach ledger shell with first-class data; mods dropdown from attackModifierParts/damageModifierParts lives in roll terms
    ...(rollLedger !== null ? { system: { rollLedger } } : { system: {} }),
    author: user?.id ?? "",
    content: card.content,
    whisper: [],
    roll: null,
    flavor: "attack resolution",
  } as unknown as MessageDocument;
  // F01 NOTE: the canonical flow submits the card and its ledgerOps in ONE envelope
  // (atomic revert-then-reapply on reroll). Keep two envelopes for test-compatibility
  // now and merge in the follow-up; the ledger payload is already self-contained.
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
  if (ops.length > 0) client.submit(ops);
  return { ok: true, result, hpWriteError };
}

/** P09/D-218 — the load-firearm provoke seam for the sheet's Reload button. Loading provokes `yes` (Table 7-2 via `load-firearm`). */
export function firearmReloadOpportunity(input: Parameters<typeof pf1eActionOpportunities>[0]): ReturnType<typeof pf1eActionOpportunities> {
  return pf1eActionOpportunities({ ...input, actionId: FIREARM_RELOAD_ACTION_ID });
}

/** Parameters for the multi-arrow Manyshot flow. */
export interface ResolveManyshotFlowParams {
  attackerName: string;
  line: PF1eDerivedAttack;
  attackFormulas: readonly string[];
  damageFormula: string;
  critDamageFormula: string | null;
  targetName: string;
  targetActor: ActorDocument;
  targetDerived: PF1eDerived;
  defense: PF1eDefenseChoice;
  situational?: PF1eSituationalModifiers | undefined;
  nonlethalDamage?: boolean | undefined;
  feats?: readonly string[] | undefined;
  /** P04 — positional defenses folded into every arrow (cover AC, concealment d%). */
  positional?: PF1ePositionalDefense | undefined;
  verifiable?: boolean | undefined;
  /** A07 — attacker BAB and stance toggles (mirror of the single-attack flow). */
  attackerBab?: number | undefined;
  powerAttack?: boolean | undefined;
  deadlyAim?: boolean | undefined;
  combatExpertise?: boolean | undefined;
  fightingDefensively?: boolean | undefined;
  pointBlankShot?: boolean | undefined;
  distanceFt?: number | undefined;
  /** P04/C01 — shooting-into-melee geometry (AoN 131, folded into the Manyshot -4 ladder). */
  targetEngaged?: boolean | undefined;
  nearestFriendlyDistanceFt?: number | null | undefined;
  engagedSizeCategoriesLarger?: number | undefined;
  /** P08/D-201 — mount movement (Manyshot is ranged; −4 double/−8 run while mounted). */
  mountMovement?: PF1eMountMovement | undefined;
}

/**
 * Host-roll and resolve a Manyshot volley — the first attack of a full-attack
 * action with a bow (2 arrows at BAB +6, 3 at +11, 4 at +16). Unlike calling
 * the single attack flow repeatedly, this keeps one evolving defender state and
 * emits one public card plus the HP writes for the volley. When used as the
 * first iterative of a full attack, remaining iteratives (BAB-5, BAB-10…)
 * are resolved separately as single arrows so the first bonus is not doubled.
 */
export async function resolveManyshotFlow(
  client: ResolveFlowClient,
  user: PermissionUser | null,
  params: ResolveManyshotFlowParams,
): Promise<
  | { ok: true; results: Extract<PF1eResolveResult, { ok: true }>[]; hpWriteError: string | null }
  | { ok: false; error: string }
> {
  if (params.attackFormulas.length < 2 || params.attackFormulas.length > 4)
    return { ok: false, error: "Manyshot requires between 2 and 4 attack formulas" };
  if (!params.line.ranged) return { ok: false, error: "Manyshot requires a ranged attack" };

  const featAttackDeltaPartsManyshot = featAttackParts({
    feats: params.feats,
    bab: params.attackerBab ?? 0,
    ranged: true,
    weaponName: params.line.name,
    powerAttack: params.powerAttack,
    deadlyAim: params.deadlyAim,
    combatExpertise: params.combatExpertise,
    fightingDefensively: params.fightingDefensively,
    pointBlankShot: params.pointBlankShot,
    distanceFt: params.distanceFt,
  });
  const featAttackDeltaManyshot = featAttackDeltaPartsManyshot.reduce((sum, p) => sum + p.value, 0);
  const featDamageDeltaPartsManyshot = featDamageParts({
    feats: params.feats,
    bab: params.attackerBab ?? 0,
    ranged: true,
    weaponName: params.line.name,
    powerAttack: params.powerAttack,
    deadlyAim: params.deadlyAim,
    pointBlankShot: params.pointBlankShot,
    distanceFt: params.distanceFt,
  });
  const featDamageDeltaManyshot = featDamageDeltaPartsManyshot.reduce((sum, p) => sum + p.value, 0);
  const manyshotEngagementPenalty = params.targetEngaged === true ? shootingIntoMeleePenalty({
    sizeCategoriesLarger: params.engagedSizeCategoriesLarger ?? 0,
    preciseShot: hasPF1eFeat(params.feats ?? [], "Precise Shot"),
    targetEngaged: true,
    nearestFriendlyDistanceFt: params.nearestFriendlyDistanceFt ?? undefined,
  }) : 0;
  const baseManyshotBonus = (params.line.attackBonuses[0] ?? params.line.attackBonus) - 4;
  const manyshotMountPenaltyPart = params.mountMovement !== undefined ? mountedRangedPenalty(params.mountMovement) : null;
  const manyshotMountPenalty = manyshotMountPenaltyPart?.value ?? 0;
  const effectiveManyshotBonus = baseManyshotBonus + featAttackDeltaManyshot + manyshotEngagementPenalty + manyshotMountPenalty;
  const effectiveManyshotFormulas =
    featAttackDeltaManyshot !== 0 || manyshotEngagementPenalty !== 0 || manyshotMountPenalty !== 0
      ? params.attackFormulas.map(() => `1d20 ${effectiveManyshotBonus >= 0 ? "+ " + effectiveManyshotBonus : "- " + Math.abs(effectiveManyshotBonus)}`)
      : params.attackFormulas;
  const defender = resolveDefenderFromDerived(params.targetName, params.targetDerived);
  const arrows: Array<{
    die: number;
    confirmDie?: number;
    concealmentDie?: number;
    damageTotal: number;
  }> = [];
  let currentDefender = { ...defender };
  const roll = async (formula: string, flavor: string) => {
    const id = params.verifiable
      ? await client.rollVerified(formula, "roll", undefined, flavor)
      : client.roll(formula, "roll", undefined, flavor);
    const message = await awaitRollMessage(client, id);
    return message === null ? null : message;
  };

  for (let index = 0; index < effectiveManyshotFormulas.length; index += 1) {
    const formula = effectiveManyshotFormulas[index];
    if (formula === undefined) return { ok: false, error: "missing Manyshot attack formula" };
    const attack = await roll(formula, `${params.line.name} Manyshot arrow ${index + 1}`);
    if (attack === null) return { ok: false, error: "Manyshot attack roll did not arrive" };
    const die = dieFaceOf(attack);
    if (die === null) return { ok: false, error: "could not read a Manyshot attack d20" };
    const bonus = effectiveManyshotBonus;
    const prepare = pf1eResolvePrepare({
      attack: {
        label: params.line.name,
        bonus,
        critThreatMin: params.line.critThreatMin,
        critMultiplier: params.line.critMultiplier,
        ...(params.line.touchAttack ? { touchAttack: true } : {}),
        ranged: true,
        damageType: params.line.damageType,
      },
      defense: params.defense,
      defender: currentDefender,
      die,
      ...(params.situational ? { situational: params.situational } : {}),
      ...(params.nonlethalDamage === undefined ? {} : { nonlethalDamage: params.nonlethalDamage }),
      ...(params.feats === undefined ? {} : { feats: params.feats }),
      ...(params.positional === undefined ? {} : { positional: params.positional }),
    });
    if (!prepare.ok) return { ok: false, error: prepare.error };
    let confirmDie: number | undefined;
    let manyshotConfirmed = false;
    if (prepare.roll.hits && prepare.roll.threat) {
      const confirmation = await roll(
        `1d20 ${prepare.attackBonus >= 0 ? `+ ${prepare.attackBonus}` : `- ${Math.abs(prepare.attackBonus)}`}`,
        `${params.line.name} Manyshot arrow ${index + 1} confirmation`,
      );
      if (confirmation === null) return { ok: false, error: "Manyshot confirmation roll did not arrive" };
      confirmDie = dieFaceOf(confirmation) ?? undefined;
      if (confirmDie === undefined) return { ok: false, error: "could not read a Manyshot confirmation d20" };
      const confCheck = confirmCritical({ die: confirmDie, attackBonus: prepare.attackBonus, ac: prepare.defenseAc });
      if (!confCheck.ok) return { ok: false, error: confCheck.error };
      manyshotConfirmed = confCheck.confirmed;
    }
    // P04 — a live miss chance on a hit rolls its own public d% before damage.
    let concealmentDie: number | undefined;
    if (
      prepare.roll.hits &&
      prepare.needsConcealmentRoll !== null
    ) {
      const percent = prepare.needsConcealmentRoll.percent;
      const concealment = await roll(
        "1d100",
        `${params.line.name} Manyshot arrow ${index + 1} concealment ${String(percent)}%`,
      );
      if (concealment === null)
        return { ok: false, error: "Manyshot concealment roll did not arrive" };
      concealmentDie = dieFaceOf(concealment) ?? undefined;
      if (concealmentDie === undefined)
        return { ok: false, error: "could not read a Manyshot concealment d%" };
    }
    let damageTotal = 0;
    if (prepare.roll.hits) {
      const damage = await roll(
        manyshotConfirmed ? params.critDamageFormula ?? params.damageFormula : params.damageFormula,
        `${params.line.name} Manyshot arrow ${index + 1} damage`,
      );
      if (damage === null || damage.roll === null || typeof damage.roll.total !== "number")
        return { ok: false, error: "Manyshot damage roll did not arrive" };
      damageTotal = damage.roll.total;
      if (featDamageDeltaManyshot !== 0) {
        const mult = manyshotConfirmed ? (params.line.critMultiplier ?? 2) : 1;
        damageTotal += featDamageDeltaManyshot * mult;
      }
    }
    const one = pf1eResolveAttack({
      attack: {
        label: params.line.name,
        bonus,
        critThreatMin: params.line.critThreatMin,
        critMultiplier: params.line.critMultiplier,
        ranged: true,
        damageType: params.line.damageType,
      },
      defense: params.defense,
      defender: currentDefender,
      die,
      ...(confirmDie !== undefined ? { confirmDie } : {}),
      ...(concealmentDie !== undefined ? { concealmentDie } : {}),
      damageTotal,
      ...(params.situational ? { situational: params.situational } : {}),
      ...(params.nonlethalDamage === undefined ? {} : { nonlethalDamage: params.nonlethalDamage }),
      ...(params.feats === undefined ? {} : { feats: params.feats }),
      ...(params.positional === undefined ? {} : { positional: params.positional }),
    });
    if (!one.ok) return one;
    const result = one;
    arrows.push({
      die,
      ...(confirmDie === undefined ? {} : { confirmDie }),
      ...(concealmentDie === undefined ? {} : { concealmentDie }),
      damageTotal,
    });
    currentDefender = { ...currentDefender, hp: result.hp.after, nonlethalDamage: result.nonlethal.after, tempHp: result.tempHp.after, tempHpSources: result.tempHp.afterSources };
  }

  const resolved = pf1eResolveManyshot({
    attack: {
      label: params.line.name,
      bonus: effectiveManyshotBonus,
      critThreatMin: params.line.critThreatMin,
      critMultiplier: params.line.critMultiplier,
      ranged: true,
      damageType: params.line.damageType,
    },
    arrows,
    defense: params.defense,
    defender,
    ...(params.situational ? { situational: params.situational } : {}),
    ...(params.nonlethalDamage === undefined ? {} : { nonlethalDamage: params.nonlethalDamage }),
    ...(params.feats === undefined ? {} : { feats: params.feats }),
    ...(params.positional === undefined ? {} : { positional: params.positional }),
  });
  if (!resolved.ok) return resolved;
  const final = resolved.arrows[resolved.arrows.length - 1];
  let hpWriteError: string | null = null;
  const ops: Op[] = [];
  if (final && final.hp.after !== defender.hp) {
    const edit = pf1eSheetEdit(params.targetActor, user, "hp", String(resolved.finalHp));
    if (edit.error) hpWriteError = edit.error;
    else ops.push(...edit.ops);
  }
  if (final && final.nonlethal.after !== defender.nonlethalDamage) {
    const edit = pf1eSheetEdit(params.targetActor, user, "nonlethalDamage", String(resolved.finalNonlethal));
    if (edit.error && hpWriteError === null) hpWriteError = edit.error;
    else if (!edit.error) ops.push(...edit.ops);
  }
  if (final && (resolved.finalTempHp !== (defender.tempHp ?? 0) || JSON.stringify(resolved.finalTempHpSources) !== JSON.stringify(defender.tempHpSources ?? {}))) {
    if (!user || !can(user, "update", params.targetActor, "actors")) {
      if (hpWriteError === null) hpWriteError = "You do not own this PF1e actor.";
    } else {
      const diff: Record<string, import("../../core/documents").Json> = {};
      if (Object.keys(resolved.finalTempHpSources).length === 0) {
        diff["-=system.pf1e.tempHpSources"] = null;
        diff["-=system.pf1e.tempHp"] = null;
      } else {
        diff["system.pf1e.tempHpSources"] = resolved.finalTempHpSources as unknown as import("../../core/documents").Json;
        diff["-=system.pf1e.tempHp"] = null;
      }
      ops.push({ kind: "update", ref: { coll: "actors", id: params.targetActor._id }, diff });
    }
  }
  client.submit([{ kind: "create", coll: "messages", data: {
    _id: globalThis.crypto.randomUUID(), type: "message", name: `${params.attackerName} Manyshot`,
    ownership: { default: 1 }, flags: {}, system: {}, author: user?.id ?? "", whisper: [], roll: null,
    flavor: "Manyshot resolution", content: `${params.attackerName}: ${params.line.name} Manyshot against ${params.targetName}\n${resolved.arrows.map((arrow, index) => `Arrow ${index + 1}: ${arrow.outcome}, ${arrow.damage?.dealt ?? 0} damage`).join("\n")}\nHP ${defender.hp} → ${resolved.finalHp}.`,
  } as MessageDocument }]);
  if (ops.length) client.submit(ops);
  return { ok: true, results: resolved.arrows, hpWriteError };
}

/** P09/D-219 — burst explosion flow: a 5-ft burst from a chosen corner (UC p.135). */
export interface ResolveFirearmExplosionParams {
  attackerName: string;
  /** The firearm's damage formula for the burst (e.g. the musket's 1d12). */
  damageFormula: string;
  /** Creatures in the 5-ft burst — the 4 squares sharing the chosen corner. */
  burstTargets: ReadonlyArray<{
    name: string;
    actor: ActorDocument;
    derived: PF1eDerived;
  }>;
  /** Corner the burst is placed on — only for the card; omit when the GM places by hand. */
  corner?: { col: number; row: number } | undefined;
  verifiable?: boolean | undefined;
}

export async function resolveFirearmExplosionFlow(
  client: ResolveFlowClient,
  user: PermissionUser | null,
  params: ResolveFirearmExplosionParams,
): Promise<
  | {
      ok: true;
      damageTotal: number;
      perTarget: Array<{
        name: string;
        die: number;
        total: number;
        success: boolean;
        dealt: number;
        hpBefore: number;
        hpAfter: number;
        hpWriteError: string | null;
      }>;
      card: string;
    }
  | { ok: false; error: string }
> {
  if (params.burstTargets.length === 0) return { ok: false, error: "the explosion burst has no targets" };
  if (params.damageFormula.trim() === "") return { ok: false, error: "the explosion needs a damage formula (the firearm's dice)" };

  const rollId = params.verifiable
    ? await client.rollVerified(params.damageFormula, "roll", undefined, `firearm explosion ${params.damageFormula}`)
    : client.roll(params.damageFormula, "roll", undefined, `firearm explosion ${params.damageFormula}`);
  const damageMsg = await awaitRollMessage(client, rollId);
  if (damageMsg === null) return { ok: false, error: `explosion damage roll never arrived: ${params.damageFormula}` };
  if (damageMsg.roll === null || typeof damageMsg.roll.total !== "number")
    return { ok: false, error: "the explosion damage message carries no total" };
  const damageTotal = damageMsg.roll.total;

  const perTarget: Array<{
    name: string;
    die: number;
    total: number;
    success: boolean;
    dealt: number;
    hpBefore: number;
    hpAfter: number;
    hpWriteError: string | null;
  }> = [];
  const ops: Op[] = [];
  const lines: string[] = [];
  lines.push(
    `${params.attackerName}'s early firearm explodes — burst from a chosen corner deals ${String(damageTotal)} [[${damageTotal}|${params.damageFormula}]] fire damage, DC ${FIREARM_EXPLOSION_DC} Reflex half (UC p.135)` +
      (params.corner ? ` — corner (${params.corner.col},${params.corner.row}), 5-ft burst` : ""),
  );

  for (const target of params.burstTargets) {
    const saveRollId = params.verifiable
      ? await client.rollVerified("1d20", "roll", undefined, `${target.name} Reflex vs DC ${FIREARM_EXPLOSION_DC}`)
      : client.roll("1d20", "roll", undefined, `${target.name} Reflex vs DC ${FIREARM_EXPLOSION_DC}`);
    const saveMsg = await awaitRollMessage(client, saveRollId);
    if (saveMsg === null) return { ok: false, error: `Reflex save roll never arrived for ${target.name}` };
    const die = dieFaceOf(saveMsg);
    if (die === null) return { ok: false, error: `could not read the Reflex save d20 for ${target.name}` };
    const save = firearmExplosionReflexOutcome({ die, reflexMod: target.derived.saves.ref });
    const dealt = firearmExplosionMitigatedDamage({ damageTotal, success: save.success });
    const before = target.derived.hp;
    const after = Math.max(0, before - dealt);
    let hpWriteError: string | null = null;
    if (dealt > 0) {
      const edit = pf1eSheetEdit(target.actor, user, "hp", String(after));
      if (edit.error !== null) hpWriteError = edit.error;
      else ops.push(...edit.ops);
    }
    perTarget.push({ name: target.name, die, total: save.total, success: save.success, dealt, hpBefore: before, hpAfter: after, hpWriteError });
    const saveText = save.success ? `saves (${String(save.total)} ≥ ${FIREARM_EXPLOSION_DC}, half)` : `fails (${String(save.total)} < ${FIREARM_EXPLOSION_DC})`;
    lines.push(
      `${target.name}: Reflex ${String(die)} + ${String(target.derived.saves.ref)} = ${String(save.total)} — ${saveText} — ${String(dealt)} damage${hpWriteError ? ` — ⚠ ${hpWriteError}` : ` — ${String(before)} → ${String(after)} HP`}`,
    );
  }

  const content = lines.join("\n");
  client.submit([
    {
      kind: "create",
      coll: "messages",
      data: {
        _id: globalThis.crypto.randomUUID(),
        type: "message",
        name: `${params.attackerName} firearm explosion`.slice(0, 40),
        ownership: { default: 1 },
        flags: {},
        system: {},
        author: user?.id ?? "",
        content,
        whisper: [],
        roll: null,
        flavor: "firearm explosion",
      } as MessageDocument,
    },
  ]);
  if (ops.length > 0) client.submit(ops);
  return { ok: true, damageTotal, perTarget, card: content };
}
