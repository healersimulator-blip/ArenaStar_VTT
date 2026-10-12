/** G-32 (D-440), D-452: token height labels and the smaller-at-other-heights cue. */
import { describe, expect, test } from "vitest";
import { draftLevel } from "../../src/core/levels";
import {
  elevationCues, elevationDifference, elevationLabel, elevationReference, elevationScale, elevationViewer, heightAboveFloor,
  lowerTokenLabels, tokenElevationModeOf, tokenElevationScaleOf,
} from "../../src/core/elevationCues";
import { validateWorldSettingsPatch } from "../../src/core/worldSettings";
import type { ActorDocument, SceneDocument, TokenDocument } from "../../src/core/documents";

const base = { ownership: { default: 0 as const }, flags: {}, system: {} };
const token = (id: string, elevation: number, levelId?: string, over: Partial<TokenDocument> = {}): TokenDocument => ({
  ...base, _id: id, type: "token", name: id, x: 50, y: 50, width: 100, height: 100, rotation: 0, elevation,
  ...(levelId ? { levelId } : {}), img: "", hidden: false, disposition: "neutral", vision: false, light: { radius: 0, color: "#fff", alpha: 0 }, ...over,
});
function scene(tokens: TokenDocument[], withLevels = true): SceneDocument {
  return {
    ...base, _id: "s", type: "scene", name: "Keep", active: true, img: null, width: 1000, height: 1000,
    grid: { type: "square", size: 100, distance: 5, units: "ft" } as SceneDocument["grid"], darkness: 0,
    ...(withLevels ? { levelMode: "isolated" as const, levels: [draftLevel("ground", "Ground", 0, 10, 0), draftLevel("upper", "Upper", 10, 20, 1)] } : {}),
    tokens, walls: [], lights: [], sounds: [], tiles: [], regions: [], drawings: [], templates: [], notes: [],
  };
}

