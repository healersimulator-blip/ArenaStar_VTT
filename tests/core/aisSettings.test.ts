/** D-476: pure settings helpers — coercion, document shape, write ops, commit detection. */
import { describe, expect, test } from "vitest";
import type { AisSettingDeclaration } from "../../src/core/automationInterconnect";
import {
  aisDeviceSettingsScope,
  aisSettingsDocId,
  aisSettingsDocTouched,
  aisSettingsPackageOf,
  aisWorldSettingOps,
  aisWorldSettingValues,
  coerceAisSettingValue,
} from "../../src/core/aisSettings";
import type { SettingsDocument } from "../../src/core/documents";
import { applyDiff } from "../../src/core/diff";
import { worldSettingsFrom } from "../../src/core/worldSettings";

const declarations: AisSettingDeclaration[] = [
  { key: "radius", scope: "world", type: "number", label: "Radius", default: 20, min: 0, max: 60, step: 5 },
  { key: "mode", scope: "world", type: "choice", label: "Mode", default: "soft", choices: [{ value: "soft", label: "Soft" }, { value: "hard", label: "Hard" }] },
  { key: "sound", scope: "device", type: "boolean", label: "Sound", default: true },
  { key: "note", scope: "world", type: "string", label: "Note", default: "", maxLength: 8 },
];

describe("AIS settings helpers", () => {
  test("document ids and scopes are stable and reversible", () => {
    expect(aisSettingsDocId("pf1e-torch")).toBe("ais-settings:pf1e-torch");
    expect(aisSettingsPackageOf("ais-settings:pf1e-torch")).toBe("pf1e-torch");
    expect(aisSettingsPackageOf("world-settings")).toBeNull();
    expect(aisSettingsPackageOf("ais-settings:")).toBeNull();
    expect(aisDeviceSettingsScope("w1", "pf1e-torch")).toBe("ais-settings:w1:pf1e-torch");
  });

  test("coercion follows the declaration, including steps, lengths and control characters", () => {
    const [radius, mode, sound, note] = declarations as [AisSettingDeclaration, AisSettingDeclaration, AisSettingDeclaration, AisSettingDeclaration];
    expect(coerceAisSettingValue(radius, 25)).toEqual({ ok: true, value: 25 });
    expect(coerceAisSettingValue(radius, 26).ok).toBe(false);
    expect(coerceAisSettingValue(radius, -5).ok).toBe(false);
    expect(coerceAisSettingValue(radius, "25").ok).toBe(false);
    expect(coerceAisSettingValue(radius, Number.NaN).ok).toBe(false);
    expect(coerceAisSettingValue(mode, "hard")).toEqual({ ok: true, value: "hard" });
    expect(coerceAisSettingValue(mode, "loud").ok).toBe(false);
    expect(coerceAisSettingValue(sound, false)).toEqual({ ok: true, value: false });
    expect(coerceAisSettingValue(sound, 0).ok).toBe(false);
    expect(coerceAisSettingValue(note, "12345678")).toEqual({ ok: true, value: "12345678" });
    expect(coerceAisSettingValue(note, "123456789").ok).toBe(false);
    expect(coerceAisSettingValue(note, "a\u0007b").ok).toBe(false);
    expect(coerceAisSettingValue(note, "a\nb")).toEqual({ ok: true, value: "a\nb" });
  });

  test("world values read only declared world keys and fall back to the default for stale or foreign data", () => {
    expect(aisWorldSettingValues(undefined, declarations)).toEqual({ radius: 20, mode: "soft", note: "" });
    const doc: SettingsDocument = {
      _id: "ais-settings:pf1e-torch", type: "settings", name: "x", ownership: { default: 1 }, system: {},
      flags: { ais: { packageId: "pf1e-torch", values: { radius: 35, mode: "loud", sound: false, extra: 1 } } },
    };
    // `mode: "loud"` no longer fits a newer declaration → default; `sound` is device scope → not read.
    expect(aisWorldSettingValues(doc, declarations)).toEqual({ radius: 35, mode: "soft", note: "" });
  });

  test("write ops create the GM-owned, player-readable document once and then patch one dotted key", () => {
    const create = aisWorldSettingOps(undefined, "pf1e-torch", "Torch", "radius", 30);
    expect(create).toEqual([{ kind: "create", coll: "settings", data: {
      _id: "ais-settings:pf1e-torch", type: "settings", name: "Torch settings", ownership: { default: 1 },
      flags: { ais: { packageId: "pf1e-torch", values: { radius: 30 } } }, system: {},
    } }]);
    const created = (create[0] as { data: SettingsDocument }).data;
    // The values live in flags: the core world-settings merge must not see them.
    expect(worldSettingsFrom([created])).toEqual({});
    const update = aisWorldSettingOps(created, "pf1e-torch", "Torch", "mode", "hard");
    expect(update).toEqual([{ kind: "update", ref: { coll: "settings", id: "ais-settings:pf1e-torch" }, diff: { "flags.ais.values.mode": "hard" } }]);
    const patched = applyDiff(created, (update[0] as { diff: Record<string, unknown> }).diff as never);
    expect(patched.ok && aisWorldSettingValues(patched.value, declarations)).toEqual({ radius: 30, mode: "hard", note: "" });
    expect(aisWorldSettingOps(created, "pf1e-torch", "Torch", "radius", 30)).toEqual([]);
    // A document without the namespace (hand-authored) gets the whole namespace written at once.
    const foreign: SettingsDocument = { ...created, flags: {} };
    expect(aisWorldSettingOps(foreign, "pf1e-torch", "Torch", "radius", 5)).toEqual([{
      kind: "update", ref: { coll: "settings", id: "ais-settings:pf1e-torch" },
      diff: { "flags.ais": { packageId: "pf1e-torch", values: { radius: 5 } } },
    }]);
  });

  test("commit detection matches only this module's document", () => {
    const ops = aisWorldSettingOps(undefined, "pf1e-torch", "Torch", "radius", 30);
    expect(aisSettingsDocTouched(ops, "pf1e-torch")).toBe(true);
    expect(aisSettingsDocTouched(ops, "other")).toBe(false);
    expect(aisSettingsDocTouched([{ kind: "update", ref: { coll: "settings", id: "world-settings" }, diff: { "system.clockSeconds": 6 } }], "pf1e-torch")).toBe(false);
    expect(aisSettingsDocTouched([{ kind: "delete", ref: { coll: "settings", id: "ais-settings:pf1e-torch" } }], "pf1e-torch")).toBe(true);
  });
});
