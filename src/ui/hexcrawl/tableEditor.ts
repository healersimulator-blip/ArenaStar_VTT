/**
 * **The encounter-table editor's model** (Phase 3, plan §5.4) — pure, DOM-free, unit-tested.
 *
 * The wizard is *a form over this file*: every decision about what a keystroke means (a weight
 * typed in, a mode switched, rows pasted, a table attached to a hex) is made here so it can be
 * tested in Node and so `EncounterTableWizard.svelte` stays markup. The split follows
 * `hexContextMenu.ts`: the component decides what to show, this decides what the store gets.
 *
 * Two rules the model exists to hold:
 *
 * - **Draft → ops is a diff.** Saving an unchanged table submits nothing (`updateEncounterTableOps`
 *   returns `[]`), so a save button pressed twice costs no sequence number.
 * - **The live `%` column is the compiled ladder, not the raw weight.** A GM who types 30/30/30
 *   rolls 34/33/33; showing them "30 %" would be the editor lying about its own table
 *   (`rowPercents` counts faces).
 */
import type {
  CellDocument,
  EncounterEntry,
  EncounterRef,
  EncounterTableDocument,
  EncounterTags,
  SceneDocument,
} from "../../core/documents";
import type { Op } from "../../core/ops";
import {
  convertTableToDice,
  convertTableToWeighted,
  type EncounterRoll,
  drawEncounter,
  encounterTagsOf,
  parsePastedRows,
  rowPercents,
  ALL_TAGS_ON,
  validateEncounterTable,
} from "../../core/hexcrawl";
import type { EncounterTableCheck } from "../../core/hexcrawl/tables";
import {
  createEncounterTableOps,
  updateEncounterTableOps,
} from "../../core/hexcrawl/tableOps";
import { createCellOps, setCellTablesOps } from "../../core/hexcrawl/scene";

/**
 * A table being edited. `id === null` means "not in the world yet" — the wizard mints the id on
 * save so that an abandoned draft never leaves a document behind.
 */
export interface TableDraft {
  id: string | null;
  name: string;
  mode: "dice" | "weighted";
  formula: string;
  entries: EncounterEntry[];
  tags: EncounterTags;
  /** The battle scene to offer when this table resolves (§5.6); `""` = none. */
  sceneId: string;
  /** `null` = the default (rest of the current phase). */
  cooldownSeconds: number | null;
}

/** One row of the table as the wizard paints it: the entry plus the numbers derived from it. */
export interface RowView {
  index: number;
  entry: EncounterEntry;
  /** Share of the ladder, whole percent (`0` when the row has no ladder space). */
  percent: number;
  /** The dice range a weighted table compiled to, or the row's own range in dice mode. */
  range: [number, number] | null;
  /** One line describing the row's refs, for the entry cell's second line. */
  refLabel: string;
}

export interface DraftView {
  rows: RowView[];
  /** Sum of the whole-percent column; `100` unless every row is weightless. */
  totalPercent: number;
  check: EncounterTableCheck;
  /** Sum of the raw weights (dice mode shows the ranges instead). */
  totalWeight: number;
}

/** A blank table: weighted (the requirement's own model), tags all on, one empty row. */
export function emptyTableDraft(): TableDraft {
  return {
    id: null,
    name: "",
    mode: "weighted",
    formula: "",
    entries: [blankEntry()],
    tags: { ...ALL_TAGS_ON },
    sceneId: "",
    cooldownSeconds: null,
  };
}

export function blankEntry(): EncounterEntry {
  return { weight: 10, text: "", count: 1, refs: [] };
}

/** A stored document as a draft (the wizard's Edit path). */
export function draftOf(doc: EncounterTableDocument): TableDraft {
  return {
    id: doc._id,
    name: doc.name,
    mode: doc.mode,
    formula: doc.mode === "dice" ? (doc.formula ?? "") : "",
    entries: (doc.entries ?? []).map((e) => ({
      ...e,
      refs: (e.refs ?? []).map((r) => ({ ...r })),
    })),
    tags: encounterTagsOf(doc),
    sceneId: doc.sceneId ?? "",
    cooldownSeconds:
      typeof doc.cooldownSeconds === "number" ? doc.cooldownSeconds : null,
  };
}

