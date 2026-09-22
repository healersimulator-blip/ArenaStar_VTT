/**
 * **Encounter tables — the weighted-percentage compiler (D-269, plan §5.2, requirement 5b).**
 *
 * An encounter table can be written two ways and both end up in the *same* draw path:
 *
 * - **weighted percentage** — the GM types a weight per row and the compiler lays the rows out
 *   over a `1d100` ladder (`weightsToRanges`). The attached generator works this way: rows are
 *   percentages, and the interesting question is what happens when they do not add to 100;
 * - **dice** — the GM keeps their own formula (`1d20`, `2d6+1`) and each row keeps its own
 *   inclusive range, which the existing dice engine already knows how to roll
 *   (`core/rollTable.ts` `validateTable`/`drawFromTable`).
 *
 * The compiler is pure and total — it never fails a table. That is a deliberate choice: a GM
 * mid-session who has typed 95% worth of rows should get a *sensible* table, not a validation
 * dialog. Rows that were never reached are reported (`dropped`, `repeated`) so the panel can
 * warn without blocking, and a table whose weights total more than 100 is scaled down to fit
 * rather than truncated (the top row would otherwise swallow everything after it).
 */
import type {
  EncounterEntry,
  EncounterTags,
  EncounterTableDocument,
  Json,
} from "../documents";

/** The dice a weighted encounter table rolls. */
export const WEIGHT_LADDER_DIE = 100;

export interface CompiledRange {
  /** Inclusive `[lo, hi]` on the ladder die. */
  range: [number, number];
  /** Index into the entries array this range belongs to (for `range → entry` lookup). */
  index: number;
  /** That entry's share of the ladder, after scaling. */
  weight: number;
}

export interface WeightCompilation {
  /** In entry order; empty when no row has weight. */
  ranges: CompiledRange[];
  /** The sum the GM typed. */
  total: number;
  /** Rows that got no ladder space at all (their weight rounded away). */
  dropped: number[];
  /** Rows that received more than their proportional share (a rounding-up tie). */
  repeated: number[];
  /** True when `total !== 100` and the compiler had to scale or pad. */
  scaled: boolean;
  /** Human-readable notes for the panel; empty when the weights are exactly 100. */
  warnings: string[];
}

/**
 * Lay weighted rows out over `1d100`, in entry order, front-loaded with the remainder.
 *
 * The rules, and the reasoning, in one place:
 * 1. **A row with weight 0 is a note, not a possibility.** It never takes ladder space (a GM
 *    writes "the party's own tracks — flavour only" that way).
 * 2. **Weights are scaled to 100 when they do not sum to 100.** Under 100: the rows share 100
 *    proportionally, so a 25/25/25 table becomes 33/33/34 rather than leaving a dead quarter of
 *    the die silent. Over 100: proportional down, so a 200/200 table is 50/50 and the *ratios*
 *    the GM wrote survive intact.
 * 3. **The remainder goes to the earliest rows**, one point each, so the ladder has no gaps
 *    (a gap would be a roll that produces nothing — the one outcome the GM never asked for) and
 *    the totals always read `1 … 100`.
 * 4. A whole-number weight like 33.3 never appears: the ladder is integers.
 */
