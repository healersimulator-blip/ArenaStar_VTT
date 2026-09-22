/**
 * D-269 (plan §3.1) — the profile and every op that writes it.
 *
 * Two contracts live here. The first is **tolerance**: `hexcrawlProfileOf` is the only reader of
 * a hand-editable flag, and a world file written by a later slice (or edited in a text editor)
 * must degrade to something playable instead of throwing in the canvas. The second is **op
 * shape**: an embedded create/update/delete must carry its parent chain, or the host's store
 * cannot find the cell it is writing (and the op log replays it into the void).
 */
import { describe, expect, test } from "vitest";
import { DocumentStore, type StoreMeta } from "../../src/core/store";
import type { OpEnvelope } from "../../src/core/ops";
import type {
  CellDocument,
  DocRef,
  Json,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import { DEFAULT_DAYLIGHT } from "../../src/core/clock";
import { worldSettingsFrom } from "../../src/core/worldSettings";
import { terrainCatalogOrDefault } from "../../src/core/hexcrawl/terrain";
import type { Op } from "../../src/core/ops";
import {
  HEXCRAWL_FLAG,
  MAX_REVEALED_CELLS,
  MAX_SIGHT_RADIUS,
  hexcrawlProfileOf,
  isHexcrawlScene,
  partyTokenOf,
} from "../../src/core/hexcrawl/types";
import {
  addFeatureOps,
  clearTravelOps,
  createCellOps,
  deleteCellOps,
  disableHexcrawlOps,
  enableHexcrawlOps,
  patchFeatureOps,
  patchHexcrawlOps,
  profileOf,
  revealCellsOps,
  revealFeatureOps,
  serializeProfile,
  setCellTablesOps,
  setDaylightOps,
  setEncounterModeOps,
  setPartyTokenOps,
  setSightOps,
  setTerrainOps,
  setTravelRouteOps,
  dedupeAdjacent,
  newHexcrawlPartyOps,
  newHexcrawlSceneOps,
  newPartyTokenDoc,
  updateCellOps,
} from "../../src/core/hexcrawl/scene";

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Map",
    ownership: { default: 2 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 800,
    darkness: 0,
    grid: {
      type: "hex",
      size: 40,
      distance: 6,
      units: "mi",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    ...over,
  };
}

const flagged = (
  profile: Record<string, Json>,
  over: Partial<SceneDocument> = {},
) => scene({ flags: { core: { [HEXCRAWL_FLAG]: profile } }, ...over });

/**
 * The hexcrawl flag an update op writes. `Op` is a union (a delete has no `diff`), so the test
 * narrows through `unknown` in one place instead of casting at every call site.
 */
function flagOf(ops: readonly Op[]): Record<string, unknown> {
  // Batches may carry a create and an update (the wizard's second submit); the flag is the update.
  const op = ops.find((o) => o.kind === "update");
  if (!op || op.kind !== "update") throw new Error("expected one update op");
  const flags = (op.diff as { flags?: { core?: Record<string, unknown> } })
    .flags;
  const core = flags?.core ?? {};
  return (core[HEXCRAWL_FLAG] as Record<string, unknown>) ?? {};
}

/** The document a create op carries (narrowed in one place, like `flagOf`). */
function createdDoc(ops: readonly Op[]): CellDocument {
  const op = ops[0];
  if (!op || op.kind !== "create") throw new Error("expected one create op");
  return op.data as unknown as CellDocument;
}

/** The diff an update op carries. */
function diffOf(ops: readonly Op[]): Record<string, unknown> {
  const op = ops[0];
  if (!op || op.kind !== "update") throw new Error("expected one update op");
  return op.diff as Record<string, unknown>;
}

const cellDoc = (
  key: string,
  over: Partial<CellDocument> = {},
): CellDocument => ({
  _id: `cell-${key.replace(",", "-")}`,
  type: "cell",
  name: key,
  ownership: { default: 0 },
  flags: {},
  system: {},
  key,
  ...over,
});

describe("reading the profile", () => {
  test("the flag's presence is the switch", () => {
    expect(isHexcrawlScene(scene())).toBe(false);
    expect(isHexcrawlScene(flagged({}))).toBe(true);
    expect(isHexcrawlScene(null)).toBe(false);
    expect(isHexcrawlScene({ flags: { core: { hexcrawl: "yes" } } })).toBe(
      false,
    );
    expect(hexcrawlProfileOf(scene())).toBeNull();
  });

  test("an empty bag reads as every documented default", () => {
    const profile = hexcrawlProfileOf(flagged({})) as NonNullable<
      ReturnType<typeof hexcrawlProfileOf>
    >;
    expect(profile.revealed).toEqual([]);
    expect(profile.sight).toEqual({
      mode: "gm",
      radiusCells: 0,
      radiusWorldUnits: 0,
    });
    expect(profile.partyTokenId).toBeNull();
    expect(profile.encounterMode).toBe("prompt");
    expect(profile.daylight).toEqual(DEFAULT_DAYLIGHT);
    expect(profile.terrain).toBe("pf1e-overland");
    expect(profile.travel).toBeNull();
  });

  test("garbage fields fall back one by one, and numbers are clamped", () => {
    const profile = hexcrawlProfileOf(
      flagged({
        revealed: ["0,0", 7, null, "1,0"],
        sight: { mode: "everyone", radiusCells: 999, radiusWorldUnits: -4 },
        partyTokenId: 42,
        encounterMode: "loud",
        daylight: { dawnHour: "6", duskHour: 30 },
        terrain: "",
        travel: { path: ["only-one"], cursor: 3 },
      }),
    ) as NonNullable<ReturnType<typeof hexcrawlProfileOf>>;
    expect(profile.revealed).toEqual(["0,0", "1,0"]);
    expect(profile.sight.mode).toBe("gm");
    expect(profile.sight.radiusCells).toBe(MAX_SIGHT_RADIUS);
    expect(profile.sight.radiusWorldUnits).toBe(0);
    expect(profile.partyTokenId).toBeNull();
    expect(profile.encounterMode).toBe("prompt");
    expect(profile.daylight).toEqual({ dawnHour: 6, duskHour: 24 });
    expect(profile.terrain).toBe("pf1e-overland");
    expect(profile.travel).toBeNull(); // a one-cell "route" is not a route
  });

  test("a travel plan is read back with its bounds applied", () => {
    const profile = hexcrawlProfileOf(
      flagged({
        travel: {
          path: ["0,0", "1,0", "2,0"],
          cursor: 99,
          progressSeconds: -5,
          speedPerDay: 9_000,
          pace: "sprint",
        },
      }),
    ) as NonNullable<ReturnType<typeof hexcrawlProfileOf>>;
    expect(profile.travel).toEqual({
      path: ["0,0", "1,0", "2,0"],
      cursor: 2,
      progressSeconds: 0,
      speedPerDay: 240,
      pace: "normal",
    });
  });

  test("serializeProfile de-duplicates, caps and keeps the profile's own order", () => {
    const profile = profileOf(flagged({}));
    const out = serializeProfile({
      ...profile,
      revealed: [
        "b",
        "a",
        "b",
        ...Array.from({ length: MAX_REVEALED_CELLS + 10 }, (_, i) => `x${i}`),
      ],
      sight: { mode: "gm+party", radiusCells: 400, radiusWorldUnits: 10 },
    });
    expect(out["version"]).toBe(1);
    expect((out["revealed"] as string[]).length).toBe(MAX_REVEALED_CELLS);
    expect((out["revealed"] as string[]).slice(0, 2)).toEqual(["b", "a"]);
    expect(out["sight"]).toEqual({
      mode: "gm+party",
      radiusCells: MAX_SIGHT_RADIUS,
      radiusWorldUnits: 10,
    });
  });

  test("partyTokenOf only names a token that still exists", () => {
    const token: TokenDocument = {
      _id: "t1",
      type: "token",
      name: "Party",
      ownership: { default: 2 },
      flags: {},
      system: {},
      x: 0,
      y: 0,
      rotation: 0,
      width: 1,
      height: 1,
      img: "",
      hidden: false,
      disposition: "friendly",
      vision: false,
      light: { radius: 0, color: "#ffffff", alpha: 0.5 },
    };
    expect(
      partyTokenOf(flagged({ partyTokenId: "t1" }, { tokens: [token] })),
    ).toBe("t1");
    expect(
      partyTokenOf(flagged({ partyTokenId: "gone" }, { tokens: [token] })),
    ).toBeNull();
    expect(partyTokenOf(flagged({}))).toBeNull();
  });
});

describe("profile ops", () => {
  test("enabling writes the flag; disabling removes it and keeps everything else intact", () => {
    const enable = enableHexcrawlOps(scene());
    expect(enable).toHaveLength(1);
    expect(flagOf(enable)).toMatchObject({
      version: 1,
      encounterMode: "prompt",
    });

    const s = flagged(
      { encounterMode: "auto" },
      { flags: { core: { fog: true, hexcrawl: { encounterMode: "auto" } } } },
    );
    const disableOp = disableHexcrawlOps(s)[0];
    const core =
      disableOp?.kind === "update"
        ? ((disableOp.diff as { flags: { core: Record<string, unknown> } })
            .flags.core ?? {})
        : {};
    expect(core["hexcrawl"]).toBeUndefined();
    expect(core["fog"]).toBe(true); // the other flag survives — this is a merge, not a replace
  });

  test("re-enabling keeps what the scene already had", () => {
    const s = flagged({ revealed: ["0,0"], partyTokenId: "p1" });
    expect(flagOf(enableHexcrawlOps(s))).toMatchObject({
      revealed: ["0,0"],
      partyTokenId: "p1",
    });
  });

  test("a patch that changes nothing writes nothing", () => {
    const s = flagged({ encounterMode: "auto" });
    expect(patchHexcrawlOps(s, { encounterMode: "auto" })).toEqual([]);
    expect(patchHexcrawlOps(s, { encounterMode: "manual" })).toHaveLength(1);
    // Setter sugar goes through the same guard.
    expect(setEncounterModeOps(s, "auto")).toEqual([]);
    expect(setEncounterModeOps(s, "prompt")).toHaveLength(1);
  });

  test("the sight, daylight, terrain and party setters patch only their own key", () => {
    const s = flagged({
      sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
      revealed: ["0,0"],
    });
    const read = (ops: readonly Op[]) => flagOf(ops);
    expect(read(setSightOps(s, { radiusCells: 1 }))["sight"]).toEqual({
      mode: "gm",
      radiusCells: 1,
      radiusWorldUnits: 0,
    });
    expect(read(setSightOps(s, { mode: "gm+party" }))["sight"]).toEqual({
      mode: "gm+party",
      radiusCells: 0,
      radiusWorldUnits: 0,
    });
    expect(read(setDaylightOps(s, 5, 21))["daylight"]).toEqual({
      dawnHour: 5,
      duskHour: 21,
    });
    expect(read(setTerrainOps(s, "custom"))["terrain"]).toBe("custom");
    expect(read(setPartyTokenOps(s, "p9"))["partyTokenId"]).toBe("p9");
    // Clearing only writes when there was something to clear (a no-op patch writes nothing).
    const withParty = flagged({ partyTokenId: "p9" });
    expect(read(setPartyTokenOps(withParty, null))["partyTokenId"]).toBeNull();
    expect(setPartyTokenOps(s, null)).toEqual([]);
    // …and the reveal set is untouched by any of them.
    expect(read(setSightOps(s, { radiusCells: 2 }))["revealed"]).toEqual([
      "0,0",
    ]);
  });

  test("reveal cells opens and closes in one write, and a no-op writes nothing", () => {
    const s = flagged({ revealed: ["0,0", "1,0"] });
    const reveal = (ops: readonly Op[]) => flagOf(ops)["revealed"] as string[];
    expect(reveal(revealCellsOps(s, ["2,0"]))).toEqual(["0,0", "1,0", "2,0"]);
    expect(reveal(revealCellsOps(s, ["2,0"], ["0,0"]))).toEqual(["1,0", "2,0"]);
    expect(revealCellsOps(s, ["0,0"])).toEqual([]); // already open
    expect(revealCellsOps(s, [], ["9,9"])).toEqual([]); // closing an unopened cell is a no-op
  });

  test("a route needs two cells and de-duplicates adjacent repeats", () => {
    const s = flagged({ partyTokenId: "p1" });
    const flag = (ops: readonly Op[]) => flagOf(ops);
    const route = setTravelRouteOps(s, ["0,0", "0,0", "1,0", "1,0", "2,0"], {
      speedPerDay: 30,
      pace: "forced",
    });
    expect(flag(route)["travel"]).toEqual({
      path: ["0,0", "1,0", "2,0"],
      cursor: 0,
      progressSeconds: 0,
      speedPerDay: 30,
      pace: "forced",
    });
    // A one-cell route clears the march instead of writing a degenerate one; a scene that had no
    // march writes nothing at all.
    const marching = flagged({
      travel: {
        path: ["0,0", "1,0"],
        cursor: 1,
        progressSeconds: 0,
        speedPerDay: 24,
        pace: "normal",
      },
    });
    expect(flag(setTravelRouteOps(marching, ["0,0"]))["travel"]).toBeNull();
    expect(setTravelRouteOps(s, ["0,0"])).toEqual([]);
    expect(clearTravelOps(marching)).toHaveLength(1);
    expect(clearTravelOps(s)).toEqual([]);
    expect(dedupeAdjacent([])).toEqual([]);
    expect(dedupeAdjacent(["a", "a"])).toEqual(["a"]);
    // Speed is bounded, not trusted.
    expect(
      (
        flag(setTravelRouteOps(s, ["0,0", "1,0"], { speedPerDay: 0 }))[
          "travel"
        ] as { speedPerDay: number }
      ).speedPerDay,
    ).toBe(1);
  });
});

describe("cell ops", () => {
  test("creating a cell carries the parent chain and the full document", () => {
    const ops = createCellOps(scene(), "cell-9", {
      key: "3,4",
      terrain: "forest",
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "create",
      coll: "cells",
      parent: { coll: "scenes", id: "scene-1" },
    });
    expect(createdDoc(ops)).toMatchObject({
      _id: "cell-9",
      type: "cell",
      key: "3,4",
      terrain: "forest",
      ownership: { default: 0 },
      flags: {},
      system: {},
    });
  });

  test("updating and deleting a cell point at the embedded id, with the parent in the ref", () => {
    const s = scene({ cells: [cellDoc("3,4")] });
    const update = updateCellOps(s, "3,4", { terrain: "marsh" });
    expect(update[0]).toEqual({
      kind: "update",
      ref: {
        coll: "cells",
        id: "cell-3-4",
        parent: { coll: "scenes", id: "scene-1" },
      },
      diff: { terrain: "marsh" },
    });
    expect(deleteCellOps(s, "3,4")[0]).toEqual({
      kind: "delete",
      ref: {
        coll: "cells",
        id: "cell-3-4",
        parent: { coll: "scenes", id: "scene-1" },
      },
    });
    // Cells that do not exist produce nothing (the panel may hold a stale key).
    expect(updateCellOps(s, "9,9", { terrain: "marsh" })).toEqual([]);
    expect(deleteCellOps(s, "9,9")).toEqual([]);
    expect(setCellTablesOps(s, "9,9", ["t1"])).toEqual([]);
    expect(setCellTablesOps(s, "3,4", ["t1", "t2"])[0]).toMatchObject({
      diff: { tables: ["t1", "t2"] },
    });
    expect(diffOf(setCellTablesOps(s, "3,4", ["t1"]))["tables"]).toEqual([
      "t1",
    ]);
  });
});

describe("feature ops", () => {
  const feature = {
    id: "f1",
    name: "Hidden shrine",
    text: "A moss-covered stone.",
    reveal: { kind: "perception" as const, dc: 18 },
    autoReveal: true,
    state: { revealed: false },
  };

  test("features are added, patched and removed as one array write", () => {
    const s = scene({ cells: [cellDoc("0,0")] });
    const added = addFeatureOps(s, "0,0", feature);
    expect(diffOf(added)["features"]).toEqual([feature]);
    const withFeature = scene({
      cells: [cellDoc("0,0", { features: [feature] })],
    });
    const patched = patchFeatureOps(withFeature, "0,0", "f1", {
      text: "A taller stone.",
    });
    const patchedFeature = (
      diffOf(patched)["features"] as Array<typeof feature>
    )[0];
    expect(patchedFeature?.text).toBe("A taller stone.");
    expect(patchedFeature?.reveal).toEqual({ kind: "perception", dc: 18 });
    expect(patchFeatureOps(withFeature, "0,0", "nope", { text: "x" })).toEqual([
      {
        kind: "update",
        ref: {
          coll: "cells",
          id: "cell-0-0",
          parent: { coll: "scenes", id: "scene-1" },
        },
        diff: { features: [feature] },
      },
    ]);
    expect(addFeatureOps(scene(), "0,0", feature)).toEqual([]);
  });

  test("revealing records who and when; hiding clears the receipt; repeats write nothing", () => {
    const s = scene({ cells: [cellDoc("0,0", { features: [feature] })] });
    const revealed = revealFeatureOps(s, "0,0", "f1", true, {
      atClock: 3_600,
      by: "gm",
    });
    const state = (diffOf(revealed)["features"] as Array<{ state: unknown }>)[0]
      ?.state;
    expect(state).toEqual({ revealed: true, atClock: 3_600, by: "gm" });

    const already = scene({
      cells: [
        cellDoc("0,0", {
          features: [{ ...feature, state: { revealed: true, atClock: 1 } }],
        }),
      ],
    });
    expect(revealFeatureOps(already, "0,0", "f1", true)).toEqual([]);
    const hidden = revealFeatureOps(already, "0,0", "f1", false);
    expect(
      (diffOf(hidden)["features"] as Array<{ state: unknown }>)[0]?.state,
    ).toEqual({
      revealed: false,
    });
    // A missing cell or feature is not an error, it is a no-op.
    expect(revealFeatureOps(scene(), "0,0", "f1", true)).toEqual([]);
    expect(revealFeatureOps(s, "0,0", "gone", true, { atClock: 1 })).toEqual(
      [],
    );
  });
});

/** The heterogeneous op list of a whole-wizard submit, split the way a host would read it. */
function creates(
  ops: readonly Op[],
): Array<{ coll: string; parent?: DocRef; data: Record<string, unknown> }> {
  return ops.flatMap((op) =>
    op.kind === "create"
      ? [
          {
            coll: op.coll,
            ...(op.parent ? { parent: op.parent } : {}),
            data: op.data as unknown as Record<string, unknown>,
          },
        ]
      : [],
  );
}

function updates(
  ops: readonly Op[],
): Array<{ id: string; diff: Record<string, unknown> }> {
  return ops.flatMap((op) =>
    op.kind === "update" ? [{ id: op.ref.id, diff: op.diff }] : [],
  );
}

describe("creating a hexcrawl scene (the wizard’s one envelope)", () => {
  const hexGrid = {
    type: "hex" as const,
    size: 40,
    distance: 6,
    units: "mi",
    diagonals: "555" as const,
    hexLayout: "oddQ" as const,
  };

  test("batch 1 creates the scene, leaves the old map, and installs the world terrain; batch 2 adds the party and the profile", () => {
    const existing = scene({ _id: "scene-1", name: "Scene 1", active: true });
    const idle = scene({ _id: "scene-2", name: "Scene 2", active: false });
    const first = newHexcrawlSceneOps({
      id: "scene-marsh",
      name: "Marsh overland",
      width: 2000,
      height: 1500,
      grid: hexGrid,
      img: "hash-1",
      settingsDocs: [],
      scenes: [existing, idle],
      activate: true,
    });

    // The host validates a batch against the store as it stands, so nothing in batch 1 may
    // reference the scene it creates — and the order is the order a GM sees it happen.
    expect(
      first.map((op) => `${op.kind}:${op.kind === "create" ? op.coll : op.ref.coll}`),
    ).toEqual(["create:scenes", "update:scenes", "create:settings"]);

    const sceneCreate = creates(first).find((c) => c.coll === "scenes");
    expect(sceneCreate?.data["_id"]).toBe("scene-marsh");
    expect(sceneCreate?.data["name"]).toBe("Marsh overland");
    expect(sceneCreate?.data["active"]).toBe(true);
    expect(sceneCreate?.data["img"]).toBe("hash-1");
    expect(sceneCreate?.data["width"]).toBe(2000);
    expect(sceneCreate?.data["grid"]).toEqual(hexGrid);
    // Leaving the old map, and never touching a scene that was already idle.
    expect(updates(first)).toEqual([{ id: "scene-1", diff: { active: false } }]);

    // ── batch 2: the party token and the profile that names it ──
    const created = scene({
      _id: "scene-marsh",
      width: 2000,
      height: 1500,
      grid: hexGrid,
      img: "hash-1",
    });
    const second = newHexcrawlPartyOps(created, {
      party: { name: "The Company" },
      profile: {
        sight: { mode: "gm+party", radiusCells: 1, radiusWorldUnits: 0 },
        encounterMode: "auto",
      },
    });
    expect(
      second.map((op) => `${op.kind}:${op.kind === "create" ? op.coll : op.ref.coll}`),
    ).toEqual(["create:tokens", "update:scenes"]);

    const token = creates(second).find((c) => c.coll === "tokens");
    expect(token?.parent).toEqual({ coll: "scenes", id: "scene-marsh" });
    expect(token?.data["x"]).toBe(1000);
    expect(token?.data["y"]).toBe(750);
    expect(token?.data["name"]).toBe("The Company");
    expect((token?.data["flags"] as { core?: { party?: unknown } }).core?.party).toBe(
      true,
    );

    const profile = profileOf(
      scene({
        _id: "scene-marsh",
        flags: {
          core: { [HEXCRAWL_FLAG]: flagOf(second) as unknown as Json },
        },
      }),
    );
    expect(profile.partyTokenId).toBe(token?.data["_id"]);
    expect(profile.sight.mode).toBe("gm+party");
    expect(profile.sight.radiusCells).toBe(1);
    expect(profile.encounterMode).toBe("auto");
    // Untouched keys keep the documented defaults rather than undefined.
    expect(profile.daylight).toEqual(DEFAULT_DAYLIGHT);
    expect(profile.terrain).toBe("pf1e-overland");

    // ── the world's terrain catalog is installed once, with the shipped ladder ──
    const settings = creates(first).find((c) => c.coll === "settings");
    expect(settings?.data["_id"]).toBe("world-settings");
    const terrain = (settings?.data["system"] as { hexTerrain?: { terrains?: unknown[] } })
      .hexTerrain;
    expect(Array.isArray(terrain?.terrains)).toBe(true);
    expect((terrain?.terrains ?? []).length).toBeGreaterThan(0);
  });

  test("a world that already prices its terrain keeps its catalog", () => {
    const docs = [
      {
        _id: "world-settings",
        type: "settings",
        name: "World Settings",
        ownership: { default: 1 },
        flags: {},
        system: { hexTerrain: { id: "custom", terrains: [{ id: "ash", cost: 2 }] } },
      },
    ];
    const ops = newHexcrawlSceneOps({
      id: "scene-1b",
      name: "Second map",
      width: 800,
      height: 600,
      grid: hexGrid,
      settingsDocs: docs,
    });
    expect(creates(ops).some((c) => c.coll === "settings")).toBe(false);
    expect(updates(ops).some((u) => u.id === "world-settings")).toBe(false);
  });

  test("no party step means no token and no partyTokenId, and no activation means no deactivation", () => {
    const first = newHexcrawlSceneOps({
      id: "scene-solo",
      name: "Lone map",
      width: 800,
      height: 600,
      grid: hexGrid,
      // A scene is active, but the wizard is not taking the GM there: nothing is deactivated.
      scenes: [scene({ _id: "scene-1", active: true })],
    });
    expect(first.map((op) => (op.kind === "create" ? op.coll : op.ref.coll))).toEqual([
      "scenes",
    ]);

    const second = newHexcrawlPartyOps(scene({ _id: "scene-solo" }));
    expect(second).toHaveLength(1);
    const profile = hexcrawlProfileOf(
      scene({
        flags: { core: { [HEXCRAWL_FLAG]: flagOf(second) as unknown as Json } },
      }),
    );
    expect(profile?.partyTokenId).toBeNull();
    expect(profile?.sight.mode).toBe("gm");
    expect(profile?.encounterMode).toBe("prompt");
  });

  test("a party token is a plain token whose one special fact is the flag", () => {
    const token = newPartyTokenDoc("t-1", 10, 20, "Wanderers");
    expect(token.ownership.default).toBe(3);
    expect(token.disposition).toBe("friendly");
    expect(token.light).toEqual({ radius: 0, color: "#ffffff", alpha: 0.5 });
    // `partyTokenOf` answers from the profile's cache, so a linked token is found by id …
    expect(
      partyTokenOf(flagged({ partyTokenId: "t-1" }, { tokens: [token] })),
    ).toBe("t-1");
    // … and `newHexcrawlSceneOps` writes both halves, so they agree from the first frame.
    const ops = newHexcrawlPartyOps(
      scene({ _id: "scene-p", width: 400, height: 400 }),
      { party: { name: "Wanderers" } },
    );
    const created = creates(ops).find((c) => c.coll === "tokens");
    expect(typeof created?.data["_id"]).toBe("string");
    expect(
      (created?.data["flags"] as { core?: { party?: unknown } }).core?.party,
    ).toBe(true);
  });
});


/**
 * The wizard's envelope has to *apply*, not just look right: a create that the store refuses
 * (a missing parent, a duplicate id, a non-JSON field) would leave the GM on a closed window and
 * the same scene they started on. This is the fake-host half of D-270's browser gate.
 */
describe("the wizard's envelope applies through a real store", () => {
  const meta: StoreMeta = {
    worldId: "w1",
    name: "World",
    system: "mass-battle-basic",
    systemVersion: "1.0.0",
  };
  let tx = 0;
  const env = (seq: number, ops: Op[]): OpEnvelope => {
    tx += 1;
    return { seq, ts: 0, by: "gm-key", ops, txId: `tx-${tx}` };
  };

  test("create, activate, party token, profile and terrain all land", () => {
    const store = new DocumentStore({ meta });
    expect(
      store.applyEnvelope(
        env(1, [{ kind: "create", coll: "scenes", data: scene() }]),
      ).ok,
    ).toBe(true);

    const first = newHexcrawlSceneOps({
      id: "scene-marsh",
      name: "Marsh overland",
      width: 1600,
      height: 1200,
      grid: {
        type: "hex",
        size: 100,
        distance: 6,
        units: "mi",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      img: "abc123",
      settingsDocs: store.getAll("settings"),
      scenes: store.getAll("scenes") as readonly SceneDocument[],
      activate: true,
    });
    expect(store.applyEnvelope(env(2, first)).ok).toBe(true);

    // Batch 2 is built from the scene *as it now exists* — the reason the wizard has two submits.
    const landed = store.get("scenes", "scene-marsh") as SceneDocument;
    const second = newHexcrawlPartyOps(landed, { party: { name: "The Company" } });
    expect(store.applyEnvelope(env(3, second)).ok).toBe(true);

    // The scene the GM is standing on is the new one, with the map the wizard uploaded.
    const created = store.get("scenes", "scene-marsh") as SceneDocument;
    expect(created.name).toBe("Marsh overland");
    expect(created.active).toBe(true);
    expect(created.img).toBe("abc123");
    expect(created.width).toBe(1600);
    expect((store.get("scenes", "scene-1") as SceneDocument).active).toBe(false);

    // The profile names a token that exists on the scene, and the token carries the flag.
    const profile = hexcrawlProfileOf(created);
    expect(profile).not.toBeNull();
    const party = (created.tokens ?? []).find((t) => t._id === profile?.partyTokenId);
    expect(party?.name).toBe("The Company");
    expect(
      (party?.flags as { core?: { party?: unknown } }).core?.party,
    ).toBe(true);

    // The world's terrain catalog is a settings fact, written once.
    const settings = worldSettingsFrom(store.getAll("settings"));
    expect(terrainCatalogOrDefault(settings["hexTerrain"]).terrains.length).toBeGreaterThan(
      5,
    );

    // D-271: a cell create survives the store too. Until the browser spec drove one, the builder
    // produced a document without the `name` a `create` requires and the host refused the whole
    // envelope — a shape-only unit test cannot see that, an applied one can.
    const cellOps = createCellOps(created, "cell-0-0", {
      key: "0,0",
      terrain: "forest",
      description: "The idol is cursed",
      playerText: "A mossy shrine",
    });
    expect(store.applyEnvelope(env(4, cellOps)).ok).toBe(true);
    const withCell = store.get("scenes", "scene-marsh") as SceneDocument;
    expect(withCell.cells).toHaveLength(1);
    expect(withCell.cells?.[0]?.name).toBe("0,0");
    expect(withCell.cells?.[0]?.key).toBe("0,0");

    // …and an update to it is readable back (the hex window's write path).
    expect(
      store.applyEnvelope(
        env(5, [
          {
            kind: "update",
            ref: { coll: "cells", id: "cell-0-0", parent: { coll: "scenes", id: "scene-marsh" } },
            diff: { key: "0,0", system: { explored: true } },
          },
        ]),
      ).ok,
    ).toBe(true);
    expect(
      (store.get("scenes", "scene-marsh") as SceneDocument).cells?.[0]?.system,
    ).toEqual({ explored: true });
  });
});
