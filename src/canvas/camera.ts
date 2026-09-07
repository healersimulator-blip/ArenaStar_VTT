/**
 * §9 camera — pure viewport math (world ⇄ screen, zoom-at-point, fit).
 * Screen-space transform: screen = (world − origin) × scale.
 */
export interface Camera {
  /** World coordinate at the top-left screen pixel. */
  x: number;
  y: number;
  scale: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export function worldToScreen(camera: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - camera.x) * camera.scale, y: (wy - camera.y) * camera.scale };
}

export function screenToWorld(camera: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / camera.scale + camera.x, y: sy / camera.scale + camera.y };
}

/**
 * Zoom keeping one screen point pinned (§14 pinch/scroll zoom): the world
 * coordinate under the cursor stays under the cursor.
 */
export function zoomAt(
  camera: Camera,
  sx: number,
  sy: number,
  factor: number,
  limits = { min: 0.1, max: 10 },
): Camera {
  const scale = Math.min(limits.max, Math.max(limits.min, camera.scale * factor));
  const before = screenToWorld(camera, sx, sy);
  const next: Camera = { ...camera, scale };
  const after = screenToWorld(next, sx, sy);
  return { x: camera.x + (before.x - after.x), y: camera.y + (before.y - after.y), scale };
}

/** Center a world rect inside the viewport with padding (scene load, §9). */
export function fitRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: Viewport,
  padding = 32,
): Camera {
  const scale = Math.min(
    (viewport.width - padding * 2) / rect.width,
    (viewport.height - padding * 2) / rect.height,
  );
  const clamped = Math.min(10, Math.max(0.1, scale));
  return {
    scale: clamped,
    x: rect.x + rect.width / 2 - viewport.width / (2 * clamped),
    y: rect.y + rect.height / 2 - viewport.height / (2 * clamped),
  };
}
