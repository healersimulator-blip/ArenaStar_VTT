/**
 * D-271 (plan §3.5/§4) — the reveal set crosses the host/player boundary as documents.
 *
 * This is the test the browser spec cannot replace: it drives the **real** host, over the real
 * manual-signalling join, and then reads the *player's own replica*. A closed hex must not be
 * there at all; opening it must materialize exactly the cell the GM opened, stripped of the GM's
 * text; closing it again must take it away.
 */
import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import type { CellDocument, SceneDocument } from "../../src/core/documents";
import {
  createCellOps,
  newHexcrawlPartyOps,
  newHexcrawlSceneOps,
  revealCellsOps,
} from "../../src/core/hexcrawl";
import { joinHostPlayer, settle } from "./fakes";

// One shared fake-IDB world per file: each test owns its own scene id so the first test's
// cells cannot leak into the second one's expectations.
const SCENE = "scene-hx";
const SCENE_EDIT = "scene-hx-edit";

function cellsOn(scene: SceneDocument | undefined): CellDocument[] {
  return scene?.cells ?? [];
}

describe("hexcrawl reveals over a real join", () => {
  test("a closed cell is absent from the player's replica; opening it sends the cell, closing it takes it back", async () => {
    const { hostApp, playerApp, pump } =
      await joinHostPlayer("hexcrawl-reveal");
    try {
      const gm = hostApp.gm.client;
      const player = playerApp.client;
      if (!player) throw new Error("the joined player has no client");

      // ── the wizard's two envelopes: the scene first, its party second ──
      gm.submit(
        newHexcrawlSceneOps({
          id: SCENE,
          name: "Overland",
          width: 1000,
          height: 800,
          grid: {
            type: "hex",
            size: 100,
            distance: 6,
            units: "mi",
            diagonals: "555",
            hexLayout: "oddQ",
          },
          settingsDocs: gm.store.getAll("settings"),
          scenes: gm.store.getAll("scenes") as readonly SceneDocument[],
          activate: true,
        }),
      );
      await settle(6);
      const created = gm.store.get("scenes", SCENE) as
        SceneDocument | undefined;
      expect(created).toBeDefined();
      if (!created) return;
      gm.submit(
        newHexcrawlPartyOps(created, {
          party: { name: "The Party" },
          profile: { encounterMode: "prompt" },
        }),
      );
      await settle(6);

      // ── the GM authors one open and one closed cell, with secrets in both ──
      const withParty = gm.store.get("scenes", SCENE) as SceneDocument;
      gm.submit(
        createCellOps(withParty, "cell-open", {
          key: "0,0",
          terrain: "forest",
          description: "The idol is cursed",
          playerText: "A mossy shrine",
        }),
      );
      await settle(6);
      const afterFirst = gm.store.get("scenes", SCENE) as SceneDocument;
      gm.submit(
        createCellOps(afterFirst, "cell-closed", {
          key: "1,1",
          terrain: "mountains",
          description: "The dragon's lair",
          playerText: "Tall peaks",
        }),
      );
      await settle(6);
      const both = gm.store.get("scenes", SCENE) as SceneDocument;

      // Neither cell is open yet: the player holds the scene but no cells.
      expect(
        cellsOn(player.store.get("scenes", SCENE) as SceneDocument).map(
          (c) => c.key,
        ),
      ).toEqual([]);

      // ── the GM opens 0,0: a create crossing ──
      gm.submit(revealCellsOps(both, ["0,0"]));
      await settle(8);
      const playerScene = player.store.get("scenes", SCENE) as SceneDocument;
      const opened = cellsOn(playerScene);
      expect(opened.map((c) => c.key)).toEqual(["0,0"]);
      expect(opened[0]?.playerText).toBe("A mossy shrine");
      expect(opened[0]?.description).toBeUndefined(); // the GM's text never travels
      expect(opened[0]?.terrain).toBe("forest");
      // The GM keeps both cells, secrets intact.
      expect(
        cellsOn(gm.store.get("scenes", SCENE) as SceneDocument),
      ).toHaveLength(2);
      expect(
        cellsOn(gm.store.get("scenes", SCENE) as SceneDocument).find(
          (c) => c.key === "0,0",
        )?.description,
      ).toBe("The idol is cursed");

      // ── opening the second one adds it without disturbing the first ──
      gm.submit(
        revealCellsOps(gm.store.get("scenes", SCENE) as SceneDocument, ["1,1"]),
      );
      await settle(8);
      expect(
        cellsOn(player.store.get("scenes", SCENE) as SceneDocument)
          .map((c) => c.key)
          .sort(),
      ).toEqual(["0,0", "1,1"]);

      // ── closing a hex is a delete on the player's replica ──
      gm.submit(
        revealCellsOps(
          gm.store.get("scenes", SCENE) as SceneDocument,
          [],
          ["0,0"],
        ),
      );
      await settle(8);
      expect(
        cellsOn(player.store.get("scenes", SCENE) as SceneDocument).map(
          (c) => c.key,
        ),
      ).toEqual(["1,1"]);

      // ── and a ring that opens two cells sends the one of them that was authored ──
      // ("2,2" is a bare ring cell nobody wrote: the overlay paints it from the grid, so there
      // is no document to cross the boundary.)
      const before = cellsOn(
        player.store.get("scenes", SCENE) as SceneDocument,
      ).length;
      gm.submit(
        revealCellsOps(gm.store.get("scenes", SCENE) as SceneDocument, [
          "0,0",
          "2,2",
        ]),
      );
      await settle(8);
      expect(
        cellsOn(player.store.get("scenes", SCENE) as SceneDocument).length,
      ).toBe(before + 1);
      pump.stop();
    } finally {
      pump.stop();
    }
  });

  test("editing an open cell's text reaches the player; editing a closed one does not create it", async () => {
    const { hostApp, playerApp, pump } = await joinHostPlayer(
      "hexcrawl-reveal-edit",
    );
    try {
      const gm = hostApp.gm.client;
      const player = playerApp.client;
      if (!player) throw new Error("the joined player has no client");
      gm.submit(
        newHexcrawlSceneOps({
          id: SCENE_EDIT,
          name: "Overland II",
          width: 800,
          height: 800,
          grid: {
            type: "hex",
            size: 100,
            distance: 6,
            units: "mi",
            diagonals: "555",
            hexLayout: "oddQ",
          },
          settingsDocs: gm.store.getAll("settings"),
          scenes: gm.store.getAll("scenes") as readonly SceneDocument[],
          activate: true,
        }),
      );
      await settle(6);
      const scene = gm.store.get("scenes", SCENE_EDIT) as SceneDocument;
      gm.submit(
        createCellOps(scene, "cell-a", {
          key: "0,0",
          description: "GM",
          playerText: "v1",
        }),
      );
      await settle(6);

      // A closed cell's text edit is not a way to leak it into the replica.
      gm.submit([
        {
          kind: "update",
          ref: {
            coll: "cells",
            id: "cell-a",
            parent: { coll: "scenes", id: SCENE_EDIT },
          },
          diff: { playerText: "v2" },
        },
      ]);
      await settle(6);
      expect(
        cellsOn(player.store.get("scenes", SCENE_EDIT) as SceneDocument),
      ).toHaveLength(0);

      gm.submit(
        revealCellsOps(gm.store.get("scenes", SCENE_EDIT) as SceneDocument, [
          "0,0",
        ]),
      );
      await settle(8);
      expect(
        cellsOn(player.store.get("scenes", SCENE_EDIT) as SceneDocument)[0]
          ?.playerText,
      ).toBe("v2");
      pump.stop();
    } finally {
      pump.stop();
    }
  });
});
