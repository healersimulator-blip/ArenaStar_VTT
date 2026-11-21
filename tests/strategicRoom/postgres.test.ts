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

/** Graceful restart: release the advisory lease, then reopen from committed PostgreSQL state. */
async function reopen(room: string) {
  for (const a of authorities.splice(0)) await a.close();
  for (const db of dbs.splice(0)) await db.dispose();
  const db = database(room);
  const authority = await StrategicAuthority.open(db, signal(), later);
  authorities.push(authority);
  return { db, authority };
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

  test("names, unit grants, invites, kick and ban are durable and enforced", async () => {
    const f = await fixture();
    const kick = vi.fn();
    const a = await StrategicAuthority.open(f.db, { ...signal(), kick }, later);
    authorities.push(a);
    const gm = await member(f.db, f.members.gm);
    const red = await member(f.db, f.members["commander-2"]);

    // GM assigns a display name; players cannot.
    expect(
      await a.submit(gm, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-2",
        name: "  Vanguard  ",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      (await f.db.roster()).find((m) => m.id === "commander-2")?.name,
    ).toBe("Vanguard");
    expect(
      await a.submit(red, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-2",
        name: "Me",
      }),
    ).toMatchObject({ code: "forbidden" });
    expect(
      (await f.db.roster()).find((m) => m.id === "commander-2")?.name,
    ).toBe("Vanguard");

    // Only the GM may widen a grant, and only to that commander's own deployment.
    expect(
      await a.submit(red, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-2",
        units: ["unit-1-1"],
      }),
    ).toMatchObject({ code: "forbidden" });
    expect(
      await a.submit(gm, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-2",
        units: ["unit-1-1"],
      }),
    ).toMatchObject({ code: "invalid_order" });

    // Grants gate the order path and the visible list, not just the rendered UI.
    const redUnits = a.battle.own(red).map((unit) => unit.id);
    expect(redUnits.length).toBe(5);
    const [kept, removed] = redUnits as [string, string];
    expect(await a.submit(red, order(removed))).toMatchObject({ revision: 1 });
    expect(await a.submit(red, order(kept, 1, 1))).toMatchObject({
      revision: 2,
    });
    expect(
      await a.submit(gm, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-2",
        units: [kept],
      }),
    ).toMatchObject({ status: "accepted" });
    // The withdrawn order is gone and the commander's revision moved, so their in-flight
    // batch cannot silently re-add it.
    const after = await f.db.privateState(red);
    expect(after?.orders.revision).toBe(3);
    expect(after?.orders.edits.map((e) => e.unitId)).toEqual([kept]);
    expect(await a.submit(red, order(removed, 1, 3))).toMatchObject({
      code: "invalid_order",
    });
    expect(a.battle.own(red).map((u) => u.id)).toEqual([kept]);
    // The GM still sees the withdrawn unit as part of the seat's deployment, so it can be
    // granted back; the grant list itself is what shrank.
    const seat = (await f.db.roster()).find((m) => m.id === "commander-2");
    expect(seat?.units).toEqual([kept]);
    expect(seat?.deployed).toEqual([...redUnits].sort());

    // Invites: a bound seat cannot be re-invited. The scenario fixture binds every seat, so a
    // second room leaves one commander unclaimed to exercise the real invite path.
    expect(
      await a.submit(gm, {
        kind: "member.invite",
        requestId: id(),
        memberId: "commander-2",
        invite: "z".repeat(32),
      }),
    ).toMatchObject({ code: "forbidden" });
    // Kick drops the live session without revoking the seat.
    expect(
      await a.submit(gm, {
        kind: "member.kick",
        requestId: id(),
        memberId: "commander-2",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(kick).toHaveBeenCalledWith("commander-2");
    expect(
      (await f.db.roster()).find((m) => m.id === "commander-2"),
    ).toMatchObject({
      claimed: true,
    });
    expect(await f.db.admit(f.members["commander-2"])).not.toBeNull();

    // Ban is permanent for the battle: the bound key stops being admitted and the seat leaves
    // the roster. (The live-session drop itself belongs to the session edge.)
    expect(
      await a.submit(gm, {
        kind: "member.revoke",
        requestId: id(),
        memberId: "commander-2",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(await f.db.admit(f.members["commander-2"])).toBeNull();
    expect((await f.db.roster()).some((m) => m.id === "commander-2")).toBe(
      false,
    );
  });

  test("an unclaimed seat can be invited once, then the bound key is the only way in", async () => {
    const room = `test-${id()}`;
    const scenario = generatedScenario();
    const db = database(room);
    await db.migrate();
    await db.create(scenario, deploy(scenario), { gm: "11".repeat(32) });
    testRooms.push(room);
    const a = await StrategicAuthority.open(db, signal(), later);
    authorities.push(a);
    const gm = await member(db, "11".repeat(32));
    expect(
      (await db.roster()).filter((m) => m.role === "PLAYER" && !m.claimed),
    ).toHaveLength(2);
    const issued = "y".repeat(32);
    expect(
      await a.submit(gm, {
        kind: "member.invite",
        requestId: id(),
        memberId: "commander-2",
        invite: issued,
      }),
    ).toMatchObject({
      status: "accepted",
      invites: { "commander-2": issued },
    });
    // The GM roster can resend the same accepted code after a reload.
    expect(
      (await db.roster()).find((m) => m.id === "commander-2")?.invite,
    ).toBe(issued);
    expect(await db.admit("55".repeat(32), "n".repeat(32))).toBeNull();
    expect((await db.admit("44".repeat(32), "y".repeat(32)))?.id).toBe(
      "commander-2",
    );
    // The code is one-time: neither another key nor a replay can use it again.
    expect(await db.admit("66".repeat(32), "y".repeat(32))).toBeNull();
    expect(await db.admit("44".repeat(32))).toMatchObject({
      id: "commander-2",
    });
    expect(
      await a.submit(gm, {
        kind: "member.invite",
        requestId: id(),
        memberId: "commander-2",
        invite: "w".repeat(32),
      }),
    ).toMatchObject({ code: "forbidden" });
    expect(
      (await db.roster()).find((m) => m.id === "commander-2"),
    ).toMatchObject({
      claimed: true,
      invite: null,
    });
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
    // A failed pin check acquired the advisory lock before checking the build. Its
    // rejection must also leave a clean handoff, without a sleep or retry window.
    const replacement = database(f.room);
    const claimed = await replacement.acquire(() => undefined);
    expect(claimed.room.version).toBe(1);
  });

  test("one seat's grant survives restart without disabling every other seat", async () => {
    const f = await fixture();
    const a = await StrategicAuthority.open(f.db, signal(), later);
    authorities.push(a);
    const gm = await member(f.db, f.members.gm);
    const red = await member(f.db, f.members["commander-2"]);
    expect(a.battle.own(red).map((u) => u.id)).toHaveLength(5);
    expect(
      await a.submit(gm, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-1",
        units: ["unit-1-1"],
      }),
    ).toMatchObject({ status: "accepted" });

    const { db, authority } = await reopen(f.room);
    const restartedRed = await member(db, f.members["commander-2"]);
    expect(authority.battle.own(restartedRed).map((u) => u.id)).toHaveLength(5);
    expect(
      await authority.submit(restartedRed, order("unit-2-1")),
    ).toMatchObject({ status: "accepted" });
    expect(
      (await db.roster()).find((m) => m.id === "commander-2")?.units,
    ).toHaveLength(5);
    expect(
      (await db.roster()).find((m) => m.id === "commander-1")?.units,
    ).toEqual(["unit-1-1"]);
  });

  test("an explicit empty allowlist stays empty after restart", async () => {
    const f = await fixture();
    const a = await StrategicAuthority.open(f.db, signal(), later);
    authorities.push(a);
    const gm = await member(f.db, f.members.gm);
    const blue = await member(f.db, f.members["commander-1"]);
    expect(
      await a.submit(gm, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-1",
        units: [],
      }),
    ).toMatchObject({ status: "accepted" });
    expect(a.battle.own(blue)).toEqual([]);

    const { db, authority } = await reopen(f.room);
    const restartedBlue = await member(db, f.members["commander-1"]);
    expect(authority.battle.own(restartedBlue)).toEqual([]);
    expect(
      (await db.roster()).find((m) => m.id === "commander-1")?.units,
    ).toEqual([]);
    expect(
      (await db.roster()).find((m) => m.id === "commander-2")?.units,
    ).toHaveLength(5);
    expect(
      await authority.submit(restartedBlue, order("unit-1-1", 1, 1)),
    ).toMatchObject({ code: "invalid_order" });
  });

  test("invite bumps roster generation and revoke removes both grant representations", async () => {
    const f = await fixture();
    const a = await StrategicAuthority.open(f.db, signal(), later);
    authorities.push(a);
    const gm = await member(f.db, f.members.gm);
    expect(
      await a.submit(gm, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-1",
        units: ["unit-1-1"],
      }),
    ).toMatchObject({ status: "accepted" });
    expect(await f.db.grants("commander-1")).toEqual(["unit-1-1"]);
    // Simulate a seat whose browser identity was never claimed, so an invite is legal.
    await f.db.pool.query(
      "UPDATE strategic_members SET public_key=NULL WHERE room_id=$1 AND id='commander-1'",
      [f.room],
    );

    const beforeInvite = a.room.members;
    const inviteCode = "g".repeat(32);
    expect(
      await a.submit(gm, {
        kind: "member.invite",
        requestId: id(),
        memberId: "commander-1",
        invite: inviteCode,
      }),
    ).toMatchObject({
      status: "accepted",
      invites: { "commander-1": inviteCode },
    });
    await vi.waitFor(() =>
      expect(a.room.members).toBeGreaterThan(beforeInvite),
    );
    expect(
      (await f.db.roster()).find((m) => m.id === "commander-1")?.invite,
    ).toBe(inviteCode);

    expect(
      await a.submit(gm, {
        kind: "member.revoke",
        requestId: id(),
        memberId: "commander-1",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(await f.db.grants("commander-1")).toBeNull();
    const legacy = await f.db.pool.query(
      "SELECT unit_id FROM strategic_control WHERE room_id=$1 AND member_id='commander-1'",
      [f.room],
    );
    expect(legacy.rowCount).toBe(0);
    expect(
      (await f.db.roster()).find((m) => m.id === "commander-1"),
    ).toBeUndefined();
  });

  test("a later grant edit does not rewrite an older publication's control", async () => {
    const f = await fixture();
    const a = await StrategicAuthority.open(f.db, signal(), later);
    authorities.push(a);
    const gm = await member(f.db, f.members.gm);
    expect(await a.submit(gm, close(1))).toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(a.room.phase).toBe("report"));
    expect((await f.db.version(0)).control).toEqual({});
    expect((await f.db.version(1)).control).toEqual({});
    expect(
      await a.submit(gm, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-1",
        units: ["unit-1-1"],
      }),
    ).toMatchObject({ status: "accepted" });
    expect((await f.db.version(1)).control).toEqual({});
    expect(
      (await f.db.roster()).find((m) => m.id === "commander-1")?.units,
    ).toEqual(["unit-1-1"]);
  });

  test("restricted unit grants gate turn reports and frozen turns snapshot unit.faction", async () => {
    const f = await fixture();
    let captured: Frozen | undefined;
    const hold = async (job: Frozen): Promise<Result> => {
      captured = job;
      await new Promise((r) => setTimeout(r, 80));
      return resolveFrozen(job);
    };
    const a = await StrategicAuthority.open(f.db, signal(), hold);
    authorities.push(a);
    const gm = await member(f.db, f.members.gm);
    const blue = await member(f.db, f.members["commander-1"]);
    expect(
      await a.submit(gm, {
        kind: "member.update",
        requestId: id(),
        memberId: "commander-1",
        units: ["unit-1-1"],
      }),
    ).toMatchObject({ status: "accepted" });
    expect(await a.submit(gm, close(1))).toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(captured).toBeDefined());
    await vi.waitFor(() => expect(a.room.phase).toBe("report"));
    expect((await f.db.report(blue, 1, 0)).map((r) => r.unitId)).toEqual([
      "unit-1-1",
    ]);
    expect(
      await a.submit(gm, {
        kind: "turn.next",
        requestId: id(),
        turnId: 1,
        durationMs: null,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await a.submit(gm, {
        kind: "unit.faction",
        requestId: id(),
        unitId: "unit-1-1",
        factionId: "red",
      }),
    ).toMatchObject({ status: "accepted" });
    const frozenTurn1 = await f.db.pool.query<{ scenario: Frozen["scenario"] }>(
      "SELECT scenario FROM strategic_frozen WHERE room_id=$1 AND turn_id=1",
      [f.room],
    );
    expect(
      frozenTurn1.rows[0]?.scenario.commanders
        .find((c) => c.id === "commander-1")
        ?.units.find((u) => u.id === "unit-1-1")?.factionId,
    ).toBeUndefined();
    expect(a.battle.unitFactions()["unit-1-1"]).toBe("red");
  });

  test("GM roster.assign swaps commander teams and transfers 5-unit commands atomically", async () => {
    const f = await fixture();
    const a = await StrategicAuthority.open(f.db, signal(), later);
    authorities.push(a);
    const gm = await member(f.db, f.members.gm);
    expect(
      await a.submit(gm, {
        kind: "roster.assign",
        requestId: id(),
        assignments: [
          {
            memberId: "commander-1",
            factionId: "red",
            units: ["unit-2-1", "unit-2-2", "unit-2-3", "unit-2-4", "unit-2-5"],
          },
          {
            memberId: "commander-2",
            factionId: "blue",
            units: ["unit-1-1", "unit-1-2", "unit-1-3", "unit-1-4", "unit-1-5"],
          },
        ],
      }),
    ).toMatchObject({ status: "accepted" });
    const swappedOne = await member(f.db, f.members["commander-1"]);
    const swappedTwo = await member(f.db, f.members["commander-2"]);
    expect(swappedOne.factionId).toBe("red");
    expect(swappedTwo.factionId).toBe("blue");
    expect(a.battle.own(swappedOne).map((u) => u.id)).toEqual([
      "unit-2-1",
      "unit-2-2",
      "unit-2-3",
      "unit-2-4",
      "unit-2-5",
    ]);
    expect(a.battle.own(swappedTwo).map((u) => u.id)).toEqual([
      "unit-1-1",
      "unit-1-2",
      "unit-1-3",
      "unit-1-4",
      "unit-1-5",
    ]);
    expect(
      await a.submit(swappedOne, {
        kind: "orders.submit",
        requestId: id(),
        turnId: 1,
        expectedRevision: 0,
        unitEdits: [
          {
            unitId: "unit-2-1",
            order: { kind: "attack", targetUnitId: "unit-1-1", mode: "melee" },
          },
        ],
      }),
    ).toMatchObject({ status: "accepted", revision: 1 });
    expect(await a.submit(gm, close(1))).toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(a.room.phase).toBe("report"));
    expect((await f.db.report(swappedOne, 1, 0)).map((r) => r.unitId)).toEqual([
      "unit-2-1",
      "unit-2-2",
      "unit-2-3",
      "unit-2-4",
      "unit-2-5",
    ]);
  });
});
