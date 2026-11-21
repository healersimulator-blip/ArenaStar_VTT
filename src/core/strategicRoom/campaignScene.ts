import type { SceneDocument, DocRef } from "../documents";
import type { Op } from "../ops";
import type { DocumentStore } from "../store";
import { sceneDifficultCells } from "../rules";
import { parsePF1eActorSystem } from "../../packages/pf1e/actor";
import { PF1E_ENTANGLE_DOCUMENT_ID, record } from "./protocol";
import { assertBattleScene, extractScenario } from "./worldExtract";
import { parseScenario, scenarioProjectionDigest, type Scenario } from "./scenario";

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
/** Visible, explicitly sided scene tokens can seed a constrained hosted deployment. */
export function sourceStrategicTokens(scene: SceneDocument) {
  return scene.tokens.filter(
    (token) => !token.hidden && token.disposition !== "neutral",
  );
}
/** Project authored geometry into battlefield feet. This is rules input, not presentation art. */
function sceneRulesProjection(scene: SceneDocument) {
  const feet = 5 / scene.grid.size;
  const walls = scene.walls.map((wall) => ({
    x1: wall.c[0] * feet,
    y1: wall.c[1] * feet,
    x2: wall.c[2] * feet,
    y2: wall.c[3] * feet,
    // Same compiled convention as TurnChannel: bit0 move, bit1 sight, bit2 sound, bit3 light.
    restriction: (wall.move > 0 ? 1 : 0) | (wall.sight > 0 ? 2 : 0) |
      (wall.sound > 0 ? 4 : 0) | (wall.light > 0 ? 8 : 0),
  }));
  const terrain = sceneDifficultCells(scene);
  return {
    ...(walls.length ? { walls } : {}),
    ...(terrain ? { terrain } : {}),
  };
}

function projectRegularEntangleCasters(store: DocumentStore, scene: SceneDocument, scenario: Scenario): Scenario {
  const armies = sourceArmies(store, scene._id);
  const byUnit = new Map(armies.flatMap((army) => army.units.map((unit) => [unit._id, unit] as const)));
  const commanders = scenario.commanders.map((commander) => ({ ...commander,
    units: commander.units.map((unit) => {
      const source = byUnit.get(unit.id);
      const token = source?.leaderTokenId
        ? scene.tokens.find((candidate) => candidate._id === source.leaderTokenId) : undefined;
      const actor = token?.actorId ? store.get("actors", token.actorId) : undefined;
      const parsed = parsePF1eActorSystem(actor?.system?.pf1e);
      if (!actor || !parsed.ok) return unit;
      const spells = parsed.value.spells;
      const casterLevel = Math.max(1, (spells?.casterLevel ?? 0) + (spells?.casterLevelBonus ?? 0));
      const key = spells?.keyAbility;
      const score = key ? parsed.value.abilities?.[key] : undefined;
      const castingAbilityMod = typeof score === "number" ? Math.floor((score - 10) / 2) : 0;
      const prepared = spells?.prepared?.filter((entry) =>
        entry.name.trim().toLowerCase() === "entangle" && !entry.expended).length ?? 0;
      const knows = spells?.known?.some((entry) =>
        entry.name.trim().toLowerCase() === "entangle" && entry.level === 1) ?? false;
      const availableLevelOne = Math.max(0,
        (spells?.slotsPerDay?.[1] ?? 0) - (spells?.slotsUsed?.[1] ?? 0));
      const entangleSlots = spells?.mode === "spontaneous" && knows
        ? availableLevelOne : prepared;
      if (entangleSlots < 1) return unit;
      return { ...unit, spellcasting: { actorId: actor._id, itemId: PF1E_ENTANGLE_DOCUMENT_ID,
        casterLevel, castingAbilityMod, entangleSlots } };
    }),
  }));
  return { ...scenario, commanders };
}

export function strategicActionCardPolicy(scene: SceneDocument) {
  const configured = scene.flags?.core?.strategicActionCards;
  if (record(configured) && typeof configured.playerCharacters === "boolean" &&
    typeof configured.units === "boolean" && typeof configured.models === "boolean")
    return { playerCharacters: configured.playerCharacters, units: configured.units,
      models: configured.models };
  // Safe scale default: hero/unit events may publish; never emit one card per model unless opted in.
  return { playerCharacters: true, units: true, models: false };
}

