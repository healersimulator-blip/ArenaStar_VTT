/**
 * PF1e tactical cast flow (P5/C02, D-156) — the UI-side orchestration that
 * turns one spell description and one chosen target into public chat rolls, a
 * resolution card, the slot/preparation bookkeeping and authoritative HP
 * writes. Every rule lives in `src/packages/pf1e/casting.ts` (pure, D-149);
 * this module only orchestrates the wire, mirroring the attack flow:
 *
 * 1. every die rides the §11 machinery (`client.roll`, host-evaluated, read
 *    back from the replicated roll message — nothing is rolled client-side);
 * 2. the DC comes from the derived `spellSaveDc` table (key ability, ability
 *    damage, effects and any authored DC bonus already folded in);
 * 3. SR is a caster-level check with no natural-die special cases (D-149),
 *    overcome once per round per (caster, target) via the combat-document
 *    ledger in `srLedger.ts`;
 * 4. `resolveSpellTarget` composes severity, evasion, and the shared energy
 *    pipeline (save halves first, then ER — the D-149 order);
 * 5. the slot spend and prepared-spell expense reuse the D-155 spellbook edit
 *    builders, so ownership, validation and diff shape are that module's;
 * 6. the HP write goes through `pf1eSheetEdit` — a resolver without
 *    permission narrates but cannot write;
 * 7. touch spells (D-158) ride the same wire: the touch attack is part of the
 *    casting, a missed melee touch holds the charge on the actor document,
 *    and `resolveTouchDelivery` delivers it through the shared effect
 *    pipeline (`runSpellEffect`) that both paths consume. D-159 extends it:
 *    willing targets are auto-touched (no attack roll), a natural 20
 *    threatens and the confirmation roll rides all the same modifiers; a
 *    confirmed critical doubles the rolled damage (×2) before SR/save.
 *    D-161 adds multi-round casting: `castingTime: "longer"` begins the
 *    spell now (slot + prepared row spent, effect rides
 *    `system.pf1e.pendingCast`), `resolvePendingCompletion` fires it just
 *    before the caster's next turn, and `resolvePendingDisruption` resolves
 *    damage taken mid-casting (DC 10 + damage + spell level).
 *    D-162 completes the held-charge consumers: a held charge carries a
 *    `charges` count for multi-touch spells (Chill Touch holds one per
 *    caster level), `resolveChargeAllyTouches` touches up to six willing
 *    allies as a full-round action, and `resolveChargeWeaponRelease`
 *    discharges through a normal unarmed/natural weapon attack — normal
 *    attack bonus vs normal AC, weapon damage plus the spell's full
 *    resolution on a hit, the charge kept on a miss.
 *    D-163 wires swift/quickened timing (Rules IDs 157/158): a swift- or
 *    free-time cast, or a GM-declared quickened one, spends the caster
 *    combatant's per-turn swift action through the D-131 ledger ("only one
 *    such spell in any round"), is refused by name when the swift action is
 *    gone, and narrates the no-attack-of-opportunity timing on the card.
 */
import type { Op } from "../../core/ops";
import type { PermissionUser } from "../../core/ownership";
import type {
  ActorDocument,
  CombatDocument,
  Json,
  MessageDocument,
} from "../../core/documents";
import type { PF1eDerived } from "../../packages/pf1e/actor";
import {
  PF1E_SAVE_SEVERITIES,
  resolveSpellTarget,
  spellResistanceCheck,
  type PF1eSaveSeverity,
  type PF1eSaveType,
  type PF1eSpellTargetResult,
  type PF1eSrResult,
} from "../../packages/pf1e/casting";
import {
  PF1E_ENERGY_TYPES,
  type PF1eEnergyType,
} from "../../packages/pf1e/healthState";
import { hasPF1eFeat } from "../../packages/pf1e/feats";
import {
  arcaneSpellFailureChance,
  checkCastingLegality,
  componentNeeds,
  parseSpellComponents,
  resolveCastingAttempt,
  type PF1eCasterState,
  type PF1eCastingTime,
  type PF1eConcentrationTrigger,
  type PF1eSpellTradition,
} from "../../packages/pf1e/concentration";
import {
  srAlreadyOvercome,
  srOvercomeBlobFromFlags,
  srOvercomeDiff,
} from "../../packages/pf1e/srLedger";
import {
  pendingCastDiff,
  pendingCastFromSystem,
} from "../../packages/pf1e/pendingCast";
import {
  PF1E_ALLY_TOUCH_MAX,
  PF1E_HELD_CHARGE_MAX_CHARGES,
  consumeHeldCharge,
  consumeHeldCharges,
  criticalDamageTotal,
  heldChargeCount,
  heldChargeDiff,
  heldChargeFromSystem,
  resolveTouchAttack,
  touchCriticalNeedsConfirmation,
} from "../../packages/pf1e/touchSpell";
import { pf1eSheetEdit, sheetRecord, isPF1eActor } from "./pf1eSheetModel";
import { pf1eSpellbookEdit } from "./pf1eSpellbook";
import { awaitRollMessage, dieFaceOf } from "./pf1eResolveFlow";
import { can } from "../../core/permissions";
import {
  readCombatantState,
  spendCombatantAction,
} from "../../packages/pf1e/combatState";
import { actionRefusal } from "../../packages/pf1e/actions";

/** The structural slice of ClientSync the flow needs (tests fake exactly this). */
export interface CastFlowClient {
  roll(formula: string, mode?: "roll", to?: string[], flavor?: string): string;
  readonly store: { getAll(coll: "messages"): readonly unknown[] };
  submit(ops: Op[]): string;
}

export interface PF1eCastFlowParams {
  casterActor: ActorDocument;
  casterDerived: PF1eDerived;
  spell: {
    name: string;
    /** Spell level for the DC (0–9). */
    level: number;
    /** The slot level to expend; defaults to the spell level. */
    slotLevel?: number;
    /** Prepared-caster row to expend with the cast. */
    preparedIndex?: number;
  };
  authored: {
    saveType: PF1eSaveType;
    severity: PF1eSaveSeverity;
    /** NdM dice, or "" for a spell that deals no damage. */
    damageFormula: string;
    energyType?: PF1eEnergyType;
  };
  targetName: string;
  targetActor: ActorDocument;
  targetDerived: PF1eDerived;
  /** The target's authored feats/features (Evasion is read, never activated). */
  targetFeats?: readonly string[];
  /** The active encounter; the round-scoped SR ledger rides its flags. */
  combat?: CombatDocument | null;
  /** Manual GM adjudication that SR was already overcome this round. */
  srOvercomeByCaller?: boolean;
  /**
   * The C03a pre-save gate (D-157): components/legality, arcane spell
   * failure, deafened spoilage and concentration, resolved through D-150's
   * `resolveCastingAttempt`. Absent (or an empty `components` line) skips
   * the gate entirely, exactly as before D-157.
   */
  gate?: PF1eCastGateInput;
  /**
   * Touch delivery (D-158): the touch attempt rides the casting ("you cast
   * the spell and then touch the subject"). `"melee"` misses hold the
   * charge; `"ranged"` misses spend the spell ("ranged touch attacks cannot
   * be held"). Absent = a normal, non-touch spell.
   */
  touch?: "melee" | "ranged";
  /**
   * The GM declares the target willing (or the caster touching themselves):
   * "You can automatically touch one friend or use the spell on yourself"
   * (D-159) — the touch attack is skipped entirely. Ignored without `touch`.
   */
  willing?: boolean;
  /**
   * The casting time the GM declares (D-161). `"longer"` (1 round or more)
   * begins the casting now — the slot and prepared row are spent, the effect
   * is deferred to just before the caster's next turn and rides the actor
   * document as `pendingCast` (Rules ID 147). Absent = an immediate cast.
   */
  castingTime?: PF1eCastingTime;
  /**
   * Charges for a multi-touch spell held on a melee miss (D-162): spells
   * like Chill Touch deliver "up to one time per level" (CRB pg. 255), so
   * the held charge carries a count. Ignored unless `touch === "melee"` —
   * validated and refused by name otherwise (a ranged touch cannot be held).
   * Absent or 1 = an ordinary single-delivery touch spell.
   */
  charges?: number;
  /**
   * D-163: the GM declares the spell quickened (Quicken Spell feat). The
   * casting rides the turn's swift action — "You can cast a quickened spell
   * ... as a swift action. Only one such spell can be cast in any round, and
   * such spells don't count toward your normal limit of one spell per round"
   * (Rules ID 158) — and provokes no attack of opportunity. Refused for a
   * casting time of 1 round or more.
   */
  quickened?: boolean;
  /**
   * D-163: the caster's combatant in `combat`, whose per-turn action ledger
   * (`flags.pf1e.actions`) gates and records the swift-action spend of a
   * swift/free/quickened cast. Without both, swift usage is the GM's call.
   */
  combatantId?: string;
}

/**
 * A concentration trigger as the caller declares it — without the die, which
 * the flow rolls on the host (one d20 per trigger, like every other die).
 */
export type PF1eConcentrationDeclaration =
  | { situation: "castDefensively" }
  | { situation: "injured"; damage: number }
  | { situation: "continuousDamage"; damage: number }
  | { situation: "nonDamagingSpell"; spellDc: number }
  | { situation: "grappledOrPinned"; grapplerCmb: number }
  | {
      situation:
        | "vigorousMotion"
        | "violentMotion"
        | "extremelyViolentMotion"
        | "windRainSleet"
        | "windHailDebris"
        | "entangled";
    };

export interface PF1eCastGateInput {
  /** The spell's Components line, e.g. "V, S, M/DF". */
  components: string;
  /** The situation the GM declares for this casting. */
  caster: PF1eCasterState;
  castingTime: PF1eCastingTime;
  /** Concentration triggers to resolve; each gets its own host d20. */
  declarations?: readonly PF1eConcentrationDeclaration[];
}

/** The caster's authored tradition: "arcane" unless the actor says divine. */
function spellsTraditionOf(actor: ActorDocument): PF1eSpellTradition {
  const pf1e = sheetRecord((actor.system as Record<string, unknown>).pf1e);
  const spells = pf1e ? sheetRecord(pf1e.spells) : null;
  return spells?.tradition === "divine" ? "divine" : "arcane";
}

/**
 * The authored armour's arcane spell failure percentage, or null when absent
 * or out of range (a refused value is not a guessed one).
 */
function armorSpellFailureOf(actor: ActorDocument): number | null {
  const pf1e = sheetRecord((actor.system as Record<string, unknown>).pf1e);
  const armor = pf1e ? sheetRecord(pf1e.armor) : null;
  const chance = armor?.spellFailure;
  if (
    typeof chance !== "number" ||
    !Number.isFinite(chance) ||
    chance < 0 ||
    chance > 100
  )
    return null;
  return chance;
}

/** The declared touch attempt on the cast card (D-158, extended by D-159). */
export interface PF1eCastTouchSummary {
  kind: "melee" | "ranged";
  /** The touch attack's total; null for a willing auto-touch (no roll). */
  total: number | null;
  hit: boolean;
  threat: boolean;
  /** Willing auto-touch — "you can automatically touch one friend". */
  auto?: boolean;
  /** A confirmed critical hit; the rolled damage was doubled (×2). */
  critical?: boolean;
}

