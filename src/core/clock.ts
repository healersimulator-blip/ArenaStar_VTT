/**
 * **The world clock's calendar half — one integral clock (D-268).**
 *
 * A round is 6 seconds; a minute is 10 of those rounds, an hour 600, a day 14 400 (86 400 s).
 * This module owns those numbers and the *derivations* from elapsed seconds — hour of day,
 * day/night phase, distance to the next hour or the next phase change — so that the PF1e
 * duration ladder (`packages/pf1e/effects.ts` `ttlToTicks`, `packages/pf1e/worldClock.ts`
 * `TICKS_PER_DAY`), the Settings window's time buttons, the hexcrawl travel model and any
 * later "until dawn" rule all read the same ladder instead of each keeping its own idea of
 * what an hour is. D-268 *is* that correction: an hour used to be 100 rounds (ten minutes)
 * and a day 2 400 rounds (four hours), which no per-hour or per-24-hour ability could live
 * with.
 *
 * Why the constants live in `core` and not in the rules package: elapsed seconds, days and
 * hours are not a ruleset's opinion — they are what the replicated `settings.clockSeconds`
 * counts. A rules package may price a duration in rounds (and PF1e does, at 6 s a round), but
 * that is a *ladder over* this clock, not a second clock.
 *
 * Deliberately pure: no documents, no store, no writes, no imports. Every function takes
 * elapsed seconds and returns a derived number, so it is unit-testable and usable from the
 * canvas, the UI, the rules package and (later) the agent connector alike.
 */

/** A minute of elapsed time, in seconds. */
export const MINUTE_SECONDS = 60;
/** An hour of elapsed time, in seconds. */
export const HOUR_SECONDS = 3_600;
/** A day of elapsed time, in seconds. */
export const DAY_SECONDS = 86_400;

/** The round the ladder is written against (A.1). A world may configure another `secondsPerRound`. */
export const SECONDS_PER_ROUND = 6;

/** Rounds in a minute at the 6-second round: the ladder's second rung. */
export const ROUNDS_PER_MINUTE = 10;
/** Rounds in an hour: what `ttlToTicks` writes for a "1 hour" duration. */
export const ROUNDS_PER_HOUR = ROUNDS_PER_MINUTE * 60;
/** Rounds in a day: `TICKS_PER_DAY` in the PF1e clock. */
export const ROUNDS_PER_DAY = ROUNDS_PER_HOUR * 24;

/**
 * When a day starts and ends, in hours of the clock. Both default to the temperate 06/18.
 * **`dawnHour === duskHour` means the sun never sets** (a day-only map, or a published
 * hexcrawl with no night rules) — the natural knob for a table that does not want night.
 */
export interface Daylight {
  /** Hour the day begins (0–23, may be fractional). */
  dawnHour: number;
  /** Hour the night begins (0–23, may be fractional). */
  duskHour: number;
}

export const DEFAULT_DAYLIGHT: Daylight = { dawnHour: 6, duskHour: 18 };

/** Day or night, as the encounter tags and the hex map both understand it. */
export type ClockPhase = "day" | "night";

const asFinite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Whole seconds since the world's epoch, never negative (the clock clamps at 0). */
export function normalizeClock(clockSeconds: number): number {
  return Math.max(0, Math.trunc(asFinite(clockSeconds)));
}

/** Hour of the clock's day, 0–23 (fractional part dropped: this is the wall-clock hour). */
export function hourOfDay(clockSeconds: number): number {
  return Math.floor(
    (normalizeClock(clockSeconds) % DAY_SECONDS) / HOUR_SECONDS,
  );
}

/** Minute within the hour, 0–59. */
export function minuteOfHour(clockSeconds: number): number {
  return Math.floor(
    (normalizeClock(clockSeconds) % HOUR_SECONDS) / MINUTE_SECONDS,
  );
}

/** Second within the minute, 0–59. */
export function secondOfMinute(clockSeconds: number): number {
  return normalizeClock(clockSeconds) % MINUTE_SECONDS;
}

/** How many whole days have elapsed (day 0 is the first day of the world's clock). */
export function dayNumber(clockSeconds: number): number {
  return Math.floor(normalizeClock(clockSeconds) / DAY_SECONDS);
}

