import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StrategicAuthority } from "../../services/strategic-room/src/authority";
import {
  PostgresRoom,
  StaleAuthority,
} from "../../services/strategic-room/src/postgres";
import {
  deploy,
  generatedScenario,
} from "../../services/strategic-room/src/scenario";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import type {
  Frozen,
  Member,
  Result,
} from "../../services/strategic-room/src/state";
import type {
  Command,
  OrdersSubmit,
} from "../../src/core/strategicRoom/protocol";

const url = process.env.STRATEGIC_TEST_DATABASE_URL;
const id = () => randomUUID();
const pin = "resolver-test-v1";
const signal = () => ({ change: vi.fn(), revoke: vi.fn(), lost: vi.fn() });
const order = (
  unitId: string,
  turnId = 1,
  expectedRevision = 0,
): OrdersSubmit => ({
  kind: "orders.submit",
  turnId,
  expectedRevision,
  requestId: id(),
  unitEdits: [{ unitId, order: { kind: "hold", stance: "hold" } }],
});
const close = (turnId: number): Command => ({
  kind: "turn.close",
  requestId: id(),
  turnId,
});
const next = (turnId: number, durationMs: number | null): Command => ({
  kind: "turn.next",
  requestId: id(),
  turnId,
  durationMs,
});
const later = async (job: Frozen) => resolveFrozen(job);

const testRooms: string[] = [];
const dbs: PostgresRoom[] = [];
const authorities: StrategicAuthority[] = [];
function database(room: string, build = pin) {
  const db = new PostgresRoom(url ?? "", room, build);
  dbs.push(db);
  return db;
}
async function fixture() {
  const room = `test-${id()}`;
  const scenario = generatedScenario();
  const db = database(room);
  const members = {
    gm: "11".repeat(32),
    "commander-1": "22".repeat(32),
    "commander-2": "33".repeat(32),
  };
  await db.migrate();
  await db.create(scenario, deploy(scenario), members);
  testRooms.push(room);
  return { db, scenario, room, members };
}
async function member(db: PostgresRoom, key: string) {
  const admitted = await db.admit(key);
  if (!admitted) throw new Error("Test member was not admitted.");
  return admitted;
}

afterEach(async () => {
  await Promise.all(authorities.splice(0).map((a) => a.close()));
  await Promise.all(dbs.splice(0).map((db) => db.dispose()));
  if (url && testRooms.length) {
    const cleaner = new PostgresRoom(url, "cleanup", pin);
    try {
      await cleaner.pool.query(
        "DELETE FROM strategic_rooms WHERE id=ANY($1::text[])",
        [testRooms.splice(0)],
      );
    } finally {
      await cleaner.dispose();
    }
  }
});

