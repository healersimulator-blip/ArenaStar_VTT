/** Bounded publication burst absorber. Waiting holds no DB connection or encoded response.
 * Only a single waiting request per admitted session, bounded in number and time. */
export class BulkReads<K> {
  active = 0;
  private readonly queue = new Map<K, () => void>();
  constructor(
    private readonly limit: number,
    private readonly backlog: number,
    private readonly timeoutMs: number,
  ) {}

  private grant() {
    this.active++;
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      this.active--;
      this.queue.values().next().value?.();
    };
  }

  /** A direct read must not overtake sessions already queued for a slot. */
  private available() {
    return this.active < this.limit && this.queue.size === 0;
  }

  enter() {
    return this.available() ? this.grant() : undefined;
  }

  wait(key: K, signal: AbortSignal): Promise<(() => void) | undefined> {
    if (
      signal.aborted ||
      this.queue.has(key) ||
      this.queue.size >= this.backlog
    )
      return Promise.resolve(undefined);
    const immediate = this.available() ? this.grant() : undefined;
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const finish = (grant: boolean) => {
        this.queue.delete(key);
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        resolve(grant ? this.grant() : undefined);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, this.timeoutMs);
      signal.addEventListener("abort", cancel, { once: true });
      this.queue.set(key, () => finish(true));
    });
  }
}