export function weightsToRanges(
  entries: ReadonlyArray<{ weight: number }>,
  die = WEIGHT_LADDER_DIE,
): WeightCompilation {
  const weights = entries.map((e) =>
    typeof e.weight === "number" && Number.isFinite(e.weight) && e.weight > 0
      ? e.weight
      : 0,
  );
  const total = weights.reduce((a, b) => a + b, 0);
  const warnings: string[] = [];
  if (total <= 0) {
    return {
      ranges: [],
      total: 0,
      dropped: entries.map((_, i) => i),
      repeated: [],
      scaled: false,
      warnings: ["No row has a weight: this table can only be rolled by hand."],
    };
  }
  const scaled = total !== die;
  if (scaled) {
    warnings.push(
      total < die
        ? `Weights total ${trim(total)}, not ${die}: scaled up to fill the die.`
        : `Weights total ${trim(total)}, over ${die}: scaled down proportionally.`,
    );
  }
  // Exact shares first (fractions kept), then the integer floor, then hand out the remainder.
  const exact = weights.map((w) => (total > 0 ? (w * die) / total : 0));
  const floors = exact.map((v) => Math.floor(v));
  const assigned = floors.reduce<number>((a, b) => a + (b ?? 0), 0);
  let remainder = die - assigned;
  // Remainder to the largest fractional parts first, earliest entry first on a tie.
  const order = exact
    .map((v, i) => ({ i, frac: (v ?? 0) - Math.floor(v ?? 0) }))
    .filter((o) => (weights[o.i] ?? 0) > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const counts = floors.slice();
  for (const o of order) {
    if (remainder <= 0) break;
    if (o.i < 0 || o.i >= counts.length) continue;
    counts[o.i] = (counts[o.i] ?? 0) + 1;
    remainder -= 1;
  }
  // A scaled-down table can leave a tiny weight with 0 faces — it gets one instead of vanishing,
  // because a row that silently cannot be rolled is a bug the GM cannot see. The face is *moved*
  // from the row that collected the rounding remainder, so the ladder still totals 100.
  for (let i = 0; i < counts.length; i++) {
    if ((weights[i] ?? 0) <= 0 || (counts[i] ?? 0) > 0) continue;
    let donor = -1;
    for (let j = 0; j < counts.length; j++) {
      if (j === i) continue;
      const c = counts[j] ?? 0;
      if (c <= 1) continue;
      if (donor === -1 || c > (counts[donor] ?? 0)) donor = j;
    }
    if (donor === -1) {
      warnings.push(
        "A row's weight is too small to fit on the die; it is listed as unreachable.",
      );
      continue;
    }
    counts[donor] = (counts[donor] ?? 0) - 1;
    counts[i] = 1;
  }
  const ranges: CompiledRange[] = [];
  const dropped: number[] = [];
  const repeated: number[] = [];
  let cursor = 1;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i] ?? 0;
    if (weights[i] === 0) {
      dropped.push(i);
      continue;
    }
    if (count <= 0) {
      dropped.push(i);
      continue;
    }
    if (cursor > die) {
      dropped.push(i);
      continue;
    }
    const hi = Math.min(die, cursor + count - 1);
    const weight = weights[i] ?? 0;
    ranges.push({ range: [cursor, hi], index: i, weight });
    if (hi - cursor + 1 > Math.max(1, Math.ceil(exact[i] ?? 0)))
      repeated.push(i);
    cursor = hi + 1;
  }
  // If the hand-outs pushed past the die, the last rows lose their space; tell the GM.
  if (cursor <= die) {
    warnings.push(
      `The ladder ends at ${cursor - 1}; rows after it are unreachable.`,
    );
  }
  return { ranges, total, dropped, repeated, scaled, warnings };
}

const trim = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(1);

/** The ladder a table draws on: weighted uses the compiled ranges, dice uses the stored ones. */
export function rangesFor(
  entries: ReadonlyArray<EncounterEntry>,
): CompiledRange[] {
  return weightsToRanges(entries).ranges;
}

/**
 * The stored `[lo,hi]` ranges of a dice table, validated and de-overlapped in order. Returns the
 * entries in range order with their own ranges kept, so a table written out of order still draws
 * the way its author intended.
 */
export interface DiceRange {
  range: [number, number];
  index: number;
}

