/**
 * Core PF1e poison/affliction rules — immutable source profiles and a pure, host-callable course
 * state machine. This module deliberately does not perform document writes, roll dice, or infer a
 * save result. The host supplies verified saves and commits the returned course/effect event
 * atomically. Disease and Unchained progression tracks are separate rules profiles, not aliases.
 */
import { DAY_SECONDS, HOUR_SECONDS, MINUTE_SECONDS, SECONDS_PER_ROUND } from "../../core/clock";
import { err, okVal, type Result } from "../../core/result";
import type { PF1eAbilityKey } from "./actor";
import { PF1E_POISON_CATALOGUE } from "./poisonCatalogue";

export const PF1E_POISON_RULESET = "core-pf1e" as const;

export type PF1ePoisonTimeUnit = "round" | "minute" | "hour" | "day";
export type PF1ePoisonDeliveryRoute = "injury" | "contact" | "ingested" | "inhaled";
export type PF1ePoisonCourseState = "onset" | "active" | "cured" | "expired";
export type PF1ePoisonSaveType = "fort" | "ref" | "will";

export interface PF1ePoisonDuration {
  readonly value: number;
  readonly unit: PF1ePoisonTimeUnit;
}

export interface PF1ePoisonDefinitionSource {
  readonly title: string;
  readonly citation: string;
  readonly url?: string;
}

export type PF1ePoisonEffect =
  | {
      readonly kind: "damage";
      readonly target: "hitPoints" | "abilityDamage" | "abilityDrain";
      readonly formula: string;
      readonly ability?: PF1eAbilityKey;
      /** Ability effects usually accumulate; replace is explicit source behavior. */
      readonly accumulation?: "accumulate" | "replace";
    }
  | {
      readonly kind: "condition";
      readonly condition: string;
      /** Cure removes only source-owned conditions the poison entry says are temporary. */
      readonly removeOnCure: boolean;
    };

export interface PF1ePoisonDefinition {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly ruleset: typeof PF1E_POISON_RULESET;
  readonly source: PF1ePoisonDefinitionSource;
  readonly delivery: readonly PF1ePoisonDeliveryRoute[];
  /** Unadjusted DC. Dose stacking is applied only by the pure calculation below. */
  readonly baseDC: number;
  readonly dcSource: "fixed-stat-block" | "creature-derived";
  /** Required for creature-derived entries; the host evaluates this from the source creature. */
  readonly dcFormula?: "10+floor(Hd/2)+Con modifier";
  readonly saveType: PF1ePoisonSaveType;
  readonly onset: PF1ePoisonDuration | null;
  readonly frequency: {
    readonly interval: PF1ePoisonDuration;
    /** Number of interval saves; null is explicitly unbounded. */
    readonly intervals: number | null;
    /** First save after onset is source-specific; never guessed by the scheduler. */
    readonly firstSave: "at-onset" | "after-one-interval";
  } | null;
  readonly effects: {
    /** No-onset failure: applies once per failed exposure (also for stacked doses). */
    readonly immediate: readonly PF1ePoisonEffect[];
    /** Each failed frequency save applies this profile exactly once. */
    readonly periodic: readonly PF1ePoisonEffect[];
    /** One-shot, no-frequency poison whose onset has elapsed. */
    readonly oneShot: readonly PF1ePoisonEffect[];
  };
  readonly cure: {
    readonly successesRequired: number;
    /** `Cure N saves` and `Cure N consecutive saves` remain distinct. */
    readonly consecutive: boolean;
  };
}

export interface PF1ePoisonExposureSource {
  readonly kind: "attack" | "item" | "ability" | "environment" | "other";
  readonly actionId?: string;
  readonly sourceId?: string;
  readonly actorId?: string;
  readonly itemId?: string;
  readonly abilityId?: string;
}

export interface PF1ePoisonDoseEvent {
  readonly id: string;
  readonly source: PF1ePoisonExposureSource;
  readonly route: PF1ePoisonDeliveryRoute;
  /** The actual exposure time, retained even when Delay Poison queues the save. */
  readonly timestamp: number;
  /** When the host resolved the initial save. */
  readonly resolvedAt: number;
  readonly doseCount: number;
  readonly initialSaveDC: number;
  readonly initialSavePassed: false;
  readonly receiptId?: string;
}

export interface PF1ePoisonAttempt {
  readonly id: string;
  readonly kind: "frequency" | "one-shot";
  readonly index: number;
  readonly timestamp: number;
  readonly dc: number | null;
  readonly passed: boolean | null;
  readonly effectsApplied: boolean;
  readonly receiptId?: string;
}

/** Target-owned authoritative course; every state boundary is explicit and replay-safe. */
export interface PF1ePoisonCourse {
  readonly id: string;
  readonly targetId: string;
  readonly definitionIdentity: string;
  /** Immutable canonical snapshot, so same-name/different-mechanics profiles never merge. */
  readonly definition: PF1ePoisonDefinition;
  readonly state: PF1ePoisonCourseState;
  readonly doseCount: number;
  readonly firstExposedAt: number;
  readonly startedAt: number;
  readonly onsetDueAt: number | null;
  readonly nextAttemptAt: number | null;
  readonly frequencyEndAt: number | null;
  readonly attemptsScheduled: number | null;
  readonly attemptsResolved: number;
  readonly cureProgress: number;
  readonly doseEvents: readonly PF1ePoisonDoseEvent[];
  readonly attempts: readonly PF1ePoisonAttempt[];
  readonly lastResolvedAttemptId: string | null;
  /** Ongoing effect IDs owned by this course; cure/expiry may remove only these. */
  readonly activeEffectIds: readonly string[];
  /** Per-profile effect totals needed for explicit replace/accumulate behavior across failures. */
  readonly effectTotals: Readonly<Record<string, number>>;
  readonly pausedAt: number | null;
  readonly endedAt: number | null;
  readonly endReason: "cured" | "neutralized" | "frequency-ended" | "one-shot-complete" | null;
}

export interface PF1ePoisonExposureInput {
  readonly targetId: string;
  readonly definition: PF1ePoisonDefinition;
  /** Required only when a failed exposure starts a new course. */
  readonly newCourseId?: string;
  readonly exposureId: string;
  readonly route: PF1ePoisonDeliveryRoute;
  /** Injury/contact exposure is capped at one dose; ingestion/inhalation may batch. */
  readonly doseCount: number;
  readonly exposedAt: number;
  readonly resolvedAt?: number;
  readonly savePassed: boolean;
  readonly immune?: boolean;
  readonly source: PF1ePoisonExposureSource;
  readonly receiptId?: string;
}

export interface PF1ePoisonExposureAttempt {
  readonly id: string;
  readonly definitionIdentity: string;
  readonly source: PF1ePoisonExposureSource;
  readonly route: PF1ePoisonDeliveryRoute;
  readonly timestamp: number;
  readonly resolvedAt: number;
  readonly doseCount: number;
  readonly dc: number | null;
  readonly passed: boolean | null;
  readonly outcome: "resisted" | "contracted" | "immune";
  readonly receiptId?: string;
}

export interface PF1ePoisonExposureResolution {
  readonly course: PF1ePoisonCourse | null;
  readonly attempt: PF1ePoisonExposureAttempt;
  /** Exactly the source-defined immediate effects for this failed exposure, never per dose. */
  readonly effects: readonly PF1ePoisonEffect[];
  readonly extensionIntervals: number;
  readonly duplicate: boolean;
}

export interface PF1ePoisonFrequencyResolution {
  readonly course: PF1ePoisonCourse;
  readonly attempt: PF1ePoisonAttempt;
  readonly effects: readonly PF1ePoisonEffect[];
  /** Host removes only these course-owned continuing effect instances on cure/expiry. */
  readonly effectIdsToRemove: readonly string[];
  readonly cured: boolean;
  readonly expired: boolean;
  readonly duplicate: boolean;
}

export interface PF1ePoisonTargetState {
  readonly targetId: string;
  readonly courses: Readonly<Record<string, PF1ePoisonCourse>>;
  /** Durable exposure-attempt IDs make successful, failed and immune initial saves idempotent. */
  readonly exposureAttempts: Readonly<Record<string, PF1ePoisonExposureAttempt>>;
  readonly delayPoison: {
    active: boolean;
    startedAt: number | null;
    endsAt: number | null;
    source: PF1ePoisonExposureSource | null;
    casterLevel: number | null;
  };
  /** Ordered exposure intents awaiting their initial save after Delay Poison ends. */
  readonly queuedExposures: readonly PF1eQueuedPoisonExposure[];
}

