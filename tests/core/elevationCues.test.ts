/** G-32 (D-440): token height badges and the smaller-at-other-heights cue. */
import { describe, expect, test } from "vitest";
import { draftLevel } from "../../src/core/levels";
import {
  elevationCues, elevationLabel, elevationScale, elevationViewer, heightAboveFloor, tokenElevationModeOf, tokenElevationScaleOf,
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

  test("cues are sparse, follow the world setting and never reveal heights in gm mode", () => {
    const tokens = [token("flyer", 15, "ground"), token("walker", 0, "ground"), token("upstairs", 10, "upper")];
    const s = scene(tokens);
    const all = elevationCues(s, tokens, { mode: "all", scaleByHeight: false, isGm: false, viewer: null });
    expect([...all]).toEqual([["flyer", { label: "+15 ft", scale: 1 }]]);
    expect(elevationCues(s, tokens, { mode: "gm", scaleByHeight: true, isGm: false, viewer: tokens[1] as TokenDocument }).size).toBe(0);
    expect(elevationCues(s, tokens, { mode: "gm", scaleByHeight: false, isGm: true, viewer: null }).get("flyer")?.label).toBe("+15 ft");
    expect(elevationCues(s, tokens, { mode: "off", scaleByHeight: true, isGm: true, viewer: tokens[1] as TokenDocument }).size).toBe(0);
    const scaled = elevationCues(s, tokens, { mode: "all", scaleByHeight: true, isGm: false, viewer: tokens[1] as TokenDocument });
    expect(Object.fromEntries(scaled)).toEqual({
      flyer: { label: "+15 ft", scale: elevationScale(15, 5) },
      upstairs: { label: null, scale: 0.833 },
    });
  });

  test("the viewer is the first selected token the user controls, else the followed token", () => {
    const mine = token("mine", 0, "ground", { ownership: { default: 0, alice: 3 } });
    const pet = token("pet", 0, "ground", { actorId: "petActor" });
    const theirs = token("theirs", 10, "upper");
    const s = scene([mine, pet, theirs]);
    const actors = [{ ...base, _id: "petActor", type: "actor", name: "Pet", ownership: { default: 0, alice: 3 }, items: [] } as unknown as ActorDocument];
    const alice = { id: "alice", role: "PLAYER" as const };
    expect(elevationViewer(s, alice, actors, ["theirs", "pet"])?._id).toBe("pet");
    expect(elevationViewer(s, alice, actors, ["theirs"], "mine")?._id).toBe("mine");
    expect(elevationViewer(s, alice, actors, ["theirs"], "theirs")).toBeNull();
    expect(elevationViewer(s, { id: "gm", role: "GM" }, actors, ["theirs"])?._id).toBe("theirs");
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
});
