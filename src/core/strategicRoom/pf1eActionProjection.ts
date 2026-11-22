import type { ActionCard } from "../action";
import type { SpellHazard } from "./hazardAvoidance";
import type { Point, ReadyResponse, ReadyTrigger, StrategicItemEffect, StrategicSpellId } from "./protocol";

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

export type FrozenSpellHazardInput = FrozenEntangleCastInput & {
  spellId: "entangle" | "burning-entanglement" | "black-tentacles";
};

const HAZARD_META: Readonly<
  Record<
    "entangle" | "burning-entanglement" | "black-tentacles",
    {
      label: string;
      hazardSpell: SpellHazard["spell"];
      radius: number;
      roundsPerLevel: number;
      hasReflexSave: boolean;
    }
  >
> = Object.freeze({
  entangle: {
    label: "Entangle",
    hazardSpell: "entangle",
    radius: 40,
    roundsPerLevel: 10,
    hasReflexSave: true,
  },
  "burning-entanglement": {
    label: "Burning Entanglement",
    hazardSpell: "burningEntanglement",
    radius: 40,
    roundsPerLevel: 10,
    hasReflexSave: true,
  },
  "black-tentacles": {
    label: "Black Tentacles",
    hazardSpell: "blackTentacles",
    radius: 20,
    roundsPerLevel: 1,
    hasReflexSave: false,
  },
});

/** Build the regular data-only action evidence used by both tactical presentation and projection. */
export function frozenEntangleAction(input: FrozenEntangleCastInput): ActionCard {
  return frozenSpellHazardAction({ ...input, spellId: "entangle" });
}

export function frozenSpellHazardAction(input: FrozenSpellHazardInput): ActionCard {
  const meta = HAZARD_META[input.spellId];
  return {
    v: 2,
    id: input.actionId,
    revision: 0,
    kind: "cast",
    label: meta.label,
    state: "resolved",
    source: { name: input.unitId, actorId: input.actorId, itemId: input.itemId },
    sceneId: input.sceneId,
    area: {
      sceneId: input.sceneId,
      shape: "spread",
      origin: { ...input.originFeet },
      radius: meta.radius,
      units: "ft",
    },
    targets: [
      {
        key: `${input.unitId}-area`,
        name: `${meta.label} area`,
        state: "resolved",
        outcome: "affected",
        provenance: "host",
        ...(meta.hasReflexSave
          ? {
              check: {
                kind: "save",
                status: "resolved",
                formula: `PF1e ${meta.label} Reflex`,
                dc: input.saveDc,
                total: null,
                saveType: "ref",
              },
            }
          : {}),
      },
    ],
    notes: [`Caster level ${input.casterLevel}`],
    createdAt: input.startsTurn,
    updatedAt: input.startsTurn,
  };
}

/**
 * Route a frozen hosted cast through the same ActionCard adapter as ordinary PF1e play.
 * The frozen scenario coordinates are feet and the area origin is already in feet, so the
 * grid is explicit (and overridable) here rather than hardcoded; the caller that knows the
 * frozen scene's scale should pass its own.
 */
export function projectFrozenEntangleCast(
  input: FrozenEntangleCastInput,
  grid: StrategicSceneScale = { size: 1, distance: 1, units: "ft" },
): SpellHazard {
  return projectEntangleAction({
    action: frozenEntangleAction(input),
    grid,
    startsTurn: input.startsTurn,
    casterLevel: input.casterLevel,
    casterFactionId: input.casterFactionId,
  });
}

export function projectSpellHazardAction(input: EntangleProjectionInput): SpellHazard {
  const { action, grid } = input;
  const labelKey = action.label.trim().toLowerCase();
  const spellId =
    labelKey === "entangle"
      ? "entangle"
      : labelKey === "burning entanglement"
        ? "burning-entanglement"
        : labelKey === "black tentacles"
          ? "black-tentacles"
          : null;
  if (!spellId)
    throw new Error("Only a resolved, host-verified regular PF1e Entangle, Burning Entanglement, or Black Tentacles area can be projected.");
  const meta = HAZARD_META[spellId];
  if (
    action.kind !== "cast" ||
    action.state !== "resolved" ||
    !action.source.actorId ||
    !action.sceneId ||
    !action.area ||
    action.area.sceneId !== action.sceneId ||
    action.area.shape !== "spread" ||
    action.area.radius !== meta.radius ||
    action.area.units !== "ft" ||
    grid.units.trim().toLowerCase() !== "ft" ||
    !Number.isFinite(grid.size) ||
    grid.size <= 0 ||
    !Number.isFinite(grid.distance) ||
    grid.distance <= 0 ||
    !Number.isInteger(input.startsTurn) ||
    input.startsTurn < 0 ||
    !Number.isInteger(input.casterLevel) ||
    input.casterLevel < 1 ||
    input.casterLevel > 100 ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(input.casterFactionId)
  )
    throw new Error(`Only a resolved, host-verified regular PF1e ${meta.label} area can be projected.`);

  let dc: number | undefined;
  if (meta.hasReflexSave) {
    const saveDcs = action.targets.flatMap((target) =>
      target.provenance === "host" &&
      target.check?.kind === "save" &&
      target.check.saveType === "ref" &&
      target.check.dc !== null
        ? [target.check.dc]
        : [],
    );
    dc = saveDcs[0];
    if (dc === undefined || saveDcs.some((candidate) => candidate !== dc))
      throw new Error(`${meta.label} projection requires one host-verified Reflex DC for the cast.`);
  }
  const feetPerPixel = grid.distance / grid.size;
  return {
    id: action.id,
    spell: meta.hazardSpell,
    at: { x: action.area.origin.x * feetPerPixel, y: action.area.origin.y * feetPerPixel },
    radius: action.area.radius,
    startsTurn: input.startsTurn,
    expiresAfterTurn: input.startsTurn + input.casterLevel * meta.roundsPerLevel - 1,
    ...(dc !== undefined ? { dc } : {}),
    casterLevel: input.casterLevel,
    casterFactionId: input.casterFactionId,
  };
}

