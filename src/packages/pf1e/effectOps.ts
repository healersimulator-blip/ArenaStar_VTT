/**
 * PF1e effect **apply/persist path** (P4/E01) — the one sanctioned place that turns a
 * `PF1eEffectPayload` into documents and authorized Ops, for both homes the core
 * badge/tick code already reads (`src/core/combat.ts` header):
 *
 *  - **actor-embedded** — `actor.effects` (the `EffectDocument[]` array; the home the
 *    sheet reads today). No combat countdown ticks here: durations seeded on an
 *    embedded effect count down only when the actor is in an encounter via its
 *    combatant copy.
 *  - **combatant-referenced** — `combatant.flags.core.effects[id]`, the map
 *    `core/combat.ts`'s `tickEffects` decrements at the owner's turn end and the
 *    CombatPanel badges. This is the combat-timed home.
 *
 * Nothing here touches a store. Callers submit the returned Ops through
 * `ClientSync.submit`, so host authorization stays decisive — the same discipline as
 * `pf1eSheetEdit`. The permission checks here are the client-side gate only.
 *
 * Stacking, penalties, suppression (a `disabled` effect contributes nothing) and the
 * typed resolution itself stay in `effects.ts:resolveEffects` — this module only moves
 * validated payloads in and out of documents and feeds the resolved result to the two
 * consumers that had no path before: damage rolls (`rollData.ts`) and action legality
 * (`actions.ts`).
 */
import type {
  ActorDocument,
  CombatDocument,
  CombatantDocument,
  EffectDocument,
  Json,
} from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import { can } from "../../core/permissions";
import { err, okVal, type Result } from "../../core/result";
import {
  effectFlagsFor,
  readTacticalEffect,
  readTacticalEffects,
  resolveEffects,
  validateEffectPayload,
  type PF1eActiveEffect,
  type PF1eEffectPayload,
  type ResolvedEffects,
} from "./effects";

/** Budget guard: an actor or combatant carries at most this many effects. */
export const MAX_EFFECTS = 50;

/** Browser/node-safe effect id (crypto.randomUUID with a Math.random fallback). */
export function pfEffectId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return "pf-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** The apply request: a display name plus the validated-under-`flags.pf1e` payload. */
export interface PF1eEffectRequest {
  name: string;
  icon?: string;
  payload: PF1eEffectPayload;
  /** Caster/effect level for per-level durations (defaults to the payload's source level). */
  casterLevel?: number;
  /**
   * The replicated world clock (seconds, E05) at apply time; stamped onto the payload as
   * `appliedAtClock` so clock-counted durations (round/minute/hour/day) can be swept when
   * the GM advances time past their end. Omitted = unanchored (never clock-swept).
   */
  worldClockSeconds?: number;
  /** Explicit effect id; a fresh one is generated when omitted. */
  id?: string;
}

/**
 * Build the embedded `EffectDocument`: `changes` stays empty (it is not the mechanic —
 * D-112), the payload rides `flags.pf1e`, and `flags.core.duration` is seeded from the
 * payload's ttl so core's per-turn tick counts what the spell's text says.
 */
export function buildEffectDoc(
  request: PF1eEffectRequest,
): Result<EffectDocument> {
  if (typeof request.name !== "string" || request.name.trim() === "")
    return err("pf1e effect: a display name is required");
  const payload = validateEffectPayload(request.payload);
  if (!payload.ok) return payload;
  const id = request.id ?? pfEffectId();
  if (typeof id !== "string" || id === "")
    return err("pf1e effect: id must be a non-empty string");
  const doc: EffectDocument = {
    _id: id,
    type: "effect",
    name: request.name.trim(),
    ownership: { default: 0 },
    flags: effectFlagsFor(
      payload.value,
      request.casterLevel,
      request.worldClockSeconds !== undefined
        ? { worldClockSeconds: request.worldClockSeconds }
        : undefined,
    ) as unknown as FlagStoreLike,
    system: {},
    changes: [],
    disabled: false,
  };
  if (request.icon !== undefined && request.icon !== "")
    (doc as { icon?: string }).icon = request.icon;
  return okVal(doc);
}

/** `FlagStore` shape without importing the whole documents module graph into tests. */
interface FlagStoreLike {
  [scope: string]: Record<string, Json>;
}

/**
 * Apply to the **actor-embedded** home. Permission: `update` on the actor, exactly like
 * every other sheet edit. Duplicate ids are refused (a re-apply is a new effect with a
 * new id, never a silent overwrite).
 */
