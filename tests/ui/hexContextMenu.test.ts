/**
 * D-271 (plan §5.2) — the empty-ground context menu, as a pure model.
 *
 * The interesting assertions here are the *permission* ones and the "a gridless cell needs a
 * shape" rule: the browser spec can only prove the menu opens and one entry works, while this
 * file can prove which entries exist for whom and what each one writes.
 */
import { describe, expect, test } from "vitest";
import type {
  CellDocument,
  Json,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import { PF1E_TERRAIN_CATALOG } from "../../src/core/hexcrawl/terrain";
import {
  applyHexMenuEntry,
  hexContextMenuModel,
  terrainEntryId,
  terrainIdOfEntry,
} from "../../src/ui/hexcrawl/hexContextMenu";

const gm = { id: "gm", role: "GM" as const };
const player = { id: "p1", role: "PLAYER" as const };

function profileFlag(
  over: Partial<{ revealed: string[]; partyTokenId: string | null }> = {},
): Json {
  return {
    version: 1,
    revealed: over.revealed ?? [],
    sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
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
  ownership: { default: 0 },
  flags: { core: { party: true } },
  system: {},
  // `x/y` is the token's centre (and width/height are pixels), so a token at (0,0) stands in the
  // middle of hex `0,0` on this 50 px grid.
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
    flags: { core: { hexcrawl: profileFlag({ partyTokenId: "party" }) } },
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

const labels = (model: { entries: { label: string }[] }) =>
  model.entries.map((e) => e.label);

/** An entry the test already knows is there — the lint forbids `!`, and a plain index is not
 *  narrowed by being written inside an `expect`. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`no element ${index} (length ${items.length})`);
  }
  return value;
}

describe("hexContextMenuModel (§5.2)", () => {
  test("a GM sees the landed entries plus the waiting ones, each with a reason", () => {
    const s = scene({ cells: [cell("0,0")] });
    const model = hexContextMenuModel({
      scene: s,
      key: "0,0",
      user: gm,
      catalog: PF1E_TERRAIN_CATALOG,
    });
    expect(model.title).toBe("0,0");
    expect(model.subtitle).toBe("closed");
    expect(labels(model)).toEqual([
      "Open hex description",
      "Open hex (reveal to players)",
      ...PF1E_TERRAIN_CATALOG.terrains.map((t) => t.name),
      "Attach encounter table…",
      "Roll from a table…",
      "Explore this hex",
      "Reveal feature…",
      "Move party here",
      "Add to path",
    ]);
    // D-272 moved *Attach encounter table…* out of the waiting set (it opens the tables window
    // for this hex); D-273 moved *Roll from a table…* (it opens the hex window, whose rows are
    // the trigger — plan §6 rule 6) and *Explore this hex* (the shell spends the time and asks
    // the `exploring` trigger); D-275 landed the last three — *Reveal feature…* (it opens the
    // same window, whose feature block is the editor), *Add to path* (the shell's draft route) and
    // *Move party here* (one position op, and it is live in this fixture because the profile names
    // a party token — this fixture has none, so *Move party here* stays in the waiting set with its
    // reason, and the dedicated test below covers the live case). Every remaining waiting entry says
    // why it is waiting — never a silent dead row (the token menu's own honesty rule).
    const live = new Set(["open", "reveal", "attach", "roll", "explore", "feature", "add-path"]);
    for (const id of live) expect(model.entries.find((e) => e.id === id)?.disabled).toBe(false);
    for (const entry of model.entries) {
      if (live.has(entry.id) || entry.id.startsWith("terrain:")) continue;
      expect(entry.disabled).toBe(true);
      expect(entry.reason).toBeTruthy();
    }
  });

  test("D-275: the feature row opens the editor, the path row is the shell's, the move writes one op", () => {
    // The party token has to *exist* for the move to be possible (`partyTokenIdOf` checks the
    // scene, not just the flag) — a stale id in the profile is a scene nobody can march.
    const s = scene({ cells: [cell("0,0")], tokens: [token()] });
    const input = {
      scene: s,
      key: "0,0",
      user: gm,
      catalog: PF1E_TERRAIN_CATALOG,
      partyTokenId: "party",
      nextId: () => "cell-x",
    };
    // *Reveal feature…* is the hex window: the feature block there is the editor (art, rule, the
    // automatic switch), so the entry itself must write nothing.
    const featureEntry = applyHexMenuEntry({ ...input, entryId: "feature" });
    expect(featureEntry).toMatchObject({ ops: [], openWindow: true, addPath: false, error: null });
    // *Add to path* is the shell's own draft route — no ops, just the flag.
    const addPath = applyHexMenuEntry({ ...input, entryId: "add-path" });
    expect(addPath).toMatchObject({ ops: [], openWindow: false, addPath: true, error: null });
    // …and *Move party here* is one position op, aimed at the hex's centre (the party token sits
    // at 0,0 on a 50 px grid, so the centre of `0,0` is the corner itself).
    const move = applyHexMenuEntry({ ...input, entryId: "move-party" });
    expect(move.error).toBeNull();
    expect(move.addPath).toBe(false);
    expect(move.ops).toHaveLength(1);
    expect(move.ops[0]).toMatchObject({
      kind: "update",
      ref: { coll: "tokens", id: "party", parent: { coll: "scenes", id: "scene-1" } },
      diff: { x: 0, y: 0 },
    });
    // A player gets none of the three.
    for (const id of ["feature", "add-path", "move-party"]) {
      const denied = applyHexMenuEntry({ ...input, entryId: id, user: player });
      expect(denied).toMatchObject({ ops: [], addPath: false, error: "not your hex to change" });
    }
  });

  test("move party here waits for a party token, and says so (it is not a dead row)", () => {
    // No `partyTokenId` in the profile and no token flagged as the party: the row is disabled with
    // the reason the GM needs, while *Add to path* (which needs nothing but the scene) stays live.
    const s = scene({
      cells: [cell("0,0")],
      tokens: [],
      flags: { core: { hexcrawl: profileFlag({ partyTokenId: null }) } },
    });
    const model = hexContextMenuModel({
      scene: s,
      key: "0,0",
      user: gm,
      catalog: PF1E_TERRAIN_CATALOG,
    });
    const moveEntry = model.entries.find((e) => e.id === "move-party");
    expect(moveEntry?.disabled).toBe(true);
    expect(moveEntry?.reason).toBeTruthy();
    expect(model.entries.find((e) => e.id === "add-path")?.disabled).toBe(false);
    // …and applying it anyway is refused, not silently a no-op.
    expect(
      applyHexMenuEntry({
        scene: s,
        key: "0,0",
        user: gm,
        entryId: "move-party",
        nextId: () => "cell-x",
      }),
    ).toMatchObject({ ops: [], error: "this scene has no party token yet" });
  });

  test("the roll entry opens the hex window; explore asks the shell for the clock envelope", () => {
    const input = {
      scene: scene({ cells: [cell("0,0")] }),
      key: "0,0",
      user: gm,
      nextId: () => "cell-x",
    };
    const roll = applyHexMenuEntry({ ...input, entryId: "roll" });
    expect(roll).toMatchObject({ ops: [], openWindow: true, explore: false, error: null });
    const explore = applyHexMenuEntry({ ...input, entryId: "explore" });
    expect(explore).toMatchObject({ ops: [], openWindow: false, explore: true, error: null });
    // The time is real, so the shell owns it: the entry itself writes nothing.
    expect(explore.ops).toHaveLength(0);
    // …and a player never gets either entry to press.
    const asPlayer = applyHexMenuEntry({ ...input, entryId: "explore", user: player });
    expect(asPlayer).toMatchObject({ explore: false, error: "not your hex to change" });
  });

  test("the attach entry asks the shell for the tables window and writes nothing itself", () => {
    const result = applyHexMenuEntry({
      scene: scene({ cells: [cell("0,0")] }),
      key: "0,0",
      entryId: "attach",
      user: gm,
      nextId: () => "cell-x",
    });
    expect(result).toMatchObject({ ops: [], openTables: true, error: null });
  });

  test("an open cell offers Close, and the current terrain is checked", () => {
    const s = scene({
      cells: [cell("0,0", { terrain: "forest" })],
      flags: { core: { hexcrawl: profileFlag({ revealed: ["0,0"] }) } },
    });
    const model = hexContextMenuModel({
      scene: s,
      key: "0,0",
      user: gm,
      catalog: PF1E_TERRAIN_CATALOG,
    });
    expect(model.subtitle).toBe("open · Forest / woods");
    expect(model.entries.map((e) => e.id)).toContain("hide");
    expect(model.entries.map((e) => e.id)).not.toContain("reveal");
  });

  test("a player gets the description entry on open ground and nothing on closed ground", () => {
    const closed = hexContextMenuModel({
      scene: scene({ cells: [cell("0,0")] }),
      key: "0,0",
      user: player,
      catalog: PF1E_TERRAIN_CATALOG,
    });
    expect(closed.entries).toEqual([]);
    expect(closed.title).toBe("Unexplored");

    const open = hexContextMenuModel({
      scene: scene({
        cells: [cell("0,0")],
        tokens: [token()],
        flags: {
          core: {
            hexcrawl: profileFlag({ revealed: ["0,0"], partyTokenId: "party" }),
          },
        },
      }),
      key: "0,0",
      user: player,
      catalog: PF1E_TERRAIN_CATALOG,
    });
    expect(labels(open)).toEqual(["Open hex description", "the party is here"]);
    expect(at(open.entries, 1).statik).toBe(true);
    expect(open.entries.some((e) => e.terrainId)).toBe(false);
  });

  test("a gridless cell with no authored zone cannot take terrain", () => {
    const s = scene({
      grid: {
        type: "gridless",
        size: 100,
        distance: 1,
        units: "mi",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      cells: [cell("zone-a", { poly: [0, 0, 100, 0, 100, 100, 0, 100] })],
    });
    const outside = hexContextMenuModel({
      scene: s,
      key: "zone-b",
      user: gm,
      catalog: PF1E_TERRAIN_CATALOG,
    });
    const rows = outside.entries.filter((e) => e.terrainId);
    expect(rows.length).toBe(PF1E_TERRAIN_CATALOG.terrains.length);
    expect(rows.every((r) => r.disabled)).toBe(true);
    expect(at(rows, 0).reason).toContain("zone");

    const inside = hexContextMenuModel({
      scene: s,
      key: "zone-a",
      user: gm,
      catalog: PF1E_TERRAIN_CATALOG,
    });
    expect(
      inside.entries.filter((e) => e.terrainId).every((r) => !r.disabled),
    ).toBe(true);
  });
});

describe("applyHexMenuEntry (§5.2)", () => {
  const nextId = () => "cell-new";

  test("reveal and hide write the profile's reveal set", () => {
    const s = scene({ cells: [cell("0,0")] });
    const reveal = applyHexMenuEntry({
      scene: s,
      key: "0,0",
      entryId: "reveal",
      user: gm,
      nextId,
    });
    expect(reveal.note).toContain("open to the table");
    expect(reveal.ops).toHaveLength(1);
    expect(at(reveal.ops, 0).kind).toBe("update");
    const revealed = (
      at(reveal.ops, 0) as unknown as { diff: Record<string, Json> }
    ).diff["flags"] as {
      core: { hexcrawl: { revealed: string[] } };
    };
    expect(revealed.core.hexcrawl.revealed).toEqual(["0,0"]);

    const opened = scene({
      flags: { core: { hexcrawl: profileFlag({ revealed: ["0,0"] }) } },
    });
    const hide = applyHexMenuEntry({
      scene: opened,
      key: "0,0",
      entryId: "hide",
      user: gm,
      nextId,
    });
    expect(hide.note).toContain("closed");
    expect(hide.ops).toHaveLength(1);
  });

  test("terrain creates a cell when none is authored and updates it when one is", () => {
    const bare = scene();
    const created = applyHexMenuEntry({
      scene: bare,
      key: "3,-2",
      entryId: terrainEntryId("mountains"),
      user: gm,
      nextId,
    });
    expect(created.terrainId).toBe("mountains");
    expect(terrainIdOfEntry(terrainEntryId("mountains"))).toBe("mountains");
    expect(at(created.ops, 0).kind).toBe("create");
    const data = (at(created.ops, 0) as unknown as { data: CellDocument }).data;
    expect(data.key).toBe("3,-2");
    expect(data.terrain).toBe("mountains");
    // The store refuses a create without a name (D-271's `createCellOps` bug): the key is it.
    expect(data.name).toBe("3,-2");

    const authored = scene({ cells: [cell("3,-2", { terrain: "plains" })] });
    const updated = applyHexMenuEntry({
      scene: authored,
      key: "3,-2",
      entryId: terrainEntryId("mountains"),
      user: gm,
      nextId,
    });
    expect(at(updated.ops, 0).kind).toBe("update");
    expect(
      (at(updated.ops, 0) as unknown as { diff: Record<string, Json> }).diff[
        "terrain"
      ],
    ).toBe("mountains");
    // Re-picking what is already there spends nothing.
    const same = applyHexMenuEntry({
      scene: authored,
      key: "3,-2",
      entryId: terrainEntryId("plains"),
      user: gm,
      nextId,
    });
    expect(same.ops).toEqual([]);
  });

  test("a player cannot reveal or re-terrain, and `open` only asks for the window", () => {
    const s = scene({ cells: [cell("0,0")] });
    const reveal = applyHexMenuEntry({
      scene: s,
      key: "0,0",
      entryId: "reveal",
      user: player,
      nextId,
    });
    expect(reveal.ops).toEqual([]);
    expect(reveal.error).toBe("not your hex to change");

    const open = applyHexMenuEntry({
      scene: s,
      key: "0,0",
      entryId: "open",
      user: player,
      nextId,
    });
    expect(open.openWindow).toBe(true);
    expect(open.ops).toEqual([]);
    expect(open.error).toBeNull();
  });

  test("an unknown entry is an error, not a silent no-op", () => {
    const result = applyHexMenuEntry({
      scene: scene(),
      key: "0,0",
      entryId: "summon-dragon",
      user: gm,
      nextId,
    });
    expect(result.error).toContain("unknown hex menu entry");
  });
});
