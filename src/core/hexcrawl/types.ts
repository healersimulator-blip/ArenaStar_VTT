/**
 * **Hexcrawl scenes — the flag profile (D-269, plan §3.1).**
 *
 * A hexcrawl scene is a scene *profile*, not a new document kind: the scene keeps its map
 * image, its `SceneGrid` (which already offers `square | hex | gridless`), its tokens, walls
 * and fog, and gains one flag block, `flags.core.hexcrawl`. **The flag's presence is the
 * switch**, exactly like `flags.core.fog === true` (D-250), so no existing scene changes
 * behaviour and a table can turn the feature off by removing the flag.
 *
 * Everything in the profile is data a GM edits, and every write goes through `scene.ts`'s op
 * builders, so hexcrawl state inherits the op log, undo, sync, projection and the world file.
 *
 * Time is **not** in this profile: there is one integral clock (`core/clock.ts`, D-268) and the
 * only hexcrawl opinion about it is the day/night window (`daylight`).
 */
import type { Daylight } from "../clock";
import { DEFAULT_DAYLIGHT } from "../clock";
import type { SceneDocument } from "../documents";

/** The scene flag key: `flags.core.hexcrawl`. */
export const HEXCRAWL_FLAG = "hexcrawl";

/** Written so a later slice can migrate the profile instead of guessing (plan §3.1). */
export const HEXCRAWL_VERSION = 1;

/**
 * Who the closed cells are closed *for*:
 * - `"gm"` — the GM opens cells by hand (a published hex map with a printed key);
 * - `"gm+party"` — the party's own sight ring adds to the open set every time it moves.
 */
export type HexcrawlSightMode = "gm" | "gm+party";

/** What happens when a trigger fires (plan §3.1, requirement 5a). */
export type EncounterMode = "auto" | "prompt" | "manual";

/** Whether a public encounter card names the rolled entry (D-273, plan §6 output rule). */
export type EncounterAnnounce = "names" | "hidden";

/** `normal` walks; `forced` is the longer day a party gets by marching past its rest. */
export type TravelPace = "normal" | "forced";

export interface HexcrawlSight {
  mode: HexcrawlSightMode;
  /** Cells around the party token that the party can see (0 = only its own cell). */
  radiusCells: number;
  /** The same idea on a gridless map, where a ring is a distance: world units. */
  radiusWorldUnits: number;
}

export interface TravelPlan {
  /** Cell keys from the first step to the destination; the party starts on `path[cursor]`. */
  path: string[];
  /** Index into `path` the party currently occupies. */
  cursor: number;
  /** Seconds already spent walking *towards* `path[cursor + 1]`. */
  progressSeconds: number;
  /** Grid units (miles on an overland map) the party covers in a day of normal travel. */
  speedPerDay: number;
  pace: TravelPace;
}

export interface HexcrawlProfile {
  version: typeof HEXCRAWL_VERSION;
  /** The open cells — the set the GM (and the party's ring) has revealed. */
  revealed: string[];
  sight: HexcrawlSight;
  /** The token the party walks with; one party per scene. */
  partyTokenId: string | null;
  encounterMode: EncounterMode;
  /**
   * What a **public** encounter card reveals (D-273). `names` = the entry's text, count and refs;
   * `hidden` = "something happens here" only, and the payload's text/refs are *absent* rather than
   * blanked, because a document a player receives is a document a player can read. A GM card
   * always carries the names, whatever this says.
   */
  encounterAnnounce: EncounterAnnounce;
  /** Day/night window in hours of the one clock; equal hours = the sun never sets. */
  daylight: Daylight;
  /** Terrain catalog id (a world setting, `core/hexcrawl/terrain.ts`). */
  terrain: string;
  /** The committed route, or null when the party is standing still. */
  travel: TravelPlan | null;
}

/** A party that walks all day covers a normal day's march (24 miles on a 24-mile-a-day map). */
export const DEFAULT_SPEED_PER_DAY = 24;