export type PF1eCastFlowOutcome =
  | {
      ok: true;
      /** A ruined spell still spends its slot but produces no effect rolls. */
      lost: false;
      /** True only on the held-charge variant below. */
      held: false;
      /** True only on the pending variant below. */
      pending?: undefined;
      dc: number;
      sr: PF1eSrResult;
      result: Extract<PF1eSpellTargetResult, { ok: true }>;
      /** Over-budget slot spends and similar MVP warnings (allowed, reported). */
      warnings: string[];
      /** Narration from the C03a gate's checks (empty without a gate). */
      gateNotes: string[];
      hpWriteError: string | null;
      /** The touch attack that delivered the spell, when one was declared. */
      touch?: PF1eCastTouchSummary;
    }
  | {
      ok: true;
      /** The gate ruined the spell: slot spent, no effect, the card says why. */
      lost: true;
      held: false;
      pending?: undefined;
      warnings: string[];
      gateNotes: string[];
      touch?: PF1eCastTouchSummary;
    }
  | {
      ok: true;
      lost: false;
      /** The melee touch missed: the spell is spent and the charge held. */
      held: true;
      pending?: undefined;
      warnings: string[];
      gateNotes: string[];
      touch: PF1eCastTouchSummary & { kind: "melee"; hit: false };
      touchAc: number;
    }
  | {
      ok: true;
      lost: false;
      held: false;
      /**
       * Multi-round casting (D-161): the spell began; slot and prepared row
       * are spent, the effect rides `system.pf1e.pendingCast` until just
       * before the caster's next turn.
       */
      pending: true;
      pendingSpell: { name: string; level: number };
      warnings: string[];
      gateNotes: string[];
    }
  | { ok: false; error: string };

const DAMAGE_FORMULA = /^(\d+)[dD](\d+)$/;

/** Authored prepared row at `index`, or null when absent/malformed. */
function preparedRowAt(
  actor: ActorDocument,
  index: number,
): Record<string, unknown> | null {
  const pf1e = sheetRecord((actor.system as Record<string, unknown>).pf1e);
  const spells = pf1e ? sheetRecord(pf1e.spells) : null;
  const prepared = spells?.prepared;
  if (!Array.isArray(prepared)) return null;
  const row = prepared[index];
  return sheetRecord(row);
}

/** The effect pipeline's inputs: everything after the touch has landed. */
interface SpellEffectInput {
  casterActor: ActorDocument;
  casterDerived: PF1eDerived;
  spellName: string;
  authored: {
    saveType: PF1eSaveType;
    severity: PF1eSaveSeverity;
    damageFormula: string;
    energyType?: PF1eEnergyType;
  };
  dc: number;
  targetName: string;
  targetActor: ActorDocument;
  targetDerived: PF1eDerived;
  targetFeats?: readonly string[];
  combat?: CombatDocument | null | undefined;
  srOvercomeByCaller?: boolean;
  /**
   * A confirmed critical hit (D-159): the rolled damage total is doubled
   * (×2, Rules ID 131) before SR/save/energy-resistance composition.
   */
  critical?: boolean;
  /**
   * D-162: the unarmed/natural release adds its weapon damage ON TOP of the
   * spell's composition, so the flow must not write the spell-only HP — the
   * caller applies one combined write. The SR-ledger op is still emitted.
   */
  skipHpWrite?: boolean;
}

type SpellEffectResult =
  | {
      ok: true;
      /** State writes (SR ledger + HP), to be batched by the caller. */
      ops: Op[];
      sr: PF1eSrResult;
      saveBonus: number;
      saveTotal: number | null;
      result: Extract<PF1eSpellTargetResult, { ok: true }>;
      hpWriteError: string | null;
    }
  | { ok: false; error: string };

/**
 * The shared effect pipeline (D-158 extraction of the D-156 body): damage
 * roll → SR check → saving throw → authoritative composition → SR-ledger and
 * HP writes. Used by both the cast flow and held-charge delivery, so the two
 * cannot drift apart.
 */
async function runSpellEffect(
  client: CastFlowClient,
  user: PermissionUser | null,
  input: SpellEffectInput,
): Promise<SpellEffectResult> {
  const fail = (error: string): SpellEffectResult => ({ ok: false, error });
  const ops: Op[] = [];
  const { authored, casterDerived, spellName } = input;

  let damageTotal = 0;
  if (authored.damageFormula !== "") {
    const match = DAMAGE_FORMULA.exec(authored.damageFormula.trim());
    if (!match)
      return fail(
        `Damage "${authored.damageFormula}": use NdM with 1–100 dice and 2–1000 sides, or leave empty for a spell that deals no damage.`,
      );
    const dice = Number(match[1]);
    const sides = Number(match[2]);
    if (!(dice >= 1 && dice <= 100 && sides >= 2 && sides <= 1000))
      return fail("Damage dice must be NdM with 1–100 dice and 2–1000 sides.");
    const rollId = client.roll(
      authored.damageFormula,
      "roll",
      undefined,
      `${spellName} damage`,
    );
    const message = await awaitRollMessage(client, rollId);
    if (
      message === null ||
      message.roll === null ||
      typeof message.roll.total !== "number"
    )
      return fail("The damage roll message carries no total.");
    damageTotal = Math.max(0, Math.trunc(message.roll.total));
    if (input.critical === true) damageTotal = criticalDamageTotal(damageTotal);
  }

  // ── spell resistance (once per round per target; no natural-die cases) ───
  const spellResistance = input.targetDerived.spellResistance;
  const round =
    input.combat && input.combat.round >= 1 ? input.combat.round : null;
  const blob =
    input.combat !== null && input.combat !== undefined
      ? srOvercomeBlobFromFlags(input.combat.flags)
      : null;
  const reused =
    input.srOvercomeByCaller === true ||
    (round !== null &&
      blob !== null &&
      srAlreadyOvercome(
        blob,
        input.casterActor._id,
        input.targetActor._id,
        round,
      ));
  let sr: PF1eSrResult = {
    resisted: false,
    total: null,
    reused: false,
    issues: [],
  };
  if (spellResistance > 0) {
    if (reused) {
      sr = { resisted: false, total: null, reused: true, issues: [] };
    } else {
      const rollId = client.roll(
        "1d20",
        "roll",
        undefined,
        `${spellName} caster level check vs SR ${spellResistance}`,
      );
      const message = await awaitRollMessage(client, rollId);
      if (message === null) return fail("The SR check roll never replicated.");
      const srDie = dieFaceOf(message);
      if (srDie === null)
        return fail("Could not read the SR check's d20 face.");
      sr = spellResistanceCheck({
        die: srDie,
        casterLevel: casterDerived.spellCasterLevel,
        spellResistance,
      });
      if (sr.issues.length > 0)
        return fail(
          sr.issues.map((i) => `${i.field}: ${i.message}`).join("; "),
        );
    }
  }

  // ── the saving throw (only when the spell allows one and SR did not block) ─
  let saveDie: number | undefined;
  let saveTotal: number | null = null;
  const allowsSave = authored.severity !== "none" && !sr.resisted;
  const saveBonus =
    authored.saveType === "fort"
      ? input.targetDerived.saves.fort
      : authored.saveType === "ref"
        ? input.targetDerived.saves.ref
        : input.targetDerived.saves.will;
  if (allowsSave) {
    const rollId = client.roll(
      "1d20",
      "roll",
      undefined,
      `${input.targetName} ${authored.saveType} save vs ${spellName}`,
    );
    const message = await awaitRollMessage(client, rollId);
    if (message === null) return fail("The saving throw never replicated.");
    const face = dieFaceOf(message);
    if (face === null)
      return fail("Could not read the saving throw's d20 face.");
    saveDie = face;
    saveTotal = face + saveBonus;
  }

  // ── the authoritative composition (D-149 pipeline, unmodified) ───────────
  const energyResistance = Object.fromEntries(
    Object.entries(input.targetDerived.energyResistance).filter(
      ([, v]) => v > 0,
    ),
  );
  const target = resolveSpellTarget({
    damage: damageTotal,
    ...(authored.energyType !== undefined
      ? { energyType: authored.energyType }
      : {}),
    severity: authored.severity,
    saveType: authored.saveType,
    dc: input.dc,
    saveBonus,
    ...(saveDie !== undefined ? { saveDie } : {}),
    evasion: hasPF1eFeat(input.targetFeats, "Evasion"),
    improvedEvasion: hasPF1eFeat(input.targetFeats, "Improved Evasion"),
    defender:
      Object.keys(energyResistance).length > 0 ? { energyResistance } : {},
    ...(spellResistance > 0 ? { sr } : {}),
  });
  if (!target.ok) return fail(target.error);

  // The round-scoped SR ledger rides the combat document's flags.
  if (
    sr.resisted === false &&
    sr.reused === false &&
    sr.total !== null &&
    round !== null
  ) {
    ops.push({
      kind: "update",
      ref: { coll: "combats", id: (input.combat as CombatDocument)._id },
      diff: srOvercomeDiff(input.casterActor._id, input.targetActor._id, round),
    });
  }

  // ── the HP write (permission-checked; a refused write is narrated) ────────
  let hpWriteError: string | null = null;
  if (target.dealt > 0 && input.skipHpWrite !== true) {
    const after = input.targetDerived.hp - target.dealt;
    const edit = pf1eSheetEdit(input.targetActor, user, "hp", String(after));
    if (edit.error !== null) hpWriteError = edit.error;
    else ops.push(...edit.ops);
  }

  return {
    ok: true,
    ops,
    sr,
    saveBonus,
    saveTotal,
    result: target,
    hpWriteError,
  };
}

/**
 * Resolve one tactical cast end to end. All dice are host-evaluated public
 * rolls; all writes are Ops through the sheet's own validated paths.
 */
