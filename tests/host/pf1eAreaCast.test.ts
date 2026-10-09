/**
 * D-408 (S3) — one area cast, N rows, one card, one commit, one host-verified zone.
 *
 * These tests drive the real `resolveAreaCastFlow` through a connected player replica with
 * host-evaluated dice, then read the host store: every row must verify independently (host
 * provenance), each failed row must deliver its condition under a row-discriminated idempotency
 * key, the spell area must derive atomically with its card, and the zone must price movement
 * until the world clock expires it. Dice are random; every assertion re-derives from the actual
 * rolls, so no test depends on a particular outcome.
 */
import { describe, expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import type {
  ActorDocument,
  Json,
  MessageDocument,
  Ownership,
  SceneDocument,
  TokenDocument,
  UserDocument,
} from "../../src/core/documents";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { HostSync, gmSessionUser } from "../../src/host/sync";
import { worldSettingsDoc } from "../../src/core/worldSettings";
import { deriveFromActorDocument } from "../../src/packages/pf1e/actor";
import { resolveSpellTarget } from "../../src/packages/pf1e/casting";
import { resolveAreaCastFlow } from "../../src/ui/sheets/pf1eAreaCastFlow";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";

const meta: StoreMeta = {
  worldId: "area-cast-world",
  name: "Area cast tests",
  system: "pf1e-core",
  systemVersion: "1.0.0",
};
const GM_ID = "gm-area-cast";
const PLAYER_ID = "player-area-cast";

function user(id: string, role: "GM" | "PLAYER"): UserDocument {
  return { _id: id, type: "user", name: role === "GM" ? "GM" : "Rex",
    ownership: { default: 0 }, flags: {}, system: {}, role, character: null, color: "#eeeeee" };
}

/** Wis 16 prepared druid: level-1 DC 14, caster level 3, one prepared Entangle. */
function druidDoc(): ActorDocument {
  return {
    _id: "druid", type: "actor", name: "druid",
    ownership: { default: 0, [PLAYER_ID]: 3, [GM_ID]: 3 }, flags: {},
    system: { pf1e: {
      size: "Medium", hp: 24, hpMax: 24,
      abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 16, cha: 10 },
      saves: { fort: 4, ref: 1, will: 6 }, savesAsTotal: true,
      spells: {
        keyAbility: "wis", mode: "prepared", tradition: "divine", casterLevel: 3,
        slotsPerDay: { 0: 4, 1: 3, 2: 2 },
        prepared: [{ name: "Entangle", level: 1 }],
      },
    } },
    items: [], effects: [],
  };
}

function orcDoc(id: string, over: Record<string, unknown> = {}): ActorDocument {
  return {
    _id: id, type: "actor", name: id,
    ownership: { default: 2, [GM_ID]: 3 }, flags: {},
    system: { pf1e: {
      size: "Medium", hp: 20, hpMax: 20,
      abilities: { str: 14, dex: 10, con: 14, int: 8, wis: 10, cha: 8 },
      saves: { fort: 2, ref: 0, will: 0 }, savesAsTotal: true,
      ...over,
    } },
    items: [], effects: [],
  };
}

function areaDemoScene(): SceneDocument {
  const token = (id: string, actorId: string, x: number, y: number, ownership: Ownership): TokenDocument => ({
    _id: id, type: "token", name: actorId, flags: {}, system: {}, ownership,
    x, y, rotation: 0, width: 100, height: 100, img: "", actorId,
    hidden: false, disposition: "neutral", vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0 },
  });
  return {
    _id: "scene-jungle", type: "scene", name: "JungleEntrance2 — PF1e Area Demonstration",
    ownership: { default: 2, [GM_ID]: 3, [PLAYER_ID]: 2 }, flags: {}, system: {}, active: false,
    img: null, width: 1200, height: 1800, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [
      token("tok-druid", "druid", 300, 500, { default: 0, [GM_ID]: 3, [PLAYER_ID]: 3 }),
      token("tok-orc1", "orc1", 500, 700, { default: 2, [GM_ID]: 3, [PLAYER_ID]: 2 }),
      token("tok-orc2", "orc2", 700, 300, { default: 2, [GM_ID]: 3, [PLAYER_ID]: 2 }),
    ],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  };
}

