import { describe, expect, test } from "vitest";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { XoshiroPRNG } from "../../src/sim/prng";
import { ModelStatus, type ArmyDocument, type FactionDocument, type OrderQueue } from "../../src/core/strategic";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { SimEvent } from "../../src/core/sim";
import { drawableUnits } from "../../src/canvas/layers/ModelLayer/units";
import { detailLayer } from "../../src/ui/strategicRoom/hostedLayer";
import { parseCommand, type Baseline, type ModelMarker } from "../../src/core/strategicRoom/protocol";
import { validateWorldSettingsPatch } from "../../src/core/worldSettings";
import { deploy, parseScenario } from "../../services/strategic-room/src/scenario";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";

function makeCtx(settings: Record<string, unknown>): RulesContext {
  return {
    sceneId: "scene-spatial",
    grid: { type: "square", size: 1000, distance: 5, units: "ft", diagonals: "555" },
    walls: {
      x1: new Float32Array(),
      y1: new Float32Array(),
      x2: new Float32Array(),
      y2: new Float32Array(),
      restriction: new Uint8Array(),
    },
    factions: [
      {
        _id: "f0",
        type: "faction",
        name: "Blue",
        color: "#2e6f9e",
        ownership: { default: 3 },
        flags: {},
        system: {},
        allies: [],
      },
      {
        _id: "f1",
        type: "faction",
        name: "Red",
        color: "#c0392b",
        ownership: { default: 3 },
        flags: {},
        system: {},
        allies: [],
      },
    ],
    armies: [],
    leaderActors: {},
    worldSettings: settings,
    turnMode: "simultaneous",
  } as unknown as RulesContext;
}

