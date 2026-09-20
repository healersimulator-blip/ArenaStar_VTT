/**
 * §10 GM fog mask — the manual Hide/Reveal brushes (D-256).
 *
 * Roll20's Hide/Reveal Mask is *manual*: the GM paints cover over the map and paints it away
 * again, and no amount of token vision re-reveals what the GM has hidden. Our explored fog
 * (D-250) is the opposite — it accumulates from sight — so the manual brush cannot live in
 * the per-user explored texture. It is a scene-level, ordered paint log instead:
 *
 *   [{ mode: "hide", poly }, { mode: "reveal", poly }, …]
 *
 * Every client replays the log onto its own fog layer (hide paints cover, reveal erases
 * cover *and* the explored cover underneath), which makes the result identical for the GM
 * and for every player, survives a reload because the log is a replicated scene flag, and
 * gives later operations priority over earlier ones — exactly how a brush behaves.
 *
 * The log is bounded (`FOG_MASK_MAX_OPS`); a full-scene "hide all" / "reveal all" is
 * `null` (no mask) and the whole-scene rectangle respectively, both of which the rail's
 * buttons emit, so the bound never blocks the everyday brushes.
 */
import type { BaseDocument, Json, SceneDocument } from "./documents";
import type { Op } from "./ops";
import { pointInPolygon } from "../canvas/vision/polygon";

export type FogMaskMode = "reveal" | "hide";

export interface FogMaskOp {
  mode: FogMaskMode;
  /** Flat world-space polygon [x1,y1,x2,y2,…]. */
  poly: number[];
}

/** How many paint operations one scene may carry (≈ a long session of brushing). */
export const FOG_MASK_MAX_OPS = 512;

interface CoreFlags {
  core?: { fogMask?: unknown };
}

function isOp(value: unknown): value is FogMaskOp {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { mode?: unknown; poly?: unknown };
  if (record.mode !== "reveal" && record.mode !== "hide") return false;
  const poly = record.poly;
  if (!Array.isArray(poly) || poly.length < 6 || poly.length % 2 !== 0) return false;
  return poly.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** The scene's mask log (a malformed flag reads as empty — never throws on data). */
export function fogMaskLog(scene: BaseDocument | null | undefined): FogMaskOp[] {
  const raw = (scene?.flags as CoreFlags | undefined)?.core?.fogMask;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isOp).map((op) => ({ mode: op.mode, poly: [...op.poly] }));
}

/**
 * The whole-object `flags` update that writes the log (FlatDiff cannot create missing
 * intermediates, D-012 — the same shape as the fog settings and war-scale flags).
 */
export function fogMaskOps(scene: SceneDocument, log: readonly FogMaskOp[]): Op[] {
  const flags = scene.flags;
  const existing = flags["core"];
  const core: Record<string, Json> = {
    ...(existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {}),
  };
  if (log.length === 0) delete core["fogMask"];
  else core["fogMask"] = log.map((op) => ({ mode: op.mode, poly: [...op.poly] })) as unknown as Json;
  return [
    { kind: "update", ref: { coll: "scenes", id: scene._id }, diff: { flags: { ...flags, core } } },
  ];
}

/** Append one brush stroke, dropping the oldest strokes when the bound is reached. */
export function appendFogMask(
  log: readonly FogMaskOp[],
  op: FogMaskOp,
  limit = FOG_MASK_MAX_OPS,
): FogMaskOp[] {
  const next = [...log.map((o) => ({ mode: o.mode, poly: [...o.poly] })), { mode: op.mode, poly: [...op.poly] }];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Whole-scene rect for "hide all" / "reveal all". */
export function sceneRectPoly(scene: { width: number; height: number }): number[] {
  return [0, 0, scene.width, 0, scene.width, scene.height, 0, scene.height];
}

/** Hide strokes in order (the two lists are what a fog layer replays). */
export function fogMaskPolys(log: readonly FogMaskOp[], mode: FogMaskMode): number[][] {
  return log.filter((op) => op.mode === mode).map((op) => op.poly);
}

/**
 * Is this world point manually hidden? Later strokes win, so the point is hidden when the
 * last stroke covering it is a hide. Used to withhold tokens that stand inside a manual
 * cover (Roll20 hides everything under the mask except tokens a player controls).
 */
export function pointInFogMask(log: readonly FogMaskOp[], x: number, y: number): boolean {
  let hidden = false;
  for (const op of log) {
    if (op.poly.length < 6) continue;
    if (pointInPolygon(Float32Array.from(op.poly), x, y)) hidden = op.mode === "hide";
  }
  return hidden;
}
