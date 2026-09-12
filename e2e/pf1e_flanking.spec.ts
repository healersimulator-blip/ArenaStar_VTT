import { expect, test } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

/**
 * P04 — flanking through the real bundled scene (AoN ID 183, CRB p.197).
 *
 * `pf1ePlaceTokens` submits real create ops (`gm.client.submit` → oplog → store)
 * and authors each creature's size onto a real actor document, so every fact
 * asserted here travels scene grid → `tokenCells` → `deriveFromDocuments` →
 * `threatenedCells` → `resolveFlanking` inside the shipped bundle. The default
 * scene's grid is `{ size: 100, distance: 5, units: "ft" }`, so cell (10, 8) is
 * the square whose centre is world (1050, 850).
 *
 * The fixtures are the same hand-drawn ones the unit suites pin, and the shapes
 * are the point: opposite borders and opposite corners flank, a crowd on one
 * side does not, and a creature that threatens nothing cannot help.
 */

interface ThreatEntry {
  tokenId: string;
  size: string;
  cells: string[];
  reachSquares: number;
  reachFt: number;
  threatensNothing: boolean;
  cannotFlank: boolean;
  threatKeys: string[];
  threatRects: number;
}

interface ThreatResult {
  ok: boolean;
  cellSize: number;
  feetPerCell: number;
  tokens: number;
  entries: ThreatEntry[];
  flanking: Array<{
    attackerId: string;
    defenderId: string;
    helperIds: string[];
    bonus: number;
  }>;
  flankedTokenIds: string[];
  issues: Array<{ field: string; message: string }>;
  defaults: Array<{ field: string; message: string }>;
}

type Placed = Array<{ id: string; col: number; row: number; size?: string }>;

const place = (page: import("@playwright/test").Page, tokens: Placed) =>
  page.evaluate((t) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | { pf1ePlaceTokens: (x: unknown) => { ok: boolean; placed: number } }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1ePlaceTokens(t);
  }, tokens);

const threat = (
  page: import("@playwright/test").Page,
  spec: Record<string, unknown> = {},
) =>
  page.evaluate((s) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      { pf1eThreat: (x: unknown) => ThreatResult } | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eThreat(s);
  }, spec);

const entryOf = (res: ThreatResult, id: string): ThreatEntry => {
  const found = res.entries.find((e) => e.tokenId === id);
  if (!found) throw new Error(`no threat entry for ${id}`);
  return found;
};

/** Boot, place tokens through the op path, and wait for the store to catch up. */
async function sceneWith(
  page: import("@playwright/test").Page,
  tokens: Placed,
): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const placed = await place(page, tokens);
  expect(placed.ok).toBe(true);
  await expect
    .poll(async () => hostCall<number>(page, "tokenCount"))
    .toBe(tokens.length);
}

