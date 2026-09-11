/**
 * P5/C04 (D-155) — the spellbook surface: persisted slot ledger + prepared
 * list, and the authorized Ops that spend/restore slots and manage the
 * preparation.
 *
 * All rules arithmetic stays in `packages/pf1e/spellSlots` (Table 1-3 bonus
 * spells, the `10 + spell level` minimum, prepared/spontaneous semantics —
 * verified in D-152). This module only maps an actor document onto that layer
 * and builds FlatDiff Ops, following the Weapons-tab edit contract (D-117):
 * ownership gates, named errors, dotted-path writes that preserve siblings,
 * array replacement for the structured prepared list.
 *
 * Overuse is WARNED, never refused (C04: "warnings, not hard enforcement").
 * Slot state is daily ledger STATE — resting/reset automation belongs to P7
 * recovery, not here; until then Restore is the GM's manual reset.
 */
import type { ActorDocument, Json } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { can } from "../../core/permissions";
import {
  MAX_PREPARED_SPELLS,
  type PF1eDerived,
} from "../../packages/pf1e/actor";
import {
  PF1E_SLOT_LEVEL_COUNT,
  PF1E_SLOT_LEVELS,
  resolveSpellSlotBudget,
  reviewPreparation,
  slotLedgerView,
  spendSlot,
  type PF1eSlotBudget,
  type PF1eSlotLedger,
  type PF1eSlotLedgerView,
} from "../../packages/pf1e/spellSlots";
import { isPF1eActor, sheetRecord } from "./pf1eSheetModel";

export interface PF1ePreparedRow {
  name: string;
  level: number;
  slotLevel: number;
  expended: boolean;
}

export interface PF1eSpellbookView {
  /** False when the actor has no spellcasting data — the tab stays hidden. */
  casting: boolean;
  mode: "prepared" | "spontaneous";
  /** Levels 0–9 with spent/total including Table 1-3 bonuses. */
  ledger: PF1eSlotLedgerView;
  /** The Table 1-3-resolved budget; the tab shows its base/bonus split. */
  budget: PF1eSlotBudget;
  prepared: PF1ePreparedRow[];
  /** reviewPreparation warnings (over-preparation, slotless levels). */
  preparationWarnings: string[];
}

function authoredSpells(actor: ActorDocument): Record<string, Json> | null {
  const pf1e = sheetRecord((actor.system as Record<string, unknown>).pf1e);
  return pf1e ? sheetRecord(pf1e.spells) : null;
}

function ledgerFrom(spells: Record<string, Json> | null): PF1eSlotLedger {
  const spent = new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0);
  const used = spells ? sheetRecord(spells.slotsUsed) : null;
  if (used) {
    for (const level of PF1E_SLOT_LEVELS) {
      const v = used[level];
      if (typeof v === "number" && Number.isInteger(v) && v >= 0)
        spent[level] = v;
    }
  }
  return { spent };
}

function budgetFrom(derived: PF1eDerived): PF1eSlotBudget {
  const keyAbilityScore = derived.casting
    ? (derived.abilities[derived.spellKeyAbility] ?? null)
    : null;
  return resolveSpellSlotBudget({
    baseSlots: derived.spellSlots.slice(0, PF1E_SLOT_LEVEL_COUNT),
    keyAbilityScore,
  });
}

function preparedRows(spells: Record<string, Json> | null): PF1ePreparedRow[] {
  const raw = spells?.prepared;
  if (!Array.isArray(raw)) return [];
  const out: PF1ePreparedRow[] = [];
  for (const entry of raw) {
    const rec = sheetRecord(entry);
    if (!rec) continue;
    if (typeof rec.name !== "string" || rec.name.trim() === "") continue;
    if (!Number.isInteger(rec.level)) continue;
    out.push({
      name: rec.name,
      level: rec.level as number,
      slotLevel: Number.isInteger(rec.slotLevel)
        ? (rec.slotLevel as number)
        : (rec.level as number),
      expended: rec.expended === true,
    });
  }
  return out;
}

export function pf1eSpellbookView(
  actor: ActorDocument,
  derived: PF1eDerived,
): PF1eSpellbookView {
  const spells = isPF1eActor(actor) ? authoredSpells(actor) : null;
  const ledger = ledgerFrom(spells);
  const budget = budgetFrom(derived);
  const prepared = preparedRows(spells);
  const preparationWarnings =
    derived.spellMode === "prepared"
      ? reviewPreparation({
          spells: prepared.map((p) => ({
            name: p.name,
            level: p.level,
            slotLevel: p.slotLevel,
          })),
          budget,
        }).warnings
      : [];
  return {
    casting: derived.casting,
    mode: derived.spellMode,
    ledger: slotLedgerView(budget, ledger, preparedByLevel(prepared)),
    budget,
    prepared,
    preparationWarnings,
  };
}

function preparedByLevel(rows: PF1ePreparedRow[]): number[] | null {
  if (rows.length === 0) return null;
  const out = new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0);
  for (const row of rows) {
    if (row.slotLevel >= 0 && row.slotLevel < PF1E_SLOT_LEVEL_COUNT)
      out[row.slotLevel] = (out[row.slotLevel] ?? 0) + 1;
  }
  return out;
}

