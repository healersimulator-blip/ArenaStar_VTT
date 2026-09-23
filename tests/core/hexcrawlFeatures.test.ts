/**
 * D-275 (plan §3.5, requirement 8) — **the rule that reveals a hidden feature**, as a contract.
 *
 * The four kinds are the requirement's own list (`manual`, `perception`, `time`, `dice`), and the
 * interesting parts are the ones a browser cannot show you: that a reveal only happens when the
 * rule says so, that `autoReveal: false` turns a rule into a note, that the time counter and the
 * reveal are written **together**, and that a formula this engine cannot roll reports itself
 * instead of throwing in the middle of a march.
 */
import { describe, expect, test } from "vitest";
import type { CellDocument, CellFeature, SceneDocument } from "../../src/core/documents";
import {
  addExploredTimeOps,
  evaluateFeature,
  exploredSecondsOf,
  featureRuleLabel,
  formatDuration,
  revealDueFeatures,
  type FeatureFacts,
} from "../../src/core/hexcrawl/features";

function feature(over: Partial<CellFeature> = {}): CellFeature {
  return {
    id: "f1",
    name: "The old shrine",
    text: "A moss-covered stone.",
    reveal: { kind: "manual" },
    autoReveal: true,
    state: { revealed: false },
    ...over,
  };
}

function cell(over: Partial<CellDocument> = {}): CellDocument {
  return {
    _id: "cell-1",
    type: "cell",
    key: "3,4",
    name: "3,4",
    flags: {},
    system: {},
    ...over,
  } as CellDocument;
}

function scene(cells: CellDocument[]): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Overland",
    active: true,
    img: null,
    ownership: { default: 2 },
    width: 1600,
    height: 1200,
    grid: { type: "hex", size: 100, distance: 6, units: "mi", diagonals: "555", hexLayout: "oddQ" },
    darkness: 0,
    tokens: [],
    walls: [],
    cells,
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    flags: {},
    system: {},
  };
}

const facts = (over: Partial<FeatureFacts> = {}): FeatureFacts => ({
  clockSeconds: 3_600,
  passivePerception: 12,
  perceptionModifier: 4,
  rng: () => 0.5,
  ...over,
});

describe("the rule matrix", () => {
  test("a manual feature never reveals itself, whatever the facts say", () => {
    const verdict = evaluateFeature(feature(), facts(), 100_000);
    expect(verdict.reveal).toBe(false);
    expect(verdict.note).toBe("");
  });

  test("time: the counter has to reach the requirement, and the note says both sides", () => {
    const shrine = feature({ reveal: { kind: "time", seconds: 7_200 } });
    expect(evaluateFeature(shrine, facts(), 7_199).reveal).toBe(false);
    // The note reads in the same units as the rule (`formatDuration` drops the seconds once
    // there is a minute or an hour to report).
    expect(evaluateFeature(shrine, facts(), 7_199).note).toBe("The old shrine: 1 h 59 m here vs 2 h");
    expect(evaluateFeature(shrine, facts(), 7_200).reveal).toBe(true);
    // More time than it needs is still a reveal; the note reads as the GM would say it.
    const verdict = evaluateFeature(shrine, facts(), 10_800);
    expect(verdict.reveal).toBe(true);
    expect(verdict.note).toBe("The old shrine: 3 h here vs 2 h");
  });

  test("passive Perception compares 10 + the modifier, and does not roll", () => {
    const shrine = feature({ reveal: { kind: "perception", dc: 15 } });
    // passive 12 < 15, whatever the rng would have said.
    expect(evaluateFeature(shrine, facts({ passivePerception: 12 }), 0).reveal).toBe(false);
    expect(evaluateFeature(shrine, facts({ passivePerception: 15 }), 0).reveal).toBe(true);
  });

  test("an active Perception feature rolls 1d20 + the party's modifier", () => {
    const shrine = feature({
      reveal: { kind: "perception", dc: 15, active: true },
    });
    // rng 0.5 → 1d20 = 11, +4 = 15: exactly the DC (a check meets its DC in PF1e).
    expect(evaluateFeature(shrine, facts({ rng: () => 0.5 }), 0).reveal).toBe(true);
    // rng 0 → 1d20 = 1, +4 = 5: a miss, and the note says the number.
    const miss = evaluateFeature(shrine, facts({ rng: () => 0 }), 0);
    expect(miss.reveal).toBe(false);
    expect(miss.note).toBe("The old shrine: Perception 5 vs 15");
  });

  test("dice: the formula decides, and an unreadable one says so without throwing", () => {
    const cache = feature({ reveal: { kind: "dice", formula: "1d20", target: 15 } });
    expect(evaluateFeature(cache, facts({ rng: () => 0.5 }), 0).reveal).toBe(false); // 11 < 15
    expect(evaluateFeature(cache, facts({ rng: () => 0.7 }), 0).reveal).toBe(true); // 15 ≥ 15
    const broken = feature({ reveal: { kind: "dice", formula: "not a formula", target: 15 } });
    const verdict = evaluateFeature(broken, facts(), 0);
    expect(verdict.reveal).toBe(false);
    expect(verdict.note).toContain("is not a formula this engine can roll");
  });

  test("a revealed feature stays revealed: nothing here hides anything again", () => {
    const found = feature({ state: { revealed: true, atClock: 42 } });
    expect(evaluateFeature(found, facts(), 999_999)).toEqual({ reveal: false, note: "" });
  });
});