export function pf1eApplyActorEffect(
  actor: ActorDocument,
  user: PermissionUser | null,
  request: PF1eEffectRequest,
): { ops: Array<Record<string, Json>>; error: string | null } {
  const fail = (error: string) => ({ ops: [], error });
  if (!user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  if (!Array.isArray(actor.effects))
    return fail("This actor's effect list is malformed.");
  if (actor.effects.length >= MAX_EFFECTS)
    return fail(`Too many effects (limit ${MAX_EFFECTS}). Remove one first.`);
  const doc = buildEffectDoc(request);
  if (!doc.ok) return fail(doc.error);
  if (actor.effects.some((e) => e._id === doc.value._id))
    return fail(`An effect with id "${doc.value._id}" already exists here.`);
  return {
    ops: [
      {
        kind: "update",
        ref: { coll: "actors", id: actor._id },
        diff: { effects: [...actor.effects, doc.value] as unknown as Json[] },
      },
    ],
    error: null,
  };
}

/** Toggle (suppress/restore) or remove one actor-embedded effect. */
export function pf1eSetActorEffectDisabled(
  actor: ActorDocument,
  user: PermissionUser | null,
  effectId: string,
  disabled: boolean,
): { ops: Array<Record<string, Json>>; error: string | null } {
  return mapActorEffects(actor, user, effectId, (e) => ({ ...e, disabled }));
}

export function pf1eRemoveActorEffect(
  actor: ActorDocument,
  user: PermissionUser | null,
  effectId: string,
): { ops: Array<Record<string, Json>>; error: string | null } {
  const fail = (error: string) => ({ ops: [], error });
  if (!user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  if (!Array.isArray(actor.effects))
    return fail("This actor's effect list is malformed.");
  if (!actor.effects.some((e) => e._id === effectId))
    return fail("That effect is not on this actor.");
  return {
    ops: [
      {
        kind: "update",
        ref: { coll: "actors", id: actor._id },
        diff: {
          effects: actor.effects.filter(
            (e) => e._id !== effectId,
          ) as unknown as Json[],
        },
      },
    ],
    error: null,
  };
}

/**
 * Edit an existing actor-embedded effect in place: same id and suppression
 * state, new validated payload (and name/icon). The duration is re-seeded from
 * the edited ttl — an edit is a new agreement on how long the effect lasts, not
 * a resume of the old countdown.
 */
export function pf1eEditActorEffect(
  actor: ActorDocument,
  user: PermissionUser | null,
  effectId: string,
  request: PF1eEffectRequest,
): { ops: Array<Record<string, Json>>; error: string | null } {
  const fail = (error: string) => ({ ops: [], error });
  if (!user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  if (!Array.isArray(actor.effects))
    return fail("This actor's effect list is malformed.");
  if (!actor.effects.some((e) => e._id === effectId))
    return fail("That effect is not on this actor.");
  const doc = buildEffectDoc(request);
  if (!doc.ok) return fail(doc.error);
  return mapActorEffects(actor, user, effectId, (e) => ({
    ...doc.value,
    _id: e._id,
    disabled: e.disabled,
  }));
}

function mapActorEffects(
  actor: ActorDocument,
  user: PermissionUser | null,
  effectId: string,
  map: (doc: EffectDocument) => EffectDocument,
): { ops: Array<Record<string, Json>>; error: string | null } {
  const fail = (error: string) => ({ ops: [], error });
  if (!user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  if (!Array.isArray(actor.effects))
    return fail("This actor's effect list is malformed.");
  const next = actor.effects.map((e) => (e._id === effectId ? map(e) : e));
  if (!actor.effects.some((e) => e._id === effectId))
    return fail("That effect is not on this actor.");
  return {
    ops: [
      {
        kind: "update",
        ref: { coll: "actors", id: actor._id },
        diff: { effects: next as unknown as Json[] },
      },
    ],
    error: null,
  };
}

/** The combatant's `flags.core.effects` record — the exact shape `core/combat.ts` reads. */
export function combatantEffectsRecord(
  combatant: CombatantDocument,
): Record<string, EffectDocument> {
  const flags = asRecord(combatant.flags ?? {});
  const core = flags ? asRecord(flags.core) : null;
  const effects = core ? asRecord(core.effects) : null;
  if (!effects) return {};
  const out: Record<string, EffectDocument> = {};
  for (const [id, value] of Object.entries(effects)) {
    const doc = asRecord(value);
    if (doc) out[id] = doc as unknown as EffectDocument;
  }
  return out;
}

/** Replace one combatant's effect record; null when the id is not in the encounter. */
export function withCombatantEffects(
  combat: CombatDocument,
  combatantId: string,
  effects: Record<string, EffectDocument>,
): CombatDocument | null {
  let found = false;
  const combatants = combat.combatants.map((c) => {
    if (c._id !== combatantId) return c;
    found = true;
    return {
      ...c,
      flags: {
        ...(c.flags as object),
        core: {
          ...(asRecord(c.flags)?.core ?? {}),
          effects: effects as unknown as Record<string, Json>,
        },
      },
    } as CombatantDocument;
  });
  if (!found) return null;
  return { ...combat, combatants };
}

/**
 * Apply to the **combatant-referenced** home (`flags.core.effects[id]`), so the effect
 * is ticked by `core/combat.ts` at this combatant's turn end and badged by the panel.
 * Permission: `update` on the encounter, exactly like the tracker's own transitions.
 */
export function pf1eApplyCombatantEffect(
  combat: CombatDocument,
  user: PermissionUser | null,
  combatantId: string,
  request: PF1eEffectRequest,
): {
  combat: CombatDocument | null;
  ops: Array<Record<string, Json>>;
  error: string | null;
} {
  const fail = (error: string) => ({ combat: null, ops: [], error });
  if (!user || !can(user, "update", combat, "combats"))
    return fail("You cannot update this encounter.");
  const member = combat.combatants.find((c) => c._id === combatantId);
  if (!member) return fail("combatant is not part of this encounter");
  const effects = combatantEffectsRecord(member);
  if (Object.keys(effects).length >= MAX_EFFECTS)
    return fail(`Too many effects (limit ${MAX_EFFECTS}). Remove one first.`);
  const doc = buildEffectDoc(request);
  if (!doc.ok) return fail(doc.error);
  if (effects[doc.value._id] !== undefined)
    return fail(`An effect with id "${doc.value._id}" already exists here.`);
  effects[doc.value._id] = doc.value;
  const next = withCombatantEffects(combat, combatantId, effects);
  if (!next) return fail("combatant is not part of this encounter");
  return {
    combat: next,
    ops: [
      {
        kind: "update",
        ref: { coll: "combats", id: combat._id },
        diff: { combatants: next.combatants as unknown as Json[] },
      },
    ],
    error: null,
  };
}

/** Toggle (suppress/restore) or remove one combatant-referenced effect. */
export function pf1eEditCombatantEffect(
  combat: CombatDocument,
  user: PermissionUser | null,
  combatantId: string,
  effectId: string,
  request: PF1eEffectRequest,
): {
  combat: CombatDocument | null;
  ops: Array<Record<string, Json>>;
  error: string | null;
} {
  const fail = (error: string) => ({ combat: null, ops: [], error });
  if (!user || !can(user, "update", combat, "combats"))
    return fail("You cannot update this encounter.");
  const member = combat.combatants.find((c) => c._id === combatantId);
  if (!member) return fail("combatant is not part of this encounter");
  const effects = combatantEffectsRecord(member);
  const existing = effects[effectId];
  if (existing === undefined)
    return fail("That effect is not on this combatant.");
  const doc = buildEffectDoc(request);
  if (!doc.ok) return fail(doc.error);
  effects[effectId] = {
    ...doc.value,
    _id: effectId,
    disabled: existing.disabled,
  };
  const next = withCombatantEffects(combat, combatantId, effects);
  if (!next) return fail("combatant is not part of this encounter");
  return {
    combat: next,
    ops: [
      {
        kind: "update",
        ref: { coll: "combats", id: combat._id },
        diff: { combatants: next.combatants as unknown as Json[] },
      },
    ],
    error: null,
  };
}

/** Toggle (suppress/restore) or remove one combatant-referenced effect. */
export function pf1eSetCombatantEffectDisabled(
  combat: CombatDocument,
  user: PermissionUser | null,
  combatantId: string,
  effectId: string,
  disabled: boolean,
): {
  combat: CombatDocument | null;
  ops: Array<Record<string, Json>>;
  error: string | null;
} {
  return mapCombatantEffects(combat, user, combatantId, effectId, (e) => ({
    ...e,
    disabled,
  }));
}

export function pf1eRemoveCombatantEffect(
  combat: CombatDocument,
  user: PermissionUser | null,
  combatantId: string,
  effectId: string,
): {
  combat: CombatDocument | null;
  ops: Array<Record<string, Json>>;
  error: string | null;
} {
  const fail = (error: string) => ({ combat: null, ops: [], error });
  if (!user || !can(user, "update", combat, "combats"))
    return fail("You cannot update this encounter.");
  const member = combat.combatants.find((c) => c._id === combatantId);
  if (!member) return fail("combatant is not part of this encounter");
  const effects = combatantEffectsRecord(member);
  if (effects[effectId] === undefined)
    return fail("That effect is not on this combatant.");
  // `no-dynamic-delete`: shrink by rest destructuring, never `delete`.
  const { [effectId]: removed, ...rest } = effects;
  void removed;
  const next = withCombatantEffects(
    combat,
    combatantId,
    rest as Record<string, EffectDocument>,
  );
  if (!next) return fail("combatant is not part of this encounter");
  return {
    combat: next,
    ops: [
      {
        kind: "update",
        ref: { coll: "combats", id: combat._id },
        diff: { combatants: next.combatants as unknown as Json[] },
      },
    ],
    error: null,
  };
}

function mapCombatantEffects(
  combat: CombatDocument,
  user: PermissionUser | null,
  combatantId: string,
  effectId: string,
  map: (doc: EffectDocument) => EffectDocument,
): {
  combat: CombatDocument | null;
  ops: Array<Record<string, Json>>;
  error: string | null;
} {
  const fail = (error: string) => ({ combat: null, ops: [], error });
  if (!user || !can(user, "update", combat, "combats"))
    return fail("You cannot update this encounter.");
  const member = combat.combatants.find((c) => c._id === combatantId);
  if (!member) return fail("combatant is not part of this encounter");
  const effects = combatantEffectsRecord(member);
  if (effects[effectId] === undefined)
    return fail("That effect is not on this combatant.");
  effects[effectId] = map(effects[effectId]);
  const next = withCombatantEffects(combat, combatantId, effects);
  if (!next) return fail("combatant is not part of this encounter");
  return {
    combat: next,
    ops: [
      {
        kind: "update",
        ref: { coll: "combats", id: combat._id },
        diff: { combatants: next.combatants as unknown as Json[] },
      },
    ],
    error: null,
  };
}

export interface CombinedEffects {
  effects: PF1eActiveEffect[];
  rejected: Array<{ id: string; error: string }>;
}

/**
 * The derivation's read side: actor-embedded effects plus the linked combatant's
 * referenced ones, with the **combatant copy winning on an id collision** — it is the
 * instance the core tick decrements, so it is the live truth while the encounter runs.
 * The actor's embedded copy of the same id (the out-of-combat home) is shadowed, not
 * deleted, so it comes back when the effect is removed from the encounter.
 */
export function combinedTacticalEffects(
  actor: ActorDocument,
  combat: CombatDocument | null,
  combatantId: string | null,
): CombinedEffects {
  const embedded = readTacticalEffects(
    (Array.isArray(actor.effects) ? actor.effects : []).map(
      (e) => [e._id, e] as const,
    ),
  );
  const combined = new Map<string, PF1eActiveEffect>(
    embedded.effects.map((e) => [e.id, e]),
  );
  const rejected = [...embedded.rejected];
  if (combat && combatantId) {
    const member = combat.combatants.find((c) => c._id === combatantId);
    if (member) {
      const referenced = readTacticalEffects(combatantEffectsRecord(member));
      rejected.push(...referenced.rejected);
      for (const e of referenced.effects) combined.set(e.id, e);
    }
  }
  return { effects: [...combined.values()], rejected };
}

/**
 * A deny token refuses a spend when it equals the spend's action id (`"charge"`,
 * `"full-attack"`, `"cast-spell"` …) or the spend's kind (`"standard"`, `"move"`, …).
 * Tokens nobody consumes yet (the plan's `"aoo"` waits for P6's interrupt queue) are
 * inert here — they stay in the set so later consumers read the same data.
 */
export function deniedActionTokens(
  resolved: ResolvedEffects,
): ReadonlySet<string> {
  return resolved.denies;
}

/** Re-export so consumers do not import two modules for one read. */
export function resolveTacticalEffects(
  effects: readonly PF1eActiveEffect[],
): ResolvedEffects {
  return resolveEffects(effects);
}

/** Read one effect back through the shared validation (used by the ops tests). */
export const readEffect = readTacticalEffect;
