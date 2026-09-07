/**
 * §10 combat tracker — pure state machine over CombatDocument. Transitions
 * return a NEW combat plus hook event names (Foundry-style; the caller emits
 * them on Hooks). Delay & effect durations ride combatant/effect `flags`
 * (§0 FlagStore is the sanctioned extension point — CombatantDocument and
 * EffectDocument carry no dedicated fields):
 *   combatant.flags.core.delayed : true once delayed this round (cleared on start)
 *   effect.flags.core.duration  : turns remaining; hits 0 → expired
 *   effects live in combatant.flags.core.effects (id → EffectDocument)
 */
import type {
  CombatDocument,
  CombatantDocument,
  EffectDocument,
  FlagStore,
  Json,
} from "./documents";

export interface CombatTransition {
  combat: CombatDocument;
  /** Hook names in firing order (§3 Hooks.callAll). */
  hooks: string[];
  /** Combatants whose effect(s) expired this transition. */
  expired: Array<{ combatantId: string; effectId: string }>;
}

/** Sort order: initiative desc (null last), defeated always last, stable. */
export function sortCombatants(combatants: readonly CombatantDocument[]): CombatantDocument[] {
  return [...combatants].sort((a, b) => {
    if (a.defeated !== b.defeated) return a.defeated ? 1 : -1;
    const ia = a.initiative ?? -Infinity;
    const ib = b.initiative ?? -Infinity;
    if (ia !== ib) return ib - ia;
    return 0; // stable by insertion (Array.prototype.sort is stable, ES2019+)
  });
}

/** The combatant whose turn it is (null before round 1 / empty). */
export function currentCombatant(combat: CombatDocument): CombatantDocument | null {
  if (combat.round < 1 || combat.combatants.length === 0) return null;
  const sorted = sortCombatants(combat.combatants);
  const idx = Math.min(Math.max(combat.turn, 0), sorted.length - 1);
  return sorted[idx] ?? null;
}

function withCombatants(combat: CombatDocument, combatants: CombatantDocument[]): CombatDocument {
  return { ...combat, combatants };
}

/** Start combat: round 1, turn 0, first combatant's turn begins. */
export function startCombat(combat: CombatDocument): CombatTransition {
  const sorted = sortCombatants(combat.combatants).map((c) => clearDelayed(c));
  const next = { ...combat, round: 1, turn: 0, combatants: sorted };
  const first = sorted[0];
  return {
    combat: next,
    hooks: ["combat:start", "combat:round:start", ...(first ? ["combat:turn:start"] : [])],
    expired: [],
  };
}

/** End combat: reset round/turn (combatants keep initiative for reuse). */
export function endCombat(combat: CombatDocument): CombatTransition {
  return {
    combat: { ...combat, round: 0, turn: 0, combatants: combat.combatants.map(clearDelayed) },
    hooks: ["combat:end"],
    expired: [],
  };
}

/**
 * Advance to the next turn; wraps to the next round (decrementing ROUND-boundary
 * durations is not a thing — durations are turn-boundary, §10 "effect durations").
 */
export function nextTurn(combat: CombatDocument): CombatTransition {
  const sorted = sortCombatants(combat.combatants);
  if (sorted.length === 0) return { combat, hooks: [], expired: [] };
  const hooks: string[] = ["combat:turn:end"];
  let expired: CombatTransition["expired"] = [];

  // effects on the combatant whose turn just ended tick down
  const cur = currentCombatant(combat);
  if (cur) {
    const tick = tickEffects(sorted, cur._id);
    sorted.splice(0, sorted.length, ...tick.combatants);
    expired = tick.expired;
    hooks.push(...tick.expired.map(() => "combat:effect:expire"));
  }

  let round = combat.round;
  let turn = combat.turn;
  if (round < 1) {
    // not started — nextTurn starts it
    return startCombat(combat);
  }
  if (turn + 1 >= sorted.length) {
    round += 1;
    turn = 0;
    hooks.push("combat:round:start");
    // delayed combatants rejoin at the top of the new round
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      if (c?.flags && typeof c.flags === "object" && "delayed" in c.flags) {
        sorted[i] = clearDelayed(c);
      }
    }
  } else {
    turn += 1;
  }
  const next = { ...combat, round, turn, combatants: [...sorted] };
  const starting = sortCombatants(next.combatants)[turn] ?? null;
  let combatants = next.combatants;
  if (starting) {
    combatants = next.combatants.map((c) => (c._id === starting._id ? clearDelayed(c) : c));
    hooks.push("combat:turn:start");
  }
  return { combat: { ...next, combatants }, hooks, expired };
}

/** Step back one turn (GM control; wraps rounds backwards). */
export function previousTurn(combat: CombatDocument): CombatTransition {
  const sorted = sortCombatants(combat.combatants);
  if (sorted.length === 0 || combat.round < 1) return { combat, hooks: [], expired: [] };
  let round = combat.round;
  let turn = combat.turn;
  if (turn - 1 < 0) {
    if (round - 1 < 1) return { combat, hooks: [], expired: [] }; // start of combat
    round -= 1;
    turn = sorted.length - 1;
  } else {
    turn -= 1;
  }
  return {
    combat: { ...combat, round, turn },
    hooks: ["combat:turn:start"],
    expired: [],
  };
}