export interface PF1eQueuedPoisonExposure {
  readonly targetId: string;
  readonly definition: PF1ePoisonDefinition;
  readonly newCourseId?: string;
  readonly exposureId: string;
  readonly route: PF1ePoisonDeliveryRoute;
  readonly doseCount: number;
  readonly exposedAt: number;
  readonly source: PF1ePoisonExposureSource;
  readonly receiptId?: string;
}

export interface PF1ePoisonTargetExposureResolution {
  readonly state: PF1ePoisonTargetState;
  readonly resolution: PF1ePoisonExposureResolution | null;
  readonly queued: boolean;
}
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ABILITIES: readonly PF1eAbilityKey[] = ["str", "dex", "con", "int", "wis", "cha"];
const ROUTES: readonly PF1ePoisonDeliveryRoute[] = ["injury", "contact", "ingested", "inhaled"];
const SOURCE_KINDS: readonly PF1ePoisonExposureSource["kind"][] = ["attack", "item", "ability", "environment", "other"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = 240): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

function isWhole(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function durationSeconds(duration: PF1ePoisonDuration): number {
  const scale = duration.unit === "round" ? SECONDS_PER_ROUND
    : duration.unit === "minute" ? MINUTE_SECONDS
      : duration.unit === "hour" ? HOUR_SECONDS : DAY_SECONDS;
  return duration.value * scale;
}

function validateDuration(raw: unknown, field: string): Result<PF1ePoisonDuration> {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !["value", "unit"].includes(key)))
    return err(`${field} must be { value, unit }`);
  if (!isWhole(raw.value, 1, 1_000_000)) return err(`${field}.value must be a positive whole number`);
  if (!["round", "minute", "hour", "day"].includes(String(raw.unit)))
    return err(`${field}.unit must be round, minute, hour or day`);
  return okVal({ value: raw.value, unit: raw.unit as PF1ePoisonTimeUnit });
}

function validateEffect(raw: unknown, field: string): Result<PF1ePoisonEffect> {
  if (!isRecord(raw)) return err(`${field} must be an object`);
  if (raw.kind === "damage") {
    if (Object.keys(raw).some((key) => !["kind", "target", "formula", "ability", "accumulation"].includes(key)))
      return err(`${field} has an unknown damage field`);
    if (!["hitPoints", "abilityDamage", "abilityDrain"].includes(String(raw.target)))
      return err(`${field}.target is unsupported`);
    if (!isText(raw.formula, 120) || !/^(?:\d+d\d+(?:[+-]\d+)?|\d+)$/i.test(raw.formula))
      return err(`${field}.formula must be a simple non-empty damage formula`);
    const target = raw.target as "hitPoints" | "abilityDamage" | "abilityDrain";
    if ((target === "abilityDamage" || target === "abilityDrain") &&
        (typeof raw.ability !== "string" || !(ABILITIES as readonly string[]).includes(raw.ability)))
      return err(`${field}.ability is required for an ability damage/drain effect`);
    if (target === "hitPoints" && raw.ability !== undefined)
      return err(`${field}.ability is not valid for hit point damage`);
    if (raw.accumulation !== undefined && !["accumulate", "replace"].includes(String(raw.accumulation)))
      return err(`${field}.accumulation must be accumulate or replace`);
    return okVal({
      kind: "damage",
      target,
      formula: raw.formula,
      ...(typeof raw.ability === "string" ? { ability: raw.ability as PF1eAbilityKey } : {}),
      ...(raw.accumulation !== undefined ? { accumulation: raw.accumulation as "accumulate" | "replace" } : {}),
    });
  }
  if (raw.kind === "condition") {
    if (Object.keys(raw).some((key) => !["kind", "condition", "removeOnCure"].includes(key)))
      return err(`${field} has an unknown condition field`);
    if (!isText(raw.condition, 80) || typeof raw.removeOnCure !== "boolean")
      return err(`${field} needs a condition name and removeOnCure boolean`);
    return okVal({ kind: "condition", condition: raw.condition, removeOnCure: raw.removeOnCure });
  }
  return err(`${field}.kind must be damage or condition`);
}

function validateEffectList(raw: unknown, field: string): Result<PF1ePoisonEffect[]> {
  if (!Array.isArray(raw)) return err(`${field} must be an array`);
  const out: PF1ePoisonEffect[] = [];
  for (const [index, effect] of raw.entries()) {
    const checked = validateEffect(effect, `${field}[${index}]`);
    if (!checked.ok) return checked;
    out.push(checked.value);
  }
  if (out.length > 32) return err(`${field} supports at most 32 effects`);
  return okVal(out);
}

/** Validate and canonicalize an immutable Core poison profile. */
export function validatePF1ePoisonDefinition(raw: unknown): Result<PF1ePoisonDefinition> {
  if (!isRecord(raw)) return err("poison definition must be an object");
  const known = ["id", "version", "name", "ruleset", "source", "delivery", "baseDC", "dcSource", "dcFormula", "saveType", "onset", "frequency", "effects", "cure"];
  if (Object.keys(raw).some((key) => !known.includes(key))) return err("poison definition has an unknown field");
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return err("poison definition id is invalid");
  if (!isWhole(raw.version, 1, 10_000)) return err("poison definition version must be a positive whole number");
  if (!isText(raw.name, 120)) return err("poison definition name is required");
  if (raw.ruleset !== PF1E_POISON_RULESET) return err("only the Core PF1e poison ruleset is supported");
  if (!isRecord(raw.source) || Object.keys(raw.source).some((key) => !["title", "citation", "url"].includes(key)) ||
      !isText(raw.source.title, 160) || !isText(raw.source.citation, 240) ||
      (raw.source.url !== undefined && (!isText(raw.source.url, 500) || !raw.source.url.startsWith("https://"))))
    return err("poison definition source needs a title, citation and optional https URL");
  if (!Array.isArray(raw.delivery) || raw.delivery.length === 0 ||
      raw.delivery.some((route) => typeof route !== "string" || !(ROUTES as readonly string[]).includes(route)))
    return err("poison definition delivery must list one or more supported routes");
  if (!isWhole(raw.baseDC, 1, 99)) return err("poison baseDC must be a whole number from 1 to 99");
  if (!["fixed-stat-block", "creature-derived"].includes(String(raw.dcSource)))
    return err("poison dcSource must identify a fixed stat-block DC or creature-derived DC");
  if ((raw.dcSource === "creature-derived" && raw.dcFormula !== "10+floor(Hd/2)+Con modifier") ||
      (raw.dcSource === "fixed-stat-block" && raw.dcFormula !== undefined))
    return err("creature-derived poison DC needs the supported 10+floor(Hd/2)+Con modifier formula");
  if (typeof raw.saveType !== "string" || !["fort", "ref", "will"].includes(raw.saveType))
    return err("poison saveType must be fort, ref or will");

  let onset: PF1ePoisonDuration | null = null;
  if (raw.onset !== null) {
    const checked = validateDuration(raw.onset, "poison onset");
    if (!checked.ok) return checked;
    onset = checked.value;
  }
  let frequency: PF1ePoisonDefinition["frequency"] = null;
  if (raw.frequency !== null) {
    if (!isRecord(raw.frequency) || Object.keys(raw.frequency).some((key) => !["interval", "intervals", "firstSave"].includes(key)))
      return err("poison frequency must be null or { interval, intervals, firstSave }");
    const interval = validateDuration(raw.frequency.interval, "poison frequency interval");
    if (!interval.ok) return interval;
    if (raw.frequency.intervals !== null && !isWhole(raw.frequency.intervals, 1, 100_000))
      return err("poison frequency intervals must be a positive whole number or null");
    if (!["at-onset", "after-one-interval"].includes(String(raw.frequency.firstSave)))
      return err("poison frequency firstSave must be at-onset or after-one-interval");
    frequency = {
      interval: interval.value,
      intervals: raw.frequency.intervals as number | null,
      firstSave: raw.frequency.firstSave as "at-onset" | "after-one-interval",
    };
  }
  if (!isRecord(raw.effects) || Object.keys(raw.effects).some((key) => !["immediate", "periodic", "oneShot"].includes(key)))
    return err("poison effects must define immediate, periodic and oneShot arrays");
  const immediate = validateEffectList(raw.effects.immediate, "poison effects.immediate");
  if (!immediate.ok) return immediate;
  const periodic = validateEffectList(raw.effects.periodic, "poison effects.periodic");
  if (!periodic.ok) return periodic;
  const oneShot = validateEffectList(raw.effects.oneShot, "poison effects.oneShot");
  if (!oneShot.ok) return oneShot;
  if (!isRecord(raw.cure) || Object.keys(raw.cure).some((key) => !["successesRequired", "consecutive"].includes(key)) ||
      !isWhole(raw.cure.successesRequired, 1, 100) || typeof raw.cure.consecutive !== "boolean")
    return err("poison cure must specify a positive successesRequired and a consecutive boolean");

  return okVal({
    id: raw.id,
    version: raw.version,
    name: raw.name.trim(),
    ruleset: PF1E_POISON_RULESET,
    source: {
      title: raw.source.title.trim(),
      citation: raw.source.citation.trim(),
      ...(typeof raw.source.url === "string" ? { url: raw.source.url } : {}),
    },
    delivery: [...new Set(raw.delivery as PF1ePoisonDeliveryRoute[])],
    baseDC: raw.baseDC,
    dcSource: raw.dcSource as "fixed-stat-block" | "creature-derived",
    ...(raw.dcFormula !== undefined ? { dcFormula: "10+floor(Hd/2)+Con modifier" as const } : {}),
    saveType: raw.saveType as PF1ePoisonSaveType,
    onset,
    frequency,
    effects: { immediate: immediate.value, periodic: periodic.value, oneShot: oneShot.value },
    cure: { successesRequired: raw.cure.successesRequired, consecutive: raw.cure.consecutive },
  });
}

