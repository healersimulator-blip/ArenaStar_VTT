import { describe, expect, test } from "vitest";
import {
  assignCharacterOps,
  controlsToken,
  playerRows,
  removeUserOps,
  setPlayerColorOps,
  setTokenControlOps,
} from "../../src/core/players";
import type { ActorDocument, SceneDocument, TokenDocument, UserDocument } from "../../src/core/documents";

const user = (id: string, role: UserDocument["role"], extra: Partial<UserDocument> = {}): UserDocument => ({
  _id: id, type: "user", name: id, ownership: { default: 0 }, flags: {}, system: {}, role, character: null, color: "#336699", ...extra,
});
const actor = (id: string, ownership: Record<string, number> = { default: 0 }): ActorDocument =>
  ({ _id: id, type: "actor", name: `Actor ${id}`, ownership, flags: {}, system: {}, img: "", items: [] }) as unknown as ActorDocument;
const token = (id: string, extra: Partial<TokenDocument> = {}): TokenDocument =>
  ({ _id: id, type: "token", name: `Token ${id}`, ownership: { default: 0 }, flags: {}, system: {}, x: 0, y: 0, rotation: 0, width: 1, height: 1, img: "", hidden: false, disposition: "neutral", vision: false, light: { dim: 0, bright: 0, color: "#fff", alpha: 0 }, ...extra }) as unknown as TokenDocument;
const scene = (tokens: TokenDocument[]): SceneDocument =>
  ({ _id: "s1", type: "scene", name: "Cove", ownership: { default: 0 }, flags: {}, system: {}, active: true, img: null, width: 1000, height: 1000,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddR" }, darkness: 0,
    tokens, walls: [], lights: [], notes: [], drawings: [], templates: [], tiles: [], regions: [] }) as unknown as SceneDocument;

describe("player roster (D-465)", () => {
  test("rows: GM first, presence folded in, character and token control resolved", () => {
    const hero = actor("hero", { default: 0, p1: 3 });
    const users = [user("p2", "PLAYER"), user("gm", "GM"), user("p1", "TRUSTED", { character: "hero" })];
    const sc = scene([token("t1", { actorId: "hero" }), token("t2", { ownership: { default: 0, p2: 3 } }), token("t3")]);
    const rows = playerRows(users, [hero], sc, { online: new Set(["p1"]), banned: new Set(["p2"]) });
    expect(rows.map((row) => row.id)).toEqual(["gm", "p1", "p2"]);
    const [gm, p1, p2] = rows;
    expect(p1).toMatchObject({ online: true, banned: false, characterId: "hero", characterName: "Actor hero", canSaveMacros: false });
    expect(p1?.tokens.map((entry) => [entry.tokenId, entry.via])).toEqual([["t1", "actor"], ["t2", null], ["t3", null]]);
    expect(p2).toMatchObject({ online: false, banned: true, characterId: null });
    expect(p2?.tokens.map((entry) => entry.via)).toEqual([null, "token", null]);
    expect(gm?.tokens.every((entry) => entry.via === "token")).toBe(true); // the GM controls everything
    expect(gm?.canSaveMacros).toBe(true);
  });

  test("controlsToken: direct token ownership or the actor's; players own nothing by default", () => {
    const sc = scene([]);
    const t = token("t", { actorId: "a" });
    const actorOf = (id: string) => (id === "a" ? actor("a", { default: 0, p1: 3 }) : undefined);
    expect(controlsToken({ id: "p1", role: "PLAYER" }, t, sc, actorOf)).toBe("actor");
    expect(controlsToken({ id: "p2", role: "PLAYER" }, t, sc, actorOf)).toBeNull();
    expect(controlsToken({ id: "p2", role: "PLAYER" }, token("u", { ownership: { default: 0, p2: 3 } }), sc, actorOf)).toBe("token");
    expect(controlsToken({ id: "p2", role: "PLAYER" }, token("v", { ownership: { default: 0, p2: 2 } }), sc, actorOf)).toBeNull();
    // A token whose default level is OWNER is everyone's: no per-player grant to make or revoke.
    expect(controlsToken({ id: "p2", role: "PLAYER" }, token("w", { ownership: { default: 3 } }), sc, actorOf)).toBe("everyone");
    expect(controlsToken({ id: "p2", role: "PLAYER" }, token("x", { ownership: { default: 3, p2: 3 } }), sc, actorOf)).toBe("token");
  });

  test("assigning a character sets the user's character and makes them its owner", () => {
    const p1 = user("p1", "PLAYER");
    const hero = actor("hero", { default: 0, other: 1 });
    const ops = assignCharacterOps(p1, hero);
    expect(ops).toEqual([
      { kind: "update", ref: { coll: "users", id: "p1" }, diff: { character: "hero" } },
      { kind: "update", ref: { coll: "actors", id: "hero" }, diff: { ownership: { default: 0, other: 1, p1: 3 } } },
    ]);
    // Already the owner: only the user changes. Clearing: character null, nothing revoked by default.
    expect(assignCharacterOps(p1, actor("hero", { default: 0, p1: 3 }))).toHaveLength(1);
    expect(assignCharacterOps(p1, null)).toEqual([{ kind: "update", ref: { coll: "users", id: "p1" }, diff: { character: null } }]);
    // Opt-in revoke of the previous character's grant.
    const previous = actor("old", { default: 0, p1: 3, gm: 3 });
    const swap = assignCharacterOps(p1, hero, { previous, revokePrevious: true });
    expect(swap.at(-1)).toEqual({ kind: "update", ref: { coll: "actors", id: "old" }, diff: { ownership: { default: 0, gm: 3 } } });
  });

  test("token control toggles one token's ownership entry and is idempotent", () => {
    const sc = scene([]);
    const t = token("t1", { ownership: { default: 0, p9: 3 } });
    expect(setTokenControlOps(sc, t, "p1", true)).toEqual([
      { kind: "update", ref: { coll: "tokens", id: "t1", parent: { coll: "scenes", id: "s1" } }, diff: { ownership: { default: 0, p9: 3, p1: 3 } } },
    ]);
    expect(setTokenControlOps(sc, t, "p1", false)).toEqual([]);
    expect(setTokenControlOps(sc, t, "p9", false)).toEqual([
      { kind: "update", ref: { coll: "tokens", id: "t1", parent: { coll: "scenes", id: "s1" } }, diff: { ownership: { default: 0 } } },
    ]);
    expect(setTokenControlOps(sc, t, "p9", true)).toEqual([]);
  });

  test("colour and removal guard themselves", () => {
    const p1 = user("p1", "PLAYER");
    expect(setPlayerColorOps(p1, "#FFAA00")).toEqual([{ kind: "update", ref: { coll: "users", id: "p1" }, diff: { color: "#ffaa00" } }]);
    expect(setPlayerColorOps(p1, "#336699")).toEqual([]); // unchanged
    expect(setPlayerColorOps(p1, "red")).toEqual([]); // not a hex colour
    expect(removeUserOps(p1, false)).toEqual([{ kind: "delete", ref: { coll: "users", id: "p1" } }]);
    expect(removeUserOps(p1, true)).toEqual([]); // connected players are kicked first
    expect(removeUserOps(user("gm", "GM"), false)).toEqual([]);
  });
});
