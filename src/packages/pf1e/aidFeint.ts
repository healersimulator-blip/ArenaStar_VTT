/**
 * P05/D-211 — Aid Another and Feint, the two A.9 companions the TODO calls
 * out separately from the ten combat manœuvres. Pure, diceless except for
 * the caller's die: every number is a caller fact (attack bonus, Bluff
 * bonus, opponent's BAB/Wis/Sense Motive, humanoid/animal/Int, feat flags).
 * Verified against:
 *
 *  - Aid Another: AoN 186 / CRB p.197: standard action, in position to make a
 *    melee attack on an opponent engaging a friend, attack roll vs AC 10;
 *    success ⇒ friend gains +2 bonus on next attack vs that opponent *or*
 *    +2 bonus to AC vs that opponent's next attack (your choice) before your
 *    next turn; multiple aid bonuses stack; aiding an action that would
 *    provoke also provokes (Table 7-2 footnote 2).
 *  - Feint: AoN 195 / CRB p.201 + Bluff skill (AoN bluff): standard action
 *    (move with Improved Feint), Bluff vs DC 10 + opponent BAB + Wis mod,
 *    or 10 + Sense Motive bonus if trained and higher; nonhumanoid –4,
 *    animal Int 1–2 –8, no Int impossible; success ⇒ next melee attack vs
 *    target (on or before your next turn) denies Dex to AC; does not provoke;
 *    Greater Feint: the Dex loss lasts until beginning of your next turn
 *    (in addition to the next attack).
 *
 * The pure layer refuses by name rather than guessing (missing die, missing
 * opponent numbers, impossible target, missing greater die is *not* needed
 * here — Greater Feint has no extra die).
 */

export interface PF1eAidAnotherInput {
  /** Natural d20 face. */
  die: number;
  /** Attack bonus of the aider (first iterative melee, including ability/size/effects). */
  attackBonus: number;
  /** DC to aid — AC 10 unless the table says otherwise (default 10). */
  dc?: number;
  /** Summed attack penalties (Power Attack, …) — positive = penalty. */
  attackPenalty?: number;
  /** Penalized-AoO damage that hit the aider before the roll (Table 7-2 footnote 2). */
  aooDamageTaken?: number;
  /** True when the aided friend's action would normally provoke — then aiding also provokes (AoN 128 fn2). */
  aidedActionProvokes?: boolean;
  /** Choice the aider makes on success. */
  aidChoice?: "attack" | "ac";
}

export type PF1eAidAnotherResult =
  | { ok: false; error: string }
  | {
      ok: true;
      success: boolean;
      total: number;
      dc: number;
      margin: number;
      /** The Table 7-2 provoke fact. */
      provokes: boolean;
      /** +2 on success, 0 otherwise — what the friend gains. */
      bonus: number;
      aidChoice: "attack" | "ac";
      notes: readonly string[];
    };

