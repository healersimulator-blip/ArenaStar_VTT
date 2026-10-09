/**
 * D-407 — a spell's tactical effect rides the landed cast that delivered it.
 *
 * The poison rider (D-405/D-406) proved the pattern on attacks; this is the same shape on a
 * **cast card**: the client names the catalogue effect and the card row, and the host re-reads the
 * row, re-checks the outcome against the same catalogue row, derives the source (caster, item,
 * card) itself and attaches a condition rider to the card. The scene these tests guard is the
 * printed Entangle contract — a failed Reflex save entangles, a made one does not — and the tests
 * deliberately try to lie about the row, the effect and the condition.
 */
import { describe, expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import type {
  ActorDocument,
  ActionReceiptDocument,
  Json,
  MacroDocument,
  MessageDocument,
  SceneDocument,
  TokenDocument,
  Ownership,
  UserDocument,
} from "../../src/core/documents";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { HostSync, gmSessionUser } from "../../src/host/sync";
import { deriveFromActorDocument } from "../../src/packages/pf1e/actor";
import { resolveCastFlow } from "../../src/ui/sheets/pf1eCastFlow";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";

const meta: StoreMeta = {
  worldId: "spell-effect-world",
  name: "Spell effect rider tests",
  system: "pf1e-core",
  systemVersion: "1.0.0",
};
const GM_ID = "gm-spell-effect";
const PLAYER_ID = "player-spell-effect";

function user(id: string, role: "GM" | "PLAYER"): UserDocument {
  return { _id: id, type: "user", name: role === "GM" ? "GM" : "Rex",
    ownership: { default: 0 }, flags: {}, system: {}, role, character: null, color: "#eeeeee" };
}

function actorDoc(id: string, over: Partial<ActorDocument> = {}): ActorDocument {
  return {
    _id: id, type: "actor", name: id, ownership: { default: 0, [GM_ID]: 3 }, flags: {},
    system: { pf1e: {
      hp: 20, hpMax: 20,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      saves: { fort: 0, ref: 0, will: 0 }, savesAsTotal: true, hitDice: 4,
    } },
    items: [], effects: [], ...over,
  };
}

function spellDemoScene(): SceneDocument {
  const token = (id: string, actorId: string, x: number): TokenDocument => ({
    _id: id, type: "token", name: actorId, flags: {}, system: {}, ownership: { default: 0 },
    x, y: 500, rotation: 0, width: 100, height: 100, img: "", actorId,
    hidden: false, disposition: "neutral", vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0 },
  });
  return {
    _id: "scene-jungle", type: "scene", name: "JungleEntrance2 — PF1e Spell Demonstration",
    ownership: { default: 2, [GM_ID]: 3 }, flags: {}, system: {}, active: false,
    img: null, width: 1200, height: 1800, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [token("tok-druid", "druid", 300), token("tok-orc", "orc", 500)],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  };
}

function lightningDemoScene(): SceneDocument {
  const token = (id: string, name: string, actorId: string, x: number, ownership: Ownership): TokenDocument => ({
    _id: id, type: "token", name, flags: {}, system: {}, ownership,
    x, y: 500, rotation: 0, width: 100, height: 100, img: "", actorId,
    hidden: false, disposition: "hostile", vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0 },
  });
  return {
    _id: "scene-jungle", type: "scene", name: "JungleEntrance2 — PF1e Spell Demonstration",
    ownership: { default: 2, [GM_ID]: 3, [PLAYER_ID]: 2 }, flags: {}, system: {}, active: false,
    img: null, width: 1200, height: 1800, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [
      token("tok-hosilla", "Hosilla", "hosilla", 300, { default: 0, [GM_ID]: 3, [PLAYER_ID]: 3 }),
      token("tok-hobgoblin-1", "Hobgoblin Fighter 1", "hobgoblin-fighter-1", 600,
        { default: 2, [GM_ID]: 3, [PLAYER_ID]: 2 }),
    ],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  };
}

function entangledVinesMacro(): MacroDocument {
  return {
    _id: "macro-entangled-vines", type: "macro", name: "Entangled — Token Vines",
    ownership: { default: 1, [GM_ID]: 3 }, flags: { core: { playerCallable: true } }, system: {},
    kind: "sequence", command: "", sequence: { version: 1, persistent: true, audience: "scene",
      sections: [{ kind: "text", id: "vines", text: "vines", at: { kind: "target" },
        startMs: 0, durationMs: 1000 }] },
  };
}

