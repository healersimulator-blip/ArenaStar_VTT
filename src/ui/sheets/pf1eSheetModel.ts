/** P1 sheet adapter: no rules arithmetic and no local store writes. */
import type { ActorDocument, BaseDocument, Json } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { can } from "../../core/permissions";
import { deriveFromDocuments } from "../../packages/pf1e/actor";
import { readTacticalEffects } from "../../packages/pf1e/effects";
import { normalizePF1eSystem } from "../../packages/pf1e/statBlock";

export function isPF1eActor(doc: BaseDocument): doc is ActorDocument {
  const block = doc.system.pf1e;
  return (
    doc.type === "actor" && block !== null && typeof block === "object" && !Array.isArray(block)
  );
}

export const SHEET_FIELDS = [
  ["abilities.str", "Strength"],
  ["abilities.dex", "Dexterity"],
  ["abilities.con", "Constitution"],
  ["abilities.int", "Intelligence"],
  ["abilities.wis", "Wisdom"],
  ["abilities.cha", "Charisma"],
  ["hp", "Current HP"],
  ["hpMax", "Maximum HP"],
  ["nonlethalDamage", "Nonlethal damage"],
  ["tempHp", "Remaining temporary HP (manual)"],
  ["energyResistance.acid", "Acid resistance (manual)"],
  ["energyResistance.cold", "Cold resistance (manual)"],
  ["energyResistance.electricity", "Electricity resistance (manual)"],
  ["energyResistance.fire", "Fire resistance (manual)"],
  ["energyResistance.sonic", "Sonic resistance (manual)"],
  ["baseAttack", "Base attack bonus"],
  ["initiative", "Initiative misc"],
  ["speedFt", "Speed (ft)"],
  ["saves.fort", "Fortitude authored"],
  ["saves.ref", "Reflex authored"],
  ["saves.will", "Will authored"],
  ["dr", "Damage reduction value (record only)"],
  ["spellResistance", "Spell resistance (record only)"],
  ["fastHealing", "Fast healing (record only)"],
  ["regeneration", "Regeneration (record only)"],
] as const;
export type SheetField = (typeof SHEET_FIELDS)[number][0];

export function pf1eSheetView(actor: ActorDocument) {
  const effects = readTacticalEffects(actor.effects.map((e) => [e._id, e] as const));
  return {
    authored: normalizePF1eSystem(actor.system.pf1e).system,
    derived: deriveFromDocuments({ actor, effects: effects.effects }),
    effectErrors: effects.rejected.map((e) => `${e.id}: ${e.error}`),
  };
}

