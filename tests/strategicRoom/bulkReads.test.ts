import { expect, test, vi } from "vitest";
import { BulkReads } from "../../services/strategic-room/src/bulkReads";

function granted(release: (() => void) | undefined) {
  if (!release) throw new Error("Expected a bulk slot.");
  return release;
}

test("publication waiters share the active cap, one slot per session, in arrival order", async () => {
  const gate = new BulkReads<string>(1, 2, 1000);
  const live = new AbortController();
  const first = granted(gate.enter());
  const a = gate.wait("a", live.signal);
  expect(await gate.wait("a", live.signal)).toBeUndefined();
  const b = gate.wait("b", live.signal);
  expect(await gate.wait("c", live.signal)).toBeUndefined();
  expect(gate.enter()).toBeUndefined();
  first();
  first(); // finish + close cannot double-release
  expect(gate.active).toBe(1);
  granted(await a)();
  expect(gate.active).toBe(1);
  granted(await b)();
  expect(gate.active).toBe(0);
});

test("a direct read never jumps ahead of an already queued waiter", () => {
  const gate = new BulkReads<string>(3, 2, 1000);
  const state = gate as unknown as {
    active: number;
    queue: Map<string, () => void>;
  };
  // Rare race window: a slot has freed but the queued wake-up has not installed itself yet.
  state.active = 1;
  state.queue.set("waiting", () => undefined);
  expect(gate.enter()).toBeUndefined();
});

test("closed or expired waiters release their backlog slot without consuming a read", async () => {
  vi.useFakeTimers();
  try {
    const gate = new BulkReads<string>(1, 1, 500);
    const first = granted(gate.enter());
    const disconnected = new AbortController();
    const a = gate.wait("a", disconnected.signal);
    disconnected.abort();
    expect(await a).toBeUndefined();
    const b = gate.wait("b", new AbortController().signal);
    vi.advanceTimersByTime(500);
    expect(await b).toBeUndefined();
    expect(gate.active).toBe(1);
    first();
    expect(gate.active).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
