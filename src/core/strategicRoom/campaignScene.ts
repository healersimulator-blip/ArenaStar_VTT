import type { SceneDocument, DocRef } from "../documents";
import type { Op } from "../ops";
import type { DocumentStore } from "../store";
import { record } from "./protocol";
import { assertBattleScene, extractScenario } from "./worldExtract";
import { parseScenario } from "./scenario";

export type BattleBinding = {
  id: string;
  scene: string;
  world: string;
  armies: string[];
  factions: string[];
  seed: number;
  seats: number;
  strength: number;
};
export function battleOf(
  scene: SceneDocument,
  world: string,
): BattleBinding | null {
  const b = scene.flags?.core?.campaignBattle;
  if (
    !record(b) ||
    b.world !== world ||
    b.scene !== scene._id ||
    typeof b.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(b.id) ||
    !Array.isArray(b.armies) ||
    !Array.isArray(b.factions)
  )
    return null;
  return b as BattleBinding;
}
export function sourceArmies(store: DocumentStore, scene: string) {
  return store
    .getAll("armies")
    .filter((a) => a.units.some((u) => u.sceneId === scene));
}
/** Send a deployment, never documents.json, tokens, private assets or identities. */
export function sceneDeployment(
  store: DocumentStore,
  scene: SceneDocument,
  seed: number,
  seats: number,
  strength = 1,
) {
  assertBattleScene(scene);
  const armies = sourceArmies(store, scene._id);
  const bounds = {
    minX: 0,
    minY: 0,
    maxX: (scene.width / scene.grid.size) * 5,
    maxY: (scene.height / scene.grid.size) * 5,
  };
  const docs = [
    { coll: "scenes", id: scene._id, doc: scene },
    ...store
      .getAll("factions")
      .map((doc) => ({ coll: "factions", id: doc._id, doc })),
    ...armies.map((doc) => ({ coll: "armies", id: doc._id, doc })),
  ];
  const layout = { sceneId: scene._id, name: scene.name, bounds, seed };
  if (armies.length)
    return extractScenario(
      { docs },
      {
        ...layout,
        slots: Object.fromEntries(
          armies.map((a, i) => [`commander-${i + 1}`, a._id]),
        ),
      },
    );
  // Arrange the same files/ranks as deploySnapshot, without overlapping boundary cells.
  if (!Number.isInteger(seats) || seats < 2 || seats > 500)
    throw new Error("Choose 2–500 commander seats.");
  if (!Number.isInteger(strength) || strength < 1 || strength > 100)
    throw new Error("Choose 1–100 models per seat.");
  const files = Math.min(strength, 10),
    ranks = Math.ceil(strength / 10);
  const cols = Math.floor(bounds.maxX / (5 * ranks)),
    rows = Math.floor(bounds.maxY / (5 * files));
  if (cols * rows < seats)
    throw new Error("Enlarge the scene: the selected formations do not fit.");
  const factions = [
    { id: "blue", name: "Blue", color: "#72bbff" },
    { id: "red", name: "Red", color: "#ff887e" },
  ];
  return parseScenario({
    format: "arenastar-strategic-scenario-v1",
    name: scene.name,
    bounds,
    seed,
    factions,
    commanders: Array.from({ length: seats }, (_, i) => {
      const red = i >= Math.ceil(seats / 2),
        j = red ? cols * rows - 1 - (i - Math.ceil(seats / 2)) : i;
      return {
        id: `commander-${i + 1}`,
        name: `Commander ${i + 1}`,
        factionId: red ? "red" : "blue",
        units: [
          {
            id: `unit-${i + 1}`,
            name: `${red ? "Red" : "Blue"} company ${i + 1}`,
            strength,
            weapon: "melee",
            anchor: {
              x: ((j % cols) * ranks + ranks - 0.5) * 5,
              y: (Math.floor(j / cols) * files + files / 2) * 5,
            },
          },
        ],
      };
    }),
  });
}

/** Host commit fence: embedded unit/scene operations count as writes to their parent. */
export function battleBlocks(b: BattleBinding, op: Op): boolean {
  let root: DocRef =
    op.kind === "create"
      ? (op.parent ?? { coll: op.coll, id: op.data._id })
      : op.ref;
  while (root.parent) root = root.parent;
  if (
    (root.coll === "armies" && b.armies.includes(root.id)) ||
    (root.coll === "factions" && b.factions.includes(root.id))
  )
    return true;
  return (
    root.coll === "scenes" &&
    root.id === b.scene &&
    !(
      op.kind === "update" &&
      !op.ref.parent &&
      Object.keys(op.diff).every((k) => k === "active")
    )
  );
}