export function diceRanges(
  entries: ReadonlyArray<Pick<EncounterEntry, "range">>,
  die: number,
): DiceRange[] {
  const out: DiceRange[] = [];
  for (let i = 0; i < entries.length; i++) {
    const r = entries[i]?.range;
    if (!r) continue;
    const lo = Math.max(1, Math.min(die, Math.trunc(r[0])));
    const hi = Math.max(lo, Math.min(die, Math.trunc(r[1])));
    out.push({ range: [lo, hi], index: i });
  }
  // Ordered by lower bound, then by the author's own order: an overlap resolves to the entry
  // that was written further up the table, which is what a GM reading their own table expects.
  return out.sort((a, b) => a.range[0] - b.range[0] || a.index - b.index);
}

/** The die size of a formula's first term (`2d6+1` → 6; `d20` → 20); 100 when unreadable. */
export function dieSizeOf(formula: string | undefined): number {
  const m = /(\d*)d(\d+)/i.exec(formula ?? "");
  return m ? Math.max(2, Math.min(1_000, Number(m[2]))) : WEIGHT_LADDER_DIE;
}

/** Which entry a rolled die lands on (null = nothing: a gap the author left open). */
export function entryForRoll(
  ranges: ReadonlyArray<CompiledRange>,
  roll: number,
): number | null {
  for (const r of ranges) {
    if (roll >= r.range[0] && roll <= r.range[1]) return r.index;
  }
  return null;
}

// ─── tags ────────────────────────────────────────────────────────────────────

/**
 * The activation tags, defaulted ON. **A missing field means `true`**, which is what makes the
 * requirement's "by default all should be ON" true for tables written by an older slice, by a
 * hand-edited world file, or by a GM who only unticked the one tag they cared about.
 */
export const ALL_TAGS_ON: EncounterTags = {
  day: true,
  night: true,
  entering: true,
  moving: true,
  exploring: true,
  fighting: true,
};

export const TAG_KEYS: ReadonlyArray<keyof EncounterTags> = [
  "day",
  "night",
  "entering",
  "moving",
  "exploring",
  "fighting",
];

export function encounterTagsOf(table: {
  tags?: Partial<EncounterTags> | null;
}): EncounterTags {
  const tags = table.tags ?? {};
  return {
    day: tags.day !== false,
    night: tags.night !== false,
    entering: tags.entering !== false,
    moving: tags.moving !== false,
    exploring: tags.exploring !== false,
    fighting: tags.fighting !== false,
  };
}

/** The GM's tag edit (only the keys they touched). */
export function withTags(
  tags: EncounterTags,
  patch: Partial<EncounterTags>,
): EncounterTags {
  return { ...ALL_TAGS_ON, ...tags, ...patch };
}

// ─── table validation ────────────────────────────────────────────────────────

export interface EncounterTableCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Die the table rolls: `1d100` for weighted, the formula's own die for dice. */
  die: number;
  ranges: CompiledRange[];
}

/**
 * Everything the panel and the draw path want to know about a table before it is used, in one
 * call: mode, formula readability, range/weight coverage and the two warnings a GM can act on
 * (rows that cannot be reached, entries that point at something that no longer exists is a
 * *host* check, not this one — refs are validated where they are drawn).
 */
export function validateEncounterTable(
  table: EncounterTableDocument,
): EncounterTableCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries = Array.isArray(table.entries) ? table.entries : [];
  if (entries.length === 0) errors.push("The table has no entries.");
  if (table.mode === "weighted") {
    const compiled = weightsToRanges(entries);
    warnings.push(...compiled.warnings);
    if (compiled.ranges.length === 0)
      errors.push("No entry has a weight above zero.");
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      die: WEIGHT_LADDER_DIE,
      ranges: compiled.ranges,
    };
  }
  const formula = (table.formula ?? "").trim();
  if (!/^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i.test(formula)) {
    errors.push(
      `Formula "${table.formula}" is not a dice expression like 1d20 or 2d6+1.`,
    );
  }
  const die = dieSizeOf(formula);
  // A dice range is reported in the compiled shape (`weight: 0`) so callers have one type to
  // read, whichever mode the table is in.
  const ranges: CompiledRange[] = diceRanges(entries, die).map((r) => ({
    ...r,
    weight: 0,
  }));
  if (ranges.length === 0) errors.push("No entry has a dice range.");
  const gaps: number[] = [];
  let expect = 1;
  for (const r of ranges) {
    if (r.range[0] > expect + 1) gaps.push(expect + 1);
    expect = Math.max(expect, r.range[1] + 1);
  }
  if (gaps.length > 0)
    warnings.push(`${gaps.length} roll(s) land on no entry (e.g. ${gaps[0]}).`);
  if (expect <= die) warnings.push(`Rolls ${expect}–${die} land on no entry.`);
  return { ok: errors.length === 0, errors, warnings, die, ranges };
}

