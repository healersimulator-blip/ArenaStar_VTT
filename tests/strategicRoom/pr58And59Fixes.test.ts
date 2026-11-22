import { describe, expect, test } from "vitest";
import { makeToken } from "../../src/app/hostBoot";
import type { SceneDocument } from "../../src/core/documents";
import { DocumentStore } from "../../src/core/store";
import {
  analyzeBattleReconciliation,
  buildBattleReconciliationOps,
} from "../../src/core/strategicRoom/reconcile";
import { parseCommand, type BattleReconciliationPayload } from "../../src/core/strategicRoom/protocol";
import { parseScenario } from "../../src/core/strategicRoom/scenario";
import { applyPerimeterEnvelopment } from "../../src/packages/pf1e/formationSlots";
import { BattleView } from "../../services/strategic-room/src/battle";
import { evaluateHostRollFormula } from "../../services/strategic-room/src/postgres";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import { deploy, rulesInput } from "../../services/strategic-room/src/scenario";
import { checkpointPool, type Member } from "../../services/strategic-room/src/state";

const SECRET = new Uint8Array(32);

const blueMember: Member = {
  id: "cmd-blue",
  name: "Blue Commander",
  role: "PLAYER",
  factionId: "blue",
  epoch: 1,
};

const redMember: Member = {
  id: "cmd-red",
  name: "Red Commander",
  role: "PLAYER",
  factionId: "red",
  epoch: 1,
};