export function pf1eAidAnother(input: PF1eAidAnotherInput): PF1eAidAnotherResult {
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 20) {
    return { ok: false, error: "the aid another die must be a natural d20 face (1–20)" };
  }
  if (!Number.isFinite(input.attackBonus)) {
    return { ok: false, error: "aid another requires a finite attackBonus (the aider's melee bonus)" };
  }
  const dc = input.dc ?? 10;
  if (!Number.isFinite(dc) || dc < 0 || dc > 100) {
    return { ok: false, error: "aid another dc must be a finite number (default AC 10)" };
  }
  const attackPenalty = input.attackPenalty ?? 0;
  const aoo = input.aooDamageTaken ?? 0;
  const penalties = attackPenalty + aoo;
  const total = input.die + input.attackBonus - penalties;
  const notes: string[] = [];
  if (aoo > 0) notes.push(`the provoked attack of opportunity dealt ${String(aoo)} damage — that much as a penalty on this roll (A.9 / Table 7-2)`);
  // Aid is an attack roll: nat 1 auto-miss, nat 20 auto-hit (CRB p.178)
  if (input.die === 20) {
    notes.push("natural 20 — the aid attempt automatically succeeds (attack roll)");
    const aidChoice = input.aidChoice ?? "attack";
    const bonus = 2;
    if (aidChoice === "attack") notes.push("your friend gains a +2 bonus on his next attack roll against that opponent before your next turn (A.9)");
    else notes.push("your friend gains a +2 bonus to AC against that opponent's next attack before your next turn (A.9)");
    notes.push("multiple aid bonuses stack (A.9)");
    const provokes = input.aidedActionProvokes === true;
    if (provokes) notes.push("you aid someone performing an action that would normally provoke — the act of aiding another provokes as well (Table 7-2 footnote 2)");
    return { ok: true, success: true, total, dc, margin: total - dc, provokes, bonus, aidChoice, notes };
  }
  if (input.die === 1) {
    notes.push("natural 1 — the aid attempt automatically fails (attack roll)");
    const provokes = input.aidedActionProvokes === true;
    if (provokes) notes.push("you aid someone performing an action that would normally provoke — the act of aiding another provokes as well (Table 7-2 footnote 2)");
    return { ok: true, success: false, total, dc, margin: total - dc, provokes, bonus: 0, aidChoice: input.aidChoice ?? "attack", notes };
  }
  const success = total >= dc;
  const aidChoice = input.aidChoice ?? "attack";
  const bonus = success ? 2 : 0;
  if (success) {
    if (aidChoice === "attack") notes.push("your friend gains a +2 bonus on his next attack roll against that opponent before your next turn (A.9)");
    else notes.push("your friend gains a +2 bonus to AC against that opponent's next attack before your next turn (A.9)");
    notes.push("multiple aid bonuses stack (A.9)");
  } else {
    notes.push(`aid fails — ${String(total)} vs AC ${String(dc)}`);
  }
  const provokes = input.aidedActionProvokes === true;
  if (provokes) notes.push("you aid someone performing an action that would normally provoke — the act of aiding another provokes as well (Table 7-2 footnote 2)");
  return { ok: true, success, total, dc, margin: total - dc, provokes, bonus, aidChoice, notes };
}

// ── Feint ────────────────────────────────────────────────────────────────

export interface PF1eFeintInput {
  die: number;
  bluffBonus: number;
  /** Defender's BAB. */
  defenderBab: number;
  /** Defender's Wisdom modifier. */
  defenderWisMod: number;
  /** Defender's Sense Motive bonus (ranks + Wis + class + misc). Absent ⇒ not evaluated. */
  defenderSenseMotiveBonus?: number | null;
  /** Defender trained in Sense Motive (≥1 rank). If false, the Sense Motive DC never wins. */
  defenderSenseMotiveTrained?: boolean;
  /** True when the target is a humanoid (no penalty). False ⇒ –4. Absent ⇒ no penalty. */
  defenderIsHumanoid?: boolean | null;
  /** Defender Intelligence score. null/undefined = not authored; 0 = mindless? */
  defenderIntScore?: number | null;
  /** Explicit animal-Int flag: Int 1–2 animal ⇒ –8 (overrides the –4). */
  defenderIsAnimalInt?: boolean | null;
  hasImprovedFeint?: boolean;
  hasGreaterFeint?: boolean;
}

export type PF1eFeintResult =
  | { ok: false; error: string }
  | {
      ok: true;
      success: boolean;
      total: number;
      dc: number;
      margin: number;
      /** Standard vs move with Improved Feint (AoN 195). */
      action: "standard" | "move";
      /** Does the feinting action itself provoke? Never (AoN 195). */
      provokes: false;
      /** Humanoid/animal penalty applied (0/4/8). */
      penalty: number;
      /** Success grants denied-Dex on next melee attack (and until next turn with Greater). */
      deniesDex: boolean;
      /** Greater Feint extends the loss until beginning of your next turn. */
      greaterExtendsToNextTurn: boolean;
      notes: readonly string[];
    };

