/**
 * PF1e tactical **effects** — the data contract and stacking resolution.
 *
 * Deliberate constraint (user decision, Gap List §10.1 item 3, recorded as D-112): core
 * `EffectDocument` (`src/core/documents.ts:151`) is *not* extended. It stays `{ changes, disabled }`
 * so no other module is affected; PF1e's semantics live in `flags.pf1e` on the same document, and
 * `changes` is **not** used as the mechanic (it can only overwrite a path, which cannot express
 * "+2 morale to AC"). Ticking also stays with core: `flags.core.duration` is what
 * `src/core/combat.ts`'s `tickEffects` decrements at the owner's turn end, and `CombatPanel` already
 * renders its badge — this module adds *meaning* around it, never a second timer.
 *
 * Nothing here writes to a document. Derived numbers are computed on read by
 * `actor.ts:derivePF1eActor`, which is what makes expiry free (no undo, no restore).
 */
import type { Json } from "../../core/documents";
import { err, okVal, type Result } from "../../core/result";
import {
  isPF1eBonusType,
  PF1E_BONUS_TYPES,
  type PF1eBonusType,
} from "./rulesTables";

/** Every number a PF1e effect may adjust. The closed list is what makes typos loud. */
export const PF1E_MOD_KEYS = [
  "ac",
  "acTouch",
  "acFlatFooted",
  "attack",
  "attackMelee",
  "attackRanged",
  "damage",
  "save.fort",
  "save.ref",
  "save.will",
  "saves",
  "cmb",
  "cmd",
  "initiative",
  "speed",
  "ability.str",
  "ability.dex",
  "ability.con",
  "ability.int",
  "ability.wis",
  "ability.cha",
  "casterLevel",
  "concentration",
  "spellDc",
  "spellPenetration",
  "perception",
  "stealth",
] as const;

export type PF1eModKey = (typeof PF1E_MOD_KEYS)[number];

function isModKey(value: unknown): value is PF1eModKey {
  return (
    typeof value === "string" &&
    (PF1E_MOD_KEYS as readonly string[]).includes(value)
  );
}

/** One typed contribution (SRD "Bonuses and Penalties"; stacking in `resolveEffects`). */
export type PF1eMod = {
  key: PF1eModKey;
  type: PF1eBonusType;
  /** Signed: penalties are negative values carrying their own type. */
  value: number;
  /** Origin name; untyped and circumstance bonuses stack only across *different* sources. */
  source?: string;
};

/** Extra damage on top of the weapon's own (energy weapon, sneak-attack style precision damage). */
export type PF1eDamageBoost = {
  dice?: number;
  sides?: number;
  bonus?: number;
  /** Energy descriptor for resistance bookkeeping (fire, cold, acid, electricity, sonic). */
  energy?: string;
  /** Precision damage is never multiplied on a critical and never reduced by DR (A.3). */
  precision?: boolean;
};

/** Duration semantics; the countdown itself is core's `flags.core.duration`. */
export const PF1E_TTL_UNITS = [
  "round",
  "minute",
  "hour",
  "day",
  "instant",
  "concentration",
  "permanent",
] as const;

export type PF1eTtl = {
  unit: (typeof PF1E_TTL_UNITS)[number];
  value: number;
  /** "1 round/level", "1 minute/level" … */
  perLevel?: boolean;
  /**
   * Which boundary consumes a tick. Core ticks at the owner's turn end, which matches the SRD
   * "ends at the beginning of your next turn" convention for rounds/level; `round-start` is the
   * variant for effects measured in whole rounds. See the P4 note in the plan.
   */
  endsOn?: "own-turn" | "round-start";
};

export type PF1eEffectSource = {
  kind:
    "spell" | "feat" | "item" | "condition" | "poison" | "disease" | "other";
  id?: string;
  /** Caster or effect level, for DCs and per-level scaling. */
  level?: number;
  /** Save DC, when the target was allowed one. */
  dc?: number;
};

