/**
 * P07/D-195 — the **fired readied action resolves through the sheet's own attack flow**. D-194's
 * "Fire ready" control reordered initiative and handed the GM a status note; this module closes the
 * loop the note named: a readied *standard attack* now actually rolls, writes hit points and posts
 * a card through `resolveAttackFlow` — the same resolver the sheet and the attacks-of-opportunity
 * path use — so "the readied action resolves just before the trigger" is a fact, not a suggestion.
 *
 * The rules it encodes (CRB p.203, AoN 201), plus the named assumptions:
 *   • A readied action fires **just before** the trigger — `resolveReady` moves the readied
 *     combatant's initiative immediately ahead of the triggerer and points the turn at it, so the
 *     attack resolves *now*, before the triggerer acts.
 *   • A readied standard attack resolves as the combatant's **primary melee attack** (`meleeLine`),
 *     the same default the AoO resolver uses — a readied attack is a single attack. A
 *     ranged-only combatant is reported by name rather than silently given a melee strike.
 *   • The provoker **defends normally**: a ready does not impose flat-footedness (that is the
 *     surprise/first-turn state, A.1), unlike an attack of opportunity.
 *   • **No budget is spent**: the standard action was already paid when the ready was declared
 *     (`readyCombatant`), so firing spends nothing further.
 *   • A move/swift/free readied action is not an attack — the reorder stands, and the line names
 *     what the GM resolves next (the combatant is now current).
 *
 * The module is the orchestration, not the Svelte handler: it returns `{ combat, hooks, lines,
 * damage }`, and the panel pushes the combat transition; the HP write happens inside
 * `resolveAttackFlow` before the caller finalizes the reorder, exactly as the AoO resolver does.
 */
import type {
  ActorDocument,
  CombatDocument,
  SceneDocument,
} from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { PF1eActionSpend } from "../../packages/pf1e/actions";
import type { PF1eReadyTrigger } from "../../packages/pf1e/combatState";
import { resolveReady } from "../../packages/pf1e/readyDelay";
import { pf1eAttackRollGroups } from "../../packages/pf1e/rollData";
import type { PF1eDerivedAttack } from "../../packages/pf1e/actor";
import {
  resolveAttackFlow,
  type ResolveFlowClient,
} from "../sheets/pf1eResolveFlow";
import {
  actorOf,
  authoredAttackCount,
  derivedFor,
  featsOf,
  meleeLine,
  type AooTokenRef,
} from "./pf1eAooFlow";

/** The store reads this module needs — a superset of the resolver's minimal client. */
export interface ReadyActionClient extends ResolveFlowClient {
  readonly store: {
    getAll(coll: "messages"): readonly unknown[];
    getAll(coll: "scenes"): readonly SceneDocument[];
    getAll(coll: "actors"): readonly ActorDocument[];
  };
}

/** The result of firing one readied action, whatever the prepared action was. */
export interface ReadyActionOutcome {
  ok: boolean;
  /** The refusal reason (the `resolveReady` error) — the panel shows it verbatim. */
  error: string | null;
  /** The reordered combat (readied initiative moved, ready spent); null on refusal. */
  combat: CombatDocument | null;
  /** Hooks to fire when the caller pushes the combat transition. */
  hooks: string[];
  action: PF1eActionSpend | null;
  trigger: PF1eReadyTrigger | null;
  /** Log lines: the resolved attack, or the named move/swift/free hand-off. */
  lines: string[];
  /** Damage the readied action dealt (0 on a miss, a refusal, or a non-attack ready). */
  damage: number;
  /** True when a standard-attack ready actually rolled; false for move/swift/free. */
  resolved: boolean;
}

/** The combatant's tracker name (its own if the id is unknown to the combat). */
function combatantName(combat: CombatDocument, id: string): string {
  return combat.combatants.find((c) => c._id === id)?.name ?? id;
}

const noRoll = (
  ok: boolean,
  error: string | null,
): Omit<ReadyActionOutcome, "combat" | "hooks" | "action" | "trigger"> => ({
  ok,
  error,
  lines: [],
  damage: 0,
  resolved: false,
});

/**
 * Fire a readied action: reorder the initiative (`resolveReady`), then — when the prepared action
 * is a standard attack — resolve it through the sheet's own flow against the triggerer. Pure of
 * Svelte and of dice; the caller supplies the client and the combat facts it already holds.
 */
