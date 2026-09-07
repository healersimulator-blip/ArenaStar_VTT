import { describe, expect, test, vi } from "vitest";
import { FailoverMonitor } from "../../src/net/failover";

describe("§6.5 Assistant-GM Failover", () => {
  test("triggers failover after 30s host absence for ASSISTANT role", () => {
    vi.useFakeTimers();
    const monitor = new FailoverMonitor({ role: "ASSISTANT", timeoutMs: 30_000 });

    let failed = false;
    monitor.onHostFailed = () => {
      failed = true;
    };

    monitor.start();
    expect(failed).toBe(false);

    // 25s elapsed -> no failover
    vi.advanceTimersByTime(25_000);
    expect(failed).toBe(false);

    // Heartbeat resets timer
    monitor.recordHeartbeat();
    vi.advanceTimersByTime(25_000);
    expect(failed).toBe(false);

    // 30s silence -> failover triggers
    vi.advanceTimersByTime(5_000);
    expect(failed).toBe(true);

    monitor.stop();
    vi.useRealTimers();
  });

  test("does NOT trigger failover for PLAYER role", () => {
    vi.useFakeTimers();
    const monitor = new FailoverMonitor({ role: "PLAYER", timeoutMs: 30_000 });

    let failed = false;
    monitor.onHostFailed = () => {
      failed = true;
    };

    monitor.start();
    vi.advanceTimersByTime(35_000);
    expect(failed).toBe(false);

    monitor.stop();
    vi.useRealTimers();
  });

  test("triggers failover immediately on transport disconnect for ASSISTANT", () => {
    const monitor = new FailoverMonitor({ role: "ASSISTANT", timeoutMs: 30_000 });

    let failed = false;
    monitor.onHostFailed = () => {
      failed = true;
    };

    monitor.start();
    monitor.onDisconnect();
    expect(failed).toBe(true);

    monitor.stop();
  });
});