export type PF1eSpellbookEdit =
  | { kind: "spend"; level: number }
  | { kind: "restore"; level: number }
  | { kind: "prepare"; name: string; level: number; slotLevel?: number }
  | { kind: "preparedRemove"; index: number }
  | { kind: "preparedToggle"; index: number };

export interface PF1eSpellbookEditResult {
  ops: Op[];
  error: string | null;
  /** Over-budget spend and similar MVP warnings (allowed, reported). */
  warning: string | null;
}

export function pf1eSpellbookEdit(
  actor: ActorDocument,
  derived: PF1eDerived,
  user: PermissionUser | null,
  edit: PF1eSpellbookEdit,
): PF1eSpellbookEditResult {
  const fail = (error: string): PF1eSpellbookEditResult => ({
    ops: [],
    error,
    warning: null,
  });
  if (!isPF1eActor(actor) || !user || !can(user, "update", actor, "actors"))
    return fail("You do not own this PF1e actor.");
  const spells = authoredSpells(actor);
  if (!spells)
    return fail("This actor has no spellcasting data (system.pf1e.spells).");
  const budget = budgetFrom(derived);
  const ledger = ledgerFrom(spells);

  if (edit.kind === "spend" || edit.kind === "restore") {
    const level = edit.level;
    if (!Number.isInteger(level) || level < 0 || level >= PF1E_SLOT_LEVEL_COUNT)
      return fail("Spell level must be an integer 0–9.");
    const spentNow = ledger.spent[level] ?? 0;
    if (edit.kind === "restore") {
      if (spentNow <= 0) return { ops: [], error: null, warning: null };
      return {
        ops: [slotOp(actor, spells, level, spentNow - 1)],
        error: null,
        warning: null,
      };
    }
    const spend = spendSlot(ledger, budget, level);
    if (!spend.ok) {
      const msg = spend.issues[0]?.message ?? "This slot cannot be spent.";
      return fail(msg);
    }
    return {
      ops: [slotOp(actor, spells, level, ledger.spent[level] ?? spentNow + 1)],
      error: null,
      warning: spend.warning,
    };
  }

  // Prepared-list edits apply to prepared casters only.
  if (derived.spellMode !== "prepared")
    return fail("Spontaneous casters keep no prepared list.");
  const rows = preparedRows(spells);

  if (edit.kind === "prepare") {
    const name = edit.name.trim();
    if (name === "") return fail("Name the spell before preparing it.");
    if (name.length > 120)
      return fail("Spell names are at most 120 characters.");
    if (!Number.isInteger(edit.level) || edit.level < 0 || edit.level > 9)
      return fail("Spell level must be an integer 0–9.");
    if (
      edit.slotLevel !== undefined &&
      (!Number.isInteger(edit.slotLevel) ||
        edit.slotLevel < 0 ||
        edit.slotLevel > 9)
    )
      return fail("Slot level must be an integer 0–9.");
    if (rows.length >= MAX_PREPARED_SPELLS)
      return fail(
        `At most ${MAX_PREPARED_SPELLS} prepared spells are supported.`,
      );
    const row: Record<string, Json> = { name, level: edit.level };
    if (edit.slotLevel !== undefined) row.slotLevel = edit.slotLevel;
    const next = [...rawPrepared(spells), row];
    return {
      ops: [
        {
          kind: "update",
          ref: { coll: "actors", id: actor._id },
          diff: { "system.pf1e.spells.prepared": next },
        },
      ],
      error: null,
      warning: null,
    };
  }

  if (!Number.isInteger(edit.index) || edit.index < 0 || !rows[edit.index])
    return fail("That prepared spell no longer exists.");
  const next = rawPrepared(spells).map((entry, i) => {
    if (i !== edit.index || !sheetRecord(entry)) return entry;
    if (edit.kind === "preparedToggle") {
      const rec = sheetRecord(entry) as Record<string, Json>;
      return { ...rec, expended: rec.expended !== true };
    }
    return entry;
  });
  const filtered =
    edit.kind === "preparedRemove"
      ? next.filter((_, i) => i !== edit.index)
      : next;
  return {
    ops: [
      {
        kind: "update",
        ref: { coll: "actors", id: actor._id },
        diff: { "system.pf1e.spells.prepared": filtered },
      },
    ],
    error: null,
    warning: null,
  };
}

/** Raw authored prepared array (unknown fields preserved on row edits). */
function rawPrepared(spells: Record<string, Json>): Json[] {
  return Array.isArray(spells.prepared) ? [...(spells.prepared as Json[])] : [];
}

/**
 * A slot write: dotted path when `slotsUsed` already exists (preserving
 * sibling levels), full materialization otherwise.
 */
function slotOp(
  actor: ActorDocument,
  spells: Record<string, Json>,
  level: number,
  value: number,
): Op {
  const diff: Record<string, Json> = sheetRecord(spells.slotsUsed)
    ? { [`system.pf1e.spells.slotsUsed.${level}`]: value }
    : {
        "system.pf1e.spells.slotsUsed": Object.fromEntries(
          PF1E_SLOT_LEVELS.map((l) => [String(l), l === level ? value : 0]),
        ),
      };
  return { kind: "update", ref: { coll: "actors", id: actor._id }, diff };
}