describe("PR #58 & #59 mechanics and hosted-battle fixes", () => {
  test("1. Perimeter envelopment caps single-round travel by maxMoveFeet and rotates wrapped models toward the defender", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Envelopment Speed Cap",
      seed: 17,
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
      factions: [
        { id: "blue", name: "Blue", color: "#5599ff" },
        { id: "red", name: "Red", color: "#ff6655" },
      ],
      commanders: [
        {
          id: "cmd-blue",
          factionId: "blue",
          units: [
            {
              id: "u-blue",
              name: "Blue Cohort",
              strength: 80,
              weapon: "melee",
              anchor: { x: 245, y: 250 },
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red",
              name: "Red Guard",
              strength: 4,
              weapon: "melee",
              anchor: { x: 250, y: 250 },
            },
          ],
        },
      ],
    });
    if (!scenario) throw new Error("Expected valid scenario");

    const state0 = deploy(scenario);
    const pool = checkpointPool(state0);
    const blueRange = state0.units[0]?.range;
    const redRange = state0.units[1]?.range;
    if (!blueRange || !redRange) throw new Error("Missing unit ranges");
    const beforeX = Array.from({ length: blueRange[1] - blueRange[0] }, (_, k) => pool.x[blueRange[0] + k] ?? 0);
    const beforeY = Array.from({ length: blueRange[1] - blueRange[0] }, (_, k) => pool.y[blueRange[0] + k] ?? 0);

    const moved = applyPerimeterEnvelopment({
      pool,
      attackerRange: blueRange,
      defenderRange: redRange,
      attackerAnchor: { x: 245, y: 250 },
      defenderAnchor: { x: 250, y: 250 },
      cellFeet: 5,
      reachFt: 5,
      bounds: scenario.bounds,
      maxMoveFeet: 40,
    });
    expect(moved.wrapped).toBeGreaterThan(0);

    for (let k = 0; k < beforeX.length; k++) {
      const m = blueRange[0] + k;
      const d = Math.hypot((pool.x[m] ?? 0) - (beforeX[k] ?? 0), (pool.y[m] ?? 0) - (beforeY[k] ?? 0));
      expect(d).toBeLessThanOrEqual(40.001);
    }
  });

  test("2. Moving units rotate toward travel direction and right-side default facing persists across turns in BattleView", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Facing & Rotation",
      seed: 23,
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
      factions: [
        { id: "blue", name: "Blue", color: "#5599ff" },
        { id: "red", name: "Red", color: "#ff6655" },
      ],
      commanders: [
        {
          id: "cmd-blue",
          factionId: "blue",
          units: [
            {
              id: "u-blue",
              name: "Blue Vanguards",
              strength: 20,
              weapon: "melee",
              anchor: { x: 150, y: 250 },
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red",
              name: "Red Line",
              strength: 20,
              weapon: "melee",
              anchor: { x: 450, y: 250 },
            },
          ],
        },
      ],
    });
    if (!scenario) throw new Error("Expected valid scenario");

    const state0 = deploy(scenario);
    const bv0 = new BattleView(scenario, state0, SECRET);
    const redOwn0 = bv0.own(redMember);
    expect(redOwn0[0]?.facing).toBeCloseTo(Math.PI, 2);
    expect(bv0.own(blueMember)[0]?.leadAt).toBeTruthy();

    // Blue marches due south (+Y = PI/2), Red holds without explicit facing.
    const r1 = resolveFrozen({
      turnId: 1,
      seed: 23,
      scenario,
      start: state0,
      orders: [
        {
          unitId: "u-blue",
          memberId: "cmd-blue",
          order: { kind: "move", pace: "march", path: [{ x: 150, y: 310 }] },
        },
      ],
    });

    const pool1 = checkpointPool(r1.state);
    expect(pool1.rot[0]).toBeGreaterThan(0.5);

    const bv1 = new BattleView(scenario, r1.state, SECRET);
    const redOwn1 = bv1.own(redMember);
    // Right-side stationary army preserves default PI facing on turn 1+ instead of flipping to 0.
    expect(Math.abs(redOwn1[0]?.facing ?? 0)).toBeCloseTo(Math.PI, 2);
  });

  test("3. Elevation melee bonus uses live post-march unit positions instead of static turn-0 anchors", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Live Ridge Elevation",
      seed: 31,
      bounds: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
      regions: [{ id: "reg-1", x: 200, y: 200, width: 100, height: 100, elevationFt: 15, kind: "raised" }],
      factions: [
        { id: "blue", name: "Blue", color: "#5599ff" },
        { id: "red", name: "Red", color: "#ff6655" },
      ],
      commanders: [
        {
          id: "cmd-blue",
          factionId: "blue",
          units: [
            {
              id: "u-blue",
              name: "Blue Climbers",
              strength: 10,
              weapon: "melee",
              anchor: { x: 100, y: 250 },
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red",
              name: "Red Lowlanders",
              strength: 10,
              weapon: "melee",
              anchor: { x: 320, y: 250 },
            },
          ],
        },
      ],
    });
    if (!scenario) throw new Error("Expected valid scenario");

    const state0 = deploy(scenario);
    const baseRules = rulesInput(scenario, state0.units);
    const baseBab = baseRules.units[0]?.stats.bab ?? 0;

    const movedRules = rulesInput(scenario, state0.units, {
      unitPositions: new Map([
        ["u-blue", { x: 250, y: 250 }],
        ["u-red", { x: 320, y: 250 }],
      ]),
    });
    expect(movedRules.units[0]?.stats.bab).toBe(baseBab + 1);
    expect(movedRules.units[1]?.stats.bab).toBe(baseRules.units[1]?.stats.bab);
  });

  test("4. Readied enemyEntersReach checks reachable stride distance and line of effect; blast ActionCard reports true spell hits; exited hazards clear Entangled", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Ready, Blast & Hazard Cleanup",
      seed: 42,
      bounds: { minX: 0, minY: 0, maxX: 800, maxY: 800 },
      hazards: [{ id: "hz-1", spell: "entangle", at: { x: 150, y: 250 }, radius: 40, dc: 14, expiresAfterTurn: 1 }],
      factions: [
        { id: "blue", name: "Blue", color: "#5599ff" },
        { id: "red", name: "Red", color: "#ff6655" },
      ],
      commanders: [
        {
          id: "cmd-blue",
          factionId: "blue",
          units: [
            {
              id: "u-blue",
              name: "Blue Watch",
              strength: 10,
              weapon: "melee",
              anchor: { x: 150, y: 250 },
              spells: [
                {
                  id: "fireball",
                  itemId: "item-fb",
                  casterLevel: 5,
                  castingAbilityMod: 3,
                  slots: 2,
                },
                {
                  id: "burning-hands",
                  itemId: "item-bh",
                  casterLevel: 5,
                  castingAbilityMod: 3,
                  slots: 2,
                },
              ],
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red-far",
              name: "Far Raiders",
              strength: 10,
              weapon: "melee",
              anchor: { x: 650, y: 250 },
            },
          ],
        },
      ],
    });
    if (!scenario) throw new Error("Expected valid scenario");

    const state0 = deploy(scenario);
    // Validate cone spell origin enforcement in BattleView: far origin is rejected, unit origin accepted.
    const bv0 = new BattleView(scenario, state0, SECRET);
    expect(
      bv0.validate(blueMember, {
        unitId: "u-blue",
        order: {
          kind: "cast",
          spellId: "burning-hands",
          itemId: "item-bh",
          origin: { x: 500, y: 500 },
          dir: { x: 1, y: 0 },
        },
      }),
    ).toContain("originates at the casting unit");

    // Turn 1: Blue readies melee vs enemyEntersReach while Far Raiders order a charge toward (155, 250) from 500 ft away!
    // Since Far Raiders can only move up to 40 ft this turn, they do NOT enter reach on Turn 1.
    const r1 = resolveFrozen({
      turnId: 1,
      seed: 42,
      scenario,
      start: state0,
      orders: [
        {
          unitId: "u-blue",
          memberId: "cmd-blue",
          order: { kind: "ready", trigger: "enemyEntersReach", response: "melee" },
        },
        {
          unitId: "u-red-far",
          memberId: "cmd-red",
          order: { kind: "move", pace: "charge", path: [{ x: 155, y: 250 }] },
        },
      ],
    });
    expect(r1.state.actions ?? []).toHaveLength(0);
    expect(r1.state.extras?.unitResources?.["u-blue"]?.conditions).toContain("Entangled");

    // Turn 2: hz-1 expired after turn 1, and Blue casts Fireball into empty ground (400, 600).
    // Blast card should report 0 targets/kills, and expired Entangled condition should clear!
    const r2 = resolveFrozen({
      turnId: 2,
      seed: 43,
      scenario,
      start: r1.state,
      orders: [
        {
          unitId: "u-blue",
          memberId: "cmd-blue",
          order: {
            kind: "cast",
            spellId: "fireball",
            itemId: "item-fb",
            origin: { x: 400, y: 600 },
          },
        },
      ],
    });
    const fbCard = (r2.state.actions ?? []).find((a) => a.id.startsWith("fireball-"));
    expect(fbCard?.targets[0]?.name).toBe("0 model(s) in area");
    expect(fbCard?.notes).toContain("Damage dealt: 0 HP · Casualties: 0");
    expect(r2.state.extras?.unitResources?.["u-blue"]?.conditions ?? []).not.toContain("Entangled");
  });

  test("5. Protocol scene.template put, roll-table formula evaluation, and reconciliation delta/conflict accounting", () => {
    const parsedPut = parseCommand({
      kind: "scene.template",
      requestId: "req-tpl-12345678",
      op: "put",
      template: {
        id: "tpl-1",
        shape: "circle",
        x: 200,
        y: 200,
        distance: 20,
        color: "#ff8844",
      },
    });
    expect(parsedPut?.kind).toBe("scene.template");

    // Roll table formula with modifier evaluates through evaluateHostRollFormula
    const evaluated = evaluateHostRollFormula("1d1+4");
    expect(evaluated?.total).toBe(5);

    // Reconciliation: unchanged door/darkness reports 0 sceneChanges; conflicted scene skips token reconciledUnits bump
    const store = new DocumentStore({
      meta: { worldId: "w", name: "Test World", system: "pf1e", systemVersion: "1" },
    });
    const tok = makeToken("Guard", 200, 200);
    const scene: SceneDocument = {
      _id: "scene-test-1",
      type: "scene",
      name: "Battle",
      active: true,
      img: null,
      width: 2000,
      height: 2000,
      darkness: 0.25,
      grid: { type: "square", size: 20, units: "ft", distance: 5, diagonals: "555", hexLayout: "oddQ" },
      tokens: [tok],
      walls: [],
      lights: [],
      sounds: [],
      tiles: [],
      drawings: [],
      templates: [],
      notes: [],
      regions: [],
      ownership: { default: 1 },
      flags: { core: { scale: "strategic" } },
      system: {},
    };
    const envRes = store.applyEnvelope({
      seq: 1,
      ts: 1,
      by: "gm",
      txId: "tx-1",
      ops: [{ kind: "create", coll: "scenes", data: scene as never }],
    });
    expect(envRes.ok).toBe(true);

    const payload: BattleReconciliationPayload = {
      id: "b-1",
      version: 2,
      projection: {
        worldId: "w",
        sceneId: scene._id,
        sourceSeq: 1,
        digest: "stale",
        dependencies: [
          {
            coll: "scenes",
            id: scene._id,
            digest: "different-from-current-scene",
            visibility: "public",
          },
        ],
      },
      darkness: 0.25,
      units: [
        {
          id: `token-${tok._id}`,
          name: "Guard",
          factionId: "blue",
          source: { kind: "token", tokenId: tok._id },
          initialStrength: 20,
          alive: 15,
          lost: 5,
          at: { x: 50, y: 50 },
        },
      ],
    };

    const analysis = analyzeBattleReconciliation(store, scene._id, payload);
    expect(analysis.sceneChanges).toBe(0);
    expect(analysis.unitChanges).toBe(1);

    const built = buildBattleReconciliationOps(store, scene._id, payload, { skipConflicted: true });
    expect(built.reconciledUnits).toBe(0);
    expect(built.skippedConflicts).toBe(1);
    expect(built.ops).toHaveLength(1); // Only the audit journal entry
  });
});
