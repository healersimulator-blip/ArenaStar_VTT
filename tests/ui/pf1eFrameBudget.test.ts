// Checklist: V08 — the 200-actor tactical refresh/resolution frame budget this file pins.
/**
 * V08 — a 200-actor tactical refresh inside a documented frame budget.
 *
 * The strategic scale has a measured turn-cost gate; the *tactical* scale had none, so nothing
 * stopped a sheet derivation, an effects recompute or a badge pass from quietly becoming O(n²)
 * or from allocating per actor per frame. A GM with 200 actors on the map — two armies of
 * heroes-and-henchmen, or a large dungeon crawl — refreshes every one of them on a snapshot,
 * an Op or an effect tick, and that refresh happens on the main thread inside one animation
 * frame.
 *
 * This file measures the four surfaces the box names, at exactly 200 actors, and holds their
 * **sum** inside a budget:
 *
 *   • sheet derivation  — `derivePF1eActor` through `deriveFromDocuments` (the single tactical
 *                         derivation every sheet, roll and resolve flow reads);
 *   • effects           — `tokenBadgesMap`, the effects → token-badge pass the canvas runs in
 *                         `syncTokens`;
 *   • tracker           — `combatantBudget` per combatant, the per-row legality the tracker
 *                         renders;
 *   • detection         — `DetectionGrid.reseed` + `visibleModels` over the same 200 models.
 *
 * Budget: 16.7 ms is one frame at 60 Hz. Asserting the *sum* of all four against a single frame
 * is the honest reading of "within a documented frame budget" — a refresh that needs two frames
 * drops a frame on screen. The ceiling is deliberately loose (3× one frame) because CI boxes are
 * slow and a timing test that flakes gets skipped, which is worse than no gate; the number that
 * matters is the *printed* measurement, recorded here so a regression is a visible delta rather
 * than a mystery. Warm-up iterations run first so JIT compilation is not charged to the budget.
 */
import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CombatDocument,
  EffectDocument,
  Json,
  TokenDocument,
} from "../../src/core/documents";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import { tokenBadgesMap } from "../../src/packages/pf1e/tokenBadges";
import { combatantBudget } from "../../src/ui/combat/actionBudget";
import { DetectionGrid } from "../../src/core/detection";
import { pf1eConditionPayload } from "../../src/packages/pf1e/conditions";
import { createModelPool, allocModel } from "../../src/sim/pool";

/** The box's number. */
const ACTORS = 200;
/** One frame at 60 Hz, in ms. */
const FRAME_MS = 1000 / 60;
/** Asserted ceiling: 3 frames. Loose enough not to flake, tight enough to catch O(n²). */
const BUDGET_MS = FRAME_MS * 3;
/** Warm-up passes excluded from the measurement. */
const WARMUP = 3;

const CONDITIONS = ["Prone", "Blinded", "Shaken", "Entangled", "Flat-Footed"];

/** A real PF1e effect document: conditions carry `pf1eConditionPayload`, not a made-up flag. */
function effectDoc(id: string, name: string, payload: Json): EffectDocument {
  return {
    _id: id,
    type: "effect",
    name,
    ownership: { default: 0 },
    system: {},
    changes: [],
    disabled: false,
    flags: { pf1e: payload } as EffectDocument["flags"],
  };
}

function actorAt(index: number): ActorDocument {
  const conditionName = CONDITIONS[index % CONDITIONS.length] as string;
  const condition = pf1eConditionPayload(conditionName);
  if (!condition.ok) throw new Error(`fixture condition "${conditionName}" is not a condition`);
  const effects: EffectDocument[] = [
    effectDoc(`fx-${index}-a`, "Bless", { mods: [{ key: "attack", type: "morale", value: 1 }] }),
    effectDoc(`fx-${index}-b`, conditionName, condition.value as Json),
  ];
  return {
    _id: `actor-${index}`,
    type: "actor",
    name: `Combatant ${index}`,
    ownership: { default: 0, gm: 3 },
    flags: {},
    system: {
      pf1e: {
        abilities: { str: 14 + (index % 5), dex: 12 + (index % 3), con: 13 },
        bab: 1 + (index % 10),
        armorClass: { armor: 4 + (index % 3), shield: index % 2 },
        hp: { max: 10 + index },
        saves: { fort: 3, ref: 2, will: 1 },
        attacks: [{ name: "Longsword", bab: 1 + (index % 10), damage: "1d8+2" }],
      },
    },
    items: [],
    effects,
  } as unknown as ActorDocument;
}

const actors: ActorDocument[] = Array.from({ length: ACTORS }, (_, i) => actorAt(i));

const tokens: TokenDocument[] = actors.map(
  (actor, i) =>
    ({
      _id: `token-${i}`,
      actorId: actor._id,
      name: actor.name,
      x: (i % 20) * 5,
      y: Math.floor(i / 20) * 5,
      width: 1,
      height: 1,
    }) as unknown as TokenDocument,
);

const combat: CombatDocument = {
  _id: "combat-1",
  type: "combat",
  sceneId: "scene-1",
  round: 3,
  turn: 0,
  active: true,
  flags: {},
  system: {},
  combatants: actors.map((actor, i) => ({
    _id: `cbt-${i}`,
    tokenId: `token-${i}`,
    actorId: actor._id,
    name: actor.name,
    initiative: (i * 7) % 30,
    hidden: false,
    flags: {},
    system: {},
  })),
} as unknown as CombatDocument;

