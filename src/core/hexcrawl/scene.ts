/**
 * **Hexcrawl scene ops — every write in one place (D-269, plan §3.1/§3.4).**
 *
 * Each function returns `Op[]` and writes nothing: the caller submits them, so hexcrawl edits
 * ride the ordinary intent path and inherit host validation, the op log, undo, projection and
 * the world file (D-012's whole-object-update rule is respected — `FlatDiff` cannot create
 * missing intermediates, so flag writes pass the merged object).
 *
 * Two shapes of write live here:
 * - **profile writes** — one flag block on the scene (`flags.core.hexcrawl`);
 * - **cell writes** — create/update/delete of the embedded `cells` collection.
 *
 * Projection is *not* done here: `core/projection.ts` strips what a player may not read, using
 * `hexcrawl/profile`'s predicates, and this module never has to decide who is looking.
 */
import type {
  BaseDocument,
  CellDocument,
  CellFeature,
  Json,
  SceneDocument,
  SceneGrid,
  TokenDocument,
} from "../documents";
import type { FlatDiff, Op } from "../ops";
import { worldSettingsFrom, worldSettingsOps } from "../worldSettings";
import { PF1E_TERRAIN_CATALOG, catalogToJson } from "./terrain";
import {
  DEFAULT_HEXCRAWL_PROFILE,
  HEXCRAWL_FLAG,
  HEXCRAWL_VERSION,
  MAX_REVEALED_CELLS,
  MAX_SIGHT_RADIUS,
  MAX_SIGHT_WORLD_UNITS,
  MAX_SPEED_PER_DAY,
  MAX_TRAVEL_PATH,
  MIN_SPEED_PER_DAY,
  type EncounterAnnounce,
  type EncounterMode,
  type HexcrawlProfile,
  type HexcrawlSightMode,
  type TravelPace,
  type TravelPlan,
  hexcrawlProfileOf,
  readTravelPlan,
} from "./types";

/** The scene's current profile, defaulted — what a patch is applied on top of. */
export function profileOf(scene: SceneDocument): HexcrawlProfile {
  return hexcrawlProfileOf(scene) ?? { ...DEFAULT_HEXCRAWL_PROFILE };
}

/** The whole-object `flags` update that writes a profile (existence = the feature switch). */
export function hexcrawlFlagOps(
  scene: SceneDocument,
  profile: HexcrawlProfile,
): Op[] {
  const flags = scene.flags ?? {};
  const core =
    typeof flags["core"] === "object" && flags["core"] !== null
      ? flags["core"]
      : {};
  return [
    {
      kind: "update",
      ref: { coll: "scenes", id: scene._id },
      diff: {
        flags: {
          ...flags,
          core: { ...core, [HEXCRAWL_FLAG]: serializeProfile(profile) },
        },
      },
    },
  ];
}

/** Trim a profile to JSON and to the documented bounds before it is written. */
export function serializeProfile(
  profile: HexcrawlProfile,
): Record<string, Json> {
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const key of profile.revealed) {
    if (seenSet.has(key)) continue;
    seenSet.add(key);
    seen.push(key);
    if (seen.length >= MAX_REVEALED_CELLS) break;
  }
  const sight = profile.sight;
  const out: Record<string, Json> = {
    version: HEXCRAWL_VERSION,
    revealed: seen,
    sight: {
      mode: sight.mode,
      radiusCells: clampInt(sight.radiusCells, 0, MAX_SIGHT_RADIUS),
      radiusWorldUnits: clampInt(
        sight.radiusWorldUnits,
        0,
        MAX_SIGHT_WORLD_UNITS,
      ),
    },
    partyTokenId: profile.partyTokenId,
    encounterMode: profile.encounterMode,
    daylight: {
      dawnHour: clampNum(profile.daylight.dawnHour, 0, 24),
      duskHour: clampNum(profile.daylight.duskHour, 0, 24),
    },
    terrain: profile.terrain,
    travel: profile.travel ? serializeTravel(profile.travel) : null,
  };
  return out;
}

