import type { RulesWallsContext, UnitView } from "../core/rules";
import type { ArmyDocument, UnitDocument } from "../core/strategic";

/** Stable slot order is the army order followed by each army's unit order. */
export function unitViewFor(army: ArmyDocument, unit: UnitDocument): UnitView {
  return {
    id: unit._id,
    armyId: army._id,
    factionId: army.factionId,
    type: unit.type,
    name: unit.name,
    profile: unit.profile,
    stats: { ...unit.stats },
    orders: unit.orders,
    formation: unit.formation,
    sceneId: unit.sceneId ?? null,
    modelRange: unit.modelRange,
    leaderTokenId: unit.leaderTokenId ?? null,
    squadId: unit.squadId ?? null,
    doctrine: unit.doctrine ?? null,
    envelop: unit.envelop ?? null,
    armyInitiative:
      typeof army.initiative === "number" && Number.isFinite(army.initiative)
        ? army.initiative
        : null,
  };
}

export function emptyRulesWalls(): RulesWallsContext {
  return {
    x1: new Float32Array(),
    y1: new Float32Array(),
    x2: new Float32Array(),
    y2: new Float32Array(),
    restriction: new Uint8Array(),
  };
}