/** What one draw produced: the entry, the die it was read from, and the raw roll. */
export interface EncounterDraw {
  entry: EncounterEntry;
  index: number;
  roll: number;
  die: number;
  /** The rolled formula's text, for the chat card. */
  formula: string;
}

/** One entry as JSON (the panel's copy/paste format and the world file's own shape). */
export function entryToJson(entry: EncounterEntry): Record<string, Json> {
  return {
    weight: entry.weight,
    ...(entry.range ? { range: [entry.range[0], entry.range[1]] } : {}),
    text: entry.text,
    count: entry.count,
    refs: entry.refs.map((r) =>
      r.kind === "compendium"
        ? { kind: "compendium", packId: r.packId, entryId: r.entryId }
        : { kind: "actor", actorId: r.actorId },
    ),
  };
}

// ─── percentages, mode conversion and paste (plan §5.4) ──────────────────────

/**
 * Each entry's share of the ladder, as a percentage of the whole, in entry order.
 *
 * This is the number the wizard shows in its `%` column and its bar, and it is *derived from the
 * compiled ladder* rather than from the raw weights: when a GM types 30/30/30 the ladder is
 * 34/33/33, and showing "30 %" beside a row that rolls 34 % of the time would be the editor
 * lying about its own table. `shares` therefore always sums to exactly 100 (when anything has a
 * weight at all) — no rounding drift, because it counts faces, not weights.
 */
export function rowShares(
  entries: ReadonlyArray<{ weight: number }>,
  die = WEIGHT_LADDER_DIE,
): number[] {
  const shares = entries.map(() => 0);
  const compiled = weightsToRanges(entries, die);
  for (const range of compiled.ranges) {
    if (range.index < 0 || range.index >= shares.length) continue;
    const faces = range.range[1] - range.range[0] + 1;
    shares[range.index] = (faces / die) * 100;
  }
  return shares;
}

/** The same shares, rounded to whole percentages that still read as a total of 100. */
export function rowPercents(
  entries: ReadonlyArray<{ weight: number }>,
  die = WEIGHT_LADDER_DIE,
): number[] {
  const shares = rowShares(entries, die);
  const percents = shares.map((s) => Math.round(s));
  const drift = die === 100 ? 100 - percents.reduce((a, b) => a + b, 0) : 0;
  if (drift !== 0) {
    // Hand the drift to the row that owns the largest share — the row a reader would not
    // notice a point moving on, and never a row with no share at all.
    let biggest = -1;
    for (let i = 0; i < shares.length; i++) {
      if ((shares[i] ?? 0) <= 0) continue;
      if (biggest === -1 || (shares[i] ?? 0) > (shares[biggest] ?? 0))
        biggest = i;
    }
    if (biggest >= 0) percents[biggest] = (percents[biggest] ?? 0) + drift;
  }
  return percents;
}

/** `1d20`, `d20`, `d100` — a **flat** die whose faces are equally likely (single-term only). */
const FLAT_DIE = /^\s*(\d*)d(\d+)\s*$/i;
/** Any dice expression the wizard may *store*, even one it cannot read as percentages. */
const ANY_FORMULA = /^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i;

