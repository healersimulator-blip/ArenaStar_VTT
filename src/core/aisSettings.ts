/**
 * D-476 — **AIS module settings** (the generic "settings service" every real-world module needs;
 * readiness gap R-03 in `AIS_PF1E_MODULE_READINESS.md`).
 *
 * A module declares its settings in `interconnect.settings` (schema, not code). Two scopes:
 *
 * - **world** — one replicated `settings` document per module, `_id = "ais-settings:<packageId>"`,
 *   readable by every replica (`ownership.default = LIMITED`, like the appearance preferences,
 *   `aisAppearance.ts`) and writable only with GM authority (`can()` refuses player updates).
 *   Values live under `flags.ais.values`, **not** `system`: `worldSettingsFrom()` merges every
 *   settings document's `system` bag into the core world-settings record, so a module key named
 *   `secondsPerRound` would otherwise silently override a core rule option.
 * - **device** — per device + world + module, in the IndexedDB `settings` store, next to the
 *   module's own key/value storage (`module.storage.*`); never replicated.
 *
 * Everything here is pure: parsing/coercion against the declaration, the ops that write a world
 * value, and the committed-op filter the runtimes use to raise `module.settings.changed`.
 */
import type {
  AisSettingDeclaration,
  AisSettingValue,
} from "./automationInterconnect";
import type { Json, SettingsDocument } from "./documents";
import { OWNERSHIP_LEVELS } from "./documents";
import type { Op } from "./ops";
import type { Result } from "./result";
import { err, okVal } from "./result";

export const AIS_SETTINGS_DOC_PREFIX = "ais-settings:";
export const AIS_SETTING_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,47}$/;
const CHOICE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function aisSettingsDocId(packageId: string): string {
  return `${AIS_SETTINGS_DOC_PREFIX}${packageId}`;
}

/** The package a settings document belongs to, or null for any other `settings` document. */
export function aisSettingsPackageOf(docId: string): string | null {
  return docId.startsWith(AIS_SETTINGS_DOC_PREFIX) && docId.length > AIS_SETTINGS_DOC_PREFIX.length
    ? docId.slice(AIS_SETTINGS_DOC_PREFIX.length)
    : null;
}

/** IndexedDB scope of a module's device-scope settings (one row per key). */
export function aisDeviceSettingsScope(worldId: string, packageId: string): string {
  return `ais-settings:${worldId}:${packageId}`;
}

const hasControlChars = (text: string): boolean =>
  Array.from(text).some((ch) => (ch.codePointAt(0) ?? 0) < 0x20);

/**
 * Coerce a proposed value to one declaration: the single place that decides what a setting may
 * hold, used by the RPC (`settings.set`), the shell forms and the readers (a stored value that no
 * longer fits a newer declaration falls back to the default rather than leaking through).
 */
export function coerceAisSettingValue(
  declaration: AisSettingDeclaration,
  value: unknown,
): Result<AisSettingValue> {
  switch (declaration.type) {
    case "boolean":
      return typeof value === "boolean"
        ? okVal(value)
        : err(`setting ${declaration.key} must be a boolean`);
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return err(`setting ${declaration.key} must be a finite number`);
      const min = declaration.min ?? -1e15;
      const max = declaration.max ?? 1e15;
      if (value < min || value > max)
        return err(`setting ${declaration.key} must be between ${min} and ${max}`);
      if (declaration.step !== undefined) {
        const steps = (value - min) / declaration.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9)
          return err(`setting ${declaration.key} must move in steps of ${declaration.step}`);
      }
      return okVal(value);
    }
    case "string": {
      if (typeof value !== "string") return err(`setting ${declaration.key} must be a string`);
      const maxLength = declaration.maxLength ?? 256;
      if (value.length > maxLength) return err(`setting ${declaration.key} is limited to ${maxLength} characters`);
      if (hasControlChars(value.replaceAll("\n", "").replaceAll("\t", "")))
        return err(`setting ${declaration.key} may not contain control characters`);
      return okVal(value);
    }
    case "choice": {
      if (typeof value !== "string" || !declaration.choices?.some((choice) => choice.value === value))
        return err(`setting ${declaration.key} must be one of its declared choices`);
      return okVal(value);
    }
  }
}

