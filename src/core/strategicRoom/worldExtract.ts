import { isId, only, point, record } from "./protocol";
import { parseScenario } from "./scenario";

/** Offline, fresh deployment only. The selected docs aren't deserialized into an active world. */
export function extractScenario(documents: unknown, layout: unknown) {
  if (
    !record(documents) ||
    !Array.isArray(documents.docs) ||
    !record(layout) ||
    !only(layout, "sceneId", "name", "seed", "bounds", "slots") ||
    !isId(layout.sceneId) ||
    !record(layout.slots)
  ) {
    throw new Error(
      "Supply exported documents.json and a layout with sceneId, name, seed, bounds and slots.",
    );
  }
  const selected = new Map<string, Record<string, unknown>>();
  for (const row of documents.docs as unknown[]) {
    if (
      !record(row) ||
      !isId(row.id) ||
      !record(row.doc) ||
      !["scenes", "factions", "armies"].includes(String(row.coll))
    )
      continue;
    const key = `${String(row.coll)}:${row.id}`;
    if (selected.has(key)) throw new Error("Duplicate source document ID.");
    selected.set(key, row.doc);
  }
  const scene = selected.get(`scenes:${layout.sceneId}`);
  assertBattleScene(scene);
  const used = new Set<string>();
  const factions = new Map<
    string,
    { id: string; name: unknown; color: unknown }
  >();
  const commanders = Object.entries(layout.slots).map(([id, armyId]) => {
    if (!isId(armyId) || used.has(armyId))
      throw new Error(
        "Assign each source army to a unique new hosted commander slot.",
      );
    const army = selected.get(`armies:${armyId}`);
    if (!army || !isId(army.factionId) || !Array.isArray(army.units))
      throw new Error("Missing source army, faction, or embedded units.");
    used.add(armyId);
    const faction = selected.get(`factions:${army.factionId}`);
    if (
      !faction ||
      (Array.isArray(faction.allies) && faction.allies.length > 0)
    )
      throw new Error("Unsupported faction or alliance.");
    factions.set(army.factionId, {
      id: army.factionId,
      name: faction.name,
      color: faction.color,
    });
    const units = (army.units as unknown[]).map((unit) => {
      if (
        !record(unit) ||
        unit.type !== "infantry" ||
        unit.sceneId !== layout.sceneId ||
        unit.formation !== "line" ||
        unit.leaderTokenId ||
        unit.squadId ||
        unit.doctrine ||
        unit.envelop === true ||
        !record(unit.stats) ||
        !record(unit.profile) ||
        !point(unit.profile.anchor)
      ) {
        throw new Error(
          "Use line infantry in the selected scene, with anchors and without heroes, squads, or doctrine.",
        );
      }
      return {
        id: unit._id,
        name: unit.name,
        strength: unit.stats.strength,
        anchor: unit.profile.anchor,
        weapon: unit.stats.weaponIsRanged ? "shot" : "melee",
      };
    });
    return { id, factionId: army.factionId, units };
  });
  return parseScenario({
    format: "arenastar-strategic-scenario-v1",
    name: layout.name,
    seed: layout.seed,
    bounds: layout.bounds,
    factions: [...factions.values()],
    commanders,
  });
}

export function assertBattleScene(scene: unknown) {
  if (!record(scene)) throw new Error("Missing strategic scene");
  const grid = scene?.grid;
  const flags = scene?.flags;
  const core = record(flags) ? flags.core : null;
  const pf1e = record(flags) ? flags.pf1e : null;
  if (
    !scene ||
    !record(core) ||
    core.scale !== "strategic" ||
    !record(grid) ||
    grid.type !== "square" ||
    grid.distance !== 5 ||
    typeof grid.units !== "string" ||
    !["ft", "feet", "foot"].includes(grid.units.trim().toLowerCase()) ||
    (Array.isArray(scene.walls) && scene.walls.length > 0) ||
    (Array.isArray(scene.levels) && scene.levels.length > 0) ||
    (record(pf1e) && pf1e.difficultCells !== undefined)
  ) {
    throw new Error(
      "Select a 5-ft square strategic scene without walls, levels or authored terrain.",
    );
  }
}
