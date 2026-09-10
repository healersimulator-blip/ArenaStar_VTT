/**
 * **World settings** — the replicated, GM-edited rule options of a world.
 *
 * There has always been a `settings` collection (`src/core/documents.ts:314`, listed in
 * `TOP_LEVEL_COLLECTIONS`), but nothing wrote to or read from it: the four rules contexts that take a
 * `worldSettings` bag passed `{}` (`App.svelte`, `host/turnChannel.ts`, `ui/armies/armyModel.ts`,
 * `app/e2eHook.ts`). This module is what makes that bag real, and it is deliberately *not* stored on
 * `WorldsRecord` (`src/storage/idb.ts:41`): that record is the local host's private row and is not
 * replicated, so players would run buffs against a clock they cannot see. A document in the replicated
 * `settings` collection gets the normal op-log treatment — undo, sync, projection — for free.
 *
 * Shape: exactly one document per world, `_id = "world-settings"`, with flat keys under `system`
 * (the same flat convention the rules modules already use: `massBattleBasic.ts:380` reads
 * `ctx.worldSettings.detectionMultiplier`). Extra `settings` documents are tolerated and merged in
 * `_id` order, so every replica derives the same bag.
 */
import type { Json, Ownership, SettingsDocument } from "./documents";
import type { Op } from "./ops";

export const WORLD_SETTINGS_ID = "world-settings";
export const WORLD_SETTINGS_NAME = "World Settings";

/**
 * The keys core understands. A rule package may read anything else out of the same bag — unknown
 * keys are preserved untouched, so a settings doc written by a package survives a core-only edit.
 */
export interface CoreWorldSettings {
  /** Fog/detection scaling already read by the basic mass-battle rules. */
  detectionMultiplier?: number;
  /** Seconds one combat round represents (PF1e: 6). The clock below advances by this per round. */
  secondsPerRound?: number;
  /** Whether the round clock advances at all when a round wraps (off = "theater time" campaigns). */
  advanceClockOnRound?: boolean;
  /**
   * The replicated world clock in elapsed seconds (E05, D-146). Lives here — not on the local
   * `WorldsRecord` (D-113) — so every replica, including a freshly joined player, reads the
   * same time their buffs expire against. Written only through ops (GM time controls, the
   * combat tracker's round wrap); never local-only state.
   */
  clockSeconds?: number;
  /** Anything a package defines; never stripped by core. Absent means "unset", not `undefined`. */
  [key: string]: Json;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const isSettingsDoc = (doc: unknown): boolean =>
  asRecord(doc)?.type === "settings";

/**
 * Merge every `settings` document's `system` bag, in `_id` order (deterministic across replicas).
 * Callers pass `store.getAll("settings")`.
 */
export function worldSettingsFrom(docs: Iterable<unknown>): CoreWorldSettings {
  const list = [...docs].filter(isSettingsDoc);
  list.sort((a, b) => {
    const ia = String(asRecord(a)?._id ?? "");
    const ib = String(asRecord(b)?._id ?? "");
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  const merged: Record<string, unknown> = {};
  for (const doc of list) {
    const system = asRecord(asRecord(doc)?.system);
    if (!system) continue;
    for (const [key, value] of Object.entries(system)) {
      if (value === undefined) continue;
      merged[key] = value;
    }
  }
  return merged as CoreWorldSettings;
}

export const DEFAULT_SECONDS_PER_ROUND = 6;

/** Seconds a round is worth, never zero and never absurd (1–3600). */
export function secondsPerRoundOf(settings: CoreWorldSettings): number {
  const v = settings.secondsPerRound;
  if (typeof v !== "number" || !Number.isFinite(v))
    return DEFAULT_SECONDS_PER_ROUND;
  return Math.min(3600, Math.max(1, Math.trunc(v)));
}

/** Clock advance on round wrap; on unless the world explicitly opts out. */
export function advanceClockOnRoundOf(settings: CoreWorldSettings): boolean {
  return settings.advanceClockOnRound !== false;
}

/** Values the settings bag may hold; objects/arrays would hide bugs from the diff, so they are refused. */
export function isScalarSetting(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * Validate a proposed patch (used by the settings UI before it submits, so a bad entry is a form
 * error rather than a silently ignored key).
 */
export function validateWorldSettingsPatch(patch: Record<string, unknown>): {
  ok: boolean;
  error: string | null;
  clean: Record<string, Json>;
} {
  const clean: Record<string, Json> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "" || key === "_id" || key === "type" || key === "ownership") {
      return { ok: false, error: `"${key}" is not a setting name`, clean: {} };
    }
    if (key.includes("."))
      return {
        ok: false,
        error: `setting "${key}" may not contain "."`,
        clean: {},
      };
    if (!isScalarSetting(value)) {
      return {
        ok: false,
        error: `setting "${key}" must be a number, string, or boolean`,
        clean: {},
      };
    }
    if (key === "secondsPerRound") {
      const n = typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n) || n < 1 || n > 3600) {
        return {
          ok: false,
          error: "secondsPerRound must be between 1 and 3600",
          clean: {},
        };
      }
    }
    if (key === "detectionMultiplier") {
      const n = typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        return {
          ok: false,
          error: "detectionMultiplier must be a positive number",
          clean: {},
        };
      }
    }
    if (key === "clockSeconds") {
      const n = typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 3_153_600_000) {
        return {
          ok: false,
          error: "clockSeconds must be between 0 and 3153600000",
          clean: {},
        };
      }
    }
    clean[key] = value as Json;
  }
  return { ok: true, error: null, clean };
}

