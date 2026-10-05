import { describe, expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import type { ActorDocument, ActionReceiptDocument, CombatantDocument, CombatDocument, Json } from "../../src/core/documents";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { worldSettingsDoc } from "../../src/core/worldSettings";
import type { MessageDocument, UserDocument } from "../../src/core/documents";
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

/**
 * Commit-reveal resolution crosses several promise boundaries (crypto.subtle plus the session
 * queue), so a fixed number of `flushMicrotasks` calls is a guess. Wait for the state instead.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  throw new Error(`timed out waiting for ${label}`);
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

const PLAYER_ID = "player-rex";

function riderUser(id: string, role: "GM" | "PLAYER"): UserDocument {
  return { _id: id, type: "user", name: role === "GM" ? "GM" : "Rex", ownership: { default: 0 },
    flags: {}, system: {}, role, character: null, color: "#eeeeee" };
}

/** A second harness with a real player session, for rider delivery and player-owned saves. */
async function riderSetup() {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const host = new HostSync({
    store, log, undo, bus: createEventBus(), systemUserId: GM_ID, roomId: "poison-rider-room",
    verifyHelloSig: async () => true, rng: () => 0,
  });
  const seed = { seq: 1, ts: 0, by: GM_ID, txId: "seed-rider-users",
    ops: [
      { kind: "create" as const, coll: "users" as const, data: riderUser(GM_ID, "GM") },
      { kind: "create" as const, coll: "users" as const, data: riderUser(PLAYER_ID, "PLAYER") },
    ] };
  const applied = store.applyEnvelope(seed);
  if (!applied.ok) throw new Error(applied.error);
  log.append(seed, applied.value.inverses);
  undo.push(seed, applied.value.inverses);
  const gmPair = createTransportPair();
  const playerPair = createTransportPair();
  host.addSession("rider-gm", gmPair.a, gmSessionUser(GM_ID));
  host.addSession("rider-player", playerPair.a, { id: PLAYER_ID, role: "PLAYER", name: "Rex" });
  const gmBus = createEventBus<ClientEvents>();
  const playerBus = createEventBus<ClientEvents>();
  const rejected: ClientEvents["rejected"][] = [];
  gmBus.on("rejected", (event) => rejected.push(event));
  playerBus.on("rejected", (event) => rejected.push(event));
  const gm = new ClientSync({ transport: gmPair.b, bus: gmBus, meta });
  const player = new ClientSync({ transport: playerPair.b, bus: playerBus, meta });
  // Explicit defer mode: the default "savesChecksAuto" still defers rider saves, but saying it
  // here keeps the test independent of the default's future.
  gm.submit([{ kind: "create", coll: "settings", data: worldSettingsDoc({}) }]);
  await flushMicrotasks();
  return { store, host, gm, player, rejected };
}

/** The attack card a resolved strike posts, with host-roll evidence (D-405 delivery contract). */
function attackCardMessage(input: {
  messageId: string; sourceActorId: string; targetActorId: string; targetName: string;
  attackRollId: string; formula: string; total: number; dc: number; damage?: number;
}): MessageDocument {
  return {
    _id: input.messageId, type: "message", name: "Longsword vs target",
    ownership: { default: 1 }, flags: {},
    system: { action: {
      v: 2, id: input.messageId, revision: 0, kind: "attack", label: "Longsword", state: "resolved",
      source: { name: "attacker", actorId: input.sourceActorId },
      notes: [],
      targets: [{
        key: "target", name: input.targetName, actorId: input.targetActorId, state: "resolved",
        outcome: "hit",
        check: { kind: "attack", status: "resolved", formula: input.formula, dc: input.dc,
          total: input.total, passed: true },
        ...(input.damage !== undefined ? { damage: { dealt: input.damage } } : {}),
        evidence: { adapter: "pf1e.attack.v1", payload: { attackRollId: input.attackRollId } },
      }],
      createdAt: 0, updatedAt: 0,
    } },
    author: "", content: "Longsword hits.", whisper: [], roll: null, flavor: "",
  } as unknown as MessageDocument;
}

async function hostRollId(client: ClientSync, formula: string): Promise<{ rollId: string; total: number }> {
  const rollId = client.roll(formula, "roll", undefined, "attack");
  await flushMicrotasks();
  const message = client.store.getAll("messages").find((candidate) =>
    (candidate.flags as { core?: { rollId?: unknown } })?.core?.rollId === rollId) as MessageDocument | undefined;
  if (!message?.roll) throw new Error(`roll ${rollId} did not replicate`);
  return { rollId, total: message.roll.total };
}

function riderOf(store: DocumentStore, messageId: string): Record<string, unknown> {
  const message = store.get("messages", messageId) as MessageDocument | undefined;
  const action = message?.system.action as Record<string, unknown> | undefined;
  const target = (action?.targets as Record<string, unknown>[] | undefined)?.[0];
  const rider = (target?.riders as Record<string, unknown>[] | undefined)?.[0];
  if (!rider) throw new Error("rider missing from the delivering card");
  return rider;
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

describe("D-405 poison riders on landed interactions", () => {
  test("a landed strike with a coated weapon attaches an applied rider and the exposure is Revertable", async () => {
    const { store, gm, rejected } = await riderSetup();
    await seedActors(gm, [
      actorDoc("attacker", { ownership: { default: 0, [GM_ID]: 3 } }),
      actorDoc("victim", { ownership: { default: 1, [GM_ID]: 3 },
        system: { pf1e: { hp: 20, hpMax: 20, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
          saves: { fort: -30, ref: 0, will: 0 }, savesAsTotal: true, hitDice: 4 } } }),
    ]);
    const { rollId, total } = await hostRollId(gm, "1d20+9");
    const messageId = "attack-card-one";
    gm.submit([{ kind: "create", coll: "messages",
      data: attackCardMessage({ messageId, sourceActorId: "attacker", targetActorId: "victim",
        targetName: "victim", attackRollId: rollId, formula: "1d20+9", total, dc: 10 }) }]);
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    // The card's row is host-verified from the roll, so the rider is legitimate mechanics.
    const action = (store.get("messages", messageId) as MessageDocument).system.action as
      Record<string, unknown>;
    expect((action.targets as Record<string, unknown>[])[0]).toMatchObject({ provenance: "host" });

    gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim", poisonId: "greenblood-oil",
      sourceActorId: "attacker", rider: { actionId: messageId, targetKey: "target" } });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    expect(riderOf(store, messageId)).toMatchObject({
      kind: "poison", label: "Greenblood oil", state: "applied",
      save: { saveType: "fort", dc: 13, total: -29, passed: false },
      evidence: { adapter: "pf1e.poison.v1", payload: {
        definitionId: "greenblood-oil", version: 1, baseDC: 13, route: "injury", doseCount: 1,
        sourceActorId: "attacker" } },
    });
    expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toEqual({ con: 1 });

    // Revert the delivery: the rider row, the course and the damage all come from one receipt.
    const receipt = receiptsOf(store).find((entry) => entry.name.includes("Poison exposure: Greenblood oil"));
    if (!receipt) throw new Error("poison receipt missing");
    gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toBeUndefined();
    const reverted = (store.get("messages", messageId) as MessageDocument).system.action as
      Record<string, unknown>;
    expect((((reverted.targets as Record<string, unknown>[])[0]?.riders as unknown[]) ?? []).length).toBe(0);
  });

  test("a warded victim resists: the rider records the passed save and applies no mechanics", async () => {
    const { store, gm, rejected } = await riderSetup();
    await seedActors(gm, [
      actorDoc("attacker", { ownership: { default: 0, [GM_ID]: 3 } }),
      actorDoc("victim", { ownership: { default: 1, [GM_ID]: 3 },
        system: { pf1e: { hp: 20, hpMax: 20, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
          saves: { fort: 30, ref: 0, will: 0 }, savesAsTotal: true, hitDice: 4 } } }),
    ]);
    const { rollId, total } = await hostRollId(gm, "1d20+9");
    const messageId = "attack-card-two";
    gm.submit([{ kind: "create", coll: "messages",
      data: attackCardMessage({ messageId, sourceActorId: "attacker", targetActorId: "victim",
        targetName: "victim", attackRollId: rollId, formula: "1d20+9", total, dc: 10 }) }]);
    await flushMicrotasks();
    gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim", poisonId: "greenblood-oil",
      sourceActorId: "attacker", rider: { actionId: messageId, targetKey: "target" } });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    expect(riderOf(store, messageId)).toMatchObject({ state: "resisted",
      save: { total: 31, passed: true } });
    expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toBeUndefined();
    expect(Object.keys(poisonState(actorOf(store, "victim")).courses as object)).toEqual([]);
  });

  test("a player-owned victim's rider save stays a host pending roll until that player rolls it", async () => {
    const { store, gm, player, rejected } = await riderSetup();
    await seedActors(gm, [
      actorDoc("attacker", { ownership: { default: 0, [GM_ID]: 3 } }),
      actorDoc("victim", { ownership: { default: 0, [PLAYER_ID]: 3, [GM_ID]: 3 } }),
    ]);
    const { rollId, total } = await hostRollId(gm, "1d20+9");
    const messageId = "attack-card-three";
    gm.submit([{ kind: "create", coll: "messages",
      data: attackCardMessage({ messageId, sourceActorId: "attacker", targetActorId: "victim",
        targetName: "victim", attackRollId: rollId, formula: "1d20+9", total, dc: 10 }) }]);
    await flushMicrotasks();
    const requestId = gm.requestPF1ePoisonAction({ action: "expose", targetActorId: "victim",
      poisonId: "greenblood-oil", sourceActorId: "attacker",
      rider: { actionId: messageId, targetKey: "target" } });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    const pending = (store.get("messages", messageId) as MessageDocument).system.pendingRoll as
      Record<string, unknown>;
    expect(pending).toMatchObject({ kind: "save", saveType: "fort", dc: 13, formula: "1d20", resolved: false,
      actionId: messageId, targetKey: "target", target: { actorId: "victim" } });
    expect(riderOf(store, messageId)).toMatchObject({ state: "pending",
      save: { dc: 13, total: null, pendingRollId: pending.id } });
    // The offer is recorded, but no dose exists until the victim's own roll lands.
    expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toBeUndefined();
    expect(poisonState(actorOf(store, "victim"))).toBeUndefined();

    await player.rollPending(messageId, String(pending.id));
    await waitFor(
      () => Boolean(((store.get("messages", messageId) as MessageDocument).system.pendingRoll as
        Record<string, unknown> | undefined)?.resolved),
      "the player's rider save to resolve",
    );
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    const resolved = (store.get("messages", messageId) as MessageDocument).system.pendingRoll as
      Record<string, unknown>;
    expect(resolved.resolved).toBe(true);
    const rolledTotal = resolved.total as number;
    const passed = rolledTotal >= 13;
    expect(riderOf(store, messageId)).toMatchObject({ state: passed ? "resisted" : "applied",
      save: { total: rolledTotal, passed } });
    if (passed) {
      expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toBeUndefined();
      expect(Object.keys(poisonState(actorOf(store, "victim")).courses as object)).toEqual([]);
    } else {
      expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toEqual({ con: 1 });
      expect(poisonState(actorOf(store, "victim"))).toBeDefined();
    }

    // The continuation envelope owns the mechanics: its Revert restores the pre-save state.
    const receipt = receiptsOf(store).find((entry) => entry.name.includes("Poison exposure save: victim"));
    if (!receipt) throw new Error("continuation receipt missing");
    gm.actionRevert(receipt._id);
    await waitFor(
      () => pf1eOf(actorOf(store, "victim")).abilitiesDamage === undefined &&
        !(((store.get("messages", messageId) as MessageDocument).system.pendingRoll as
          Record<string, unknown> | undefined)?.resolved),
      "the rider-save Revert to restore the pre-save state",
    );
    expect(pf1eOf(actorOf(store, "victim")).abilitiesDamage).toBeUndefined();
    const revertedState = poisonState(actorOf(store, "victim")) as Record<string, unknown> | undefined;
    expect(Object.keys((revertedState?.courses ?? {}) as object)).toEqual([]);
    const restored = (store.get("messages", messageId) as MessageDocument).system.pendingRoll as
      Record<string, unknown>;
    expect(restored.resolved).toBe(false);
    expect(riderOf(store, messageId)).toMatchObject({ state: "pending" });
    void requestId;
  });
});
