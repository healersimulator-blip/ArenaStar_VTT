/** P1 tactical attack-line authoring; no rolls and no mutation of legacy strategic weapons. */
import type { ActorDocument, Json } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { can } from "../../core/permissions";
import { normalizePF1eSystem } from "../../packages/pf1e/statBlock";
import { isPF1eActor, sheetRecord } from "./pf1eSheetModel";

export const ATTACK_TEXT_FIELDS = [
  ["name", "Name"],
  ["damageDice", "Weapon dice (NdM)"],
  ["damageType", "Damage type"],
] as const;
export const ATTACK_NUMBER_FIELDS = [
  ["damageBonus", "Authored damage bonus"],
  ["critThreatMin", "Lowest critical threat (1–20)"],
  ["critMultiplier", "Critical multiplier (2–4)"],
  ["rangeIncrementFt", "Range increment (ft)"],
  ["reachSquares", "Reach (squares)"],
] as const;
export const ATTACK_BOOLEAN_FIELDS = [
  ["ranged", "Ranged"],
  ["touchAttack", "Touch attack"],
  ["twoHanded", "Two-handed"],
  ["offHand", "Off-hand"],
  ["natural", "Natural attack"],
  ["secondary", "Secondary natural attack"],
  ["abilityDamageIncluded", "Damage bonus already includes ability"],
] as const;
export const MAX_SHEET_ATTACKS = 100;

export type AttackEdit =
  | { kind: "add"; expected: Json[] }
  | { kind: "remove"; index: number; expected: Json[] }
  | { kind: "set"; index: number; field: string; value: string | boolean; expected: Json[] };

export function pf1eAttackEditorView(actor: ActorDocument): {
  rows: Record<string, Json>[];
  legacyWeapon: Json | undefined;
  error: string | null;
} {
  const raw = sheetRecord(actor.system.pf1e) ?? {};
  const legacyWeapon = raw.weapon;
  if (
    raw.attacks !== undefined &&
    (!Array.isArray(raw.attacks) || raw.attacks.some((row) => !sheetRecord(row)))
  ) {
    return {
      rows: [],
      legacyWeapon,
      error:
        "Imported attacks are malformed. They remain unchanged; repair the source before editing this list.",
    };
  }
  if (raw.attacks === undefined && raw.weapon !== undefined && !sheetRecord(raw.weapon)) {
    return {
      rows: [],
      legacyWeapon,
      error: "Imported weapon data is not an object. It will not be replaced by this editor.",
    };
  }
  const normalized = normalizePF1eSystem(raw).system;
  const rows = Array.isArray(normalized.attacks)
    ? (normalized.attacks as Record<string, Json>[])
    : [];
  return {
    rows,
    legacyWeapon,
    error:
      rows.length > MAX_SHEET_ATTACKS
        ? "This list exceeds the 100-attack editor limit and is read-only."
        : null,
  };
}

/** Empty optional inputs remove a field, letting the existing derivation choose its default. */
function parseAttackValue(
  field: string,
  input: string | boolean,
): { value: Json | undefined; error: string | null } {
  const bad = (error: string) => ({ value: undefined, error });
  if (ATTACK_BOOLEAN_FIELDS.some(([key]) => key === field)) {
    return typeof input === "boolean"
      ? { value: input, error: null }
      : bad("Use a checkbox value for this field.");
  }
  if (typeof input !== "string") return bad("Enter a text or numeric value.");
  const raw = input.trim();
  if (ATTACK_TEXT_FIELDS.some(([key]) => key === field)) {
    if (raw.length > 200) return bad("Use at most 200 characters.");
    if (field === "damageDice" && raw !== "") {
      const match = /^(\d{1,3})d(\d{1,4})$/i.exec(raw);
      const count = Number(match?.[1]);
      const sides = Number(match?.[2]);
      if (!match || count < 1 || count > 100 || sides < 2 || sides > 1000)
        return bad(
          "Use NdM with 1–100 dice and 2–1000 sides. Put flat bonuses in the damage bonus field.",
        );
      return { value: `${count}d${sides}`, error: null };
    }
    return { value: raw === "" ? undefined : raw, error: null };
  }
  if (!ATTACK_NUMBER_FIELDS.some(([key]) => key === field)) return bad("Unknown attack field.");
  if (raw === "") return { value: undefined, error: null };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return bad("Enter a finite whole number.");
  if (field === "critThreatMin" && (value < 1 || value > 20))
    return bad("Critical threat must be between 1 and 20.");
  if (field === "critMultiplier" && (value < 2 || value > 4))
    return bad("Critical multiplier must be between 2 and 4.");
  if (field === "rangeIncrementFt" && value <= 0)
    return bad("Range increment must be positive, or blank for no authored range.");
  if (field === "reachSquares" && value < 0) return bad("Reach cannot be negative.");
  return { value, error: null };
}

export function pf1eAttackEdit(
  actor: ActorDocument,
  user: PermissionUser | null,
  edit: AttackEdit,
): { ops: Op[]; error: string | null } {
  const fail = (error: string) => ({ ops: [], error });
  if (!isPF1eActor(actor) || !user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  const view = pf1eAttackEditorView(actor);
  if (view.error) return fail(view.error);
  // This is a local stale-edit check, not host-side compare-and-swap.
  if (JSON.stringify(view.rows) !== JSON.stringify(edit.expected))
    return fail("The attack list changed while editing. Reopen the Weapons tab and retry.");
  const raw = sheetRecord(actor.system.pf1e) ?? {};
  const rows = view.rows.map((row) => ({ ...row }));
  let diff: Record<string, Json>;
  if (edit.kind === "add") {
    if (rows.length >= MAX_SHEET_ATTACKS)
      return fail("At most 100 authored attacks are supported by this editor.");
    rows.push({ name: "New attack" });
    diff = { "system.pf1e.attacks": rows };
  } else {
    if (!Number.isSafeInteger(edit.index) || edit.index < 0 || !rows[edit.index])
      return fail("Attack no longer exists.");
    if (edit.kind === "remove") {
      rows.splice(edit.index, 1);
      // Keep [] rather than deleting the key: deletion would reactivate a legacy weapon.
      diff = { "system.pf1e.attacks": rows };
    } else {
      const parsed = parseAttackValue(edit.field, edit.value);
      if (parsed.error) return fail(parsed.error);
      const row = rows[edit.index];
      if (!row) return fail("Attack no longer exists.");
      if (row[edit.field] !== null && typeof row[edit.field] === "object")
        return fail("This field contains structured import data and is read-only here.");
      if (parsed.value === undefined) Reflect.deleteProperty(row, edit.field);
      else row[edit.field] = parsed.value;
      if (Array.isArray(raw.attacks)) {
        // Ordinary edits touch one property, retaining unknown fields and other rows.
        const path = `system.pf1e.attacks.${edit.index}.${edit.field}`;
        diff = parsed.value === undefined ? { [`-=${path}`]: null } : { [path]: parsed.value };
      } else {
        // First legacy edit materializes only tactical authored lines, never derived totals.
        diff = { "system.pf1e.attacks": rows };
      }
    }
  }
  return {
    ops: [{ kind: "update", ref: { coll: "actors", id: actor._id }, diff }],
    error: null,
  };
}