describe("G-32 elevation cues", () => {
  test("the badge reads the height above the token's own floor", () => {
    const s = scene([]);
    expect(heightAboveFloor(s, token("a", 15, "upper"))).toBe(5);
    expect(heightAboveFloor(s, token("b", 10, "upper"))).toBe(0);
    // No level: the band its feet are in, else the ground.
    expect(heightAboveFloor(s, token("c", 12.5))).toBe(2.5);
    expect(heightAboveFloor(scene([], false), token("d", 30))).toBe(30);
    expect(heightAboveFloor(scene([], false), token("e", -5))).toBe(-5);
    expect(elevationLabel(5, "ft")).toBe("+5 ft");
    expect(elevationLabel(-2.5, "m")).toBe("-2.5 m");
    expect(elevationLabel(3, "")).toBe("+3");
    expect(elevationLabel(0, "ft")).toBeNull();
  });

  test("tokens away from the viewer's height shrink smoothly down to half size", () => {
    expect(elevationScale(0, 5)).toBe(1);
    expect(elevationScale(10, 5)).toBe(0.833);
    expect(elevationScale(-10, 5)).toBe(0.833);
    expect(elevationScale(50, 5)).toBe(0.5);
    expect(elevationScale(500, 5)).toBe(0.5);
    expect(elevationScale(10, 0)).toBe(0.833); // a bad grid distance falls back to 5
  });

  test("D-452: the GM reads heights from the ground, a player from their own token; cues are sparse and gm mode reveals nothing", () => {
    const tokens = [token("flyer", 15, "ground"), token("walker", 0, "ground"), token("upstairs", 10, "upper")];
    const s = scene(tokens);
    const labels = (cues: Map<string, { label: string | null }>) => Object.fromEntries([...cues].map(([id, c]) => [id, c.label]));
    // The GM: from 0, whatever floor a token is on (the upstairs token stands on its floor at 10).
    expect(labels(elevationCues(s, tokens, { mode: "all", scaleByHeight: false, isGm: true, viewer: null }))).toEqual({ flyer: "+15 ft", upstairs: "+10 ft" });
    // The GM's selection never moves the reference.
    expect(labels(elevationCues(s, tokens, { mode: "all", scaleByHeight: false, isGm: true, viewer: tokens[0] as TokenDocument }))).toEqual({ flyer: "+15 ft", upstairs: "+10 ft" });
    // A player: from their own token.
    expect(labels(elevationCues(s, tokens, { mode: "all", scaleByHeight: false, isGm: false, viewer: tokens[0] as TokenDocument }))).toEqual({ walker: "-15 ft", upstairs: "-5 ft" });
    expect(labels(elevationCues(s, tokens, { mode: "all", scaleByHeight: false, isGm: false, viewer: tokens[2] as TokenDocument }))).toEqual({ flyer: "+5 ft", walker: "-10 ft" });
    expect(elevationCues(s, tokens, { mode: "gm", scaleByHeight: true, isGm: false, viewer: tokens[1] as TokenDocument }).size).toBe(0);
    expect(elevationCues(s, tokens, { mode: "gm", scaleByHeight: false, isGm: true, viewer: null }).get("flyer")?.label).toBe("+15 ft");
    expect(elevationCues(s, tokens, { mode: "off", scaleByHeight: true, isGm: true, viewer: tokens[1] as TokenDocument }).size).toBe(0);
    const scaled = elevationCues(s, tokens, { mode: "all", scaleByHeight: true, isGm: false, viewer: tokens[1] as TokenDocument });
    expect(Object.fromEntries(scaled)).toEqual({
      flyer: { label: "+15 ft", scale: elevationScale(15, 5) },
      upstairs: { label: "+10 ft", scale: 0.833 },
    });
  });

  test("D-452: the reference and the rounded difference", () => {
    expect(elevationReference({ isGm: true, viewer: { elevation: 20 }, floorZ: 35 })).toBe(0);
    expect(elevationReference({ isGm: false, viewer: { elevation: 20 }, floorZ: 35 })).toBe(20);
    expect(elevationReference({ isGm: false, viewer: {}, floorZ: 35 })).toBe(0); // a token without elevation stands at 0
    expect(elevationReference({ isGm: false, viewer: null, floorZ: 35 })).toBe(35);
    expect(elevationReference({ isGm: false, viewer: null, floorZ: null })).toBe(0);
    expect(elevationReference({ isGm: false, viewer: null, floorZ: Number.NaN })).toBe(0);
    expect(elevationDifference(10.004, 0)).toBe(10);
    expect(Object.is(elevationDifference(5, 5), 0)).toBe(true);
    expect(elevationDifference(undefined, 20)).toBe(-20);
    expect(elevationDifference(Number.POSITIVE_INFINITY, 0)).toBe(0);
  });

  test("D-452: tokens seen on floors below are labelled the same way, never scaled", () => {
    const below = [token("goblin", 0, "ground"), token("bat", 7.5, "ground")];
    const me = token("me", 10, "upper");
    const s = scene([...below, me]);
    expect(Object.fromEntries(lowerTokenLabels(s, below, { mode: "all", isGm: false, viewer: me }))).toEqual({ goblin: "-10 ft", bat: "-2.5 ft" });
    expect(Object.fromEntries(lowerTokenLabels(s, below, { mode: "all", isGm: true, viewer: me }))).toEqual({ bat: "+7.5 ft" });
    expect(lowerTokenLabels(s, below, { mode: "gm", isGm: false, viewer: me }).size).toBe(0);
    // No own token on this floor: from the floor's Z.
    expect(Object.fromEntries(lowerTokenLabels(s, below, { mode: "all", isGm: false, viewer: null, floorZ: 10 }))).toEqual({ goblin: "-10 ft", bat: "-2.5 ft" });
  });

  test("the viewer is the first selected token the user controls, else the followed token, else (D-452) their first token", () => {
    const mine = token("mine", 0, "ground", { ownership: { default: 0, alice: 3 } });
    const pet = token("pet", 0, "ground", { actorId: "petActor" });
    const theirs = token("theirs", 10, "upper");
    const s = scene([mine, pet, theirs]);
    const actors = [{ ...base, _id: "petActor", type: "actor", name: "Pet", ownership: { default: 0, alice: 3 }, items: [] } as unknown as ActorDocument];
    const alice = { id: "alice", role: "PLAYER" as const };
    expect(elevationViewer(s, alice, actors, ["theirs", "pet"])?._id).toBe("pet");
    expect(elevationViewer(s, alice, actors, ["theirs"], "mine")?._id).toBe("mine");
    // D-452: neither selected nor followed: the player's first token, preferring one with vision.
    expect(elevationViewer(s, alice, actors, ["theirs"], "theirs")?._id).toBe("mine");
    expect(elevationViewer(scene([mine, { ...pet, vision: true }, theirs]), alice, actors, [])?._id).toBe("pet");
    expect(elevationViewer(scene([theirs]), alice, actors, [])).toBeNull();
    expect(elevationViewer(s, { id: "gm", role: "GM" }, actors, ["theirs"])?._id).toBe("theirs");
    // The GM never falls back: their labels read from the ground anyway.
    expect(elevationViewer(s, { id: "gm", role: "GM" }, actors, [])).toBeNull();
    expect(elevationViewer(s, null, actors, ["mine"])).toBeNull();
  });

  test("the settings default to visible badges and no size cue, and are validated", () => {
    expect(tokenElevationModeOf({})).toBe("all");
    expect(tokenElevationModeOf({ tokenElevation: "gm" })).toBe("gm");
    expect(tokenElevationScaleOf({})).toBe(false);
    expect(tokenElevationScaleOf({ tokenElevationScale: true })).toBe(true);
    expect(validateWorldSettingsPatch({ tokenElevation: "off", tokenElevationScale: true }).ok).toBe(true);
    expect(validateWorldSettingsPatch({ tokenElevation: "players" }).error).toBe("tokenElevation must be all, gm, or off");
    expect(validateWorldSettingsPatch({ tokenElevationScale: "yes" }).error).toBe("tokenElevationScale must be a boolean");
  });

  test("D-443: on an isolated player floor (no levels in the replica) the badge measures from the focused floor's Z", () => {
    // What a player's replica holds: no `levels`, no `levelId`.
    const tokens = [token("me", 10), token("flyer", 25)];
    const s = scene(tokens, false);
    expect(Object.fromEntries(elevationCues(s, tokens, { mode: "all", scaleByHeight: false, isGm: false, viewer: null }))).toEqual({
      me: { label: "+10 ft", scale: 1 }, flyer: { label: "+25 ft", scale: 1 } }); // the old, wrong reading
    expect(Object.fromEntries(elevationCues(s, tokens, { mode: "all", scaleByHeight: false, isGm: false, viewer: null, floorZ: 10 }))).toEqual({
      flyer: { label: "+15 ft", scale: 1 } });
    // D-452: the player's own token wins over the floor.
    expect(Object.fromEntries(elevationCues(s, tokens, { mode: "all", scaleByHeight: false, isGm: false, viewer: tokens[1] as TokenDocument, floorZ: 10 }))).toEqual({
      me: { label: "-15 ft", scale: 1 } });
  });
});
