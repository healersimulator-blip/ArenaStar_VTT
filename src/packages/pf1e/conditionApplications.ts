/**
 * PF1e condition applications — source-addressable condition state and the compatibility
 * boundary for legacy `system.pf1e.conditions: string[]` data.
 *
 * A condition name is not an instance. Applications are stored by stable ID, so removing a
 * grapple or an effect from one source does not erase the same condition supplied by another.
 * Legacy strings are normalized for reads only; no migration write is performed here.
 */
import type { ActorDocument, Json } from "../../core/documents";
import type { Op } from "../../core/ops";
import { err, okVal, type Result } from "../../core/result";
import type { PF1eActiveEffect } from "./effects";
import { pf1eConditionDef } from "./conditions";

export const MAX_PF1E_CONDITION_APPLICATIONS = 256;

export type PF1eConditionSourceKind =
  | "manual"
  | "maneuver"
  | "health"
  | "spell"
  | "poison"
  | "item"
  | "other"
  | "legacy";

export interface PF1eConditionSource {
  kind: PF1eConditionSourceKind;
  /** Stable source document/action identifier, when one exists. */
  id?: string;
  /** Host-created action receipt/card identity. */
  actionId?: string;
  actorId?: string;
  itemId?: string;
  abilityId?: string;
  /** Relationship identity (for example, the grapple that supplied this application). */
  relationshipId?: string;
  /** Optional group identity for a single effect with multiple targets/instances. */
  groupId?: string;
}

export type PF1eConditionRemovalPolicy =
  | { kind: "permanent" }
  | { kind: "manual"; reason?: string }
  | { kind: "event"; event: string }
  | {
      kind: "expiry";
      value: number;
      unit: "round" | "minute" | "hour" | "day";
      boundary: "round-start" | "own-turn-start" | "world-clock";
      appliedAt: number;
      expiresAt: number;
    };

/** Persisted in `actor.system.pf1e.conditionApplications[applicationId]`. */
export interface PF1eConditionApplication {
  id: string;
  /** Exact canonical key from `PF1E_CONDITIONS`, e.g. `"Grappled"`. */
  condition: string;
  source: PF1eConditionSource;
  removal: PF1eConditionRemovalPolicy;
}

export interface PF1eConditionApplicationView {
  id: string;
  condition: string;
  source: PF1eConditionSource | null;
  removal: PF1eConditionRemovalPolicy;
  legacy: boolean;
  supported: boolean;
}

export interface PF1eConditionReadout {
  /** Supported persisted and legacy applications; duplicate names remain separate instances. */
  applications: PF1eConditionApplicationView[];
  /** Names to display, including unsupported legacy labels. */
  names: string[];
  /** Unknown legacy labels are preserved and reported rather than given invented mechanics. */
  issues: string[];
}

const SOURCE_KINDS: readonly PF1eConditionSourceKind[] = [
  "manual", "maneuver", "health", "spell", "poison", "item", "other", "legacy",
];
const CONDITION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SOURCE_TEXT = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = MAX_SOURCE_TEXT): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

function readSource(raw: unknown): Result<PF1eConditionSource> {
  if (!isRecord(raw)) return err("condition application source must be an object");
  const allowed = ["kind", "id", "actionId", "actorId", "itemId", "abilityId", "relationshipId", "groupId"];
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    return err("condition application source has an unknown field");
  if (typeof raw.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(raw.kind))
    return err("condition application source.kind is unsupported");
  const out: PF1eConditionSource = { kind: raw.kind as PF1eConditionSourceKind };
  for (const key of ["id", "actionId", "actorId", "itemId", "abilityId", "relationshipId", "groupId"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isText(value)) return err(`condition application source.${key} must be non-empty text of at most ${MAX_SOURCE_TEXT} characters`);
    out[key] = value;
  }
  return okVal(out);
}

