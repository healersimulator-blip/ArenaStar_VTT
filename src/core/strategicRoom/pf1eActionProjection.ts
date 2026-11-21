import type { ActionCard } from "../action";
import type { SpellHazard } from "./hazardAvoidance";

export type StrategicSceneScale = {
  size: number;
  distance: number;
  units: string;
};

export type FrozenEntangleCastInput = {
  actionId: string;
  sceneId: string;
  actorId: string;
  itemId: string;
  unitId: string;
  originFeet: { x: number; y: number };
  saveDc: number;
  startsTurn: number;
  casterLevel: number;
  casterFactionId: string;
};

export type EntangleProjectionInput = {
  action: ActionCard;
  grid: StrategicSceneScale;
  startsTurn: number;
  casterLevel: number;
  casterFactionId: string;
};

/** Build the regular data-only action evidence used by both tactical presentation and projection. */
export function frozenEntangleAction(input: FrozenEntangleCastInput): ActionCard {
  return {
    v: 2,
    id: input.actionId,
    revision: 0,
    kind: "cast",
    label: "Entangle",
    state: "resolved",
    source: { name: input.unitId, actorId: input.actorId, itemId: input.itemId },
    sceneId: input.sceneId,
    area: { sceneId: input.sceneId, shape: "spread", origin: { ...input.originFeet },
      radius: 40, units: "ft" },
    targets: [{ key: `${input.unitId}-area`, name: "Entangle area", state: "resolved",
      outcome: "affected", provenance: "host", check: { kind: "save", status: "resolved",
        formula: "PF1e Entangle Reflex", dc: input.saveDc, total: null, saveType: "ref" } }],
    notes: [],
    createdAt: input.startsTurn,
    updatedAt: input.startsTurn,
  };
}

/** Route a frozen hosted cast through the same ActionCard adapter as ordinary PF1e play. */
export function projectFrozenEntangleCast(input: FrozenEntangleCastInput): SpellHazard {
  return projectEntangleAction({ action: frozenEntangleAction(input),
    grid: { size: 5, distance: 5, units: "ft" }, startsTurn: input.startsTurn,
    casterLevel: input.casterLevel, casterFactionId: input.casterFactionId });
}

/**
 * Adapt the ordinary host-verified PF1e Entangle action into its dense frozen representation.
 * This deliberately consumes ActionCard/ActionArea rather than defining a second strategic cast.
 */
export function projectEntangleAction(input: EntangleProjectionInput): SpellHazard {
  const { action, grid } = input;
  if (action.kind !== "cast" || action.label.trim().toLowerCase() !== "entangle" ||
    action.state !== "resolved" || !action.source.actorId || !action.sceneId ||
    !action.area || action.area.sceneId !== action.sceneId || action.area.shape !== "spread" ||
    action.area.radius !== 40 || action.area.units !== "ft" ||
    grid.units.trim().toLowerCase() !== "ft" || !Number.isFinite(grid.size) || grid.size <= 0 ||
    !Number.isFinite(grid.distance) || grid.distance !== 5 ||
    !Number.isInteger(input.startsTurn) || input.startsTurn < 0 ||
    !Number.isInteger(input.casterLevel) || input.casterLevel < 1 || input.casterLevel > 100 ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(input.casterFactionId))
    throw new Error("Only a resolved, host-verified regular PF1e Entangle area can be projected.");
  const saveDcs = action.targets.flatMap((target) =>
    target.provenance === "host" && target.check?.kind === "save" &&
      target.check.saveType === "ref" && target.check.dc !== null
      ? [target.check.dc] : []);
  const dc = saveDcs[0];
  if (dc === undefined || saveDcs.some((candidate) => candidate !== dc))
    throw new Error("Entangle projection requires one host-verified Reflex DC for the cast.");
  const feetPerPixel = grid.distance / grid.size;
  return {
    id: action.id,
    spell: "entangle",
    at: { x: action.area.origin.x * feetPerPixel, y: action.area.origin.y * feetPerPixel },
    radius: action.area.radius,
    startsTurn: input.startsTurn,
    // PF1e duration: 1 minute/level = 10 rounds per caster level, inclusive turn interval.
    expiresAfterTurn: input.startsTurn + input.casterLevel * 10 - 1,
    dc,
    casterLevel: input.casterLevel,
    casterFactionId: input.casterFactionId,
  };
}
