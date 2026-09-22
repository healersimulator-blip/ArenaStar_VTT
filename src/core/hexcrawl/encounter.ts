/**
 * **The encounter engine (D-269, plan §6).**
 *
 * One pure module answers the whole question "is anything eligible right now, and what should
 * happen?" at four trigger points — the party crossed a border (`entering`), took a step while
 * travelling (`moving`), spent time looking (`exploring`), or a fight started (`fighting`) —
 * under one of two phases of the day (`day`/`night`, from `core/clock.ts`).
 *
 * The rules, each with its own test:
 *
 * 1. **Tag eligibility** is `tags[trigger] && tags[phase]`, with every tag defaulting ON
 *    (`encounterTagsOf`), so a fresh table fires on everything until the GM narrows it.
 * 2. **Cooldown** — a table that fired stays quiet for `cooldownSeconds`, defaulting to *the
 *    rest of the current phase*: a night table cannot fire twice in the same night, without the
 *    GM configuring anything. `moving` is why this exists at all — a three-day march across one
 *    forest cell is three days of dice, and the requirement asks for *news*, not statistics.
 * 3. **The ledger is replicated world data** (`cell.flags.core.encounters`, `{ [tableId]: atClock }`),
 *    not local state, so two GMs at one table cannot double-fire the same night encounter.
 * 4. **Ties never pick silently** — two eligible tables produce a decision the UI resolves with
 *    the picker popup (requirement 5: "several eligible → GM picks from a pop-up").
 * 5. **Determinism** — randomness is injected (`RngFn`), so a test replays an exact itinerary and
 *    the host's seeded dice are the only source of luck in production.
 *
 * Nothing here writes: `encounterDecision` says what to do, `ledgerOps` records that it was done.
 */
import type { EncounterTableDocument, Json, SceneDocument } from "../documents";
import type { FlatDiff, Op } from "../ops";
import {
  DEFAULT_DAYLIGHT,
  phaseOf,
  secondsUntilPhaseEnd,
  type ClockPhase,
  type Daylight,
} from "../clock";
import { hexcrawlProfileOf } from "./types";
import {
  encounterTagsOf,
  entryForRoll,
  validateEncounterTable,
  WEIGHT_LADDER_DIE,
  weightsToRanges,
} from "./tables";

/** The four moments an encounter can start. */
export type EncounterTrigger = "entering" | "moving" | "exploring" | "fighting";

export const ENCOUNTER_TRIGGERS: ReadonlyArray<EncounterTrigger> = [
  "entering",
  "moving",
  "exploring",
  "fighting",
];

/** Injected randomness: `[0, 1)` like `Math.random`, or the host's seeded dice stream. */
export type RngFn = () => number;

export interface LedgerEntry {
  cellKey: string;
  tableId: string;
  /** World clock reading when the table last produced an encounter. */
  atClock: number;
}

export interface EncounterContext {
  scene: SceneDocument;
  tables: ReadonlyArray<EncounterTableDocument>;
  /** The cell the trigger happened in. */
  cellKey: string;
  trigger: EncounterTrigger;
  clockSeconds: number;
  /** Daylight window; falls back to the scene profile, then to 06/18. */
  daylight?: Daylight;
  /** What already fired, read from the cells' ledger flags (`readLedger`). */
  fired: ReadonlyArray<LedgerEntry>;
  rng: RngFn;
}

export type EncounterDecision =
  | {
      kind: "none";
      reason:
        "not-a-hexcrawl" | "no-cell" | "no-tables" | "none-eligible" | "manual";
    }
  | { kind: "manual"; tables: EncounterTableDocument[] }
  | { kind: "prompt"; tables: EncounterTableDocument[] }
  | {
      kind: "roll";
      tables: EncounterTableDocument[];
      table: EncounterTableDocument;
    };

/** Why a check found nothing to do (`EncounterDecision`'s `none` reasons, named for callers). */
export type EncounterNoneReason = Extract<
  EncounterDecision,
  { kind: "none" }
>["reason"];

/** The scene's daylight window: its profile's, or the temperate default. */
export function daylightOf(scene: SceneDocument | null | undefined): Daylight {
  return hexcrawlProfileOf(scene)?.daylight ?? DEFAULT_DAYLIGHT;
}

