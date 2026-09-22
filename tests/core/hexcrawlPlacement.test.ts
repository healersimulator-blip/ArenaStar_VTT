/**
 * D-274 (plan §5.5/§5.6) — the two pieces of geometry a resolved encounter needs: where its tokens
 * stand (`core/hexcrawl/placement.ts`) and what a copied battle scene looks like
 * (`core/sceneCopy.ts`). Both are pure, which is the point: the browser spec can only tell you a
 * window opened, and "the tokens are not in one spot" is arithmetic.
 */
import { describe, expect, test } from "vitest";
import type {
  CellDocument,
  SceneDocument,
  TokenDocument,
  WallDocument,
} from "../../src/core/documents";
import {
  encounterLogOf,
  logEncounterOps,
  type EncounterLogEntry,
} from "../../src/core/hexcrawl/encounter";
import {
  encounterTokenData,
  placeEncounterTokens,
  placementSpacing,
  wallDistance,
} from "../../src/core/hexcrawl/placement";
import { copyName, duplicateSceneOps } from "../../src/core/sceneCopy";

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Forest road",
    active: true,
    img: "asset-hash-1",
    width: 1600,
    height: 1200,
    grid: {
      type: "hex",
      size: 100,
      distance: 6,
      units: "mi",
      diagonals: "euclidean",
      hexLayout: "oddQ",
    },
    darkness: 0,
    tokens: [],
    walls: [],
    cells: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    flags: {},
    system: {},
    ...over,
  } as SceneDocument;
}

const wall = (id: string, c: [number, number, number, number]): WallDocument =>
  ({ _id: id, type: "wall", c, door: 0, oneWay: false, move: 1, sight: 1, sound: 1, light: 1 }) as WallDocument;

const token = (id: string, name = id, x = 0, y = 0): TokenDocument =>
  ({
    _id: id,
    type: "token",
    name,
    ownership: { default: 3 },
    flags: {},
    system: {},
    x,
    y,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  }) as TokenDocument;

const cell = (key: string, id = `cell-${key}`): CellDocument =>
  ({ _id: id, type: "cell", key, flags: {}, system: {} }) as CellDocument;

describe("placeEncounterTokens (§5.5)", () => {
  test("the first token takes the origin, and no two are closer than one cell", () => {
    const points = placeEncounterTokens({
      scene: scene(),
      origin: { x: 800, y: 600 },
      count: 6,
    });
    expect(points).toHaveLength(6);
    expect(points[0]).toMatchObject({ x: 800, y: 600, blocked: false });
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        if (!a || !b) throw new Error("missing point");
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        // "not in one spot, but near each other" — the requirement's own words, as arithmetic.
        expect(distance).toBeGreaterThanOrEqual(100);
      }
    }
  });

  test("it always places every creature, even where a wall blocks the ring", () => {
    // A wall right beside the drop point: the origin is clear, the first ring is not.
    const walls = [wall("w1", [790, 500, 810, 700])];
    const points = placeEncounterTokens({
      scene: scene({ walls }),
      origin: { x: 700, y: 600 },
      count: 8,
    });
    expect(points).toHaveLength(8);
    // Every position is on the map, and at least the origin is clear of the wall.
    for (const p of points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1600);
      expect(p.y).toBeLessThan(1200);
    }
    const first = points[0];
    if (!first) throw new Error("no first point");
    expect(wallDistance(walls, first)).toBeGreaterThanOrEqual(50);
  });

  test("a drop beside the map's edge stays on the map", () => {
    const points = placeEncounterTokens({
      scene: scene(),
      origin: { x: 20, y: 20 },
      count: 7,
    });
    expect(points).toHaveLength(7);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(50);
      expect(p.y).toBeGreaterThanOrEqual(50);
      expect(p.x).toBeLessThanOrEqual(1550);
      expect(p.y).toBeLessThanOrEqual(1150);
    }
  });

  test("zero is zero (an empty roll places nothing, and says so by returning nothing)", () => {
    expect(placeEncounterTokens({ scene: scene(), origin: { x: 10, y: 10 }, count: 0 })).toEqual([]);
    expect(placeEncounterTokens({ scene: scene(), origin: { x: 10, y: 10 }, count: -3 })).toEqual([]);
  });

  test("the spacing is the scene's own cell size, and 100 px on a gridless map", () => {
    expect(placementSpacing(scene())).toBe(100);
    expect(placementSpacing(scene({ grid: { ...scene().grid, size: 140 } }))).toBe(140);
    expect(
      placementSpacing(
        scene({ grid: { ...scene().grid, type: "gridless", size: 0 } }),
      ),
    ).toBe(100);
    // 140 px cells → the positions are 140 apart, not 100.
    const points = placeEncounterTokens({
      scene: scene({ grid: { ...scene().grid, size: 140 } }),
      origin: { x: 700, y: 600 },
      count: 2,
    });
    const [p0, p1] = points;
    if (!p0 || !p1) throw new Error("two points expected");
    expect(Math.hypot(p0.x - p1.x, p0.y - p1.y)).toBe(140);
  });
});