/** The payload under `effect.flags.pf1e`. */
export type PF1eEffectPayload = {
  mods?: PF1eMod[];
  boosts?: PF1eDamageBoost[];
  /** Actions the target cannot take while active ("full-attack", "charge", "cast-spell", "aoo"). */
  denies?: string[];
  /** Named special qualities granted ("evasion", "uncanny-dodge", "low-light-vision"). */
  grants?: string[];
  immune?: {
    mindAffecting?: boolean;
    conditions?: string[];
    energy?: string[];
    dr?: number;
  };
  flags?: {
    flatFooted?: boolean;
    deniedDexToAc?: boolean;
    cannotAoO?: boolean;
  };
  /** SRD condition name for display and immunity checks; its *mechanics* are in `mods`. */
  condition?: string;
  /** Requires a standard action each round or it ends (concentration-based durations). */
  concentration?: boolean;
  ttl?: PF1eTtl;
  source?: PF1eEffectSource;
  /** Effects sharing a group (e.g. "rage") contribute once between them, best only. */
  stackGroup?: string;
};

/** A validated effect, ready for the derivation to read. */
export type PF1eActiveEffect = {
  id: string;
  name: string;
  icon: string | null;
  disabled: boolean;
  /** Remaining ticks from `flags.core.duration`; null = no countdown, persists until removed. */
  durationLeft: number | null;
  payload: PF1eEffectPayload;
};

/** Minimal structural view of an effect document (so tests need no full document). */
export interface EffectLike {
  type?: string;
  name?: string;
  disabled?: boolean;
  icon?: string;
  flags?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function scopeFlags(
  doc: EffectLike,
  scope: "core" | "pf1e",
): Record<string, unknown> {
  const flags = asRecord(doc.flags ?? {});
  return (flags ? asRecord(flags[scope]) : null) ?? {};
}

const stringArray = (v: unknown, field: string): Result<string[]> => {
  if (v === undefined) return okVal<string[]>([]);
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    return err(`pf1e effect: ${field} must be an array of strings`);
  }
  return okVal(v as string[]);
};

