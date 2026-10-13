/**
 * Scene-level proximity LOS rules for sight passing through physical openings. This is
 * ArenaStar's documented policy model; it does not claim to duplicate Foundry's unpublished
 * attenuation curve.
 *
 * Distances and depths use the scene grid's declared distance units. Widths are full cone
 * apertures in degrees. Scene rules are opt-in so scenes written before this feature retain
 * their existing full-LOS window behavior.
 */
import type { BaseDocument, DocRef, Json, LevelDocument, SceneDocument, WallDocument } from "./documents";
import { applyDiff } from "./diff";
import type { Op } from "./ops";

export interface OpeningSightCone {
  /** Maximum distance beyond the opening, in the scene's grid units. */
  depth: number;
  /** Full angular width around the opening's outward normal, in degrees. */
  widthDeg: number;
}

export interface OpeningSightCurve {
  /** At this viewer-to-opening distance, the partial cone is used. */
  partialAt: number;
  partial: OpeningSightCone;
  /** At this closer viewer-to-opening distance, the full cone is used. */
  fullAt: number;
  full: OpeningSightCone;
}

export interface SceneOpeningSightPolicy extends OpeningSightCurve {
  enabled: boolean;
  applyTo: {
    windows: boolean;
    doors: boolean;
    apertures: boolean;
  };
}

/** Inherit is represented by the absence of a wall/level override, keeping saved data sparse. */
export type OpeningSightOverride =
  | { mode: "full" }
  | { mode: "custom"; curve: OpeningSightCurve };

export const OPENING_SIGHT_FEATURE = "proximity-opening-sight-v1";
export const MAX_OPENING_SIGHT_VALUE = 100_000;

const DEFAULT_WIDTHS = { partial: 35, full: 120 } as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const finiteInRange = (value: unknown, min: number, max = MAX_OPENING_SIGHT_VALUE): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

function sceneUnit(grid: Pick<SceneDocument["grid"], "distance"> | null | undefined): number {
  const value = grid?.distance;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_OPENING_SIGHT_VALUE
    ? value
    : 5;
}

/** Defaults shown in Scene Settings. `enabled:false` preserves legacy scenes until opted in. */
export function defaultOpeningSightPolicy(
  grid?: Pick<SceneDocument["grid"], "distance"> | null,
): SceneOpeningSightPolicy {
  const unit = sceneUnit(grid);
  return {
    enabled: false,
    applyTo: { windows: true, doors: true, apertures: true },
    partialAt: unit * 6,
    partial: { depth: unit * 2, widthDeg: DEFAULT_WIDTHS.partial },
    fullAt: unit,
    full: { depth: unit * 12, widthDeg: DEFAULT_WIDTHS.full },
  };
}

export function openingSightCurveError(value: unknown): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["partialAt", "partial", "fullAt", "full"]))
    return "Opening LOS curve must contain partialAt, partial, fullAt and full only";
  if (!finiteInRange(value.partialAt, 0) || !finiteInRange(value.fullAt, 0) || value.partialAt <= value.fullAt)
    return "Partial distance must be greater than the closer full-cone distance";
  for (const key of ["partial", "full"] as const) {
    const cone = value[key];
    if (!isRecord(cone) || !hasOnlyKeys(cone, ["depth", "widthDeg"]) ||
        !finiteInRange(cone.depth, 0) || !finiteInRange(cone.widthDeg, 1, 360))
      return `${key === "partial" ? "Partial" : "Full"} cone needs a non-negative depth and a width from 1 to 360 degrees`;
  }
  const partial = value.partial as OpeningSightCone;
  const full = value.full as OpeningSightCone;
  if (partial.depth > full.depth || partial.widthDeg > full.widthDeg)
    return "The partial cone cannot be deeper or wider than the full cone";
  return null;
}

export function openingSightPolicyError(value: unknown): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["enabled", "applyTo", "partialAt", "partial", "fullAt", "full"]))
    return "Opening LOS policy has an invalid shape";
  if (typeof value.enabled !== "boolean") return "Opening LOS enabled must be true or false";
  if (!isRecord(value.applyTo) || !hasOnlyKeys(value.applyTo, ["windows", "doors", "apertures"]) ||
      ![value.applyTo.windows, value.applyTo.doors, value.applyTo.apertures].every((flag) => typeof flag === "boolean"))
    return "Choose whether the scene rule applies to windows, doors and floor apertures";
  return openingSightCurveError({
    partialAt: value.partialAt,
    partial: value.partial,
    fullAt: value.fullAt,
    full: value.full,
  });
}

