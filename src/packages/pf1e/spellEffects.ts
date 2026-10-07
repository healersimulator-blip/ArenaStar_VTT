/**
 * D-407 — authored **tactical** spell effects: the mechanics a spell delivers to a target, as
 * validated source data.
 *
 * The mass-battle half of a spell already ships as `massBattle` payloads executed by the battle
 * engine (`spellPacks.ts`, M15). This module is the *tactical* half: what a cast resolved through
 * the hero-level cast flow does to a target beyond damage. It exists because D-259 deliberately
 * shipped no spell blocks — a prepared row carries a name, a level and a Components line, and the
 * caster answered the save/severity questions on the cast form. A spell whose whole point is a
 * condition (Entangle) cannot be answered that way: the condition, its save and the reason it was
 * applied are spell facts, not table facts.
 *
 * Shape, deliberately minimal:
 *
 * - `save` — the saving throw the target is allowed and what a successful save means for the
 *   condition (`negates`), or `null` for a spell with no save. Damage is still the cast form's
 *   business; the tactical half is the condition.
 * - `conditions` — canonical `PF1E_CONDITIONS` names applied to a target whose save failed. Names
 *   are validated against the library, never free text, and the list is bounded.
 *
 * What is deliberately absent until its consumer exists: duration/expiry, area re-saves and the
 * printed break-free action (plan S4), and area targeting (plan S3). The pack's `automationNote`
 * names the parts a table must still adjudicate rather than pretending they are modeled.
 *
 * The same rows ship as content in `systems/pf1e-core/packs/spells.json` (`system.tacticalEffect`,
 * one entry per catalogue id); no source file loads pack data at runtime (M18), so this module is
 * the engine's synchronous mirror and `tests/packages/pf1eContentPacks.test.ts` pins the mirror to
 * the shipped file — editing one without the other fails the build.
 */
import { err, okVal, type Result } from "../../core/result";
import type { PF1eSaveSeverity, PF1eSaveType } from "./casting";
import { pf1eConditionDef } from "./conditions";

export const PF1E_SPELL_EFFECT_VERSION = 1 as const;

/** A spell applies a bounded set of conditions; the library itself is the ceiling. */
export const PF1E_SPELL_EFFECT_MAX_CONDITIONS = 4;

export interface PF1eSpellEffectSource {
  readonly title: string;
  readonly citation: string;
  readonly url?: string;
}

export interface PF1eSpellEffect {
  /** Canonical id, equal to the content pack entry's id (`entangle`). */
  readonly id: string;
  readonly version: typeof PF1E_SPELL_EFFECT_VERSION;
  /** Canonical display name, equal to the pack entry's name. */
  readonly name: string;
  readonly source: PF1eSpellEffectSource;
  /**
   * The save the target is allowed. `null` means the spell allows none and the condition lands on
   * any affected row; otherwise a successful save negates the condition (severity `negates`) or
   * the catalogue row says which lesser outcome applies.
   */
  readonly save: { readonly type: PF1eSaveType; readonly severity: PF1eSaveSeverity } | null;
  /** Canonical condition names applied to a target whose save failed (or that had none). */
  readonly conditions: readonly string[];
  /** Optional starter-world persistent visual, linked to the exact condition application at runtime. */
  readonly conditionFxMacroId?: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAVE_TYPES: readonly PF1eSaveType[] = ["fort", "ref", "will"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

/**
 * The only save outcome a condition can have today: a made save means the condition does not
 * apply. The printed "partial" outcomes (half movement, difficult terrain, a shorter duration) are
 * exactly the parts S4 leaves to the table, so authoring `partial` here would promise an
 * implementation the engine does not have.
 */
const CONDITION_SAVE_SEVERITY: PF1eSaveSeverity = "negates";

const EFFECT_KEYS = ["id", "version", "name", "source", "save", "conditions", "conditionFxMacroId"] as const;
const SOURCE_KEYS = ["title", "citation", "url"] as const;
const SAVE_KEYS = ["type", "severity"] as const;

/**
 * Validate one authored tactical effect. Closed shape: an unknown key is refused by name, a
 * condition the library does not define is refused rather than kept, and severity is restricted to
 * the vocabulary the cast flow can act on.
 */
export function validatePF1eSpellEffect(raw: unknown): Result<PF1eSpellEffect> {
  if (!isRecord(raw)) return err("a spell effect must be an object");
  const stray = Object.keys(raw).filter((key) => !(EFFECT_KEYS as readonly string[]).includes(key));
  if (stray.length > 0) return err(`a spell effect carries no ${stray.join("/")} field`);
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id))
    return err("a spell effect needs an id of 1–128 letters, digits, \"_\" or \"-\"");
  if (raw.version !== PF1E_SPELL_EFFECT_VERSION)
    return err(`a spell effect version must be ${String(PF1E_SPELL_EFFECT_VERSION)}`);
  if (!isText(raw.name, 80)) return err("a spell effect needs a name of at most 80 characters");
  if (raw.conditionFxMacroId !== undefined &&
      (typeof raw.conditionFxMacroId !== "string" || !ID_RE.test(raw.conditionFxMacroId)))
    return err("a spell effect condition FX macro id must be a bounded document id");
  if (!isRecord(raw.source) ||
      Object.keys(raw.source).some((key) => !(SOURCE_KEYS as readonly string[]).includes(key)) ||
      !isText(raw.source.title, 160) || !isText(raw.source.citation, 240) ||
      (raw.source.url !== undefined && !isText(raw.source.url, 300)))
    return err("a spell effect needs a source with a title and citation (and an optional url)");
  if (raw.save !== null) {
    if (!isRecord(raw.save) ||
        Object.keys(raw.save).some((key) => !(SAVE_KEYS as readonly string[]).includes(key)) ||
        !SAVE_TYPES.includes(raw.save.type as PF1eSaveType) ||
        raw.save.severity !== CONDITION_SAVE_SEVERITY)
      return err(`a spell effect save must be null or { type: fort|ref|will, severity: "${CONDITION_SAVE_SEVERITY}" }`);
  }
  if (!Array.isArray(raw.conditions) || raw.conditions.length < 1 ||
      raw.conditions.length > PF1E_SPELL_EFFECT_MAX_CONDITIONS)
    return err(`a spell effect names 1–${String(PF1E_SPELL_EFFECT_MAX_CONDITIONS)} conditions`);
  const conditions: string[] = [];
  for (const [index, name] of raw.conditions.entries()) {
    if (typeof name !== "string") return err(`spell effect conditions[${String(index)}] must be a name`);
    const def = pf1eConditionDef(name);
    if (!def) return err(`spell effect condition "${name}" is not a PF1e condition`);
    if (conditions.includes(def.name)) return err(`spell effect repeats condition ${def.name}`);
    conditions.push(def.name);
  }
  const source: PF1eSpellEffectSource = {
    title: raw.source.title.trim(),
    citation: raw.source.citation.trim(),
    ...(raw.source.url !== undefined ? { url: raw.source.url.trim() } : {}),
  };
  return okVal({
    id: raw.id,
    version: PF1E_SPELL_EFFECT_VERSION,
    name: raw.name.trim(),
    source,
    save: raw.save === null
      ? null
      : { type: raw.save.type as PF1eSaveType, severity: raw.save.severity as PF1eSaveSeverity },
    conditions,
    ...(typeof raw.conditionFxMacroId === "string" ? { conditionFxMacroId: raw.conditionFxMacroId } : {}),
  });
}

