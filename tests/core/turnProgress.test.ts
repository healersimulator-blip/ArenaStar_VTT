import { expect, test } from "vitest";
import { hostedTurnProgress } from "../../src/core/turnProgress";
import type { Head } from "../../src/core/strategicRoom/protocol";

const orders: Head = {
  phase: "orders",
  version: 0,
  turnId: 1,
  deadlineMs: null,
};
const resolution: Head = { ...orders, phase: "resolution" };
const report: Head = { ...orders, phase: "report", version: 1 };

test("signals close immediately, then resolution and actual view application without a timer", () => {
  expect(hostedTurnProgress(orders, orders, true)).toBe("closing");
  expect(hostedTurnProgress(resolution, orders, true)).toBe("resolving");
  expect(hostedTurnProgress(resolution, null, false)).toBe("resolving");
  expect(hostedTurnProgress(report, resolution, false)).toBe("applying");
  expect(hostedTurnProgress(report, report, false)).toBeNull();
});

test("clears when denied, paused or disconnected; retry has its own label", () => {
  const paused: Head = { ...orders, phase: "paused" };
  expect(hostedTurnProgress(paused, resolution, false)).toBeNull();
  expect(hostedTurnProgress(paused, paused, true)).toBe("retrying");
  expect(hostedTurnProgress(orders, orders, false)).toBeNull();
  expect(hostedTurnProgress(null, null, false)).toBeNull();
});
