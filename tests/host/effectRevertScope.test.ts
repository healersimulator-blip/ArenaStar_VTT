/**
 * Phase-0 characterization: **how far GM Revert reaches today**.
 *
 * Companion to `CONDITION_EFFECT_REVERT_GAP_AND_PLAN.md`. These tests pin the *current*
 * behaviour of the three revert mechanisms for the two condition/effect homes, so the
 * implementation slices in that plan have a red→green target:
 *
 *   1. a condition write submitted as an ordinary intent is restored by global Undo;
 *   2. the same write inside a host-audited envelope is restored by the named GM Revert —
 *      the machinery is field-agnostic;
 *   3. the shipped condition library's ops (`pf1eApplyActorEffect`, a whole-array diff on
 *      `actor.effects`) behave the same way;
 *   4. but a receipt's staleness gate is WHOLE-DOCUMENT: one later unrelated HP edit on the
 *      same actor refuses the whole revert (contrast: the F01 ledger's gate is per-path,
 *      `tests/packages/rollLedger.test.ts` "staleness gate").
 *
 * Cases 2 and 4 reach `HostSync`'s audit plumbing through a narrow private cast. That is the
 * finding, not a shortcut: **no public producer** (maneuver flow, dying tick, first aid,
 * scene sheet, reviewed scripts, automation steps, module API) ever wraps a condition/effect
 * op in an audited envelope or a roll ledger, so there is no public path to exercise. Phase 1
 * of the plan replaces these two cases with public-path tests over a maneuver/dirty-trick card.
 */
import { describe, expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import {
  DocumentStore,
  OpLog,
  UndoStack,
  type StoreMeta,
} from "../../src/core";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type {
  ActorDocument,
  Json,
  UserDocument,
} from "../../src/core/documents";
import { HostSync, gmSessionUser } from "../../src/host/sync";
import { ClientSync } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { pf1eConditionRequest } from "../../src/packages/pf1e/conditions";
import { pf1eApplyActorEffect } from "../../src/packages/pf1e/effectOps";

const meta: StoreMeta = {
  worldId: "w1",
  name: "World",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};
const GM_ID = "gm-key";

function userDoc(id: string, name: string): UserDocument {
  return {
    _id: id,
    type: "user",
    name,
    ownership: { default: 0 },
    flags: {},
    system: {},
    role: "GM",
    character: null,
    color: "#fff",
  };
}

function actorDoc(id: string): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: "Victim",
    ownership: { default: 0 },
    flags: {},
    system: {
      pf1e: {
        hp: 12,
        hpMax: 20,
        abilities: { str: 10, dex: 10, con: 10 },
        conditions: ["Prone"],
      },
    },
    items: [],
    effects: [],
  };
}

const ACTOR_REF = { coll: "actors" as const, id: "victim" };

/** The narrow private surface cases 2 and 4 need; see the file header. */
interface AuditPlumbing {
  commitOps(
    ops: Op[],
    by: string,
    txId: string,
    recordUndo?: boolean,
    audit?: { id: string; label: string },
  ): { ok: true; seq: number } | { ok: false; error: string };
  newActionAudit(label: string): { id: string; label: string };
}

async function setup() {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const host = new HostSync({
    store,
    log,
    undo,
    bus: createEventBus(),
    systemUserId: GM_ID,
    roomId: "room-7",
    verifyHelloSig: async (hello) => hello.sig === "valid",
  });
  const seed: OpEnvelope = {
    seq: 1,
    ts: 0,
    by: GM_ID,
    txId: "seed-1",
    ops: [{ kind: "create", coll: "users", data: userDoc(GM_ID, "GM") }],
  };
  const applied = store.applyEnvelope(seed);
  if (!applied.ok) throw new Error(applied.error);
  log.append(seed, applied.value.inverses);
  undo.push(seed, applied.value.inverses);

  const pair = createTransportPair();
  host.addSession("gm", pair.a, gmSessionUser(GM_ID));
  const gm = new ClientSync({ transport: pair.b, bus: createEventBus(), meta });
  await flushMicrotasks();

  return { host, store, gm, plumbing: host as unknown as AuditPlumbing };
}

const conditionsOf = (store: DocumentStore): unknown =>
  (
    (store.get("actors", "victim") as ActorDocument).system as {
      pf1e: { conditions: unknown };
    }
  ).pf1e.conditions;

const effectsOf = (store: DocumentStore): unknown[] =>
  (store.get("actors", "victim") as ActorDocument).effects;

const receipts = (
  store: DocumentStore,
): readonly { _id: string; status: string }[] =>
  store.getAll("actionReceipts") as readonly { _id: string; status: string }[];

/** A dirty-trick-shaped write: the exact op `planDirtyTrick` produces for the string home. */
const applyConditionOp = (name: string): Op => ({
  kind: "update",
  ref: ACTOR_REF,
  diff: { "system.pf1e.conditions": ["Prone", name] as unknown as Json },
});

