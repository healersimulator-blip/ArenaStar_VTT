/**
 * §2.2 item 2 (G-10b, D-261) — running one quickbar slot.
 *
 * Every slot runs the **sheet's own** flow rather than a second implementation of the rules: an
 * attack is `resolveAttackFlow` (the same call the sheet's Resolve button makes, with the standard
 * action's first iterative and no situational toggles), the damage verb is the public roll card the
 * sheet's damage button makes, and an item slot is the `resolveCastFlow` call `PF1eItemWindow` makes
 * with its `source`, so a charge is spent and written. A slot that cannot run says why.
 */
import type { ClientSync } from "../../client/sync";
import type { ActorDocument } from "../../core/documents";
import { worldSettingsFrom } from "../../core/worldSettings";
import { consumableCastAuthored } from "../../packages/pf1e/consumables";
import { pf1eAttackRollGroups } from "../../packages/pf1e/rollData";
import { resolveCastFlow } from "../sheets/pf1eCastFlow";
import { pf1eItemView } from "../sheets/pf1eItemsTab";
import { resolveAttackFlow } from "../sheets/pf1eResolveFlow";
import { pf1eSheetView } from "../sheets/pf1eSheetModel";
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
        (outcome.hpWriteError === null ? "" : ` (⚠ hit points not written: ${outcome.hpWriteError})`),
    };
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
    // F03: the target's save is still to be rolled from the pending card.
    return {
      ok: true,
      note: `${source.spellName} from ${item.item.name} → ${target.name} — awaiting the save`,
    };
  }
  if (outcome.held) {
    return {
      ok: true,
      note: `${source.spellName} held for delivery — the charge is spent`,
    };
  }
  return {
    ok: true,
    note: `${source.spellName} from ${item.item.name} → ${target.name} — DC ${String(
      outcome.dc,
    )}, ${String(Math.max(0, source.charges - 1))} charge(s) left`,
  };
}
