/**
 * PF1e tactical effect contract (plan P0, Gap List §10.1 item 3): `flags.pf1e` payloads, core-owned
 * ticking, and SRD stacking. The rejection cases matter as much as the accepted ones — an effect whose
 * `changes` array would silently do nothing is the failure mode this whole seam exists to prevent.
 */
import { describe, expect, test } from "vitest";
import {
  contributionsCombine,
  describeEffect,
  effectFlagsFor,
  readTacticalEffect,
  readTacticalEffects,
  resolveEffects,
  transfersToCmd,
  ttlToTicks,
  validateEffectPayload,
  type PF1eActiveEffect,
  type PF1eEffectPayload,
} from "../../src/packages/pf1e/effects";

const effect = (
  id: string,
  payload: PF1eEffectPayload,
  overrides: Partial<PF1eActiveEffect> = {},
): PF1eActiveEffect => ({
  id,
  name: id,
  icon: null,
  disabled: false,
  durationLeft: null,
  payload,
  ...overrides,
});

describe("payload validation", () => {
  test("accepts a typed bonus, a boost, and a duration", () => {
    const r = validateEffectPayload({
      mods: [
        {
          key: "ability.str",
          type: "enhancement",
          value: 2,
          source: "bull's strength",
        },
      ],
      boosts: [{ dice: 1, sides: 6, energy: "fire" }],
      ttl: { unit: "minute", value: 1, perLevel: true },
      source: { kind: "spell", id: "bull's-strength", level: 3, dc: 14 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mods?.[0]?.value).toBe(2);
    expect(r.value.ttl?.perLevel).toBe(true);
    expect(r.value.source?.dc).toBe(14);
  });

  test("a negative value stays negative and keeps its type (penalties are not unsigned)", () => {
    const r = validateEffectPayload({
      mods: [{ key: "attack", type: "circumstance", value: -2 }],
    });
    expect(r.ok && r.value.mods?.[0]?.value).toBe(-2);
  });

  test("rejects an unknown top-level field instead of ignoring it", () => {
    const r = validateEffectPayload({
      bonus: [{ key: "ac", type: "morale", value: 2 }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('unknown field "bonus"');
  });

  test("rejects a mod key the derivation would never read", () => {
    const r = validateEffectPayload({
      mods: [{ key: "toHit", type: "morale", value: 2 }],
    });
    expect(!r.ok && r.error).toContain("is not a PF1e mod key");
  });

  test("rejects a bonus type that has no stacking meaning", () => {
    const r = validateEffectPayload({
      mods: [{ key: "ac", type: "loud", value: 2 }],
    });
    expect(!r.ok && r.error).toContain("is not one of");
  });

  test("rejects a string value, a damage die without sides, and a non-array mods list", () => {
    expect(
      validateEffectPayload({
        mods: [{ key: "ac", type: "morale", value: "2" }],
      }).ok,
    ).toBe(false);
    expect(validateEffectPayload({ boosts: [{ bonus: 3 }] }).ok).toBe(true);
    expect(!validateEffectPayload({ boosts: [{ dice: 2 }] }).ok).toBe(true);
    expect(!validateEffectPayload({ mods: { key: "ac" } }).ok).toBe(true);
    expect(!validateEffectPayload("ac+2").ok).toBe(true);
  });

  test("an empty payload is legal (a marker effect: condition display only)", () => {
    const r = validateEffectPayload({ condition: "prone" });
    expect(r.ok && r.value.condition).toBe("prone");
    expect(r.ok && r.value.mods).toBeUndefined();
  });
});

describe("reading documents", () => {
  const doc = {
    type: "effect",
    name: "Bull's Strength",
    disabled: false,
    flags: {
      core: { duration: 8 },
      pf1e: {
        mods: [
          {
            key: "damage",
            type: "untyped",
            value: 2,
            source: "bull's strength",
          },
        ],
        ttl: { unit: "minute", value: 1, perLevel: true },
        source: { kind: "spell", level: 4 },
      },
    },
  };

  test("core's duration and the PF1e payload are read side by side", () => {
    const r = readTacticalEffect("e1", doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("Bull's Strength");
    expect(r.value.durationLeft).toBe(8);
    expect(r.value.payload.mods?.[0]?.key).toBe("damage");
  });

  test("a malformed payload is reported per effect, and the good ones still load", () => {
    const { effects, rejected } = readTacticalEffects({
      good: doc,
      bad: {
        flags: { pf1e: { mods: [{ key: "nope", type: "morale", value: 1 }] } },
      },
    });
    expect(effects.map((e) => e.id)).toEqual(["good"]);
    expect(rejected[0]?.error).toContain("nope");
  });

  test("duration 0 or absent means no countdown, which core also treats as persistent", () => {
    expect(
      readTacticalEffect("e", { flags: { core: { duration: 0 }, pf1e: {} } })
        .ok,
    ).toBe(true);
    const r = readTacticalEffect("e", { flags: { pf1e: {} } });
    expect(r.ok && r.value.durationLeft).toBeNull();
  });
});

describe("durations (A.1: 1 round = 6 seconds)", () => {
  test("rounds and minutes-per-level convert to core's tick count", () => {
    expect(
      ttlToTicks(
        { unit: "round", value: 1, perLevel: true, endsOn: "own-turn" },
        5,
      ),
    ).toBe(5);
    expect(
      ttlToTicks(
        { unit: "minute", value: 1, perLevel: true, endsOn: "own-turn" },
        5,
      ),
    ).toBe(50);
    expect(ttlToTicks({ unit: "hour", value: 1, endsOn: "own-turn" }, 3)).toBe(
      100,
    );
    expect(ttlToTicks({ unit: "round", value: 3, endsOn: "round-start" })).toBe(
      3,
    );
  });

  test("permanent, concentration and instant are not per-turn countdowns", () => {
    expect(
      ttlToTicks({ unit: "permanent", value: 1, endsOn: "own-turn" }),
    ).toBeNull();
    expect(
      ttlToTicks({ unit: "concentration", value: 1, endsOn: "own-turn" }),
    ).toBeNull();
    expect(ttlToTicks(undefined)).toBeNull();
  });

  test("the write path seeds both scopes in one call", () => {
    const flags = effectFlagsFor(
      {
        ttl: { unit: "round", value: 1, perLevel: true, endsOn: "own-turn" },
        source: { kind: "spell", level: 7 },
      },
      7,
    );
    expect(flags.core.duration).toBe(7);
    expect(flags.pf1e.ttl?.unit).toBe("round");
    // A permanent duration must not invent a countdown for core to tick away.
    expect(
      effectFlagsFor({
        ttl: { unit: "permanent", value: 1, endsOn: "own-turn" },
      }).core,
    ).toEqual({});
  });
});

describe("stacking (SRD Bonuses and Penalties, A.15)", () => {
  test("same type to the same key does not stack — the better one wins", () => {
    const r = resolveEffects([
      effect("a", { mods: [{ key: "ac", type: "morale", value: 2 }] }),
      effect("b", { mods: [{ key: "ac", type: "morale", value: 4 }] }),
    ]);
    expect(r.mods.ac).toBe(4);
  });

  test("different types stack", () => {
    const r = resolveEffects([
      effect("a", { mods: [{ key: "ac", type: "morale", value: 2 }] }),
      effect("b", { mods: [{ key: "ac", type: "shield", value: 3 }] }),
    ]);
    expect(r.mods.ac).toBe(5);
  });

  test("a bonus and a penalty of the same type offset each other", () => {
    const r = resolveEffects([
      effect("a", { mods: [{ key: "ac", type: "enhancement", value: 2 }] }),
      effect("b", { mods: [{ key: "ac", type: "enhancement", value: -2 }] }),
    ]);
    expect(r.mods.ac ?? 0).toBe(0);
  });

  test("dodge bonuses always stack, even from one effect naming itself twice", () => {
    const r = resolveEffects([
      effect("a", {
        mods: [
          { key: "ac", type: "dodge", value: 2 },
          { key: "ac", type: "dodge", value: 3 },
        ],
      }),
    ]);
    // Same contributor, same type: the better one stands; two different contributors add.
    expect(r.mods.ac).toBe(3);
    const two = resolveEffects([
      effect("a", { mods: [{ key: "ac", type: "dodge", value: 2 }] }),
      effect("b", { mods: [{ key: "ac", type: "dodge", value: 2 }] }),
    ]);
    expect(two.mods.ac).toBe(4);
  });

  test("untyped bonuses stack only from different sources", () => {
    const same = resolveEffects([
      effect("a", {
        mods: [{ key: "attack", type: "untyped", value: 2, source: "stance" }],
      }),
      effect("b", {
        mods: [{ key: "attack", type: "untyped", value: 4, source: "stance" }],
      }),
    ]);
    expect(same.mods.attack).toBe(4);
    const diff = resolveEffects([
      effect("a", {
        mods: [{ key: "attack", type: "untyped", value: 2, source: "rage" }],
      }),
      effect("b", {
        mods: [{ key: "attack", type: "untyped", value: 4, source: "focus" }],
      }),
    ]);
    expect(diff.mods.attack).toBe(6);
  });

  test("contributionsCombine states the rule the resolver implements", () => {
    expect(contributionsCombine({ type: "morale" }, { type: "dodge" })).toBe(
      true,
    );
    expect(contributionsCombine({ type: "morale" }, { type: "morale" })).toBe(
      false,
    );
    expect(contributionsCombine({ type: "dodge" }, { type: "dodge" })).toBe(
      true,
    );
    expect(
      contributionsCombine(
        { type: "circumstance", source: "flanked" },
        { type: "circumstance", source: "high ground" },
      ),
    ).toBe(true);
    expect(
      contributionsCombine(
        { type: "circumstance", source: "flanked" },
        { type: "circumstance", source: "flanked" },
      ),
    ).toBe(false);
  });

  test("stackGroup collapses a family to its best contributor, even across different sources", () => {
    const plain = resolveEffects([
      effect("a", {
        mods: [
          { key: "ability.str", type: "untyped", value: 2, source: "rage i" },
        ],
      }),
      effect("b", {
        mods: [
          { key: "ability.str", type: "untyped", value: 4, source: "rage ii" },
        ],
      }),
    ]);
    expect(plain.mods["ability.str"]).toBe(6); // without a group these two untyped bonuses add
    const grouped = resolveEffects([
      effect("a", {
        mods: [
          { key: "ability.str", type: "untyped", value: 2, source: "rage i" },
        ],
        stackGroup: "rage",
      }),
      effect("b", {
        mods: [
          { key: "ability.str", type: "untyped", value: 4, source: "rage ii" },
        ],
        stackGroup: "rage",
      }),
    ]);
    expect(grouped.mods["ability.str"]).toBe(4);
  });

  test("disabled effects contribute nothing", () => {
    const r = resolveEffects([
      effect(
        "a",
        { mods: [{ key: "ac", type: "armor", value: 5 }] },
        { disabled: true },
      ),
    ]);
    expect(r.mods.ac).toBeUndefined();
  });
});

describe("what combat needs beyond numbers", () => {
  test("CMD borrows the transferable AC bonuses and every AC penalty (A.9)", () => {
    const r = resolveEffects([
      effect("a", {
        mods: [
          { key: "ac", type: "deflection", value: 3 },
          { key: "ac", type: "armor", value: 6 },
          { key: "ac", type: "armor", value: -2 },
        ],
      }),
    ]);
    expect(r.acTransfer).toBe(3);
    expect(r.acPenalties).toBe(-2);
    expect(transfersToCmd("insight")).toBe(true);
    expect(transfersToCmd("natural")).toBe(false);
  });

  test("denials, grants, immunities and conditions surface as sets", () => {
    const r = resolveEffects([
      effect("a", {
        denies: ["full-attack", "charge"],
        grants: ["evasion"],
        immune: {
          mindAffecting: true,
          conditions: ["fear"],
          energy: ["fire"],
          dr: 5,
        },
        flags: { flatFooted: true, cannotAoO: true },
        condition: "confused",
        concentration: true,
      }),
    ]);
    expect([...r.denies]).toEqual(["full-attack", "charge"]);
    expect(r.grants.has("evasion")).toBe(true);
    expect(r.immuneMindAffecting).toBe(true);
    expect(r.immuneConditions.has("fear")).toBe(true);
    expect(r.extraDr).toBe(5);
    expect(r.flatFooted).toBe(true);
    expect(r.cannotAoO).toBe(true);
    expect(r.requiresConcentration).toBe(true);
    expect(r.conditions).toEqual(["confused"]);
  });

  test("damage boosts are carried through for the roll, with precision flagged", () => {
    const r = resolveEffects([
      effect("a", {
        boosts: [{ dice: 4, sides: 6, precision: true, energy: "fire" }],
      }),
    ]);
    expect(r.boosts[0]).toEqual({
      dice: 4,
      sides: 6,
      energy: "fire",
      precision: true,
    });
  });

  test("every resolved key keeps a breakdown string so the UI can explain itself", () => {
    const r = resolveEffects([
      effect("shield-of-faith", {
        mods: [
          {
            key: "ac",
            type: "deflection",
            value: 2,
            source: "shield of faith",
          },
        ],
      }),
    ]);
    expect(r.mods.ac).toBe(2);
    expect(r.breakdown.ac).toContain("+2");
  });

  test("describeEffect names the bonus and the remaining rounds", () => {
    const text = describeEffect(
      effect(
        "bull",
        { mods: [{ key: "ability.str", type: "enhancement", value: 2 }] },
        { name: "Bull's Strength", durationLeft: 1 },
      ),
    );
    expect(text).toContain("Bull's Strength");
    expect(text).toContain("+2 enhancement to str");
    expect(text).toContain("1 round)");
  });
});