export async function resolveCastFlow(
  client: CastFlowClient,
  user: PermissionUser | null,
  params: PF1eCastFlowParams,
): Promise<PF1eCastFlowOutcome> {
  const fail = (error: string): PF1eCastFlowOutcome => ({ ok: false, error });

  // ── validation: nothing is rolled before the cast is well-formed ─────────
  const { casterDerived, authored, spell } = params;
  if (!casterDerived.casting)
    return fail("This actor has no spellcasting data.");
  if (!Number.isInteger(spell.level) || spell.level < 0 || spell.level > 9)
    return fail("Spell level must be an integer 0–9.");
  const slotLevel = spell.slotLevel ?? spell.level;
  if (!Number.isInteger(slotLevel) || slotLevel < 0 || slotLevel > 9)
    return fail("Slot level must be an integer 0–9.");
  const dc = casterDerived.spellSaveDc[spell.level];
  if (dc === null || dc === undefined)
    return fail(
      `No DC for level ${spell.level}: the caster has no slots at that level.`,
    );
  if (
    authored.saveType !== "fort" &&
    authored.saveType !== "ref" &&
    authored.saveType !== "will"
  )
    return fail(`Unknown save type "${String(authored.saveType)}".`);
  if (!(PF1E_SAVE_SEVERITIES as readonly string[]).includes(authored.severity))
    return fail(`Unknown save severity "${String(authored.severity)}".`);
  if (
    authored.energyType !== undefined &&
    !(PF1E_ENERGY_TYPES as readonly string[]).includes(authored.energyType)
  )
    return fail(`Unknown energy type "${String(authored.energyType)}".`);
  // D-162: charges belong to a held melee touch — nothing else can hold them.
  if (params.charges !== undefined) {
    if (params.touch !== "melee")
      return fail(
        "Charges apply only to a melee touch spell that can be held; ranged touch attacks cannot be held.",
      );
    if (
      !Number.isInteger(params.charges) ||
      params.charges < 1 ||
      params.charges > PF1E_HELD_CHARGE_MAX_CHARGES
    )
      return fail(
        `Charges must be an integer 1–${String(PF1E_HELD_CHARGE_MAX_CHARGES)}.`,
      );
  }

  // ── D-163 swift/quickened timing (Rules IDs 157/158): a swift- or free-time
  //    cast, or a quickened one, rides the turn's swift action — "You can
  //    perform only one single swift action per turn" — and the ledger is the
  //    "only one such spell in any round" gate. The spend is computed here
  //    (before any bookkeeping or die) but lands with the batched ops below. ──
  if (params.quickened === true && params.castingTime === "longer")
    return fail(
      "A quickened spell comes into effect as a swift action this round — it cannot use a casting time of 1 round or more.",
    );
  const swiftTiming =
    params.quickened === true ||
    params.castingTime === "swift" ||
    params.castingTime === "free";
  let swiftSpendCombat: CombatDocument | null = null;
  if (
    swiftTiming &&
    params.combat !== null &&
    params.combat !== undefined &&
    params.combatantId !== undefined
  ) {
    const member = params.combat.combatants.find(
      (c) => c._id === params.combatantId,
    );
    if (member !== undefined) {
      const refusal = actionRefusal(readCombatantState(member).actions, {
        kind: "swift",
        action: "cast-quickened",
      });
      if (refusal !== null)
        return fail(
          `Cannot cast "${spell.name}" as a swift action: ${refusal}.`,
        );
      const spent = spendCombatantAction(params.combat, params.combatantId, {
        kind: "swift",
        action: "cast-quickened",
      });
      if (!spent.ok)
        return fail(
          `Cannot cast "${spell.name}" as a swift action: ${spent.error}.`,
        );
      swiftSpendCombat = spent.value;
    }
  }

  // ── the C03a gate, diceless half (D-157): an illegal casting is refused
  //    before any die rolls and spends nothing ──────────────────────────────
  const gate = params.gate;
  const gateActive = gate !== undefined && gate.components.trim() !== "";
  let gateTradition: PF1eSpellTradition = "arcane";
  let gateNeedsSomatic = false;
  if (gateActive && gate !== undefined) {
    gateTradition = spellsTraditionOf(params.casterActor);
    const parsed = parseSpellComponents(gate.components);
    if (!parsed.ok)
      return fail(
        `Components "${gate.components}": ${parsed.issues
          .map((i) => `${i.field}: ${i.message}`)
          .join("; ")}`,
      );
    const needs = componentNeeds(parsed.segments, gateTradition);
    gateNeedsSomatic = needs.codes.includes("S");
    const legality = checkCastingLegality({
      needs,
      caster: gate.caster,
      castingTime: gate.castingTime,
    });
    if (!legality.legal)
      return fail(
        `Cannot cast "${spell.name}": ${legality.reasons.join("; ")}.`,
      );
  }

  // ── the daily bookkeeping, validated BEFORE any die is rolled so a refused
  //    cast publishes nothing: slot spend + prepared expense (D-155 builders) ──
  const warnings: string[] = [];
  const ops: Op[] = [];
  if (swiftSpendCombat !== null) {
    ops.push({
      kind: "update",
      ref: { coll: "combats", id: swiftSpendCombat._id },
      diff: { combatants: swiftSpendCombat.combatants as unknown as Json[] },
    });
  }
  if (swiftTiming) {
    warnings.push(
      params.quickened === true
        ? "cast as a quickened swift action — does not provoke attacks of opportunity and does not count against the one-spell-per-round limit"
        : "cast as a swift action — does not provoke attacks of opportunity",
    );
  }
  const spend = pf1eSpellbookEdit(params.casterActor, casterDerived, user, {
    kind: "spend",
    level: slotLevel,
  });
  if (spend.error !== null) return fail(spend.error);
  if (spend.warning !== null) warnings.push(spend.warning);
  ops.push(...spend.ops);
  if (spell.preparedIndex !== undefined) {
    const row = preparedRowAt(params.casterActor, spell.preparedIndex);
    if (row === null) return fail("That prepared spell no longer exists.");
    if (row.expended === true)
      return fail(
        `"${spell.name}" is already expended — restore it before casting it again.`,
      );
    const expend = pf1eSpellbookEdit(params.casterActor, casterDerived, user, {
      kind: "preparedToggle",
      index: spell.preparedIndex,
    });
    if (expend.error !== null) return fail(expend.error);
    ops.push(...expend.ops);
  }

  // ── the C03a gate, dice half (D-157): arcane spell failure, deafened
  //    spoilage and concentration. A ruined spell still spends its slot —
  //    "you lose the spell just as if you had cast it to no effect" ─────────
  let gateNotes: string[] = [];
  if (gateActive && gate !== undefined) {
    const armorChance = armorSpellFailureOf(params.casterActor);
    const gearInput =
      gateTradition === "arcane" && armorChance !== null
        ? { armor: { chance: armorChance } }
        : {};
    const asf = arcaneSpellFailureChance({
      ...gearInput,
      hasSomatic: gateNeedsSomatic,
    });
    if (asf.issues.length > 0)
      return fail(asf.issues.map((i) => `${i.field}: ${i.message}`).join("; "));
    let arcaneDie: number | undefined;
    if (asf.applies) {
      const rollId = client.roll(
        "1d100",
        "roll",
        undefined,
        `${spell.name} arcane spell failure (${asf.chance}%)`,
      );
      const message = await awaitRollMessage(client, rollId);
      if (message === null)
        return fail("The arcane spell failure roll never replicated.");
      const face = dieFaceOf(message);
      if (face === null)
        return fail("Could not read the arcane spell failure d100 face.");
      arcaneDie = face;
    }
    let deafenedDie: number | undefined;
    if (gate.caster.deafened === true) {
      // Parsing already succeeded above, so this cannot fail here.
      const needs = componentNeeds(
        parseSpellComponents(gate.components).segments,
        gateTradition,
      );
      if (needs.mustSpeak) {
        const rollId = client.roll(
          "1d100",
          "roll",
          undefined,
          `${spell.name} deafened spoilage (20%)`,
        );
        const message = await awaitRollMessage(client, rollId);
        if (message === null)
          return fail("The deafened spoilage roll never replicated.");
        const face = dieFaceOf(message);
        if (face === null)
          return fail("Could not read the deafened spoilage d100 face.");
        deafenedDie = face;
      }
    }
    const triggers: PF1eConcentrationTrigger[] = [];
    for (const declaration of gate.declarations ?? []) {
      const rollId = client.roll(
        "1d20",
        "roll",
        undefined,
        `${spell.name} concentration (${declaration.situation})`,
      );
      const message = await awaitRollMessage(client, rollId);
      if (message === null)
        return fail(
          `The concentration roll (${declaration.situation}) never replicated.`,
        );
      const face = dieFaceOf(message);
      if (face === null)
        return fail(
          `Could not read the concentration d20 face (${declaration.situation}).`,
        );
      switch (declaration.situation) {
        case "injured":
          triggers.push({
            situation: "injured",
            damage: declaration.damage,
            die: face,
          });
          break;
        case "continuousDamage":
          triggers.push({
            situation: "continuousDamage",
            damage: declaration.damage,
            die: face,
          });
          break;
        case "nonDamagingSpell":
          triggers.push({
            situation: "nonDamagingSpell",
            spellDc: declaration.spellDc,
            die: face,
          });
          break;
        case "grappledOrPinned":
          triggers.push({
            situation: "grappledOrPinned",
            grapplerCmb: declaration.grapplerCmb,
            die: face,
          });
          break;
        case "vigorousMotion":
          triggers.push({ situation: "vigorousMotion", die: face });
          break;
        case "violentMotion":
          triggers.push({ situation: "violentMotion", die: face });
          break;
        case "extremelyViolentMotion":
          triggers.push({ situation: "extremelyViolentMotion", die: face });
          break;
        case "windRainSleet":
          triggers.push({ situation: "windRainSleet", die: face });
          break;
        case "windHailDebris":
          triggers.push({ situation: "windHailDebris", die: face });
          break;
        case "entangled":
          triggers.push({ situation: "entangled", die: face });
          break;
        case "castDefensively":
          triggers.push({ situation: "castDefensively", die: face });
          break;
      }
    }
    const attempt = resolveCastingAttempt({
      components: gate.components,
      tradition: gateTradition,
      caster: gate.caster,
      castingTime: gate.castingTime,
      spellLevel: spell.level,
      ...gearInput,
      ...(arcaneDie !== undefined ? { arcaneDie } : {}),
      ...(deafenedDie !== undefined ? { deafenedDie } : {}),
      triggers,
      casterLevel: casterDerived.spellCasterLevel,
      keyAbilityMod: casterDerived.abilityMods[casterDerived.spellKeyAbility],
      featBonus: casterDerived.concentration,
    });
    if (!attempt.ok) return fail(attempt.error ?? "The casting gate refused.");
    gateNotes = [...attempt.notes];
    if (attempt.outcome === "lost") {
      const card = castLostCardContent(
        {
          casterName: params.casterActor.name,
          spellName: spell.name,
          spellLevel: spell.level,
        },
        gateNotes,
        warnings,
      );
      const cardMessage: MessageDocument = {
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
        flavor: "cast resolution",
      };
      client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
      if (ops.length > 0) client.submit(ops);
      return { ok: true, lost: true, held: false, warnings, gateNotes };
    }
  }

  // ── held-charge dissipation (D-158): "If you cast another spell, the
  //    touch spell dissipates." Clearing first also lets a new touch spell's
  //    held charge replace it when this cast misses below ───────────────────
  const priorCharge = heldChargeFromSystem(
    params.casterActor.system as Record<string, unknown>,
  );
  if (priorCharge !== null) {
    ops.push({
      kind: "update",
      ref: { coll: "actors", id: params.casterActor._id },
      diff: heldChargeDiff(null),
    });
    warnings.push(
      `the held ${priorCharge.name} charge dissipates as ${spell.name} is cast`,
    );
  }

  // ── multi-round casting (D-161): a spell whose casting time is 1 round ──
  // ── or longer begins now; the effect comes into effect "just before the ──
  // ── beginning of your turn in the round after you began casting" ─────────
  if (params.castingTime === "longer") {
    if (params.touch !== undefined)
      return fail(
        "Touch delivery is not modeled for spells with a casting time of 1 round or more.",
      );
    const priorPending = pendingCastFromSystem(
      params.casterActor.system as Record<string, unknown>,
    );
    if (priorPending !== null) {
      // Concentration maintains one multi-round casting at a time: beginning
      // another spell forfeits the one in progress ("If you lose
      // concentration after starting the spell and before it is complete,
      // you lose the spell.").
      ops.push({
        kind: "update",
        ref: { coll: "actors", id: params.casterActor._id },
        diff: pendingCastDiff(null),
      });
      warnings.push(
        `the pending ${priorPending.name} is lost as ${spell.name} begins`,
      );
    }
    ops.push({
      kind: "update",
      ref: { coll: "actors", id: params.casterActor._id },
      diff: pendingCastDiff({
        name: spell.name,
        level: spell.level,
        ...(slotLevel !== spell.level ? { slotLevel } : {}),
        damageFormula: authored.damageFormula,
        saveType: authored.saveType,
        severity: authored.severity,
        ...(authored.energyType !== undefined
          ? { energyType: authored.energyType }
          : {}),
        targetId: params.targetActor._id,
      }),
    });
    const card = pendingCastCardContent(
      {
        casterName: params.casterActor.name,
        spellName: spell.name,
        spellLevel: spell.level,
        slotLevel,
        targetName: params.targetName,
      },
      warnings,
      gateNotes,
    );
    const cardMessage: MessageDocument = {
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
      flavor: "cast resolution",
    };
    client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
    if (ops.length > 0) client.submit(ops);
    return {
      ok: true,
      lost: false,
      held: false,
      pending: true,
      pendingSpell: { name: spell.name, level: spell.level },
      warnings,
      gateNotes,
    };
  }

  // ── touch delivery (D-158, extended by D-159): the touch attempt is part ─
  // ── of the casting; willing targets are auto-touched, a natural 20 threatens ─
  let touchSummary: PF1eCastTouchSummary | undefined;
  let touchCardLine: string | null = null;
  let touchCritical = false;
  if (params.touch !== undefined) {
    const melee = params.touch === "melee";
    const touchAbility = melee
      ? casterDerived.abilityMods.str
      : casterDerived.abilityMods.dex;
    const touchBonus =
      casterDerived.baseAttack +
      touchAbility +
      casterDerived.sizeEntry.attackAc;
    const touchBonusStr =
      touchBonus >= 0 ? `+ ${touchBonus}` : `- ${Math.abs(touchBonus)}`;
    if (params.willing === true) {
      // "You can automatically touch one friend or use the spell on
      // yourself" — no attack roll is made at all.
      touchSummary = {
        kind: params.touch,
        total: null,
        hit: true,
        threat: false,
        auto: true,
      };
      touchCardLine = `${melee ? "Melee" : "Ranged"} touch: ${params.casterActor.name} touches the willing ${params.targetName} automatically — no attack roll is needed.`;
    } else {
      const rollId = client.roll(
        "1d20",
        "roll",
        undefined,
        `${spell.name} ${melee ? "melee" : "ranged"} touch attack`,
      );
      const message = await awaitRollMessage(client, rollId);
      if (message === null) return fail("The touch attack never replicated.");
      const face = dieFaceOf(message);
      if (face === null)
        return fail("Could not read the touch attack's d20 face.");
      const touch = resolveTouchAttack({
        die: face,
        bonus: touchBonus,
        touchAc: params.targetDerived.ac.touch,
      });
      if (!touch.ok)
        return fail(touch.error ?? "The touch attack was malformed.");
      touchSummary = {
        kind: params.touch,
        total: touch.total,
        hit: touch.hit,
        threat: touch.threat,
      };
      touchCardLine = `${melee ? "Melee" : "Ranged"} touch attack [[${touch.total}|1d20 ${touchBonusStr}]] vs touch AC ${params.targetDerived.ac.touch} — ${touch.hit ? (touch.threat ? "HIT (threatens a critical)" : "hit") : "MISS"}.`;
      if (touch.hit && touch.threat) {
        if (
          touchCriticalNeedsConfirmation(true, authored.damageFormula !== "")
        ) {
          // "another attack roll with all the same modifiers as the attack
          // roll you just made" (Rules ID 131), against the same touch AC.
          const confId = client.roll(
            "1d20",
            "roll",
            undefined,
            `${spell.name} critical confirmation`,
          );
          const confMessage = await awaitRollMessage(client, confId);
          if (confMessage === null)
            return fail("The critical confirmation never replicated.");
          const confFace = dieFaceOf(confMessage);
          if (confFace === null)
            return fail("Could not read the confirmation's d20 face.");
          const conf = resolveTouchAttack({
            die: confFace,
            bonus: touchBonus,
            touchAc: params.targetDerived.ac.touch,
          });
          if (!conf.ok)
            return fail(conf.error ?? "The confirmation roll was malformed.");
          touchCritical = conf.hit;
          touchSummary = { ...touchSummary, critical: conf.hit };
          touchCardLine += ` Critical confirmation [[${conf.total}|1d20 ${touchBonusStr}]] — ${conf.hit ? "CRITICAL HIT (damage doubled)." : "not confirmed (regular hit)."}`;
        } else {
          touchCardLine +=
            " A touch spell that deals no damage cannot score a critical hit.";
        }
      }
    }
    if (touchSummary !== undefined && touchSummary.hit === false) {
      if (melee) {
        // "If you don't discharge the spell in the round when you cast the
        // spell, you can hold the charge."
        ops.push({
          kind: "update",
          ref: { coll: "actors", id: params.casterActor._id },
          diff: heldChargeDiff({
            name: spell.name,
            level: spell.level,
            ...(slotLevel !== spell.level ? { slotLevel } : {}),
            damageFormula: authored.damageFormula,
            saveType: authored.saveType,
            severity: authored.severity,
            ...(authored.energyType !== undefined
              ? { energyType: authored.energyType }
              : {}),
            // D-162: a multi-touch spell holds its full charge count here.
            ...(params.charges !== undefined && params.charges > 1
              ? { charges: params.charges }
              : {}),
          }),
        });
        const card = castTouchMissCardContent(
          {
            casterName: params.casterActor.name,
            spellName: spell.name,
            spellLevel: spell.level,
            targetName: params.targetName,
            ...(params.charges !== undefined && params.charges > 1
              ? { charges: params.charges }
              : {}),
          },
          touchCardLine,
          true,
          warnings,
          gateNotes,
        );
        const cardMessage: MessageDocument = {
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
          flavor: "cast resolution",
        };
        client.submit([
          { kind: "create", coll: "messages", data: cardMessage },
        ]);
        if (ops.length > 0) client.submit(ops);
        return {
          ok: true,
          lost: false,
          held: true,
          warnings,
          gateNotes,
          touch: { ...touchSummary, kind: "melee", hit: false },
          touchAc: params.targetDerived.ac.touch,
        };
      }
      // "Unless otherwise noted, ranged touch attacks cannot be held."
      warnings.push(
        "the ranged touch attack missed — a ranged touch attack cannot be held, so the spell is spent",
      );
      const card = castTouchMissCardContent(
        {
          casterName: params.casterActor.name,
          spellName: spell.name,
          spellLevel: spell.level,
          targetName: params.targetName,
        },
        touchCardLine,
        false,
        warnings,
        gateNotes,
      );
      const cardMessage: MessageDocument = {
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
        flavor: "cast resolution",
      };
      client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
      if (ops.length > 0) client.submit(ops);
      return {
        ok: true,
        lost: true,
        held: false,
        warnings,
        gateNotes,
        touch: touchSummary,
      };
    }
  }

  // ── the effect pipeline (damage → SR → save → composition → HP write) ────
  const effect = await runSpellEffect(client, user, {
    casterActor: params.casterActor,
    casterDerived,
    spellName: spell.name,
    authored,
    dc,
    targetName: params.targetName,
    targetActor: params.targetActor,
    targetDerived: params.targetDerived,
    ...(params.targetFeats !== undefined
      ? { targetFeats: params.targetFeats }
      : {}),
    combat: params.combat,
    ...(params.srOvercomeByCaller !== undefined
      ? { srOvercomeByCaller: params.srOvercomeByCaller }
      : {}),
    ...(touchCritical ? { critical: true } : {}),
  });
  if (!effect.ok) return fail(effect.error);
  ops.push(...effect.ops);
  const { sr, saveBonus, saveTotal, result: target, hpWriteError } = effect;

  // ── the resolution card (public narrative, §11 chips) ─────────────────────
  const card = castResolutionCardContent(
    {
      casterName: params.casterActor.name,
      spellName: spell.name,
      spellLevel: spell.level,
      slotLevel,
      targetName: params.targetName,
      damageFormula: authored.damageFormula,
      saveType: authored.saveType,
      severity: authored.severity,
      hpBefore: params.targetDerived.hp,
      hpAfter: params.targetDerived.hp - target.dealt,
    },
    { dc, sr, saveBonus, saveTotal, result: target },
    warnings,
    hpWriteError,
    gateNotes,
    touchCardLine,
  );
  const cardMessage: MessageDocument = {
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
    flavor: "cast resolution",
  };
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
  if (ops.length > 0) client.submit(ops);
  return {
    ok: true,
    lost: false,
    held: false,
    dc,
    sr,
    result: target,
    warnings,
    gateNotes,
    hpWriteError,
    ...(touchSummary !== undefined ? { touch: touchSummary } : {}),
  };
}

