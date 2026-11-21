import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { simPositionFits } from "../sim";
import type { SpellHazard } from "./hazardAvoidance";
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
} from "./protocol";

export const MAX_COMMANDERS = 500;
export const MAX_MODELS = 50_000;
export const MAP_SPAN = 4096;
export const CELL_FEET = 5;
/** Signed launch payload cap for authored battlefield art; keeps campaign requests bounded. */
export const MAX_SCENARIO_BACKGROUND_BYTES = 1024 * 1024;
const idName = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 64;
const textId = (v: unknown): v is string =>
  isId(v) && v !== "__proto__" && v !== "constructor" && v !== "prototype";

export type ScenarioUnit = {
  id: string;
  name: string;
  /** Optional per-unit allegiance override; defaults to its commander's faction. */
  factionId?: string;
  anchor: Point;
  strength: number;
  weapon: "melee" | "shot";
  /** Projected regular PF1e spell resource; never a strategic-only spell definition. */
  spellcasting?: {
    actorId: string;
    itemId: string;
    casterLevel: number;
    castingAbilityMod: number;
    entangleSlots: number;
  };
};
export type ScenarioBackground = {
  hash: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  width: number;
  height: number;
  /** Base64url bytes, signed by the GM and hash-verified by the campaign edge. */
  data: string;
};
export type ScenarioWall = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** RulesWallsContext bit convention: move|sight|sound|light. */
  restriction: number;
};
export type ScenarioProjection = {
  format: "arenastar-battle-projection-v1";
  worldId: string;
  sceneId: string;
  /** DocumentStore sequence frozen when the projection was built. */
  sourceSeq: number;
  systemId: string;
  systemVersion: string;
  /** SHA-256 of the validated scenario payload with this manifest omitted. */
  digest: string;
};
export type Scenario = {
  format: "arenastar-strategic-scenario-v1";
  projection?: ScenarioProjection;
  name: string;
  seed: number;
  bounds: Bounds;
  background?: ScenarioBackground;
  /** Authored source-scene geometry, projected in battlefield feet. */
  walls?: ScenarioWall[];
  terrain?: { difficultCells: Array<{ col: number; row: number }> };
  /** Which action classes may be published as cards; per-model cards default off for scale. */
  actionCards?: { playerCharacters: boolean; units: boolean; models: boolean };
  /** Active persistent spell areas that influence hosted movement. */
  hazards?: SpellHazard[];
  factions: Array<{ id: string; name: string; color: string }>;
  commanders: Array<{
    id: string;
    /** GM-visible label; never trusted as a participant-set boundary or identity. */
    name?: string;
    factionId: string;
    units: ScenarioUnit[];
  }>;
};

export function scenarioProjectionDigest(scenario: Omit<Scenario, "projection">): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(scenario))));
}

export function inBounds(bounds: Bounds, x: number, y: number): boolean {
  return (
    x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
  );
}

