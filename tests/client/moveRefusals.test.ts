import { expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import { moveRefusalMessage, refusalNotifier } from "../../src/client/moveRefusals";
import type { ClientEvents } from "../../src/client/sync";
import type { OpEnvelope } from "../../src/core/ops";

test("refusal text keeps the host's reason and stays short", () => {
  expect(moveRefusalMessage("invariant", "A wall blocks entry to the stairs")).toBe("Move refused: A wall blocks entry to the stairs");
  expect(moveRefusalMessage("rate_limited", "intent rate exceeded")).toMatch(/Too many moves/);
  expect(moveRefusalMessage("forbidden", "not authenticated")).toBe("You can't move that token.");
  expect(moveRefusalMessage("invariant", "")).toBe("The host refused that move.");
  expect(moveRefusalMessage("invariant", "x".repeat(500)).length).toBeLessThanOrEqual(215);
});

test("only tracked canvas transactions are announced, once, and commits clear them", () => {
  const bus = createEventBus<ClientEvents>();
  const seen: string[] = [];
  const notifier = refusalNotifier(bus, (m) => seen.push(m), 2);
  expect(notifier.track("a")).toBe("a");
  notifier.track("b");
  bus.emit("rejected", { txId: "untracked", reason: "invariant", detail: "dialog handles this" });
  bus.emit("rejected", { txId: "a", reason: "invariant", detail: "Stair landing overlaps a wall" });
  bus.emit("rejected", { txId: "a", reason: "invariant", detail: "duplicate" });
  bus.emit("ops", { envelope: { txId: "b" } as unknown as OpEnvelope, reconciled: null });
  bus.emit("rejected", { txId: "b", reason: "invariant", detail: "late" });
  expect(seen).toEqual(["Move refused: Stair landing overlaps a wall"]);
  // Bounded: the oldest pending transaction is forgotten first.
  notifier.track("c"); notifier.track("d"); notifier.track("e");
  bus.emit("rejected", { txId: "c", reason: "invariant", detail: "forgotten" });
  bus.emit("rejected", { txId: "e", reason: "invariant", detail: "kept" });
  expect(seen.at(-1)).toBe("Move refused: kept");
  expect(seen).toHaveLength(2);
  notifier.dispose();
  notifier.track("f");
  bus.emit("rejected", { txId: "f", reason: "invariant", detail: "after dispose" });
  expect(seen).toHaveLength(2);
});