/** Stable exact-profile identity includes source, version and every mechanical field. */
export function pf1ePoisonDefinitionIdentity(definition: PF1ePoisonDefinition): string {
  const checked = validatePF1ePoisonDefinition(definition);
  return checked.ok ? JSON.stringify(checked.value) : "";
}

/** Standard PF1e creature poison DC formula; callers resolve it from the source creature, then snapshot baseDC. */
export function pf1eCreaturePoisonBaseDc(hitDice: number, constitutionModifier: number): number | null {
  if (!isWhole(hitDice, 1, 100_000) || !Number.isSafeInteger(constitutionModifier) || Math.abs(constitutionModifier) > 1000)
    return null;
  const dc = 10 + Math.floor(hitDice / 2) + constitutionModifier;
  return dc >= 1 && dc <= 99 ? dc : null;
}

/** Core FAQ: ongoing save DC uses the active dose stack, not a new-exposure candidate stack. */
export function pf1ePoisonOngoingSaveDc(baseDC: number, activeDoseCount: number): number | null {
  if (!isWhole(baseDC, 1, 99) || !isWhole(activeDoseCount, 1, 100_000)) return null;
  return baseDC + 2 * (activeDoseCount - 1);
}

/** Core FAQ: resist a new batch at the DC for the candidate combined dose stack. */
export function pf1ePoisonExposureSaveDc(baseDC: number, activeDoseCount: number, newDoseCount: number): number | null {
  if (!isWhole(baseDC, 1, 99) || !isWhole(activeDoseCount, 0, 100_000) ||
      !isWhole(newDoseCount, 1, 100_000) || activeDoseCount + newDoseCount > 100_000) return null;
  return baseDC + 2 * Math.max(0, activeDoseCount + newDoseCount - 1);
}

export function pf1eActivePoisonDoseCount(course: PF1ePoisonCourse | null | undefined): number {
  return course && (course.state === "onset" || course.state === "active") ? course.doseCount : 0;
}

function safeSource(raw: unknown): Result<PF1ePoisonExposureSource> {
  if (!isRecord(raw)) return err("poison exposure source must be an object");
  const known = ["kind", "actionId", "sourceId", "actorId", "itemId", "abilityId"];
  if (Object.keys(raw).some((key) => !known.includes(key)) ||
      typeof raw.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(raw.kind))
    return err("poison exposure source is malformed");
  const out: Record<string, unknown> = { kind: raw.kind };
  for (const key of ["actionId", "sourceId", "actorId", "itemId", "abilityId"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isText(value, 160)) return err(`poison exposure source.${key} must be non-empty text`);
    out[key] = value;
  }
  return okVal(out as unknown as PF1ePoisonExposureSource);
}

type ActivePF1ePoisonCourse = PF1ePoisonCourse & { state: "onset" | "active" };

function activeCourse(course: PF1ePoisonCourse | null | undefined): course is ActivePF1ePoisonCourse {
  return course !== null && course !== undefined && (course.state === "onset" || course.state === "active");
}

function profileExtensionIntervals(definition: PF1ePoisonDefinition): number {
  const intervals = definition.frequency?.intervals;
  if (intervals === undefined || intervals === null) return 0;
  // R7 ruling: fractional half-durations are rounded down per additional dose.
  return Math.floor(intervals / 2);
}

function makeExposureAttempt(input: PF1ePoisonExposureInput, dc: number | null, outcome: PF1ePoisonExposureAttempt["outcome"], resolvedAt: number): PF1ePoisonExposureAttempt {
  const source = safeSource(input.source);
  return {
    id: input.exposureId,
    definitionIdentity: pf1ePoisonDefinitionIdentity(input.definition),
    source: source.ok ? source.value : input.source,
    route: input.route,
    timestamp: input.exposedAt,
    resolvedAt,
    doseCount: input.doseCount,
    dc,
    passed: outcome === "resisted" ? true : outcome === "contracted" ? false : null,
    outcome,
    ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
  };
}