function serializeTravel(travel: TravelPlan): Record<string, Json> {
  return {
    path: travel.path.slice(0, MAX_TRAVEL_PATH),
    cursor: travel.cursor,
    progressSeconds: travel.progressSeconds,
    speedPerDay: clampNum(
      travel.speedPerDay,
      MIN_SPEED_PER_DAY,
      MAX_SPEED_PER_DAY,
    ),
    pace: travel.pace,
  };
}

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(
    max,
    Math.max(min, Math.round(Number.isFinite(value) ? value : min)),
  );
const clampNum = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/** Enabling the feature: write the flag with defaults (the GM's first click). */
export function enableHexcrawlOps(
  scene: SceneDocument,
  init: Partial<HexcrawlProfile> = {},
): Op[] {
  const current = hexcrawlProfileOf(scene);
  const profile: HexcrawlProfile = {
    ...DEFAULT_HEXCRAWL_PROFILE,
    ...init,
    revealed: init.revealed ?? [],
  };
  // Re-enabling a scene keeps what it already had; only `init` overrides.
  return hexcrawlFlagOps(scene, current ? { ...current, ...init } : profile);
}

/** Disabling the feature: drop the flag entirely. Cells stay on the scene (harmless, unread). */
export function disableHexcrawlOps(scene: SceneDocument): Op[] {
  const flags = scene.flags ?? {};
  // The key is dropped by rebuilding the bag without it (no dynamic `delete`; same discipline as
  // `fogSettingsOps`).
  const existing =
    typeof flags["core"] === "object" && flags["core"] !== null
      ? (flags["core"] as Record<string, Json>)
      : {};
  const core = Object.fromEntries(
    Object.entries(existing).filter(([key]) => key !== HEXCRAWL_FLAG),
  );
  return [
    {
      kind: "update",
      ref: { coll: "scenes", id: scene._id },
      diff: { flags: { ...flags, core } },
    } satisfies Op,
  ];
}

/** Patch the profile. Returns `[]` when nothing changes, so a no-op click writes no ops. */
export function patchHexcrawlOps(
  scene: SceneDocument,
  patch: Partial<HexcrawlProfile>,
): Op[] {
  const current = profileOf(scene);
  const next: HexcrawlProfile = { ...current, ...patch };
  if (
    JSON.stringify(serializeProfile(current)) ===
    JSON.stringify(serializeProfile(next))
  )
    return [];
  return hexcrawlFlagOps(scene, next);
}

export function setSightOps(
  scene: SceneDocument,
  sight: {
    mode?: HexcrawlSightMode;
    radiusCells?: number;
    radiusWorldUnits?: number;
  },
): Op[] {
  const current = profileOf(scene);
  return patchHexcrawlOps(scene, { sight: { ...current.sight, ...sight } });
}

export function setEncounterModeOps(
  scene: SceneDocument,
  mode: EncounterMode,
): Op[] {
  return patchHexcrawlOps(scene, { encounterMode: mode });
}

/** D-273: whether a public encounter card names what was rolled. */
export function setEncounterAnnounceOps(
  scene: SceneDocument,
  announce: EncounterAnnounce,
): Op[] {
  return patchHexcrawlOps(scene, { encounterAnnounce: announce });
}

export function setDaylightOps(
  scene: SceneDocument,
  dawnHour: number,
  duskHour: number,
): Op[] {
  return patchHexcrawlOps(scene, { daylight: { dawnHour, duskHour } });
}

export function setTerrainOps(scene: SceneDocument, terrain: string): Op[] {
  return patchHexcrawlOps(scene, { terrain });
}

export function setPartyTokenOps(
  scene: SceneDocument,
  tokenId: string | null,
): Op[] {
  return patchHexcrawlOps(scene, { partyTokenId: tokenId });
}

/**
 * The reveal set. `open` adds and removes in one write (the ring opens and closes as the party
 * walks), which is why this is not two functions: two ops would let a reader see a half-applied
 * ring.
 */
