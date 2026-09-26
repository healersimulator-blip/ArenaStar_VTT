/**
 * Camera cues (SQ-15): a pan and a shake are **view** effects, pure math over one
 * viewer's camera. Nothing here touches a document, a socket or another user —
 * each client moves only its own camera, and the destination it moves to was
 * resolved and bounds-checked by the host (`resolveFxSequence`).
 *
 * The shape of the contract, because two of these rules are decisions rather
 * than arithmetic:
 *
 *  - a **pan** interpolates the viewport *centre* from where the viewer is to the
 *    resolved point, so a zoom change cannot make the destination drift; when the
 *    section ends the camera stays on the destination (that is what a pan is for),
 *  - a **path** walks its host-resolved waypoints in order, starting from where the
 *    viewer already is (so "here, then the gate, then the throne" is what the author
 *    meant), and stays on the last one like a pan stays on its destination,
 *  - a **shake** never moves the camera anywhere permanently: the offset decays to
 *    zero and the caller restores the exact base camera on the last frame,
 *  - both are bounded: a shake's amplitude is a fixed screen-space budget divided
 *    by the camera scale, so it looks the same at every zoom level and cannot be
 *    used to fling a view across the map.
 */
import type { Camera, Viewport } from "./camera";
import { fxEase, type FxEasing } from "../core/fx";

/** Peak shake offset in screen pixels at intensity 1 (before decay). */
export const SHAKE_AMPLITUDE_PX = 24;

export interface ResolvedCameraPan {
  kind: "camera";
  mode: "pan";
  startMs: number;
  toX: number;
  toY: number;
  easing?: FxEasing;
  zoom?: number;
  durationMs: number;
}
export interface ResolvedCameraShake {
  kind: "camera";
  mode: "shake";
  startMs: number;
  intensity: number;
  durationMs: number;
}
export interface ResolvedCameraPath {
  kind: "camera";
  mode: "path";
  startMs: number;
  /** Host-resolved waypoints in order (2–8). */
  points: Array<{ x: number; y: number }>;
  easing?: FxEasing;
  zoom?: number;
  durationMs: number;
}
export type ResolvedCameraSection = ResolvedCameraPan | ResolvedCameraShake | ResolvedCameraPath;

/** The world point a camera is centred on right now. */
export function cameraCentre(camera: Camera, viewport: Viewport): { x: number; y: number } {
  const scale = camera.scale || 1;
  return {
    x: camera.x + viewport.width / (2 * scale),
    y: camera.y + viewport.height / (2 * scale),
  };
}

/** A camera that centres `point` at `scale`. */
export function cameraCentredOn(point: { x: number; y: number }, viewport: Viewport, scale: number): Camera {
  const safeScale = scale > 0 ? scale : 1;
  return {
    x: point.x - viewport.width / (2 * safeScale),
    y: point.y - viewport.height / (2 * safeScale),
    scale: safeScale,
  };
}

/**
 * `progress` 0 → the base camera exactly, 1 → the destination centred at `zoom`
 * (the base scale when `zoom` is absent). Positions and scale share one eased
 * progress, so a pan-and-zoom arrives as one motion.
 */
export function panCamera(
  base: Camera,
  to: { x: number; y: number },
  viewport: Viewport,
  progress: number,
  zoom?: number,
): Camera {
  const phase = Math.min(1, Math.max(0, progress));
  const from = cameraCentre(base, viewport);
  const scale = zoom === undefined ? base.scale : base.scale + (zoom - base.scale) * phase;
  return cameraCentredOn(
    { x: from.x + (to.x - from.x) * phase, y: from.y + (to.y - from.y) * phase },
    viewport,
    scale,
  );
}