describe("the time counter", () => {
  test("it accumulates, and a zero or negative advance writes nothing", () => {
    const sceneDoc = scene([cell({ flags: { core: { exploredSeconds: 3_600 } } })]);
    const [op] = addExploredTimeOps(sceneDoc, "3,4", 1_800, 5_400);
    const flags = (op as unknown as { diff: { flags: Record<string, unknown> } }).diff.flags;
    const core = flags["core"] as Record<string, unknown>;
    expect(core["exploredSeconds"]).toBe(5_400);
    expect(core["exploredAtClock"]).toBe(5_400);
    expect(addExploredTimeOps(sceneDoc, "3,4", 0)).toEqual([]);
    expect(addExploredTimeOps(sceneDoc, "3,4", -60)).toEqual([]);
  });

  test("a march authors the hex it slept in, rather than dropping the hours", () => {
    // The ledger is a fact about where the party *stood*, not about what the GM painted: a hex
    // nobody authored still owes the party its hours when the GM opens it later (the `time` rule
    // reads this counter). The create carries the flag with it — one op, not two.
    const [op] = addExploredTimeOps(scene([]), "9,9", 600, 1_200);
    expect(op?.kind).toBe("create");
    const data = (op as unknown as { data: CellDocument }).data;
    expect(data.key).toBe("9,9");
    expect(data.name).toBe("9,9"); // `create` needs a name; the key is the name a GM would give it
    expect(exploredSecondsOf(data)).toBe(600);
    const core = (data.flags ?? {})["core"] as Record<string, unknown>;
    expect(core["exploredAtClock"]).toBe(1_200);
    // …and an authored hex is still an *update*, carrying the flag forward.
    const [patched] = addExploredTimeOps(
      scene([cell({ flags: { core: { exploredSeconds: 3_600 } } })]),
      "3,4",
      600,
    );
    expect(patched?.kind).toBe("update");
  });

  test("an unauthored hex is walked over: the time is written, no rule is judged", () => {
    const facts: FeatureFacts = { clockSeconds: 0, passivePerception: 10, perceptionModifier: 0, rng: () => 0 };
    const result = revealDueFeatures({
      scene: scene([]),
      cellKey: "9,9",
      facts,
      spentSeconds: 7_200,
    });
    expect(result.revealed).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]?.kind).toBe("create");
    expect(
      exploredSecondsOf((result.ops[0] as unknown as { data: CellDocument }).data),
    ).toBe(7_200);
    // A zero-second pass over an unauthored hex writes nothing at all.
    expect(revealDueFeatures({ scene: scene([]), cellKey: "9,9", facts, spentSeconds: 0 }).ops).toEqual([]);
  });

  test("the reader is total: absent, junk and negative all read as zero", () => {
    expect(exploredSecondsOf(cell())).toBe(0);
    expect(exploredSecondsOf(cell({ flags: { core: { exploredSeconds: "soon" } } }))).toBe(0);
    expect(exploredSecondsOf(cell({ flags: { core: { exploredSeconds: -5 } } }))).toBe(0);
    expect(exploredSecondsOf(cell({ flags: { core: { exploredSeconds: 42.9 } } }))).toBe(42);
    expect(exploredSecondsOf(null)).toBe(0);
  });

  test("durations read in the GM's units", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(600)).toBe("10 m");
    expect(formatDuration(3_600)).toBe("1 h");
    expect(formatDuration(5_400)).toBe("1 h 30 m");
    expect(formatDuration(86_400)).toBe("24 h");
  });
});

