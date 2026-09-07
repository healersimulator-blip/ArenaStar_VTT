/**
 * §8 undo/redo core: the OpLog keeps pre-images (inverses) per envelope; this
 * stack pairs each undoable envelope with its inverses (undo) and originals
 * (redo). The host turns peek/pop results into fresh envelopes with new txIds
 * and its own `by` — undo history itself is never sent as-is to clients.
 * GM/ASSISTANT only (enforced by HostSync, §10).
 */
import type { Op, OpEnvelope } from "./ops";

export interface UndoItem {
  seq: number;
  txId: string;
  /** Inverse ops in envelope order; apply REVERSED to undo. */
  inverses: Op[];
  /** Original ops; re-apply to redo. */
  originals: Op[];
}

export interface UndoRedoOps {
  /** The envelope the ops undo/redo (for UI labels). */
  refSeq: number;
  ops: Op[];
}

export class UndoStack {
  private undoStack: UndoItem[] = [];
  private redoStack: UndoItem[] = [];

  constructor(readonly maxDepth = 100) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Record a committed envelope (no-op inverses = nothing undoable). */
  push(env: OpEnvelope, inverses: readonly Op[]): void {
    if (inverses.length === 0) return;
    this.undoStack.push({
      seq: env.seq,
      txId: env.txId,
      inverses: [...inverses],
      originals: [...env.ops],
    });
    if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
    this.redoStack = []; // a new commit invalidates the redo branch
  }

  peekUndo(): UndoRedoOps | null {
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top) return null;
    return { refSeq: top.seq, ops: [...top.inverses].reverse() };
  }

  peekRedo(): UndoRedoOps | null {
    const top = this.redoStack[this.redoStack.length - 1];
    if (!top) return null;
    return { refSeq: top.seq, ops: [...top.originals] };
  }

  /** Pop the undo item (moves it to the redo stack). */
  applyUndo(): UndoRedoOps | null {
    const item = this.undoStack.pop();
    if (!item) return null;
    this.redoStack.push(item);
    return { refSeq: item.seq, ops: [...item.inverses].reverse() };
  }

  /** Pop the redo item (moves it back to the undo stack). */
  applyRedo(): UndoRedoOps | null {
    const item = this.redoStack.pop();
    if (!item) return null;
    this.undoStack.push(item);
    return { refSeq: item.seq, ops: [...item.originals] };
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