/** Day or night at this reading, under the scene's own window. */
export function encounterPhase(
  clockSeconds: number,
  scene: SceneDocument | null | undefined,
): ClockPhase {
  return phaseOf(clockSeconds, daylightOf(scene));
}

/**
 * Which of `tables` may fire now: attached to the cell (the caller passes only those), tagged
 * for this trigger *and* this phase, and past their cooldown. Order is the authored order the
 * caller supplied — a tie's popup must be stable, or the GM's muscle memory breaks.
 */
export function eligibleTables(
  ctx: EncounterContext,
): EncounterTableDocument[] {
  const phase = encounterPhase(ctx.clockSeconds, ctx.scene);
  const daylight = ctx.daylight ?? daylightOf(ctx.scene);
  const out: EncounterTableDocument[] = [];
  for (const table of ctx.tables) {
    const tags = encounterTagsOf(table);
    if (!tags[ctx.trigger]) continue;
    if (phase === "day" ? !tags.day : !tags.night) continue;
    if (cooldownRemaining(table, ctx, daylight) > 0) continue;
    out.push(table);
  }
  return out;
}

/**
 * Seconds until this table may fire again *in this cell*. Default cooldown = the rest of the
 * current phase, so "once per night" needs no configuration; an explicit `cooldownSeconds`
 * overrides it, and a table that has never fired is always ready.
 */
export function cooldownRemaining(
  table: EncounterTableDocument,
  ctx: Pick<EncounterContext, "cellKey" | "clockSeconds" | "fired">,
  daylight: Daylight,
): number {
  const last = lastFiredAt(ctx.fired, ctx.cellKey, table._id);
  if (last === null) return 0;
  const cooldown =
    typeof table.cooldownSeconds === "number" &&
    Number.isFinite(table.cooldownSeconds) &&
    table.cooldownSeconds > 0
      ? Math.trunc(table.cooldownSeconds)
      : // A phase can be shortened by a wrapped window (dawn 20 → dusk 6); `secondsUntilPhaseEnd`
        // already handles that, and the profile's own window is what the table was tagged against.
        secondsUntilPhaseEnd(last, daylight);
  const elapsed = ctx.clockSeconds - last;
  if (elapsed < 0) return 0; // the clock was rewound: the GM reset time and wants a fresh night
  return Math.max(0, cooldown - elapsed);
}

/** The most recent firing of `tableId` in `cellKey` (null = never). */
export function lastFiredAt(
  fired: ReadonlyArray<LedgerEntry>,
  cellKey: string,
  tableId: string,
): number | null {
  let at: number | null = null;
  for (const entry of fired) {
    if (entry.cellKey !== cellKey || entry.tableId !== tableId) continue;
    if (at === null || entry.atClock > at) at = entry.atClock;
  }
  return at;
}

/**
 * What the scene's mode says to do next (plan §6 rules 2/4/6):
 * - `manual` — nothing fires by itself; the hex window's rows are the only trigger;
 * - no eligible table — nothing at all;
 * - `auto` with one candidate — roll it;
 * - `auto` with several — a `prompt` decision **listing every candidate**, never a silent
 *   first-match, because that is the requirement's explicit ask (the "auto-roll a random one"
 *   shortcut is what a GM complains about later);
 * - `prompt` — the GM-only card; the shape is the same list either way.
 */
export function encounterDecision(ctx: EncounterContext): EncounterDecision {
  const profile = hexcrawlProfileOf(ctx.scene);
  if (!profile) return { kind: "none", reason: "not-a-hexcrawl" };
  if (!ctx.cellKey) return { kind: "none", reason: "no-cell" };
  if (ctx.tables.length === 0) return { kind: "none", reason: "no-tables" };
  if (profile.encounterMode === "manual")
    return { kind: "manual", tables: eligibleTables(ctx) };
  const eligible = eligibleTables(ctx);
  if (eligible.length === 0) return { kind: "none", reason: "none-eligible" };
  if (profile.encounterMode === "prompt")
    return { kind: "prompt", tables: eligible };
  if (eligible.length === 1) {
    const only = eligible[0] as EncounterTableDocument;
    return { kind: "roll", tables: eligible, table: only };
  }
  return { kind: "prompt", tables: eligible };
}

// ─── rolling an encounter ────────────────────────────────────────────────────

