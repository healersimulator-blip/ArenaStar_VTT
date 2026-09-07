import { describe, expect, it } from "vitest";
import {
  calculateLogisticsForecast,
  type DepotDocument,
  type ReinforcementDocument,
  type RouteDocument,
} from "../../src/core/logistics";
import type { ArmyDocument } from "../../src/core/strategic";

describe("Logistics & Attrition Forecast (§10, §12)", () => {
  it("calculates supply balance, attrition risk, and upkeep costs", () => {
    const armies: ArmyDocument[] = [
      {
        _id: "army-1",
        type: "army",
        name: "1st Legion",
        factionId: "f1",
        ownership: { default: 3 },
        flags: {},
        system: {},
        commander: [],
        supply: {},
        units: [
          {
            _id: "u1",
            type: "infantry",
            name: "Vanguard",
            ownership: { default: 3 },
            flags: {},
            system: {},
            profile: {},
            formation: "line",
            sceneId: "scene-1",
            modelRange: [0, 20],
            orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
            stats: { strength: 20, morale: 5, supply: 0, fatigue: 0 }, // 0 supply -> attrition risk
          },
        ],
      },
    ];

    const depots: DepotDocument[] = [
      {
        _id: "depot-1",
        type: "depot",
        name: "Central Supply Hub",
        factionId: "f1",
        sceneId: "scene-1",
        location: { x: 100, y: 100 },
        capacity: 100,
        currentSupply: 50,
        upkeepCost: 10,
        ownership: { default: 3 },
        flags: {},
        system: {},
      },
    ];

    const routes: RouteDocument[] = [
      {
        _id: "route-1",
        type: "route",
        name: "North Supply Line",
        fromDepotId: "depot-1",
        toTargetId: "army-1",
        throughput: 20,
        status: "active",
        ownership: { default: 3 },
        flags: {},
        system: {},
      },
    ];

    const reinforcements: ReinforcementDocument[] = [
      {
        _id: "reinf-1",
        type: "reinforcement",
        name: "Fresh Recruits",
        factionId: "f1",
        armyId: "army-1",
        unitType: "infantry",
        unitName: "Fresh Recruits",
        strength: 30,
        turnsRemaining: 1,
        ownership: { default: 3 },
        flags: {},
        system: {},
      },
    ];

    const forecast = calculateLogisticsForecast(armies, depots, routes, reinforcements);

    expect(forecast.totalDepots).toBe(1);
    expect(forecast.totalActiveRoutes).toBe(1);
    expect(forecast.pendingReinforcements).toBe(1);

    const f1 = forecast.factions["f1"];
    expect(f1).toBeDefined();
    if (f1) {
      expect(f1.totalSupplyAvailable).toBe(50);
      expect(f1.totalSupplyRequired).toBe(2); // 20 models / 10 = 2
      expect(f1.unitsAtRisk).toBe(1);
      expect(f1.arrivingReinforcementsCount).toBe(30);
      expect(f1.totalUpkeepCost).toBe(10);
      expect(f1.warnings.some((w) => w.includes("attrition"))).toBe(true);
    }
  });
});
