import { describe, expect, test } from "vitest";
import type { ActorDocument, Json } from "../../src/core/documents";
import { applyDiff } from "../../src/core/diff";
import { parsePF1eActorSystem } from "../../src/packages/pf1e/actor";
import { normalizePF1eSystem } from "../../src/packages/pf1e/statBlock";
import {
  acRevision,
  emptyAcDraft,
  previewAcConversion,
  type AcPreview,
} from "../../src/ui/sheets/pf1eAcConversion";
import { pf1eSheetView, pf1eDetailEdit } from "../../src/ui/sheets/pf1eSheetModel";
const owner = { id: "p", role: "PLAYER" as const };
const components = { armor: "5", shield: "0", natural: "0", dodge: "0", misc: "0", maxDex: "" };
function actor(extra: Record<string, Json> = {}): ActorDocument {
  return {
    _id: "hero",
    type: "actor",
    name: "Hero",
    ownership: { default: 2, p: 3 },
    flags: {},
    system: {
      pf1e: {
        abilities: { dex: 16 },
        ac: 22,
        touchAc: 16,
        flatFootedAc: 17,
        weapon: { notes: "keep" },
        ...extra,
      },
    },
    items: [],
    effects: [],
  };
}
function apply(a: ActorDocument, preview: AcPreview): ActorDocument {
  expect(preview.error).toBeNull();
  const op = preview.ops[0];
  if (!op || op.kind !== "update") throw new Error("Expected an update");
  const result = applyDiff(a, op.diff);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
describe("explicit tactical AC source conversion", () => {
  test("preview is non-mutating, makes no component guesses and retains published sources", () => {
    const a = actor({
      armor: { checkPenalty: -2, custom: "keep" },
      armorClass: { custom: "keep" },
    });
    // Existing components prevent legacy totals from being normalized without explicit mode.
    (a.system.pf1e as Record<string, Json>).acMode = "published";
    const before = structuredClone(a);
    expect(
      previewAcConversion(a, owner, {
        mode: "components",
        draft: emptyAcDraft(),
        expected: acRevision(a),
      }).error,
    ).not.toBeNull();
    const preview = previewAcConversion(a, owner, {
      mode: "components",
      draft: components,
      expected: acRevision(a),
    });
    expect(preview.before).toEqual({ normal: 22, touch: 16, flatFooted: 17 });
    expect(preview.after).toEqual({ normal: 18, touch: 13, flatFooted: 15 });
    expect(a).toEqual(before);
    const converted = apply(a, preview);
    expect(pf1eSheetView(converted).derived.acFromTotals).toBe(false);
    expect(converted.system.pf1e).toMatchObject({
      ac: 22,
      touchAc: 16,
      flatFootedAc: 17,
      weapon: { notes: "keep" },
      armor: { checkPenalty: -2, custom: "keep", armorBonus: 5 },
      armorClass: { custom: "keep", armor: 5 },
      acMode: "components",
    });
    expect(
      pf1eDetailEdit(converted, owner, { kind: "armor", field: "armor.armorBonus", raw: "7" })
        .error,
    ).toBeNull();
    const restored = apply(
      converted,
      previewAcConversion(converted, owner, {
        mode: "published",
        expected: acRevision(converted),
      }),
    );
    expect(pf1eSheetView(restored).derived.ac).toEqual(preview.before);
  });
  test("legacy and canonical totals both round-trip; no derived AC is ever saved", () => {
    for (const a of [
      actor(),
      {
        ...actor(),
        system: {
          pf1e: { abilities: { dex: 16 }, acTotals: { normal: 22, touch: 16, flatFooted: 17 } },
        },
      },
    ]) {
      const result = previewAcConversion(a, owner, {
        mode: "components",
        draft: components,
        expected: acRevision(a),
      });
      const converted = apply(a, result);
      expect(pf1eSheetView(converted).derived.ac.normal).toBe(18);
      const normalized = normalizePF1eSystem(
        (converted.system.pf1e ?? {}) as Record<string, Json>,
      ).system;
      expect(normalizePF1eSystem(normalized).system).toEqual(normalized);
      expect(result.ops[0]).toMatchObject({ diff: { "system.pf1e.acMode": "components" } });
      expect(JSON.stringify(result.ops)).not.toContain('"system.pf1e.acTotals"');
    }
  });
  test("active effects apply identically to both preview sides and are not baked into components", () => {
    const a = actor();
    a.effects = [
      {
        _id: "buff",
        type: "effect",
        name: "Ward",
        ownership: { default: 0 },
        system: {},
        changes: [],
        disabled: false,
        flags: { pf1e: { mods: [{ key: "ac", type: "morale", value: 2 }] } },
      },
    ];
    const preview = previewAcConversion(a, owner, {
      mode: "components",
      draft: components,
      expected: acRevision(a),
    });
    expect(preview.before?.normal).toBe(24);
    expect(preview.after?.normal).toBe(20);
    const next = apply(a, preview);
    next.effects = [];
    expect(pf1eSheetView(next).derived.ac.normal).toBe(18);
  });
  test("stale previews, missing originals, invalid input and non-owners cannot submit", () => {
    const a = actor();
    const expected = acRevision(a);
    const changed = { ...a, name: "Changed" };
    expect(
      previewAcConversion(changed, owner, { mode: "components", draft: components, expected })
        .ops,
    ).toEqual([]);
    for (const user of [null, { id: "other", role: "PLAYER" as const }])
      expect(previewAcConversion(a, user, { mode: "published", expected }).ops).toEqual([]);
    for (const text of ["", "NaN", "1.5", "-1", "1e99"])
      expect(
        previewAcConversion(a, owner, {
          mode: "components",
          draft: { ...components, armor: text },
          expected,
        }).ops,
      ).toEqual([]);
    const plain = { ...a, system: { pf1e: {} } };
    expect(
      previewAcConversion(plain, owner, { mode: "published", expected: acRevision(plain) }).ops,
    ).toEqual([]);
    expect(parsePF1eActorSystem({ acMode: "auto" }).ok).toBe(false);
    const malformed = actor({ armor: "imported opaque source" });
    expect(
      previewAcConversion(malformed, owner, {
        mode: "components",
        draft: components,
        expected: acRevision(malformed),
      }).ops,
    ).toEqual([]);
  });
});
