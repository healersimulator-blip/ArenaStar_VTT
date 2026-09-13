/**
 * P06/D-191/D-192 — the **action provoke**: the attacks of opportunity a provoking
 * *action* (casting a spell, making a ranged or ranged-touch attack) earns, resolved (or
 * reported) through the same action seam and the same resolver the movement path uses.
 * This is the sheet-scoped glue D-190 left named: the cast and attack flows know only the
 * actor, the target and the linked combat, so *this* module reads the scene facts out of
 * the store, builds the action opportunity with `pf1eActionOpportunities`, and either
 * resolves the queue (`resolveActionOpportunities`) or reports its lines.
 *
 * The rules it encodes, quoted in `interrupts.ts`:
 *   • Table 7-2's `cast-spell` row — casting provokes an attack of opportunity (AoN 102,
 *     "performing certain actions within a threatened square"), *unless* the cast is a
 *     swift/free action (a quickened spell is a swift action, AoN 158) or the caster is
 *     casting defensively (the C03a concentration check *replaces* the opportunity —
 *     "does not provoke an attack of opportunity").
 *   • AoN 133's ranged-touch rule — a ranged touch provokes *even when the spell was cast
 *     defensively*, so it is queued as its own trigger, distinct from the cast.
 *   • AoN 133's concentration rule — "If you take damage from an attack of opportunity,
 *     you must make a concentration check (DC 10 + points of damage taken + the spell's
 *     level) or lose the spell." The resolution's damage to the caster is returned so the
 *     caller feeds it into the cast gate's `injured` declaration (whose `concentrationDc`
 *     is exactly that formula).
 *   • Table 7-2's `attack-ranged` row (D-192) — making a ranged attack while threatened
 *     provokes, resolved *before* the attack (the interrupt), with no concentration check
 *     on the damage: the shot still goes through whatever the reactor's strike did.
 *
 * The module is the *decision and the report*, not the Svelte handler: it returns lines
 * and damage, and the sheet only reads the scene, calls it, and threads the damage into
 * the gate it already builds (the cast) or the warning it already shows (the shot). The
 * two provokes of a ranged-touch spell share one queue (the `queue` input of
 * `pf1eActionOpportunities`), so a reactor with one per round is refused on the second
 * provoke *before any die is rolled* — the resolver's D-191 budget gate, which reads the
 * spend the first provoke already wrote into the combat.
 */
import type {
  ActorDocument,
  CombatDocument,
  SceneDocument,
} from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { deriveFromDocuments } from "../../packages/pf1e/actor";
import {
  actionProvokeLines,
  pf1eActionOpportunities,
  type PF1eActionOpportunityResult,
} from "../../packages/pf1e/actionOpportunity";
import type { PF1eCastingTime } from "../../packages/pf1e/concentration";
import type { PF1eAoOTrigger, PF1eInterrupt } from "../../packages/pf1e/interrupts";
import type { PF1eAreaIssue } from "../../packages/pf1e/targeting";
import { sightSegments } from "../../canvas/vision/wallSight";
import {
  attackOfOpportunityBudget,
  combatantForToken,
} from "./actionBudget";
import {
  resolutionLines,
  resolveActionOpportunities,
  type OpportunityResolution,
} from "./pf1eAooFlow";

/** The store reads this module needs — a superset of the resolver's minimal client. */
export interface ActionProvokeClient {
  roll(formula: string, mode?: "roll", to?: string[], flavor?: string): string;
  rollVerified(
    formula: string,
    mode?: "roll",
    to?: string[],
    flavor?: string,
  ): Promise<string>;
  submit(ops: Op[]): string;
  readonly store: {
    getAll(coll: "messages"): readonly unknown[];
    getAll(coll: "scenes"): readonly SceneDocument[];
    getAll(coll: "actors"): readonly ActorDocument[];
  };
}

/** One provoking trigger a declared cast earns, in the order the rules resolve them. */
export type PF1eActionProvoke =
  | { actionId: string }
  | { trigger: PF1eAoOTrigger };

/**
 * The triggers one declared cast earns. A swift/free cast provokes nothing (quickened is
 * a swift action — AoN 158), and a defensively cast spell replaces the casting provoke
 * with the C03a concentration check — but the ranged touch still provokes (AoN 133), so it
 * is added regardless of defensiveness.
 */
export function castProvokes(input: {
  castingTime?: PF1eCastingTime;
  quickened?: boolean;
  defensively?: boolean;
  touch?: "melee" | "ranged";
}): readonly PF1eActionProvoke[] {
  const provokes: PF1eActionProvoke[] = [];
  const swift =
    input.quickened === true ||
    input.castingTime === "swift" ||
    input.castingTime === "free";
  if (!swift && input.defensively !== true) {
    provokes.push({ actionId: "cast-spell" });
  }
  if (input.touch === "ranged") provokes.push({ trigger: { kind: "ranged-touch" } });
  return provokes;
}

/**
 * The trigger a ranged attack earns: Table 7-2's `attack-ranged` row provokes (yes) — a
 * ranged attack made while threatened draws an attack of opportunity, resolved before the
 * shot (the interrupt rule). A melee line is the caller's `attack-melee` (provokes: no),
 * so no helper is needed for it; the unarmed provoke is the resolver's own P6 note.
 */
export function rangedAttackProvokes(): readonly PF1eActionProvoke[] {
  return [{ actionId: "attack-ranged" }];
}

/**
 * The damage one resolution dealt to the provoker, which the cast caller feeds into the
 * cast gate's `injured` declaration — `concentrationDc` turns it into
 * `10 + damage + level` (AoN 133). Zero when the attacks missed or no reactor struck.
 */
