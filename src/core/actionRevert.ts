/**
 * Durable GM Revert for committed world actions. The action receipt lives in its
 * own private collection, not in the capped chat or the compacted OpLog. A
 * transaction first runs against a shadow store to capture EXACT inverse ops
 * (including repeated writes to the same document); the receipt and the world
 * changes then commit in one envelope. The host checks post-images again when
 * a GM asks to Revert, rather than blindly overwriting subsequent edits.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ActionReceiptDocument, BaseDocument, DocRef } from "./documents";
import type { Op } from "./ops";
import type { DocumentStore } from "./store";

export const MAX_ACTION_RECEIPT_BYTES = 1_000_000;
export const MAX_ACTION_RECEIPT_OPS = 4096;
export const MAX_ACTION_RECEIPT_PATHS = 4096;

/** Only the host can supply an audit; its ID is never accepted from an intent. */
export interface ActionAudit {
  id: string;
  label: string;
  /** Async script/graph groups are not reversible until they finish (or crash and expire). */
  pendingUntil?: number;
  /** Bounded host-owned attribution/idempotency data retained on the private receipt. */
  system?: Record<string, import("./documents").Json>;
  /**
   * Opt in only when every inverse for the referenced document is path-addressable. The receipt
   * then gates those exact post-values, so an independent keyed affliction can be reverted without
   * restoring (or staling on) a sibling key. Unlisted documents retain whole-document hashing.
   */
  pathChecks?: readonly { ref: DocRef; paths: readonly string[] }[];
}

export function actionOpRef(op: Op): DocRef {
  return op.kind === "create"
    ? { coll: op.coll, id: op.data._id, ...(op.parent ? { parent: op.parent } : {}) }
    : op.ref;
}

function valueHash(value: unknown): string | null {
  if (value === undefined) return null;
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
}

/** Exact post-image digest; missing is distinct from an existing empty document. */
export function actionDocHash(doc: BaseDocument | undefined): string | null {
  return valueHash(doc);
}

function safePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length < 1 || path.length > 512) return false;
  const segments = path.split(".");
  return segments.length <= 24 && segments.every((segment) =>
    /^[A-Za-z0-9_-]{1,128}$/.test(segment) &&
    segment !== "__proto__" && segment !== "prototype" && segment !== "constructor");
}

/** Read an exact document path; an absent leaf/intermediate has the distinct missing hash. */
function documentPathValue(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const segment of path.split(".")) {
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= cursor.length) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object" || cursor === null || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function pathHash(doc: unknown, path: string): string | null {
  return valueHash(documentPathValue(doc, path));
}

function normalizeDiffPath(key: string): string {
  return key.startsWith("-=") ? key.slice(2) : key;
}

