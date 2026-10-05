import { describe, expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import type { ActorDocument, ActionReceiptDocument, CombatantDocument, CombatDocument, Json } from "../../src/core/documents";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { worldSettingsDoc } from "../../src/core/worldSettings";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { HostSync, gmSessionUser } from "../../src/host/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { readWorldClock } from "../../src/packages/pf1e/worldClock";

const meta: StoreMeta = {
  worldId: "poison-world",
  name: "Poison tests",
  system: "pf1e-core",
  systemVersion: "1.0.0",
};
const GM_ID = "gm-poison";

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

function spellcaster(id: string): ActorDocument {
  const actor = actorDoc(id);
  const pf1e = (actor.system as Record<string, unknown>).pf1e as Record<string, unknown>;
  pf1e.spells = {
    casterLevel: 3,
    keyAbility: "wis",
    mode: "prepared",
    slotsPerDay: { "1": 3, "2": 2, "3": 1, "4": 1 },
    slotsUsed: {},
    prepared: [
      { name: "Neutralize Poison", level: 4, expended: false },
      { name: "Delay Poison", level: 2, expended: false },
    ],
  } as unknown as Json;
  return actor;
}

async function setup(rng: () => number = () => 0) {
  const store = new DocumentStore({ meta });
  const host = new HostSync({
    store,
    log: new OpLog(),
    undo: new UndoStack(),
    bus: createEventBus(),
    systemUserId: GM_ID,
    roomId: "poison-room",
    verifyHelloSig: async () => true,
    rng,
  });
  const pair = createTransportPair();
  host.addSession("poison-gm", pair.a, gmSessionUser(GM_ID));
  const clientBus = createEventBus<ClientEvents>();
  const rejected: ClientEvents["rejected"][] = [];
  clientBus.on("rejected", (event) => rejected.push(event));
  const gm = new ClientSync({ transport: pair.b, bus: clientBus, meta });
  await flushMicrotasks();
  return { store, host, gm, rejected };
}

function pf1eOf(actor: ActorDocument): Record<string, unknown> {
  return (actor.system as Record<string, unknown>).pf1e as Record<string, unknown>;
}

function actorOf(store: DocumentStore, id: string): ActorDocument {
  const actor = store.get("actors", id) as ActorDocument | undefined;
  if (!actor) throw new Error(`actor ${id} missing`);
  return actor;
}

function poisonState(actor: ActorDocument): Record<string, unknown> {
  return pf1eOf(actor).afflictions as Record<string, unknown>;
}

function receiptsOf(store: DocumentStore): ActionReceiptDocument[] {
  return [...store.getAll("actionReceipts")] as ActionReceiptDocument[];
}

async function seedActors(gm: ClientSync, actors: readonly ActorDocument[]): Promise<void> {
  gm.submit(actors.map((data) => ({ kind: "create" as const, coll: "actors" as const, data })));
  await flushMicrotasks();
}

describe("host-authoritative PF1e Core poison protocol", () => {
  test("host resolves exposure, applies immediate ability damage atomically, and named Revert restores only that event", async () => {
    const { store, gm, rejected } = await setup();
    await seedActors(gm, [actorDoc("victim")]);

    gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim", poisonId: "greenblood-oil" });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);

    const victim = actorOf(store, "victim");
    const pf1e = pf1eOf(victim);
    expect(pf1e.abilitiesDamage).toEqual({ con: 1 });
    const state = poisonState(victim);
    const courses = state.courses as Record<string, Record<string, unknown>>;
    const course = Object.values(courses)[0];
    expect(course).toMatchObject({ state: "active", doseCount: 1, attemptsResolved: 0, nextAttemptAt: 6 });
    expect((state.exposureAttempts as Record<string, Record<string, unknown>>)).toMatchObject({
      [Object.keys(state.exposureAttempts as object)[0] as string]: { outcome: "contracted", passed: false, dc: 13 },
    });

    const receipt = receiptsOf(store).find((entry) => entry.name === "Poison exposure: Greenblood oil");
    expect(receipt).toBeDefined();
    expect(receipt?.after.find((entry) => entry.ref.coll === "actors"))
      .toMatchObject({ hashMode: "paths", hash: null });
    if (!receipt) throw new Error("poison action receipt missing");
    gm.submit([{ kind: "update", ref: { coll: "actors", id: "victim" },
      diff: { "system.pf1e.hp": 17 as Json } }]);
    await flushMicrotasks();
    gm.actionRevert(receipt._id);
    await flushMicrotasks();

    const reverted = pf1eOf(actorOf(store, "victim"));
    expect(reverted.hp).toBe(17);
    expect(reverted).not.toHaveProperty("afflictions");
    expect(reverted).not.toHaveProperty("abilitiesDamage");
    expect(receiptsOf(store).find((entry) => entry._id === receipt._id)?.status).toBe("reverted");
  });

  test("round-boundary saves receive separate receipts and Revert of one poison tick preserves a sibling course", async () => {
    const { store, gm } = await setup();
    await seedActors(gm, [actorDoc("victim")]);
    gm.submit([{ kind: "create", coll: "settings", data: worldSettingsDoc({ clockSeconds: 0 }) }]);
    await flushMicrotasks();

    gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim", poisonId: "greenblood-oil" });
    await flushMicrotasks();
    gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim", poisonId: "medium-spider-venom" });
    await flushMicrotasks();

    gm.submit([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
      diff: { "system.clockSeconds": 6 as Json } }]);
    await flushMicrotasks();
    expect(readWorldClock(store.getAll("settings"))).toBe(6);

    const victim = actorOf(store, "victim");
    const state = poisonState(victim);
    const courses = state.courses as Record<string, Record<string, unknown>>;
    const greenblood = Object.values(courses).find((course) =>
      (course.definition as Record<string, unknown>).id === "greenblood-oil");
    const spider = Object.values(courses).find((course) =>
      (course.definition as Record<string, unknown>).id === "medium-spider-venom");
    expect(greenblood?.attemptsResolved).toBe(1);
    expect(spider?.attemptsResolved).toBe(1);
    expect(pf1eOf(victim).abilitiesDamage).toEqual({ con: 2, str: 2 });

    const spiderTick = receiptsOf(store).find((entry) => entry.name === "Poison save: Medium spider venom");
    expect(spiderTick?.after.find((entry) => entry.ref.coll === "actors"))
      .toMatchObject({ hashMode: "paths" });
    if (!spiderTick) throw new Error("spider tick receipt missing");
    gm.actionRevert(spiderTick._id);
    await flushMicrotasks();

    const after = actorOf(store, "victim");
    const afterPf1e = pf1eOf(after);
    const afterCourses = poisonState(after).courses as Record<string, Record<string, unknown>>;
    const afterGreenblood = Object.values(afterCourses).find((course) =>
      (course.definition as Record<string, unknown>).id === "greenblood-oil");
    const afterSpider = Object.values(afterCourses).find((course) =>
      (course.definition as Record<string, unknown>).id === "medium-spider-venom");
    expect(afterGreenblood?.attemptsResolved).toBe(1);
    expect(afterSpider?.attemptsResolved).toBe(0);
    expect(afterPf1e.abilitiesDamage).toEqual({ con: 2, str: 1 });
  });

  test("a 1/round save resolves on the affected creature's combat turn when world time is paused", async () => {
    const { store, gm } = await setup();
    await seedActors(gm, [actorDoc("victim")]);
    gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim", poisonId: "greenblood-oil" });
    await flushMicrotasks();
    const before = poisonState(actorOf(store, "victim"));
    const courseId = Object.keys(before.courses as object)[0];
    if (!courseId) throw new Error("poison course missing");

    const combatant: CombatantDocument = { _id: "victim-turn", type: "combatant", name: "Victim",
      ownership: { default: 0 as const }, flags: {}, system: {}, tokenId: "victim-token", actorId: "victim",
      initiative: 10, hidden: false, defeated: false };
    const combat: CombatDocument = {
      _id: "poison-combat", type: "combat", name: "Poison turn", ownership: { default: 0 },
      flags: {}, system: {}, round: 1, turn: 0, combatants: [combatant],
    };
    gm.submit([{ kind: "create", coll: "combats", data: combat }]);
    await flushMicrotasks();

    const course = (poisonState(actorOf(store, "victim")).courses as Record<string, Record<string, unknown>>)[courseId];
    if (!course) throw new Error("poison course missing after turn boundary");
    expect(course).toMatchObject({ attemptsResolved: 1, nextAttemptAt: 12 });
    expect((course.attempts as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: "frequency", timestamp: 6, dc: 13, passed: false,
    });
    expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toEqual({ con: 2 });
  });

  test("Delay Poison spends a prepared source, queues exposure, then resolves it in order when world time expires", async () => {
    const { store, gm, rejected } = await setup();
    await seedActors(gm, [spellcaster("caster"), actorDoc("victim")]);
    gm.submit([{ kind: "create", coll: "settings", data: worldSettingsDoc({ clockSeconds: 0 }) }]);
    await flushMicrotasks();

    gm.requestPF1ePoisonAction({ action: "delay-start", targetActorId: "victim", sourceActorId: "caster",
      spellUse: { kind: "prepared", index: 1 } });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    const prepared = (pf1eOf(actorOf(store, "caster")).spells as Record<string, unknown>).prepared as unknown[];
    expect(prepared[0]).toMatchObject({ name: "Neutralize Poison", expended: false });
    expect(prepared[1]).toMatchObject({ name: "Delay Poison", expended: true });
    expect(poisonState(actorOf(store, "victim")).delayPoison)
      .toMatchObject({ active: true, startedAt: 0, endsAt: 10_800, casterLevel: 3 });

    gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim", poisonId: "greenblood-oil" });
    await flushMicrotasks();
    expect(poisonState(actorOf(store, "victim")).queuedExposures).toHaveLength(1);
    expect(poisonState(actorOf(store, "victim")).exposureAttempts).toEqual({});

    gm.submit([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
      diff: { "system.clockSeconds": 10_800 as Json } }]);
    await flushMicrotasks();
    const victim = actorOf(store, "victim");
    const state = poisonState(victim);
    expect(state.delayPoison).toMatchObject({ active: false, startedAt: null, endsAt: null });
    expect(state.queuedExposures).toHaveLength(0);
    expect(Object.keys(state.exposureAttempts as object)).toHaveLength(1);
    expect(pf1eOf(victim).abilitiesDamage).toEqual({ con: 1 });
    expect(receiptsOf(store).some((entry) => entry.name === "Poison exposure resolves: Greenblood oil")).toBe(true);
  });

  test("Neutralize Poison spends its prepared row, ends the course, and never heals prior damage", async () => {
    const { store, gm } = await setup();
    await seedActors(gm, [spellcaster("caster"), actorDoc("victim")]);
    gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim", poisonId: "greenblood-oil" });
    await flushMicrotasks();
    const before = poisonState(actorOf(store, "victim"));
    const courseId = Object.keys(before.courses as object)[0];
    if (!courseId) throw new Error("poison course missing");

    gm.requestPF1ePoisonAction({ action: "neutralize", targetActorId: "victim", sourceActorId: "caster",
      spellUse: { kind: "prepared", index: 0 }, courseId });
    await flushMicrotasks();

    const course = (poisonState(actorOf(store, "victim")).courses as Record<string, Record<string, unknown>>)[courseId];
    expect(course).toMatchObject({ state: "cured", endReason: "neutralized", doseCount: 1 });
    expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toEqual({ con: 1 });
    const prepared = (pf1eOf(actorOf(store, "caster")).spells as Record<string, unknown>).prepared as unknown[];
    expect(prepared[0]).toMatchObject({ name: "Neutralize Poison", expended: true });
  });
});
