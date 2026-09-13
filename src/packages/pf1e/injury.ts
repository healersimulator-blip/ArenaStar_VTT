/**
 * P7/H01/D-203 — injury and death, Gap List A.13 transcribed:
 *
 *   "0 HP ⇒ **staggered** (disabled: a single move or standard action per
 *   turn, never both, never full-round; a standard/strenuous action deals you
 *   1 point of damage after completing the act, putting you at −1 and dying —
 *   no check involved; verified AoN ID 164/166); below 0 ⇒ dying: unconscious,
 *   no actions, and **lose 1 HP every round** until dead or stable; each round
 *   on your turn, a DC 10 Constitution check to stabilize, with a **penalty on
 *   the roll equal to your negative HP total** (nat 20 = automatic success;
 *   fail ⇒ lose 1 HP); another creature can stabilize you with a DC 15 Heal
 *   check (first aid — standard action, provokes); dead when negative HP ≥
 *   your Con score; a stable character (aided) makes a DC 10 Con check each
 *   hour (same penalty) to wake disabled. Coup de grâce = full-round action
 *   vs a helpless defender (melee weapon, or bow/crossbow while adjacent):
 *   automatic hit and critical hit; if the defender survives the damage, a
 *   **mandatory** Fort save DC 10 + damage dealt or death; delivering it
 *   provokes AoOs; creatures immune to critical hits are unaffected by the
 *   critical damage and need not save (verified AoN ID 413). … Nonlethal:
 *   tracks separately; nonlethal damage **exactly equal to** current HP ⇒
 *   staggered, **exceeding** it ⇒ unconscious."
 *
 * The *state* of a dying creature (how many rounds, who aided) and the
 * turn/hour ticks that drive it are the combat bookkeeping's (D-204 wires
 * them); this module owns the verdicts every consumer reads, and the card
 * annotations `resolve.ts` prints come from here so the thresholds live in
 * exactly one place. Every die is the caller's.
 */

/** The lethal injury ladder, off current HP and the Con score. */
export type PF1eLethalState = "healthy" | "disabled" | "dying" | "dead";

export function injuryStateOf(input: {
  /** Current hit points (may be negative). */
  hp: number;
  /** The Constitution score — dead when negative HP reaches it. */
  conScore: number;
}): { state: PF1eLethalState; note: string | null } {
  const con = input.conScore > 0 ? input.conScore : 0;
  if (input.hp < 0 && con > 0 && -input.hp >= con) {
    return {
      state: "dead",
      note: `dead — negative HP (${String(input.hp)}) reached Constitution ${String(con)} (CRB p.190)`,
    };
  }
  if (input.hp < 0) {
    return {
      state: "dying",
      note: "unconscious and dying (below 0 HP, loses 1 HP per round — the stable/dying bookkeeping is P7)",
    };
  }
  if (input.hp === 0) {
    return {
      state: "disabled",
      note: "disabled (staggered at exactly 0 HP; a strenuous standard action costs 1 HP and starts dying)",
    };
  }
  return { state: "healthy", note: null };
}

/** A.13's nonlethal thresholds: exactly equal staggers, exceeding knocks out. */
export function nonlethalStateOf(input: {
  hp: number;
  nonlethalDamage: number;
}): "clear" | "staggered" | "unconscious" {
  if (input.hp <= 0) return "clear"; // the lethal state dominates
  if (input.nonlethalDamage > input.hp) return "unconscious";
  if (input.nonlethalDamage === input.hp) return "staggered";
  return "clear";
}

/**
 * The disabled action economy (A.13): a single move **or** standard action
 * per turn, never both, never a full-round action; the standard (or any
 * strenuous act) costs 1 HP *after* it completes — putting the character at
 * −1 and dying, no check involved.
 */
export function disabledAfterAction(input: {
  hp: number;
  action: "move" | "standard" | "full-round" | "swift" | "free";
  /** A second action this turn already? Disabled allows one, not both. */
  actedAlready?: boolean;
}): { allowed: boolean; hpAfter: number; note: string | null } {
  if (input.action === "full-round") {
    return {
      allowed: false,
      hpAfter: input.hp,
      note: "disabled — a full-round action is impossible at 0 HP (A.13)",
    };
  }
  if (input.action === "swift" || input.action === "free") {
    // Free and swift actions are not the disabled character's "single action".
    return { allowed: true, hpAfter: input.hp, note: null };
  }
  if (input.actedAlready === true) {
    return {
      allowed: false,
      hpAfter: input.hp,
      note: "disabled — one move or standard action per turn, never both (A.13)",
    };
  }
  if (input.action === "standard") {
    return {
      allowed: true,
      hpAfter: input.hp - 1,
      note: "the strenuous standard action completes, then costs 1 HP — at −1 and dying, no check (A.13)",
    };
  }
  return { allowed: true, hpAfter: input.hp, note: null };
}