/**
 * The document to create the first time anyone edits world settings in a world. `default: LIMITED` is
 * the whole point of this seam: `projectWorld` replicates any document at LIMITED or above
 * (`projection.ts:127`), so players see the clock and options their buffs tick against, while
 * `can(user, "update")` still requires OWNER and is bypassed only by the GM/ASSISTANT
 * (`permissions.ts:25`, D-013).
 */
export function worldSettingsDoc(
  settings: CoreWorldSettings = {},
  ownership: Ownership = { default: 1 },
): SettingsDocument {
  return {
    _id: WORLD_SETTINGS_ID,
    type: "settings",
    name: WORLD_SETTINGS_NAME,
    ownership,
    flags: {},
    system: { ...settings } as Record<string, Json>,
  };
}

/**
 * Ops that apply a patch, creating the document when the world has none yet. Each changed key is
 * written as its own dotted path (`"system.secondsPerRound"`), so a concurrent edit to another key is
 * never clobbered, and a key set to `undefined` is deleted with the `"-=<path>"` convention
 * (`ops.ts:11`).
 */
export function worldSettingsOps(
  docs: Iterable<unknown>,
  patch: Record<string, unknown>,
): Op[] {
  const canonical = [...docs].find(
    (d) => isSettingsDoc(d) && asRecord(d)?._id === WORLD_SETTINGS_ID,
  );
  // Both the "what changed" comparison and the create-time merge read *this* document only: other
  // `settings` documents may define the same key, and silently hopping between documents is how a
  // settings UI ends up appearing to forget an edit.
  const current =
    asRecord(canonical ? asRecord(canonical)?.system : null) ?? {};
  const diff: Record<string, Json | null> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (current[key] !== undefined) diff[`-=system.${key}`] = null;
      continue;
    }
    if (current[key] === value) continue;
    diff[`system.${key}`] = value as Json;
  }
  if (!canonical) {
    const created: Record<string, Json> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) created[key] = value as Json;
    }
    return [
      { kind: "create", coll: "settings", data: worldSettingsDoc(created) },
    ];
  }
  if (Object.keys(diff).length === 0) return [];
  return [
    { kind: "update", ref: { coll: "settings", id: WORLD_SETTINGS_ID }, diff },
  ];
}

/** Look up one setting with a fallback, so callers never write `settings.x ?? default` inline. */
export function settingOf<K extends keyof CoreWorldSettings>(
  settings: CoreWorldSettings,
  key: K,
  fallback: NonNullable<CoreWorldSettings[K]>,
): NonNullable<CoreWorldSettings[K]> {
  const v = settings[key];
  return v === undefined || v === null
    ? fallback
    : (v as NonNullable<CoreWorldSettings[K]>);
}