/** The delivery of a held charge (D-158, "Holding the Charge"). */
export interface PF1eTouchDeliveryParams {
  casterActor: ActorDocument;
  casterDerived: PF1eDerived;
  targetName: string;
  targetActor: ActorDocument;
  targetDerived: PF1eDerived;
  /** The target's authored feats/features (Evasion is read, never activated). */
  targetFeats?: readonly string[];
  /** The active encounter; the round-scoped SR ledger rides its flags. */
  combat?: CombatDocument | null;
  /** Manual GM adjudication that SR was already overcome this round. */
  srOvercomeByCaller?: boolean;
  /**
   * The GM declares the target willing: "You can touch one friend as a
   * standard action" (D-159) — no attack roll, the charge discharges.
   */
  willing?: boolean;
}

export type PF1eTouchDeliveryOutcome =
  | {
      ok: true;
      /** The touch attack landed and the held spell took effect. */
      delivered: true;
      dc: number;
      sr: PF1eSrResult;
      result: Extract<PF1eSpellTargetResult, { ok: true }>;
      hpWriteError: string | null;
      /**
       * D-162: deliveries left on a multi-charge held spell after this touch
       * consumed one; absent when the last charge discharged.
       */
      chargesRemaining?: number;
      /** Total is null for a willing auto-touch (no roll was made). */
      touch: {
        total: number | null;
        hit: true;
        threat: boolean;
        auto?: boolean;
        critical?: boolean;
      };
    }
  | {
      ok: true;
      /** The touch missed; the charge is still held. */
      delivered: false;
      chargeName: string;
      touch: { total: number; hit: false; threat: boolean };
      touchAc: number;
    }
  | { ok: false; error: string };

/**
 * Deliver a held touch-spell charge with a melee touch attack. "You can
 * continue to make touch attacks round after round." A miss keeps the charge;
 * a hit runs the same effect pipeline as the cast and clears the charge.
 */
