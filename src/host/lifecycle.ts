/**
 * §6.5 host resilience wiring — beforeunload guard + continuous OpLog flush.
 *
 * The HostPersister already appends every op to the oplog immediately and
 * batches document flushes (~500 ms). This installs the lifecycle hooks:
 * - `beforeunload` / `pagehide` (bfcache-safe) → await drain() chain;
 * - `visibilitychange → hidden` → drain early (mobile/tab-switch safety);
 * - an optional interval tick keeps flushing even without new traffic hooks.
 *
 * Returns a remove() for tests/teardown.
 */
export interface Drainable {
  /** Resolves when all queued persistence writes have settled (§6.5). */
  drain(): Promise<unknown>;
}

export interface LifecycleTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  /** Injectable document (tests); absent outside browsers. */
  document?: {
    visibilityState?: string;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
}

export interface HostLifecycleOptions {
  /** Extra periodic drain interval in ms (0 = disabled; persistence batches internally). */
  flushIntervalMs?: number;
}

/** globalThis when it is a window-like target; null in Node/tests. */
function windowLikeTarget(): LifecycleTarget | null {
  const candidate = globalThis as unknown as LifecycleTarget;
  return typeof candidate.addEventListener === "function" ? candidate : null;
}

export function installHostLifecycle(
  persister: Drainable,
  target?: LifecycleTarget,
  options: HostLifecycleOptions = {},
): () => void {
  const bound: LifecycleTarget | null = target ?? windowLikeTarget();
  if (!bound) return () => undefined; // no window (Node) — nothing to hook
  const onUnload = (): void => {
    void persister.drain().catch(() => undefined); // best-effort sync handoff
  };
  const onVisibility = (): void => {
    if (bound.document?.visibilityState === "hidden") {
      void persister.drain().catch(() => undefined);
    }
  };
  bound.addEventListener("beforeunload", onUnload);
  bound.addEventListener("pagehide", onUnload);
  bound.document?.addEventListener?.("visibilitychange", onVisibility);

  const intervalMs = options.flushIntervalMs ?? 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (intervalMs > 0) {
    timer = setInterval(() => void persister.drain().catch(() => undefined), intervalMs);
  }

  return () => {
    bound.removeEventListener("beforeunload", onUnload);
    bound.removeEventListener("pagehide", onUnload);
    bound.document?.removeEventListener?.("visibilitychange", onVisibility);
    if (timer !== null) clearInterval(timer);
  };
}