/** `HH:MM`, zero-padded — the time-of-day readout for hex maps and travel previews. */
export function formatClockTime(clockSeconds: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hourOfDay(clockSeconds))}:${pad(minuteOfHour(clockSeconds))}`;
}

/** `3d 14:20` — the itinerary's stamp (day 0 prints as `0d` so columns line up). */
export function formatClockStamp(clockSeconds: number): string {
  return `${dayNumber(clockSeconds)}d ${formatClockTime(clockSeconds)}`;
}

/** Hour of the day including minutes, e.g. 17.75 at 17:45 — for phase windows. */
export function hourFractionOfDay(clockSeconds: number): number {
  const inDay = normalizeClock(clockSeconds) % DAY_SECONDS;
  return inDay / HOUR_SECONDS;
}

/**
 * Day or night at this moment. The window is half-open `[dawn, dusk)`; when the two are equal
 * the sun never sets and every hour is day. A window that *wraps* (dawn 20, dusk 6 — a polar
 * summer) is supported: it is day from 20:00 through 06:00 and night in between.
 */
export function phaseOf(
  clockSeconds: number,
  daylight: Daylight = DEFAULT_DAYLIGHT,
): ClockPhase {
  const dawn = asFinite(daylight.dawnHour);
  const dusk = asFinite(daylight.duskHour);
  if (dawn === dusk) return "day"; // no night in this world
  const hour = hourFractionOfDay(clockSeconds);
  const wrapped = dawn > dusk;
  const day = wrapped
    ? hour >= dawn || hour < dusk
    : hour >= dawn && hour < dusk;
  return day ? "day" : "night";
}

export interface TimeOfDay {
  /** 0–23. */
  hour: number;
  minute: number;
  /** Day or night under the given (or default) daylight window. */
  phase: ClockPhase;
  /** Whole days elapsed — what a hex map's "day 4" column shows. */
  day: number;
  /** `14:20`. */
  label: string;
}

/** Everything a caller needs about "when is it" in one call. */
export function timeOfDay(
  clockSeconds: number,
  daylight: Daylight = DEFAULT_DAYLIGHT,
): TimeOfDay {
  return {
    hour: hourOfDay(clockSeconds),
    minute: minuteOfHour(clockSeconds),
    phase: phaseOf(clockSeconds, daylight),
    day: dayNumber(clockSeconds),
    label: formatClockTime(clockSeconds),
  };
}

/**
 * Seconds from now until the clock next reads `hour` (0–23, fractional allowed). "Travel until
 * dusk" and the night table's cooldown both need this; a fractional hour lands inside the hour,
 * so `secondsUntilHour(t, 18)` means 18:00 sharp.
 */
export function secondsUntilHour(clockSeconds: number, hour: number): number {
  const target = ((asFinite(hour) % 24) + 24) % 24;
  const now = hourFractionOfDay(clockSeconds);
  const deltaHours = target > now ? target - now : target + 24 - now;
  const seconds = Math.round(deltaHours * HOUR_SECONDS);
  // Landing exactly on the target must be a whole day ahead, not zero: the caller asked "when
  // is it next 18:00", and answering 0 would loop forever.
  return seconds === 0 ? DAY_SECONDS : seconds;
}

/**
 * Seconds until the current phase ends (the next dawn or dusk). This is the default cooldown for
 * an encounter table, so "a night table cannot fire twice in one night" needs no configuration:
 * the window it is allowed in *is* its cooldown. Returns `DAY_SECONDS` when the sun never sets.
 */
export function secondsUntilPhaseEnd(
  clockSeconds: number,
  daylight: Daylight = DEFAULT_DAYLIGHT,
): number {
  const dawn = asFinite(daylight.dawnHour);
  const dusk = asFinite(daylight.duskHour);
  if (dawn === dusk) return DAY_SECONDS;
  const next = phaseOf(clockSeconds, daylight) === "day" ? dusk : dawn;
  return secondsUntilHour(clockSeconds, next);
}

/**
 * Seconds between two clock readings, as a positive duration (a rewind of the clock reads as 0
 * — "how long since" has no meaning when the GM rewinds time, and the sweep treats it the same
 * way).
 */
export function elapsedBetween(from: number, to: number): number {
  return Math.max(0, normalizeClock(to) - normalizeClock(from));
}