export async function resolveTouchDelivery(
  client: CastFlowClient,
  user: PermissionUser | null,
  params: PF1eTouchDeliveryParams,
): Promise<PF1eTouchDeliveryOutcome> {
  const fail = (error: string): PF1eTouchDeliveryOutcome => ({
    ok: false,
    error,
  });
  if (
    !isPF1eActor(params.casterActor) ||
    !user ||
    !can(user, "update", params.casterActor, "actors")
  )
    return fail("You do not have permission to act for this caster.");
  const charge = heldChargeFromSystem(
    params.casterActor.system as Record<string, unknown>,
  );
  if (charge === null) return fail("There is no held charge to deliver.");
  if (!(PF1E_SAVE_SEVERITIES as readonly string[]).includes(charge.severity))
    return fail(`The held charge's severity "${charge.severity}" is unknown.`);
  if (
    charge.energyType !== undefined &&
    !(PF1E_ENERGY_TYPES as readonly string[]).includes(charge.energyType)
  )
    return fail(
      `The held charge's energy type "${charge.energyType}" is unknown.`,
    );
  const dc = params.casterDerived.spellSaveDc[charge.level];
  if (dc === null || dc === undefined)
    return fail(
      `No DC for the held ${charge.name}: the caster has no slots at level ${charge.level} now.`,
    );

  // The delivery touch attack (D-159): willing targets are auto-touched
  // ("You can touch one friend as a standard action"); a natural 20 threatens
  // and the confirmation rides all the same modifiers against the touch AC.
  const touchBonus =
    params.casterDerived.baseAttack +
    params.casterDerived.abilityMods.str +
    params.casterDerived.sizeEntry.attackAc;
  const touchBonusStr =
    touchBonus >= 0 ? `+ ${touchBonus}` : `- ${Math.abs(touchBonus)}`;
  let deliveryTouch: { total: number; hit: boolean; threat: boolean } | null =
    null;
  let deliveryCritical = false;
  let touchLine: string;
  if (params.willing === true) {
    touchLine = `Melee touch: ${params.casterActor.name} touches the willing ${params.targetName} automatically — no attack roll is needed.`;
  } else {
    const rollId = client.roll(
      "1d20",
      "roll",
      undefined,
      `${charge.name} touch attack (held charge)`,
    );
    const message = await awaitRollMessage(client, rollId);
    if (message === null) return fail("The touch attack never replicated.");
    const face = dieFaceOf(message);
    if (face === null)
      return fail("Could not read the touch attack's d20 face.");
    const touch = resolveTouchAttack({
      die: face,
      bonus: touchBonus,
      touchAc: params.targetDerived.ac.touch,
    });
    if (!touch.ok)
      return fail(touch.error ?? "The touch attack was malformed.");
    deliveryTouch = {
      total: touch.total,
      hit: touch.hit,
      threat: touch.threat,
    };
    touchLine = `Melee touch attack [[${touch.total}|1d20 ${touchBonusStr}]] vs touch AC ${params.targetDerived.ac.touch} — ${touch.hit ? (touch.threat ? "HIT (threatens a critical)" : "hit") : "MISS"}.`;
    if (touch.hit && touch.threat) {
      if (touchCriticalNeedsConfirmation(true, charge.damageFormula !== "")) {
        const confId = client.roll(
          "1d20",
          "roll",
          undefined,
          `${charge.name} critical confirmation (held charge)`,
        );
        const confMessage = await awaitRollMessage(client, confId);
        if (confMessage === null)
          return fail("The critical confirmation never replicated.");
        const confFace = dieFaceOf(confMessage);
        if (confFace === null)
          return fail("Could not read the confirmation's d20 face.");
        const conf = resolveTouchAttack({
          die: confFace,
          bonus: touchBonus,
          touchAc: params.targetDerived.ac.touch,
        });
        if (!conf.ok)
          return fail(conf.error ?? "The confirmation roll was malformed.");
        deliveryCritical = conf.hit;
        touchLine += ` Critical confirmation [[${conf.total}|1d20 ${touchBonusStr}]] — ${conf.hit ? "CRITICAL HIT (damage doubled)." : "not confirmed (regular hit)."}`;
      } else {
        touchLine +=
          " A touch spell that deals no damage cannot score a critical hit.";
      }
    }
  }

  if (deliveryTouch !== null && deliveryTouch.hit === false) {
    // Still holding the charge; nothing is spent, nothing is cleared.
    const card = castHeldDeliveryMissContent(
      {
        casterName: params.casterActor.name,
        spellName: charge.name,
        spellLevel: charge.level,
        targetName: params.targetName,
      },
      touchLine,
    );
    const cardMessage: MessageDocument = {
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
      flavor: "cast resolution",
    };
    client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
    return {
      ok: true,
      delivered: false,
      chargeName: charge.name,
      touch: {
        total: deliveryTouch.total,
        hit: false,
        threat: deliveryTouch.threat,
      },
      touchAc: params.targetDerived.ac.touch,
    };
  }

  // The touch landed: the held spell takes effect. D-162: a multi-charge
  // spell keeps holding `charges − 1`; the last charge clears the path.
  const afterDelivery = consumeHeldCharge(charge);
  if (afterDelivery !== null)
    touchLine += ` Charges remaining: ${String(heldChargeCount(afterDelivery))}.`;
  const authored: PF1eCastFlowParams["authored"] = {
    saveType: charge.saveType,
    severity: charge.severity as PF1eSaveSeverity,
    damageFormula: charge.damageFormula,
    ...(charge.energyType !== undefined
      ? { energyType: charge.energyType as PF1eEnergyType }
      : {}),
  };
  const effect = await runSpellEffect(client, user, {
    casterActor: params.casterActor,
    casterDerived: params.casterDerived,
    spellName: charge.name,
    authored,
    dc,
    targetName: params.targetName,
    targetActor: params.targetActor,
    targetDerived: params.targetDerived,
    ...(params.targetFeats !== undefined
      ? { targetFeats: params.targetFeats }
      : {}),
    combat: params.combat,
    ...(params.srOvercomeByCaller !== undefined
      ? { srOvercomeByCaller: params.srOvercomeByCaller }
      : {}),
    ...(deliveryCritical ? { critical: true } : {}),
  });
  if (!effect.ok) return fail(effect.error);
  const ops: Op[] = [...effect.ops];
  ops.push({
    kind: "update",
    ref: { coll: "actors", id: params.casterActor._id },
    diff: heldChargeDiff(afterDelivery),
  });
  const slotLevel = charge.slotLevel ?? charge.level;
  const card = castResolutionCardContent(
    {
      casterName: params.casterActor.name,
      spellName: charge.name,
      spellLevel: charge.level,
      slotLevel,
      targetName: params.targetName,
      damageFormula: charge.damageFormula,
      saveType: charge.saveType,
      severity: authored.severity,
      hpBefore: params.targetDerived.hp,
      hpAfter: params.targetDerived.hp - effect.result.dealt,
      delivered: true,
    },
    {
      dc,
      sr: effect.sr,
      saveBonus: effect.saveBonus,
      saveTotal: effect.saveTotal,
      result: effect.result,
    },
    [],
    effect.hpWriteError,
    [],
    touchLine,
  );
  const cardMessage: MessageDocument = {
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
    flavor: "cast resolution",
  };
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
  if (ops.length > 0) client.submit(ops);
  return {
    ok: true,
    delivered: true,
    dc,
    sr: effect.sr,
    result: effect.result,
    hpWriteError: effect.hpWriteError,
    ...(afterDelivery !== null
      ? { chargesRemaining: heldChargeCount(afterDelivery) }
      : {}),
    touch: {
      total: deliveryTouch === null ? null : deliveryTouch.total,
      hit: true,
      threat: deliveryTouch === null ? false : deliveryTouch.threat,
      ...(deliveryTouch === null ? { auto: true } : {}),
      ...(deliveryCritical ? { critical: true } : {}),
    },
  };
}

/** The card when a multi-round casting begins (D-161). */
export function pendingCastCardContent(
  ctx: {
    casterName: string;
    spellName: string;
    spellLevel: number;
    slotLevel: number;
    targetName: string;
  },
  warnings: readonly string[],
  gateNotes: readonly string[] = [],
): { name: string; content: string } {
  const slotNote =
    ctx.slotLevel === ctx.spellLevel
      ? `level ${ctx.spellLevel}`
      : `level ${ctx.spellLevel} cast at slot ${ctx.slotLevel}`;
  const lines: string[] = [
    `${ctx.casterName} begins casting ${ctx.spellName} (${slotNote}) at ${ctx.targetName} — it comes into effect just before their next turn.`,
  ];
  for (const note of gateNotes) lines.push(`⚠ ${note}`);
  for (const warning of warnings) lines.push(`⚠ ${warning}`);
  return { name: `${ctx.spellName} begun`, content: lines.join("\n") };
}

/** The card when a pending casting is lost to broken concentration (D-161). */
export function pendingLostCardContent(
  ctx: { casterName: string; spellName: string; spellLevel: number },
  reason: string,
): { name: string; content: string } {
  return {
    name: `${ctx.spellName} lost`,
    content: `${ctx.casterName} loses ${ctx.spellName} (level ${ctx.spellLevel}) before it completes — ${reason}. The slot and preparation were already spent.`,
  };
}

/** The card when a held charge's delivery attempt misses. */
export function castHeldDeliveryMissContent(
  ctx: {
    casterName: string;
    spellName: string;
    spellLevel: number;
    targetName: string;
  },
  touchLine: string,
): { name: string; content: string } {
  const lines: string[] = [
    `${ctx.casterName} tries to deliver the held ${ctx.spellName} (level ${ctx.spellLevel}) at ${ctx.targetName}.`,
    touchLine,
    "The charge is still held.",
  ];
  return {
    name: `${ctx.spellName} delivery miss`,
    content: lines.join("\n"),
  };
}

/** One chat card per cast; chips render as `[[text|title]]`. */
export function castResolutionCardContent(
  ctx: {
    casterName: string;
    spellName: string;
    spellLevel: number;
    slotLevel: number;
    targetName: string;
    damageFormula: string;
    saveType: PF1eSaveType;
    severity: PF1eSaveSeverity;
    hpBefore: number;
    hpAfter: number;
    /** D-158: a delivered held charge narrates differently from a fresh cast. */
    delivered?: boolean;
    /** D-161: a completed multi-round casting narrates its deferred timing. */
    pendingCompleted?: boolean;
  },
  res: {
    dc: number;
    sr: PF1eSrResult;
    saveBonus: number;
    saveTotal: number | null;
    result: Extract<PF1eSpellTargetResult, { ok: true }>;
  },
  warnings: string[],
  hpWriteError: string | null,
  gateNotes: readonly string[] = [],
  touchLine: string | null = null,
): { name: string; content: string } {
  const lines: string[] = [];
  const slotNote =
    ctx.slotLevel === ctx.spellLevel
      ? `level ${ctx.spellLevel}`
      : `level ${ctx.spellLevel} cast at slot ${ctx.slotLevel}`;
  lines.push(
    ctx.pendingCompleted === true
      ? `${ctx.casterName} completes ${ctx.spellName} (${slotNote}) at ${ctx.targetName} — the casting began before this turn — DC ${res.dc}.`
      : ctx.delivered === true
        ? `${ctx.casterName} delivers the held ${ctx.spellName} (${slotNote}) at ${ctx.targetName} — DC ${res.dc}.`
        : `${ctx.casterName} casts ${ctx.spellName} (${slotNote}) at ${ctx.targetName} — DC ${res.dc}.`,
  );
  for (const note of gateNotes) lines.push(`⚠ ${note}`);
  if (touchLine !== null) lines.push(touchLine);
  if (res.sr.reused) {
    lines.push("Spell resistance was already overcome this round — no check.");
  } else if (res.sr.total !== null) {
    lines.push(
      `SR check [[${res.sr.total}|1d20 + caster level]] — ${
        res.sr.resisted
          ? "RESISTED: the spell does not affect the target"
          : "overcome"
      }.`,
    );
  }
  if (ctx.severity === "none" && !res.result.resisted) {
    lines.push("No saving throw is allowed — the effect applies in full.");
  } else if (res.saveTotal !== null) {
    const automatic =
      res.result.automatic === "failure"
        ? " (natural 1 — always a failure)"
        : res.result.automatic === "success"
          ? " (natural 20 — always a success)"
          : "";
    lines.push(
      `${ctx.saveType.toUpperCase()} save [[${res.saveTotal}|1d20 ${
        res.saveBonus >= 0
          ? `+ ${res.saveBonus}`
          : `- ${Math.abs(res.saveBonus)}`
      }]] vs DC ${res.dc} — ${res.result.passed ? "passes" : "fails"}${automatic}.`,
    );
  }
  for (const note of res.result.notes) lines.push(note);
  if (ctx.damageFormula !== "") {
    const bits: string[] = [
      `[[${res.result.dealt}|${ctx.damageFormula}]] damage dealt`,
    ];
    if (res.result.saveReduced > 0)
      bits.push(`the save removed ${res.result.saveReduced}`);
    const er = Object.entries(res.result.erApplied)
      .map(([type, amount]) => `${type} resistance absorbed ${String(amount)}`)
      .join(", ");
    if (er !== "") bits.push(er);
    lines.push(`${bits.join("; ")}.`);
  }
  if (ctx.hpAfter !== ctx.hpBefore) {
    lines.push(
      `${ctx.targetName} ${String(ctx.hpBefore)} → ${String(ctx.hpAfter)} HP.`,
    );
  }
  for (const warning of warnings) lines.push(`⚠ ${warning}`);
  if (hpWriteError !== null) lines.push(`⚠ HP write rejected: ${hpWriteError}`);
  return { name: `${ctx.spellName} cast`, content: lines.join("\n") };
}

