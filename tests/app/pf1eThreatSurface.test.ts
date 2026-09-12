import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { installE2eHook, type AppSurface } from "../../src/app/e2eHook";
import { IDBFactory } from "fake-indexeddb";
import { boot, settle } from "./fakes";

/**
 * P04 (D-181) — the app surface `e2e/pf1e_flanking.spec.ts` drives, exercised
 * here against a real booted `HostApp`: `pf1ePlaceTokens` submits real create
 * ops through `gm.client.submit` (oplog → store → scene), and `pf1eThreat`
 * resolves the resulting scene through `pf1eThreatModel`, reading each
 * creature's size back off its **authored actor document** with
 * `deriveFromDocuments` rather than off the call's arguments.
 *
 * Same code path as the browser spec minus the bundle, so the fixtures and the
 * expected facts are identical: opposite borders flank, a crowd on one side does
 * not, a Large creature is flanked across its four squares, a Tiny creature
 * threatens nothing and helps nobody, and hostility is the caller's fact.
 */

async function surface(): Promise<{
  app: Awaited<ReturnType<typeof boot>>;
  s: AppSurface;
}> {
  // A pristine IDB per test: `bootHostApp` without a world id resumes the most
  // recent world, so a shared database would carry the previous test's tokens
  // into this one's scene.
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  const app = await boot();
  await installE2eHook(app);
  const s = (globalThis as { __vttE2E?: { app: AppSurface | null } }).__vttE2E
    ?.app;
  if (!s) throw new Error("app surface missing");
  return { app, s };
}

type Placed = Array<{ id: string; col: number; row: number; size?: string }>;

type ThreatReport = ReturnType<AppSurface["pf1eThreat"]>;

function entryOf(res: ThreatReport, id: string) {
  const found = res.entries.find((e) => e.tokenId === id);
  if (!found) throw new Error(`no threat entry for ${id}`);
  return found;
}

async function sceneWith(tokens: Placed): Promise<AppSurface> {
  const { s } = await surfaceWith(tokens);
  return s;
}

async function surfaceWith(tokens: Placed) {
  const booted = await surface();
  const placed = booted.s.pf1ePlaceTokens(tokens);
  expect(placed.ok).toBe(true);
  // The default scene's grid is 100 world units per 5-ft square (hostBoot).
  expect(placed.cellSize).toBe(100);
  await settle(6);
  expect(booted.s.tokenCount()).toBe(tokens.length);
  return booted;
}

