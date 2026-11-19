/**
 * §7/§6.1 AssetTransfer — chunked asset streaming with resume, priority queue
 * and a per-peer bandwidth cap.
 *
 * - Chunks are 16–64 KB (default 32 KB), sent on the `assets` channel via the
 *   sink the host wires in (HostSync sessions).
 * - `request(peerId, assetId, offset, priority)` enqueues or resumes a job;
 *   scene > ui > audio > preload, FIFO within a priority.
 * - Pacing: after sending C bytes to a peer, that peer's next chunk is not due
 *   for C / bytesPerSecond seconds (D-040).
 * - A missing asset is reported as the sentinel chunk
 *   `{ offset: 0, total: 0, bytes: [], done: true }` (D-039).
 */
import type { AssetChunkMsg, AssetPriority } from "../core/messages";
import type { AssetId } from "../core/ids";
import type { PeerId } from "../core/ids";

/** Ranked per §7: current scene > UI > audio > preload of other scenes. */
const PRIORITY_RANK: Record<AssetPriority, number> = {
  scene: 0,
  ui: 1,
  audio: 2,
  preload: 3,
};

export const ASSET_CHUNK_SIZE = 32 * 1024;
/** Default per-peer cap: 1 MiB/s (configurable). */
export const ASSET_BYTES_PER_SECOND = 1024 * 1024;

/** Read a range of one asset; `undefined` when the asset is unknown. */
export type AssetChunkSource = (
  assetId: AssetId,
  offset: number,
  length: number,
  /** The requesting peer; sources with per-viewer ACL re-check every chunk. */
  peerId?: PeerId,
) => Promise<{ bytes: Uint8Array; total: number } | undefined>;

export type AssetChunkSink = {
  send(peerId: PeerId, chunk: AssetChunkMsg): void;
};

export interface AssetTransferOptions {
  chunkSize?: number;
  bytesPerSecond?: number;
  now?: () => number;
  /** Injectable sleep for tests; must resolve after `ms` (may be immediate). */
  sleep?: (ms: number) => Promise<void>;
}

interface Job {
  peerId: PeerId;
  assetId: AssetId;
  offset: number;
  priority: AssetPriority;
  /** Arrival order for FIFO within a priority class. */
  seq: number;
}

export class AssetTransfer {
  private readonly chunkSize: number;
  private readonly bytesPerSecond: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly jobs = new Map<string, Job>(); // key: peerId + assetId
  private nextSeq = 0;
  /** peerId → epoch ms when the next chunk may be sent (bandwidth cap). */
  private readonly nextAllowedAt = new Map<PeerId, number>();
  private pumping = false;
  private pumpScheduled = false;

  constructor(
    private readonly source: AssetChunkSource,
    private readonly sink: AssetChunkSink,
    options: AssetTransferOptions = {},
  ) {
    this.chunkSize = options.chunkSize ?? ASSET_CHUNK_SIZE;
    this.bytesPerSecond = options.bytesPerSecond ?? ASSET_BYTES_PER_SECOND;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number) => (ms <= 0 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms))));
  }

  /** Enqueue a transfer, or resume/replace an existing one at `offset`. */
  request(peerId: PeerId, assetId: AssetId, offset: number, priority: AssetPriority): void {
    const key = jobKey(peerId, assetId);
    const existing = this.jobs.get(key);
    if (existing) {
      existing.offset = offset;
      if (PRIORITY_RANK[priority] < PRIORITY_RANK[existing.priority]) {
        existing.priority = priority;
      }
    } else {
      this.jobs.set(key, {
        peerId,
        assetId,
        offset,
        priority,
        seq: this.nextSeq++,
      });
    }
    this.schedulePump();
  }

  /** Stop work for a disconnected session, including its pacing state. */
  dropPeer(peerId: PeerId): void {
    this.nextAllowedAt.delete(peerId);
    for (const [key, job] of this.jobs) if (job.peerId === peerId) this.jobs.delete(key);
  }

  /** Number of queued (in-flight) transfers. */
  get queued(): number {
    return this.jobs.size;
  }

  /** Test/introspection hook: queued job offsets. */
  snapshot(): Array<{ peerId: PeerId; assetId: AssetId; offset: number; priority: AssetPriority }> {
    return [...this.jobs.values()].map(({ peerId, assetId, offset, priority }) => ({
      peerId,
      assetId,
      offset,
      priority,
    }));
  }

  /**
   * Start the pump on a microtask so all requests queued in the same tick are
   * ranked together (a synchronous start would commit to the first request
   * before a higher-priority one arrives).
   */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private dueJob(): Job | undefined {
    let best: Job | undefined;
    for (const job of this.jobs.values()) {
      const gate = this.nextAllowedAt.get(job.peerId) ?? 0;
      if (gate > this.now()) continue;
      if (
        !best ||
        PRIORITY_RANK[job.priority] < PRIORITY_RANK[best.priority] ||
        (PRIORITY_RANK[job.priority] === PRIORITY_RANK[best.priority] && job.seq < best.seq)
      ) {
        best = job;
      }
    }
    return best;
  }

  private earliestGate(): number | undefined {
    let earliest: number | undefined;
    for (const job of this.jobs.values()) {
      const gate = this.nextAllowedAt.get(job.peerId);
      if (gate !== undefined && (earliest === undefined || gate < earliest)) earliest = gate;
    }
    return earliest;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.dueJob();
        if (!job) {
          if (this.jobs.size === 0) return; // queue drained — gates are history
          const gate = this.earliestGate();
          if (gate === undefined) return; // no gate can block remaining jobs
          const wait = gate - this.now();
          if (wait > 0) await this.sleep(wait);
          continue;
        }
        const key = jobKey(job.peerId, job.assetId);
        const offset = job.offset;
        const read = await this.source(job.assetId, offset, this.chunkSize, job.peerId).catch(() => undefined);
        if (this.jobs.get(key) !== job || job.offset !== offset) continue; // disconnected or resumed during the read
        if (!read) {
          // Unknown asset → miss sentinel (D-039)
          this.sink.send(job.peerId, {
            kind: "asset.chunk",
            assetId: job.assetId,
            offset: 0,
            total: 0,
            bytes: new Uint8Array(0),
            done: true,
          });
          this.jobs.delete(key);
          continue;
        }
        const end = offset + read.bytes.length;
        const done = end >= read.total;
        this.sink.send(job.peerId, {
          kind: "asset.chunk",
          assetId: job.assetId,
          offset,
          total: read.total,
          bytes: read.bytes,
          done,
        });
        if (this.jobs.get(key) !== job) continue; // sink may have just closed the peer
        // Charge the final (often only) chunk too: thousands of small portraits
        // are still subject to the per-peer byte budget.
        this.nextAllowedAt.set(job.peerId, this.now() + (read.bytes.length / this.bytesPerSecond) * 1000);
        if (done) this.jobs.delete(key);
        else job.offset = end;
      }
    } finally {
      this.pumping = false;
      if (this.jobs.size > 0) this.schedulePump(); // lost-wakeup guard
    }
  }
}

function jobKey(peerId: PeerId, assetId: AssetId): string {
  return `${peerId}\u0000${assetId}`;
}
