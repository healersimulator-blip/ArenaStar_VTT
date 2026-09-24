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
export type ResolvedCameraSection = ResolvedCameraPan | ResolvedCameraShake;

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
  return panCamera(base, { x: section.toX, y: section.toY }, viewport, fxEase(section.easing, progress), section.zoom);
}

/** Where a finished pan leaves the view — the caller writes this on the last frame. */
export function cameraPanEnd(section: ResolvedCameraPan, base: Camera, viewport: Viewport): Camera {
  return panCamera(base, { x: section.toX, y: section.toY }, viewport, 1, section.zoom);
}
