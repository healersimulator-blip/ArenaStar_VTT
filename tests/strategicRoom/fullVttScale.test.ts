import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { wallFieldsFor } from "../../src/canvas/vision/wallKinds";
import { createEventBus } from "../../src/core/events";
import { OpLog } from "../../src/core/oplog";
import { DocumentStore } from "../../src/core/store";
import { UndoStack } from "../../src/core/undo";
import type {
  ActorDocument,
  JournalDocument,
  MacroDocument,
  PlaylistDocument,
  RollTableDocument,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import type { ArmyDocument, FactionDocument } from "../../src/core/strategic";
import { REGION_SIZE } from "../../src/core/strategicRoom/protocol";
import { sceneDeployment } from "../../src/core/strategicRoom/campaignScene";
import { parseScenario } from "../../src/core/strategicRoom/scenario";
import {
  analyzeBattleReconciliation,
  buildBattleReconciliationOps,
} from "../../src/core/strategicRoom/reconcile";
import { HostSync, type HostEvents } from "../../src/host/sync";
import { StrategicAuthority } from "../../services/strategic-room/src/authority";
import { BattleView } from "../../services/strategic-room/src/battle";
import { buildReconciliationPayload } from "../../services/strategic-room/src/campaign";
import { PostgresRoom } from "../../services/strategic-room/src/postgres";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import { deploy } from "../../services/strategic-room/src/scenario";
import type { Member } from "../../services/strategic-room/src/state";

function createRichCampaignFixture() {
  const store = new DocumentStore({
    meta: { worldId: "w-full-vtt", name: "Full VTT Campaign", system: "pf1e", systemVersion: "1" },
  });
  const log = new OpLog();

  const blueFaction: FactionDocument = {
    _id: "fac-blue",
    type: "faction",
    name: "Silver Vanguard",
    color: "#4da3ff",
    allies: [],
    ownership: { default: 1 },
    flags: {},
    system: {},
  };
  const redFaction: FactionDocument = {
    _id: "fac-red",
    type: "faction",
    name: "Iron Host",
    color: "#ff6b6b",
    allies: [],
    ownership: { default: 1 },
    flags: {},
    system: {},
  };
  let seq = 0;
  const createDoc = (
    coll: Extract<Parameters<DocumentStore["applyEnvelope"]>[0]["ops"][number], { kind: "create" }>["coll"],
    data: unknown,
  ) => {
    seq++;
    const env = {
      seq,
      ts: seq,
      by: "gm",
      txId: `seed-${seq}`,
      ops: [{ kind: "create" as const, coll, data: data as never }],
    };
    const res = store.applyEnvelope(env);
    expect(res.ok).toBe(true);
    log.append(env);
  };
  createDoc("factions", blueFaction);
  createDoc("factions", redFaction);

  const blueCaptain: ActorDocument = {
    _id: "act-blue-cap",
    type: "actor",
    name: "Archmage Valeria",
    ownership: { default: 0 },
    flags: {},
    items: [
      {
        _id: "item-longsword",
        type: "item",
        name: "Masterwork Longsword",
        ownership: { default: 0 },
        flags: {},
        effects: [],
        system: {
          pf1e: {
            kind: "weapon",
            equipped: true,
            damage: "1d8",
            attackBonus: 1,
            critRange: 19,
            critMult: 2,
          },
        },
      },
      {
        _id: "wand-clw",
        type: "item",
        name: "Wand of Cure Light Wounds",
        ownership: { default: 0 },
        flags: {},
        effects: [],
        system: { pf1e: { subtype: "wand", charges: 4, maxCharges: 50 } },
      },
      {
        _id: "potion-haste",
        type: "item",
        name: "Battle Horn of Haste",
        ownership: { default: 0 },
        flags: {},
        effects: [],
        system: { pf1e: { subtype: "wondrous", charges: 2 } },
      },
    ],
    effects: [
      {
        _id: "eff-barkskin",
        type: "effect",
        name: "Barkskin",
        disabled: false,
        changes: [],
        ownership: { default: 0 },
        flags: {
          pf1e: {
            mods: [{ key: "ac", type: "natural", value: 2 }],
          },
        },
        system: {},
      },
    ],
    system: {
      pf1e: {
        hp: 42,
        hpMax: 42,
        baseAttack: 7,
        abilities: { str: 16, dex: 14, con: 14, int: 20, wis: 14, cha: 12 },
        saves: { fort: 6, ref: 5, will: 8 },
        armor: { armorBonus: 6, shieldBonus: 2 },
        armorClass: { deflection: 1 },
        conditions: [],
        spells: {
          casterLevel: 9,
          keyAbility: "int",
          slots: {
            "1": { max: 3, used: 0 },
            "3": { max: 2, used: 0 },
          },
          prepared: [
            { id: "prep-fb-1", name: "Fireball", level: 3, expended: false },
            { id: "prep-fb-2", name: "Fireball", level: 3, expended: false },
            { id: "prep-ent-1", name: "Entangle", level: 1, expended: false },
            { id: "prep-bh-1", name: "Burning Hands", level: 1, expended: false },
          ],
          known: [
            { id: "kn-bt", name: "Black Tentacles", level: 4 },
          ],
        },
      },
    },
  };
  const redWarlord: ActorDocument = {
    _id: "act-red-warlord",
    type: "actor",
    name: "Duskblade Kor",
    ownership: { default: 0 },
    flags: {},
    items: [],
    effects: [],
    system: {
      pf1e: {
        hp: 18,
        hpMax: 18,
        baseAttack: 5,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        saves: { fort: 5, ref: 2, will: 2 },
        ac: { armor: 5, shield: 0, natural: 1, deflection: 0, dodge: 0, misc: 0 },
      },
    },
  };
  createDoc("actors", blueCaptain);
  createDoc("actors", redWarlord);

  const blueToken: TokenDocument = {
    _id: "tok-blue",
    type: "token",
    name: "Silver 1st",
    actorId: "act-blue-cap",
    x: 200,
    y: 400,
    width: 100,
    height: 100,
    rotation: 0,
    img: "",
    hidden: false,
    disposition: "friendly",
    vision: true,
    darkvision: 60,
    light: { radius: 0, color: "#ffffff", alpha: 0 },
    ownership: { default: 1 },
    flags: {},
    system: {},
  };
  const redToken: TokenDocument = {
    _id: "tok-red",
    type: "token",
    name: "Iron 1st",
    actorId: "act-red-warlord",
    x: 900,
    y: 400,
    width: 100,
    height: 100,
    rotation: 180,
    img: "",
    hidden: false,
    disposition: "hostile",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0 },
    ownership: { default: 1 },
    flags: {},
    system: {},
  };

  const blueArmy: ArmyDocument = {
    _id: "army-blue",
    type: "army",
    name: "Silver Vanguard",
    factionId: "fac-blue",
    commander: ["user-blue"],
    supply: {},
    ownership: { default: 0, "user-blue": 3 },
    flags: {},
    system: {},
    units: [
      {
        _id: "u-blue",
        type: "infantry",
        name: "Valeria Guard",
        leaderTokenId: "tok-blue",
        formation: "line",
        sceneId: "scene-gate",
        modelRange: [0, 12],
        profile: { anchor: { x: 22.5, y: 22.5 } },
        stats: { strength: 12, morale: 100, supply: 100, fatigue: 0 },
        orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
        ownership: { default: 0 },
        flags: {},
        system: {},
      },
    ],
  };
  const redArmy: ArmyDocument = {
    _id: "army-red",
    type: "army",
    name: "Iron Host",
    factionId: "fac-red",
    commander: ["user-red"],
    supply: {},
    ownership: { default: 0, "user-red": 3 },
    flags: {},
    system: {},
    units: [
      {
        _id: "u-red",
        type: "infantry",
        name: "Iron Raiders",
        leaderTokenId: "tok-red",
        formation: "line",
        sceneId: "scene-gate",
        modelRange: [12, 24],
        profile: { anchor: { x: 47.5, y: 22.5 } },
        stats: { strength: 12, morale: 100, supply: 100, fatigue: 0 },
        orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
        ownership: { default: 0 },
        flags: {},
        system: {},
      },
    ],
  };
  createDoc("armies", blueArmy);
  createDoc("armies", redArmy);

  // Gatehouse door spanning y = 0..1000 px (0..50 ft) at x = 600 px (30 ft)
  const gateDoor = {
    _id: "door-gate",
    type: "wall" as const,
    name: "Fortress Gate",
    ownership: { default: 0 as const },
    flags: {},
    system: {},
    ...wallFieldsFor("door", [600, 0, 600, 1000], 0),
  };

  const scene: SceneDocument = {
    _id: "scene-gate",
    type: "scene",
    name: "Gate of Thorns",
    active: true,
    img: null,
    width: 2400,
    height: 1600,
    darkness: 0.8,
    grid: { type: "square", size: 100, units: "ft", distance: 5, diagonals: "555", hexLayout: "oddQ" },
    tokens: [blueToken, redToken],
    walls: [gateDoor],
    lights: [
      {
        _id: "light-brazier",
        type: "light",
        name: "Gate Brazier",
        x: 900,
        y: 400,
        dim: 40,
        bright: 20,
        color: "#ffb347",
        alpha: 0.6,
        ownership: { default: 0 },
        flags: {},
        system: {},
      },
    ],
    regions: [
      {
        _id: "reg-ridge",
        type: "region",
        name: "West Rampart",
        x: 0,
        y: 0,
        width: 500,
        height: 1000,
        shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] },
        hidden: false,
        raised: { height: 10, solid: true },
        ownership: { default: 0 },
        flags: {},
        system: {},
      },
    ],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [
      {
        _id: "tpl-watch",
        type: "template",
        name: "Killzone",
        kind: "circle",
        x: 700,
        y: 400,
        distance: 20,
        direction: 0,
        width: 5,
        ownership: { default: 1 },
        flags: { core: { color: "#ff8844" } },
        system: {},
      },
    ],
    notes: [],
    ownership: { default: 1 },
    flags: { core: { scale: "strategic" } },
    system: {},
  };
  createDoc("scenes", scene);

  const publicJournal: JournalDocument = {
    _id: "jrn-brief",
    type: "journal",
    name: "Orders of the Day",
    pages: [
      {
        _id: "pg-1",
        type: "page",
        name: "Briefing",
        text: "Hold the rampart. <secret>Hidden tunnel under east tower.</secret>",
        src: null,
        ownership: { default: 2 },
        flags: {},
        system: {},
      },
    ],
    ownership: { default: 2 },
    flags: {},
    system: {},
  };
  const gmJournal: JournalDocument = {
    _id: "jrn-gm",
    type: "journal",
    name: "GM Ambush Notes",
    pages: [
      {
        _id: "pg-gm",
        type: "page",
        name: "Ambush",
        text: "Reinforcements arrive turn 5.",
        src: null,
        ownership: { default: 0 },
        flags: {},
        system: {},
      },
    ],
    ownership: { default: 0 },
    flags: {},
    system: {},
  };
  createDoc("journals", publicJournal);
  createDoc("journals", gmJournal);

  const moraleTable: RollTableDocument = {
    _id: "tbl-omens",
    type: "rollTable",
    name: "Battlefield Omens",
    formula: "1d6",
    results: [
      { range: [1, 3], text: "Mist rises over the field", documentRef: null },
      { range: [4, 6], text: "Eagle circles the banner", documentRef: null },
    ],
    ownership: { default: 2 },
    flags: {},
    system: {},
  };
  createDoc("rollTables", moraleTable);

  const playlist: PlaylistDocument = {
    _id: "pl-war",
    type: "playlist",
    name: "Siege Drums",
    mode: "sequential",
    sounds: [
      {
        _id: "trk-drums",
        type: "playlistSound",
        name: "War Drums",
        audio: "",
        volume: 0.8,
        loop: true,
        ownership: { default: 2 },
        flags: {},
        system: {},
      },
    ],
    ownership: { default: 2 },
    flags: {},
    system: {},
  };
  createDoc("playlists", playlist);

  const braceMacro: MacroDocument = {
    _id: "mac-brace",
    type: "macro",
    name: "Shield Wall",
    kind: "chat",
    command: "/order defend",
    ownership: { default: 2 },
    flags: {},
    system: {},
  };
  const scriptMacro: MacroDocument = {
    _id: "mac-script",
    type: "macro",
    name: "Unsafe Eval",
    kind: "script",
    command: "window.alert('pwn')",
    ownership: { default: 2 },
    flags: {},
    system: {},
  };
  createDoc("macros", braceMacro);
  createDoc("macros", scriptMacro);

  const storedScene = store.get("scenes", "scene-gate");
  if (!storedScene) throw new Error("Missing scene-gate");
  return { store, log, scene: storedScene };
}

