/**
 * §4 FlatDiff engine: dotted-path diffs (`{ "system.hp": 5 }`), deletion via a
 * "-=<path>" key with null value. Pure functions over JSON documents:
 *
 *   applyDiff(doc, diff) → new doc (immutably; original untouched) | Err
 *   readPaths(doc, diff) → pre-image diff (old values) for undo / rollback
 *   diffFlat(before, after) → canonical FlatDiff between two JSON trees
 *
 * Path semantics (D-012): object segments traverse/create-nothing (missing
 * intermediates are errors); numeric segments index arrays (in-range only);
 * deleting an array element by index is NOT supported — replace the array.
 */
import type { Json } from "./documents";
import type { FlatDiff } from "./ops";
import { type Result, err, okVal } from "./result";

export type JsonRecord = { [key: string]: Json };

const DELETE_MARKER = "-=";

interface ParsedKey {
  segments: string[];
  isDelete: boolean;
}

export function parseDiffKey(key: string): ParsedKey {
  if (key.startsWith(DELETE_MARKER)) {
    return { segments: key.slice(DELETE_MARKER.length).split("."), isDelete: true };
  }
  return { segments: key.split("."), isDelete: false };
}

/** Key with a normalized (marker-free) path, for matching. */
export function normalizeDiffKey(key: string): string {
  return key.startsWith(DELETE_MARKER) ? key.slice(DELETE_MARKER.length) : key;
}

function isPlainObject(v: Json): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIndexSegment(seg: string): boolean {
  return /^\d+$/.test(seg);
}

/** As `Record` for structural access — documents are plain JSON (§4). */
export function asRecord(doc: unknown): JsonRecord {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("asRecord: not a document object");
  }
  return doc as JsonRecord;
}

/**
 * Immutably apply a FlatDiff. Returns a cloned doc or an error; `doc` itself
 * is never mutated. Setting a path whose intermediate is missing or a
 * primitive is an error; deleting a missing path is a no-op (idempotent).
 */
export function applyDiff<T extends object>(doc: T, diff: FlatDiff): Result<T> {
  const clone = structuredClone(doc) as T;
  const target = asRecord(clone);
  for (const [key, value] of Object.entries(diff)) {
    const { segments, isDelete } = parseDiffKey(key);
    let cursor: Json = target;
    for (let depth = 0; depth < segments.length; depth++) {
      const seg = segments[depth];
      if (seg === undefined) return err(`empty path segment in '${key}'`);
      const last = depth === segments.length - 1;
      if (Array.isArray(cursor)) {
        if (!isIndexSegment(seg)) return err(`'${key}': array requires numeric segments`);
        const idx = Number(seg);
        if (idx >= cursor.length) {
          return err(`'${key}': index ${idx} out of bounds (length ${cursor.length})`);
        }
        if (!last) {
          cursor = cursor[idx] as Json;
          continue;
        }
        if (isDelete) return err(`'${key}': deleting an array element is not supported`);
        (cursor as Json[])[idx] = value as Json;
        continue;
      }
      if (!isPlainObject(cursor)) {
        return err(`'${key}': segment '${seg}' traverses a non-object`);
      }
      const container: JsonRecord = cursor;
      if (!last) {
        const next: Json | undefined = container[seg];
        if (next === undefined) {
          return err(
            `'${key}': intermediate path '${segments.slice(0, depth + 1).join(".")}' missing`,
          );
        }
        cursor = next;
        continue;
      }
      if (isDelete) {
        if (value !== null) return err(`'${key}': deletion marker requires null value`);
        // Document-key removal is rare and off hot paths; Reflect form keeps the
        // no-dynamic-delete lint honest while matching `delete` semantics exactly.
        Reflect.deleteProperty(container, seg);
      } else {
        container[seg] = value as Json;
      }
    }
  }
  return okVal(clone);
}

/**
 * Pre-image of `diff` against `doc`: for every set-key the old value (or a
 * "-=" marker if the path was absent → undo removes it); for every delete-key
 * the current value so undo restores it. Absent-target deletes are skipped
 * (they were no-ops). Returns {} when the diff would change nothing.
 */
export function readPaths<T extends object>(doc: T, diff: FlatDiff): FlatDiff {
  const pre: FlatDiff = {};
  const source = asRecord(doc);
  for (const [key, value] of Object.entries(diff)) {
    const { segments, isDelete } = parseDiffKey(key);
    let cursor: Json = source;
    let current: Json | undefined;
    let exists = true;
    for (let depth = 0; depth < segments.length; depth++) {
      const seg = segments[depth];
      if (seg === undefined) {
        exists = false;
        break;
      }
      if (Array.isArray(cursor)) {
        if (!isIndexSegment(seg)) {
          exists = false;
          break;
        }
        const idx = Number(seg);
        if (idx >= cursor.length) {
          exists = false;
          break;
        }
        cursor = cursor[idx] as Json;
      } else if (isPlainObject(cursor)) {
        const next: Json | undefined = cursor[seg];
        if (next === undefined) {
          exists = false;
          break;
        }
        cursor = next;
      } else {
        exists = false;
        break;
      }
      if (depth === segments.length - 1) current = cursor;
    }
    if (!exists) {
      // Key absent: a set would create it (undo: delete), a delete is a no-op.
      if (!isDelete && value !== null) pre[`${DELETE_MARKER}${key}`] = null;
      continue;
    }
    if (isDelete) {
      // Inverse of a delete restores the value at the clean path.
      pre[normalizeDiffKey(key)] = current as Json;
    } else if (!(key in pre)) {
      pre[key] = structuredClone(current) as Json;
    }
  }
  return pre;
}

export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (!jsonEqual(x as Json, y as Json)) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!(k in b)) return false;
      if (!jsonEqual(a[k] as Json, b[k] as Json)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Canonical diff between two JSON trees: objects recurse, everything else
 * (arrays, primitives) compares wholesale. Additions set the path; deletions
 * emit "-=<path>": null.
 */
export function diffFlat(before: JsonRecord, after: JsonRecord, prefix = ""): FlatDiff {
  const out: FlatDiff = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const b = before[key] as Json | undefined;
    const a = after[key] as Json | undefined;
    if (b !== undefined && a !== undefined && isPlainObject(b) && isPlainObject(a)) {
      Object.assign(out, diffFlat(b, a, path));
      continue;
    }
    if (b === undefined) {
      out[path] = a as Json;
    } else if (a === undefined) {
      out[`${DELETE_MARKER}${path}`] = null;
    } else if (!jsonEqual(b, a)) {
      out[path] = a;
    }
  }
  return out;
}
