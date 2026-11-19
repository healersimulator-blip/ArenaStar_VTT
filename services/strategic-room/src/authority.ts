import { Worker } from "node:worker_threads";
import {
  reject,
  type Command,
  type Receipt,
} from "../../../src/core/strategicRoom/protocol";
import { BattleView } from "./battle";
import { PostgresRoom, StaleAuthority } from "./postgres";
import type { Scenario } from "./scenario";
import type { Frozen, Member, Result, RoomRecord } from "./state";

export const COMMAND_BACKLOG = 1024;
const WORKER_LIMIT_MS = 30_000;
export type ResolveJob = (job: Frozen, signal: AbortSignal) => Promise<Result>;

export function runWorker(job: Frozen, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: job,
    });
    const stop = (reason: Error) => {
      void worker.terminate();
      reject(reason);
    };
    const timeout = setTimeout(
      () => stop(new Error("Resolver CPU limit exceeded.")),
      WORKER_LIMIT_MS,
    );
    const cancel = () => stop(new Error("Authority stopped."));
    signal.addEventListener("abort", cancel, { once: true });
    worker.once("message", (result: Result) => resolve(result));
    worker.once("error", reject);
    worker.once("exit", () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      reject(new Error("Resolver exited before returning a result."));
    });
  });
}

/** Orders and both kinds of close share a FIFO. The timer gets a reserved slot. */
export class CommandLane {
  private end: Promise<void> = Promise.resolve();
  private size = 0;

  enqueue<T>(fn: () => Promise<T>, barrier = false): Promise<T> | null {
    if (!barrier && this.size >= COMMAND_BACKLOG) return null;
    this.size++;
    const work = this.end.then(fn);
    this.end = work
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.size--;
      });
    return work;
  }

  drain() {
    return this.end;
  }
}

type Notify = {
  change: (room: RoomRecord) => void;
  revoke: (id: string) => void;
  lost: () => void;
};

export class StrategicAuthority {
  private readonly lane = new CommandLane();
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolving = false;
  private closingAt: number | undefined;
  private lastChange: NodeJS.Immediate | undefined;
  private job: Promise<void> | undefined;
  private constructor(
    readonly db: PostgresRoom,
    public room: RoomRecord,
    readonly scenario: Scenario,
    private readonly projectionKey: Buffer,
    public battle: BattleView,
    private readonly notify: Notify,
    private readonly resolveJob: ResolveJob,
    private readonly clock: () => number,
  ) {}

  static async open(
    db: PostgresRoom,
    notify: Notify,
    resolveJob = runWorker,
    clock = Date.now,
  ) {
    const lease = { authority: undefined as StrategicAuthority | undefined };
    const { room, scenario, key } = await db.acquire(() => {
      lease.authority?.lose();
      notify.lost();
    });
    const battle = new BattleView(
      scenario,
      await db.version(room.version),
      key,
    );
    if (db.generation !== room.generation)
      throw new StaleAuthority("Lease lost during startup.");
    const authority = (lease.authority = new StrategicAuthority(
      db,
      room,
      scenario,
      key,
      battle,
      notify,
      resolveJob,
      clock,
    ));
    authority.schedule();
    return authority;
  }

  get active() {
    return !this.abort.signal.aborted;
  }

  async submit(
    member: Member,
    cmd: Command,
    admittedAt = this.clock(),
  ): Promise<Receipt> {
    const queued = performance.now();
    const work = this.lane.enqueue(async () => {
      if (!this.active)
        return reject(
          cmd.requestId,
          "unavailable",
          "Authority is unavailable. Retry the same request after reconnect.",
        );
      const begin = performance.now();
      const result = await this.db.command(
        member,
        cmd,
        admittedAt,
        this.scenario.seed,
        (edit) => this.battle.validate(member, edit),
      );
      if (result.revoked) this.notify.revoke(result.revoked);
      if (result.room) this.changed(result.room);
      if (cmd.kind === "orders.submit")
        this.metric("order", {
          queueMs: begin - queued,
          durableMs: performance.now() - queued,
          accepted: result.receipt.status === "accepted",
        });
      return result.receipt;
    });
    try {
      return work === null
        ? reject(cmd.requestId, "busy", "Order lane full; retry this request.")
        : await work;
    } catch (error) {
      if (error instanceof StaleAuthority) {
        this.lose();
        this.notify.lost();
      } else console.error("Strategic command transaction failed.");
      return reject(
        cmd.requestId,
        "unavailable",
        "Commit status unknown; retry the same request.",
      );
    }
  }

