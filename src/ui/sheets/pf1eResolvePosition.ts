/**
 * P02/D-197 — the sheet's position-aware resolve consumer. The pure half of the
 * "auto flanking/cover" control: it reads the same scene facts the canvas owns
 * (tokens, walls, dispositions) and asks the pair seam (`pf1ePairPosition`) for
 * the two facts the resolve flow folds in — flanking (§2.2's +2, a melee
 * fact) and cover (AoN 181's AC grades) plus concealment (AoN 182) when a
 * source exists. Nothing here rolls, writes, or touches Svelte; the sheet binds
 * the report into its tri-state selects and the hint line, and every outcome
 * the report cannot decide is *named*, never silently assumed.
 *
 * The division of labour the pair seam already fixed:
 *   • geometry decides `soft`/`standard`/`total` cover; `partial` (+2) and
 *     `improved` (+8) are AoN 181's GM-discretion grades the corner lines
 *     cannot see — the select's explicit options, never the auto value;
 *   • `total` is passed through to the resolver, which refuses the attack
 *     ("You can't make an attack against a target that has total cover");
 *   • flanking needs an enemy helper: hostility comes from the scene's own
 *     dispositions when every token names one, else it is reported as an
 *     assumption (the same contract as the movement seam's `isEnemy`).
 */
import { sightSegments } from "../../canvas/vision/wallSight";
import type {
  ActorDocument,
  SceneDocument,
  TokenDocument,
} from "../../core/documents";
import { deriveFromDocuments } from "../../packages/pf1e/actor";
import type { PF1ePositionalDefense } from "../../packages/pf1e/resolve";
import {
  pf1ePairPosition,
  type PF1eThreatToken,
} from "../../packages/pf1e/threatPreview";

/**
 * The active scene, App.svelte's own lookup as a pure function: the flagged
 * scene, else the default scene, else nothing (a named outcome, not a guess).
 */
export function activeSceneOf(
  scenes: readonly SceneDocument[],
  fallbackSceneId: string,
): SceneDocument | null {
  return (
    scenes.find((sc) => sc.active) ??
    scenes.find((sc) => sc._id === fallbackSceneId) ??
    null
  );
}

/** The scene token linked to an actor (first match), or a named nothing. */
export function tokenOfActor(
  scene: SceneDocument,
  actorId: string,
): TokenDocument | null {
  return scene.tokens.find((t) => t.actorId === actorId) ?? null;
}

/**
 * Scene tokens → threat facts, deriving each linked actor's size and body form
 * exactly as the canvas does (`App.svelte`'s `onTokenMove` build). A token
 * without a linked actor keeps the seam's named Medium default.
 */
export function threatTokensOfScene(
  scene: SceneDocument,
  actors: readonly ActorDocument[],
): PF1eThreatToken[] {
  return scene.tokens.map((t) => {
    const actor =
      t.actorId !== undefined && t.actorId !== null
        ? (actors.find((a) => a._id === t.actorId) ?? null)
        : null;
    const derived =
      actor !== null
        ? deriveFromDocuments({ actor: { system: actor.system } })
        : null;
    return {
      _id: t._id,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      ...(derived !== null
        ? { size: derived.size, shape: derived.reachShape }
        : {}),
    };
  });
}

/** The auto report the sheet's tri-state selects and hint line bind to. */
export interface PF1eResolvePositionReport {
  ok: boolean;
  /** Why the position could not be read — the hint line's own sentence. */
  reason: string | null;
  /** The positional-defense payload for the resolve flow (cover + concealment). */
  defense: PF1ePositionalDefense;
  /** The pair's flanking fact (folded into the situational +2 for melee lines). */
  flanked: boolean;
  /** True when hostility was assumed because a token named no disposition. */
  hostilityAssumed: boolean;
  /**
   * The pair's melee reach for the line's own `reachSquares` — the gate the
   * Attack button refuses through (P02's deferred `meleeReachLegality`
   * consumer). Null for a ranged line (range increments are the ranged seam).
   */
  reach: { canStrike: boolean; refusals: readonly string[] } | null;
}

/**
 * Read the attacker/target pair's positional facts off the scene. Pure: the
 * caller supplies the store's scenes and actors; the report names every state
 * it could not decide (`ok: false` + `reason`) so the sheet falls back to the
 * hand-set selects honestly instead of guessing.
 */