test.describe("PF1e flanking (§9/P6 P04)", () => {
  test("resolves opposite-border flanking from the live scene and its actor documents", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await sceneWith(page, [
      { id: "d", col: 10, row: 8 },
      { id: "e", col: 11, row: 8 },
      { id: "w", col: 9, row: 8 },
    ]);

    const res = await threat(page);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    // Scene metadata flowed through, not hardcoded 5-ft squares.
    expect(res.cellSize).toBe(100);
    expect(res.feetPerCell).toBe(5);
    expect(res.tokens).toBe(3);

    // The size came off the authored actor document via deriveFromDocuments.
    const defender = entryOf(res, "d");
    expect(defender.size).toBe("Medium");
    expect(defender.cells).toEqual(["10,8"]);
    expect(defender.reachFt).toBe(5);
    expect(defender.threatKeys).toHaveLength(8); // AoN 102: the eight neighbours
    expect(defender.threatRects).toBe(8); // the overlay draw list

    expect(res.flanking).toEqual([
      { attackerId: "e", defenderId: "d", helperIds: ["w"], bonus: 2 },
      { attackerId: "w", defenderId: "d", helperIds: ["e"], bonus: 2 },
    ]);
    expect(res.flankedTokenIds).toEqual(["d"]);
    // Hostility is a scene fact, so the model names the assumption it made.
    expect(res.defaults.map((d) => d.field)).toContain("isEnemy");
    expect(errors).toEqual([]);
  });

  test("a crowd on one side is in contact and flanks nobody", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "d", col: 10, row: 8 },
      { id: "e1", col: 11, row: 8 },
      { id: "e2", col: 12, row: 9 },
      { id: "e3", col: 11, row: 7 },
    ]);
    const res = await threat(page);
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(4);
    // All three reach the defender's square …
    expect(entryOf(res, "e1").threatKeys).toContain("10,8");
    // … and none of them earns the bonus: contact is not an opposite border.
    expect(res.flanking).toEqual([]);
    expect(res.flankedTokenIds).toEqual([]);
  });

  test("a Large creature takes four squares and is flanked across its space", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "L", col: 10, row: 8, size: "Large" },
      { id: "e", col: 12, row: 8 },
      { id: "w", col: 9, row: 9 },
    ]);
    const res = await threat(page);
    expect(res.ok).toBe(true);

    const ogre = entryOf(res, "L");
    expect(ogre.size).toBe("Large");
    expect(ogre.cells).toEqual(["10,8", "11,8", "10,9", "11,9"]);
    expect(ogre.reachSquares).toBe(2); // Table 8-4: Large (tall) 10 ft
    expect(ogre.reachFt).toBe(10);
    expect(ogre.threatKeys).toHaveLength(28); // P02's pinned figure
    expect(ogre.cannotFlank).toBe(false);

    expect(res.flanking).toEqual([
      { attackerId: "e", defenderId: "L", helperIds: ["w"], bonus: 2 },
      { attackerId: "w", defenderId: "L", helperIds: ["e"], bonus: 2 },
    ]);
  });

  test("a Tiny creature threatens nothing, cannot flank, and cannot help", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "d", col: 10, row: 8 },
      { id: "e", col: 11, row: 8 },
      { id: "t", col: 9, row: 8, size: "Tiny" },
    ]);
    const res = await threat(page);
    expect(res.ok).toBe(true);

    const tiny = entryOf(res, "t");
    expect(tiny.size).toBe("Tiny");
    expect(tiny.reachSquares).toBe(0);
    expect(tiny.reachFt).toBe(0);
    expect(tiny.threatensNothing).toBe(true);
    expect(tiny.cannotFlank).toBe(true);
    expect(tiny.threatKeys).toEqual([]);

    // The Medium attacker east has the Tiny thing on the defender's far border,
    // but a creature with no reach cannot help anybody flank (AoN 183/179).
    expect(res.flanking).toEqual([]);
  });

  test("hostility is the caller's fact: a friend on the far border confers nothing", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "d", col: 10, row: 8 },
      { id: "e", col: 11, row: 8 },
      { id: "w", col: 9, row: 8 },
    ]);

    const anyone = await threat(page);
    expect(anyone.flanking).toHaveLength(2);

    // Only "e" is an enemy of the defender, so "w" is not "another enemy
    // character or creature" and the bonus disappears with it.
    const enemies = await threat(page, { enemiesOf: { d: ["e"] } });
    expect(enemies.ok).toBe(true);
    expect(enemies.flanking).toEqual([]);
    expect(enemies.flankedTokenIds).toEqual([]);
    // The assumption is no longer being made, so it is no longer announced.
    expect(enemies.defaults.map((d) => d.field)).not.toContain("isEnemy");
    // Geometry is untouched by the hostility filter: the threat sets are the same.
    expect(enemies.entries.map((e) => e.threatKeys.length)).toEqual(
      anyone.entries.map((e) => e.threatKeys.length),
    );
  });
});
