/**
 * P4/E05 — the replicated world clock (D-146). The clock lives as the `clockSeconds` key of the
 * replicated `world-settings` document, advances from exactly two op-writing places (the combat
 * tracker's round wrap and the GM's out-of-combat time controls), anchors `appliedAtClock` on
 * payloads at apply time, and sweeps clock-counted durations (round/minute/hour/day) from both
 * effect homes when the clock passes their end — never touching local storage, so a joiner reads
 * the same time their buffs expire against.
 */
import { describe, expect, test } from "vitest";
import { startCombat } from "../../src/core/combat";
import type {
  ActorDocument,
  CombatDocument,
  CombatantDocument,
  EffectDocument,
  Json,
  SettingsDocument,
} from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import {
  WORLD_SETTINGS_ID,
  validateWorldSettingsPatch,
  worldSettingsDoc,
  type CoreWorldSettings,
} from "../../src/core/worldSettings";
import {
  effectFlagsFor,
  readTacticalEffect,
  validateEffectPayload,
  type PF1eEffectPayload,
  type PF1eTtl,
} from "../../src/packages/pf1e/effects";
import {
  buildEffectDoc,
  combatantEffectsRecord,
  pf1eApplyActorEffect,
  type PF1eEffectRequest,
} from "../../src/packages/pf1e/effectOps";
import { pf1eNextTurn } from "../../src/packages/pf1e/combatState";
import {
  TICKS_PER_DAY,
  WORLD_CLOCK_KEY,
  advanceWorldClockOps,
  clockExpiredIds,
  formatWorldClock,
  isClockCounted,
  pf1eClockSweepOps,
  readWorldClock,
  setWorldClockOps,
  ttlSeconds,
  wrapAdvanceOps,
  worldClockSecondsOf,
} from "../../src/packages/pf1e/worldClock";

const gm: PermissionUser = { id: "gm", role: "GM" };

/** Build a settings bag without tripping the computed-key literal checks. */
const bag = (system: Record<string, unknown>): CoreWorldSettings =>
  system as CoreWorldSettings;

const settingsDoc = (system: Record<string, unknown>): SettingsDocument => ({
  ...worldSettingsDoc({}),
  system: system as SettingsDocument["system"],
});

function actor(id: string, effects: EffectDocument[]): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 2 },
    flags: {},
    system: {},
    items: [],
    effects,
  };
}

function combatant(id: string, initiative: number): CombatantDocument {
  return {
    _id: id,
    type: "combatant",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    tokenId: null,
    actorId: null,
    initiative,
    hidden: false,
    defeated: false,
  };
}

function combat(...cs: CombatantDocument[]): CombatDocument {
  return {
    _id: "enc",
    type: "combat",
    name: "fight",
    ownership: { default: 1 },
    flags: {},
    system: {},
    round: 0,
    turn: 0,
    combatants: cs,
  };
}

function effectDoc(
  id: string,
  payload: PF1eEffectPayload,
  duration?: number,
): EffectDocument {
  return {
    _id: id,
    type: "effect",
    name: id,
    ownership: { default: 0 },
    flags: {
      ...(duration !== undefined ? { core: { duration } } : {}),
      pf1e: payload as unknown as Json,
    } as unknown as EffectDocument["flags"],
    system: {},
    changes: [],
    disabled: false,
  };
}

const ttl = (unit: PF1eTtl["unit"], value = 1, perLevel = false): PF1eTtl => ({
  unit,
  value,
  ...(perLevel ? { perLevel: true } : {}),
});

describe("reading the replicated clock", () => {
  test("absent, junk and out-of-range values read as 0; real values truncate", () => {
    expect(worldClockSecondsOf({})).toBe(0);
    expect(worldClockSecondsOf(bag({ [WORLD_CLOCK_KEY]: "x" }))).toBe(0);
    expect(worldClockSecondsOf(bag({ [WORLD_CLOCK_KEY]: -5 }))).toBe(0);
    expect(worldClockSecondsOf(bag({ [WORLD_CLOCK_KEY]: 90.9 }))).toBe(90);
    expect(
      worldClockSecondsOf(bag({ [WORLD_CLOCK_KEY]: 3_153_600_000 + 1 })),
    ).toBe(3_153_600_000);
  });

  test("a joiner reads the clock off the replicated settings merge", () => {
    const world = [
      settingsDoc({ detectionMultiplier: 2 }),
      settingsDoc({ [WORLD_CLOCK_KEY]: 90 }),
    ];
    expect(readWorldClock(world)).toBe(90);
    // The canonical doc the settings UI edits:
    expect(world.some((d) => d._id === WORLD_SETTINGS_ID)).toBe(true);
  });
});