async function setup() {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const host = new HostSync({ store, log, undo, bus: createEventBus(), systemUserId: GM_ID,
    roomId: "spell-effect-room", verifyHelloSig: async () => true });
  const seed = { seq: 1, ts: 0, by: GM_ID, txId: "seed-spell-effect-users",
    ops: [
      { kind: "create" as const, coll: "users" as const, data: user(GM_ID, "GM") },
      { kind: "create" as const, coll: "users" as const, data: user(PLAYER_ID, "PLAYER") },
    ] };
  const applied = store.applyEnvelope(seed);
  if (!applied.ok) throw new Error(applied.error);
  log.append(seed, applied.value.inverses);
  undo.push(seed, applied.value.inverses);
  const gmPair = createTransportPair();
  const playerPair = createTransportPair();
  host.addSession("spell-effect-gm", gmPair.a, gmSessionUser(GM_ID));
  host.addSession("spell-effect-player", playerPair.a, { id: PLAYER_ID, role: "PLAYER", name: "Rex" });
  const gmBus = createEventBus<ClientEvents>();
  const playerBus = createEventBus<ClientEvents>();
  const rejected: ClientEvents["rejected"][] = [];
  const results: ClientEvents["conditionActionResult"][] = [];
  gmBus.on("rejected", (event) => rejected.push(event));
  playerBus.on("rejected", (event) => rejected.push(event));
  gmBus.on("conditionActionResult", (event) => results.push(event));
  playerBus.on("conditionActionResult", (event) => results.push(event));
  const gm = new ClientSync({ transport: gmPair.b, bus: gmBus, meta });
  const player = new ClientSync({ transport: playerPair.b, bus: playerBus, meta });
  await flushMicrotasks();
  return { store, host, gm, player, rejected, results };
}

async function seedActors(gm: ClientSync, actors: readonly ActorDocument[]): Promise<void> {
  gm.submit(actors.map((data) => ({ kind: "create" as const, coll: "actors" as const, data })));
  await flushMicrotasks();
}

/** The cast card `resolveCastFlow` posts, reduced to the fields the rider contract reads. */
function castCardMessage(input: {
  messageId: string; casterId: string; itemId?: string; targetActorId: string;
  targetName?: string; outcome?: "failedSave" | "saved" | "affected" | "resisted";
  dc?: number; total?: number; saveType?: "ref" | "fort" | "will";
  sceneId?: string; casterTokenId?: string; targetTokenId?: string;
}): MessageDocument {
  const resolver = input.outcome === "saved" || input.outcome === "resisted";
  return {
    _id: input.messageId, type: "message", name: `Entangle vs ${input.targetName ?? input.targetActorId}`,
    ownership: { default: 1 }, flags: {},
    system: { action: {
      v: 2, id: input.messageId, revision: 0, kind: "cast", label: "Entangle", state: "resolved",
      source: { name: "druid", actorId: input.casterId,
        ...(input.casterTokenId !== undefined ? { tokenId: input.casterTokenId } : {}),
        ...(input.itemId !== undefined ? { itemId: input.itemId } : {}) },
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      notes: [],
      targets: [{
        key: input.targetActorId, name: input.targetName ?? input.targetActorId,
        actorId: input.targetActorId,
        ...(input.targetTokenId !== undefined ? { tokenId: input.targetTokenId } : {}),
        state: "resolved", outcome: input.outcome ?? "failedSave",
        check: { kind: "save", status: "resolved", formula: "1d20+1", dc: input.dc ?? 15,
          total: input.total ?? (resolver ? 20 : 4), saveType: input.saveType ?? "ref",
          passed: resolver },
      }],
      createdAt: 0, updatedAt: 0,
    } },
    author: "", content: "Entangle.", whisper: [], roll: null, flavor: "",
  } as unknown as MessageDocument;
}

function actorOf(store: DocumentStore, id: string): ActorDocument {
  const actor = store.get("actors", id) as ActorDocument | undefined;
  if (!actor) throw new Error(`actor ${id} missing`);
  return actor;
}

function pf1eOf(actor: ActorDocument): Record<string, unknown> {
  return (actor.system as Record<string, unknown>).pf1e as Record<string, unknown>;
}

function conditionApps(actor: ActorDocument): Record<string, Record<string, unknown>> {
  return (pf1eOf(actor).conditionApplications ?? {}) as Record<string, Record<string, unknown>>;
}