/** Resolve one initial/exposure save. Successful exposure never changes dose/cure/schedule state. */
export function applyPF1ePoisonExposure(
  input: PF1ePoisonExposureInput,
  existing: PF1ePoisonCourse | null = null,
): Result<PF1ePoisonExposureResolution> {
  const definitionResult = validatePF1ePoisonDefinition(input.definition);
  if (!definitionResult.ok) return definitionResult;
  const definition = definitionResult.value;
  const source = safeSource(input.source);
  if (!source.ok) return source;
  if (!ID_RE.test(input.targetId) || !ID_RE.test(input.exposureId)) return err("poison target/exposure identity is invalid");
  if (!isWhole(input.doseCount, 1, 100_000)) return err("poison exposure doseCount must be a positive whole number");
  if (!isWhole(input.exposedAt) || !isWhole(input.resolvedAt ?? input.exposedAt)) return err("poison exposure timestamps must be non-negative whole seconds");
  if (!(definition.delivery as readonly string[]).includes(input.route)) return err(`${definition.name} does not support ${input.route} exposure`);
  if ((input.route === "injury" || input.route === "contact") && input.doseCount !== 1)
    return err(`${input.route} exposure contributes at most one dose per qualifying event`);
  if (typeof input.savePassed !== "boolean") return err("poison exposure needs a host-resolved save result");

  const resolvedAt = input.resolvedAt ?? input.exposedAt;
  const previous = activeCourse(existing) ? existing : null;
  if (previous && (previous.targetId !== input.targetId || previous.definitionIdentity !== pf1ePoisonDefinitionIdentity(definition)))
    return err("poison course does not match this target and exact definition identity");
  if (previous?.doseEvents.some((event) => event.id === input.exposureId)) {
    return okVal({
      course: previous,
      attempt: makeExposureAttempt(input, previous.doseEvents.find((event) => event.id === input.exposureId)?.initialSaveDC ?? null, "contracted", resolvedAt),
      effects: [],
      extensionIntervals: 0,
      duplicate: true,
    });
  }
  if (input.immune === true) {
    return okVal({
      course: previous,
      attempt: makeExposureAttempt(input, null, "immune", resolvedAt),
      effects: [],
      extensionIntervals: 0,
      duplicate: false,
    });
  }

  const activeDoses = previous?.doseCount ?? 0;
  if (activeDoses + input.doseCount > 100_000)
    return err("poison course exceeds the supported 100,000 active-dose limit");
  const dc = pf1ePoisonExposureSaveDc(definition.baseDC, activeDoses, input.doseCount);
  if (dc === null) return err("could not calculate poison exposure DC");
  if (input.savePassed) {
    return okVal({
      course: previous,
      attempt: makeExposureAttempt(input, dc, "resisted", resolvedAt),
      effects: [],
      extensionIntervals: 0,
      duplicate: false,
    });
  }

  const isNewCourse = previous === null;
  const courseId = isNewCourse ? input.newCourseId : previous.id;
  if (courseId === undefined || !ID_RE.test(courseId))
    return err("a failed exposure starting a new course requires a safe newCourseId");
  const identity = pf1ePoisonDefinitionIdentity(definition);
  const oldDoseCount = previous?.doseCount ?? 0;
  const doseCount = oldDoseCount + input.doseCount;
  const extensionDoseCount = oldDoseCount > 0 ? input.doseCount : Math.max(0, input.doseCount - 1);
  const extensionIntervals = profileExtensionIntervals(definition) * extensionDoseCount;
  const frequency = definition.frequency;
  const frequencySeconds = frequency === null ? 0 : durationSeconds(frequency.interval);
  const scheduledBase = frequency?.intervals ?? null;
  const addedIntervals = frequency === null ? 0 : extensionIntervals;
  let attemptsScheduled: number | null = previous?.attemptsScheduled ?? scheduledBase;
  if (attemptsScheduled !== null) attemptsScheduled += addedIntervals;
  let onsetDueAt = previous?.onsetDueAt ?? null;
  let nextAttemptAt = previous?.nextAttemptAt ?? null;
  let frequencyEndAt = previous?.frequencyEndAt ?? null;
  let state: PF1ePoisonCourseState = previous?.state ?? "active";
  let effects: readonly PF1ePoisonEffect[] = [];
  let endedAt: number | null = previous?.endedAt ?? null;
  let endReason: PF1ePoisonCourse["endReason"] = previous?.endReason ?? null;

  if (isNewCourse) {
    if (definition.onset !== null) {
      const onsetAt = resolvedAt + durationSeconds(definition.onset);
      onsetDueAt = onsetAt;
      state = "onset";
      if (frequency !== null) {
        nextAttemptAt = onsetAt + (frequency.firstSave === "at-onset" ? 0 : frequencySeconds);
        frequencyEndAt = attemptsScheduled === null ? null : nextAttemptAt + Math.max(0, attemptsScheduled - 1) * frequencySeconds;
      } else {
        attemptsScheduled = 1;
        nextAttemptAt = onsetAt;
        frequencyEndAt = onsetAt;
      }
      // Onset suppresses every effect until the post-onset save/one-shot boundary.
    } else if (frequency !== null) {
      state = "active";
      nextAttemptAt = resolvedAt + frequencySeconds;
      frequencyEndAt = attemptsScheduled === null ? null : nextAttemptAt + Math.max(0, attemptsScheduled - 1) * frequencySeconds;
      effects = definition.effects.immediate;
    } else {
      // No onset and no frequency is an immediate one-shot; it is not an ongoing active dose.
      state = "expired";
      attemptsScheduled = 0;
      nextAttemptAt = null;
      frequencyEndAt = resolvedAt;
      endedAt = resolvedAt;
      endReason = "one-shot-complete";
      effects = definition.effects.immediate.length > 0 ? definition.effects.immediate : definition.effects.oneShot;
    }
  } else {
    // A later dose joins the running course. It never restarts onset or moves its next save.
    if (frequency !== null && attemptsScheduled !== null && previous.attemptsScheduled !== null) {
      attemptsScheduled = previous.attemptsScheduled + addedIntervals;
      frequencyEndAt = previous.frequencyEndAt === null
        ? null
        : previous.frequencyEndAt + addedIntervals * frequencySeconds;
    }
    if (previous.state === "active" && definition.onset === null)
      effects = definition.effects.immediate;
    if (definition.cure.consecutive) {
      // Ruling R7: even a failed initial save for an added dose breaks the streak.
      // (A successful exposure returns above and deliberately leaves cure progress alone.)
    }
  }

  const doseEvent: PF1ePoisonDoseEvent = {
    id: input.exposureId,
    source: source.value,
    route: input.route,
    timestamp: input.exposedAt,
    resolvedAt,
    doseCount: input.doseCount,
    initialSaveDC: dc,
    initialSavePassed: false,
    ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
  };
  const attempts = previous?.attempts ?? [];
  const cureProgress = previous?.cureProgress !== undefined && definition.cure.consecutive
    ? 0
    : previous?.cureProgress ?? 0;
  const course: PF1ePoisonCourse = {
    id: courseId,
    targetId: input.targetId,
    definitionIdentity: identity,
    definition,
    state,
    doseCount,
    firstExposedAt: previous?.firstExposedAt ?? input.exposedAt,
    startedAt: previous?.startedAt ?? resolvedAt,
    onsetDueAt,
    nextAttemptAt,
    frequencyEndAt,
    attemptsScheduled,
    attemptsResolved: previous?.attemptsResolved ?? 0,
    cureProgress,
    doseEvents: [...previous?.doseEvents ?? [], doseEvent],
    attempts,
    lastResolvedAttemptId: previous?.lastResolvedAttemptId ?? null,
    activeEffectIds: previous?.activeEffectIds ?? [],
    effectTotals: previous?.effectTotals ?? {},
    pausedAt: previous?.pausedAt ?? null,
    endedAt,
    endReason,
  };
  return okVal({
    course,
    attempt: makeExposureAttempt(input, dc, "contracted", resolvedAt),
    effects,
    extensionIntervals,
    duplicate: false,
  });
}

/** Resolve an onset boundary; a no-frequency profile emits exactly one one-shot effect. */
export function resolvePF1ePoisonOnset(input: {
  course: PF1ePoisonCourse;
  attemptId: string;
  now: number;
  receiptId?: string;
}): Result<{ course: PF1ePoisonCourse; attempt: PF1ePoisonAttempt; effects: readonly PF1ePoisonEffect[]; duplicate: boolean }> {
  const course = input.course;
  if (!ID_RE.test(input.attemptId) || !isWhole(input.now)) return err("poison onset attempt identity/time is invalid");
  if (course.attempts.some((attempt) => attempt.id === input.attemptId)) {
    const prior = course.attempts.find((attempt) => attempt.id === input.attemptId) as PF1ePoisonAttempt;
    return okVal({ course, attempt: prior, effects: [], duplicate: true });
  }
  if (course.state !== "onset" || course.onsetDueAt === null)
    return err("poison course has no pending onset");
  if (course.pausedAt !== null) return err("poison course is paused by Delay Poison");
  if (input.now < course.onsetDueAt) return err("poison onset is not due yet");

  if (course.definition.frequency !== null) {
    // The frequency save is its own typed attempt. It becomes eligible at the onset boundary.
    return okVal({
      course: { ...course, state: "active" },
      attempt: {
        id: input.attemptId,
        kind: "one-shot",
        index: 0,
        timestamp: input.now,
        dc: null,
        passed: null,
        effectsApplied: false,
        ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
      },
      effects: [],
      duplicate: false,
    });
  }

  const attempt: PF1ePoisonAttempt = {
    id: input.attemptId,
    kind: "one-shot",
    index: 1,
    timestamp: input.now,
    dc: null,
    passed: null,
    effectsApplied: course.definition.effects.oneShot.length > 0,
    ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
  };
  return okVal({
    course: {
      ...course,
      state: "expired",
      nextAttemptAt: null,
      attemptsScheduled: 1,
      attemptsResolved: 1,
      attempts: [...course.attempts, attempt],
      lastResolvedAttemptId: attempt.id,
      endedAt: input.now,
      endReason: "one-shot-complete",
    },
    attempt,
    effects: course.definition.effects.oneShot,
    duplicate: false,
  });
}

/** Resolve exactly one source-scheduled periodic save (one save per active course, never per dose). */
export function resolvePF1ePoisonFrequencySave(input: {
  course: PF1ePoisonCourse;
  attemptId: string;
  now: number;
  passed: boolean;
  receiptId?: string;
}): Result<PF1ePoisonFrequencyResolution> {
  const current = input.course;
  if (!ID_RE.test(input.attemptId) || !isWhole(input.now) || typeof input.passed !== "boolean")
    return err("poison frequency attempt identity, time or result is invalid");
  const duplicate = current.attempts.find((attempt) => attempt.id === input.attemptId);
  if (duplicate) return okVal({ course: current, attempt: duplicate, effects: [], effectIdsToRemove: [], cured: current.state === "cured", expired: current.state === "expired", duplicate: true });
  const definition = current.definition;
  const frequency = definition.frequency;
  if (frequency === null) return err("poison course has no periodic frequency");
  if (current.state !== "active" && current.state !== "onset") return err(`poison course is ${current.state}`);
  if (current.pausedAt !== null) return err("poison course is paused by Delay Poison");
  if (current.nextAttemptAt === null || input.now < current.nextAttemptAt) return err("poison frequency save is not due yet");
  const dc = pf1ePoisonOngoingSaveDc(definition.baseDC, current.doseCount);
  if (dc === null) return err("could not calculate ongoing poison DC");
  const index = current.attemptsResolved + 1;
  const cureProgress = input.passed
    ? current.cureProgress + 1
    : definition.cure.consecutive ? 0 : current.cureProgress;
  const cured = input.passed && cureProgress >= definition.cure.successesRequired;
  const attemptsResolved = current.attemptsResolved + 1;
  const finiteFrequencyEnded = !cured && current.attemptsScheduled !== null && attemptsResolved >= current.attemptsScheduled;
  const intervalSeconds = durationSeconds(frequency.interval);
  const nextAttemptAt = cured || finiteFrequencyEnded ? null : input.now + intervalSeconds;
  const attempt: PF1ePoisonAttempt = {
    id: input.attemptId,
    kind: "frequency",
    index,
    timestamp: input.now,
    dc,
    passed: input.passed,
    effectsApplied: !input.passed && definition.effects.periodic.length > 0,
    ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
  };
  const state: PF1ePoisonCourseState = cured ? "cured" : finiteFrequencyEnded ? "expired" : "active";
  const course: PF1ePoisonCourse = {
    ...current,
    state,
    nextAttemptAt,
    attemptsResolved,
    cureProgress,
    attempts: [...current.attempts, attempt],
    lastResolvedAttemptId: attempt.id,
    activeEffectIds: cured || finiteFrequencyEnded ? [] : current.activeEffectIds,
    endedAt: cured || finiteFrequencyEnded ? input.now : null,
    endReason: cured ? "cured" : finiteFrequencyEnded ? "frequency-ended" : null,
  };
  return okVal({
    course,
    attempt,
    effects: input.passed ? [] : definition.effects.periodic,
    effectIdsToRemove: cured || finiteFrequencyEnded ? current.activeEffectIds : [],
    cured,
    expired: finiteFrequencyEnded,
    duplicate: false,
  });
}

