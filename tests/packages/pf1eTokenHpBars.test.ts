/**
 * §2.2/G-10a (D-261) — token hit-point bars.
 *
 * The bar shows the sheet's own derivation (authored `hp`/`hpMax` plus the Constitution
 * drain/damage adjustment), a token with no reachable actor or no authored maximum shows nothing,
 * and *who* gets the bars is the `tokenHpBars` world setting — the default is GM-only, and an
 * unrecognised or unset value must not leak monster hit points to the table.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument, Json, TokenDocument } from "../../src/core/documents";
import {
  tokenHpBarFor,
  tokenHpBarsMap,
  type PF1eTokenHpBarMode,
} from "../../src/packages/pf1e/tokenHpBars";
import { tokenHpBarsOf, validateWorldSettingsPatch } from "../../src/core/worldSettings";

function token(id: string, over: Partial<TokenDocument> = {}): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    x: 0,
    y: 0,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: false,
    light: { radius: 0, color: "#fff", alpha: 0.5 },
    ...over,
  };
}

function actor(id: string, pf1e: Record<string, Json>): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 2 },
    flags: {},
    system: { pf1e },
    items: [],
    effects: [],
  };
}

describe("tokenHpBarFor", () => {
  test("reads the authored hit points the sheet shows", () => {
    const orc = actor("orc", { hp: 7, hpMax: 12, tempHp: 4, nonlethalDamage: 3 });
    expect(tokenHpBarFor(token("t", { actorId: "orc" }), [orc])).toEqual({
      hp: 7,
      hpMax: 12,
      tempHp: 4,
      nonlethalDamage: 3,
    });
  });

  test("an unauthored document reads as full hit points at its maximum", () => {
    // `hp` falls back to `hpMax` (actor.ts), so a freshly imported stat block with only a
    // maximum draws a full green bar rather than an empty one.
    expect(tokenHpBarFor(token("t", { actorId: "a" }), [actor("a", { hpMax: 9 })])).toEqual({
      hp: 9,
      hpMax: 9,
      tempHp: 0,
      nonlethalDamage: 0,
    });
  });

  test("the Constitution drain adjustment reaches the bar (drain Δ modifier × Hit Dice)", () => {
    const drained = actor("a", {
      hp: 30,
      hpMax: 30,
      hitDice: 4,
      abilities: { con: 14 },
      abilitiesDrain: { con: 6 },
    });
    // Con 14 → 8: modifier +2 → −1, Δ −3, so 4 Hit Dice cost 12 from current *and* total.
    expect(tokenHpBarFor(token("t", { actorId: "a" }), [drained])).toEqual({
      hp: 18,
      hpMax: 18,
      tempHp: 0,
      nonlethalDamage: 0,
    });
  });

  test("a buff's Constitution bonus is not hit points — no effect can move them", () => {
    // PF1E_MOD_KEYS carries no hit-point key and the derivation only adjusts for drain/damage,
    // so this documents the boundary the module's header claims: effects feed the badge row,
    // not the bar.
    const raging = actor("a", { hp: 30, hpMax: 30, hitDice: 4, abilities: { con: 14 } });
    expect(tokenHpBarFor(token("t", { actorId: "a" }), [raging])).toEqual({
      hp: 30,
      hpMax: 30,
      tempHp: 0,
      nonlethalDamage: 0,
    });
  });

  test("nothing to show: no actor id, an actor the replica does not hold, no maximum", () => {
    const actors = [actor("a", { hp: 3 })];
    expect(tokenHpBarFor(token("t"), actors)).toBeNull();
    expect(tokenHpBarFor(token("t", { actorId: "gone" }), actors)).toBeNull();
    expect(tokenHpBarFor(token("t", { actorId: "a" }), actors)).toBeNull();
    expect(
      tokenHpBarFor(token("t", { actorId: "b" }), [actor("b", { hpMax: 0, hp: -4 })]),
    ).toBeNull();
  });
});

describe("tokenHpBarsMap", () => {
  const actors = [
    actor("hero", { hp: 11, hpMax: 14 }),
    actor("orc", { hp: 2, hpMax: 12 }),
  ];
  const tokens = [
    token("hero", { actorId: "hero" }),
    token("orc", { actorId: "orc" }),
    token("rock"),
  ];
  const modes: PF1eTokenHpBarMode[] = ["gm", "all", "hover"];

  test("the default `gm` mode hands a player an empty map and the GM every bar", () => {
    const player = tokenHpBarsMap(tokens, { actors, mode: "gm", isGM: false });
    expect([...player.keys()]).toEqual([]);
    const gm = tokenHpBarsMap(tokens, { actors, mode: "gm", isGM: true });
    expect([...gm.keys()]).toEqual(["hero", "orc"]);
    // An actor-less token never gets a bar, whatever the mode.
    expect(gm.has("rock")).toBe(false);
  });

  test("`all` and `hover` hand the same numbers to either shell", () => {
    for (const mode of modes.slice(1)) {
      for (const isGM of [true, false]) {
        const map = tokenHpBarsMap(tokens, { actors, mode, isGM });
        expect([...map.keys()]).toEqual(["hero", "orc"]);
        expect(map.get("hero")).toEqual({
          hp: 11,
          hpMax: 14,
          tempHp: 0,
          nonlethalDamage: 0,
        });
      }
    }
  });
});

describe("the world setting", () => {
  test("unset or unrecognised reads as GM-only", () => {
    expect(tokenHpBarsOf({})).toBe("gm");
    expect(tokenHpBarsOf({ tokenHpBars: "everyone" as never })).toBe("gm");
    expect(tokenHpBarsOf({ tokenHpBars: "all" })).toBe("all");
    expect(tokenHpBarsOf({ tokenHpBars: "hover" })).toBe("hover");
  });

  test("the settings editor accepts exactly the three modes", () => {
    for (const mode of ["gm", "all", "hover"]) {
      const checked = validateWorldSettingsPatch({ tokenHpBars: mode });
      expect(checked.ok).toBe(true);
      expect(checked.clean.tokenHpBars).toBe(mode);
    }
    const bad = validateWorldSettingsPatch({ tokenHpBars: "players" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("tokenHpBars");
  });
});