describe("clock ops", () => {
  test("advancing an empty world creates the settings document and sets the key", () => {
    const ops = advanceWorldClockOps([], 30);
    expect(ops.length).toBeGreaterThanOrEqual(1);
    // No canonical document yet: one create op carrying the bag (no dotted updates).
    const created = ops[0] as { kind: string; data?: SettingsDocument };
    expect(created.kind).toBe("create");
    expect(created.data?.system[WORLD_CLOCK_KEY]).toBe(30);
  });

  test("a delta that changes nothing produces no ops", () => {
    const world = [settingsDoc({ [WORLD_CLOCK_KEY]: 30 })];
    expect(advanceWorldClockOps(world, 0)).toEqual([]);
    expect(setWorldClockOps(world, 30)).toEqual([]);
  });

  test("rewinding clamps at zero instead of going negative", () => {
    const world = [settingsDoc({ [WORLD_CLOCK_KEY]: 10 })];
    const ops = advanceWorldClockOps(world, -100);
    const diff = (ops[0] as { diff: Record<string, Json> }).diff;
    expect(diff[`system.${WORLD_CLOCK_KEY}`]).toBe(0);
  });

  test("the round wrap advances the clock by pf1eNextTurn's clockDeltaSeconds", () => {
    const enc = combat(combatant("a", 20), combatant("b", 15));
    const started = startCombat(enc);
    const midRound = pf1eNextTurn(started.combat);
    expect(midRound.clockDeltaSeconds).toBe(0);
    expect(wrapAdvanceOps([], midRound.clockDeltaSeconds)).toEqual([]);

    // One combatant: the very next transition wraps round 1 → 2.
    const wrapped = pf1eNextTurn(midRound.combat);
    expect(wrapped.clockDeltaSeconds).toBe(6);
    const ops = wrapAdvanceOps(
      [settingsDoc({ [WORLD_CLOCK_KEY]: 12 })],
      wrapped.clockDeltaSeconds,
    );
    expect(ops.length).toBeGreaterThanOrEqual(1);
    const diffs = ops.flatMap((op) =>
      "diff" in op ? [op.diff as Record<string, Json>] : [],
    );
    expect(diffs.some((d) => d[`system.${WORLD_CLOCK_KEY}`] === 18)).toBe(true);
  });
});

describe("the duration ladder", () => {
  test("round/minute/hour follow the landed ttlToTicks abstraction times the round", () => {
    expect(ttlSeconds(ttl("round", 3))).toBe(18); // 3 × 6 s
    expect(ttlSeconds(ttl("minute", 1))).toBe(60); // 10 rounds
    expect(ttlSeconds(ttl("hour", 1))).toBe(600); // 100 rounds
    expect(ttlSeconds(ttl("minute", 1, true), 3)).toBe(180); // 1 min/level at CL 3
    expect(ttlSeconds(ttl("round", 1), 1, 60)).toBe(60); // configured round length
  });

  test("a day is 24 of this world's hours; configured rounds scale it", () => {
    expect(TICKS_PER_DAY).toBe(2400);
    expect(ttlSeconds(ttl("day", 1))).toBe(14_400);
    expect(ttlSeconds(ttl("day", 2))).toBe(28_800);
    expect(ttlSeconds(ttl("day", 1, true), 2)).toBe(28_800);
    expect(ttlSeconds(ttl("day", 1), 1, 60)).toBe(144_000);
  });

  test("instant, concentration and permanent are never clock-counted", () => {
    for (const unit of ["instant", "concentration", "permanent"] as const) {
      expect(ttlSeconds(ttl(unit))).toBeNull();
      expect(isClockCounted(ttl(unit))).toBe(false);
    }
    for (const unit of ["round", "minute", "hour", "day"] as const) {
      expect(isClockCounted(ttl(unit))).toBe(true);
    }
  });
});

