/**
 * P5/C05 — pack-driven cast payloads (DEVIATIONS D-2).
 *
 * The parity test reads the shipped `systems/pf1e-core/packs/spells.json` directly, the
 * same way `pf1eActor.test.ts` reads the bestiary, so the in-code mirror cannot drift
 * from the content pack it claims to reproduce.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PF1E_PACK_FIREBALL_MASS_BATTLE,
  PF1E_PACK_BURNING_HANDS_MASS_BATTLE,
  parsePackSpellOrder,
  spellRangeFeet,
} from "../../src/packages/pf1e/spellPacks";

interface PackSpellEntry {
  id: string;
  name: string;
  data: {
    name: string;
    system: Record<string, unknown>;
  };
}

const packPath = fileURLToPath(
  new URL("../../systems/pf1e-core/packs/spells.json", import.meta.url),
);
const pack = JSON.parse(readFileSync(packPath, "utf8")) as {
  entries: PackSpellEntry[];
};
const fireball = pack.entries.find((e) => e.id === "fireball");
const burningHands = pack.entries.find((e) => e.id === "burning-hands");

describe("pack ↔ code parity for the reference Fireball", () => {
  it("the in-code mirror matches the fields the shipped pack actually carries", () => {
    expect(fireball).toBeDefined();
    if (!fireball) return;
    const sys = fireball.data.system;
    const mirror = PF1E_PACK_FIREBALL_MASS_BATTLE.system as Record<
      string,
      unknown
    >;
    const packMb = sys.massBattle as Record<string, unknown>;
    const mirrorMb = mirror.massBattle as Record<string, unknown>;
    // The mirror carries every field the sim consumes. `notes` is prose for a pack
    // author, not an input, so it is the one deliberate omission — asserted, not assumed.
    const omitted = Object.keys(packMb).filter((k) => !(k in mirrorMb));
    expect(omitted).toEqual(["notes"]);
    const rest = Object.fromEntries(
      Object.entries(packMb).filter(([k]) => k !== "notes"),
    );
    expect(mirrorMb).toEqual(rest);
    expect(mirror.savingThrow).toBe(sys.savingThrow);
    expect(mirror.spellResistance).toBe(sys.spellResistance);
  });

  it("the pack's radius is 20 ft, which is what closes D-2", () => {
    const sys = fireball?.data.system as Record<string, unknown> | undefined;
    const mb = sys?.massBattle as Record<string, unknown> | undefined;
    expect(mb?.radiusFeet).toBe(20);
    expect(sys?.area).toBe("20-ft.-radius spread");
  });

  it("the pack's range is long, matching CRB p.283 (D-164)", () => {
    const sys = fireball?.data.system as Record<string, unknown> | undefined;
    const mb = sys?.massBattle as Record<string, unknown> | undefined;
    expect(mb?.rangeCategory).toBe("long");
    expect(sys?.range).toBe("long (400 ft. + 40 ft./level)");
  });
});

describe("pack ↔ code parity for the reference Burning Hands (D-171)", () => {
  it("the in-code mirror matches the fields the shipped pack actually carries", () => {
    expect(burningHands).toBeDefined();
    if (!burningHands) return;
    const sys = burningHands.data.system;
    const mirror = PF1E_PACK_BURNING_HANDS_MASS_BATTLE.system as Record<
      string,
      unknown
    >;
    const packMb = sys.massBattle as Record<string, unknown>;
    const mirrorMb = mirror.massBattle as Record<string, unknown>;
    // Same contract as Fireball: every field the sim consumes is mirrored; `notes` is
    // prose and the one deliberate omission — asserted, not assumed.
    const omitted = Object.keys(packMb).filter((k) => !(k in mirrorMb));
    expect(omitted).toEqual(["notes"]);
    const rest = Object.fromEntries(
      Object.entries(packMb).filter(([k]) => k !== "notes"),
    );
    expect(mirrorMb).toEqual(rest);
    expect(mirror.savingThrow).toBe(sys.savingThrow);
    expect(mirror.spellResistance).toBe(sys.spellResistance);
  });

  it("the pack carries the CRB pg. 251 numbers: 15-ft cone, 1d4/level, max 5d4", () => {
    const sys = burningHands?.data.system as
      Record<string, unknown> | undefined;
    const mb = sys?.massBattle as Record<string, unknown> | undefined;
    expect(mb?.shape).toBe("cone");
    expect(mb?.radiusFeet).toBe(15);
    expect(mb?.damageDiceSides).toBe(4);
    expect(mb?.maxDice).toBe(5);
    expect(sys?.range).toBe("15 ft.");
    expect(sys?.area).toBe("cone-shaped burst");
  });

  it("parses as a caster-origin cone: no range category, dice capped at 5d4", () => {
    const at = (casterLevel: number) =>
      parsePackSpellOrder({ entry: burningHands?.data, casterLevel });
    const r = at(2);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.order).toMatchObject({
      spellName: "Burning Hands",
      shape: "cone",
      radius: 15,
      rangeCategory: null, // a cone shoots away from the caster — no designated point
      saveType: "ref",
      halfOnSave: true,
      evasionApplies: true,
      damageType: "fire",
      spellResistance: true,
    });
    expect(at(1).order?.damageDiceCount).toBe(1);
    expect(at(2).order?.damageDiceCount).toBe(2);
    expect(at(5).order?.damageDiceCount).toBe(5);
    expect(at(20).order?.damageDiceCount).toBe(5); // "maximum 5d4"
  });
});

describe("parsePackSpellOrder", () => {
  it("turns the pack's fireball into a cast payload with the pack's own numbers", () => {
    const r = parsePackSpellOrder({ entry: fireball?.data, casterLevel: 5 });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.order).toMatchObject({
      spellName: "Fireball",
      shape: "circle",
      radius: 20, // the pack, not the old hard-coded 15
      rangeCategory: "long", // CRB p.283: "Range long (400 ft. + 40 ft./level)"
      saveType: "ref",
      halfOnSave: true,
      evasionApplies: true,
      damageType: "fire",
      spellResistance: true,
    });
  });

  it("resolves 1d6 per caster level and honours the 10d6 cap", () => {
    const at = (casterLevel: number) =>
      parsePackSpellOrder({ entry: fireball?.data, casterLevel }).order
        ?.damageDiceCount;
    expect(at(1)).toBe(1);
    expect(at(5)).toBe(5);
    expect(at(10)).toBe(10);
    expect(at(20)).toBe(10); // "maximum 10d6"
  });

  it("names a shape the sim cannot draw", () => {
    const r = parsePackSpellOrder({
      entry: {
        name: "Odd",
        system: {
          massBattle: {
            shape: "square",
            radiusFeet: 10,
            saveType: "ref",
            halfOnSave: true,
            damageDiceCount: 1,
            damageDiceSides: 6,
          },
        },
      },
      casterLevel: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain("massBattle.shape");
  });

  it("refuses a non-positive radius and a missing massBattle block", () => {
    const bad = parsePackSpellOrder({
      entry: {
        name: "Zero",
        system: {
          massBattle: {
            shape: "circle",
            radiusFeet: 0,
            saveType: "ref",
            halfOnSave: true,
            damageDiceCount: 1,
            damageDiceSides: 6,
          },
        },
      },
      casterLevel: 5,
    });
    expect(bad.issues.map((i) => i.field)).toContain("massBattle.radiusFeet");

    const none = parsePackSpellOrder({
      entry: { name: "Ray", system: { savingThrow: "none" } },
      casterLevel: 5,
    });
    expect(none.ok).toBe(false);
    expect(none.issues[0]?.message).toMatch(/no "massBattle" block/);
  });

  it("refuses per-caster-level scaling with no cap authored", () => {
    const r = parsePackSpellOrder({
      entry: {
        name: "Uncapped",
        system: {
          savingThrow: "Reflex half",
          massBattle: {
            shape: "circle",
            radiusFeet: 10,
            rangeCategory: "medium",
            saveType: "ref",
            halfOnSave: true,
            damageDiceCount: 1,
            damageDiceSides: 6,
            dicePerCasterLevel: true,
          },
        },
      },
      casterLevel: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain("massBattle.maxDice");
  });

  it("flags evasion on a spell that is not Reflex half, instead of silently allowing it", () => {
    const fort = parsePackSpellOrder({
      entry: {
        name: "Bad Evasion",
        system: {
          savingThrow: "Fortitude half",
          massBattle: {
            shape: "circle",
            radiusFeet: 10,
            rangeCategory: "close",
            saveType: "fort",
            halfOnSave: true,
            evasion: true,
            damageDiceCount: 1,
            damageDiceSides: 6,
          },
        },
      },
      casterLevel: 5,
    });
    expect(fort.ok).toBe(false);
    expect(fort.issues[0]?.message).toMatch(/not Reflex half/);
  });

  it("flags a Saving Throw line that contradicts the sim block", () => {
    const r = parsePackSpellOrder({
      entry: {
        name: "Contradictory",
        system: {
          savingThrow: "Reflex half",
          massBattle: {
            shape: "circle",
            radiusFeet: 10,
            rangeCategory: "medium",
            saveType: "ref",
            halfOnSave: false, // says "half" but does not halve
            damageDiceCount: 1,
            damageDiceSides: 6,
          },
        },
      },
      casterLevel: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain("savingThrow");
  });

  it("accepts a negates spell, where halfOnSave false is correct", () => {
    const r = parsePackSpellOrder({
      entry: {
        name: "Hold Person",
        system: {
          savingThrow: "Will negates",
          spellResistance: true,
          massBattle: {
            shape: "circle",
            radiusFeet: 10,
            rangeCategory: "medium",
            saveType: "will",
            halfOnSave: false,
            damageDiceCount: 1,
            damageDiceSides: 6,
          },
        },
      },
      casterLevel: 5,
    });
    expect(r.ok).toBe(true);
    expect(r.order?.halfOnSave).toBe(false);
    expect(r.order?.spellResistance).toBe(true);
  });

  it("names a malformed caster level", () => {
    const r = parsePackSpellOrder({ entry: fireball?.data, casterLevel: 0 });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain("casterLevel");
  });

  it("names a range category the sim cannot resolve, or a missing one", () => {
    const entry = (massBattle: Record<string, unknown>) => ({
      name: "Ranged",
      system: { savingThrow: "Reflex half", massBattle },
    });
    const base = {
      shape: "circle",
      radiusFeet: 10,
      saveType: "ref",
      halfOnSave: true,
      damageDiceCount: 1,
      damageDiceSides: 6,
    };

    const wrong = parsePackSpellOrder({
      entry: entry({ ...base, rangeCategory: "miles" }),
      casterLevel: 5,
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.issues.map((i) => i.field)).toContain(
      "massBattle.rangeCategory",
    );

    const missing = parsePackSpellOrder({
      entry: entry({ ...base }),
      casterLevel: 5,
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues.map((i) => i.field)).toContain(
      "massBattle.rangeCategory",
    );
  });
});

describe("cone/line payloads (D-167)", () => {
  const coneMb = {
    shape: "cone",
    radiusFeet: 15, // the cone's length — the spell's own Range entry (CRB p.214)
    saveType: "ref",
    halfOnSave: true,
    damageDiceCount: 1,
    damageDiceSides: 6,
  };
  const coneEntry = {
    name: "Burning Spray",
    system: { savingThrow: "Reflex half", massBattle: coneMb },
  };

  it("parses a cone without a range category — cones shoot away from the caster", () => {
    const r = parsePackSpellOrder({ entry: coneEntry, casterLevel: 3 });
    expect(r.ok).toBe(true);
    expect(r.order).toMatchObject({
      shape: "cone",
      radius: 15,
      rangeCategory: null,
      widthFeet: null,
    });
  });

  it("parses a line and carries its corridor width", () => {
    const r = parsePackSpellOrder({
      entry: {
        name: "Test Line",
        system: {
          savingThrow: "Reflex half",
          massBattle: {
            ...coneMb,
            shape: "line",
            radiusFeet: 60,
            widthFeet: 5,
          },
        },
      },
      casterLevel: 5,
    });
    expect(r.ok).toBe(true);
    expect(r.order).toMatchObject({
      shape: "line",
      radius: 60,
      widthFeet: 5,
      rangeCategory: null,
    });
  });

  it("names a line with no usable corridor width", () => {
    const r = parsePackSpellOrder({
      entry: {
        name: "Wide Line",
        system: {
          savingThrow: "Reflex half",
          massBattle: { ...coneMb, shape: "line" },
        },
      },
      casterLevel: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain("massBattle.widthFeet");
  });

  it("still requires a range category for circle shapes", () => {
    const r = parsePackSpellOrder({
      entry: {
        name: "Round",
        system: {
          savingThrow: "Reflex half",
          massBattle: { ...coneMb, shape: "circle" },
        },
      },
      casterLevel: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain("massBattle.rangeCategory");
  });
});

describe("spellRangeFeet — the standard range categories (CRB p.213)", () => {
  it("close: 25 ft, +5 ft per two full caster levels", () => {
    expect(spellRangeFeet("close", 1)).toBe(25);
    expect(spellRangeFeet("close", 2)).toBe(30);
    expect(spellRangeFeet("close", 3)).toBe(30); // "every two FULL caster levels"
    expect(spellRangeFeet("close", 5)).toBe(35);
    expect(spellRangeFeet("close", 10)).toBe(50);
  });

  it("medium: 100 ft + 10 ft per caster level", () => {
    expect(spellRangeFeet("medium", 1)).toBe(110);
    expect(spellRangeFeet("medium", 5)).toBe(150);
    expect(spellRangeFeet("medium", 10)).toBe(200);
  });

  it("long: 400 ft + 40 ft per caster level", () => {
    expect(spellRangeFeet("long", 1)).toBe(440);
    expect(spellRangeFeet("long", 5)).toBe(600);
    expect(spellRangeFeet("long", 10)).toBe(800);
  });
});
