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
import { confirmCritical } from "../../packages/pf1e/tactical";
import type { PF1eSituationalModifiers } from "../../packages/pf1e/tactical";
import type {
  PF1eDefenseChoice,
  PF1eResolveDefender,
  PF1eResolveResult,
} from "../../packages/pf1e/resolve";
import {
  pf1eResolveAttack,
  pf1eResolveManyshot,
  pf1eResolvePrepare,
} from "../../packages/pf1e/resolve";
import { fmtSigned } from "../../packages/pf1e/rollData";
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
  /** Commit-reveal rolls + a verification chip (the plan's Verify chip). */
  verifiable?: boolean;
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
    ...(derived.dr > 0
      ? { dr: [{ value: derived.dr, bypass: derived.drBypass }] }
      : {}),
    ...(Object.keys(energyResistance).length > 0 ? { energyResistance } : {}),
  };
}

/** Wait for the host-evaluated roll message carrying our rollId to replicate. */
export async function awaitRollMessage(
  client: ResolveFlowClient,
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
  const bonus = line.attackBonuses[params.iterative] ?? line.attackBonus;
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

  // 1. The attack roll.
  const attackRoll = await rollOne(
    params.attackFormula,
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

  // 3. A hit rolls damage (the crit formula on a confirmed threat, D-139).
  let damageTotal = 0;
  let damageFormula = params.damageFormula;
  if (prepared.roll.ok && prepared.roll.hits) {
    damageFormula =
      confirmedCrit && params.critDamageFormula !== null
        ? params.critDamageFormula
        : params.damageFormula;
    const damageRoll = await rollOne(
      damageFormula,
      `${line.name} ${confirmedCrit ? "critical damage" : "damage"}`,
    );
    if (!damageRoll.ok) return damageRoll;
    if (
      damageRoll.message.roll === null ||
      typeof damageRoll.message.roll.total !== "number"
    ) {
      return { ok: false, error: "the damage roll message carries no total" };
    }
    damageTotal = damageRoll.message.roll.total;
  }

  // 4. The authoritative composition.
  const result = pf1eResolveAttack({
    ...prepareInput,
    die,
    ...(confirmDie !== undefined ? { confirmDie } : {}),
    damageTotal,
  });
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

  // 6. The resolution card (public narrative; names a rejected write honestly).
  const card = resolutionCardContent(
    {
      attackerName: params.attackerName,
      targetName: params.targetName,
      label: line.name,
      attackFormula: params.attackFormula,
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
    flavor: "attack resolution",
  };
  client.submit([{ kind: "create", coll: "messages", data: cardMessage }]);
  if (ops.length > 0) client.submit(ops);
  return { ok: true, result, hpWriteError };
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
  verifiable?: boolean | undefined;
}

/**
 * Host-roll and resolve a complete Manyshot volley. Unlike calling the single
 * attack flow repeatedly, this keeps one evolving defender state and emits one
 * public card plus one final pair of HP Ops.
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

  const defender = resolveDefenderFromDerived(params.targetName, params.targetDerived);
  const arrows: { die: number; confirmDie?: number; damageTotal: number }[] = [];
  let currentDefender = { ...defender };
  const roll = async (formula: string, flavor: string) => {
    const id = params.verifiable
      ? await client.rollVerified(formula, "roll", undefined, flavor)
      : client.roll(formula, "roll", undefined, flavor);
    const message = await awaitRollMessage(client, id);
    return message === null ? null : message;
  };

  for (let index = 0; index < params.attackFormulas.length; index += 1) {
    const formula = params.attackFormulas[index];
    if (formula === undefined) return { ok: false, error: "missing Manyshot attack formula" };
    const attack = await roll(formula, `${params.line.name} Manyshot arrow ${index + 1}`);
    if (attack === null) return { ok: false, error: "Manyshot attack roll did not arrive" };
    const die = dieFaceOf(attack);
    if (die === null) return { ok: false, error: "could not read a Manyshot attack d20" };
    const bonus = (params.line.attackBonuses[0] ?? params.line.attackBonus) - 4;
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
    });
    if (!prepare.ok) return { ok: false, error: prepare.error };
    let confirmDie: number | undefined;
    if (prepare.roll.hits && prepare.roll.threat) {
      const confirmation = await roll(
        `1d20 ${prepare.attackBonus >= 0 ? `+ ${prepare.attackBonus}` : `- ${Math.abs(prepare.attackBonus)}`}`,
        `${params.line.name} Manyshot arrow ${index + 1} confirmation`,
      );
      if (confirmation === null) return { ok: false, error: "Manyshot confirmation roll did not arrive" };
      confirmDie = dieFaceOf(confirmation) ?? undefined;
      if (confirmDie === undefined) return { ok: false, error: "could not read a Manyshot confirmation d20" };
    }
    let damageTotal = 0;
    if (prepare.roll.hits) {
      const damage = await roll(
        prepare.roll.threat && confirmDie !== undefined ? params.critDamageFormula ?? params.damageFormula : params.damageFormula,
        `${params.line.name} Manyshot arrow ${index + 1} damage`,
      );
      if (damage === null || damage.roll === null || typeof damage.roll.total !== "number")
        return { ok: false, error: "Manyshot damage roll did not arrive" };
      damageTotal = damage.roll.total;
    }
    const one = pf1eResolveManyshot({
      attack: {
        label: params.line.name,
        bonus,
        critThreatMin: params.line.critThreatMin,
        critMultiplier: params.line.critMultiplier,
        ranged: true,
        damageType: params.line.damageType,
      },
      arrows: [{ die, ...(confirmDie === undefined ? {} : { confirmDie }), damageTotal }],
      defense: params.defense,
      defender: currentDefender,
      ...(params.situational ? { situational: params.situational } : {}),
      ...(params.nonlethalDamage === undefined ? {} : { nonlethalDamage: params.nonlethalDamage }),
      ...(params.feats === undefined ? {} : { feats: params.feats }),
    });
    if (!one.ok) return one;
    const result = one.arrows[0];
    if (!result) return { ok: false, error: "Manyshot produced no arrow result" };
    arrows.push({ die, ...(confirmDie === undefined ? {} : { confirmDie }), damageTotal });
    currentDefender = { ...currentDefender, hp: result.hp.after, nonlethalDamage: result.nonlethal.after };
  }

  const resolved = pf1eResolveManyshot({
    attack: {
      label: params.line.name,
      bonus: (params.line.attackBonuses[0] ?? params.line.attackBonus) - 4,
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
  client.submit([{ kind: "create", coll: "messages", data: {
    _id: globalThis.crypto.randomUUID(), type: "message", name: `${params.attackerName} Manyshot`,
    ownership: { default: 1 }, flags: {}, system: {}, author: user?.id ?? "", whisper: [], roll: null,
    flavor: "Manyshot resolution", content: `${params.attackerName}: ${params.line.name} Manyshot against ${params.targetName}\n${resolved.arrows.map((arrow, index) => `Arrow ${index + 1}: ${arrow.outcome}, ${arrow.damage?.dealt ?? 0} damage`).join("\n")}\nHP ${defender.hp} → ${resolved.finalHp}.`,
  } as MessageDocument }]);
  if (ops.length) client.submit(ops);
  return { ok: true, results: resolved.arrows, hpWriteError };
}
