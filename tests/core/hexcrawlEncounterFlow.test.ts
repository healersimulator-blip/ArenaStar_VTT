/**
 * D-273 (plan §6) — the encounter engine's flow: what a trigger does, what the ledger remembers,
 * and what a GM-only card may carry.
 *
 * The interesting claims are the three the plan's §6 rules make: eligibility by attachment *and*
 * tag, "a firing is written, a prompt is not", and "a public card never carries what a player may
 * not read". The last one is checked twice — through the payload, and through the real projection
 * (`projectWorld`) with a player's eyes, because that is the function the host actually uses.
 */
import { describe, expect, test } from "vitest";
import type {
  CellDocument,
  EncounterTableDocument,
  MessageDocument,
  SceneDocument,
} from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import {
  answerPromptOps,
  encounterCardMessage,
  encounterCheck,
  encounterPayloadOf,
  encounterPromptMessage,
  encounterResultMessage,
  formatCooldown,
  hexcrawlClockSeconds,
  ledgerOfCell,
  openPromptFor,
  readyIn,
  rollTableNow,
} from "../../src/core/hexcrawl/encounterFlow";
import { projectWorld } from "../../src/core/projection";
import type { WorldCollections } from "../../src/core/documents";
import { HOUR_SECONDS } from "../../src/core/clock";

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

const TAGS = {
  day: true,
  night: true,
  entering: true,
  moving: true,
  exploring: true,
  fighting: true,
};

function table(over: Partial<EncounterTableDocument> = {}): EncounterTableDocument {
  return {
    _id: "table-1",
    type: "encounterTable",
    name: "Forest road — day",
    ownership: { default: 0, gm: 3 },
    flags: {},
    system: {},
    mode: "weighted",
    formula: "",
    entries: [{ weight: 100, text: "Goblin bandits", count: 3, refs: [] }],
    tags: { ...TAGS },
    ...over,
  };
}

function cell(over: Partial<CellDocument> = {}): CellDocument {
  return {
    _id: "cell-0-0",
    type: "cell",
    name: "0,0",
    ownership: { default: 0, gm: 3 },
    flags: {},
    system: {},
    key: "0,0",
    tables: ["table-1"],
    features: [],
    ...over,
  };
}

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Overland",
    ownership: { default: 0, gm: 3 },
    flags: {
      core: {
        hexcrawl: {
          version: 1,
          revealed: [],
          sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
          partyTokenId: null,
          encounterMode: "prompt",
          encounterAnnounce: "names",
          daylight: { dawnHour: 6, duskHour: 18 },
          terrain: "pf1e-overland",
          travel: null,
        },
      },
    },
    system: {},
    width: 2000,
    height: 1500,
    grid: { type: "hex", size: 100, distance: 6, units: "mi", diagonals: "555", hexLayout: "oddQ" },
    cells: [cell()],
    ...over,
  } as unknown as SceneDocument;
}

const NOON = 12 * HOUR_SECONDS; // day
const MIDNIGHT = 0; // night

/** The same scene with a given encounter mode (the fixture's default is `prompt`). */
function sceneMode(
  mode: "auto" | "prompt" | "manual",
  over: Partial<SceneDocument> = {},
): SceneDocument {
  const base = scene(over);
  const flags = base.flags as { core: { hexcrawl: Record<string, unknown> } };
  return {
    ...base,
    flags: {
      core: { hexcrawl: { ...flags.core.hexcrawl, encounterMode: mode } },
    },
  } as unknown as SceneDocument;
}

/** A deterministic rng: `n` gives face `n + 1` on a d100. */
const rng = (value: number) => () => value;

