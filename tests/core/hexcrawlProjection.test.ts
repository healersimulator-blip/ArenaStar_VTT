/**
 * D-271 (plan §3.5/§4) — the security-relevant half of the hexcrawl overlay: what a **player**
 * is sent of a cell, on the snapshot path and on the per-op path.
 *
 * These assertions are deliberately about documents rather than pixels: the asset manifest lists
 * every hash a world holds, so a feature the projection lets through is a feature the player can
 * read whether or not the canvas draws it (D-256's lesson).
 */
import { describe, expect, test } from "vitest";
import {
  projectEnvelope,
  projectWorld,
  type ProjectionResolver,
} from "../../src/core/projection";
import type {
  CellDocument,
  Json,
  SceneDocument,
} from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import type { Op, OpEnvelope } from "../../src/core/ops";
import { emptyWorld } from "../net/fixtures";

const gm: PermissionUser = { id: "gm-key", role: "GM" };
const player: PermissionUser = { id: "pl-key", role: "PLAYER" };

const profileFlag = (revealed: string[]): Json =>
  ({
    version: 1,
    revealed,
    sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
    partyTokenId: null,
    encounterMode: "prompt",
    daylight: { dawnHour: 6, duskHour: 18 },
    terrain: "pf1e-overland",
    travel: null,
  }) as unknown as Json;

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

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "s1",
    type: "scene",
    name: "Overland",
    ownership: { default: 2 },
    flags: { core: { hexcrawl: profileFlag(["0,0"]) } },
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 1000,
    darkness: 0,
    grid: {
      type: "hex",
      size: 100,
      distance: 6,
      units: "mi",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    cells: [
      cell("0,0", {
        description: "The idol is cursed",
        playerText: "A mossy shrine",
        features: [
          {
            id: "f-open",
            name: "Open shrine",
            text: "You may pray here",
            reveal: { kind: "manual" },
            autoReveal: false,
            state: { revealed: true },
          },
          {
            id: "f-secret",
            name: "Hidden cellar",
            text: "Loot under the altar",
            img: "hash-cellar",
            reveal: { kind: "perception", dc: 20 },
            autoReveal: false,
            state: { revealed: false },
          },
        ],
      }),
      cell("1,1", {
        description: "The dragon's lair",
        playerText: "Tall peaks",
      }),
    ],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    ...over,
  };
}

function resolverFor(s: SceneDocument): ProjectionResolver {
  return {
    resolve: (ref) => {
      if (ref.coll === "scenes") return ref.id === s._id ? s : undefined;
      if (
        ref.coll === "cells" &&
        ref.parent?.coll === "scenes" &&
        ref.parent.id === s._id
      ) {
        return s.cells?.find((c) => c._id === ref.id);
      }
      return undefined;
    },
  };
}

const sceneRef = { coll: "scenes" as const, id: "s1" };
const cellRef = (id: string) => ({
  coll: "cells" as const,
  id,
  parent: sceneRef,
});

let tx = 0;
function env(ops: Op[]): OpEnvelope {
  tx += 1;
  return { seq: 1, ts: 0, by: "gm-key", ops, txId: `tx-${tx}` };
}

describe("the snapshot path (projectWorld)", () => {
  test("a player receives the open cell — without the GM's text, without the secret feature", () => {
    const s = scene();
    const world = { ...emptyWorld(), scenes: [s] };
    const projected = projectWorld(world, 1, player).collections.scenes ?? [];
    const sent = projected.find((d) => d._id === "s1") as
      SceneDocument | undefined;
    expect(sent).toBeDefined();
    const open = sent?.cells?.find((c) => c.key === "0,0");
    expect(open?.playerText).toBe("A mossy shrine");
    expect(open?.description).toBeUndefined();
    expect(open?.features?.map((f) => f.id)).toEqual(["f-open"]);
    // The closed cell is not in the player's world at all.
    expect(sent?.cells?.map((c) => c.key)).toEqual(["0,0"]);
  });

  test("the GM receives the scene untouched, cells and secrets included", () => {
    const s = scene();
    const world = { ...emptyWorld(), scenes: [s] };
    const sent = projectWorld(world, 1, gm).collections
      .scenes?.[0] as SceneDocument;
    expect(sent.cells).toHaveLength(2);
    expect(sent.cells?.[0]?.description).toBe("The idol is cursed");
    expect(sent.cells?.[0]?.features).toHaveLength(2);
  });

  test("a scene whose cells are already player-shaped keeps its identity (no churn)", () => {
    const s = scene({
      cells: [
        cell("0,0"), // open: the reveal set names it, and it carries no GM-only fields
        cell("1,1"), // closed: dropped, so this scene *does* change
      ],
    });
    const world = { ...emptyWorld(), scenes: [s] };
    const sent = projectWorld(world, 1, player).collections
      .scenes?.[0] as SceneDocument;
    expect(sent.cells).toHaveLength(1);
    expect(sent.cells?.[0]).toBe(s.cells?.[0]); // the same object, not a copy

    const clean = scene({ cells: [cell("0,0")] });
    expect(
      projectWorld({ ...emptyWorld(), scenes: [clean] }, 1, player).collections
        .scenes?.[0],
    ).toBe(clean);
  });
});