describe.skipIf(!url)("real PostgreSQL hosted order/turn authority", () => {
  test("atomically rejects a batch with a foreign unit and durably deduplicates before checking revisions", async () => {
    const { db, members } = await fixture();
    const a = await StrategicAuthority.open(db, signal(), later);
    authorities.push(a);
    const blue = await member(db, members["commander-1"]);
    const hold = order("unit-1-1");
    const invalid = {
      ...hold,
      requestId: id(),
      unitEdits: [...hold.unitEdits, ...order("unit-2-1").unitEdits],
    };
    expect(await a.submit(blue, invalid)).toMatchObject({
      code: "invalid_order",
    });
    expect((await db.privateState(blue))?.orders).toEqual({
      revision: 0,
      edits: [],
    });
    const receipt = await a.submit(blue, hold);
    expect(receipt).toMatchObject({ status: "accepted", revision: 1 });
    expect(
      await a.submit(blue, { ...hold, expectedRevision: 1 }),
    ).toMatchObject({ code: "request_reused" });
    expect(await a.submit(blue, order("unit-1-2"))).toMatchObject({
      code: "stale_revision",
    });
    const additional = order("unit-1-2", 1, 1);
    expect(await a.submit(blue, additional)).toMatchObject({
      status: "accepted",
      revision: 2,
    });
    expect(await a.submit(blue, hold)).toEqual(receipt);
    expect(
      await a.submit(blue, {
        ...order("unit-1-1", 1, 2),
        unitEdits: [{ unitId: "unit-1-1", order: null }],
      }),
    ).toMatchObject({ revision: 3 });
    expect((await db.privateState(blue))?.orders.edits).toEqual(
      additional.unitEdits,
    );
  });

  test("freezes FIFO at manual close; resumes abandoned resolution and fences old publications", async () => {
    const f = await fixture();
    let captured: Frozen | undefined;
    const holdWorker = (job: Frozen, signal: AbortSignal) =>
      new Promise<Result>((_resolve, reject) => {
        captured = job;
        signal.addEventListener(
          "abort",
          () => reject(new Error("worker stopped")),
          { once: true },
        );
      });
    const events = signal();
    const a = await StrategicAuthority.open(f.db, events, holdWorker);
    authorities.push(a);
    const blue = await member(f.db, f.members["commander-1"]),
      gm = await member(f.db, f.members.gm);
    const accepted = order("unit-1-1");
    const gmClose = close(1);
    const [ack, closed, late] = await Promise.all([
      a.submit(blue, accepted),
      a.submit(gm, gmClose),
      a.submit(blue, order("unit-1-2", 1, 1)),
    ]);
    expect([ack, closed, late]).toMatchObject([
      { status: "accepted", revision: 1 },
      { status: "accepted" },
      { code: "turn_closed" },
    ]);
    expect(await a.submit(blue, accepted)).toEqual(ack);
    await vi.waitFor(() =>
      expect(captured?.orders.map((o) => o.unitId)).toEqual(["unit-1-1"]),
    );
    const oldGeneration = f.db.generation;
    await expect(database(f.room).acquire(() => undefined)).rejects.toThrow(
      /owns/,
    );
    const expected = captured ? resolveFrozen(captured) : undefined;
    if (!expected) throw new Error("Missing frozen job");
    // Terminate only this fixture's lease backend, leaving its query pool and
    // frozen data intact. Simulates an unexpected authority DB disconnect.
    const admin = database(f.room);
    const lost = await admin.pool.query<{ ok: boolean }>(
      `WITH room_key AS (SELECT hashtextextended('arenastar-strategic:' || $1, 0) AS value)
      SELECT pg_terminate_backend(pid) AS ok FROM pg_locks, room_key
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = ((value >> 32) & 4294967295)::oid
        AND objid = (value & 4294967295)::oid`,
      [f.room],
    );
    expect(lost.rows).toEqual([{ ok: true }]);
    await vi.waitFor(() => expect(events.lost).toHaveBeenCalledOnce());
    expect(a.active).toBe(false);
    await expect(
      f.db.publish(1, oldGeneration, expected),
    ).rejects.toBeInstanceOf(StaleAuthority);
    const successor = database(f.room);
    const b = await StrategicAuthority.open(successor, signal(), later);
    authorities.push(b);
    await vi.waitFor(() => expect(b.room.phase).toBe("report"));
    expect((await successor.version(1)).hash).toBe(expected.state.hash);
    await expect(
      successor.publish(1, oldGeneration, expected),
    ).rejects.toBeInstanceOf(StaleAuthority);
    await expect(
      successor.publish(1, successor.generation, expected),
    ).rejects.toBeInstanceOf(StaleAuthority);
    expect(await b.submit(gm, gmClose)).toEqual(closed);
    expect(await b.submit(blue, accepted)).toEqual(ack);
    expect((await successor.report(blue, 1, 0)).map((r) => r.unitId)).toEqual([
      "unit-1-1",
      "unit-1-2",
      "unit-1-3",
      "unit-1-4",
      "unit-1-5",
    ]);
    expect(await successor.report(gm, 1, 0)).toHaveLength(10);
    expect(await b.submit(gm, next(1, null))).toMatchObject({
      status: "accepted",
      turnId: 2,
    });
    expect(await b.submit(blue, order("unit-1-1", 1, 0))).toMatchObject({
      code: "turn_closed",
    });
    expect((await successor.privateState(blue))?.orders).toEqual({
      revision: 0,
      edits: [],
    });
  });

  test("uses server admission time at the deadline and revokes access plus unfrozen orders", async () => {
    const f = await fixture();
    const events = signal();
    const a = await StrategicAuthority.open(f.db, events, later);
    authorities.push(a);
    const blue = await member(f.db, f.members["commander-1"]),
      red = await member(f.db, f.members["commander-2"]),
      gm = await member(f.db, f.members.gm);
    await a.submit(gm, close(1));
    await vi.waitFor(() => expect(a.room.phase).toBe("report"));
    await a.submit(gm, next(1, 1500));
    const deadline = a.room.deadlineMs;
    if (!deadline) throw new Error("No cutoff");
    expect(
      await a.submit(blue, order("unit-1-1", 2), deadline - 1),
    ).toMatchObject({ status: "accepted" });
    expect(await a.submit(red, order("unit-2-1", 2), deadline)).toMatchObject({
      code: "turn_closed",
    });
    const revoke: Command = {
      kind: "member.revoke",
      requestId: id(),
      memberId: blue.id,
    };
    expect(await a.submit(red, revoke)).toMatchObject({ code: "forbidden" });
    expect(await a.submit(gm, revoke)).toMatchObject({ status: "accepted" });
    expect(events.revoke).toHaveBeenCalledWith(blue.id);
    expect(await f.db.privateState(blue)).toBeNull();
    expect(await f.db.report(blue, 1, 0)).toEqual([]);
    expect(await f.db.admit(f.members["commander-1"])).toBeNull();
    await vi.waitFor(() => expect(a.room.phase).toBe("report"), {
      timeout: 4000,
    });
    expect((await f.db.frozen(2, f.scenario)).orders).toEqual([]);
  });

  test("failure does not reopen orders; retry uses the original freeze, and a different build cannot claim the room", async () => {
    const f = await fixture();
    let attempts = 0;
    const a = await StrategicAuthority.open(f.db, signal(), async (job) => {
      if (++attempts === 1) throw new Error("test resolver failure");
      return resolveFrozen(job);
    });
    authorities.push(a);
    const gm = await member(f.db, f.members.gm);
    const blue: Member = await member(f.db, f.members["commander-1"]);
    await a.submit(blue, order("unit-1-1"));
    await a.submit(gm, close(1));
    await vi.waitFor(() => expect(a.room.phase).toBe("paused"));
    expect(await a.submit(blue, order("unit-1-2", 1, 1))).toMatchObject({
      code: "turn_closed",
    });
    await a.submit(gm, { kind: "turn.retry", requestId: id(), turnId: 1 });
    await vi.waitFor(() => expect(a.room.phase).toBe("report"));
    expect(attempts).toBe(2);
    expect((await f.db.frozen(1, f.scenario)).orders).toHaveLength(1);
    await a.close();
    await expect(
      database(f.room, "not-the-original-build").acquire(() => undefined),
    ).rejects.toThrow(/pinned build/);
  });
});