describe("encounterCheck — attachment, tags and the three modes", () => {
  test("only the tables the cell names are candidates", () => {
    const other = table({ _id: "table-2", name: "Not attached" });
    const check = encounterCheck({
      scene: sceneMode("auto"),
      tables: [table(), other],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0),
    });
    expect(check.action).toBe("roll");
    expect(check.eligible.map((t) => t._id)).toEqual(["table-1"]);
  });

  test("a cell with no tables at all says so", () => {
    const check = encounterCheck({
      scene: scene({ cells: [cell({ tables: [] })] }),
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0),
    });
    expect(check).toMatchObject({ action: "none", reason: "no-tables", ops: [] });
  });

  test("a night-only table does not fire at noon", () => {
    const night = table({ tags: { ...TAGS, day: false } });
    const check = encounterCheck({
      scene: scene(),
      tables: [night],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0),
    });
    expect(check).toMatchObject({ action: "none", reason: "none-eligible" });
    expect(check.phase).toBe("day");
    // …and it does fire at midnight.
    const nightCheck = encounterCheck({
      scene: sceneMode("auto"),
      tables: [night],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: MIDNIGHT,
      rng: rng(0),
    });
    expect(nightCheck).toMatchObject({ action: "roll", phase: "night" });
  });

  test("an `entering` table ignores `exploring`, and vice versa", () => {
    const exploringOnly = table({ tags: { ...TAGS, entering: false, moving: false } });
    const input = {
      scene: sceneMode("auto"),
      tables: [exploringOnly],
      cellKey: "0,0" as const,
      clockSeconds: NOON,
      rng: rng(0),
    };
    expect(encounterCheck({ ...input, trigger: "entering" }).action).toBe("none");
    expect(encounterCheck({ ...input, trigger: "exploring" }).action).toBe("roll");
  });

  test("an automatic roll draws and writes the ledger at the current reading", () => {
    const check = encounterCheck({
      scene: sceneMode("auto"),
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0.99),
    });
    expect(check.action).toBe("roll");
    expect(check.roll?.roll).toBe(100);
    expect(check.roll?.text).toBe("Goblin bandits");
    expect(check.roll?.count).toBe(3);
    expect(check.ops).toHaveLength(1);
    const op = at(check.ops, 0);
    if (op.kind !== "update") throw new Error("expected an update");
    expect(op.ref).toMatchObject({ coll: "cells", id: "cell-0-0", parent: { coll: "scenes", id: "scene-1" } });
  });

  test("prompt mode lists every candidate and writes nothing — a prompt is not a firing", () => {
    const two = scene({
      flags: {
        core: {
          hexcrawl: {
            version: 1,
            revealed: [],
            sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
            partyTokenId: null,
            encounterMode: "prompt",
            daylight: { dawnHour: 6, duskHour: 18 },
            terrain: "pf1e-overland",
            travel: null,
          },
        },
      },
      cells: [cell({ tables: ["table-1", "table-2"] })],
    });
    const check = encounterCheck({
      scene: two,
      tables: [table(), table({ _id: "table-2", name: "Wolves" })],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0),
    });
    expect(check.action).toBe("prompt");
    expect(check.eligible.map((t) => t.name)).toEqual(["Forest road — day", "Wolves"]);
    expect(check.roll).toBeNull();
    expect(check.ops).toEqual([]);
  });

  test("auto mode with two eligible tables takes the picker path, never a silent first match", () => {
    const auto = scene({
      flags: {
        core: {
          hexcrawl: {
            version: 1,
            revealed: [],
            sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
            partyTokenId: null,
            encounterMode: "auto",
            daylight: { dawnHour: 6, duskHour: 18 },
            terrain: "pf1e-overland",
            travel: null,
          },
        },
      },
      cells: [cell({ tables: ["table-1", "table-2"] })],
    });
    const check = encounterCheck({
      scene: auto,
      tables: [table(), table({ _id: "table-2", name: "Wolves" })],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0),
    });
    expect(check.action).toBe("prompt");
    expect(check.eligible).toHaveLength(2);
    expect(check.roll).toBeNull();
  });

  test("auto mode with one table rolls it", () => {
    const auto = scene({
      flags: {
        core: {
          hexcrawl: {
            version: 1,
            revealed: [],
            sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
            partyTokenId: null,
            encounterMode: "auto",
            daylight: { dawnHour: 6, duskHour: 18 },
            terrain: "pf1e-overland",
            travel: null,
          },
        },
      },
    });
    expect(
      encounterCheck({
        scene: auto,
        tables: [table()],
        cellKey: "0,0",
        trigger: "entering",
        clockSeconds: NOON,
        rng: rng(0),
      }).action,
    ).toBe("roll");
  });

  test("manual mode never fires by itself, and still lists what is attached", () => {
    const manual = scene({
      flags: {
        core: {
          hexcrawl: {
            version: 1,
            revealed: [],
            sight: { mode: "gm", radiusCells: 0, radiusWorldUnits: 0 },
            partyTokenId: null,
            encounterMode: "manual",
            daylight: { dawnHour: 6, duskHour: 18 },
            terrain: "pf1e-overland",
            travel: null,
          },
        },
      },
    });
    const check = encounterCheck({
      scene: manual,
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0),
    });
    expect(check).toMatchObject({ action: "manual", ops: [], roll: null });
    expect(check.eligible).toHaveLength(1);
  });
});

