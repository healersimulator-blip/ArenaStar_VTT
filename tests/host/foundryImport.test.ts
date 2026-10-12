/** G-30 (D-449): an imported Foundry scene is one valid create — floors, scopes, stairs — and floor play can be turned on. */
import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import tower from "../fixtures/foundry/levels-tower.json";
import cabin from "../fixtures/foundry/core-cabin.json";
import { boot } from "../app/fakes";
import { planFoundryImport } from "../../src/core/foundryImport";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";

test("Levels and V14 scenes import as one undoable create each, and floor play accepts them", async () => {
  const app = await boot();
  try {
    let n = 0;
    for (const [raw, sceneId] of [[tower, "imported-tower"], [cabin, "imported-cabin"]] as const) {
      const result = planFoundryImport(raw, { sceneId, nextId: () => `${sceneId}-${++n}` });
      if (!result.ok) throw new Error(result.error);
      await app.gm.client.submitAndWait([{ kind: "create", coll: "scenes", data: result.scene }]);
      const stored = app.store.get("scenes", sceneId);
      expect(stored?.levels?.length).toBe(result.report.floors.length);
      expect(stored?.regions?.filter((r) => r.stairs).length).toBe(result.report.counts.stairs);
      expect(stored?.walls.length).toBe(result.report.counts.walls);
      expect(stored?.tokens.every((t) => typeof t.levelId === "string")).toBe(true);
      await app.gm.client.submitAndWait([{ kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { levelMode: "isolated" } }]);
      expect(app.store.get("scenes", sceneId)?.levelMode).toBe("isolated");
    }
    // Undo takes back the cabin's floor play, then the cabin itself.
    expect(app.host.undo().ok).toBe(true); expect(app.host.undo().ok).toBe(true);
    expect(app.store.get("scenes", "imported-cabin")).toBeUndefined();
    expect(app.store.get("scenes", "imported-tower")?.levelMode).toBe("isolated");
  } finally { await app.close(); const db = await openVttDb(); await deleteWorldData(db, app.worldId); db.close(); }
});
