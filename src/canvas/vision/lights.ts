/**
 * §9 light math (pure, Node-testable — the Pixi layer re-exports these):
 * color parsing, viewport rejection, gradient stop colors.
 */
export interface AmbientLighting {
  /** 0 = fully lit scene, 1 = fully dark. */
  darkness: number;
  /** Darkness tint, e.g. "#0a0e1a" for a cold night. */
  color: string;
}

/** #rrggbb → 0xrrggbb with fallback. */
export function parseLightColor(hex: string, fallback = 0xffe9b8): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const g = m?.[1];
  return g ? parseInt(g, 16) : fallback;
}

/** Cheap viewport rejection before polygon work. */
export function lightAffectsViewport(
  light: { x: number; y: number; dim: number },
  view: { x: number; y: number; width: number; height: number },
): boolean {
  const r = Math.max(light.dim, 0);
  return (
    light.x + r >= view.x &&
    light.x - r <= view.x + view.width &&
    light.y + r >= view.y &&
    light.y - r <= view.y + view.height
  );
}

/** packed 0xrrggbb + alpha → [r,g,b,a] ColorSource array. */
export function rgba(color: number, alpha: number): number[] {
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255, Math.max(0, Math.min(1, alpha))];
}
