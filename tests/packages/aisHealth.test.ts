/** D-479: health traces, counters and the circuit breaker, through the dispatcher and the monitor. */
import { describe, expect, test, vi } from "vitest";
import { AIS_CIRCUIT_FAILURES, AIS_TRACE_RING, createAisHealthMonitor } from "../../src/packages/aisHealth";
import { AIS_MODULE_METHODS, createAisModuleDispatcher, type AisModuleHandlers, type AisTraceEntry } from "../../src/packages/aisModuleIframe";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const request = (id: number, method: string, args: unknown = {}) => ({ vttAisRpc: 1, kind: "request", id, method, args });
const handlers = (): AisModuleHandlers => Object.fromEntries(
  AIS_MODULE_METHODS.map((method) => [method, vi.fn(async () => ({ ok: true }))]),
) as unknown as AisModuleHandlers;

describe("AIS health monitor", () => {
  test("keeps a bounded ring, counts by kind and never exposes its live arrays", () => {
    const onTrip = vi.fn();
    const monitor = createAisHealthMonitor({ onTrip });
    for (let i = 0; i < AIS_TRACE_RING + 10; i++) monitor.record({ at: i, kind: "event", name: "world.ops.committed", ok: true });
    monitor.record({ at: 100, kind: "rpc", name: "chat.post", ok: true, ms: 3 });
    monitor.record({ at: 101, kind: "rpc", name: "chat.post", ok: false, ms: 1, error: "nope" });
    monitor.record({ at: 102, kind: "rejected", name: "fx.play", ok: false, error: "Capability not granted: fx.play" });
    monitor.record({ at: 103, kind: "command", name: "light", ok: true, ms: 12 });
    monitor.record({ at: 104, kind: "command", name: "light", ok: false, ms: 8000, error: "timed out" });
    monitor.record({ at: 105, kind: "lifecycle", name: "ready", ok: true });
    const view = monitor.diagnostics();
    expect(view.counters).toEqual({ requests: 2, failures: 1, rejected: 1, commands: 2, commandFailures: 1, events: AIS_TRACE_RING + 10 });
    expect(view.trace).toHaveLength(AIS_TRACE_RING);
    expect(view.trace.at(-1)).toEqual({ at: 105, kind: "lifecycle", name: "ready", ok: true });
    expect(view.trace[0]?.at).toBe(16); // the oldest 16 events fell out of the ring
    view.trace.length = 0;
    view.counters.requests = 99;
    expect(monitor.diagnostics().trace).toHaveLength(AIS_TRACE_RING);
    expect(monitor.diagnostics().counters.requests).toBe(2);
    expect(view.circuitOpenedAt).toBeNull();
    expect(onTrip).not.toHaveBeenCalled();
  });

  test("the breaker trips once on failures inside the window and ignores successes and old failures", () => {
    const onTrip = vi.fn();
    const monitor = createAisHealthMonitor({ onTrip, failures: 5, windowMs: 1000 });
    for (let i = 0; i < 4; i++) monitor.record({ at: 1000 + i, kind: "rpc", name: "x", ok: false });
    for (let i = 0; i < 50; i++) monitor.record({ at: 1010 + i, kind: "rpc", name: "x", ok: true });
    expect(onTrip).not.toHaveBeenCalled();
    // An old failure has left the window: still four inside it.
    monitor.record({ at: 2500, kind: "rejected", name: "x", ok: false });
    expect(onTrip).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) monitor.record({ at: 2501 + i, kind: "rejected", name: "x", ok: false });
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledWith("circuit open: 5 failed requests within 1 s");
    expect(monitor.diagnostics().circuitOpenedAt).toBe(2504);
    // Further failures do not re-trip.
    for (let i = 0; i < 10; i++) monitor.record({ at: 2600 + i, kind: "rpc", name: "x", ok: false });
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  test("the default threshold matches the documented budget", () => {
    expect(AIS_CIRCUIT_FAILURES).toBe(50);
  });

  test("the dispatcher reports admitted requests with outcome and latency, and rejections separately", async () => {
    const calls = handlers();
    calls["chat.post"] = async () => { throw new Error("host said no"); };
    const trace: AisTraceEntry[] = [];
    const dispatcher = createAisModuleDispatcher(calls, new Set(["chat.post", "scene.read.visible"]), vi.fn(), undefined, (entry) => trace.push(entry));
    const post = vi.fn();
    dispatcher.onFrame(request(1, "scene.read.visible"), post);
    dispatcher.onFrame(request(2, "chat.post", { content: "x" }), post);
    dispatcher.onFrame(request(3, "fx.play", {}), post);
    await tick();
    expect(trace.map((entry) => [entry.kind, entry.name, entry.ok])).toEqual([
      ["rejected", "fx.play", false],
      ["rpc", "scene.read.visible", true],
      ["rpc", "chat.post", false],
    ]);
    expect(trace[0]?.error).toBe("Capability not granted: fx.play");
    expect(trace[2]?.error).toBe("host said no");
    expect(trace.filter((entry) => entry.kind === "rpc").every((entry) => typeof entry.ms === "number")).toBe(true);
  });
});
