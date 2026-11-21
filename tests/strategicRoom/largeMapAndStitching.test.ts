import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { makeToken } from "../../src/app/hostBoot";
import { DocumentStore } from "../../src/core/store";
import { OWNERSHIP_LEVELS, type SceneDocument, type TokenDocument } from "../../src/core/documents";
import {
  sceneDeployment,
  withScenarioBackgroundTiles,
} from "../../src/core/strategicRoom/campaignScene";
import {
  MAP_SPAN,
  parseScenario,
  scenarioProjectionDigest,
  type ScenarioBackground,
} from "../../src/core/strategicRoom/scenario";
import { BattleView } from "../../services/strategic-room/src/battle";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import { deploy } from "../../services/strategic-room/src/scenario";
import { buildGmMedia } from "../../services/strategic-room/src/server";

function makeStore() {
  return new DocumentStore({
    meta: {
      worldId: "world-grand",
      name: "Grand Campaign",
      system: "pf1e",
      systemVersion: "1",
    },
  });
}

function makeStrategicScene(widthSquares: number, heightSquares: number, tokens: TokenDocument[]): SceneDocument {
  const gridSize = 20;
  return {
    _id: "scene-grand-theater",
    type: "scene",
    name: "Grand Strategic Theater",
    ownership: { default: OWNERSHIP_LEVELS.OBSERVER },
    flags: { core: { scale: "strategic" } },
    system: {},
    active: true,
    img: null,
    width: widthSquares * gridSize,
    height: heightSquares * gridSize,
    darkness: 0,
    grid: {
      type: "square",
      size: gridSize,
      distance: 5,
      units: "ft",
      diagonals: "555",
      hexLayout: "oddR",
    },
    tokens,
    walls: [],
    lights: [],
    sounds: [],
    drawings: [],
    templates: [],
    notes: [],
    tiles: [],
  };
}

function makeCompanyToken(
  id: string,
  name: string,
  xFt: number,
  yFt: number,
  disposition: "friendly" | "hostile",
  strength = 20,
): TokenDocument {
  const gridSize = 20;
  const base = makeToken(
    name,
    Math.round((xFt / 5) * gridSize - gridSize),
    Math.round((yFt / 5) * gridSize - gridSize),
  );
  return {
    ...base,
    _id: id,
    width: gridSize * 2,
    height: gridSize * 2,
    rotation: disposition === "friendly" ? 0 : 180,
    disposition,
    flags: { core: { strategicStrength: strength, strategicWeapon: "melee" } },
  };
}

