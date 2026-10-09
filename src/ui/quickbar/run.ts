/**
 * §2.2 item 2 (G-10b, D-261) — running one quickbar slot.
 *
 * Every slot runs the **sheet's own** flow rather than a second implementation of the rules: an
 * attack is `resolveAttackFlow` (the same call the sheet's Resolve button makes, with the standard
 * action's first iterative and no situational toggles), the damage verb is the public roll card the
 * sheet's damage button makes, an item slot is the `resolveCastFlow` call `PF1eItemWindow` makes
 * with its `source`, so a charge is spent and written, and a **spell** slot (D-407) is the same flow
 * the sheet's cast form uses — authored tactical effects supply their mechanics, while every
 * other spell carries a caller-reviewed save/damage profile from its quickbar binding. Bound FX
 * uses the exact normalized spell name and follows the committed cast in either case.
 */
import type { ClientSync } from "../../client/sync";
import type { ActionArea } from "../../core/action";
import type { ActorDocument, SceneDocument } from "../../core/documents";
import { fxSpellKeyFromName } from "../../core/fxBinding";
import type { FxItemEvent, FxItemOutcome } from "../sheets/fxItemCue";
import { worldSettingsFrom } from "../../core/worldSettings";
import { consumableCastAuthored } from "../../packages/pf1e/consumables";
import { pf1eAttackRollGroups } from "../../packages/pf1e/rollData";
import { resolveCastFlow } from "../sheets/pf1eCastFlow";
import { resolveAreaCastFlow } from "../sheets/pf1eAreaCastFlow";
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

/** Warm the supplied media while a player is still choosing the spell's area/direction. */
export function prefetchQuickbarSpellFx(input: {
  client: ClientSync;
  scene: SceneDocument;
  spellName: string;
  requestAsset: (assetId: string, mime: string) => Promise<unknown>;
}): void {
  const name = input.spellName.trim().toLowerCase();
  const keys = name === "lightning bolt"
    ? ["lightningEffect"]
    : name === "entangle" ? ["entangleAreaEffect", "entangledTokenEffect"] : [];
  const flags = input.scene.flags as Record<string, unknown>;
  const core = flags.core && typeof flags.core === "object"
    ? flags.core as Record<string, unknown> : null;
  const demo = core?.spellDemo && typeof core.spellDemo === "object"
    ? core.spellDemo as Record<string, unknown> : null;
  const assets = demo?.assets && typeof demo.assets === "object"
    ? demo.assets as Record<string, unknown> : null;
  for (const key of keys) {
    const entry = assets?.[key] && typeof assets[key] === "object"
      ? assets[key] as Record<string, unknown> : null;
    const assetId = typeof entry?.assetId === "string" ? entry.assetId : null;
    if (!assetId) continue;
    const mime = input.client.store.world.assetManifest[assetId]?.mime ?? "video/webm";
    void input.requestAsset(assetId, mime).catch(() => undefined);
  }
}

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
 * D-407 — a hot-bar cast of a prepared or known spell. Catalogue rows supply authored mechanics;
 * an unmodeled compendium spell needs an explicit, validated-at-readback cast profile from the
 * binding UI instead of silently inventing a save or damage rule. `resolveCastFlow` does the rest:
 * components, DC, slot spend, action card, condition delivery when authored, and the FX cue after
 * the committed outcome.
 */