describe("the cooldown ledger", () => {
  const firedScene = (atClock: number) =>
    sceneMode("auto", {
      cells: [cell({ flags: { core: { encounters: { "table-1": atClock } } } })],
    });

  test("a table that just fired is not eligible again this phase", () => {
    const check = encounterCheck({
      scene: firedScene(NOON),
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON + 60,
      rng: rng(0),
    });
    expect(check).toMatchObject({ action: "none", reason: "none-eligible" });
  });

  test("the default cooldown is the rest of the phase: dusk ends it, and the day re-arms it", () => {
    // Dusk at 18:00: 5 h after an 12:00 firing is still the same phase…
    expect(
      encounterCheck({
        scene: firedScene(NOON),
        tables: [table()],
        cellKey: "0,0",
        trigger: "entering",
        clockSeconds: NOON + 5 * HOUR_SECONDS,
        rng: rng(0),
      }).action,
    ).toBe("none");
    // …13:00 the next day is a new day phase, so the table fires again.
    expect(
      encounterCheck({
        scene: firedScene(NOON),
        tables: [table()],
        cellKey: "0,0",
        trigger: "entering",
        clockSeconds: NOON + 25 * HOUR_SECONDS,
        rng: rng(0),
      }).action,
    ).toBe("roll");
  });

  test("an explicit cooldownSeconds overrides the phase default, and a rewind re-arms", () => {
    const hourly = table({ cooldownSeconds: 3600 });
    const at = (clockSeconds: number) =>
      encounterCheck({
        scene: firedScene(NOON),
        tables: [hourly],
        cellKey: "0,0",
        trigger: "entering",
        clockSeconds,
        rng: rng(0),
      }).action;
    expect(at(NOON + 3599)).toBe("none");
    expect(at(NOON + 3600)).toBe("roll");
    // The clock was rewound (a GM correction) — a stale ledger entry must not block the night.
    expect(
      encounterCheck({
        scene: firedScene(NOON),
        tables: [hourly],
        cellKey: "0,0",
        trigger: "entering",
        clockSeconds: NOON - HOUR_SECONDS,
        rng: rng(0),
      }).action,
    ).toBe("roll");
  });

  test("readyIn reads the remaining cooldown, and the ledger readback is per cell", () => {
    expect(readyIn({ scene: firedScene(NOON), table: table(), cellKey: "0,0", clockSeconds: NOON + 60 })).toBe(
      6 * HOUR_SECONDS - 60,
    );
    expect(ledgerOfCell(firedScene(NOON), "0,0")).toEqual({ "table-1": NOON });
    expect(ledgerOfCell(firedScene(NOON), "9,9")).toEqual({});
    expect(formatCooldown(0)).toBe("ready");
    expect(formatCooldown(90)).toBe("2m");
    expect(formatCooldown(6 * HOUR_SECONDS)).toBe("6h 0m");
    expect(formatCooldown(26 * HOUR_SECONDS)).toBe("1d 2h");
  });

  test("two different cells keep separate ledgers (a table may fire in each)", () => {
    const twoCells = sceneMode("auto", {
      cells: [
        cell(),
        cell({ _id: "cell-1-0", key: "1,0" }),
      ],
    });
    const input = {
      scene: twoCells,
      tables: [table()],
      trigger: "entering" as const,
      clockSeconds: NOON,
      rng: rng(0),
    };
    expect(encounterCheck({ ...input, cellKey: "0,0" }).action).toBe("roll");
    expect(encounterCheck({ ...input, cellKey: "1,0" }).action).toBe("roll");
    // …and a ledger entry in one cell does not silence the other.
    const both = sceneMode("auto", {
      cells: [
        cell({ flags: { core: { encounters: { "table-1": NOON } } } }),
        cell({ _id: "cell-1-0", key: "1,0" }),
      ],
    });
    expect(encounterCheck({ ...input, scene: both, cellKey: "1,0" }).action).toBe("roll");
    expect(encounterCheck({ ...input, scene: both, cellKey: "0,0" }).action).toBe("none");
  });

  test("rollTableNow is the hand-rolled path: same draw, same ledger write", () => {
    const { roll, ops } = rollTableNow({
      scene: scene(),
      table: table(),
      cellKey: "0,0",
      clockSeconds: NOON,
      rng: rng(0.5),
    });
    expect(roll.roll).toBe(51); // `rollDie` is 1-based: floor(0.5 × 100) + 1
    expect(ops).toHaveLength(1);
    const op = at(ops, 0);
    if (op.kind !== "update") throw new Error("expected an update");
    const flags = op.diff["flags"] as { core?: { encounters?: Record<string, number> } };
    expect(flags.core?.encounters).toEqual({ "table-1": NOON });
  });

  test("the clock is read from the world setting, clamped like the settings validator", () => {
    expect(hexcrawlClockSeconds({ clockSeconds: 1234 })).toBe(1234);
    expect(hexcrawlClockSeconds({ clockSeconds: -5 })).toBe(0);
    expect(hexcrawlClockSeconds({ clockSeconds: Number.NaN })).toBe(0);
    expect(hexcrawlClockSeconds({})).toBe(0);
    expect(hexcrawlClockSeconds({ clockSeconds: 9_999_999_999_999 })).toBe(3_153_600_000);
  });
});