/** The draft as the document `validateEncounterTable`/`drawEncounter` expect. */
export function draftAsDocument(draft: TableDraft): EncounterTableDocument {
  return {
    _id: draft.id ?? "draft",
    type: "encounterTable",
    name: draft.name.trim() || "Encounter table",
    ownership: { default: 0, gm: 3 },
    flags: {},
    system: {},
    mode: draft.mode,
    formula: draft.mode === "dice" ? draft.formula : "",
    entries: draft.entries,
    tags: draft.tags,
    ...(draft.sceneId ? { sceneId: draft.sceneId } : {}),
    ...(draft.cooldownSeconds !== null
      ? { cooldownSeconds: draft.cooldownSeconds }
      : {}),
  };
}

/** Everything the wizard reads off the draft. */
export function draftView(draft: TableDraft): DraftView {
  const check = validateEncounterTable(draftAsDocument(draft));
  const percents =
    draft.mode === "weighted"
      ? rowPercents(draft.entries)
      : draft.entries.map(() => 0);
  const weighted =
    draft.mode === "weighted"
      ? check.ranges
      : check.ranges.map((r) => ({ ...r, weight: 0 }));
  const rows: RowView[] = draft.entries.map((entry, index) => {
    const compiled = weighted.find((r) => r.index === index);
    return {
      index,
      entry,
      percent: percents[index] ?? 0,
      range: compiled ? compiled.range : (entry.range ?? null),
      refLabel: refLabelOf(entry),
    };
  });
  const totalPercent = rows.reduce((sum, row) => sum + row.percent, 0);
  const totalWeight = draft.entries.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.weight) ? entry.weight : 0),
    0,
  );
  return { rows, totalPercent, check, totalWeight };
}

/** `▸ Bestiary: Wolf` / `▸ World: Diego Montoya` / `2 refs`. */
export function refLabelOf(entry: EncounterEntry): string {
  const refs = entry.refs ?? [];
  if (refs.length === 0) return "";
  return refs
    .map((ref: EncounterRef) =>
      ref.kind === "compendium"
        ? `▸ ${ref.packId}/${ref.entryId}`
        : `▸ ${ref.actorId}`,
    )
    .join(" ");
}

// ─── editing one row ─────────────────────────────────────────────────────────

export function withRowText(
  draft: TableDraft,
  index: number,
  text: string,
): TableDraft {
  return replaceRow(draft, index, (entry) => ({ ...entry, text }));
}

/** A weight is any finite number ≥ 0; a blank or nonsense field becomes 0 (never NaN — that
 * would poison the ladder and the `%` column with it). */
export function withRowWeight(
  draft: TableDraft,
  index: number,
  raw: string,
): TableDraft {
  const value = Number(raw);
  const weight = Number.isFinite(value) && value > 0 ? value : 0;
  return replaceRow(draft, index, (entry) => ({ ...entry, weight }));
}

export function withRowCount(
  draft: TableDraft,
  index: number,
  raw: string,
): TableDraft {
  const value = Number(raw);
  const count = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1;
  return replaceRow(draft, index, (entry) => ({ ...entry, count }));
}

/** Dice mode: `3-5`, `7`, blank (no range at all). */
export function withRowRange(
  draft: TableDraft,
  index: number,
  raw: string,
): TableDraft {
  const text = raw.trim();
  if (text === "") {
    // A blank range field means "this row has no dice range" — the key is *removed*, not set to
    // `undefined`, because the document is validated for gaps by whether a range exists.
    return replaceRow(draft, index, (entry) => {
      const cleared: typeof entry = { ...entry };
      delete cleared.range;
      return cleared;
    });
  }
  const single = /^(\d+)$/.exec(text);
  const pair = /^(\d+)\s*[-–]\s*(\d+)$/.exec(text);
  const range: [number, number] | null = single
    ? [Number(single[1]), Number(single[1])]
    : pair
      ? [Number(pair[1]), Number(pair[2])]
      : null;
  if (!range) return draft;
  const ordered: [number, number] = [
    Math.max(1, Math.min(range[0], range[1])),
    Math.max(range[0], range[1]),
  ];
  return replaceRow(draft, index, (entry) => ({ ...entry, range: ordered }));
}

export function addRow(draft: TableDraft): TableDraft {
  const weight = draft.mode === "weighted" ? 10 : 0;
  return { ...draft, entries: [...draft.entries, { ...blankEntry(), weight }] };
}

