/**
 * P02/D-197 — the sheet's position-aware resolve consumer, the pure half.
 * `pf1eResolvePositionReport` reads the same scene facts the canvas owns and
 * asks the pair seam for flanking/cover/concealment; these tests pin the
 * lookup contract (`activeSceneOf`, `tokenOfActor`), the fold the resolve flow
 * consumes, and the hint line's honesty (every unreadable state is named).
 *
 * Fixtures use the tactical convention: grid.size 100 world units per square,
 * distance 5 ft, a token's x/y is its centre, Medium = 100×100.
 */
import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  Json,
  SceneDocument,
  TokenDocument,
  WallDocument,
} from "../../src/core/documents";
import {
  COVER_GRADE_OPTIONS,
  activeSceneOf,
  pf1eResolvePositionReport,
  resolvePositionHint,
  threatTokensOfScene,
  tokenOfActor,
} from "../../src/ui/sheets/pf1eResolvePosition";

const GRID = {
  type: "square" as const,
  size: 100,
  distance: 5,
  units: "ft",
  diagonals: "555" as const,
  hexLayout: "oddQ" as const,
};

function token(
  id: string,
  col: number,
  row: number,
  extra: Partial<TokenDocument> = {},
): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: id,
    ownership: { default: 2 },
    flags: {},
    system: {},
    x: (col + 0.5) * GRID.size,
    y: (row + 0.5) * GRID.size,
    rotation: 0,
    width: GRID.size,
    height: GRID.size,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 1 },
    ...extra,
  };
}

function wall(c: [number, number, number, number]): WallDocument {
  return {
    _id: `w-${c.join("-")}`,
    type: "wall",
    name: "wall",
    ownership: { default: 2 },
    flags: {},
    system: {},
    c,
    door: 0,
    oneWay: false,
    move: 0,
    sight: 0,
    sound: 0,
    light: 0,
  };
}

function scene(
  tokens: readonly TokenDocument[],
  walls: readonly WallDocument[] = [],
  active = true,
): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Tactical",
    ownership: { default: 2 },
    flags: {},
    system: {},
    active,
    img: null,
    width: 2000,
    height: 2000,
    grid: GRID,
    darkness: 0,
    tokens: [...tokens],
    walls: [...walls],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  };
}

function actor(id: string, pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 2 },
    flags: {},
    system: { pf1e: { abilities: { str: 12, dex: 12, con: 12 }, hp: 10, hpMax: 10, ...pf1e } },
    items: [],
    effects: [],
  };
}

/** The fighter swings at the goblin; `extra` overloads the placement. */
function report(
  extra: Partial<Parameters<typeof pf1eResolvePositionReport>[0]> = {},
) {
  return pf1eResolvePositionReport({
    scene: scene([]),
    actors: [],
    attackerActorId: "fighter",
    targetActorId: "goblin",
    ranged: false,
    ...extra,
  });
}

describe("activeSceneOf — App.svelte's lookup as a pure function", () => {
  test("the flagged scene wins whatever its id; the default id is the fallback; else nothing", () => {
    const flagged = { ...scene([], [], true), _id: "elsewhere" };
    const fallback = scene([], [], false); // _id "scene-1", not flagged
    const other = { ...scene([], [], false), _id: "scene-9" };
    expect(activeSceneOf([other, fallback, flagged], "scene-1")).toBe(flagged);
    expect(activeSceneOf([other, fallback], "scene-1")).toBe(fallback);
    expect(activeSceneOf([other], "scene-1")).toBeNull();
    expect(activeSceneOf([], "scene-1")).toBeNull();
  });
});

