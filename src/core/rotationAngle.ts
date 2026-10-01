import { evaluateFormula, validateFormula, type RngFn } from "../dice/engine";
import { err, okVal, type Result } from "./result";

/** GM-authored degrees, resolved before absolute/relative normalization. */
export interface RotationAngle { angle?: number; formula?: string }
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000;
export function rotationAngleError(value: { angle?: unknown; formula?: unknown }): string | null {
  if (value.formula === undefined) return valid(value.angle) ? null : "Rotation needs finite degrees within ±1000000";
  if (value.angle !== undefined) return "Choose a fixed angle or a formula, not both";
  if (typeof value.formula !== "string" || !value.formula.trim() || value.formula.length > 128 || value.formula.includes("@"))
    return "Rotation formula needs 1–128 characters of dice/math without document paths";
  const parsed = validateFormula(value.formula);
  return parsed.ok ? null : parsed.error;
}
export function resolveRotationAngle(value: RotationAngle, rng: RngFn): Result<number> {
  const invalid = rotationAngleError(value);
  if (invalid) return err(invalid);
  if (value.formula === undefined) return okVal(value.angle as number);
  let draws = 0;
  try {
    const result = evaluateFormula(value.formula, undefined, () => {
      if (++draws > 64) throw new Error("Rotation formula exceeds 64 random draws");
      const draw = rng();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error("invalid host RNG");
      return draw;
    });
    if (!result.ok) return err(result.error);
    return valid(result.value.total) ? okVal(result.value.total) : err("Rotation formula must resolve to finite degrees within ±1000000");
  } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
}