describe("the cards", () => {
  const promptPayloadInput = () => {
    const check = encounterCheck({
      scene: scene(),
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0),
    });
    return { check, gmIds: ["gm-1", "gm-2"] };
  };

  test("a prompt card is whispered to the GM ids and names every candidate", () => {
    const { check, gmIds } = promptPayloadInput();
    const message = encounterPromptMessage({
      scene: scene(),
      check: { ...check, action: "prompt", eligible: [table(), table({ _id: "t2", name: "Wolves" })] },
      authorId: "gm-1",
      gmIds,
    });
    expect(message.whisper).toEqual(["gm-1", "gm-2"]);
    expect(message.roll).toBeNull();
    expect(message.rollMode).toBeUndefined();
    const payload = encounterPayloadOf(message);
    expect(payload).toMatchObject({
      kind: "prompt",
      cellKey: "0,0",
      trigger: "entering",
      phase: "day",
      // The whisper is the enforcement; the flag is what makes the card *say* "GM only".
      gmOnly: true,
    });
    expect(payload?.candidates.map((c) => c.name)).toEqual(["Forest road — day", "Wolves"]);
    expect(payload?.candidates[0]?.tags.night).toBe(true);
    expect(message.content).toContain("may fire");
  });

  test("a GM-only result card carries the roll and the names", () => {
    const check = encounterCheck({
      scene: sceneMode("auto"),
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0.42),
    });
    const message = encounterResultMessage({
      scene: scene(),
      cellKey: "0,0",
      trigger: "entering",
      phase: check.phase,
      clockSeconds: NOON,
      table: table(),
      roll: check.roll ?? draw(),
      authorId: "gm-1",
      gmIds: ["gm-1"],
      gmOnly: true,
      announceNames: true,
    });
    expect(message.whisper).toEqual(["gm-1"]);
    expect(message.rollMode).toBe("gmroll");
    expect(message.roll?.total).toBe(check.roll?.roll);
    const payload = encounterPayloadOf(message);
    expect(payload?.gmOnly).toBe(true);
    expect(payload?.roll?.text).toBe("Goblin bandits");
    expect(payload?.roll?.count).toBe(3);
  });

  function draw() {
    const check = encounterCheck({
      scene: sceneMode("auto"),
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0.42),
    });
    if (!check.roll) throw new Error("expected a roll");
    return check.roll;
  }

  test("a public card hides the creature names when the scene says to — narrowed, not blanked", () => {
    const roll = draw();
    const build = (announceNames: boolean) =>
      encounterResultMessage({
        scene: scene(),
        cellKey: "0,0",
        trigger: "entering",
        phase: "day",
        clockSeconds: NOON,
        table: table(),
        roll,
        authorId: "gm-1",
        gmIds: ["gm-1"],
        gmOnly: false,
        announceNames,
      });
    const shown = build(true);
    expect(shown.whisper).toEqual([]);
    expect(shown.rollMode).toBe("roll");
    expect(encounterPayloadOf(shown)?.roll?.text).toBe("Goblin bandits");

    const hidden = build(false);
    expect(hidden.whisper).toEqual([]);
    const payload = encounterPayloadOf(hidden);
    expect(payload?.roll?.tableName).toBe("Forest road — day");
    expect(payload?.roll?.roll).toBe(roll.roll);
    // Not `""` and not `[]` — the keys are absent, so nothing can leak by accident.
    expect("text" in (payload?.roll ?? {})).toBe(false);
    expect("refs" in (payload?.roll ?? {})).toBe(false);
    expect("count" in (payload?.roll ?? {})).toBe(false);
    expect(JSON.stringify(hidden)).not.toContain("Goblin bandits");
  });

  test("the answer op marks the card once, so a prompt is never offered twice", () => {
    const roll = draw();
    const ops = answerPromptOps("message-1", roll);
    expect(ops).toMatchObject([
      {
        kind: "update",
        ref: { coll: "messages", id: "message-1" },
        diff: {
          "system.encounter.answered": true,
          "system.encounter.answeredRoll": roll.roll,
        },
      },
    ]);
  });

  test("openPromptFor finds only an unanswered prompt for this cell", () => {
    const { check, gmIds } = promptPayloadInput();
    const prompt = encounterPromptMessage({
      scene: scene(),
      check,
      authorId: "gm-1",
      gmIds,
    });
    expect(openPromptFor([prompt], "scene-1", "0,0")).toBe(prompt);
    expect(openPromptFor([prompt], "scene-1", "1,0")).toBeNull();
    expect(openPromptFor([prompt], "scene-2", "0,0")).toBeNull();
    const answered = {
      ...prompt,
      system: { encounter: { ...encounterPayloadOf(prompt), answered: true } },
    } as unknown as MessageDocument;
    expect(openPromptFor([answered], "scene-1", "0,0")).toBeNull();
    // A result card is not a prompt.
    expect(openPromptFor([encounterCardMessage({
      payload: {
        kind: "result",
        sceneId: "scene-1",
        cellKey: "0,0",
        trigger: "entering",
        phase: "day",
        clockSeconds: NOON,
        candidates: [],
      },
      authorId: "gm-1",
      whisper: [],
    })], "scene-1", "0,0")).toBeNull();
  });

  test("a plain chat line is not an encounter payload", () => {
    expect(
      encounterPayloadOf({
        system: {},
      } as Pick<MessageDocument, "system">),
    ).toBeNull();
    expect(
      encounterPayloadOf({
        system: { encounter: { kind: "nonsense" } },
      } as unknown as Pick<MessageDocument, "system">),
    ).toBeNull();
  });
});