export function authoredNumber(actor: ActorDocument, field: SheetField): number | null {
  let value: unknown = normalizePF1eSystem(actor.system.pf1e).system;
  for (const key of field.split(".")) {
    value =
      value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The caller must send these Ops through ClientSync.submit; host authorization remains decisive. */
export function pf1eSheetEdit(
  actor: ActorDocument,
  user: PermissionUser | null,
  field: string,
  raw: string,
): { ops: Op[]; error: string | null } {
  const fail = (error: string) => ({ ops: [], error });
  if (!isPF1eActor(actor) || !user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  if (!SHEET_FIELDS.some(([key]) => key === field))
    return fail("This field is not editable here.");
  if (!raw.trim() || !Number.isFinite(Number(raw)) || !Number.isSafeInteger(Number(raw)))
    return fail("Enter a finite whole number.");
  const value = Number(raw);
  if (
    (field.startsWith("abilities.") ||
      field.startsWith("energyResistance.") ||
      field === "tempHp" ||
      [
        "hpMax",
        "nonlethalDamage",
        "baseAttack",
        "speedFt",
        "dr",
        "spellResistance",
        "fastHealing",
        "regeneration",
      ].includes(field)) &&
    value < 0
  )
    return fail("This value cannot be negative.");
  const diff: Record<string, Json> = {};
  // A first save edit on an imported stat block must not discard the other two
  // saves or reinterpret its totals as bases. Materialize only this authored group.
  const original = actor.system.pf1e as Record<string, Json>;
  if (
    field.startsWith("energyResistance.") &&
    original.energyResistance !== undefined &&
    !sheetRecord(original.energyResistance)
  )
    return fail(
      "Structured resistance import is read-only here; repair its source explicitly.",
    );
  if (field === "tempHp" && original.tempHp !== null && typeof original.tempHp === "object")
    return fail("Structured temporary HP import is read-only here.");
  const normalized = normalizePF1eSystem(original).system;
  if (
    field.startsWith("saves.") &&
    original.saves === undefined &&
    normalized.saves !== undefined
  ) {
    diff["system.pf1e.saves"] = {
      ...(normalized.saves as Record<string, Json>),
      [field.slice(6)]: value,
    };
    if (normalized.savesAsTotal === true) diff["system.pf1e.savesAsTotal"] = true;
  }
  if (field === "dr" && sheetRecord(original.dr)) diff["system.pf1e.dr.val"] = value;
  if (field === "regeneration" && sheetRecord(original.regeneration))
    diff["system.pf1e.regeneration.value"] = value;
  if (Object.keys(diff).length === 0) Object.assign(diff, authoredPatch(actor, field, value));
  return {
    ops: [{ kind: "update", ref: { coll: "actors", id: actor._id }, diff }],
    error: null,
  };
}

/** Object-shaped authored data only; never read effective stats back into an editor. */
export function sheetRecord(value: unknown): Record<string, Json> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
}

export const ARMOR_FIELDS = [
  ["armor.armorBonus", "Armor bonus"],
  ["armor.shieldBonus", "Shield bonus"],
  ["armorClass.natural", "Natural armor"],
  ["armorClass.dodge", "Dodge bonus"],
  ["armorClass.misc", "Miscellaneous AC"],
  ["armor.maxDexBonus", "Maximum Dexterity bonus"],
  ["armor.checkPenalty", "Armor check penalty (record only)"],
  ["armor.spellFailure", "Arcane spell failure % (record only)"],
] as const;

export const MONSTER_FIELDS = [
  ["cr", "Challenge rating"],
  ["type", "Creature type"],
  ["alignment", "Alignment"],
  ["senses", "Senses"],
  ["languages", "Languages"],
  ["specialAttacks", "Special attacks"],
  ["sq", "Special qualities"],
  ["treasure", "Treasure"],
] as const;

type EditResult = { ops: Op[]; error: string | null };
export type DetailEdit =
  | { kind: "armor"; field: string; raw: string }
  | { kind: "list"; field: "feats" | "traits"; raw: string; expected: Json | undefined }
  | { kind: "monster-start" }
  | { kind: "monster"; field: string; raw: string; expected: Json | undefined };

/** Materialize only a missing authored group: FlatDiff cannot traverse missing parents. */
function authoredPatch(actor: ActorDocument, field: string, value: Json): Record<string, Json> {
  const raw = sheetRecord(actor.system.pf1e) ?? {};
  const [group, key] = field.split(".");
  if (group && key && !sheetRecord(raw[group])) {
    const normalized = normalizePF1eSystem(raw).system;
    return { [`system.pf1e.${group}`]: { ...sheetRecord(normalized[group]), [key]: value } };
  }
  return { [`system.pf1e.${field}`]: value };
}

export function armorFieldValue(actor: ActorDocument, field: string): number | null {
  const normalized = normalizePF1eSystem(actor.system.pf1e).system;
  const [group, key] = field.split(".");
  let value = group && key ? sheetRecord(normalized[group])?.[key] : undefined;
  // These two aliases are authored components, not derived/effect-adjusted values.
  if (value === undefined && field === "armor.armorBonus")
    value = sheetRecord(normalized.armorClass)?.armor;
  if (value === undefined && field === "armor.shieldBonus")
    value = sheetRecord(normalized.armorClass)?.shield;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Bounded P1 authoring: descriptive fields do not imply combat automation. */
export function pf1eDetailEdit(
  actor: ActorDocument,
  user: PermissionUser | null,
  edit: DetailEdit,
): EditResult {
  const fail = (error: string): EditResult => ({ ops: [], error });
  if (!isPF1eActor(actor) || !user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  const raw = sheetRecord(actor.system.pf1e) ?? {};
  let diff: Record<string, Json>;
  switch (edit.kind) {
    case "armor": {
      if (!ARMOR_FIELDS.some(([key]) => key === edit.field))
        return fail("Unknown armor field.");
      // Existing P0 derivation gives published AC totals precedence over components.
      // Never silently throw away those totals or pretend an ignored edit changes AC.
      if (pf1eSheetView(actor).derived.acFromTotals)
        return fail(
          "This actor uses published AC totals. Component conversion must be authored explicitly before editing armor here.",
        );
      if (edit.raw.trim() === "" && edit.field === "armor.maxDexBonus") {
        diff = { "-=system.pf1e.armor.maxDexBonus": null };
        // Deleting through a missing parent is not a valid FlatDiff either.
        if (!sheetRecord(raw.armor)) return { ops: [], error: null };
        break;
      }
      const value = Number(edit.raw);
      if (!edit.raw.trim() || !Number.isSafeInteger(value))
        return fail("Enter a finite whole number.");
      if (edit.field === "armor.spellFailure" && (value < 0 || value > 100))
        return fail("Spell failure must be between 0 and 100 percent.");
      if (edit.field === "armor.checkPenalty" && value > 0)
        return fail("Armor check penalty must be zero or negative.");
      if (edit.field !== "armorClass.misc" && edit.field !== "armor.checkPenalty" && value < 0)
        return fail("This value cannot be negative.");
      diff = authoredPatch(actor, edit.field, value);
      break;
    }
    case "list": {
      if (edit.field !== "feats" && edit.field !== "traits") return fail("Unknown list field.");
      if (JSON.stringify(raw[edit.field]) !== JSON.stringify(edit.expected))
        return fail("This list changed while editing. Reopen the tab and retry.");
      if (
        raw[edit.field] !== undefined &&
        (!Array.isArray(raw[edit.field]) ||
          !(raw[edit.field] as Json[]).every((value) => typeof value === "string"))
      )
        return fail(
          "This imported list has structured entries. It is read-only here to preserve their data.",
        );
      const values = edit.raw
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (values.length > 100 || values.some((value) => value.length > 200))
        return fail("Use at most 100 entries of at most 200 characters each.");
      diff = { [`system.pf1e.${edit.field}`]: values };
      break;
    }
    case "monster-start": {
      if (raw.creature !== undefined && raw.creature !== null)
        return fail("Creature data already exists; it will not be overwritten.");
      diff = { "system.pf1e.creature": {} };
      break;
    }
    case "monster": {
      if (!MONSTER_FIELDS.some(([key]) => key === edit.field))
        return fail("Unknown creature field.");
      const creature = sheetRecord(raw.creature);
      if (!creature) return fail("Add creature details first.");
      const old = creature[edit.field];
      if (JSON.stringify(old) !== JSON.stringify(edit.expected))
        return fail("This field changed while editing. Reopen the tab and retry.");
      if (old !== undefined && typeof old !== "string" && typeof old !== "number")
        return fail("This imported field is structured and read-only here.");
      if (edit.raw.length > 4000) return fail("Use at most 4000 characters.");
      // CR permits fractions such as 1/3. It is descriptive, not a challenge calculator.
      diff = { [`system.pf1e.creature.${edit.field}`]: edit.raw.trim() };
      break;
    }
  }
  return {
    ops: [{ kind: "update", ref: { coll: "actors", id: actor._id }, diff }],
    error: null,
  };
}
