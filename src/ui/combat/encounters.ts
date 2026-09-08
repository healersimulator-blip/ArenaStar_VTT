import type { CombatDocument, SceneDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { can } from "../../core/permissions";

/** No schema extension: bindings and the single active pointer use scoped flags. */
export function encounterList(
  combats: readonly CombatDocument[],
  scene: SceneDocument,
  legacySceneId: string,
): CombatDocument[] {
  return combats.filter((c) => {
    const binding = c.flags.core?.sceneId;
    return binding === scene._id || (binding === undefined && scene._id === legacySceneId);
  });
}
export function selectedEncounter(
  combats: readonly CombatDocument[],
  scene: SceneDocument,
  legacySceneId: string,
): CombatDocument | null {
  const list = encounterList(combats, scene, legacySceneId);
  const id = scene.flags.core?.activeCombatId;
  // A deleted/stale explicit selection must not silently switch to a different encounter.
  return id === undefined ? (list[0] ?? null) : (list.find((c) => c._id === id) ?? null);
}
export function activateEncounter(
  scene: SceneDocument,
  combat: CombatDocument,
  user: PermissionUser | null,
  legacySceneId: string,
): { ops: Op[]; error: string | null } {
  if (!user || !can(user, "update", scene, "scenes") || !can(user, "update", combat, "combats"))
    return { ops: [], error: "You cannot activate this encounter." };
  if (!encounterList([combat], scene, legacySceneId).length)
    return { ops: [], error: "Encounter belongs to a different scene." };
  return {
    error: null,
    ops: [
      {
        kind: "update",
        ref: { coll: "scenes", id: scene._id },
        diff: { "flags.core": { ...scene.flags.core, activeCombatId: combat._id } },
      },
    ],
  };
}
export function newEncounter(
  scene: SceneDocument,
  id: string,
  name: string,
  nextId: () => string,
): CombatDocument {
  return {
    _id: id,
    type: "combat",
    name,
    ownership: { default: 1 },
    flags: { core: { sceneId: scene._id } },
    system: {},
    round: 0,
    turn: 0,
    combatants: scene.tokens.map((t) => ({
      _id: nextId(),
      type: "combatant",
      name: t.name,
      ownership: { default: 1 },
      flags: {},
      system: {},
      tokenId: t._id,
      actorId: t.actorId ?? null,
      initiative: null,
      hidden: false,
      defeated: false,
    })),
  };
}
