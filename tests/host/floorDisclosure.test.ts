/** G-33 (D-451): over the wire, a player's replica follows their floors — and never stalls. */
import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { joinHostPlayer, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel } from "../../src/core/levels";
import type { TokenDocument, WallDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";

const parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
const base = { flags: {}, system: {}, ownership: { default: 0 } } as const;
const wall = (id: string, levelId: string): WallDocument => ({ ...base, _id: id, type: "wall", name: id, c: [0, 0, 100, 0], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0,
  levelScope: { mode: "levels", ids: [levelId] } });

test("a player holds their floor's documents; taking the stairs swaps them; others' moves cross cleanly; ending floor play restores all", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer();
  try {
    const player = playerApp.client; if (!player?.user) throw new Error("join");
    const original = hostApp.store.get("scenes", DEFAULT_SCENE_ID); if (!original) throw new Error("scene");
    const mk = (id: string, levelId: string, elevation: number, owner = false): TokenDocument => ({ ...base, _id: id, type: "token", name: id,
      ownership: owner ? { default: 0, [player.user?.id ?? ""]: 3 } : { default: 0 }, x: 150, y: 150, width: 100, height: 100, rotation: 0, elevation, levelId,
      img: "", vision: true, hidden: false, disposition: "neutral", light: { radius: 0, color: "#fff", alpha: 0 } });
    const configured = { ...original, levelMode: "isolated" as const,
      tokens: [mk("hero", "ground", 0, true), mk("goblin", "upper", 10)],
      walls: [wall("w-ground", "ground"), wall("w-upper", "upper")],
      levels: [draftLevel("ground", "Ground", 0, 10, 0), draftLevel("upper", "Upper", 10, 20, 1)] };
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(configured)) }]);
    await settle(8);
    const held = () => { const s = player.store.get("scenes", DEFAULT_SCENE_ID); return { tokens: s?.tokens.map((t) => t._id).sort(), walls: s?.walls.map((w) => w._id).sort() }; };
    expect(held()).toEqual({ tokens: ["hero"], walls: ["w-ground"] });

    const gm = (ops: Op[]) => hostApp.gm.client.submitAndWait(ops);
    const tok = (id: string, diff: Record<string, unknown>): Op => ({ kind: "update", ref: { coll: "tokens", id, parent }, diff: diff as never });
    // Withheld edits never arrive: a wall upstairs, the goblin pacing upstairs.
    await gm([{ kind: "create", coll: "walls", parent, data: wall("w-upper-2", "upper") }, tok("goblin", { x: 450 })]); await settle(8);
    expect(held()).toEqual({ tokens: ["hero"], walls: ["w-ground"] });

    // The hero goes upstairs (a GM floor move): the replica swaps floors.
    await gm([tok("hero", { levelId: "upper", elevation: 10 })]); await settle(8);
    expect(held()).toEqual({ tokens: ["goblin", "hero"], walls: ["w-upper", "w-upper-2"] });
    expect(player.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.find((t) => t._id === "goblin")?.x).toBe(450); // current state, not stale

    // Another token crossing the boundary arrives and leaves as a whole document.
    await gm([tok("goblin", { levelId: "ground", elevation: 0 })]); await settle(8);
    expect(held().tokens).toEqual(["hero"]);
    await gm([tok("goblin", { levelId: "upper", elevation: 10, name: "Goblin chief" })]); await settle(8);
    expect(player.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.find((t) => t._id === "goblin")?.name).toBe("Goblin chief");

    // Upper now sees Ground below it: Ground's tokens and art come along (walls stay below).
    await gm([{ kind: "update", ref: { coll: "levels", id: "upper", parent }, diff: { visibleLevelIds: ["ground"] } }]); await settle(8);
    expect(held()).toEqual({ tokens: ["goblin", "hero"], walls: ["w-ground", "w-upper", "w-upper-2"] }); // ground walls light the view below

    // Ending floor play restores everything; the replica is still applying envelopes (no stall).
    await gm([{ kind: "update", ref: parent, diff: { "-=levelMode": null } }]); await settle(8);
    await gm([tok("hero", { name: "Hero!" })]); await settle(8);
    const scene = player.store.get("scenes", DEFAULT_SCENE_ID);
    expect(scene?.walls.map((w) => w._id).sort()).toEqual(["w-ground", "w-upper", "w-upper-2"]);
    expect(scene?.tokens.find((t) => t._id === "hero")?.name).toBe("Hero!");
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); await deleteWorldData(db, hostApp.worldId); db.close(); }
});
