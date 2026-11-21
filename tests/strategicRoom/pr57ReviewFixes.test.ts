import { createHash } from "node:crypto";
import { render } from "svelte/server";
import { describe, expect, test } from "vitest";
import type { SceneDocument } from "../../src/core/documents";
import { ModelStatus, type ModelPool } from "../../src/core/strategic";
import { DocumentStore } from "../../src/core/store";
import {
  sceneDeployment,
  withScenarioBackground,
} from "../../src/core/strategicRoom/campaignScene";
import { frozenEntangleAction } from "../../src/core/strategicRoom/pf1eActionProjection";
import { STRATEGIC_CODEC } from "../../src/core/strategicRoom/protocol";
import {
  parseScenario,
  type Scenario,
  type ScenarioBackground,
} from "../../src/core/strategicRoom/scenario";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA, PF1eCondition } from "../../src/packages/pf1e/schema";
import { applyUnitConditionsToStride } from "../../src/packages/pf1e/stride";
import {
  canonicalPoolHash,
  encodeSimSnapshot,
  snapshotFromPool,
} from "../../src/sim/codec";
import ActionCardView from "../../src/ui/chat/ActionCard.svelte";
import { BattleView } from "../../services/strategic-room/src/battle";
import { MarchReservation } from "../../services/strategic-room/src/marchReservation";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import { deploy, rulesInput } from "../../services/strategic-room/src/scenario";
import {
  buildGmMedia,
  extForMime,
} from "../../services/strategic-room/src/server";
import {
  checkpointPool,
  type Member,
  type Published,
} from "../../services/strategic-room/src/state";

const SECRET = new Uint8Array(32);

const gm: Member = {
  id: "gm",
  name: "GM",
  role: "GM",
  factionId: null,
  epoch: 1,
};

function player(id: string, factionId: string): Member {
  return { id, name: id, role: "PLAYER", factionId, epoch: 1 };
}

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