/**
 * Adapt the ordinary host-verified PF1e Entangle action into its dense frozen representation.
 * This deliberately consumes ActionCard/ActionArea rather than defining a second strategic cast.
 */
export function projectEntangleAction(input: EntangleProjectionInput): SpellHazard {
  if (input.action.label.trim().toLowerCase() !== "entangle")
    throw new Error("Only a resolved, host-verified regular PF1e Entangle area can be projected.");
  return projectSpellHazardAction(input);
}

/** Build a resolved ActionCard for a pack-driven PF1e area spell (`fireball`, `burning-hands`, `lightning-bolt`, `cone-of-cold`). */
export function frozenBlastSpellAction(input: {
  actionId: string;
  sceneId: string;
  actorId: string;
  itemId: string;
  unitId: string;
  spellId: StrategicSpellId;
  label: string;
  shape: "circle" | "cone" | "line";
  originFeet: Point;
  radiusFeet: number;
  saveDc: number;
  turnId: number;
  targeted: number;
  damageDealt: number;
  kills: number;
}): ActionCard {
  const areaShape = input.shape === "circle" ? "spread" : input.shape;
  return {
    v: 2,
    id: input.actionId,
    revision: 0,
    kind: "cast",
    label: input.label,
    state: "resolved",
    source: { name: input.unitId, actorId: input.actorId, itemId: input.itemId },
    sceneId: input.sceneId,
    area: {
      sceneId: input.sceneId,
      shape: areaShape,
      origin: { ...input.originFeet },
      radius: input.radiusFeet,
      units: "ft",
    },
    targets: [
      {
        key: `${input.unitId}-${input.spellId}`,
        name: `${input.targeted} model(s) in area`,
        state: "resolved",
        outcome: input.targeted > 0 ? "affected" : "miss",
        provenance: "host",
        check: {
          kind: "save",
          status: "resolved",
          formula: `PF1e ${input.label} Reflex`,
          dc: input.saveDc,
          total: null,
          saveType: "ref",
        },
      },
    ],
    notes: [
      `Damage dealt: ${input.damageDealt} HP · Casualties: ${input.kills}`,
    ],
    createdAt: input.turnId,
    updatedAt: input.turnId,
  };
}

export function frozenItemUseAction(input: {
  actionId: string;
  sceneId: string;
  actorId?: string;
  itemId: string;
  itemName: string;
  unitId: string;
  targetUnitName: string;
  effect: StrategicItemEffect;
  summary: string;
  turnId: number;
}): ActionCard {
  return {
    v: 2,
    id: input.actionId,
    revision: 0,
    kind: "item",
    label: input.itemName,
    state: "resolved",
    source: {
      name: input.unitId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      itemId: input.itemId,
    },
    sceneId: input.sceneId,
    targets: [
      {
        key: input.targetUnitName,
        name: input.targetUnitName,
        state: "resolved",
        outcome: "affected",
        provenance: "host",
      },
    ],
    notes: [input.summary],
    createdAt: input.turnId,
    updatedAt: input.turnId,
  };
}

export function frozenReactionAction(input: {
  actionId: string;
  sceneId: string;
  unitId: string;
  unitName: string;
  trigger: ReadyTrigger;
  response: ReadyResponse;
  targetName: string;
  summary: string;
  turnId: number;
}): ActionCard {
  return {
    v: 2,
    id: input.actionId,
    revision: 0,
    kind: "ability",
    label: `Readied ${input.response} (${input.trigger})`,
    state: "resolved",
    source: { name: input.unitName },
    sceneId: input.sceneId,
    targets: [
      {
        key: input.targetName,
        name: input.targetName,
        state: "resolved",
        outcome: "affected",
        provenance: "host",
      },
    ],
    notes: [input.summary],
    createdAt: input.turnId,
    updatedAt: input.turnId,
  };
}
