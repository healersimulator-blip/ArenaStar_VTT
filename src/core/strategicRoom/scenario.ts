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
  STRATEGIC_SPELL_IDS,
  type Bounds,
  type HostedJournal,
  type HostedLight,
  type HostedMacro,
  type HostedPlaylist,
  type HostedRegion,
  type HostedRollTable,
  type HostedTemplate,
  type Point,
  type StrategicFxCoalescence,
  type StrategicItemEffect,
  type StrategicModelStats,
  type StrategicSpellId,
} from "./protocol";

export const MAX_COMMANDERS = 500;
export const MAX_UNITS_PER_COMMANDER = 100;
export const MAX_UNITS = 50_000;
export const MAX_MODELS = 50_000;
/** Supports up to 5,000 × 5,000 five-foot grid squares (25,000 × 25,000 ft). */
export const MAP_SPAN = 25_000;
export const CELL_FEET = 5;
/** Signed launch payload cap for authored battlefield art; keeps campaign requests bounded. */
export const MAX_SCENARIO_BACKGROUND_BYTES = 1024 * 1024;
export const MAX_SCENARIO_BACKGROUND_TILES = 64;
export const MAX_SCENARIO_STITCHED_BYTES = 16 * 1024 * 1024;
export const MAX_SCENARIO_BADGE_BYTES = 256 * 1024;
export const MAX_SCENARIO_BADGES = 16;

const idName = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 64;
const textId = (v: unknown): v is string =>
  isId(v) && v !== "__proto__" && v !== "constructor" && v !== "prototype";

const ALLOWED_STAT_KEYS = new Set([
  "bab",
  "strMod",
  "dexMod",
  "conMod",
  "sizeMod",
  "specialSizeMod",
  "fort",
  "ref",
  "will",
  "hp",
  "sr",
  "drVal",
  "drType",
  "ac",
  "touchAc",
  "flatFootedAc",
  "armorBonus",
  "shieldBonus",
  "naturalArmor",
  "dodgeBonus",
  "miscAc",
  "cmb",
  "cmd",
  "maxAoos",
  "casterLevel",
  "castingStatMod",
  "castingAbilityMod",
  "spellPenetration",
  "entangleSlots",
  "weaponIsRanged",
  "weaponIsThrown",
  "weaponIsFirearm",
  "weaponIsEarlyFirearm",
  "weaponMisfireMin",
  "weaponRangeIncrement",
  "weaponMaxIncrements",
  "weaponReachFt",
  "preciseShot",
  "holdFire1st",
  "weaponHandedness",
  "weaponImprovedCritical",
  "weaponDamageDiceCount",
  "weaponDamageDiceSides",
  "weaponDamageMod",
  "weaponCritMin",
  "weaponCritMult",
  "weaponEnhancement",
  "weaponMaterial",
  "weaponDamageType",
  "weaponBonusDiceCount",
  "weaponBonusDiceSides",
  "weaponBonusDiceTypeFlags",
  "weaponBonusDicePrecision",
  "weaponAlignmentFlags",
  "fastHealing",
  "regeneration",
  "morale",
  "supply",
  "fatigue",
  "hero",
]);

export type ScenarioUnitSpell = {
  id: StrategicSpellId;
  itemId: string;
  actorId?: string;
  casterLevel: number;
  castingAbilityMod: number;
  spellPenetration?: number;
  slots: number;
};

export type ScenarioUnitItem = {
  id: string;
  name: string;
  actorId?: string;
  effect: StrategicItemEffect;
  charges: number;
  potency?: number;
};

export type ScenarioUnitSource = {
  kind: "armyUnit" | "token";
  armyId?: string;
  unitId?: string;
  tokenId?: string;
  actorId?: string;
};