export function removeRow(draft: TableDraft, index: number): TableDraft {
  return { ...draft, entries: draft.entries.filter((_, i) => i !== index) };
}

export function moveRow(
  draft: TableDraft,
  index: number,
  delta: number,
): TableDraft {
  const to = index + delta;
  if (to < 0 || to >= draft.entries.length) return draft;
  const entries = [...draft.entries];
  const [row] = entries.splice(index, 1);
  if (!row) return draft;
  entries.splice(to, 0, row);
  return { ...draft, entries };
}

/** Attach / replace the entry's refs (`[]` = pure text). */
export function withRowRefs(
  draft: TableDraft,
  index: number,
  refs: EncounterEntry["refs"],
): TableDraft {
  return replaceRow(draft, index, (entry) => ({ ...entry, refs }));
}

/** Set / clear the linked battle scene. */
export function withScene(draft: TableDraft, sceneId: string): TableDraft {
  return { ...draft, sceneId };
}

/** `0`/`null` = the default (rest of the current phase). */
export function withCooldown(
  draft: TableDraft,
  seconds: number | null,
): TableDraft {
  return {
    ...draft,
    cooldownSeconds:
      seconds === null || !Number.isFinite(seconds) || seconds <= 0
        ? null
        : Math.trunc(seconds),
  };
}

export function withTags(
  draft: TableDraft,
  patch: Partial<EncounterTags>,
): TableDraft {
  return { ...draft, tags: { ...draft.tags, ...patch } };
}

function replaceRow(
  draft: TableDraft,
  index: number,
  fn: (entry: EncounterEntry) => EncounterEntry,
): TableDraft {
  const entry = draft.entries[index];
  if (!entry) return draft;
  const entries = [...draft.entries];
  entries[index] = fn(entry);
  return { ...draft, entries };
}

// ─── mode switching (§5.4: lossless in one direction only) ───────────────────

export interface ModeChange {
  draft: TableDraft;
  /** Why the switch was refused, in the GM's words (null = it happened). */
  error: string | null;
  /** What the conversion did that the GM should know about. */
  notes: string[];
}

/**
 * Switch the roll type. Dice → weighted is refused outright when the formula has no percentage
 * reading (`2d6+1`), and the refusal quotes the formula — nothing is invented (§5.4).
 */
export function switchMode(
  draft: TableDraft,
  mode: "dice" | "weighted",
): ModeChange {
  if (mode === draft.mode) return { draft, error: null, notes: [] };
  if (mode === "weighted") {
    const converted = convertTableToWeighted(draft);
    if (!converted.ok) return { draft, error: converted.error, notes: [] };
    return {
      draft: {
        ...draft,
        mode: "weighted",
        formula: "",
        entries: converted.entries,
      },
      error: null,
      notes: converted.notes,
    };
  }
  const converted = convertTableToDice(draft);
  if (!converted.ok) return { draft, error: converted.error, notes: [] };
  return {
    draft: {
      ...draft,
      mode: "dice",
      formula: converted.formula,
      entries: converted.entries,
    },
    error: null,
    notes: converted.notes,
  };
}

/** Paste rows (`weight, text, count`, TSV or CSV) — the unreadable lines are reported back. */
export function pasteRows(
  draft: TableDraft,
  text: string,
): ModeChange & { skipped: number } {
  const parsed = parsePastedRows(text, { mode: draft.mode });
  if (parsed.entries.length === 0) {
    return {
      draft,
      error: "Nothing in the pasted text looked like a table row.",
      notes: [],
      skipped: parsed.skipped.length,
    };
  }
  const filled: EncounterEntry[] = [
    ...draft.entries.filter(
      (e) => e.text.trim() !== "" || (e.refs ?? []).length > 0,
    ),
    ...parsed.entries,
  ];
  return {
    draft: { ...draft, entries: filled },
    error: null,
    notes:
      parsed.skipped.length > 0
        ? [
            `${parsed.skipped.length} line(s) could not be read and were skipped.`,
          ]
        : [],
    skipped: parsed.skipped.length,
  };
}

/** Draw once with the real engine (the wizard's *Test roll*) — nothing is written. */
export function testRoll(
  draft: TableDraft,
  rng: () => number = Math.random,
): EncounterRoll {
  return drawEncounter(draftAsDocument(draft), rng);
}