/** No packages, scripts, walls, heroes, pending orders, authority or assets are importable. */
export function parseScenario(raw: unknown): Scenario {
  if (
    !record(raw) ||
    !only(raw, "format", "projection", "name", "seed", "bounds", "background", "walls", "terrain", "hazards", "actionCards", "factions", "commanders") ||
    raw.format !== "arenastar-strategic-scenario-v1" ||
    !idName(raw.name) ||
    !integer(raw.seed, 0, 0xffff_ffff)
  ) {
    throw new Error(
      "Expected an arenastar-strategic-scenario-v1 export; see the supported fields in the room README.",
    );
  }
  let projection: ScenarioProjection | undefined;
  if (raw.projection !== undefined) {
    const manifest = raw.projection;
    if (!record(manifest) || !only(manifest, "format", "worldId", "sceneId", "sourceSeq",
      "systemId", "systemVersion", "digest") ||
      manifest.format !== "arenastar-battle-projection-v1" || !textId(manifest.worldId) ||
      !textId(manifest.sceneId) || !integer(manifest.sourceSeq, 0) ||
      !idName(manifest.systemId) || !idName(manifest.systemVersion) ||
      typeof manifest.digest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.digest))
      throw new Error("Invalid hosted battle projection manifest.");
    projection = { format: manifest.format, worldId: manifest.worldId, sceneId: manifest.sceneId,
      sourceSeq: manifest.sourceSeq, systemId: manifest.systemId,
      systemVersion: manifest.systemVersion, digest: manifest.digest };
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
  let walls: ScenarioWall[] | undefined;
  if (raw.walls !== undefined) {
    if (!Array.isArray(raw.walls) || raw.walls.length > 10_000)
      throw new Error("Use at most 10,000 projected scene walls.");
    walls = raw.walls.map((wall): ScenarioWall => {
      if (!record(wall) || !only(wall, "x1", "y1", "x2", "y2", "restriction") ||
        !finite(wall.x1) || !finite(wall.y1) || !finite(wall.x2) || !finite(wall.y2) ||
        !integer(wall.restriction, 0, 15) ||
        !inBounds(bounds, wall.x1, wall.y1) || !inBounds(bounds, wall.x2, wall.y2) ||
        (wall.x1 === wall.x2 && wall.y1 === wall.y2))
        throw new Error("Invalid projected scene wall.");
      return { x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2,
        restriction: wall.restriction };
    });
  }
  let terrain: Scenario["terrain"];
  if (raw.terrain !== undefined) {
    if (!record(raw.terrain) || !only(raw.terrain, "difficultCells") ||
      !Array.isArray(raw.terrain.difficultCells) || raw.terrain.difficultCells.length > 250_000)
      throw new Error("Invalid projected difficult terrain.");
    const seen = new Set<string>();
    const difficultCells = raw.terrain.difficultCells.map((entry) => {
      if (!record(entry) || !only(entry, "col", "row") ||
        !integer(entry.col, Math.floor(bounds.minX / CELL_FEET), Math.floor(bounds.maxX / CELL_FEET)) ||
        !integer(entry.row, Math.floor(bounds.minY / CELL_FEET), Math.floor(bounds.maxY / CELL_FEET)))
        throw new Error("Invalid projected difficult-terrain cell.");
      const key = `${entry.col},${entry.row}`;
      if (seen.has(key)) throw new Error("Duplicate projected difficult-terrain cell.");
      seen.add(key);
      return { col: entry.col, row: entry.row };
    });
    terrain = { difficultCells };
  }
  let hazards: SpellHazard[] | undefined;
  if (raw.hazards !== undefined) {
    if (!Array.isArray(raw.hazards) || raw.hazards.length > 64)
      throw new Error("Use at most 64 active hosted spell hazards.");
    hazards = raw.hazards.map((hazard): SpellHazard => {
      if (!record(hazard) || !only(hazard, "id", "spell", "at", "radius", "startsTurn",
        "expiresAfterTurn", "dc", "casterLevel", "casterFactionId") ||
        !textId(hazard.id) || !["entangle", "burningEntanglement", "blackTentacles"].includes(String(hazard.spell)) ||
        !point(hazard.at) || !finite(hazard.radius) || hazard.radius < 5 || hazard.radius > 200 ||
        !inBounds(bounds, hazard.at.x, hazard.at.y) ||
        (hazard.startsTurn !== undefined && !integer(hazard.startsTurn, 0, 1_000_000)) ||
        (hazard.expiresAfterTurn !== undefined && !integer(hazard.expiresAfterTurn, 0, 1_000_000)) ||
        (hazard.dc !== undefined && !integer(hazard.dc, 1, 100)) ||
        (hazard.casterLevel !== undefined && !integer(hazard.casterLevel, 1, 100)) ||
        (hazard.casterFactionId !== undefined && !textId(hazard.casterFactionId)))
        throw new Error("Invalid persistent Entangle, Burning Entanglement, or Black Tentacles zone.");
      return {
        id: hazard.id, spell: hazard.spell as SpellHazard["spell"],
        at: { x: hazard.at.x, y: hazard.at.y }, radius: hazard.radius,
        ...(hazard.startsTurn !== undefined ? { startsTurn: hazard.startsTurn } : {}),
        ...(hazard.expiresAfterTurn !== undefined ? { expiresAfterTurn: hazard.expiresAfterTurn } : {}),
        ...(hazard.dc !== undefined ? { dc: hazard.dc } : {}),
        ...(hazard.casterLevel !== undefined ? { casterLevel: hazard.casterLevel } : {}),
        ...(hazard.casterFactionId !== undefined ? { casterFactionId: hazard.casterFactionId } : {}),
      };
    });
  }
  let background: ScenarioBackground | undefined;
  if (raw.background !== undefined) {
    const art = raw.background;
    if (
      !record(art) ||
      !only(art, "hash", "mime", "size", "width", "height", "data") ||
      typeof art.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(art.hash) ||
      !["image/png", "image/jpeg", "image/webp"].includes(String(art.mime)) ||
      !integer(art.size, 1, MAX_SCENARIO_BACKGROUND_BYTES) ||
      !integer(art.width, 1, 100_000) ||
      !integer(art.height, 1, 100_000) ||
      typeof art.data !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(art.data) ||
      Math.floor((art.data.length * 3) / 4) < art.size - 2 ||
      Math.floor((art.data.length * 3) / 4) > art.size
    ) throw new Error("Invalid or oversized strategic battlefield background.");
    background = {
      hash: art.hash,
      mime: art.mime as ScenarioBackground["mime"],
      size: art.size,
      width: art.width,
      height: art.height,
      data: art.data,
    };
  }
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
  if (hazards?.some((hazard) =>
    (hazard.casterFactionId !== undefined && !factionIds.has(hazard.casterFactionId)) ||
    (hazard.expiresAfterTurn !== undefined &&
      hazard.expiresAfterTurn < (hazard.startsTurn ?? 0))))
    throw new Error("A spell hazard needs a known caster faction and a non-negative duration.");
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
      !only(c, "id", "name", "factionId", "units") ||
      (c.name !== undefined && !idName(c.name)) ||
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
      let spellcasting: ScenarioUnit["spellcasting"];
      if (record(u) && u.spellcasting !== undefined) {
        const spell = u.spellcasting;
        if (!record(spell) || !only(spell, "actorId", "itemId", "casterLevel",
          "castingAbilityMod", "entangleSlots") || !textId(spell.actorId) ||
          !textId(spell.itemId) || !integer(spell.casterLevel, 1, 100) ||
          !integer(spell.castingAbilityMod, -10, 30) || !integer(spell.entangleSlots, 0, 100))
          throw new Error("Invalid projected regular PF1e Entangle caster resource.");
        spellcasting = { actorId: spell.actorId, itemId: spell.itemId,
          casterLevel: spell.casterLevel, castingAbilityMod: spell.castingAbilityMod,
          entangleSlots: spell.entangleSlots };
      }
      if (
        !record(u) ||
        !only(u, "id", "name", "anchor", "strength", "weapon", "factionId", "spellcasting") ||
        !textId(u.id) ||
        (u.factionId !== undefined && (!textId(u.factionId) || !factionIds.has(u.factionId))) ||
        unitIds.has(u.id) ||
        !idName(u.name) ||
        !integer(u.strength, 1, 120) ||
        !point(u.anchor) ||
        (u.weapon !== "melee" && u.weapon !== "shot")
      ) {
        throw new Error(
          "Invalid or multiply assigned unit; use 1–120 models and an explicit deploy anchor, weapon and known faction.",
        );
      }
      unitIds.add(u.id);
      count += u.strength;
      return {
        id: u.id,
        name: u.name,
        ...(typeof u.factionId === "string" ? { factionId: u.factionId } : {}),
        anchor: { x: u.anchor.x, y: u.anchor.y },
        strength: u.strength,
        weapon: u.weapon,
        ...(spellcasting ? { spellcasting } : {}),
      };
    });
    return {
      id: c.id,
      ...(typeof c.name === "string" ? { name: c.name } : {}),
      factionId: c.factionId,
      units,
    };
  });
  if (
    new Set(commanders.flatMap((c) => c.units.map((u) => u.factionId ?? c.factionId))).size !== 2 ||
    count > MAX_MODELS
  ) {
    throw new Error(
      `Both factions need commanders and the battlefield may not exceed ${MAX_MODELS} models.`,
    );
  }
  let actionCards: Scenario["actionCards"];
  if (raw.actionCards !== undefined) {
    const policy = raw.actionCards;
    if (!record(policy) || !only(policy, "playerCharacters", "units", "models") ||
      typeof policy.playerCharacters !== "boolean" || typeof policy.units !== "boolean" ||
      typeof policy.models !== "boolean")
      throw new Error("Invalid strategic action-card publication policy.");
    actionCards = { playerCharacters: policy.playerCharacters, units: policy.units, models: policy.models };
  }
  const scenario: Scenario = {
    format: raw.format,
    ...(projection ? { projection } : {}),
    name: raw.name,
    seed: raw.seed,
    bounds,
    ...(background ? { background } : {}),
    ...(walls?.length ? { walls } : {}),
    ...(terrain ? { terrain } : {}),
    ...(hazards?.length ? { hazards } : {}),
    ...(actionCards ? { actionCards } : {}),
    factions,
    commanders,
  };
  if (projection) {
    const payload = { ...scenario };
    delete payload.projection;
    const digest = scenarioProjectionDigest(payload);
    if (digest !== projection.digest)
      throw new Error("Hosted battle projection digest does not match its validated payload.");
  }
  return scenario;
}