function cardOf(store: DocumentStore, id: string): Record<string, unknown> {
  const message = store.get("messages", id) as MessageDocument | undefined;
  return message?.system.action as Record<string, unknown>;
}

function riderOf(store: DocumentStore, messageId: string): Record<string, unknown> {
  const action = cardOf(store, messageId);
  const target = (action.targets as Record<string, unknown>[])[0];
  const rider = (target?.riders as Record<string, unknown>[] | undefined)?.[0];
  if (!rider) throw new Error("condition rider missing from the delivering card");
  return rider;
}

function messagesOf(store: DocumentStore): MessageDocument[] {
  return [...store.getAll("messages")] as MessageDocument[];
}

function receiptsOf(store: DocumentStore): ActionReceiptDocument[] {
  return [...store.getAll("actionReceipts")] as ActionReceiptDocument[];
}

async function landedCast(gm: ClientSync, input: {
  messageId: string; casterId: string; targetId: string; itemId?: string;
  outcome?: "failedSave" | "saved"; dc?: number;
  sceneId?: string; casterTokenId?: string; targetTokenId?: string;
}): Promise<void> {
  gm.submit([{ kind: "create", coll: "messages", data: castCardMessage({
    messageId: input.messageId, casterId: input.casterId, targetActorId: input.targetId,
    ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
    outcome: input.outcome ?? "failedSave",
    ...(input.dc !== undefined ? { dc: input.dc } : {}),
    ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    ...(input.casterTokenId !== undefined ? { casterTokenId: input.casterTokenId } : {}),
    ...(input.targetTokenId !== undefined ? { targetTokenId: input.targetTokenId } : {}),
  }) }]);
  await flushMicrotasks();
}

