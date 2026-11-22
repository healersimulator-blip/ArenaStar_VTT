import type { Json } from "../../../src/core/documents";
import type { RulesContext } from "../../../src/core/rules";
import type {
  ArmyDocument,
  FactionDocument,
  UnitStats,
} from "../../../src/core/strategic";
import {
  integer,
  STRATEGIC_CODEC,
  type StrategicModelStats,
} from "../../../src/core/strategicRoom/protocol";
import { deploySnapshot } from "../../../src/sim/deploy";
import { canonicalPoolHash } from "../../../src/sim/codec";
import { unitViewFor } from "../../../src/sim/turnPlan";
import { PF1E_MODEL_SCHEMA } from "../../../src/packages/pf1e/schema";
import {
  checkpointPool,
  type LiveRoomState,
  type Published,
  type VersionExtras,
} from "./state";

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
  const base: UnitStats = {
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
    ...(unit.spellcasting
      ? {
          casterLevel: unit.spellcasting.casterLevel,
          castingAbilityMod: unit.spellcasting.castingAbilityMod,
          entangleSlots: unit.spellcasting.entangleSlots,
        }
      : {}),
    ...(unit.spells?.[0]
      ? {
          casterLevel: unit.spells[0].casterLevel,
          castingStatMod: unit.spells[0].castingAbilityMod,
          ...(unit.spells[0].spellPenetration !== undefined
            ? { spellPenetration: unit.spells[0].spellPenetration }
            : {}),
        }
      : {}),
    ...(unit.weapon === "shot"
      ? { weaponIsRanged: 1, weaponRangeIncrement: 60, weaponMaxIncrements: 10 }
      : {}),
    ...(unit.stats ?? {}),
  };
  base.strength = unit.strength;
  return base;
}

export function unitElevationAt(
  scenario: Scenario,
  pt: { x: number; y: number } | null | undefined,
): number {
  if (!pt || !scenario.regions?.length) return 0;
  let best = 0;
  for (const reg of scenario.regions) {
    if (
      pt.x >= reg.x &&
      pt.x <= reg.x + reg.width &&
      pt.y >= reg.y &&
      pt.y <= reg.y + reg.height &&
      reg.elevationFt > best
    ) {
      best = reg.elevationFt;
    }
  }
  return best;
}

export function effectiveWallsFor(scenario: Scenario, live?: LiveRoomState) {
  const projectedWalls = scenario.walls ?? [];
  const effective = projectedWalls.map((wall) => {
    const doorState =
      wall.id && live?.doors && Object.hasOwn(live.doors, wall.id)
        ? live.doors[wall.id]
        : wall.door;
    const restriction =
      doorState === 1 ? (wall.openRestriction ?? 0) : wall.restriction;
    return { ...wall, restriction, ...(doorState !== undefined ? { door: doorState } : {}) };
  });
  return {
    list: effective,
    typed: {
      x1: Float32Array.from(effective, (wall) => wall.x1),
      y1: Float32Array.from(effective, (wall) => wall.y1),
      x2: Float32Array.from(effective, (wall) => wall.x2),
      y2: Float32Array.from(effective, (wall) => wall.y2),
      restriction: Uint8Array.from(effective, (wall) => wall.restriction),
    },
  };
}

export function rulesInput(
  scenario: Scenario,
  state: readonly UnitState[],
  options?: {
    live?: LiveRoomState;
    extras?: VersionExtras;
    turnId?: number;
    unitPositions?: ReadonlyMap<string, { x: number; y: number } | null>;
  },
) {
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
  const turnId = options?.turnId ?? 0;
  // One simulation army per unit permits a GM to change one company's allegiance without
  // changing its seat or grants. The commander ID remains the authority boundary.
  const armies: ArmyDocument[] = scenario.commanders.flatMap((c) =>
    c.units.map((u) => {
      const own = state[i++];
      if (!own) throw new Error("Missing committed unit state.");
      const stats: UnitStats = { ...own.stats };
      // Apply active temporary formation buffs from consumables/spells
      const res = options?.extras?.unitResources?.[u.id];
      for (const buff of res?.buffs ?? []) {
        if (buff.expiresAfterTurn < turnId) continue;
        if (buff.effect === "bless") {
          stats.bab = (stats.bab ?? 6) + 1;
        } else if (buff.effect === "haste") {
          stats.bab = (stats.bab ?? 6) + 1;
          stats.ac = (stats.ac ?? 16) + 1;
          stats.dodgeBonus = (stats.dodgeBonus ?? 0) + 1;
          stats.ref = (stats.ref ?? 4) + 1;
        } else if (buff.effect === "shield") {
          stats.ac = (stats.ac ?? 16) + 2;
          stats.touchAc = (stats.touchAc ?? 11) + 2;
        }
      }
      // Apply PF1e Shaken/Sickened/Fatigued condition penalties if present on unit
      for (const cond of res?.conditions ?? u.conditions ?? []) {
        const lc = cond.toLowerCase();
        if (lc === "shaken" || lc === "sickened") {
          stats.bab = (stats.bab ?? 6) - 2;
          stats.fort = (stats.fort ?? 4) - 2;
          stats.ref = (stats.ref ?? 4) - 2;
          stats.will = (stats.will ?? 2) - 2;
        } else if (lc === "fatigued") {
          stats.strMod = (stats.strMod ?? 3) - 1;
          stats.dexMod = (stats.dexMod ?? 0) - 1;
        }
      }
      // Higher ground (+1 melee attack when positioned on elevated region, PF1e Table 8-6)
      const currentAt = options?.unitPositions?.has(u.id)
        ? (options.unitPositions.get(u.id) ?? undefined)
        : u.anchor;
      if (!stats.weaponIsRanged && unitElevationAt(scenario, currentAt) > 0) {
        stats.bab = (stats.bab ?? 6) + 1;
      }
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
        units: [
          {
            _id: u.id,
            type: u.unitType ?? "infantry",
            name: u.name,
            ownership: { default: 0 },
            flags: {},
            system: {},
            profile: { anchor: u.anchor },
            stats,
            orders: { pending: [], issuedBy: c.id, issuedTurn: 0 },
            formation: "line",
            sceneId: SCENE,
            modelRange: own.range,
          },
        ],
      };
    }),
  );
  const units = armies.flatMap((a) => a.units.map((u) => unitViewFor(a, u)));
  const walls = effectiveWallsFor(scenario, options?.live).typed;
  const auto = options?.live?.autonomy;
  const worldSettings: Record<string, Json> = {};
  if (auto?.spatialCombat === true) {
    worldSettings.strategicSpatialCombat = true;
  }
  if (auto?.global === true) {
    worldSettings.strategicAutonomyGlobal = true;
  }
  if (auto?.factions && Object.keys(auto.factions).length > 0) {
    worldSettings.strategicAutonomyFactions = auto.factions as unknown as Json;
  }
  if (auto?.units && Object.keys(auto.units).length > 0) {
    worldSettings.strategicAutonomyUnits = auto.units as unknown as Json;
  }
  const ctx: RulesContext = {
    sceneId: SCENE,
    grid: {
      type: "square",
      size: 100,
      distance: CELL_FEET,
      units: "ft",
      diagonals: "555",
    },
    walls,
    ...(scenario.terrain ? { terrain: scenario.terrain } : {}),
    factions,
    armies,
    leaderActors: (scenario.leaderActors ?? {}) as Record<string, Json>,
    worldSettings,
    turnMode: "simultaneous",
  };
  return { ctx, armies, units };
}

