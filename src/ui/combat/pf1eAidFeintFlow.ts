/**
 * P05/D-211 — Aid Another and Feint resolution flows: the sheet/tracker
 * consumers that roll the die, spend the action, and (for aid) thread the
 * conditional AoO's damage back as a penalty — the same discipline as
 * `pf1eManeuverFlow`. Pure orchestration, no rules.
 *
 * Each flow derives what it can from the actors' own derivations (BAB/Wis,
 * size for maneuvers, melee attack bonus for aid) and rolls a host-evaluated
 * public die; the pure `pf1eAidAnother`/`pf1eFeint` verdict is posted as one
 * public card (with `[[total|1d20+X]]`) and the chosen AoO/concealment chips.
 * Both are note-only (the +2 or denied-Dex lives in the card text and in the
 * note the next attack can claim); a live `flags.pf1e` effect that the
 * resolver consumes is a follow-up consumer.
 */

import type { ActorDocument, CombatDocument, SceneDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { deriveFromDocuments } from "../../packages/pf1e/actor";
import { combinedTacticalEffects } from "../../packages/pf1e/effectOps";
import { isFlatFootedByRound, spendCombatantAction } from "../../packages/pf1e/combatState";
import { pf1eAidAnother, pf1eFeint } from "../../packages/pf1e/aidFeint";
import type { PF1eAidFeintPlan } from "./pf1eAidFeint";
import { planAidAnother, planFeint } from "./pf1eAidFeint";
import { attackOfOpportunityBudget, spendAttackOfOpportunityAuthorized } from "./actionBudget";
import { awaitRollMessage, dieFaceOf, resolveAttackFlow, type ResolveFlowClient } from "../sheets/pf1eResolveFlow";
import { pendingRollCreateOp } from "./pf1ePendingRollFlow";
import { isPlayerOwned } from "../../packages/pf1e/pendingRoll";
import { worldSettingsFrom } from "../../core/worldSettings";

export type AidFeintFlowClient = ResolveFlowClient;

function derivedFor(actor: ActorDocument, combat: CombatDocument | null, combatantId: string | null) {
  return deriveFromDocuments({
    actor: { system: actor.system as Record<string, unknown> },
    effects: combinedTacticalEffects(actor, combat, combatantId).effects,
  });
}

function combatantIdForActor(combat: CombatDocument | null, actorId: string): string | null {
  if (!combat) return null;
  const m = combat.combatants.find((c) => c.actorId === actorId);
  return m ? m._id : null;
}

async function awaitDie(client: AidFeintFlowClient, rollId: string): Promise<number | null> {
  const msg = await awaitRollMessage(client, rollId);
  if (!msg) return null;
  return dieFaceOf(msg);
}

// ── Aid Another flow ───────────────────────────────────────────────

export interface AidAnotherFlowParams {
  aider: ActorDocument;
  aided: ActorDocument;
  opponent: ActorDocument;
  combat?: CombatDocument | null;
  tokens?: readonly { _id: string; actorId?: string | null }[];
  scene?: SceneDocument | null;
  /** Choose before the roll whether the +2 is for attack or AC. */
  aidChoice?: "attack" | "ac";
  /** Attack penalty already summed (Power Attack, …). */
  attackPenalty?: number;
  /** True when the aided action would provoke — then aiding also provokes (Table 7-2 fn2). */
  aidedActionProvokes?: boolean;
  /** Bluff? No, aid uses attack. Bluff not needed. */
  verifiable?: boolean;
}

export async function resolveAidAnotherFlow(
  client: AidFeintFlowClient,
  user: PermissionUser | null,
  params: AidAnotherFlowParams,
): Promise<{ ok: true; plan: PF1eAidFeintPlan; cardId: string } | { ok: false; error: string }> {
  const aider = params.aider;
  const aided = params.aided;
  const opponent = params.opponent;

  const aiderCombatantId = combatantIdForActor(params.combat ?? null, aider._id);
  const aiderDerived = derivedFor(aider, params.combat ?? null, aiderCombatantId);
  // Aid is a melee attack vs AC 10 — use the first melee attack's bonus; if the actor has no
  // melee line (archer), fall back to BAB+Str+size like a maneuver's CMB composition would.
  const meleeLine = aiderDerived.attacks.find((a) => !a.ranged) ?? aiderDerived.attacks[0] ?? null;
  const attackBonus = meleeLine ? meleeLine.attackBonus : aiderDerived.cmb;

  // Spend standard action when in a PF1e encounter
  if (params.combat && aiderCombatantId) {
    const hasPf1e = params.combat.combatants.some((c) => c.actorId === aider._id || c.actorId === aided._id);
    if (hasPf1e) {
      const spend = spendCombatantAction(params.combat, aiderCombatantId, { kind: "standard", action: "aid-another" });
      if (!spend.ok) return { ok: false, error: `Action refused: ${spend.error}` };
      if (spend.value) client.submit([{ kind: "update", ref: { coll: "combats", id: params.combat._id }, diff: { combatants: spend.value.combatants } as unknown as Record<string, unknown> } as unknown as Op]);
    }
  }

  // Conditional AoO: if aiding a provoking action, the opponent that the attack is made against
  // (the one engaging the friend) threatens the aider and may make one AoO.
  let aooDamage: number | null = null;
  const provokes = params.aidedActionProvokes === true;
  if (provokes && params.combat && params.tokens && params.tokens.length > 0) {
    const reactorCombatant = params.combat.combatants.find((c) => c.actorId === opponent._id);
    if (reactorCombatant) {
      const budget = attackOfOpportunityBudget(params.combat, reactorCombatant._id, [aider, opponent, aided]);
      if (budget && budget.canTake) {
        const reactorDerived = derivedFor(opponent, params.combat, reactorCombatant._id);
        const line = reactorDerived.attacks.find((a) => !a.ranged) ?? null;
        if (line) {
          const attackFormula = `1d20 + ${line.attackBonus}`;
          const damageFormula = line.damageDice ? `${line.damageDice} + ${line.damageBonus}` : "1d3";
          const aiderDerivedForDef = aiderDerived;
          const aiderCombatant = params.combat && aiderCombatantId !== null
            ? params.combat.combatants.find((c) => c._id === aiderCombatantId)
            : undefined;
          const aiderFlat = aiderCombatant ? isFlatFootedByRound(params.combat, aiderCombatant).flatFooted : false;
          const defense: "normal" | "flatFooted" = aiderFlat ? "flatFooted" : "normal";
          const outcome = await resolveAttackFlow(client, user, {
            attackerName: opponent.name,
            line,
            iterative: 0,
            attackFormula,
            damageFormula,
            critDamageFormula: null,
            targetName: aider.name,
            targetActor: aider,
            targetDerived: aiderDerivedForDef,
            defense,
          });
          if (outcome.ok && outcome.result.ok) {
            aooDamage = outcome.result.damage?.dealt ?? 0;
            const spent = spendAttackOfOpportunityAuthorized(params.combat, reactorCombatant._id, user, [aider, opponent, aided], { reason: "aid-another" });
            if (spent.combat && spent.ops.length > 0) client.submit(spent.ops);
          }
        }
      }
    }
  }

  // F03: aid another pending as attack in savesChecksAuto (default) and manual — defer to aider when player-owned
  try {
    const worldSettingsAid = worldSettingsFrom((client as unknown as { store: { getAll(c: string): readonly unknown[] } }).store.getAll("settings") as unknown as Iterable<unknown>);
    const aiderIsPlayerOwned = isPlayerOwned((aider as unknown as { ownership?: unknown }).ownership as unknown as import("../../core/documents").Ownership | null | undefined);
    const turnNumberAid = (params.combat as unknown as { round?: unknown })?.round !== undefined && typeof (params.combat as unknown as { round?: unknown }).round === "number" ? Math.trunc((params.combat as unknown as { round: number }).round) : 0;
    const { shouldDeferToPlayer: shouldDeferAid } = await import("../../packages/pf1e/pendingRoll");
    if (shouldDeferAid({ kind: "check", targetIsPlayerOwned: aiderIsPlayerOwned, worldSettings: worldSettingsAid, isStrategic: false })) {
      const bonusAid = attackBonus + (params.attackPenalty ?? 0) + (aooDamage !== null && aooDamage > 0 ? -Math.abs(aooDamage) : 0);
      const formulaAid = `1d20${bonusAid >= 0 ? `+${bonusAid}` : `${bonusAid}`}`;
      const modifiersAid: Array<{ label: string; value: number; reason: string }> = [{ label: "Attack", value: attackBonus, reason: "aid another" }];
      if (params.attackPenalty !== undefined && params.attackPenalty !== 0) modifiersAid.push({ label: "Penalty", value: params.attackPenalty, reason: "attackPenalty" });
      if (aooDamage !== null && aooDamage > 0) modifiersAid.push({ label: "AoO damage", value: -Math.abs(aooDamage), reason: "aooDamageTaken" });
      const pendingOpAid = pendingRollCreateOp({
        kind: "check",
        initiator: { actorId: aider._id as unknown as string, tokenId: null, name: aider.name, actionLabel: "aid another" },
        target: { actorId: opponent._id as unknown as string, tokenId: null, name: opponent.name },
        formula: formulaAid,
        dc: 10,
        modifiers: modifiersAid,
        turnNumber: turnNumberAid,
        rollMode: "roll",
        targetIsPlayerOwned: aiderIsPlayerOwned,
        worldSettings: worldSettingsAid,
        isStrategic: false,
      });
      if (pendingOpAid !== null) {
        const pendingCardAid = {
          _id: globalThis.crypto.randomUUID(),
          type: "message",
          name: `${aider.name} — aid ${aided.name} (pending)`,
          ownership: { default: 1 },
          flags: {},
          system: {},
          author: user?.id ?? "",
          content: `${aider.name} — aid another ${aided.name} vs ${opponent.name} — [[${formulaAid}]] vs AC 10 — pending for player roll (die ${formulaAid}).`,
          whisper: [],
          roll: null,
          flavor: "aid another resolution",
        } as unknown as import("../../core/documents").MessageDocument;
        client.submit([{ kind: "create", coll: "messages", data: pendingCardAid }]);
        client.submit([pendingOpAid]);
        const pendingPlanAid: PF1eAidFeintPlan = { ops: [], note: `aid another pending for player roll — check ${formulaAid} vs AC 10` };
        return { ok: true, plan: pendingPlanAid, cardId: (pendingOpAid as unknown as { data: { _id: string } }).data._id };
      }
    }
  } catch {
    // A failed pending-card branch falls back to the inline roll below.
  }
  const rollId = params.verifiable ? await client.rollVerified("1d20", "roll", undefined, "aid another") : client.roll("1d20", "roll", undefined, "aid another");
  const die = await awaitDie(client, rollId);
  if (die === null) return { ok: false, error: "aid another die roll did not arrive" };

  const planRes = planAidAnother({
    aider,
    aided,
    opponent,
    die,
    attackBonus,
    ...(params.attackPenalty !== undefined ? { attackPenalty: params.attackPenalty } : {}),
    ...(aooDamage !== null && aooDamage > 0 ? { aooDamageTaken: aooDamage } : {}),
    ...(params.aidedActionProvokes !== undefined ? { aidedActionProvokes: params.aidedActionProvokes } : {}),
    ...(params.aidChoice !== undefined ? { aidChoice: params.aidChoice } : {}),
  });
  if (!planRes.ok) return planRes;

  // Post one public aid card
  const verdict = pf1eAidAnother({
    die,
    attackBonus,
    ...(params.attackPenalty !== undefined ? { attackPenalty: params.attackPenalty } : {}),
    ...(aooDamage !== null && aooDamage > 0 ? { aooDamageTaken: aooDamage } : {}),
    ...(params.aidedActionProvokes !== undefined ? { aidedActionProvokes: params.aidedActionProvokes } : {}),
    ...(params.aidChoice !== undefined ? { aidChoice: params.aidChoice } : {}),
  });
  // verdict is already folded into planRes's note, but we need total/dc for the chip
  const total = verdict.ok ? String(verdict.total) : "?";
  const dc = verdict.ok ? String(verdict.dc) : "10";
  const lines: string[] = [
    `${aider.name} — aid another ${aided.name} vs ${opponent.name} — [[${total}|1d20 + attack]] vs AC ${dc} — ${verdict.ok && verdict.success ? "SUCCESS" : "FAIL"} (die ${die}${aooDamage ? `, AoO ${aooDamage} as penalty` : ""})`,
    planRes.plan.note,
  ];
  const cardDoc = {
    _id: globalThis.crypto.randomUUID(),
    type: "message",
    name: `${aider.name} — aid ${aided.name}`.slice(0, 40),
    ownership: { default: 1 },
    flags: {},
    system: {},
    author: user?.id ?? "",
    content: lines.join("\n"),
    whisper: [],
    roll: null,
    flavor: "aid another resolution",
  } as unknown as import("../../core/documents").MessageDocument;
  client.submit([{ kind: "create", coll: "messages", data: cardDoc }]);
  if (planRes.plan.ops.length > 0) client.submit(planRes.plan.ops as unknown as Op[]);
  return { ok: true, plan: planRes.plan, cardId: (cardDoc as { _id: string })._id };
}

// ── Feint flow ─────────────────────────────────────────────────────

export interface FeintFlowParams {
  feinter: ActorDocument;
  target: ActorDocument;
  combat?: CombatDocument | null;
  tokens?: readonly { _id: string; actorId?: string | null }[];
  scene?: SceneDocument | null;
  /** Bluff modifier (ability + ranks + misc + effect mods). Supplied by the caller — skills have no derived bluff yet (L01). */
  bluffBonus: number;
  /** Feat flags. */
  hasImprovedFeint?: boolean;
  hasGreaterFeint?: boolean;
  /** Target's authored type / Int — derived where possible, caller may override. */
  targetIsHumanoid?: boolean | null;
  targetIntScore?: number | null;
  targetIsAnimalInt?: boolean | null;
  /** Target's Sense Motive bonus if trained (ranks+Wis+misc). */
  targetSenseMotiveBonus?: number | null;
  targetSenseMotiveTrained?: boolean;
  verifiable?: boolean;
}

export async function resolveFeintFlow(
  client: AidFeintFlowClient,
  user: PermissionUser | null,
  params: FeintFlowParams,
): Promise<{ ok: true; plan: PF1eAidFeintPlan; cardId: string } | { ok: false; error: string }> {
  const feinter = params.feinter;
  const target = params.target;

  const feinterCombatantId = combatantIdForActor(params.combat ?? null, feinter._id);
  const targetCombatantId = combatantIdForActor(params.combat ?? null, target._id);
  const feinterDerived = derivedFor(feinter, params.combat ?? null, feinterCombatantId);
  const targetDerived = derivedFor(target, params.combat ?? null, targetCombatantId);

  // Spend: standard unless Improved Feint => move
  if (params.combat && feinterCombatantId) {
    const hasPf1e = params.combat.combatants.some((c) => c.actorId === feinter._id);
    if (hasPf1e) {
      const kind = params.hasImprovedFeint === true ? ("move" as const) : ("standard" as const);
      const spend = spendCombatantAction(params.combat, feinterCombatantId, { kind, action: "feint" });
      if (!spend.ok) return { ok: false, error: `Action refused: ${spend.error}` };
      if (spend.value) client.submit([{ kind: "update", ref: { coll: "combats", id: params.combat._id }, diff: { combatants: spend.value.combatants } as unknown as Record<string, unknown> } as unknown as Op]);
    }
  }

  // F03: feint pending as check in manual only — defer 1d20+Bluff vs DC to feinter when player-owned
  try {
    const worldSettingsFeint = worldSettingsFrom((client as unknown as { store: { getAll(c: string): readonly unknown[] } }).store.getAll("settings") as unknown as Iterable<unknown>);
    const feinterIsPlayerOwned = isPlayerOwned((feinter as unknown as { ownership?: unknown }).ownership as unknown as import("../../core/documents").Ownership | null | undefined);
    const turnNumberFeint = (params.combat as unknown as { round?: unknown })?.round !== undefined && typeof (params.combat as unknown as { round: number }).round === "number" ? Math.trunc((params.combat as unknown as { round: number }).round) : 0;
    const { shouldDeferToPlayer: shouldDeferFeint } = await import("../../packages/pf1e/pendingRoll");
    if (shouldDeferFeint({ kind: "check", targetIsPlayerOwned: feinterIsPlayerOwned, worldSettings: worldSettingsFeint, isStrategic: false })) {
      // Compute DC for the pending card by probing the pure feint with a dummy die (dc does not depend on die)
      const defenderBabForDc = targetDerived.baseAttack;
      const defenderWisModForDc = targetDerived.abilityMods.wis;
      const targetIntScoreForDc = params.targetIntScore !== undefined ? params.targetIntScore : targetDerived.abilities.int;
      let dcForFeint: number | null = null;
      try {
        const probe = pf1eFeint({
          die: 10,
          bluffBonus: params.bluffBonus,
          defenderBab: defenderBabForDc,
          defenderWisMod: defenderWisModForDc,
          ...(params.targetSenseMotiveBonus !== undefined ? { defenderSenseMotiveBonus: params.targetSenseMotiveBonus } : {}),
          ...(params.targetSenseMotiveTrained !== undefined ? { defenderSenseMotiveTrained: params.targetSenseMotiveTrained } : {}),
          ...(params.targetIsHumanoid !== undefined ? { defenderIsHumanoid: params.targetIsHumanoid } : {}),
          defenderIntScore: targetIntScoreForDc,
          ...(params.targetIsAnimalInt !== undefined ? { defenderIsAnimalInt: params.targetIsAnimalInt } : {}),
          ...(params.hasImprovedFeint !== undefined ? { hasImprovedFeint: params.hasImprovedFeint } : {}),
          ...(params.hasGreaterFeint !== undefined ? { hasGreaterFeint: params.hasGreaterFeint } : {}),
        });
        if (probe.ok) dcForFeint = probe.dc;
      } catch {
        // DC probe is optional; the CRB formula below is the fallback.
      }
      if (dcForFeint === null) dcForFeint = 10 + defenderBabForDc + defenderWisModForDc;
      const formulaFeint = `1d20${params.bluffBonus >= 0 ? `+${params.bluffBonus}` : `${params.bluffBonus}`}`;
      const pendingOpFeint = pendingRollCreateOp({
        kind: "check",
        initiator: { actorId: feinter._id as unknown as string, tokenId: null, name: feinter.name, actionLabel: "feint (Bluff)" },
        target: { actorId: target._id as unknown as string, tokenId: null, name: target.name },
        formula: formulaFeint,
        dc: dcForFeint,
        modifiers: [{ label: "Bluff", value: params.bluffBonus, reason: "feint" }],
        turnNumber: turnNumberFeint,
        rollMode: "roll",
        targetIsPlayerOwned: feinterIsPlayerOwned,
        worldSettings: worldSettingsFeint,
        isStrategic: false,
      });
      if (pendingOpFeint !== null) {
        const pendingCardFeint = {
          _id: globalThis.crypto.randomUUID(),
          type: "message",
          name: `${feinter.name} — feint vs ${target.name} (pending)`,
          ownership: { default: 1 },
          flags: {},
          system: {},
          author: user?.id ?? "",
          content: `${feinter.name} — feint vs ${target.name} — [[${formulaFeint}]] vs DC ${dcForFeint} — pending for player roll (die ${formulaFeint}).`,
          whisper: [],
          roll: null,
          flavor: "feint resolution",
        } as unknown as import("../../core/documents").MessageDocument;
        client.submit([{ kind: "create", coll: "messages", data: pendingCardFeint }]);
        client.submit([pendingOpFeint]);
        const pendingPlanFeint: PF1eAidFeintPlan = { ops: [], note: `feint pending for player roll — check ${formulaFeint} vs DC ${dcForFeint}` };
        return { ok: true, plan: pendingPlanFeint, cardId: (pendingOpFeint as unknown as { data: { _id: string } }).data._id };
      }
    }
  } catch {
    // A failed pending-card branch falls back to the inline roll below.
  }
  const rollId = params.verifiable ? await client.rollVerified("1d20", "roll", undefined, "feint (Bluff)") : client.roll("1d20", "roll", undefined, "feint (Bluff)");
  const die = await awaitDie(client, rollId);
  if (die === null) return { ok: false, error: "feint die roll did not arrive" };

  // Target BAB and Wis for DC: derived BAB + derived Wis mod
  const defenderBab = targetDerived.baseAttack;
  const defenderWisMod = targetDerived.abilityMods.wis;
  // Humanoid / Int: caller overrides win, else infer from size? No inference — use what caller gave or derived defaults.
  // Int score: authored abilities.int after drain/damage is the live score; 0 => mindless would be dead already but feint reads it as impossible.
  const targetIntScore =
    params.targetIntScore !== undefined
      ? params.targetIntScore
      : targetDerived.abilities.int;

  const planRes = planFeint({
    feinter,
    target,
    die,
    bluffBonus: params.bluffBonus,
    defenderBab,
    defenderWisMod,
    ...(params.targetSenseMotiveBonus !== undefined ? { defenderSenseMotiveBonus: params.targetSenseMotiveBonus } : {}),
    ...(params.targetSenseMotiveTrained !== undefined ? { defenderSenseMotiveTrained: params.targetSenseMotiveTrained } : {}),
    ...(params.targetIsHumanoid !== undefined ? { defenderIsHumanoid: params.targetIsHumanoid } : {}),
    defenderIntScore: targetIntScore,
    ...(params.targetIsAnimalInt !== undefined ? { defenderIsAnimalInt: params.targetIsAnimalInt } : {}),
    ...(params.hasImprovedFeint !== undefined ? { hasImprovedFeint: params.hasImprovedFeint } : {}),
    ...(params.hasGreaterFeint !== undefined ? { hasGreaterFeint: params.hasGreaterFeint } : {}),
  });
  if (!planRes.ok) return planRes;

  const verdict = pf1eFeint({
    die,
    bluffBonus: params.bluffBonus,
    defenderBab,
    defenderWisMod,
    ...(params.targetSenseMotiveBonus !== undefined ? { defenderSenseMotiveBonus: params.targetSenseMotiveBonus } : {}),
    ...(params.targetSenseMotiveTrained !== undefined ? { defenderSenseMotiveTrained: params.targetSenseMotiveTrained } : {}),
    ...(params.targetIsHumanoid !== undefined ? { defenderIsHumanoid: params.targetIsHumanoid } : {}),
    defenderIntScore: targetIntScore,
    ...(params.targetIsAnimalInt !== undefined ? { defenderIsAnimalInt: params.targetIsAnimalInt } : {}),
    ...(params.hasImprovedFeint !== undefined ? { hasImprovedFeint: params.hasImprovedFeint } : {}),
    ...(params.hasGreaterFeint !== undefined ? { hasGreaterFeint: params.hasGreaterFeint } : {}),
  });
  const total = verdict.ok ? String(verdict.total) : "?";
  const dc = verdict.ok ? String(verdict.dc) : "?";
  void feinterDerived;
  const lines: string[] = [
    `${feinter.name} — feint vs ${target.name} — [[${total}|1d20 + Bluff]] vs DC ${dc} — ${verdict.ok && verdict.success ? "SUCCESS" : "FAIL"} (die ${die})`,
    planRes.plan.note,
  ];
  const cardDoc = {
    _id: globalThis.crypto.randomUUID(),
    type: "message",
    name: `${feinter.name} — feint vs ${target.name}`.slice(0, 40),
    ownership: { default: 1 },
    flags: {},
    system: {},
    author: user?.id ?? "",
    content: lines.join("\n"),
    whisper: [],
    roll: null,
    flavor: "feint resolution",
  } as unknown as import("../../core/documents").MessageDocument;
  client.submit([{ kind: "create", coll: "messages", data: cardDoc }]);
  if (planRes.plan.ops.length > 0) client.submit(planRes.plan.ops as unknown as Op[]);
  return { ok: true, plan: planRes.plan, cardId: (cardDoc as { _id: string })._id };
}
