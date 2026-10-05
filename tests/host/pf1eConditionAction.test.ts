import { describe, expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import type { ActorDocument, ActionReceiptDocument, Json } from "../../src/core/documents";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { HostSync, gmSessionUser } from "../../src/host/sync";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import { pf1eApplyConditionApplication } from "../../src/packages/pf1e/conditionApplications";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";

const meta: StoreMeta = {
  worldId: "condition-action-world",
  name: "Condition action tests",
  system: "pf1e-core",
  systemVersion: "1.0.0",
};
const GM_ID = "gm-condition";

function actorDoc(id: string, over: Partial<ActorDocument> = {}): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 0, [GM_ID]: 3 },
    flags: {},
    system: { pf1e: {
      hp: 20,
      hpMax: 20,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      saves: { fort: 0, ref: 0, will: 0 },
      savesAsTotal: true,
      hitDice: 4,
    } },
    items: [],
    effects: [],
    ...over,
  };
}

async function setup() {
  const store = new DocumentStore({ meta });
  const host = new HostSync({
    store,
    log: new OpLog(),
    undo: new UndoStack(),
    bus: createEventBus(),
    systemUserId: GM_ID,
    roomId: "condition-room",
    verifyHelloSig: async () => true,
  });
  const pair = createTransportPair();
  host.addSession("condition-gm", pair.a, gmSessionUser(GM_ID));
  const bus = createEventBus<ClientEvents>();
  const rejected: ClientEvents["rejected"][] = [];
  const results: ClientEvents["conditionActionResult"][] = [];
  bus.on("rejected", (event) => rejected.push(event));
  bus.on("conditionActionResult", (event) => results.push(event));
  const gm = new ClientSync({ transport: pair.b, bus, meta });
  await flushMicrotasks();
  return { store, host, gm, rejected, results };
}

async function seed(gm: ClientSync, ...actors: ActorDocument[]): Promise<void> {
  gm.submit(actors.map((data) => ({ kind: "create" as const, coll: "actors" as const, data })));
  await flushMicrotasks();
}

function actorOf(store: DocumentStore, id: string): ActorDocument {
  const actor = store.get("actors", id) as ActorDocument | undefined;
  if (!actor) throw new Error(`actor ${id} missing`);
  return actor;
}

function receiptsOf(store: DocumentStore): ActionReceiptDocument[] {
  return [...store.getAll("actionReceipts")] as ActionReceiptDocument[];
}