async function runSpellSlot(input: {
  client: ClientSync;
  actor: ActorDocument;
  view: ReturnType<typeof pf1eSheetView>;
  target: ActorDocument;
  targetView: ReturnType<typeof pf1eSheetView>;
  entry: PF1eQuickbarEntry;
  resourceAlreadySpent?: boolean;
  suppressSpellCue?: boolean;
  context?: {
    sceneId: string;
    casterTokenId: string;
    targetTokenId: string;
    area?: ActionArea;
  };
}): Promise<PF1eQuickbarRunResult> {
  const { client, actor, view, target, targetView, entry } = input;
  const name = entry.label.replace(/ \(level \d+\)$/, "").trim();
  const effect = pf1eSpellEffectByName(name);
  const lightningLine = name.toLowerCase() === "lightning bolt" && input.context?.area?.shape === "line";
  const profile = effect === null && !lightningLine ? entry.spellProfile : undefined;
  if (effect === null && !lightningLine && profile === undefined)
    return { ok: false, error: `${name} needs a reviewed save, severity and damage profile in its quickbar binding` };
  const spellName = effect?.name ?? name;
  const saveType = effect?.save?.type ?? profile?.saveType ?? "ref";
  const severity = effect !== null
    ? effect.save?.severity ?? "none"
    : profile?.severity ?? (lightningLine ? "half" : "none");
  const damageFormula = lightningLine ? "6d6" : profile?.damageFormula ?? "";
  const energyType = lightningLine ? "electricity" as const : profile?.energyType;
  const preparedIndex = entry.preparedIndex ?? null;
  const prepared = preparedIndex === null
    ? null : pf1eSpellbookView(actor, view.derived).prepared[preparedIndex] ?? null;
  if (preparedIndex !== null && prepared === null)
    return { ok: false, error: "the bound prepared row is gone — re-prepare and re-bind" };
  if (prepared !== null && fxSpellKeyFromName(prepared.name) !== fxSpellKeyFromName(spellName))
    return { ok: false, error: `the bound row now holds ${prepared.name}, not ${spellName}` };
  const level = prepared?.slotLevel ?? prepared?.level ?? entry.spellLevel ?? 0;
  const components = prepared?.components.trim() || entry.spellComponents?.trim() || "";
  const gate = components === "" ? undefined : {
    components,
    caster: { canSpeak: true, hasFreeHand: true, componentsInHand: true,
      deafened: false, grappled: false, pinned: false },
    castingTime: "standard" as const,
    declarations: [],
  };
  if (preparedIndex === null) {
    const pf1e = (actor.system as Record<string, unknown>).pf1e;
    const spells = pf1e && typeof pf1e === "object" && !Array.isArray(pf1e)
      ? (pf1e as Record<string, unknown>).spells : undefined;
    const known = spells && typeof spells === "object" && !Array.isArray(spells)
      ? (spells as Record<string, unknown>).known : undefined;
    if (!Array.isArray(known) || !known.some((raw) => raw && typeof raw === "object" && !Array.isArray(raw) &&
        typeof (raw as Record<string, unknown>).name === "string" &&
        fxSpellKeyFromName((raw as Record<string, unknown>).name as string) === fxSpellKeyFromName(spellName) &&
        ((raw as Record<string, unknown>).slotLevel === level ||
          (raw as Record<string, unknown>).slotLevel === undefined && (raw as Record<string, unknown>).level === level)))
      return { ok: false, error: `${spellName} is no longer in this caster's known spells at level ${String(level)}` };
  }
  const outcome = await resolveCastFlow(client, client.user, {
    ...(input.resourceAlreadySpent ? { resourceAlreadySpent: true } : {}),
    ...(input.context ? { context: input.context } : {}),
    casterActor: actor,
    casterDerived: view.derived,
    spell: {
      name: spellName,
      level,
      ...(preparedIndex !== null ? { preparedIndex } : {}),
    },
    ...(effect !== null ? { spellEffectId: effect.id } : {}),
    ...(gate !== undefined ? { gate } : {}),
    authored: {
      saveType,
      severity,
      damageFormula,
      ...(energyType !== undefined ? { energyType } : {}),
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
  const committedSpellCue = (): string => input.suppressSpellCue ? "" : castSpellCueNote({
    client, spellName, outcome: fxCastOutcome(outcome), caster: actor, target,
    ...(input.context ? { sceneId: input.context.sceneId, sourceTokenId: input.context.casterTokenId,
      targetTokenId: input.context.targetTokenId } : {}),
  });
  if (outcome.lost)
    return { ok: false, error: `${spellName} was lost before it resolved${committedSpellCue()}` };
  if (outcome.pending) {
    return { ok: true, note: `${spellName} → ${target.name} — awaiting ${
      outcome.pendingRollId ? "the target's save" : "completion"}` };
  }
  const cue = committedSpellCue();
  if (outcome.held) {
    return { ok: true, note: `${spellName} held for delivery — the charge is spent${cue}` };
  }
  const saveDescription = severity === "none" ? "no save" : `${saveType.toUpperCase()} save`;
  return { ok: true, note: `${spellName} → ${target.name} — DC ${String(outcome.dc)}, ${saveDescription}${
    outcome.result.passed ? " made" : " failed"}${cue}` };
}

/**
 * D-408 — resolve one Entangle area as one slot expenditure, one card and one commit across
 * every affected creature. The loop over single-target casts is gone: a mid-area failure used to
 * leave earlier rows committed while later ones never resolved, and the area flow fails the whole
 * cast before anything is spent instead.
 */
export async function runQuickbarEntangleArea(input: {
  client: ClientSync;
  actor: ActorDocument;
  entry: PF1eQuickbarEntry;
  scene: SceneDocument;
  casterTokenId: string;
  origin: { x: number; y: number };
  targets: readonly { tokenId: string; actor: ActorDocument }[];
}): Promise<PF1eQuickbarRunResult> {
  const name = input.entry.label.replace(/ \(level \d+\)$/, "").trim();
  if (input.entry.kind !== "spell" || name.toLowerCase() !== "entangle")
    return { ok: false, error: "Only the Entangle quickbar spell supports spread casting." };
  if (input.targets.length === 0)
    return { ok: false, error: "No creature footprint intersects that spread; no slot was spent." };
  if (input.scene.grid.type !== "square" || input.scene.grid.units !== "ft" ||
      !Number.isFinite(input.scene.grid.size) || input.scene.grid.size <= 0 ||
      !Number.isInteger(input.origin.x / input.scene.grid.size) ||
      !Number.isInteger(input.origin.y / input.scene.grid.size))
    return { ok: false, error: "Entangle needs a feet-based square grid intersection; no slot was spent." };
  const area: ActionArea = {
    sceneId: input.scene._id,
    shape: "spread",
    origin: { ...input.origin },
    radius: 40,
    units: "ft",
  };
  // The binding resolution mirrors a single-target slot cast (`runSpellSlot`): catalogue
  // mechanics when the spell is modeled, else the binding's reviewed profile — never invented.
  const effect = pf1eSpellEffectByName(name);
  const profile = effect === null ? input.entry.spellProfile : undefined;
  if (effect === null && profile === undefined)
    return { ok: false, error: `${name} needs a reviewed save, severity and damage profile in its quickbar binding` };
  const spellName = effect?.name ?? name;
  const saveType = effect?.save?.type ?? profile?.saveType ?? "ref";
  const severity = effect !== null
    ? effect.save?.severity ?? "none"
    : profile?.severity ?? "none";
  const damageFormula = profile?.damageFormula ?? "";
  const energyType = profile?.energyType;
  const preparedIndex = input.entry.preparedIndex ?? null;
  const settings = worldSettingsFrom(input.client.store.getAll("settings"));
  const view = pf1eSheetView(input.actor, { settings });
  const prepared = preparedIndex === null
    ? null : pf1eSpellbookView(input.actor, view.derived).prepared[preparedIndex] ?? null;
  if (preparedIndex !== null && prepared === null)
    return { ok: false, error: "the bound prepared row is gone — re-prepare and re-bind" };
  if (prepared !== null && fxSpellKeyFromName(prepared.name) !== fxSpellKeyFromName(spellName))
    return { ok: false, error: `the bound row now holds ${prepared.name}, not ${spellName}` };
  const level = prepared?.slotLevel ?? prepared?.level ?? input.entry.spellLevel ?? 0;
  const components = prepared?.components.trim() || input.entry.spellComponents?.trim() || "";
  const gate = components === "" ? undefined : {
    components,
    caster: { canSpeak: true, hasFreeHand: true, componentsInHand: true,
      deafened: false, grappled: false, pinned: false },
    castingTime: "standard" as const,
    declarations: [],
  };
  if (preparedIndex === null) {
    const pf1e = (input.actor.system as Record<string, unknown>).pf1e;
    const spells = pf1e && typeof pf1e === "object" && !Array.isArray(pf1e)
      ? (pf1e as Record<string, unknown>).spells : undefined;
    const known = spells && typeof spells === "object" && !Array.isArray(spells)
      ? (spells as Record<string, unknown>).known : undefined;
    if (!Array.isArray(known) || !known.some((raw) => raw && typeof raw === "object" && !Array.isArray(raw) &&
        typeof (raw as Record<string, unknown>).name === "string" &&
        fxSpellKeyFromName((raw as Record<string, unknown>).name as string) === fxSpellKeyFromName(spellName) &&
        ((raw as Record<string, unknown>).slotLevel === level ||
          (raw as Record<string, unknown>).slotLevel === undefined && (raw as Record<string, unknown>).level === level)))
      return { ok: false, error: `${spellName} is no longer in this caster's known spells at level ${String(level)}` };
  }
  const outcome = await resolveAreaCastFlow(input.client, input.client.user, {
    casterActor: input.actor,
    casterDerived: view.derived,
    casterTokenId: input.casterTokenId,
    spell: {
      name: spellName,
      level,
      ...(preparedIndex !== null ? { preparedIndex } : {}),
    },
    ...(effect !== null ? { spellEffectId: effect.id } : {}),
    ...(gate !== undefined ? { gate } : {}),
    authored: {
      saveType,
      severity,
      damageFormula,
      ...(energyType !== undefined ? { energyType } : {}),
    },
    area,
    targets: input.targets.map((target) => {
      const targetView = pf1eSheetView(target.actor, { settings });
      return {
        name: target.actor.name,
        actor: target.actor,
        derived: targetView.derived,
        feats: Array.isArray(targetView.authored.feats)
          ? (targetView.authored.feats as string[])
          : [],
        tokenId: target.tokenId,
      };
    }),
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const first = input.targets[0] as { tokenId: string; actor: ActorDocument };
  // One spell-bound area timeline per cast, not one copy per creature row. Its target anchor is the
  // first affected token; the host plays the saved 40-ft-area visual to this scene's entitled peers.
  // The thicket appears whether the saves fail or not — the zone outlives every row.
  const cue = (cueOutcome: "success" | "failure"): string => castSpellCueNote({
    client: input.client, spellName, outcome: cueOutcome, caster: input.actor, target: first.actor,
    sceneId: input.scene._id, sourceTokenId: input.casterTokenId, targetTokenId: first.tokenId,
  });
  if (outcome.lost)
    return { ok: false, error: `${spellName} was lost before it resolved${cue("failure")}` };
  const saveDescription = severity === "none" ? "no save" : `${saveType.toUpperCase()} save`;
  const reports = outcome.rows.map((row) =>
    `${spellName} → ${row.targetName} — DC ${String(outcome.dc)}, ${saveDescription}${row.result.passed ? " made" : " failed"}`);
  return { ok: true, note: `Entangle — 40-ft-radius spread at (${String(input.origin.x)}, ${
    String(input.origin.y)}); ${String(outcome.rows.length)} target row(s): ${reports.join("; ")}${cue("success")}` };
}

/** Resolve a caster-level-six Lightning Bolt line once across all intersected creature footprints. */
export async function runQuickbarLightningBoltLine(input: {
  client: ClientSync;
  actor: ActorDocument;
  entry: PF1eQuickbarEntry;
  scene: SceneDocument;
  casterTokenId: string;
  origin: { x: number; y: number };
  direction: { x: number; y: number };
  targets: readonly { tokenId: string; actor: ActorDocument }[];
  effectMacroId?: string;
}): Promise<PF1eQuickbarRunResult> {
  const name = input.entry.label.replace(/ \(level \d+\)$/, "").trim();
  if (input.entry.kind !== "spell" || name.toLowerCase() !== "lightning bolt")
    return { ok: false, error: "Only Lightning Bolt supports the 90-ft line cast." };
  if (input.targets.length === 0)
    return { ok: false, error: "No creature footprint intersects that line; no slot was spent." };
  const casterToken = input.scene.tokens.find((token) => token._id === input.casterTokenId);
  const directionLength = Math.hypot(input.direction.x, input.direction.y);
  if (!casterToken || casterToken.actorId !== input.actor._id || input.scene.grid.type !== "square" ||
      input.scene.grid.units !== "ft" || !Number.isFinite(input.scene.grid.size) || input.scene.grid.size <= 0 ||
      Math.abs(input.origin.x - casterToken.x) > 1e-6 || Math.abs(input.origin.y - casterToken.y) > 1e-6 ||
      !Number.isFinite(directionLength) || Math.abs(directionLength - 1) > 1e-6 ||
      input.targets.some((target) => target.tokenId === input.casterTokenId))
    return { ok: false, error: "Lightning Bolt needs a verified 90-ft direction from the selected caster; no slot was spent." };
  const area: ActionArea = {
    sceneId: input.scene._id, shape: "line", origin: { ...input.origin },
    length: 90, width: 5, direction: { ...input.direction }, units: "ft",
  };
  const settings = worldSettingsFrom(input.client.store.getAll("settings"));
  const view = pf1eSheetView(input.actor, { settings });
  const reports: string[] = [];
  let farthest: { tokenId: string; actor: ActorDocument; distance: number } | undefined;
  for (const [index, target] of input.targets.entries()) {
    const targetView = pf1eSheetView(target.actor, { settings });
    const outcome = await runSpellSlot({
      client: input.client, actor: input.actor, view, target: target.actor, targetView,
      entry: input.entry, resourceAlreadySpent: index > 0, suppressSpellCue: true,
      context: { sceneId: input.scene._id, casterTokenId: input.casterTokenId,
        targetTokenId: target.tokenId, area },
    });
    if (!outcome.ok) {
      return { ok: false, error: index === 0 ? outcome.error
        : `Lightning Bolt has resolved ${String(index)} target row(s), but stopped at ${target.actor.name}: ${outcome.error}` };
    }
    const token = input.scene.tokens.find((candidate) => candidate._id === target.tokenId);
    if (token) {
      const distance = (token.x - input.origin.x) * input.direction.x +
        (token.y - input.origin.y) * input.direction.y;
      if (!farthest || distance > farthest.distance) farthest = { ...target, distance };
    }
    reports.push(outcome.note);
  }
  let cue = "";
  if (input.effectMacroId && farthest) {
    input.client.requestSequence(input.effectMacroId, input.scene._id, input.casterTokenId, farthest.tokenId);
    cue = " · Lightning Bolt effect requested";
  }
  return { ok: true, note: `Lightning Bolt — 90-ft line, 5 ft wide; ${String(input.targets.length)} target row(s): ${
    reports.join("; ")}${cue}` };
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
