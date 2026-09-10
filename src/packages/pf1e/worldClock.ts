/**
 * **The replicated world clock (E05, D-146).**
 *
 * One world time for every replica, stored as the `clockSeconds` key of the replicated
 * `settings` document `_id = "world-settings"` — the D-113 seam. It is deliberately *not* on
 * `WorldsRecord` (that row is the local host's private storage and is never replicated), so a
 * player joining mid-session reads the same clock their buffs are anchored against instead of a
 * private guess. Writes go through the normal op path (`worldSettingsOps`), which gives undo,
 * sync and projection for free; nothing in this module touches local storage.
 *
 * The clock advances from exactly two places, both of which funnel through `worldSettingsOps`:
 * - **Round wrap** — the combat tracker applies `pf1eNextTurn`'s `clockDeltaSeconds`
 *   (`advanceWorldClockOps`) when `advanceClockOnRound` is on. Per-combat elapsed time already
 *   lives on the round state; this is the world-level counterpart.
 * - **GM out-of-combat time controls** — `advanceWorldClockOps` / `setWorldClockOps` from the
 *   settings window, which also sweep clock-counted effects (`pf1eClockSweepOps`).
 *
 * Duration model (the E05 half of the P4 duration story):
 * - `round`/`minute`/`hour` payloads keep their `flags.core.duration` ticks and the turn engine
 *   as their in-combat consumer (E04). Applying now also stamps `appliedAtClock`, so the same
 *   effect can be ended by a clock advance while *out* of combat — the turn engine ticks once
 *   per owner round and the clock advances once per round, so the two agree on rate and the
 *   sweep only ever *removes* (no double-decrement).
 * - `day` has no per-turn tick (`ttlToTicks` returns null); the clock is its only consumer.
 * - `instant`/`concentration`/`permanent` are not clock-counted: an instant is over, a
 *   concentration effect lapses on maintenance (E04/A.16), a permanent one never expires.
 * - Effects applied before E05 (no `appliedAtClock`) are never swept — the sweep refuses to
 *   guess an anchor.
 */
import type { ActorDocument, CombatDocument, Json } from "../../core/documents";
import type { Op } from "../../core/ops";
import {
  worldSettingsFrom,
  worldSettingsOps,
  type CoreWorldSettings,
} from "../../core/worldSettings";
import {
  readTacticalEffect,
  ttlToTicks,
  type PF1eEffectPayload,
  type PF1eTtl,
} from "./effects";
import { combatantEffectsRecord, withCombatantEffects } from "./effectOps";

/** The world-settings key carrying the replicated clock (elapsed seconds). */
export const WORLD_CLOCK_KEY = "clockSeconds";

/**
 * This world's duration ladder is the landed `ttlToTicks` abstraction: 1 minute = 10 rounds,
 * 1 hour = 100 rounds. A day is therefore 24 of those hours — 2 400 rounds, 14 400 s at the
 * default 6 s round — not the 6 000 rounds a real-clock day would imply.
 */
export const TICKS_PER_DAY = 2400;

/** Upper bound mirrored by `validateWorldSettingsPatch` (100 years of elapsed seconds). */
export const MAX_CLOCK_SECONDS = 3_153_600_000;

/** The replicated clock as a non-negative integer of seconds; anything else reads as 0. */
export function worldClockSecondsOf(settings: CoreWorldSettings): number {
  const v = settings[WORLD_CLOCK_KEY];
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.min(MAX_CLOCK_SECONDS, Math.max(0, Math.trunc(v)));
}

/** Read the clock off the replicated settings collection (the joiner's readback path). */
export function readWorldClock(settingsDocs: Iterable<unknown>): number {
  return worldClockSecondsOf(worldSettingsFrom(settingsDocs));
}

/**
 * Ops setting the clock to an absolute value (clamped at 0). [] when the value is already
 * current, so a caller never writes a no-op envelope.
 */
export function setWorldClockOps(
  settingsDocs: Iterable<unknown>,
  seconds: number,
): Op[] {
  const next =
    typeof seconds === "number" && Number.isFinite(seconds)
      ? Math.min(MAX_CLOCK_SECONDS, Math.max(0, Math.trunc(seconds)))
      : 0;
  if (readWorldClock(settingsDocs) === next) return [];
  return worldSettingsOps(settingsDocs, { [WORLD_CLOCK_KEY]: next });
}

/**
 * Ops advancing (or rewinding — a negative delta is a GM correction, never an expiry driver)
 * the clock by `delta` seconds, clamped at 0.
 */
export function advanceWorldClockOps(
  settingsDocs: Iterable<unknown>,
  delta: number,
): Op[] {
  const current = readWorldClock(settingsDocs);
  const d =
    typeof delta === "number" && Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return setWorldClockOps(settingsDocs, current + d);
}

/**
 * The combat tracker's contribution: ops for a `pf1eNextTurn` result's `clockDeltaSeconds`.
 * Zero deltas (no wrap, or the surprise round) produce no ops; whether the world advances at
 * all on wrap remains the caller's `advanceClockOnRound` decision (core's setting).
 */
export function wrapAdvanceOps(
  settingsDocs: Iterable<unknown>,
  clockDeltaSeconds: number,
): Op[] {
  const d =
    typeof clockDeltaSeconds === "number" && Number.isFinite(clockDeltaSeconds)
      ? Math.trunc(clockDeltaSeconds)
      : 0;
  return d > 0 ? advanceWorldClockOps(settingsDocs, d) : [];
}