describe("Per-model spatial melee (C1 / C19)", () => {
  test("5-ft reach attacks adjacent enemies, reach 10-ft attacks from 2 squares away, blocked rear rank does not swing", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(6, PF1E_MODEL_SCHEMA);
    // Unit 0 (Blue standard 5-ft reach): front model at x=0, y=0; blocked rear model at x=-10, y=0 (x=-5, -5..+5 blocked by allies)
    allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 30,
      hpMax: 30,
      sys: { ac: 10, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 1 },
    });
    allocModel(pool, {
      id: 2,
      unitIdx: 0,
      x: -10,
      y: 0,
      hp: 30,
      hpMax: 30,
      sys: { ac: 10, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 1 },
    });
    // Unit 1 (Blue pike 10-ft reach): model at x=0, y=20 facing Red at x=10, y=20
    allocModel(pool, {
      id: 3,
      unitIdx: 1,
      x: 0,
      y: 20,
      hp: 30,
      hpMax: 30,
      sys: { ac: 10, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 2 },
    });
    // Unit 2 (Red target for standard): at x=5, y=0
    allocModel(pool, {
      id: 4,
      unitIdx: 2,
      x: 5,
      y: 0,
      hp: 100,
      hpMax: 100,
      sys: { ac: 5, touchAc: 5, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 3 },
    });
    // Unit 3 (Red target for pike at 10 ft): at x=10, y=20
    allocModel(pool, {
      id: 5,
      unitIdx: 3,
      x: 10,
      y: 20,
      hp: 100,
      hpMax: 100,
      sys: { ac: 5, touchAc: 5, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 4 },
    });

    const units: UnitView[] = [
      {
        id: "u-std",
        armyId: "a0",
        factionId: "f0",
        type: "infantry",
        name: "Swordsmen",
        profile: {},
        stats: { bab: 20, strMod: 4, ac: 10, move: 0, damageDiceCount: 1, damageDiceSides: 1 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [0, 2],
        leaderTokenId: null,
      },
      {
        id: "u-pike",
        armyId: "a0",
        factionId: "f0",
        type: "infantry",
        name: "Pikemen",
        profile: {},
        stats: { bab: 6, strMod: 3, ac: 10, move: 0, weaponReachFt: 10 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [2, 3],
        leaderTokenId: null,
      },
      {
        id: "u-red-1",
        armyId: "a1",
        factionId: "f1",
        type: "infantry",
        name: "Red 1",
        profile: {},
        stats: { bab: 1, strMod: 0, ac: 5, move: 0 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [3, 4],
        leaderTokenId: null,
      },
      {
        id: "u-red-2",
        armyId: "a1",
        factionId: "f1",
        type: "infantry",
        name: "Red 2",
        profile: {},
        stats: { bab: 1, strMod: 0, ac: 5, move: 0 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [4, 5],
        leaderTokenId: null,
      },
    ];

    const orders = new Map<string, OrderQueue>([
      ["u-std", { issuedBy: "gm", issuedTurn: 1, pending: [{ kind: "attack", targetUnitId: "u-red-1" }] }],
      ["u-pike", { issuedBy: "gm", issuedTurn: 1, pending: [{ kind: "attack", targetUnitId: "u-red-2" }] }],
    ]);
    const events: SimEvent[] = [];
    rules.resolveTurn(
      makeCtx({ strategicSpatialCombat: true, strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(11),
      (ev) => events.push(ev),
    );

    const stdEv = events.find((e) => e.type === "attack" && e.unitId === "u-std");
    // Only model 0 is in 5-ft reach (4 iteratives from BAB 20); blocked model 1 at x=-5 gets 0 swings!
    expect((stdEv?.data as { totalAttacks?: number } | undefined)?.totalAttacks).toBe(4);
    expect(pool.hp[3]).toBeLessThan(100);
    // Pike at 10-ft reach hits Red 2 without stepping
    expect(pool.x[2]).toBe(0);
    expect(pool.hp[4]).toBeLessThan(100);
  });

  test("unengaged model 1 square short takes free 5-ft step + full iterative attacks; farther model strides + provokes AoO + gets 1 standard attack", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    // Blue model 0 at x=0 (10 ft from Red at x=10 -> 1 square short -> 5-ft step to x=5 + full 3 iteratives from BAB 11)
    allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 40,
      hpMax: 40,
      sys: { ac: 10, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 1 },
    });
    // Red target 0 at x=10, y=0
    allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 10,
      y: 0,
      hp: 100,
      hpMax: 100,
      sys: { ac: 5, touchAc: 5, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 2 },
    });
    // Blue strider at x=0, y=50 (20 ft from Red reach guard at x=20, y=50 -> must stride 15 ft to x=15, provoking AoO from 10-ft reach guard, and gets only 1 standard swing despite BAB 11)
    allocModel(pool, {
      id: 3,
      unitIdx: 2,
      x: 0,
      y: 50,
      hp: 50,
      hpMax: 50,
      sys: { ac: 5, touchAc: 5, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 3 },
    });
    // Red 10-ft reach guard at x=20, y=50 (threatens x=10 and x=15 -> leaving x=10 for x=15 provokes AoO!)
    allocModel(pool, {
      id: 4,
      unitIdx: 3,
      x: 20,
      y: 50,
      hp: 100,
      hpMax: 100,
      sys: { ac: 5, touchAc: 5, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 4 },
    });

    const units: UnitView[] = [
      {
        id: "u-step",
        armyId: "a0",
        factionId: "f0",
        type: "infantry",
        name: "Stepper",
        profile: {},
        stats: { bab: 11, strMod: 3, ac: 10, move: 6 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [0, 1],
        leaderTokenId: null,
      },
      {
        id: "u-red-step",
        armyId: "a1",
        factionId: "f1",
        type: "infantry",
        name: "Red Step Target",
        profile: {},
        stats: { bab: 5, strMod: 2, ac: 5, move: 6, weaponReachFt: 10 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [1, 2],
        leaderTokenId: null,
      },
      {
        id: "u-stride",
        armyId: "a0",
        factionId: "f0",
        type: "infantry",
        name: "Strider",
        profile: {},
        stats: { bab: 11, strMod: 3, ac: 5, move: 6 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [2, 3],
        leaderTokenId: null,
      },
      {
        id: "u-red-guard",
        armyId: "a1",
        factionId: "f1",
        type: "infantry",
        name: "Red Pike Guard",
        profile: {},
        stats: { bab: 15, strMod: 4, ac: 5, move: 6, weaponReachFt: 10 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [3, 4],
        leaderTokenId: null,
      },
    ];

    const orders = new Map<string, OrderQueue>([
      ["u-step", { issuedBy: "gm", issuedTurn: 1, pending: [{ kind: "attack", targetUnitId: "u-red-step" }] }],
      ["u-stride", { issuedBy: "gm", issuedTurn: 1, pending: [{ kind: "attack", targetUnitId: "u-red-guard" }] }],
    ]);
    const events: SimEvent[] = [];
    rules.resolveTurn(
      makeCtx({ strategicSpatialCombat: true, strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(23),
      (ev) => events.push(ev),
    );

    // Stepper took 5-ft step to x=5, did NOT provoke AoO from Red Step Target's 10-ft reach, and got full 3 iteratives
    expect(pool.x[0]).toBe(5);
    const stepAttack = events.find((e) => e.type === "attack" && e.unitId === "u-step");
    expect((stepAttack?.data as { totalAttacks?: number } | undefined)?.totalAttacks).toBe(3);
    const stepAoo = events.find((e) => e.type === "opportunity" && e.targetUnitId === "u-step");
    expect(stepAoo).toBeUndefined();

    // Strider moved into reach, provoked AoO from Red Pike Guard, and got only 1 standard attack
    expect(pool.x[2]).toBeGreaterThanOrEqual(10);
    const strideAttack = events.find((e) => e.type === "attack" && e.unitId === "u-stride");
    expect((strideAttack?.data as { totalAttacks?: number } | undefined)?.totalAttacks).toBe(1);
    const strideAoo = events.find((e) => e.type === "opportunity" && e.targetUnitId === "u-stride");
    expect(strideAoo).toBeDefined();
  });
});

describe("Per-model spatial ranged volley (G2b / R3 / T2fix)", () => {
  test("applies holdFire1st, firing into melee (-4 vs Precise Shot), and soft cover (+4 AC after 4 own-unit allies)", () => {
    const rules = createMassBattlePf1e();

    // 1. holdFire1st blocks shots past 1st range increment (60 ft)
    const holdPool = createModelPool(2, PF1E_MODEL_SCHEMA);
    allocModel(holdPool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 20,
      hpMax: 20,
      sys: { ac: 12, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 1 },
    });
    allocModel(holdPool, {
      id: 2,
      unitIdx: 1,
      x: 100,
      y: 0,
      hp: 20,
      hpMax: 20,
      sys: { ac: 10, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 2 },
    });
    const holdUnits: UnitView[] = [
      {
        id: "u-arch",
        armyId: "a0",
        factionId: "f0",
        type: "archer",
        name: "Disciplined Archers",
        profile: {},
        stats: { bab: 10, dexMod: 4, isRanged: 1, rangeIncrement: 60, maxIncrements: 10, holdFire1st: 1 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [0, 1],
        leaderTokenId: null,
      },
      {
        id: "u-tgt",
        armyId: "a1",
        factionId: "f1",
        type: "infantry",
        name: "Target",
        profile: {},
        stats: { ac: 10 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [1, 2],
        leaderTokenId: null,
      },
    ];
    const holdEvents: SimEvent[] = [];
    rules.resolveTurn(
      makeCtx({ strategicSpatialCombat: true }),
      holdPool,
      holdUnits,
      new Map([["u-arch", { issuedBy: "gm", issuedTurn: 1, pending: [{ kind: "attack", targetUnitId: "u-tgt", mode: "shot" }] }]]),
      new XoshiroPRNG(5),
      (ev) => holdEvents.push(ev),
    );
    expect(holdPool.hp[1]).toBe(20);

    // 2. Firing into melee (-4 penalty without Precise Shot vs no penalty with Precise Shot) & soft cover (+4 AC from intervening screen unit)
    const runVolleyTrial = (preciseShot: number, interveningScreen: boolean): number => {
      let totalHits = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
        // Shooter at (0, 0)
        allocModel(pool, {
          id: 1,
          unitIdx: 0,
          x: 0,
          y: 0,
          hp: 20,
          hpMax: 20,
          sys: { ac: 12, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 1 },
        });
        // Target at (30, 0) with AC 16
        allocModel(pool, {
          id: 2,
          unitIdx: 1,
          x: 30,
          y: 0,
          hp: 50,
          hpMax: 50,
          sys: { ac: 16, touchAc: 12, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 2 },
        });
        // Friendly melee ally adjacent to target at (30, 5) so target is in melee (not on shot line y=0 unless screen enabled)
        allocModel(pool, {
          id: 3,
          unitIdx: 2,
          x: interveningScreen ? 15 : 30,
          y: interveningScreen ? 0 : 5,
          hp: 20,
          hpMax: 20,
          sys: { ac: 14, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 3 },
        });
        const trialUnits: UnitView[] = [
          {
            id: "u-bow",
            armyId: "a0",
            factionId: "f0",
            type: "archer",
            name: "Bow",
            profile: {},
            stats: { bab: 4, dexMod: 2, isRanged: 1, rangeIncrement: 60, maxIncrements: 10, preciseShot },
            orders: null,
            formation: "line",
            sceneId: "scene-spatial",
            modelRange: [0, 1],
            leaderTokenId: null,
          },
          {
            id: "u-enemy",
            armyId: "a1",
            factionId: "f1",
            type: "infantry",
            name: "Enemy",
            profile: {},
            stats: { ac: 16 },
            orders: null,
            formation: "line",
            sceneId: "scene-spatial",
            modelRange: [1, 2],
            leaderTokenId: null,
          },
          {
            id: "u-ally",
            armyId: "a0",
            factionId: "f0",
            type: "infantry",
            name: "Screen Ally",
            profile: {},
            stats: { ac: 14 },
            orders: null,
            formation: "line",
            sceneId: "scene-spatial",
            modelRange: [2, 3],
            leaderTokenId: null,
          },
        ];
        rules.resolveTurn(
          makeCtx({ strategicSpatialCombat: true }),
          pool,
          trialUnits,
          new Map([["u-bow", { issuedBy: "gm", issuedTurn: 1, pending: [{ kind: "attack", targetUnitId: "u-enemy", mode: "shot" }] }]]),
          new XoshiroPRNG(seed * 97 + 3),
          () => {},
        );
        if ((pool.hp[1] ?? 50) < 50) totalHits++;
      }
      return totalHits;
    };

    const hitsIntoMeleeNoFeat = runVolleyTrial(0, false);
    const hitsIntoMeleePrecise = runVolleyTrial(1, false);
    const hitsThroughOtherUnitCover = runVolleyTrial(1, true);
    expect(hitsIntoMeleePrecise).toBeGreaterThan(hitsIntoMeleeNoFeat);
    expect(hitsIntoMeleePrecise).toBeGreaterThan(hitsThroughOtherUnitCover);
  });
});

describe("3-Tier GM Autonomous Unit Behavior & Hosted Protocol", () => {
  test("Global, Per-Faction, and Per-Unit autonomy hierarchy + explicit player/GM order override", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(5, PF1E_MODEL_SCHEMA);
    // u0 (f0): global=false, f0=true -> advances!
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    // u1 (f0): f0=true, but unit override = "off" -> stays put!
    allocModel(pool, { id: 2, unitIdx: 1, x: 0, y: 30, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    // u2 (f0): f0=true, explicit player hold order -> overrides autonomy and stays put!
    allocModel(pool, { id: 3, unitIdx: 2, x: 0, y: 60, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    // u3 (f1): global=false, f1 omitted, unit override = "advance" -> advances!
    allocModel(pool, { id: 4, unitIdx: 3, x: 80, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    // u4 (f1): global=false, f1 omitted, no unit override -> stays put!
    allocModel(pool, { id: 5, unitIdx: 4, x: 80, y: 40, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 2, ref: 2, will: 2, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });

    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "F0 Auto", profile: {}, stats: { bab: 3, ac: 14 }, orders: null, formation: "line", sceneId: "scene-spatial", modelRange: [0, 1], leaderTokenId: null },
      { id: "u1", armyId: "a0", factionId: "f0", type: "infantry", name: "F0 UnitOff", profile: {}, stats: { bab: 3, ac: 14 }, orders: null, formation: "line", sceneId: "scene-spatial", modelRange: [1, 2], leaderTokenId: null },
      { id: "u2", armyId: "a0", factionId: "f0", type: "infantry", name: "F0 ExplicitHold", profile: {}, stats: { bab: 3, ac: 14 }, orders: null, formation: "line", sceneId: "scene-spatial", modelRange: [2, 3], leaderTokenId: null },
      { id: "u3", armyId: "a1", factionId: "f1", type: "infantry", name: "F1 UnitAdvance", profile: {}, stats: { bab: 3, ac: 14 }, orders: null, formation: "line", sceneId: "scene-spatial", modelRange: [3, 4], leaderTokenId: null },
      { id: "u4", armyId: "a1", factionId: "f1", type: "infantry", name: "F1 Idle", profile: {}, stats: { bab: 3, ac: 14 }, orders: null, formation: "line", sceneId: "scene-spatial", modelRange: [4, 5], leaderTokenId: null },
    ];

    const orders = new Map<string, OrderQueue>([
      ["u2", { issuedBy: "player-1", issuedTurn: 1, pending: [{ kind: "hold", stance: "defend" }] }],
    ]);

    rules.resolveTurn(
      makeCtx({
        strategicAutonomyGlobal: false,
        strategicAutonomyFactions: { f0: true },
        strategicAutonomyUnits: { u1: "off", u3: "advance" },
        strategicSimultaneous: true,
      }),
      pool,
      units,
      orders,
      new XoshiroPRNG(19),
      () => {},
    );

    expect(pool.x[0]).toBeGreaterThan(0); // u0 marched toward enemy
    expect(pool.x[1]).toBe(0); // u1 overridden to "off"
    expect(pool.x[2]).toBe(0); // u2 had explicit player order
    expect(pool.x[3]).toBeLessThan(80); // u3 overridden to "advance"
    expect(pool.x[4]).toBe(80); // u4 inherited global=false
  });

  test("autonomy.configure wire command parses cleanly and Hosted resolveFrozen honors live.autonomy", () => {
    const parsed = parseCommand({
      kind: "autonomy.configure",
      requestId: "req_autonomy_configure_01",
      spatialCombat: true,
      global: false,
      factions: { blue: true },
      units: { red: "advance" },
    });
    expect(parsed).toEqual({
      kind: "autonomy.configure",
      requestId: "req_autonomy_configure_01",
      spatialCombat: true,
      global: false,
      factions: { blue: true },
      units: { red: "advance" },
    });

    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Hosted Autonomy",
      seed: 12,
      bounds: { minX: -200, minY: -200, maxX: 200, maxY: 200 },
      factions: [
        { id: "blue", color: "#0000ff", name: "Blue" },
        { id: "red", color: "#ff0000", name: "Red" },
      ],
      commanders: [
        { id: "c-blue", factionId: "blue", units: [{ id: "u-blue", name: "Blue", strength: 5, weapon: "melee", anchor: { x: -40, y: 0 } }] },
        { id: "c-red", factionId: "red", units: [{ id: "u-red", name: "Red", strength: 5, weapon: "melee", anchor: { x: 40, y: 0 } }] },
      ],
    });
    const start = deploy(scenario);
    const res = resolveFrozen({
      turnId: 1,
      seed: 12,
      orders: [],
      start,
      scenario,
      live: {
        autonomy: {
          spatialCombat: true,
          global: false,
          factions: { blue: true, red: false },
        },
      },
    });
    // Blue autonomously marched east; Red stayed put at x=40
    expect(res.state.hash).not.toBe(start.hash);
  });
});

describe("Per-model shared VTT token art projection", () => {
  test("drawableUnits and hostedLayer project shared unit tokenImg to DrawableUnit views", () => {
    const factions: FactionDocument[] = [
      { _id: "f-blue", type: "faction", name: "Blue", color: "#4da3ff", allies: [], ownership: { default: 0 }, flags: {}, system: {} },
    ];
    const armies: ArmyDocument[] = [
      {
        _id: "a-blue",
        type: "army",
        name: "Vanguard",
        factionId: "f-blue",
        commander: [],
        supply: {},
        ownership: { default: 0 },
        flags: {},
        system: {},
        units: [
          {
            _id: "u-1",
            type: "infantry",
            name: "1st Guard",
            ownership: { default: 0 },
            flags: {},
            system: {},
            profile: { tokenImg: "/assets/guard-token.png" },
            formation: "line",
            sceneId: null,
            modelRange: [0, 10],
            orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
            stats: { strength: 10, morale: 10, supply: 10, fatigue: 0 },
          },
        ],
      },
    ];
    const drawables = drawableUnits(armies, factions);
    expect(drawables[0]?.tokenImg).toBe("/assets/guard-token.png");

    const view: Baseline = {
      epoch: "1",
      head: { turnId: 1, version: 0, phase: "orders", deadlineMs: null },
      name: "Room 1",
      role: "GM",
      factionId: null,
      bounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
      factions: [{ id: "f-blue", name: "Blue", color: "#4da3ff" }],
      markers: [{ id: "u-1", name: "1st Guard", factionId: "f-blue", at: { x: 0, y: 0 } }],
      unitBadges: { "u-1": "/badges/guard.webp" },
      own: [],
      orders: { revision: 0, edits: [] },
    };
    const models = new Map<string, ModelMarker>([
      ["m1", { id: "m1", unitId: "u-1", x: 0, y: 0, rotation: 0 }],
      ["m2", { id: "m2", unitId: "u-1", x: 0, y: 5, rotation: 0 }],
    ]);
    const hosted = detailLayer(view, models);
    expect(hosted.units[0]?.tokenImg).toBe("/badges/guard.webp");
    expect(hosted.pool.count).toBe(2);

    const okZoomOut = validateWorldSettingsPatch({ strategicUnitZoomOutTokens: true });
    expect(okZoomOut.ok).toBe(true);
    expect(okZoomOut.clean["strategicUnitZoomOutTokens"]).toBe(true);
    const badZoomOut = validateWorldSettingsPatch({ strategicUnitZoomOutTokens: "yes" });
    expect(badZoomOut.ok).toBe(false);
  });
});

describe("50,000-unit turn scale benchmark (< 5000 ms)", () => {
  test("resolves a 50,000-unit turn with GM autonomy + per-model spatial combat well under 5 seconds", () => {
    const UNIT_COUNT = 50_000;
    const rules = createMassBattlePf1e();
    const pool = createModelPool(UNIT_COUNT, PF1E_MODEL_SCHEMA);
    const units: UnitView[] = new Array<UnitView>(UNIT_COUNT);

    // 25,000 Blue units facing 25,000 Red units across 250 lanes so thousands engage in melee/ranged while thousands march autonomously
    const half = UNIT_COUNT / 2;
    for (let i = 0; i < half; i++) {
      const col = Math.floor(i / 250);
      const row = i % 250;
      const bx = -col * 5;
      const by = row * 10;
      const isRanged = col === 1 ? 1 : 0;
      allocModel(pool, {
        id: i + 1,
        unitIdx: i,
        x: bx,
        y: by,
        hp: 15,
        hpMax: 15,
        sys: { ac: 15, touchAc: 11, fort: 3, ref: 1, will: 1, sr: 0, drType: 0, drVal: 0, profileIdx: isRanged ? 2 : 1 },
      });
      units[i] = {
        id: `b-${i}`,
        armyId: "a-blue",
        factionId: "f0",
        type: isRanged ? "archer" : "infantry",
        name: `Blue ${i}`,
        profile: {},
        stats: isRanged
          ? { bab: 4, dexMod: 2, ac: 14, weaponIsRanged: 1, weaponRangeIncrement: 60, weaponMaxIncrements: 5 }
          : { bab: 4, strMod: 2, ac: 15 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [i, i + 1],
        leaderTokenId: null,
      };
    }
    for (let i = 0; i < half; i++) {
      const uIdx = half + i;
      const col = Math.floor(i / 250);
      const row = i % 250;
      const rx = 5 + col * 5;
      const ry = row * 10;
      allocModel(pool, {
        id: uIdx + 1,
        unitIdx: uIdx,
        x: rx,
        y: ry,
        hp: 15,
        hpMax: 15,
        sys: { ac: 15, touchAc: 11, fort: 3, ref: 1, will: 1, sr: 0, drType: 0, drVal: 0, profileIdx: 1 },
      });
      units[uIdx] = {
        id: `r-${i}`,
        armyId: "a-red",
        factionId: "f1",
        type: "infantry",
        name: `Red ${i}`,
        profile: {},
        stats: { bab: 4, strMod: 2, ac: 15 },
        orders: null,
        formation: "line",
        sceneId: "scene-spatial",
        modelRange: [uIdx, uIdx + 1],
        leaderTokenId: null,
      };
    }

    const orders = new Map<string, OrderQueue>();
    const ctx = makeCtx({
      strategicSpatialCombat: true,
      strategicAutonomyGlobal: true,
      strategicSimultaneous: true,
    });

    const t0 = performance.now();
    let eventCount = 0;
    rules.resolveTurn(ctx, pool, units, orders, new XoshiroPRNG(101), () => {
      eventCount++;
    });
    const elapsedMs = performance.now() - t0;

    let casualties = 0;
    for (let i = 0; i < pool.count; i++) {
      if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0 || (pool.hp[i] ?? 15) < 15) {
        casualties++;
      }
    }
    console.log(
      `[50k-Unit Spatial+Autonomy Benchmark] units=${UNIT_COUNT} models=${pool.count} resolveMs=${elapsedMs.toFixed(1)}ms events=${eventCount} damagedOrDead=${casualties}`,
    );
    expect(casualties).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(5000);
  });
});
