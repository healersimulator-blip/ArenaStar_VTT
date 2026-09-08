/** Explicit, previewed AC source selection. Never reverse-engineer components from a total. */
import type { ActorDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { can } from "../../core/permissions";
import { applyDiff } from "../../core/diff";
import { isPF1eActor, pf1eSheetView, sheetRecord } from "./pf1eSheetModel";

export const AC_CONVERSION_FIELDS = [
  ["armor", "Armor"],
  ["shield", "Shield"],
  ["natural", "Natural armor"],
  ["dodge", "Dodge"],
  ["misc", "Miscellaneous"],
  ["maxDex", "Maximum Dex (blank = no cap)"],
] as const;
export type AcDraft = Record<(typeof AC_CONVERSION_FIELDS)[number][0], string>;
export const emptyAcDraft = (): AcDraft => ({
  armor: "",
  shield: "",
  natural: "",
  dodge: "",
  misc: "",
  maxDex: "",
});
export type AcRequest =
  | { mode: "components"; draft: AcDraft; expected: string }
  | { mode: "published"; expected: string };
export type AcPreview = {
  error: string | null;
  ops: Op[];
  before: { normal: number; touch: number; flatFooted: number } | null;
  after: { normal: number; touch: number; flatFooted: number } | null;
};
export const acRevision = (actor: ActorDocument): string => JSON.stringify(actor);
export function hasPublishedAc(actor: ActorDocument): boolean {
  const raw = sheetRecord(actor.system.pf1e) ?? {};
  const total = sheetRecord(raw.acTotals)?.normal;
  return (
    (typeof raw.ac === "number" && Number.isFinite(raw.ac)) ||
    (typeof total === "number" && Number.isFinite(total))
  );
}

/** Rebuild at submit time against the latest projected actor; don't submit a stale preview's Ops. */
export function previewAcConversion(
  actor: ActorDocument,
  user: PermissionUser | null,
  request: AcRequest,
): AcPreview {
  const fail = (error: string): AcPreview => ({ error, ops: [], before: null, after: null });
  if (!isPF1eActor(actor) || !user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  if (acRevision(actor) !== request.expected)
    return fail("Actor data or effects changed. Preview again before applying.");
  if (!hasPublishedAc(actor))
    return fail("No numeric published AC totals are available to switch from or restore.");
  const raw = sheetRecord(actor.system.pf1e) ?? {};
  let op: Op;
  if (request.mode === "components") {
    for (const field of ["armor", "armorClass"] as const) {
      if (raw[field] !== undefined && !sheetRecord(raw[field]))
        return fail(
          "Imported armor components are malformed; repair their source before converting.",
        );
    }
    const values: Record<string, number | null> = {};
    for (const [field] of AC_CONVERSION_FIELDS) {
      const text = request.draft[field];
      if (typeof text !== "string") return fail("Enter all AC components explicitly.");
      if (field === "maxDex" && text.trim() === "") {
        values[field] = null;
        continue;
      }
      const value = Number(text);
      if (!text.trim() || !Number.isSafeInteger(value) || (field !== "misc" && value < 0))
        return fail(
          "Enter whole-number AC components (only miscellaneous may be negative); use 0 when absent.",
        );
      values[field] = value;
    }
    const armor = {
      ...sheetRecord(raw.armor),
      armorBonus: values.armor ?? 0,
      shieldBonus: values.shield ?? 0,
      maxDexBonus: values.maxDex ?? null,
    };
    const armorClass = {
      ...sheetRecord(raw.armorClass),
      armor: values.armor ?? 0,
      shield: values.shield ?? 0,
      natural: values.natural ?? 0,
      dodge: values.dodge ?? 0,
      misc: values.misc ?? 0,
    };
    op = {
      kind: "update",
      ref: { coll: "actors", id: actor._id },
      diff: {
        "system.pf1e.armor": armor,
        "system.pf1e.armorClass": armorClass,
        "system.pf1e.acMode": "components",
      },
    };
  } else if (request.mode === "published") {
    op = {
      kind: "update",
      ref: { coll: "actors", id: actor._id },
      diff: { "system.pf1e.acMode": "published" },
    };
  } else return fail("Unknown AC source.");
  const applied = applyDiff(actor, op.diff);
  if (!applied.ok) return fail(applied.error);
  const before = pf1eSheetView(actor).derived;
  const after = pf1eSheetView(applied.value).derived;
  if (request.mode === "published" && !after.acFromTotals)
    return fail("Published AC could not be read; source data is unchanged.");
  return { error: null, ops: [op], before: before.ac, after: after.ac };
}
