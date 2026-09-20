/**
 * §9 explored fog — the pure half (D-250). What a scene's fog setting means, whose tokens
 * reveal for a given viewer, how far they see, and the dedupe key that keeps the reveal loop
 * from recomputing polygons nothing moved. `src/client/fogExploration.ts` drives a fog
 * surface with these; the Settings scene editor writes the flags with `fogSettingsOps`.
 *
 * Model: fog is a per-scene switch (`flags.core.fog === true`, off by default so no existing
 * scene changes). Every user keeps their OWN explored map per scene (§8 key
 * [worldId, sceneId, userId]) — a player reveals with the tokens they control; the GM's map
 * accumulates every vision token, so with god view off it shows the union of what the table
 * has seen. Sight is bounded by sight-blocking walls (`wallSight`) and, optionally, a range
 * in grid squares (`flags.core.fogRange`; absent/0 = the whole scene). Darkness and light
 * sources do not shorten exploration yet (ROADMAP).
 *
 * Fog also decides what a player is shown (D-251): their own tokens always; any other token
 * only while it stands inside one of their current sight polygons (`fogVisibleTokenIds`). The
 * GM is never gated — the GM's cover is drawn translucent instead.
 */
import type {
  ActorDocument,
  BaseDocument,
  Json,
  SceneDocument,
  TokenDocument,
} from "./documents";
import type { Op } from "./ops";
import type { PermissionUser } from "./ownership";
import { can } from "./permissions";
import { fogMaskLog, pointInFogMask } from "./fogMask";
import { pointInPolygon } from "../canvas/vision/polygon";

export interface FogSettings {
  enabled: boolean;
  /** Sight range in grid squares; null = unbounded (walls only). */
  rangeSquares: number | null;
}

interface CoreFlags {
  core?: { fog?: unknown; fogRange?: unknown };
}

/** Read the scene's fog flags (absent → off, whole scene). */
export function sceneFogSettings(scene: BaseDocument | null | undefined): FogSettings {
  const core = (scene?.flags as CoreFlags | undefined)?.core;
  const range = core?.fogRange;
  return {
    enabled: core?.fog === true,
    rangeSquares:
      typeof range === "number" && Number.isFinite(range) && range > 0 ? range : null,
  };
}

/**
 * The whole-object `flags` update that turns fog on/off or sets its range (FlatDiff cannot
 * create missing intermediates, D-012 — same shape as the D-080 scale flag). Range 0/null
 * clears the key.
 */
export function fogSettingsOps(scene: SceneDocument, next: FogSettings): Op[] {
  const flags = scene.flags;
  const existing = flags["core"];
  const core: Record<string, Json> = {
    ...(existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {}),
  };
  if (next.enabled) core["fog"] = true;
  else delete core["fog"];
  if (next.rangeSquares !== null && next.rangeSquares > 0) core["fogRange"] = next.rangeSquares;
  else delete core["fogRange"];
  return [
    {
      kind: "update",
      ref: { coll: "scenes", id: scene._id },
      diff: { flags: { ...flags, core } },
    },
  ];
}

/** A vision origin: one token's centre. */
export interface FogViewer {
  tokenId: string;
  x: number;
  y: number;
}

export interface FogViewerContext {
  /** Actors, for tokens whose ownership lives on the linked actor. */
  actors?: readonly ActorDocument[];
}

/**
 * Whose eyes reveal for `user` on `scene`: tokens with `vision` that the user controls —
 * GM/ASSISTANT control every token (their map is the table's union); a player controls a
 * token they own outright (token ownership, scene cascade) or through its actor.
 */
export function fogViewers(
  scene: SceneDocument,
  user: PermissionUser | null,
  context: FogViewerContext = {},
): FogViewer[] {
  if (!user) return [];
  const out: FogViewer[] = [];
  for (const token of scene.tokens) {
    if (!token.vision) continue;
    if (!controlsToken(user, token, scene, context.actors ?? [])) continue;
    out.push({ tokenId: token._id, x: token.x, y: token.y });
  }
  return out;
}

function controlsToken(
  user: PermissionUser,
  token: TokenDocument,
  scene: SceneDocument,
  actors: readonly ActorDocument[],
): boolean {
  if (can(user, "update", token, "tokens", { parent: scene })) return true;
  if (!token.actorId) return false;
  const actor = actors.find((a) => a._id === token.actorId);
  return actor !== undefined && can(user, "update", actor, "actors");
}

/**
 * Is any part of the token in sight? The centre and four points a quarter of the footprint
 * in from the corners are tested against every current polygon, so a token half behind a
 * corner still shows while one fully around it does not.
 */
