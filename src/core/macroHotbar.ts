/**
 * MC-01 (D-392): a player's hotbar is a local preference, not permission to edit
 * a world macro. Store only five bindings, scoped to this world and this player.
 *
 * null inherits the GM's current slot; "" explicitly leaves it empty; an id
 * overrides it. Resolve ids against the CURRENT projected catalog on every
 * render/run: a deleted or unpublished assignment is inert, never a fallback to
 * some other macro. Retaining the id lets a reconnect/republish recover it.
 */
import type { MacroDocument } from "./documents";

export const MACRO_HOTBAR_SLOT_COUNT = 5;
export const MACRO_HOTBAR_STORAGE_PREFIX = "vtt-macro-hotbar:v1:";
const MAX_STORED_CHARS = 4096;
const RUNNABLE_KINDS = new Set<MacroDocument["kind"]>(["chat", "script", "sequence", "automation", "composite"]);

/** null = GM default, empty string = explicitly empty, other string = macro id. */
export type MacroHotbarBinding = string | null;
export interface MacroHotbarPrefs {
  version: 1;
  slots: MacroHotbarBinding[];
}
export interface MacroHotbarScope {
  worldId: string;
  userId: string;
}
export interface MacroHotbarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function boundedId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  return [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

/** Total, fresh, fixed-length and versioned, including for hand-edited storage. */
export function normalizeMacroHotbarPrefs(raw: unknown): MacroHotbarPrefs {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const values = record?.version === 1 && Array.isArray(record.slots) ? record.slots as unknown[] : [];
  return { version: 1, slots: Array.from({ length: MACRO_HOTBAR_SLOT_COUNT }, (_, i) => {
    const value = values[i];
    return value === "" || boundedId(value) ? value : null;
  }) };
}

/** The five GM-assigned defaults. Duplicate slots keep the existing last-wins rule. */
export function macroSlots(macros: readonly MacroDocument[]): Array<MacroDocument | null> {
  const slots: Array<MacroDocument | null> = Array.from({ length: MACRO_HOTBAR_SLOT_COUNT }, () => null);
  for (const macro of macros) {
    const core = (macro.flags as { core?: { slot?: unknown } }).core;
    const slot = core?.slot;
    if (typeof slot === "number" && Number.isInteger(slot) && slot >= 1 && slot <= MACRO_HOTBAR_SLOT_COUNT)
      slots[slot - 1] = macro;
  }
  return slots;
}

/** Only delivered, hotbar-runnable entries — no summon/preset picker masquerading as a run. */
export function hotbarMacroChoices(macros: readonly MacroDocument[]): MacroDocument[] {
  return macros.filter((macro) => RUNNABLE_KINDS.has(macro.kind) && boundedId(macro._id))
    .slice().sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id));
}

/** Never use a stored name, body, grant or graph reference to run a slot. */
export function playerMacroSlots(macros: readonly MacroDocument[], prefs: MacroHotbarPrefs): Array<MacroDocument | null> {
  const defaults = macroSlots(macros);
  const catalog = new Map(hotbarMacroChoices(macros).map((macro) => [macro._id, macro]));
  return normalizeMacroHotbarPrefs(prefs).slots.map((binding, i) =>
    binding === null ? defaults[i] ?? null : catalog.get(binding) ?? null);
}

/** A fresh assignment can name only a current choice. Existing missing ids stay inert. */
export function assignMacroHotbarSlot(
  prefs: MacroHotbarPrefs, index: number, binding: MacroHotbarBinding, macros: readonly MacroDocument[],
): MacroHotbarPrefs {
  if (!Number.isInteger(index) || index < 0 || index >= MACRO_HOTBAR_SLOT_COUNT) return prefs;
  if (binding !== null && binding !== "" && !hotbarMacroChoices(macros).some((macro) => macro._id === binding)) return prefs;
  const next = normalizeMacroHotbarPrefs(prefs);
  next.slots[index] = binding;
  return next;
}

/** JSON tuples avoid delimiter collisions, including imported world/user identifiers. */
export function macroHotbarStorageKey(scope: MacroHotbarScope): string {
  return MACRO_HOTBAR_STORAGE_PREFIX + JSON.stringify([scope.worldId, scope.userId]);
}

function storageOrNull(storage?: MacroHotbarStorage | null): MacroHotbarStorage | null {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readMacroHotbarPrefs(scope: MacroHotbarScope, storage?: MacroHotbarStorage | null): MacroHotbarPrefs {
  try {
    const raw = storageOrNull(storage)?.getItem(macroHotbarStorageKey(scope));
    if (!raw || raw.length > MAX_STORED_CHARS) return normalizeMacroHotbarPrefs(null);
    return normalizeMacroHotbarPrefs(JSON.parse(raw) as unknown);
  } catch { return normalizeMacroHotbarPrefs(null); }
}

/** A storage-denied browser still gets the arrangement for this visit, with truthful feedback. */
export function writeMacroHotbarPrefs(
  scope: MacroHotbarScope, raw: MacroHotbarPrefs, storage?: MacroHotbarStorage | null,
): { prefs: MacroHotbarPrefs; saved: boolean } {
  const prefs = normalizeMacroHotbarPrefs(raw);
  const target = storageOrNull(storage);
  try {
    if (target) {
      target.setItem(macroHotbarStorageKey(scope), JSON.stringify(prefs));
      return { prefs, saved: true };
    }
  } catch { /* No world write or network fallback: this is a device-local preference. */ }
  return { prefs, saved: false };
}
