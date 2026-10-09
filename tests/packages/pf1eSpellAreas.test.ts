/**
 * D-408 (S3) — persisted PF1e spell areas.
 *
 * The record the host derives post-commit from an area cast card: closed validation, a defensive
 * flags reader, live/expired filtering on the world clock, difficult-terrain cells for the
 * movement planner, and whole-record diffs (FlatDiff cannot create missing intermediates).
 */
import { describe, expect, test } from "vitest";
import {
  MAX_PF1E_SPELL_AREAS_PER_SCENE,
  difficultCellsFromSpellAreas,
  expiredPF1eSpellAreaIds,
  livePF1eSpellAreas,
  spellAreaAddDiff,
  spellAreaRemoveDiff,
  spellAreasFromFlags,
  validatePF1eSpellArea,
  type PF1eSpellArea,
} from "../../src/packages/pf1e/spellAreas";

const area = (patch: Partial<PF1eSpellArea> = {}): PF1eSpellArea => ({
  id: "spellarea-card-one",
  effectId: "entangle",
  actionId: "card-one",
  sceneId: "scene-one",
  casterActorId: "druid",
  dc: 15,
  casterLevel: 3,
  spellLevel: 1,
  origin: { x: 500, y: 500 },
  radiusFt: 40,
  startsAt: 1_000,
  endsAt: 181_000,
  difficultTerrain: true,
  ...patch,
});

const GRID = { size: 50, distance: 5, units: "ft" };