/**
 * Unvalidated catalogue rows. The loader below is the only reader; the shipped pack mirrors these
 * rows profile for profile (`tests/packages/pf1eContentPacks.test.ts`).
 */
export const PF1E_SPELL_EFFECT_ROWS: readonly unknown[] = [
  {
    id: "entangle",
    version: 1,
    name: "Entangle",
    source: {
      title: "PRPG Core Rulebook p.278 (Entangle)",
      citation:
        "Reflex partial, see text; a creature that fails its save gains the entangled condition. The printed difficult-terrain half of \"partial\" is named as unmodeled in the pack's automationNote.",
      url: "https://www.aonprd.com/SpellDisplay.aspx?ItemName=Entangle",
    },
    save: { type: "ref", severity: "negates" },
    conditions: ["Entangled"],
    conditionFxMacroId: "macro-entangled-vines",
  },
];

interface PF1eSpellEffectLoad {
  readonly effects: readonly PF1eSpellEffect[];
  readonly errors: readonly string[];
}

function loadPF1eSpellEffects(rows: readonly unknown[]): PF1eSpellEffectLoad {
  if (!Array.isArray(rows)) return { effects: [], errors: ["spell effect catalogue: rows must be an array"] };
  const effects: PF1eSpellEffect[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((entry, index) => {
    const checked = validatePF1eSpellEffect(entry);
    if (!checked.ok) {
      errors.push(`spell effect catalogue[${String(index)}]: ${checked.error}`);
      return;
    }
    if (seen.has(checked.value.id)) {
      errors.push(`spell effect catalogue[${String(index)}]: duplicate spell effect id ${checked.value.id}`);
      return;
    }
    seen.add(checked.value.id);
    effects.push(checked.value);
  });
  return { effects, errors };
}

const SPELL_EFFECT_LOAD = loadPF1eSpellEffects(PF1E_SPELL_EFFECT_ROWS);

/** Catalogue rows that failed validation (empty is the only acceptable value in tests). */
export const PF1E_SPELL_EFFECT_ERRORS: readonly string[] = SPELL_EFFECT_LOAD.errors;

/** The validated catalogue, in authored order. */
export const PF1E_SPELL_EFFECTS: readonly PF1eSpellEffect[] = SPELL_EFFECT_LOAD.effects;

/** Exact-effect lookup by pack id (optionally a pinned version); null when the catalogue lacks it. */
export function pf1eSpellEffectById(id: string, version?: number): PF1eSpellEffect | null {
  return PF1E_SPELL_EFFECTS.find((effect) =>
    effect.id === id && (version === undefined || effect.version === version)) ?? null;
}

/** Case-insensitive display-name lookup; the cast form's selector reads the list, not this. */
export function pf1eSpellEffectByName(name: string): PF1eSpellEffect | null {
  const needle = name.trim().toLowerCase();
  return PF1E_SPELL_EFFECTS.find((effect) => effect.name.toLowerCase() === needle) ?? null;
}

/**
 * Does this target row's committed outcome deliver the effect's conditions? A spell with a save
 * lands the condition only on `failedSave`; a spell without one lands it on `affected`. This is the
 * single predicate the client producer and the host re-check share, so the card and the condition
 * store cannot disagree about what "landed" meant.
 */
export function pf1eSpellEffectLanded(effect: PF1eSpellEffect, outcome: string): boolean {
  return effect.save === null ? outcome === "affected" : outcome === "failedSave";
}