describe("large strategic maps (>500x500 squares), high seat/unit counts, and stitched map tiles", () => {
  test("(a) deploys, projects fog-of-war, and resolves turns on a 3,000 x 3,000 square (15,000 x 15,000 ft) map", () => {
    expect(MAP_SPAN).toBeGreaterThanOrEqual(25_000);
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Continental Campaign",
      seed: 42,
      bounds: { minX: 0, minY: 0, maxX: 15_000, maxY: 15_000 },
      factions: [
        { id: "blue", name: "Blue", color: "#4da3ff" },
        { id: "red", name: "Red", color: "#ff6b6b" },
      ],
      commanders: [
        {
          id: "commander-1",
          factionId: "blue",
          units: [
            { id: "blue-vanguard", name: "Blue Vanguard", anchor: { x: 7480, y: 7500 }, strength: 50, weapon: "melee" },
            { id: "blue-reserve", name: "Blue Reserve", anchor: { x: 400, y: 400 }, strength: 50, weapon: "shot" },
          ],
        },
        {
          id: "commander-2",
          factionId: "red",
          units: [
            // Within 30 ft detection range of Blue Vanguard (rear rank at 7485, clear of 7480)
            { id: "red-screen", name: "Red Screen", anchor: { x: 7505, y: 7500 }, strength: 50, weapon: "melee" },
            // 6,500 ft away in far corner -> must remain hidden by fog of war!
            { id: "red-deep-rear", name: "Red Deep Rear", anchor: { x: 14_200, y: 14_200 }, strength: 50, weapon: "shot" },
          ],
        },
      ],
    });

    const published = deploy(scenario);
    const key = new Uint8Array(32).fill(7);
    const battle = new BattleView(scenario, published, key);

    const blueMarkers = battle.markers({
      id: "commander-1",
      name: "Blue 1",
      role: "PLAYER",
      factionId: "blue",
      epoch: 1,
    });
    const visibleIds = blueMarkers.map((m) => m.id);
    expect(visibleIds).toContain("blue-vanguard");
    expect(visibleIds).toContain("blue-reserve");
    expect(visibleIds).toContain("red-screen");
    expect(visibleIds).not.toContain("red-deep-rear");

    const next = resolveFrozen({
      turnId: 1,
      seed: 99,
      scenario,
      start: published,
      orders: [
        {
          memberId: "commander-1",
          unitId: "blue-reserve",
          order: { kind: "move", pace: "march", path: [{ x: 430, y: 400 }] },
        },
      ],
    });
    const nextBattle = new BattleView(scenario, next.state, key, battle);
    const gmMarkers = nextBattle.markers({ id: "gm", name: "GM", role: "GM", factionId: null, epoch: 1 });
    expect(gmMarkers).toHaveLength(4);
    const moved = gmMarkers.find((m) => m.id === "blue-reserve");
    expect(moved?.at.x).toBeGreaterThan(390);
  });

  test("(b) projects 1,200 scene tokens across 120 commander seats (exceeding old 500-token cap) on a 1,000x1,000 square map", () => {
    const store = makeStore();
    const tokens: TokenDocument[] = [];
    // 600 Blue + 600 Red = 1,200 units (24,000 models) across 5,000 x 5,000 ft (1,000 x 1,000 grid squares)
    for (let i = 0; i < 600; i++) {
      const col = Math.floor(i / 30);
      const row = i % 30;
      tokens.push(
        makeCompanyToken(`tok-b-${i}`, `Blue Co ${i + 1}`, 1800 - col * 45, 500 + row * 120, "friendly", 20),
      );
      tokens.push(
        makeCompanyToken(`tok-r-${i}`, `Red Co ${i + 1}`, 3200 + col * 45, 500 + row * 120, "hostile", 20),
      );
    }
    const scene = makeStrategicScene(1000, 1000, tokens);
    const t0 = performance.now();
    const scenario = sceneDeployment(store, scene, 12345, 120, 20);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(500);
    expect(scenario.bounds).toEqual({ minX: 0, minY: 0, maxX: 5000, maxY: 5000 });
    expect(scenario.commanders).toHaveLength(120);
    const totalUnits = scenario.commanders.reduce((sum, c) => sum + c.units.length, 0);
    expect(totalUnits).toBe(1200);
    expect(scenario.commanders.every((c) => c.units.length === 10)).toBe(true);

    const state = deploy(scenario);
    const view = new BattleView(scenario, state, new Uint8Array(32).fill(3));
    const gm = { id: "gm", name: "GM", role: "GM" as const, factionId: null, epoch: 1 };
    expect(view.markers(gm)).toHaveLength(1200);
    expect(view.packedMarkers(gm).byteLength).toBeLessThan(128 * 1024);
  });

  test("(c) validates stitched backgroundTiles + backgroundAssets and keeps projection digest stable across key order", () => {
    const store = makeStore();
    const scene = makeStrategicScene(800, 800, [
      makeCompanyToken("b1", "Blue 1", 1500, 2000, "friendly", 25),
      makeCompanyToken("r1", "Red 1", 2500, 2000, "hostile", 25),
    ]);
    const base = sceneDeployment(store, scene, 7, 2, 25);

    const makePanel = (byte: number): ScenarioBackground => {
      const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, byte]);
      const hash = createHash("sha256").update(raw).digest("hex");
      return {
        hash,
        mime: "image/png",
        size: raw.byteLength,
        width: 2048,
        height: 2048,
        data: raw.toString("base64url"),
      };
    };
    const p1 = makePanel(1);
    const p2 = makePanel(2);
    const p3 = makePanel(3);
    const p4 = makePanel(4);

    const stitched = withScenarioBackgroundTiles(
      base,
      [
        { hash: p1.hash, x: 0, y: 0, width: 2000, height: 2000 },
        { hash: p2.hash, x: 2000, y: 0, width: 2000, height: 2000 },
        { hash: p3.hash, x: 0, y: 2000, width: 2000, height: 2000 },
        { hash: p4.hash, x: 2000, y: 2000, width: 2000, height: 2000 },
      ],
      // Deliberately unsorted key insertion order (simulating PostgreSQL jsonb key reordering)
      { [p4.hash]: p4, [p1.hash]: p1, [p3.hash]: p3, [p2.hash]: p2 },
    );

    expect(stitched.backgroundTiles).toHaveLength(4);
    expect(Object.keys(stitched.backgroundAssets ?? {})).toHaveLength(4);

    // Re-parsing with reversed backgroundAssets key order must produce the exact same projection digest!
    const { projection, ...withoutProjection } = stitched;
    const reversedAssets = Object.fromEntries(
      Object.entries(stitched.backgroundAssets ?? {}).reverse(),
    );
    const reparsed = parseScenario({ ...withoutProjection, backgroundAssets: reversedAssets });
    expect(scenarioProjectionDigest(reparsed)).toBe(projection?.digest);

    // buildGmMedia excludes stitched panel hashes from GM standalone scene-media list
    const gmMedia = buildGmMedia(
      [
        { hash: p1.hash, data: new Uint8Array([1]), mime: "image/png" },
        { hash: "f".repeat(64), data: new Uint8Array([9, 9]), mime: "image/webp" },
      ],
      undefined,
      new Set([p1.hash, p2.hash, p3.hash, p4.hash]),
    );
    expect(gmMedia.map((m) => m.hash)).toEqual(["f".repeat(64)]);
  });
});