export function revealCellsOps(
  scene: SceneDocument,
  open: readonly string[],
  close: readonly string[] = [],
): Op[] {
  const current = profileOf(scene);
  const set = new Set(current.revealed);
  for (const key of open) set.add(key);
  for (const key of close) set.delete(key);
  if (
    set.size === current.revealed.length &&
    [...set].every((k) => current.revealed.includes(k))
  ) {
    return [];
  }
  return patchHexcrawlOps(scene, { revealed: [...set] });
}

/** Close every cell (a map reset), keeping the party token and terrain as they were. */
export function closeAllCellsOps(scene: SceneDocument): Op[] {
  return patchHexcrawlOps(scene, { revealed: [] });
}

// ─── cells (embedded documents) ──────────────────────────────────────────────

/** The `cells` array with `cells ?? []` tolerance (old scenes have no field). */
function cellsArray(scene: SceneDocument): CellDocument[] {
  return scene.cells ?? [];
}

/** Ids the GM has not chosen are generated by the caller (a doc id must be world-unique). */

/**
 * Create a cell. **The parent's `cells` array is written in the same diff** — the embedded
 * create path (D-013) needs the array to exist on scenes authored before this feature.
 */
export function createCellOps(
  scene: SceneDocument,
  id: string,
  cell: Partial<CellDocument>,
): Op[] {
  const doc: CellDocument = {
    _id: id,
    type: "cell",
    // A cell's own label defaults to its key: `create` requires a `name` (the store's common
    // field check), and "3,-2" is the name a GM would give an anonymous hex anyway. This was a
    // real bug until D-271 — the builder's unit tests only read the op's shape, so a cell create
    // never made it through a store until the browser spec drove one.
    name: cell.name ?? cell.key ?? id,
    key: cell.key ?? "",
    ownership: cell.ownership ?? { default: 0 },
    flags: cell.flags ?? {},
    system: cell.system ?? {},
    ...cell,
  } as CellDocument;
  return [
    {
      kind: "create",
      coll: "cells",
      // D-012: an embedded create carries its parent, so the store can materialize the `cells`
      // array on a scene that predates the feature (see `embeddedArray`'s `?? []`).
      parent: { coll: "scenes", id: scene._id },
      data: doc as unknown as BaseDocument,
    },
  ];
}

/** Update a cell's authored fields (terrain, texts, tables, features) in one write. */
export function updateCellOps(
  scene: SceneDocument,
  key: string,
  patch: Partial<Omit<CellDocument, "_id" | "type" | "key">>,
): Op[] {
  const cell = cellsArray(scene).find((c) => c.key === key);
  if (!cell) return [];
  return [
    {
      kind: "update",
      ref: {
        coll: "cells",
        id: cell._id,
        parent: { coll: "scenes", id: scene._id },
      },
      diff: patch as unknown as FlatDiff,
    },
  ];
}

export function deleteCellOps(scene: SceneDocument, key: string): Op[] {
  const cell = cellsArray(scene).find((c) => c.key === key);
  if (!cell) return [];
  return [
    {
      kind: "delete",
      ref: {
        coll: "cells",
        id: cell._id,
        parent: { coll: "scenes", id: scene._id },
      },
    },
  ];
}

/** Attach/detach encounter tables on a cell (the cell's own list; tables live top-level). */
export function setCellTablesOps(
  scene: SceneDocument,
  key: string,
  tableIds: string[],
): Op[] {
  return updateCellOps(scene, key, { tables: tableIds });
}

// ─── features (hidden things inside a cell) ──────────────────────────────────

export function addFeatureOps(
  scene: SceneDocument,
  key: string,
  feature: CellFeature,
): Op[] {
  const cell = cellsArray(scene).find((c) => c.key === key);
  if (!cell) return [];
  return updateCellOps(scene, key, {
    features: [...(cell.features ?? []), feature],
  });
}

export function removeFeatureOps(
  scene: SceneDocument,
  key: string,
  featureId: string,
): Op[] {
  const cell = cellsArray(scene).find((c) => c.key === key);
  if (!cell) return [];
  return updateCellOps(scene, key, {
    features: (cell.features ?? []).filter((f) => f.id !== featureId),
  });
}