/** Seconds one tick of `flags.core.duration` is worth under this world's rules. */
export function ttlSeconds(
  ttl: PF1eTtl | undefined,
  casterLevel = 1,
  secondsPerRound = 6,
): number | null {
  if (!ttl) return null;
  const level = Math.max(1, Math.trunc(casterLevel));
  const spr =
    typeof secondsPerRound === "number" && Number.isFinite(secondsPerRound)
      ? Math.max(1, Math.trunc(secondsPerRound))
      : 6;
  const ticks = ttlToTicks(ttl, level);
  if (ticks !== null) return ticks * spr;
  if (ttl.unit !== "day") return null; // instant / concentration / permanent
  const n = Math.max(1, Math.trunc(ttl.value)) * (ttl.perLevel ? level : 1);
  return n * TICKS_PER_DAY * spr;
}

/** Units the clock may end: the ticked trio plus `day`, whose only consumer is the clock. */
export function isClockCounted(ttl: PF1eTtl | undefined): boolean {
  return (
    ttl !== undefined &&
    (ttl.unit === "round" ||
      ttl.unit === "minute" ||
      ttl.unit === "hour" ||
      ttl.unit === "day")
  );
}

/**
 * Which of `entries` (already-validated payloads, e.g. from `readTacticalEffects`) the clock
 * has ended at `now`: anchored (has `appliedAtClock`), clock-counted, and whose
 * `appliedAtClock + ttlSeconds ≤ now`. Removal only — the sweep never rewrites durations, so
 * an effect consumed by the turn engine first is simply already gone.
 */
export function clockExpiredIds(
  entries: ReadonlyArray<{ id: string; payload: PF1eEffectPayload }>,
  now: number,
  secondsPerRound = 6,
): string[] {
  const t =
    typeof now === "number" && Number.isFinite(now) ? Math.trunc(now) : 0;
  const expired: string[] = [];
  for (const { id, payload } of entries) {
    if (payload.appliedAtClock === undefined) continue;
    if (!isClockCounted(payload.ttl)) continue;
    const seconds = ttlSeconds(
      payload.ttl,
      payload.source?.level ?? 1,
      secondsPerRound,
    );
    if (seconds === null) continue;
    if (t >= payload.appliedAtClock + seconds) expired.push(id);
  }
  return expired;
}

export type ClockExpiry = {
  home: "actors" | "combats";
  ownerId: string;
  effectId: string;
};

/**
 * Sweep both effect homes (E01's actors-embedded and combatant-embedded records) against the
 * clock, producing the update ops that strip exactly the expired documents and the receipt
 * list. Effects that fail validation are preserved untouched, and an owner with nothing
 * expired produces no op at all.
 */
export function pf1eClockSweepOps(
  actors: readonly ActorDocument[],
  combats: readonly CombatDocument[],
  now: number,
  secondsPerRound = 6,
): { ops: Array<Record<string, Json>>; expired: ClockExpiry[] } {
  const ops: Array<Record<string, Json>> = [];
  const expired: ClockExpiry[] = [];

  for (const actor of actors) {
    const embedded = Array.isArray(actor.effects) ? actor.effects : [];
    if (embedded.length === 0) continue;
    const keep: unknown[] = [];
    for (const doc of embedded) {
      const r = readTacticalEffect(String(doc._id ?? ""), doc);
      if (!r.ok) {
        keep.push(doc);
        continue;
      }
      if (
        clockExpiredIds(
          [{ id: r.value.id, payload: r.value.payload }],
          now,
          secondsPerRound,
        ).length > 0
      ) {
        expired.push({
          home: "actors",
          ownerId: actor._id,
          effectId: r.value.id,
        });
      } else {
        keep.push(doc);
      }
    }
    if (keep.length !== embedded.length) {
      ops.push({
        kind: "update",
        ref: { coll: "actors", id: actor._id },
        diff: { effects: keep as Json[] },
      });
    }
  }

  for (const combat of combats) {
    let acc = combat;
    let changed = false;
    for (const member of combat.combatants) {
      const record = combatantEffectsRecord(member);
      const ids = Object.keys(record);
      if (ids.length === 0) continue;
      const remaining: Record<string, unknown> = {};
      let dropped = false;
      for (const id of ids) {
        const r = readTacticalEffect(id, record[id] as never);
        if (!r.ok) {
          remaining[id] = record[id];
          continue;
        }
        if (
          clockExpiredIds(
            [{ id: r.value.id, payload: r.value.payload }],
            now,
            secondsPerRound,
          ).length > 0
        ) {
          dropped = true;
          expired.push({ home: "combats", ownerId: member._id, effectId: id });
        } else {
          remaining[id] = record[id];
        }
      }
      if (dropped) {
        const next = withCombatantEffects(acc, member._id, remaining as never);
        if (next) {
          acc = next;
          changed = true;
        }
      }
    }
    if (changed) {
      ops.push({
        kind: "update",
        ref: { coll: "combats", id: combat._id },
        diff: { combatants: acc.combatants as unknown as Json[] },
      });
    }
  }

  return { ops, expired };
}

/** `1d 02:03:04` / `02:03:04` — the settings window's clock readout. */
export function formatWorldClock(total: number): string {
  const s =
    typeof total === "number" && Number.isFinite(total)
      ? Math.max(0, Math.trunc(total))
      : 0;
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}