export type ScenarioUnit = {
  id: string;
  name: string;
  /** Optional per-unit allegiance override; defaults to its commander's faction. */
  factionId?: string;
  /** Optional content-addressed SHA-256 badge hash referencing `Scenario.badges`. */
  badge?: string;
  anchor: Point;
  strength: number;
  weapon: "melee" | "shot";
  unitType?: "infantry" | "cavalry" | "artillery" | "hero";
  /** Stable provenance back to source campaign Army/Unit/Token/Actor documents. */
  source?: ScenarioUnitSource;
  /** Derived PF1e combat stats from Actor/Item/ActiveEffect sheets (`deriveFromDocuments`). */
  stats?: Record<string, number>;
  /** Unit perception mode derived from leader/cohort senses. */
  vision?: {
    mode: "normal" | "lowLight" | "darkvision";
    rangeFt?: number;
  };
  /** Generalized regular PF1e spellbook entries available at formation scale. */
  spells?: ScenarioUnitSpell[];
  /** Projected regular PF1e consumables/wands/scrolls available to this unit. */
  items?: ScenarioUnitItem[];
  /** Canonical PF1e conditions active on the unit at launch. */
  conditions?: string[];
  /** Veteran per-soldier C45 combat statistics carried into this battle (indexed by initial slot). */
  modelStats?: StrategicModelStats[];
  /** Legacy projected regular PF1e Entangle spell resource; preserved for compatibility. */
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

export type ScenarioBackgroundTile = {
  hash: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
};

export type ScenarioWall = {
  id?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** RulesWallsContext bit convention when closed/solid: move|sight|sound|light. */
  restriction: number;
  /** Restriction mask when `door === 1` (open); defaults to `0` for ordinary doors. */
  openRestriction?: number;
  /** Door state when conditional-axis (`isDoorWall`): `0` closed, `1` open, `2` locked. */
  door?: 0 | 1 | 2;
};

export type ScenarioDependency = {
  coll: string;
  id: string;
  parentId?: string;
  digest: string;
  visibility: "public" | "faction" | "gm" | "owner";
};

export type ScenarioUnsupportedDiagnostic = {
  feature: string;
  docId?: string;
  reason: string;
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
  /** Per-document SHA-256 provenance and visibility classes for conflict-aware reconciliation. */
  dependencies?: ScenarioDependency[];
  /** Explicit diagnostics for campaign features that cannot execute identically in hosted rooms. */
  unsupported?: ScenarioUnsupportedDiagnostic[];
};

export type ScenarioContent = {
  journals?: HostedJournal[];
  rollTables?: HostedRollTable[];
  playlists?: HostedPlaylist[];
  macros?: HostedMacro[];
};

export type Scenario = {
  format: "arenastar-strategic-scenario-v1";
  projection?: ScenarioProjection;
  name: string;
  seed: number;
  bounds: Bounds;
  background?: ScenarioBackground;
  /** Stitched multi-image map panels placed in world feet, referencing `backgroundAssets`. */
  backgroundTiles?: ScenarioBackgroundTile[];
  /** Content-addressed panel art (`sha256 -> art`) referenced by `backgroundTiles`. */
  backgroundAssets?: Record<string, ScenarioBackground>;
  /** Content-addressed unit token badges (`sha256 -> art`), bounded in count and size. */
  badges?: Record<string, ScenarioBackground>;
  /** Authored source-scene geometry, projected in battlefield feet. */
  walls?: ScenarioWall[];
  /** Scene illumination & ambient lights in battlefield feet. */
  lighting?: {
    darkness: number;
    lights: HostedLight[];
  };
  /** Elevated floors and stairs in battlefield feet. */
  regions?: HostedRegion[];
  /** Persistent measured templates in battlefield feet. */
  templates?: HostedTemplate[];
  terrain?: { difficultCells: Array<{ col: number; row: number }> };
  /** Sanitized leader Actor documents keyed by unitId for `RulesContext.leaderActors`. */
  leaderActors?: Record<string, Record<string, unknown>>;
  /** Entitlement-tagged campaign journals, roll tables, playlists, and declarative macros. */
  content?: ScenarioContent;
  /** Which action classes may be published as cards; per-model cards default off for scale. */
  actionCards?: { playerCharacters: boolean; units: boolean; models: boolean };
  /** Opt-in C45 per-model combat statistics tracking & cross-battle persistence for this scene. */
  trackModelStats?: boolean;
  /** Scene-level VFX & spatial audio coalescence aggressiveness (`extreme` default when omitted). */
  fxCoalescence?: StrategicFxCoalescence;
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

/** Validate a bounded strategic scenario projection with zero executable script payloads. */
export function parseScenario(raw: unknown): Scenario {
  if (
    !record(raw) ||
    !only(
      raw,
      "format",
      "projection",
      "name",
      "seed",
      "bounds",
      "background",
      "backgroundTiles",
      "backgroundAssets",
      "badges",
      "walls",
      "lighting",
      "regions",
      "templates",
      "terrain",
      "leaderActors",
      "content",
      "hazards",
      "actionCards",
      "trackModelStats",
      "fxCoalescence",
      "factions",
      "commanders",
    ) ||
    raw.format !== "arenastar-strategic-scenario-v1" ||
    !idName(raw.name) ||
    !integer(raw.seed, 0, 0xffff_ffff) ||
    (raw.trackModelStats !== undefined && typeof raw.trackModelStats !== "boolean") ||
    (raw.fxCoalescence !== undefined &&
      !["none", "low", "balanced", "high", "extreme"].includes(String(raw.fxCoalescence)))
  ) {
    throw new Error(
      "Expected an arenastar-strategic-scenario-v1 export; see the supported fields in the room README.",
    );
  }
  let projection: ScenarioProjection | undefined;
  if (raw.projection !== undefined) {
    const manifest = raw.projection;
    if (
      !record(manifest) ||
      !only(
        manifest,
        "format",
        "worldId",
        "sceneId",
        "sourceSeq",
        "systemId",
        "systemVersion",
        "digest",
        "dependencies",
        "unsupported",
      ) ||
      manifest.format !== "arenastar-battle-projection-v1" ||
      !textId(manifest.worldId) ||
      !textId(manifest.sceneId) ||
      !integer(manifest.sourceSeq, 0) ||
      !idName(manifest.systemId) ||
      !idName(manifest.systemVersion) ||
      typeof manifest.digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(manifest.digest)
    )
      throw new Error("Invalid hosted battle projection manifest.");
    let dependencies: ScenarioDependency[] | undefined;
    if (manifest.dependencies !== undefined) {
      if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length > 2_000)
        throw new Error("Invalid hosted battle projection dependencies.");
      dependencies = manifest.dependencies.map((dep): ScenarioDependency => {
        if (
          !record(dep) ||
          !only(dep, "coll", "id", "parentId", "digest", "visibility") ||
          !textId(dep.coll) ||
          !textId(dep.id) ||
          (dep.parentId !== undefined && !textId(dep.parentId)) ||
          typeof dep.digest !== "string" ||
          !/^[0-9a-f]{64}$/.test(dep.digest) ||
          !["public", "faction", "gm", "owner"].includes(String(dep.visibility))
        )
          throw new Error("Invalid hosted battle projection dependency.");
        return {
          coll: dep.coll,
          id: dep.id,
          ...(typeof dep.parentId === "string" ? { parentId: dep.parentId } : {}),
          digest: dep.digest,
          visibility: dep.visibility as ScenarioDependency["visibility"],
        };
      });
    }
    let unsupported: ScenarioUnsupportedDiagnostic[] | undefined;
    if (manifest.unsupported !== undefined) {
      if (!Array.isArray(manifest.unsupported) || manifest.unsupported.length > 256)
        throw new Error("Invalid hosted battle projection diagnostics.");
      unsupported = manifest.unsupported.map((diag): ScenarioUnsupportedDiagnostic => {
        if (
          !record(diag) ||
          !only(diag, "feature", "docId", "reason") ||
          typeof diag.feature !== "string" ||
          diag.feature.trim().length === 0 ||
          diag.feature.length > 64 ||
          (diag.docId !== undefined && !textId(diag.docId)) ||
          typeof diag.reason !== "string" ||
          diag.reason.trim().length === 0 ||
          diag.reason.length > 240
        )
          throw new Error("Invalid hosted battle projection diagnostic.");
        return {
          feature: diag.feature.trim(),
          ...(typeof diag.docId === "string" ? { docId: diag.docId } : {}),
          reason: diag.reason.trim(),
        };
      });
    }
    projection = {
      format: manifest.format,
      worldId: manifest.worldId,
      sceneId: manifest.sceneId,
      sourceSeq: manifest.sourceSeq,
      systemId: manifest.systemId,
      systemVersion: manifest.systemVersion,
      digest: manifest.digest,
      ...(dependencies?.length ? { dependencies } : {}),
      ...(unsupported?.length ? { unsupported } : {}),
    };
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
      if (
        !record(wall) ||
        !only(wall, "id", "x1", "y1", "x2", "y2", "restriction", "openRestriction", "door") ||
        (wall.id !== undefined && !textId(wall.id)) ||
        !finite(wall.x1) ||
        !finite(wall.y1) ||
        !finite(wall.x2) ||
        !finite(wall.y2) ||
        !integer(wall.restriction, 0, 15) ||
        (wall.openRestriction !== undefined && !integer(wall.openRestriction, 0, 15)) ||
        (wall.door !== undefined && wall.door !== 0 && wall.door !== 1 && wall.door !== 2) ||
        !inBounds(bounds, wall.x1, wall.y1) ||
        !inBounds(bounds, wall.x2, wall.y2) ||
        (wall.x1 === wall.x2 && wall.y1 === wall.y2)
      )
        throw new Error("Invalid projected scene wall.");
      return {
        ...(typeof wall.id === "string" ? { id: wall.id } : {}),
        x1: wall.x1,
        y1: wall.y1,
        x2: wall.x2,
        y2: wall.y2,
        restriction: wall.restriction,
        ...(wall.openRestriction !== undefined ? { openRestriction: wall.openRestriction } : {}),
        ...(wall.door !== undefined ? { door: wall.door } : {}),
      };
    });
  }
  let lighting: Scenario["lighting"];
  if (raw.lighting !== undefined) {
    if (
      !record(raw.lighting) ||
      !only(raw.lighting, "darkness", "lights") ||
      !finite(raw.lighting.darkness) ||
      raw.lighting.darkness < 0 ||
      raw.lighting.darkness > 1 ||
      !Array.isArray(raw.lighting.lights) ||
      raw.lighting.lights.length > 500
    )
      throw new Error("Invalid projected scene lighting.");
    const lights = raw.lighting.lights.map((light): HostedLight => {
      if (
        !record(light) ||
        !only(light, "id", "x", "y", "dim", "bright", "color", "alpha", "hidden") ||
        !textId(light.id) ||
        !finite(light.x) ||
        !finite(light.y) ||
        !finite(light.dim) ||
        light.dim < 0 ||
        light.dim > MAP_SPAN ||
        !finite(light.bright) ||
        light.bright < 0 ||
        light.bright > MAP_SPAN ||
        typeof light.color !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(light.color) ||
        !finite(light.alpha) ||
        light.alpha < 0 ||
        light.alpha > 1 ||
        (light.hidden !== undefined && typeof light.hidden !== "boolean")
      )
        throw new Error("Invalid projected ambient light.");
      return {
        id: light.id,
        x: light.x,
        y: light.y,
        dim: light.dim,
        bright: light.bright,
        color: light.color,
        alpha: light.alpha,
        ...(light.hidden === true ? { hidden: true } : {}),
      };
    });
    lighting = { darkness: raw.lighting.darkness, lights };
  }
  let regions: HostedRegion[] | undefined;
  if (raw.regions !== undefined) {
    if (!Array.isArray(raw.regions) || raw.regions.length > 500)
      throw new Error("Invalid projected scene regions.");
    regions = raw.regions.map((reg): HostedRegion => {
      if (
        !record(reg) ||
        !only(reg, "id", "name", "x", "y", "width", "height", "elevationFt", "kind") ||
        !textId(reg.id) ||
        (reg.name !== undefined && !idName(reg.name)) ||
        !finite(reg.x) ||
        !finite(reg.y) ||
        !finite(reg.width) ||
        reg.width <= 0 ||
        !finite(reg.height) ||
        reg.height <= 0 ||
        !finite(reg.elevationFt) ||
        Math.abs(reg.elevationFt) > 1000 ||
        (reg.kind !== "raised" && reg.kind !== "stairs")
      )
        throw new Error("Invalid projected scene region.");
      return {
        id: reg.id,
        ...(typeof reg.name === "string" ? { name: reg.name } : {}),
        x: reg.x,
        y: reg.y,
        width: reg.width,
        height: reg.height,
        elevationFt: reg.elevationFt,
        kind: reg.kind,
      };
    });
  }
  let templates: HostedTemplate[] | undefined;
  if (raw.templates !== undefined) {
    if (!Array.isArray(raw.templates) || raw.templates.length > 256)
      throw new Error("Invalid projected measured templates.");
    templates = raw.templates.map((tpl): HostedTemplate => {
      if (
        !record(tpl) ||
        !only(tpl, "id", "shape", "x", "y", "distance", "direction", "width", "color", "label") ||
        !textId(tpl.id) ||
        !["circle", "cone", "line", "rect"].includes(String(tpl.shape)) ||
        !finite(tpl.x) ||
        !finite(tpl.y) ||
        !finite(tpl.distance) ||
        tpl.distance <= 0 ||
        tpl.distance > 1000 ||
        (tpl.direction !== undefined && (!finite(tpl.direction) || Math.abs(tpl.direction) > 3600)) ||
        (tpl.width !== undefined && (!finite(tpl.width) || tpl.width <= 0 || tpl.width > 200)) ||
        typeof tpl.color !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(tpl.color) ||
        (tpl.label !== undefined && !idName(tpl.label))
      )
        throw new Error("Invalid projected measured template.");
      return {
        id: tpl.id,
        shape: tpl.shape as HostedTemplate["shape"],
        x: tpl.x,
        y: tpl.y,
        distance: tpl.distance,
        ...(tpl.direction !== undefined ? { direction: tpl.direction } : {}),
        ...(tpl.width !== undefined ? { width: tpl.width } : {}),
        color: tpl.color,
        ...(typeof tpl.label === "string" ? { label: tpl.label } : {}),
      };
    });
  }
  let terrain: Scenario["terrain"];
  if (raw.terrain !== undefined) {
    if (
      !record(raw.terrain) ||
      !only(raw.terrain, "difficultCells") ||
      !Array.isArray(raw.terrain.difficultCells) ||
      raw.terrain.difficultCells.length > 250_000
    )
      throw new Error("Invalid projected difficult terrain.");
    const seen = new Set<string>();
    const difficultCells = raw.terrain.difficultCells.map((entry) => {
      if (
        !record(entry) ||
        !only(entry, "col", "row") ||
        !integer(entry.col, Math.floor(bounds.minX / CELL_FEET), Math.floor(bounds.maxX / CELL_FEET)) ||
        !integer(entry.row, Math.floor(bounds.minY / CELL_FEET), Math.floor(bounds.maxY / CELL_FEET))
      )
        throw new Error("Invalid projected difficult-terrain cell.");
      const key = `${entry.col},${entry.row}`;
      if (seen.has(key)) throw new Error("Duplicate projected difficult-terrain cell.");
      seen.add(key);
      return { col: entry.col, row: entry.row };
    });
    terrain = { difficultCells };
  }
  let leaderActors: Record<string, Record<string, unknown>> | undefined;
  if (raw.leaderActors !== undefined) {
    if (!record(raw.leaderActors)) throw new Error("Invalid projected leader actors.");
    const entries = Object.entries(raw.leaderActors).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length > 500) throw new Error("Use at most 500 projected leader actors.");
    const encodedSize = new TextEncoder().encode(JSON.stringify(raw.leaderActors)).byteLength;
    if (encodedSize > 512 * 1024) throw new Error("Projected leader actors exceed 512 KiB.");
    const out: Record<string, Record<string, unknown>> = {};
    for (const [unitId, doc] of entries) {
      if (!textId(unitId) || !record(doc)) throw new Error("Invalid projected leader actor entry.");
      out[unitId] = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    }
    if (entries.length > 0) leaderActors = out;
  }
  let content: ScenarioContent | undefined;
  if (raw.content !== undefined) {
    if (!record(raw.content) || !only(raw.content, "journals", "rollTables", "playlists", "macros"))
      throw new Error("Invalid projected campaign content.");
    let journals: HostedJournal[] | undefined;
    if (raw.content.journals !== undefined) {
      if (!Array.isArray(raw.content.journals) || raw.content.journals.length > 64)
        throw new Error("Use at most 64 projected journals.");
      journals = raw.content.journals.map((j): HostedJournal => {
        if (
          !record(j) ||
          !only(j, "id", "name", "markdown", "visibility") ||
          !textId(j.id) ||
          !idName(j.name) ||
          typeof j.markdown !== "string" ||
          j.markdown.length > 16_384 ||
          (j.visibility !== "public" && j.visibility !== "gm")
        )
          throw new Error("Invalid projected journal.");
        return { id: j.id, name: j.name, markdown: j.markdown, visibility: j.visibility };
      });
    }
    let rollTables: HostedRollTable[] | undefined;
    if (raw.content.rollTables !== undefined) {
      if (!Array.isArray(raw.content.rollTables) || raw.content.rollTables.length > 32)
        throw new Error("Use at most 32 projected roll tables.");
      rollTables = raw.content.rollTables.map((t): HostedRollTable => {
        if (
          !record(t) ||
          !only(t, "id", "name", "formula", "results", "visibility") ||
          !textId(t.id) ||
          !idName(t.name) ||
          typeof t.formula !== "string" ||
          !/^[0-9dD+\-\s]{1,32}$/.test(t.formula) ||
          !Array.isArray(t.results) ||
          t.results.length < 1 ||
          t.results.length > 100 ||
          (t.visibility !== "public" && t.visibility !== "gm")
        )
          throw new Error("Invalid projected roll table.");
        const results = t.results.map((r) => {
          if (
            !record(r) ||
            !only(r, "range", "text") ||
            !Array.isArray(r.range) ||
            r.range.length !== 2 ||
            !integer(r.range[0], 1, 10_000) ||
            !integer(r.range[1], r.range[0], 10_000) ||
            typeof r.text !== "string" ||
            r.text.length > 240
          )
            throw new Error("Invalid projected roll-table row.");
          return { range: [r.range[0], r.range[1]] as [number, number], text: r.text };
        });
        return { id: t.id, name: t.name, formula: t.formula, results, visibility: t.visibility };
      });
    }
    let playlists: HostedPlaylist[] | undefined;
    if (raw.content.playlists !== undefined) {
      if (!Array.isArray(raw.content.playlists) || raw.content.playlists.length > 16)
        throw new Error("Use at most 16 projected playlists.");
      playlists = raw.content.playlists.map((p): HostedPlaylist => {
        if (
          !record(p) ||
          !only(p, "id", "name", "tracks") ||
          !textId(p.id) ||
          !idName(p.name) ||
          !Array.isArray(p.tracks) ||
          p.tracks.length > 32
        )
          throw new Error("Invalid projected playlist.");
        const tracks = p.tracks.map((tr) => {
          if (
            !record(tr) ||
            !only(tr, "id", "name", "loop") ||
            !textId(tr.id) ||
            !idName(tr.name) ||
            typeof tr.loop !== "boolean"
          )
            throw new Error("Invalid projected playlist track.");
          return { id: tr.id, name: tr.name, loop: tr.loop };
        });
        return { id: p.id, name: p.name, tracks };
      });
    }
    let macros: HostedMacro[] | undefined;
    if (raw.content.macros !== undefined) {
      if (!Array.isArray(raw.content.macros) || raw.content.macros.length > 32)
        throw new Error("Use at most 32 projected macros.");
      macros = raw.content.macros.map((m): HostedMacro => {
        if (
          !record(m) ||
          !only(m, "id", "name", "executable", "disabledReason", "action") ||
          !textId(m.id) ||
          !idName(m.name) ||
          typeof m.executable !== "boolean" ||
          (m.disabledReason !== undefined && (typeof m.disabledReason !== "string" || m.disabledReason.length > 240))
        )
          throw new Error("Invalid projected macro.");
        let action: HostedMacro["action"];
        if (m.action !== undefined) {
          if (!record(m.action)) throw new Error("Invalid projected macro action.");
          if (m.action.kind === "chat") {
            if (
              !only(m.action, "kind", "text", "rollFormula") ||
              typeof m.action.text !== "string" ||
              m.action.text.length > 240 ||
              (m.action.rollFormula !== undefined &&
                (typeof m.action.rollFormula !== "string" || !/^[0-9dD+\-\s]{1,32}$/.test(m.action.rollFormula)))
            )
              throw new Error("Invalid projected chat macro.");
            action = {
              kind: "chat",
              text: m.action.text,
              ...(typeof m.action.rollFormula === "string" ? { rollFormula: m.action.rollFormula } : {}),
            };
          } else if (
            m.action.kind === "order" &&
            only(m.action, "kind", "orderKind") &&
            ["hold", "defend", "reform"].includes(String(m.action.orderKind))
          ) {
            action = { kind: "order", orderKind: m.action.orderKind as "hold" | "defend" | "reform" };
          } else {
            throw new Error("Invalid projected macro action.");
          }
        }
        return {
          id: m.id,
          name: m.name,
          executable: m.executable,
          ...(typeof m.disabledReason === "string" ? { disabledReason: m.disabledReason } : {}),
          ...(action ? { action } : {}),
        };
      });
    }
    if (journals?.length || rollTables?.length || playlists?.length || macros?.length) {
      content = {
        ...(journals?.length ? { journals } : {}),
        ...(rollTables?.length ? { rollTables } : {}),
        ...(playlists?.length ? { playlists } : {}),
        ...(macros?.length ? { macros } : {}),
      };
    }
  }
  let hazards: SpellHazard[] | undefined;
  if (raw.hazards !== undefined) {
    if (!Array.isArray(raw.hazards) || raw.hazards.length > 64)
      throw new Error("Use at most 64 active hosted spell hazards.");
    hazards = raw.hazards.map((hazard): SpellHazard => {
      if (
        !record(hazard) ||
        !only(
          hazard,
          "id",
          "spell",
          "at",
          "radius",
          "startsTurn",
          "expiresAfterTurn",
          "dc",
          "casterLevel",
          "casterFactionId",
        ) ||
        !textId(hazard.id) ||
        !["entangle", "burningEntanglement", "blackTentacles"].includes(String(hazard.spell)) ||
        !point(hazard.at) ||
        !finite(hazard.radius) ||
        hazard.radius < 5 ||
        hazard.radius > 200 ||
        !inBounds(bounds, hazard.at.x, hazard.at.y) ||
        (hazard.startsTurn !== undefined && !integer(hazard.startsTurn, 0, 1_000_000)) ||
        (hazard.expiresAfterTurn !== undefined && !integer(hazard.expiresAfterTurn, 0, 1_000_000)) ||
        (hazard.dc !== undefined && !integer(hazard.dc, 1, 100)) ||
        (hazard.casterLevel !== undefined && !integer(hazard.casterLevel, 1, 100)) ||
        (hazard.casterFactionId !== undefined && !textId(hazard.casterFactionId))
      )
        throw new Error("Invalid persistent Entangle, Burning Entanglement, or Black Tentacles zone.");
      return {
        id: hazard.id,
        spell: hazard.spell as SpellHazard["spell"],
        at: { x: hazard.at.x, y: hazard.at.y },
        radius: hazard.radius,
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
    )
      throw new Error("Invalid or oversized strategic battlefield background.");
    background = {
      hash: art.hash,
      mime: art.mime as ScenarioBackground["mime"],
      size: art.size,
      width: art.width,
      height: art.height,
      data: art.data,
    };
  }
  let badges: Record<string, ScenarioBackground> | undefined;
  if (raw.badges !== undefined) {
    if (!record(raw.badges)) throw new Error("Invalid strategic unit badges.");
    const entries = Object.entries(raw.badges).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length > MAX_SCENARIO_BADGES)
      throw new Error(`Use at most ${MAX_SCENARIO_BADGES} distinct unit badges.`);
    let totalBytes = 0;
    const map: Record<string, ScenarioBackground> = {};
    for (const [hash, art] of entries) {
      if (
        !/^[0-9a-f]{64}$/.test(hash) ||
        !record(art) ||
        !only(art, "hash", "mime", "size", "width", "height", "data") ||
        art.hash !== hash ||
        !["image/png", "image/jpeg", "image/webp"].includes(String(art.mime)) ||
        !integer(art.size, 1, MAX_SCENARIO_BADGE_BYTES) ||
        !integer(art.width, 1, 100_000) ||
        !integer(art.height, 1, 100_000) ||
        typeof art.data !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(art.data) ||
        Math.floor((art.data.length * 3) / 4) < art.size - 2 ||
        Math.floor((art.data.length * 3) / 4) > art.size
      )
        throw new Error("Invalid or oversized strategic unit badge.");
      totalBytes += art.size;
      if (totalBytes > MAX_SCENARIO_BACKGROUND_BYTES)
        throw new Error("Strategic unit badges exceed 1 MiB combined.");
      map[hash] = {
        hash,
        mime: art.mime as ScenarioBackground["mime"],
        size: art.size,
        width: art.width,
        height: art.height,
        data: art.data,
      };
    }
    if (entries.length > 0) badges = map;
  }
  let backgroundAssets: Record<string, ScenarioBackground> | undefined;
  if (raw.backgroundAssets !== undefined) {
    if (!record(raw.backgroundAssets)) throw new Error("Invalid stitched map assets.");
    const entries = Object.entries(raw.backgroundAssets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length > MAX_SCENARIO_BACKGROUND_TILES)
      throw new Error(`Use at most ${MAX_SCENARIO_BACKGROUND_TILES} stitched map assets.`);
    let totalBytes = 0;
    const map: Record<string, ScenarioBackground> = {};
    for (const [hash, art] of entries) {
      if (
        !/^[0-9a-f]{64}$/.test(hash) ||
        !record(art) ||
        !only(art, "hash", "mime", "size", "width", "height", "data") ||
        art.hash !== hash ||
        !["image/png", "image/jpeg", "image/webp"].includes(String(art.mime)) ||
        !integer(art.size, 1, MAX_SCENARIO_BACKGROUND_BYTES) ||
        !integer(art.width, 1, 200_000) ||
        !integer(art.height, 1, 200_000) ||
        typeof art.data !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(art.data) ||
        Math.floor((art.data.length * 3) / 4) < art.size - 2 ||
        Math.floor((art.data.length * 3) / 4) > art.size
      )
        throw new Error("Invalid or oversized stitched map panel.");
      totalBytes += art.size;
      if (totalBytes > MAX_SCENARIO_STITCHED_BYTES)
        throw new Error("Stitched map panels exceed 16 MiB combined.");
      map[hash] = {
        hash,
        mime: art.mime as ScenarioBackground["mime"],
        size: art.size,
        width: art.width,
        height: art.height,
        data: art.data,
      };
    }
    if (entries.length > 0) backgroundAssets = map;
  }
  let backgroundTiles: ScenarioBackgroundTile[] | undefined;
  if (raw.backgroundTiles !== undefined) {
    if (!Array.isArray(raw.backgroundTiles) || raw.backgroundTiles.length > MAX_SCENARIO_BACKGROUND_TILES)
      throw new Error(`Use at most ${MAX_SCENARIO_BACKGROUND_TILES} stitched map tiles.`);
    const tiles = (raw.backgroundTiles as unknown[]).map((tile): ScenarioBackgroundTile => {
      if (
        !record(tile) ||
        !only(tile, "hash", "x", "y", "width", "height", "rotation") ||
        typeof tile.hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(tile.hash) ||
        !backgroundAssets?.[tile.hash] ||
        !finite(tile.x) ||
        !finite(tile.y) ||
        !finite(tile.width) ||
        !finite(tile.height) ||
        tile.width <= 0 ||
        tile.height <= 0 ||
        tile.width > MAP_SPAN * 2 ||
        tile.height > MAP_SPAN * 2 ||
        (tile.rotation !== undefined && (!finite(tile.rotation) || Math.abs(tile.rotation) > 3600))
      )
        throw new Error("Invalid stitched map tile placement.");
      return {
        hash: tile.hash,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        ...(tile.rotation !== undefined && tile.rotation !== 0 ? { rotation: tile.rotation } : {}),
      };
    });
    if (tiles.length > 0) backgroundTiles = tiles;
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
  if (
    hazards?.some(
      (hazard) =>
        (hazard.casterFactionId !== undefined && !factionIds.has(hazard.casterFactionId)) ||
        (hazard.expiresAfterTurn !== undefined && hazard.expiresAfterTurn < (hazard.startsTurn ?? 0)),
    )
  )
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
      c.units.length > MAX_UNITS_PER_COMMANDER
    ) {
      throw new Error(
        `Each unique commander slot needs a valid faction and 1–${MAX_UNITS_PER_COMMANDER} units.`,
      );
    }
    memberIds.add(c.id);
    const units = (c.units as unknown[]).map((u): ScenarioUnit => {
      let spellcasting: ScenarioUnit["spellcasting"];
      if (record(u) && u.spellcasting !== undefined) {
        const spell = u.spellcasting;
        if (
          !record(spell) ||
          !only(spell, "actorId", "itemId", "casterLevel", "castingAbilityMod", "entangleSlots") ||
          !textId(spell.actorId) ||
          !textId(spell.itemId) ||
          !integer(spell.casterLevel, 1, 100) ||
          !integer(spell.castingAbilityMod, -10, 30) ||
          !integer(spell.entangleSlots, 0, 100)
        )
          throw new Error("Invalid projected regular PF1e Entangle caster resource.");
        spellcasting = {
          actorId: spell.actorId,
          itemId: spell.itemId,
          casterLevel: spell.casterLevel,
          castingAbilityMod: spell.castingAbilityMod,
          entangleSlots: spell.entangleSlots,
        };
      }
      let spells: ScenarioUnitSpell[] | undefined;
      if (record(u) && u.spells !== undefined) {
        if (!Array.isArray(u.spells) || u.spells.length > 16)
          throw new Error("Invalid projected unit spellbook.");
        spells = u.spells.map((s): ScenarioUnitSpell => {
          if (
            !record(s) ||
            !only(s, "id", "itemId", "actorId", "casterLevel", "castingAbilityMod", "spellPenetration", "slots") ||
            !(STRATEGIC_SPELL_IDS as readonly string[]).includes(String(s.id)) ||
            !textId(s.itemId) ||
            (s.actorId !== undefined && !textId(s.actorId)) ||
            !integer(s.casterLevel, 1, 100) ||
            !integer(s.castingAbilityMod, -10, 30) ||
            (s.spellPenetration !== undefined && !integer(s.spellPenetration, -10, 40)) ||
            !integer(s.slots, 0, 100)
          )
            throw new Error("Invalid projected unit spell entry.");
          return {
            id: s.id as StrategicSpellId,
            itemId: s.itemId,
            ...(typeof s.actorId === "string" ? { actorId: s.actorId } : {}),
            casterLevel: s.casterLevel,
            castingAbilityMod: s.castingAbilityMod,
            ...(s.spellPenetration !== undefined ? { spellPenetration: s.spellPenetration } : {}),
            slots: s.slots,
          };
        });
      }
      let items: ScenarioUnitItem[] | undefined;
      if (record(u) && u.items !== undefined) {
        if (!Array.isArray(u.items) || u.items.length > 16)
          throw new Error("Invalid projected unit items.");
        items = u.items.map((it): ScenarioUnitItem => {
          if (
            !record(it) ||
            !only(it, "id", "name", "actorId", "effect", "charges", "potency") ||
            !textId(it.id) ||
            !idName(it.name) ||
            (it.actorId !== undefined && !textId(it.actorId)) ||
            !["heal", "bless", "haste", "shield"].includes(String(it.effect)) ||
            !integer(it.charges, 0, 200) ||
            (it.potency !== undefined && !integer(it.potency, 1, 200))
          )
            throw new Error("Invalid projected unit item.");
          return {
            id: it.id,
            name: it.name,
            ...(typeof it.actorId === "string" ? { actorId: it.actorId } : {}),
            effect: it.effect as StrategicItemEffect,
            charges: it.charges,
            ...(it.potency !== undefined ? { potency: it.potency } : {}),
          };
        });
      }
      let stats: Record<string, number> | undefined;
      if (record(u) && u.stats !== undefined) {
        if (!record(u.stats)) throw new Error("Invalid projected unit stats.");
        const map: Record<string, number> = {};
        for (const [k, v] of Object.entries(u.stats).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          if (!ALLOWED_STAT_KEYS.has(k) || !finite(v) || Math.abs(v) > 10_000)
            throw new Error(`Invalid projected unit stat "${k}".`);
          map[k] = v;
        }
        if (Object.keys(map).length > 0) stats = map;
      }
      let source: ScenarioUnitSource | undefined;
      if (record(u) && u.source !== undefined) {
        const src = u.source;
        if (
          !record(src) ||
          !only(src, "kind", "armyId", "unitId", "tokenId", "actorId") ||
          (src.kind !== "armyUnit" && src.kind !== "token") ||
          (src.armyId !== undefined && !textId(src.armyId)) ||
          (src.unitId !== undefined && !textId(src.unitId)) ||
          (src.tokenId !== undefined && !textId(src.tokenId)) ||
          (src.actorId !== undefined && !textId(src.actorId))
        )
          throw new Error("Invalid projected unit source provenance.");
        source = {
          kind: src.kind,
          ...(typeof src.armyId === "string" ? { armyId: src.armyId } : {}),
          ...(typeof src.unitId === "string" ? { unitId: src.unitId } : {}),
          ...(typeof src.tokenId === "string" ? { tokenId: src.tokenId } : {}),
          ...(typeof src.actorId === "string" ? { actorId: src.actorId } : {}),
        };
      }
      let vision: ScenarioUnit["vision"];
      if (record(u) && u.vision !== undefined) {
        const vis = u.vision;
        if (
          !record(vis) ||
          !only(vis, "mode", "rangeFt") ||
          !["normal", "lowLight", "darkvision"].includes(String(vis.mode)) ||
          (vis.rangeFt !== undefined && !integer(vis.rangeFt, 5, 500))
        )
          throw new Error("Invalid projected unit vision.");
        vision = {
          mode: vis.mode as "normal" | "lowLight" | "darkvision",
          ...(vis.rangeFt !== undefined ? { rangeFt: vis.rangeFt } : {}),
        };
      }
      let conditions: string[] | undefined;
      if (record(u) && u.conditions !== undefined) {
        if (
          !Array.isArray(u.conditions) ||
          u.conditions.length > 16 ||
          !u.conditions.every((cond) => idName(cond))
        )
          throw new Error("Invalid projected unit conditions.");
        conditions = u.conditions.map((cond) => cond.trim());
      }
      let modelStats: StrategicModelStats[] | undefined;
      if (record(u) && u.modelStats !== undefined) {
        if (!Array.isArray(u.modelStats) || u.modelStats.length > 120)
          throw new Error("Invalid projected soldier combat statistics.");
        modelStats = u.modelStats.map((ms): StrategicModelStats => {
          if (
            !record(ms) ||
            !only(
              ms,
              "kills",
              "damageDealt",
              "damageTaken",
              "damageReduced",
              "healed",
              "hits",
              "misses",
              "crits",
            ) ||
            !integer(ms.kills, 0, 1_000_000) ||
            !integer(ms.damageDealt, 0, 100_000_000) ||
            (ms.damageTaken !== undefined && !integer(ms.damageTaken, 0, 100_000_000)) ||
            (ms.damageReduced !== undefined && !integer(ms.damageReduced, 0, 100_000_000)) ||
            (ms.healed !== undefined && !integer(ms.healed, 0, 100_000_000)) ||
            (ms.hits !== undefined && !integer(ms.hits, 0, 10_000_000)) ||
            (ms.misses !== undefined && !integer(ms.misses, 0, 10_000_000)) ||
            (ms.crits !== undefined && !integer(ms.crits, 0, 10_000_000))
          )
            throw new Error("Invalid projected soldier combat record.");
          return {
            kills: ms.kills,
            damageDealt: ms.damageDealt,
            ...(ms.damageTaken ? { damageTaken: ms.damageTaken } : {}),
            ...(ms.damageReduced ? { damageReduced: ms.damageReduced } : {}),
            ...(ms.healed ? { healed: ms.healed } : {}),
            ...(ms.hits ? { hits: ms.hits } : {}),
            ...(ms.misses ? { misses: ms.misses } : {}),
            ...(ms.crits ? { crits: ms.crits } : {}),
          };
        });
      }
      if (
        !record(u) ||
        !only(
          u,
          "id",
          "name",
          "anchor",
          "strength",
          "weapon",
          "unitType",
          "factionId",
          "badge",
          "source",
          "stats",
          "vision",
          "spells",
          "items",
          "conditions",
          "modelStats",
          "spellcasting",
        ) ||
        !textId(u.id) ||
        (u.factionId !== undefined && (!textId(u.factionId) || !factionIds.has(u.factionId))) ||
        (u.badge !== undefined && (typeof u.badge !== "string" || !/^[0-9a-f]{64}$/.test(u.badge))) ||
        (u.unitType !== undefined && !["infantry", "cavalry", "artillery", "hero"].includes(String(u.unitType))) ||
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
        ...(typeof u.badge === "string" ? { badge: u.badge } : {}),
        anchor: { x: u.anchor.x, y: u.anchor.y },
        strength: u.strength,
        weapon: u.weapon,
        ...(u.unitType !== undefined
          ? { unitType: u.unitType as NonNullable<ScenarioUnit["unitType"]> }
          : {}),
        ...(source ? { source } : {}),
        ...(stats ? { stats } : {}),
        ...(vision ? { vision } : {}),
        ...(spells?.length ? { spells } : {}),
        ...(items?.length ? { items } : {}),
        ...(conditions?.length ? { conditions } : {}),
        ...(modelStats?.length ? { modelStats } : {}),
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
    unitIds.size > MAX_UNITS ||
    count > MAX_MODELS
  ) {
    throw new Error(
      `Both factions need commanders and the battlefield may not exceed ${MAX_UNITS} units or ${MAX_MODELS} models.`,
    );
  }
  let actionCards: Scenario["actionCards"];
  if (raw.actionCards !== undefined) {
    const policy = raw.actionCards;
    if (
      !record(policy) ||
      !only(policy, "playerCharacters", "units", "models") ||
      typeof policy.playerCharacters !== "boolean" ||
      typeof policy.units !== "boolean" ||
      typeof policy.models !== "boolean"
    )
      throw new Error("Invalid strategic action-card publication policy.");
    actionCards = {
      playerCharacters: policy.playerCharacters,
      units: policy.units,
      models: policy.models,
    };
  }
  const scenario: Scenario = {
    format: raw.format,
    ...(projection ? { projection } : {}),
    name: raw.name,
    seed: raw.seed,
    bounds,
    ...(background ? { background } : {}),
    ...(backgroundTiles ? { backgroundTiles } : {}),
    ...(backgroundAssets ? { backgroundAssets } : {}),
    ...(badges ? { badges } : {}),
    ...(walls?.length ? { walls } : {}),
    ...(lighting ? { lighting } : {}),
    ...(regions?.length ? { regions } : {}),
    ...(templates?.length ? { templates } : {}),
    ...(terrain ? { terrain } : {}),
    ...(leaderActors ? { leaderActors } : {}),
    ...(content ? { content } : {}),
    ...(hazards?.length ? { hazards } : {}),
    ...(actionCards ? { actionCards } : {}),
    ...(raw.trackModelStats === true ? { trackModelStats: true } : {}),
    ...(raw.fxCoalescence !== undefined && raw.fxCoalescence !== "extreme"
      ? { fxCoalescence: raw.fxCoalescence as StrategicFxCoalescence }
      : {}),
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