/** Patch one feature (the reveal rule, its texts, its art). */
export function patchFeatureOps(
  scene: SceneDocument,
  key: string,
  featureId: string,
  patch: Partial<CellFeature>,
): Op[] {
  const cell = cellsArray(scene).find((c) => c.key === key);
  if (!cell) return [];
  return updateCellOps(scene, key, {
    features: (cell.features ?? []).map((f) =>
      f.id === featureId ? { ...f, ...patch } : f,
    ),
  });
}

/**
 * Flip a feature's revealed state — the only reveal write, whoever decided it (the GM's
 * checkbox or a client that passed the Perception DC). `atClock` is the world clock reading
 * that justified it, kept for the audit trail (D-004's receipt idea, applied to exploration).
 */
export function revealFeatureOps(
  scene: SceneDocument,
  key: string,
  featureId: string,
  revealed: boolean,
  opts: { atClock?: number; by?: string } = {},
): Op[] {
  const cell = cellsArray(scene).find((c) => c.key === key);
  const feature = cell?.features?.find((f) => f.id === featureId);
  if (!cell || !feature) return [];
  if (feature.state.revealed === revealed) return [];
  const state: CellFeature["state"] = revealed
    ? {
        revealed: true,
        ...(typeof opts.atClock === "number"
          ? { atClock: Math.trunc(opts.atClock) }
          : {}),
        ...(opts.by ? { by: opts.by } : {}),
      }
    : { revealed: false };
  return patchFeatureOps(scene, key, featureId, { state });
}

// ─── travel (route + party token) ────────────────────────────────────────────

/**
 * Commit a route. The party token is assigned here too, because a route with no party is not
 * something the GM can do anything with — the two always change together.
 */
export function setTravelRouteOps(
  scene: SceneDocument,
  path: string[],
  opts: {
    partyTokenId?: string | null;
    speedPerDay?: number;
    pace?: TravelPace;
  } = {},
): Op[] {
  const current = profileOf(scene);
  const clean = dedupeAdjacent(path).slice(0, MAX_TRAVEL_PATH);
  const travel: TravelPlan | null =
    clean.length >= 2
      ? {
          path: clean,
          cursor: 0,
          progressSeconds: 0,
          speedPerDay: clampNum(
            opts.speedPerDay ?? current.travel?.speedPerDay ?? 24,
            MIN_SPEED_PER_DAY,
            MAX_SPEED_PER_DAY,
          ),
          pace: opts.pace ?? current.travel?.pace ?? "normal",
        }
      : null;
  return patchHexcrawlOps(scene, {
    travel,
    ...(opts.partyTokenId !== undefined
      ? { partyTokenId: opts.partyTokenId }
      : {}),
  });
}

/** Drop a route the party never finished (a GM cancelling a march). */
export function clearTravelOps(scene: SceneDocument): Op[] {
  return patchHexcrawlOps(scene, { travel: null });
}

/** Adjacent duplicates in a clicked path are noise: one click can land twice on the same cell. */
export function dedupeAdjacent(path: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of path) {
    if (out.length > 0 && out[out.length - 1] === key) continue;
    out.push(key);
  }
  return out;
}

/** Re-export for the UI: the plan's normalized reader (bounds + types already applied). */
export { readTravelPlan };

/**
 * A party token: a normal token whose only special fact is the flag the model reads
 * (`flags.core.party`). Core cannot call the app's `makeToken` (app → core is the dependency
 * direction), so the literal lives here next to `partyTokenOf`, which finds it again.
 */
export function newPartyTokenDoc(
  id: string,
  x: number,
  y: number,
  name = "Party",
): TokenDocument {
  return {
    _id: id,
    type: "token",
    name,
    ownership: { default: 3 },
    flags: { core: { party: true } },
    system: {},
    x,
    y,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "friendly",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  };
}

export interface NewHexcrawlSceneInput {
  /** Document id for the new scene (`scene-xxxx`); the caller makes it unique. */
  id: string;
  name: string;
  width: number;
  height: number;
  grid: SceneGrid;
  /** The map asset, when the wizard uploaded one (a world asset hash). */
  img?: string | null;
  /** The scenes to deactivate when the new one is activated (`activate: true`). */
  scenes?: readonly SceneDocument[];
  /** Make the new scene the active one — the GM lands on the map they just made. */
  activate?: boolean;
  /** The world's `settings` documents — so the first hexcrawl scene installs the terrain catalog. */
  settingsDocs?: Iterable<unknown>;
}