describe("anchoring at apply", () => {
  test("effectFlagsFor stamps the world clock when one is in scope", () => {
    const payload: PF1eEffectPayload = { ttl: ttl("minute", 2) };
    expect(effectFlagsFor(payload).pf1e.appliedAtClock).toBeUndefined();
    expect(
      effectFlagsFor(payload, 1, { worldClockSeconds: 120 }).pf1e
        .appliedAtClock,
    ).toBe(120);
    expect(
      effectFlagsFor(payload, 1, { worldClockSeconds: -1 }).pf1e.appliedAtClock,
    ).toBeUndefined();
    expect(
      effectFlagsFor(payload, 1, { worldClockSeconds: Number.NaN }).pf1e
        .appliedAtClock,
    ).toBeUndefined();
  });

  test("the validator round-trips a valid anchor and drops junk", () => {
    const ok = validateEffectPayload({ appliedAtClock: 90.7, ttl: ttl("day") });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.appliedAtClock).toBe(90);
    const junk = validateEffectPayload({ appliedAtClock: -3 });
    expect(junk.ok).toBe(true);
    if (junk.ok) expect(junk.value.appliedAtClock).toBeUndefined();
    const junkStr = validateEffectPayload({ appliedAtClock: "x" });
    expect(junkStr.ok).toBe(true);
    if (junkStr.ok) expect(junkStr.value.appliedAtClock).toBeUndefined();
  });

  test("readTacticalEffect preserves the anchor — the sweep can see applied effects", () => {
    const doc = effectDoc("m", { ttl: ttl("minute", 1), appliedAtClock: 60 });
    const r = readTacticalEffect("m", doc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.payload.appliedAtClock).toBe(60);
  });

  test("apply requests stamp the anchor through buildEffectDoc and the authorized ops", () => {
    const request: PF1eEffectRequest = {
      name: "Mage Armor",
      payload: { ttl: ttl("hour", 1) },
      worldClockSeconds: 42,
    };
    const built = buildEffectDoc(request);
    expect(built.ok).toBe(true);
    if (built.ok) {
      const flags = built.value.flags as unknown as {
        pf1e: PF1eEffectPayload;
      };
      expect(flags.pf1e.appliedAtClock).toBe(42);
    }
    const applied = pf1eApplyActorEffect(actor("fighter", []), gm, request);
    expect(applied.error).toBeNull();
    const first = applied.ops[0];
    if (!first) throw new Error("apply produced no op");
    const written = (first.diff as unknown as { effects: EffectDocument[] })
      .effects;
    if (!written[0]) throw new Error("apply wrote no effect");
    expect(
      (written[0].flags as unknown as { pf1e: PF1eEffectPayload }).pf1e
        .appliedAtClock,
    ).toBe(42);
  });
});