/** Mark host-created source effect IDs on a course, without inventing document identities. */
export function setPF1ePoisonCourseEffects(course: PF1ePoisonCourse, effectIds: readonly string[]): Result<PF1ePoisonCourse> {
  if (effectIds.length > 256 || effectIds.some((id) => typeof id !== "string" || !ID_RE.test(id)))
    return err("poison source-effect IDs are invalid");
  return okVal({ ...course, activeEffectIds: [...new Set(effectIds)] });
}

export function emptyPF1ePoisonTargetState(targetId: string): Result<PF1ePoisonTargetState> {
  if (!ID_RE.test(targetId)) return err("poison target ID is invalid");
  return okVal({ targetId, courses: {}, exposureAttempts: {},
    delayPoison: { active: false, startedAt: null, endsAt: null, source: null, casterLevel: null }, queuedExposures: [] });
}

function activeCourseForDefinition(state: PF1ePoisonTargetState, definition: PF1ePoisonDefinition): PF1ePoisonCourse | null {
  const identity = pf1ePoisonDefinitionIdentity(definition);
  return Object.values(state.courses).find((course) =>
    course.definitionIdentity === identity && activeCourse(course)) ?? null;
}

function validatePoisonDoseEvent(raw: unknown, field: string): Result<PF1ePoisonDoseEvent> {
  if (!isRecord(raw) || Object.keys(raw).some((key) =>
    !["id", "source", "route", "timestamp", "resolvedAt", "doseCount", "initialSaveDC", "initialSavePassed", "receiptId"].includes(key)))
    return err(`${field} is malformed`);
  const source = safeSource(raw.source);
  if (!source.ok) return source;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id) ||
      typeof raw.route !== "string" || !(ROUTES as readonly string[]).includes(raw.route) ||
      !isWhole(raw.timestamp) || !isWhole(raw.resolvedAt) || raw.resolvedAt < raw.timestamp ||
      !isWhole(raw.doseCount, 1, 100_000) || !isWhole(raw.initialSaveDC, 1, 200_099) ||
      raw.initialSavePassed !== false ||
      (raw.receiptId !== undefined && (typeof raw.receiptId !== "string" || !ID_RE.test(raw.receiptId))))
    return err(`${field} has invalid dose, route, time or initial-save facts`);
  if ((raw.route === "injury" || raw.route === "contact") && raw.doseCount !== 1)
    return err(`${field} injury/contact dose count must be one`);
  return okVal({
    id: raw.id,
    source: source.value,
    route: raw.route as PF1ePoisonDeliveryRoute,
    timestamp: raw.timestamp,
    resolvedAt: raw.resolvedAt,
    doseCount: raw.doseCount,
    initialSaveDC: raw.initialSaveDC,
    initialSavePassed: false,
    ...(raw.receiptId !== undefined ? { receiptId: raw.receiptId as string } : {}),
  });
}

function validatePoisonAttempt(raw: unknown, field: string): Result<PF1ePoisonAttempt> {
  if (!isRecord(raw) || Object.keys(raw).some((key) =>
    !["id", "kind", "index", "timestamp", "dc", "passed", "effectsApplied", "receiptId"].includes(key)))
    return err(`${field} is malformed`);
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id) ||
      (raw.kind !== "frequency" && raw.kind !== "one-shot") ||
      !isWhole(raw.index) || !isWhole(raw.timestamp) ||
      (raw.dc !== null && !isWhole(raw.dc, 1, 200_099)) ||
      (raw.passed !== null && typeof raw.passed !== "boolean") ||
      typeof raw.effectsApplied !== "boolean" ||
      (raw.receiptId !== undefined && (typeof raw.receiptId !== "string" || !ID_RE.test(raw.receiptId))))
    return err(`${field} has invalid attempt facts`);
  if (raw.kind === "frequency" && (raw.dc === null || typeof raw.passed !== "boolean" || raw.index < 1))
    return err(`${field} frequency attempts need a DC, result and positive index`);
  if (raw.kind === "one-shot" && (raw.dc !== null || raw.passed !== null))
    return err(`${field} one-shot attempts cannot carry a save DC/result`);
  return okVal({
    id: raw.id,
    kind: raw.kind,
    index: raw.index,
    timestamp: raw.timestamp,
    dc: raw.dc as number | null,
    passed: raw.passed as boolean | null,
    effectsApplied: raw.effectsApplied,
    ...(raw.receiptId !== undefined ? { receiptId: raw.receiptId as string } : {}),
  });
}

/** Validate and canonicalize one persisted target-owned poison course. */
export function validatePF1ePoisonCourse(raw: unknown): Result<PF1ePoisonCourse> {
  const fields = ["id", "targetId", "definitionIdentity", "definition", "state", "doseCount", "firstExposedAt", "startedAt",
    "onsetDueAt", "nextAttemptAt", "frequencyEndAt", "attemptsScheduled", "attemptsResolved", "cureProgress", "doseEvents",
    "attempts", "lastResolvedAttemptId", "activeEffectIds", "effectTotals", "pausedAt", "endedAt", "endReason"];
  if (!isRecord(raw) || Object.keys(raw).some((key) => !fields.includes(key)))
    return err("poison course must be an object with the supported fields");
  const definition = validatePF1ePoisonDefinition(raw.definition);
  if (!definition.ok) return definition;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id) ||
      typeof raw.targetId !== "string" || !ID_RE.test(raw.targetId) ||
      typeof raw.definitionIdentity !== "string" || raw.definitionIdentity !== pf1ePoisonDefinitionIdentity(definition.value) ||
      !["onset", "active", "cured", "expired"].includes(String(raw.state)) ||
      !isWhole(raw.doseCount, 1, 100_000) || !isWhole(raw.firstExposedAt) || !isWhole(raw.startedAt) ||
      (raw.onsetDueAt !== null && !isWhole(raw.onsetDueAt)) ||
      (raw.nextAttemptAt !== null && !isWhole(raw.nextAttemptAt)) ||
      (raw.frequencyEndAt !== null && !isWhole(raw.frequencyEndAt)) ||
      (raw.attemptsScheduled !== null && !isWhole(raw.attemptsScheduled)) ||
      !isWhole(raw.attemptsResolved) || !isWhole(raw.cureProgress) ||
      (raw.lastResolvedAttemptId !== null && (typeof raw.lastResolvedAttemptId !== "string" || !ID_RE.test(raw.lastResolvedAttemptId))) ||
      !Array.isArray(raw.doseEvents) || raw.doseEvents.length < 1 || raw.doseEvents.length > 10_000 ||
      !Array.isArray(raw.attempts) || raw.attempts.length > 10_000 ||
      !Array.isArray(raw.activeEffectIds) || raw.activeEffectIds.length > 256 ||
      raw.activeEffectIds.some((id) => typeof id !== "string" || !ID_RE.test(id)) ||
      new Set(raw.activeEffectIds as string[]).size !== raw.activeEffectIds.length ||
      !isRecord(raw.effectTotals) || Object.keys(raw.effectTotals).length > 256 ||
      Object.entries(raw.effectTotals).some(([key, value]) => !ID_RE.test(key) || !isWhole(value, 0, 100_000_000)) ||
      (raw.pausedAt !== null && !isWhole(raw.pausedAt)) ||
      (raw.endedAt !== null && !isWhole(raw.endedAt)) ||
      ![null, "cured", "neutralized", "frequency-ended", "one-shot-complete"].includes(raw.endReason as string | null))
    return err("poison course has invalid identity, state counters, schedule or provenance arrays");

  const doseEvents: PF1ePoisonDoseEvent[] = [];
  for (const [index, event] of raw.doseEvents.entries()) {
    const checked = validatePoisonDoseEvent(event, `poison course doseEvents[${index}]`);
    if (!checked.ok) return checked;
    doseEvents.push(checked.value);
  }
  if (new Set(doseEvents.map((event) => event.id)).size !== doseEvents.length ||
      doseEvents.reduce((sum, event) => sum + event.doseCount, 0) !== raw.doseCount)
    return err("poison course dose events must be unique and sum to its dose count");

  const attempts: PF1ePoisonAttempt[] = [];
  for (const [index, attempt] of raw.attempts.entries()) {
    const checked = validatePoisonAttempt(attempt, `poison course attempts[${index}]`);
    if (!checked.ok) return checked;
    attempts.push(checked.value);
  }
  if (new Set(attempts.map((attempt) => attempt.id)).size !== attempts.length ||
      (raw.lastResolvedAttemptId !== null && attempts.at(-1)?.id !== raw.lastResolvedAttemptId) ||
      (raw.lastResolvedAttemptId === null && attempts.length > 0))
    return err("poison course attempt identities/last attempt do not match");

  const state = raw.state as PF1ePoisonCourseState;
  const definitionFrequency = definition.value.frequency;
  const attemptsScheduled = raw.attemptsScheduled as number | null;
  const ended = state === "cured" || state === "expired";
  if (raw.cureProgress > definition.value.cure.successesRequired ||
      raw.attemptsResolved > attempts.length ||
      (attemptsScheduled !== null && raw.attemptsResolved > attemptsScheduled) ||
      (definitionFrequency !== null && definitionFrequency.intervals !== null &&
        (attemptsScheduled === null || attemptsScheduled < definitionFrequency.intervals)) ||
      (definitionFrequency !== null && definitionFrequency.intervals === null && attemptsScheduled !== null) ||
      (state === "onset" && (definition.value.onset === null || raw.onsetDueAt === null)) ||
      (state === "active" && (definitionFrequency === null || raw.nextAttemptAt === null)) ||
      (ended && (raw.nextAttemptAt !== null || raw.endedAt === null || raw.endReason === null || raw.pausedAt !== null)) ||
      (!ended && (raw.endedAt !== null || raw.endReason !== null)) ||
      ((raw.pausedAt !== null) && state !== "active" && state !== "onset"))
    return err("poison course state is inconsistent with its cure/frequency schedule");

  if (state === "cured" && raw.endReason !== "cured" && raw.endReason !== "neutralized")
    return err("cured poison course needs a cure/neutralize end reason");
  if (state === "expired" && raw.endReason !== "frequency-ended" && raw.endReason !== "one-shot-complete")
    return err("expired poison course needs a finite-frequency/one-shot end reason");
  if (definitionFrequency === null && state === "active")
    return err("a no-frequency poison cannot retain an active course");

  return okVal({
    id: raw.id,
    targetId: raw.targetId,
    definitionIdentity: raw.definitionIdentity,
    definition: definition.value,
    state,
    doseCount: raw.doseCount,
    firstExposedAt: raw.firstExposedAt,
    startedAt: raw.startedAt,
    onsetDueAt: raw.onsetDueAt as number | null,
    nextAttemptAt: raw.nextAttemptAt as number | null,
    frequencyEndAt: raw.frequencyEndAt as number | null,
    attemptsScheduled,
    attemptsResolved: raw.attemptsResolved,
    cureProgress: raw.cureProgress,
    doseEvents,
    attempts,
    lastResolvedAttemptId: raw.lastResolvedAttemptId as string | null,
    activeEffectIds: [...raw.activeEffectIds as string[]],
    effectTotals: { ...raw.effectTotals as Record<string, number> },
    pausedAt: raw.pausedAt as number | null,
    endedAt: raw.endedAt as number | null,
    endReason: raw.endReason as PF1ePoisonCourse["endReason"],
  });
}