describe("projection: a GM-only card never reaches a player", () => {
  const gm: PermissionUser = { id: "gm-1", role: "GM" };
  const player: PermissionUser = { id: "p1", role: "PLAYER" };

  const worldWith = (message: MessageDocument): WorldCollections => {
    const empty = {
      folders: [],
      scenes: [],
      actors: [],
      items: [],
      journals: [],
      rollTables: [],
      encounterTables: [],
      playlists: [],
      macros: [],
      cards: [],
      combats: [],
      settings: [],
      compendia: [],
      factions: [],
      armies: [],
      turns: [],
      depots: [],
      routes: [],
      reinforcements: [],
    };
    const users = [gm, player].map((u) => ({
      _id: u.id,
      type: "user",
      name: u.id,
      role: u.role,
      ownership: { default: 0 },
      flags: {},
      system: {},
      character: null,
      color: "#fff",
    }));
    return {
      ...empty,
      users,
      messages: [message],
    } as unknown as WorldCollections;
  };

  function messagesFor(world: WorldCollections, user: PermissionUser): MessageDocument[] {
    // `projectWorld(world, seq, user)` — the same call the host makes per session.
    const projected = projectWorld(world, 1, user) as unknown as {
      collections: { messages?: MessageDocument[] };
    };
    return projected.collections.messages ?? [];
  }

  test("the prompt card is present for a GM and absent for a player", () => {
    const check = encounterCheck({
      scene: scene(),
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0),
    });
    const prompt = encounterPromptMessage({
      scene: scene(),
      check,
      authorId: "gm-1",
      gmIds: ["gm-1"],
    });
    const world = worldWith(prompt);
    expect(messagesFor(world, gm).map((m) => m._id)).toEqual([prompt._id]);
    expect(messagesFor(world, player)).toEqual([]);
  });

  test("a GM-only result card is omitted for a player; a public one arrives whole", () => {
    const check = encounterCheck({
      scene: sceneMode("auto"),
      tables: [table()],
      cellKey: "0,0",
      trigger: "entering",
      clockSeconds: NOON,
      rng: rng(0.1),
    });
    if (!check.roll) throw new Error("expected a roll");
    const base = {
      scene: scene(),
      cellKey: "0,0",
      trigger: "entering" as const,
      phase: check.phase,
      clockSeconds: NOON,
      table: table(),
      roll: check.roll,
      authorId: "gm-1",
      gmIds: ["gm-1"],
    };
    const gmOnly = encounterResultMessage({ ...base, gmOnly: true, announceNames: true });
    expect(messagesFor(worldWith(gmOnly), player)).toEqual([]);
    expect(messagesFor(worldWith(gmOnly), gm)).toHaveLength(1);

    const publicHidden = encounterResultMessage({ ...base, gmOnly: false, announceNames: false });
    const playerCopy = messagesFor(worldWith(publicHidden), player);
    expect(playerCopy).toHaveLength(1);
    // The player's own replica carries no creature name, even though the message arrived.
    expect(JSON.stringify(playerCopy)).not.toContain("Goblin bandits");
    expect(at(playerCopy, 0).roll?.total).toBe(check.roll.roll);
  });
});
