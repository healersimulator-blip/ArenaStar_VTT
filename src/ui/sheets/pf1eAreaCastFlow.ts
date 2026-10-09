/**
 * PF1e area cast flow (D-408) — one spell, one slot, one card, N affected
 * creatures. The quickbar's spread/line casts used to loop the single-target
 * flow once per creature: N cards, N commits, and a mid-loop failure left
 * earlier rows committed while later ones never resolved. This flow resolves
 * every row through the SAME shared builders as a single-target cast
 * (`runSpellEffect`, `resolvedCastActionTarget`, the delivery planning) and
 * commits the card plus every row's writes in ONE submit — a row that fails
 * fails the whole cast before anything is spent.
 *
 * What the flow owns (cast-wide, once): permission, area/target validation,
 * the C03a gate's diceless half plus the arcane-failure/deafened dice, the
 * one slot/prepared spend, and held-charge dissipation. What each row owns
 * (per affected creature, in order): SR, the saving throw, composition, the
 * HP write and the authored-condition delivery request.
 *
 * Deliberate refusals for this slice (each names itself): concentration
 * declarations (no pending-concentration branch), non-standard gate timing
 * that needs the swift ledger ("swift"/"free") or a deferred completion
 * ("longer"), and pending-save deferral (a row that would defer names the
 * table setting and the flow asks for single-target casts instead). Damage
 * rolls once per row rather than once for the whole area — shared-damage
 * support is a later slice; no damage-dealing area spell routes here yet.
 */
import type { Op } from "../../core/ops";
import {
  actionAsJson,
  validateActionArea,
  type ActionArea,
  type ActionTarget,
} from "../../core/action";
import type { PermissionUser } from "../../core/ownership";
import type {
  ActorDocument,
  CombatDocument,
  MessageDocument,
  Ownership,
} from "../../core/documents";
import type { PF1eDerived } from "../../packages/pf1e/actor";
import {
  PF1E_SAVE_SEVERITIES,
  type PF1eSaveSeverity,
  type PF1eSaveType,
  type PF1eSpellTargetResult,
  type PF1eSrResult,
} from "../../packages/pf1e/casting";
import {
  PF1E_ENERGY_TYPES,
  type PF1eEnergyType,
} from "../../packages/pf1e/healthState";
import {
  arcaneSpellFailureChance,
  componentNeeds,
  parseSpellComponents,
  resolveCastingAttempt,
} from "../../packages/pf1e/concentration";
import { worldSettingsFrom } from "../../core/worldSettings";
import {
  isPlayerOwned,
  shouldDeferToPlayer,
} from "../../packages/pf1e/pendingRoll";
import { can } from "../../core/permissions";
import { isPF1eActor } from "./pf1eSheetModel";
import { awaitRollMessage, dieFaceOf } from "./pf1eResolveFlow";
import {
  armorSpellFailureOf,
  castActionCard,
  castActionTargetBase,
  castLostCardContent,
  castResolutionCardContent,
  castSpatialContext,
  checkCastGateLegality,
  dissipateHeldChargeIfAny,
  plannedSpellEffectDelivery,
  requestSpellEffectDelivery,
  resolvedCastActionTarget,
  runSpellEffect,
  spendCastSlotAndPrepared,
  type CastFlowClient,
  type PF1eCastFlowParams,
  type PF1eCastGateInput,
  type PF1eSpellEffectDelivery,
} from "./pf1eCastFlow";

/** An area cast resolves at most 24 affected creatures in one card. */
export const PF1E_AREA_CAST_TARGET_MAX = 24;

/** One affected creature, as the caller (template intersection) supplies it. */
export interface PF1eAreaCastTarget {
  name: string;
  actor: ActorDocument;
  derived: PF1eDerived;
  /** The target's authored feats/features (Evasion is read, never activated). */
  feats?: readonly string[];
  /** The token caught in the area; inferred from visible scenes when absent. */
  tokenId?: string;
}