export function provokeDamageTaken(
  resolution: OpportunityResolution,
  provokerTokenId: string,
): number {
  let total = 0;
  for (const entry of resolution.entries) {
    if (entry.provokerId === provokerTokenId) total += entry.damage;
  }
  return total;
}

export interface ActionProvokeResolution {
  /** The log lines: resolved attacks, skips, forgoes, and any named assumption. */
  lines: string[];
  /** The damage the provoked attacks dealt to the provoker — feeds the concentration DC. */
  damage: number;
}

/**
 * Read the scene facts, build the action opportunity for every provoke an action earns,
 * and resolve (world auto-resolve on + an encounter) or report the queue. Pure of dice
 * and Pixi; the sheet passes its client and the facts it already holds.
 */
export async function resolveActionProvokes(input: {
  client: ActionProvokeClient;
  user: PermissionUser | null;
  /** The provoker's scene token id (from the linked combatant). */
  provokerTokenId: string;
  /** What the action provokes, from `castProvokes`/`rangedAttackProvokes`. Empty = nothing. */
  provokes: readonly PF1eActionProvoke[];
  /** The world option (`aooSettings.autoResolveAoosOf`), read by the caller. */
  autoResolve: boolean;
  /** The provoker's encounter (the linked combat); null = report only, no spend. */
  combat: CombatDocument | null;
}): Promise<ActionProvokeResolution> {
  if (input.provokes.length === 0) return { lines: [], damage: 0 };

  const scenes = input.client.store.getAll("scenes");
  const scene = scenes.find((s) => s.active) ?? scenes[0] ?? null;
  if (scene === null) return { lines: [], damage: 0 };

  const actors = input.client.store.getAll("actors");
  const tokens = scene.tokens.map((t) => {
    const actor = t.actorId
      ? (actors.find((a) => a._id === t.actorId) ?? null)
      : null;
    const derived = actor
      ? deriveFromDocuments({ actor: { system: actor.system } })
      : null;
    return {
      _id: t._id,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      ...(derived ? { size: derived.size, shape: derived.reachShape } : {}),
    };
  });

  // Hostility is a caller fact, as in the movement seam: the scene's dispositions when
  // every token names one, else a named assumption.
  const dispositionOf = new Map(
    scene.tokens.map((t) => [t._id, t.disposition]),
  );
  const explicit = scene.tokens.every(
    (t) => (dispositionOf.get(t._id) ?? "neutral") !== "neutral",
  );
  const isEnemy = explicit
    ? (a: string, b: string) => dispositionOf.get(a) !== dispositionOf.get(b)
    : undefined;
  const hostilityAssumed = !explicit;

  // The ledgers only exist when there is an encounter to spend against (D-187's shape).
  const ledgers: Record<string, { used: number; max: number }> = {};
  if (input.combat !== null) {
    for (const t of scene.tokens) {
      const combatant = combatantForToken(input.combat, t._id);
      if (combatant === null) continue;
      const budget = attackOfOpportunityBudget(
        input.combat,
        combatant._id,
        actors,
      );
      if (budget !== null) ledgers[t._id] = { used: budget.used, max: budget.max };
    }
  }

  let queue: PF1eActionOpportunityResult["queue"] | undefined;
  const allQueued: PF1eInterrupt[] = [];
  const reportLines: string[] = [];
  let squares: string[] = [];
  let defaults: readonly PF1eAreaIssue[] = [];

  for (const provoke of input.provokes) {
    const opportunity = pf1eActionOpportunities({
      grid: scene.grid,
      tokens,
      provoker: { tokenId: input.provokerTokenId },
      ...("actionId" in provoke ? { actionId: provoke.actionId } : {}),
      ...("trigger" in provoke ? { trigger: provoke.trigger } : {}),
      ...(isEnemy !== undefined ? { isEnemy } : {}),
      ...(input.combat !== null ? { ledgers } : {}),
      ...(queue !== undefined ? { queue } : {}),
      // P04 — the scene's sight-blocking walls, so AoN 181's cover exclusion
      // applies to the queued reactions (absent = the seam's named default).
      coverWalls: sightSegments(scene.walls),
    });
    if (!opportunity.ok) continue;
    queue = opportunity.queue;
    allQueued.push(...opportunity.queued);
    squares = [...opportunity.squares];
    defaults = [...opportunity.defaults];
    reportLines.push(...actionProvokeLines(opportunity, { hostilityAssumed }));
  }

  if (allQueued.length === 0) {
    return { lines: reportLines, damage: 0 };
  }

  if (input.autoResolve && input.combat !== null && queue !== undefined) {
    const merged: PF1eActionOpportunityResult = {
      ok: true,
      issues: [],
      defaults,
      grid: null,
      refusal: null,
      trigger: null,
      squares,
      rects: [],
      reactors: [],
      refused: [],
      queue,
      queued: allQueued,
    };
    const resolution = await resolveActionOpportunities(
      input.client,
      input.user,
      {
        opportunity: merged,
        combat: input.combat,
        actors,
        tokens: scene.tokens,
        scene,
      },
    );
    return {
      lines: resolutionLines(resolution, { hostilityAssumed }),
      damage: provokeDamageTaken(resolution, input.provokerTokenId),
    };
  }

  const lines = [...reportLines];
  if (input.autoResolve && input.combat === null) {
    lines.push(
      "(no encounter — the AoO budget is per round and per combatant, so these were left to the table)",
    );
  }
  return { lines, damage: 0 };
}
