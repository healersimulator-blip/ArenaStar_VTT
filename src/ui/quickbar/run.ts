/**
 * §2.2 item 2 (G-10b, D-261) — running one quickbar slot.
 *
 * Every slot runs the **sheet's own** flow rather than a second implementation of the rules: an
 * attack is `resolveAttackFlow` (the same call the sheet's Resolve button makes, with the standard
 * action's first iterative and no situational toggles), the damage verb is the public roll card the
 * sheet's damage button makes, an item slot is the `resolveCastFlow` call `PF1eItemWindow` makes
 * with its `source`, so a charge is spent and written, and a **spell** slot (D-407) is the same flow
 * the sheet's cast form uses — with the save and the condition taken from the tactical catalogue
 * rather than from a form a hot bar does not have. A slot that cannot run says why.
 */
import type { ClientSync } from "../../client/sync";
import type { ActorDocument } from "../../core/documents";
import type { FxItemEvent, FxItemOutcome } from "../sheets/fxItemCue";
import { worldSettingsFrom } from "../../core/worldSettings";
import { consumableCastAuthored } from "../../packages/pf1e/consumables";
import { pf1eAttackRollGroups } from "../../packages/pf1e/rollData";
import { resolveCastFlow } from "../sheets/pf1eCastFlow";
import { pf1eSpellEffectByName } from "../../packages/pf1e/spellEffects";
import { castSpellCueNote, fireBoundItemCue, fxCastOutcome, fxItemCueNote } from "../sheets/fxItemCue";
import { attackLineItemId, pf1eItemView } from "../sheets/pf1eItemsTab";
import { resolveAttackFlow } from "../sheets/pf1eResolveFlow";
import { pf1eSheetView } from "../sheets/pf1eSheetModel";
import { pf1eSpellbookView } from "../sheets/pf1eSpellbook";
import type { PF1eQuickbarEntry } from "./model";

export interface PF1eQuickbarRunInput {
  client: ClientSync;
  /** The character the bar is playing (the selected token's actor). */
  actor: ActorDocument;
  entry: PF1eQuickbarEntry;
  /** The selected token's actor — required by every verb except a damage roll. */
  target: ActorDocument | null;
}

export type PF1eQuickbarRunResult =
  | { ok: true; note: string }
  | { ok: false; error: string };

/**
 * D-311/D-312: the note a bound cue adds to a committed item use — empty when the item has no
 * binding this reader can see, and a sentence when it does (including when the binding is
 * disabled or has no cue for that outcome, because "nothing happened" needs saying then).
 */
function boundCueNote(
  client: ClientSync,
  actor: ActorDocument,
  item: { _id: string },
  outcome: FxItemOutcome,
  target: ActorDocument,
  event: FxItemEvent = "use",
): string {
  return fxItemCueNote(
    fireBoundItemCue({ client, actor, item, outcome, event, targetActor: target }));
}

/**
 * D-312: a line authored from an item is the item attacking, so a binding that fires on the
 * `attack` event follows the roll — and only a line that **names** its item (`itemId`, written
 * by `createAttackFromWeaponOp`) can be recognized as that item's. A hand-authored line is not
 * any item's, and guessing by name would fire the wrong cue.
 */
function attackCueNote(
  client: ClientSync,
  actor: ActorDocument,
  index: number,
  outcome: "miss" | "hit" | "crit",
  target: ActorDocument,
): string {
  const itemId = attackLineItemId(actor, index);
  if (itemId === null) return "";
  return boundCueNote(client, actor, { _id: itemId },
    outcome === "miss" ? "failure" : "success", target, "attack");
}

/**
 * D-407 — a hot-bar cast of a **prepared spell**. The catalogue supplies the mechanics the sheet's
 * cast form would otherwise ask the player for (save, severity, the condition the effect delivers),
 * and `resolveCastFlow` does everything else: the concentration gate from the row's Components line,
 * the DC from the derived spell DC, the slot spend, the card and the condition delivery on a landed
 * save. The bound *spell* cue (S5a) is fired after the flow commits, exactly as the sheet does it.
 */