describe("pf1eResolvePositionReport — the pair's positional facts", () => {
  test("an adjacent clear pair: no cover, not flanked, honest hint", () => {
    const fighter = token("t-f", 0, 0, { actorId: "fighter", disposition: "hostile" });
    const goblin = token("t-g", 1, 0, { actorId: "goblin", disposition: "friendly" });
    const r = report({ scene: scene([fighter, goblin]) });
    expect(r.ok).toBe(true);
    expect(r.defense).toEqual({});
    expect(r.flanked).toBe(false);
    expect(resolvePositionHint(r, { attacker: "Fighter", target: "Goblin" })).toBe(
      "Fighter vs Goblin: not flanked; no cover.",
    );
  });

  test("a helper directly opposite flanks the target (dispositions named)", () => {
    const fighter = token("t-f", 0, 0, { actorId: "fighter", disposition: "hostile" });
    const goblin = token("t-g", 1, 0, { actorId: "goblin", disposition: "friendly" });
    const rogue = token("t-r", 2, 0, { actorId: "rogue", disposition: "hostile" });
    const r = report({
      scene: scene([fighter, goblin, rogue]),
      actors: [actor("fighter"), actor("goblin"), actor("rogue")],
    });
    expect(r.ok).toBe(true);
    expect(r.flanked).toBe(true);
    expect(r.hostilityAssumed).toBe(false);
    expect(resolvePositionHint(r, { attacker: "Fighter", target: "Goblin" })).toContain(
      "flanked (+2 melee)",
    );
  });

  test("a neutral token leaves hostility assumed — and the assumption is named", () => {
    const fighter = token("t-f", 0, 0, { actorId: "fighter", disposition: "hostile" });
    const goblin = token("t-g", 1, 0, { actorId: "goblin", disposition: "friendly" });
    const bystander = token("t-b", 2, 0, { actorId: "bystander" }); // neutral
    const r = report({ scene: scene([fighter, goblin, bystander]) });
    expect(r.ok).toBe(true);
    // The movement seam's own default: without named dispositions every other
    // token is an enemy, so the bystander still helps flank — the hint names
    // the assumption, and the tri-state select lets the table overrule it.
    expect(r.flanked).toBe(true);
    expect(r.hostilityAssumed).toBe(true);
    expect(resolvePositionHint(r, { attacker: "F", target: "G" })).toContain(
      "hostility assumed",
    );
  });

  test("a wall on the shared edge grants standard cover, folded into the defense", () => {
    const fighter = token("t-f", 0, 0, { actorId: "fighter", disposition: "hostile" });
    const goblin = token("t-g", 1, 0, { actorId: "goblin", disposition: "friendly" });
    const r = report({
      scene: scene([fighter, goblin], [wall([100, 20, 100, 80])]),
    });
    expect(r.ok).toBe(true);
    expect(r.defense).toEqual({ cover: "standard" });
    expect(resolvePositionHint(r, { attacker: "F", target: "G" })).toContain(
      "standard cover",
    );
  });

  test("a solid wall between the pair is total cover — the hint says the attack is refused", () => {
    const fighter = token("t-f", 0, 0, { actorId: "fighter", disposition: "hostile" });
    const goblin = token("t-g", 2, 0, { actorId: "goblin", disposition: "friendly" });
    // The wall over-spans the row (y −50..150) so every corner line crosses
    // it strictly — a wall that merely shares the row's corners leaves the
    // near corners' horizontal lines clear (the endpoint-touch convention).
    const r = report({
      scene: scene([fighter, goblin], [wall([150, -50, 150, 150])]),
    });
    expect(r.ok).toBe(true);
    expect(r.defense).toEqual({ cover: "total" });
    expect(resolvePositionHint(r, { attacker: "F", target: "G" })).toContain(
      "total cover — the attack will be refused",
    );
  });

  test("a ranged shot measures cover the ranged way: an intervening creature is soft cover", () => {
    const fighter = token("t-f", 0, 0, { actorId: "fighter", disposition: "hostile" });
    const mule = token("t-m", 2, 0, { actorId: "mule", disposition: "hostile" });
    const goblin = token("t-g", 4, 0, { actorId: "goblin", disposition: "friendly" });
    const r = report({
      scene: scene([fighter, mule, goblin]),
      ranged: true,
    });
    expect(r.ok).toBe(true);
    expect(r.defense).toEqual({ cover: "soft" });
  });

  test("a melee line reads its reach — in reach, out of reach, and the refusal that names the gap", () => {
    const fighter = token("t-f", 0, 0, { actorId: "fighter", disposition: "hostile" });
    const adjacent = token("t-g", 1, 0, { actorId: "goblin", disposition: "friendly" });
    const far = token("t-g2", 2, 0, { actorId: "goblin2", disposition: "friendly" });
    const inReach = report({
      scene: scene([fighter, adjacent]),
      targetActorId: "goblin",
      reachSquares: 1,
    });
    expect(inReach.ok).toBe(true);
    expect(inReach.reach).toEqual({ canStrike: true, refusals: [] });

    const out = report({
      scene: scene([fighter, far]),
      targetActorId: "goblin2",
      reachSquares: 1,
    });
    expect(out.ok).toBe(true);
    expect(out.reach).toEqual({
      canStrike: false,
      refusals: ["the target is 10 ft away — the attack line reaches 5 ft"],
    });
    expect(resolvePositionHint(out, { attacker: "F", target: "G" })).toContain(
      "out of reach (the target is 10 ft away",
    );

    // A ranged line carries no reach fact — range increments are that seam's.
    const shot = report({
      scene: scene([fighter, far]),
      targetActorId: "goblin2",
      ranged: true,
      reachSquares: 1,
    });
    expect(shot.reach).toBeNull();
  });

  test("every unreadable state is named, never guessed", () => {
    expect(report({ scene: null }).reason).toBe(
      "no active scene — flanking and cover are set by hand",
    );
    const placed = token("t-g", 1, 0, { actorId: "goblin" });
    expect(report({ scene: scene([placed]) }).reason).toContain(
      "the attacker has no token",
    );
    const fighterOnly = token("t-f", 0, 0, { actorId: "fighter" });
    expect(report({ scene: scene([fighterOnly]) }).reason).toContain(
      "the target has no token",
    );
    // The hint renders the failure sentence for the sheet's line.
    const noScene = report({ scene: null });
    expect(
      resolvePositionHint(noScene, { attacker: "F", target: "G" }),
    ).toContain("no active scene");
  });

  test("tokenOfActor and threatTokensOfScene — the linked-token lookup and the Medium default", () => {
    const sc = scene([token("t-f", 0, 0, { actorId: "fighter" }), token("t-x", 3, 3)]);
    expect(tokenOfActor(sc, "fighter")?._id).toBe("t-f");
    expect(tokenOfActor(sc, "nobody")).toBeNull();
    const facts = threatTokensOfScene(sc, [actor("fighter")]);
    // A linked actor's derivation supplies the size; an unlinked token keeps
    // the seam's named Medium default (size absent).
    expect(facts[0]).toMatchObject({ _id: "t-f", size: "Medium" });
    expect(facts[1]).toMatchObject({ _id: "t-x" });
    expect("size" in (facts[1] ?? {})).toBe(false);
  });

  test("COVER_GRADE_OPTIONS lists exactly the hand-set grades geometry cannot see", () => {
    expect([...COVER_GRADE_OPTIONS]).toEqual([
      "partial",
      "soft",
      "standard",
      "improved",
    ]);
  });
});
