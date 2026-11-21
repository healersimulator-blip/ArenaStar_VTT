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
});