export async function resolveReadiedAction(input: {
  client: ReadyActionClient;
  user: PermissionUser | null;
  combat: CombatDocument;
  /** The combatant whose readied action is firing. */
  readiedCombatantId: string;
  /** The combatant whose action triggered the ready (interrupted, resolves after). */
  triggererCombatantId: string;
}): Promise<ReadyActionOutcome> {
  const fired = resolveReady(
    input.combat,
    input.readiedCombatantId,
    input.triggererCombatantId,
  );
  if (!fired.ok) {
    return { ...noRoll(false, fired.error), combat: null, hooks: [], action: null, trigger: null };
  }
  const { combat, action, trigger, hooks } = fired.value;
  const readiedName = combatantName(combat, input.readiedCombatantId);

  // A move/swift/free readied action is not an attack: the reorder stands and the line names
  // what the GM resolves next (the combatant is now current). No die is rolled.
  if (action.kind !== "standard") {
    return {
      ok: true,
      error: null,
      combat,
      hooks,
      action,
      trigger,
      lines: [
        `${readiedName}'s readied ${action.kind} action fires — resolve it now (trigger: ${trigger.kind}).`,
      ],
      damage: 0,
      resolved: false,
    };
  }

  const scenes = input.client.store.getAll("scenes");
  const scene = scenes.find((s) => s.active) ?? scenes[0] ?? null;
  const actors = input.client.store.getAll("actors");
  const readiedCombatant = combat.combatants.find(
    (c) => c._id === input.readiedCombatantId,
  );
  const triggererCombatant = combat.combatants.find(
    (c) => c._id === input.triggererCombatantId,
  );
  const readiedTokenId = readiedCombatant?.tokenId;
  const triggererTokenId = triggererCombatant?.tokenId;
  if (
    scene === null ||
    readiedTokenId === null ||
    readiedTokenId === undefined ||
    triggererTokenId === null ||
    triggererTokenId === undefined
  ) {
    return {
      ...noRoll(true, null),
      combat,
      hooks,
      action,
      trigger,
      lines: [
        `${readiedName}'s readied attack fires, but there is no scene token to resolve it against — resolve the attack through the sheet.`,
      ],
    };
  }

  const tokens: readonly AooTokenRef[] = scene.tokens.map((t) => ({
    _id: t._id,
    actorId: t.actorId ?? null,
  }));
  const reactorActor = actorOf(readiedTokenId, tokens, actors);
  const provokerActor = actorOf(triggererTokenId, tokens, actors);
  if (reactorActor === null || provokerActor === null) {
    return {
      ...noRoll(true, null),
      combat,
      hooks,
      action,
      trigger,
      lines: [
        `${readiedName}'s readied attack fires, but a token has no actor document to ${
          reactorActor === null ? "attack with" : "defend against"
        } — resolve the attack through the sheet.`,
      ],
    };
  }

  const reactorDerived = derivedFor(
    reactorActor,
    combat,
    readiedCombatant?._id ?? null,
  );
  const provokerDerived = derivedFor(
    provokerActor,
    combat,
    triggererCombatant?._id ?? null,
  );
  const base = meleeLine(reactorDerived);
  if (base === null) {
    return {
      ...noRoll(true, null),
      combat,
      hooks,
      action,
      trigger,
      lines: [
        `${readiedName}'s readied attack is ranged-only — a readied attack resolves as the primary melee attack, so resolve it through the sheet.`,
      ],
    };
  }
  // The card must say why this attack happened; the roll and the resolution are the sheet's
  // own, so only the line's label differs.
  const line: PF1eDerivedAttack = {
    ...base,
    name: `${base.name} — readied action`,
  };
  const feats = featsOf(reactorActor);
  const authored = authoredAttackCount(reactorActor);
  const groups = pf1eAttackRollGroups(reactorDerived, {
    authoredAttacksCount: authored,
    feats,
  });
  const group = groups[reactorDerived.attacks.indexOf(base)];
  if (group === undefined) {
    return {
      ...noRoll(true, null),
      combat,
      hooks,
      action,
      trigger,
      lines: [`${readiedName}'s readied attack produced no attack group — resolve it through the sheet.`],
    };
  }

  const outcome = await resolveAttackFlow(input.client, input.user, {
    attackerName: reactorActor.name,
    line,
    iterative: 0,
    attackFormula: group.attack.formula,
    damageFormula: group.damage?.formula ?? "0",
    critDamageFormula: group.critDamage?.formula ?? null,
    targetName: provokerActor.name,
    targetActor: provokerActor,
    targetDerived: provokerDerived,
    // A ready does not impose flat-footedness — the provoker defends normally (A.1's state
    // is surprise/first-turn, not "was readied against").
    defense: "normal",
    ...(authored === 0 ? { unarmed: true } : {}),
    ...(feats.length > 0 ? { feats } : {}),
  });
  if (!outcome.ok) {
    return {
      ...noRoll(true, outcome.error),
      combat,
      hooks,
      action,
      trigger,
      lines: [
        `${readiedName}'s readied attack could not be resolved: ${outcome.error}`,
      ],
    };
  }
  const result = outcome.result;
  if (!result.ok) {
    return {
      ...noRoll(true, result.error),
      combat,
      hooks,
      action,
      trigger,
      lines: [`${readiedName}'s readied attack was refused: ${result.error}`],
    };
  }
  const damage = result.damage?.dealt ?? 0;
  const verb =
    result.outcome === "miss"
      ? "misses"
      : result.outcome === "crit"
        ? "critically hits"
        : "hits";
  const lines = [
    `${reactorActor.name} ${verb} ${provokerActor.name} for ${damage} (${result.attackTotal} vs AC ${result.defenseAc})`,
  ];
  if (outcome.hpWriteError !== null) {
    lines.push(
      `— the readied attack's hit points could not be written: ${outcome.hpWriteError}`,
    );
  }
  return {
    ok: true,
    error: null,
    combat,
    hooks,
    action,
    trigger,
    lines,
    damage,
    resolved: true,
  };
}
