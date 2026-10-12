/**
 * D-454 — the "Ice Beacon — Elevation Test" scene of the PF1e starter worlds
 * (`scripts/starterIceBeacon.mjs`, ELEVATION_TEST_SCENE.md).
 *
 * The documents come from the builder's own `testerDocuments`, so these are the rows that ship.
 * Every claim of the tester script is checked against the real floor, sight and label code:
 * the scene validates and passes the floor-play check without findings, every stair lands on solid
 * floor, the crates hide the Ambusher until Hosilla climbs, the open scaffold hides nothing, and
 * the labels read from the ground (GM) or from Hosilla (player), on her floor and on floors below.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { ActorDocument, LevelDocument, NoteDocument, SceneDocument, TokenDocument } from "../../src/core/documents";
import { sceneLevelsError } from "../../src/core/levels";
import { sceneRegionsError } from "../../src/core/regionValidation";
import { levelPlayAudit } from "../../src/core/levelAudit";
import { floorSolidAt, surfaceOpenings } from "../../src/core/floorSurface";
import { floorFooting } from "../../src/core/floorSupport";
import { floorPresentation, floorScene, stairSpec, visibleFloorsBelow } from "../../src/core/levelPlay";
import { groundAt, raisedSight, raisedVolumes } from "../../src/core/raisedAreas";
import { fogViewers, fogVisibleTokenIds } from "../../src/core/fogExploration";
import { elevationCues, elevationViewer, lowerTokenLabels } from "../../src/core/elevationCues";
import { tokensSeenBelow } from "../../src/core/crossFloorSight";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const mod = (await import(/* @vite-ignore */ join(repoRoot, "scripts/buildStarterWorlds.mjs"))) as {
  testerDocuments: (contentDir: string | null) => Array<{ _id: string; type: string; name: string }>;
};
const docs = mod.testerDocuments(null);
const scene = docs.find((d) => d._id === "scene-ice-beacon") as unknown as SceneDocument;
const actors = docs.filter((d) => d.type === "actor") as unknown as ActorDocument[];
const HALL = "lvl-ib-hall", GALLERY = "lvl-ib-gallery", RING = "lvl-ib-ring", BEACON = "lvl-ib-beacon";
const player = { id: "tester", role: "PLAYER" as const };
const gm = { id: "gm", role: "GM" as const };
const whole = new Float32Array([0, 0, 2200, 0, 2200, 2200, 0, 2200]);
const level = (id: string) => scene.levels?.find((l) => l._id === id) as LevelDocument;
const tokenById = (id: string) => scene.tokens.find((t) => t._id === id) as TokenDocument;
/** The scene with Hosilla moved (her floor and elevation must agree). */
const withHosilla = (levelId: string, x: number, y: number, elevation: number): SceneDocument =>
  ({ ...scene, tokens: scene.tokens.map((t) => (t._id === "tok-ib-hosilla" ? { ...t, levelId, x, y, elevation } : t)) });

/**
 * What a player's client sees on the Ground Hall with Hosilla at (x, y, z): the player's floor scene
 * (Hall tokens, its raised areas, no levels — players hold none) through the fog token gate.
 */
function hallSees(x: number, y: number, z: number): string[] {
  const moved = withHosilla(HALL, x, y, z);
  const floor = floorScene(moved, { isolated: true, levelId: HALL, tokenIds: moved.tokens.filter((t) => t.levelId === HALL).map((t) => t._id),
    presentation: floorPresentation(moved, level(HALL)) });
  const { levels: _levels, levelMode: _mode, ...rest } = floor; void _levels; void _mode;
  const replica = rest as SceneDocument;
  const viewers = fogViewers(replica, player, { actors });
  const sight = raisedSight(replica, viewers, 0);
  if (!sight) throw new Error("the Hall's crates are solid raised areas");
  return [...fogVisibleTokenIds(replica, player, [whole], { actors, viewers, raised: { sight, wallPolys: [whole] } })]
    .map((id) => id.replace("tok-ib-", "")).sort();
}
const seenBelow = (levelId: string, x: number, y: number, z: number) =>
  tokensSeenBelow(withHosilla(levelId, x, y, z), actors, player, levelId).map((b) => b.id.replace("tok-ib-", "")).sort();
/** Labels (by short id) for the tokens on one floor, as the GM or as the player with Hosilla at her current spot. */
function labels(s: SceneDocument, user: typeof gm | typeof player, levelId: string): Record<string, string> {
  const isGm = user.role === "GM";
  const viewer = isGm ? null : elevationViewer(s, user, actors, []);
  const cues = elevationCues(s, s.tokens.filter((t) => t.levelId === levelId), { mode: "all", scaleByHeight: false, isGm, viewer });
  return Object.fromEntries([...cues].flatMap(([id, cue]) => (cue.label ? [[id.replace("tok-ib-", ""), cue.label]] : [])));
}

