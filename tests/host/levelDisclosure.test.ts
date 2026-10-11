import { expect, test } from "vitest";
import { HostLevelDisclosure, LevelExposureTracker, type LevelDisclosureInput } from "../../src/host/levelDisclosure";
import { SpatialKernel, type SpatialSurface } from "../../src/core/spatial/kernel";
import { SpatialPerception, type PerceptionBody } from "../../src/core/spatial/perception";
import { draftLevel } from "../../src/core/levels";
import type { SceneDocument, TokenDocument } from "../../src/core/documents";
const player = { id: "p", role: "PLAYER" as const };
const token = (id: string, levelId: string, z: number, owner = false): TokenDocument => ({ _id: id, type: "token", name: id, ownership: { default: 2, ...(owner ? { p: 3 } : {}) }, flags: {}, system: {},
  x: 50, y: 50, width: 10, height: 10, rotation: 0, elevation: z, levelId, img: "", vision: true, hidden: false, disposition: "neutral", light: { radius: 0, color: "#fff", alpha: 0 } });
const body = (t: TokenDocument): PerceptionBody => ({ feet: { x: t.x, y: t.y, z: t.elevation ?? 0 }, width: t.width, depth: t.height, height: 2, eyeHeight: 1.5, rotation: t.rotation, sight: 100, darkvision: 0 });
function floor(hole = false, blocks: SpatialSurface["planes"][number]["blocks"] = ["sight", "light"]): SpatialSurface {
  return { id: "ceiling", transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 }, footprint: { version: 2, components: [{ outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], holes: hole ? [[{ x: .3, y: .3 }, { x: .3, y: .7 }, { x: .7, y: .7 }, { x: .7, y: .3 }]] : [] }] }, planes: [{ z: 10, blocks, supportsMovement: true }] };
}
function fixture(hole = false): LevelDisclosureInput {
  const a = draftLevel("base", "Known room"), b = { ...draftLevel("upper", "SECRET UPPER ROOM", 10, 20), darkness: 1 };
  a.visibleLevelIds = [b._id];
  const tokens = [token("own", "base", 0, true), token("remote", "upper", 10)];
  const scene: SceneDocument = { _id: "s", type: "scene", name: "Scene", ownership: { default: 2 }, flags: {}, system: {}, active: true, img: null, width: 100, height: 100, darkness: 0,
    grid: { type: "square", size: 10, distance: 1, units: "ft", diagonals: "555", hexLayout: "oddQ" }, levels: [a, b], tokens, walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [] };
  return { scene, actors: [], bodies: new Map(tokens.map((t) => [t._id, body(t)])), barriers: [], surfaces: [floor(hole)], lights: [{ id: "torch-below", at: { x: 50, y: 50, z: 2 }, bright: 20, dim: 30 }], worldSeq: 1, geometryRevision: 1 };
}
function ids(input: LevelDisclosureInput) {
  const result = new HostLevelDisclosure(input).plan(player, { levelId: "base" }); if (!result.ok) throw new Error(result.error); return result.plan;
}

test("sealed three-dimensional plane blocks sight and light; a real aperture permits only the token", () => {
  expect(ids(fixture()).tokenIds).toEqual(["own"]);
  const open = ids(fixture(true)); expect(open.tokenIds).toEqual(["own", "remote"]);
  expect(open.levels).toEqual([{ id: "base", name: "Known room" }]); expect(open.terrainRegions).toEqual([]);
  expect(JSON.stringify(open)).not.toContain("SECRET"); expect(JSON.stringify(open)).not.toContain("upper");
});
test("floor selection and forged observers never grant access, and directed eligibility remains necessary", () => {
  const input = fixture(true), authority = new HostLevelDisclosure(input);
  expect(authority.plan(player, { levelId: "upper" })).toEqual(authority.plan(player, { levelId: "nonexistent" }));
  expect(authority.plan(player, { levelId: "base", observerIds: ["remote"] })).toEqual({ ok: false, error: "unavailable" });
  expect(authority.plan(player, { levelId: "base", observerIds: new Array(1) })).toEqual({ ok: false, error: "unavailable" });
  const level = input.scene.levels?.[0]; if (!level) throw new Error("fixture"); level.visibleLevelIds = [];
  expect(ids(input).tokenIds).toEqual(["own"]);
});
test("independent sight/light channels and target darkness both matter; darkvision never bypasses the ceiling", () => {
  const input = fixture(); input.surfaces = [floor(false, ["light"])];
  expect(ids(input).tokenIds).toEqual(["own"]); // glass transmits sight, not light
  const eye = input.bodies.get("own"); if (!eye) throw new Error("fixture"); eye.darkvision = 30;
  expect(ids(input).tokenIds).toEqual(["own", "remote"]);
  input.surfaces = [floor(false, ["sight"])]; expect(ids(input).tokenIds).toEqual(["own"]);
});
test("hidden targets stay hidden and authority snapshots cannot be changed by mutation of source arrays", () => {
  const input = fixture(true), target = input.scene.tokens[1]; if (!target) throw new Error("fixture"); target.hidden = true;
  const authority = new HostLevelDisclosure(input); target.hidden = false; input.surfaces = [];
  const result = authority.plan(player, { levelId: "base" }); expect(result).toMatchObject({ ok: true, plan: { tokenIds: ["own"] } });
});
test("light falloff measures Z in distance units, not XY pixels", () => {
  const queries = new SpatialPerception(new SpatialKernel([], []), [{ id: "l", at: { x: 0, y: 0, z: 0 }, bright: 1, dim: 5 }], 100);
  expect(queries.lightAt({ x: 300, y: 0, z: 4 }, 1).lit).toBe(true);
  expect(queries.lightAt({ x: 300, y: 0, z: 4.01 }, 1).lit).toBe(false);
  expect(() => queries.lightAt({ x: 0, y: 0, z: 0 }, NaN)).toThrow();
  expect(() => queries.sees({ ...body(token("t", "base", 0)), darkvision: 100 }, [{ x: 50, y: 50, z: 1 }], NaN)).toThrow("darkness");
});
test("door geometry revision conceals a target without deleting any canonical document", () => {
  const input = fixture(true), tracker = new LevelExposureTracker();
  const first = tracker.update(ids(input)); expect(first).toMatchObject({ baseViewRevision: 0, viewRevision: 1, addedTokenIds: ["own", "remote"] });
  input.surfaces = [floor(false)]; input.geometryRevision = 2;
  const next = ids(input), second = tracker.update(next);
  expect(second).toMatchObject({ baseViewRevision: 1, viewRevision: 2, removedTokenIds: ["remote"], addedTokenIds: [] });
  expect(input.scene.tokens).toHaveLength(2);
  expect(() => tracker.update({ ...next, geometryRevision: 1 })).toThrow("Stale");
  expect(() => tracker.update({ ...next, userId: "someone-else" })).toThrow("mismatched");
});
test("invalid body snapshots and ray budget overflow fail closed instead of returning partial exposure", () => {
  const input = fixture(true), eye = input.bodies.get("own"); if (!eye) throw new Error("fixture"); eye.feet.x++;
  expect(() => new HostLevelDisclosure(input)).toThrow("aligned");
  const queries = new SpatialPerception(new SpatialKernel([], []), [{ id: "l", at: { x: 0, y: 0, z: 0 }, bright: 1, dim: 20 }], 10, 1);
  queries.lightAt({ x: 0, y: 0, z: 2 }, 1); expect(() => queries.lightAt({ x: 0, y: 0, z: 3 }, 1)).toThrow("budget");
});