export function pf1eResolvePositionReport(input: {
  scene: SceneDocument | null;
  actors: readonly ActorDocument[];
  attackerActorId: string;
  targetActorId: string;
  /** The attack line's own rangedness (a derived line's `ranged` flag). */
  ranged: boolean;
  /** The attack line's reach in squares (a derived line's `reachSquares`). */
  reachSquares?: number;
}): PF1eResolvePositionReport {
  const noPosition = (reason: string): PF1eResolvePositionReport => ({
    ok: false,
    reason,
    defense: {},
    flanked: false,
    hostilityAssumed: false,
    reach: null,
  });
  if (input.scene === null) {
    return noPosition("no active scene — flanking and cover are set by hand");
  }
  const scene = input.scene;
  const attackerToken = tokenOfActor(scene, input.attackerActorId);
  if (attackerToken === null) {
    return noPosition(
      "the attacker has no token on the active scene — flanking and cover are set by hand",
    );
  }
  const targetToken = tokenOfActor(scene, input.targetActorId);
  if (targetToken === null) {
    return noPosition(
      "the target has no token on the active scene — flanking and cover are set by hand",
    );
  }

  // Hostility from the scene's own dispositions, the movement seam's contract:
  // a helper counts when every token names a disposition and theirs differs.
  const dispositionOf = new Map(
    scene.tokens.map((t) => [t._id, t.disposition] as const),
  );
  const explicit = scene.tokens.every(
    (t) => (dispositionOf.get(t._id) ?? "neutral") !== "neutral",
  );

  const pair = pf1ePairPosition({
    grid: scene.grid,
    tokens: threatTokensOfScene(scene, input.actors),
    attackerId: attackerToken._id,
    defenderId: targetToken._id,
    ranged: input.ranged,
    ...(input.reachSquares !== undefined
      ? { reachSquares: input.reachSquares }
      : {}),
    walls: sightSegments(scene.walls),
    ...(explicit
      ? {
          isEnemy: (a: string, b: string) =>
            dispositionOf.get(a) !== dispositionOf.get(b),
        }
      : {}),
  });
  if (!pair.ok) {
    return noPosition(
      `the pair's position could not be read (${pair.issues
        .map((i) => i.message)
        .join("; ")})`,
    );
  }

  const defense: PF1ePositionalDefense = {
    ...(pair.cover.kind !== "none" ? { cover: pair.cover.kind } : {}),
    ...(pair.concealment.percent > 0
      ? {
          concealment: {
            percent: pair.concealment.percent,
            ...(pair.concealment.label !== null &&
            pair.concealment.label !== ""
              ? { label: pair.concealment.label }
              : {}),
          },
        }
      : {}),
  };
  return {
    ok: true,
    reason: null,
    defense,
    flanked: pair.flanking.flanked,
    hostilityAssumed: !explicit,
    reach: input.ranged ? null : pair.reach,
  };
}

/** The cover grades the select offers beyond the scene's own word. */
export const COVER_GRADE_OPTIONS = [
  "partial",
  "soft",
  "standard",
  "improved",
] as const;

/** One sentence for the sheet's hint line: what the scene says, or why not. */
export function resolvePositionHint(
  report: PF1eResolvePositionReport,
  names: { attacker: string; target: string },
): string {
  if (!report.ok || report.reason !== null) {
    return `${names.attacker} vs ${names.target}: ${report.reason ?? "position unreadable"}.`;
  }
  const parts: string[] = [];
  if (report.reach !== null && !report.reach.canStrike) {
    parts.push(`out of reach (${report.reach.refusals.join("; ")})`);
  }
  parts.push(
    report.flanked
      ? "flanked (+2 melee)"
      : "not flanked",
  );
  const cover = report.defense.cover;
  parts.push(
    cover === undefined
      ? "no cover"
      : cover === "total"
        ? "total cover — the attack will be refused (AoN 181)"
        : `${cover} cover`,
  );
  if (report.defense.concealment !== undefined) {
    parts.push(
      `${String(report.defense.concealment.percent)}% concealment (d% on a hit, AoN 182)`,
    );
  }
  if (report.hostilityAssumed) {
    parts.push("hostility assumed — a token named no disposition");
  }
  return `${names.attacker} vs ${names.target}: ${parts.join("; ")}.`;
}