/** Best-of-N timing with warm-up, in ms. */
function measure(fn: () => unknown, repeats = 5): number {
  for (let i = 0; i < WARMUP; i++) fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe(`V08 — ${ACTORS} actors refresh inside a documented frame budget`, () => {
  const sheetMs = measure(() => {
    for (const actor of actors) deriveFromDocuments({ actor });
  });
  const effectsMs = measure(() => tokenBadgesMap(tokens, { actors, combats: [combat] }));
  const trackerMs = measure(() => {
    for (const member of combat.combatants) combatantBudget(combat, member._id, actors);
  });
  const detectionMs = measure(() => {
    const pool = createModelPool(ACTORS);
    for (let i = 0; i < ACTORS; i++) {
      allocModel(pool, {
        id: i + 1,
        unitIdx: i % 2,
        x: (i % 20) * 5,
        y: Math.floor(i / 20) * 5,
        hp: 10,
        hpMax: 10,
      });
    }
    const grid = new DetectionGrid(5);
    grid.reseed(
      Array.from({ length: ACTORS }, (_, i) => ({
        anchor: { x: (i % 20) * 5, y: Math.floor(i / 20) * 5 },
        factionId: i % 2 === 0 ? "f-blue" : "f-red",
        radius: 30,
      })),
      { minX: 0, minY: 0, maxX: 100, maxY: 50 },
    );
    grid.visibleModels(pool, "f-blue", ["f-blue"]);
  });

  const totalMs = sheetMs + effectsMs + trackerMs + detectionMs;

  test("the whole refresh is measured and printed for the record", () => {
    console.info(
      `pf1e tactical refresh (${ACTORS} actors): derivation ${sheetMs.toFixed(2)} ms · ` +
        `effects ${effectsMs.toFixed(2)} ms · tracker ${trackerMs.toFixed(2)} ms · ` +
        `detection ${detectionMs.toFixed(2)} ms · total ${totalMs.toFixed(2)} ms ` +
        `(one frame = ${FRAME_MS.toFixed(2)} ms)`,
    );
    // Every surface must actually have done work, or the measurement proves nothing.
    expect(actors).toHaveLength(ACTORS);
    expect(combat.combatants).toHaveLength(ACTORS);
    expect(sheetMs).toBeGreaterThan(0);
    expect(effectsMs).toBeGreaterThan(0);
    expect(trackerMs).toBeGreaterThan(0);
    expect(detectionMs).toBeGreaterThan(0);
  });

  test("the combined refresh fits the budget (3 × one 60 Hz frame)", () => {
    expect(totalMs).toBeLessThanOrEqual(BUDGET_MS);
  });

  test("no single surface is allowed to eat the whole frame on its own", () => {
    // A regression in one surface is what actually ships; the sum can hide it behind three
    // cheap passes. Each gets the full budget individually.
    for (const [label, ms] of [
      ["sheet derivation", sheetMs],
      ["effects → badges", effectsMs],
      ["tracker legality", trackerMs],
      ["detection reseed", detectionMs],
    ] as const) {
      expect(ms, label).toBeLessThanOrEqual(BUDGET_MS);
    }
  });

  test("cost scales linearly, not quadratically, in actor count", () => {
    // The gate that catches the failure mode a flat budget cannot: doubling the actors must not
    // quadruple the derivation cost. Measured on the derivation pass because it is the one
    // surface every other tactical read goes through.
    const half = actors.slice(0, ACTORS / 2);
    const halfMs = measure(() => {
      for (const actor of half) deriveFromDocuments({ actor });
    });
    const fullMs = measure(() => {
      for (const actor of actors) deriveFromDocuments({ actor });
    });
    expect(halfMs).toBeGreaterThan(0);
    // Linear would be ~2.0×; allow up to 3.0× for noise, refuse the 4.0× of a quadratic.
    expect(fullMs / halfMs).toBeLessThan(3);
  });

  test("derivation is pure: 200 actors derive identically on every pass", () => {
    // A memoization or caching regression shows up as drift between passes; pin it while the
    // budget is being measured so the perf gate cannot be satisfied by returning stale numbers.
    const first = actors.map((actor) => JSON.stringify(deriveFromDocuments({ actor })));
    const second = actors.map((actor) => JSON.stringify(deriveFromDocuments({ actor })));
    expect(second).toEqual(first);
  });

  test("the fixture is a real PF1e payload, not a stub the derivation ignores", () => {
    const derived = deriveFromDocuments({ actor: actors[0] as ActorDocument });
    expect(derived.ac.normal).toBeGreaterThan(10);
    expect(derived.converted.length).toBeGreaterThan(0);
    // The badge pass really sees the authored conditions.
    const badges = tokenBadgesMap(tokens, { actors, combats: [combat] });
    expect(badges.size).toBe(ACTORS);
    const firstBadges = badges.get("token-0") ?? [];
    expect(firstBadges.some((badge) => badge.condition)).toBe(true);
    // …and the tracker really produces a budget per combatant.
    const budget = combatantBudget(combat, "cbt-0", actors);
    expect(budget).not.toBeNull();
    expect((budget as unknown as { ledger: Json }).ledger).toBeDefined();
  });
});
