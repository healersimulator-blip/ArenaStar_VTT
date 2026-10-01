import { evaluateFormula, validateFormula, type RngFn } from "../dice/engine";
import { err, okVal, type Result } from "./result";

export type TileImageSelection = "first" | "last" | "next" | "previous" | "random" | "other" | "index" | "numbers" | "formula";
export interface TileImageList {
  images: string[];
  selection: TileImageSelection;
  index?: number;
  /** Inclusive 1-based ranges and individual numbers, e.g. 1-3, 5 or [1, 3]. */
  numbers?: string;
  /** Sandboxed dice grammar, not JavaScript or template evaluation. No document paths. */
  formula?: string;
}

export const TILE_IMAGE_EXPRESSION_MAX = 128;
export const TILE_IMAGE_FORMULA_ROLLS = 64;

/** Expand without rolling or reading documents. The image list itself is capped at 32. */
export function tileImageNumbers(value: unknown, count: number): Result<number[]> {
  if (typeof value !== "string" || value.length > TILE_IMAGE_EXPRESSION_MAX || !Number.isInteger(count) || count < 1 || count > 32)
    return err("Image numbers need a list/range of at most 128 characters");
  let source = value.trim();
  if (source.startsWith("[") && source.endsWith("]")) source = source.slice(1, -1).trim();
  if (!source) return err("Image numbers cannot be empty");
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const item of source.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(item);
    if (!match) return err("Image numbers accept integers and inclusive ranges, e.g. 1-3, 5");
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last > count || last < first)
      return err(`Image numbers must be ascending and within 1–${count}`);
    for (let index = first; index <= last; index++) {
      if (seen.has(index)) return err("Image numbers must not repeat or overlap");
      seen.add(index);
      indices.push(index);
    }
  }
  return okVal(indices);
}

/** Mode-specific schema checks; validates formulas without consuming randomness. */
export function tileImageSelectionError(value: {
  selection?: unknown; index?: unknown; numbers?: unknown; formula?: unknown;
}, count: number): string | null {
  if (value.selection !== "index" && value.index !== undefined ||
      value.selection !== "numbers" && value.numbers !== undefined ||
      value.selection !== "formula" && value.formula !== undefined)
    return "Image number, number list and formula belong only to their own selection modes";
  switch (value.selection) {
    case "index":
      return typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 1 && value.index <= count
        ? null : `Image number must be an integer within 1–${count}`;
    case "numbers": {
      const parsed = tileImageNumbers(value.numbers, count);
      return parsed.ok ? null : parsed.error;
    }
    case "formula": {
      if (typeof value.formula !== "string" || !value.formula.trim() || value.formula.length > TILE_IMAGE_EXPRESSION_MAX || value.formula.includes("@"))
        return "Image formula needs 1–128 characters of dice/math, without document paths";
      const parsed = validateFormula(value.formula);
      return parsed.ok ? null : `Image formula: ${parsed.error}`;
    }
    case "other": return count >= 2 ? null : "Random other needs at least two images";
    case "first": case "last": case "next": case "previous": case "random": return null;
    default: return "Unknown tile image selection";
  }
}

/** Resolve one tile to a zero-based slot. Host callers also impose a shared nested-plan RNG budget. */
export function resolveTileImageIndex(list: TileImageList, current: number, rng: RngFn): Result<number> {
  const count = list.images.length;
  const invalid = tileImageSelectionError(list, count);
  if (!Number.isInteger(current) || current < -1 || current >= count) return err("Invalid current image slot");
  if (count < 1 || count > 32 || invalid) return err(invalid ?? "Invalid image count");
  const roll = (): number => {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("invalid host RNG");
    return value;
  };
  try {
    switch (list.selection) {
      case "first": return okVal(0);
      case "last": return okVal(count - 1);
      case "next": return okVal((current + 1) % count);
      case "previous": return okVal((current <= 0 ? count : current) - 1);
      case "index": return okVal((list.index ?? 1) - 1);
      case "random": return okVal(Math.floor(roll() * count));
      case "other": {
        const candidates = list.images.map((_image, index) => index).filter((index) => index !== current);
        return okVal(candidates[Math.floor(roll() * candidates.length)] ?? 0);
      }
      case "numbers": {
        const parsed = tileImageNumbers(list.numbers, count);
        if (!parsed.ok) return parsed;
        const slot = parsed.value.length === 1 ? 0 : Math.floor(roll() * parsed.value.length);
        return okVal((parsed.value[slot] ?? 1) - 1);
      }
      case "formula": {
        let draws = 0;
        const result = evaluateFormula(list.formula ?? "", undefined, () => {
          if (++draws > TILE_IMAGE_FORMULA_ROLLS) throw new Error("Image formula exceeds 64 random draws");
          return roll();
        });
        if (!result.ok) return err(`Image formula: ${result.error}`);
        const number = result.value.total;
        if (!Number.isInteger(number) || number < 1 || number > count)
          return err(`Image formula must resolve to a whole image number within 1–${count}`);
        return okVal(number - 1);
      }
    }
  } catch (error) {
    return err(`Image selection: ${error instanceof Error ? error.message : String(error)}`);
  }
}