describe("the sweep", () => {
  const anchored = (at: number, unit: PF1eTtl["unit"], value = 1) =>
    ({ ttl: ttl(unit, value), appliedAtClock: at }) satisfies PF1eEffectPayload;

  test("a minute effect ends exactly when the clock reaches its anchor plus 60 s", () => {
    const entries = [{ id: "m", payload: anchored(0, "minute") }];
    expect(clockExpiredIds(entries, 59, 6)).toEqual([]);
    expect(clockExpiredIds(entries, 60, 6)).toEqual(["m"]);
  });

  test("per-level scaling and day lengths set the real end", () => {
    const cl3 = {
      ttl: ttl("minute", 1, true),
      appliedAtClock: 0,
      source: { kind: "spell" as const, level: 3 },
    };
    // 1 minute/level at CL 3 = 30 ticks = 180 s; a plain minute would already be gone at 179.
    expect(
      clockExpiredIds([{ id: "m", payload: anchored(0, "minute") }], 179, 6),
    ).toEqual(["m"]);
    expect(clockExpiredIds([{ id: "m", payload: cl3 }], 179, 6)).toEqual([]);
    expect(clockExpiredIds([{ id: "m", payload: cl3 }], 180, 6)).toEqual(["m"]);
    expect(
      clockExpiredIds([{ id: "d", payload: anchored(0, "day") }], 14_399, 6),
    ).toEqual([]);
    expect(
      clockExpiredIds([{ id: "d", payload: anchored(0, "day") }], 14_400, 6),
    ).toEqual(["d"]);
  });

  test("unanchored (pre-E05) effects are never swept; anchored non-counted units too", () => {
    const entries = [
      { id: "legacy", payload: { ttl: ttl("minute") } },
      { id: "inst", payload: { ...anchored(0, "instant") } },
      { id: "conc", payload: { ...anchored(0, "concentration") } },
      { id: "perm", payload: { ...anchored(0, "permanent") } },
    ];
    expect(clockExpiredIds(entries, 3_153_600_000, 6)).toEqual([]);
  });

  test("the actor home is swept by one update op carrying the survivors", () => {
    const a = actor("fighter", [
      effectDoc("expired", anchored(0, "minute")),
      effectDoc("kept", { ttl: ttl("permanent") }),
      effectDoc("later", { ...anchored(100, "hour", 1) }),
    ]);
    const sweep = pf1eClockSweepOps([a], [], 60, 6);
    expect(sweep.ops).toEqual([
      {
        kind: "update",
        ref: { coll: "actors", id: "fighter" },
        diff: { effects: [expect.any(Object), expect.any(Object)] },
      },
    ]);
    const firstOp = sweep.ops[0];
    if (!firstOp) throw new Error("sweep produced no op");
    const effects = (firstOp.diff as unknown as { effects: EffectDocument[] })
      .effects;
    expect(effects.map((e) => e._id)).toEqual(["kept", "later"]);
    expect(sweep.expired).toEqual([
      { home: "actors", ownerId: "fighter", effectId: "expired" },
    ]);
  });

  test("the combatant home is swept in place, keeping untouched combatants", () => {
    const carrier = combatant("a", 20);
    carrier.flags = {
      core: {
        effects: {
          expired: effectDoc("expired", anchored(0, "minute")),
          kept: effectDoc("kept", { ttl: ttl("permanent") }),
        } as unknown as Json,
      },
    } as never;
    const enc = combat(carrier, combatant("b", 15));
    const sweep = pf1eClockSweepOps([], [enc], 60, 6);
    expect(sweep.ops.length).toBe(1);
    const sweepOp = sweep.ops[0];
    if (!sweepOp) throw new Error("sweep produced no op");
    const next = (
      sweepOp.diff as unknown as { combatants: CombatantDocument[] }
    ).combatants;
    const nextCarrier = next[0];
    const other = next[1];
    if (!nextCarrier || !other) throw new Error("sweep dropped a combatant");
    expect(Object.keys(combatantEffectsRecord(nextCarrier))).toEqual(["kept"]);
    expect(other._id).toBe("b");
    expect(sweep.expired).toEqual([
      { home: "combats", ownerId: "a", effectId: "expired" },
    ]);

    // Nothing expired → nothing written:
    expect(pf1eClockSweepOps([], [enc], 10, 6)).toEqual({
      ops: [],
      expired: [],
    });
  });

  test("an unparseable embedded effect is preserved, not silently dropped by the sweep", () => {
    const junk = {
      _id: "junk",
      type: "effect",
      name: "junk",
      flags: { pf1e: { mods: "not-an-array" } },
    } as unknown as EffectDocument;
    const a = actor("fighter", [
      junk,
      effectDoc("expired", anchored(0, "minute")),
    ]);
    const sweep = pf1eClockSweepOps([a], [], 60, 6);
    const junkOp = sweep.ops[0];
    if (!junkOp) throw new Error("sweep produced no op");
    const effects = (junkOp.diff as unknown as { effects: EffectDocument[] })
      .effects;
    expect(effects.map((e) => e._id)).toEqual(["junk"]);
  });
});

describe("settings validation", () => {
  test("clockSeconds must be a finite non-negative number within the bound", () => {
    expect(validateWorldSettingsPatch({ clockSeconds: -1 }).ok).toBe(false);
    expect(validateWorldSettingsPatch({ clockSeconds: "x" }).ok).toBe(false);
    expect(validateWorldSettingsPatch({ clockSeconds: 3_153_600_001 }).ok).toBe(
      false,
    );
    expect(validateWorldSettingsPatch({ clockSeconds: 0 }).ok).toBe(true);
    expect(validateWorldSettingsPatch({ clockSeconds: 3_153_600_000 }).ok).toBe(
      true,
    );
  });
});

describe("formatting", () => {
  test("the readout renders h:mm:ss with a day prefix when needed", () => {
    expect(formatWorldClock(0)).toBe("00:00:00");
    expect(formatWorldClock(3661)).toBe("01:01:01");
    expect(formatWorldClock(90_061)).toBe("1d 01:01:01");
    expect(formatWorldClock(-5)).toBe("00:00:00");
  });
});