/**
 * The first half of the "New hexcrawl scene" wizard's submit: the scene itself, whoever is
 * leaving it, and (once per world) the terrain catalog setting.
 *
 * **Why this is two functions and not one envelope.** The host validates an intent against the
 * store *as it stands* before it commits anything (`HostSync.validateOps` resolves parents and
 * targets up front), so an op that references a document created by an op beside it is refused
 * with `invalid_schema: create: parent not found`. A scene and its own party token therefore
 * cannot travel together: batch 1 creates the scene, and `newHexcrawlPartyOps` — submitted once
 * the create has committed — puts the token on it and enables the profile. The wizard waits for
 * the commit rather than guessing at a delay, and a rejected batch reports the host's own words.
 */
export function newHexcrawlSceneOps(input: NewHexcrawlSceneInput): Op[] {
  const activate = input.activate === true;
  const scene: SceneDocument = {
    _id: input.id,
    type: "scene",
    name: input.name,
    ownership: { default: 1 },
    flags: {},
    system: {},
    active: activate,
    img: input.img ?? null,
    width: Math.max(1, Math.round(input.width)),
    height: Math.max(1, Math.round(input.height)),
    darkness: 0,
    grid: { ...input.grid },
    tokens: [],
    walls: [],
    lights: [],
    drawings: [],
    templates: [],
    notes: [],
    tiles: [],
    sounds: [],
  };

  const ops: Op[] = [{ kind: "create", coll: "scenes", data: scene }];

  // Landing on the new map also means leaving the old one — but only a scene that *was* active
  // is written, so a quiet nav click never spends an op on a scene nobody was looking at.
  if (activate) {
    for (const other of input.scenes ?? []) {
      if (other._id === input.id || other.active !== true) continue;
      ops.push({
        kind: "update",
        ref: { coll: "scenes", id: other._id },
        diff: { active: false },
      });
    }
  }

  if (input.settingsDocs) {
    // The terrain catalog is world data, installed the first time a world gets a hexcrawl scene.
    // An existing catalog — a GM's own prices — is never overwritten by a new scene, so the key is
    // *checked* rather than written and compared: `worldSettingsOps` compares by reference, and a
    // freshly serialized ladder is never the same object as the one already stored.
    const docs = [...input.settingsDocs];
    if (worldSettingsFrom(docs)["hexTerrain"] === undefined) {
      ops.push(
        ...worldSettingsOps(docs, { hexTerrain: catalogToJson(PF1E_TERRAIN_CATALOG) }),
      );
    }
  }

  return ops;
}

export interface NewHexcrawlPartyInput {
  /** Profile overrides (sight, encounter mode, daylight, speed per day…). */
  profile?: Partial<HexcrawlProfile>;
  /** The wizard's last step: create the party token at the map's centre. */
  party?: { name?: string } | null;
}

/**
 * The second half: enable the profile on a scene that now exists, and optionally create the party
 * token it names. Both ops reference the scene, so both belong after the create has committed —
 * see `newHexcrawlSceneOps` for the host rule that forces the split.
 */
export function newHexcrawlPartyOps(
  scene: SceneDocument,
  input: NewHexcrawlPartyInput = {},
): Op[] {
  const ops: Op[] = [];
  const party = input.party
    ? newPartyTokenDoc(
        `t-${scene._id.replace(/^scene-?/, "")}-party`,
        Math.round((scene.width ?? 0) / 2),
        Math.round((scene.height ?? 0) / 2),
        input.party.name?.trim() || "Party",
      )
    : null;
  if (party) {
    ops.push({
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: scene._id },
      data: party,
    });
  }
  ops.push(
    ...enableHexcrawlOps(scene, {
      ...input.profile,
      ...(party ? { partyTokenId: party._id } : {}),
    }),
  );
  return ops;
}