/** Validate one `flags.pf1e` payload. Unknown fields/mod keys/bonus types are errors, never silence. */
export function validateEffectPayload(raw: unknown): Result<PF1eEffectPayload> {
  const obj = asRecord(raw);
  if (!obj) return err("pf1e effect: payload must be an object");
  const known = [
    "mods",
    "boosts",
    "denies",
    "grants",
    "immune",
    "flags",
    "condition",
    "concentration",
    "ttl",
    "source",
    "stackGroup",
  ];
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) return err(`pf1e effect: unknown field "${key}"`);
  }

  const mods: PF1eMod[] = [];
  if (obj.mods !== undefined) {
    if (!Array.isArray(obj.mods))
      return err("pf1e effect: mods must be an array");
    for (const [i, entry] of obj.mods.entries()) {
      const m = asRecord(entry);
      if (!m) return err(`pf1e effect: mods[${i}] must be an object`);
      if (!isModKey(m.key)) {
        return err(
          `pf1e effect: mods[${i}].key ${JSON.stringify(m.key)} is not a PF1e mod key`,
        );
      }
      if (!isPF1eBonusType(m.type)) {
        return err(
          `pf1e effect: mods[${i}].type ${JSON.stringify(m.type)} is not one of ${PF1E_BONUS_TYPES.join(", ")}`,
        );
      }
      if (typeof m.value !== "number" || !Number.isFinite(m.value)) {
        return err(`pf1e effect: mods[${i}].value must be a finite number`);
      }
      if (m.source !== undefined && typeof m.source !== "string") {
        return err(`pf1e effect: mods[${i}].source must be a string`);
      }
      mods.push({
        key: m.key,
        type: m.type,
        value: Math.trunc(m.value),
        ...(typeof m.source === "string" ? { source: m.source } : {}),
      });
    }
  }

  const boosts: PF1eDamageBoost[] = [];
  if (obj.boosts !== undefined) {
    if (!Array.isArray(obj.boosts))
      return err("pf1e effect: boosts must be an array");
    for (const [i, entry] of obj.boosts.entries()) {
      const b = asRecord(entry);
      if (!b) return err(`pf1e effect: boosts[${i}] must be an object`);
      const dice = typeof b.dice === "number" ? Math.trunc(b.dice) : undefined;
      const sides =
        typeof b.sides === "number" ? Math.trunc(b.sides) : undefined;
      const bonus =
        typeof b.bonus === "number" ? Math.trunc(b.bonus) : undefined;
      if (dice === undefined && bonus === undefined) {
        return err(`pf1e effect: boosts[${i}] needs dice or bonus`);
      }
      if (dice !== undefined && (sides === undefined || sides < 2)) {
        return err(`pf1e effect: boosts[${i}] with dice needs sides >= 2`);
      }
      const boost: PF1eDamageBoost = {};
      if (dice !== undefined && sides !== undefined) {
        // validation above guarantees a `sides >= 2` whenever `dice` is present
        boost.dice = dice;
        boost.sides = sides;
      }
      if (bonus !== undefined) boost.bonus = bonus;
      if (typeof b.energy === "string") boost.energy = b.energy;
      if (b.precision === true) boost.precision = true;
      boosts.push(boost);
    }
  }

  let ttl: PF1eTtl | undefined;
  if (obj.ttl !== undefined) {
    const parsed = readTtl(obj.ttl);
    if (!parsed)
      return err(
        `pf1e effect: ttl must be { unit, value, perLevel?, endsOn? }`,
      );
    ttl = parsed;
  }

  let source: PF1eEffectSource | undefined;
  if (obj.source !== undefined) {
    const parsed = readSource(obj.source);
    if (!parsed)
      return err(`pf1e effect: source must be { kind, id?, level?, dc? }`);
    source = parsed;
  }

  const immune = asRecord(obj.immune);
  if (obj.immune !== undefined && !immune)
    return err("pf1e effect: immune must be an object");
  const payloadFlags = asRecord(obj.flags);
  if (obj.flags !== undefined && !payloadFlags)
    return err("pf1e effect: flags must be an object");

  const denies = stringArray(obj.denies, "denies");
  if (!denies.ok) return denies;
  const grants = stringArray(obj.grants, "grants");
  if (!grants.ok) return grants;
  const immuneConditions = immune
    ? stringArray(immune.conditions, "immune.conditions")
    : okVal([]);
  if (!immuneConditions.ok) return immuneConditions;
  const immuneEnergy = immune
    ? stringArray(immune.energy, "immune.energy")
    : okVal([]);
  if (!immuneEnergy.ok) return immuneEnergy;

  return okVal({
    ...(mods.length > 0 ? { mods } : {}),
    ...(boosts.length > 0 ? { boosts } : {}),
    ...(denies.value.length > 0 ? { denies: denies.value } : {}),
    ...(grants.value.length > 0 ? { grants: grants.value } : {}),
    ...(immune
      ? {
          immune: {
            ...(immune.mindAffecting === true ? { mindAffecting: true } : {}),
            ...(immuneConditions.value.length > 0
              ? { conditions: immuneConditions.value }
              : {}),
            ...(immuneEnergy.value.length > 0
              ? { energy: immuneEnergy.value }
              : {}),
            ...(typeof immune.dr === "number" && Number.isFinite(immune.dr)
              ? { dr: Math.max(0, Math.trunc(immune.dr)) }
              : {}),
          },
        }
      : {}),
    ...(payloadFlags
      ? {
          flags: {
            ...(payloadFlags.flatFooted === true ? { flatFooted: true } : {}),
            ...(payloadFlags.deniedDexToAc === true
              ? { deniedDexToAc: true }
              : {}),
            ...(payloadFlags.cannotAoO === true ? { cannotAoO: true } : {}),
          },
        }
      : {}),
    ...(typeof obj.condition === "string" && obj.condition !== ""
      ? { condition: obj.condition }
      : {}),
    ...(obj.concentration === true ? { concentration: true } : {}),
    ...(ttl ? { ttl } : {}),
    ...(source ? { source } : {}),
    ...(typeof obj.stackGroup === "string" && obj.stackGroup !== ""
      ? { stackGroup: obj.stackGroup }
      : {}),
  });
}

function readTtl(raw: unknown): PF1eTtl | undefined {
  const t = asRecord(raw);
  if (!t) return undefined;
  if (
    typeof t.unit !== "string" ||
    !(PF1E_TTL_UNITS as readonly string[]).includes(t.unit)
  ) {
    return undefined;
  }
  const value =
    typeof t.value === "number" && Number.isFinite(t.value)
      ? Math.max(1, Math.trunc(t.value))
      : 1;
  const unit = t.unit as PF1eTtl["unit"];
  return {
    unit,
    value,
    ...(t.perLevel === true ? { perLevel: true } : {}),
    endsOn: t.endsOn === "round-start" ? "round-start" : "own-turn",
  };
}

const SOURCE_KINDS: readonly PF1eEffectSource["kind"][] = [
  "spell",
  "feat",
  "item",
  "condition",
  "poison",
  "disease",
  "other",
];