async function setup() {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const host = new HostSync({ store, log, undo, bus: createEventBus(), systemUserId: GM_ID,
    roomId: "area-cast-room", verifyHelloSig: async () => true });
  const seed = { seq: 1, ts: 0, by: GM_ID, txId: "seed-area-cast-users",
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
  host.addSession("area-cast-gm", gmPair.a, gmSessionUser(GM_ID));
  host.addSession("area-cast-player", playerPair.a, { id: PLAYER_ID, role: "PLAYER", name: "Rex" });
  const gmBus = createEventBus<ClientEvents>();
  const playerBus = createEventBus<ClientEvents>();
  const rejected: ClientEvents["rejected"][] = [];
  gmBus.on("rejected", (event) => rejected.push(event));
  playerBus.on("rejected", (event) => rejected.push(event));
  const gm = new ClientSync({ transport: gmPair.b, bus: gmBus, meta });
  const player = new ClientSync({ transport: playerPair.b, bus: playerBus, meta });
  await flushMicrotasks();
  return { store, host, gm, player, rejected };
}

async function seedTable(gm: ClientSync, orcOver: Record<string, unknown> = {}): Promise<void> {
  gm.submit([
    { kind: "create", coll: "actors", data: druidDoc() },
    { kind: "create", coll: "actors", data: orcDoc("orc1", orcOver) },
    { kind: "create", coll: "actors", data: orcDoc("orc2", orcOver) },
    { kind: "create", coll: "scenes", data: areaDemoScene() },
    { kind: "create", coll: "settings", data: worldSettingsDoc({ clockSeconds: 0 }) },
  ]);
  await flushMicrotasks();
}

function actorOf(store: DocumentStore, id: string): ActorDocument {
  const actor = store.get("actors", id) as ActorDocument | undefined;
  if (!actor) throw new Error(`actor ${id} missing`);
  return actor;
}

function pf1eOf(actor: ActorDocument): Record<string, unknown> {
  return (actor.system as Record<string, unknown>).pf1e as Record<string, unknown>;
}

function cardOf(store: DocumentStore, id: string): Record<string, unknown> {
  const message = store.get("messages", id) as MessageDocument | undefined;
  return message?.system.action as Record<string, unknown>;
}

function rowsOf(card: Record<string, unknown>): Record<string, unknown>[] {
  return card.targets as Record<string, unknown>[];
}

function entangledFromCard(actor: ActorDocument, cardId: string): boolean {
  const apps = (pf1eOf(actor).conditionApplications ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(apps).some((app) =>
    app.condition === "Entangled" &&
    (app.source as Record<string, unknown>)?.kind === "spell" &&
    (app.source as Record<string, unknown>)?.actionId === cardId);
}

function rollTotalOf(store: DocumentStore, rollId: string): number {
  const found = [...store.getAll("messages")].find((candidate) =>
    ((candidate.flags as Record<string, Record<string, unknown>> | undefined)?.core?.rollId) === rollId)
    ?.roll?.total;
  if (typeof found !== "number") throw new Error(`missing roll total for ${rollId}`);
  return found;
}

function claimOf(store: DocumentStore, rollId: string): unknown {
  const found = [...store.getAll("messages")].find((candidate) =>
    ((candidate.flags as Record<string, Record<string, unknown>> | undefined)?.core?.rollId) === rollId);
  return (found?.system.rollEvidence as Record<string, unknown> | undefined)?.claimedBy;
}

function spellAreasOf(store: DocumentStore): Record<string, Record<string, unknown>> {
  const scene = store.get("scenes", "scene-jungle") as SceneDocument | undefined;
  const flags = scene?.flags as Record<string, Record<string, unknown>> | undefined;
  return (flags?.pf1e?.spellAreas ?? {}) as Record<string, Record<string, unknown>>;
}

const SPREAD = {
  sceneId: "scene-jungle", shape: "spread" as const, origin: { x: 600, y: 500 },
  radius: 40, units: "ft" as const,
};

describe("D-408 area casts verify per row and derive one zone", () => {
  test("two rows verify host, deliver per row and derive the entangle zone atomically", async () => {
    const { store, gm, player, rejected } = await setup();
    await seedTable(gm);
    const caster = player.store.get("actors", "druid") as ActorDocument | undefined;
    const orc1 = player.store.get("actors", "orc1") as ActorDocument | undefined;
    const orc2 = player.store.get("actors", "orc2") as ActorDocument | undefined;
    if (!caster || !orc1 || !orc2 || !player.user) throw new Error("player replica missed the table");

    const resolved = await resolveAreaCastFlow(player, player.user, {
      casterActor: caster,
      casterDerived: deriveFromActorDocument(caster),
      casterTokenId: "tok-druid",
      spell: { name: "Entangle", level: 1, preparedIndex: 0 },
      authored: { saveType: "ref", severity: "negates", damageFormula: "" },
      area: { ...SPREAD },
      targets: [
        { name: "orc1", actor: orc1, derived: deriveFromActorDocument(orc1), tokenId: "tok-orc1" },
        { name: "orc2", actor: orc2, derived: deriveFromActorDocument(orc2), tokenId: "tok-orc2" },
      ],
      spellEffectId: "entangle",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.lost) throw new Error("area cast did not resolve");
    expect(resolved.dc).toBe(14);
    expect(resolved.rows.length).toBe(2);
    await flushMicrotasks();

    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    // Both rows re-derive from immutable host rolls: host provenance on each.
    const card = cardOf(store, resolved.cardId);
    expect(card).toMatchObject({ kind: "cast", label: "Entangle" });
    const rows = rowsOf(card);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ key: "orc1", provenance: "host",
      evidence: { adapter: "pf1e.spellTarget.v1" } });
    expect(rows[1]).toMatchObject({ key: "orc2", provenance: "host",
      evidence: { adapter: "pf1e.spellTarget.v1" } });
    // Each row claimed its own save die; neither shares nor reuses.
    const saveRolls = rows.map((row) =>
      (row.evidence as { payload: { saveRollId: string } }).payload.saveRollId);
    expect(new Set(saveRolls).size).toBe(2);
    expect(saveRolls.every((rollId) => claimOf(store, rollId) === resolved.cardId)).toBe(true);
    // One slot spent across both rows.
    const slotsUsed = (pf1eOf(actorOf(store, "druid")).spells as Record<string, Record<string, number>>)
      .slotsUsed as Record<string, number>;
    expect(slotsUsed["1"] ?? 0).toBe(1);
    // A failed save entangles; a made one does not — per row, from the host's own readback.
    for (const [index, id] of ["orc1", "orc2"].entries()) {
      const failed = resolved.rows[index]?.result.passed === false;
      expect(entangledFromCard(actorOf(store, id), resolved.cardId)).toBe(failed);
    }
    // The zone derives atomically with its card: catalogue duration × derived caster level.
    const areas = spellAreasOf(store);
    const zone = areas[`spellarea-${resolved.cardId}`];
    expect(zone).toMatchObject({
      effectId: "entangle", actionId: resolved.cardId, sceneId: "scene-jungle",
      casterActorId: "druid", dc: 14, casterLevel: 3, spellLevel: 1,
      origin: { x: 600, y: 500 }, radiusFt: 40, difficultTerrain: true,
    });
    expect((zone?.endsAt as number) - (zone?.startsAt as number)).toBe(3 * 60_000);
  });

  test("SR ledger keys compose per row in the one envelope", async () => {
    const { store, gm, player, rejected } = await setup();
    await seedTable(gm, { spellResistance: 5 });
    gm.submit([{ kind: "create", coll: "combats", data: {
      _id: "fight", type: "combat", name: "fight", ownership: { default: 3 },
      flags: { pf1e: { srOvercome: {} } }, system: {}, round: 1, turn: 0, combatants: [],
    } as import("../../src/core/documents").CombatDocument }]);
    await flushMicrotasks();
    const caster = player.store.get("actors", "druid") as ActorDocument | undefined;
    const orc1 = player.store.get("actors", "orc1") as ActorDocument | undefined;
    const orc2 = player.store.get("actors", "orc2") as ActorDocument | undefined;
    const combat = player.store.get("combats", "fight") as
      | import("../../src/core/documents").CombatDocument | undefined;
    if (!caster || !orc1 || !orc2 || !combat || !player.user)
      throw new Error("player replica missed the table");

    const resolved = await resolveAreaCastFlow(player, player.user, {
      casterActor: caster,
      casterDerived: deriveFromActorDocument(caster),
      casterTokenId: "tok-druid",
      spell: { name: "Entangle", level: 1, preparedIndex: 0 },
      authored: { saveType: "ref", severity: "negates", damageFormula: "" },
      area: { ...SPREAD },
      targets: [
        { name: "orc1", actor: orc1, derived: deriveFromActorDocument(orc1), tokenId: "tok-orc1" },
        { name: "orc2", actor: orc2, derived: deriveFromActorDocument(orc2), tokenId: "tok-orc2" },
      ],
      combat,
      spellEffectId: "entangle",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.lost) throw new Error("area cast did not resolve");
    await flushMicrotasks();

    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    const rows = rowsOf(cardOf(store, resolved.cardId));
    expect(rows.map((row) => row.provenance)).toEqual(["host", "host"]);
    // Each row's SR die is its own, and both ledger keys land — unless a row resisted.
    const srRolls = rows.map((row) =>
      (row.evidence as { payload: { srRollId?: string } }).payload.srRollId);
    expect(new Set(srRolls).size).toBe(2);
    expect(srRolls.every((rollId) =>
      typeof rollId === "string" && claimOf(store, rollId) === resolved.cardId)).toBe(true);
    const blob = ((store.get("combats", "fight") as { flags: Record<string, unknown> })
      .flags.pf1e as Record<string, Record<string, number> | undefined>).srOvercome ?? {};
    for (const [index, id] of ["orc1", "orc2"].entries()) {
      const resisted = resolved.rows[index]?.sr.resisted === true;
      expect(blob[`druid:${id}`] === 1).toBe(!resisted);
    }
  });

  test("a second row citing the first row's die degrades to reported and claims nothing", async () => {
    const { store, gm, player, rejected } = await setup();
    await seedTable(gm);
    const rollId = player.roll("1d20", "roll", undefined, "shared save die");
    await flushMicrotasks();
    const die = rollTotalOf(store, rollId);
    // The honest composition for this die; both rows claim it, so the card is a lie.
    const composed = resolveSpellTarget({
      damage: 0, severity: "negates", saveType: "ref", dc: 14, saveBonus: 0, saveDie: die,
      evasion: false, improvedEvasion: false, defender: {},
    });
    if (!composed.ok) throw new Error(composed.error);
    const outcome = composed.passed ? "saved" : "failedSave";
    const row = (id: string, tokenId: string): Record<string, unknown> => ({
      key: id, name: id, actorId: id, tokenId, state: "resolved", outcome,
      check: { kind: "save", status: "resolved", formula: "1d20", dc: 14, total: die + 0,
        saveType: "ref", passed: composed.passed, automatic: composed.automatic },
      evidence: { adapter: "pf1e.spellTarget.v1", payload: {
        spellLevel: 1, saveType: "ref", severity: "negates", damageFormula: "",
        effectId: "entangle", critical: false, saveRollId: rollId,
      } },
      damage: { dealt: 0, prevented: 0 },
    });
    player.submit([{ kind: "create", coll: "messages", data: {
      _id: "shared-die-card", type: "message", name: "Entangle cast",
      ownership: { default: 1 }, flags: {},
      system: { action: {
        v: 2, id: "shared-die-card", revision: 0, kind: "cast", label: "Entangle",
        state: "resolved",
        source: { name: "druid", actorId: "druid", tokenId: "tok-druid" },
        sceneId: "scene-jungle", area: { ...SPREAD },
        targets: [row("orc1", "tok-orc1"), row("orc2", "tok-orc2")],
        notes: [], createdAt: 0, updatedAt: 0,
      } },
      author: "", content: "Entangle.", whisper: [], roll: null, flavor: "cast resolution",
    } as unknown as MessageDocument }]);
    await flushMicrotasks();

    expect(rejected, JSON.stringify(rejected)).toEqual([]);
    const rows = rowsOf(cardOf(store, "shared-die-card"));
    // First citer wins host; the duplicate degrades and takes no claim.
    expect(rows.map((r) => r.provenance)).toEqual(["host", "reported"]);
    expect(claimOf(store, rollId)).toBe("shared-die-card");
    // The zone still derives from the verified row.
    expect(spellAreasOf(store)["spellarea-shared-die-card"]).toMatchObject({
      effectId: "entangle", dc: 14,
    });
  });

  test("the live zone prices movement ×2 until the world clock expires it", async () => {
    const { store, gm, player, rejected } = await setup();
    await seedTable(gm);
    const caster = player.store.get("actors", "druid") as ActorDocument | undefined;
    const orc1 = player.store.get("actors", "orc1") as ActorDocument | undefined;
    const orc2 = player.store.get("actors", "orc2") as ActorDocument | undefined;
    if (!caster || !orc1 || !orc2 || !player.user) throw new Error("player replica missed the table");
    const resolved = await resolveAreaCastFlow(player, player.user, {
      casterActor: caster,
      casterDerived: deriveFromActorDocument(caster),
      casterTokenId: "tok-druid",
      spell: { name: "Entangle", level: 1, preparedIndex: 0 },
      authored: { saveType: "ref", severity: "negates", damageFormula: "" },
      area: { ...SPREAD },
      targets: [
        { name: "orc1", actor: orc1, derived: deriveFromActorDocument(orc1), tokenId: "tok-orc1" },
        { name: "orc2", actor: orc2, derived: deriveFromActorDocument(orc2), tokenId: "tok-orc2" },
      ],
      spellEffectId: "entangle",
    });
    if (!resolved.ok || resolved.lost) throw new Error("area cast did not resolve");
    await flushMicrotasks();
    const zoneId = `spellarea-${resolved.cardId}`;
    expect(spellAreasOf(store)[zoneId]).toBeDefined();

    // Five open cells (25 ft) fit a 30-ft move — until the zone doubles them to 50 ft.
    player.submit([{ kind: "update",
      ref: { coll: "tokens", id: "tok-druid", parent: { coll: "scenes", id: "scene-jungle" } },
      diff: { x: 800 } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)).toMatchObject({ reason: "invariant" });
    expect(String(rejected.at(-1)?.detail ?? "")).toContain("can't move there");
    const held = (store.get("scenes", "scene-jungle") as SceneDocument | undefined)
      ?.tokens.find((token) => token._id === "tok-druid");
    expect(held?.x).toBe(300);

    // One second before the duration ends the ground still holds; at the boundary it releases.
    gm.submit([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
      diff: { "system.clockSeconds": 179 as Json } }]);
    await flushMicrotasks();
    expect(spellAreasOf(store)[zoneId]).toBeDefined();
    gm.submit([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
      diff: { "system.clockSeconds": 180 as Json } }]);
    await flushMicrotasks();
    expect(spellAreasOf(store)[zoneId]).toBeUndefined();

    player.submit([{ kind: "update",
      ref: { coll: "tokens", id: "tok-druid", parent: { coll: "scenes", id: "scene-jungle" } },
      diff: { x: 800 } }]);
    await flushMicrotasks();
    const moved = (store.get("scenes", "scene-jungle") as SceneDocument | undefined)
      ?.tokens.find((token) => token._id === "tok-druid");
    expect(moved?.x).toBe(800);
  });
});