export function pf1eFeint(input: PF1eFeintInput): PF1eFeintResult {
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 20) {
    return { ok: false, error: "the feint die must be a natural d20 face (1–20)" };
  }
  if (!Number.isFinite(input.bluffBonus)) {
    return { ok: false, error: "feint requires a finite bluffBonus (Bluff modifier)" };
  }
  if (!Number.isFinite(input.defenderBab) || input.defenderBab < 0) {
    return { ok: false, error: "feint requires defenderBab (the opponent's base attack bonus)" };
  }
  if (!Number.isFinite(input.defenderWisMod)) {
    return { ok: false, error: "feint requires defenderWisMod (the opponent's Wisdom modifier)" };
  }
  // Impossible target: no Intelligence score
  // In PF1e, Int — (nonability) => feint impossible. Authored as null, 0, or non-finite.
  // We treat explicit null as mindless; absent (undefined) is not enough to declare impossible.
  if (input.defenderIntScore === null) {
    return { ok: false, error: "feint is impossible against a creature lacking an Intelligence score (A.9)" };
  }
  if (typeof input.defenderIntScore === "number" && input.defenderIntScore === 0) {
    return { ok: false, error: "feint is impossible against a creature lacking an Intelligence score (A.9)" };
  }
  let penalty = 0;
  const notes: string[] = [];
  // Animal Intelligence 1–2 ⇒ –8 (Bestiary). Overrides the generic –4.
  const isAnimalInt =
    input.defenderIsAnimalInt === true ||
    (typeof input.defenderIntScore === "number" && input.defenderIntScore >= 1 && input.defenderIntScore <= 2);
  if (isAnimalInt) {
    penalty = 8;
    notes.push("against a creature of animal Intelligence (1 or 2) you take a –8 penalty on the Bluff check (AoN 195)");
  } else if (input.defenderIsHumanoid === false) {
    penalty = 4;
    notes.push("when feinting against a nonhumanoid you take a –4 penalty on the Bluff check (AoN 195)");
  }
  const total = input.die + input.bluffBonus - penalty;
  let dc = 10 + input.defenderBab + input.defenderWisMod;
  let dcNote = `10 + BAB ${String(input.defenderBab)} + Wis ${String(input.defenderWisMod >= 0 ? `+${String(input.defenderWisMod)}` : String(input.defenderWisMod))} = ${String(dc)}`;
  if (
    input.defenderSenseMotiveTrained === true &&
    typeof input.defenderSenseMotiveBonus === "number" &&
    Number.isFinite(input.defenderSenseMotiveBonus)
  ) {
    const alt = 10 + input.defenderSenseMotiveBonus;
    if (alt > dc) {
      dc = alt;
      dcNote = `10 + Sense Motive ${String(input.defenderSenseMotiveBonus >= 0 ? `+${String(input.defenderSenseMotiveBonus)}` : String(input.defenderSenseMotiveBonus))} = ${String(dc)} (trained Sense Motive, higher than BAB+Wis)`;
    } else {
      dcNote += ` vs 10 + Sense Motive ${String(input.defenderSenseMotiveBonus)} = ${String(alt)} — BAB+Wis higher`;
    }
  }
  const success = total >= dc;
  const action: "standard" | "move" = input.hasImprovedFeint === true ? "move" : "standard";
  if (action === "move") notes.push("Improved Feint: you may feint as a move action (AoN 195)");
  notes.push(`feint ${success ? "succeeds" : "fails"} — Bluff ${String(total)} vs DC ${String(dc)} (${dcNote})`);
  if (success) {
    notes.push("if successful, the next melee attack you make against the target does not allow him to use his Dexterity bonus to AC (if any); this attack must be made on or before your next turn (AoN 195)");
    if (input.hasGreaterFeint === true) {
      notes.push("Greater Feint: whenever you use feint to cause an opponent to lose his Dexterity bonus, he loses that bonus until the beginning of your next turn, in addition to losing his Dexterity bonus against your next attack (AoN 195)");
    }
  } else {
    notes.push("feinting in combat does not provoke attacks of opportunity (AoN 195)");
  }
  return {
    ok: true,
    success,
    total,
    dc,
    margin: total - dc,
    action,
    provokes: false as const,
    penalty,
    deniesDex: success,
    greaterExtendsToNextTurn: success && input.hasGreaterFeint === true,
    notes,
  };
}