export function openingSightOverrideError(value: unknown): string | null {
  if (!isRecord(value) || typeof value.mode !== "string") return "Opening LOS override must be an object with a mode";
  if (value.mode === "full") return hasOnlyKeys(value, ["mode"]) ? null : "Full LOS override accepts only mode";
  if (value.mode === "custom") {
    if (!hasOnlyKeys(value, ["mode", "curve"])) return "Custom opening LOS override accepts only mode and curve";
    return openingSightCurveError(value.curve);
  }
  return "Opening LOS override mode must be full or custom; inherit by removing the override";
}

/**
 * Defensive read for legacy/imported scene documents. A missing or malformed setting is Off,
 * with fresh grid-relative values ready for the GM's editor.
 */
export function openingSightPolicyOf(
  scene: Pick<SceneDocument, "flags" | "grid"> | null | undefined,
): SceneOpeningSightPolicy {
  const core = scene?.flags?.["core"];
  const stored = isRecord(core) ? core["openingSight"] : undefined;
  if (openingSightPolicyError(stored)) return defaultOpeningSightPolicy(scene?.grid);
  return structuredClone(stored as unknown as SceneOpeningSightPolicy);
}

export function openingSightOverrideOf(value: unknown): OpeningSightOverride | undefined {
  return openingSightOverrideError(value) === null ? structuredClone(value as OpeningSightOverride) : undefined;
}

/** Null means not applicable yet (too far); otherwise the linearly interpolated ArenaStar cone. */
export function openingSightConeAt(
  curve: OpeningSightCurve,
  viewerDistance: number,
): OpeningSightCone | null {
  if (openingSightCurveError(curve) || !Number.isFinite(viewerDistance) || viewerDistance < 0 ||
      viewerDistance > curve.partialAt) return null;
  if (viewerDistance <= curve.fullAt) return { ...curve.full };
  const amount = (curve.partialAt - viewerDistance) / (curve.partialAt - curve.fullAt);
  return {
    depth: curve.partial.depth + (curve.full.depth - curve.partial.depth) * amount,
    widthDeg: curve.partial.widthDeg + (curve.full.widthDeg - curve.partial.widthDeg) * amount,
  };
}

export function sceneOpeningSightPolicyOp(
  scene: Pick<SceneDocument, "_id" | "flags">,
  next: SceneOpeningSightPolicy,
): Extract<Op, { kind: "update" }> {
  const error = openingSightPolicyError(next);
  if (error) throw new Error(error);
  const currentFlags = scene.flags ?? {};
  const rawCore = currentFlags["core"];
  const core: Record<string, Json> = {
    ...(isRecord(rawCore) ? rawCore as Record<string, Json> : {}),
    openingSight: structuredClone(next) as unknown as Json,
  };
  return {
    kind: "update",
    ref: { coll: "scenes", id: scene._id },
    diff: { flags: { ...currentFlags, core } as unknown as Json },
  };
}

export function wallOpeningSightOverrideOp(
  sceneId: string,
  wallId: string,
  override: OpeningSightOverride | null,
): Extract<Op, { kind: "update" }> {
  if (override !== null) {
    const error = openingSightOverrideError(override);
    if (error) throw new Error(error);
    return {
      kind: "update",
      ref: { coll: "walls", id: wallId, parent: { coll: "scenes", id: sceneId } },
      diff: { openingSightOverride: structuredClone(override) as unknown as Json },
    };
  }
  return {
    kind: "update",
    ref: { coll: "walls", id: wallId, parent: { coll: "scenes", id: sceneId } },
    diff: { "-=openingSightOverride": null },
  };
}

export function levelApertureSightOverrideOp(
  sceneId: string,
  level: Pick<LevelDocument, "_id" | "apertureSightOverrides">,
  apertureId: string,
  override: OpeningSightOverride | null,
): Extract<Op, { kind: "update" }> {
  const current = override === null
    ? Object.fromEntries(Object.entries(level.apertureSightOverrides ?? {}).filter(([id]) => id !== apertureId))
    : { ...(level.apertureSightOverrides ?? {}) };
  if (override !== null) {
    const error = openingSightOverrideError(override);
    if (error) throw new Error(error);
    current[apertureId] = structuredClone(override);
  }
  return {
    kind: "update",
    ref: { coll: "levels", id: level._id, parent: { coll: "scenes", id: sceneId } },
    diff: Object.keys(current).length
      ? { apertureSightOverrides: current as unknown as Json }
      : { "-=apertureSightOverrides": null },
  };
}