/**
 * The card for a ruined spell (D-157): the slot is spent, the spell is lost
 * "as if cast to no effect", and the table reads which check did it.
 */
export function castLostCardContent(
  ctx: { casterName: string; spellName: string; spellLevel: number },
  gateNotes: readonly string[],
  warnings: readonly string[],
): { name: string; content: string } {
  const lines: string[] = [
    `${ctx.casterName} loses ${ctx.spellName} (level ${ctx.spellLevel}) — the spell is ruined and spent to no effect.`,
  ];
  for (const note of gateNotes) lines.push(note);
  for (const warning of warnings) lines.push(`⚠ ${warning}`);
  return { name: `${ctx.spellName} lost`, content: lines.join("\n") };
}

/**
 * The card for a missed touch attack (D-158). For a melee touch the charge is
 * held ("you can hold the charge indefinitely"); for a ranged touch the spell
 * is simply spent ("ranged touch attacks cannot be held").
 */
export function castTouchMissCardContent(
  ctx: {
    casterName: string;
    spellName: string;
    spellLevel: number;
    targetName: string;
    /** D-162: a multi-touch spell holds more than one delivery. */
    charges?: number;
  },
  touchLine: string | null,
  held: boolean,
  warnings: readonly string[],
  gateNotes: readonly string[] = [],
): { name: string; content: string } {
  const lines: string[] = [
    `${ctx.casterName} casts ${ctx.spellName} (level ${ctx.spellLevel}) at ${ctx.targetName}.`,
  ];
  for (const note of gateNotes) lines.push(`⚠ ${note}`);
  if (touchLine !== null) lines.push(touchLine);
  lines.push(
    held
      ? ctx.charges !== undefined && ctx.charges > 1
        ? `The charge is held with ${ctx.charges} deliveries remaining — each successful touch consumes one; it dissipates if another spell is cast.`
        : "The charge is held — deliver it with a touch attack; it dissipates if another spell is cast."
      : "The spell is spent to no effect.",
  );
  for (const warning of warnings) lines.push(`⚠ ${warning}`);
  return { name: `${ctx.spellName} touch miss`, content: lines.join("\n") };
}

/* ------------------------------------------------------------------ *
 * P5/C03 multi-round casting (D-161): completion and disruption.
 * ------------------------------------------------------------------ */

export interface PF1ePendingCompletionParams {
  casterActor: ActorDocument;
  casterDerived: PF1eDerived;
  /** The target the casting was begun against; must still match. */
  targetName: string;
  targetActor: ActorDocument;
  targetDerived: PF1eDerived;
  targetFeats?: readonly string[];
  combat?: CombatDocument | null;
  srOvercomeByCaller?: boolean;
}

export type PF1ePendingCompletionOutcome =
  | {
      ok: true;
      completed: true;
      dc: number;
      sr: PF1eSrResult;
      result: Extract<PF1eSpellTargetResult, { ok: true }>;
      hpWriteError: string | null;
    }
  | { ok: false; error: string };

/**
 * Complete a pending multi-round casting: "It comes into effect just before
 * the beginning of your turn in the round after you began casting the
 * spell." The slot and prepared row were spent when the casting began, so
 * this only runs the effect pipeline against the original target and clears
 * the pending state.
 */
export async function resolvePendingCompletion(
  client: CastFlowClient,
  user: PermissionUser | null,
  params: PF1ePendingCompletionParams,
): Promise<PF1ePendingCompletionOutcome> {
  const fail = (error: string): PF1ePendingCompletionOutcome => ({
    ok: false,
    error,
  });
  if (
    !isPF1eActor(params.casterActor) ||
    !user ||
    !can(user, "update", params.casterActor, "actors")
  )
    return fail("You do not have permission to act for this caster.");
  const pending = pendingCastFromSystem(
    params.casterActor.system as Record<string, unknown>,
  );
  if (pending === null) return fail("There is no pending casting to complete.");
  if (pending.targetId !== params.targetActor._id)
    return fail(
      `The ${pending.name} was begun at a different target — complete it there or lose the spell.`,
    );
  if (!(PF1E_SAVE_SEVERITIES as readonly string[]).includes(pending.severity))
    return fail(
      `The pending spell's severity "${pending.severity}" is unknown.`,
    );
  if (
    pending.energyType !== undefined &&
    !(PF1E_ENERGY_TYPES as readonly string[]).includes(pending.energyType)
  )
    return fail(
      `The pending spell's energy type "${pending.energyType}" is unknown.`,
    );
  const dc = params.casterDerived.spellSaveDc[pending.level];
  if (dc === null || dc === undefined)
    return fail(
      `No DC for the pending ${pending.name}: the caster has no slots at level ${pending.level} now.`,
    );

  const authored: PF1eCastFlowParams["authored"] = {
    saveType: pending.saveType,
    severity: pending.severity as PF1eSaveSeverity,
    damageFormula: pending.damageFormula,
    ...(pending.energyType !== undefined
      ? { energyType: pending.energyType as PF1eEnergyType }
      : {}),
  };
  const effect = await runSpellEffect(client, user, {
    casterActor: params.casterActor,
    casterDerived: params.casterDerived,
    spellName: pending.name,
    authored,
    dc,
    targetName: params.targetName,
    targetActor: params.targetActor,
    targetDerived: params.targetDerived,
    ...(params.targetFeats !== undefined
      ? { targetFeats: params.targetFeats }
      : {}),
    combat: params.combat,
    ...(params.srOvercomeByCaller !== undefined
      ? { srOvercomeByCaller: params.srOvercomeByCaller }
      : {}),
  });
  if (!effect.ok) return fail(effect.error);
  const ops: Op[] = [...effect.ops];
  ops.push({
    kind: "update",
    ref: { coll: "actors", id: params.casterActor._id },
    diff: pendingCastDiff(null),
  });
  const slotLevel = pending.slotLevel ?? pending.level;
  const card = castResolutionCardContent(
    {
      casterName: params.casterActor.name,
      spellName: pending.name,
      spellLevel: pending.level,
      slotLevel,
      targetName: params.targetName,
      damageFormula: pending.damageFormula,
      saveType: pending.saveType,
      severity: authored.severity,
      hpBefore: params.targetDerived.hp,
      hpAfter: params.targetDerived.hp - effect.result.dealt,
      pendingCompleted: true,
    },
    {
      dc,
      sr: effect.sr,
      saveBonus: effect.saveBonus,
      saveTotal: effect.saveTotal,
      result: effect.result,
    },
    [],
    effect.hpWriteError,
  );
  const cardMessage: MessageDocument = {
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
    flavor: "cast resolution",
  };
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
  if (ops.length > 0) client.submit(ops);
  return {
    ok: true,
    completed: true,
    dc,
    sr: effect.sr,
    result: effect.result,
    hpWriteError: effect.hpWriteError,
  };
}

export interface PF1ePendingDisruptionParams {
  casterActor: ActorDocument;
  casterDerived: PF1eDerived;
  /** The damage the GM says interrupted the casting. */
  damage: number;
}

export type PF1ePendingDisruptionOutcome =
  | {
      ok: true;
      /** False when the concentration check passed and the casting continues. */
      lost: boolean;
      dc: number;
      total: number;
      spellName: string;
    }
  | { ok: false; error: string };

/**
 * Resolve damage taken while a multi-round casting is in progress: "If you
 * start casting a spell but something interferes with your concentration,
 * you must make a concentration check or lose the spell" (Rules ID 133) —
 * DC 10 + damage taken + spell level, the same DC as an injured caster
 * (Table 9-1). Failure loses the spell; success keeps it pending.
 */
export async function resolvePendingDisruption(
  client: CastFlowClient,
  user: PermissionUser | null,
  params: PF1ePendingDisruptionParams,
): Promise<PF1ePendingDisruptionOutcome> {
  const fail = (error: string): PF1ePendingDisruptionOutcome => ({
    ok: false,
    error,
  });
  if (
    !isPF1eActor(params.casterActor) ||
    !user ||
    !can(user, "update", params.casterActor, "actors")
  )
    return fail("You do not have permission to act for this caster.");
  const pending = pendingCastFromSystem(
    params.casterActor.system as Record<string, unknown>,
  );
  if (pending === null) return fail("There is no pending casting to disrupt.");
  if (!Number.isInteger(params.damage) || params.damage < 0)
    return fail(
      "The interruption damage must be a whole number of hit points.",
    );
  const dc = 10 + params.damage + pending.level;
  const rollId = client.roll(
    "1d20",
    "roll",
    undefined,
    `${pending.name} concentration (interrupted while casting)`,
  );
  const message = await awaitRollMessage(client, rollId);
  if (message === null)
    return fail("The concentration check never replicated.");
  const face = dieFaceOf(message);
  if (face === null)
    return fail("Could not read the concentration check's d20 face.");
  const bonus =
    params.casterDerived.spellCasterLevel +
    params.casterDerived.abilityMods[params.casterDerived.spellKeyAbility] +
    params.casterDerived.concentration;
  const total = face + bonus;
  const lost = total < dc;
  const ops: Op[] = [];
  if (lost) {
    ops.push({
      kind: "update",
      ref: { coll: "actors", id: params.casterActor._id },
      diff: pendingCastDiff(null),
    });
  }
  const card = lost
    ? pendingLostCardContent(
        {
          casterName: params.casterActor.name,
          spellName: pending.name,
          spellLevel: pending.level,
        },
        `the concentration check [[${total}|1d20 ${bonus >= 0 ? `+ ${bonus}` : `- ${Math.abs(bonus)}`}]] failed against DC ${dc} after taking ${params.damage} damage`,
      )
    : {
        name: `${pending.name} held`,
        content: `${params.casterActor.name} keeps concentrating on ${pending.name} — concentration [[${total}|1d20 ${bonus >= 0 ? `+ ${bonus}` : `- ${Math.abs(bonus)}`}]] vs DC ${dc} passed despite ${params.damage} damage.`,
      };
  const cardMessage: MessageDocument = {
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
    flavor: "cast resolution",
  };
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
  if (ops.length > 0) client.submit(ops);
  return { ok: true, lost, dc, total, spellName: pending.name };
}

