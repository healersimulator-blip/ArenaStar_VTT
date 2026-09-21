/**
 * §3.1 (G-39) — the dice spellings the three exporters use, read into the one this app rolls.
 *
 * Three sources, three spellings of the same fact:
 *
 * - Foundry's pf1 system evaluates damage through its own roller: a longsword's action carries
 *   `"sizeRoll(1, 6, @size)"` (the size-dependent dice function) or plain `"1d8"`.
 * - Hero Lab prints what a player reads: `"1d8+3"`, `"2d6"`, and for a flat bonus just `"+5"`.
 * - Roll20's sheet export stores what the sheet computes, which is the same player-facing text.
 *
 * A damage *expression* therefore arrives here as text and leaves as `{ dice, bonus }` — the two
 * things this app's attack line authors separately (`damageDice` + `damageBonus`). Anything the
 * parser does not recognise stays unrecognised (`null`), so the caller names it in the report
 * instead of guessing at it.
 */

/** `1d8` — a dice-only expression, the form `PF1eAttackEntry.damageDice` wants. */
export const DICE_FORMULA = /^\d+d\d+$/;

/** `1d8+3`, `1d8 - 1`, `2d6`, `+5`, `5` — the damage part of a printed weapon line. */
const DAMAGE_EXPRESSION = /^(?:(\d+d\d+))?\s*([+-]\s*\d+)?$/;

export interface ParsedDamage {
  /** Dice expression, `""` when the source states a flat amount only. */
  dice: string;
  /** Flat modifier already printed on the line (a magic weapon's bonus, a Str penalty). */
  bonus: number;
}

/**
 * Foundry's `sizeRoll(1, 6, @size)` (and its `sizeRoll(1, 6, @size, 1)` four-argument form) is the
 * pf1 system's way of saying "one d6, resized with the actor". The dice it names are the answer;
 * the `@size` argument rides the sheet's own size, which the item does not carry.
 */
export function sizeRollToDice(formula: unknown): string | null {
  const text = typeof formula === "string" ? formula.trim() : "";
  const sized =
    /^sizeRoll\(\s*(\d+)\s*,\s*(\d+)\s*,\s*@[\w.]+(?:\s*,\s*\d+\s*)?\)$/.exec(
      text,
    );
  if (sized) return `${sized[1]}d${sized[2]}`;
  return DICE_FORMULA.test(text) ? text : null;
}

/**
 * A printed damage expression, split into dice and flat bonus. `"1d8+3"` → `{dice:"1d8",bonus:3}`,
 * `"+5"` → `{dice:"",bonus:5}`, `"1d8"` → `{dice:"1d8",bonus:0}`. Anything else is `null`: a
 * critical expression, a two-part damage line or a formula referring to other statistics is not
 * something to guess at.
 */
export function parseDamage(text: unknown): ParsedDamage | null {
  const clean = typeof text === "string" ? text.replace(/\s+/g, "") : "";
  if (clean === "") return null;
  const m = DAMAGE_EXPRESSION.exec(clean);
  if (m === null) return null;
  const dice = m[1] ?? "";
  const bonusText = m[2] ?? "";
  if (dice === "" && bonusText === "") return null;
  const bonus =
    bonusText === "" ? 0 : Number.parseInt(bonusText.replace("+", ""), 10);
  if (!Number.isFinite(bonus)) return null;
  return { dice, bonus };
}