function readRemoval(raw: unknown): Result<PF1eConditionRemovalPolicy> {
  if (!isRecord(raw) || typeof raw.kind !== "string")
    return err("condition application removal must have a kind");
  switch (raw.kind) {
    case "permanent":
      return Object.keys(raw).length === 1
        ? okVal({ kind: "permanent" })
        : err("permanent condition removal has no extra fields");
    case "manual":
      if (Object.keys(raw).some((key) => !["kind", "reason"].includes(key)))
        return err("manual condition removal has an unknown field");
      if (raw.reason !== undefined && !isText(raw.reason, 240))
        return err("condition application removal.reason must be text of at most 240 characters");
      return okVal({ kind: "manual", ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}) });
    case "event":
      if (Object.keys(raw).some((key) => !["kind", "event"].includes(key)) || !isText(raw.event, 120))
        return err("event condition removal needs a non-empty event name");
      return okVal({ kind: "event", event: raw.event });
    case "expiry":
      // D7: the wire shape is fully specified (`value`/`unit`/`boundary`/`appliedAt`/`expiresAt`),
      // but no host sweep consumes it yet. Accepting it would store "expires in 1 minute" on an
      // application that then never expires — a silent lie — so the writer is refused by name until
      // Phase 4 lands the sweep that reads it.
      return err("condition removal kind \"expiry\" has no host sweep yet; Phase 4 will accept it");
    default:
      return err(`condition removal kind "${raw.kind}" is unsupported`);
  }
}

/** Validate and canonicalize one persisted application. */
export function readPF1eConditionApplication(raw: unknown): Result<PF1eConditionApplication> {
  if (!isRecord(raw)) return err("condition application must be an object");
  if (Object.keys(raw).some((key) => !["id", "condition", "source", "removal"].includes(key)))
    return err("condition application has an unknown field");
  if (typeof raw.id !== "string" || !CONDITION_ID_RE.test(raw.id))
    return err("condition application id must be 1–128 letters, digits, underscores or hyphens");
  if (typeof raw.condition !== "string" || raw.condition.trim() === "" || raw.condition.length > 80)
    return err("condition application condition must be non-empty text of at most 80 characters");
  const def = pf1eConditionDef(raw.condition);
  if (!def) return err(`condition application condition "${raw.condition}" is unsupported`);
  const source = readSource(raw.source);
  if (!source.ok) return source;
  const removal = readRemoval(raw.removal);
  if (!removal.ok) return removal;
  return okVal({ id: raw.id, condition: def.name, source: source.value, removal: removal.value });
}

/** Schema check used by PF1e actor parsing and the host's generic-op guard. */
export function validatePF1eConditionApplications(raw: unknown): Result<Record<string, PF1eConditionApplication>> {
  if (raw === undefined) return okVal({});
  if (!isRecord(raw)) return err("system.pf1e.conditionApplications must be an id-keyed object");
  const entries = Object.entries(raw);
  if (entries.length > MAX_PF1E_CONDITION_APPLICATIONS)
    return err(`system.pf1e.conditionApplications supports at most ${MAX_PF1E_CONDITION_APPLICATIONS} active entries`);
  const out: Record<string, PF1eConditionApplication> = {};
  for (const [id, rawApplication] of entries) {
    if (!CONDITION_ID_RE.test(id))
      return err(`condition application key "${id}" is not a safe application ID`);
    const app = readPF1eConditionApplication(rawApplication);
    if (!app.ok) return err(`conditionApplications.${id}: ${app.error}`);
    if (app.value.id !== id)
      return err(`conditionApplications.${id}: map key must equal application.id`);
    out[id] = app.value;
  }
  return okVal(out);
}

