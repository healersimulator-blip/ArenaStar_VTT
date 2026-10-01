import { evaluateFormula, validateFormula, type RngFn } from "../dice/engine";
import { err, okVal, type Result } from "./result";

/** GM-authored whole-minute delta. Validation never rolls or reads documents. */
export interface GameTimeAmount { minutes?: number; formula?: string }
const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && Math.abs(n) <= 525_600;
export function gameTimeAmountError(value: { minutes?: unknown; formula?: unknown }): string | null {
  if (value.formula === undefined) return valid(value.minutes) ? null : "Game Time requires a whole-minute change within ±525600 minutes";
  if (value.minutes !== undefined) return "Game Time: choose fixed minutes or a formula, not both";
  if (typeof value.formula !== "string" || !value.formula.trim() || value.formula.length > 128 || value.formula.includes("@"))
    return "Game Time formula needs 1–128 characters of dice/math without document paths";
  const parsed = validateFormula(value.formula);
  return parsed.ok ? null : `Game Time: ${parsed.error}`;
}
export function resolveGameTimeAmount(value: GameTimeAmount, rng: RngFn): Result<number> {
  const invalid = gameTimeAmountError(value);
  if (invalid) return err(invalid);
  if (value.formula === undefined) return okVal(value.minutes as number);
  let draws = 0;
  try {
    const result = evaluateFormula(value.formula, undefined, () => {
      if (++draws > 64) throw new Error("Game Time formula exceeds 64 random draws");
      const draw = rng();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error("invalid host RNG");
      return draw;
    });
    if (!result.ok) return err(`Game Time: ${result.error}`);
    return valid(result.value.total) ? okVal(result.value.total) : err("Game Time formula must resolve to whole minutes within ±525600");
  } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
}