/**
 * A path walked from the viewer's current position through `points`, in order.
 *
 * The legs are evenly spread across the section's duration and each one is eased by
 * the same shared curve (`fxEase`), so a tour and a single pan of the same timeline
 * move alike. `zoom`, when given, is interpolated across the whole path rather than
 * per leg — otherwise a two-waypoint tour and a single pan to the same place would
 * end at different scales, which is exactly the kind of drift the pan rule exists to
 * prevent.
 */
export function pathCamera(
  base: Camera,
  points: readonly { x: number; y: number }[],
  viewport: Viewport,
  progress: number,
  zoom?: number,
  easing?: FxEasing,
): Camera {
  // A non-finite progress is clamped to 0 rather than propagated: a NaN camera would
  // blank the map for that viewer, and "no motion" is the safe reading of "no time".
  const phase = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const start = cameraCentre(base, viewport);
  // The list is the current centre followed by every waypoint: N waypoints, N legs.
  const route = [start, ...points];
  const legs = route.length - 1;
  if (legs < 1) return base;
  const scale = zoom === undefined ? base.scale : base.scale + (zoom - base.scale) * phase;
  if (phase >= 1) {
    const last = route[route.length - 1] ?? start;
    return cameraCentredOn(last, viewport, scale);
  }
  const scaled = phase * legs;
  const index = Math.min(legs - 1, Math.floor(scaled));
  const local = scaled - index;
  const from = route[index] ?? start;
  const to = route[index + 1] ?? from;
  const eased = fxEase(easing, local); // easing is per leg: every stop is still a stop
  return cameraCentredOn(
    { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased },
    viewport,
    scale,
  );
}

/** Bounded, decaying offset around the base camera. `rand` is `Math.random` in the app. */
export function shakeCamera(
  base: Camera,
  progress: number,
  intensity: number,
  rand: () => number,
): Camera {
  const phase = Math.min(1, Math.max(0, progress));
  const amplitude = (SHAKE_AMPLITUDE_PX * intensity * (1 - phase)) / (base.scale || 1);
  return {
    x: base.x + (rand() * 2 - 1) * amplitude,
    y: base.y + (rand() * 2 - 1) * amplitude,
    scale: base.scale,
  };
}

/**
 * The camera this section wants `elapsedMs` into it, or `null` once it is over.
 * `null` is the caller's cue to **release**: the pan leaves the view on its
 * destination, the shake restores the base (see the module note).
 */
export function cameraAt(
  section: ResolvedCameraSection,
  base: Camera,
  viewport: Viewport,
  elapsedMs: number,
  rand: () => number = Math.random,
): Camera | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs >= section.durationMs) return null;
  const progress = Math.min(1, Math.max(0, elapsedMs / section.durationMs));
  if (section.mode === "shake") return shakeCamera(base, progress, section.intensity, rand);
  if (section.mode === "path")
    return pathCamera(base, section.points, viewport, progress, section.zoom, section.easing);
  return panCamera(base, { x: section.toX, y: section.toY }, viewport, fxEase(section.easing, progress), section.zoom);
}

/** Where a finished pan leaves the view — the caller writes this on the last frame. */
export function cameraPanEnd(section: ResolvedCameraPan, base: Camera, viewport: Viewport): Camera {
  return panCamera(base, { x: section.toX, y: section.toY }, viewport, 1, section.zoom);
}

/** Where a finished path leaves the view: its last waypoint, at the path's final zoom. */
export function cameraPathEnd(section: ResolvedCameraPath, base: Camera, viewport: Viewport): Camera {
  return pathCamera(base, section.points, viewport, 1, section.zoom, section.easing);
}

/**
 * Where a camera section leaves the view once it is over — the one place the three
 * modes differ: a pan parks on its destination, a path on its last waypoint, and a
 * shake hands the view back exactly as it found it.
 */
export function cameraEnd(section: ResolvedCameraSection, base: Camera, viewport: Viewport): Camera {
  if (section.mode === "shake") return base;
  if (section.mode === "path") return cameraPathEnd(section, base, viewport);
  return cameraPanEnd(section, base, viewport);
}