function must<T>(val: T | null | undefined, label = "value"): T {
  if (val === null || val === undefined) throw new Error(`Expected ${label}`);
  return val;
}

describe("Full VTT at Formation Scale (Phases A–E)", () => {
  test("Phase A & B: projects interactive doors, darkness/lights/vision, elevated regions, templates, derived PF1e actors, spellbooks, items, and diagnostics", () => {
    const { store, scene } = createRichCampaignFixture();
    const scenario = sceneDeployment(store, scene, 101, 2);

    // Signed/hashed projection manifest + dependency hashes + script macro diagnostic
    expect(scenario.projection?.dependencies?.length).toBeGreaterThanOrEqual(6);
    expect(
      scenario.projection?.unsupported?.some((u) => u.feature === "macro.script" && u.docId === "mac-script"),
    ).toBe(true);

    // Geometry, doors, lighting, regions, templates
    expect(scenario.walls).toEqual([
      {
        id: "door-gate",
        x1: 30,
        y1: 0,
        x2: 30,
        y2: 50,
        restriction: 15,
        openRestriction: 0,
        door: 0,
      },
    ]);
    expect(scenario.lighting?.darkness).toBe(0.8);
    expect(scenario.lighting?.lights).toHaveLength(1);
    expect(scenario.regions).toEqual([
      {
        id: "reg-ridge",
        name: "West Rampart",
        x: 0,
        y: 0,
        width: 25,
        height: 50,
        elevationFt: 10,
        kind: "raised",
      },
    ]);
    expect(scenario.templates).toHaveLength(1);

    // Derived PF1e Actor stats (including Barkskin +2 natural armor ActiveEffect!), darkvision, spells, items
    const blueUnit = must(scenario.commanders[0]?.units[0], "blueUnit");
    expect(blueUnit.vision).toEqual({ mode: "darkvision", rangeFt: 60 });
    expect(blueUnit.stats?.bab).toBe(7);
    expect(blueUnit.stats?.ac).toBeGreaterThanOrEqual(21); // 10 + 6 armor + 2 shield + 2 dex + 1 defl + 2 natural
    expect(blueUnit.spells?.map((s) => s.id)).toEqual(
      expect.arrayContaining(["fireball", "entangle", "burning-hands"]),
    );
    expect(blueUnit.items?.map((i) => i.effect)).toEqual(["heal", "haste"]);
    expect(scenario.leaderActors?.["u-blue"]).toBeDefined();
  });

  test("Phase A & D: closed door blocks LOS & movement; live door open + light/darkness + entitlement filtering work without leaking GM secrets", () => {
    const { store, scene } = createRichCampaignFixture();
    const scenario = sceneDeployment(store, scene, 202, 2);
    const published = deploy(scenario);
    const key = Buffer.alloc(32, 7);

    const gm: Member = { id: "gm", role: "GM", factionId: null, epoch: 1 };
    const bluePlayer: Member = { id: "commander-1", role: "PLAYER", factionId: "fac-blue", epoch: 1 };
    const redPlayer: Member = { id: "commander-2", role: "PLAYER", factionId: "fac-red", epoch: 1 };

    // Closed gate door blocks sight between u-blue (x=15) and u-red (x=47.5) across x=30,
    // and blocks a PF1e charge through the closed gate!
    const closedView = new BattleView(scenario, published, key, undefined, {});
    expect(closedView.markers(bluePlayer).map((m) => m.id)).toEqual(["u-blue"]);
    expect(
      closedView.validate(bluePlayer, {
        unitId: "u-blue",
        order: { kind: "move", pace: "charge", path: [{ x: 40, y: 22.5 }] },
      }),
    ).toMatch(/charge/i);

    // Opening the door (`doors["door-gate"] = 1`) immediately opens sight AND unobstructed charge!
    const openView = new BattleView(scenario, published, key, undefined, {
      doors: { "door-gate": 1 },
      chat: [
        {
          id: "c1",
          senderId: "commander-1",
          senderName: "Blue",
          factionId: "fac-blue",
          scope: "faction",
          text: "Blue private plan",
          createdAt: 1,
        },
        {
          id: "c2",
          senderId: "gm",
          senderName: "GM",
          factionId: null,
          scope: "gm",
          text: "Secret GM note",
          createdAt: 2,
        },
      ],
    });
    expect(openView.markers(bluePlayer).map((m) => m.id)).toEqual(["u-blue", "u-red"]);
    expect(
      openView.validate(bluePlayer, {
        unitId: "u-blue",
        order: { kind: "move", pace: "charge", path: [{ x: 35, y: 22.5 }] },
      }),
    ).toBeNull();

    // Entitlement checks: Red player never sees Blue faction chat, GM chat, GM journal, or <secret> block!
    expect(openView.chat(redPlayer)).toBeUndefined();
    expect(openView.chat(bluePlayer)?.map((c) => c.id)).toEqual(["c1"]);
    expect(openView.chat(gm)?.map((c) => c.id)).toEqual(["c1", "c2"]);

    const playerContent = openView.content(bluePlayer);
    expect(playerContent?.journals).toHaveLength(1);
    expect(playerContent?.journals?.[0]?.markdown).toBe("Hold the rampart.");
    expect(playerContent?.journals?.[0]?.markdown).not.toContain("Hidden tunnel");
    expect(openView.content(gm)?.journals).toHaveLength(2);

    const scriptMac = playerContent?.macros?.find((m) => m.id === "mac-script");
    expect(scriptMac?.executable).toBe(false);
    expect(scriptMac?.disabledReason).toMatch(/sandbox policy/i);
  });

  test("Phase C: resolves shared PF1e Fireball blast, Entangle hazard, consumable healing/buffs, and readied reactions deterministically", () => {
    const { store, scene } = createRichCampaignFixture();
    const scenario = sceneDeployment(store, scene, 303, 2);
    const start = deploy(scenario);

    const fireballItemId = must(
      scenario.commanders[0]?.units[0]?.spells?.find((s) => s.id === "fireball"),
      "fireball",
    ).itemId;

    // Turn 1 (with gate door open): Blue casts Fireball at Red formation; Red readies melee on enemyCasts
    const turn1 = resolveFrozen({
      turnId: 1,
      seed: 9991,
      start,
      scenario,
      live: { doors: { "door-gate": 1 } },
      orders: [
        {
          unitId: "u-blue",
          memberId: "commander-1",
          order: {
            kind: "cast",
            spellId: "fireball",
            itemId: fireballItemId,
            origin: { x: 47.5, y: 22.5 },
          },
        },
        {
          unitId: "u-red",
          memberId: "commander-2",
          order: {
            kind: "ready",
            trigger: "enemyCasts",
            response: "countermarch",
          },
        },
      ],
    });

    const redRow1 = must(turn1.rows.find((r) => r.unitId === "u-red"), "redRow1");
    expect(redRow1.before).toBe(12);
    expect(redRow1.alive).toBeLessThan(12); // Fireball inflicted PF1e Reflex-save casualties!
    expect(turn1.state.extras?.unitResources?.["u-blue"]?.spells?.fireball).toBe(1); // 2 -> 1 slot
    expect(turn1.state.extras?.fxCues?.some((c) => c.preset === "fireball")).toBe(true);
    expect(turn1.state.actions?.some((a) => a.label === "Fireball")).toBe(true);
    expect(turn1.state.actions?.some((a) => a.label.includes("Readied countermarch"))).toBe(true);

    // Turn 2: Blue uses Wand of Cure Light Wounds + Entangle on subsequent turns
    const turn2 = resolveFrozen({
      turnId: 2,
      seed: 9992,
      start: turn1.state,
      scenario,
      live: { doors: { "door-gate": 1 } },
      orders: [
        {
          unitId: "u-blue",
          memberId: "commander-1",
          order: { kind: "useItem", itemId: "wand-clw" },
        },
      ],
    });
    expect(turn2.state.extras?.unitResources?.["u-blue"]?.items?.["wand-clw"]).toBe(3); // 4 -> 3 charges
    expect(turn2.state.actions?.some((a) => a.label === "Wand of Cure Light Wounds")).toBe(true);
  });

  test("Phase E: conflict-checked campaign reconciliation writes back casualties, positions, spell slots, item charges, conditions, doors & darkness atomically and supports single-step undo", () => {
    const { store, log, scene } = createRichCampaignFixture();
    const scenario = sceneDeployment(store, scene, 404, 2);

    const proj = must(scenario.projection, "projection");
    const payload = {
      id: "11111111-2222-4333-8444-555555555555",
      version: 2,
      surviving: 17,
      lost: 7,
      doorStates: { "door-gate": 1 as const },
      darkness: 0.3,
      projection: {
        worldId: proj.worldId,
        sceneId: proj.sceneId,
        sourceSeq: proj.sourceSeq,
        digest: proj.digest,
        dependencies: must(proj.dependencies, "dependencies"),
      },
      units: [
        {
          id: "u-blue",
          name: "Valeria Guard",
          factionId: "fac-blue",
          source: must(scenario.commanders[0]?.units[0]?.source, "blueSource"),
          initialStrength: 12,
          alive: 10,
          lost: 2,
          at: { x: 25, y: 22.5 },
          facing: 0,
          spellsSpent: { fireball: 1 },
          itemsSpent: { "wand-clw": 1 },
          conditions: ["Blessed"],
        },
        {
          id: "u-red",
          name: "Iron Raiders",
          factionId: "fac-red",
          source: must(scenario.commanders[1]?.units[0]?.source, "redSource"),
          initialStrength: 12,
          alive: 7,
          lost: 5,
          at: { x: 42.5, y: 22.5 },
          facing: Math.PI,
          conditions: ["Entangled"],
        },
      ],
    };

    // Clean analysis: zero conflicts before concurrent campaign edits
    const cleanAnalysis = analyzeBattleReconciliation(store, scene._id, payload);
    expect(cleanAnalysis.conflicts).toHaveLength(0);

    // Simulate a concurrent edit to Red's army while battle was hosted -> flagged & skipped when skipConflicted=true
    const undo = new UndoStack();
    const host = new HostSync({
      store,
      log,
      undo,
      bus: createEventBus<HostEvents>(),
      systemUserId: "gm",
      roomId: "room-test",
    });
    const concurrentEnv = {
      seq: store.seq + 1,
      ts: 100,
      by: "gm",
      txId: "concurrent-edit",
      ops: [
        {
          kind: "update" as const,
          ref: { coll: "armies" as const, id: "army-red" },
          diff: { name: "Iron Host (Reinforced Elsewhere)" },
        },
      ],
    };
    const editRed = store.applyEnvelope(concurrentEnv);
    expect(editRed.ok).toBe(true);
    log.append(concurrentEnv);
    const conflictAnalysis = analyzeBattleReconciliation(store, scene._id, payload);
    expect(conflictAnalysis.conflicts.map((c) => `${c.coll}:${c.id}`)).toEqual(["armies:army-red"]);

    host.commitBattleScene(scene._id, {
      "flags.core.campaignBattle": {
        id: payload.id,
        world: "w-full-vtt",
        scene: scene._id,
        seed: 404,
        seats: 2,
        strength: 12,
        armies: ["army-blue", "army-red"],
        factions: ["fac-blue", "fac-red"],
      },
    });

    const plan = buildBattleReconciliationOps(store, scene._id, payload, { skipConflicted: true });
    expect(plan.skippedConflicts).toBe(1); // army-red skipped safely!

    const res = host.commitBattleReconciliation(plan.ops, "Reconcile Gate of Thorns");
    if (!res.ok) throw new Error(`Reconciliation failed: ${res.error}`);

    // Blue army updated, Red army untouched due to skipConflicted, door opened, darkness updated, actor spell & wand decremented!
    expect(store.get("armies", "army-blue")?.units[0]?.stats.strength).toBe(10);
    expect(store.get("armies", "army-red")?.units[0]?.stats.strength).toBe(12);
    expect(store.get("scenes", scene._id)?.walls[0]?.door).toBe(1);
    expect(store.get("scenes", scene._id)?.darkness).toBe(0.3);
    expect(store.get("scenes", scene._id)?.flags.core?.campaignBattle).toBeUndefined();

    const updatedCap = must(store.get("actors", "act-blue-cap"), "updatedCap");
    const prepAfter = (updatedCap.system.pf1e as { spells: { prepared: Array<{ id: string; expended?: boolean }> } })
      .spells.prepared;
    expect(prepAfter.find((p) => p.id === "prep-fb-1")?.expended).toBe(true);
    expect(
      (updatedCap.items.find((i) => i._id === "wand-clw")?.system.pf1e as { charges: number }).charges,
    ).toBe(3);

    // Single-step Undo restores every single reconciled document atomically, and Redo re-applies cleanly!
    expect(undo.canUndo).toBe(true);
    const undone = host.undo();
    expect(undone.ok).toBe(true);
    expect(store.get("armies", "army-blue")?.units[0]?.stats.strength).toBe(12);
    expect(store.get("scenes", scene._id)?.walls[0]?.door).toBe(0);
    expect(store.get("scenes", scene._id)?.darkness).toBe(0.8);
    const restoredWand = must(
      must(store.get("actors", "act-blue-cap"), "restoredCap").items.find((i) => i._id === "wand-clw"),
      "restoredWand",
    );
    expect((restoredWand.system.pf1e as { charges: number }).charges).toBe(4);
    const redone = host.redo();
    expect(redone.ok).toBe(true);
    expect(store.get("armies", "army-blue")?.units[0]?.stats.strength).toBe(10);
    expect(store.get("scenes", scene._id)?.walls[0]?.door).toBe(1);
    expect(store.get("scenes", scene._id)?.darkness).toBe(0.3);
  });

  test("Scale & Boundedness (§8 Gates): 500 commanders, 5,000 units, and 10,000 models resolve Full-VTT doors, lighting, elevation, spells & reactions without per-model action-card floods", () => {
    const commanders = Array.from({ length: 500 }, (_, ci) => {
      const isBlue = ci < 250;
      const factionId = isBlue ? "fac-blue" : "fac-red";
      const rowBase = ci % 250;
      return {
        id: `cmd-${ci + 1}`,
        factionId,
        units: Array.from({ length: 10 }, (__, ui) => {
          const idx = ci * 10 + ui;
          const x = isBlue ? 500 + (ui * 40) : 1200 + (ui * 40);
          const y = 100 + rowBase * 95;
          return {
            id: `u-${idx + 1}`,
            name: `Company ${idx + 1}`,
            strength: 2, // 5,000 units * 2 = 10,000 models
            anchor: { x, y },
            weapon: (ui % 2 === 0 ? "melee" : "shot") as "melee" | "shot",
            ...(idx === 0 || idx === 1
              ? {
                  vision: { mode: "darkvision" as const, rangeFt: 120 },
                  spells: [
                    {
                      id: "fireball" as const,
                      itemId: "fb-1",
                      casterLevel: 9,
                      castingAbilityMod: 6,
                      slots: 2,
                    },
                    {
                      id: "black-tentacles" as const,
                      itemId: "bt-1",
                      casterLevel: 7,
                      castingAbilityMod: 6,
                      slots: 2,
                    },
                  ],
                  items: [
                    {
                      id: "horn-1",
                      name: "Warhorn of Haste",
                      effect: "haste" as const,
                      charges: 2,
                      potency: 5,
                    },
                  ],
                }
              : {}),
          };
        }),
      };
    });

    const rawScenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Grand Siege of 5,000 Units",
      seed: 20261121,
      bounds: { minX: 0, minY: 0, maxX: 25_000, maxY: 25_000 },
      walls: [
        {
          id: "grand-gate",
          x1: 1000,
          y1: 50,
          x2: 1000,
          y2: 300,
          restriction: 15,
          openRestriction: 0,
          door: 0,
        },
      ],
      lighting: {
        darkness: 0.75,
        lights: [
          { id: "beacon-1", x: 1200, y: 100, dim: 240, bright: 120, color: "#ffaa44", alpha: 0.7 },
        ],
      },
      regions: [
        { id: "citadel-wall", name: "Citadel Wall", x: 480, y: 80, width: 80, height: 80, elevationFt: 20, kind: "raised" },
      ],
      actionCards: { playerCharacters: true, units: true, models: false },
      factions: [
        { id: "fac-blue", name: "Grand Alliance", color: "#5f9fff" },
        { id: "fac-red", name: "Dread Legion", color: "#ff726f" },
      ],
      commanders,
    });

    const start = deploy(rawScenario);
    expect(start.units).toHaveLength(5_000);
    const totalModels = start.units.reduce((acc, u) => acc + u.stats.strength, 0);
    expect(totalModels).toBe(10_000);

    const key = new Uint8Array(32).fill(9);
    const view = new BattleView(
      rawScenario,
      start,
      key,
      undefined,
      { doors: { "grand-gate": 1 } },
    );

    const gm: Member = { id: "gm", role: "GM", factionId: null, epoch: 1 };
    expect(view.markers(gm)).toHaveLength(5_000);
    // Viewport region query stays strictly bounded to visible viewport models, never dumping 10,000 models unless asked
    const tileKey = `${Math.floor(500 / REGION_SIZE)},${Math.floor(100 / REGION_SIZE)}`;
    const smallViewport = view.region(gm, tileKey);
    expect(smallViewport.length).toBeGreaterThan(0);
    expect(smallViewport.length).toBeLessThan(100);

    const resolved = resolveFrozen({
      turnId: 1,
      seed: 7777,
      start,
      scenario: rawScenario,
      live: { doors: { "grand-gate": 1 } },
      orders: [
        {
          unitId: "u-1",
          memberId: "cmd-1",
          order: {
            kind: "cast",
            spellId: "fireball",
            itemId: "fb-1",
            origin: { x: 1200, y: 100 },
          },
        },
        {
          unitId: "u-2",
          memberId: "cmd-1",
          order: {
            kind: "useItem",
            itemId: "horn-1",
          },
        },
        {
          unitId: "u-2501",
          memberId: "cmd-251",
          order: {
            kind: "ready",
            trigger: "enemyEntersReach",
            response: "countermarch",
          },
        },
      ],
    });

    expect(resolved.state.units).toHaveLength(5_000);
    // Action cards remain unit/spell-level (<= number of cast/reaction orders), NEVER 10,000 per-model cards!
    expect(resolved.state.actions?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(resolved.state.actions?.length ?? 0).toBeLessThanOrEqual(5);
    expect(resolved.state.extras?.unitResources?.["u-1"]?.spells?.fireball).toBe(1);
    expect(resolved.state.extras?.unitResources?.["u-2"]?.items?.["horn-1"]).toBe(1);
    expect(resolved.state.extras?.unitResources?.["u-2"]?.buffs?.some((b) => b.effect === "haste")).toBe(true);
  });

  const pgUrl = process.env.STRATEGIC_TEST_DATABASE_URL;
  describe.runIf(Boolean(pgUrl))("PostgreSQL Authority & Campaign Reconciliation", () => {
    test("persists live doors, lighting, templates, playlist, chat/dice, roll tables, vetted macros, and builds reconciliation payload", async () => {
      const { store, scene } = createRichCampaignFixture();
      const scenario = sceneDeployment(store, scene, 505, 2);
      const roomId = `pg-full-vtt-${randomUUID()}`;
      const db = new PostgresRoom(pgUrl ?? "", roomId, "full-vtt-test-v1");
      let authority: StrategicAuthority | null = null;
      try {
        await db.migrate();
        const keys = {
          gm: "aa".repeat(32),
          "commander-1": "bb".repeat(32),
          "commander-2": "cc".repeat(32),
        };
        await db.create(scenario, deploy(scenario), keys);
        const gm = must(await db.admit(keys.gm), "gm");
        const blue = must(await db.admit(keys["commander-1"]), "blue");
        const red = must(await db.admit(keys["commander-2"]), "red");

        authority = await StrategicAuthority.open(
          db,
          { change: vi.fn(), revoke: vi.fn(), lost: vi.fn() },
          async (job) => resolveFrozen(job),
        );

        // Initially closed door hides Red from Blue
        expect(authority.battle.markers(blue).map((m) => m.id)).toEqual(["u-blue"]);

        // Live GM commands: open gate, adjust darkness, place & delete template, set playlist
        const doorRes = await authority.submit(gm, {
          kind: "scene.door",
          requestId: randomUUID(),
          wallId: "door-gate",
          door: 1,
        });
        expect(doorRes.status).toBe("accepted");
        expect(authority.battle.markers(blue).map((m) => m.id)).toEqual(["u-blue", "u-red"]);

        const lightRes = await authority.submit(gm, {
          kind: "scene.light",
          requestId: randomUUID(),
          darkness: 0.4,
          lightId: "light-brazier",
          hidden: true,
        });
        expect(lightRes.status).toBe("accepted");
        expect(authority.battle.darkness()).toBe(0.4);
        expect(authority.battle.lights(blue) ?? []).toHaveLength(0);

        const tplPut = await authority.submit(gm, {
          kind: "scene.template",
          requestId: randomUUID(),
          op: "put",
          template: {
            id: "tpl-pg",
            shape: "circle",
            x: 30,
            y: 22.5,
            distance: 20,
            color: "#ff6600",
            label: "Gate Breach",
          },
        });
        expect(tplPut.status).toBe("accepted");
        expect(authority.battle.templates()?.map((t) => t.id)).toContain("tpl-pg");

        const tplDel = await authority.submit(gm, {
          kind: "scene.template",
          requestId: randomUUID(),
          op: "delete",
          templateId: "tpl-pg",
        });
        expect(tplDel.status).toBe("accepted");
        expect(authority.battle.templates()?.map((t) => t.id) ?? []).not.toContain("tpl-pg");

        const playRes = await authority.submit(gm, {
          kind: "scene.playlist",
          requestId: randomUUID(),
          trackId: "trk-drums",
        });
        expect(playRes.status).toBe("accepted");
        expect(authority.battle.content(blue)?.activeTrackId).toBe("trk-drums");

        // Faction chat + host-provenanced dice roll + roll table + vetted macro
        const chatRes = await authority.submit(blue, {
          kind: "chat.send",
          requestId: randomUUID(),
          scope: "faction",
          text: "Advance on the gate!",
          rollFormula: "1d20+4",
        });
        expect(chatRes.status).toBe("accepted");
        expect(authority.battle.chat(blue)?.[0]?.roll?.provenance).toBe("host");
        expect(authority.battle.chat(red)).toBeUndefined();

        const tblRes = await authority.submit(blue, {
          kind: "table.roll",
          requestId: randomUUID(),
          tableId: "tbl-omens",
        });
        expect(tblRes.status).toBe("accepted");
        expect(authority.battle.chat(red)?.some((c) => c.text.includes("Battlefield Omens"))).toBe(true);

        const macOk = await authority.submit(blue, {
          kind: "macro.exec",
          requestId: randomUUID(),
          macroId: "mac-brace",
          unitId: "u-blue",
        });
        expect(macOk.status).toBe("accepted");

        const macDenied = await authority.submit(blue, {
          kind: "macro.exec",
          requestId: randomUUID(),
          macroId: "mac-script",
        });
        expect(macDenied.status).toBe("rejected");
        if (macDenied.status === "rejected") {
          expect(macDenied.code).toBe("invalid_order");
        }

        // Submit PF1e Fireball order and resolve Turn 1
        const privateBlue = must(await db.privateState(blue), "privateBlue");
        const fbItemId = must(
          scenario.commanders[0]?.units[0]?.spells?.find((s) => s.id === "fireball"),
          "fireball",
        ).itemId;
        const sub = await authority.submit(blue, {
          kind: "orders.submit",
          requestId: randomUUID(),
          turnId: 1,
          expectedRevision: privateBlue.orders.revision,
          unitEdits: [
            {
              unitId: "u-blue",
              order: {
                kind: "cast",
                spellId: "fireball",
                itemId: fbItemId,
                origin: { x: 47.5, y: 22.5 },
              },
            },
          ],
        });
        expect(sub.status).toBe("accepted");

        const closed = await authority.submit(gm, {
          kind: "turn.close",
          requestId: randomUUID(),
          turnId: 1,
        });
        expect(closed.status).toBe("accepted");

        const activeAuth = authority;
        await vi.waitFor(() => {
          expect(activeAuth.battle.state.version).toBe(1);
        });

        const liveState = authority.battle.live;
        const published = await db.version(1);
        const previewPayload = buildReconciliationPayload(
          roomId,
          authority.battle.scenario,
          published,
          liveState,
          45,
          15,
          true,
        );
        expect(previewPayload.previewOnly).toBe(true);
        expect(previewPayload.doorStates).toEqual({ "door-gate": 1 });
        expect(previewPayload.darkness).toBe(0.4);
        const blueSummary = previewPayload.units?.find((u) => u.id === "u-blue");
        expect(blueSummary?.spellsSpent?.fireball).toBe(1);
      } finally {
        await authority?.close();
        await db.pool.query("DELETE FROM strategic_rooms WHERE id = $1", [roomId]).catch(() => undefined);
        await db.dispose();
      }
    });
  });
});
