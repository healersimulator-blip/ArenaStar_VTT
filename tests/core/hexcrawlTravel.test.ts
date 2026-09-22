/**
 * D-269 (plan §4, §8 gate) — travel on the world clock, with a fake host.
 *
 * This is the gate the plan named: **advance three 14 400-round travel days and assert the op
 * stream**. It is written as a loop because the interesting property is not one day's arithmetic
 * but the composition — a party that marches for three days must arrive exactly where the terrain
 * says it should, must be *somewhere sensible* at the end of every day, and must produce the
 * border-crossing events an encounter engine can act on, in order, with clock readings that agree
 * with `advanceWorldClockOps`.
 */
import { describe, expect, test } from "vitest";
import type {
  CellDocument,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import {
  DAY_SECONDS,
  ROUNDS_PER_DAY,
  SECONDS_PER_ROUND,
} from "../../src/core/clock";
import {
  advanceWorldClockOps,
  readWorldClock,
} from "../../src/packages/pf1e/worldClock";
import {
  PF1E_TERRAIN_CATALOG,
  ROAD_COST,
} from "../../src/core/hexcrawl/terrain";
import {
  MAX_TRAVEL_DAYS_PER_ADVANCE,
  MAX_TRAVEL_EVENTS,
  partyCellOf,
  partyPositionOps,
  partyTokenOf,
  routePointsOf,
  routeSeconds,
  stepCostOf,
  stepSecondsOf,
  travelAdvance,
  travelProgressOps,
} from "../../src/core/hexcrawl/travel";
import { cellAtPoint, cellKeyOf } from "../../src/core/hexcrawl/cells";
import { triggersForStep } from "../../src/core/hexcrawl/encounter";
import {
  hexcrawlProfileOf,
  type TravelPlan,
} from "../../src/core/hexcrawl/types";

// ─── the fake host ───────────────────────────────────────────────────────────

const settingsDoc = (clockSeconds: number) => ({
  _id: "world-settings",
  type: "settings",
  name: "World Settings",
  ownership: { default: 0 },
  flags: {},
  system: { clockSeconds, secondsPerRound: SECONDS_PER_ROUND },
});

/** A document store small enough to read in one screen: settings docs and one scene. */
class FakeHost {
  clockSeconds = 0;
  sceneOps: Op[] = [];
  /** Every chat/whisper op a later slice would submit (the encounter cards). */
  chatOps: Op[] = [];

  constructor(public scene: SceneDocument) {}

  /** One day of world time, through the real clock op builder. */
  advanceDay(): number {
    const before = this.clockSeconds;
    const ops = advanceWorldClockOps(
      [settingsDoc(this.clockSeconds)],
      DAY_SECONDS,
    );
    expect(ops).toHaveLength(1);
    this.applySettings(ops[0] as Op);
    expect(this.clockSeconds).toBe(before + DAY_SECONDS);
    return this.clockSeconds - before;
  }

  /** Advance by any number of rounds through the clock, exactly as the Settings button does. */
  advanceRounds(rounds: number): void {
    const ops = advanceWorldClockOps(
      [settingsDoc(this.clockSeconds)],
      rounds * SECONDS_PER_ROUND,
    );
    this.applySettings(ops[0] as Op);
  }

  private applySettings(op: Op): unknown {
    // The clock op writes the settings document's `system` bag (worldSettingsOps' whole-object
    // update); reading it back is all this fake host needs to do to advance.
    const diff = op.kind === "update" ? op.diff : {};
    // A FlatDiff, not a nested object (D-012): worldSettingsOps writes `system.clockSeconds`.
    const clock = (diff as Record<string, unknown>)["system.clockSeconds"];
    if (typeof clock === "number") this.clockSeconds = clock;
    return settingsDoc(this.clockSeconds);
  }

  /** Apply the travel slice's own ops to the scene (the host validates; the test trusts). */
  applySceneOps(ops: Op[]): void {
    for (const op of ops) {
      if (op.kind !== "update") continue;
      if (op.ref.coll === "scenes") {
        const diff = op.diff as { flags?: unknown };
        if (diff.flags !== undefined)
          this.scene = { ...this.scene, flags: diff.flags as never };
        continue;
      }
      if (op.ref.coll === "tokens") {
        const at = this.scene.tokens.findIndex((t) => t._id === op.ref.id);
        if (at < 0) continue;
        const tokens = [...this.scene.tokens];
        tokens[at] = {
          ...tokens[at],
          ...(op.diff as Partial<TokenDocument>),
        } as TokenDocument;
        this.scene = { ...this.scene, tokens };
      }
    }
    this.sceneOps.push(...ops);
  }

  plan(): TravelPlan | null {
    return hexcrawlProfileOf(this.scene)?.travel ?? null;
  }
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const cell = (key: string, terrain: string | undefined): CellDocument => ({
  _id: `cell-${key.replace(",", "-")}`,
  type: "cell",
  name: key,
  ownership: { default: 0 },
  flags: {},
  system: {},
  key,
  ...(terrain ? { terrain } : {}),
});

const token = (id: string, x: number, y: number): TokenDocument => ({
  _id: id,
  type: "token",
  name: "Party",
  ownership: { default: 2 },
  flags: {},
  system: {},
  x,
  y,
  rotation: 0,
  // Pixels, not cells: `TokenDocument` stores the token's centre in x/y and its pixel size here.
  width: 40,
  height: 40,
  img: "",
  hidden: false,
  disposition: "friendly",
  vision: false,
  light: { radius: 0, color: "#ffffff", alpha: 0.5 },
});

function mapScene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Overland",
    ownership: { default: 0 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 2000,
    height: 2000,
    darkness: 0,
    grid: {
      type: "hex",
      size: 40,
      distance: 1,
      units: "mi",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [token("party", 0, 0)],
    walls: [],
    cells: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    ...over,
  };
}

/** A scene whose hexes have terrain, plus a party and a route through them. */
function marchScene(
  route: string[],
  terrains: Record<string, string>,
  speedPerDay = 24,
): FakeHost {
  const cells = Object.entries(terrains).map(([key, terrain]) =>
    cell(key, terrain),
  );
  const scene = mapScene({ cells });
  const host = new FakeHost(scene);
  const profile = {
    version: 1 as const,
    revealed: [],
    sight: { mode: "gm" as const, radiusCells: 0, radiusWorldUnits: 0 },
    partyTokenId: "party",
    encounterMode: "prompt" as const,
    daylight: { dawnHour: 6, duskHour: 18 },
    terrain: "pf1e-overland",
    travel: {
      path: route,
      cursor: 0,
      progressSeconds: 0,
      speedPerDay,
      pace: "normal" as const,
    },
  };
  host.scene = { ...host.scene, flags: { core: { hexcrawl: profile } } };
  return host;
}

const ROUTE = ["0,0", "1,0", "2,0", "3,0", "4,0"];

/** The hexcrawl flag an update op carries (the op union has no `diff` on a delete). */
function profileFromOps(ops: readonly Op[]): Record<string, unknown> {
  const op = ops[0];
  if (!op || op.kind !== "update") throw new Error("expected one update op");
  const flags = (op.diff as { flags?: { core?: Record<string, unknown> } })
    .flags;
  return (flags?.core?.["hexcrawl"] as Record<string, unknown>) ?? {};
}

describe("one day, one map", () => {
  test("a day is 14 400 rounds of six seconds — the ladder the whole feature is priced in", () => {
    const host = marchScene(ROUTE, { "0,0": "plains", "1,0": "plains" });
    expect(ROUNDS_PER_DAY * SECONDS_PER_ROUND).toBe(DAY_SECONDS);
    host.advanceDay();
    expect(host.clockSeconds).toBe(86_400);
    expect(readWorldClock([settingsDoc(host.clockSeconds)])).toBe(86_400);
  });

  test("plains cost an hour a hex; the day is 24 hexes", () => {
    const host = marchScene(
      ROUTE,
      Object.fromEntries(ROUTE.map((k) => [k, "plains"])),
    );
    expect(
      stepSecondsOf(
        host.scene,
        PF1E_TERRAIN_CATALOG,
        "0,0",
        "1,0",
        24,
        "normal",
      ),
    ).toBe(3_600);
  });

  test("terrain prices the same route differently, and the road rule beats the worse side", () => {
    const host = marchScene(ROUTE, {
      "0,0": "mountains",
      "1,0": "road",
      "2,0": "mountains",
    });
    expect(stepCostOf(PF1E_TERRAIN_CATALOG, "mountains", "mountains")).toBe(3);
    expect(stepCostOf(PF1E_TERRAIN_CATALOG, "mountains", "road")).toBe(
      ROAD_COST,
    );
    expect(stepCostOf(PF1E_TERRAIN_CATALOG, "road", "mountains")).toBe(
      ROAD_COST,
    );
    expect(
      stepSecondsOf(
        host.scene,
        PF1E_TERRAIN_CATALOG,
        "0,0",
        "1,0",
        24,
        "normal",
      ),
    ).toBe(3_600);
    expect(
      stepSecondsOf(
        host.scene,
        PF1E_TERRAIN_CATALOG,
        "1,0",
        "2,0",
        24,
        "normal",
      ),
    ).toBe(3_600);
    expect(
      stepSecondsOf(
        host.scene,
        PF1E_TERRAIN_CATALOG,
        "2,0",
        "3,0",
        24,
        "normal",
      ),
    ).toBe(10_800);
  });
});

describe("three days of marching", () => {
  test("a party on plains covers three days of ground, in order, and arrives", () => {
    // 24 plains hexes a day: a 72-hex route is exactly three days. Build one.
    const route: string[] = [];
    for (let q = 0; q <= 72; q++) route.push(`${q},0`);
    const terrains = Object.fromEntries(route.map((k) => [k, "plains"]));
    const host = marchScene(route, terrains);
    const events: Array<{ cellKey: string; at: number }> = [];
    let day = 0;

    for (let d = 1; d <= 3; d++) {
      day = d;
      const elapsed = host.advanceDay();
      const plan = host.plan();
      expect(plan).not.toBeNull();
      const advance = travelAdvance({
        scene: host.scene,
        plan: plan as TravelPlan,
        elapsedSeconds: elapsed,
        catalog: PF1E_TERRAIN_CATALOG,
        startClock: host.clockSeconds - elapsed,
      });
      for (const step of advance.steps) {
        events.push({ cellKey: step.cellKey, at: step.arrivedAtClock });
        expect(step.triggers).toEqual(
          triggersForStep(step.fromKey, step.cellKey),
        );
        // The token is put at the cell's centre as it is entered.
        const ops = partyPositionOps(host.scene, "party", { x: 0, y: 0 });
        expect(ops).toHaveLength(1);
      }
      host.applySceneOps(travelProgressOps(host.scene, advance.plan));
      const party = partyTokenOf(host.scene);
      expect(party).not.toBeNull();
      if (advance.arrived) break;
    }

    expect(day).toBe(3);
    expect(events).toHaveLength(72); // one border crossing per hex after the first
    expect(events[0]).toEqual({ cellKey: "1,0", at: 3_600 });
    expect(events[23]).toEqual({ cellKey: "24,0", at: 86_400 });
    expect(events[47]).toEqual({ cellKey: "48,0", at: 2 * 86_400 });
    expect(events[71]).toEqual({ cellKey: "72,0", at: 3 * 86_400 });
    // The route is finished, so the profile's travel is cleared and the map stops drawing it.
    expect(host.plan()).toBeNull();
    // …and every step's clock reading is monotonic, which is what the encounter ledger reads.
    for (let i = 1; i < events.length; i++) {
      expect((events[i]?.at ?? 0) > (events[i - 1]?.at ?? 0)).toBe(true);
    }
  });

  test("mountains halve the ground covered, and the itinerary says so up front", () => {
    const route = ["0,0", "1,0", "2,0", "3,0"];
    const host = marchScene(
      route,
      Object.fromEntries(route.map((k) => [k, "mountains"])),
    );
    // Three mountain crossings at 3 h each = 9 h — the GM reads this before committing.
    expect(
      routeSeconds({
        scene: host.scene,
        path: route,
        speedPerDay: 24,
        pace: "normal",
        catalog: PF1E_TERRAIN_CATALOG,
      }),
    ).toBe(3 * 10_800);

    const advance = travelAdvance({
      scene: host.scene,
      plan: host.plan() as TravelPlan,
      elapsedSeconds: DAY_SECONDS,
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 0,
    });
    expect(advance.steps).toHaveLength(3);
    expect(advance.arrived).toBe(true);
    expect(advance.plan).toBeNull();
    // A day is enough for eight mountain hexes, so a three-hex route finishes with time to spare.
    expect(advance.leftoverSeconds).toBe(DAY_SECONDS - 3 * 10_800);
  });

  test("a step that does not finish leaves the party mid-hex, and the plan remembers", () => {
    const route = ["0,0", "1,0"];
    const host = marchScene(route, { "0,0": "mountains", "1,0": "mountains" });
    const half = travelAdvance({
      scene: host.scene,
      plan: host.plan() as TravelPlan,
      elapsedSeconds: 5_400, // half of the 10 800 s crossing
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 0,
    });
    expect(half.steps).toEqual([]);
    expect(half.arrived).toBe(false);
    expect(half.plan?.progressSeconds).toBe(5_400);
    expect(half.plan?.cursor).toBe(0);
    // The next advance picks up where it stopped: 5 400 more seconds finish the step.
    const rest = travelAdvance({
      scene: host.scene,
      plan: half.plan as TravelPlan,
      elapsedSeconds: 5_400,
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 5_400,
    });
    expect(rest.steps).toHaveLength(1);
    expect(rest.steps[0]?.cellKey).toBe("1,0");
    // The party left the first cell at the start of the route (0 s), not when this advance
    // resumed — the step's own duration is what places the departure.
    expect(rest.steps[0]?.departedAtClock).toBe(0);
    expect(rest.steps[0]?.arrivedAtClock).toBe(10_800);
    expect(rest.arrived).toBe(true);
  });

  test("three days on a mountain route is still three days — the clock, not the map, decides", () => {
    // A long mountain march: a mountain crossing is 3 h, so exactly 8 fit in a 24-hour day and
    // the route (30 hexes) is longer than the march.
    const route: string[] = [];
    for (let q = 0; q <= 30; q++) route.push(`${q},0`);
    const host = marchScene(
      route,
      Object.fromEntries(route.map((k) => [k, "mountains"])),
    );
    let crossings = 0;
    let clock = 0;
    for (let day = 0; day < 3; day++) {
      const elapsed = host.advanceDay();
      const advance = travelAdvance({
        scene: host.scene,
        plan: host.plan() as TravelPlan,
        elapsedSeconds: elapsed,
        catalog: PF1E_TERRAIN_CATALOG,
        startClock: clock,
      });
      clock += elapsed;
      crossings += advance.steps.length;
      host.applySceneOps(travelProgressOps(host.scene, advance.plan));
    }
    expect(clock).toBe(3 * DAY_SECONDS);
    expect(crossings).toBe(24); // 8 crossings × 3 days — the clock's arithmetic, not the map's
    expect(host.plan()).not.toBeNull(); // the route is longer than the march
  });
});

describe("where the time went (D-275)", () => {
  test("a full day across forest charges every cell the party walked through", () => {
    // Forest costs 2 on the stock table, so a border is 7 200 s at speed 24 (plan §5.5): twelve
    // crossings fill a day exactly, and the route that names them charges twelve cells.
    const route: string[] = [];
    for (let q = 0; q <= 12; q++) route.push(`${q},0`);
    const host = marchScene(route, Object.fromEntries(route.map((k) => [k, "forest"])));
    host.advanceDay();
    const plan = host.plan();
    expect(plan).not.toBeNull();
    if (!plan) return;
    const advance = travelAdvance({
      scene: host.scene,
      plan,
      elapsedSeconds: DAY_SECONDS,
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 0,
    });
    expect(advance.arrived).toBe(true);
    expect(advance.spentSeconds["0,0"]).toBe(7_200);
    expect(advance.spentSeconds["11,0"]).toBe(7_200);
    // The destination hex is charged nothing of its own crossing — the party arrived and stopped.
    expect(advance.spentSeconds["12,0"]).toBeUndefined();
    const sum = Object.values(advance.spentSeconds).reduce((a, b) => a + b, 0);
    expect(sum).toBe(DAY_SECONDS);
  });

  test("a mid-crossing stop charges the cell the party is still standing in", () => {
    const host = marchScene(ROUTE, { "0,0": "forest", "1,0": "forest" });
    const plan = host.plan();
    expect(plan).not.toBeNull();
    if (!plan) return;
    // An hour into a two-hour forest crossing: still in `0,0`, and that is where the hour went.
    const advance = travelAdvance({
      scene: host.scene,
      plan,
      elapsedSeconds: 3_600,
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 0,
    });
    expect(advance.cellKey).toBe("0,0");
    expect(advance.steps).toEqual([]);
    expect(advance.spentSeconds).toEqual({ "0,0": 3_600 });
  });

  test("time left over at the end of the route is spent standing at the destination", () => {
    const host = marchScene(["0,0", "1,0"], { "0,0": "plains", "1,0": "plains" });
    const plan = host.plan();
    expect(plan).not.toBeNull();
    if (!plan) return;
    const advance = travelAdvance({
      scene: host.scene,
      plan,
      elapsedSeconds: 3_600 + 600, // one plains crossing, then ten minutes of standing about
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 0,
    });
    expect(advance.arrived).toBe(true);
    expect(advance.plan).toBeNull();
    expect(advance.leftoverSeconds).toBe(600);
    expect(advance.spentSeconds).toEqual({ "0,0": 3_600, "1,0": 600 });
    expect(Object.values(advance.spentSeconds).reduce((a, b) => a + b, 0)).toBe(4_200);
  });

  test("no route, no ledger — an empty map, not a zeroed one", () => {
    const host = marchScene(ROUTE, { "0,0": "plains" });
    const advance = travelAdvance({
      scene: host.scene,
      plan: null,
      elapsedSeconds: DAY_SECONDS,
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 0,
    });
    expect(advance.spentSeconds).toEqual({});
    expect(advance.leftoverSeconds).toBe(DAY_SECONDS);
  });

  test("the ledger sums to the elapsed time on every day of a three-day march", () => {
    // Mixed terrain, so the sums are not trivially one number per day: a forest hex beside a plains
    // hex costs the forest's two hours, and the ledger still has to account for every second.
    const route: string[] = [];
    for (let q = 0; q <= 72; q++) route.push(`${q},0`);
    const host = marchScene(
      route,
      Object.fromEntries(
        route.map((k, i) => [k, i % 3 === 0 ? "forest" : "plains"] as const),
      ),
    );
    for (let day = 0; day < 3; day++) {
      host.advanceDay();
      const plan = host.plan();
      if (!plan) break;
      const advance = travelAdvance({
        scene: host.scene,
        plan,
        elapsedSeconds: DAY_SECONDS,
        catalog: PF1E_TERRAIN_CATALOG,
        startClock: 0,
      });
      const sum = Object.values(advance.spentSeconds).reduce((a, b) => a + b, 0);
      expect(sum).toBe(DAY_SECONDS);
      // Every cell charged is a cell the route names, and every charge is positive — a zero-value key
      // would be a ledger entry for a border the party never touched.
      for (const [key, seconds] of Object.entries(advance.spentSeconds)) {
        expect(route).toContain(key);
        expect(seconds).toBeGreaterThan(0);
      }
      host.applySceneOps(travelProgressOps(host.scene, advance.plan));
    }
  });
});

describe("the route as a line (D-275)", () => {
  test("it answers one point per key, in order, and drops the keys a scene cannot place", () => {
    const host = marchScene(ROUTE, { "0,0": "plains", "1,0": "plains" });
    const points = routePointsOf(host.scene, ROUTE);
    expect(points.map((p) => p.key)).toEqual(ROUTE);
    // The first cell's centre is the grid's own first centre, so the line starts where the party is
    // standing (the fixture's token sits at 0,0 on a 40 px hex grid — the centre of hex `0,0`).
    expect(points[0]).toMatchObject({ key: "0,0", x: 0, y: 0 });
    expect(routePointsOf(host.scene, [])).toEqual([]);
    // A key with no place on the map is a gap, not a guess: on a gridless map a cell is a drawn
    // zone, and one that has no polygon yet has no centre either (D-270's zone half).
    const gridless = mapScene({
      grid: {
        type: "gridless",
        size: 0,
        distance: 0,
        units: "mi",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      cells: [
        { ...cell("w1", "plains"), poly: [100, 100, 300, 100, 300, 300, 100, 300] },
        cell("w2", "plains"),
      ],
    });
    expect(routePointsOf(gridless, ["w1", "w2", "w3"]).map((p) => p.key)).toEqual(["w1"]);
    expect(routePointsOf(gridless, ["w1"])[0]).toMatchObject({ x: 200, y: 200 });
  });
});

describe("caps and edges", () => {
  test("a single advance cannot outrun thirty days, and a huge path cannot flood events", () => {
    const route = ["0,0", "1,0", "2,0"];
    const host = marchScene(route, {
      "0,0": "plains",
      "1,0": "plains",
      "2,0": "plains",
    });
    const absurd = travelAdvance({
      scene: host.scene,
      plan: host.plan() as TravelPlan,
      elapsedSeconds: 10_000 * DAY_SECONDS,
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 0,
    });
    // The route finishes long before the cap matters — the cap is about the *walk*, so the
    // leftover seconds are reported rather than silently dropped.
    expect(absurd.arrived).toBe(true);
    expect(absurd.leftoverSeconds).toBeGreaterThan(0);
    expect(MAX_TRAVEL_EVENTS).toBe(512);
    expect(MAX_TRAVEL_DAYS_PER_ADVANCE).toBe(30);
  });

  test("negative and zero elapsed time change nothing", () => {
    const host = marchScene(ROUTE, {});
    const plan = host.plan() as TravelPlan;
    for (const elapsed of [0, -5_000]) {
      const advance = travelAdvance({
        scene: host.scene,
        plan,
        elapsedSeconds: elapsed,
        catalog: PF1E_TERRAIN_CATALOG,
        startClock: 1_000,
      });
      expect(advance.steps).toEqual([]);
      expect(advance.plan?.cursor).toBe(0);
      expect(advance.plan?.progressSeconds).toBe(0);
      expect(advance.arrived).toBe(false);
    }
  });

  test("a one-cell route is not a route, and a party token's cell comes from its position", () => {
    // A "path" of one cell is the party standing still: `readTravelPlan` normalizes it away, and
    // the engine answers with the party waiting rather than with a march of zero steps.
    const host = marchScene(["0,0"], { "0,0": "plains" });
    expect(host.plan()).toBeNull();
    const advance = travelAdvance({
      scene: host.scene,
      plan: null,
      elapsedSeconds: DAY_SECONDS,
      catalog: PF1E_TERRAIN_CATALOG,
      startClock: 0,
    });
    expect(advance.steps).toEqual([]);
    expect(advance.arrived).toBe(false);
    expect(advance.cellKey).toBeNull();
    expect(advance.plan).toBeNull();
    expect(advance.leftoverSeconds).toBe(DAY_SECONDS);

    expect(partyTokenOf(host.scene)?._id).toBe("party");
    // The token's x/y are its top-left corner; a 1×1 token at the origin sits in hex 0,0.
    expect(
      partyCellOf(host.scene, (x, y) => cellAtPoint(host.scene, x, y)),
    ).toBe(cellKeyOf({ q: 0, r: 0 }));
    // A profile naming a token that no longer exists degrades to "no party".
    const gone = { ...host.scene, tokens: [] };
    expect(partyTokenOf(gone)).toBeNull();
    expect(partyCellOf(gone, () => "0,0")).toBeNull();
  });

  test("position ops centre the token on the cell", () => {
    const host = marchScene(ROUTE, {});
    const ops = partyPositionOps(host.scene, "party", { x: 500, y: 300 });
    expect(ops).toEqual([
      {
        kind: "update",
        ref: {
          coll: "tokens",
          id: "party",
          parent: { coll: "scenes", id: "scene-1" },
        },
        // Both sides are centres, so standing on a cell is setting the token's x/y to it.
        diff: { x: 500, y: 300 },
      },
    ]);
    expect(partyPositionOps(host.scene, "nobody", { x: 0, y: 0 })).toEqual([]);
  });

  test("progress ops write the profile back whole (and clear a finished route)", () => {
    const host = marchScene(ROUTE, { "0,0": "forest" });
    host.scene = {
      ...host.scene,
      flags: {
        core: {
          hexcrawl: {
            ...(hexcrawlProfileOf(host.scene) as object),
            revealed: ["0,0"],
          },
        },
      },
    };
    const ops = travelProgressOps(host.scene, {
      path: ROUTE,
      cursor: 2,
      progressSeconds: 700,
      speedPerDay: 30,
      pace: "forced",
    });
    expect(ops).toHaveLength(1);
    const profile = profileFromOps(ops);
    expect(profile["revealed"]).toEqual(["0,0"]);
    expect(profile["terrain"]).toBe("pf1e-overland");
    expect(profile["travel"]).toEqual({
      path: ROUTE,
      cursor: 2,
      progressSeconds: 700,
      speedPerDay: 30,
      pace: "forced",
    });
    const cleared = travelProgressOps(host.scene, null);
    expect(profileFromOps(cleared)["travel"]).toBeNull();
    // A scene that is not a hexcrawl scene produces no ops at all.
    expect(travelProgressOps(host.scene, null)).not.toHaveLength(0);
    expect(travelProgressOps(mapScene(), null)).toEqual([]);
  });
});
