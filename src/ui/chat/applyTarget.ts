/**
 * §2.2 item 3 (G-20/D-261) — **the apply verb's target**.
 *
 * A roll card is applied to the token the table has selected, so the whole target derivation is
 * "which actor is the single selected token linked to, and may this user update it". The
 * permission answer is advisory here (the host re-checks it: `roll.apply` in `host/sync.ts`), but
 * showing a player a button that the host will refuse is worse than not showing it — and a target
 * the viewer cannot update is exactly the case a card should render as *no verb* rather than as a
 * verb that fails.
 */
import type { ActorDocument, SceneDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import { can } from "../../core/permissions";

export interface RollApplyTarget {
  actorId: string;
  name: string;
  /** Advisory: `can(user, "update", actor, "actors")` on this replica's actor document. */
  canUpdate: boolean;
}

interface Reader {
  getAll(coll: "scenes" | "actors"): readonly unknown[];
}

/**
 * The target for a roll card, or null when nothing (or more than one thing) is selected, the
 * selected token links to no actor, or that actor is not on this replica.
 */
export function rollApplyTarget(
  reader: Reader,
  user: PermissionUser | null,
  tokenIds: readonly string[],
): RollApplyTarget | null {
  if (tokenIds.length !== 1) return null;
  const tokenId = tokenIds[0];
  const scenes = reader.getAll("scenes") as readonly SceneDocument[];
  let actorId: string | null = null;
  for (const scene of scenes) {
    const token = scene.tokens.find((t) => t._id === tokenId);
    if (token) {
      actorId = token.actorId ?? null;
      break;
    }
  }
  if (actorId === null) return null;
  const actor = (reader.getAll("actors") as readonly ActorDocument[]).find(
    (a) => a._id === actorId,
  );
  if (!actor) return null;
  return {
    actorId: actor._id,
    name: actor.name,
    canUpdate: user !== null && can(user, "update", actor, "actors"),
  };
}

/**
 * Whether a roll card already applied its verb to a target — the label a card shows instead of an
 * enabled button. Reads the same `flags.pf1e.applied` record the host writes.
 */
export function appliedLabelFor(
  applications: Record<string, { damage?: number; healing?: number }>,
  actorId: string,
): string | null {
  const entry = applications[actorId];
  if (!entry) return null;
  const parts: string[] = [];
  if (entry.damage !== undefined) parts.push(`⚔ ${entry.damage}`);
  if (entry.healing !== undefined) parts.push(`✚ ${entry.healing}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
