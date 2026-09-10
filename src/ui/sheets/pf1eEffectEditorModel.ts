/**
 * P4/E02 — the **custom effect editor** model. Pure: form state in, a validated
 * `PF1eEffectRequest` (or a named error) out, and a round-trip from an existing
 * `PF1eActiveEffect` back into form state for editing. The component only renders
 * this; the apply/edit Ops stay in `effectOps.ts`.
 *
 * On "open-ended stat keys" (the implementation-plan sketch): the P0 contract
 * deliberately keeps `PF1E_MOD_KEYS` closed ("the closed list is what makes typos
 * loud") and `validateEffectPayload` refuses unknown keys rather than storing a
 * silent no-op — a mod the derivation cannot consume would change nothing while
 * looking like it did. Custom buffs stay first-class through the free-form name,
 * condition label, deny/grant tokens, boosts and stacking group; extending the
 * mechanical key list is a deliberate contract change, not an editor option.
 */
import {
  PF1E_BONUS_TYPES,
  type PF1eBonusType,
} from "../../packages/pf1e/rulesTables";
import {
  PF1E_MOD_KEYS,
  PF1E_TTL_UNITS,
  type PF1eActiveEffect,
  type PF1eDamageBoost,
  type PF1eEffectPayload,
  type PF1eEffectSource,
  type PF1eMod,
  type PF1eModKey,
  type PF1eTtl,
} from "../../packages/pf1e/effects";
import type { PF1eEffectRequest } from "../../packages/pf1e/effectOps";

export { PF1E_BONUS_TYPES, PF1E_MOD_KEYS, PF1E_TTL_UNITS };

/**
 * SRD condition names as a presentation picker: the label stored in
 * `payload.condition` is display/immunity data only — its mechanics are whatever
 * mods the author adds (E03 owns the mathematical library).
 */
export const SRD_CONDITION_NAMES = [
  "Blinded",
  "Dazzled",
  "Dead",
  "Disabled",
  "Dying",
  "Entangled",
  "Exhausted",
  "Fascinated",
  "Fatigued",
  "Flat-footed",
  "Frightened",
  "Grappled",
  "Helpless",
  "Invisible",
  "Nauseated",
  "Panicked",
  "Paralyzed",
  "Pinned",
  "Prone",
  "Shaken",
  "Sickened",
  "Stable",
  "Stunned",
  "Unconscious",
] as const;

/** Deny tokens with consumers or near-term consumers, offered as suggestions. */
export const SUGGESTED_DENY_TOKENS = [
  "charge",
  "full-attack",
  "cast-spell",
  "standard",
  "move",
  "swift",
  "five-foot-step",
  "aoo",
] as const;

export const EFFECT_SOURCE_KINDS = [
  "spell",
  "feat",
  "item",
  "condition",
  "poison",
  "disease",
  "other",
] as const;

export interface EffectModForm {
  key: PF1eModKey | "";
  type: PF1eBonusType;
  /** Empty = absent; otherwise a whole number (penalties negative). */
  value: string;
  /** Untyped/circumstance stacking source (free text). */
  source: string;
}

export interface EffectBoostForm {
  dice: string;
  sides: string;
  bonus: string;
  energy: string;
  precision: boolean;
}

export interface EffectForm {
  name: string;
  icon: string;
  condition: string;
  mods: EffectModForm[];
  boosts: EffectBoostForm[];
  /** Comma/space separated tokens (denies, grants). */
  denies: string;
  grants: string;
  stackGroup: string;
  concentration: boolean;
  flatFooted: boolean;
  deniedDexToAc: boolean;
  cannotAoO: boolean;
  immuneMindAffecting: boolean;
  immuneConditions: string;
  immuneEnergy: string;
  immuneDr: string;
  ttlUnit: (typeof PF1E_TTL_UNITS)[number] | "";
  ttlValue: string;
  ttlPerLevel: boolean;
  ttlEndsOn: "own-turn" | "round-start";
  sourceKind: (typeof EFFECT_SOURCE_KINDS)[number] | "";
  sourceId: string;
  sourceLevel: string;
  sourceDc: string;
}

