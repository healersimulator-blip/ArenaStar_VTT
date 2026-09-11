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
 *    permission narrates but cannot write.
 */
import type { Op } from "../../core/ops";
import type { PermissionUser } from "../../core/ownership";
import type {
  ActorDocument,
  CombatDocument,
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
  srAlreadyOvercome,
  srOvercomeBlobFromFlags,
  srOvercomeDiff,
} from "../../packages/pf1e/srLedger";
import { pf1eSheetEdit, sheetRecord } from "./pf1eSheetModel";
import { pf1eSpellbookEdit } from "./pf1eSpellbook";
import { awaitRollMessage, dieFaceOf } from "./pf1eResolveFlow";

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
}

export type PF1eCastFlowOutcome =
  | {
      ok: true;
      dc: number;
      sr: PF1eSrResult;
      result: Extract<PF1eSpellTargetResult, { ok: true }>;
      /** Over-budget slot spends and similar MVP warnings (allowed, reported). */
      warnings: string[];
      hpWriteError: string | null;
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

  // ── the daily bookkeeping, validated BEFORE any die is rolled so a refused
  //    cast publishes nothing: slot spend + prepared expense (D-155 builders) ──
  const warnings: string[] = [];
  const ops: Op[] = [];
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
      `${spell.name} damage`,
    );
    const message = await awaitRollMessage(client, rollId);
    if (
      message === null ||
      message.roll === null ||
      typeof message.roll.total !== "number"
    )
      return fail("The damage roll message carries no total.");
    damageTotal = Math.max(0, Math.trunc(message.roll.total));
  }

  // ── spell resistance (once per round per target; no natural-die cases) ───
  const spellResistance = params.targetDerived.spellResistance;
  const round =
    params.combat && params.combat.round >= 1 ? params.combat.round : null;
  const blob =
    params.combat !== null && params.combat !== undefined
      ? srOvercomeBlobFromFlags(params.combat.flags)
      : null;
  const reused =
    params.srOvercomeByCaller === true ||
    (round !== null &&
      blob !== null &&
      srAlreadyOvercome(
        blob,
        params.casterActor._id,
        params.targetActor._id,
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
        `${spell.name} caster level check vs SR ${spellResistance}`,
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
      ? params.targetDerived.saves.fort
      : authored.saveType === "ref"
        ? params.targetDerived.saves.ref
        : params.targetDerived.saves.will;
  if (allowsSave) {
    const rollId = client.roll(
      "1d20",
      "roll",
      undefined,
      `${params.targetName} ${authored.saveType} save vs ${spell.name}`,
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
    Object.entries(params.targetDerived.energyResistance).filter(
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
    dc,
    saveBonus,
    ...(saveDie !== undefined ? { saveDie } : {}),
    evasion: hasPF1eFeat(params.targetFeats, "Evasion"),
    improvedEvasion: hasPF1eFeat(params.targetFeats, "Improved Evasion"),
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
      ref: { coll: "combats", id: (params.combat as CombatDocument)._id },
      diff: srOvercomeDiff(
        params.casterActor._id,
        params.targetActor._id,
        round,
      ),
    });
  }

  // ── the HP write (permission-checked; a refused write is narrated) ────────
  let hpWriteError: string | null = null;
  if (target.dealt > 0) {
    const after = params.targetDerived.hp - target.dealt;
    const edit = pf1eSheetEdit(params.targetActor, user, "hp", String(after));
    if (edit.error !== null) hpWriteError = edit.error;
    else ops.push(...edit.ops);
  }

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
    dc,
    sr,
    result: target,
    warnings,
    hpWriteError,
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
): { name: string; content: string } {
  const lines: string[] = [];
  const slotNote =
    ctx.slotLevel === ctx.spellLevel
      ? `level ${ctx.spellLevel}`
      : `level ${ctx.spellLevel} cast at slot ${ctx.slotLevel}`;
  lines.push(
    `${ctx.casterName} casts ${ctx.spellName} (${slotNote}) at ${ctx.targetName} — DC ${res.dc}.`,
  );
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
