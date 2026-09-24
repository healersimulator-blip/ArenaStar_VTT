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

/** Only the host can supply an audit; its ID is never accepted from an intent. */
export interface ActionAudit {
  id: string;
  label: string;
  /** Async script/graph groups are not reversible until they finish (or crash and expire). */
  pendingUntil?: number;
}

export function actionOpRef(op: Op): DocRef {
  return op.kind === "create"
    ? { coll: op.coll, id: op.data._id, ...(op.parent ? { parent: op.parent } : {}) }
    : op.ref;
}

/** Exact post-image digest; missing is distinct from an existing empty document. */
export function actionDocHash(doc: BaseDocument | undefined): string | null {
  return doc === undefined ? null : bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(doc))));
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
  for (const check of previous?.after ?? []) refs.set(JSON.stringify(check.ref), check.ref);
  for (const op of ops) {
    const ref = actionOpRef(op);
    if (ref.coll === "actionReceipts") return { ok: false, error: "Cannot record an action receipt inside itself" };
    refs.set(JSON.stringify(ref), ref);
  }
  const allInverses = [...inverses].reverse().concat(previous?.inverses ?? []);
  if (allInverses.length > MAX_ACTION_RECEIPT_OPS || refs.size > MAX_ACTION_RECEIPT_OPS)
    return { ok: false, error: "Action exceeds the Revert history limit" };
  const receipt: ActionReceiptDocument = {
    _id: audit.id, type: "actionReceipt", name: audit.label, ownership: { default: 0 },
    flags: {}, system: {}, status: audit.pendingUntil ? "pending" : "ready",
    createdAt: previous?.createdAt ?? at,
    ...(audit.pendingUntil ? { pendingUntil: audit.pendingUntil } : {}),
    commits: (previous?.commits ?? 0) + 1,
    inverses: allInverses,
    after: [...refs.values()].map((ref) => ({ ref, hash: actionDocHash(shadow.resolve(ref)) })),
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
 * or traps. Changes to a still-existing message DO remain stale. */
export function actionStaleReason(receipt: ActionReceiptDocument, store: DocumentStore): string | null {
  if (!Array.isArray(receipt.inverses) || !Array.isArray(receipt.after) ||
      receipt.inverses.length === 0 || receipt.inverses.length > MAX_ACTION_RECEIPT_OPS ||
      receipt.after.length === 0 || receipt.after.length > MAX_ACTION_RECEIPT_OPS ||
      JSON.stringify(receipt).length > MAX_ACTION_RECEIPT_BYTES)
    return "Action pre-images are missing or invalid";
  const missingChat = missingActionMessageDeletes(receipt, store);
  for (const check of receipt.after) {
    if (!check || !check.ref || typeof check.ref.coll !== "string" ||
        typeof check.ref.id !== "string" ||
        (check.hash !== null && (typeof check.hash !== "string" || !/^[0-9a-f]{64}$/.test(check.hash))))
      return "Action post-image is invalid";
    if (actionDocHash(store.resolve(check.ref)) !== check.hash &&
        !(check.ref.coll === "messages" && missingChat.has(check.ref.id)))
      return `Action is stale: ${check.ref.coll}/${check.ref.id} changed after this run`;
  }
  return null;
}
