import type { RulesContext } from "../../../src/core/rules";
import type {
  ArmyDocument,
  FactionDocument,
  UnitStats,
} from "../../../src/core/strategic";
import {
  integer,
  STRATEGIC_CODEC,
} from "../../../src/core/strategicRoom/protocol";
import { deploySnapshot } from "../../../src/sim/deploy";
import { canonicalPoolHash } from "../../../src/sim/codec";
import { unitViewFor } from "../../../src/sim/turnPlan";
import { PF1E_MODEL_SCHEMA } from "../../../src/packages/pf1e/schema";
import { checkpointPool, type Published } from "./state";

import {
  CELL_FEET,
  MAX_MODELS,
  MAX_COMMANDERS,
  inBounds,
  parseScenario,
  type Scenario,
  type ScenarioUnit,
} from "../../../src/core/strategicRoom/scenario";
export * from "../../../src/core/strategicRoom/scenario";
const SCENE = "battlefield";
export type UnitState = { range: [number, number] | null; stats: UnitStats };
function initialStats(unit: ScenarioUnit): UnitStats {
  return {
    strength: unit.strength,
    morale: 10,
    supply: 5,
    fatigue: 0,
    bab: 6,
    strMod: 3,
    ac: 16,
    touchAc: 11,
    hp: 10,
    fort: 5,
    ref: 4,
    will: 3,
    damageDiceCount: 1,
    damageDiceSides: 8,
    damageMod: 3,
    ...(unit.spellcasting ? {
      casterLevel: unit.spellcasting.casterLevel,
      castingAbilityMod: unit.spellcasting.castingAbilityMod,
      entangleSlots: unit.spellcasting.entangleSlots,
    } : {}),
    ...(unit.weapon === "shot"
      ? { weaponIsRanged: 1, weaponRangeIncrement: 60, weaponMaxIncrements: 10 }
      : {}),
  };
}

export function rulesInput(scenario: Scenario, state: readonly UnitState[]) {
  const factions: FactionDocument[] = scenario.factions.map(
    ({ id, name, color }) => ({
      _id: id,
      name,
      color,
      type: "faction",
      ownership: { default: 0 },
      flags: {},
      system: {},
      allies: [],
    }),
  );
  let i = 0;
  // One simulation army per unit permits a GM to change one company's allegiance without
  // changing its seat or grants. The commander ID remains the authority boundary.
  const armies: ArmyDocument[] = scenario.commanders.flatMap((c) => c.units.map((u) => {
    const own = state[i++];
    if (!own) throw new Error("Missing committed unit state.");
    return {
      _id: `${c.id}-${u.id}`,
      type: "army",
      name: c.id,
      factionId: u.factionId ?? c.factionId,
      commander: [c.id],
      supply: {},
      ownership: { default: 0, [c.id]: 3 },
      flags: {},
      system: {},
      units: [{
        _id: u.id,
        type: "infantry",
        name: u.name,
        ownership: { default: 0 },
        flags: {},
        system: {},
        profile: { anchor: u.anchor },
        stats: own.stats,
        orders: { pending: [], issuedBy: c.id, issuedTurn: 0 },
        formation: "line",
        sceneId: SCENE,
        modelRange: own.range,
        envelop: false,
      }],
    };
  }));
  const units = armies.flatMap((a) => a.units.map((u) => unitViewFor(a, u)));
  const projectedWalls = scenario.walls ?? [];
  const ctx: RulesContext = {
    sceneId: SCENE,
    grid: {
      type: "square",
      size: 100,
      distance: CELL_FEET,
      units: "ft",
      diagonals: "555",
    },
    walls: {
      x1: Float32Array.from(projectedWalls, (wall) => wall.x1),
      y1: Float32Array.from(projectedWalls, (wall) => wall.y1),
      x2: Float32Array.from(projectedWalls, (wall) => wall.x2),
      y2: Float32Array.from(projectedWalls, (wall) => wall.y2),
      restriction: Uint8Array.from(projectedWalls, (wall) => wall.restriction),
    },
    ...(scenario.terrain ? { terrain: scenario.terrain } : {}),
    factions,
    armies,
    leaderActors: {},
    worldSettings: {},
    turnMode: "simultaneous",
  };
  return { ctx, armies, units };
}

