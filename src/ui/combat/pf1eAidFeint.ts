/**
 * P05/D-211 — Aid Another and Feint planners: verdicts turned into the exact
 * host ops the sheet/CombatPanel submit. Pure (no dice, no store): the caller
 * supplies the die face and the derivation's numbers; the planner returns the
 * ops the flow submits.
 *
 * Both are *note-only* for now (the +2 or denied-Dex lives in the card
 * text and in the effect the next attack can claim). The underlying rule is
 * not invented here: Aid Another's +2 is a circumstance bonus on the friend's
 * next attack vs that opponent or +2 to AC vs that opponent's next attack,
 * lasting until before your next turn and stacking with other aids (AoN 186);
 * Feint's success denies Dex to AC on the next melee attack on or before your
 * next turn (move with Improved Feint, until next turn with Greater Feint).
 * Writing a live `flags.pf1e` effect that the resolver would consume is a
 * follow-up consumer (the attack resolver would need an "aided +2 vs X" fact);
 * this slice's contract is the verdict, the card, and the ledger spend.
 */
import type { ActorDocument } from "../../core/documents";
import type { Op } from "../../core/ops";
import { pf1eAidAnother, pf1eFeint, type PF1eAidAnotherInput, type PF1eFeintInput } from "../../packages/pf1e/aidFeint";

export interface PF1eAidFeintPlan {
  ops: Op[];
  note: string;
}

function aiderNameOf(actor: ActorDocument): string {
  return actor.name;
}

/* ── Aid Another ─────────────────────────────────────────────────────── */

export function planAidAnother(input: {
  aider: ActorDocument;
  aided: ActorDocument;
  opponent: ActorDocument;
  die: number;
  attackBonus: number;
  dc?: number;
  attackPenalty?: number;
  aooDamageTaken?: number;
  aidedActionProvokes?: boolean;
  aidChoice?: "attack" | "ac";
}): { ok: true; plan: PF1eAidFeintPlan } | { ok: false; error: string } {
  const res = pf1eAidAnother({
    die: input.die,
    attackBonus: input.attackBonus,
    ...(input.dc !== undefined ? { dc: input.dc } : {}),
    ...(input.attackPenalty !== undefined ? { attackPenalty: input.attackPenalty } : {}),
    ...(input.aooDamageTaken !== undefined ? { aooDamageTaken: input.aooDamageTaken } : {}),
    ...(input.aidedActionProvokes !== undefined ? { aidedActionProvokes: input.aidedActionProvokes } : {}),
    ...(input.aidChoice !== undefined ? { aidChoice: input.aidChoice } : {}),
  } as PF1eAidAnotherInput);
  if (!res.ok) return res;
  const note = `${aiderNameOf(input.aider)} → ${input.aided.name} vs ${input.opponent.name} — ${res.notes.join(" · ")}`;
  // Note-only: the +2 lives in the card. A live effect (mods: attack +2 or ac +2
  // circumstance, source aid-<aiderId>, ttl 1 round) is the resolver consumer
  // that would make the *next* attack automatically read it — intentionally out
  // of slice (the resolver needs an "aided vs X" scoping fact, not a global +2).
  return { ok: true, plan: { ops: [], note } };
}

/* ── Feint ───────────────────────────────────────────────────────────── */

export function planFeint(input: {
  feinter: ActorDocument;
  target: ActorDocument;
  die: number;
  bluffBonus: number;
  defenderBab: number;
  defenderWisMod: number;
  defenderSenseMotiveBonus?: number | null;
  defenderSenseMotiveTrained?: boolean;
  defenderIsHumanoid?: boolean | null;
  defenderIntScore?: number | null;
  defenderIsAnimalInt?: boolean | null;
  hasImprovedFeint?: boolean;
  hasGreaterFeint?: boolean;
}): { ok: true; plan: PF1eAidFeintPlan } | { ok: false; error: string } {
  const res = pf1eFeint({
    die: input.die,
    bluffBonus: input.bluffBonus,
    defenderBab: input.defenderBab,
    defenderWisMod: input.defenderWisMod,
    ...(input.defenderSenseMotiveBonus !== undefined ? { defenderSenseMotiveBonus: input.defenderSenseMotiveBonus } : {}),
    ...(input.defenderSenseMotiveTrained !== undefined ? { defenderSenseMotiveTrained: input.defenderSenseMotiveTrained } : {}),
    ...(input.defenderIsHumanoid !== undefined ? { defenderIsHumanoid: input.defenderIsHumanoid } : {}),
    ...(input.defenderIntScore !== undefined ? { defenderIntScore: input.defenderIntScore } : {}),
    ...(input.defenderIsAnimalInt !== undefined ? { defenderIsAnimalInt: input.defenderIsAnimalInt } : {}),
    ...(input.hasImprovedFeint !== undefined ? { hasImprovedFeint: input.hasImprovedFeint } : {}),
    ...(input.hasGreaterFeint !== undefined ? { hasGreaterFeint: input.hasGreaterFeint } : {}),
  } as PF1eFeintInput);
  if (!res.ok) return res;
  const note = `${aiderNameOf(input.feinter)} → ${input.target.name} — ${res.notes.join(" · ")}`;
  // Note-only: success means "target is denied Dex to AC vs your next melee
  // attack (Greater: until next turn)". The condition write (`flags.deniedDexToAc`)
  // is a live effect on the target that the *attack resolver* would consume
  // and then clear — intentionally note-only until the resolver gains a
  // feint-scoped denied-Dex fact (global deniedDex would incorrectly grant
  // sneak attack to allies, forum AoN 195).
  return { ok: true, plan: { ops: [], note } };
}