describe("encounterTokenData (§5.5)", () => {
  test("one token per entry, hostile, linked to its actor, with the prototype's own size", () => {
    let n = 0;
    const tokens = encounterTokenData(
      [
        { actorId: "actor-1", name: "Goblin", img: "goblin.png", width: 100, height: 100 },
        { actorId: null, name: "A wary merchant", img: "" },
      ],
      [
        { x: 100, y: 200, blocked: false },
        { x: 200, y: 200, blocked: false },
      ],
      () => `t-${(n += 1)}`,
    );
    expect(tokens.map((t) => [t._id, t.name, t.x, t.y])).toEqual([
      ["t-1", "Goblin", 100, 200],
      ["t-2", "A wary merchant", 200, 200],
    ]);
    expect(tokens[0]?.actorId).toBe("actor-1");
    expect(tokens[0]?.img).toBe("goblin.png");
    // A bare text row places a token too — it is what the party actually sees.
    expect(tokens[1]?.actorId).toBeUndefined(); // a text row has no actor to link to
    expect(tokens.every((t) => t.disposition === "hostile")).toBe(true);
    // More points than entries (or the reverse) places what it can rather than throwing.
    expect(encounterTokenData([], [], () => "t").length).toBe(0);
  });
});

describe("duplicateSceneOps (§5.6)", () => {
  test("the copy carries every child re-keyed, and shares the map image by hash", () => {
    const source = scene({
      tokens: [token("t1", "Hero", 100, 100), token("t2", "Orc", 200, 200)],
      walls: [wall("w1", [0, 0, 100, 0])],
      cells: [cell("0,0")],
      notes: [{ _id: "n1", type: "note", x: 5, y: 5, text: "x" } as never],
      lights: [{ _id: "l1", type: "light" } as never],
      tiles: [{ _id: "tl1", type: "tile" } as never],
      drawings: [{ _id: "d1", type: "drawing" } as never],
      templates: [{ _id: "tp1", type: "template" } as never],
      sounds: [{ _id: "s1", type: "sound" } as never],
    });
    let n = 0;
    const ops = duplicateSceneOps({
      scene: source,
      id: "scene-copy",
      nextId: (kind) => `${kind}-new-${(n += 1)}`,
    });
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (op?.kind !== "create" || op.coll !== "scenes") throw new Error("no scene create");
    const copy = op.data as unknown as SceneDocument;
    expect(copy._id).toBe("scene-copy");
    expect(copy.name).toBe("Forest road (copy)");
    expect(copy.img).toBe("asset-hash-1"); // the bytes are the *same asset*, not a copy
    expect(copy.tokens.map((t) => t._id)).toEqual(["t-new-1", "t-new-2"]);
    expect(copy.walls.map((w) => w._id)).toEqual(["w-new-3"]);
    expect(copy.notes.map((note) => note._id)).toEqual(["n-new-4"]);
    expect((copy.cells ?? []).map((c) => c._id)).toEqual(["c-new-5"]);
    expect(copy.cells?.[0]?.key).toBe("0,0"); // a copied hex is still the same hex
    expect(copy.lights.map((light) => light._id)).toEqual(["l-new-6"]);
    expect(copy.sounds.map((sound) => sound._id)).toEqual(["s-new-7"]);
    expect(copy.tiles.map((tile) => tile._id)).toEqual(["tl-new-8"]);
    expect(copy.drawings.map((drawing) => drawing._id)).toEqual(["d-new-9"]);
    expect(copy.templates.map((template) => template._id)).toEqual(["tp-new-10"]);
    // …and the original is untouched: the copy is a new document, not a mutation.
    expect(source.tokens.map((t) => t._id)).toEqual(["t1", "t2"]);
  });

  test("the encounter's own tokens ride inside the copy", () => {
    const ops = duplicateSceneOps({
      scene: scene({ tokens: [token("t1")] }),
      id: "scene-battle",
      extraTokens: [token("t-go1", "Goblin", 400, 400), token("t-go2", "Goblin", 500, 400)],
    });
    const copy = (ops[0] as unknown as { data: SceneDocument }).data;
    expect(copy.tokens.map((t) => t.name)).toEqual(["t1", "Goblin", "Goblin"]);
    expect(copy.tokens[1]?.x).toBe(400);
  });

  test("activate writes the copy's flag and clears the scene it replaces", () => {
    const source = scene({ active: true });
    const other = scene({ _id: "scene-2", name: "Dungeon", active: true });
    const ops = duplicateSceneOps({
      scene: source,
      id: "scene-copy",
      nextId: (k) => `${k}-1`,
      activate: true,
      scenes: [source, other],
    });
    type Row = { kind: string; ref?: { id: string }; data?: { _id?: string }; diff?: unknown };
    const rows = ops as unknown as Row[];
    // The copy's own `active` rides *inside* the create: the host resolves an `update` ref against
    // the store before the batch, so a follow-up update on a document created beside it is refused
    // (and takes the whole envelope with it).
    expect(
      rows.map((o) => [o.kind, o.ref?.id ?? o.data?._id]),
    ).toEqual([
      ["create", "scene-copy"],
      ["update", "scene-2"],
    ]);
    expect((rows[0]?.data as { active?: boolean } | undefined)?.active).toBe(true);
    expect(rows[1]?.diff).toEqual({ active: false });
  });

  test("a name that is already a copy is not stacked into `(copy) (copy)`", () => {
    expect(copyName("Forest road")).toBe("Forest road (copy)");
    expect(copyName("Forest road (copy)")).toBe("Forest road (copy)");
    expect(copyName("Forest road (copy 2)")).toBe("Forest road (copy 2)");
  });
});

