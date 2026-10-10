import { describe, expect, test } from "vitest";
import type { JournalDocument, SceneDocument } from "../../src/core/documents";
import { DEFAULT_SCENE_EXPRESS_DEFAULTS, uniqueSceneName } from "../../src/core/imageHandling";
import { planImageAction, type ImageActionPlanInput } from "../../src/core/imageActions";

const IMAGE = "a".repeat(64);

function scene(): SceneDocument {
  return {
    _id: "scene-current",
    type: "scene",
    name: "Current",
    ownership: { default: 0 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 800,
    darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "evenQ" },
    background: { offset: { x: 0, y: 0 }, scale: 1, padding: 0, color: "#ffffff" },
    tokens: [{ _id: "token-one", type: "token", name: "One", ownership: { default: 0 }, flags: {}, system: {},
      x: 100, y: 120, rotation: 0, width: 50, height: 50, img: "old.png", hidden: false, disposition: "neutral",
      vision: true, light: { radius: 0, color: "#ffffff", alpha: 0.5 } }],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  };
}

function input(action: ImageActionPlanInput["action"], over: Partial<ImageActionPlanInput> = {}): ImageActionPlanInput {
  const current = scene();
  return {
    action,
    image: IMAGE,
    name: "my map v2",
    width: 3080,
    height: 2520,
    scene: current,
    scenes: [current],
    journals: [],
    selectedTokenIds: ["token-one"],
    sceneDefaults: { ...DEFAULT_SCENE_EXPRESS_DEFAULTS },
    newSceneId: "scene-new",
    newTileId: "tile-new",
    newJournalId: "journal-new",
    newPageId: "page-new",
    targetJournalId: "",
    autoCreateJournal: true,
    autoCreateJournalName: "mini-uploader",
    logicalFolder: "Scenes",
    thumbnail: "b".repeat(64),
    background: { offset: { x: 3, y: 4 }, scale: 1.25, padding: 0.1, color: "#ffffff" },
    sceneSize: { width: 3080, height: 2520 },
    resizeChoice: "keep",
    grid: { type: "square", size: 140, distance: 5, units: "ft", diagonals: "555", hexLayout: "evenQ" },
    assetGridSize: 128,
    foregroundElevation: 5,
    activateNewScene: false,
    ...over,
  };
}

describe("pure image destination action planner", () => {
  test("new scenes derive dimensions, defaults, background metadata and thumbnail", () => {
    const defaults = { ...DEFAULT_SCENE_EXPRESS_DEFAULTS, ownership: "all" as const, activateImmediately: true };
    const plan = planImageAction(input("newScene", { sceneDefaults: defaults }));
    expect(plan.focusSceneId).toBe("scene-new");
    expect(plan.ops).toHaveLength(2); // deactivate current, create the new active scene
    expect(plan.ops[0]).toMatchObject({ kind: "update", ref: { coll: "scenes", id: "scene-current" }, diff: { active: false } });
    const create = plan.ops[1];
    expect(create).toMatchObject({
      kind: "create",
      coll: "scenes",
      data: {
        _id: "scene-new",
        name: "my map v2",
        active: true,
        img: IMAGE,
        width: 3080,
        height: 2520,
        ownership: { default: 1 },
        thumbnail: "b".repeat(64),
        logicalFolder: "Scenes",
        background: { offset: { x: 3, y: 4 }, scale: 1.25, padding: 0.1, color: "#ffffff" },
        tokenVision: false,
        fogExploration: false,
      },
    });
  });

  test("background replacement keeps placeables by default and rescale stays one scene update", () => {
    const keep = planImageAction(input("replaceBackground"));
    expect(keep.ops).toHaveLength(1);
    expect(keep.ops[0]).toMatchObject({
      kind: "update",
      ref: { coll: "scenes", id: "scene-current" },
      diff: { img: IMAGE, width: 3080, height: 2520, thumbnail: "b".repeat(64) },
    });
    if (keep.ops[0]?.kind !== "update") throw new Error("Expected a scene update");
    expect(keep.ops[0].diff.tokens).toBeUndefined();

    const rescaled = planImageAction(input("replaceBackground", { resizeChoice: "rescale" }));
    expect(rescaled.ops).toHaveLength(1);
    if (rescaled.ops[0]?.kind !== "update") throw new Error("Expected a scene update");
    expect(rescaled.ops[0].diff.tokens).toMatchObject([{ x: 308, y: 378, width: 154, height: 157.5 }]);
  });

  test("foreground and the three tile placements use their respective sizing rules", () => {
    const foreground = planImageAction(input("replaceForeground"));
    expect(foreground.ops[0]).toMatchObject({
      kind: "update", ref: { coll: "scenes", id: "scene-current" },
      diff: { foreground: { img: IMAGE, elevation: 5 } },
    });

    const natural = planImageAction(input("tileNatural"));
    expect(natural.ops[0]).toMatchObject({ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "scene-current" },
      data: { x: -1040, y: -860, width: 3080, height: 2520, img: IMAGE } });

    const fit = planImageAction(input("tileFit"));
    expect(fit.ops[0]).toMatchObject({ data: { x: 11.111111111111143, y: 0, width: 977.7777777777777, height: 800 } });

    const grid = planImageAction(input("tileGrid"));
    expect(grid.ops[0]).toMatchObject({ data: { x: -703.125, y: -584.375, width: 2406.25, height: 1968.75, assetGridSize: 128 } });
  });

  test("journal target is reused; otherwise Auto-Create Journal uses the configured name", () => {
    const journal: JournalDocument = {
      _id: "journal-existing", type: "journal", name: "Handouts", ownership: { default: 1 },
      flags: {}, system: {}, pages: [],
    };
    const existing = planImageAction(input("journalPage", {
      journals: [journal], targetJournalId: journal._id,
    }));
    expect(existing.ops[0]).toMatchObject({
      kind: "update", ref: { coll: "journals", id: journal._id },
      diff: { pages: [{ _id: "page-new", type: "page", name: "my map v2", src: IMAGE }] },
    });

    const created = planImageAction(input("journalPage"));
    expect(created.ops[0]).toMatchObject({
      kind: "create", coll: "journals",
      data: { _id: "journal-new", name: "mini-uploader", pages: [{ _id: "page-new", src: IMAGE }] },
    });
    expect(() => planImageAction(input("journalPage", { autoCreateJournal: false })))
      .toThrow(/target journal or enable Auto-Create/i);
  });

  test("token art edits selected tokens; preview/share actions make no document writes", () => {
    const art = planImageAction(input("tokenArt"));
    expect(art.ops[0]).toMatchObject({ kind: "update", ref: { coll: "scenes", id: "scene-current" },
      diff: { tokens: [{ _id: "token-one", img: IMAGE }] } });
    expect(planImageAction(input("preview")).ops).toEqual([]);
    expect(planImageAction(input("showPlayers")).ops).toEqual([]);
    expect(() => planImageAction(input("tokenArt", { selectedTokenIds: ["gone"] })))
      .toThrow(/no longer in this scene/i);
  });

  test("scene-name collision choice can allocate a stable normalized alternative", () => {
    expect(uniqueSceneName("My Map", ["Current", "my map"])).toBe("My Map (2)");
    expect(uniqueSceneName("Fresh", ["Current"])).toBe("Fresh");
  });
});
