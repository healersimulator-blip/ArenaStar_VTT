/**
 * D-407 — the tactical spell-effect catalogue (v2: duration/area/range/difficultTerrain, D-408).
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
  pf1eSpellEffectDurationMs,
  pf1eSpellEffectLanded,
  pf1eSpellEffectRangeFt,
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
  conditionFxMacroId: "macro-entangled-vines",
  duration: { value: 1, unit: "minute", perLevel: true },
  area: { shape: "spread", radiusFt: 40 },
  range: { baseFt: 400, perLevelFt: 40 },
  difficultTerrain: true,
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
    expect(pf1eSpellEffectById("entangle", 2)?.name).toBe("Entangle");
    expect(pf1eSpellEffectById("entangle", 1)).toBeNull();
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
    refuse({ duration: "1 min./level" }, "duration must be { value: 1–1000, unit: round|minute, perLevel: boolean }");
    refuse({ duration: { value: 1, unit: "hour", perLevel: true } }, "duration must be { value");
    refuse({ duration: { value: 0, unit: "minute", perLevel: true } }, "duration must be { value");
    refuse({ area: { shape: "cone", radiusFt: 40 } }, "area must be { shape: \"spread\"");
    refuse({ area: { shape: "spread", radiusFt: 600 } }, "area must be { shape: \"spread\"");
    refuse({ range: { baseFt: 400, perLevelFt: 2.5 } }, "range must be { baseFt: 0–10000, perLevelFt: 0–1000 }");
    refuse({ difficultTerrain: "yes" }, "difficultTerrain must be a boolean");
    refuse({ id: "has space" }, "needs an id");
    refuse({ version: 1 }, "version must be 2");
    refuse({ name: "" }, "needs a name");
    refuse({ source: { title: "Book", citation: "" } }, "source with a title and citation");
    refuse({ save: { type: "reflex", severity: "negates" } }, "save must be null or");
    // "partial" is print-accurate for Entangle and deliberately unauthorable: the engine cannot
    // implement a lesser condition outcome yet, and a row must not promise one (plan S4).
    refuse({ save: { type: "ref", severity: "partial" } }, "save must be null or");
    refuse({ save: { type: "ref", severity: "negates", extra: 1 } }, "save must be null or");
    refuse({ conditions: [] }, `names 1–${String(PF1E_SPELL_EFFECT_MAX_CONDITIONS)} conditions`);
    refuse({ conditionFxMacroId: "not a document id" }, "condition FX macro id");
    refuse({ conditions: ["Entangled", "Entangled"] }, "repeats condition Entangled");
    refuse({ conditions: ["Reticulated"] }, "is not a PF1e condition");
    refuse({ conditions: Array.from({ length: PF1E_SPELL_EFFECT_MAX_CONDITIONS + 1 }, () => "Prone") },
      `names 1–${String(PF1E_SPELL_EFFECT_MAX_CONDITIONS)} conditions`);
    // A canonical spelling is accepted and normalized to the library's name.
    const lower = validatePF1eSpellEffect({ ...structuredClone(entangle), conditions: ["entangled"] });
    expect(lower.ok).toBe(true);
    if (lower.ok) expect(lower.value.conditions).toEqual(["Entangled"]);
    // The v2 area facts are optional: a single-target row omits them and still validates.
    const single = validatePF1eSpellEffect({
      ...structuredClone(entangle),
      duration: undefined, area: undefined, range: undefined, difficultTerrain: undefined,
    });
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.value.duration).toBeUndefined();
      expect(single.value.area).toBeUndefined();
      expect(single.value.range).toBeUndefined();
      expect(single.value.difficultTerrain).toBeUndefined();
    }
  });

  test("duration and range helpers transcribe the printed lines (D-408)", () => {
    const duration = entangle.duration;
    expect(duration).toBeDefined();
    if (!duration) return;
    // 1 min./level: a 1st-level caster holds the spread for one minute, a 5th for five.
    expect(pf1eSpellEffectDurationMs(duration, 1)).toBe(60_000);
    expect(pf1eSpellEffectDurationMs(duration, 5)).toBe(300_000);
    expect(pf1eSpellEffectDurationMs(duration, 0)).toBeNull();
    expect(pf1eSpellEffectDurationMs({ value: 2, unit: "round", perLevel: false }, 7)).toBe(12_000);
    const range = entangle.range;
    expect(range).toBeDefined();
    if (!range) return;
    // Long: 400 ft. + 40 ft./level.
    expect(pf1eSpellEffectRangeFt(range, 1)).toBe(440);
    expect(pf1eSpellEffectRangeFt(range, 6)).toBe(640);
    expect(pf1eSpellEffectRangeFt(range, 0)).toBeNull();
  });
});
