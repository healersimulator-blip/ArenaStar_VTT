/**
 * D-479 — **AIS health traces and the circuit breaker** (§14 observability, acceptance criterion
 * 11 of `AUTOMATION_INTERCONNECT_DESIGN.md`).
 *
 * Every module frame keeps a bounded ring of what happened to it (admitted RPCs with their
 * outcome and latency, admission rejections, commands, delivered events, lifecycle transitions)
 * plus counters. The packages views of both shells show the counters and the newest entries so a
 * GM can tell "the module never subscribed" from "the host refused its capability" without a
 * devtools session.
 *
 * The breaker is deliberately coarse: a module whose requests keep failing — denied capabilities,
 * malformed calls, a rate-limit storm — is stopped (`failed`, reason `circuit open: …`) instead of
 * burning the main thread of the device it runs on. Successful work never trips it; the shells
 * offer a restart.
 */

export interface AisTraceEntry {
  at: number;
  kind: "rpc" | "rejected" | "command" | "event" | "lifecycle";
  name: string;
  ok: boolean;
  ms?: number;
  error?: string;
}

export interface AisModuleDiagnostics {
  counters: {
    requests: number;
    failures: number;
    rejected: number;
    commands: number;
    commandFailures: number;
    events: number;
  };
  /** Newest last; at most `AIS_TRACE_RING` entries. */
  trace: AisTraceEntry[];
  /** When the breaker tripped, else null. */
  circuitOpenedAt: number | null;
}

export const AIS_TRACE_RING = 64;
/** This many failed requests (admitted-then-failed or rejected at admission) inside the window trip the breaker. */
export const AIS_CIRCUIT_FAILURES = 50;
export const AIS_CIRCUIT_WINDOW_MS = 10_000;

export interface AisHealthMonitor {
  record(entry: AisTraceEntry): void;
  diagnostics(): AisModuleDiagnostics;
}

export function createAisHealthMonitor(options: {
  /** Called once, synchronously, when the failure window overflows. */
  onTrip: (reason: string) => void;
  failures?: number;
  windowMs?: number;
}): AisHealthMonitor {
  const limit = options.failures ?? AIS_CIRCUIT_FAILURES;
  const windowMs = options.windowMs ?? AIS_CIRCUIT_WINDOW_MS;
  const trace: AisTraceEntry[] = [];
  const counters: AisModuleDiagnostics["counters"] =
    { requests: 0, failures: 0, rejected: 0, commands: 0, commandFailures: 0, events: 0 };
  const failureTimes: number[] = [];
  let circuitOpenedAt: number | null = null;
  const noteFailure = (at: number): void => {
    if (circuitOpenedAt !== null) return;
    failureTimes.push(at);
    while (failureTimes.length > 0 && at - (failureTimes[0] ?? at) > windowMs) failureTimes.shift();
    if (failureTimes.length >= limit) {
      circuitOpenedAt = at;
      options.onTrip(`circuit open: ${limit} failed requests within ${windowMs / 1000} s`);
    }
  };
  return {
    record(entry) {
      trace.push(entry);
      if (trace.length > AIS_TRACE_RING) trace.splice(0, trace.length - AIS_TRACE_RING);
      switch (entry.kind) {
        case "rpc":
          counters.requests++;
          if (!entry.ok) { counters.failures++; noteFailure(entry.at); }
          break;
        case "rejected":
          counters.rejected++;
          noteFailure(entry.at);
          break;
        case "command":
          counters.commands++;
          if (!entry.ok) counters.commandFailures++;
          break;
        case "event":
          counters.events++;
          break;
        default:
          break;
      }
    },
    diagnostics() {
      return { counters: { ...counters }, trace: trace.map((entry) => ({ ...entry })), circuitOpenedAt };
    },
  };
}
