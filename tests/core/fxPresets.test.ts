/**
 * D-310 (SQ-12) — the preset payload: the look, bounded and validated by the very same
 * sequence rules a timeline obeys, and loaded under fresh section ids so the same preset
 * can be used twice in one timeline.
 */
import { describe, expect, test } from "vitest";
import { FX_PRESET_LIMITS, fxPresetDocumentError, fxPresetSections, validateFxPreset } from "../../src/core/fxPresets";
import type { MacroDocument } from "../../src/core/documents";
import type { FxSection } from "../../src/core/fx";

const asset = "a".repeat(64);

const image = (patch: Partial<FxSection> = {}): FxSection =>
  ({ id: "fx-one", kind: "image", assetId: asset, startMs: 0, durationMs: 1_000,
    at: { kind: "point", x: 10, y: 10 }, ...patch } as FxSection);
const sound = (patch: Partial<FxSection> = {}): FxSection =>
  ({ id: "fx-two", kind: "sound", assetId: asset, startMs: 500, durationMs: 800, volume: 0.7, ...patch } as FxSection);
const preset = (...sections: FxSection[]) => ({ version: 1 as const, sections });

function macro(patch: Partial<MacroDocument> = {}): MacroDocument {
  return { _id: "p-1", type: "macro", name: "Fireball look", command: "", kind: "fxPreset",
    ownership: { default: 0 }, flags: {}, system: {}, preset: preset(image()),
    ...patch } as MacroDocument;
}

describe("FX preset payload (D-310)", () => {
  test("a bundle of sections validates, and each one keeps every sequence rule", () => {
    const ok = validateFxPreset(preset(image(), sound()));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.preset.sections).toHaveLength(2);
    // The validator is the sequence validator: a section the host would refuse in a
    // timeline is refused here, so a preset can never be a way around a section rule.
    const bad = validateFxPreset(preset(image({ durationMs: -1 })));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("1");
    // A positional sound without its reach is the D-309 rule, applied to a preset too.
    const noRadius = validateFxPreset(preset(sound({ at: { kind: "point", x: 5, y: 5 } } as never)));
    expect(noRadius.ok).toBe(false);
    if (!noRadius.ok) expect(noRadius.error).toContain("radius");
  });

  test("a failure names the section that caused it, not just the rule", () => {
    const second = sound({ id: "fx-two", durationMs: 0 } as never);
    const checked = validateFxPreset(preset(image(), second));
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error).toContain("preset section 2 (fx-two)");
      expect(checked.error).toContain("zero-duration");
    }
    // A fault that belongs to no single section is reported as the bundle's own.
    const duplicated = validateFxPreset(preset(image(), sound({ id: "fx-one" })));
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.error).toMatch(/^FX preset: /);
  });

  test("the bundle's own shape is bounded: version, section count, unknown fields", () => {
    expect(validateFxPreset({ version: 2, sections: [image()] }).ok).toBe(false);
    expect(validateFxPreset({ version: 1, sections: [] }).ok).toBe(false);
    expect(validateFxPreset({ version: 1, sections: new Array(9).fill(null).map((_, i) => image({ id: `fx-${i}` })) }).ok).toBe(false);
    expect(validateFxPreset({ version: 1, sections: [image()], persistent: true }).ok).toBe(false);
    expect(validateFxPreset(null).ok).toBe(false);
    // Eight is the ceiling, and it is inclusive — a preset is a look, not a timeline.
    const eight = validateFxPreset(preset(...new Array(FX_PRESET_LIMITS.sections.max).fill(null)
      .map((_, i) => image({ id: `fx-${i}` }))));
    expect(eight.ok).toBe(true);
  });

  test("loading mints fresh ids, so one preset can be used twice in a timeline", () => {
    const checked = validateFxPreset(preset(image(), sound()));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    let n = 0;
    const sections = fxPresetSections(checked.preset, () => `new-${n++}`);
    expect(sections.map((section) => section.id)).toEqual(["new-0", "new-1"]);
    expect(sections.every((section) => section.id !== "fx-one")).toBe(true);
    // Shallow copies: mutating the loaded section must not reach back into the stored one.
    expect(sections[0]).not.toBe(checked.preset.sections[0]);
    expect(checked.preset.sections[0]?.id).toBe("fx-one");
    // A mint that repeats itself still cannot produce a duplicate: the loader loops.
    let same = 0;
    const again = fxPresetSections(checked.preset, () => `dup-${same++ % 2}`);
    expect(new Set(again.map((section) => section.id)).size).toBe(2);
  });

  test("a preset macro is one kind of thing: name bounded, no other payload smuggled in", () => {
    expect(fxPresetDocumentError(macro())).toBeNull();
    expect(fxPresetDocumentError(macro({ name: "" }))).toContain("name");
    expect(fxPresetDocumentError(macro({ name: "x".repeat(FX_PRESET_LIMITS.name + 1) }))).toContain("name");
    expect(fxPresetDocumentError(macro({ name: "bad\u0007name" }))).toContain("name");
    // A crafted document that is a preset *and* a timeline would be a payload no branch
    // of the validator looks at — the run would use the sequence, the preset the file.
    const smuggled = macro({ sequence: { version: 1, sections: [image()] } });
    expect(fxPresetDocumentError(smuggled)).toContain("not sequence");
    expect(fxPresetDocumentError(macro({
      scriptState: { version: 1, runs: [] } as never } as Partial<MacroDocument>))).toContain("scriptState");
    expect(fxPresetDocumentError(macro({ preset: { version: 1, sections: [] } }))).toContain("1–8");
  });
});