describe("GM Revert scope for conditions and effects (Phase-0 characterization)", () => {
  test("an ordinary condition intent is restored by global Undo", async () => {
    const { host, store, gm } = await setup();
    gm.submit([{ kind: "create", coll: "actors", data: actorDoc("victim") }]);
    await flushMicrotasks();
    gm.submit([applyConditionOp("Sickened")]);
    await flushMicrotasks();
    expect(conditionsOf(store)).toEqual(["Prone", "Sickened"]);

    expect(host.undo()).toMatchObject({ ok: true });
    await flushMicrotasks();
    expect(conditionsOf(store)).toEqual(["Prone"]);
  });

  test("an audited condition write is restored by the named GM Revert (field-agnostic machinery)", async () => {
    const { store, gm, plumbing } = await setup();
    gm.submit([{ kind: "create", coll: "actors", data: actorDoc("victim") }]);
    await flushMicrotasks();

    const audit = plumbing.newActionAudit("Characterization: dirty trick");
    const committed = plumbing.commitOps(
      [applyConditionOp("Entangled")],
      GM_ID,
      "chars-tx-1",
      true,
      audit,
    );
    expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true });
    await flushMicrotasks();
    expect(conditionsOf(store)).toEqual(["Prone", "Entangled"]);
    expect(receipts(store).map((r) => r.status)).toEqual(["ready"]);

    gm.actionRevert(audit.id);
    await flushMicrotasks();
    expect(conditionsOf(store)).toEqual(["Prone"]);
    expect(receipts(store)[0]?.status).toBe("reverted");
  });

  test("the shipped condition library's whole-array effect diff follows the same two paths", async () => {
    const { host, store, gm, plumbing } = await setup();
    gm.submit([{ kind: "create", coll: "actors", data: actorDoc("victim") }]);
    await flushMicrotasks();

    const request = pf1eConditionRequest("Entangled");
    if (!request.ok) throw new Error(request.error);
    const opsFor = (id: string) => {
      const applied = pf1eApplyActorEffect(
        store.get("actors", "victim") as ActorDocument,
        { id: GM_ID, role: "GM" },
        { name: request.value.name, payload: request.value.payload, id },
      );
      expect(applied.error, String(applied.error)).toBeNull();
      return applied.ops as unknown as Op[];
    };

    // (a) ordinary intent → Undo removes the effect document again.
    gm.submit(opsFor("eff-entangled-a"));
    await flushMicrotasks();
    expect(effectsOf(store)).toHaveLength(1);
    expect(host.undo()).toMatchObject({ ok: true });
    await flushMicrotasks();
    expect(effectsOf(store)).toHaveLength(0);

    // (b) the identical ops inside an audited envelope → named GM Revert removes it too.
    const audit = plumbing.newActionAudit(
      "Characterization: condition library",
    );
    expect(
      plumbing.commitOps(
        opsFor("eff-entangled-b"),
        GM_ID,
        "chars-tx-2",
        true,
        audit,
      ),
    ).toMatchObject({ ok: true });
    await flushMicrotasks();
    expect(effectsOf(store)).toHaveLength(1);
    gm.actionRevert(audit.id);
    await flushMicrotasks();
    expect(effectsOf(store)).toHaveLength(0);
  });

  test("receipt staleness is whole-document: one later HP edit refuses the condition revert", async () => {
    const { store, gm, plumbing } = await setup();
    gm.submit([{ kind: "create", coll: "actors", data: actorDoc("victim") }]);
    await flushMicrotasks();

    const audit = plumbing.newActionAudit("Characterization: stale receipt");
    plumbing.commitOps(
      [applyConditionOp("Shaken")],
      GM_ID,
      "chars-tx-3",
      true,
      audit,
    );
    await flushMicrotasks();

    // An unrelated path on the same document — combat damage — is enough to refuse.
    gm.submit([
      {
        kind: "update",
        ref: ACTOR_REF,
        diff: { "system.pf1e.hp": 5 as unknown as Json },
      },
    ]);
    await flushMicrotasks();

    const rejected: Array<{ reason?: string; detail?: string }> = [];
    const bus = (
      gm as unknown as {
        bus: { on(k: string, fn: (e: unknown) => void): void };
      }
    ).bus;
    bus.on("rejected", (e) => rejected.push(e as { detail?: string }));

    gm.actionRevert(audit.id);
    await flushMicrotasks();
    expect(receipts(store)[0]?.status).toBe("ready");
    expect(conditionsOf(store)).toEqual(["Prone", "Shaken"]);
    expect(rejected.at(-1)?.detail).toBe(
      "Action is stale: actors/victim changed after this run",
    );
  });
});