describe("D-454 Ice Beacon: structure", () => {
  test("ships in the starter documents with its own actors, a journal guide and a start note", () => {
    expect(scene).toMatchObject({ name: "Ice Beacon — Elevation Test", active: false, width: 2200, height: 2200, levelMode: "isolated",
      grid: { size: 100, distance: 5, units: "ft" }, darkness: 0, flags: { core: { fog: true } }, background: { color: "#1b2430" } });
    expect(docs.find((d) => d._id === "journal-ice-beacon")).toMatchObject({ type: "journal", name: "Ice Beacon — Elevation Test" });
    const note = scene.notes[0] as NoteDocument;
    expect(note).toMatchObject({ journalId: "journal-ice-beacon", visible: true, levelScope: { mode: "levels", ids: [HALL] } });
    // Hosilla is the Jungle demo's player character; every opponent has an actor of its own.
    const hosilla = tokenById("tok-ib-hosilla");
    expect(hosilla).toMatchObject({ actorId: "hosilla", disposition: "friendly", ownership: { default: 3 }, vision: true });
    const foes = scene.tokens.filter((t) => t.disposition === "hostile");
    expect(foes).toHaveLength(9);
    expect(new Set(foes.map((t) => t.actorId)).size).toBe(9);
    for (const t of scene.tokens) expect(actors.some((a) => a._id === t.actorId), t._id).toBe(true);
  });

  test("validates, and the floor-play check has nothing to report", () => {
    expect(sceneLevelsError(scene)).toBeNull();
    expect(sceneRegionsError(scene)).toBeNull();
    expect(levelPlayAudit(scene)).toEqual([]);
  });

  test("four floors of 20, 15 and 10 ft under an open-topped Beacon, each seeing every floor below", () => {
    expect(scene.levels?.map((l) => [l.name, l.bottom, l.top, l.top === null ? null : l.top - (l.bottom ?? 0)])).toEqual([
      ["Ground Hall", 0, 20, 20], ["Gallery", 20, 35, 15], ["Crystal Ring", 35, 45, 10], ["Beacon", 45, null, null]]);
    expect(visibleFloorsBelow(scene, level(BEACON)).map((f) => f.level._id)).toEqual([RING, GALLERY, HALL]);
    expect(visibleFloorsBelow(scene, level(GALLERY)).map((f) => f.level._id)).toEqual([HALL]);
    // Each floor shows its own art; the Hall also its crate and scaffold props.
    for (const l of scene.levels ?? []) for (const id of l.tileIds ?? []) expect(scene.tiles.some((t) => t._id === id)).toBe(true);
    expect(level(HALL).tileIds).toHaveLength(5);
    // Holes between floors: the Gallery's and the Ring's openings (the Hall is solid, the Beacon a disc).
    expect(level(HALL).surface).toBeUndefined();
    expect(surfaceOpenings(level(GALLERY).surface as NonNullable<LevelDocument["surface"]>)).toHaveLength(3);
    expect(surfaceOpenings(level(RING).surface as NonNullable<LevelDocument["surface"]>)).toHaveLength(2);
    expect(floorSolidAt(level(GALLERY), { x: 1100, y: 1200 })).toBe(false); // over the Hall
    expect(floorSolidAt(level(BEACON), { x: 300, y: 300 })).toBe(false); // open sky beside the disc
    // Walls are on their floor (unscoped walls do nothing in floor play); the Hall's entrance is locked.
    expect(scene.walls.every((w) => w.levelScope?.mode === "levels" && w.levelScope.ids.length === 1)).toBe(true);
    expect(scene.walls.filter((w) => w.door !== 0)).toEqual([expect.objectContaining({ _id: "door-ib-hall-entrance", door: 2 })]);
  });

  test("stairs join every pair of neighbouring floors and land on solid floor outside the stairwell", () => {
    const stairs = (scene.regions ?? []).filter((r) => r.stairs);
    expect(stairs.map((r) => [r._id, stairSpec(r.stairs as NonNullable<typeof r.stairs>).levels])).toEqual([
      ["stairs-ib-west", [HALL, GALLERY]], ["stairs-ib-east", [HALL, GALLERY]], ["stairs-ib-balcony", [HALL, GALLERY]],
      ["stairs-ib-twin-west", [GALLERY, RING]], ["stairs-ib-twin-east", [GALLERY, RING]], ["stairs-ib-beacon", [RING, BEACON]]]);
    for (const r of stairs) {
      const spec = stairSpec(r.stairs as NonNullable<typeof r.stairs>);
      expect(r.hidden).toBe(true); // GM-only region; players get the marker
      expect(spec.arrivals.map((a) => a.levelId).sort()).toEqual([...spec.levels].sort());
      for (const a of spec.arrivals) {
        expect(floorSolidAt(level(a.levelId), a), `${r._id} → ${a.levelId}`).toBe(true);
        const inside = a.x >= r.x && a.x <= r.x + r.width && a.y >= r.y && a.y <= r.y + r.height;
        expect(inside, `${r._id} → ${a.levelId}`).toBe(false);
      }
    }
  });

  test("every token stands on its floor or flies; the crate stacks and the scaffold carry the hobgoblins", () => {
    for (const t of scene.tokens) expect(floorFooting(scene, t).supported, t._id).toBe(true);
    expect(raisedVolumes(scene).map((v) => [v.name, v.levelId, v.top, v.solid, v.standable])).toEqual([
      ["Crates (5 ft)", HALL, 5, true, true], ["Crates (10 ft)", HALL, 10, true, true],
      ["Crates (15 ft)", HALL, 15, true, true], ["Scaffold (10 ft, open)", HALL, 10, false, true]]);
    for (const id of ["tok-ib-lookout", "tok-ib-sentry", "tok-ib-archer", "tok-ib-ambusher", "tok-ib-orc", "tok-ib-hosilla"]) {
      const t = tokenById(id);
      expect(t.elevation, id).toBe(groundAt(scene, t));
    }
    expect(tokenById("tok-ib-vrock")).toMatchObject({ levelId: GALLERY, elevation: 30, width: 200 }); // airborne over the opening
    expect(floorSolidAt(level(GALLERY), tokenById("tok-ib-vrock"))).toBe(false);
  });
});