// ─── saving and attaching ────────────────────────────────────────────────────

export interface SavePlan {
  ops: Op[];
  /** The id the table will live under (minted for a new draft). */
  id: string;
  error: string | null;
}

/**
 * What the Save button submits. A new table plus, when the wizard was opened from a hex, the cell
 * update that attaches it — both in one envelope: the cell already exists, so the host's
 * create-then-reference rule (§Phase 1) does not bite; nothing references the *table* document
 * except the cell's id list, which the host does not resolve.
 */
export function savePlan(
  draft: TableDraft,
  options: {
    mintId: () => string;
    existing?: EncounterTableDocument | null;
    attach?: { scene: SceneDocument; key: string } | null;
  },
): SavePlan {
  const check = validateEncounterTable(draftAsDocument(draft));
  if (!check.ok) {
    return { ops: [], id: draft.id ?? "", error: check.errors.join(" ") };
  }
  const existing = options.existing ?? null;
  const id = existing?._id ?? draft.id ?? options.mintId();
  const ops = existing
    ? updateEncounterTableOps(existing, {
        name: draft.name,
        mode: draft.mode,
        formula: draft.formula,
        entries: draft.entries,
        tags: draft.tags,
        ...(draft.sceneId ? { sceneId: draft.sceneId } : {}),
        ...(draft.cooldownSeconds !== null
          ? { cooldownSeconds: draft.cooldownSeconds }
          : {}),
      })
    : createEncounterTableOps(id, {
        name: draft.name,
        mode: draft.mode,
        formula: draft.formula,
        entries: draft.entries,
        tags: draft.tags,
        ...(draft.sceneId ? { sceneId: draft.sceneId } : {}),
        ...(draft.cooldownSeconds !== null
          ? { cooldownSeconds: draft.cooldownSeconds }
          : {}),
      });
  if (options.attach) {
    ops.push(...attachTableOps(options.attach.scene, options.attach.key, id));
  }
  return { ops, id, error: null };
}

/**
 * Attach a table to a cell without disturbing the ones already there.
 *
 * A hex with **no cell document yet** gets one, because attaching is exactly the first edit a GM
 * makes on a hex nobody has described: the cell is created by this click (the same rule the hex
 * window's text fields follow), not silently dropped — `updateCellOps` has nothing to update and
 * would return `[]`.
 */
export function attachTableOps(
  scene: SceneDocument,
  key: string,
  tableId: string,
): Op[] {
  const cell = cellOf(scene, key);
  if (!cell) {
    return createCellOps(
      scene,
      cellIdOf(
        key,
        (scene.cells ?? []).map((c) => c._id),
      ),
      { key, name: key, tables: [tableId] },
    );
  }
  const current = cell.tables ?? [];
  if (current.includes(tableId)) return [];
  return setCellTablesOps(scene, key, [...current, tableId]);
}

/** `cell-3--2` — readable, and unique because the key is (`cell-` + key with `,` → `-`). */
export function cellIdOf(key: string, taken: readonly string[]): string {
  const base = `cell-${key.replace(/[^0-9a-z]+/gi, "-")}`;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Detach (`[]` ops when it was not attached, so the menu entry can be idempotent). */
export function detachTableOps(
  scene: SceneDocument,
  key: string,
  tableId: string,
): Op[] {
  const cell = cellOf(scene, key);
  const current = cell?.tables ?? [];
  if (!current.includes(tableId)) return [];
  return setCellTablesOps(
    scene,
    key,
    current.filter((id) => id !== tableId),
  );
}

/** The tables a cell can draw from, in authored order (the attach popup's checked set). */
export function attachedTableIds(scene: SceneDocument, key: string): string[] {
  return [...(cellOf(scene, key)?.tables ?? [])];
}

function cellOf(scene: SceneDocument, key: string): CellDocument | null {
  return (scene.cells ?? []).find((c) => c.key === key) ?? null;
}

/** Scenes a table may link as its battle scene (a hexcrawl scene may link any other scene). */
export function battleSceneChoices(
  scenes: ReadonlyArray<{ _id: string; name: string }>,
  excludeId?: string,
): Array<{ id: string; name: string }> {
  return scenes
    .filter((s) => s._id !== excludeId)
    .map((s) => ({ id: s._id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