function validateQueuedExposure(input: PF1eQueuedPoisonExposure, targetId: string): Result<PF1eQueuedPoisonExposure> {
  const definition = validatePF1ePoisonDefinition(input.definition);
  if (!definition.ok) return definition;
  const source = safeSource(input.source);
  if (!source.ok) return source;
  if (input.targetId !== targetId || !ID_RE.test(input.exposureId) ||
      (input.newCourseId !== undefined && !ID_RE.test(input.newCourseId)) ||
      !isWhole(input.doseCount, 1, 100_000) || !isWhole(input.exposedAt) ||
      !(definition.value.delivery as readonly string[]).includes(input.route) ||
      ((input.route === "injury" || input.route === "contact") && input.doseCount !== 1))
    return err("queued poison exposure is malformed");
  return okVal({
    targetId: input.targetId,
    definition: definition.value,
    ...(input.newCourseId !== undefined ? { newCourseId: input.newCourseId } : {}),
    exposureId: input.exposureId,
    route: input.route,
    doseCount: input.doseCount,
    exposedAt: input.exposedAt,
    source: source.value,
    ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
  });
}

function validatePoisonExposureAttempt(raw: unknown, key: string): Result<PF1ePoisonExposureAttempt> {
  if (!isRecord(raw) || Object.keys(raw).some((field) =>
    !["id", "definitionIdentity", "source", "route", "timestamp", "resolvedAt", "doseCount", "dc", "passed", "outcome", "receiptId"].includes(field)))
    return err(`poison exposure attempt ${key} is malformed`);
  const source = safeSource(raw.source);
  if (!source.ok) return source;
  const outcome = raw.outcome;
  if (typeof raw.id !== "string" || raw.id !== key || !ID_RE.test(raw.id) ||
      typeof raw.definitionIdentity !== "string" || !isText(raw.definitionIdentity, 10_000) ||
      typeof raw.route !== "string" || !(ROUTES as readonly string[]).includes(raw.route) ||
      !isWhole(raw.timestamp) || !isWhole(raw.resolvedAt) || raw.resolvedAt < raw.timestamp ||
      !isWhole(raw.doseCount, 1, 100_000) ||
      (raw.dc !== null && !isWhole(raw.dc, 1, 200_099)) ||
      (raw.passed !== null && typeof raw.passed !== "boolean") ||
      !["resisted", "contracted", "immune"].includes(String(outcome)) ||
      (raw.receiptId !== undefined && (typeof raw.receiptId !== "string" || !ID_RE.test(raw.receiptId))))
    return err(`poison exposure attempt ${key} has invalid outcome or source facts`);
  if ((raw.route === "injury" || raw.route === "contact") && raw.doseCount !== 1)
    return err(`poison exposure attempt ${key} injury/contact dose count must be one`);
  if ((outcome === "resisted" && (raw.dc === null || raw.passed !== true)) ||
      (outcome === "contracted" && (raw.dc === null || raw.passed !== false)) ||
      (outcome === "immune" && (raw.dc !== null || raw.passed !== null)))
    return err(`poison exposure attempt ${key} has contradictory save facts`);
  return okVal({
    id: raw.id,
    definitionIdentity: raw.definitionIdentity,
    source: source.value,
    route: raw.route as PF1ePoisonDeliveryRoute,
    timestamp: raw.timestamp,
    resolvedAt: raw.resolvedAt,
    doseCount: raw.doseCount,
    dc: raw.dc as number | null,
    passed: raw.passed as boolean | null,
    outcome: outcome as PF1ePoisonExposureAttempt["outcome"],
    ...(raw.receiptId !== undefined ? { receiptId: raw.receiptId as string } : {}),
  });
}

