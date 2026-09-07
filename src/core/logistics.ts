/**
 * §4A & §10 & §12 Logistics data model, forecasting engine, and upkeep calculations.
 * Manages Supply Depots, Supply Routes, Reinforcement Queues, and Attrition forecasts.
 */
import type { BaseDocument } from "./documents";
import type { DocId } from "./ids";
import type { ArmyDocument, Vec2 } from "./strategic";

export interface DepotDocument extends BaseDocument {
  type: "depot";
  factionId: DocId;
  sceneId: DocId | null;
  location: Vec2;
  capacity: number;
  currentSupply: number;
  upkeepCost: number;
}

export interface RouteDocument extends BaseDocument {
  type: "route";
  fromDepotId: DocId;
  toTargetId: DocId; // Army ID or Unit ID or target location
  throughput: number;
  status: "active" | "disrupted" | "severed";
}

export interface ReinforcementDocument extends BaseDocument {
  type: "reinforcement";
  factionId: DocId;
  armyId: DocId;
  unitType: string;
  unitName: string;
  strength: number;
  turnsRemaining: number;
}

export interface FactionLogisticsForecast {
  factionId: DocId;
  totalSupplyAvailable: number;
  totalSupplyRequired: number;
  netSupplyChange: number;
  unitsAtRisk: number; // units with supply = 0
  arrivingReinforcementsCount: number;
  totalUpkeepCost: number;
  warnings: string[];
}

export interface LogisticsForecast {
  factions: Record<DocId, FactionLogisticsForecast>;
  totalDepots: number;
  totalActiveRoutes: number;
  pendingReinforcements: number;
}

/**
 * Default pure client-side logistics forecast (§12 RulesModule.forecast fallback).
 */
export function calculateLogisticsForecast(
  armies: readonly ArmyDocument[],
  depots: readonly DepotDocument[],
  routes: readonly RouteDocument[],
  reinforcements: readonly ReinforcementDocument[],
): LogisticsForecast {
  const factionMap: Record<DocId, FactionLogisticsForecast> = {};

  const getFaction = (fid: DocId): FactionLogisticsForecast => {
    let existing = factionMap[fid];
    if (!existing) {
      existing = {
        factionId: fid,
        totalSupplyAvailable: 0,
        totalSupplyRequired: 0,
        netSupplyChange: 0,
        unitsAtRisk: 0,
        arrivingReinforcementsCount: 0,
        totalUpkeepCost: 0,
        warnings: [],
      };
      factionMap[fid] = existing;
    }
    return existing;
  };

  // Depots supply & upkeep
  for (const depot of depots) {
    const fc = getFaction(depot.factionId);
    fc.totalSupplyAvailable += depot.currentSupply;
    fc.totalUpkeepCost += depot.upkeepCost ?? 0;
  }

  // Armies consumption
  for (const army of armies) {
    const fc = getFaction(army.factionId);
    let armyDemand = 0;
    for (const u of army.units) {
      const uDemand = Math.ceil((u.stats.strength ?? 0) / 10);
      armyDemand += uDemand;
      if ((u.stats.supply ?? 0) <= 0) {
        fc.unitsAtRisk++;
      }
    }
    fc.totalSupplyRequired += armyDemand;
  }

  // Reinforcements
  for (const r of reinforcements) {
    const fc = getFaction(r.factionId);
    if (r.turnsRemaining <= 1) {
      fc.arrivingReinforcementsCount += r.strength;
    }
  }

  // Summary per faction
  for (const fid of Object.keys(factionMap)) {
    const fc = factionMap[fid];
    if (!fc) continue;
    fc.netSupplyChange = fc.totalSupplyAvailable - fc.totalSupplyRequired;
    if (fc.totalSupplyAvailable < fc.totalSupplyRequired) {
      fc.warnings.push(
        `Supply deficit of ${fc.totalSupplyRequired - fc.totalSupplyAvailable} units!`,
      );
    }
    if (fc.unitsAtRisk > 0) {
      fc.warnings.push(`${fc.unitsAtRisk} unit(s) are out of supply and face attrition!`);
    }
  }

  const totalActiveRoutes = routes.filter((r) => r.status === "active").length;

  return {
    factions: factionMap,
    totalDepots: depots.length,
    totalActiveRoutes,
    pendingReinforcements: reinforcements.length,
  };
}
