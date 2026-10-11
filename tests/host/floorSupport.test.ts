/** G-23 (D-448): the host keeps players from walking on air; the GM may, and the check offers the fall. */
import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { joinHostPlayer, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel } from "../../src/core/levels";
import { traceSurface } from "../../src/core/floorSurface";
import { levelAuditFixOps, levelPlayAudit } from "../../src/core/levelAudit";
import type { LevelSurface, RegionDocument, TokenDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";

const parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
/** Upper floor: solid over 1000 px except a stairwell at 400–600; the stairs fill its west half. */
const stairwell = traceSurface((x, y) => x < 1000 && y < 1000 && !(x >= 400 && x < 600 && y >= 400 && y < 600), { x: 0, y: 0, width: 1000, height: 1000 }, { cell: 50 }).surface as LevelSurface;
const stairs: RegionDocument = { _id: "stairs", type: "region", name: "Stairs", ownership: { default: 0 }, flags: {}, system: {}, hidden: true, x: 400, y: 400, width: 100, height: 200,
  shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, stairs: { version: 2, levels: ["ground", "upper"], mode: "prompt" } };
const move = (x: number, y = 500): Op => ({ kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { x, y } });

test("players cannot walk out over an opening; the stairs and solid floor are fine; the GM can, and the check drops the token", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer();
  try {
    const player = playerApp.client; if (!player?.user) throw new Error("join");
    const original = hostApp.store.get("scenes", DEFAULT_SCENE_ID); if (!original) throw new Error("scene");
    const hero: TokenDocument = { _id: "hero", type: "token", name: "Hero", flags: {}, system: {}, ownership: { default: 0, [player.user.id]: 3 }, x: 250, y: 500, width: 100, height: 100,
      rotation: 0, elevation: 10, levelId: "upper", img: "", vision: true, hidden: false, disposition: "friendly", light: { radius: 0, color: "#fff", alpha: 0 } };
    const configured = { ...original, levelMode: "isolated" as const, regions: [stairs], tokens: [hero],
      levels: [draftLevel("ground", "Ground", 0, 10, 0), { ...draftLevel("upper", "Upper", 10, 20, 1), visibleLevelIds: ["ground"], surface: stairwell }] };
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(configured)) }]);
    player.requestLevelFocus(DEFAULT_SCENE_ID, null); await settle(6);
    const at = () => hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.find((t) => t._id === "hero");

    await player.submitAndWait([move(250, 250)]);
    expect(at()).toMatchObject({ x: 250, y: 250, levelId: "upper" });
    await expect(player.submitAndWait([move(550)])).rejects.toThrow("No floor there: Hero would step into an opening on Upper.");
    expect(at()).toMatchObject({ x: 250, y: 250 });
    await player.submitAndWait([move(450)]); // onto the stairs: they carry the hero (and ask where to)
    expect(at()).toMatchObject({ x: 450, y: 500, levelId: "upper" });

    // The GM may put a token there; the floor-play check then offers the fall.
    await hostApp.gm.client.submitAndWait([move(550)]);
    const scene = hostApp.store.get("scenes", DEFAULT_SCENE_ID); if (!scene) throw new Error("scene");
    expect(levelPlayAudit(scene).find((f) => f.code === "token-over-opening")).toMatchObject({ severity: "warning", fix: "drop-tokens", ids: ["hero"] });
    const drop = levelAuditFixOps(scene, "drop-tokens");
    expect(drop).toEqual([{ kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { levelId: "ground", elevation: 0 } }]);
    await hostApp.gm.client.submitAndWait(drop);
    expect(at()).toMatchObject({ x: 550, y: 500, levelId: "ground", elevation: 0 });
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); await deleteWorldData(db, hostApp.worldId); db.close(); }
});