describe("persisted PF1e spell areas (D-408)", () => {
  test("the validator accepts a full record and refuses malformed ones by name", () => {
    expect(validatePF1eSpellArea(area()).ok).toBe(true);
    const refuse = (patch: Record<string, unknown>, detail: string): void => {
      const checked = validatePF1eSpellArea({ ...structuredClone(area()), ...patch });
      expect(checked.ok, detail).toBe(false);
      if (!checked.ok) expect(checked.error).toContain(detail);
    };
    refuse({ spare: 1 }, "carries no spare field");
    refuse({ id: "has space" }, "needs id of 1–128");
    refuse({ dc: 0 }, "dc must be a whole number from 1 to 99");
    refuse({ dc: 100 }, "dc must be a whole number from 1 to 99");
    refuse({ casterLevel: 0 }, "casterLevel must be 1–100");
    refuse({ spellLevel: 10 }, "spellLevel must be 0–9");
    refuse({ origin: { x: 1 } }, "origin must be a finite { x, y } point");
    refuse({ radiusFt: 4 }, "radiusFt must be 5–500");
    refuse({ startsAt: 2000, endsAt: 2000 }, "needs 0 ≤ startsAt < endsAt");
    refuse({ startsAt: 3000, endsAt: 2000 }, "needs 0 ≤ startsAt < endsAt");
    refuse({ difficultTerrain: "yes" }, "difficultTerrain must be a boolean");
  });

  test("the flags reader is defensive: garbage reads as empty, never throws", () => {
    expect(spellAreasFromFlags(null)).toEqual({});
    expect(spellAreasFromFlags({})).toEqual({});
    expect(spellAreasFromFlags({ pf1e: null })).toEqual({});
    expect(spellAreasFromFlags({ pf1e: { spellAreas: null } })).toEqual({});
    expect(spellAreasFromFlags({ pf1e: { spellAreas: [area()] } })).toEqual({});
    // A malformed entry is skipped; a key/id mismatch is skipped, never trusted.
    const flags = { pf1e: { spellAreas: {
      "spellarea-card-one": area(),
      broken: { id: "broken", dc: "high" },
      mismatched: area({ id: "spellarea-other" }),
    } } };
    expect(spellAreasFromFlags(flags)).toEqual({ "spellarea-card-one": area() });
  });

  test("live/expired filtering runs on the world clock", () => {
    const areas = {
      live: area({ id: "live", startsAt: 1_000, endsAt: 2_000 }),
      future: area({ id: "future", startsAt: 5_000, endsAt: 6_000 }),
      spent: area({ id: "spent", startsAt: 1_000, endsAt: 1_500 }),
    };
    expect(livePF1eSpellAreas(areas, 1_500).map((entry) => entry.id)).toEqual(["live"]);
    expect(livePF1eSpellAreas(areas, 2_000).map((entry) => entry.id)).toEqual([]);
    expect(expiredPF1eSpellAreaIds(areas, 1_500)).toEqual(["spent"]);
    expect(expiredPF1eSpellAreaIds(areas, 999)).toEqual([]);
  });

  test("a live difficult spread contributes its cells; expired, calm or unreadable areas contribute none", () => {
    const areas = { "spellarea-card-one": area() };
    const cells = difficultCellsFromSpellAreas(areas, { grid: GRID, nowMs: 1_500 });
    expect(cells.length).toBeGreaterThan(0);
    const keys = new Set(cells.map((cell) => `${String(cell.col)},${String(cell.row)}`));
    // The intersection (500, 500) at 50 px/cell touches the four cells around (10, 10).
    for (const key of ["9,9", "9,10", "10,9", "10,10"]) expect(keys.has(key), key).toBe(true);
    expect(keys.has("0,0")).toBe(false);
    // Expired, non-difficult and unreadable-grid areas price no square at ×2.
    expect(difficultCellsFromSpellAreas(areas, { grid: GRID, nowMs: 181_000 })).toEqual([]);
    expect(difficultCellsFromSpellAreas(
      { "spellarea-card-one": area({ difficultTerrain: false }) }, { grid: GRID, nowMs: 1_500 },
    )).toEqual([]);
    expect(difficultCellsFromSpellAreas(
      areas, { grid: { size: 0, distance: 5, units: "ft" }, nowMs: 1_500 },
    )).toEqual([]);
    // Two overlapping spreads union their cells without duplicates.
    const twin = { ...areas, "spellarea-card-two": area({ id: "spellarea-card-two", actionId: "card-two" }) };
    const union = difficultCellsFromSpellAreas(twin, { grid: GRID, nowMs: 1_500 });
    expect(union).toHaveLength(cells.length);
  });

  test("add writes the record (creating flags.pf1e when absent) and refuses a full scene", () => {
    const added = spellAreaAddDiff({}, area());
    expect(added.ok).toBe(true);
    if (added.ok) expect(added.value).toEqual({ "flags.pf1e": { spellAreas: { [area().id]: area() } } });
    const existing = { pf1e: { difficultCells: [{ col: 1, row: 2 }], spellAreas: {} } };
    const added2 = spellAreaAddDiff(existing, area());
    expect(added2.ok).toBe(true);
    if (added2.ok) expect(added2.value).toEqual({ "flags.pf1e.spellAreas": { [area().id]: area() } });
    const full: Record<string, PF1eSpellArea> = {};
    for (let index = 0; index < MAX_PF1E_SPELL_AREAS_PER_SCENE; index += 1)
      full[`spellarea-${String(index)}`] = area({ id: `spellarea-${String(index)}`, actionId: `card-${String(index)}` });
    const refused = spellAreaAddDiff({ pf1e: { spellAreas: full } }, area());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("already holds");
    // Re-deriving an area that is already there is idempotent, not a second write.
    const same = spellAreaAddDiff({ pf1e: { spellAreas: full } },
      area({ id: "spellarea-0", actionId: "card-0" }));
    expect(same.ok).toBe(true);
  });

  test("remove drops exactly the named ids, and is a null no-op when nothing would change", () => {
    const flags = { pf1e: { spellAreas: {
      keep: area({ id: "keep", actionId: "card-keep" }),
      drop: area({ id: "drop", actionId: "card-drop" }),
    } } };
    expect(spellAreaRemoveDiff(flags, ["drop", "ghost"])).toEqual({
      "flags.pf1e.spellAreas": { keep: area({ id: "keep", actionId: "card-keep" }) },
    });
    expect(spellAreaRemoveDiff(flags, ["ghost"])).toBeNull();
    expect(spellAreaRemoveDiff({}, ["drop"])).toBeNull();
  });
});
