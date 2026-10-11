/** G-14 (D-450): stairwells drawn on the map, and edited in place. */
import { describe, expect, test } from "vitest";
import { draftLevel } from "../../src/core/levels";
import { drawnStairwell, floorsBottomUp, stairDirectionsOf, stairEdgesFor, stairEditDiff, type StairEdit } from "../../src/core/stairAuthoring";
import { stairBehaviorError, type StairBehaviorV2 } from "../../src/core/levelPlay";
import type { RegionDocument } from "../../src/core/documents";

const scene = { levels: [draftLevel("upper", "Upper", 10, 20, 2), draftLevel("cellar", "Cellar", -10, 0, 0), draftLevel("ground", "Ground", 0, 10, 1)] };
const z = (id: string) => scene.levels.find((l) => l._id === id)?.floorZ ?? 0;
const region = (stairs: StairBehaviorV2): RegionDocument => ({ _id: "s1", type: "region", name: "Stairs", ownership: { default: 0 }, flags: {}, system: {}, hidden: true,
  x: 100, y: 100, width: 100, height: 200, shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, stairs });

describe("drawing stairs on the map", () => {
  test("they join the floor being viewed and the next one up, travel at once both ways, and are named after their floors", () => {
    const made = drawnStairwell(scene, { x: 200.4, y: 300, width: 99.8, height: 200 }, { id: "drawn", levelId: "ground" });
    if (typeof made === "string") throw new Error(made);
    expect(made).toMatchObject({ _id: "drawn", name: "Stairs Ground ↔ Upper", hidden: true, x: 200, y: 300, width: 100, height: 200, rotation: 0,
      stairs: { version: 2, levels: ["ground", "upper"], mode: "auto" } });
    expect(stairBehaviorError(made.stairs, scene.levels)).toBeNull();
  });

  test("from the top floor they go down; with no floor in view they start at the lowest", () => {
    const top = drawnStairwell(scene, { x: 0, y: 0, width: 100, height: 100 }, { id: "a", levelId: "upper" });
    const none = drawnStairwell(scene, { x: 0, y: 0, width: 100, height: 100 }, { id: "b", levelId: null });
    expect(typeof top !== "string" && top.stairs).toEqual({ version: 2, levels: ["ground", "upper"], mode: "auto" });
    expect(typeof none !== "string" && none.stairs).toEqual({ version: 2, levels: ["cellar", "ground"], mode: "auto" });
  });

  test("a scene needs two floors, and the area must be real", () => {
    expect(drawnStairwell({ levels: [draftLevel("only", "Only")] }, { x: 0, y: 0, width: 100, height: 100 }, { id: "x" })).toContain("add at least two floors");
    expect(drawnStairwell(scene, { x: 0, y: 0, width: 0.5, height: 100 }, { id: "x" })).toBe("Drag a larger area for the stairs.");
  });
});

describe("directions", () => {
  test("up and down are one-way moves between every pair; both needs none; the editor reads them back", () => {
    const ids = floorsBottomUp(scene).map((l) => l._id);
    expect(ids).toEqual(["cellar", "ground", "upper"]);
    expect(stairEdgesFor(ids, "both", z)).toBeUndefined();
    const up = stairEdgesFor(["cellar", "upper"], "up", z) ?? [];
    expect(up).toEqual([{ from: "cellar", to: "upper" }]);
    expect(stairDirectionsOf({ levels: ["cellar", "upper"], edges: up }, z)).toBe("up");
    expect(stairDirectionsOf({ levels: ["cellar", "upper"], edges: [{ from: "upper", to: "cellar" }] }, z)).toBe("down");
    expect(stairDirectionsOf({ levels: ["cellar", "upper"] }, z)).toBe("both");
    expect(stairDirectionsOf({ levels: ["cellar", "upper"], edges: [{ from: "cellar", to: "upper" }, { from: "upper", to: "cellar" }] }, z)).toBe("both");
    expect(stairDirectionsOf({ levels: ["cellar", "ground", "upper"], edges: [{ from: "cellar", to: "upper" }] }, z)).toBe("custom");
  });
});

describe("editing stairs in place", () => {
  const base: StairBehaviorV2 = { version: 2, levels: ["cellar", "ground"], mode: "prompt", locked: true, door: "door-1",
    arrivals: [{ levelId: "cellar", x: 120, y: 150 }, { levelId: "ground", x: 150, y: 150 }] };
  const edit = (patch: Partial<StairEdit>): StairEdit => ({ name: "Stairs", label: "", levels: ["cellar", "ground"], directions: "both", area: { x: 100, y: 100, width: 100, height: 200 }, ...patch });

  test("rename, label, retarget, one direction and a new area in one update; lock, door and kept arrivals stay", () => {
    const diff = stairEditDiff(region(base), scene, edit({ name: " Spiral stair ", label: "Spiral", levels: ["upper", "ground"], directions: "up", area: { x: 50, y: 60, width: 200, height: 100 } }));
    if (typeof diff === "string") throw new Error(diff);
    expect(diff).toEqual({ name: "Spiral stair", x: 50, y: 60, width: 200, height: 100,
      stairs: { version: 2, levels: ["ground", "upper"], mode: "prompt", locked: true, door: "door-1", label: "Spiral", edges: [{ from: "ground", to: "upper" }],
        arrivals: [{ levelId: "ground", x: 150, y: 150 }] } });
    expect(stairBehaviorError(diff.stairs, scene.levels)).toBeNull();
  });

  test("custom one-way moves are kept for the floors that remain; an emptied label is removed", () => {
    const custom: StairBehaviorV2 = { version: 2, levels: ["cellar", "ground", "upper"], mode: "auto", label: "Old", edges: [{ from: "cellar", to: "upper" }, { from: "ground", to: "upper" }] };
    const kept = stairEditDiff(region(custom), scene, edit({ levels: ["ground", "upper"], directions: "custom" }));
    expect(typeof kept !== "string" && kept.stairs).toEqual({ version: 2, levels: ["ground", "upper"], mode: "auto", edges: [{ from: "ground", to: "upper" }] });
    expect(stairEditDiff(region(custom), scene, edit({ levels: ["cellar", "ground"], directions: "custom" }))).toContain("choose a direction");
  });

  test("refusals say why", () => {
    expect(stairEditDiff(region(base), scene, edit({ name: "  " }))).toBe("Stairs need a name of 1–128 characters.");
    expect(stairEditDiff(region(base), scene, edit({ levels: ["ground"] }))).toBe("Choose at least two floors.");
    expect(stairEditDiff(region(base), scene, edit({ area: { x: 0, y: 0, width: 0, height: 10 } }))).toBe("The stairs need a positive width and height.");
    expect(stairEditDiff(region(base), scene, edit({ label: "x".repeat(65) }))).toContain("up to 64");
    expect(stairEditDiff({ ...region(base), stairs: { from: "cellar", to: "ground" } }, scene, edit({}))).toBe("Convert these stairs to a stairwell first.");
  });
});