describe("the per-op path (projectEnvelope)", () => {
  test("creating a cell the table has not opened sends nothing to a player", () => {
    const s = scene();
    const resolver = resolverFor(s);
    const e = env([
      {
        kind: "create",
        coll: "cells",
        parent: sceneRef,
        data: cell("9,9", {
          description: "A trap",
          playerText: "Nothing here",
        }),
      },
    ]);
    expect(projectEnvelope(e, player, resolver)).toBeNull();
    expect(projectEnvelope(e, gm, resolver)).not.toBeNull();
  });

  test("creating a cell that *is* open arrives stripped", () => {
    const s = scene();
    const resolver = resolverFor(s);
    const e = env([
      {
        kind: "create",
        coll: "cells",
        parent: sceneRef,
        data: cell("0,0", { description: "GM notes", playerText: "A shrine" }),
      },
    ]);
    const projected = projectEnvelope(e, player, resolver);
    const op = projected?.ops[0];
    expect(op?.kind).toBe("create");
    if (op?.kind !== "create") return;
    const data = op.data as CellDocument;
    expect(data.playerText).toBe("A shrine");
    expect(data.description).toBeUndefined();
  });

  test("an update to a closed cell is a delete for the player (the replica forgets it)", () => {
    const s = scene();
    const resolver = resolverFor(s);
    const e = env([
      {
        kind: "update",
        ref: cellRef("cell-1-1"),
        diff: { playerText: "Peaks" },
      },
    ]);
    const projected = projectEnvelope(e, player, resolver);
    expect(projected?.ops).toEqual([
      { kind: "delete", ref: cellRef("cell-1-1") },
    ]);
  });

  test("an update to an open cell keeps the player text, drops the GM's description", () => {
    const s = scene();
    const resolver = resolverFor(s);
    const e = env([
      {
        kind: "update",
        ref: cellRef("cell-0-0"),
        diff: {
          description: "GM rewrite",
          playerText: "A shrine, restored",
          terrain: "forest",
        },
      },
    ]);
    const op = projectEnvelope(e, player, resolver)?.ops[0];
    expect(op?.kind).toBe("update");
    if (op?.kind !== "update") return;
    expect(Object.keys(op.diff).sort()).toEqual(["playerText", "terrain"]);
    expect(op.diff["playerText"]).toBe("A shrine, restored");
  });

  test("a feature array in a diff travels without the unrevealed rows", () => {
    const s = scene();
    const resolver = resolverFor(s);
    const e = env([
      {
        kind: "update",
        ref: cellRef("cell-0-0"),
        diff: {
          features: [
            {
              id: "f-open",
              name: "Open",
              text: "seen",
              reveal: { kind: "manual" },
              autoReveal: false,
              state: { revealed: true },
            },
            {
              id: "f-secret",
              name: "Hidden",
              text: "loot",
              reveal: { kind: "manual" },
              autoReveal: false,
              state: { revealed: false },
            },
          ] as unknown as Json,
        },
      },
    ]);
    const op = projectEnvelope(e, player, resolver)?.ops[0];
    if (op?.kind !== "update") throw new Error("expected an update");
    const kept = op.diff["features"] as Array<{ id: string }>;
    expect(kept.map((f) => f.id)).toEqual(["f-open"]);
  });

  test("a diff that only touches GM-only keys is dropped entirely", () => {
    const s = scene();
    const resolver = resolverFor(s);
    const e = env([
      {
        kind: "update",
        ref: cellRef("cell-0-0"),
        diff: { description: "GM only" },
      },
    ]);
    expect(projectEnvelope(e, player, resolver)).toBeNull();
  });

  test("the GM's own envelope is never rewritten", () => {
    const s = scene();
    const resolver = resolverFor(s);
    const ops: Op[] = [
      {
        kind: "update",
        ref: cellRef("cell-0-0"),
        diff: { description: "GM only" },
      },
      {
        kind: "update",
        ref: cellRef("cell-1-1"),
        diff: { description: "GM only" },
      },
    ];
    const e = env(ops);
    expect(projectEnvelope(e, gm, resolver)).toBe(e);
  });
});