/** Manifest-time validation of one declaration (called by `packageManifest.ts`). */
export function aisSettingDeclarationError(raw: unknown, index: number): string | null {
  const where = `interconnect.settings[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${where} must be an object`;
  const record = raw as Record<string, unknown>;
  const allowed = ["key", "scope", "type", "label", "hint", "default", "min", "max", "step", "maxLength", "choices"];
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) return `${where} has unsupported field ${unknown}`;
  if (typeof record.key !== "string" || !AIS_SETTING_KEY_RE.test(record.key))
    return `${where} needs a key matching ${AIS_SETTING_KEY_RE.source}`;
  const key = record.key;
  if (record.scope !== "world" && record.scope !== "device")
    return `${where} (${key}) scope must be "world" or "device"`;
  if (record.type !== "boolean" && record.type !== "number" && record.type !== "string" && record.type !== "choice")
    return `${where} (${key}) type must be boolean, number, string or choice`;
  if (typeof record.label !== "string" || record.label.trim().length === 0 || record.label.length > 48 || hasControlChars(record.label))
    return `${where} (${key}) needs a label of 1–48 printable characters`;
  if (record.hint !== undefined && (typeof record.hint !== "string" || record.hint.length > 160 || hasControlChars(record.hint)))
    return `${where} (${key}) hint must be at most 160 printable characters`;
  const numeric = (field: "min" | "max" | "step" | "maxLength"): string | null => {
    const v = record[field];
    if (v === undefined) return null;
    if (record.type !== (field === "maxLength" ? "string" : "number"))
      return `${where} (${key}) ${field} only applies to ${field === "maxLength" ? "string" : "number"} settings`;
    if (typeof v !== "number" || !Number.isFinite(v)) return `${where} (${key}) ${field} must be a finite number`;
    if (field === "step" && v <= 0) return `${where} (${key}) step must be positive`;
    if (field === "maxLength" && (!Number.isInteger(v) || v < 1 || v > 512))
      return `${where} (${key}) maxLength must be an integer 1–512`;
    return null;
  };
  for (const field of ["min", "max", "step", "maxLength"] as const) {
    const error = numeric(field);
    if (error) return error;
  }
  if (typeof record.min === "number" && typeof record.max === "number" && record.min > record.max)
    return `${where} (${key}) min must not exceed max`;
  if (record.choices !== undefined) {
    if (record.type !== "choice") return `${where} (${key}) choices only apply to choice settings`;
    if (!Array.isArray(record.choices) || record.choices.length < 2 || record.choices.length > 32)
      return `${where} (${key}) needs 2–32 choices`;
    const seen = new Set<string>();
    for (const choice of record.choices) {
      if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return `${where} (${key}) choices must be objects`;
      const row = choice as Record<string, unknown>;
      if (Object.keys(row).some((field) => field !== "value" && field !== "label"))
        return `${where} (${key}) choices contain only value and label`;
      if (typeof row.value !== "string" || !CHOICE_VALUE_RE.test(row.value)) return `${where} (${key}) has an invalid choice value`;
      if (typeof row.label !== "string" || row.label.trim().length === 0 || row.label.length > 48 || hasControlChars(row.label))
        return `${where} (${key}) choice ${row.value} needs a label of 1–48 printable characters`;
      if (seen.has(row.value)) return `${where} (${key}) repeats choice ${row.value}`;
      seen.add(row.value);
    }
  } else if (record.type === "choice") return `${where} (${key}) choice settings need choices`;
  const declaration = normalizeAisSettingDeclaration(record);
  const coerced = coerceAisSettingValue(declaration, record.default);
  if (!coerced.ok) return `${where} default: ${coerced.error}`;
  return null;
}