/* ------------------------------------------------------------------ *
 * P5/C03 held-charge consumers (D-162).
 *
 * Transcribed before encoding (R02): AoN Rules ID 133 ("Cast a Spell",
 * CRB pg. 183, "Holding the Charge") — "You can touch one friend as a
 * standard action or up to six friends as a full-round action.
 * Alternatively, you may make a normal unarmed attack (or an attack with a
 * natural weapon) while holding a charge. In this case, you aren't
 * considered armed and you provoke attacks of opportunity as normal for the
 * attack. If your unarmed attack or natural weapon attack normally doesn't
 * provoke attacks of opportunity, neither does this attack. If the attack
 * hits, you deal normal damage for your unarmed attack or natural weapon
 * and the spell discharges. If the attack misses, you are still holding
 * the charge." Multi-charge held spells come from the spell description
 * (Chill Touch, CRB pg. 255: "You can use this melee touch attack up to
 * one time per level"); each delivery consumes one charge.
 * ------------------------------------------------------------------ */

/** One willing target of the full-round ally touch (D-162). */
export interface PF1eAllyTouchTarget {
  name: string;
  actor: ActorDocument;
  derived: PF1eDerived;
  feats?: readonly string[];
}

export interface PF1eAllyTouchesParams {
  casterActor: ActorDocument;
  casterDerived: PF1eDerived;
  /** 1–6 willing targets ("up to six friends as a full-round action"). */
  targets: readonly PF1eAllyTouchTarget[];
  combat?: CombatDocument | null;
  srOvercomeByCaller?: boolean;
}

export type PF1eAllyTouchesOutcome =
  | {
      ok: true;
      /** Targets actually touched (all of them — willing touches auto-hit). */
      touched: number;
      /** Deliveries left afterwards; absent when the spell discharged. */
      chargesRemaining?: number;
      spellName: string;
      perTarget: Array<{ name: string; hpWriteError: string | null }>;
    }
  | { ok: false; error: string };

/**
 * Touch willing allies with a held charge: "You can touch one friend as a
 * standard action or up to six friends as a full-round action" (Rules ID
 * 133). No attack rolls — "You can automatically touch one friend" — each
 * touched ally receives the spell's full resolution (its own damage roll,
 * SR check and saving throw) and one charge is consumed per ally.
 */
export async function resolveChargeAllyTouches(
  client: CastFlowClient,
  user: PermissionUser | null,
  params: PF1eAllyTouchesParams,
): Promise<PF1eAllyTouchesOutcome> {
  const fail = (error: string): PF1eAllyTouchesOutcome => ({
    ok: false,
    error,
  });
  if (
    !isPF1eActor(params.casterActor) ||
    !user ||
    !can(user, "update", params.casterActor, "actors")
  )
    return fail("You do not have permission to act for this caster.");
  const charge = heldChargeFromSystem(
    params.casterActor.system as Record<string, unknown>,
  );
  if (charge === null) return fail("There is no held charge to touch with.");
  if (params.targets.length === 0)
    return fail("Pick at least one willing target to touch.");
  if (params.targets.length > PF1E_ALLY_TOUCH_MAX)
    return fail(
      `A full-round action touches up to ${String(PF1E_ALLY_TOUCH_MAX)} friends, not ${String(params.targets.length)}.`,
    );
  const seen = new Set<string>();
  for (const target of params.targets) {
    if (seen.has(target.actor._id))
      return fail(`"${target.name}" is listed more than once.`);
    seen.add(target.actor._id);
  }
  const countLeft = heldChargeCount(charge);
  if (params.targets.length > countLeft)
    return fail(
      `The held ${charge.name} has ${String(countLeft)} ${countLeft === 1 ? "delivery" : "deliveries"} left — not enough for ${String(params.targets.length)} allies.`,
    );
  if (!(PF1E_SAVE_SEVERITIES as readonly string[]).includes(charge.severity))
    return fail(`The held charge's severity "${charge.severity}" is unknown.`);
  if (
    charge.energyType !== undefined &&
    !(PF1E_ENERGY_TYPES as readonly string[]).includes(charge.energyType)
  )
    return fail(
      `The held charge's energy type "${charge.energyType}" is unknown.`,
    );
  const dc = params.casterDerived.spellSaveDc[charge.level];
  if (dc === null || dc === undefined)
    return fail(
      `No DC for the held ${charge.name}: the caster has no slots at level ${charge.level} now.`,
    );

  const authored: PF1eCastFlowParams["authored"] = {
    saveType: charge.saveType,
    severity: charge.severity as PF1eSaveSeverity,
    damageFormula: charge.damageFormula,
    ...(charge.energyType !== undefined
      ? { energyType: charge.energyType as PF1eEnergyType }
      : {}),
  };
  const ops: Op[] = [];
  const perTarget: Array<{ name: string; hpWriteError: string | null }> = [];
  const targetLines: string[] = [];
  for (const target of params.targets) {
    const effect = await runSpellEffect(client, user, {
      casterActor: params.casterActor,
      casterDerived: params.casterDerived,
      spellName: charge.name,
      authored,
      dc,
      targetName: target.name,
      targetActor: target.actor,
      targetDerived: target.derived,
      ...(target.feats !== undefined ? { targetFeats: target.feats } : {}),
      combat: params.combat,
      ...(params.srOvercomeByCaller !== undefined
        ? { srOvercomeByCaller: params.srOvercomeByCaller }
        : {}),
    });
    if (!effect.ok) return fail(`${target.name}: ${effect.error}`);
    ops.push(...effect.ops);
    perTarget.push({ name: target.name, hpWriteError: effect.hpWriteError });
    const saveLine =
      effect.saveTotal === null
        ? "no save allowed"
        : `${charge.saveType.toUpperCase()} save ${String(effect.saveTotal)} vs DC ${String(dc)} — ${effect.result.passed ? "passes" : "fails"}`;
    const hpAfter = target.derived.hp - effect.result.dealt;
    targetLines.push(
      `${target.name}: touched automatically; ${saveLine}; ${String(effect.result.dealt)} damage${
        hpAfter !== target.derived.hp
          ? ` (${String(target.derived.hp)} → ${String(hpAfter)} HP)`
          : ""
      }${effect.hpWriteError !== null ? ` — ⚠ HP write rejected: ${effect.hpWriteError}` : ""}.`,
    );
  }

  // Consume one charge per touched ally; the last one clears the path.
  const afterTouch = consumeHeldCharges(charge, params.targets.length);
  ops.push({
    kind: "update",
    ref: { coll: "actors", id: params.casterActor._id },
    diff: heldChargeDiff(afterTouch),
  });
  const card = chargeAllyTouchesCardContent(
    {
      casterName: params.casterActor.name,
      spellName: charge.name,
      spellLevel: charge.level,
    },
    targetLines,
    params.targets.length,
    afterTouch === null ? null : heldChargeCount(afterTouch),
  );
  const cardMessage: MessageDocument = {
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
    flavor: "cast resolution",
  };
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
  if (ops.length > 0) client.submit(ops);
  return {
    ok: true,
    touched: params.targets.length,
    ...(afterTouch !== null
      ? { chargesRemaining: heldChargeCount(afterTouch) }
      : {}),
    spellName: charge.name,
    perTarget,
  };
}

/** The card for the full-round willing-ally touch (D-162). */
export function chargeAllyTouchesCardContent(
  ctx: { casterName: string; spellName: string; spellLevel: number },
  targetLines: readonly string[],
  touched: number,
  chargesLeft: number | null,
): { name: string; content: string } {
  const action = touched === 1 ? "a standard action" : "a full-round action";
  const lines: string[] = [
    `${ctx.casterName} touches ${String(touched)} willing ${touched === 1 ? "ally" : "allies"} with the held ${ctx.spellName} (level ${String(ctx.spellLevel)}) as ${action} — no attack roll is needed for a willing target.`,
    ...targetLines,
    chargesLeft === null
      ? "The spell is fully discharged."
      : `Charges remaining: ${String(chargesLeft)}.`,
  ];
  return { name: `${ctx.spellName} ally touches`, content: lines.join("\n") };
}

/** The weapon used to release a held charge (D-162). */
export interface PF1eChargeReleaseWeapon {
  name: string;
  /** The line's normal attack bonus — the release is a normal attack. */
  attackBonus: number;
  /** NdM weapon dice, or "" when the line adds no dice. */
  damageFormula: string;
  /** The line's static damage bonus (ability + flat + effect mods). */
  damageBonus: number;
}

export interface PF1eChargeReleaseParams {
  casterActor: ActorDocument;
  casterDerived: PF1eDerived;
  targetName: string;
  targetActor: ActorDocument;
  targetDerived: PF1eDerived;
  weapon: PF1eChargeReleaseWeapon;
  targetFeats?: readonly string[];
  combat?: CombatDocument | null;
  srOvercomeByCaller?: boolean;
}

export type PF1eChargeReleaseOutcome =
  | {
      ok: true;
      /** The attack hit: weapon damage dealt and the spell discharged. */
      released: true;
      dc: number;
      sr: PF1eSrResult;
      result: Extract<PF1eSpellTargetResult, { ok: true }>;
      /** The weapon damage applied alongside the spell. */
      weaponDamage: number;
      weaponCritical: boolean;
      hpWriteError: string | null;
      /** Deliveries left afterwards; absent when the spell discharged. */
      chargesRemaining?: number;
      attack: { total: number; hit: true; threat: boolean; critical: boolean };
    }
  | {
      ok: true;
      /** The attack missed; the charge is still held. */
      released: false;
      attack: { total: number; hit: false; threat: false };
      ac: number;
    }
  | { ok: false; error: string };

/**
 * Release a held charge through a normal unarmed or natural weapon attack:
 * "you may make a normal unarmed attack (or an attack with a natural weapon)
 * while holding a charge" (Rules ID 133). The attack rolls against the
 * target's NORMAL AC with the weapon's normal bonus — it is not a touch
 * attack — and on a hit deals the weapon's normal damage while the spell
 * discharges through the shared effect pipeline. A miss keeps the charge.
 * The caster is not considered armed, so the attack provokes as normal;
 * resolving those attacks of opportunity belongs to P6's interrupt queue.
 */