describe("D-454 Ice Beacon: what a player sees on the Ground Hall", () => {
  test("from the entrance: everyone but the Ambusher behind the solid crates; the orc shows through the open scaffold", () => {
    expect(hallSees(1150, 1750, 0)).toEqual(["archer", "hosilla", "lookout", "orc", "sentry"]);
  });

  test("climbing the crates changes what is in view", () => {
    // 5 ft, south-east square: the 10- and 15-ft stacks still hide the Ambusher
    expect(hallSees(750, 1550, 5)).toEqual(["archer", "hosilla", "lookout", "orc", "sentry"]);
    // 10 ft, north squares: over the stack's edge, the Ambusher appears; the 15-ft stack now hides the scaffold
    expect(hallSees(750, 1250, 10)).toEqual(["ambusher", "hosilla", "lookout", "sentry"]);
    // 15 ft, north-west square: everything is in view
    expect(hallSees(850, 1250, 15)).toEqual(["ambusher", "archer", "hosilla", "lookout", "orc", "sentry"]);
  });
});

describe("D-454 Ice Beacon: height labels", () => {
  test("the GM reads every token from the ground", () => {
    expect(labels(scene, gm, HALL)).toEqual({ lookout: "+15 ft", sentry: "+5 ft", archer: "+10 ft" });
    expect(labels(scene, gm, GALLERY)).toEqual({ troll: "+20 ft", vrock: "+30 ft" });
    expect(labels(scene, gm, RING)).toEqual({ "axe-beak": "+35 ft" });
    expect(labels(scene, gm, BEACON)).toEqual({ oracle: "+45 ft" });
  });

  test("a player reads from Hosilla, wherever she stands", () => {
    expect(labels(scene, player, HALL)).toEqual({ lookout: "+15 ft", sentry: "+5 ft", archer: "+10 ft" });
    expect(labels(withHosilla(HALL, 750, 1550, 5), player, HALL)).toEqual({ lookout: "+10 ft", archer: "+5 ft", ambusher: "-5 ft", orc: "-5 ft" });
    // On the Gallery: the Troll is level with her, the Vrock flies 10 ft above.
    const gallery = withHosilla(GALLERY, 450, 650, 20);
    expect(labels(gallery, player, GALLERY)).toEqual({ vrock: "+10 ft" });
    // Tokens seen below through the opening are labelled from her too.
    const viewer = elevationViewer(gallery, player, actors, []);
    const hall = gallery.tokens.filter((t) => t.levelId === HALL);
    expect(Object.fromEntries(lowerTokenLabels(gallery, hall, { mode: "all", isGm: false, viewer }))).toMatchObject({
      "tok-ib-lookout": "-5 ft", "tok-ib-archer": "-10 ft", "tok-ib-orc": "-20 ft", "tok-ib-ambusher": "-20 ft" });
  });
});

describe("D-454 Ice Beacon: seeing down through the openings", () => {
  test("from the Gallery, Hall tokens show through the opening, more of them from its edge", () => {
    expect(seenBelow(GALLERY, 450, 650, 20)).toEqual(["archer", "lookout", "orc"]); // west spiral's landing
    expect(seenBelow(GALLERY, 1150, 750, 20)).toEqual(["ambusher", "archer", "lookout", "orc"]); // balcony's south edge
  });

  test("from the Ring, both floors below; from the Beacon's rim, the Ring", () => {
    expect(seenBelow(RING, 1150, 1750, 35)).toEqual(["archer", "lookout", "orc", "sentry", "troll", "vrock"]); // twin spirals' landing
    expect(seenBelow(BEACON, 750, 1150, 45)).toEqual(["axe-beak"]); // west rim
    expect(seenBelow(BEACON, 1150, 1150, 45)).toEqual([]); // the disc hides what is under it
  });
});
