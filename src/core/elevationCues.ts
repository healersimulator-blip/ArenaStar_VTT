/**
 * G-32 (D-440), D-452: elevation cues on tokens. A label under each token gives its height
 * difference. The GM reads it from the ground (elevation 0). A player reads it from their own token
 * (`elevationViewer`: the selected token, else the followed one, else their first token), else
 * from the floor they look at. An optional cue (Levels T9) draws tokens at other heights smaller
 * than the viewer's own token. Pure presentation: nothing here changes movement, sight, light or fog.
 */
import type { ActorDocument, SceneDocument, TokenDocument } from "./documents";
import type { PermissionUser } from "./ownership";
import { inElevationBand } from "./multilevelGeometry";
import { userControlsToken } from "./fogExploration";
import type { CoreWorldSettings } from "./worldSettings";

/** Who sees elevation cues: everyone (default), the GM only, or nobody. */
export type TokenElevationMode = "all" | "gm" | "off";
export interface ElevationCue {
  /** Label text under the token, e.g. `+15 ft`; null draws no label. */
  label: string | null;
  /** Artwork scale about the token centre, 0.5–1. */
  scale: number;
}
export const MIN_ELEVATION_SCALE = 0.5;

export function tokenElevationModeOf(settings: CoreWorldSettings): TokenElevationMode {
  const v = settings.tokenElevation;
  return v === "gm" || v === "off" ? v : "all";
}
export function tokenElevationScaleOf(settings: CoreWorldSettings): boolean {
  return settings.tokenElevationScale === true;
}

/**
 * Height above the floor the token stands on: its level's floor, or the floor of the band its feet
 * are in, or 0 in a scene without floors. This was D-440's label. D-452 labels measure from the
 * ground (GM) or the viewer's own token (players) instead, and this stays for floor-relative readouts.
 */
export function heightAboveFloor(scene: Pick<SceneDocument, "levels">, token: Pick<TokenDocument, "elevation" | "levelId">): number {
  const z = token.elevation ?? 0;
  const levels = scene.levels ?? [];
  const level = token.levelId !== undefined ? levels.find((l) => l._id === token.levelId) : levels.find((l) => inElevationBand(l, z));
  const h = Math.round((z - (level?.floorZ ?? 0)) * 100) / 100;
  return h === 0 ? 0 : h;
}
export function elevationLabel(height: number, units: string): string | null {
  if (!Number.isFinite(height) || height === 0) return null;
  return `${height > 0 ? "+" : "-"}${Math.abs(height)}${units ? ` ${units}` : ""}`;
}
/** D-452: a height difference rounded to 0.01, never -0. */
export function elevationDifference(elevation: number | undefined, reference: number): number {
  const z = typeof elevation === "number" && Number.isFinite(elevation) ? elevation : 0;
  const h = Math.round((z - reference) * 100) / 100;
  return h === 0 ? 0 : h;
}
/**
 * D-452: what labels measure from. The GM measures from the ground (0). A player measures from
 * their own token, else from the floor they look at (`floorZ`, 0 in a flat scene).
 */
export function elevationReference(options: { isGm: boolean; viewer: Pick<TokenDocument, "elevation"> | null; floorZ?: number | null }): number {
  if (options.isGm) return 0;
  const own = options.viewer?.elevation;
  if (options.viewer) return typeof own === "number" && Number.isFinite(own) ? own : 0;
  return typeof options.floorZ === "number" && Number.isFinite(options.floorZ) ? options.floorZ : 0;
}
/** Smaller with height difference: ×0.83 at two 5 ft cells, ×0.5 from ten cells. */
export function elevationScale(difference: number, distance: number): number {
  const cell = Number.isFinite(distance) && distance > 0 ? distance : 5;
  const s = 1 / (1 + Math.abs(difference) / (10 * cell));
  return Math.round(Math.max(MIN_ELEVATION_SCALE, Math.min(1, s)) * 1000) / 1000;
}

/**
 * The viewer's own token: the first selected token they control, else the token their floor
 * follows. D-452: a player with neither falls back to their first token with vision, else their
 * first token, in scene order, so labels always read from somewhere. The GM never falls back.
 */
export function elevationViewer(scene: SceneDocument, user: PermissionUser | null, actors: readonly ActorDocument[],
  selection: readonly string[], followTokenId?: string | null): TokenDocument | null {
  if (!user) return null;
  const controlled = (id: string | null | undefined) => {
    const token = id ? scene.tokens.find((t) => t._id === id) : undefined;
    return token && userControlsToken(user, token, scene, actors) ? token : null;
  };
  for (const id of selection) { const token = controlled(id); if (token) return token; }
  const followed = controlled(followTokenId);
  if (followed || user.role === "GM" || user.role === "ASSISTANT") return followed;
  const own = scene.tokens.filter((t) => userControlsToken(user, t, scene, actors));
  return own.find((t) => t.vision) ?? own[0] ?? null;
}

/**
 * Cues for the tokens this canvas draws. Sparse: tokens at the reference height (D-452) and the
 * viewer's own height get no entry. `gm` mode hides every cue from players, the scale included,
 * because a smaller token gives the height away just as a label would.
 */
export function elevationCues(scene: SceneDocument, tokens: readonly TokenDocument[], options: {
  mode: TokenElevationMode; scaleByHeight: boolean; isGm: boolean; viewer: TokenDocument | null;
  /** D-443: an isolated player floor's Z, the reference when the player has no token here. Players have no `levels` to look it up in. */
  floorZ?: number | null;
}): Map<string, ElevationCue> {
  const cues = new Map<string, ElevationCue>();
  if (options.mode === "off" || (options.mode === "gm" && !options.isGm)) return cues;
  const units = scene.grid?.units ?? "";
  const viewer = options.scaleByHeight ? options.viewer : null;
  const reference = elevationReference(options);
  for (const token of tokens) {
    const label = elevationLabel(elevationDifference(token.elevation, reference), units);
    const scale = viewer && token._id !== viewer._id ? elevationScale((token.elevation ?? 0) - (viewer.elevation ?? 0), scene.grid?.distance ?? 5) : 1;
    if (label !== null || scale !== 1) cues.set(token._id, { label, scale });
  }
  return cues;
}

/** D-452: labels for tokens seen on floors below, read the same way as `elevationCues` (never scaled). */
export function lowerTokenLabels(scene: SceneDocument, tokens: readonly TokenDocument[], options: {
  mode: TokenElevationMode; isGm: boolean; viewer: TokenDocument | null; floorZ?: number | null;
}): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, cue] of elevationCues(scene, tokens, { ...options, scaleByHeight: false })) if (cue.label) out.set(id, cue.label);
  return out;
}