export function initialUnitResources(
  scenario: Scenario,
): NonNullable<VersionExtras["unitResources"]> {
  const out: NonNullable<VersionExtras["unitResources"]> = {};
  for (const c of scenario.commanders) {
    for (const u of c.units) {
      const spells: Record<string, number> = {};
      for (const s of u.spells ?? []) {
        spells[s.id] = s.slots;
      }
      if (u.spellcasting && spells.entangle === undefined) {
        spells.entangle = u.spellcasting.entangleSlots;
      }
      const items: Record<string, number> = {};
      for (const it of u.items ?? []) {
        items[it.id] = it.charges;
      }
      const conditions = u.conditions?.length ? [...u.conditions] : undefined;
      if (Object.keys(spells).length || Object.keys(items).length || conditions?.length) {
        out[u.id] = {
          ...(Object.keys(spells).length ? { spells } : {}),
          ...(Object.keys(items).length ? { items } : {}),
          ...(conditions ? { conditions } : {}),
        };
      }
    }
  }
  return out;
}

export function deploy(scenario: Scenario): Published {
  const units = scenario.commanders.flatMap((c) =>
    c.units.map((u): UnitState => ({ range: null, stats: initialStats(u) })),
  );
  const unitResources = initialUnitResources(scenario);
  const extras: VersionExtras | undefined = Object.keys(unitResources).length
    ? { unitResources }
    : undefined;
  const input = rulesInput(scenario, units, {
    ...(extras ? { extras } : {}),
    turnId: 0,
  });
  const { bytes, maxHpMax, ranges } = deploySnapshot(
    input.units,
    input.ctx.factions,
    PF1E_MODEL_SCHEMA,
    {
      spacing: CELL_FEET,
      maxTotal: MAX_MODELS,
      codecVersion: STRATEGIC_CODEC,
      assignRankFile: true,
    },
  );
  const state: Published = {
    version: 0,
    bytes,
    maxHpMax,
    units,
    hash: "",
    ...(extras ? { extras } : {}),
  };
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
  const flatScenarioUnits = scenario.commanders.flatMap((c) => c.units);
  const seededModelStats: Record<string, StrategicModelStats> = {};
  for (const [i, [, range]] of ranges.entries()) {
    const unit = units[i];
    if (unit) unit.range = range;
    if (scenario.trackModelStats && range) {
      const scenUnit = flatScenarioUnits[i];
      const incoming = scenUnit?.modelStats;
      if (incoming?.length) {
        const [start, end] = range;
        for (let slot = 0; start + slot < end && slot < incoming.length; slot++) {
          const rec = incoming[slot];
          const mid = pool.id[start + slot];
          if (!rec || mid === undefined) continue;
          if (
            rec.kills > 0 ||
            rec.damageDealt > 0 ||
            (rec.damageTaken ?? 0) > 0 ||
            (rec.damageReduced ?? 0) > 0 ||
            (rec.healed ?? 0) > 0 ||
            (rec.hits ?? 0) > 0 ||
            (rec.misses ?? 0) > 0 ||
            (rec.crits ?? 0) > 0
          ) {
            seededModelStats[String(mid)] = { ...rec };
          }
        }
      }
    }
  }
  if (Object.keys(seededModelStats).length > 0) {
    state.extras = { ...(state.extras ?? {}), modelStats: seededModelStats };
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
