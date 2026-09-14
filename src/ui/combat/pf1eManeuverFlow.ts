/**
 * P05/D-210 — maneuver resolution flow: the sheet/tracker consumer that rolls
 * the die and threads the provoked AoO's damage back (the wiring the TODO
 * names as the next slice). Pure orchestration, no rules: every die is a
 * host-evaluated public roll, every condition write rides the planner's
 * `system.pf1e.conditions` op, and the AoO (when the maneuver provokes) is
 * the defender's single melee attack resolved through the sheet's own
 * `resolveAttackFlow` — so the roll, the threat/confirmation, the damage,
 * the mitigation and the HP write are the same code path a sheet attack
 * uses. Hit or miss, the defender's AoO budget is spent (reacting is the
 * cost), and its damage — if any — becomes `aooDamageTaken` on the
 * maneuver check, exactly the penalized-AoO rule A.9 documents.
 *
 * The flow is the product surface the CombatPanel / PF1eActorSheet will
 * call. It derives CMB/CMD from the actors' own derivations, spends the
 * attacker's standard action (when an encounter is present), rolls the
 * maneuver die (and the concealment d% when a live miss chance meets a
 * would-be success), posts one public maneuver card and submits the
 * condition ops. The maneuver kind decides which pure consumer and which
 * planner run — the same 10 the D-199..D-209 pure layers own, plus the
 * grapple family.
 */