/** Validate and canonicalize the target-owned persisted poison collection. */
export function validatePF1ePoisonTargetState(raw: unknown, expectedTargetId?: string): Result<PF1ePoisonTargetState> {
  if (!isRecord(raw) || Object.keys(raw).some((key) =>
    !["targetId", "courses", "exposureAttempts", "delayPoison", "queuedExposures"].includes(key)))
    return err("system.pf1e.afflictions must be a target-owned poison-state object");
  if (typeof raw.targetId !== "string" || !ID_RE.test(raw.targetId) ||
      (expectedTargetId !== undefined && raw.targetId !== expectedTargetId) ||
      !isRecord(raw.courses) || Object.keys(raw.courses).length > 512 ||
      !isRecord(raw.exposureAttempts) || Object.keys(raw.exposureAttempts).length > 10_000 ||
      !isRecord(raw.delayPoison) || !Array.isArray(raw.queuedExposures) || raw.queuedExposures.length > 256)
    return err("poison target state has an invalid target ID, course map, delay state or bounded event collection");
  const delay = raw.delayPoison;
  if (Object.keys(delay).some((key) => !["active", "startedAt", "endsAt", "source", "casterLevel"].includes(key)) ||
      typeof delay.active !== "boolean" ||
      (delay.startedAt !== null && !isWhole(delay.startedAt)) ||
      (delay.endsAt !== null && !isWhole(delay.endsAt)) ||
      (delay.casterLevel !== null && !isWhole(delay.casterLevel, 1, 100_000)) ||
      (delay.active !== (delay.startedAt !== null)) ||
      (delay.active && delay.endsAt !== null && delay.endsAt <= (delay.startedAt as number)) ||
      (!delay.active && (delay.endsAt !== null || delay.source !== null || delay.casterLevel !== null)))
    return err("Delay Poison duration/caster state is malformed");
  let delaySource: PF1ePoisonExposureSource | null = null;
  if (delay.source !== null) {
    const checkedSource = safeSource(delay.source);
    if (!checkedSource.ok) return err(`Delay Poison source: ${checkedSource.error}`);
    delaySource = checkedSource.value;
  }
  if ((delay.casterLevel !== null) !== (delay.source !== null))
    return err("Delay Poison caster level and source must be recorded together");

  const courses: Record<string, PF1ePoisonCourse> = {};
  const activeIdentities = new Set<string>();
  for (const [id, rawCourse] of Object.entries(raw.courses)) {
    if (!ID_RE.test(id)) return err(`poison course key ${id} is invalid`);
    const course = validatePF1ePoisonCourse(rawCourse);
    if (!course.ok) return err(`afflictions.courses.${id}: ${course.error}`);
    if (course.value.id !== id || course.value.targetId !== raw.targetId)
      return err(`afflictions.courses.${id}: course ID or target does not match its map`);
    if (activeCourse(course.value)) {
      if (activeIdentities.has(course.value.definitionIdentity))
        return err(`afflictions contains more than one active course for ${course.value.definition.name}`);
      activeIdentities.add(course.value.definitionIdentity);
      if (raw.delayPoison.active !== (course.value.pausedAt !== null))
        return err(`afflictions.courses.${id}: active course pause state does not match Delay Poison`);
    } else if (course.value.pausedAt !== null) {
      return err(`afflictions.courses.${id}: ended course cannot remain paused`);
    }
    courses[id] = course.value;
  }

  const exposureAttempts: Record<string, PF1ePoisonExposureAttempt> = {};
  for (const [id, rawAttempt] of Object.entries(raw.exposureAttempts)) {
    if (!ID_RE.test(id)) return err(`poison exposure-attempt key ${id} is invalid`);
    const attempt = validatePoisonExposureAttempt(rawAttempt, id);
    if (!attempt.ok) return attempt;
    exposureAttempts[id] = attempt.value;
  }

  const queuedExposures: PF1eQueuedPoisonExposure[] = [];
  for (const [index, rawExposure] of raw.queuedExposures.entries()) {
    if (!isRecord(rawExposure) || Object.keys(rawExposure).some((key) =>
      !["targetId", "definition", "newCourseId", "exposureId", "route", "doseCount", "exposedAt", "source", "receiptId"].includes(key)))
      return err(`poison queuedExposures[${index}] is malformed`);
    const exposure = validateQueuedExposure(rawExposure as unknown as PF1eQueuedPoisonExposure, raw.targetId);
    if (!exposure.ok) return err(`poison queuedExposures[${index}]: ${exposure.error}`);
    if (Object.hasOwn(exposureAttempts, exposure.value.exposureId) ||
        Object.values(courses).some((course) => course.doseEvents.some((event) => event.id === exposure.value.exposureId)))
      return err(`poison queued exposure ${exposure.value.exposureId} was already resolved`);
    queuedExposures.push(exposure.value);
  }
  if (new Set(queuedExposures.map((exposure) => exposure.exposureId)).size !== queuedExposures.length)
    return err("queued poison exposure IDs must be unique");
  queuedExposures.sort(compareQueuedExposures);

  return okVal({
    targetId: raw.targetId,
    courses,
    exposureAttempts,
    delayPoison: {
      active: delay.active,
      startedAt: delay.startedAt as number | null,
      endsAt: delay.endsAt as number | null,
      source: delaySource,
      casterLevel: delay.casterLevel as number | null,
    },
    queuedExposures,
  });
}

/**
 * Apply an exposure to a target state. During Delay Poison it queues only the exposure facts; the
 * host obtains and resolves one initial save at a time when the delay ends.
 */
export function applyPF1ePoisonExposureToTarget(input: {
  state: PF1ePoisonTargetState;
  exposure: PF1eQueuedPoisonExposure;
  savePassed?: boolean;
  resolvedAt?: number;
  immune?: boolean;
}): Result<PF1ePoisonTargetExposureResolution> {
  const state = input.state;
  const exposure = validateQueuedExposure(input.exposure, state.targetId);
  if (!exposure.ok) return exposure;
  const priorAttempt = state.exposureAttempts[exposure.value.exposureId];
  if (priorAttempt) {
    return okVal({
      state,
      resolution: {
        course: activeCourseForDefinition(state, exposure.value.definition),
        attempt: priorAttempt,
        effects: [],
        extensionIntervals: 0,
        duplicate: true,
      },
      queued: false,
    });
  }
  if (state.queuedExposures.some((queued) => queued.exposureId === exposure.value.exposureId))
    return okVal({ state, resolution: null, queued: true });
  if (input.immune === true) {
    const immuneAttempt = makeExposureAttempt({
      ...exposure.value,
      savePassed: false,
      immune: true,
      ...(input.resolvedAt !== undefined ? { resolvedAt: input.resolvedAt } : {}),
    }, null, "immune", input.resolvedAt ?? exposure.value.exposedAt);
    return okVal({
      state: { ...state, exposureAttempts: { ...state.exposureAttempts, [immuneAttempt.id]: immuneAttempt } },
      resolution: {
        course: activeCourseForDefinition(state, exposure.value.definition),
        attempt: immuneAttempt,
        effects: [],
        extensionIntervals: 0,
        duplicate: false,
      },
      queued: false,
    });
  }
  if (state.delayPoison.active) {
    if (state.delayPoison.endsAt !== null &&
        (input.resolvedAt ?? exposure.value.exposedAt) >= state.delayPoison.endsAt)
      return err("Delay Poison duration ended; resolve its queued exposures before adding another");
    return okVal({
      state: { ...state, queuedExposures: [...state.queuedExposures, exposure.value].sort(compareQueuedExposures) },
      resolution: null,
      queued: true,
    });
  }
  if (input.savePassed === undefined) return err("poison exposure needs a host-resolved save result");
  const existing = activeCourseForDefinition(state, exposure.value.definition);
  const resolved = applyPF1ePoisonExposure({
    ...exposure.value,
    savePassed: input.savePassed,
    ...(input.resolvedAt !== undefined ? { resolvedAt: input.resolvedAt } : {}),
    ...(input.immune !== undefined ? { immune: input.immune } : {}),
  }, existing);
  if (!resolved.ok) return resolved;
  const courses = { ...state.courses };
  if (resolved.value.course !== null) courses[resolved.value.course.id] = resolved.value.course;
  return okVal({
    state: {
      ...state,
      courses,
      exposureAttempts: { ...state.exposureAttempts, [resolved.value.attempt.id]: resolved.value.attempt },
    },
    resolution: resolved.value,
    queued: false,
  });
}

function compareQueuedExposures(a: PF1eQueuedPoisonExposure, b: PF1eQueuedPoisonExposure): number {
  return a.exposedAt - b.exposedAt || a.exposureId.localeCompare(b.exposureId);
}

/** Pause every active poison course without accumulating missed frequency saves. */
export function activatePF1eDelayPoison(
  state: PF1ePoisonTargetState,
  now: number,
  options?: { durationSeconds?: number; source?: PF1ePoisonExposureSource; casterLevel?: number },
): Result<PF1ePoisonTargetState> {
  if (!isWhole(now)) return err("Delay Poison start time must be non-negative whole seconds");
  if (state.delayPoison.active) return okVal(state);
  let source: PF1ePoisonExposureSource | null = null;
  if (options?.source !== undefined) {
    const checked = safeSource(options.source);
    if (!checked.ok) return checked;
    source = checked.value;
  }
  if ((options?.durationSeconds === undefined) !== (options?.casterLevel === undefined) ||
      (options?.durationSeconds !== undefined && !isWhole(options.durationSeconds, 1)) ||
      (options?.casterLevel !== undefined && !isWhole(options.casterLevel, 1, 100_000)) ||
      ((options?.durationSeconds !== undefined) !== (source !== null)))
    return err("Delay Poison duration must be tied to a validated caster source and caster level");
  const endsAt = options?.durationSeconds === undefined ? null : now + options.durationSeconds;
  if (endsAt !== null && !Number.isSafeInteger(endsAt)) return err("Delay Poison end time exceeds the safe clock range");
  const courses: Record<string, PF1ePoisonCourse> = { ...state.courses };
  for (const [id, course] of Object.entries(courses)) {
    if (activeCourse(course) && course.pausedAt === null) courses[id] = { ...course, pausedAt: now };
  }
  return okVal({ ...state, courses, delayPoison: {
    active: true,
    startedAt: now,
    endsAt,
    source,
    casterLevel: options?.casterLevel ?? null,
  } });
}

