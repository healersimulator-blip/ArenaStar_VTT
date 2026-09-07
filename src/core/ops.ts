/**
 * §4 Ops: the ONLY way to mutate Document state. Ops are batched into
 * transactions (one OpEnvelope); undo, late-join delta and broadcast all
 * operate on OpEnvelopes (§5).
 */
import type { AnyCollectionName, BaseDocument, DocRef, Json } from "./documents";
import type { TxId, UserId } from "./ids";

/**
 * Dotted-path diff for update ops, e.g. { "system.hp": 5, "name": "Orc" }.
 * A key of the form "-=<path>" with value null deletes that path (§4).
 */
export type FlatDiff = Record<string, Json | null>;

export type Op =
  | {
      kind: "create";
      coll: AnyCollectionName;
      parent?: DocRef;
      /** Full document to insert (spec: `data: Doc`); per-system fields live under `system`. */
      data: BaseDocument;
    }
  | { kind: "update"; ref: DocRef; diff: FlatDiff }
  | { kind: "delete"; ref: DocRef };

/** Every mutation of the Document Store travels in one of these (§4, §5). */
export interface OpEnvelope {
  /** Monotonic sequence number, host-assigned on commit (§5). */
  seq: number;
  /** Wall-clock timestamp (ms); never used inside the SimWorker. */
  ts: number;
  by: UserId;
  ops: Op[];
  txId: TxId;
}

/** Client → host transaction proposal (§5 flow). */
export interface Intent {
  txId: TxId;
  ops: Op[];
}