  private metric(stage: string, data: Record<string, unknown>) {
    if (process.env.STRATEGIC_METRICS === "1")
      console.log(JSON.stringify({ stage, room: this.db.id, ...data }));
  }

  private changed(room: RoomRecord) {
    this.room = room;
    if (!this.lastChange) {
      // Prioritize the originating command's durable ACK before fan-out.
      this.lastChange = setImmediate(() => {
        this.lastChange = undefined;
        if (this.active) this.notify.change(this.room);
      });
    }
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.active) return;
    const { phase, deadlineMs, turnId } = this.room;
    if (phase === "orders" && deadlineMs !== null) {
      this.timer = setTimeout(
        () => {
          // A queued command retains its server admission time, not its DB execution time.
          this.lane
            .enqueue(async () => {
              if (!this.active) return;
              const next = await this.db.closeDeadline(
                turnId,
                this.clock(),
                this.scenario.seed,
              );
              if (next) this.changed(next);
              else if (
                this.room.turnId === turnId &&
                this.room.phase === "orders"
              )
                this.schedule();
            }, true)
            ?.catch(() => {
              this.lose();
              this.notify.lost();
            });
        },
        Math.max(0, deadlineMs - this.clock()),
      );
      this.timer.unref();
    }
    if (phase === "resolution" && !this.resolving) {
      this.resolving = true;
      this.closingAt = performance.now();
      this.job = this.resolve(this.room);
    }
  }

  private async resolve(start: RoomRecord) {
    try {
      const job = await this.db.frozen(start.turnId, this.scenario);
      const loaded = performance.now();
      const result = await this.resolveJob(job, this.abort.signal);
      if (!this.active) return;
      const resolved = performance.now();
      const battle = new BattleView(
        this.scenario,
        result.state,
        this.projectionKey,
      );
      const projected = performance.now();
      // Serialize in-memory state transitions with commands (a durable next could otherwise race installation).
      await this.lane.enqueue(async () => {
        if (!this.active) return;
        const beforeCommit = performance.now();
        const room = await this.db.publish(
          start.turnId,
          start.generation,
          result,
        );
        this.battle = battle;
        this.metric("publish", {
          turnId: start.turnId,
          loadMs: loaded - (this.closingAt ?? loaded),
          workerMs: resolved - loaded,
          projectionMs: projected - resolved,
          commitMs: performance.now() - beforeCommit,
          totalMs: performance.now() - (this.closingAt ?? beforeCommit),
          checkpointBytes: result.state.bytes.byteLength,
          reportBytes: result.report.byteLength,
          ...result.metrics,
        });
        this.changed(room);
      }, true);
    } catch (error) {
      if (!this.active) return;
      if (error instanceof StaleAuthority) {
        this.lose();
        this.notify.lost();
        return;
      }
      console.error("Strategic resolution failed; frozen input retained.");
      try {
        await this.lane.enqueue(async () => {
          if (!this.active) return;
          const paused = await this.db.pause(start.turnId, start.generation);
          if (paused) this.changed(paused);
        }, true);
      } catch {
        this.lose();
        this.notify.lost();
      }
    } finally {
      this.resolving = false;
      // A retry/close can have committed while a previous resolution was unwinding.
      if (this.active && this.room.phase === "resolution") this.schedule();
    }
  }

  private lose() {
    this.abort.abort();
    clearTimeout(this.timer);
    if (this.lastChange) clearImmediate(this.lastChange);
  }

  async close() {
    this.lose();
    await this.job;
    await this.lane.drain();
    await this.db.dispose();
  }
}