export function emptyEffectForm(): EffectForm {
  return {
    name: "",
    icon: "",
    condition: "",
    mods: [{ key: "", type: "untyped", value: "", source: "" }],
    boosts: [],
    denies: "",
    grants: "",
    stackGroup: "",
    concentration: false,
    flatFooted: false,
    deniedDexToAc: false,
    cannotAoO: false,
    immuneMindAffecting: false,
    immuneConditions: "",
    immuneEnergy: "",
    immuneDr: "",
    ttlUnit: "",
    ttlValue: "",
    ttlPerLevel: false,
    ttlEndsOn: "own-turn",
    sourceKind: "",
    sourceId: "",
    sourceLevel: "",
    sourceDc: "",
  };
}

/** Parse one numeric form field: "" = absent, garbage = a named error. */
function optionalInt(
  raw: string,
  field: string,
): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isSafeInteger(Math.trunc(n)))
    return { value: null, error: `${field} must be a whole number.` };
  return { value: Math.trunc(n), error: null };
}

/** "fire, cold" / "fire cold" → ["fire", "cold"]; free-form tokens, lowercased. */
export function parseTokenList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Assemble the apply request from the form. Every invalid field is reported —
 * the editor never guesses a zero, and the payload is revalidated by
 * `validateEffectPayload` through `buildEffectDoc` before anything is written.
 */
export function buildEffectRequest(form: EffectForm): {
  request: PF1eEffectRequest | null;
  error: string | null;
} {
  const name = form.name.trim();
  if (name === "")
    return { request: null, error: "A display name is required." };

  const mods: PF1eMod[] = [];
  for (const [i, row] of form.mods.entries()) {
    if (row.key === "" && row.value.trim() === "") continue; // untouched row
    if (row.key === "")
      return {
        request: null,
        error: `Modifier row ${i + 1} has no stat selected.`,
      };
    const parsed = optionalInt(row.value, `Modifier row ${i + 1} value`);
    if (parsed.error) return { request: null, error: parsed.error };
    if (parsed.value === null)
      return { request: null, error: `Modifier row ${i + 1} has no value.` };
    mods.push({
      key: row.key,
      type: row.type,
      value: parsed.value,
      ...(row.source.trim() !== "" ? { source: row.source.trim() } : {}),
    });
  }

  const boosts: PF1eDamageBoost[] = [];
  for (const [i, row] of form.boosts.entries()) {
    const dice = optionalInt(row.dice, `Boost row ${i + 1} dice count`);
    if (dice.error) return { request: null, error: dice.error };
    const sides = optionalInt(row.sides, `Boost row ${i + 1} die size`);
    if (sides.error) return { request: null, error: sides.error };
    const bonus = optionalInt(row.bonus, `Boost row ${i + 1} bonus`);
    if (bonus.error) return { request: null, error: bonus.error };
    if (dice.value === null && bonus.value === null) {
      return {
        request: null,
        error: `Boost row ${i + 1} needs dice or a flat bonus.`,
      };
    }
    if (dice.value !== null && (sides.value === null || sides.value < 2))
      return {
        request: null,
        error: `Boost row ${i + 1} needs a die size of at least 2.`,
      };
    boosts.push({
      ...(dice.value !== null && sides.value !== null
        ? { dice: dice.value, sides: sides.value }
        : {}),
      ...(bonus.value !== null ? { bonus: bonus.value } : {}),
      ...(row.energy.trim() !== "" ? { energy: row.energy.trim() } : {}),
      ...(row.precision ? { precision: true } : {}),
    });
  }

  let ttl: PF1eTtl | undefined;
  if (form.ttlUnit !== "") {
    const value = optionalInt(form.ttlValue, "Duration value");
    if (value.error) return { request: null, error: value.error };
    ttl = {
      unit: form.ttlUnit,
      value: Math.max(1, value.value ?? 1),
      ...(form.ttlPerLevel ? { perLevel: true } : {}),
      endsOn: form.ttlEndsOn,
    };
  }

  let source: PF1eEffectSource | undefined;
  if (form.sourceKind !== "") {
    const level = optionalInt(form.sourceLevel, "Source level");
    if (level.error) return { request: null, error: level.error };
    const dc = optionalInt(form.sourceDc, "Source DC");
    if (dc.error) return { request: null, error: dc.error };
    source = {
      kind: form.sourceKind,
      ...(form.sourceId.trim() !== "" ? { id: form.sourceId.trim() } : {}),
      ...(level.value !== null ? { level: level.value } : {}),
      ...(dc.value !== null ? { dc: dc.value } : {}),
    };
  }

  const immuneDr = optionalInt(form.immuneDr, "Damage reduction");
  if (immuneDr.error) return { request: null, error: immuneDr.error };

  const immune =
    form.immuneMindAffecting ||
    parseTokenList(form.immuneConditions).length > 0 ||
    parseTokenList(form.immuneEnergy).length > 0 ||
    immuneDr.value !== null
      ? {
          ...(form.immuneMindAffecting ? { mindAffecting: true } : {}),
          ...(parseTokenList(form.immuneConditions).length > 0
            ? { conditions: parseTokenList(form.immuneConditions) }
            : {}),
          ...(parseTokenList(form.immuneEnergy).length > 0
            ? { energy: parseTokenList(form.immuneEnergy) }
            : {}),
          ...(immuneDr.value !== null
            ? { dr: Math.max(0, immuneDr.value) }
            : {}),
        }
      : undefined;

  const flags =
    form.flatFooted || form.deniedDexToAc || form.cannotAoO
      ? {
          ...(form.flatFooted ? { flatFooted: true } : {}),
          ...(form.deniedDexToAc ? { deniedDexToAc: true } : {}),
          ...(form.cannotAoO ? { cannotAoO: true } : {}),
        }
      : undefined;

  const condition = form.condition.trim();
  const stackGroup = form.stackGroup.trim();
  const payload: PF1eEffectPayload = {
    ...(mods.length > 0 ? { mods } : {}),
    ...(boosts.length > 0 ? { boosts } : {}),
    ...(parseTokenList(form.denies).length > 0
      ? { denies: parseTokenList(form.denies) }
      : {}),
    ...(parseTokenList(form.grants).length > 0
      ? { grants: parseTokenList(form.grants) }
      : {}),
    ...(immune ? { immune } : {}),
    ...(flags ? { flags } : {}),
    ...(condition !== "" ? { condition } : {}),
    ...(form.concentration ? { concentration: true } : {}),
    ...(ttl ? { ttl } : {}),
    ...(source ? { source } : {}),
    ...(stackGroup !== "" ? { stackGroup } : {}),
  };

  return {
    request: {
      name,
      ...(form.icon.trim() !== "" ? { icon: form.icon.trim() } : {}),
      payload,
    },
    error: null,
  };
}

