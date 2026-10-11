/**
 * G-32 (D-440): elevation cues on tokens. A badge shows a token's height above its floor, and an
 * optional cue (Levels T9) draws tokens at other heights smaller than the viewer's own token.
 * Pure presentation: nothing here changes movement, sight, light or fog.
 */
import type { ActorDocument, SceneDocument, TokenDocument } from "./documents";
import type { PermissionUser } from "./ownership";
import { inElevationBand } from "./multilevelGeometry";
import { userControlsToken } from "./fogExploration";
import type { CoreWorldSettings } from "./worldSettings";

/** Who sees elevation cues: everyone (default), the GM only, or nobody. */
export type TokenElevationMode = "all" | "gm" | "off";
export interface ElevationCue {
  /** Badge text, e.g. `+15 ft`; null draws no badge. */
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
 * are in, or 0 in a scene without floors. This is what matters at the table ("flying 15 ft up"),
 * and it stays meaningful on every floor of a tower.
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
/** Smaller with height difference: ×0.83 at two 5 ft cells, ×0.5 from ten cells. */
export function elevationScale(difference: number, distance: number): number {
  const cell = Number.isFinite(distance) && distance > 0 ? distance : 5;
  const s = 1 / (1 + Math.abs(difference) / (10 * cell));
  return Math.round(Math.max(MIN_ELEVATION_SCALE, Math.min(1, s)) * 1000) / 1000;
}

/** The viewer's own token: the first selected token they control, else the token their floor follows. */
export function elevationViewer(scene: SceneDocument, user: PermissionUser | null, actors: readonly ActorDocument[],
  selection: readonly string[], followTokenId?: string | null): TokenDocument | null {
  if (!user) return null;
  const controlled = (id: string | null | undefined) => {
    const token = id ? scene.tokens.find((t) => t._id === id) : undefined;
    return token && userControlsToken(user, token, scene, actors) ? token : null;
  };
  for (const id of selection) { const token = controlled(id); if (token) return token; }
  return controlled(followTokenId);
}

/**
 * Cues for the tokens this canvas draws. Sparse: tokens on their floor and at the viewer's height
 * get no entry. `gm` mode hides every cue from players, the scale included, because a smaller
 * token gives the height away just as a badge would.
 */
export function elevationCues(scene: SceneDocument, tokens: readonly TokenDocument[], options: {
  mode: TokenElevationMode; scaleByHeight: boolean; isGm: boolean; viewer: TokenDocument | null;
}): Map<string, ElevationCue> {
  const cues = new Map<string, ElevationCue>();
  if (options.mode === "off" || (options.mode === "gm" && !options.isGm)) return cues;
  const units = scene.grid?.units ?? "";
  const viewer = options.scaleByHeight ? options.viewer : null;
  for (const token of tokens) {
    const label = elevationLabel(heightAboveFloor(scene, token), units);
    const scale = viewer && token._id !== viewer._id ? elevationScale((token.elevation ?? 0) - (viewer.elevation ?? 0), scene.grid?.distance ?? 5) : 1;
    if (label !== null || scale !== 1) cues.set(token._id, { label, scale });
  }
  return cues;
}
