/**
 * §5/§8 OpLog: the authoritative, monotonically-sequenced log of OpEnvelopes.
 * Late-join catch-up (`since(seq)`), compaction (`compact(base)` — the point
 * up to which a snapshot supersedes the log) and undo (pre-images captured as
 * inverse Ops at append time) all live here. Persistence (IDB write-behind)
 * is layered on top by src/storage; this structure is pure in-memory.
 */
import type { BaseDocument, DocRef } from "./documents";
import type { Op, OpEnvelope } from "./ops";
import { readPaths } from "./diff";
import { type OkOrErr, type Result, err, ok } from "./result";

/** Minimal read-only view OpLog needs to capture pre-images. */
export interface DocReader {
  resolve(ref: DocRef): BaseDocument | undefined;
}

export interface OpLogEntry {
  env: OpEnvelope;
  /** Inverse ops (op order); undo applies them reversed. */
  inverses: Op[];
}

export class OpLog {
  /** Seq of the last envelope dropped by compaction; log starts at baseSeq+1. */
  baseSeq: number;

  private entries: OpLogEntry[] = [];

  constructor(baseSeq = 0) {
    this.baseSeq = baseSeq;
  }

  get lastSeq(): number {
    const last = this.entries[this.entries.length - 1];
    return last ? last.env.seq : this.baseSeq;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Append with strict monotonic continuity (§5). */
  append(env: OpEnvelope, inverses: Op[] = []): OkOrErr {
    if (env.seq !== this.lastSeq + 1) {
      return err(`oplog: expected seq ${this.lastSeq + 1}, got ${env.seq}`);
    }
    this.entries.push({ env, inverses });
    return ok;
  }

  /** Envelopes with seq > `seq` (late-join delta, §5). */
  since(seq: number): OpEnvelope[] {
    return this.entries.filter((e) => e.env.seq > seq).map((e) => e.env);
  }

  at(seq: number): OpLogEntry | undefined {
    return this.entries.find((e) => e.env.seq === seq);
  }

  /** Drop entries with seq ≤ newBase (they are superseded by a snapshot). */
  compact(newBase: number): void {
    if (newBase <= this.baseSeq) return;
    this.entries = this.entries.filter((e) => e.env.seq > newBase);
    this.baseSeq = newBase;
  }

  /** Inverse ops of the last envelope (reversed = ready to apply), or null. */
  lastInverse(): { undoOf: number; ops: Op[] } | null {
    const last = this.entries[this.entries.length - 1];
    if (!last || last.inverses.length === 0) return null;
    return { undoOf: last.env.seq, ops: [...last.inverses].reverse() };
  }

  /** Pop the last entry (host applies its inverse as a fresh envelope). */
  popLast(): OpLogEntry | null {
    const last = this.entries.pop();
    return last ?? null;
  }
}

/**
 * Capture the inverse of a single Op against the current store state, BEFORE
 * the op is applied (§8 undo: "OpLog keeps pre-images for update/delete").
 * Returns null when the op is a no-op (nothing to undo).
 */
export function computeInverse(reader: DocReader, op: Op): Op | null {
  switch (op.kind) {
    case "create": {
      const ref: DocRef = op.parent
        ? { coll: op.coll, id: op.data._id, parent: op.parent }
        : { coll: op.coll, id: op.data._id };
      return { kind: "delete", ref };
    }
    case "update": {
      const doc = reader.resolve(op.ref);
      if (!doc) return null;
      const pre = readPaths(doc, op.diff);
      if (Object.keys(pre).length === 0) return null;
      return { kind: "update", ref: op.ref, diff: pre };
    }
    case "delete": {
      const doc = reader.resolve(op.ref);
      if (!doc) return null;
      return {
        kind: "create",
        coll: op.ref.coll,
        ...(op.ref.parent !== undefined ? { parent: op.ref.parent } : {}),
        data: structuredClone(doc),
      };
    }
  }
}

/** Anything with transactional envelope application (DocumentStore satisfies this). */
export interface EnvelopeApplier {
  applyEnvelope(env: OpEnvelope): Result<unknown>;
}

/**
 * §8 replay: apply `from` a log into an applier in seq order (startup after a
 * checkpoint, or verification). Fails on the first rejected envelope.
 */
export function replayLog(applier: EnvelopeApplier, log: OpLog, fromSeq = log.baseSeq): OkOrErr {
  for (const env of log.since(fromSeq)) {
    const res = applier.applyEnvelope(env);
    if (!res.ok) return err(`replay: envelope seq=${env.seq} rejected: ${res.error}`);
  }
  return ok;
}