describe("P04 — pf1ePlaceTokens/pf1eThreat on a real booted host app", () => {
  test("tokens land through the op path, and flanking is resolved from the scene", async () => {
    const s = await sceneWith([
      { id: "d", col: 10, row: 8 },
      { id: "e", col: 11, row: 8 },
      { id: "w", col: 9, row: 8 },
    ]);

    const res = s.pf1eThreat();
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.cellSize).toBe(100);
    expect(res.feetPerCell).toBe(5);
    expect(res.tokens).toBe(3);

    const defender = entryOf(res, "d");
    expect(defender.size).toBe("Medium");
    expect(defender.cells).toEqual(["10,8"]);
    expect(defender.reachFt).toBe(5);
    expect(defender.threatKeys).toHaveLength(8);
    expect(defender.threatRects).toBe(8);

    expect(res.flanking).toEqual([
      { attackerId: "e", defenderId: "d", helperIds: ["w"], bonus: 2 },
      { attackerId: "w", defenderId: "d", helperIds: ["e"], bonus: 2 },
    ]);
    expect(res.flankedTokenIds).toEqual(["d"]);
    expect(res.defaults.map((d) => d.field)).toContain("isEnemy");
  });

  test("a crowd on one side is in contact and flanks nobody", async () => {
    const s = await sceneWith([
      { id: "d", col: 10, row: 8 },
      { id: "e1", col: 11, row: 8 },
      { id: "e2", col: 12, row: 9 },
      { id: "e3", col: 11, row: 7 },
    ]);
    const res = s.pf1eThreat();
    expect(res.entries).toHaveLength(4);
    expect(entryOf(res, "e1").threatKeys).toContain("10,8");
    expect(res.flanking).toEqual([]);
    expect(res.flankedTokenIds).toEqual([]);
  });

  test("a Large creature takes four squares and is flanked across its space", async () => {
    const s = await sceneWith([
      { id: "L", col: 10, row: 8, size: "Large" },
      { id: "e", col: 12, row: 8 },
      { id: "w", col: 9, row: 9 },
    ]);
    const res = s.pf1eThreat();
    const ogre = entryOf(res, "L");
    expect(ogre.size).toBe("Large");
    expect(ogre.cells).toEqual(["10,8", "11,8", "10,9", "11,9"]);
    expect(ogre.reachSquares).toBe(2);
    expect(ogre.reachFt).toBe(10);
    expect(ogre.threatKeys).toHaveLength(28);
    expect(ogre.cannotFlank).toBe(false);
    expect(res.flanking).toEqual([
      { attackerId: "e", defenderId: "L", helperIds: ["w"], bonus: 2 },
      { attackerId: "w", defenderId: "L", helperIds: ["e"], bonus: 2 },
    ]);
  });

  test("a Tiny creature threatens nothing, cannot flank, and cannot help", async () => {
    const s = await sceneWith([
      { id: "d", col: 10, row: 8 },
      { id: "e", col: 11, row: 8 },
      { id: "t", col: 9, row: 8, size: "Tiny" },
    ]);
    const res = s.pf1eThreat();
    const tiny = entryOf(res, "t");
    expect(tiny.size).toBe("Tiny");
    expect(tiny.reachSquares).toBe(0);
    expect(tiny.reachFt).toBe(0);
    expect(tiny.threatensNothing).toBe(true);
    expect(tiny.cannotFlank).toBe(true);
    expect(tiny.threatKeys).toEqual([]);
    expect(res.flanking).toEqual([]);
  });

  test("hostility is the caller's fact: a friend on the far border confers nothing", async () => {
    const s = await sceneWith([
      { id: "d", col: 10, row: 8 },
      { id: "e", col: 11, row: 8 },
      { id: "w", col: 9, row: 8 },
    ]);
    expect(s.pf1eThreat().flanking).toHaveLength(2);

    const enemies = s.pf1eThreat({ enemiesOf: { d: ["e"] } });
    expect(enemies.ok).toBe(true);
    expect(enemies.flanking).toEqual([]);
    expect(enemies.flankedTokenIds).toEqual([]);
    expect(enemies.defaults.map((d) => d.field)).not.toContain("isEnemy");
    // The filter narrows enmity, never geometry.
    expect(enemies.entries.map((e) => e.threatKeys.length)).toEqual(
      s.pf1eThreat().entries.map((e) => e.threatKeys.length),
    );
  });

  test("the reach comes off the authored actor document, and follows it when it changes", async () => {
    const { app, s } = await surfaceWith([{ id: "d", col: 10, row: 8 }]);
    const before = s.pf1eThreat();
    expect(entryOf(before, "d").size).toBe("Medium");
    expect(entryOf(before, "d").reachFt).toBe(5);
    expect(entryOf(before, "d").threatKeys).toHaveLength(8);
    // Nothing was assumed: the placement authored a real actor and linked it.
    expect(before.defaults.map((d) => d.field)).not.toContain("token:d");

    // Re-author the size through the same op path a sheet edit would use.
    app.gm.client.submit([
      {
        kind: "update",
        ref: { coll: "actors", id: "a-d" },
        diff: { "system.pf1e.size": "Huge" },
      },
    ]);
    await settle(6);
    const after = s.pf1eThreat();
    expect(entryOf(after, "d").size).toBe("Huge");
    expect(entryOf(after, "d").reachSquares).toBe(3); // Table 8-4: Huge 15 ft
    expect(entryOf(after, "d").reachFt).toBe(15);
    // The token's drawn rect still decides the space it occupies — reach grew,
    // the footprint did not, because nothing resized the token.
    expect(entryOf(after, "d").cells).toEqual(entryOf(before, "d").cells);
    expect(entryOf(after, "d").threatKeys.length).toBeGreaterThan(8);
  });
});