function readSource(raw: unknown): PF1eEffectSource | undefined {
  const s = asRecord(raw);
  if (!s || typeof s.kind !== "string") return undefined;
  const kind = s.kind as PF1eEffectSource["kind"];
  if (!SOURCE_KINDS.includes(kind)) return undefined;
  return {
    kind,
    ...(typeof s.id === "string" ? { id: s.id } : {}),
    ...(typeof s.level === "number" && Number.isFinite(s.level)
      ? { level: Math.trunc(s.level) }
      : {}),
    ...(typeof s.dc === "number" && Number.isFinite(s.dc)
      ? { dc: Math.trunc(s.dc) }
      : {}),
  };
}

/** Core's convention: `flags.core.duration` is a plain integer of ticks (`core/combat.ts` header). */
function coreDuration(doc: EffectLike): number | null {
  const v = scopeFlags(doc, "core")["duration"];
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.trunc(v)
    : null;
}

/** Read + validate one effect document (an `EffectDocument` carrying `flags.pf1e`). */
export function readTacticalEffect(
  id: string,
  doc: EffectLike,
): Result<PF1eActiveEffect> {
  const payload = validateEffectPayload(scopeFlags(doc, "pf1e"));
  if (!payload.ok) return payload;
  return okVal({
    id,
    name: typeof doc.name === "string" && doc.name !== "" ? doc.name : "Effect",
    icon: typeof doc.icon === "string" && doc.icon !== "" ? doc.icon : null,
    disabled: doc.disabled === true,
    durationLeft: coreDuration(doc),
    payload: payload.value,
  });
}

/** Read every effect embedded on a document, dropping the ones that fail validation (with reasons). */
export function readTacticalEffects(
  embedded:
    | ReadonlyArray<readonly [id: string, doc: EffectLike]>
    | Readonly<Record<string, EffectLike>>,
): {
  effects: PF1eActiveEffect[];
  rejected: Array<{ id: string; error: string }>;
} {
  const entries: Array<[string, EffectLike]> = Array.isArray(embedded)
    ? (embedded as Array<[string, EffectLike]>)
    : Object.entries(embedded as Record<string, EffectLike>);
  const effects: PF1eActiveEffect[] = [];
  const rejected: Array<{ id: string; error: string }> = [];
  for (const [id, doc] of entries) {
    const r = readTacticalEffect(id, doc);
    if (r.ok) effects.push(r.value);
    else rejected.push({ id, error: r.error });
  }
  return { effects, rejected };
}

/**
 * The tick count to seed `flags.core.duration` with, so core's per-turn ticking matches the
 * spell's written duration. 1 round = 6 s (A.1), so a minute is 10 rounds and an hour is 100;
 * day/permanent/concentration/instant durations are not per-turn countdowns and return null
 * (the world clock or an event ends them — P4/P5).
 */
export function ttlToTicks(
  ttl: PF1eTtl | undefined,
  casterLevel = 1,
): number | null {
  if (!ttl) return null;
  const level = Math.max(1, Math.trunc(casterLevel));
  const n = ttl.perLevel ? ttl.value * level : ttl.value;
  switch (ttl.unit) {
    case "round":
      return n;
    case "minute":
      return n * 10;
    case "hour":
      return n * 100;
    default:
      return null;
  }
}

/** The `flags` object to write when an effect is applied (both scopes, one place). */
export function effectFlagsFor(
  payload: PF1eEffectPayload,
  casterLevel = payload.source?.level ?? 1,
): { core: Record<string, Json>; pf1e: PF1eEffectPayload } {
  const ticks = ttlToTicks(payload.ttl, casterLevel);
  return {
    core: ticks !== null ? { duration: ticks } : {},
    pf1e: payload,
  };
}

/** A mod after provenance is attached, for the sheet's breakdown line. */
interface AttributedMod extends PF1eMod {
  from: string;
  stackGroup: string | null;
}