export async function resolveChargeWeaponRelease(
  client: CastFlowClient,
  user: PermissionUser | null,
  params: PF1eChargeReleaseParams,
): Promise<PF1eChargeReleaseOutcome> {
  const fail = (error: string): PF1eChargeReleaseOutcome => ({
    ok: false,
    error,
  });
  if (
    !isPF1eActor(params.casterActor) ||
    !user ||
    !can(user, "update", params.casterActor, "actors")
  )
    return fail("You do not have permission to act for this caster.");
  const charge = heldChargeFromSystem(
    params.casterActor.system as Record<string, unknown>,
  );
  if (charge === null) return fail("There is no held charge to release.");
  if (!Number.isInteger(params.weapon.attackBonus))
    return fail("The release attack bonus must be an integer.");
  if (!Number.isInteger(params.weapon.damageBonus))
    return fail("The release damage bonus must be an integer.");
  const formula = params.weapon.damageFormula.trim();
  if (formula !== "" && !DAMAGE_FORMULA.test(formula))
    return fail(
      `Weapon damage "${params.weapon.damageFormula}": use NdM, or leave empty.`,
    );
  if (!(PF1E_SAVE_SEVERITIES as readonly string[]).includes(charge.severity))
    return fail(`The held charge's severity "${charge.severity}" is unknown.`);
  if (
    charge.energyType !== undefined &&
    !(PF1E_ENERGY_TYPES as readonly string[]).includes(charge.energyType)
  )
    return fail(
      `The held charge's energy type "${charge.energyType}" is unknown.`,
    );
  const dc = params.casterDerived.spellSaveDc[charge.level];
  if (dc === null || dc === undefined)
    return fail(
      `No DC for the held ${charge.name}: the caster has no slots at level ${charge.level} now.`,
    );

  // ── the normal attack against normal AC (never touch AC) ──────────────────
  const ac = params.targetDerived.ac.normal;
  const bonusStr =
    params.weapon.attackBonus >= 0
      ? `+ ${params.weapon.attackBonus}`
      : `- ${Math.abs(params.weapon.attackBonus)}`;
  const rollId = client.roll(
    "1d20",
    "roll",
    undefined,
    `${charge.name} release via ${params.weapon.name}`,
  );
  const message = await awaitRollMessage(client, rollId);
  if (message === null) return fail("The release attack never replicated.");
  const face = dieFaceOf(message);
  if (face === null)
    return fail("Could not read the release attack's d20 face.");
  const total = face + params.weapon.attackBonus;
  const threat = face === 20;
  const hit = total >= ac;
  const attackLine = `${params.weapon.name} attack [[${total}|1d20 ${bonusStr}]] vs AC ${String(ac)} — ${hit ? (threat ? "HIT (threatens a critical)" : "hit") : "MISS"}.`;

  if (!hit) {
    // "If the attack misses, you are still holding the charge."
    const card = chargeReleaseMissCardContent(
      {
        casterName: params.casterActor.name,
        spellName: charge.name,
        spellLevel: charge.level,
        targetName: params.targetName,
        weaponName: params.weapon.name,
      },
      attackLine,
    );
    const cardMessage: MessageDocument = {
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
      flavor: "cast resolution",
    };
    client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
    return {
      ok: true,
      released: false,
      attack: { total, hit: false, threat: false },
      ac,
    };
  }

  // ── the hit: confirm a natural 20, then roll the weapon damage ────────────
  let weaponCritical = false;
  let attackNarration = attackLine;
  if (threat) {
    // "another attack roll with all the same modifiers" (Rules ID 131),
    // against the same AC. The confirmation doubles the weapon damage only;
    // the spell resolves once, on its own save/SR terms.
    const confId = client.roll(
      "1d20",
      "roll",
      undefined,
      `${charge.name} release critical confirmation`,
    );
    const confMessage = await awaitRollMessage(client, confId);
    if (confMessage === null)
      return fail("The critical confirmation never replicated.");
    const confFace = dieFaceOf(confMessage);
    if (confFace === null)
      return fail("Could not read the confirmation's d20 face.");
    const confTotal = confFace + params.weapon.attackBonus;
    weaponCritical = confTotal >= ac;
    attackNarration += ` Critical confirmation [[${confTotal}|1d20 ${bonusStr}]] — ${weaponCritical ? "CRITICAL HIT (weapon damage doubled; the spell is not)." : "not confirmed (regular hit)."}`;
  }
  let weaponDamage = params.weapon.damageBonus;
  if (formula !== "") {
    const dmgId = client.roll(
      formula,
      "roll",
      undefined,
      `${params.weapon.name} damage (charge release)`,
    );
    const dmgMessage = await awaitRollMessage(client, dmgId);
    if (dmgMessage === null)
      return fail("The weapon damage roll never replicated.");
    if (dmgMessage.roll === null || typeof dmgMessage.roll.total !== "number")
      return fail("The weapon damage roll carries no total.");
    weaponDamage =
      Math.max(0, Math.trunc(dmgMessage.roll.total)) +
      params.weapon.damageBonus;
  }
  if (weaponCritical) weaponDamage = criticalDamageTotal(weaponDamage);
  const weaponLine = `${params.weapon.name} deals [[${weaponDamage}|${formula === "" ? "no dice" : formula}${params.weapon.damageBonus !== 0 || formula === "" ? ` ${params.weapon.damageBonus >= 0 ? `+ ${params.weapon.damageBonus}` : `- ${Math.abs(params.weapon.damageBonus)}`}` : ""}]] damage${weaponCritical ? " (critical ×2)" : ""}.`;

  // ── the spell discharges through the shared pipeline (no spell-only HP write) ──
  const authored: PF1eCastFlowParams["authored"] = {
    saveType: charge.saveType,
    severity: charge.severity as PF1eSaveSeverity,
    damageFormula: charge.damageFormula,
    ...(charge.energyType !== undefined
      ? { energyType: charge.energyType as PF1eEnergyType }
      : {}),
  };
  const effect = await runSpellEffect(client, user, {
    casterActor: params.casterActor,
    casterDerived: params.casterDerived,
    spellName: charge.name,
    authored,
    dc,
    targetName: params.targetName,
    targetActor: params.targetActor,
    targetDerived: params.targetDerived,
    ...(params.targetFeats !== undefined
      ? { targetFeats: params.targetFeats }
      : {}),
    combat: params.combat,
    ...(params.srOvercomeByCaller !== undefined
      ? { srOvercomeByCaller: params.srOvercomeByCaller }
      : {}),
    skipHpWrite: true,
  });
  if (!effect.ok) return fail(effect.error);

  // ── one combined HP write: weapon damage + spell damage ───────────────────
  const ops: Op[] = [...effect.ops];
  let hpWriteError: string | null = null;
  const totalDealt = weaponDamage + effect.result.dealt;
  if (totalDealt > 0) {
    const after = params.targetDerived.hp - totalDealt;
    const edit = pf1eSheetEdit(params.targetActor, user, "hp", String(after));
    if (edit.error !== null) hpWriteError = edit.error;
    else ops.push(...edit.ops);
  }

  // Consume one charge; a multi-charge spell keeps holding the rest.
  const afterRelease = consumeHeldCharge(charge);
  ops.push({
    kind: "update",
    ref: { coll: "actors", id: params.casterActor._id },
    diff: heldChargeDiff(afterRelease),
  });
  const card = chargeReleaseCardContent(
    {
      casterName: params.casterActor.name,
      spellName: charge.name,
      spellLevel: charge.level,
      targetName: params.targetName,
    },
    attackNarration,
    weaponLine,
    {
      dc,
      sr: effect.sr,
      saveBonus: effect.saveBonus,
      saveTotal: effect.saveTotal,
      result: effect.result,
    },
    params.targetDerived.hp,
    params.targetDerived.hp - totalDealt,
    hpWriteError,
    afterRelease === null ? null : heldChargeCount(afterRelease),
  );
  const cardMessage: MessageDocument = {
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
    flavor: "cast resolution",
  };
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
  if (ops.length > 0) client.submit(ops);
  return {
    ok: true,
    released: true,
    dc,
    sr: effect.sr,
    result: effect.result,
    weaponDamage,
    weaponCritical,
    hpWriteError,
    ...(afterRelease !== null
      ? { chargesRemaining: heldChargeCount(afterRelease) }
      : {}),
    attack: { total, hit: true, threat, critical: weaponCritical },
  };
}

/** The card when the release attack misses (D-162). */
export function chargeReleaseMissCardContent(
  ctx: {
    casterName: string;
    spellName: string;
    spellLevel: number;
    targetName: string;
    weaponName: string;
  },
  attackLine: string,
): { name: string; content: string } {
  const lines: string[] = [
    `${ctx.casterName} strikes ${ctx.targetName} with the ${ctx.weaponName} to release the held ${ctx.spellName} (level ${ctx.spellLevel}).`,
    attackLine,
    "The attack misses — the caster is not considered armed, so the attack provokes as normal, and the charge is still held.",
  ];
  return { name: `${ctx.spellName} release miss`, content: lines.join("\n") };
}

/** The card when a held charge discharges through a weapon attack (D-162). */
export function chargeReleaseCardContent(
  ctx: {
    casterName: string;
    spellName: string;
    spellLevel: number;
    targetName: string;
  },
  attackLine: string,
  weaponLine: string,
  res: {
    dc: number;
    sr: PF1eSrResult;
    saveBonus: number;
    saveTotal: number | null;
    result: Extract<PF1eSpellTargetResult, { ok: true }>;
  },
  hpBefore: number,
  hpAfter: number,
  hpWriteError: string | null,
  chargesLeft: number | null,
): { name: string; content: string } {
  const lines: string[] = [
    `${ctx.casterName} releases the held ${ctx.spellName} (level ${ctx.spellLevel}) through the attack at ${ctx.targetName} — DC ${res.dc}. The caster is not considered armed, so this attack provokes as normal.`,
    attackLine,
  ];
  if (weaponLine !== "") lines.push(weaponLine);
  if (res.sr.reused) {
    lines.push("Spell resistance was already overcome this round — no check.");
  } else if (res.sr.total !== null) {
    lines.push(
      `SR check [[${res.sr.total}|1d20 + caster level]] — ${
        res.sr.resisted
          ? "RESISTED: the spell does not affect the target"
          : "overcome"
      }.`,
    );
  }
  if (res.saveTotal !== null) {
    const automatic =
      res.result.automatic === "failure"
        ? " (natural 1 — always a failure)"
        : res.result.automatic === "success"
          ? " (natural 20 — always a success)"
          : "";
    lines.push(
      `Saving throw [[${res.saveTotal}|1d20 ${
        res.saveBonus >= 0
          ? `+ ${res.saveBonus}`
          : `- ${Math.abs(res.saveBonus)}`
      }]] vs DC ${res.dc} — ${res.result.passed ? "passes" : "fails"}${automatic}.`,
    );
  }
  for (const note of res.result.notes) lines.push(note);
  if (res.result.dealt > 0)
    lines.push(
      `The discharged spell deals ${String(res.result.dealt)} damage.`,
    );
  if (hpAfter !== hpBefore)
    lines.push(
      `${ctx.targetName} ${String(hpBefore)} → ${String(hpAfter)} HP.`,
    );
  if (hpWriteError !== null) lines.push(`⚠ HP write rejected: ${hpWriteError}`);
  lines.push(
    chargesLeft === null
      ? "The spell is fully discharged."
      : `Charges remaining: ${String(chargesLeft)}.`,
  );
  return { name: `${ctx.spellName} released`, content: lines.join("\n") };
}