/** Build a candidate in the shadow store; never mutates the real receipt. */
export function extendActionReceipt(
  shadow: DocumentStore,
  audit: ActionAudit,
  ops: readonly Op[],
  inverses: readonly Op[],
  previous: ActionReceiptDocument | undefined,
  at: number,
): { ok: true; receipt: ActionReceiptDocument } | { ok: false; error: string } {
  if (previous && (previous._id !== audit.id || previous.status !== "pending" ||
      previous.name !== audit.label || !audit.pendingUntil))
    return { ok: false, error: "Action receipt is no longer accepting writes" };
  if (!previous && shadow.get("actionReceipts", audit.id))
    return { ok: false, error: "Action receipt ID already exists" };

  const refs = new Map<string, DocRef>();
  const previousChecks = new Map<string, ActionReceiptDocument["after"][number]>();
  for (const check of previous?.after ?? []) {
    const key = JSON.stringify(check.ref);
    refs.set(key, check.ref);
    previousChecks.set(key, check);
  }
  for (const op of ops) {
    const ref = actionOpRef(op);
    if (ref.coll === "actionReceipts") return { ok: false, error: "Cannot record an action receipt inside itself" };
    refs.set(JSON.stringify(ref), ref);
  }
  const requestedPaths = new Map<string, { ref: DocRef; paths: Set<string> }>();
  let pathCount = 0;
  for (const check of audit.pathChecks ?? []) {
    const key = JSON.stringify(check.ref);
    if (!refs.has(key) || !Array.isArray(check.paths) || check.paths.length === 0)
      return { ok: false, error: "Action path checks must name changed documents and at least one path" };
    const entry = requestedPaths.get(key) ?? { ref: check.ref, paths: new Set<string>() };
    for (const path of check.paths) {
      if (!safePath(path)) return { ok: false, error: "Action path check contains an invalid path" };
      entry.paths.add(path);
    }
    requestedPaths.set(key, entry);
  }
  for (const [key, check] of previousChecks) {
    if (check.hashMode !== "paths") continue;
    const entry = requestedPaths.get(key) ?? { ref: check.ref, paths: new Set<string>() };
    for (const path of check.pathHashes ?? []) entry.paths.add(path.path);
    requestedPaths.set(key, entry);
  }
  // All actual writes to an explicitly path-watched document join the same gate. Omitting a diff
  // path here would make the receipt capable of overwriting an unobserved sibling mutation.
  for (const op of ops) {
    if (op.kind !== "update") continue;
    const key = JSON.stringify(op.ref);
    const entry = requestedPaths.get(key);
    if (!entry) continue;
    for (const diffKey of Object.keys(op.diff)) {
      const path = normalizeDiffPath(diffKey);
      if (!safePath(path)) return { ok: false, error: "Action update contains an invalid watched path" };
      entry.paths.add(path);
    }
  }
  for (const entry of requestedPaths.values()) pathCount += entry.paths.size;
  if (pathCount > MAX_ACTION_RECEIPT_PATHS)
    return { ok: false, error: "Action exceeds the Revert path-check limit" };

  const allInverses = [...inverses].reverse().concat(previous?.inverses ?? []);
  if (allInverses.length > MAX_ACTION_RECEIPT_OPS || refs.size > MAX_ACTION_RECEIPT_OPS)
    return { ok: false, error: "Action exceeds the Revert history limit" };
  const after: ActionReceiptDocument["after"] = [];
  for (const [key, ref] of refs) {
    const prior = previousChecks.get(key);
    const requested = requestedPaths.get(key);
    // A previous whole-document receipt is never silently downgraded to path-level checking.
    const pathMode = prior?.hashMode === "paths" || (prior === undefined && requested !== undefined);
    if (!pathMode) {
      after.push({ ref, hash: actionDocHash(shadow.resolve(ref)) });
      continue;
    }
    const paths = new Set(prior?.pathHashes?.map((entry) => entry.path) ?? []);
    for (const path of requested?.paths ?? []) paths.add(path);
    if (paths.size === 0 || [...paths].some((path) => !safePath(path)))
      return { ok: false, error: "Action path receipt is empty or malformed" };
    const doc = shadow.resolve(ref);
    after.push({
      ref,
      hash: null,
      hashMode: "paths",
      pathHashes: [...paths].sort().map((path) => ({ path, hash: pathHash(doc, path) })),
    });
  }
  const receipt: ActionReceiptDocument = {
    _id: audit.id, type: "actionReceipt", name: audit.label, ownership: { default: 0 },
    flags: {}, system: previous?.system ?? audit.system ?? {}, status: audit.pendingUntil ? "pending" : "ready",
    createdAt: previous?.createdAt ?? at,
    ...(audit.pendingUntil ? { pendingUntil: audit.pendingUntil } : {}),
    commits: (previous?.commits ?? 0) + 1,
    inverses: allInverses,
    after,
  };
  if (JSON.stringify(receipt).length > MAX_ACTION_RECEIPT_BYTES)
    return { ok: false, error: "Action pre-images exceed the Revert history limit" };
  return { ok: true, receipt };
}