describe("what the party's presence earns", () => {
  test("a march through a hex reveals the timed feature it was waiting for, and charges the time", () => {
    const sceneDoc = scene([
      cell({ features: [feature({ reveal: { kind: "time", seconds: 7_200 } })] }),
    ]);
    const result = revealDueFeatures({
      scene: sceneDoc,
      cellKey: "3,4",
      facts: facts({ clockSeconds: 7_200 }),
      spentSeconds: 7_200,
    });
    expect(result.revealed.map((f) => f.id)).toEqual(["f1"]);
    expect(result.notes).toEqual(["The old shrine: 2 h here vs 2 h"]);
    // Two writes, one envelope: the features array (the reveal) and the counter (the time).
    expect(result.ops).toHaveLength(2);
    const kinds = result.ops.map((op) => Object.keys((op as unknown as { diff: object }).diff)[0]);
    expect(kinds).toEqual(["features", "flags"]);
    const revealed = (
      result.ops[0] as unknown as { diff: { features: CellFeature[] } }
    ).diff.features[0];
    expect(revealed?.state.revealed).toBe(true);
    expect(revealed?.state.atClock).toBe(7_200);
  });

  test("the time is written even when nothing was revealed — it was spent either way", () => {
    const sceneDoc = scene([
      cell({ features: [feature({ reveal: { kind: "time", seconds: 7_200 } })] }),
    ]);
    const result = revealDueFeatures({
      scene: sceneDoc,
      cellKey: "3,4",
      facts: facts(),
      spentSeconds: 600,
    });
    expect(result.revealed).toEqual([]);
    expect(result.ops).toHaveLength(1);
    expect(Object.keys((result.ops[0] as unknown as { diff: object }).diff)).toEqual(["flags"]);
  });

  test("automatic off means the rule only *finds* it — the GM's checkbox still does the reveal", () => {
    const sceneDoc = scene([
      cell({
        features: [
          feature({ reveal: { kind: "perception", dc: 5 }, autoReveal: false }),
        ],
      }),
    ]);
    const result = revealDueFeatures({ scene: sceneDoc, cellKey: "3,4", facts: facts() });
    expect(result.revealed).toEqual([]);
    expect(result.ops).toEqual([]);
    expect(result.notes).toEqual(["The old shrine: found — reveal it when you are ready"]);
  });

  test("a failed automatic check is reported; a failed manual rule is not noise", () => {
    const sceneDoc = scene([
      cell({
        features: [
          feature({ id: "far", reveal: { kind: "perception", dc: 40 }, autoReveal: true }),
          feature({ id: "gm", reveal: { kind: "perception", dc: 40 }, autoReveal: false }),
          feature({ id: "plain", reveal: { kind: "manual" }, autoReveal: true }),
        ],
      }),
    ]);
    const result = revealDueFeatures({ scene: sceneDoc, cellKey: "3,4", facts: facts() });
    expect(result.revealed).toEqual([]);
    expect(result.notes).toEqual(["The old shrine: passive Perception 12 vs 40"]);
  });

  test("the stored counter and the advance are judged together", () => {
    const sceneDoc = scene([
      cell({
        flags: { core: { exploredSeconds: 6_000 } },
        features: [feature({ reveal: { kind: "time", seconds: 7_200 } })],
      }),
    ]);
    // 6 000 already there + 1 200 now = 7 200: the feature fires on the *sum*, not on the step.
    const result = revealDueFeatures({
      scene: sceneDoc,
      cellKey: "3,4",
      facts: facts(),
      spentSeconds: 1_200,
    });
    expect(result.revealed).toHaveLength(1);
    const flags = (
      result.ops.find(
        (op) => Object.keys((op as unknown as { diff: object }).diff)[0] === "flags",
      ) as unknown as { diff: { flags: Record<string, unknown> } }
    ).diff.flags;
    expect((flags["core"] as Record<string, unknown>)["exploredSeconds"]).toBe(7_200);
  });

  test("a cell with no features is not an error, and neither is a cell that does not exist", () => {
    expect(revealDueFeatures({ scene: scene([]), cellKey: "3,4", facts: facts() }).ops).toEqual([]);
    const bare = scene([cell({ features: [] })]);
    expect(revealDueFeatures({ scene: bare, cellKey: "3,4", facts: facts() })).toEqual({
      ops: [],
      revealed: [],
      notes: [],
    });
  });
});

describe("the rule as the GM reads it", () => {
  test("every kind has words, and the automatic switch is visible in them", () => {
    expect(featureRuleLabel(feature({ reveal: { kind: "manual" } }))).toBe("the GM reveals it");
    expect(
      featureRuleLabel(feature({ reveal: { kind: "perception", dc: 15 }, autoReveal: false })),
    ).toBe("passive Perception 15 — the GM decides");
    expect(
      featureRuleLabel(feature({ reveal: { kind: "perception", dc: 15, active: true } })),
    ).toBe("Perception check vs 15");
    expect(featureRuleLabel(feature({ reveal: { kind: "time", seconds: 7_200 } }))).toBe(
      "2 h spent here",
    );
    expect(
      featureRuleLabel(feature({ reveal: { kind: "dice", formula: "1d20", target: 15 } })),
    ).toBe("1d20 ≥ 15");
  });
});
