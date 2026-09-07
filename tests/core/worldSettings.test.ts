/**
 * World settings (plan P0.4, decision D-113): the rules options live in the replicated `settings`
 * collection rather than the local `WorldsRecord`, because a clock a player cannot see is not a clock
 * their durations tick against. These tests pin the reader, the patch validation, and — most
 * importantly — that the rules contexts actually read the document instead of the `{}` they used to.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SECONDS_PER_ROUND,
  WORLD_SETTINGS_ID,
  advanceClockOnRoundOf,
  isScalarSetting,
  secondsPerRoundOf,
  settingOf,
  validateWorldSettingsPatch,
  worldSettingsDoc,
  worldSettingsFrom,
  worldSettingsOps,
} from "../../src/core/worldSettings";
import type { BaseDocument, SettingsDocument } from "../../src/core/documents";
import { rulesContextFromStore } from "../../src/ui/armies/armyModel";
import {
  OWNERSHIP_LEVELS,
  type WorldCollections,
} from "../../src/core/documents";
import { getEffectiveOwnership } from "../../src/core/permissions";
import { projectWorld } from "../../src/core/projection";
import type { PermissionUser } from "../../src/core/ownership";
import { emptyWorld } from "../net/fixtures";

const settingsDoc = (
  system: Record<string, unknown>,
  id = WORLD_SETTINGS_ID,
): SettingsDocument => ({
  ...worldSettingsDoc({}),
  _id: id,
  system: system as SettingsDocument["system"],
});

/** The projection a PLAYER sees, so the ownership level is checked the way the host checks it. */
function projectedForPlayer(docs: readonly BaseDocument[]) {
  const world: WorldCollections = {
    ...emptyWorld(),
    settings: [...docs] as SettingsDocument[],
  };
  return projectWorld(world, 1, playerView);
}

const playerView: PermissionUser = { id: "pl-key", role: "PLAYER" };

describe("reading the settings collection", () => {
  test("an empty world has no settings, and callers supply their own defaults", () => {
    expect(worldSettingsFrom([])).toEqual({});
    expect(secondsPerRoundOf({})).toBe(DEFAULT_SECONDS_PER_ROUND);
    expect(advanceClockOnRoundOf({})).toBe(true);
  });

  test("only documents of type settings contribute, merged in _id order", () => {
    const merged = worldSettingsFrom([
      { _id: "b", type: "scene", system: { secondsPerRound: 99 } },
      settingsDoc({ secondsPerRound: 6, detectionMultiplier: 2 }, "a"),
      settingsDoc({ secondsPerRound: 10 }, "b"),
    ]);
    expect(merged.secondsPerRound).toBe(10);
    expect(merged.detectionMultiplier).toBe(2);
  });

  test("a key set to null is a value, a key set to undefined is not", () => {
    const merged = worldSettingsFrom([settingsDoc({ a: null, b: undefined })]);
    expect("a" in merged).toBe(true);
    expect("b" in merged).toBe(false);
  });

  test("the seconds-per-round setting is clamped into a usable range", () => {
    // Out-of-range input is clamped rather than trusted; the *write* path refuses it outright.
    expect(secondsPerRoundOf({ secondsPerRound: 0 })).toBe(1);
    expect(secondsPerRoundOf({ secondsPerRound: -5 })).toBe(1);
    expect(secondsPerRoundOf({ secondsPerRound: 1 })).toBe(1);
    expect(secondsPerRoundOf({ secondsPerRound: 999_999 })).toBe(3600);
    expect(
      secondsPerRoundOf({ secondsPerRound: "six" as unknown as number }),
    ).toBe(DEFAULT_SECONDS_PER_ROUND);
  });

  test("settingOf reads a key with a fallback", () => {
    expect(
      settingOf({ detectionMultiplier: 3 }, "detectionMultiplier", 1),
    ).toBe(3);
    expect(settingOf({}, "detectionMultiplier", 1)).toBe(1);
  });
});

describe("patch validation", () => {
  test("scalars pass, structures are refused", () => {
    expect(
      validateWorldSettingsPatch({
        secondsPerRound: 6,
        tactical: true,
        flavour: "gritty",
      }).ok,
    ).toBe(true);
    expect(validateWorldSettingsPatch({ nested: { a: 1 } }).error).toContain(
      "must be a number, string, or boolean",
    );
    expect(isScalarSetting([1, 2])).toBe(false);
    expect(isScalarSetting(Number.NaN)).toBe(false);
  });

  test("a dotted key would be read as a path by the diff engine, so it is refused here", () => {
    expect(validateWorldSettingsPatch({ "a.b": 1 }).error).toContain(
      'may not contain "."',
    );
  });

  test("document fields are not settings", () => {
    expect(validateWorldSettingsPatch({ _id: "x" }).ok).toBe(false);
    expect(validateWorldSettingsPatch({ ownership: 3 }).ok).toBe(false);
  });

  test("out-of-range values are named rather than clamped behind the user's back", () => {
    expect(validateWorldSettingsPatch({ secondsPerRound: 0 }).error).toContain(
      "between 1 and 3600",
    );
    expect(
      validateWorldSettingsPatch({ detectionMultiplier: 0 }).error,
    ).toContain("positive");
  });
});

