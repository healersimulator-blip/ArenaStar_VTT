/**
 * D-269 (plan §6, requirements 5/5a) — the encounter engine's contract.
 *
 * The eligibility matrix is the feature's headline rule ("day/night, entering, moving, exploring,
 * fighting — all on by default, and the GM can turn one off"), so it is tested as a matrix: every
 * one of the six tags, switched off, must remove exactly the situations it names and no others.
 * The cooldown tests pin the part a GM cannot see — that a night table cannot fire twice in one
 * night *without being configured to*.
 */
import { describe, expect, test } from "vitest";
import type {
  CellDocument,
  EncounterTableDocument,
  SceneDocument,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { DEFAULT_DAYLIGHT, HOUR_SECONDS } from "../../src/core/clock";
import { ALL_TAGS_ON } from "../../src/core/hexcrawl/tables";
import {
  clearLedgerOps,
  cooldownRemaining,
  drawEncounter,
  eligibleTables,
  encounterDecision,
  encounterPhase,
  lastFiredAt,
  ledgerOps,
  readLedger,
  rollDie,
  triggersForExplore,
  triggersForFight,
  triggersForStep,
  type EncounterContext,
  type EncounterTrigger,
} from "../../src/core/hexcrawl/encounter";
import type { EncounterTags } from "../../src/core/documents";

const DAY = 10 * HOUR_SECONDS; // 10:00
const NIGHT = 23 * HOUR_SECONDS; // 23:00

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Map",
    ownership: { default: 0 },
    flags: { core: { hexcrawl: { version: 1, encounterMode: "auto" } } },
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 800,
    darkness: 0,
    grid: {
      type: "hex",
      size: 50,
      distance: 6,
      units: "mi",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
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

const table = (
  id: string,
  over: Partial<EncounterTableDocument> = {},
): EncounterTableDocument => ({
  _id: id,
  type: "encounterTable",
  name: id,
  ownership: { default: 2 },
  flags: {},
  system: {},
  mode: "weighted",
  formula: "",
  entries: [{ weight: 100, text: `${id} result`, count: 1, refs: [] }],
  tags: { ...ALL_TAGS_ON },
  ...over,
});

function ctx(over: Partial<EncounterContext> = {}): EncounterContext {
  return {
    scene: scene(),
    tables: [table("t1")],
    cellKey: "0,0",
    trigger: "entering",
    clockSeconds: DAY,
    fired: [],
    rng: () => 0.5,
    ...over,
  };
}

describe("phase", () => {
  test("the scene's own daylight window decides day and night", () => {
    expect(encounterPhase(DAY, scene())).toBe("day");
    expect(encounterPhase(NIGHT, scene())).toBe("night");
    expect(encounterPhase(5 * HOUR_SECONDS, scene())).toBe("night"); // before dawn
    expect(
      encounterPhase(DEFAULT_DAYLIGHT.duskHour * HOUR_SECONDS, scene()),
    ).toBe("night");
    const nightless = scene({
      flags: {
        core: {
          hexcrawl: { version: 1, daylight: { dawnHour: 6, duskHour: 6 } },
        },
      },
    });
    expect(encounterPhase(NIGHT, nightless)).toBe("day");
    const polar = scene({
      flags: {
        core: {
          hexcrawl: { version: 1, daylight: { dawnHour: 20, duskHour: 6 } },
        },
      },
    });
    expect(encounterPhase(NIGHT, polar)).toBe("day"); // 20:00–06:00 is the polar day
    expect(encounterPhase(DAY, polar)).toBe("night");
  });
});

describe("the eligibility matrix (6 tags × 2 phases × 4 triggers)", () => {
  const triggers: EncounterTrigger[] = [
    "entering",
    "moving",
    "exploring",
    "fighting",
  ];
  const phases: Array<{ name: "day" | "night"; clock: number }> = [
    { name: "day", clock: DAY },
    { name: "night", clock: NIGHT },
  ];

  test("with every tag on, every combination is eligible", () => {
    for (const trigger of triggers) {
      for (const { clock } of phases) {
        const tables = eligibleTables(ctx({ trigger, clockSeconds: clock }));
        expect(tables.map((t) => t._id)).toEqual(["t1"]);
      }
    }
  });

  test("switching one tag off removes exactly its own situations", () => {
    const tagOf: Record<string, EncounterTags> = {
      day: { ...ALL_TAGS_ON, day: false },
      night: { ...ALL_TAGS_ON, night: false },
      entering: { ...ALL_TAGS_ON, entering: false },
      moving: { ...ALL_TAGS_ON, moving: false },
      exploring: { ...ALL_TAGS_ON, exploring: false },
      fighting: { ...ALL_TAGS_ON, fighting: false },
    };
    for (const [tag, tags] of Object.entries(tagOf)) {
      const t = table("t1", { tags });
      for (const trigger of triggers) {
        for (const { name, clock } of phases) {
          const eligible = eligibleTables(
            ctx({ tables: [t], trigger, clockSeconds: clock }),
          );
          const shouldFire =
            (tag === "day" ? name === "night" : true) &&
            (tag === "night" ? name === "day" : true) &&
            (tag === trigger ? false : true);
          expect({
            tag,
            trigger,
            phase: name,
            fires: eligible.length === 1,
          }).toEqual({
            tag,
            trigger,
            phase: name,
            fires: shouldFire,
          });
        }
      }
    }
  });

  test("a table with a partial tag bag still counts the missing ones as on", () => {
    const partial = table("t-partial", {
      tags: { night: false } as EncounterTags,
    });
    expect(
      eligibleTables(
        ctx({ tables: [partial], trigger: "exploring", clockSeconds: DAY }),
      ),
    ).toHaveLength(1);
    expect(
      eligibleTables(
        ctx({ tables: [partial], trigger: "exploring", clockSeconds: NIGHT }),
      ),
    ).toHaveLength(0);
    expect(
      eligibleTables(
        ctx({ tables: [partial], trigger: "fighting", clockSeconds: DAY }),
      ),
    ).toHaveLength(1);
  });
});

describe("cooldown", () => {
  test("a table that has never fired is ready", () => {
    expect(cooldownRemaining(table("t1"), ctx(), DEFAULT_DAYLIGHT)).toBe(0);
  });

  test("the default cooldown is the rest of the current phase", () => {
    const at2300 = NIGHT;
    const fired = [{ cellKey: "0,0", tableId: "t1", atClock: at2300 }];
    // One hour later, still night: not ready.
    expect(
      cooldownRemaining(
        table("t1"),
        ctx({ clockSeconds: at2300 + HOUR_SECONDS, fired }),
        DEFAULT_DAYLIGHT,
      ),
    ).toBe(6 * HOUR_SECONDS);
    // At 05:00 the *next* morning the night is nearly over, so nearly ready — the clock reading
    // is absolute seconds since the epoch, which is why the day has to be added (a real bug hunt
    // once a table appeared ready six hours early because 05:00 looked like the same night).
    expect(
      cooldownRemaining(
        table("t1"),
        ctx({ clockSeconds: 86_400 + 5 * HOUR_SECONDS, fired }),
        DEFAULT_DAYLIGHT,
      ),
    ).toBe(HOUR_SECONDS);
    // …and a night table is *ineligible* by tag after dawn anyway, which the matrix covers.
    const eligible = eligibleTables(
      ctx({ clockSeconds: at2300 + HOUR_SECONDS, fired }),
    );
    expect(eligible).toHaveLength(0);
  });

  test("an explicit cooldownSeconds overrides the phase default", () => {
    const fired = [{ cellKey: "0,0", tableId: "t1", atClock: NIGHT }];
    const t = table("t1", { cooldownSeconds: 7 * 24 * HOUR_SECONDS });
    expect(
      cooldownRemaining(
        t,
        ctx({ clockSeconds: NIGHT + 6 * 24 * HOUR_SECONDS, fired }),
        DEFAULT_DAYLIGHT,
      ),
    ).toBe(24 * HOUR_SECONDS);
    // A zero (or negative) `cooldownSeconds` is not "no cooldown" — it is an unset field, and the
    // phase default applies, because that is the value the spec documents as the default.
    expect(
      cooldownRemaining(
        table("t1", { cooldownSeconds: 0 }),
        ctx({ clockSeconds: NIGHT + 1, fired }),
        DEFAULT_DAYLIGHT,
      ),
    ).toBeGreaterThan(0);
    // Six days later the phase default has long expired, so the table is ready again.
    expect(
      cooldownRemaining(
        table("t1", { cooldownSeconds: 0 }),
        ctx({ clockSeconds: NIGHT + 6 * 86_400, fired }),
        DEFAULT_DAYLIGHT,
      ),
    ).toBe(0);
    expect(
      eligibleTables(ctx({ clockSeconds: NIGHT + 6 * 86_400, fired })),
    ).toHaveLength(1);
  });

  test("the cooldown is per cell: the same table may fire in a different hex", () => {
    const fired = [{ cellKey: "0,0", tableId: "t1", atClock: NIGHT }];
    expect(
      eligibleTables(
        ctx({ cellKey: "1,0", clockSeconds: NIGHT + HOUR_SECONDS, fired }),
      ),
    ).toHaveLength(1);
    expect(
      eligibleTables(
        ctx({ cellKey: "0,0", clockSeconds: NIGHT + HOUR_SECONDS, fired }),
      ),
    ).toHaveLength(0);
  });

  test("rewinding the clock clears the cooldown (the GM reset time on purpose)", () => {
    const fired = [
      { cellKey: "0,0", tableId: "t1", atClock: 5 * HOUR_SECONDS },
    ];
    expect(
      cooldownRemaining(
        table("t1"),
        ctx({ clockSeconds: 2 * HOUR_SECONDS, fired }),
        DEFAULT_DAYLIGHT,
      ),
    ).toBe(0);
  });

  test("lastFiredAt takes the most recent firing of that table in that cell", () => {
    const fired = [
      { cellKey: "0,0", tableId: "t1", atClock: 100 },
      { cellKey: "0,0", tableId: "t1", atClock: 500 },
      { cellKey: "0,0", tableId: "t2", atClock: 900 },
      { cellKey: "1,0", tableId: "t1", atClock: 900 },
    ];
    expect(lastFiredAt(fired, "0,0", "t1")).toBe(500);
    expect(lastFiredAt(fired, "0,0", "t9")).toBeNull();
  });
});

describe("the decision (requirement 5a)", () => {
  test("manual says what could fire but never fires it", () => {
    const s = scene({
      flags: { core: { hexcrawl: { version: 1, encounterMode: "manual" } } },
    });
    const decision = encounterDecision(ctx({ scene: s }));
    expect(decision).toEqual({
      kind: "manual",
      tables: [expect.objectContaining({ _id: "t1" })],
    });
  });

  test("auto with one candidate rolls it; auto with several prompts instead of picking", () => {
    expect(encounterDecision(ctx()).kind).toBe("roll");
    const many = encounterDecision(ctx({ tables: [table("t1"), table("t2")] }));
    expect(many.kind).toBe("prompt");
    expect(many.kind === "prompt" ? many.tables.map((t) => t._id) : []).toEqual(
      ["t1", "t2"],
    );
  });

  test("prompt mode always prompts, even with a single candidate", () => {
    const s = scene({
      flags: { core: { hexcrawl: { version: 1, encounterMode: "prompt" } } },
    });
    const decision = encounterDecision(ctx({ scene: s }));
    expect(decision.kind).toBe("prompt");
  });

  test("nothing eligible is not an error, and neither is a scene without the profile", () => {
    const quiet = table("t1", { tags: { ...ALL_TAGS_ON, entering: false } });
    expect(encounterDecision(ctx({ tables: [quiet] }))).toEqual({
      kind: "none",
      reason: "none-eligible",
    });
    expect(encounterDecision(ctx({ tables: [] }))).toEqual({
      kind: "none",
      reason: "no-tables",
    });
    expect(encounterDecision(ctx({ cellKey: "" }))).toEqual({
      kind: "none",
      reason: "no-cell",
    });
    expect(encounterDecision(ctx({ scene: scene({ flags: {} }) }))).toEqual({
      kind: "none",
      reason: "not-a-hexcrawl",
    });
  });
});

describe("drawing", () => {
  test("rollDie stays inside the die for every rng value", () => {
    expect(rollDie(100, () => 0)).toBe(1);
    expect(rollDie(100, () => 0.999999)).toBe(100);
    expect(rollDie(100, () => 1)).toBe(100); // a degenerate rng must not produce 101
    expect(rollDie(20, () => 0.5)).toBe(11);
  });

  test("a weighted table draws from the compiled ladder", () => {
    const t = table("t1", {
      entries: [
        { weight: 70, text: "Wolves", count: 2, refs: [] },
        {
          weight: 30,
          text: "Bandits",
          count: 1,
          refs: [{ kind: "actor", actorId: "a1" }],
        },
      ],
    });
    expect(drawEncounter(t, () => 0).roll).toBe(1);
    expect(drawEncounter(t, () => 0).text).toBe("Wolves");
    expect(drawEncounter(t, () => 0.69).text).toBe("Wolves");
    expect(drawEncounter(t, () => 0.7).text).toBe("Bandits");
    expect(drawEncounter(t, () => 0.999).text).toBe("Bandits");
    expect(drawEncounter(t, () => 0.8).count).toBe(1);
    expect(drawEncounter(t, () => 0.8).refs).toEqual([
      { kind: "actor", actorId: "a1" },
    ]);
    const roll = drawEncounter(t, () => 0.5);
    expect(roll.formula).toBe("1d100");
    expect(roll.die).toBe(100);
    expect(roll.tableId).toBe("t1");
  });

  test("a dice table draws on its own die and reports a gap honestly", () => {
    const t = table("t1", {
      mode: "dice",
      formula: "1d6",
      entries: [
        { weight: 0, range: [1, 3], text: "Boar", count: 1, refs: [] },
        { weight: 0, range: [5, 6], text: "Owlbear", count: 1, refs: [] },
      ],
    });
    expect(drawEncounter(t, () => 0).formula).toBe("1d6");
    expect(drawEncounter(t, () => 0).roll).toBe(1);
    expect(drawEncounter(t, () => 0.6).roll).toBe(4);
    // 4 is the hole in the table: `entryIndex` is null and the text says so instead of lying.
    const gap = drawEncounter(t, () => 0.6);
    expect(gap.entryIndex).toBeNull();
    expect(gap.text).toMatch(/Nothing on 4/);
  });
});

describe("the ledger", () => {
  /** A miniature store: enough to prove the ops are the ones the store's apply path expects. */
  function applyOps(s: SceneDocument, ops: Op[]): SceneDocument {
    const next: SceneDocument = { ...s, cells: [...(s.cells ?? [])] };
    for (const op of ops) {
      if (op.kind !== "update") continue;
      if (op.ref.coll !== "cells") continue;
      const at = (next.cells ?? []).findIndex((c) => c._id === op.ref.id);
      if (at < 0) continue;
      next.cells = [...(next.cells ?? [])];
      next.cells[at] = {
        ...(next.cells[at] as CellDocument),
        ...(op.diff as Partial<CellDocument>),
      } as CellDocument;
    }
    return next;
  }

  test("a firing is written to the cell and read back", () => {
    const cell: CellDocument = {
      _id: "cell-1",
      type: "cell" as const,
      name: "0,0",
      ownership: { default: 0 },
      flags: {},
      system: {},
      key: "0,0",
    };
    const s = scene({ cells: [cell] });
    expect(readLedger(s)).toEqual([]);
    const ops = ledgerOps(s, "0,0", [{ tableId: "t1", atClock: 3_600 }]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "update",
      ref: {
        coll: "cells",
        id: "cell-1",
        parent: { coll: "scenes", id: "scene-1" },
      },
    });
    const after = applyOps(s, ops);
    expect(readLedger(after)).toEqual([
      { cellKey: "0,0", tableId: "t1", atClock: 3_600 },
    ]);
    // A second firing updates the same key rather than adding a row.
    const after2 = applyOps(
      after,
      ledgerOps(after, "0,0", [{ tableId: "t1", atClock: 7_200 }]),
    );
    expect(readLedger(after2)).toEqual([
      { cellKey: "0,0", tableId: "t1", atClock: 7_200 },
    ]);
    // A cleared ledger reads as never-fired.
    expect(readLedger(applyOps(after2, clearLedgerOps(after2, "0,0")))).toEqual(
      [],
    );
  });

  test("a cell that does not exist, or an empty write, produces no ops", () => {
    const s = scene();
    expect(ledgerOps(s, "0,0", [{ tableId: "t1", atClock: 1 }])).toEqual([]);
    const withCell = scene({
      cells: [
        {
          _id: "c",
          type: "cell",
          name: "0,0",
          ownership: { default: 0 },
          flags: {},
          system: {},
          key: "0,0",
        },
      ],
    });
    expect(ledgerOps(withCell, "0,0", [])).toEqual([]);
  });

  test("a hand-edited ledger (strings, arrays) is ignored rather than trusted", () => {
    const s = scene({
      cells: [
        {
          _id: "c",
          type: "cell",
          name: "0,0",
          ownership: { default: 0 },
          flags: {
            core: { encounters: { t1: "yesterday", t2: [1], t3: 900 } },
          },
          system: {},
          key: "0,0",
        },
      ],
    });
    expect(readLedger(s)).toEqual([
      { cellKey: "0,0", tableId: "t3", atClock: 900 },
    ]);
  });
});

describe("trigger points", () => {
  test("crossing a border is entering + moving; a step inside a cell is moving only", () => {
    expect(triggersForStep("0,0", "1,0")).toEqual(["entering", "moving"]);
    expect(triggersForStep(null, "0,0")).toEqual(["entering", "moving"]);
    expect(triggersForStep("0,0", "0,0")).toEqual(["moving"]);
    expect(triggersForExplore()).toEqual(["exploring"]);
    expect(triggersForFight()).toEqual(["fighting"]);
  });
});
