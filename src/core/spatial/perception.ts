/** Shared 2.5D perception queries. Inputs are host-owned snapshots, never player-supplied geometry.
 * Point/body samples authorize individual tokens, NOT terrain pixels between samples.
 * No implicit floors and no filtering occluders by a selected editing level.
 */
import type { Point3, SpatialKernel } from "./kernel";

export interface SpatialLight {
  id: string;
  at: Point3;
  /** Radii in scene distance units, not pixels. */
  bright: number;
  dim: number;
}
export interface PerceptionBody {
  feet: Point3;
  width: number;
  depth: number;
  height: number;
  eyeHeight: number;
  rotation: number;
  sight: number;
  darkvision: number;
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000;
function pointError(p: Point3): boolean { return !p || ![p.x, p.y, p.z].every(finite); }
export function perceptionBodyError(body: PerceptionBody): string | null {
  if (!body || pointError(body.feet) || ![body.width, body.depth, body.height].every((v) => finite(v) && v >= .001) ||
      !finite(body.eyeHeight) || body.eyeHeight < 0 || body.eyeHeight > body.height || !finite(body.rotation) ||
      ![body.sight, body.darkvision].every((v) => finite(v) && v >= 0)) return "Invalid perception body";
  if (!finite(body.feet.z + body.height)) return "Perception body exceeds elevation bounds";
  return null;
}
export function bodySamples(body: PerceptionBody): Point3[] {
  const error = perceptionBodyError(body); if (error) throw new Error(error);
  const a = body.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const xy = [[0, 0], [-.25, -.25], [.25, -.25], [-.25, .25], [.25, .25]];
  return [.1, .5, .9].flatMap((height) => xy.map(([x = 0, y = 0]) => ({
    x: body.feet.x + x * body.width * cos - y * body.depth * sin,
    y: body.feet.y + x * body.width * sin + y * body.depth * cos,
    z: body.feet.z + height * body.height,
  })));
}
export class SpatialPerception {
  private readonly lights: readonly SpatialLight[];
  private rays = 0;
  constructor(private readonly kernel: SpatialKernel, lights: readonly SpatialLight[], private readonly pixelsPerUnit: number,
    private readonly rayBudget = 20_000) {
    if (!finite(pixelsPerUnit) || pixelsPerUnit <= 0 || !Number.isSafeInteger(rayBudget) || rayBudget < 1 || rayBudget > 200_000 || !Array.isArray(lights) || lights.length > 256) throw new Error("Invalid perception budget/units");
    const ids = new Set<string>();
    for (const l of lights) {
      if (!l || typeof l.id !== "string" || !l.id || l.id.length > 128 || ids.has(l.id) || pointError(l.at) ||
          !finite(l.bright) || !finite(l.dim) || l.bright < 0 || l.dim < l.bright) throw new Error("Invalid spatial light");
      ids.add(l.id);
    }
    this.lights = structuredClone(lights);
  }
  /** One bounded request; exceeding the budget throws so callers discard the whole partial plan. */
  begin(): void { this.rays = 0; }
  private clear(a: Point3, b: Point3, axis: "sight" | "light"): boolean {
    if (++this.rays > this.rayBudget) throw new Error("Perception ray budget exceeded");
    return this.kernel.ray(a, b, axis).length === 0;
  }
  distance(a: Point3, b: Point3): number {
    if (pointError(a) || pointError(b)) throw new Error("Invalid perception point");
    return Math.hypot((b.x - a.x) / this.pixelsPerUnit, (b.y - a.y) / this.pixelsPerUnit, b.z - a.z);
  }
  /** Light channel traces source Z to target Z through all surfaces and walls. */
  lightAt(point: Point3, darkness: number): { lit: boolean; bright: boolean; ambient: boolean } {
    if (pointError(point) || !finite(darkness) || darkness < 0 || darkness > 1) throw new Error("Invalid light query");
    const ambient = darkness < 1;
    let lit = ambient, bright = false;
    for (const source of this.lights) {
      const distance = this.distance(source.at, point);
      if (source.dim > 0 && distance <= source.dim && this.clear(source.at, point, "light")) {
        lit = true; bright ||= distance <= source.bright;
      }
    }
    return { lit, bright, ambient };
  }
  /** Sight must be clear even under darkvision; target illumination may come from a different floor. */
  sees(eye: PerceptionBody, samples: readonly Point3[], targetDarkness: number): boolean {
    const error = perceptionBodyError(eye); if (error) throw new Error(error);
    if (!finite(targetDarkness) || targetDarkness < 0 || targetDarkness > 1) throw new Error("Invalid target darkness");
    if (!Array.isArray(samples) || samples.length < 1 || samples.length > 15) throw new Error("Invalid target sample budget");
    const from = { ...eye.feet, z: eye.feet.z + eye.eyeHeight };
    for (const sample of samples) {
      const distance = this.distance(from, sample);
      const darkvision = eye.darkvision > 0 && distance <= eye.darkvision;
      if (!darkvision && distance > eye.sight) continue;
      if (!this.clear(from, sample, "sight")) continue;
      if (darkvision || this.lightAt(sample, targetDarkness).lit) return true;
    }
    return false;
  }
}
