import type { LightAnimation } from "./documents";

export const LIGHT_ANIMATION_TYPES = ["torch", "pulse"] as const;

export type LightAnimationValidation =
  | { ok: true; value: LightAnimation | null }
  | { ok: false; error: string };

/** Strict v1 metadata parser shared by module writes, imports and the renderer. */
export function parseLightAnimation(value: unknown): LightAnimationValidation {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "light animation must be a plain object or null" };
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["type", "speed", "intensity", "reverse"].includes(key)))
    return { ok: false, error: "light animation contains an unsupported field" };
  if (!(LIGHT_ANIMATION_TYPES as readonly unknown[]).includes(raw.type))
    return { ok: false, error: "light animation type must be torch or pulse" };
  if (typeof raw.speed !== "number" || !Number.isFinite(raw.speed) || raw.speed < 0 || raw.speed > 10)
    return { ok: false, error: "light animation speed must be between 0 and 10 cycles per second" };
  if (typeof raw.intensity !== "number" || !Number.isFinite(raw.intensity) || raw.intensity < 0 || raw.intensity > 1)
    return { ok: false, error: "light animation intensity must be between 0 and 1" };
  if (raw.reverse !== undefined && typeof raw.reverse !== "boolean")
    return { ok: false, error: "light animation reverse must be a boolean" };
  return {
    ok: true,
    value: {
      type: raw.type as LightAnimation["type"],
      speed: raw.speed,
      intensity: raw.intensity,
      ...(raw.reverse === undefined ? {} : { reverse: raw.reverse }),
    },
  };
}

/** Animation modulation only affects light presentation; it never changes vision/range tests. */
export function lightAnimationAlpha(
  animation: LightAnimation | null | undefined,
  timeSeconds: number,
  reducedMotion = false,
): number {
  if (!animation || reducedMotion || animation.speed <= 0 || animation.intensity <= 0 || !Number.isFinite(timeSeconds)) return 1;
  const phase = timeSeconds * animation.speed * Math.PI * 2;
  let wave: number;
  if (animation.type === "pulse") {
    wave = (Math.sin(phase) + 1) / 2;
  } else {
    // Layered, deterministic harmonics give the flame an irregular but reproducible shimmer.
    wave = (Math.sin(phase * 1.73 + 0.37) * 0.50 +
      Math.sin(phase * 2.41 + 1.29) * 0.32 +
      Math.sin(phase * 3.17 + 2.13) * 0.18 + 1) / 2;
  }
  if (animation.reverse) wave = 1 - wave;
  const depth = Math.max(0, Math.min(1, animation.intensity));
  const minimum = animation.type === "pulse" ? 0.62 : 0.72;
  return 1 - (1 - minimum) * depth * (1 - wave);
}