export interface ModeConversion {
  ok: boolean;
  /** Why the conversion was refused — shown to the GM in these words. */
  error: string | null;
  /** The converted rows (empty when refused). */
  entries: EncounterEntry[];
  /** The formula a converted table should carry (`1d100`). */
  formula: string;
  /** Notes worth showing beside the result (a re-rounding, a dropped row). */
  notes: string[];
}

/**
 * **Dice → weighted, losslessly or not at all** (plan §5.4).
 *
 * A flat die (`1d20`, `d100`) has a percentage reading: a row covering `k` faces of `N` is
 * `100k/N` percent, and the ladder compiler turns those percentages back into the very same
 * ranges. Anything else — `2d6+1`, `3d6` — has no percentage reading at all, because its faces
 * are not equally likely, and the refusal says so in those words rather than inventing weights
 * that would quietly change what the table rolls.
 */
export function convertTableToWeighted(
  doc: Pick<EncounterTableDocument, "formula" | "entries">,
): ModeConversion {
  const formula = (doc.formula ?? "").trim();
  const flat = FLAT_DIE.exec(formula);
  if (!flat) {
    return {
      ok: false,
      error:
        `"${doc.formula}" has no percentage reading — only a single flat die like 1d20 can be ` +
        "expressed as weights. Leave the table in dice mode, or rewrite the formula as 1d100.",
      entries: [],
      formula,
      notes: [],
    };
  }
  const count = flat[1] ?? "";
  if (count !== "" && count !== "1") {
    // `2d6` looks like a flat die by shape but is not one: its middle faces are likelier than
    // its ends, so there is no percentage reading to convert to (§5.4).
    return {
      ok: false,
      error:
        `"${doc.formula}" rolls several dice, so its faces are not equally likely — it has no ` +
        "percentage reading. Only a single flat die like 1d20 can be expressed as weights.",
      entries: [],
      formula,
      notes: [],
    };
  }
  const die = dieSizeOf(formula);
  const notes: string[] = [];
  const entries: EncounterEntry[] = [];
  for (const entry of doc.entries ?? []) {
    const range = entry.range;
    if (!range) {
      // A row with no range keeps a nominal weight of 1 so it is not silently unreachable; the
      // compiler will tell the GM if the weights no longer add up.
      notes.push(`"${entry.text}" had no range: it is kept at weight 1.`);
      entries.push({ ...entry, weight: 1 });
      continue;
    }
    const lo = Math.max(1, Math.min(die, Math.trunc(range[0])));
    const hi = Math.max(lo, Math.min(die, Math.trunc(range[1])));
    entries.push({ ...entry, weight: ((hi - lo + 1) / die) * 100 });
  }
  const compiled = weightsToRanges(entries);
  notes.push(...compiled.warnings);
  return { ok: true, error: null, entries, formula: "", notes };
}

/**
 * **Weighted → dice, as `1d100` with these ranges** (plan §5.4): the ladder the compiler already
 * computed *is* the dice table, so a GM who wants a formula to paste into a chat macro gets the
 * exact ladder their weights describe rather than an approximation of it.
 */
export function convertTableToDice(
  doc: Pick<EncounterTableDocument, "entries">,
): ModeConversion {
  const compiled = weightsToRanges(doc.entries ?? []);
  if (compiled.ranges.length === 0) {
    return {
      ok: false,
      error: "No row has a weight, so there is no ladder to express as dice.",
      entries: [],
      formula: "",
      notes: [],
    };
  }
  const byIndex = new Map(compiled.ranges.map((r) => [r.index, r.range]));
  const entries: EncounterEntry[] = (doc.entries ?? []).map((entry, index) => {
    const range = byIndex.get(index) ?? entry.range;
    return { ...entry, ...(range ? { range } : {}), weight: 0 };
  });
  const notes = [
    `Expressed as 1d${WEIGHT_LADDER_DIE}; the ranges are the compiled ladder.`,
  ];
  if (compiled.dropped.length > 0)
    notes.push(
      `${compiled.dropped.length} row(s) had no ladder space and keep their old range.`,
    );
  return {
    ok: true,
    error: null,
    entries,
    formula: `1d${WEIGHT_LADDER_DIE}`,
    notes,
  };
}

