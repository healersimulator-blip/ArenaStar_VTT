import { evaluateFormula, validateFormula, type RngFn } from "../dice/engine";
import { err, okVal, type Result } from "./result";
export type MoveAxisMode = "set" | "add";
export interface MoveCoordinates {
  x?: number; y?: number; xFormula?: string; yFormula?: string;
  mode?: MoveAxisMode; xMode?: MoveAxisMode; yMode?: MoveAxisMode;
}
export function moveCoordinatesError(value: Record<string, unknown>): string | null {
  for (const key of ["mode", "xMode", "yMode"])
    if (value[key] !== undefined && value[key] !== "set" && value[key] !== "add") return "Move axis mode must be set/add";
  for (const axis of ["x", "y"] as const) {
    const formula = value[`${axis}Formula`], fixed = value[axis];
    if (formula !== undefined) {
      if (fixed !== undefined) return `Move ${axis}: choose a fixed coordinate or formula, not both`;
      if (typeof formula !== "string" || !formula.trim() || formula.length > 128 || formula.includes("@"))
        return `Move ${axis} formula requires 1–128 characters of dice/math without document paths`;
      const parsed = validateFormula(formula);
      if (!parsed.ok) return `Move ${axis}: ${parsed.error}`;
    } else {
      const mode = value[`${axis}Mode`] ?? value.mode ?? "set";
      if (typeof fixed !== "number" || !Number.isFinite(fixed) || fixed > 1e9 || fixed < (mode === "add" ? -1e9 : 0))
        return `Move ${axis} requires finite bounded coordinates`;
    }
  }
  return null;
}
/** Resolves X then Y for each target. Validation never consumes randomness. */
export function resolveMoveCoordinates(value: MoveCoordinates, rng: RngFn): Result<{x:number;y:number}> {
  const invalid = moveCoordinatesError({...value});
  if (invalid) return err(invalid);
  const point = {x:0,y:0};
  try {
    for (const axis of ["x","y"] as const) {
      const formula = value[`${axis}Formula`];
      let n = value[axis] ?? 0;
      if (formula !== undefined) {
        let draws = 0;
        const result = evaluateFormula(formula, undefined, () => {
          if (++draws > 64) throw new Error("Move axis formula exceeds 64 random draws");
          const draw = rng();
          if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error("invalid host RNG");
          return draw;
        });
        if (!result.ok) return err(`Move ${axis}: ${result.error}`);
        n = result.value.total;
      }
      const mode = value[`${axis}Mode`] ?? value.mode ?? "set";
      if (!Number.isFinite(n) || n > 1e9 || n < (mode === "add" ? -1e9 : 0)) return err(`Move ${axis} result is outside its coordinate bounds`);
      point[axis] = n;
    }
    return okVal(point);
  } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
}