describe("D-407 spell effects deliver conditions on the landed cast", () => {
  test("a failed save applies the catalogue condition, records it on the card and Reverts cleanly", async () => {
    const { store, gm, results, rejected } = await setup();
    await seedActors(gm, [actorDoc("druid"), actorDoc("orc")]);
    gm.submit([
      { kind: "create", coll: "scenes", data: spellDemoScene() },
      { kind: "create", coll: "macros", data: entangledVinesMacro() },
    ]);
    await flushMicrotasks();
    await landedCast(gm, { messageId: "cast-one", casterId: "druid", targetId: "orc",
      sceneId: "scene-jungle", casterTokenId: "tok-druid", targetTokenId: "tok-orc" });

    // The catalogue, not the client, decides what the effect applies: `entangle` applies Entangled.
    gm.requestPF1eConditionAction({ action: "apply", actorId: "orc", condition: "Entangled",
      spell: { effectId: "entangle", actionId: "cast-one", targetKey: "orc" } });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    expect(results).toHaveLength(1);
    const applicationId = results[0]?.applicationId;
    const receiptId = results[0]?.receiptId;
    if (!applicationId || !receiptId) throw new Error("condition acknowledgement missing");

    // The source is the host's reading of the card (caster, card), never the client's claim.
    expect(conditionApps(actorOf(store, "orc"))[applicationId]).toMatchObject({
      condition: "Entangled",
      source: { kind: "spell", id: "entangle", actionId: "cast-one", actorId: "druid" },
      removal: { kind: "manual" },
    });
    expect(store.getAll("fxInstances")).toHaveLength(1);
    expect(store.getAll("fxInstances")[0]).toMatchObject({
      macroId: "macro-entangled-vines", targetTokenId: "tok-orc",
      conditionApplicationId: applicationId,
    });
    // The delivering card carries the rider, and the rider's evidence is the catalogue row.
    expect(riderOf(store, "cast-one")).toMatchObject({
      kind: "condition", label: "Entangled", state: "applied",
      facts: ["spell: Entangle", "REF negates (DC 15)", "condition: Entangled"],
      evidence: { adapter: "pf1e.spellEffect.v1", payload: {
        effectId: "entangle", version: 2, condition: "Entangled",
        actionId: "cast-one", targetKey: "orc" } },
    });
    // The GM-visible record names the spell that delivered it (D4's policy, one step further).
    const record = messagesOf(store).find((message) =>
      (message.system as Record<string, unknown>).pf1eCondition !== undefined);
    expect(record?.content).toContain("via Entangle");
    expect(record?.content).toContain("Entangled");

    // Revert is one receipt: the condition and the rider row leave together.
    gm.actionRevert(receiptId);
    await flushMicrotasks();
    expect(conditionApps(actorOf(store, "orc"))).toEqual({});
    expect(((cardOf(store, "cast-one").targets as Record<string, unknown>[])[0]?.riders ?? []))
      .toEqual([]);
    expect(store.getAll("fxInstances")).toEqual([]);
    expect(receiptsOf(store).find((entry) => entry._id === receiptId)?.status).toBe("reverted");
  });

  test("a made save delivers nothing: the row is not landed, so the delivery is refused", async () => {
    const { store, gm, rejected } = await setup();
    await seedActors(gm, [actorDoc("druid"), actorDoc("orc")]);
    await landedCast(gm, { messageId: "cast-two", casterId: "druid", targetId: "orc",
      outcome: "saved" });

    gm.requestPF1eConditionAction({ action: "apply", actorId: "orc", condition: "Entangled",
      spell: { effectId: "entangle", actionId: "cast-two", targetKey: "orc" } });
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("invalid_schema");
    expect(rejected.at(-1)?.detail).toContain("Entangle delivers only on a landed row");
    expect(conditionApps(actorOf(store, "orc"))).toEqual({});
    expect(((cardOf(store, "cast-two").targets as Record<string, unknown>[])[0]?.riders ?? []))
      .toEqual([]);
  });

  test("the effect's own catalogue is the authority: an unshipped effect, a foreign condition, a foreign card and a foreign save all fail closed", async () => {
    const { store, gm, rejected } = await setup();
    await seedActors(gm, [actorDoc("druid"), actorDoc("orc"), actorDoc("other")]);
    // Note: Entangle has a save, so its landed row is `failedSave` — an `affected` row is only a
    // landed row for a save-less effect, which this catalogue does not ship yet (see the unit pin
    // in `tests/packages/pf1eSpellEffect.test.ts`).
    await landedCast(gm, { messageId: "cast-three", casterId: "druid", targetId: "orc" });

    const refused = async (driver: () => void, detail: string): Promise<void> => {
      const before = rejected.length;
      driver();
      await flushMicrotasks();
      expect(rejected.length, `expected a refusal for ${detail}`).toBe(before + 1);
      expect(rejected.at(-1)?.detail).toContain(detail);
    };
    await refused(() => gm.requestPF1eConditionAction({ action: "apply", actorId: "orc",
      condition: "Entangled", spell: { effectId: "wish", actionId: "cast-three", targetKey: "orc" } }),
      "not in the host-validated catalogue");
    await refused(() => gm.requestPF1eConditionAction({ action: "apply", actorId: "orc",
      condition: "Prone", spell: { effectId: "entangle", actionId: "cast-three", targetKey: "orc" } }),
      "does not apply Prone");
    await refused(() => gm.requestPF1eConditionAction({ action: "apply", actorId: "orc",
      condition: "Entangled", spell: { effectId: "entangle", actionId: "cast-one", targetKey: "orc" } }),
      "does not exist");
    await refused(() => gm.requestPF1eConditionAction({ action: "apply", actorId: "other",
      condition: "Entangled", spell: { effectId: "entangle", actionId: "cast-three", targetKey: "orc" } }),
      "is not this target's");
    // The save type is the effect's, not the client's: a Reflex effect cannot ride a Fortitude row.
    gm.submit([{ kind: "create", coll: "messages", data: castCardMessage({
      messageId: "cast-five", casterId: "druid", targetActorId: "orc", saveType: "fort" }) }]);
    await flushMicrotasks();
    await refused(() => gm.requestPF1eConditionAction({ action: "apply", actorId: "orc",
      condition: "Entangled", spell: { effectId: "entangle", actionId: "cast-five", targetKey: "orc" } }),
      "different save");
    expect(conditionApps(actorOf(store, "orc"))).toEqual({});
  });

  test("the same card cannot deliver the same condition twice, and a retried request id is idempotent", async () => {
    const { store, gm, rejected } = await setup();
    await seedActors(gm, [actorDoc("druid"), actorDoc("orc")]);
    await landedCast(gm, { messageId: "cast-six", casterId: "druid", targetId: "orc" });
    const request = { action: "apply", actorId: "orc", condition: "Entangled",
      spell: { effectId: "entangle", actionId: "cast-six", targetKey: "orc" } } as const;

    const firstId = gm.requestPF1eConditionAction(request, "speffect-cast-six-0");
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    // A retry with the producer's deterministic request id is acknowledged, not applied twice.
    gm.requestPF1eConditionAction(request, "speffect-cast-six-0");
    await flushMicrotasks();
    expect(rejected).toEqual([]);
    expect(Object.keys(conditionApps(actorOf(store, "orc")))).toHaveLength(1);

    // A different request id for the same card and condition is a second delivery, not a retry.
    gm.requestPF1eConditionAction(request);
    await flushMicrotasks();
    expect(rejected.at(-1)?.detail).toContain("already delivered this condition");
    expect(Object.keys(conditionApps(actorOf(store, "orc")))).toHaveLength(1);
    // The rider the first delivery attached is the one the card still carries.
    const rows = cardOf(store, "cast-six").targets as Array<Record<string, unknown>>;
    expect((rows[0]?.riders as unknown[] | undefined) ?? []).toHaveLength(1);
    expect(firstId).toBe("speffect-cast-six-0");
  });

  test("the caster's controller may deliver to an NPC, and condition-linked FX stop when removed", async () => {
    const { store, gm, player, rejected, results } = await setup();
    await seedActors(gm, [
      actorDoc("druid", { ownership: { default: 0, [PLAYER_ID]: 3, [GM_ID]: 3 } }),
      actorDoc("orc", { ownership: { default: 0, [GM_ID]: 3 } }),
    ]);
    gm.submit([
      { kind: "create", coll: "scenes", data: spellDemoScene() },
      { kind: "create", coll: "macros", data: entangledVinesMacro() },
    ]);
    await flushMicrotasks();
    await landedCast(gm, { messageId: "cast-seven", casterId: "druid", targetId: "orc",
      sceneId: "scene-jungle", casterTokenId: "tok-druid", targetTokenId: "tok-orc" });

    // Players may apply only a host-verified spell delivery from an actor they control, even though
    // they do not own the NPC target. The linked FX run belongs to the exact condition application.
    player.requestPF1eConditionAction({ action: "apply", actorId: "orc", condition: "Entangled",
      spell: { effectId: "entangle", actionId: "cast-seven", targetKey: "orc" } });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    expect(results).toHaveLength(1);
    const applicationId = results[0]?.applicationId;
    if (!applicationId) throw new Error("condition application acknowledgement missing");
    expect(conditionApps(actorOf(store, "orc"))[applicationId]).toMatchObject({
      source: { kind: "spell", actorId: "druid" }, removal: { kind: "manual" },
    });
    expect(store.getAll("fxInstances")).toHaveLength(1);
    expect(store.getAll("fxInstances")[0]).toMatchObject({
      macroId: "macro-entangled-vines", sceneId: "scene-jungle", targetTokenId: "tok-orc",
      conditionApplicationId: applicationId,
    });

    // The GM can break/remove an NPC's condition. Deleting its keyed application also removes the
    // persistent vine instance, instead of leaving an orphaned visual on the token.
    gm.requestPF1eConditionAction({ action: "remove", actorId: "orc", applicationId });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    expect(conditionApps(actorOf(store, "orc"))).toEqual({});
    expect(store.getAll("fxInstances")).toEqual([]);
  });

  test("a manual application still carries its manual source and removal (the spell path is additive)", async () => {
    const { store, gm, results, rejected } = await setup();
    await seedActors(gm, [actorDoc("orc")]);
    gm.requestPF1eConditionAction({ action: "apply", actorId: "orc", condition: "Entangled" });
    await flushMicrotasks();
    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    expect(conditionApps(actorOf(store, "orc"))[results[0]?.applicationId ?? "missing"])
      .toMatchObject({ source: { kind: "manual", id: GM_ID }, removal: { kind: "manual" } });
  });
});