/** Is this formula one the wizard can store at all? (The editor's own Save gate.) */
export function formulaIsReadable(formula: string): boolean {
  return ANY_FORMULA.test(formula ?? "");
}

export interface PasteResult {
  entries: EncounterEntry[];
  /** Lines that could not be read, with their 1-based line numbers. */
  skipped: Array<{ line: number; text: string }>;
}

/**
 * **Paste rows** (plan §5.4): one row per line, `weight, text, count` or `text`, comma- or
 * tab-separated, with an optional trailing `@pack/entry` or `@actor` reference.
 *
 * The accepted shapes, in the order they are tried:
 * - `30, Goblin bandits, 2` — weight (or dice range `1-5`), text, count;
 * - `Goblin bandits` — a bare line becomes a row with the given default weight;
 * - `30, Wolves, 1, @bestiary/wolf` — a ref appended as `@<pack>/<entry>`.
 *
 * Rows that do not parse are *reported*, never dropped silently — a paste that half-works is the
 * one case where a GM cannot see what happened.
 */
export function parsePastedRows(
  text: string,
  options: { mode: "dice" | "weighted"; defaultWeight?: number } = {
    mode: "weighted",
  },
): PasteResult {
  const entries: EncounterEntry[] = [];
  const skipped: Array<{ line: number; text: string }> = [];
  const lines = (text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "") continue;
    // A spreadsheet paste is TSV; a hand-written line is CSV. When the line carries a tab, that
    // tab is the separator and commas belong to the text ("Wolves, hunting" is one cell).
    const cells = (raw.includes("\t") ? raw.split("\t") : raw.split(",")).map(
      (c) => c.trim(),
    );
    const first = cells[0] ?? "";
    let weight =
      options.defaultWeight ?? (options.mode === "weighted" ? 10 : 0);
    let range: [number, number] | undefined;
    let rest = cells;
    const rangeMatch = /^(\d+)\s*[-–]\s*(\d+)$/.exec(first);
    const numberMatch = /^\d+(?:\.\d+)?$/.exec(first);
    if (rangeMatch) {
      range = [Number(rangeMatch[1]), Number(rangeMatch[2])];
      rest = cells.slice(1);
    } else if (numberMatch && cells.length > 1) {
      // The same leading number means different things per mode: a weight in a weighted table, a
      // die face in a dice table (`7, Wolf` is the row for a roll of 7).
      if (options.mode === "dice")
        range = [Number(numberMatch[0]), Number(numberMatch[0])];
      else weight = Number(numberMatch[0]);
      rest = cells.slice(1);
    }
    let text = (rest[0] ?? "").trim();
    let count = 1;
    let refToken: string | null = null;
    for (const cell of rest.slice(1)) {
      if (cell === "") continue;
      if (cell.startsWith("@")) {
        refToken = cell.slice(1);
        continue;
      }
      const n = Number(cell);
      if (Number.isFinite(n) && n > 0) {
        count = Math.max(1, Math.trunc(n));
        continue;
      }
      text = text === "" ? cell : `${text} ${cell}`;
    }
    if (text === "") {
      skipped.push({ line: i + 1, text: raw });
      continue;
    }
    const refs: EncounterEntry["refs"] = [];
    if (refToken) {
      const slash = refToken.indexOf("/");
      if (slash > 0)
        refs.push({
          kind: "compendium",
          packId: refToken.slice(0, slash),
          entryId: refToken.slice(slash + 1),
        });
      else refs.push({ kind: "actor", actorId: refToken });
    }
    entries.push({
      weight,
      ...(range ? { range } : {}),
      text,
      count,
      refs,
    });
  }
  return { entries, skipped };
}
