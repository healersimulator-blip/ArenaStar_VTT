import { describe, expect, test } from "vitest";
import { ModelStatus, type ModelPool } from "../../src/core/strategic";
import { STRATEGIC_CODEC } from "../../src/core/strategicRoom/protocol";
import { parseScenario, type Scenario } from "../../src/core/strategicRoom/scenario";
import {
  applyFormationReform,
  applyPerimeterEnvelopment,
  effectiveFilePromotions,
  normalizeAngle,
  rotateToward,
  unitFrontSaturation,
} from "../../src/packages/pf1e/formationSlots";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { type OrderQueue } from "../../src/core/strategic";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { SimEvent } from "../../src/core/sim";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { XoshiroPRNG } from "../../src/sim/prng";
import { PF1E_MODEL_SCHEMA, PF1eCondition } from "../../src/packages/pf1e/schema";
import {
  canonicalPoolHash,
  encodeSimSnapshot,
  snapshotFromPool,
} from "../../src/sim/codec";
import { directAttackOrder, orderLabel } from "../../src/ui/armies/heroOrders";
import { BattleView } from "../../services/strategic-room/src/battle";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import { deploy } from "../../services/strategic-room/src/scenario";
import {
  checkpointPool,
  type Member,
  type Published,
} from "../../services/strategic-room/src/state";

const SECRET = new Uint8Array(32);

const blueMember: Member = {
  id: "cmd-blue",
  name: "Blue Commander",
  role: "PLAYER",
  factionId: "blue",
  epoch: 1,
};

function repackPublished(state: Published, pool: ModelPool): Published {
  const snap = snapshotFromPool(
    pool,
    "battlefield",
    state.version,
    PF1E_MODEL_SCHEMA,
    STRATEGIC_CODEC,
  );
  let maxHpMax = 1;
  for (let i = 0; i < pool.count; i++) {
    maxHpMax = Math.max(maxHpMax, pool.hpMax[i] ?? 1);
  }
  const bytes = encodeSimSnapshot(snap, maxHpMax);
  return {
    ...state,
    bytes,
    maxHpMax,
    hash: canonicalPoolHash(pool, PF1E_MODEL_SCHEMA, STRATEGIC_CODEC),
  };
}

function mustRange(state: Published, unitIdx: number): [number, number] {
  const range = state.units[unitIdx]?.range;
  if (!range) throw new Error(`Missing unit range at index ${unitIdx}`);
  return range;
}