/** Stable, collision-resistant ID for a client proposal; the host still validates its source. */
export function pf1eConditionApplicationId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID) return `ca-${cryptoApi.randomUUID()}`;
  return `ca-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function pf1eBlock(system: unknown): Record<string, unknown> {
  if (!isRecord(system)) return {};
  // Callers may pass either an ActorDocument.system root or the `system.pf1e` block itself.
  return isRecord(system.pf1e) ? system.pf1e : system;
}

/** Read persisted applications and synthesize permanent source-unknown views for legacy strings. */
export function readPF1eConditionApplications(system: unknown): PF1eConditionReadout {
  const block = pf1eBlock(system);
  const applications: PF1eConditionApplicationView[] = [];
  const names: string[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  const addName = (name: string): void => {
    const key = name.trim().toLocaleLowerCase("en-US");
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  const map = validatePF1eConditionApplications(block.conditionApplications);
  if (!map.ok) {
    issues.push(map.error);
  } else {
    for (const app of Object.values(map.value)) {
      applications.push({
        id: app.id,
        condition: app.condition,
        source: app.source,
        removal: app.removal,
        legacy: false,
        supported: true,
      });
      addName(app.condition);
    }
  }

  const legacy = block.conditions;
  if (legacy !== undefined && legacy !== null && !Array.isArray(legacy)) {
    issues.push("system.pf1e.conditions: legacy condition names must be an array of strings");
  } else if (Array.isArray(legacy)) {
    legacy.forEach((rawName, index) => {
      if (typeof rawName !== "string" || rawName.trim() === "") {
        issues.push(`system.pf1e.conditions[${index}]: expected a non-empty condition name`);
        return;
      }
      const def = pf1eConditionDef(rawName);
      if (def) {
        applications.push({
          id: `legacy-${index}`,
          condition: def.name,
          source: null,
          removal: { kind: "permanent" },
          legacy: true,
          supported: true,
        });
        addName(def.name);
      } else {
        applications.push({
          id: `legacy-${index}`,
          condition: rawName,
          source: null,
          removal: { kind: "permanent" },
          legacy: true,
          supported: false,
        });
        addName(rawName);
        issues.push(`legacy condition "${rawName}" has no supported PF1e mechanics; its label is preserved`);
      }
    });
  }
  return { applications, names, issues };
}

function conditionNameSet(applications: readonly PF1eConditionApplicationView[], effects: readonly PF1eActiveEffect[]): Set<string> {
  const names = new Set(applications.filter((app) => app.supported).map((app) => app.condition.toLocaleLowerCase("en-US")));
  for (const effect of effects) {
    if (effect.disabled) continue;
    const condition = effect.payload.condition;
    if (typeof condition === "string" && condition.trim() !== "")
      names.add(condition.toLocaleLowerCase("en-US"));
  }
  return names;
}

/**
 * Merge canonical condition instances into the shared tactical effect resolver. A named condition
 * contributes its library mechanics once regardless of how many sources supplied it. Pinned
 * suppresses Grappled mechanics (but does not delete the underlying grappler/source instance).
 */
export function resolvePF1eConditionEffects(
  system: unknown,
  effects: readonly PF1eActiveEffect[] = [],
): { effects: PF1eActiveEffect[]; readout: PF1eConditionReadout } {
  const readout = readPF1eConditionApplications(system);
  const allConditionNames = conditionNameSet(readout.applications, effects);
  const pinned = allConditionNames.has("pinned");
  const effectiveEffects = pinned
    ? effects.filter((effect) => effect.payload.condition?.toLocaleLowerCase("en-US") !== "grappled")
    : [...effects];
  const represented = new Set(
    effectiveEffects
      .filter((effect) => !effect.disabled && typeof effect.payload.condition === "string")
      .map((effect) => effect.payload.condition?.toLocaleLowerCase("en-US") ?? ""),
  );
  const emitted = new Set<string>();
  for (const app of readout.applications) {
    if (!app.supported) continue;
    const key = app.condition.toLocaleLowerCase("en-US");
    if (pinned && key === "grappled") continue;
    if (represented.has(key) || emitted.has(key)) continue;
    const def = pf1eConditionDef(app.condition);
    if (!def) continue;
    emitted.add(key);
    effectiveEffects.push({
      id: `condition:${app.id}`,
      name: def.name,
      icon: null,
      disabled: false,
      durationLeft: null,
      payload: def.build(),
    });
  }
  return {
    effects: effectiveEffects,
    readout: pinned
      ? { ...readout, names: readout.names.filter((name) => name.toLocaleLowerCase("en-US") !== "grappled") }
      : readout,
  };
}

/** Build one keyed condition application op, preserving every unrelated instance. */
export function pf1eApplyConditionApplication(input: {
  actor: ActorDocument;
  condition: string;
  source: PF1eConditionSource;
  id?: string;
  removal?: PF1eConditionRemovalPolicy;
}): Result<Op[]> {
  const def = pf1eConditionDef(input.condition);
  if (!def) return err(`pf1e condition: unknown condition "${input.condition}"`);
  const block = pf1eBlock(input.actor.system);
  const current = validatePF1eConditionApplications(block.conditionApplications);
  if (!current.ok) return current;
  const id = input.id ?? pf1eConditionApplicationId();
  const application = readPF1eConditionApplication({
    id,
    condition: def.name,
    source: input.source,
    removal: input.removal ?? { kind: "manual" },
  });
  if (!application.ok) return application;
  if (Object.hasOwn(current.value, id)) return err(`condition application "${id}" already exists`);

  const merged = { ...current.value, [id]: application.value };
  // Pinned is mechanically more severe than Grappled and the two do not stack. Drop only this
  // target actor's old Grappled application instances — a rebuild rather than a dynamic `delete`
  // (the map is the actor's own condition block; other actors, including the source, are
  // untouched). Legacy names remain read-compatible and are mechanically suppressed while Pinned
  // is active.
  const removeIds = def.name === "Pinned"
    ? Object.values(current.value).filter((app) => app.condition === "Grappled").map((app) => app.id)
    : [];
  const removed = new Set(removeIds);
  const next = removed.size > 0
    ? Object.fromEntries(Object.entries(merged).filter(([key]) => !removed.has(key)))
    : merged;

  const system = isRecord(input.actor.system) ? input.actor.system : {};
  const rawBlock = isRecord(system.pf1e) ? system.pf1e : {};
  const hasBlock = isRecord(system.pf1e);
  const hasMap = isRecord(rawBlock.conditionApplications);
  const ref = { coll: "actors" as const, id: input.actor._id };
  if (!hasBlock) {
    const diffBlock = { ...rawBlock, conditionApplications: next };
    return okVal([{
      kind: "update",
      ref,
      diff: { "system.pf1e": diffBlock as unknown as Json },
    }]);
  }
  if (!hasMap) return okVal([{
    kind: "update",
    ref,
    diff: { "system.pf1e.conditionApplications": next as unknown as Json },
  }]);
  const diff: Record<string, Json | null> = {
    [`system.pf1e.conditionApplications.${id}`]: application.value as unknown as Json,
  };
  for (const removeId of removeIds)
    diff[`-=system.pf1e.conditionApplications.${removeId}`] = null;
  return okVal([{ kind: "update", ref, diff }]);
}

/** Remove exactly one keyed source instance; repeated/missing removal is a named no-op error. */
export function pf1eRemoveConditionApplication(actor: ActorDocument, id: string): Result<Op[]> {
  if (!CONDITION_ID_RE.test(id)) return err("condition application ID is invalid");
  const block = pf1eBlock(actor.system);
  const current = validatePF1eConditionApplications(block.conditionApplications);
  if (!current.ok) return current;
  if (!Object.hasOwn(current.value, id)) return err(`condition application "${id}" does not exist`);
  return okVal([{
    kind: "update",
    ref: { coll: "actors", id: actor._id },
    diff: { [`-=system.pf1e.conditionApplications.${id}`]: null },
  } as Op]);
}
