/**
 * **Encounter tables as documents** (D-272, plan §5.4) — the ops a table editor writes.
 *
 * A table is a top-level document (`encounterTables`, D-269), not a scene-embedded one, so its
 * ops are the ordinary three: create, update, delete. Nothing here is scene-scoped and nothing
 * needs a parent — which is the point of the collection choice: a "Forest road — day" table
 * outlives the hex it was written for, and several cells attach the same one.
 *
 * Two conveniences the wizard wants and the store cannot infer:
 *
 * - **`updateEncounterTableOps` diffs against the stored document**, field by field, so saving an
 *   untouched table spends no sequence number and an edit writes only what moved. The comparison
 *   is structural on `entries`/`tags` (they are plain JSON), which is exactly what a save button
 *   pressed twice should do.
 * - **`newEncounterTableId`** mints the `_id` from the name, so a world file is readable and two
 *   tables named the same do not collide (the suffix is what makes it unique, not the name).
 */
import type {
  BaseDocument,
  EncounterTableDocument,
  EncounterTags,
  Json,
} from "../documents";
import type { FlatDiff, Op } from "../ops";

/** A wizard-shaped draft: everything a GM can edit, nothing the store owns. */
export interface EncounterTableDraft {
  name: string;
  mode: "dice" | "weighted";
  formula: string;
  entries: EncounterTableDocument["entries"];
  tags: EncounterTags;
  /** The battle scene to copy when an encounter from this table resolves (§5.6). */
  sceneId?: string;
  cooldownSeconds?: number;
}

/** A slug id from the name, with a short random suffix (`forest-road-day-k3f9`). */
export function newEncounterTableId(
  name: string,
  random: () => number = Math.random,
): string {
  const slug =
    (name || "table")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "table";
  const suffix = Math.floor(random() * 0xffffff)
    .toString(36)
    .padStart(4, "0")
    .slice(0, 4);
  return `table-${slug}-${suffix}`;
}

/** The document a new table starts as: weighted (the requirement's own model), tags all on. */
export function newEncounterTableDocument(
  id: string,
  draft: EncounterTableDraft,
): EncounterTableDocument {
  return {
    _id: id,
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
    ...(typeof draft.cooldownSeconds === "number"
      ? { cooldownSeconds: draft.cooldownSeconds }
      : {}),
  };
}

export function createEncounterTableOps(
  id: string,
  draft: EncounterTableDraft,
): Op[] {
  const doc = newEncounterTableDocument(id, draft);
  return [
    { kind: "create", coll: "encounterTables", data: doc as BaseDocument },
  ];
}

/** Only what changed — a save that changes nothing is no ops at all. */
export function updateEncounterTableOps(
  table: EncounterTableDocument,
  draft: EncounterTableDraft,
): Op[] {
  const diff: FlatDiff = {};
  const name = draft.name.trim() || "Encounter table";
  if (name !== table.name) diff["name"] = name;
  if (draft.mode !== table.mode) diff["mode"] = draft.mode;
  const formula = draft.mode === "dice" ? draft.formula : "";
  if (formula !== (table.formula ?? "")) diff["formula"] = formula;
  if (!jsonEqual(table.entries, draft.entries)) {
    diff["entries"] = draft.entries as unknown as Json;
  }
  if (!jsonEqual(table.tags, draft.tags)) {
    diff["tags"] = draft.tags as unknown as Json;
  }
  if ((table.sceneId ?? null) !== (draft.sceneId ?? null)) {
    // A cleared link is a removal, and the store's delete semantics are `-=` on the key
    // (a `delete` op is banned for embedded fields, D-013's rule for a diff).
    diff[draft.sceneId ? "sceneId" : "-=sceneId"] = draft.sceneId ?? null;
  }
  if ((table.cooldownSeconds ?? null) !== (draft.cooldownSeconds ?? null)) {
    diff[
      draft.cooldownSeconds === undefined
        ? "-=cooldownSeconds"
        : "cooldownSeconds"
    ] = draft.cooldownSeconds ?? null;
  }
  if (Object.keys(diff).length === 0) return [];
  return [
    {
      kind: "update",
      ref: { coll: "encounterTables", id: table._id },
      diff,
    },
  ];
}

export function deleteEncounterTableOps(tableId: string): Op[] {
  return [{ kind: "delete", ref: { coll: "encounterTables", id: tableId } }];
}

/** Copy a table under a new id and name (`Duplicate` in the list window). */
export function duplicateEncounterTableOps(
  table: EncounterTableDocument,
  id: string,
  name?: string,
): Op[] {
  const copy: EncounterTableDocument = {
    ...table,
    _id: id,
    name: name?.trim() || `${table.name} (copy)`,
  };
  return [
    { kind: "create", coll: "encounterTables", data: copy as BaseDocument },
  ];
}

/**
 * Detach a table id from every cell that names it — what deleting a table must also do, or the
 * cells keep a dangling id (harmless to draw, confusing to read) and the hex window shows a row
 * for a table that is gone.
 */
export function detachTableFromCellsOps(
  scenes: readonly {
    _id: string;
    cells?: Array<{ _id: string; key: string; tables?: string[] }>;
  }[],
  tableId: string,
): Op[] {
  const ops: Op[] = [];
  for (const scene of scenes) {
    for (const cell of scene.cells ?? []) {
      if (!(cell.tables ?? []).includes(tableId)) continue;
      ops.push({
        kind: "update",
        ref: {
          coll: "cells",
          id: cell._id,
          parent: { coll: "scenes", id: scene._id },
        },
        diff: {
          tables: (cell.tables ?? []).filter((id) => id !== tableId),
        } as unknown as FlatDiff,
      });
    }
  }
  return ops;
}

/** Structural JSON equality for the draft's save gate (key order must not matter). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a !== "object") return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  if (!ka.every((k, i) => k === kb[i])) return false;
  return ka.every((k) =>
    jsonEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}