/** `Op` is a union; the log op is always an `update`, and these two read it without narrowing. */
function flagsOf(op: { kind: string } | undefined): Record<string, unknown> {
  const update = op as unknown as { diff?: { flags?: Record<string, unknown> } } | undefined;
  return update?.diff?.flags ?? {};
}

function flagsCoreOf(op: { kind: string } | undefined): unknown {
  return flagsOf(op)["core"];
}

/** A scene with one authored cell — the log lives on the cell's `flags.core` (D-269). */
const cellScene = (): SceneDocument => scene({ cells: [cell("6,3")] });

function entry(over: Partial<EncounterLogEntry> = {}): EncounterLogEntry {
  return {
    tableId: "t1",
    tableName: "Goblin scouts",
    roll: 66,
    text: "2 goblin scouts",
    sceneId: null,
    atClock: 3600,
    ...over,
  };
}

describe("the cell's encounter log (§5.6)", () => {
  test("a resolved encounter is appended to its cell, newest last", () => {
    const scene = cellScene();
    const ops = logEncounterOps(scene, "6,3", entry({ sceneId: "scene-battle" }));
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe("update");
    // The whole `flags` object travels: a flat diff cannot create a missing intermediate (D-012).
    const core = flagsCoreOf(ops[0]) as { encounterLog?: EncounterLogEntry[] };
    expect(core.encounterLog?.[0]?.sceneId).toBe("scene-battle");
    expect(core.encounterLog?.[0]?.text).toBe("2 goblin scouts");
  });

  test("the log is bounded — a hex visited for a campaign keeps the last 20", () => {
    let scene = cellScene();
    for (let i = 0; i < 25; i++) {
      const ops = logEncounterOps(scene, "6,3", entry({ roll: i }));
      const flags = flagsOf(ops[0]);
      scene = {
        ...scene,
        cells: (scene.cells ?? []).map((c) =>
          c.key === "6,3" ? ({ ...c, flags } as CellDocument) : c,
        ),
      };
    }
    const log = encounterLogOf(scene, "6,3");
    expect(log).toHaveLength(20);
    expect(log.at(0)?.roll).toBe(5);
    expect(log.at(-1)?.roll).toBe(24);
  });

  test("a cell nobody has authored has nothing to append to", () => {
    expect(logEncounterOps(cellScene(), "9,9", entry())).toEqual([]);
    expect(encounterLogOf(cellScene(), "9,9")).toEqual([]);
  });
});