function unitCentroidX(state: Published, unitIdx: number): number {
  const pool = checkpointPool(state);
  const range = state.units[unitIdx]?.range ?? [0, 0];
  let sum = 0;
  let count = 0;
  for (let i = range[0]; i < range[1]; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
    sum += pool.x[i] ?? 0;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

describe("PR #57 review fixes (#1–#6)", () => {
  test("Fix #1: withScenarioBackground refreshes projection.digest so parseScenario accepts raster backgrounds and still rejects tampering", () => {
    const store = new DocumentStore({
      meta: {
        worldId: "world-1",
        name: "Campaign",
        system: "pf1e",
        systemVersion: "1.0.0",
      },
    });
    const scene: SceneDocument = {
      _id: "scene-1",
      type: "scene",
      active: true,
      img: "media/battlefield.png",
      darkness: 0,
      ownership: { default: 1 },
      system: {},
      tokens: [],
      walls: [],
      lights: [],
      sounds: [],
      tiles: [],
      drawings: [],
      templates: [],
      notes: [],
      name: "Ford of Bruinen",
      flags: { core: { scale: "strategic" } },
      width: 1000,
      height: 1000,
      grid: {
        type: "square",
        size: 20,
        units: "ft",
        distance: 5,
        diagonals: "555",
        hexLayout: "oddQ",
      },
    };
    const base = sceneDeployment(store, scene, 99, 2, 10);
    expect(base.projection).toBeDefined();

    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const background: ScenarioBackground = {
      hash: createHash("sha256").update(pngBytes).digest("hex"),
      mime: "image/png",
      size: pngBytes.byteLength,
      width: 1000,
      height: 1000,
      data: pngBytes.toString("base64url"),
    };

    // Naive spread leaves the pre-background digest stale and fails parseScenario.
    expect(() => parseScenario({ ...base, background })).toThrow(
      /projection digest does not match/,
    );

    const attached = withScenarioBackground(base, background);
    expect(attached.projection?.digest).not.toBe(base.projection?.digest);
    const parsed = parseScenario(attached);
    expect(parsed.background?.hash).toBe(background.hash);

    // Tampering after attachment is still caught by the refreshed projection digest.
    expect(() => parseScenario({ ...attached, name: "Tampered" })).toThrow(
      /projection digest does not match/,
    );
  });

  test("Fix #2: resolveFrozen routes OutcomeRow.memberId to the commander ID and enforces start.control unit allowlists", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Control Routing",
      seed: 12,
      bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
      factions: [
        { id: "blue", name: "Blue", color: "#5599ff" },
        { id: "red", name: "Red", color: "#ff6655" },
      ],
      commanders: [
        {
          id: "commander-1",
          factionId: "blue",
          units: [
            { id: "unit-1-1", name: "1st", strength: 4, weapon: "melee", anchor: { x: 40, y: 40 } },
            { id: "unit-1-2", name: "2nd", strength: 4, weapon: "melee", anchor: { x: 40, y: 100 } },
            { id: "unit-1-3", name: "3rd", strength: 4, weapon: "melee", anchor: { x: 40, y: 160 } },
          ],
        },
        {
          id: "commander-2",
          factionId: "red",
          units: [
            { id: "unit-2-1", name: "Red 1st", strength: 4, weapon: "melee", anchor: { x: 220, y: 100 } },
          ],
        },
      ],
    });
    const start = deploy(scenario);

    const unrestricted = resolveFrozen({
      turnId: 1,
      seed: 1,
      scenario,
      start: { ...start, control: {} },
      orders: [],
    });
    expect(
      unrestricted.rows
        .filter((o) => o.unitId.startsWith("unit-1-"))
        .map((o) => [o.unitId, o.memberId]),
    ).toEqual([
      ["unit-1-1", "commander-1"],
      ["unit-1-2", "commander-1"],
      ["unit-1-3", "commander-1"],
    ]);

    const restricted = resolveFrozen({
      turnId: 1,
      seed: 1,
      scenario,
      start: { ...start, control: { "commander-1": ["unit-1-1", "unit-1-3"] } },
      orders: [],
    });
    expect(
      restricted.rows
        .filter((o) => o.unitId.startsWith("unit-1-"))
        .map((o) => [o.unitId, o.memberId]),
    ).toEqual([
      ["unit-1-1", "commander-1"],
      ["unit-1-2", ""],
      ["unit-1-3", "commander-1"],
    ]);

    const stripped = resolveFrozen({
      turnId: 1,
      seed: 1,
      scenario,
      start: { ...start, control: { "commander-1": [] } },
      orders: [],
    });
    expect(
      stripped.rows
        .filter((o) => o.unitId.startsWith("unit-1-"))
        .every((o) => o.memberId === ""),
    ).toBe(true);
  });

  test("Fix #3: BattleView enforces sight walls on visibility, LoE orders, and persistent area/action fog-of-war", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Wall Fog",
      seed: 21,
      bounds: { minX: 0, minY: 0, maxX: 220, maxY: 200 },
      walls: [{ x1: 100, y1: 0, x2: 100, y2: 200, restriction: 3 }],
      actionCards: { playerCharacters: true, units: true, models: false },
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
              name: "Blue Guard",
              strength: 4,
              weapon: "shot",
              anchor: { x: 90, y: 100 },
              spellcasting: {
                actorId: "druid-b",
                itemId: "entangle-b",
                casterLevel: 5,
                castingAbilityMod: 3,
                entangleSlots: 1,
              },
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red",
              name: "Red Druids",
              strength: 4,
              weapon: "shot",
              anchor: { x: 110, y: 100 },
              spellcasting: {
                actorId: "druid-r",
                itemId: "entangle-r",
                casterLevel: 5,
                castingAbilityMod: 3,
                entangleSlots: 1,
              },
            },
          ],
        },
      ],
    });
    const blueMember = player("cmd-blue", "blue");
    const redMember = player("cmd-red", "red");
    const initial = deploy(scenario);
    const view0 = new BattleView(scenario, initial, SECRET);

    // Sight wall at x=100 blocks detection despite 120-ft distance being inside open-ground sight.
    expect(view0.markers(blueMember).map((m) => m.factionId)).toEqual(["blue"]);
    expect(view0.markers(gm).map((m) => m.factionId)).toEqual(["blue", "red"]);

    // Blue cannot cast or shoot through the sight wall.
    expect(
      view0.validate(blueMember, {
        unitId: "u-blue",
        order: {
          kind: "cast",
          spellId: "entangle",
          itemId: "entangle-b",
          origin: { x: 160, y: 100 },
        },
      }),
    ).toMatch(/No line of effect/);
    expect(
      view0.validate(blueMember, {
        unitId: "u-blue",
        order: { kind: "attack", targetUnitId: "u-red", mode: "shot" },
      }),
    ).toMatch(/not an available enemy/);

    // Red casts Entangle deep on Red's side of the opaque wall (x=160, radius=40 => [120..200], unseen by Blue).
    const afterHiddenCast = resolveFrozen({
      turnId: 1,
      seed: 11,
      scenario,
      start: initial,
      orders: [
        {
          memberId: "cmd-red",
          unitId: "u-red",
          order: {
            kind: "cast",
            spellId: "entangle",
            itemId: "entangle-r",
            origin: { x: 160, y: 100 },
          },
        },
      ],
    });
    const viewHidden = new BattleView(scenario, afterHiddenCast.state, SECRET);
    expect(viewHidden.areas(gm, 2)).toHaveLength(1);
    expect(viewHidden.areas(redMember, 2)).toHaveLength(1);
    expect(viewHidden.actions(redMember)).toHaveLength(1);
    expect(viewHidden.areas(blueMember, 2)).toEqual([]);
    expect(viewHidden.actions(blueMember)).toBeUndefined();

    // Without the wall, when Red casts within Blue's detected region, Blue sees both the area and action card.
    const { walls: _omittedWalls, ...openScenario } = scenario;
    void _omittedWalls;
    const openStart = deploy(openScenario);
    const afterVisibleCast = resolveFrozen({
      turnId: 1,
      seed: 12,
      scenario: openScenario,
      start: openStart,
      orders: [
        {
          memberId: "cmd-red",
          unitId: "u-red",
          order: {
            kind: "cast",
            spellId: "entangle",
            itemId: "entangle-r",
            origin: { x: 80, y: 100 },
          },
        },
      ],
    });
    const viewVisible = new BattleView(openScenario, afterVisibleCast.state, SECRET);
    expect(viewVisible.areas(blueMember, 2)).toHaveLength(1);
    expect(viewVisible.actions(blueMember)).toHaveLength(1);
  });

  test("Fix #4: unit.faction multi-company allegiance flips avoid split-brain in own(), unitFactions(), cohort visibility, and target validation", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Split Allegiance",
      seed: 33,
      bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
      factions: [
        { id: "blue", name: "Blue", color: "#5599ff" },
        { id: "red", name: "Red", color: "#ff6655" },
      ],
      commanders: [
        {
          id: "cmd-mixed",
          factionId: "blue",
          units: [
            {
              id: "u-loyal",
              name: "Loyal Blue",
              strength: 4,
              weapon: "shot",
              anchor: { x: 60, y: 80 },
            },
            {
              id: "u-defector",
              name: "Turncoat Red",
              factionId: "red",
              strength: 4,
              weapon: "shot",
              anchor: { x: 60, y: 105 },
            },
          ],
        },
        {
          id: "cmd-blue-ally",
          factionId: "blue",
          units: [
            {
              id: "u-blue-ally",
              name: "Blue Ally",
              strength: 4,
              weapon: "shot",
              anchor: { x: 85, y: 80 },
            },
          ],
        },
        {
          id: "cmd-red-ally",
          factionId: "red",
          units: [
            {
              id: "u-red-ally",
              name: "Red Ally",
              strength: 4,
              weapon: "shot",
              anchor: { x: 85, y: 105 },
            },
          ],
        },
      ],
    });
    const mixedMember = player("cmd-mixed", "blue");
    const view = new BattleView(scenario, deploy(scenario), SECRET);

    expect(view.own(mixedMember).map((u) => [u.id, u.factionId])).toEqual([
      ["u-loyal", "blue"],
      ["u-defector", "red"],
    ]);
    expect(view.unitFactions()).toEqual({
      "u-loyal": "blue",
      "u-defector": "red",
      "u-blue-ally": "blue",
      "u-red-ally": "red",
    });

    // Multi-faction cohort reveals units seen by both commanded factions without crashing.
    expect(view.markers(mixedMember)).toHaveLength(4);

    // Loyal Blue can target Red units (including its own commander's defector), not Blue allies.
    expect(
      view.validate(mixedMember, {
        unitId: "u-loyal",
        order: { kind: "attack", targetUnitId: "u-defector", mode: "shot" },
      }),
    ).toBeNull();
    expect(
      view.validate(mixedMember, {
        unitId: "u-loyal",
        order: { kind: "attack", targetUnitId: "u-blue-ally", mode: "shot" },
      }),
    ).toMatch(/not an available enemy/);

    // Turncoat Red can target Blue units, not Red allies.
    expect(
      view.validate(mixedMember, {
        unitId: "u-defector",
        order: { kind: "attack", targetUnitId: "u-loyal", mode: "shot" },
      }),
    ).toBeNull();
    expect(
      view.validate(mixedMember, {
        unitId: "u-defector",
        order: { kind: "attack", targetUnitId: "u-red-ally", mode: "shot" },
      }),
    ).toMatch(/not an available enemy/);
  });

  test("Fix #5: dead models with HAZARD_GRAPPLED/ENTANGLED do not block formations, while living conditions price once", () => {
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Hazard Parity",
      seed: 44,
      bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
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
              name: "Blue",
              strength: 4,
              weapon: "melee",
              anchor: { x: 50, y: 100 },
            },
          ],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "u-red",
              name: "Red",
              strength: 4,
              weapon: "melee",
              anchor: { x: 250, y: 100 },
            },
          ],
        },
      ],
    });
    const blueMember = player("cmd-blue", "blue");
    const baseState = deploy(scenario);
    const baseX = unitCentroidX(baseState, 0);

    // 1. Dead model with HAZARD_GRAPPLED | ENTANGLED does NOT immobilize or halve the living formation (infantry.move = 4 => 20 ft).
    const poolDead = checkpointPool(baseState);
    poolDead.hp[0] = 0;
    poolDead.status[0] = (poolDead.status[0] ?? 0) | ModelStatus.dead;
    if (!poolDead.sys.pfCondition) throw new Error("Missing pfCondition column");
    poolDead.sys.pfCondition[0] =
      PF1eCondition.HAZARD_GRAPPLED | PF1eCondition.ENTANGLED;
    const stateWithDeadCond = repackPublished(baseState, poolDead);
    const deadStartX = unitCentroidX(stateWithDeadCond, 0);
    const viewDead = new BattleView(scenario, stateWithDeadCond, SECRET);
    expect(
      viewDead.validate(blueMember, {
        unitId: "u-blue",
        order: { kind: "move", pace: "charge", path: [{ x: 80, y: 100 }] },
      }),
    ).toBeNull();
    const deadRes = resolveFrozen({
      turnId: 1,
      seed: 1,
      scenario,
      start: stateWithDeadCond,
      orders: [
        {
          memberId: "cmd-blue",
          unitId: "u-blue",
          order: {
            kind: "move",
            pace: "march",
            path: [{ x: (poolDead.x[1] ?? 0) + 30, y: poolDead.y[1] ?? 100 }],
          },
        },
      ],
    });
    expect(unitCentroidX(deadRes.state, 0) - deadStartX).toBeCloseTo(20, 5);

    // 2. Living model with ENTANGLED halves 20 ft -> 10 ft ONCE (no double-halving to 5 ft) and blocks charge/run.
    const poolEntangled = checkpointPool(baseState);
    if (!poolEntangled.sys.pfCondition) throw new Error("Missing pfCondition column");
    poolEntangled.sys.pfCondition[0] = PF1eCondition.ENTANGLED;
    const stateLivingEntangled = repackPublished(baseState, poolEntangled);
    const viewEntangled = new BattleView(scenario, stateLivingEntangled, SECRET);
    expect(
      viewEntangled.validate(blueMember, {
        unitId: "u-blue",
        order: { kind: "move", pace: "charge", path: [{ x: 80, y: 100 }] },
      }),
    ).toMatch(/entangled/i);
    const entangledUnitView = rulesInput(
      scenario,
      stateLivingEntangled.units,
    ).units[0];
    if (!entangledUnitView) throw new Error("Missing entangled unit view");
    expect(
      applyUnitConditionsToStride(
        {
          from: { x: 50, y: 100 },
          path: [{ x: 80, y: 100 }],
          pace: "run",
          movePoints: 4,
          cellFeet: 5,
        },
        poolEntangled,
        entangledUnitView,
      ).refusal,
    ).toMatch(/entangled/i);

    // Pinpoint hazard on model 0 sets ENTANGLED in resolveTurn without marking cell centers (c+0.5)*5 difficult.
    const pinpointEntangleScenario: Scenario = {
      ...scenario,
      hazards: [
        {
          id: "entangle-pinpoint",
          spell: "entangle",
          at: {
            x: poolEntangled.x[0] ?? 50,
            y: poolEntangled.y[0] ?? 92.5,
          },
          radius: 1,
          dc: 99,
          casterLevel: 5,
          startsTurn: 0,
          expiresAfterTurn: 5,
        },
      ],
    };
    const entangledRes = resolveFrozen({
      turnId: 1,
      seed: 1,
      scenario: pinpointEntangleScenario,
      start: stateLivingEntangled,
      orders: [
        {
          memberId: "cmd-blue",
          unitId: "u-blue",
          order: {
            kind: "move",
            pace: "march",
            path: [
              {
                x: (poolEntangled.x[0] ?? 0) + 30,
                y: poolEntangled.y[0] ?? 100,
              },
            ],
          },
        },
      ],
    });
    // 20 ft / 2 = 10 ft (2 cells), NOT 5 ft (1 cell) from double-halving.
    expect(unitCentroidX(entangledRes.state, 0) - baseX).toBeCloseTo(10, 5);

    // 3. Living model with HAZARD_GRAPPLED blocks move & reform in validation and MarchReservation.
    const poolGrappled = checkpointPool(baseState);
    if (!poolGrappled.sys.pfCondition) throw new Error("Missing pfCondition column");
    poolGrappled.sys.pfCondition[0] = PF1eCondition.HAZARD_GRAPPLED;
    const stateGrappled = repackPublished(baseState, poolGrappled);
    const viewGrappled = new BattleView(scenario, stateGrappled, SECRET);
    expect(
      viewGrappled.validate(blueMember, {
        unitId: "u-blue",
        order: { kind: "move", pace: "march", path: [{ x: 80, y: 100 }] },
      }),
    ).toMatch(/grapple/i);
    expect(
      viewGrappled.validate(blueMember, {
        unitId: "u-blue",
        order: { kind: "reform" },
      }),
    ).toMatch(/grapple/i);

    const reservation = new MarchReservation(scenario.bounds);
    const grappledInput = rulesInput(scenario, stateGrappled.units);
    const grappledPoolCheck = checkpointPool(stateGrappled);
    const grappledUnitView = grappledInput.units[0];
    if (!grappledUnitView) throw new Error("Missing grappled unit view");
    const planned = reservation.plan(
      {
        from: { x: grappledPoolCheck.x[0] ?? 0, y: grappledPoolCheck.y[0] ?? 0 },
        path: [{ x: 80, y: 100 }],
        pace: "march",
        movePoints: 6,
        cellFeet: 5,
      },
      grappledPoolCheck,
      grappledUnitView,
    );
    expect(planned.traveled).toBe(0);
    expect(planned.refusal).toMatch(/grapple/i);

    expect(createMassBattlePf1e()).toBeDefined();
  });

  test("Fix #6: ActionCard renders 'resolved' when save total is redacted and GM media excludes background with accurate extensions", () => {
    const card = frozenEntangleAction({
      actionId: "entangle-1-u-red",
      sceneId: "scene-1",
      actorId: "druid-r",
      itemId: "entangle-r",
      unitId: "u-red",
      originFeet: { x: 100, y: 100 },
      saveDc: 14,
      startsTurn: 1,
      casterLevel: 5,
      casterFactionId: "red",
    });
    const resolvedHtml = render(ActionCardView, {
      props: { action: card },
    }).body;
    expect(resolvedHtml).toContain("data-action-resolved");
    expect(resolvedHtml).toContain(">resolved<");
    expect(resolvedHtml).not.toContain("awaiting roll");

    const pendingCard = {
      ...card,
      targets: card.targets?.map((t) => ({
        ...t,
        check: t.check ? { ...t.check, status: "pending" as const } : undefined,
      })),
    };
    const pendingHtml = render(ActionCardView, {
      props: { action: pendingCard },
    }).body;
    expect(pendingHtml).toContain("awaiting roll");

    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/webp")).toBe("webp");
    expect(extForMime("image/gif")).toBe("gif");

    const bgHash = "a".repeat(64);
    const otherHash = "b".repeat(64);
    const gmMedia = buildGmMedia(
      [
        { hash: bgHash, data: new Uint8Array([1, 2, 3]), mime: "image/png" },
        { hash: otherHash, data: new Uint8Array([4, 5]), mime: "image/jpeg" },
      ],
      bgHash,
    );
    expect(gmMedia).toEqual([
      {
        hash: otherHash,
        name: `scene-${otherHash.slice(0, 12)}.jpg`,
        mime: "image/jpeg",
        size: 2,
        url: `api/strategic/scene/${otherHash}.jpg`,
      },
    ]);
  });
});