export function deploy(scenario: Scenario): Published {
  const units = scenario.commanders.flatMap((c) =>
    c.units.map((u): UnitState => ({ range: null, stats: initialStats(u) })),
  );
  const input = rulesInput(scenario, units);
  const { bytes, maxHpMax, ranges } = deploySnapshot(
    input.units,
    input.ctx.factions,
    PF1E_MODEL_SCHEMA,
    {
      spacing: CELL_FEET,
      maxTotal: MAX_MODELS,
      codecVersion: STRATEGIC_CODEC,
    },
  );
  const state: Published = { version: 0, bytes, maxHpMax, units, hash: "" };
  const pool = checkpointPool(state);
  const seen = new Set<string>();
  for (let i = 0; i < pool.count; i++) {
    const x = pool.x[i] ?? 0,
      y = pool.y[i] ?? 0;
    if (!inBounds(scenario.bounds, x, y))
      throw new Error("A deployed formation extends outside the room bounds.");
    const key = `${Math.floor(x / CELL_FEET)},${Math.floor(y / CELL_FEET)}`;
    if (seen.has(key))
      throw new Error("Deployed formations overlap in the same square.");
    seen.add(key);
  }
  for (const [i, [, range]] of ranges.entries()) {
    const unit = units[i];
    if (unit) unit.range = range;
  }
  state.hash = canonicalPoolHash(pool, PF1E_MODEL_SCHEMA, STRATEGIC_CODEC);
  return state;
}

export function generatedScenario(
  players = 2,
  unitsPerPlayer = 5,
  workload = "mixed",
): Scenario {
  if (
    !integer(players, 2, MAX_COMMANDERS) ||
    players % 2 ||
    (unitsPerPlayer !== 5 && unitsPerPlayer !== 10) ||
    !["idle", "mixed", "contact", "march", "dense"].includes(workload)
  ) {
    throw new Error(
      "Demo: pass even players (2–500), units/player (5 or 10), and idle|mixed|contact|march|dense.",
    );
  }
  const dense = workload === "dense";
  const pitchX = dense ? 30 : 75,
    pitchY = dense ? 50 : 75;
  const across = Math.ceil(Math.sqrt((players / 2) * unitsPerPlayer));
  const x0 = 4096,
    y0 = -8192;
  const factions = [
    { id: "blue", name: "Blue", color: "#72bbff" },
    { id: "red", name: "Red", color: "#ff887e" },
  ];
  return parseScenario({
    format: "arenastar-strategic-scenario-v1",
    name: "Northern Crossing",
    seed: 4242,
    bounds: {
      minX: x0 - 25,
      maxX: x0 + pitchX * across + 35,
      minY: y0 - 25,
      maxY: y0 + pitchY * across + 35,
    },
    factions,
    commanders: Array.from({ length: players }, (_, p) => ({
      id: `commander-${p + 1}`,
      factionId: factions[p % 2]?.id,
      units: Array.from({ length: unitsPerPlayer }, (_, u) => {
        const block = Math.floor(p / 2) * unitsPerPlayer + u;
        const strength = 100 / unitsPerPlayer;
        const weapon =
          workload === "mixed" && block % 5 === 2 ? "shot" : "melee";
        // Adjacent ranks in close fixtures; ranged contacts are 25 ft away and initially visible.
        const separation =
          weapon === "shot"
            ? 25
            : dense || workload === "contact" || workload === "mixed"
              ? 5 * Math.ceil(strength / 10)
              : 40;
        return {
          id: `unit-${p + 1}-${u + 1}`,
          name: `${p % 2 === 0 ? "Blue" : "Red"} ${p + 1}.${u + 1}`,
          anchor: {
            x: x0 + (block % across) * pitchX + (p % 2) * separation,
            y: y0 + Math.floor(block / across) * pitchY + 22.5,
          },
          strength,
          weapon,
        };
      }),
    })),
  });
}
