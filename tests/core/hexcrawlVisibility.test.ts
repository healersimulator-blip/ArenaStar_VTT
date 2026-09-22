/**
 * D-271 (plan §3.5/§4) — the open set, the party's ring, and the projection rule.
 *
 * The projection suite is deliberately the paranoid half: it asserts what a *player* is sent,
 * not what the canvas draws, because the document is the gate (D-256's lesson).
 */
import { describe, expect, test } from "vitest";
import type {
  CellDocument,
  CellFeature,
  Json,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import {
  cellVisibilityChanges,
  isCellOpen,
  openCellKeys,
  partyCellKey,
  partyPointOf,
  partySightKeys,
  projectCellForViewer,
  sightReconcileOps,
} from "../../src/core/hexcrawl/visibility";

/** A `flags.core.hexcrawl` bag as the ops would write it (flat, JSON-only). */
function profileFlag(
  over: Partial<{
    revealed: string[];
    mode: "gm" | "gm+party";
    radiusCells: number;
    radiusWorldUnits: number;
    partyTokenId: string | null;
  }> = {},
): Json {
  return {
    version: 1,
    revealed: over.revealed ?? [],
    sight: {
      mode: over.mode ?? "gm",
      radiusCells: over.radiusCells ?? 0,
      radiusWorldUnits: over.radiusWorldUnits ?? 0,
    },
    partyTokenId: over.partyTokenId === undefined ? null : over.partyTokenId,
    encounterMode: "prompt",
    daylight: { dawnHour: 6, duskHour: 18 },
    terrain: "pf1e-overland",
    travel: null,
  } as unknown as Json;
}

const token = (over: Partial<TokenDocument> = {}): TokenDocument => ({
  _id: "party",
  type: "token",
  name: "Party",
  ownership: { default: 2 },
  flags: {},
  system: {},
  // `TokenDocument.x/y` is the token's CENTRE and width/height are pixels (see `partyCentreOf`):
  // a one-hex party token on this 50 px grid is 50 px wide, centred wherever it stands.
  x: 0,
  y: 0,
  width: 50,
  height: 50,
  rotation: 0,
  img: "",
  hidden: false,
  disposition: "friendly",
  vision: false,
  light: { color: "#fff", alpha: 1, radius: 0 },
  ...over,
});

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Overland",
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
      size: 50,
      distance: 6,
      units: "mi",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    cells: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    ...over,
  };
}

const cell = (key: string, over: Partial<CellDocument> = {}): CellDocument => ({
  _id: `cell-${key.replace(",", "-")}`,
  type: "cell",
  name: key,
  ownership: { default: 0 },
  flags: {},
  system: {},
  key,
  ...over,
});

const feature = (id: string, revealed: boolean): CellFeature => ({
  id,
  name: `Feature ${id}`,
  text: "The old shrine",
  img: "hash-shrine",
  reveal: { kind: "manual" },
  autoReveal: false,
  state: { revealed },
});

