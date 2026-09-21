/**
 * §2.3 (G-25 remainder, D-262) — the GM's "view as player X", the parts that are rules rather
 * than wiring: who can be previewed, which identity the preview runs as, and the one thing a
 * client-side preview has to add to the player gate (§5's withheld documents).
 */
import { describe, expect, test } from "vitest";
import type { SceneDocument, TokenDocument, UserDocument } from "../../src/core/documents";
import { viewAsOptions, viewAsUser, viewAsVisibleTokenIds, withoutHiddenTokens } from "../../src/core/viewAs";
import { fogVisibleTokenIds } from "../../src/core/fogExploration";

const user = (id: string, role: UserDocument["role"], name = id): UserDocument => ({
  _id: id,
  type: "user",
  name,
  ownership: { default: 0 },
  flags: {},
  system: {},
  role,
  character: null,
  color: "#fff",
});

const token = (id: string, over: Partial<TokenDocument> = {}): TokenDocument => ({
  _id: id,
  type: "token",
  name: id,
  // default 0 = nobody; a test grants ownership where it needs it (the §2.1 fixture's rule — a
  // default of 3 would make every token a player's own, and the gate would show everything)
  ownership: { default: 0 },
  flags: {},
  system: {},
  x: 100,
  y: 100,
  rotation: 0,
  width: 100,
  height: 100,
  img: "",
  hidden: false,
  disposition: "neutral",
  vision: true,
  light: { radius: 0, color: "#fff", alpha: 0.5 },
  ...over,
});

const scene = (over: Partial<SceneDocument> = {}): SceneDocument => ({
  _id: "scene-1",
  type: "scene",
  name: "S",
  ownership: { default: 2 },
  flags: {},
  system: {},
  active: true,
  img: null,
  width: 1000,
  height: 800,
  darkness: 0,
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  tokens: [],
  walls: [],
  lights: [],
  sounds: [],
  tiles: [],
  drawings: [],
  templates: [],
  notes: [],
  ...over,
});

/** A square polygon around a token, the shape `tokenInSight` probes. */
const squareAround = (x: number, y: number): Float32Array =>
  new Float32Array([x - 200, y - 200, x + 200, y - 200, x + 200, y + 200, x - 200, y + 200]);

const GM = { id: "gm", role: "GM" as const };

describe("who a GM can preview", () => {
  test("the players, by name — a GM or an assistant would be a no-op", () => {
    const users = [
      user("gm", "GM", "GM"),
      user("a-player", "PLAYER", "Ada"),
      user("assist", "ASSISTANT", "Helper"),
      user("b-player", "PLAYER", "Bo"),
    ];
    expect(viewAsOptions(users, GM)).toEqual([
      { id: "a-player", name: "Ada" },
      { id: "b-player", name: "Bo" },
    ]);
  });

  test("the viewer's own id is left out, and an empty store offers nothing", () => {
    const users = [user("me", "GM"), user("a-player", "PLAYER", "Ada")];
    expect(viewAsOptions(users, { id: "a-player", role: "PLAYER" })).toEqual([]);
    expect(viewAsOptions([], GM)).toEqual([]);
  });

  test("a nameless user document falls back to its id, never to an empty row", () => {
    expect(viewAsOptions([user("a-player", "PLAYER", "")], GM)).toEqual([
      { id: "a-player", name: "a-player" },
    ]);
  });
});

describe("the identity a preview runs as", () => {
  test("a chosen player becomes the permission user the fog loop is handed", () => {
    expect(viewAsUser([user("a-player", "PLAYER", "Ada")], "a-player")).toEqual({
      id: "a-player",
      role: "PLAYER",
    });
  });

  test("no choice, or a user this replica no longer holds, previews nothing", () => {
    expect(viewAsUser([user("a-player", "PLAYER")], "")).toBeNull();
    expect(viewAsUser([user("a-player", "PLAYER")], "gone")).toBeNull();
    expect(viewAsUser([], "a-player")).toBeNull();
  });
});

describe("the preview's one rule on top of the player gate", () => {
  test("a hidden token is withheld from the preview — §5 never gave it to the player", () => {
    const sc = scene({
      tokens: [token("t-open"), token("t-secret", { hidden: true })],
    });
    expect([...(withoutHiddenTokens(sc, new Set(["t-open", "t-secret"])) ?? [])]).toEqual([
      "t-open",
    ]);
  });

  test("nothing hidden, nothing filtered — the very same set comes back", () => {
    const sc = scene({ tokens: [token("t-open")] });
    const ids: ReadonlySet<string> = new Set(["t-open"]);
    expect(withoutHiddenTokens(sc, ids)).toBe(ids);
  });

  test("`null` (fog off / ungated) stays null; with no scene the set passes through", () => {
    expect(withoutHiddenTokens(scene(), null)).toBeNull();
    // nothing to filter against: never drop a gate a caller handed in
    const ids: ReadonlySet<string> = new Set(["t-open"]);
    expect(withoutHiddenTokens(null, ids)).toBe(ids);
  });

  test("the input set is never mutated", () => {
    const sc = scene({ tokens: [token("t-secret", { hidden: true })] });
    const ids = new Set(["t-secret", "t-open"]);
    withoutHiddenTokens(sc, ids);
    expect([...ids].sort()).toEqual(["t-open", "t-secret"]);
  });
});

describe("viewAsVisibleTokenIds — the whole gate as one call", () => {
  test("it is the player gate (own tokens + sight) minus the withheld documents", () => {
    const player = { id: "a-player", role: "PLAYER" as const };
    const sc = scene({
      tokens: [
        token("t-mine", { ownership: { default: 0, "a-player": 3 } }),
        token("t-seen", { x: 300, y: 100 }),
        token("t-secret", { x: 320, y: 120, hidden: true }),
        token("t-far", { x: 900, y: 700 }),
      ],
    });
    const gate = viewAsVisibleTokenIds(sc, player, [squareAround(200, 100)]);
    expect([...gate].sort()).toEqual(["t-mine", "t-seen"]);
    // …and the GM, same polygons: everything, which is why the GM is not a previewable user
    expect(fogVisibleTokenIds(sc, GM, [squareAround(200, 100)]).size).toBe(4);
  });

  test("with nothing withheld it hands back the gate unchanged", () => {
    const player = { id: "a-player", role: "PLAYER" as const };
    const sc = scene({ tokens: [token("t-seen", { x: 300, y: 100 })] });
    expect([...viewAsVisibleTokenIds(sc, player, [squareAround(200, 100)])]).toEqual(["t-seen"]);
  });
});