/**
 * The stabilization check (A.13): a DC 10 Constitution check each round on
 * the dying character's turn, with a penalty on the roll equal to the
 * negative HP total — nat 20 is an automatic success, a failure loses 1 HP.
 * The same roll (DC and penalty) is the stable character's hourly check to
 * wake disabled (`purpose: "wake"` names the difference).
 */
export function stabilizationCheck(input: {
  die: number;
  conMod: number;
  /** Current (negative) HP — the penalty is its absolute value. */
  hp: number;
  purpose?: "stabilize" | "wake";
}): {
  success: boolean;
  hpAfter: number;
  note: string;
} {
  const penalty = input.hp < 0 ? -input.hp : 0;
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 20) {
    return {
      success: false,
      hpAfter: input.hp,
      note: "the Constitution check die must be a natural d20 face (1–20)",
    };
  }
  const natural20 = input.die === 20;
  const total = input.die + input.conMod - penalty;
  const success = natural20 || total >= 10;
  if (success) {
    return {
      success: true,
      hpAfter: input.hp,
      note:
        input.purpose === "wake"
          ? `Constitution check ${String(total)} ≥ 10 — the stable character wakes disabled (A.13)`
          : `Constitution check ${String(total)} ≥ 10 — the character stabilizes (A.13)`,
    };
  }
  return {
    success: false,
    hpAfter: input.hp - 1,
    note: `Constitution check ${String(total)} < 10 (penalty ${String(penalty)} for negative HP) — 1 more hit point lost (A.13)`,
  };
}

/** A.13: another creature stabilizes the dying with a DC 15 Heal check (a standard action that provokes). */
export function healFirstAid(input: {
  die: number;
  healMod: number;
}): { stabilized: boolean; note: string } {
  const total = input.die + input.healMod;
  return {
    stabilized: total >= 15,
    note:
      total >= 15
        ? `Heal ${String(total)} ≥ 15 — first aid stabilizes the dying creature (A.13)`
        : `Heal ${String(total)} < 15 — first aid fails (A.13)`,
  };
}

/**
 * Coup de grâce (A.13, verified AoN ID 413): a full-round action against a
 * helpless defender — automatic hit and critical hit; if the defender
 * survives the (crit) damage, a **mandatory** Fortitude save at DC 10 +
 * damage dealt or death. A creature immune to critical hits is unaffected by
 * the critical damage and need not save. The attack itself (and its provoke)
 * is the caller's; this is the verdict after the damage is known.
 */
export function coupDeGraceVerdict(input: {
  /** The critical damage the defender already took. */
  damageDealt: number;
  /** The damage alone already killed the defender (the caller's HP arithmetic). */
  killedByDamage: boolean;
  /** The mandatory save's d20 face — required unless crit-immune. */
  saveDie?: number;
  fortBonus: number;
  critImmune?: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      /** True when the defender is dead — the damage, or a failed save. */
      dead: boolean;
      saved: boolean;
      /** The save DC that was owed (10 + damage), or null when immunity waived it. */
      save: { dc: number; passed: boolean } | null;
      notes: readonly string[];
    } {
  if (input.critImmune === true) {
    return {
      ok: true,
      dead: input.killedByDamage,
      saved: false,
      save: null,
      notes: [
        "immune to critical hits — unaffected by the coup de grâce's critical damage, and no save is required (A.13)",
      ],
    };
  }
  const dc = 10 + Math.max(0, Math.floor(input.damageDealt));
  const die = input.saveDie;
  if (die === undefined || !Number.isInteger(die) || die < 1 || die > 20) {
    return {
      ok: false,
      error: `the coup de grâce demands a Fortitude save (DC ${String(dc)}) — saveDie (the d20 face, 1–20) is required`,
    };
  }
  const total = die + input.fortBonus;
  const passed = total >= dc;
  const notes = [
    `coup de grâce — the damage is a critical hit; the Fortitude save is mandatory: DC ${String(dc)} (10 + ${String(Math.max(0, Math.floor(input.damageDealt)))} damage)`,
  ];
  if (input.killedByDamage) {
    notes.push(
      "the damage alone killed the defender — the save is moot (A.13)",
    );
    return { ok: true, dead: true, saved: false, save: { dc, passed }, notes };
  }
  if (passed) {
    notes.push(
      `Fortitude ${String(total)} ≥ ${String(dc)} — the defender survives (A.13)`,
    );
    return { ok: true, dead: false, saved: true, save: { dc, passed }, notes };
  }
  notes.push(
    `Fortitude ${String(total)} < ${String(dc)} — the defender dies (A.13)`,
  );
  return { ok: true, dead: true, saved: false, save: { dc, passed }, notes };
}
