import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import { joinHostPlayer } from "./fakes";
import { settle } from "./fakes";

function actor(id: string, name: string): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name,
    ownership: { default: 0, gm: 3 },
    flags: {},
    system: { hp: 10 },
    items: [],
    effects: [],
  };
}

describe("sheets: reactive editing + ownership (§10 M1)", () => {
  test("hidden actor → granted → player edits → revoked (visibility crossings)", async () => {
    const { hostApp, playerApp, pump } = await joinHostPlayer("sheets-secret");
    try {
      const gm = hostApp.gm.client;
      const player = playerApp.client;
      const playerId = playerApp.identity.publicKeyHex;

      // 1) GM creates a PRIVATE actor — the player's projection omits it
      gm.submit([{ kind: "create", coll: "actors", data: actor("a-1", "Hero") }]);
      await settle(4);
      expect(gm.store.get("actors", "a-1")?.name).toBe("Hero");
      expect(player?.store.get("actors", "a-1")).toBeUndefined();

      // 2) GM assigns ownership to the player → crossing: create-rewrite
      gm.submit([
        {
          kind: "update",
          ref: { coll: "actors", id: "a-1" },
          diff: { ownership: { default: 0, gm: 3, [playerId]: 3 } as never },
        },
      ]);
      await settle(4);
      const granted = player?.store.get("actors", "a-1");
      expect(granted?.name).toBe("Hero"); // materialized from the crossing create
      expect(granted?.system.hp).toBe(10);

      // 3) the player edits a system field — host accepts (owner), GM sees it
      player?.submit([
        { kind: "update", ref: { coll: "actors", id: "a-1" }, diff: { "system.hp": 7 } },
      ]);
      await settle(6);
      expect(hostApp.store.get("actors", "a-1")?.system.hp).toBe(7);
      expect(player?.store.get("actors", "a-1")?.system.hp).toBe(7); // reconciled

      // 4) revoke → crossing: delete-rewrite — the doc leaves the replica
      gm.submit([
        {
          kind: "update",
          ref: { coll: "actors", id: "a-1" },
          diff: { ownership: { default: 0, gm: 3 } as never },
        },
      ]);
      await settle(4);
      expect(player?.store.get("actors", "a-1")).toBeUndefined();

      // 5) a post-revoke edit is rejected host-side (§5 enforcement)
      const rejections: string[] = [];
      playerApp.bus.on("rejected", (r) => rejections.push(r.reason));
      player?.submit([
        { kind: "update", ref: { coll: "actors", id: "a-1" }, diff: { "system.hp": 99 } },
      ]);
      await settle(6);
      expect(rejections).toContain("forbidden");
      expect(hostApp.store.get("actors", "a-1")?.system.hp).toBe(7);
    } finally {
      pump.stop();
      playerApp.close();
      await hostApp.persister.flush();
      await hostApp.close();
    }
  });
});