export interface EncounterRoll {
  tableId: string;
  tableName: string;
  /** The die face, 1-based (`1d100` → 1–100). */
  roll: number;
  die: number;
  formula: string;
  /** Null when the roll landed on a gap the author left (dice mode only). */
  entryIndex: number | null;
  text: string;
  count: number;
  refs: EncounterTableDocument["entries"][number]["refs"];
}

/** Roll one die face from injected randomness (never 0, never above the die). */
export function rollDie(die: number, rng: RngFn): number {
  const face = Math.floor(rng() * die) + 1;
  return Math.max(1, Math.min(die, face));
}

/**
 * Draw from a table: the weighted ladder or the table's own dice range, one code path — the
 * two modes differ only in where their ranges come from (`validateEncounterTable` has already
 * checked both, and its warnings are the GM's to read).
 */
export function drawEncounter(
  table: EncounterTableDocument,
  rng: RngFn,
): EncounterRoll {
  const check = validateEncounterTable(table);
  const roll = rollDie(check.die === 0 ? WEIGHT_LADDER_DIE : check.die, rng);
  const index = entryForRoll(check.ranges, roll);
  const entry = index === null ? null : (table.entries[index] ?? null);
  return {
    tableId: table._id,
    tableName: table.name,
    roll,
    die: check.die,
    formula: table.mode === "weighted" ? `1d${check.die}` : table.formula,
    entryIndex: index,
    text: entry?.text ?? `Nothing on ${roll}?`,
    count: entry?.count ?? 0,
    refs: entry?.refs ?? [],
  };
}

/** The weighted ladder of a table, for the panel's preview (weights → 1–100). */
export function tableLadder(
  table: EncounterTableDocument,
): Array<{ range: [number, number]; index: number; weight: number }> {
  return weightsToRanges(table.entries).ranges;
}

// ─── the ledger (replicated, per cell) ───────────────────────────────────────

/** The flag key a cell keeps its ledger under: `flags.core.encounters`. */
export const LEDGER_FLAG = "encounters";

/** Read every ledger entry a scene's cells hold. */
export function readLedger(
  scene: SceneDocument | null | undefined,
): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const cell of scene?.cells ?? []) {
    const core = flagCore(cell.flags);
    const raw = core?.[LEDGER_FLAG];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    for (const [tableId, at] of Object.entries(raw)) {
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      out.push({ cellKey: cell.key, tableId, atClock: Math.trunc(at) });
    }
  }
  return out;
}

function flagCore(flags: unknown): Record<string, unknown> | null {
  const bag =
    typeof flags === "object" && flags !== null && !Array.isArray(flags)
      ? (flags as Record<string, unknown>)
      : null;
  const core = bag?.["core"];
  return typeof core === "object" && core !== null && !Array.isArray(core)
    ? (core as Record<string, unknown>)
    : null;
}

// ─── the encounter log (what happened here, and where it went) ───────────────

/** The flag key a cell keeps its encounter log under: `flags.core.encounterLog`. */
export const LOG_FLAG = "encounterLog";

/** One resolved encounter on a cell: the roll, and the battle scene it was played on. */
export interface EncounterLogEntry {
  tableId: string;
  tableName: string;
  roll: number;
  /** The roll's entry line, as it was written when the encounter happened. */
  text: string;
  /** Set when the GM took the encounter to a copied battle scene (requirement 5d). */
  sceneId: string | null;
  atClock: number;
}

/** The encounters a cell remembers, newest last (the return trip's own list). */
export function encounterLogOf(
  scene: SceneDocument | null | undefined,
  cellKey: string,
): EncounterLogEntry[] {
  const cell = (scene?.cells ?? []).find((c) => c.key === cellKey);
  const raw = flagCore(cell?.flags)?.[LOG_FLAG];
  if (!Array.isArray(raw)) return [];
  const out: EncounterLogEntry[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    if (typeof entry["tableId"] !== "string") continue;
    out.push({
      tableId: entry["tableId"],
      tableName: typeof entry["tableName"] === "string" ? entry["tableName"] : entry["tableId"],
      roll: typeof entry["roll"] === "number" ? Math.trunc(entry["roll"]) : 0,
      text: typeof entry["text"] === "string" ? entry["text"] : "",
      sceneId: typeof entry["sceneId"] === "string" ? entry["sceneId"] : null,
      atClock: typeof entry["atClock"] === "number" ? Math.trunc(entry["atClock"]) : 0,
    });
  }
  return out;
}