/** The next queued exposure is host-resolved first; its DC reflects earlier queued outcomes. */
export function nextPF1eQueuedPoisonExposure(state: PF1ePoisonTargetState): Result<{
  exposure: PF1eQueuedPoisonExposure;
  dc: number;
} | null> {
  if (state.delayPoison.active) return err("queued poison exposures cannot resolve until Delay Poison ends");
  const exposure = [...state.queuedExposures].sort(compareQueuedExposures)[0];
  if (!exposure) return okVal(null);
  const existing = activeCourseForDefinition(state, exposure.definition);
  const dc = pf1ePoisonExposureSaveDc(exposure.definition.baseDC, existing?.doseCount ?? 0, exposure.doseCount);
  if (dc === null) return err("could not calculate queued poison exposure DC");
  return okVal({ exposure, dc });
}

/**
 * End Delay Poison, shift saved due boundaries by the paused duration (no catch-up saves), and leave
 * queued exposure intents ordered for host resolution one by one.
 */
export function endPF1eDelayPoison(state: PF1ePoisonTargetState, now: number): Result<PF1ePoisonTargetState> {
  if (!isWhole(now)) return err("Delay Poison end time must be non-negative whole seconds");
  if (!state.delayPoison.active || state.delayPoison.startedAt === null)
    return err("Delay Poison is not active");
  if (now < state.delayPoison.startedAt) return err("Delay Poison cannot end before it starts");
  if (state.delayPoison.endsAt !== null && now < state.delayPoison.endsAt)
    return err("Delay Poison duration has not elapsed");
  const courses: Record<string, PF1ePoisonCourse> = { ...state.courses };
  for (const [id, course] of Object.entries(courses)) {
    if (course.pausedAt === null) continue;
    const elapsed = now - course.pausedAt;
    courses[id] = {
      ...course,
      onsetDueAt: course.onsetDueAt === null ? null : course.onsetDueAt + elapsed,
      nextAttemptAt: course.nextAttemptAt === null ? null : course.nextAttemptAt + elapsed,
      frequencyEndAt: course.frequencyEndAt === null ? null : course.frequencyEndAt + elapsed,
      pausedAt: null,
    };
  }
  return okVal({ ...state, courses, delayPoison: {
    active: false, startedAt: null, endsAt: null, source: null, casterLevel: null,
  } });
}

/** Resolve the first queued exposure only; a later save DC is recomputed from the updated state. */
export function resolveNextPF1eQueuedPoisonExposure(input: {
  state: PF1ePoisonTargetState;
  exposureId: string;
  savePassed: boolean;
  now: number;
  immune?: boolean;
}): Result<PF1ePoisonTargetExposureResolution> {
  if (input.state.delayPoison.active) return err("Delay Poison is still active");
  const first = [...input.state.queuedExposures].sort(compareQueuedExposures)[0];
  if (!first || first.exposureId !== input.exposureId)
    return err("queued poison exposures must resolve once, in timestamp order");
  const remaining = input.state.queuedExposures.filter((queued) => queued.exposureId !== input.exposureId);
  const staged: PF1ePoisonTargetState = { ...input.state, queuedExposures: remaining };
  const result = applyPF1ePoisonExposureToTarget({
    state: staged,
    exposure: first,
    savePassed: input.savePassed,
    resolvedAt: input.now,
    ...(input.immune !== undefined ? { immune: input.immune } : {}),
  });
  return result;
}

/** A source-validated cure/neutralize operation ends one exact course and never heals prior damage. */
export function neutralizePF1ePoisonCourse(input: {
  state: PF1ePoisonTargetState;
  courseId: string;
  now: number;
  attemptId: string;
  receiptId?: string;
}): Result<{ state: PF1ePoisonTargetState; course: PF1ePoisonCourse; effectIdsToRemove: readonly string[]; duplicate: boolean }> {
  if (!ID_RE.test(input.courseId) || !ID_RE.test(input.attemptId) || !isWhole(input.now))
    return err("neutralize poison course/attempt identity or time is invalid");
  const current = input.state.courses[input.courseId];
  if (!current) return err("poison course does not exist");
  const prior = current.attempts.find((attempt) => attempt.id === input.attemptId);
  if (prior) return okVal({ state: input.state, course: current, effectIdsToRemove: [], duplicate: true });
  if (!activeCourse(current)) return err(`poison course is already ${current.state}`);
  const attempt: PF1ePoisonAttempt = {
    id: input.attemptId,
    kind: "one-shot",
    index: current.attemptsResolved + 1,
    timestamp: input.now,
    dc: null,
    passed: null,
    effectsApplied: false,
    ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
  };
  const course: PF1ePoisonCourse = {
    ...current,
    state: "cured",
    nextAttemptAt: null,
    attempts: [...current.attempts, attempt],
    lastResolvedAttemptId: attempt.id,
    activeEffectIds: [],
    pausedAt: null,
    endedAt: input.now,
    endReason: "neutralized",
  };
  return okVal({
    state: { ...input.state, courses: { ...input.state.courses, [course.id]: course } },
    course,
    effectIdsToRemove: current.activeEffectIds,
    duplicate: false,
  });
}

/** Install host-assigned course state without sharing doses/cure/schedule across definitions. */
export function upsertPF1ePoisonCourse(
  state: PF1ePoisonTargetState,
  course: PF1ePoisonCourse,
): Result<PF1ePoisonTargetState> {
  if (course.targetId !== state.targetId || !ID_RE.test(course.id) ||
      course.definitionIdentity !== pf1ePoisonDefinitionIdentity(course.definition))
    return err("poison course identity does not match its target or immutable definition");
  const collision = state.courses[course.id];
  if (collision && collision.definitionIdentity !== course.definitionIdentity)
    return err("poison course ID cannot be reused for a different definition");
  return okVal({ ...state, courses: { ...state.courses, [course.id]: course } });
}

/**
 * The Core PF1e poison catalogue: immutable profiles validated at load. The rows are source data in
 * `poisonCatalogue.ts`, mirroring the shipped `systems/pf1e-core/packs/poisons.json` content pack
 * (no source file loads pack data at runtime — M18). A malformed or duplicated row is reported in
 * {@link PF1E_POISON_CATALOGUE_ERRORS} and excluded from the catalogue, so the host refuses an
 * exposure it cannot verify rather than running on a half-valid profile.
 */
const PF1E_POISON_ROWS: unknown = PF1E_POISON_CATALOGUE;

interface PF1ePoisonPackLoad {
  readonly definitions: readonly PF1ePoisonDefinition[];
  readonly errors: readonly string[];
}

function loadPF1ePoisonCatalogue(rows: unknown): PF1ePoisonPackLoad {
  if (!Array.isArray(rows)) return { definitions: [], errors: ["poison catalogue: rows must be an array"] };
  const entries = rows;
  const definitions: PF1ePoisonDefinition[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const checked = validatePF1ePoisonDefinition(entry);
    if (!checked.ok) {
      errors.push(`poison catalogue[${index}]: ${checked.error}`);
      return;
    }
    if (seen.has(checked.value.id)) {
      errors.push(`poison catalogue[${index}]: duplicate poison id ${checked.value.id}`);
      return;
    }
    seen.add(checked.value.id);
    definitions.push(checked.value);
  });
  return { definitions, errors };
}

const POISON_CATALOGUE_LOAD = loadPF1ePoisonCatalogue(PF1E_POISON_ROWS);

/** Catalogue rows that failed validation (empty is the only acceptable value in tests). */
export const PF1E_POISON_CATALOGUE_ERRORS: readonly string[] = POISON_CATALOGUE_LOAD.errors;

/**
 * Source fixtures required by the plan. These are Core PF1e profiles, not Unchained tracks. The
 * Greenblood data follows Paizo's poison FAQ; Giant Octopus and Wyvern follow their Bestiary entries.
 */
export const PF1E_POISON_FIXTURES: readonly PF1ePoisonDefinition[] = POISON_CATALOGUE_LOAD.definitions;

/** Exact-profile lookup by pack id (optionally a pinned version); null when the pack lacks it. */
export function pf1ePoisonDefinitionById(id: string, version?: number): PF1ePoisonDefinition | null {
  return PF1E_POISON_FIXTURES.find((definition) =>
    definition.id === id && (version === undefined || definition.version === version)) ?? null;
}

/** Fail closed if a fixture drifts from the validated immutable profile contract. */
export function validatePoisonFixtures(): readonly string[] {
  return [...PF1E_POISON_CATALOGUE_ERRORS, ...PF1E_POISON_FIXTURES.flatMap((fixture) => {
    const result = validatePF1ePoisonDefinition(fixture);
    return result.ok ? [] : [`${fixture.id}: ${result.error}`];
  })];
}