export function tokenInSight(
  token: Pick<TokenDocument, "x" | "y" | "width" | "height">,
  polys: readonly Float32Array[],
): boolean {
  if (polys.length === 0) return false;
  const dx = Math.max(0, token.width) / 4;
  const dy = Math.max(0, token.height) / 4;
  const probes: ReadonlyArray<readonly [number, number]> = [
    [token.x, token.y],
    [token.x - dx, token.y - dy],
    [token.x + dx, token.y - dy],
    [token.x - dx, token.y + dy],
    [token.x + dx, token.y + dy],
  ];
  for (const poly of polys) {
    if (poly.length < 6) continue;
    for (const [px, py] of probes) if (pointInPolygon(poly, px, py)) return true;
  }
  return false;
}

/**
 * D-256: the tokens the GM's manual Hide/Reveal mask covers, for one user. Roll20's Mask is
 * *static* — it hides whatever the GM painted over and no amount of vision paints it away — so
 * it is a filter on top of sight, not part of it. The one exception is the tokens a player
 * controls: the mask never swallows a player's own mini, which is also what makes a player
 * walked under the cover still able to move.
 *
 * The probe is the token's centre — the grid cell it stands in — so a token straddling a mask
 * edge keeps showing, mirroring `tokenInSight`'s rule for a token half behind a wall. GM and
 * ASSISTANT are never gated (the mask is drawn translucent for them, everything visible).
 */
export function maskHiddenTokenIds(
  scene: SceneDocument,
  user: PermissionUser | null,
  context: FogViewerContext = {},
): Set<string> {
  const out = new Set<string>();
  if (!user || user.role === "GM" || user.role === "ASSISTANT") return out;
  const log = fogMaskLog(scene);
  if (log.length === 0) return out;
  const actors = context.actors ?? [];
  for (const token of scene.tokens) {
    if (controlsToken(user, token, scene, actors)) continue;
    if (pointInFogMask(log, token.x, token.y)) out.add(token._id);
  }
  return out;
}

/**
 * D-251: which tokens a user is shown on a fogged scene — the ones they control, always
 * (they are the eyes), and any other only while `tokenInSight` of the user's current
 * polygons. GM/ASSISTANT see everything. Tokens the host already withheld (`hidden`) never
 * reach a player's replica in the first place (§5 projection).
 *
 * D-256 layers the GM's manual mask on top: a token standing in a hidden stroke is withheld
 * however clear the line of sight is.
 */
export function fogVisibleTokenIds(
  scene: SceneDocument,
  user: PermissionUser | null,
  polys: readonly Float32Array[],
  context: FogViewerContext = {},
): Set<string> {
  const out = new Set<string>();
  if (!user) return out;
  const actors = context.actors ?? [];
  const masked = maskHiddenTokenIds(scene, user, context);
  for (const token of scene.tokens) {
    if (user.role === "GM" || user.role === "ASSISTANT") {
      out.add(token._id);
      continue;
    }
    if (controlsToken(user, token, scene, actors)) {
      out.add(token._id);
      continue;
    }
    if (masked.has(token._id)) continue;
    if (tokenInSight(token, polys)) out.add(token._id);
  }
  return out;
}

/**
 * How far a viewer sees, in scene pixels: the configured range × grid size, else the scene
 * diagonal (the visibility sweep must always be capped for a finite scene — see
 * `visibilityPolygon`).
 */
export function fogSightRadius(scene: SceneDocument, settings: FogSettings): number {
  const diagonal = Math.hypot(Math.max(1, scene.width), Math.max(1, scene.height));
  if (settings.rangeSquares === null) return diagonal;
  const cell = scene.grid.size > 0 ? scene.grid.size : 100;
  return Math.min(diagonal, settings.rangeSquares * cell);
}

/**
 * Dedupe key for a reveal pass: viewer positions (rounded to the pixel), the sight-relevant
 * wall state (geometry, sight restriction, door state — an opening door changes what is
 * seen) and the radius. Equal keys mean the polygons would come out identical.
 */
export function fogRevealKey(
  scene: SceneDocument,
  viewers: readonly FogViewer[],
  radius: number,
): string {
  const eyes = viewers
    .map((v) => `${v.tokenId}@${Math.round(v.x)},${Math.round(v.y)}`)
    .sort()
    .join(";");
  const walls = scene.walls
    .map((w) => `${w._id}:${w.c.join(",")}:${w.sight}:${w.door}`)
    .join(";");
  return `${scene._id}|${Math.round(radius)}|${eyes}|${walls}`;
}

/** Flat [x1,y1,x2,y2,…] quads for the vision worker (transferable-friendly). */
export function flatSegments(
  segments: readonly { x1: number; y1: number; x2: number; y2: number }[],
): Float32Array {
  const flat = new Float32Array(segments.length * 4);
  segments.forEach((s, i) => {
    flat[i * 4] = s.x1;
    flat[i * 4 + 1] = s.y1;
    flat[i * 4 + 2] = s.x2;
    flat[i * 4 + 3] = s.y2;
  });
  return flat;
}

/** Upper bound on one stored fog PNG (a 512-px mask is a few KB; this is a sanity cap, §16). */
export const MAX_FOG_PNG_BYTES = 1024 * 1024;