/** Build the typed declaration from a record `aisSettingDeclarationError` accepted. */
export function normalizeAisSettingDeclaration(record: Record<string, unknown>): AisSettingDeclaration {
  const choices = Array.isArray(record.choices)
    ? (record.choices as Array<{ value: string; label: string }>).map((choice) => ({ value: choice.value, label: choice.label.trim() }))
    : undefined;
  return {
    key: String(record.key),
    scope: record.scope as AisSettingDeclaration["scope"],
    type: record.type as AisSettingDeclaration["type"],
    label: String(record.label).trim(),
    ...(typeof record.hint === "string" && record.hint.trim() ? { hint: record.hint.trim() } : {}),
    default: record.default as AisSettingValue,
    ...(typeof record.min === "number" ? { min: record.min } : {}),
    ...(typeof record.max === "number" ? { max: record.max } : {}),
    ...(typeof record.step === "number" ? { step: record.step } : {}),
    ...(typeof record.maxLength === "number" ? { maxLength: record.maxLength } : {}),
    ...(choices ? { choices } : {}),
  };
}

function storedValues(doc: SettingsDocument | undefined): Record<string, unknown> {
  const ais = doc?.flags?.["ais"];
  if (typeof ais !== "object" || ais === null || Array.isArray(ais)) return {};
  const values = (ais as Record<string, unknown>)["values"];
  return typeof values === "object" && values !== null && !Array.isArray(values)
    ? (values as Record<string, unknown>)
    : {};
}

/** Effective world-scope values for the declared keys (stored → coerced, else the default). */
export function aisWorldSettingValues(
  doc: SettingsDocument | undefined,
  declarations: readonly AisSettingDeclaration[],
): Record<string, AisSettingValue> {
  const stored = storedValues(doc);
  const out: Record<string, AisSettingValue> = {};
  for (const declaration of declarations) {
    if (declaration.scope !== "world") continue;
    const coerced = Object.hasOwn(stored, declaration.key)
      ? coerceAisSettingValue(declaration, stored[declaration.key])
      : null;
    out[declaration.key] = coerced?.ok ? coerced.value : declaration.default;
  }
  return out;
}

/** Ops that write one world-scope value, creating the module's document on first write. */
export function aisWorldSettingOps(
  doc: SettingsDocument | undefined,
  packageId: string,
  packageName: string,
  key: string,
  value: AisSettingValue,
): Op[] {
  const id = aisSettingsDocId(packageId);
  if (!doc) {
    const created: SettingsDocument = {
      _id: id,
      type: "settings",
      name: `${packageName} settings`,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: { ais: { packageId, values: { [key]: value } } },
      system: {},
    };
    return [{ kind: "create", coll: "settings", data: created }];
  }
  const stored = storedValues(doc);
  if (Object.hasOwn(stored, key) && stored[key] === value) return [];
  // `flags.ais.values` always exists on a document this module created; a document somebody
  // else authored without it gets the whole namespace replaced (the dotted path would fail).
  const ais = doc.flags?.["ais"];
  const hasNamespace = typeof ais === "object" && ais !== null && !Array.isArray(ais) &&
    typeof (ais as Record<string, unknown>)["values"] === "object" && (ais as Record<string, unknown>)["values"] !== null;
  const diff: Record<string, Json> = hasNamespace
    ? { [`flags.ais.values.${key}`]: value }
    : { "flags.ais": { packageId, values: { ...stored, [key]: value } } as Json };
  return [{ kind: "update", ref: { coll: "settings", id }, diff }];
}

/** True when a committed batch touched this module's world-settings document. */
export function aisSettingsDocTouched(ops: readonly Op[], packageId: string): boolean {
  const id = aisSettingsDocId(packageId);
  return ops.some((op) =>
    op.kind === "create"
      ? op.coll === "settings" && op.data._id === id
      : op.ref.coll === "settings" && op.ref.id === id && op.ref.parent === undefined,
  );
}
