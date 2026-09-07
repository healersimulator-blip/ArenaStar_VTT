/**
 * §6.5 Assistant-GM Failover
 *
 * Monitors host liveness on client sessions connected with the ASSISTANT role.
 * If the host is absent for >30 seconds or the connection disconnects, triggers
 * failover so the Assistant can assume host responsibilities.
 */
import type { Role } from "../core/documents";

export interface FailoverOptions {
  role: Role;
  timeoutMs?: number; // default 30,000 ms (30s)
}

export class FailoverMonitor {
  private readonly role: Role;
  private readonly timeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  onHostFailed: (() => void) | null = null;

  constructor(options: FailoverOptions) {
    this.role = options.role;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  start(): void {
    if (this.role !== "ASSISTANT") return;
    this.running = true;
    this.resetTimer();
  }

  recordHeartbeat(): void {
    if (!this.running) return;
    this.resetTimer();
  }

  onDisconnect(): void {
    if (!this.running || this.role !== "ASSISTANT") return;
    this.clearTimer();
    this.triggerFailover();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  private resetTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.triggerFailover();
    }, this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private triggerFailover(): void {
    if (!this.running) return;
    this.running = false;
    this.clearTimer();
    this.onHostFailed?.();
  }
}