async function runSpellSlot(input: {
  client: ClientSync;
  actor: ActorDocument;
  view: ReturnType<typeof pf1eSheetView>;
  target: ActorDocument;
  targetView: ReturnType<typeof pf1eSheetView>;
  entry: PF1eQuickbarEntry;
}): Promise<PF1eQuickbarRunResult> {
  const { client, actor, view, target, targetView, entry } = input;
  const name = entry.label.replace(/ \(level \d+\)$/, "").trim();
  const effect = pf1eSpellEffectByName(name);
  if (effect === null) return { ok: false, error: `${name} has no authored tactical effect` };
  const preparedIndex = entry.preparedIndex ?? null;
  const prepared = preparedIndex === null
    ? null : pf1eSpellbookView(actor, view.derived).prepared[preparedIndex] ?? null;
  if (preparedIndex !== null && prepared === null)
    return { ok: false, error: "the bound prepared row is gone — re-prepare and re-bind" };
  if (prepared !== null && pf1eSpellEffectByName(prepared.name)?.id !== effect.id)
    return { ok: false, error: `the bound row now holds ${prepared.name}, not ${effect.name}` };
  const level = prepared?.level ?? entry.spellLevel ?? 0;
  const outcome = await resolveCastFlow(client, client.user, {
    casterActor: actor,
    casterDerived: view.derived,
    spell: {
      name: effect.name,
      level,
      ...(preparedIndex !== null ? { preparedIndex } : {}),
    },
    spellEffectId: effect.id,
    authored: {
      saveType: effect.save?.type ?? "ref",
      severity: effect.save?.severity ?? "none",
      damageFormula: "",
    },
    targetName: target.name,
    targetActor: target,
    targetDerived: targetView.derived,
    targetFeats: Array.isArray(targetView.authored.feats)
      ? (targetView.authored.feats as string[])
      : [],
    castingTime: "standard",
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  if (outcome.lost) return { ok: false, error: `${effect.name} was lost before it resolved` };
  const cue = castSpellCueNote({ client, spellName: effect.name, outcome: fxCastOutcome(outcome),
    caster: actor, target });
  if (outcome.pending) {
    return { ok: true, note: `${effect.name} → ${target.name} — awaiting ${
      outcome.pendingRollId ? "the target's save" : "completion"}` };
  }
  if (outcome.held) {
    return { ok: true, note: `${effect.name} held for delivery — the charge is spent${cue}` };
  }
  return { ok: true, note: `${effect.name} → ${target.name} — DC ${String(outcome.dc)}, ${
    effect.save === null ? "no save" : `${effect.save.type.toUpperCase()} save`}${
    outcome.result.passed ? " made" : " failed"}${cue}` };
}

export async function runQuickbarEntry(
  input: PF1eQuickbarRunInput,
): Promise<PF1eQuickbarRunResult> {
  const { client, actor, entry, target } = input;
  const settings = worldSettingsFrom(client.store.getAll("settings"));
  const view = pf1eSheetView(actor, { settings });

  if (entry.kind === "damage") {
    const group = pf1eAttackRollGroups(view.derived)[entry.attackIndex];
    if (group === undefined) return { ok: false, error: `no attack line at index ${String(entry.attackIndex)}` };
    if (group.damage === null)
      return { ok: false, error: `${group.label} has no damage roll to make` };
    client.roll(group.damage.formula, "roll", undefined, `${group.label} damage`);
    return { ok: true, note: `${group.damage.formula} rolled — apply it from the card` };
  }

  if (target === null) return { ok: false, error: "pick a target first" };
  const targetView = pf1eSheetView(target, { settings });

  if (entry.kind === "attack") {
    const group = pf1eAttackRollGroups(view.derived)[entry.attackIndex];
    if (group === undefined) return { ok: false, error: `no attack line at index ${String(entry.attackIndex)}` };
    const line = view.derived.attacks[entry.attackIndex];
    if (line === undefined) return { ok: false, error: `no attack line at index ${String(entry.attackIndex)}` };
    const outcome = await resolveAttackFlow(client, client.user, {
      attackerName: actor.name,
      line,
      iterative: 0,
      attackFormula: group.attack.formula,
      damageFormula: group.damage?.formula ?? "0",
      critDamageFormula: group.critDamage?.formula ?? null,
      targetName: target.name,
      targetActor: target,
      targetDerived: targetView.derived,
      defense: "normal",
      ...(group.provokes ? { provokes: true } : {}),
      attackerBab: Math.trunc(view.derived.baseAttack),
      attackerActor: actor,
      attackerAttackIndex: entry.attackIndex,
      ...(Array.isArray(view.authored.feats) ? { feats: view.authored.feats as string[] } : {}),
    });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    if (!outcome.result.ok) return { ok: false, error: outcome.result.error };
    const result = outcome.result;
    const dealt = result.damage?.dealt ?? 0;
    return {
      ok: true,
      note:
        `${line.name} vs ${target.name} — ${result.outcome}` +
        (result.outcome === "miss"
          ? ` (AC ${String(result.defenseAc)})`
          : ` for ${String(dealt)} — ${target.name} hp ${String(result.hp.before)} → ${String(result.hp.after)}`) +
        (outcome.hpWriteError === null ? "" : ` (⚠ hit points not written: ${outcome.hpWriteError})`) +
        // D-312: after the resolve, never before — a refused or errored attack above returns
        // without ever reaching this note, so a bound attack cue can only follow a committed swing.
        attackCueNote(client, actor, entry.attackIndex, result.outcome, target),
    };
  }

  if (entry.kind === "spell") {
    return runSpellSlot({ client, actor, view, target, targetView, entry });
  }

  const itemId = entry.itemId;
  const item = itemId === null ? null : pf1eItemView(actor, itemId);
  if (item === null || item.consumable === null)
    return { ok: false, error: "the bound item no longer holds a spell" };
  const source = item.consumable;
  if (!source.castable) return { ok: false, error: `${item.item.name} has no charges left` };
  const outcome = await resolveCastFlow(client, client.user, {
    casterActor: actor,
    casterDerived: view.derived,
    spell: { name: source.spellName, level: source.spellLevel },
    authored: consumableCastAuthored(source.spell),
    targetName: target.name,
    targetActor: target,
    targetDerived: targetView.derived,
    castingTime: "standard",
    source: {
      kind: source.kind,
      itemId: item.item.id,
      itemName: item.item.name,
      casterLevel: source.casterLevel,
      saveDc: source.saveDc,
      charges: source.charges,
    },
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  if (outcome.lost) {
    // The 5-ft step out of a readied action's reach, a failed concentration check: the slot is
    // spent and the card says so — the same report the sheet shows.
    return { ok: false, error: `${source.spellName} was lost before it resolved` };
  }
  if (outcome.pending) {
    // F03: the target's save is still to be rolled from the pending card. Nothing has landed
    // yet, so a bound cue has no committed result to recognise and none is requested.
    return {
      ok: true,
      note: `${source.spellName} from ${item.item.name} → ${target.name} — awaiting the save`,
    };
  }
  if (outcome.held) {
    return {
      ok: true,
      note: `${source.spellName} held for delivery — the charge is spent` +
        boundCueNote(client, actor, { _id: item.item.id }, fxCastOutcome(outcome), target) +
        castSpellCueNote({ client, spellName: source.spellName, outcome: fxCastOutcome(outcome),
          caster: actor, target }),
    };
  }
  return {
    ok: true,
    note: `${source.spellName} from ${item.item.name} → ${target.name} — DC ${String(
      outcome.dc,
    )}, ${String(Math.max(0, source.charges - 1))} charge(s) left` +
      boundCueNote(client, actor, { _id: item.item.id }, fxCastOutcome(outcome), target) +
      castSpellCueNote({ client, spellName: source.spellName, outcome: fxCastOutcome(outcome),
        caster: actor, target }),
  };
}
