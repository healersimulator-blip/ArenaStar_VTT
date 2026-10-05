/**
 * D-407 — the tactical spell-effect catalogue.
 *
 * The pack-mirror pin lives in `pf1eContentPacks.test.ts`; this file pins the engine half: the
 * validator refuses the shapes that would make a delivery unanswerable, and the single predicate the
 * client producer and the host re-check share means the same row outcome.
 */
import { describe, expect, test } from "vitest";
import {
  PF1E_SPELL_EFFECTS,
  PF1E_SPELL_EFFECT_ERRORS,
  PF1E_SPELL_EFFECT_MAX_CONDITIONS,
  PF1E_SPELL_EFFECT_ROWS,
  PF1E_SPELL_EFFECT_VERSION,
  pf1eSpellEffectById,
  pf1eSpellEffectByName,
  pf1eSpellEffectLanded,
  validatePF1eSpellEffect,
} from "../../src/packages/pf1e/spellEffects";
import type { PF1eSpellEffect } from "../../src/packages/pf1e/spellEffects";

const entangle: PF1eSpellEffect = {
  id: "entangle",
  version: PF1E_SPELL_EFFECT_VERSION,
  name: "Entangle",
  source: { title: "PRPG Core Rulebook p.278 (Entangle)", citation: "Reflex partial; failure entangles." },
  save: { type: "ref", severity: "negates" },
  conditions: ["Entangled"],
};

describe("the authored tactical spell-effect catalogue (D-407)", () => {
  test("every shipped row validates, and the catalogue is the entangle profile", () => {
    expect(PF1E_SPELL_EFFECT_ERRORS).toEqual([]);
    expect(PF1E_SPELL_EFFECTS).toHaveLength(1);
    const row = PF1E_SPELL_EFFECTS[0];
    expect(row).toMatchObject({ id: entangle.id, version: entangle.version, name: entangle.name,
      save: entangle.save, conditions: entangle.conditions });
    // The citation is the rules receipt, not decoration: it must say what the save does, and name
    // the printed half it does not model.
    expect(row?.source.title).toBe(entangle.source.title);
    expect(row?.source.citation).toContain("Reflex");
    expect(row?.source.citation).toContain("automationNote");
    expect(row?.source.url).toContain("aonprd.com");
    // The rows are the unvalidated source; the catalogue is what consumers may trust.
    expect(PF1E_SPELL_EFFECT_ROWS).toHaveLength(PF1E_SPELL_EFFECTS.length);
  });

  test("lookup is exact (a version is optional, a wrong one is null) and by-name is case-insensitive", () => {
    expect(pf1eSpellEffectById("entangle")?.name).toBe("Entangle");
    expect(pf1eSpellEffectById("entangle", 1)?.name).toBe("Entangle");
    expect(pf1eSpellEffectById("entangle", 2)).toBeNull();
    expect(pf1eSpellEffectById("Entangled")).toBeNull();
    expect(pf1eSpellEffectByName("  eNtAnGlE ")?.id).toBe("entangle");
    expect(pf1eSpellEffectByName("wish")).toBeNull();
  });

  test("the landed predicate is the save's shape, not the caller's optimism", () => {
    expect(pf1eSpellEffectLanded(entangle, "failedSave")).toBe(true);
    for (const outcome of ["saved", "resisted", "affected", "hit", "miss", "pending", "skipped"])
      expect(pf1eSpellEffectLanded(entangle, outcome), outcome).toBe(false);
    // A save-less effect lands on the affected row, and only there.
    const noSave = { ...entangle, save: null };
    expect(pf1eSpellEffectLanded(noSave, "affected")).toBe(true);
    expect(pf1eSpellEffectLanded(noSave, "failedSave")).toBe(false);
    expect(pf1eSpellEffectLanded(noSave, "saved")).toBe(false);
  });

  test("the validator refuses a stray key, a bad save, a foreign condition name and a repeat", () => {
    const refuse = (patch: Record<string, unknown>, detail: string): void => {
      const checked = validatePF1eSpellEffect({ ...structuredClone(entangle), ...patch });
      expect(checked.ok, detail).toBe(false);
      if (!checked.ok) expect(checked.error).toContain(detail);
    };
    refuse({ duration: "1 min./level" }, "carries no duration field");
    refuse({ id: "has space" }, "needs an id");
    refuse({ version: 2 }, "version must be 1");
    refuse({ name: "" }, "needs a name");
    refuse({ source: { title: "Book", citation: "" } }, "source with a title and citation");
    refuse({ save: { type: "reflex", severity: "negates" } }, "save must be null or");
    // "partial" is print-accurate for Entangle and deliberately unauthorable: the engine cannot
    // implement a lesser condition outcome yet, and a row must not promise one (plan S4).
    refuse({ save: { type: "ref", severity: "partial" } }, "save must be null or");
    refuse({ save: { type: "ref", severity: "negates", extra: 1 } }, "save must be null or");
    refuse({ conditions: [] }, `names 1–${String(PF1E_SPELL_EFFECT_MAX_CONDITIONS)} conditions`);
    refuse({ conditions: ["Entangled", "Entangled"] }, "repeats condition Entangled");
    refuse({ conditions: ["Reticulated"] }, "is not a PF1e condition");
    refuse({ conditions: Array.from({ length: PF1E_SPELL_EFFECT_MAX_CONDITIONS + 1 }, () => "Prone") },
      `names 1–${String(PF1E_SPELL_EFFECT_MAX_CONDITIONS)} conditions`);
    // A canonical spelling is accepted and normalized to the library's name.
    const lower = validatePF1eSpellEffect({ ...structuredClone(entangle), conditions: ["entangled"] });
    expect(lower.ok).toBe(true);
    if (lower.ok) expect(lower.value.conditions).toEqual(["Entangled"]);
  });
});