/**
 * Round-trip: an existing effect's validated payload back into editor state, so
 * "Edit" never shows a lie (unknown data cannot exist — it was validated on read).
 */
export function formFromEffect(effect: PF1eActiveEffect): EffectForm {
  const p = effect.payload;
  return {
    name: effect.name,
    icon: effect.icon ?? "",
    condition: p.condition ?? "",
    mods:
      (p.mods ?? []).length > 0
        ? (p.mods as PF1eMod[]).map((m) => ({
            key: m.key,
            type: m.type,
            value: String(m.value),
            source: m.source ?? "",
          }))
        : [{ key: "", type: "untyped", value: "", source: "" }],
    boosts: (p.boosts ?? []).map((b) => ({
      dice: b.dice !== undefined ? String(b.dice) : "",
      sides: b.sides !== undefined ? String(b.sides) : "",
      bonus: b.bonus !== undefined ? String(b.bonus) : "",
      energy: b.energy ?? "",
      precision: b.precision === true,
    })),
    denies: (p.denies ?? []).join(", "),
    grants: (p.grants ?? []).join(", "),
    stackGroup: p.stackGroup ?? "",
    concentration: p.concentration === true,
    flatFooted: p.flags?.flatFooted === true,
    deniedDexToAc: p.flags?.deniedDexToAc === true,
    cannotAoO: p.flags?.cannotAoO === true,
    immuneMindAffecting: p.immune?.mindAffecting === true,
    immuneConditions: (p.immune?.conditions ?? []).join(", "),
    immuneEnergy: (p.immune?.energy ?? []).join(", "),
    immuneDr: p.immune?.dr !== undefined ? String(p.immune.dr) : "",
    ttlUnit: p.ttl?.unit ?? "",
    ttlValue: p.ttl !== undefined ? String(p.ttl.value) : "",
    ttlPerLevel: p.ttl?.perLevel === true,
    ttlEndsOn: p.ttl?.endsOn ?? "own-turn",
    sourceKind: p.source?.kind ?? "",
    sourceId: p.source?.id ?? "",
    sourceLevel: p.source?.level !== undefined ? String(p.source.level) : "",
    sourceDc: p.source?.dc !== undefined ? String(p.source.dc) : "",
  };
}