export interface PF1eAreaCastFlowParams {
  casterActor: ActorDocument;
  casterDerived: PF1eDerived;
  /** The caster's token; inferred from visible scenes when absent. */
  casterTokenId?: string;
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
  /** The spell area (required): every row resolves inside it. */
  area: ActionArea;
  /** The affected creatures, in card order: 1–24 distinct actors. */
  targets: readonly PF1eAreaCastTarget[];
  /** The active encounter; the round-scoped SR ledger rides its flags. */
  combat?: CombatDocument | null;
  /**
   * The C03a pre-save gate (D-157). Concentration declarations are refused
   * (an area cast carries no pending-concentration branch), as is any timing
   * the area flow cannot model ("swift"/"free" need the per-turn ledger,
   * "longer" needs a deferred completion). Absent (or an empty `components`
   * line) skips the gate entirely, exactly as in the single-target flow.
   */
  gate?: PF1eCastGateInput;
  /**
   * D-407 — the authored tactical effect this cast delivers. Each landed row
   * requests its own delivery; the host re-checks every row before claiming.
   */
  spellEffectId?: string;
}

/** One resolved row: the public card row plus the facts the caller reports. */
export interface PF1eAreaCastRow {
  targetName: string;
  targetActorId: string;
  /** The row's token after spatial inference; null when no token resolved. */
  tokenId: string | null;
  sr: PF1eSrResult;
  saveBonus: number;
  saveTotal: number | null;
  result: Extract<PF1eSpellTargetResult, { ok: true }>;
  hpWriteError: string | null;
  /** Conditions the row asked the host to deliver (requested, not yet applied). */
  delivered: readonly string[];
}

export type PF1eAreaCastFlowOutcome =
  | {
      ok: true;
      /** Every row resolved; the card and all writes committed together. */
      lost: false;
      cardId: string;
      dc: number;
      rows: PF1eAreaCastRow[];
      warnings: string[];
      gateNotes: string[];
    }
  | {
      ok: true;
      /** The gate ruined the spell: slot spent, one lost card, no rows resolved. */
      lost: true;
      cardId: string;
      affected: number;
      warnings: string[];
      gateNotes: string[];
    }
  | { ok: false; error: string };

function describeAreaCastArea(area: ActionArea): string {
  const units = area.units ?? "ft";
  const at = `at (${String(area.origin.x)}, ${String(area.origin.y)})`;
  if (area.shape === "line" && area.length !== undefined)
    return `${String(area.length)}-${units} line${area.width !== undefined ? `, ${String(area.width)}-${units} wide` : ""} ${at}`;
  if (area.radius !== undefined)
    return `${String(area.radius)}-${units}-radius ${area.shape} ${at}`;
  if (area.length !== undefined)
    return `${String(area.length)}-${units} ${area.shape} ${at}`;
  return `${area.shape} ${at}`;
}

/**
 * Resolve one area cast end to end: one slot, N rows, one card, one commit.
 * All dice are host-evaluated public rolls; all writes are Ops through the
 * sheet's own validated paths.
 */
