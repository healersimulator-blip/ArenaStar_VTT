import { evaluateFormula, validateFormula, type RngFn } from "../dice/engine";
import { err, okVal, type Result } from "./result";

/** GM-authored signed HP: a fixed value or safe dice grammar, never both. */
export interface HealthAmount { amount?: number; formula?: string }
const valid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n !== 0 && Math.abs(n) <= 100_000;
export function healthAmountError(value: { amount?: unknown; formula?: unknown }): string | null {
  if (value.formula === undefined) return valid(value.amount) ? null : "HP change must be a nonzero whole number within ±100000";
  if (value.amount !== undefined) return "Choose a fixed HP change or a formula, not both";
  if (typeof value.formula !== "string" || !value.formula.trim() || value.formula.length > 128 || value.formula.includes("@"))
    return "HP formula needs 1–128 characters of dice/math without document paths";
  const parsed = validateFormula(value.formula);
  return parsed.ok ? null : parsed.error;
}
export function resolveHealthAmount(value: HealthAmount, rng: RngFn): Result<number> {
  const invalid = healthAmountError(value);
  if (invalid) return err(invalid);
  if (value.formula === undefined) return okVal(value.amount as number);
  let draws = 0;
  try {
    const result = evaluateFormula(value.formula, undefined, () => {
      if (++draws > 64) throw new Error("HP formula exceeds 64 random draws");
      const draw = rng();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error("invalid host RNG");
      return draw;
    });
    if (!result.ok) return err(result.error);
    return valid(result.value.total) ? okVal(result.value.total) : err("HP formula must resolve to a nonzero whole number within ±100000");
  } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
}