/** Keep only valid IDs and policies when validating saved per-hole overrides. */
export function apertureSightOverridesError(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).length > 128) return "Floor aperture LOS overrides must be an object with at most 128 entries";
  for (const [id, override] of Object.entries(value)) {
    if (!/^ap-[a-f0-9]{16}$/.test(id)) return "Floor aperture LOS override has an invalid stable aperture ID";
    const error = openingSightOverrideError(override);
    if (error) return `Aperture ${id}: ${error}`;
  }
  return null;
}

export function openingSightWorldDataError(scene: Partial<SceneDocument>): string | null {
  const core = scene.flags?.["core"];
  const policy = isRecord(core) ? core["openingSight"] : undefined;
  if (policy !== undefined) {
    const error = openingSightPolicyError(policy);
    if (error) return error;
  }
  for (const wall of scene.walls ?? []) {
    if (wall?.openingSightOverride === undefined) continue;
    const error = openingSightOverrideError(wall.openingSightOverride);
    if (error) return `Wall ${wall._id}: ${error}`;
  }
  for (const level of scene.levels ?? []) {
    if (level?.apertureSightOverrides === undefined) continue;
    const error = apertureSightOverridesError(level.apertureSightOverrides);
    if (error) return `Level ${level._id}: ${error}`;
  }
  return null;
}

function diffTouchesOpeningSightScene(diff: Record<string, unknown>): boolean {
  return Object.keys(diff).some((key) => {
    const path = key.replace(/^-=/, "");
    return path === "flags" || path === "flags.core" || path === "flags.core.openingSight" ||
      path.startsWith("flags.core.openingSight.") || path === "walls" ||
      /^walls(?:\.\d+)?\.openingSightOverride(?:\.|$)/.test(path) ||
      path === "levels" || /^levels(?:\.\d+)?\.apertureSightOverrides(?:\.|$)/.test(path);
  });
}

/** Validate the policy fields on an intent's final touched documents (also used by archive ops). */
export function openingSightTransactionError(
  ops: readonly Op[],
  resolve: (ref: DocRef) => BaseDocument | undefined,
): string | null {
  for (const op of ops) {
    if (op.kind === "create") {
      if (op.coll === "scenes") {
        const error = openingSightWorldDataError(op.data as SceneDocument);
        if (error) return error;
      } else if (op.coll === "walls" && (op.data as Partial<WallDocument>).openingSightOverride !== undefined) {
        const error = openingSightOverrideError((op.data as Partial<WallDocument>).openingSightOverride);
        if (error) return error;
      } else if (op.coll === "levels" && (op.data as Partial<LevelDocument>).apertureSightOverrides !== undefined) {
        const error = apertureSightOverridesError((op.data as Partial<LevelDocument>).apertureSightOverrides);
        if (error) return error;
      }
      continue;
    }
    if (op.kind !== "update") continue;
    const touched = Object.keys(op.diff).some((key) => {
      const path = key.replace(/^-=/, "");
      return op.ref.coll === "walls" && (path === "openingSightOverride" || path.startsWith("openingSightOverride.")) ||
        op.ref.coll === "levels" && (path === "apertureSightOverrides" || path.startsWith("apertureSightOverrides."));
    });
    if (touched) {
      const current = resolve(op.ref);
      if (!current) continue;
      const applied = applyDiff(current, op.diff);
      if (!applied.ok) return applied.error;
      if (op.ref.coll === "walls") {
        const wall = applied.value as WallDocument;
        if (wall.openingSightOverride !== undefined) {
          const error = openingSightOverrideError(wall.openingSightOverride);
          if (error) return `Wall ${wall._id}: ${error}`;
        }
      } else if (op.ref.coll === "levels") {
        const level = applied.value as LevelDocument;
        if (level.apertureSightOverrides !== undefined) {
          const error = apertureSightOverridesError(level.apertureSightOverrides);
          if (error) return `Level ${level._id}: ${error}`;
        }
      }
    }
    if (op.ref.coll === "scenes" && diffTouchesOpeningSightScene(op.diff)) {
      const current = resolve(op.ref) as SceneDocument | undefined;
      if (!current) continue;
      const applied = applyDiff(current, op.diff);
      if (!applied.ok) return applied.error;
      const error = openingSightWorldDataError(applied.value as SceneDocument);
      if (error) return error;
    }
  }
  return null;
}