describe("the party's ring", () => {
  test("gridded: radius 0 is the party's own cell, radius 1 is that cell and its six neighbours", () => {
    const s = scene({
      flags: {
        core: {
          hexcrawl: profileFlag({
            mode: "gm+party",
            radiusCells: 0,
            partyTokenId: "party",
          }),
        },
      },
      tokens: [token({ x: 0, y: 0 })],
    });
    const own = partyCellKey(s);
    expect(own).toBe("0,0");
    expect(partySightKeys(s)).toEqual([own]);

    const wide = scene({
      flags: {
        core: {
          hexcrawl: profileFlag({
            mode: "gm+party",
            radiusCells: 1,
            partyTokenId: "party",
          }),
        },
      },
      tokens: [token({ x: 0, y: 0 })],
    });
    // The six neighbours and the centre — oddQ, flat-top: the ring the map draws.
    expect(partySightKeys(wide).sort()).toEqual(
      ["-1,-1", "-1,0", "0,-1", "0,0", "0,1", "1,-1", "1,0"].sort(),
    );
    expect(partySightKeys(wide)).toHaveLength(7);
  });

  test("`gm` mode adds nothing, however close the party stands", () => {
    const s = scene({
      flags: { core: { hexcrawl: profileFlag({ mode: "gm" }) } },
      tokens: [token()],
    });
    expect(partySightKeys(s)).toEqual([]);
    expect(openCellKeys(s).size).toBe(0);
  });

  test("no party token, no ring — and no crash", () => {
    const s = scene({
      flags: {
        core: {
          hexcrawl: profileFlag({
            mode: "gm+party",
            radiusCells: 2,
            partyTokenId: null,
          }),
        },
      },
      tokens: [token({ _id: "other" })],
    });
    expect(partyPointOf(s)).toBeNull();
    expect(partySightKeys(s)).toEqual([]);
  });

  test("gridless: the ring is a distance in world units, and the party's own zone is always in it", () => {
    const s = scene({
      grid: {
        type: "gridless",
        size: 100,
        distance: 6,
        units: "mi",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      flags: {
        core: {
          hexcrawl: profileFlag({
            mode: "gm+party",
            radiusWorldUnits: 30,
            partyTokenId: "party",
          }),
        },
      },
      tokens: [token({ x: 0, y: 0 })],
      cells: [
        // The token's centre is (50, 50) on a 100 px grid: the near zone contains it.
        cell("near", { poly: [0, 0, 120, 0, 120, 120, 0, 120] }),
        cell("far", { poly: [500, 500, 600, 500, 600, 600, 500, 600] }),
      ],
    });
    expect(partyCellKey(s)).toBe("near");
    expect(partySightKeys(s)).toEqual(["near"]);
  });
});

describe("the open set and the ring's writes", () => {
  const base = scene({
    flags: {
      core: {
        hexcrawl: profileFlag({
          revealed: ["9,9"],
          mode: "gm+party",
          radiusCells: 0,
          partyTokenId: "party",
        }),
      },
    },
    tokens: [token({ x: 0, y: 0 })],
  });

  test("open = revealed ∪ ring, and `isCellOpen` reads the same set", () => {
    expect([...openCellKeys(base)].sort()).toEqual(["0,0", "9,9"]);
    expect(isCellOpen(base, "0,0")).toBe(true);
    expect(isCellOpen(base, "9,9")).toBe(true);
    expect(isCellOpen(base, "4,4")).toBe(false);
  });

  test("the ring writes only what it adds — and nothing at all once the cell is in the set", () => {
    const ops = sightReconcileOps(base);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (!op || op.kind !== "update") throw new Error("expected a scene update");
    // The whole `flags` object is the write (D-269): the profile rides inside it.
    const flags = op.diff["flags"] as {
      core?: { hexcrawl?: { revealed?: string[] } };
    } | null;
    expect(flags?.core?.hexcrawl?.revealed?.slice().sort()).toEqual([
      "0,0",
      "9,9",
    ]);
    // Second pass: the ring is known, so the builder returns no ops at all (a no-op is not a write).
    const settled = scene({
      flags: {
        core: {
          hexcrawl: profileFlag({
            revealed: ["0,0", "9,9"],
            mode: "gm+party",
            radiusCells: 0,
            partyTokenId: "party",
          }),
        },
      },
      tokens: [token({ x: 0, y: 0 })],
    });
    expect(sightReconcileOps(settled)).toEqual([]);
    expect(sightReconcileOps(null)).toEqual([]);
  });

  test("a scene that is not a hexcrawl writes nothing (no profile, no ring)", () => {
    expect(sightReconcileOps(scene())).toEqual([]);
  });
});

describe("the projection rule (what a player is actually sent)", () => {
  const rich = cell("0,0", {
    terrain: "forest",
    description: "A hidden shrine, the idol is cursed",
    playerText: "A mossy stone shrine",
    tables: ["tbl-night"],
    features: [feature("f-open", true), feature("f-secret", false)],
  });
  const closed = cell("1,1", {
    terrain: "mountains",
    description: "The dragon sleeps here",
    playerText: "Tall peaks",
    tables: ["tbl-hoard"],
    features: [feature("f-hidden", false)],
  });

  test("an open cell keeps the player text, loses the GM text and the unrevealed feature", () => {
    const out = projectCellForViewer(rich, new Set(["0,0"]));
    if (!out) throw new Error("an open cell is sent");
    expect(out.playerText).toBe("A mossy stone shrine");
    expect(out.description).toBeUndefined();
    expect(out.tables).toEqual(["tbl-night"]);
    expect(out.features?.map((f) => f.id)).toEqual(["f-open"]);
    expect(out.terrain).toBe("forest"); // the map already shows what kind of ground it is
    expect(out.key).toBe("0,0");
    expect(out._id).toBe(rich._id);
  });

  test("a closed cell is not sent to a player at all (D-256's shape: the gate is the document)", () => {
    expect(projectCellForViewer(closed, new Set(["0,0"]))).toBeNull();
    expect(projectCellForViewer(closed, new Set())).toBeNull();
    // …even when it carries a feature whose own flag is already true: the cell is the gate.
    expect(
      projectCellForViewer(
        cell("2,2", {
          description: "GM only",
          features: [feature("f-open", true)],
        }),
        new Set(),
      ),
    ).toBeNull();
  });

  test("a feature that is not revealed is stripped from a cell that *is* open", () => {
    const out = projectCellForViewer(
      cell("3,3", {
        playerText: "peaks",
        features: [feature("f-open", true), feature("f-x", false)],
      }),
      new Set(["3,3"]),
    );
    expect(out?.features?.map((f) => f.id)).toEqual(["f-open"]);
    // A cell with nothing hidden keeps its own array identity (no churn in the replica).
    const plain = cell("4,4", { features: [feature("f-open", true)] });
    expect(projectCellForViewer(plain, new Set(["4,4"]))?.features).toBe(
      plain.features,
    );
  });

  test("the original document is never mutated", () => {
    projectCellForViewer(rich, new Set(["0,0"]));
    expect(rich.description).toBe("A hidden shrine, the idol is cursed");
    expect(rich.playerText).toBe("A mossy stone shrine");
    expect(rich.features).toHaveLength(2);
  });
});

describe("cell visibility changes (the host's boundary rewrite)", () => {
  const cells = [cell("0,0"), cell("1,1"), cell("2,2")];
  const before = scene({
    flags: {
      core: { hexcrawl: profileFlag({ revealed: ["0,0"], mode: "gm" }) },
    },
    cells,
  });
  const openedOne = scene({
    flags: {
      core: { hexcrawl: profileFlag({ revealed: ["0,0", "1,1"], mode: "gm" }) },
    },
    cells,
  });
  const withRing = scene({
    flags: {
      core: {
        hexcrawl: profileFlag({
          revealed: ["0,0", "1,1"],
          mode: "gm+party",
          radiusCells: 1,
          partyTokenId: "party",
        }),
      },
    },
    tokens: [token({ x: 0, y: 0 })],
    cells,
  });
  const ring = ["-1,-1", "-1,0", "0,-1", "0,1", "1,-1", "1,0"]; // the six neighbours of 0,0

  test("a reveal the GM made by hand opens exactly that cell", () => {
    const changed = cellVisibilityChanges(before, openedOne);
    expect(changed.opened).toEqual(["1,1"]);
    expect(changed.closed).toEqual([]);
  });

  test("turning the party's ring on opens the ring, and only the ring", () => {
    const changed = cellVisibilityChanges(openedOne, withRing);
    expect(changed.opened.slice().sort()).toEqual(ring.slice().sort());
    expect(changed.closed).toEqual([]);
    expect(changed.opened).not.toContain("2,2"); // the neighbour of a neighbour is not in sight
  });

  test("closing a hex is the same comparison, read backwards", () => {
    const changed = cellVisibilityChanges(withRing, before);
    expect(changed.closed.slice().sort()).toEqual(["1,1", ...ring].sort());
    expect(changed.opened).toEqual([]);
  });
});
