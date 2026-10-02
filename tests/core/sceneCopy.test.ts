/** D-371 — tactical/strategic scene copies retain scene-local door and window documents. */
import { describe, expect, test } from "vitest";
import type { SceneDocument, WallDocument } from "../../src/core/documents";
import { wallFieldsFor, wallKindOf } from "../../src/canvas/vision/wallKinds";
import { planDuplicateSceneOps } from "../../src/core/sceneCopy";

function sourceScene(scale: "tactical" | "strategic", walls: WallDocument[]): SceneDocument {
  return {
    _id: `scene-${scale}`,
    type: "scene",
    name: `${scale} battle map`,
    ownership: { default: 0 },
    active: true,
    img: null,
    width: 800,
    height: 600,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    darkness: 0,
    tokens: [],
    walls,
    cells: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    flags: { core: { scale } },
    system: {},
  } as SceneDocument;
}

function fixtureWalls(): WallDocument[] {
  const door = { _id: "door", type: "wall", name: "Vault door", ownership: { default: 0 }, flags: {}, system: {},
    ...wallFieldsFor("door", [100, 100, 200, 100], 2) } as WallDocument;
  const window = { _id: "window", type: "wall", name: "Arrow slit", ownership: { default: 0 }, flags: {}, system: {},
    ...wallFieldsFor("window", [300, 100, 400, 100]) } as WallDocument;
  return [door, window];
}

describe("scene-copy placeables across tactical and strategic scenes (D-371)", () => {
  test.each(["tactical", "strategic"] as const)(
    "%s-scale copies preserve door/window semantics and re-key their IDs",
    (scale) => {
      const walls = fixtureWalls();
      const source = sourceScene(scale, walls);
      const planned = planDuplicateSceneOps({ scene: source, id: `copy-${scale}` });
      expect(planned.ok).toBe(true);
      if (!planned.ok) throw new Error(planned.error);

      expect(planned.copy.flags.core).toMatchObject({ scale });
      expect(planned.copy.walls).toHaveLength(2);
      expect(planned.copy.walls.map(wallKindOf)).toEqual(["door", "window"]);
      expect(planned.copy.walls[0]).toMatchObject({
        name: "Vault door", c: walls[0]?.c, door: 2, sight: 1, move: 1, sound: 1, light: 1,
      });
      expect(planned.copy.walls[1]).toMatchObject({
        name: "Arrow slit", c: walls[1]?.c, door: 0, sight: 2, move: 0, sound: 0, light: 2,
      });
      expect(planned.copy.walls.map((wall) => wall._id)).not.toEqual(walls.map((wall) => wall._id));
      expect(walls.map(wallKindOf)).toEqual(["door", "window"]);
      expect(walls[0]?.door).toBe(2); // cloning does not mutate the source document
    },
  );
});