describe("combat_resolver_5 large-unit formation mechanics", () => {
  test("I2/I3/C3: per-file gap promotion and stationary/half-speed march reform restore front saturation without cross-file drift", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Cohort Reform",
      seed: 101,
      bounds: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
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
              name: "Blue 80",
              strength: 80,
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
              name: "Red 20",
              strength: 20,
              weapon: "melee",
              anchor: { x: 145, y: 250 },
            },
          ],
        },
      ],
    });
    const start = deploy(scenario);
    const blueRange = mustRange(start, 0);
    const redRange = mustRange(start, 1);
    expect(blueRange[1] - blueRange[0]).toBe(80);

    const pool0 = checkpointPool(start);
    const filesWithRear = new Set<number>();
    for (let i = blueRange[0]; i < blueRange[1]; i++) {
      if ((pool0.rank[i] ?? 0) > 0) filesWithRear.add(pool0.file[i] ?? 0);
    }
    expect(filesWithRear.size).toBeGreaterThanOrEqual(4);
    const targetFiles = [...filesWithRear].slice(0, 3);

    // Kill 3 front-rank models in distinct files while their files still have rear-rank reserves.
    const damagedPool = checkpointPool(start);
    const killedFrontPositions = new Map<number, { x: number; y: number }>();
    for (let i = blueRange[0]; i < blueRange[1]; i++) {
      const f = damagedPool.file[i] ?? 0;
      if ((damagedPool.rank[i] ?? 0) === 0 && targetFiles.includes(f)) {
        killedFrontPositions.set(f, {
          x: damagedPool.x[i] ?? 0,
          y: damagedPool.y[i] ?? 0,
        });
        damagedPool.hp[i] = 0;
        damagedPool.status[i] =
          (damagedPool.status[i] ?? 0) | ModelStatus.dead;
      }
    }
    expect(killedFrontPositions.size).toBe(3);

    // Verify I2 effectiveFilePromotions promotes rank 1 -> targetRank 0 within each affected file.
    const promotions = effectiveFilePromotions(damagedPool, blueRange, 5);
    for (const f of targetFiles) {
      const promoted = promotions.find(
        (p) => p.file === f && p.currentRank === 1,
      );
      expect(promoted?.targetRank).toBe(0);
    }

    // Verify I3 unitFrontSaturation against an enemy line directly opposite the front rank.
    const enemyIndices = Array.from(
      { length: redRange[1] - redRange[0] },
      (_, k) => redRange[0] + k,
    );
    const preSat = unitFrontSaturation(
      damagedPool,
      blueRange,
      enemyIndices,
      60,
      5,
    );
    expect(preSat).toBeGreaterThan(0);

    const damagedState = repackPublished(start, damagedPool);
    const fileByModelId = new Map<number, number>();
    for (let i = blueRange[0]; i < blueRange[1]; i++) {
      fileByModelId.set(damagedPool.id[i] ?? i, damagedPool.file[i] ?? 0);
    }

    // Stationary { kind: "reform" } advances rear-rank survivors into the vacated front-rank cells with zero cross-file drift.
    const stationaryReform = resolveFrozen({
      turnId: 1,
      seed: 1,
      scenario,
      start: damagedState,
      orders: [
        { memberId: "cmd-blue", unitId: "u-blue", order: { kind: "reform" } },
      ],
    });
    const reformedPool = checkpointPool(stationaryReform.state);
    const reformedRange = mustRange(stationaryReform.state, 0);
    for (let i = reformedRange[0]; i < reformedRange[1]; i++) {
      expect(reformedPool.file[i]).toBe(
        fileByModelId.get(reformedPool.id[i] ?? -1),
      );
    }
    for (const [f, pos] of killedFrontPositions) {
      let filled = false;
      for (let i = reformedRange[0]; i < reformedRange[1]; i++) {
        if (((reformedPool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
        if (
          (reformedPool.file[i] ?? -1) === f &&
          Math.abs((reformedPool.x[i] ?? 0) - pos.x) < 0.5 &&
          Math.abs((reformedPool.y[i] ?? 0) - pos.y) < 0.5
        ) {
          filled = true;
          break;
        }
      }
      expect(filled).toBe(true);
    }

    // Advancing { kind: "move", pace: "march", reform: true } moves half-speed (10 ft) AND closes front-rank gaps!
    let firstAliveStart = -1;
    for (let i = blueRange[0]; i < blueRange[1]; i++) {
      if (((damagedPool.status[i] ?? 0) & ModelStatus.dead) === 0) {
        firstAliveStart = i;
        break;
      }
    }
    const leadId = damagedPool.id[firstAliveStart] ?? -1;
    const leadXBefore = damagedPool.x[firstAliveStart] ?? 0;
    const marchReform = resolveFrozen({
      turnId: 1,
      seed: 2,
      scenario,
      start: damagedState,
      orders: [
        {
          memberId: "cmd-blue",
          unitId: "u-blue",
          order: {
            kind: "move",
            pace: "march",
            reform: true,
            path: [
              {
                x: leadXBefore + 30,
                y: damagedPool.y[firstAliveStart] ?? 250,
              },
            ],
          },
        },
      ],
    });
    const marchedPool = checkpointPool(marchReform.state);
    const marchedRange = mustRange(marchReform.state, 0);
    let leadAfterIdx = -1;
    for (let i = marchedRange[0]; i < marchedRange[1]; i++) {
      if (marchedPool.id[i] === leadId) {
        leadAfterIdx = i;
        break;
      }
    }
    const unpromotedSurv = promotions.find(
      (p) => p.currentRank === 0 && !targetFiles.includes(p.file),
    );
    if (!unpromotedSurv) throw new Error("Missing unpromoted survivor");
    const unpromotedId = damagedPool.id[unpromotedSurv.modelIdx] ?? -1;
    const unpromotedXBefore = damagedPool.x[unpromotedSurv.modelIdx] ?? 0;
    let unpromotedAfterIdx = -1;
    for (let i = marchedRange[0]; i < marchedRange[1]; i++) {
      if (marchedPool.id[i] === unpromotedId) {
        unpromotedAfterIdx = i;
        break;
      }
    }
    expect(leadAfterIdx).toBeGreaterThanOrEqual(0);
    // infantry.move = 4 (20 ft); march + reform halves stride to 10 ft AND closes front-rank gaps!
    expect((marchedPool.x[unpromotedAfterIdx] ?? 0) - unpromotedXBefore).toBeCloseTo(
      10,
      5,
    );
    for (const [f, pos] of killedFrontPositions) {
      let filledAtAdvancedFront = false;
      for (let i = marchedRange[0]; i < marchedRange[1]; i++) {
        if (((marchedPool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
        if (
          (marchedPool.file[i] ?? -1) === f &&
          Math.abs((marchedPool.x[i] ?? 0) - (pos.x + 10)) < 0.5 &&
          Math.abs((marchedPool.y[i] ?? 0) - pos.y) < 0.5
        ) {
          filledAtAdvancedFront = true;
          break;
        }
      }
      expect(filledAtAdvancedFront).toBe(true);
    }

    // Direct check on applyFormationReform pure helper.
    const purePool = checkpointPool(damagedState);
    const pureRes = applyFormationReform({
      pool: purePool,
      range: blueRange,
      cellFeet: 5,
      stepBudgetFeet: 30,
      bounds: scenario.bounds,
    });
    expect(pureRes.reformedModels).toBeGreaterThanOrEqual(3);
  });

  test("I5: rotateToward clamps wheeling smoothly across the +-PI seam", () => {
    expect(Math.abs(normalizeAngle(Math.PI * 3))).toBeCloseTo(Math.PI, 6);
    const turned = rotateToward(Math.PI - 0.1, -Math.PI + 0.1, 0.15);
    expect(normalizeAngle(turned)).toBeCloseTo(-Math.PI + 0.05, 5);
    expect(rotateToward(0, 0.5, 1.0)).toBeCloseTo(0.5, 6);
  });

  test("C6/C13/C17/C18: 80-model perimeter envelopment wraps flanks and rear corners with zero cell collisions", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Cohort Envelopment",
      seed: 202,
      bounds: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
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
              name: "Blue Phalanx",
              strength: 80,
              weapon: "melee",
              anchor: { x: 200, y: 250 },
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red",
              name: "Red Detachment",
              strength: 4,
              weapon: "melee",
              anchor: { x: 205, y: 250 },
            },
          ],
        },
      ],
    });
    const start = deploy(scenario);
    const view = new BattleView(scenario, start, SECRET);
    expect(
      view.validate(blueMember, {
        unitId: "u-blue",
        order: {
          kind: "attack",
          targetUnitId: "u-red",
          mode: "melee",
          envelop: true,
        },
      }),
    ).toBeNull();

    const resolved = resolveFrozen({
      turnId: 1,
      seed: 202,
      scenario,
      start,
      orders: [
        {
          memberId: "cmd-blue",
          unitId: "u-blue",
          order: {
            kind: "attack",
            targetUnitId: "u-red",
            mode: "melee",
            envelop: true,
          },
        },
      ],
    });

    const resPool = checkpointPool(resolved.state);
    const occupiedCells = new Set<string>();
    let livingCount = 0;
    for (let i = 0; i < resPool.count; i++) {
      if (((resPool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
      livingCount++;
      const cell = `${Math.floor((resPool.x[i] ?? 0) / 5)},${Math.floor((resPool.y[i] ?? 0) / 5)}`;
      expect(occupiedCells.has(cell)).toBe(false);
      occupiedCells.add(cell);
    }
    expect(occupiedCells.size).toBe(livingCount);

    // Flank files wrapped forward along Red's flanks and behind Red's rear edge (C18)!
    const blueRange = mustRange(resolved.state, 0);
    const redRange = mustRange(start, 1);
    const startPool = checkpointPool(start);
    let redBackX = -Infinity;
    for (let i = redRange[0]; i < redRange[1]; i++) {
      redBackX = Math.max(redBackX, startPool.x[i] ?? 0);
    }
    let maxBlueX = -Infinity;
    for (let i = blueRange[0]; i < blueRange[1]; i++) {
      if (((resPool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
      maxBlueX = Math.max(maxBlueX, resPool.x[i] ?? 0);
    }
    expect(maxBlueX).toBeGreaterThanOrEqual(redBackX);

    // Wrapped flankers establish PF1e AoN 183 flanking (+2 AB / FLANKED bit) on surviving Red defenders.
    const resRedRange = resolved.state.units[1]?.range;
    if (resRedRange && resRedRange[1] > resRedRange[0]) {
      let anyFlanked = false;
      for (let i = resRedRange[0]; i < resRedRange[1]; i++) {
        if (((resPool.sys.pfCondition?.[i] ?? 0) & PF1eCondition.FLANKED) !== 0) {
          anyFlanked = true;
        }
      }
      expect(anyFlanked).toBe(true);
    }

    // Direct check on applyPerimeterEnvelopment rear-corner fold (C18).
    const purePool = checkpointPool(start);
    const envRes = applyPerimeterEnvelopment({
      pool: purePool,
      attackerRange: mustRange(start, 0),
      defenderRange: mustRange(start, 1),
      attackerAnchor: { x: 200, y: 250 },
      defenderAnchor: { x: 205, y: 250 },
      reachFt: 5,
      cellFeet: 5,
      quantize: true,
      bounds: scenario.bounds,
    });
    expect(envRes.wrapped).toBeGreaterThan(4);
  });

  test("C23b: straight-line formation charge validates geometry/hazards and delivers charge impact strike", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Cohort Charge",
      seed: 303,
      bounds: { minX: 0, minY: 0, maxX: 400, maxY: 400 },
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
              name: "Blue Lancers",
              strength: 12,
              weapon: "melee",
              anchor: { x: 100, y: 200 },
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
              strength: 12,
              weapon: "melee",
              anchor: { x: 145, y: 200 },
            },
          ],
        },
      ],
    });
    const start = deploy(scenario);
    const startPool = checkpointPool(start);
    const blueRange = mustRange(start, 0);
    const redRange = mustRange(start, 1);
    const leadX = startPool.x[blueRange[0]] ?? 0;
    const leadY = startPool.y[blueRange[0]] ?? 0;
    let minRedX = Infinity;
    for (let i = redRange[0]; i < redRange[1]; i++) {
      minRedX = Math.min(minRedX, startPool.x[i] ?? 0);
    }
    let maxBlueX = -Infinity;
    for (let i = blueRange[0]; i < blueRange[1]; i++) {
      maxBlueX = Math.max(maxBlueX, startPool.x[i] ?? 0);
    }

    const view = new BattleView(scenario, start, SECRET);

    // Too short (< 10 ft) is rejected by PF1e charge rules.
    expect(
      view.validate(blueMember, {
        unitId: "u-blue",
        order: {
          kind: "move",
          pace: "charge",
          path: [{ x: leadX + 5, y: leadY }],
        },
      }),
    ).toMatch(/10 ft|charge/i);

    // Spell hazard in the charge corridor blocks charging even if file 0 on the outer wing misses it!
    const hazardScenario: Scenario = {
      ...scenario,
      hazards: [
        {
          id: "entangle-1-u-red",
          spell: "entangle",
          at: { x: 120, y: 200 },
          radius: 15,
          dc: 13,
          casterLevel: 3,
          startsTurn: 0,
          expiresAfterTurn: 5,
        },
      ],
    };
    const hazardView = new BattleView(hazardScenario, start, SECRET);
    const chargeDelta = minRedX - 5 - maxBlueX;
    expect(chargeDelta).toBe(35);
    expect(
      hazardView.validate(blueMember, {
        unitId: "u-blue",
        order: {
          kind: "move",
          pace: "charge",
          path: [{ x: leadX + chargeDelta, y: leadY }],
        },
      }),
    ).toMatch(/difficult|charge|hazard/i);

    // Valid charge closes 35 ft (> 20 ft normal march), applies -2 AC (16 -> 14), and executes C23b impact attacks!
    expect(
      view.validate(blueMember, {
        unitId: "u-blue",
        order: {
          kind: "move",
          pace: "charge",
          path: [{ x: leadX + chargeDelta, y: leadY }],
        },
      }),
    ).toBeNull();

    const charged = resolveFrozen({
      turnId: 1,
      seed: 303,
      scenario,
      start,
      orders: [
        {
          memberId: "cmd-blue",
          unitId: "u-blue",
          order: {
            kind: "move",
            pace: "charge",
            path: [{ x: leadX + chargeDelta, y: leadY }],
          },
        },
      ],
    });
    const chargedPool = checkpointPool(charged.state);
    expect((chargedPool.x[blueRange[0]] ?? 0) - leadX).toBeCloseTo(35, 5);

    const chargedBlueRange = mustRange(charged.state, 0);
    expect(chargedPool.sys.ac?.[chargedBlueRange[0]]).toBe(14);

    const redRangeAfter = charged.state.units[1]?.range;
    let redHpAfter = 0;
    if (redRangeAfter) {
      for (let i = redRangeAfter[0]; i < redRangeAfter[1]; i++) {
        if (((chargedPool.status[i] ?? 0) & ModelStatus.dead) === 0) {
          redHpAfter += chargedPool.hp[i] ?? 0;
        }
      }
    }
    expect(redHpAfter).toBeLessThan(12 * 10);
  });

  test("heroOrders helpers format envelop, reform, and march+reform labels cleanly", () => {
    const nameOf = (id: string) => (id === "u-red" ? "Red Guard" : id);
    const atk = directAttackOrder("u-red", { envelop: true });
    expect(atk).toEqual({
      kind: "attack",
      targetUnitId: "u-red",
      envelop: true,
    });
    expect(orderLabel(atk, nameOf)).toBe("attack → Red Guard (envelop)");
    expect(
      orderLabel(
        {
          kind: "move",
          pace: "march",
          reform: true,
          path: [{ x: 50, y: 60 }],
        },
        nameOf,
      ),
    ).toBe("move → 1 wp (march, reform)");
    expect(
      orderLabel({ kind: "custom", type: "reform", data: null }, nameOf),
    ).toBe("reform front");
  });

  test("Two-tier wheeling (I5/C23b): wide formation wheels gradually on long oblique marches with outer-arc budget lag", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Oblique Wheel",
      seed: 404,
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
              name: "Blue Phalanx",
              strength: 10,
              weapon: "melee",
              anchor: { x: 100, y: 200 },
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red",
              name: "Red Watch",
              strength: 4,
              weapon: "melee",
              anchor: { x: 500, y: 500 },
            },
          ],
        },
      ],
    });
    const start = deploy(scenario);
    const startPool = checkpointPool(start);
    const leadX = startPool.x[0] ?? 100;
    const leadY = startPool.y[0] ?? 177.5;

    // Order a long 90-degree southward wheel (> 60 ft order distance)
    const turn1 = resolveFrozen({
      turnId: 1,
      seed: 404,
      scenario,
      start,
      orders: [
        {
          memberId: "cmd-blue",
          unitId: "u-blue",
          order: {
            kind: "move",
            pace: "march",
            path: [{ x: leadX, y: leadY + 120 }],
          },
        },
      ],
    });
    const p1 = checkpointPool(turn1.state);

    // Every soldier steps individually (NOT rigid translation: outer-arc file 0 at y=177.5
    // has to swing forward+right, whereas inner-pivot file 9 at y=222.5 swings backward+right;
    // their Δx displacements differ!).
    const dxFile0 = (p1.x[0] ?? 0) - (startPool.x[0] ?? 0);
    const dxFile9 = (p1.x[9] ?? 0) - (startPool.x[9] ?? 0);
    expect(Math.abs(dxFile0 - dxFile9)).toBeGreaterThan(2);

    // No model exceeds its 20-ft infantry march budget (with codec-2 1/16-ft quantization tolerance)
    for (let i = 0; i < 10; i++) {
      const dist = Math.hypot(
        (p1.x[i] ?? 0) - (startPool.x[i] ?? 0),
        (p1.y[i] ?? 0) - (startPool.y[i] ?? 0),
      );
      expect(dist).toBeLessThanOrEqual(20.15);
    }

    // All 10 living models settle in 10 distinct 5-ft squares (no cell stacking)
    const cells = new Set<string>();
    for (let i = 0; i < 10; i++) {
      cells.add(`${Math.floor((p1.x[i] ?? 0) / 5)},${Math.floor((p1.y[i] ?? 0) / 5)}`);
    }
    expect(cells.size).toBe(10);
  });

  test("Per-soldier doorway micro-steering: open-aligned files advance through a wall gap while flanked files steer through the doorway", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Doorway Breach",
      seed: 505,
      bounds: { minX: 0, minY: 0, maxX: 400, maxY: 400 },
      walls: [
        // Vertical wall at x = 110 with a 15-ft doorway gap from y = 192.5 to y = 207.5
        { id: "w-north", x1: 110, y1: 100, x2: 110, y2: 192.5, restriction: 1 },
        { id: "w-south", x1: 110, y1: 207.5, x2: 110, y2: 300, restriction: 1 },
      ],
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
              name: "Blue Assault",
              strength: 6,
              weapon: "melee",
              anchor: { x: 100, y: 200 },
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red",
              name: "Red Garrison",
              strength: 4,
              weapon: "melee",
              anchor: { x: 300, y: 200 },
            },
          ],
        },
      ],
    });
    const start = deploy(scenario);
    const startPool = checkpointPool(start);
    const leadY = startPool.y[0] ?? 187.5;

    const res = resolveFrozen({
      turnId: 1,
      seed: 505,
      scenario,
      start,
      orders: [
        {
          memberId: "cmd-blue",
          unitId: "u-blue",
          order: {
            kind: "move",
            pace: "march",
            path: [{ x: 140, y: leadY }],
          },
        },
      ],
    });
    const afterPool = checkpointPool(res.state);

    // Center files aligned with the y ∈ [192.5, 207.5] doorway pass cleanly past x = 110!
    // Under old rigid-block movement, a single wing hitting the wall clamped the ENTIRE unit short of x = 110.
    const xs = Array.from({ length: 6 }, (_, i) => afterPool.x[i] ?? 0);
    expect(xs.some((x) => x > 115)).toBe(true);
    // And even wing soldiers at y = 187.5 / y = 212.5 steer diagonally toward the doorway opening!
    expect(xs.filter((x) => x > 110).length).toBeGreaterThanOrEqual(3);
  });

  test("Breach sliding (C17b/C39) & wing-model AoO: unengaged flank files slide into enemy gaps under doctrine and wing movement provokes AoOs", () => {
    const pool = createModelPool(6, PF1E_MODEL_SCHEMA);
    // Unit 0 (Blue, 4 models in line at x = 0, y = 0, 5, 10, 15)
    for (let i = 0; i < 4; i++) {
      allocModel(pool, {
        id: i + 1,
        unitIdx: 0,
        x: 0,
        y: i * 5,
        hp: 20,
        hpMax: 20,
        file: i,
        rank: 0,
      });
    }
    // Unit 1 (Red, 1 defender at x = 20, y = 0 — facing only Blue file 0, leaving files 1..3 unopposed!)
    allocModel(pool, { id: 5, unitIdx: 1, x: 20, y: 0, hp: 30, hpMax: 30 });
    // Unit 2 (Red flank sentinel at x = 0, y = 20 — threatens (0, 15), which ONLY Blue wing model 3 starts in and leaves, NOT Blue's anchor at y = 0!)
    allocModel(pool, { id: 6, unitIdx: 2, x: 0, y: 20, hp: 30, hpMax: 30 });

    const units: UnitView[] = [
      {
        id: "u-blue",
        armyId: "a-blue",
        factionId: "blue",
        name: "Blue Line",
        type: "infantry",
        formation: "line",
        profile: {},
        orders: null,
        sceneId: "breach-aoo-test",
        leaderTokenId: null,
        envelop: true,
        stats: { bab: 6, ac: 16, strMod: 3 },
        modelRange: [0, 4],
      },
      {
        id: "u-red-main",
        armyId: "a-red",
        factionId: "red",
        name: "Red Center",
        type: "infantry",
        formation: "line",
        profile: {},
        orders: null,
        sceneId: "breach-aoo-test",
        leaderTokenId: null,
        stats: { bab: 6, ac: 16, strMod: 3 },
        modelRange: [4, 5],
      },
      {
        id: "u-red-wing",
        armyId: "a-red",
        factionId: "red",
        name: "Red Sentinel",
        type: "infantry",
        formation: "line",
        profile: {},
        orders: null,
        sceneId: "breach-aoo-test",
        leaderTokenId: null,
        stats: { bab: 8, ac: 16, strMod: 4 },
        modelRange: [5, 6],
      },
    ];

    const ctx: RulesContext = {
      sceneId: "breach-aoo-test",
      turnMode: "stepwise",
      grid: {
        type: "square",
        size: 100,
        units: "ft",
        distance: 5,
        diagonals: "555",
      },
      walls: {
        x1: new Float32Array(0),
        y1: new Float32Array(0),
        x2: new Float32Array(0),
        y2: new Float32Array(0),
        restriction: new Uint8Array(0),
      },
      terrain: { difficultCells: [] },
      armies: [],
      factions: [
        {
          _id: "blue",
          type: "faction",
          name: "Blue",
          color: "#0000ff",
          ownership: { default: 3 },
          flags: {},
          system: {},
          allies: [],
        },
        {
          _id: "red",
          type: "faction",
          name: "Red",
          color: "#ff0000",
          ownership: { default: 3 },
          flags: {},
          system: {},
          allies: [],
        },
      ],
      leaderActors: {},
      worldSettings: { strategicDoctrine: true },
    };

    const moveOrd = {
      kind: "move" as const,
      pace: "march" as const,
      path: [{ x: 15, y: 0 }],
    };
    const orders = new Map<string, OrderQueue>([
      [
        "u-blue",
        {
          issuedBy: "cmd-blue",
          issuedTurn: 1,
          pending: [moveOrd],
          active: moveOrd,
        },
      ],
    ]);

    const events: SimEvent[] = [];
    const mod = createMassBattlePf1e();
    mod.resolveTurn(ctx, pool, units, orders, new XoshiroPRNG(77), (ev) =>
      events.push(ev),
    );

    // 1. Wing AoO: Red Sentinel at (0, 20) only threatens y >= 15, which ONLY wing soldier #3
    //    walked out of (anchor soldier #0 walked along y = 0, 20 ft away!). Verify AoO fired!
    const aooEvents = events.filter(
      (e) => e.type === "opportunity" && e.unitId === "u-red-wing",
    );
    expect(aooEvents.length).toBe(1);

    // 2. Breach slide (C17b/C39): unopposed flank soldiers (#2 at y=10, #3 at y=15) slid
    //    laterally toward Red Center at (20, 0) (`y < startY`) instead of marching blindly straight!
    expect(pool.y[2] ?? 10).toBeLessThan(9.5);
  });
});