/**
 * Append one resolved encounter to its cell's log (bounded — a hex visited for a whole campaign
 * should not grow an unbounded array in a replicated document; the last 20 stay).
 */
export function logEncounterOps(
  scene: SceneDocument,
  cellKey: string,
  entry: EncounterLogEntry,
): Op[] {
  const cell = (scene.cells ?? []).find((c) => c.key === cellKey);
  if (!cell) return [];
  const flags = cell.flags ?? {};
  const core = { ...(flagCore(flags) ?? {}) };
  const log = [...encounterLogOf(scene, cellKey), entry].slice(-20);
  core[LOG_FLAG] = log as unknown as Json;
  return [
    {
      kind: "update",
      ref: {
        coll: "cells",
        id: cell._id,
        parent: { coll: "scenes", id: scene._id },
      },
      diff: { flags: { ...flags, core } } as FlatDiff,
    },
  ];
}

/**
 * Record a firing on its cell (the write side of the ledger). One update op per cell, carrying
 * the whole `flags` object — `FlatDiff` cannot create missing intermediates (D-012).
 */
export function ledgerOps(
  scene: SceneDocument,
  cellKey: string,
  entries: ReadonlyArray<{ tableId: string; atClock: number }>,
): Op[] {
  if (entries.length === 0) return [];
  const cell = (scene.cells ?? []).find((c) => c.key === cellKey);
  if (!cell) return [];
  const flags = cell.flags ?? {};
  const core = { ...(flagCore(flags) ?? {}) };
  const ledger: Record<string, Json> = {
    ...((flagCore(flags)?.[LEDGER_FLAG] as Record<string, Json> | undefined) ??
      {}),
  };
  for (const entry of entries)
    ledger[entry.tableId] = Math.max(0, Math.trunc(entry.atClock));
  core[LEDGER_FLAG] = ledger;
  return [
    {
      kind: "update",
      ref: {
        coll: "cells",
        id: cell._id,
        parent: { coll: "scenes", id: scene._id },
      },
      diff: { flags: { ...flags, core } } as FlatDiff,
    },
  ];
}

/** Clear a cell's ledger (a GM resetting the night's encounters). */
export function clearLedgerOps(scene: SceneDocument, cellKey: string): Op[] {
  const cell = (scene.cells ?? []).find((c) => c.key === cellKey);
  if (!cell) return [];
  const flags = cell.flags ?? {};
  // The key is dropped by rebuilding the bag without it (`no-dynamic-delete` is on repo-wide, and
  // this also leaves the caller's own object untouched).
  const core = Object.fromEntries(
    Object.entries(flagCore(flags) ?? {}).filter(
      ([key]) => key !== LEDGER_FLAG,
    ),
  );
  return [
    {
      kind: "update",
      ref: {
        coll: "cells",
        id: cell._id,
        parent: { coll: "scenes", id: scene._id },
      },
      diff: { flags: { ...flags, core } } as FlatDiff,
    },
  ];
}

// ─── trigger points ──────────────────────────────────────────────────────────

/**
 * Which triggers a *step* produces. Crossing into a different cell is `entering` **and**
 * `moving`; stepping inside the same cell is `moving` only — the border crossing is the moment
 * the party notices something new, and firing `entering` on every step would be a table that
 * fires per hex of a march.
 */
export function triggersForStep(
  fromKey: string | null,
  toKey: string,
): EncounterTrigger[] {
  if (!fromKey || fromKey !== toKey) return ["entering", "moving"];
  return ["moving"];
}

/** Triggers when the party stops to look around (one check per explore action). */
export function triggersForExplore(): EncounterTrigger[] {
  return ["exploring"];
}

/** Triggers when a combat starts on a cell. */
export function triggersForFight(): EncounterTrigger[] {
  return ["fighting"];
}

/** True when any table attached to a cell would ever fire at this phase (the panel's badge). */
export function hasTagsForPhase(
  tables: ReadonlyArray<EncounterTableDocument>,
  phase: ClockPhase,
): boolean {
  return tables.some((t) => {
    const tags = encounterTagsOf(t);
    return phase === "day" ? tags.day : tags.night;
  });
}