export const DEFAULT_HEXCRAWL_PROFILE: HexcrawlProfile = {
  version: HEXCRAWL_VERSION,
  revealed: [],
  sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
  partyTokenId: null,
  encounterMode: "prompt",
  encounterAnnounce: "names",
  daylight: DEFAULT_DAYLIGHT,
  terrain: "pf1e-overland",
  travel: null,
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asInt = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;

const asNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

const asHour = (value: unknown, fallback: number): number =>
  asNumber(value, fallback, 0, 24);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/** The profile as stored on the scene, or null when this scene is not a hexcrawl scene. */
export function rawHexcrawlFlag(
  scene: SceneDocument | { flags?: unknown } | null | undefined,
): Record<string, unknown> | null {
  const core = asRecord(asRecord(scene?.flags)?.["core"]);
  return asRecord(core?.[HEXCRAWL_FLAG]);
}

/** Is this a hexcrawl scene at all? (The flag's presence is the switch.) */
export function isHexcrawlScene(
  scene: SceneDocument | { flags?: unknown } | null | undefined,
): boolean {
  return rawHexcrawlFlag(scene) !== null;
}

/**
 * The profile a reader should use: defaults filled in, unknown keys ignored, out-of-range
 * numbers clamped. Tolerant on purpose — a world file written by a later slice (or by a GM
 * hand-editing `flags`) must degrade to *something playable* here rather than throw in the
 * canvas, and every default is the documented one.
 */
export function hexcrawlProfileOf(
  scene: SceneDocument | { flags?: unknown } | null | undefined,
): HexcrawlProfile | null {
  const raw = rawHexcrawlFlag(scene);
  if (!raw) return null;
  const sight = asRecord(raw["sight"]);
  const daylight = asRecord(raw["daylight"]);
  const travel = asRecord(raw["travel"]);
  const base = DEFAULT_HEXCRAWL_PROFILE;
  return {
    version: HEXCRAWL_VERSION,
    revealed: asStringArray(raw["revealed"]).slice(0, MAX_REVEALED_CELLS),
    sight: {
      mode: sight?.["mode"] === "gm+party" ? "gm+party" : "gm",
      radiusCells: asInt(
        sight?.["radiusCells"],
        base.sight.radiusCells,
        0,
        MAX_SIGHT_RADIUS,
      ),
      radiusWorldUnits: asInt(
        sight?.["radiusWorldUnits"],
        base.sight.radiusWorldUnits,
        0,
        MAX_SIGHT_WORLD_UNITS,
      ),
    },
    partyTokenId:
      typeof raw["partyTokenId"] === "string" && raw["partyTokenId"] !== ""
        ? raw["partyTokenId"]
        : null,
    encounterMode:
      raw["encounterMode"] === "auto" || raw["encounterMode"] === "manual"
        ? raw["encounterMode"]
        : "prompt",
    encounterAnnounce: raw["encounterAnnounce"] === "hidden" ? "hidden" : "names",
    daylight: {
      dawnHour: asHour(daylight?.["dawnHour"], base.daylight.dawnHour),
      duskHour: asHour(daylight?.["duskHour"], base.daylight.duskHour),
    },
    terrain:
      typeof raw["terrain"] === "string" && raw["terrain"] !== ""
        ? raw["terrain"]
        : base.terrain,
    travel: travel ? readTravelPlan(travel) : null,
  };
}

/** Bounds, all of them about keeping one flag document small and one ring cheap to draw. */
export const MAX_REVEALED_CELLS = 20_000;
export const MAX_SIGHT_RADIUS = 12;
export const MAX_SIGHT_WORLD_UNITS = 100_000;
export const MAX_TRAVEL_PATH = 512;
export const MIN_SPEED_PER_DAY = 1;
export const MAX_SPEED_PER_DAY = 240;

/** Read a travel plan out of the flag (null when it is not a usable route). */
export function readTravelPlan(
  raw: Record<string, unknown>,
): TravelPlan | null {
  const path = asStringArray(raw["path"]).slice(0, MAX_TRAVEL_PATH);
  if (path.length < 2) return null;
  const cursor = asInt(raw["cursor"], 0, 0, path.length - 1);
  return {
    path,
    cursor,
    progressSeconds: asInt(raw["progressSeconds"], 0, 0, 10_000_000),
    speedPerDay: asNumber(
      raw["speedPerDay"],
      DEFAULT_SPEED_PER_DAY,
      MIN_SPEED_PER_DAY,
      MAX_SPEED_PER_DAY,
    ),
    pace: raw["pace"] === "forced" ? "forced" : "normal",
  };
}

/** The party's token, if the profile names one that still exists. */
export function partyTokenOf(
  scene: SceneDocument | { flags?: unknown } | null | undefined,
): string | null {
  const profile = hexcrawlProfileOf(scene);
  if (!profile?.partyTokenId) return null;
  const sceneDoc = scene as SceneDocument | null | undefined;
  const tokens = sceneDoc?.tokens ?? [];
  return tokens.some((t) => t._id === profile.partyTokenId)
    ? profile.partyTokenId
    : null;
}