/** Send a validated battle projection, never the unrelated campaign graph or executable scripts. */
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
  const rulesProjection = sceneRulesProjection(scene);
  const projected = (input: unknown): Scenario => {
    const payload = parseScenario({ ...(input as object), actionCards: strategicActionCardPolicy(scene) });
    const digest = scenarioProjectionDigest(payload);
    return parseScenario({ ...payload, projection: {
      format: "arenastar-battle-projection-v1",
      worldId: store.meta.worldId,
      sceneId: scene._id,
      sourceSeq: store.seq,
      systemId: store.meta.system,
      systemVersion: store.meta.systemVersion,
      digest,
    } });
  };
  if (armies.length) {
    const extracted = extractScenario(
      { docs },
      {
        ...layout,
        slots: Object.fromEntries(
          armies.map((a, i) => [`commander-${i + 1}`, a._id]),
        ),
      },
    );
    return projected(projectRegularEntangleCasters(store, scene,
      parseScenario({ ...extracted, ...rulesProjection })));
  }
  if (!Number.isInteger(strength) || strength < 1 || strength > 120)
    throw new Error("Choose 1–120 models per unit.");
  const tokens = sourceStrategicTokens(scene);
  if (tokens.length) {
    if (tokens.length < 2 || tokens.length > 500)
      throw new Error("Use 2–500 visible friendly/hostile tokens for a hosted deployment.");
    const sides = new Set(tokens.map((token) => token.disposition));
    if (!sides.has("friendly") || !sides.has("hostile"))
      throw new Error("Token deployment needs at least one friendly and one hostile token.");
    const factions = [
      { id: "friendly", name: "Friendly", color: "#72bbff" },
      { id: "hostile", name: "Hostile", color: "#ff887e" },
    ];
    if (!Number.isInteger(seats) || seats < 2 || seats > tokens.length)
      throw new Error(`Choose 2–${tokens.length} commander seats for this token deployment.`);
    const friendlySeats = Math.max(1, Math.min(seats - 1, Math.round(
      (seats * tokens.filter((token) => token.disposition === "friendly").length) / tokens.length,
    )));
    const sideSeats = { friendly: friendlySeats, hostile: seats - friendlySeats };
    const commanders = ["friendly", "hostile"].flatMap((factionId) => {
      const side = tokens.filter((token) => token.disposition === factionId);
      const count = sideSeats[factionId as keyof typeof sideSeats];
      if (side.length < count)
        throw new Error(`${factionId} needs at least ${count} visible tokens for ${seats} seats.`);
      return Array.from({ length: count }, (_, seatIndex) => ({
        id: "",
        name: `${factionId === "friendly" ? "Friendly" : "Hostile"} commander ${seatIndex + 1}`,
        factionId,
        units: side.filter((_, unitIndex) => unitIndex % count === seatIndex).map((token) => {
          const index = tokens.indexOf(token);
          return {
            id: `unit-${index + 1}`,
            name: token.name,
            strength,
            weapon: "melee" as const,
            anchor: {
              x: ((token.x + token.width / 2) / scene.grid.size) * 5,
              y: ((token.y + token.height / 2) / scene.grid.size) * 5,
            },
          };
        }),
      }));
    });
    commanders.forEach((commander, index) => { commander.id = `commander-${index + 1}`; });
    return projected({
      format: "arenastar-strategic-scenario-v1",
      name: scene.name,
      bounds,
      seed,
      ...rulesProjection,
      factions,
      commanders,
    });
  }
  // Arrange the same files/ranks as deploySnapshot, without overlapping boundary cells.
  if (!Number.isInteger(seats) || seats < 2 || seats > 500)
    throw new Error("Choose 2–500 commander seats.");
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
  return projected({
    format: "arenastar-strategic-scenario-v1",
    name: scene.name,
    bounds,
    seed,
    ...rulesProjection,
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
