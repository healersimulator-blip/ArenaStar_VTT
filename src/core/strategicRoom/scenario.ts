import { simPositionFits } from "../sim";
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
  commanders: Array<{
    id: string;
    /** GM-visible label; never trusted as a participant-set boundary or identity. */
    name?: string;
    factionId: string;
    units: ScenarioUnit[];
  }>;
};

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
    return {
      id: c.id,
      ...(typeof c.name === "string" ? { name: c.name } : {}),
      factionId: c.factionId,
      units,
    };
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
