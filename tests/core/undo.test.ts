import { describe, expect, test } from "vitest";
import { UndoStack } from "../../src/core/undo";
import type { Op, OpEnvelope } from "../../src/core/ops";

let tx = 0;
function env(seq: number, ops: Op[]): OpEnvelope {
  tx += 1;
  return { seq, ts: 0, by: "gm-key", ops, txId: `tx-${tx}` };
}

const update = (id: string, name: string): Op => ({
  kind: "update",
  ref: { coll: "scenes", id },
  diff: { name },
});

describe("UndoStack (§8 undo/redo core)", () => {
  test("push records undoables; no-inverse envelopes are skipped", () => {
    const stack = new UndoStack();
    stack.push(env(1, [update("s1", "A")]), [
      { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { name: "orig" } },
    ]);
    stack.push(env(2, []), []);
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);
  });

  test("undo returns reversed inverses; redo returns originals", () => {
    const stack = new UndoStack();
    const op1 = update("s1", "A");
    const op2 = update("s1", "B");
    const inv1: Op = { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { name: "inv-1" } };
    const inv2: Op = { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { name: "inv-2" } };
    stack.push(env(1, [op1, op2]), [inv1, inv2]);

    const undo = stack.applyUndo();
    expect(undo?.refSeq).toBe(1);
    expect(undo?.ops).toEqual([inv2, inv1]); // reversed
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);

    const redo = stack.applyRedo();
    expect(redo?.refSeq).toBe(1);
    expect(redo?.ops).toEqual([op1, op2]);
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);
  });

  test("a new commit clears the redo branch", () => {
    const stack = new UndoStack();
    stack.push(env(1, [update("s1", "A")]), [
      { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: {} },
    ]);
    stack.applyUndo();
    expect(stack.canRedo).toBe(true);
    stack.push(env(2, [update("s1", "C")]), [
      { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: {} },
    ]);
    expect(stack.canRedo).toBe(false);
    expect(stack.applyRedo()).toBeNull();
  });

  test("depth is capped at maxDepth (oldest dropped)", () => {
    const stack = new UndoStack(3);
    for (let i = 1; i <= 5; i++) {
      stack.push(env(i, [update("s1", `n${i}`)]), [
        { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: {} },
      ]);
    }
    let undos = 0;
    while (stack.applyUndo()) undos++;
    expect(undos).toBe(3);
  });

  test("peek does not consume; empty stacks are safe", () => {
    const stack = new UndoStack();
    expect(stack.peekUndo()).toBeNull();
    expect(stack.peekRedo()).toBeNull();
    expect(stack.applyUndo()).toBeNull();
    stack.push(env(1, [update("s1", "A")]), [
      { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: {} },
    ]);
    expect(stack.peekUndo()?.refSeq).toBe(1);
    expect(stack.peekUndo()?.refSeq).toBe(1); // still there
    stack.clear();
    expect(stack.canUndo).toBe(false);
  });
});