import type { ActorDocument, CombatDocument, MessageDocument, SceneDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { deriveFromDocuments, type PF1eDerived } from "../../packages/pf1e/actor";
import { combinedTacticalEffects } from "../../packages/pf1e/effectOps";
import { isFlatFootedByRound, readCombatantState, spendCombatantAction } from "../../packages/pf1e/combatState";

import {
  pf1eBullRush,
  pf1eDirtyTrick,
  pf1eDisarm,
  pf1eDrag,
  pf1eGrapple,
  pf1eGrappleEscape,
  pf1eGrappleMaintain,
  pf1eGrapplePin,
  pf1eGrappleTieUp,
  pf1eOverrun,
  pf1eReposition,
  pf1eSteal,
  pf1eSunder,
  pf1eTrip,
  type PF1eManeuverCheckInput,
  type PF1eManeuverKind,
} from "../../packages/pf1e/maneuvers";
import {
  planBullRush,
  planDirtyTrick,
  planDisarm,
  planDrag,
  planGrapple,
  planGrappleEscape,
  planGrappleMaintain,
  planGrapplePin,
  planGrappleTieUp,
  planOverrun,
  planReposition,
  planSteal,
  planTrip,
  type PF1eManeuverPlan,
} from "./pf1eManeuver";
import {
  attackOfOpportunityBudget,
  spendAttackOfOpportunityAuthorized,
} from "./actionBudget";
import { resolveAttackFlow, type ResolveFlowClient, awaitRollMessage, dieFaceOf } from "../sheets/pf1eResolveFlow";
import { pendingRollCreateOp } from "./pf1ePendingRollFlow";
import { isPlayerOwned } from "../../packages/pf1e/pendingRoll";
import { worldSettingsFrom } from "../../core/worldSettings";

export interface ManeuverFlowClient extends ResolveFlowClient {
  // same as ResolveFlowClient — roll, rollVerified, store, submit
}

export type ManeuverFlowKind = PF1eManeuverKind | "grapple-maintain" | "grapple-pin" | "grapple-tie-up" | "grapple-escape" | "grapple-move" | "grapple-damage" | "sunder";

export interface ManeuverFlowParams {
  attacker: ActorDocument;
  defender: ActorDocument;
  kind: ManeuverFlowKind;
  /** The encounter the maneuver happens in — for action/AoO budgets and flat-footed. */
  combat?: CombatDocument | null;
  /** Scene tokens, for token→actor AoO resolution. */
  tokens?: readonly { _id: string; actorId?: string | null }[];
  scene?: SceneDocument | null;
  /** When true the maneuver does not provoke (Improved X, grab, …). */
  hasImprovedFeat?: boolean;
  /** Attack penalty already summed by the caller (Power Attack, …). */
  attackPenalty?: number;
  /** Live concealment on the defender (maneuvers are attack rolls, AoN 182). */
  concealment?: { percent: number; label?: string };
  /** Grapple-specific. */
  grappleOpts?: {
    attackerIsHumanoid?: boolean;
    attackerFreeHands?: number;
    targetAdjacent?: boolean;
    hasAdjacentSpace?: boolean;
    hasMaintainBonus?: boolean;
    // tie-up
    targetPinnedOrRestrainedOrUnconscious?: boolean;
    grapplingWhileTying?: boolean;
    attackerCmbForDc?: number;
    targetCmbForEscape?: number;
    // escape
    escapeBonus?: number;
    becomeGrappler?: boolean;
    hasHazardBonus?: boolean;
    // move/damage/pin
    maintainSuccess?: boolean;
    speedFt?: number;
    hazardousPlacement?: boolean;
    damage?: number;
  };
  /** Dirty trick. */
  dirtyTrick?: { condition?: string; hasGreaterDirtyTrick?: boolean; greaterDie?: number };
  /** Disarm. */
  disarm?: { attackerUnarmed?: boolean; disarmedWithoutWeapon?: boolean };
  /** Steal. */
  steal?: { attackerFreeHand?: boolean };
  /** Sunder. */
  sunder?: { item: { hardness: number; hp: number; hpMax: number }; damage: number };
  /** Overrun. */
  overrun?: { targetAvoids?: boolean };
  /** Commit-reveal. */
  verifiable?: boolean;
}

/** Wait for a roll message, same helper the other flows use. */
async function awaitDie(
  client: ManeuverFlowClient,
  rollId: string,
): Promise<MessageDocument | null> {
  return awaitRollMessage(client, rollId);
}

/** Derive CMB/CMD, respecting flat-footed. */
function derivedFor(actor: ActorDocument, combat: CombatDocument | null, combatantId: string | null): PF1eDerived {
  return deriveFromDocuments({
    actor: { system: actor.system as Record<string, unknown> },
    effects: combinedTacticalEffects(actor, combat, combatantId).effects,
  });
}

function combatantIdForActor(combat: CombatDocument | null, actorId: string): string | null {
  if (!combat) return null;
  const member = combat.combatants.find((c) => c.actorId === actorId);
  return member ? member._id : null;
}

/** One public maneuver card, same shape the tracker renders. */
function maneuverCardContent(
  attackerName: string,
  defenderName: string,
  kind: string,
  check: { total: number; cmdEffective: number; margin: number; success: boolean; notes: readonly string[] },
  die: number,
  concealmentDie?: number | null,
  aooDamage?: number | null,
): { name: string; content: string } {
  const lines: string[] = [
    `${attackerName} — ${kind} vs ${defenderName} — [[${check.total}|1d20 + CMB]] vs CMD ${check.cmdEffective} — ${check.success ? "SUCCESS" : "FAIL"} (die ${die}${concealmentDie !== undefined && concealmentDie !== null ? `, d% ${concealmentDie}` : ""}${aooDamage ? `, AoO ${aooDamage} as penalty` : ""})`,
    `Margin ${check.margin >= 0 ? `+${check.margin}` : String(check.margin)}.`,
  ];
  for (const n of check.notes) lines.push(n);
  return { name: `${attackerName} — ${kind}`.slice(0, 40), content: lines.join("\n") };
}

/**
 * Resolve one maneuver end-to-end: spend the attacker's standard action
 * (when an encounter is present), roll the maneuver die (and the AoO's
 * attack/damage when the maneuver provokes), perform the pure check with
 * the AoO damage as penalty, write the condition ops and post the card.
 */
export async function resolveManeuverFlow(
  client: ManeuverFlowClient,
  user: PermissionUser | null,
  params: ManeuverFlowParams,
): Promise<{ ok: true; plan: PF1eManeuverPlan; aooDamage: number | null; cardId: string } | { ok: false; error: string }> {
  const attacker = params.attacker;
  const defender = params.defender;
  const kind = params.kind;

  // Derive CMB/CMD
  const attackerCombatantId = combatantIdForActor(params.combat ?? null, attacker._id);
  const defenderCombatantId = combatantIdForActor(params.combat ?? null, defender._id);
  const attackerDerived = derivedFor(attacker, params.combat ?? null, attackerCombatantId);
  const defenderDerived = derivedFor(defender, params.combat ?? null, defenderCombatantId);
  const defenderFlat = params.combat && defenderCombatantId ? isFlatFootedByRound(params.combat, params.combat.combatants.find((c) => c._id === defenderCombatantId)!).flatFooted : false;
  const defenderCmd = defenderFlat ? defenderDerived.cmdFlatFooted : defenderDerived.cmd;
  const attackerCmb = attackerDerived.cmb;

  // Action budget: maneuvers are standard actions (or as part of attack). Spend standard when we can.
  if (params.combat && attackerCombatantId) {
    const ledger = readCombatantState(params.combat.combatants.find((c) => c._id === attackerCombatantId)!).actions;
    // Only spend if the encounter is a PF1e encounter (has a PF1e actor). Otherwise the ledger is not PF1e.
    const hasPf1e = params.combat.combatants.some((c) => {
      const a = c.actorId ? [attacker, defender].find((x) => x._id === c.actorId) : undefined;
      return a !== undefined;
    });
    if (hasPf1e) {
      const spend = spendCombatantAction(params.combat, attackerCombatantId, { kind: "standard", action: "combat-maneuver" });
      if (!spend.ok) {
        // Refuse the maneuver before any die
        return { ok: false, error: `Action refused: ${spend.error}` };
      }
      if (spend.value) {
        client.submit([{ kind: "update", ref: { coll: "combats", id: params.combat._id }, diff: { combatants: spend.value.combatants } as unknown as Record<string, unknown> } as Op]);
      }
    }
    void ledger;
  }

  // AoO handling: if the maneuver provokes (no Improved) and the defender can AoO, resolve it first.
  let aooDamage: number | null = null;
  let aooCardPosted = false;
  const provokes = params.hasImprovedFeat !== true && kind !== "grapple-escape" && kind !== "grapple-move" && kind !== "grapple-damage";
  // Grapple escape never provokes, move/damage are maintain options, not initial checks.
  if (provokes && params.combat && params.tokens && params.tokens.length > 0) {
    // Find defender's combatant and check budget
    const defenderCombatant = params.combat.combatants.find((c) => c.actorId === defender._id);
    if (defenderCombatant) {
      const budget = attackOfOpportunityBudget(params.combat, defenderCombatant._id, [attacker, defender]);
      if (budget && budget.canTake) {
        // Resolve defender's single melee attack vs attacker
        const defenderDerivedForAoo = defenderDerived;
        const attackerDerivedForAoo = attackerDerived;
        const line = defenderDerivedForAoo.attacks.find((a) => !a.ranged) ?? null;
        if (line) {
          // Use the derived line's own bonuses directly — groups are for iterative display and would
          // require feats/authored count; the AoO is always the first iterative.
          const attackBonus = line.attackBonus;
          const attackFormula = `1d20 + ${attackBonus}`;
          const damageFormula = line.damageDice ? `${line.damageDice} + ${line.damageBonus}` : "1d3";
          const critFormula: string | null = null;
          // Flat-footed attacker?
          const attackerFlat = params.combat && attackerCombatantId ? isFlatFootedByRound(params.combat, params.combat.combatants.find((c) => c._id === attackerCombatantId)!).flatFooted : false;
          const defense: "normal" | "flatFooted" = attackerFlat ? "flatFooted" : "normal";
          const outcome = await resolveAttackFlow(client, user, {
            attackerName: defender.name,
            line,
            iterative: 0,
            attackFormula,
            damageFormula,
            critDamageFormula: critFormula,
            targetName: attacker.name,
            targetActor: attacker,
            targetDerived: attackerDerivedForAoo,
            defense,
          });
          if (outcome.ok && outcome.result.ok) {
            aooDamage = outcome.result.damage?.dealt ?? 0;
            if (aooDamage === 0 && outcome.result.outcome === "miss") aooDamage = 0;
            // Spend defender's AoO budget (hit or miss)
            const spent = spendAttackOfOpportunityAuthorized(params.combat, defenderCombatant._id, user, [attacker, defender], { reason: "maneuver" });
            if (spent.combat && spent.ops.length > 0) client.submit(spent.ops);
            aooCardPosted = true;
            void attackerFlat;
          }
        }
      }
    }
  }
  void aooCardPosted;

  // F03: maneuver check pending in manual mode only — defer 1d20+CMB vs CMD to attacker when player-owned
  const rollOne = async (formula: string, flavor: string): Promise<number | null> => {
    const rollId = params.verifiable ? await client.rollVerified(formula, "roll", undefined, flavor) : client.roll(formula, "roll", undefined, flavor);
    const msg = await awaitDie(client, rollId);
    if (!msg) return null;
    const face = dieFaceOf(msg);
    return face;
  };

  try {
    const worldSettingsM = worldSettingsFrom((client as unknown as { store: { getAll(c: string): readonly unknown[] } }).store.getAll("settings") as unknown as Iterable<unknown>);
    const attackerIsPlayerOwned = isPlayerOwned((attacker as unknown as { ownership?: unknown }).ownership as unknown as import("../../core/documents").Ownership | null | undefined);
    const turnNumberM = (params.combat as unknown as { round?: unknown })?.round !== undefined && typeof (params.combat as unknown as { round?: unknown }).round === "number" ? Math.trunc((params.combat as unknown as { round: number }).round) : 0;
    const { shouldDeferToPlayer: shouldDeferM } = await import("../../packages/pf1e/pendingRoll");
    if (shouldDeferM({ kind: "check", targetIsPlayerOwned: attackerIsPlayerOwned, worldSettings: worldSettingsM, isStrategic: false })) {
      const bonusForFormula = attackerCmb + (params.attackPenalty ?? 0) + (aooDamage !== null && aooDamage > 0 ? -Math.abs(aooDamage) : 0);
      const formulaM = `1d20${bonusForFormula >= 0 ? `+${bonusForFormula}` : `${bonusForFormula}`}`;
      const modifiersM: Array<{ label: string; value: number; reason: string }> = [{ label: "CMB", value: attackerCmb, reason: kind }];
      if (params.attackPenalty !== undefined && params.attackPenalty !== 0) modifiersM.push({ label: "Penalty", value: params.attackPenalty, reason: "attackPenalty" });
      if (aooDamage !== null && aooDamage > 0) modifiersM.push({ label: "AoO damage", value: -Math.abs(aooDamage), reason: "aooDamageTaken" });
      const pendingOpM = pendingRollCreateOp({
        kind: "check",
        initiator: { actorId: attacker._id as unknown as string, tokenId: null, name: attacker.name, actionLabel: `${kind} maneuver` },
        target: { actorId: defender._id as unknown as string, tokenId: null, name: defender.name },
        formula: formulaM,
        dc: defenderCmd,
        modifiers: modifiersM,
        turnNumber: turnNumberM,
        rollMode: "roll",
        targetIsPlayerOwned: attackerIsPlayerOwned,
        worldSettings: worldSettingsM,
        isStrategic: false,
      });
      if (pendingOpM !== null) {
        const pendingCardM: MessageDocument = {
          _id: globalThis.crypto.randomUUID(),
          type: "message",
          name: `${attacker.name} — ${kind} (pending)`,
          ownership: { default: 1 },
          flags: {},
          system: {},
          author: user?.id ?? "",
          content: `${attacker.name} — ${kind} vs ${defender.name} — [[${formulaM}]] vs CMD ${defenderCmd} — pending for player roll (die ${formulaM}).`,
          whisper: [],
          roll: null,
          flavor: "maneuver resolution",
        };
        // Post the narrative line as a card plus the atomic pending card
        client.submit([{ kind: "create", coll: "messages", data: pendingCardM }]);
        client.submit([pendingOpM]);
        const pendingPlan: PF1eManeuverPlan = { ops: [], note: `${kind} maneuver pending for player roll — check ${formulaM} vs CMD ${defenderCmd}` };
        return { ok: true, plan: pendingPlan, aooDamage, cardId: (pendingOpM as unknown as { data: { _id: string } }).data._id };
      }
    }
  } catch {}

  const die = await rollOne("1d20", `${kind} maneuver`);
  if (die === null) return { ok: false, error: "maneuver die roll did not arrive" };

  // Concealment d% if the attacker would succeed and the defender is concealed
  let concealmentDie: number | null = null;
  if (params.concealment && params.concealment.percent > 0) {
    // We don't know yet if the maneuver would succeed without concealment, but the pure check will handle the die.
    // Roll d% now and pass it; the check will consume it only when wouldSucceed.
    const face = await rollOne("1d100", `${kind} concealment ${params.concealment.percent}%`);
    if (face === null) return { ok: false, error: "concealment die roll did not arrive" };
    concealmentDie = face;
  }

  // Build the check input
  const baseCheck: Omit<PF1eManeuverCheckInput, "kind"> = {
    die,
    cmb: attackerCmb,
    cmd: defenderCmd,
    attacker: { size: attackerDerived.size as string },
    defender: { size: defenderDerived.size as string },
    ...(params.attackPenalty !== undefined ? { attackPenalty: params.attackPenalty } : {}),
    ...(aooDamage !== null && aooDamage > 0 ? { aooDamageTaken: aooDamage } : {}),
    ...(params.hasImprovedFeat ? { hasImprovedFeat: true } : {}),
    ...(params.concealment ? { concealment: params.concealment } : {}),
    ...(concealmentDie !== null ? { concealmentDie } : {}),
  } as Omit<PF1eManeuverCheckInput, "kind">;

  // Dispatch to the correct pure consumer and planner
  let plan: PF1eManeuverPlan | null = null;
  let checkForCard: { total: number; cmdEffective: number; margin: number; success: boolean; notes: readonly string[] } | null = null;

  const attackerName = attacker.name;
  const defenderName = defender.name;

  // Helper to post the card and submit ops
  const post = (pl: PF1eManeuverPlan, chk: { total: number; cmdEffective: number; margin: number; success: boolean; notes: readonly string[] }): string => {
    const card = maneuverCardContent(attackerName, defenderName, kind, chk, die, concealmentDie, aooDamage);
    const cardDoc: MessageDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "message",
      name: card.name,
      ownership: { default: 1 },
      flags: {},
      system: {},
      author: user?.id ?? "",
      content: card.content,
      whisper: [],
      roll: null,
      flavor: "maneuver resolution",
    };
    client.submit([{ kind: "create", coll: "messages", data: cardDoc }]);
    if (pl.ops.length > 0) client.submit(pl.ops);
    return cardDoc._id;
  };

  // Dispatch
  if (kind === "bull-rush") {
    const res = pf1eBullRush({ check: baseCheck });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planBullRush({ attacker, defender, check: baseCheck });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "trip") {
    const res = pf1eTrip({ check: baseCheck });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planTrip({ attacker, defender, check: baseCheck });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "disarm") {
    const res = pf1eDisarm({ check: baseCheck, ...(params.disarm?.attackerUnarmed !== undefined ? { attackerUnarmed: params.disarm.attackerUnarmed } : {}), ...(params.disarm?.disarmedWithoutWeapon !== undefined ? { disarmedWithoutWeapon: params.disarm.disarmedWithoutWeapon } : {}) });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planDisarm({ attacker, defender, check: baseCheck, ...(params.disarm?.attackerUnarmed !== undefined ? { attackerUnarmed: params.disarm.attackerUnarmed } : {}), ...(params.disarm?.disarmedWithoutWeapon !== undefined ? { disarmedWithoutWeapon: params.disarm.disarmedWithoutWeapon } : {}) });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "sunder") {
    if (!params.sunder) return { ok: false, error: "sunder requires item and damage" };
    const res = pf1eSunder({ check: baseCheck, item: params.sunder.item, damage: params.sunder.damage });
    if (!res.ok) return { ok: false, error: res.error };
    // Sunder has no planner yet (item HP is sheet-edited separately) — note-only
    plan = { ops: [], note: `${attackerName} — ${res.notes.join(" · ")}` };
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.check.success, notes: res.notes };
  } else if (kind === "overrun") {
    const res = pf1eOverrun({ check: baseCheck, ...(params.overrun?.targetAvoids !== undefined ? { targetAvoids: params.overrun.targetAvoids } : {}) });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planOverrun({ attacker, defender, check: baseCheck, ...(params.overrun?.targetAvoids !== undefined ? { targetAvoids: params.overrun.targetAvoids } : {}) });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    // Overrun's check can be null when target avoids
    if (res.check) checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
    else checkForCard = { total: 0, cmdEffective: defenderCmd, margin: 0, success: res.success, notes: res.notes };
  } else if (kind === "dirty-trick") {
    const res = pf1eDirtyTrick({ check: baseCheck, ...(params.dirtyTrick?.condition ? { condition: params.dirtyTrick.condition } : {}), ...(params.dirtyTrick?.hasGreaterDirtyTrick !== undefined ? { hasGreaterDirtyTrick: params.dirtyTrick.hasGreaterDirtyTrick } : {}), ...(params.dirtyTrick?.greaterDie !== undefined ? { greaterDie: params.dirtyTrick.greaterDie } : {}) });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planDirtyTrick({ attacker, defender, check: baseCheck, ...(params.dirtyTrick?.condition ? { condition: params.dirtyTrick.condition } : {}), ...(params.dirtyTrick?.hasGreaterDirtyTrick !== undefined ? { hasGreaterDirtyTrick: params.dirtyTrick.hasGreaterDirtyTrick } : {}), ...(params.dirtyTrick?.greaterDie !== undefined ? { greaterDie: params.dirtyTrick.greaterDie } : {}) });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "drag") {
    const res = pf1eDrag({ check: baseCheck });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planDrag({ attacker, defender, check: baseCheck });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "reposition") {
    const res = pf1eReposition({ check: baseCheck });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planReposition({ attacker, defender, check: baseCheck });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "steal") {
    const res = pf1eSteal({ check: baseCheck, ...(params.steal?.attackerFreeHand !== undefined ? { attackerFreeHand: params.steal.attackerFreeHand } : {}) });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planSteal({ attacker, defender, check: baseCheck, ...(params.steal?.attackerFreeHand !== undefined ? { attackerFreeHand: params.steal.attackerFreeHand } : {}) });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "grapple") {
    const g = params.grappleOpts;
    const res = pf1eGrapple({
      check: baseCheck,
      ...(g?.attackerIsHumanoid !== undefined ? { attackerIsHumanoid: g.attackerIsHumanoid } : {}),
      ...(g?.attackerFreeHands !== undefined ? { attackerFreeHands: g.attackerFreeHands } : {}),
      ...(g?.targetAdjacent !== undefined ? { targetAdjacent: g.targetAdjacent } : {}),
      ...(g?.hasAdjacentSpace !== undefined ? { hasAdjacentSpace: g.hasAdjacentSpace } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planGrapple({
      attacker,
      defender,
      check: baseCheck,
      ...(g?.attackerIsHumanoid !== undefined ? { attackerIsHumanoid: g.attackerIsHumanoid } : {}),
      ...(g?.attackerFreeHands !== undefined ? { attackerFreeHands: g.attackerFreeHands } : {}),
      ...(g?.targetAdjacent !== undefined ? { targetAdjacent: g.targetAdjacent } : {}),
      ...(g?.hasAdjacentSpace !== undefined ? { hasAdjacentSpace: g.hasAdjacentSpace } : {}),
    });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "grapple-maintain") {
    const g = params.grappleOpts;
    const res = pf1eGrappleMaintain({
      check: baseCheck,
      ...(g?.attackerIsHumanoid !== undefined ? { attackerIsHumanoid: g.attackerIsHumanoid } : {}),
      ...(g?.attackerFreeHands !== undefined ? { attackerFreeHands: g.attackerFreeHands } : {}),
      ...(g?.hasMaintainBonus !== undefined ? { hasMaintainBonus: g.hasMaintainBonus } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planGrappleMaintain({
      attacker,
      defender,
      check: baseCheck,
      ...(g?.attackerIsHumanoid !== undefined ? { attackerIsHumanoid: g.attackerIsHumanoid } : {}),
      ...(g?.attackerFreeHands !== undefined ? { attackerFreeHands: g.attackerFreeHands } : {}),
      ...(g?.hasMaintainBonus !== undefined ? { hasMaintainBonus: g.hasMaintainBonus } : {}),
    });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "grapple-pin") {
    const g = params.grappleOpts;
    if (g?.maintainSuccess !== true) return { ok: false, error: "grapple pin requires a successful maintain" };
    const res = pf1eGrapplePin({ maintainSuccess: true });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planGrapplePin({ attacker, defender, maintainSuccess: true });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    // Pin has no check, so we fake a card header from the maintain's context
    checkForCard = { total: 0, cmdEffective: defenderCmd, margin: 0, success: true, notes: res.notes };
  } else if (kind === "grapple-tie-up") {
    const g = params.grappleOpts;
    if (g?.targetPinnedOrRestrainedOrUnconscious !== true) return { ok: false, error: "tie up requires pinned/restrained/unconscious" };
    const res = pf1eGrappleTieUp({
      check: baseCheck,
      targetPinnedOrRestrainedOrUnconscious: true,
      ...(g.grapplingWhileTying !== undefined ? { grapplingWhileTying: g.grapplingWhileTying } : {}),
      ...(g.attackerIsHumanoid !== undefined ? { attackerIsHumanoid: g.attackerIsHumanoid } : {}),
      ...(g.attackerFreeHands !== undefined ? { attackerFreeHands: g.attackerFreeHands } : {}),
      attackerCmbForDc: g.attackerCmbForDc ?? attackerCmb,
      ...(g.targetCmbForEscape !== undefined ? { targetCmbForEscape: g.targetCmbForEscape } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planGrappleTieUp({
      attacker,
      defender,
      check: baseCheck,
      targetPinnedOrRestrainedOrUnconscious: true,
      ...(g.grapplingWhileTying !== undefined ? { grapplingWhileTying: g.grapplingWhileTying } : {}),
      ...(g.attackerIsHumanoid !== undefined ? { attackerIsHumanoid: g.attackerIsHumanoid } : {}),
      ...(g.attackerFreeHands !== undefined ? { attackerFreeHands: g.attackerFreeHands } : {}),
      attackerCmbForDc: g.attackerCmbForDc ?? attackerCmb,
      ...(g.targetCmbForEscape !== undefined ? { targetCmbForEscape: g.targetCmbForEscape } : {}),
    });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    checkForCard = { total: res.check.total, cmdEffective: res.check.cmdEffective, margin: res.check.margin, success: res.success, notes: res.notes };
  } else if (kind === "grapple-escape") {
    const g = params.grappleOpts;
    if (g?.escapeBonus === undefined) return { ok: false, error: "grapple escape requires escapeBonus" };
    // For escape we don't use the maneuver die — the die is the escape check's die, which we already rolled as `die`.
    // Reuse the rolled die as the escape die, and the escapeBonus as the bonus.
    const res = pf1eGrappleEscape({
      die,
      bonus: g.escapeBonus,
      defenderCmd,
      ...(g.becomeGrappler !== undefined ? { becomeGrappler: g.becomeGrappler } : {}),
      ...(g.hasHazardBonus !== undefined ? { hasHazardBonus: g.hasHazardBonus } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const p = planGrappleEscape({
      escaper: attacker,
      grappler: defender,
      die,
      bonus: g.escapeBonus,
      defenderCmd,
      ...(g.becomeGrappler !== undefined ? { becomeGrappler: g.becomeGrappler } : {}),
      ...(g.hasHazardBonus !== undefined ? { hasHazardBonus: g.hasHazardBonus } : {}),
    });
    if (!p.ok) return { ok: false, error: p.error };
    plan = p.plan;
    // Escape has no CMB check in the same sense, so we report the escape's total
    checkForCard = { total: die + g.escapeBonus, cmdEffective: defenderCmd, margin: die + g.escapeBonus - defenderCmd, success: res.success, notes: res.notes };
  } else {
    return { ok: false, error: `unsupported maneuver kind: ${kind}` };
  }

  if (!plan || !checkForCard) return { ok: false, error: "maneuver produced no plan" };
  const cardId = post(plan, checkForCard);
  return { ok: true, plan, aooDamage, cardId };
}