/** The message the GM reads must name the client and the condition (the D4 policy). */
describe("starter Lightning Bolt host verification", () => {
  test("a player cast uses the 90-ft line profile and may write only the verified NPC HP delta", async () => {
    const { store, gm, player, rejected } = await setup();
    const hosilla = actorDoc("hosilla", {
      name: "Hosilla",
      ownership: { default: 0, [PLAYER_ID]: 3, [GM_ID]: 3 },
      system: { pf1e: {
        size: "Medium", hp: 24, hpMax: 24, saves: { fort: 3, ref: 2, will: 5 }, savesAsTotal: true,
        abilities: { str: 10, dex: 14, con: 12, int: 12, wis: 10, cha: 18 },
        spells: { keyAbility: "cha", casterLevel: 6, mode: "spontaneous",
          slotsPerDay: { 0: 6, 1: 8, 2: 6, 3: 4 }, slotsUsed: { 3: 0 },
          known: [{ name: "Lightning Bolt", level: 3 }] },
      } },
    });
    const hobgoblin = actorDoc("hobgoblin-fighter-1", {
      name: "Hobgoblin Fighter 1",
      ownership: { default: 2, [GM_ID]: 3 },
      system: { pf1e: {
        size: "Medium", hp: 20, hpMax: 20, saves: { fort: 3, ref: 1, will: 0 }, savesAsTotal: true,
        abilities: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 9 },
      } },
    });
    gm.submit([
      { kind: "create", coll: "actors", data: hosilla },
      { kind: "create", coll: "actors", data: hobgoblin },
      { kind: "create", coll: "scenes", data: lightningDemoScene() },
    ]);
    await flushMicrotasks();

    const caster = player.store.get("actors", "hosilla") as ActorDocument | undefined;
    const target = player.store.get("actors", "hobgoblin-fighter-1") as ActorDocument | undefined;
    if (!caster || !target || !player.user) throw new Error("player replica did not receive spell demo actors");
    const area = { sceneId: "scene-jungle", shape: "line" as const, origin: { x: 300, y: 500 },
      length: 90, width: 5, direction: { x: 1, y: 0 }, units: "ft" as const };
    const resolved = await resolveCastFlow(player, player.user, {
      context: { sceneId: "scene-jungle", casterTokenId: "tok-hosilla",
        targetTokenId: "tok-hobgoblin-1", area },
      casterActor: caster,
      casterDerived: deriveFromActorDocument(caster),
      spell: { name: "Lightning Bolt", level: 3 },
      authored: { saveType: "ref", severity: "half", damageFormula: "6d6", energyType: "electricity" },
      targetName: target.name,
      targetActor: target,
      targetDerived: deriveFromActorDocument(target),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error);
    if (resolved.lost || resolved.held || resolved.pending === true)
      throw new Error("Lightning Bolt did not reach its resolved effect branch");
    expect(resolved.hpWriteError).toBeNull();
    await flushMicrotasks();

    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    const card = messagesOf(store).map((message) => message.system.action as Record<string, unknown> | undefined)
      .find((action) => action?.label === "Lightning Bolt");
    expect(card).toMatchObject({ kind: "cast", area: { shape: "line", length: 90, width: 5,
      sceneId: "scene-jungle", origin: { x: 300, y: 500 }, direction: { x: 1, y: 0 } },
      targets: [expect.objectContaining({ actorId: "hobgoblin-fighter-1", provenance: "host",
        evidence: expect.objectContaining({ adapter: "pf1e.spellTarget.v1" }) })] });
    const currentCaster = actorOf(store, "hosilla");
    expect(((pf1eOf(currentCaster).spells as Record<string, unknown>).slotsUsed as Record<string, number>)["3"])
      .toBe(1);
    const hpAfterBolt = Number(pf1eOf(actorOf(store, "hobgoblin-fighter-1")).hp);
    expect(hpAfterBolt).toBeLessThan(20);

    // The carve-out is not generic NPC ownership: a standalone HP edit still fails.
    player.submit([{ kind: "update", ref: { coll: "actors", id: "hobgoblin-fighter-1" },
      diff: { "system.pf1e.hp": hpAfterBolt - 1 } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect(Number(pf1eOf(actorOf(store, "hobgoblin-fighter-1")).hp)).toBe(hpAfterBolt);
  });
});

describe("D-407 spell effectiveness metadata", () => {
  test("the applying client's name and the spell are both in the chat record", async () => {
    const { store, gm } = await setup();
    await seedActors(gm, [actorDoc("druid"), actorDoc("orc")]);
    await landedCast(gm, { messageId: "cast-eight", casterId: "druid", targetId: "orc" });
    gm.requestPF1eConditionAction({ action: "apply", actorId: "orc", condition: "Entangled",
      spell: { effectId: "entangle", actionId: "cast-eight", targetKey: "orc" } });
    await flushMicrotasks();
    const record = messagesOf(store).find((message) =>
      (message.system as Record<string, unknown>).pf1eCondition !== undefined);
    expect(record?.content).toBe("GM applied Entangled on orc via Entangle.");
    // The audit survives with the same numbers the card carries.
    const receipt = receiptsOf(store).find((entry) => entry.name.startsWith("Condition apply:"));
    expect(receipt?.system.payload).toBe("Entangled");
    expect((JSON.parse(JSON.stringify(receipt?.system)) as Json)).toBeTruthy();
  });
});
