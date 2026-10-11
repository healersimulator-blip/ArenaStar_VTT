/** GM-local save coordination. No edit approvals, no per-edit notifications, no cloud claim. */
import type { HostPersister, PersistenceStatus } from "./persistence";

export interface SaveReceipt { savedAt: number; sequence: number }
export interface SaveStatus extends PersistenceStatus { saving: boolean }

/** Track asynchronous work already started; a save waits for that work, not future uploads. */
export class SaveWork {
  /** Monotonic activity stamp for conservative backup consistency checks. */
  version = 0;
  private readonly active = new Set<Promise<unknown>>();
  run<T>(job: () => Promise<T>): Promise<T> {
    this.version++;
    const result = job();
    this.active.add(result);
    // Both handlers resolve: no detached rejected finally-promise.
    const settled = () => { this.active.delete(result); this.version++; };
    void result.then(settled, settled);
    return result;
  }
  async drain(): Promise<void> { await Promise.all([...this.active]); }
}

export class SaveCoordinator {
  writeVersion = 0;
  private readonly listeners = new Set<(status: SaveStatus) => void>();
  private readonly preparations = new Set<() => Promise<unknown>>();
  private readonly domains = new Set<() => Promise<unknown>>();
  private readonly writes = new Map<string, () => Promise<void>>();
  private writeTail: Promise<unknown> = Promise.resolve();
  private writeError: string | null = null;
  private saveError: string | null = null;
  private inFlight: Promise<SaveReceipt> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryAt = 0;
  private failures = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(readonly persister: HostPersister, private readonly now: () => number = Date.now) {}

  get status(): SaveStatus {
    return { ...this.persister.status, error: this.persister.status.error ?? this.writeError ?? this.saveError,
      unsaved: this.persister.status.unsaved || this.writes.size > 0,
      saving: this.inFlight !== null };
  }
  subscribe(listener: (status: SaveStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }
  private publish(): void {
    for (const listener of this.listeners) {
      try { listener(this.status); } catch { /* Presentation must not interrupt saving. */ }
    }
  }
  beforeSave(job: () => Promise<unknown>): () => void {
    this.preparations.add(job);
    return () => { this.preparations.delete(job); };
  }
  addDomain(drain: () => Promise<unknown>): void { this.domains.add(drain); }

  /** Idempotent write-through domains (fog): keep the latest value until storage confirms it. */
  write(key: string, job: () => Promise<void>): void {
    this.writeVersion++;
    this.writes.set(key, job);
    if (this.now() >= this.retryAt) void this.flushWrites().catch(() => undefined);
  }
  /** Reset barriers must confirm their non-undoable epoch before acknowledging success. */
  writeAndFlush(key: string, job: () => Promise<void>): Promise<void> {
    this.write(key, job);
    return this.flushWrites();
  }

  private flushWrites(): Promise<void> {
    const result = this.writeTail.then(async () => {
      // Snapshot once so continuous reveals cannot starve a save barrier.
      for (const [key, job] of [...this.writes]) {
        await job();
        this.writeVersion++;
        if (this.writes.get(key) === job) this.writes.delete(key);
      }
      this.writeError = null;
      this.failures = 0;
      this.retryAt = 0;
      this.publish();
    });
    this.writeTail = result.catch((error: unknown) => {
      this.writeError = error instanceof Error ? error.message : String(error);
      this.retryAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
      this.publish();
    });
    return result;
  }

  start(): void {
    if (this.timer !== null) return;
    this.persister.start();
    this.unsubscribe = this.persister.subscribe(() => this.publish());
    let ticking = false;
    this.timer = setInterval(() => {
      if (ticking || !this.writes.size || this.now() < this.retryAt) return;
      ticking = true;
      void this.flushWrites().catch(() => undefined).finally(() => { ticking = false; });
    }, 1000);
  }

  saveNow(): Promise<SaveReceipt> {
    if (this.inFlight) return this.inFlight;
    const result = (async () => {
      // Let same-turn GM loopback messages reach the host before capturing domain work.
      await Promise.resolve();
      for (const prepare of this.preparations) await prepare();
      await Promise.all([...this.domains].map(drain => drain()));
      await this.flushWrites();
      await this.persister.flush();
      this.saveError = null;
      return { savedAt: this.persister.status.lastSavedAt ?? this.now(), sequence: this.persister.flushedSeq };
    })();
    this.inFlight = result;
    this.publish();
    void result.then(() => {
      this.inFlight = null;
      this.publish();
    }, (error: unknown) => {
      this.inFlight = null;
      this.saveError = error instanceof Error ? error.message : String(error);
      this.publish();
    });
    return result;
  }

  /** For page lifecycle: best-effort, never claim the browser awaits it. */
  async drain(): Promise<void> { await this.saveNow(); }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