describe("host-authoritative source-addressed condition actions", () => {
  test("apply commits a mechanical keyed application and private receipt; Revert preserves unrelated HP", async () => {
    const { store, gm, results, rejected } = await setup();
    await seed(gm, actorDoc("target"));

    gm.requestPF1eConditionAction({
      action: "apply", actorId: "target", condition: "Shaken",
    });
    await flushMicrotasks();

    expect(rejected).toHaveLength(0);
    expect(results).toHaveLength(1);
    const receiptId = results[0]?.receiptId;
    if (!receiptId) throw new Error("condition action acknowledgement missing");
    const receipt = receiptsOf(store).find((entry) => entry._id === receiptId);
    expect(receipt?.status).toBe("ready");
    expect(receipt?.inverses).toHaveLength(1);
    expect(receipt?.after[0]).toMatchObject({ hashMode: "paths" });

    const applied = actorOf(store, "target");
    const applications = (applied.system as Record<string, unknown>).pf1e as Record<string, unknown>;
    const conditionApps = applications.conditionApplications as Record<string, Record<string, unknown>>;
    const [applicationId, application] = Object.entries(conditionApps)[0] ?? [];
    expect(applicationId).toBe(results[0]?.applicationId);
    expect(application).toMatchObject({
      condition: "Shaken",
      source: { kind: "manual", id: GM_ID, actionId: receiptId },
      removal: { kind: "manual" },
    });
    expect(deriveFromDocuments({ actor: applied }).effectBreakdown.attack).toContain("-2");

    // A change outside the keyed condition path does not stale or get overwritten by Revert.
    gm.submit([{ kind: "update", ref: { coll: "actors", id: "target" },
      diff: { "system.pf1e.hp": 11 } }]);
    await flushMicrotasks();
    gm.actionRevert(receiptId);
    await flushMicrotasks();

    const after = actorOf(store, "target");
    const afterPf1e = (after.system as Record<string, unknown>).pf1e as Record<string, unknown>;
    expect(afterPf1e.hp).toBe(11);
    expect(afterPf1e.conditionApplications).toBeUndefined();
    expect(deriveFromDocuments({ actor: after }).conditions).not.toContain("Shaken");
    expect(receiptsOf(store).find((entry) => entry._id === receiptId)?.status).toBe("reverted");
  });

  test("removing an application is independently Revertable and repeated application IDs stay source-addressable", async () => {
    const { store, gm, results, rejected } = await setup();
    const target = actorDoc("target");
    target.system = { pf1e: {
      ...(target.system as Record<string, unknown>).pf1e as Record<string, unknown>,
      conditionApplications: {
        "grapple-one": { id: "grapple-one", condition: "Grappled", source: { kind: "manual", id: "gm-condition" }, removal: { kind: "manual" } },
        "grapple-two": { id: "grapple-two", condition: "Grappled", source: { kind: "spell", id: "hold-person" }, removal: { kind: "manual" } },
      } as unknown as Json,
    } };
    await seed(gm, target);

    gm.requestPF1eConditionAction({ action: "remove", actorId: "target", applicationId: "grapple-one" });
    await flushMicrotasks();
    expect(rejected).toHaveLength(0);
    expect(results).toHaveLength(1);
    let apps = (((actorOf(store, "target").system as Record<string, unknown>).pf1e as Record<string, unknown>)
      .conditionApplications as Record<string, unknown>);
    expect(Object.keys(apps)).toEqual(["grapple-two"]);
    expect(deriveFromDocuments({ actor: actorOf(store, "target") }).conditions).toContain("Grappled");

    const removeReceipt = results[0]?.receiptId;
    if (!removeReceipt) throw new Error("remove receipt missing");
    gm.actionRevert(removeReceipt);
    await flushMicrotasks();
    apps = (((actorOf(store, "target").system as Record<string, unknown>).pf1e as Record<string, unknown>)
      .conditionApplications as Record<string, unknown>);
    expect(Object.keys(apps).sort()).toEqual(["grapple-one", "grapple-two"]);
  });

  test("unsupported conditions and direct client-authored application Ops are refused", async () => {
    const { store, gm, rejected } = await setup();
    const target = actorDoc("target");
    await seed(gm, target);

    const unsupported = gm.requestPF1eConditionAction({
      action: "apply", actorId: "target", condition: "Reticulated",
    });
    await flushMicrotasks();
    expect(rejected.at(-1)).toMatchObject({ txId: unsupported, reason: "invalid_schema" });
    expect(((actorOf(store, "target").system as Record<string, unknown>).pf1e as Record<string, unknown>)
      .conditionApplications).toBeUndefined();

    const forged = pf1eApplyConditionApplication({ actor: actorOf(store, "target"), condition: "Prone",
      id: "client-prone", source: { kind: "manual", id: GM_ID } });
    if (!forged.ok) throw new Error(forged.error);
    const txId = gm.submit(forged.value);
    await flushMicrotasks();
    expect(rejected.at(-1)).toMatchObject({ txId, reason: "forbidden" });
    expect((actorOf(store, "target").system as Record<string, unknown>).pf1e)
      .not.toHaveProperty("conditionApplications");
  });

  test("a later edit to the same application makes its original Revert stale", async () => {
    const { store, gm, results, rejected } = await setup();
    const target = actorDoc("target");
    target.system = { pf1e: {
      ...(target.system as Record<string, unknown>).pf1e as Record<string, unknown>,
      conditionApplications: {},
    } };
    await seed(gm, target);
    gm.requestPF1eConditionAction({ action: "apply", actorId: "target", condition: "Prone" });
    await flushMicrotasks();
    const firstReceipt = results[0]?.receiptId;
    const applicationId = results[0]?.applicationId;
    if (!firstReceipt || !applicationId) throw new Error("initial condition action missing");

    gm.requestPF1eConditionAction({ action: "remove", actorId: "target", applicationId });
    await flushMicrotasks();
    gm.actionRevert(firstReceipt);
    await flushMicrotasks();

    expect(rejected.at(-1)?.detail).toContain(`conditionApplications.${applicationId}`);
    expect(receiptsOf(store).find((entry) => entry._id === firstReceipt)?.status).toBe("ready");
    expect(((((actorOf(store, "target").system as Record<string, unknown>).pf1e as Record<string, unknown>)
      .conditionApplications as Record<string, unknown> | undefined) ?? {})).not.toHaveProperty(applicationId);
  });
});
