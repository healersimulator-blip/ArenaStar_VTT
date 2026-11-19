import { simPositionFits } from "../../../src/core/sim";
import type { RulesContext } from "../../../src/core/rules";
import type {
  ArmyDocument,
  FactionDocument,
  UnitStats,
} from "../../../src/core/strategic";
import {
  finite,
  integer,
  isId,
  only,
  point,
  record,
  STRATEGIC_CODEC,
  type Bounds,
  type Point,
} from "../../../src/core/strategicRoom/protocol";
import { deploySnapshot } from "../../../src/sim/deploy";
import { canonicalPoolHash } from "../../../src/sim/codec";
import { emptyRulesWalls, unitViewFor } from "../../../src/sim/turnPlan";
import { PF1E_MODEL_SCHEMA } from "../../../src/packages/pf1e/schema";
import { checkpointPool, type Published } from "./state";

const SCENE = "battlefield";
export const MAX_COMMANDERS = 500;
const MAX_MODELS = 50_000;
export const MAP_SPAN = 4096;
export const CELL_FEET = 5;
const idName = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 64;
const textId = (v: unknown): v is string =>
  isId(v) && v !== "__proto__" && v !== "constructor" && v !== "prototype";

export type ScenarioUnit = {
  id: string;
  name: string;
  anchor: Point;
  strength: number;
  weapon: "melee" | "shot";
};
export type Scenario = {
  format: "arenastar-strategic-scenario-v1";
  name: string;
  seed: number;
  bounds: Bounds;
  factions: Array<{ id: string; name: string; color: string }>;
  commanders: Array<{ id: string; factionId: string; units: ScenarioUnit[] }>;
};
export type UnitState = { range: [number, number] | null; stats: UnitStats };

export function inBounds(bounds: Bounds, x: number, y: number): boolean {
  return (
    x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
  );
}

/** No packages, scripts, walls, heroes, pending orders, authority or assets are importable. */
export function parseScenario(raw: unknown): Scenario {
  if (
    !record(raw) ||
    !only(raw, "format", "name", "seed", "bounds", "factions", "commanders") ||
    raw.format !== "arenastar-strategic-scenario-v1" ||
    !idName(raw.name) ||
    !integer(raw.seed, 0, 0xffff_ffff)
  ) {
    throw new Error(
      "Expected an arenastar-strategic-scenario-v1 export; see the supported fields in the room README.",
    );
  }
  const b = raw.bounds;
  if (
    !record(b) ||
    !only(b, "minX", "minY", "maxX", "maxY") ||
    !finite(b.minX) ||
    !finite(b.minY) ||
    !finite(b.maxX) ||
    !finite(b.maxY) ||
    [b.minX, b.minY, b.maxX, b.maxY].some(
      (v) => !simPositionFits(v, STRATEGIC_CODEC),
    ) ||
    b.maxX - b.minX < 5 ||
    b.maxY - b.minY < 5 ||
    b.maxX - b.minX > MAP_SPAN ||
    b.maxY - b.minY > MAP_SPAN
  ) {
    throw new Error(
      `Map bounds must fit codec 2 and span at most ${MAP_SPAN} feet on either axis.`,
    );
  }
  const bounds: Bounds = {
    minX: b.minX,
    minY: b.minY,
    maxX: b.maxX,
    maxY: b.maxY,
  };
  if (!Array.isArray(raw.factions) || raw.factions.length !== 2)
    throw new Error("Exactly two factions are required.");
  const factions = (raw.factions as unknown[]).map((f) => {
    if (
      !record(f) ||
      !only(f, "id", "name", "color") ||
      !textId(f.id) ||
      !idName(f.name) ||
      typeof f.color !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(f.color)
    ) {
      throw new Error("Invalid faction.");
    }
    return { id: f.id, name: f.name, color: f.color };
  });
  const factionIds = new Set(factions.map((f) => f.id));
  if (factionIds.size !== 2) throw new Error("Duplicate faction ID.");
  if (
    !Array.isArray(raw.commanders) ||
    raw.commanders.length < 2 ||
    raw.commanders.length > MAX_COMMANDERS
  ) {
    throw new Error(
      `Use 2–${MAX_COMMANDERS} fixed commander slots (capacity is not a qualified player limit).`,
    );
  }
  const memberIds = new Set(["gm"]);
  const unitIds = new Set<string>();
  let count = 0;
  const commanders = (raw.commanders as unknown[]).map((c) => {
    if (
      !record(c) ||
      !only(c, "id", "factionId", "units") ||
      !textId(c.id) ||
      !textId(c.factionId) ||
      !factionIds.has(c.factionId) ||
      memberIds.has(c.id) ||
      !Array.isArray(c.units) ||
      c.units.length < 1 ||
      c.units.length > 10
    ) {
      throw new Error(
        "Each unique commander slot needs a valid faction and 1–10 units.",
      );
    }
    memberIds.add(c.id);
    const units = (c.units as unknown[]).map((u): ScenarioUnit => {
      if (
        !record(u) ||
        !only(u, "id", "name", "anchor", "strength", "weapon") ||
        !textId(u.id) ||
        unitIds.has(u.id) ||
        !idName(u.name) ||
        !integer(u.strength, 1, 100) ||
        !point(u.anchor) ||
        (u.weapon !== "melee" && u.weapon !== "shot")
      ) {
        throw new Error(
          "Invalid or multiply assigned unit; use 1–100 models and an explicit deploy anchor and weapon.",
        );
      }
      unitIds.add(u.id);
      count += u.strength;
      return {
        id: u.id,
        name: u.name,
        anchor: { x: u.anchor.x, y: u.anchor.y },
        strength: u.strength,
        weapon: u.weapon,
      };
    });
    return { id: c.id, factionId: c.factionId, units };
  });
  if (
    new Set(commanders.map((c) => c.factionId)).size !== 2 ||
    count > MAX_MODELS
  ) {
    throw new Error(
      `Both factions need commanders and the battlefield may not exceed ${MAX_MODELS} models.`,
    );
  }
  return {
    format: raw.format,
    name: raw.name,
    seed: raw.seed,
    bounds,
    factions,
    commanders,
  };
}

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
  const armies: ArmyDocument[] = scenario.commanders.map((c) => ({
    _id: c.id,
    type: "army",
    name: c.id,
    factionId: c.factionId,
    commander: [c.id],
    supply: {},
    ownership: { default: 0, [c.id]: 3 },
    flags: {},
    system: {},
    units: c.units.map((u) => {
      const own = state[i++];
      if (!own) throw new Error("Missing committed unit state.");
      return {
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
      };
    }),
  }));
  const units = armies.flatMap((a) => a.units.map((u) => unitViewFor(a, u)));
  const ctx: RulesContext = {
    sceneId: SCENE,
    grid: {
      type: "square",
      size: 100,
      distance: CELL_FEET,
      units: "ft",
      diagonals: "555",
    },
    walls: emptyRulesWalls(),
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