describe("ops", () => {
  test("the first edit creates the document, readable by players", () => {
    const ops = worldSettingsOps([], { secondsPerRound: 6 });
    expect(ops).toHaveLength(1);
    const create = ops[0];
    expect(create?.kind).toBe("create");
    if (create?.kind !== "create") return;
    expect(create.coll).toBe("settings");
    expect(create.data._id).toBe(WORLD_SETTINGS_ID);
    expect(create.data.system.secondsPerRound).toBe(6);
    expect(getEffectiveOwnership(playerView, create.data)).toBe(
      OWNERSHIP_LEVELS.LIMITED,
    );
    // LIMITED is the threshold the projection filters on, so the document reaches every client —
    // and `settings` takes the default branch of `projection.ts:139`'s switch, meaning the payload
    // arrives too (a row with a scrubbed `system` would replicate a clock nobody could read).
    const seen = projectedForPlayer([create.data]).collections.settings?.[0];
    expect(seen?._id).toBe(WORLD_SETTINGS_ID);
    expect((seen?.system as { secondsPerRound?: number } | undefined)?.secondsPerRound).toBe(
      DEFAULT_SECONDS_PER_ROUND,
    );
    // …and a world-private settings doc (default NONE) does not, which is what makes the level
    // choice load-bearing rather than decorative.
    const privateDoc = { ...create.data, ownership: { default: 0 as const } };
    expect(
      projectedForPlayer([privateDoc]).collections.settings ?? [],
    ).toHaveLength(0);
  });

  test("a later edit writes only the keys that changed, as dotted paths", () => {
    const before = [
      settingsDoc({ secondsPerRound: 6, detectionMultiplier: 2 }),
    ];
    const ops = worldSettingsOps(before, {
      secondsPerRound: 10,
      detectionMultiplier: 2,
    });
    expect(ops).toEqual([
      {
        kind: "update",
        ref: { coll: "settings", id: WORLD_SETTINGS_ID },
        diff: { "system.secondsPerRound": 10 },
      },
    ]);
    expect(worldSettingsOps(before, { secondsPerRound: 6 })).toEqual([]);
  });

  test("undefined deletes the key with the diff engine's removal marker", () => {
    const ops = worldSettingsOps([settingsDoc({ secondsPerRound: 6 })], {
      secondsPerRound: undefined,
    });
    expect(ops[0]?.kind).toBe("update");
    if (ops[0]?.kind !== "update") return;
    expect(ops[0].diff).toEqual({ "-=system.secondsPerRound": null });
  });

  test("a world with other settings documents still edits the canonical one", () => {
    const ops = worldSettingsOps(
      [settingsDoc({ flavour: "gritty" }, "house-rules")],
      { secondsPerRound: 6 },
    );
    expect(ops[0]?.kind).toBe("create");
    if (ops[0]?.kind !== "create") return;
    expect(ops[0].data._id).toBe(WORLD_SETTINGS_ID);
    // The other document's key is not clobbered, because only this one is written.
    expect(ops[0].data.system).toEqual({ secondsPerRound: 6 });
  });
});

describe("the rules contexts read the world, not a literal {}", () => {
  const store = (docs: SettingsDocument[]) =>
    ({
      get: (coll: string, id: string) =>
        coll === "settings" ? docs.find((d) => d._id === id) : undefined,
      getAll: (coll: string) => (coll === "settings" ? docs : []),
    }) as never;

  test("rulesContextFromStore picks up the settings document with no extra argument", () => {
    const ctx = rulesContextFromStore(
      store([settingsDoc({ detectionMultiplier: 3, secondsPerRound: 12 })]),
      null,
    );
    expect(ctx.worldSettings.detectionMultiplier).toBe(3);
    expect(ctx.worldSettings.secondsPerRound).toBe(12);
  });

  test("an explicit bag still wins, so tests and e2e probes stay deterministic", () => {
    const ctx = rulesContextFromStore(
      store([settingsDoc({ secondsPerRound: 12 })]),
      null,
      { secondsPerRound: 1 },
    );
    expect(ctx.worldSettings.secondsPerRound).toBe(1);
  });

  test("an empty settings collection yields an empty bag, as before", () => {
    expect(rulesContextFromStore(store([]), null).worldSettings).toEqual({});
  });
});