export async function resolveAreaCastFlow(
  client: CastFlowClient,
  user: PermissionUser | null,
  params: PF1eAreaCastFlowParams,
): Promise<PF1eAreaCastFlowOutcome> {
  const fail = (error: string): PF1eAreaCastFlowOutcome => ({ ok: false, error });

  // ── validation: nothing is rolled before the cast is well-formed ─────────
  if (
    !isPF1eActor(params.casterActor) ||
    !user ||
    !can(user, "update", params.casterActor, "actors")
  )
    return fail("You do not have permission to act for this caster.");
  const areaCheck = validateActionArea(params.area);
  if (!areaCheck.ok)
    return fail(`The spell area is unusable: ${areaCheck.error}.`);
  if (params.targets.length < 1)
    return fail(
      "An area cast needs at least one affected creature — the area caught no one.",
    );
  if (params.targets.length > PF1E_AREA_CAST_TARGET_MAX)
    return fail(
      `An area cast resolves at most ${String(PF1E_AREA_CAST_TARGET_MAX)} affected creatures — narrow the area or resolve the rest separately.`,
    );
  const seen = new Set<string>();
  for (const target of params.targets) {
    if (target.name.trim() === "")
      return fail("Every affected creature needs a name for the card.");
    if (!isPF1eActor(target.actor))
      return fail(
        `"${target.name}" is not a PF1e creature the flow can resolve.`,
      );
    if (seen.has(target.actor._id))
      return fail(
        `"${target.name}" is listed twice — each affected creature resolves once.`,
      );
    seen.add(target.actor._id);
  }
  const { authored, spell } = params;
  if (!params.casterDerived.casting)
    return fail("This actor has no spellcasting data.");
  if (!Number.isInteger(spell.level) || spell.level < 0 || spell.level > 9)
    return fail("Spell level must be an integer 0–9.");
  const slotLevel = spell.slotLevel ?? spell.level;
  if (!Number.isInteger(slotLevel) || slotLevel < 0 || slotLevel > 9)
    return fail("Slot level must be an integer 0–9.");
  const dc = params.casterDerived.spellSaveDc[spell.level];
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

  const ops: Op[] = [];
  const warnings: string[] = [];

  // One single-target params object per row: every shared builder below takes
  // exactly this shape, so rows cannot drift from single-target casts. The
  // slot is spent once above; rows never spend (`resourceAlreadySpent`).
  const rowParamsFor = (target: PF1eAreaCastTarget): PF1eCastFlowParams => {
    const row: PF1eCastFlowParams = {
      resourceAlreadySpent: true,
      context: {
        sceneId: params.area.sceneId,
        ...(params.casterTokenId !== undefined
          ? { casterTokenId: params.casterTokenId }
          : {}),
        ...(target.tokenId !== undefined ? { targetTokenId: target.tokenId } : {}),
        area: params.area,
      },
      casterActor: params.casterActor,
      casterDerived: params.casterDerived,
      spell: {
        name: spell.name,
        level: spell.level,
        ...(spell.slotLevel !== undefined ? { slotLevel: spell.slotLevel } : {}),
        ...(spell.preparedIndex !== undefined
          ? { preparedIndex: spell.preparedIndex }
          : {}),
      },
      authored: {
        saveType: authored.saveType,
        severity: authored.severity,
        damageFormula: authored.damageFormula,
        ...(authored.energyType !== undefined
          ? { energyType: authored.energyType }
          : {}),
      },
      targetName: target.name,
      targetActor: target.actor,
      targetDerived: target.derived,
      ...(target.feats !== undefined ? { targetFeats: target.feats } : {}),
      ...(params.combat !== undefined ? { combat: params.combat } : {}),
      ...(params.spellEffectId !== undefined
        ? { spellEffectId: params.spellEffectId }
        : {}),
    };
    // Context is inferred only from the caller's projected scenes; hidden
    // tokens can never enter the public card through a blind replica.
    return { ...row, context: castSpatialContext(client, row) };
  };

  // ── the C03a gate, diceless half (D-157): an illegal casting is refused
  //    before any die rolls and spends nothing ──────────────────────────────
  const gate = params.gate;
  const gateActive = gate !== undefined && gate.components.trim() !== "";
  let gateTradition: "arcane" | "divine" = "arcane";
  let gateNeedsSomatic = false;
  if (gateActive && gate !== undefined) {
    const declarations = gate.declarations ?? [];
    if (declarations.length > 0)
      return fail(
        `An area cast cannot carry concentration checks (declared: ${declarations.map((d) => d.situation).join(", ")}) — drop the declarations or cast at one target.`,
      );
    if (gate.castingTime !== "standard" && gate.castingTime !== "full-round")
      return fail(
        `An area cast resolves on a standard (or full-round) casting — "${gate.castingTime}" timing is single-target only.`,
      );
    const legality = checkCastGateLegality({
      casterActor: params.casterActor,
      gate,
      spellName: spell.name,
    });
    if (!legality.ok) return fail(legality.error);
    gateTradition = legality.legality.tradition;
    gateNeedsSomatic = legality.legality.needsSomatic;
  }

  // ── the one daily bookkeeping, validated BEFORE any die is rolled ────────
  const spendError = spendCastSlotAndPrepared(
    { casterActor: params.casterActor, spell: params.spell },
    params.casterDerived,
    user,
    slotLevel,
    ops,
    warnings,
  );
  if (spendError !== null) return fail(spendError);

  // ── the C03a gate, dice half: arcane spell failure and deafened spoilage.
  //    Concentration needs no branch — declarations were refused above — so
  //    this is the same two dice the single-target flow rolls, through the
  //    same pure `resolveCastingAttempt`. A ruined spell still spends its
  //    slot — "you lose the spell just as if you had cast it to no effect" ──
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
      const { awaitRollMessage, dieFaceOf } = await import("./pf1eResolveFlow");
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
    const attempt = resolveCastingAttempt({
      components: gate.components,
      tradition: gateTradition,
      caster: gate.caster,
      castingTime: gate.castingTime,
      spellLevel: spell.level,
      ...gearInput,
      ...(arcaneDie !== undefined ? { arcaneDie } : {}),
      ...(deafenedDie !== undefined ? { deafenedDie } : {}),
      triggers: [],
      casterLevel: params.casterDerived.spellCasterLevel,
      keyAbilityMod:
        params.casterDerived.abilityMods[params.casterDerived.spellKeyAbility],
      featBonus: params.casterDerived.concentration,
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
      const cardId = globalThis.crypto.randomUUID();
      const first = rowParamsFor(params.targets[0] as PF1eAreaCastTarget);
      const skipped: ActionTarget[] = params.targets.map((target) => ({
        ...castActionTargetBase(rowParamsFor(target)),
        state: "skipped",
        outcome: "unaffected",
        notes: ["The spell was lost before its effect resolved."],
      }));
      const action = castActionCard(
        first,
        cardId,
        skipped,
        [...gateNotes, ...warnings],
        "failed",
      );
      const cardMessage: MessageDocument = {
        _id: cardId,
        type: "message",
        name: card.name,
        ownership: { default: 1 },
        flags: {},
        system: { action: actionAsJson(action) },
        author: user?.id ?? "",
        content: card.content,
        whisper: [],
        roll: null,
        flavor: "cast resolution",
      };
      client.submit([{ kind: "create", coll: "messages", data: cardMessage }, ...ops]);
      return {
        ok: true,
        lost: true,
        cardId,
        affected: params.targets.length,
        warnings,
        gateNotes,
      };
    }
  }

  // ── held-charge dissipation (D-158): "If you cast another spell, the
  //    touch spell dissipates" ──────────────────────────────────────────────
  dissipateHeldChargeIfAny(params.casterActor, spell.name, ops, warnings);

  // ── F03 pending-save pre-check: one card cannot carry N pending saves, so
  //    a row that would defer names the table setting instead of resolving
  //    behind its back. A failed check falls back to the effect pipeline,
  //    exactly as the single-target flow does ───────────────────────────────
  try {
    const worldSettings = worldSettingsFrom(
      (client as unknown as { store: { getAll(c: string): readonly unknown[] } }).store.getAll(
        "settings",
      ) as unknown as Iterable<unknown>,
    );
    if (authored.severity !== "none") {
      const deferring: string[] = [];
      for (const target of params.targets) {
        const owned = isPlayerOwned(
          (target.actor as unknown as { ownership?: unknown }).ownership as
            | Ownership
            | null
            | undefined,
        );
        if (
          shouldDeferToPlayer({
            kind: "save",
            targetIsPlayerOwned: owned,
            worldSettings,
            isStrategic: false,
          })
        )
          deferring.push(target.name);
      }
      if (deferring.length > 0)
        return fail(
          `An area cast cannot defer saves, but ${deferring.join(", ")} ${deferring.length === 1 ? "needs" : "need"} a pending save under this table's settings — cast at them one by one.`,
        );
    }
  } catch (err) {
    warnings.push(
      `⚠ pending-save path failed (${err instanceof Error ? err.message : String(err)}) — falling back to the effect pipeline`,
    );
  }

  // ── the rows (damage → SR → save → composition → HP write), in order.
  //    Nothing has committed yet: a row that fails fails the whole cast, so
  //    the area never leaves earlier rows committed and later ones silent ───
  const rows: ActionTarget[] = [];
  const outcomes: PF1eAreaCastRow[] = [];
  const contents: string[] = [];
  const deliveries: Array<{
    rowIndex: number;
    rowParams: PF1eCastFlowParams;
    delivery: PF1eSpellEffectDelivery;
  }> = [];
  let first: PF1eCastFlowParams | null = null;
  for (const [rowIndex, target] of params.targets.entries()) {
    const rowParams = rowParamsFor(target);
    if (first === null) first = rowParams;
    const effect = await runSpellEffect(client, user, {
      casterActor: params.casterActor,
      casterDerived: params.casterDerived,
      spellName: spell.name,
      authored: {
        saveType: authored.saveType,
        severity: authored.severity,
        damageFormula: authored.damageFormula,
        ...(authored.energyType !== undefined
          ? { energyType: authored.energyType }
          : {}),
      },
      dc,
      targetName: target.name,
      targetActor: target.actor,
      targetDerived: target.derived,
      ...(target.feats !== undefined ? { targetFeats: target.feats } : {}),
      combat: params.combat,
    });
    if (!effect.ok) return fail(effect.error);
    ops.push(...effect.ops);
    const targetRow = resolvedCastActionTarget(rowParams, {
      dc,
      saveBonus: effect.saveBonus,
      saveTotal: effect.saveTotal,
      result: effect.result,
      evidence: effect.evidence,
    });
    // D-407 — the authored tactical effect rides this cast. The note rides the
    // ROW (one card carries N rows); the request itself is issued after the
    // commit, the same order the poison rider uses (`resolveAttackFlow`).
    const delivery = plannedSpellEffectDelivery(client, rowParams, targetRow);
    if (delivery !== null && delivery.note !== null) {
      targetRow.notes = [...(targetRow.notes ?? []), delivery.note].slice(0, 32);
      contents.push(
        castResolutionCardContent(
          {
            casterName: params.casterActor.name,
            spellName: spell.name,
            spellLevel: spell.level,
            slotLevel,
            targetName: target.name,
            damageFormula: authored.damageFormula,
            saveType: authored.saveType,
            severity: authored.severity,
            hpBefore: target.derived.hp,
            hpAfter: target.derived.hp - effect.result.dealt,
          },
          {
            dc,
            sr: effect.sr,
            saveBonus: effect.saveBonus,
            saveTotal: effect.saveTotal,
            result: effect.result,
          },
          [delivery.note],
          effect.hpWriteError,
        ).content,
      );
      deliveries.push({ rowIndex, rowParams, delivery });
    } else {
      contents.push(
        castResolutionCardContent(
          {
            casterName: params.casterActor.name,
            spellName: spell.name,
            spellLevel: spell.level,
            slotLevel,
            targetName: target.name,
            damageFormula: authored.damageFormula,
            saveType: authored.saveType,
            severity: authored.severity,
            hpBefore: target.derived.hp,
            hpAfter: target.derived.hp - effect.result.dealt,
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
        ).content,
      );
    }
    rows.push(targetRow);
    outcomes.push({
      targetName: target.name,
      targetActorId: target.actor._id,
      tokenId: rowParams.context?.targetTokenId ?? null,
      sr: effect.sr,
      saveBonus: effect.saveBonus,
      saveTotal: effect.saveTotal,
      result: effect.result,
      hpWriteError: effect.hpWriteError,
      delivered:
        delivery === null ? [] : [...delivery.conditions],
    });
  }

  // ── the one resolution card: header, one section per row, then the
  //    cast-wide gate notes and warnings exactly once ────────────────────────
  const cardId = globalThis.crypto.randomUUID();
  const header =
    `${params.casterActor.name} casts ${spell.name} (level ${spell.level}) — ` +
    `${describeAreaCastArea(params.area)} — DC ${String(dc)}, ${String(rows.length)} target row${rows.length === 1 ? "" : "s"}.`;
  const content = [
    header,
    ...contents,
    ...gateNotes.map((note) => `⚠ ${note}`),
    ...warnings.map((note) => `⚠ ${note}`),
  ].join("\n");
  const action = castActionCard(
    first as PF1eCastFlowParams,
    cardId,
    rows,
    [...gateNotes, ...warnings],
  );
  const cardMessage: MessageDocument = {
    _id: cardId,
    type: "message",
    name: `${spell.name} cast`,
    ownership: { default: 1 },
    flags: {},
    system: { action: actionAsJson(action) },
    author: user?.id ?? "",
    content,
    whisper: [],
    roll: null,
    flavor: "cast resolution",
  };
  // The visible card and every row's mechanical writes are one intent:
  // neither may commit alone.
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }, ...ops]);
  // Each row's delivery request carries a row-discriminated idempotency key:
  // the host claims rows independently and must never conflate two rows'
  // retries of the same card.
  for (const { rowIndex, rowParams, delivery } of deliveries)
    requestSpellEffectDelivery(
      client,
      rowParams,
      delivery,
      cardId,
      `speffect-${cardId}-r${String(rowIndex)}`,
    );
  return {
    ok: true,
    lost: false,
    cardId,
    dc,
    rows: outcomes,
    warnings,
    gateNotes,
  };
}
