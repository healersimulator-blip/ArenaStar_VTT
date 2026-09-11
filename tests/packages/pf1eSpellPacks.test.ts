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
  parsePackSpellOrder,
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
});