/** Active contributions grouped for the derivation. Pure — no documents, no store, no writes. */
export interface ResolvedEffects {
  /** Summed per mod key after stacking resolution. */
  mods: Partial<Record<PF1eModKey, number>>;
  /** Transferable AC bonuses and all AC penalties, which also move CMD (A.9). */
  acTransfer: number;
  acPenalties: number;
  boosts: readonly PF1eDamageBoost[];
  denies: ReadonlySet<string>;
  grants: ReadonlySet<string>;
  immuneMindAffecting: boolean;
  immuneConditions: ReadonlySet<string>;
  immuneEnergy: ReadonlySet<string>;
  /** Flat additional DR granted by effects (kept separate from the actor's own DR list). */
  extraDr: number;
  flatFooted: boolean;
  deniedDexToAc: boolean;
  cannotAoO: boolean;
  requiresConcentration: boolean;
  conditions: readonly string[];
  /** `key → human-readable breakdown`, so the UI can explain every number it shows. */
  breakdown: Partial<Record<PF1eModKey, string>>;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Stacking resolution (SRD "Bonuses and Penalties", the same rules A.15 uses for total defense):
 *  - different types add;
 *  - same type to the same key: keep the best bonus and the worst penalty, which cancel each other
 *    when both exist (`+2 enhancement` and `−2 enhancement` ⇒ 0);
 *  - dodge bonuses always stack, and untyped/circumstance bonuses stack **only from different
 *    sources**;
 *  - effects sharing a `stackGroup` contribute once between them, the best only.
 */
export function resolveEffects(
  effects: readonly PF1eActiveEffect[],
): ResolvedEffects {
  const active = effects.filter((e) => !e.disabled);
  const mods: AttributedMod[] = [];
  const boosts: PF1eDamageBoost[] = [];
  const denies = new Set<string>();
  const grants = new Set<string>();
  const immuneConditions = new Set<string>();
  const immuneEnergy = new Set<string>();
  const conditions: string[] = [];
  let immuneMindAffecting = false;
  let extraDr = 0;
  let flatFooted = false;
  let deniedDexToAc = false;
  let cannotAoO = false;
  let requiresConcentration = false;

  for (const e of active) {
    const p = e.payload;
    for (const m of p.mods ?? [])
      mods.push({ ...m, from: e.id, stackGroup: p.stackGroup ?? null });
    for (const b of p.boosts ?? []) boosts.push(b);
    for (const d of p.denies ?? []) denies.add(d);
    for (const g of p.grants ?? []) grants.add(g);
    if (p.immune?.mindAffecting === true) immuneMindAffecting = true;
    for (const c of p.immune?.conditions ?? []) immuneConditions.add(c);
    for (const en of p.immune?.energy ?? []) immuneEnergy.add(en);
    extraDr += p.immune?.dr ?? 0;
    flatFooted = flatFooted || p.flags?.flatFooted === true;
    deniedDexToAc = deniedDexToAc || p.flags?.deniedDexToAc === true;
    cannotAoO = cannotAoO || p.flags?.cannotAoO === true;
    requiresConcentration = requiresConcentration || p.concentration === true;
    if (p.condition !== undefined) conditions.push(p.condition);
  }

  const perKey = new Map<PF1eModKey, AttributedMod[]>();
  for (const m of mods) {
    const list = perKey.get(m.key);
    if (list) list.push(m);
    else perKey.set(m.key, [m]);
  }

  const out: ResolvedEffects = {
    mods: {},
    acTransfer: 0,
    acPenalties: 0,
    boosts,
    denies: denies.size > 0 ? denies : EMPTY_SET,
    grants: grants.size > 0 ? grants : EMPTY_SET,
    immuneMindAffecting,
    immuneConditions: immuneConditions.size > 0 ? immuneConditions : EMPTY_SET,
    immuneEnergy: immuneEnergy.size > 0 ? immuneEnergy : EMPTY_SET,
    extraDr,
    flatFooted,
    deniedDexToAc,
    cannotAoO,
    requiresConcentration,
    conditions,
    breakdown: {},
  };

  for (const [key, list] of perKey) {
    const { total, parts } = resolveKeyMods(list);
    if (total !== 0) out.mods[key] = total;
    if (parts.length > 0) out.breakdown[key] = parts.join(", ");
  }

  for (const m of perKey.get("ac") ?? []) {
    if (m.value >= 0 && CMD_TRANSFERABLE.has(m.type)) out.acTransfer += m.value;
    if (m.value < 0) out.acPenalties += m.value;
  }
  return out;
}

/** Bonus types whose AC value also raises CMD, and AC penalties always transfer (A.9). */
const CMD_TRANSFERABLE: ReadonlySet<PF1eBonusType> = new Set<PF1eBonusType>([
  "deflection",
  "dodge",
  "insight",
  "luck",
  "morale",
  "profane",
  "sacred",
  "circumstance",
]);

export function transfersToCmd(type: PF1eBonusType): boolean {
  return CMD_TRANSFERABLE.has(type);
}

interface Group {
  bonus: number;
  penalty: number;
  sources: string[];
}

function push(group: Group, value: number, source: string): void {
  if (value >= 0) {
    if (value > group.bonus) {
      group.bonus = value;
      group.sources = [source];
    }
    return;
  }
  if (value < group.penalty) {
    group.penalty = value;
    group.sources = [source];
  }
}

/**
 * Which group a contribution belongs to: entries in the same group compete (keep the better),
 * entries in different groups add. Dodge bonuses and differently-sourced untyped/circumstance
 * bonuses get a group of their own, so they add.
 */
function bucketOf(m: AttributedMod): { id: string; stacks: boolean } {
  if (m.stackGroup !== null)
    return { id: `group:${m.stackGroup}`, stacks: false };
  if (m.type === "dodge") return { id: `dodge:${m.from}`, stacks: true };
  if (
    (m.type === "untyped" || m.type === "circumstance") &&
    m.source !== undefined
  ) {
    return { id: `${m.type}:${m.source}`, stacks: true };
  }
  return { id: m.type, stacks: false };
}

/**
 * Do two contributions to the same key combine (true) or compete for one slot (false)?
 * @srd "Bonuses and Penalties" — different types add; same type does not; dodge always adds;
 * untyped and circumstance add only when the sources differ. `stackGroup` is a separate,
 * author-declared collapse and is applied by `resolveEffects`.
 */
export function contributionsCombine(
  a: { type: PF1eBonusType; source?: string },
  b: { type: PF1eBonusType; source?: string },
): boolean {
  if (a.type !== b.type) return true;
  if (a.type === "dodge") return true;
  if (a.type === "untyped" || a.type === "circumstance") {
    return (
      a.source !== undefined && b.source !== undefined && a.source !== b.source
    );
  }
  return false;
}

/**
 * Resolve every contribution to one key. Returns the sum plus a human breakdown so the sheet can
 * show why AC is what it is — the same discipline the strategic profile compile uses.
 */
function resolveKeyMods(list: readonly AttributedMod[]): {
  total: number;
  parts: string[];
} {
  // Groups that add to everything else; groups that compete internally.
  const stacking = new Map<string, Group>();
  const competing = new Map<string, Group>();
  for (const m of list) {
    const bucket = bucketOf(m);
    const target = bucket.stacks ? stacking : competing;
    const key = target.get(bucket.id) ?? { bonus: 0, penalty: 0, sources: [] };
    push(key, m.value, m.from);
    target.set(bucket.id, key);
  }

  let total = 0;
  const parts: string[] = [];
  for (const [bucket, g] of [...stacking, ...competing]) {
    const value = g.bonus + g.penalty;
    if (value === 0) continue;
    total += value;
    parts.push(
      `${value >= 0 ? "+" : ""}${value} (${bucket.replace(/^(dodge|untyped|circumstance):/, "")})`,
    );
  }
  return { total, parts };
}

/** Human-readable summary for a badge or tooltip ("+2 enhancement to ability.str (8 rounds)"). */
export function describeEffect(e: PF1eActiveEffect): string {
  const parts: string[] = [];
  for (const m of e.payload.mods ?? []) {
    parts.push(
      `${m.value >= 0 ? "+" : ""}${m.value} ${m.type} to ${m.key.replace("ability.", "")}`,
    );
  }
  for (const b of e.payload.boosts ?? []) {
    parts.push(
      b.dice !== undefined
        ? `+${b.dice}d${b.sides ?? 6} damage`
        : `+${b.bonus ?? 0} damage`,
    );
  }
  if (e.payload.condition !== undefined)
    parts.push(`condition: ${e.payload.condition}`);
  if (e.payload.denies !== undefined)
    parts.push(`cannot ${e.payload.denies.join(", ")}`);
  const timing =
    e.durationLeft !== null
      ? ` (${e.durationLeft} round${e.durationLeft === 1 ? "" : "s"})`
      : "";
  return `${e.name} — ${parts.length > 0 ? parts.join(", ") : "no numeric change"}${timing}`;
}