/** Scope constants (§4 FlagStore is scoped per module). */
const SCOPE = "core";

type CoreFlags = Record<string, Json>;

function coreFlags(c: CombatantDocument | EffectDocument): CoreFlags {
  const f = c.flags as Record<string, CoreFlags | undefined> | undefined;
  return f?.[SCOPE] ?? {};
}

function clearDelayed(c: CombatantDocument): CombatantDocument {
  const core = coreFlags(c);
  if (!("delayed" in core)) return c;
  const { delayed: _drop, ...next } = core;
  void _drop;
  if (Object.keys(next).length === 0) {
    const flags = omitScope(c.flags);
    return { ...c, flags };
  }
  return { ...c, flags: { ...(c.flags as object), [SCOPE]: next } };
}

function omitScope(flags: FlagStore): FlagStore {
  const out: Record<string, Record<string, Json>> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (key !== SCOPE) out[key] = value;
  }
  return out;
}

/**
 * Delay: the combatant passes now and acts LAST this round (Foundry-style).
 * Implemented as a `delayed` flag; sortCombatants still ranks by initiative,
 * so delay only affects scheduling via turn order — the flag marks them and
 * the UI nudges them to the end of the current round's display.
 */
export function delayCombatant(combat: CombatDocument, id: string): CombatTransition {
  let found = false;
  const combatants: CombatantDocument[] = combat.combatants.map((c): CombatantDocument => {
    if (c._id !== id) return c;
    found = true;
    return { ...c, flags: { ...(c.flags as object), [SCOPE]: { ...coreFlags(c), delayed: true } } };
  });
  if (!found) return { combat, hooks: [], expired: [] };
  return {
    combat: withCombatants(combat, combatants),
    hooks: ["combat:combatant:delay"],
    expired: [],
  };
}

/** Mark defeated (skipped in order, sorted last). */
export function setDefeated(
  combat: CombatDocument,
  id: string,
  defeated: boolean,
): CombatTransition {
  const combatants = combat.combatants.map((c) => (c._id === id ? { ...c, defeated } : c));
  return {
    combat: withCombatants(combat, combatants),
    hooks: ["combat:combatant:update"],
    expired: [],
  };
}

function flagNumber(source: CombatantDocument | EffectDocument, key: string): number | null {
  const v = coreFlags(source)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Effects are embedded in combatant `flags.core.effects` (id → EffectDocument). */
function effectsOf(c: CombatantDocument): Array<{ effect: EffectDocument; id: string }> {
  const raw = coreFlags(c).effects;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, Json>)
    .filter(([, v]) => v && typeof v === "object" && (v as { type?: string }).type === "effect")
    .map(([id, v]) => ({ effect: v as unknown as EffectDocument, id }));
}

/** Tick `duration` on the owner's turn end; expire at 0. */
function tickEffects(
  combatants: CombatantDocument[],
  ownerId: string,
): { combatants: CombatantDocument[]; expired: CombatTransition["expired"] } {
  const expired: CombatTransition["expired"] = [];
  const next = combatants.map((c) => {
    if (c._id !== ownerId) return c;
    const list = effectsOf(c);
    if (list.length === 0) return c;
    const effects: Record<string, Json> = {};
    for (const { effect, id } of list) {
      const duration = flagNumber(effect, "duration");
      if (duration === null) {
        effects[id] = effect as unknown as Json; // no duration → persists until removed
        continue;
      }
      const left = duration - 1;
      if (left <= 0) {
        expired.push({ combatantId: c._id, effectId: id });
        continue; // drop expired
      }
      effects[id] = {
        ...effect,
        flags: { ...(effect.flags as object), [SCOPE]: { ...coreFlags(effect), duration: left } },
      } as unknown as Json;
    }
    return { ...c, flags: { ...(c.flags as object), [SCOPE]: { ...coreFlags(c), effects } } };
  });
  return { combatants: next, expired };
}

/** All active effects across combatants (UI badges). */
export function activeEffects(combat: CombatDocument): Array<{
  combatantId: string;
  effect: EffectDocument;
  id: string;
  duration: number | null;
}> {
  const out: Array<{
    combatantId: string;
    effect: EffectDocument;
    id: string;
    duration: number | null;
  }> = [];
  for (const c of combat.combatants) {
    for (const { effect, id } of effectsOf(c)) {
      out.push({ combatantId: c._id, effect, id, duration: flagNumber(effect, "duration") });
    }
  }
  return out;
}

/** Roll initiative for the listed combatants (values pre-rolled by caller). */
export function applyInitiative(
  combat: CombatDocument,
  rolls: Record<string, number>,
): CombatTransition {
  const combatants = combat.combatants.map((c) =>
    c._id in rolls ? { ...c, initiative: rolls[c._id] as number } : c,
  );
  return {
    combat: withCombatants(combat, sortCombatants(combatants)),
    hooks: ["combat:combatant:update"],
    expired: [],
  };
}