/** A created chat entry may have fallen off the ordinary 100-message retention
 * cap. It is already absent, so its inverse delete is a no-op. Only waive a
 * SINGLE delete of a now-missing message; a delete/recreate or edit sequence
 * still requires its exact post-image and must not be silently rewritten. */
export function missingActionMessageDeletes(receipt: ActionReceiptDocument, store: DocumentStore): Set<string> {
  const inverses = new Map<string, Op[]>();
  for (const op of receipt.inverses) {
    if (!op || (op.kind === "create" && !op.data) ||
        (op.kind !== "create" && op.kind !== "delete" && op.kind !== "update")) continue;
    const ref = actionOpRef(op);
    if (!ref || ref.coll !== "messages" || ref.parent || typeof ref.id !== "string") continue;
    const entries = inverses.get(ref.id) ?? [];
    entries.push(op);
    inverses.set(ref.id, entries);
  }
  const missing = new Set<string>();
  for (const check of receipt.after) {
    const ref = check?.ref;
    if (!ref || ref.coll !== "messages" || ref.parent || typeof ref.id !== "string" || store.resolve(ref)) continue;
    const entries = inverses.get(ref.id) ?? [];
    if (entries.length === 1 && entries[0]?.kind === "delete") missing.add(ref.id);
  }
  return missing;
}

/** Conservative by design: a changed document is never silently overwritten.
 * Retention-pruned chat is already gone; it cannot block restoring unrelated HP
 * or traps. Path mode is opt-in and hashes only exact keyed values represented by
 * path-addressable inverse Ops; all other receipts remain whole-document fail-closed. */
export function actionStaleReason(receipt: ActionReceiptDocument, store: DocumentStore): string | null {
  if (!Array.isArray(receipt.inverses) || !Array.isArray(receipt.after) ||
      receipt.inverses.length === 0 || receipt.inverses.length > MAX_ACTION_RECEIPT_OPS ||
      receipt.after.length === 0 || receipt.after.length > MAX_ACTION_RECEIPT_OPS ||
      JSON.stringify(receipt).length > MAX_ACTION_RECEIPT_BYTES)
    return "Action pre-images are missing or invalid";
  const missingChat = missingActionMessageDeletes(receipt, store);
  for (const check of receipt.after) {
    if (!check || !check.ref || typeof check.ref.coll !== "string" || typeof check.ref.id !== "string")
      return "Action post-image is invalid";
    if (check.hashMode === "paths") {
      if (check.hash !== null || !Array.isArray(check.pathHashes) || check.pathHashes.length === 0 ||
          check.pathHashes.length > MAX_ACTION_RECEIPT_PATHS)
        return "Action path post-image is invalid";
      const doc = store.resolve(check.ref);
      const seen = new Set<string>();
      for (const pathCheck of check.pathHashes) {
        if (!pathCheck || !safePath(pathCheck.path) || seen.has(pathCheck.path) ||
            (pathCheck.hash !== null && (typeof pathCheck.hash !== "string" || !/^[0-9a-f]{64}$/.test(pathCheck.hash))))
          return "Action path post-image is invalid";
        seen.add(pathCheck.path);
        if (pathHash(doc, pathCheck.path) !== pathCheck.hash)
          return `Action is stale: ${check.ref.coll}/${check.ref.id} (${pathCheck.path}) changed after this run`;
      }
      continue;
    }
    if (check.hashMode !== undefined || check.pathHashes !== undefined ||
        (check.hash !== null && (typeof check.hash !== "string" || !/^[0-9a-f]{64}$/.test(check.hash))))
      return "Action post-image is invalid";
    if (actionDocHash(store.resolve(check.ref)) !== check.hash &&
        !(check.ref.coll === "messages" && missingChat.has(check.ref.id)))
      return `Action is stale: ${check.ref.coll}/${check.ref.id} changed after this run`;
  }
  return null;
}
