import { expect, test } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

/**
 * P06/D-185 — attacks of opportunity through the real bundled scene (AoN Rules ID 102,
 * CRB p.180; withdraw AoN 151, CRB p.188).
 *
 * `pf1eMoveToken` submits a real `tokens` **update** op — the same op the canvas
 * controller's drag emits — and `pf1eOpportunity` resolves the verdict through the shipped
 * bundle: scene grid → `tokenCells` → `cellsAlongSegment` → each token's `threatenedCells`
 * → `interrupts.queueMovementAoOs`. Creature size is read off the authored actor document
 * (`deriveFromDocuments`), so reach decides the queue from real data rather than from the
 * spec's arguments. The default scene's grid is `{ size: 100, distance: 5, units: "ft" }`,
 * so cell (col, row) is the square whose centre is world `(col*100 + 50, row*100 + 50)`.
 *
 * This is the browser half of the same fixtures the unit suites pin; it is **not** run in
 * this sandbox (no Chromium — D-119/D-182 recorded the environment), so it is authored to
 * be executable rather than reported as passing.
 */

interface OpportunityResult {
  ok: boolean;
  refusal: string | null;
  path: string[];
  squaresLeft: string[];
  leftRects: number;
  reactors: Array<{
    tokenId: string;
    cell: string;
    used: number | null;
    max: number | null;
    line: string;
  }>;
  refused: Array<{ tokenId: string; reason: string }>;
  queued: Array<{
    reactorId: string;
    provokerId: string;
    kind: string;
    square: { x: number; y: number } | null;
  }>;
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

const moveToken = (
  page: import("@playwright/test").Page,
  spec: { tokenId: string; col: number; row: number },
) =>
  page.evaluate((s) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | { pf1eMoveToken: (x: unknown) => { ok: boolean; x: number; y: number } }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eMoveToken(s);
  }, spec);

const opportunity = (
  page: import("@playwright/test").Page,
  spec: Record<string, unknown>,
) =>
  page.evaluate((s) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      { pf1eOpportunity: (x: unknown) => OpportunityResult } | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eOpportunity(s);
  }, spec);

interface ResolveResult {
  ok: boolean;
  needsEncounter: boolean;
  error: string | null;
  queued: Array<{
    reactorId: string;
    provokerId: string;
    kind: string;
    square: { x: number; y: number } | null;
  }>;
  entries: Array<{
    reactorId: string;
    provokerId: string;
    attackName: string;
    outcome: string;
    attackTotal: number;
    defenseAc: number;
    damage: number;
    hpBefore: number;
    hpAfter: number;
    used: number | null;
    max: number | null;
    ledgerError: string | null;
    line: string;
  }>;
  skipped: Array<{ reactorId: string; provokerId: string; reason: string }>;
}

/** The melee line the reactor needs: an attack of opportunity is a single melee attack. */
const FIGHTER_STATS = {
  abilities: { str: 16, dex: 14, con: 14 },
  baseAttack: 6,
  hp: 30,
  hpMax: 30,
  armorClass: { armor: 5 },
  attacks: [
    {
      name: "Longsword",
      damageDice: "1d8",
      damageBonus: 3,
      damageType: "slashing",
      critThreatMin: 20,
      critMultiplier: 2,
    },
  ],
};

const GOBLIN_STATS = {
  abilities: { dex: 14, con: 12 },
  hp: 12,
  hpMax: 12,
  armorClass: { armor: 4 },
};

const tacticalEncounter = (
  page: import("@playwright/test").Page,
  spec: Record<string, unknown>,
) =>
  page.evaluate((s) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | {
          pf1eTacticalEncounter: (x: unknown) => {
            ok: boolean;
            combatants: number;
          };
        }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eTacticalEncounter(s);
  }, spec);

const resolveOpportunity = (
  page: import("@playwright/test").Page,
  spec: Record<string, unknown>,
) =>
  page.evaluate((s) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | { pf1eOpportunityResolve: (x: unknown) => Promise<ResolveResult> }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eOpportunityResolve(s);
  }, spec);

const combatantState = (
  page: import("@playwright/test").Page,
  tokenId: string,
) =>
  page.evaluate((id) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | {
          pf1eCombatantState: (x: string) => {
            aooUsed: number;
            aooMax: number;
            acted: boolean;
            hp: number | null;
          } | null;
        }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eCombatantState(id);
  }, tokenId);

const setWorldSetting = (
  page: import("@playwright/test").Page,
  spec: { key: string; value: string | number | boolean | null },
) =>
  page.evaluate((s) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | {
          pf1eSetWorldSetting: (x: unknown) => {
            ok: boolean;
            error: string | null;
            ops: number;
          };
        }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eSetWorldSetting(s);
  }, spec);

const worldSettings = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      { pf1eWorldSettings: () => Record<string, unknown> } | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eWorldSettings();
  });

/** The prompt's read-only view (the App installs it; the spec clicks the real buttons). */
const reactionPrompt = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | {
          reaction: () => {
            sceneId: string;
            combatId: string | null;
            settled: boolean;
            rows: Array<{ reactorId: string; cell: string; line: string }>;
          } | null;
        }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.reaction();
  });

/**
 * A real canvas drag: the stage's default camera is `fitRect(2000×1500)` (the scene rect a
 * fresh world has), so a world point projects to a canvas point the same way the sheet
 * specs already rely on.
 */
async function dragToken(
  page: import("@playwright/test").Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const canvas = page.locator(".canvas-host canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const viewport = await canvas.evaluate((el) => ({
    width: el.clientWidth,
    height: el.clientHeight,
  }));
  const { fitRect, worldToScreen } = await import("../src/canvas/camera");
  const camera = fitRect(
    { x: 0, y: 0, width: 2000, height: 1500 },
    viewport,
    24,
  );
  const a = worldToScreen(camera, from.x, from.y);
  const b = worldToScreen(camera, to.x, to.y);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 8 });
  await page.mouse.up();
}

/** Cell centre in world units — the default grid is 100 units per square. */
const centre = (col: number, row: number): { x: number; y: number } => ({
  x: col * 100 + 50,
  y: row * 100 + 50,
});

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

test.describe("PF1e attacks of opportunity (§9/P6 P06)", () => {
  test("moving out of a threatened square queues one opportunity, in the square left", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await sceneWith(page, [
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);

    const res = await opportunity(page, {
      moverId: "goblin",
      toCol: 3,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(res.ok).toBe(true);
    expect(res.refusal).toBeNull();
    expect(res.path).toEqual(["0,0", "1,0", "2,0", "3,0"]);
    expect(res.squaresLeft).toEqual(["0,0", "1,0", "2,0"]);
    expect(res.leftRects).toBe(3); // the highlight draw list, one rect per left square
    // AoN 102's one-opportunity sentence: one entry, from the first square it threatened.
    expect(res.queued).toEqual([
      {
        reactorId: "fighter",
        provokerId: "goblin",
        kind: "move-out",
        square: { x: 200, y: 0 },
      },
    ]);
    expect(res.reactors).toHaveLength(1);
    expect(res.reactors[0]?.cell).toBe("2,0");
    expect(res.reactors[0]?.line).toBe(
      "fighter may strike goblin as it leaves (2,0)",
    );
    expect(res.defaults).toEqual([]); // hostility stated, so nothing was assumed
    expect(errors).toEqual([]);
  });

  test("a real token move commits through the op path, and the verdict follows the scene", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);

    const moved = await moveToken(page, { tokenId: "goblin", col: 1, row: 0 });
    expect(moved).toEqual({ ok: true, x: 150, y: 50 });
    await expect
      .poll(async () =>
        hostCall<{ x: number; y: number } | null>(page, "tokenPos"),
      )
      .toEqual({ x: 150, y: 50 });

    // The verdict for the next leg is read off the committed position.
    const res = await opportunity(page, {
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(res.squaresLeft).toEqual(["1,0", "2,0", "3,0"]);
    expect(res.queued[0]?.square).toEqual({ x: 200, y: 0 });
  });

  test("a spent ledger refuses, and a withdraw exempts only the start square", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "wizard", col: 0, row: 0 },
      { id: "west", col: -1, row: 0 },
    ]);

    const normal = await opportunity(page, {
      moverId: "wizard",
      toCol: 2,
      toRow: 0,
      enemiesOf: { wizard: ["west"] },
    });
    expect(normal.queued.map((q) => q.reactorId)).toEqual(["west"]);

    const withdrawing = await opportunity(page, {
      moverId: "wizard",
      toCol: 2,
      toRow: 0,
      withdraw: true,
      enemiesOf: { wizard: ["west"] },
    });
    // CRB p.188: the start square is not threatened, so the western enemy loses its attack.
    expect(withdrawing.squaresLeft).toEqual(["1,0"]);
    expect(withdrawing.queued).toEqual([]);

    const spent = await opportunity(page, {
      moverId: "wizard",
      toCol: 2,
      toRow: 0,
      ledgers: { west: { used: 1, max: 1 } },
      enemiesOf: { wizard: ["west"] },
    });
    expect(spent.queued).toEqual([]);
    expect(spent.refused).toEqual([
      { tokenId: "west", reason: "no opportunities left (1/1)" },
    ]);
    expect(spent.reactors[0]?.line).toContain(
      "forgoes the attack of opportunity",
    );
  });

  test("reach comes from the authored actor document, so size decides the queue", async ({
    page,
  }) => {
    // Same walk, same square: a Large creature's 2-square reach reaches (2,0) from (4,0),
    // a Medium creature's 1-square reach does not.
    await sceneWith(page, [
      { id: "goblin", col: 0, row: 0 },
      { id: "guard", col: 4, row: 0, size: "Medium" },
    ]);
    const medium = await opportunity(page, {
      moverId: "goblin",
      toCol: 3,
      toRow: 0,
      enemiesOf: { goblin: ["guard"] },
    });
    expect(medium.queued).toEqual([]);

    await sceneWith(page, [
      { id: "goblin", col: 0, row: 0 },
      { id: "ogre", col: 4, row: 0, size: "Large" },
    ]);
    const large = await opportunity(page, {
      moverId: "goblin",
      toCol: 3,
      toRow: 0,
      enemiesOf: { goblin: ["ogre"] },
    });
    expect(large.queued.map((q) => q.reactorId)).toEqual(["ogre"]);
    expect(large.reactors[0]?.cell).toBe("2,0");
  });

  test("a missing mover is refused by name", async ({ page }) => {
    await sceneWith(page, [{ id: "goblin", col: 0, row: 0 }]);
    const res = await opportunity(page, {
      moverId: "ghost",
      toCol: 2,
      toRow: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe('no token "ghost" on this scene');
    expect(res.queued).toEqual([]);
    expect(res.issues).toEqual([]);
  });
});

test.describe("PF1e auto-resolved attacks of opportunity (D-186)", () => {
  test("the world option is on by default, replicates through an op, and can be turned off", async ({
    page,
  }) => {
    await sceneWith(page, [{ id: "goblin", col: 0, row: 0 }]);
    // Never touched: absent means on (the option's polarity is `!== false`).
    expect(await worldSettings(page)).not.toHaveProperty("autoResolveAoos");

    const off = await setWorldSetting(page, {
      key: "autoResolveAoos",
      value: false,
    });
    expect(off).toMatchObject({ ok: true, error: null, ops: 1 });
    // The op echoed through the replicated settings document every replica reads.
    await expect
      .poll(async () => (await worldSettings(page)).autoResolveAoos)
      .toBe(false);

    const on = await setWorldSetting(page, {
      key: "autoResolveAoos",
      value: true,
    });
    expect(on.ok).toBe(true);
    await expect
      .poll(async () => (await worldSettings(page)).autoResolveAoos)
      .toBe(true);
  });

  test("the queued opportunity is resolved through the host: hp moves and the ledger is spent", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);
    const encounter = await tacticalEncounter(page, {
      stats: { goblin: GOBLIN_STATS, fighter: FIGHTER_STATS },
      initiatives: { goblin: 5, fighter: 20 },
      combatantFlags: {
        goblin: { acted: true },
        fighter: { acted: true, aooMax: 1 },
      },
    });
    expect(encounter).toMatchObject({ ok: true, combatants: 2 });
    await expect
      .poll(async () => (await combatantState(page, "goblin"))?.hp)
      .toBe(12);

    // The walk (0,0) → (4,0) leaves (0,0)…(3,0); the fighter at (3,1) threatens (2,0).
    // The attack resolves *before* the mover leaves that square, and the move is the
    // caller's to commit afterwards — this surface never moves the token.
    const res = await resolveOpportunity(page, {
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(res.needsEncounter).toBe(false);
    expect(res.error).toBeNull();
    expect(res.queued).toEqual([
      {
        reactorId: "fighter",
        provokerId: "goblin",
        kind: "move-out",
        square: { x: 200, y: 0 },
      },
    ]);
    expect(res.entries).toHaveLength(1);
    const entry = res.entries[0];
    expect(entry?.attackName).toBe("Longsword — attack of opportunity");
    expect(entry?.defenseAc).toBe(16);
    expect(entry?.used).toBe(1);
    expect(entry?.max).toBe(1);
    expect(entry?.ledgerError).toBeNull();
    // Real host rolls: the die is not scripted, so what is asserted is the invariant the
    // rules fix — the damage reported is the hit points the write took off.
    expect(entry?.damage).toBe((entry?.hpBefore ?? 0) - (entry?.hpAfter ?? 0));
    expect(entry?.line).toContain("1/1 opportunities this round");

    // Both writes landed as real ops: the provoker's hit points and the reactor's ledger.
    await expect
      .poll(async () => (await combatantState(page, "goblin"))?.hp)
      .toBe(entry?.hpAfter);
    const reactor = await combatantState(page, "fighter");
    expect(reactor).toMatchObject({ aooUsed: 1, aooMax: 1 });
    // …and the public card is the sheet's own, labelled with the opportunity.
    const cards = await page.evaluate(() => {
      const e2e = (globalThis as { __vttE2E?: Record<string, unknown> })
        .__vttE2E;
      const app = e2e?.app as
        | {
            pf1eCardsContaining: (x: string) => {
              count: number;
              first: string | null;
            };
          }
        | undefined;
      if (!app) throw new Error("app surface missing");
      return app.pf1eCardsContaining("attack of opportunity");
    });
    expect(cards.count).toBe(1);
    expect(cards.first).toContain("Longsword — attack of opportunity");
  });

  test("a spent ledger refuses in the seat's own words, and no encounter refuses by name", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);
    // No encounter yet: the budget is per round and per combatant, so nothing is spent.
    const noCombat = await resolveOpportunity(page, {
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(noCombat.needsEncounter).toBe(true);
    expect(noCombat.entries).toEqual([]);
    expect(noCombat.skipped[0]?.reason).toContain("no encounter");

    await tacticalEncounter(page, {
      stats: { goblin: GOBLIN_STATS, fighter: FIGHTER_STATS },
      initiatives: { goblin: 5, fighter: 20 },
      combatantFlags: {
        goblin: { acted: true },
        fighter: { aooUsed: 1, aooMax: 1 },
      },
    });
    const res = await resolveOpportunity(page, {
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(res.entries[0]?.ledgerError).toBe(
      "Attack of opportunity refused: no opportunities left (1/1).",
    );
    expect(res.entries[0]?.used).toBeNull();
    expect(res.entries[0]?.line).toContain("the ledger was not written:");
  });

  test("a ranged-only reactor forgoes the opportunity instead of attacking", async ({
    page,
  }) => {
    await sceneWith(page, [
      { id: "goblin", col: 0, row: 0 },
      { id: "archer", col: 3, row: 1 },
    ]);
    await tacticalEncounter(page, {
      stats: {
        goblin: GOBLIN_STATS,
        archer: {
          abilities: { dex: 16 },
          baseAttack: 4,
          hp: 20,
          hpMax: 20,
          attacks: [
            {
              name: "Longbow",
              ranged: true,
              damageDice: "1d8",
              damageBonus: 3,
              damageType: "piercing",
              critThreatMin: 20,
              critMultiplier: 3,
            },
          ],
        },
      },
      initiatives: { goblin: 5, archer: 20 },
      combatantFlags: {
        goblin: { acted: true },
        archer: { acted: true, aooMax: 1 },
      },
    });
    const res = await resolveOpportunity(page, {
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["archer"] },
    });
    expect(res.entries).toEqual([]);
    expect(res.skipped[0]?.reason).toContain("no melee attack line");
    // The rejection is not a spend: the archer's budget is untouched.
    expect(await combatantState(page, "archer")).toMatchObject({ aooUsed: 0 });
  });
});

test.describe("PF1e manual reaction prompt (D-187)", () => {
  /** The world option off, the scene authored, and an encounter to spend against. */
  async function manualScene(
    page: import("@playwright/test").Page,
  ): Promise<void> {
    await sceneWith(page, [
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);
    const off = await setWorldSetting(page, {
      key: "autoResolveAoos",
      value: false,
    });
    expect(off).toMatchObject({ ok: true, ops: 1 });
    await tacticalEncounter(page, {
      stats: { goblin: GOBLIN_STATS, fighter: FIGHTER_STATS },
      initiatives: { goblin: 5, fighter: 20 },
      combatantFlags: {
        goblin: { acted: true },
        fighter: { acted: true, aooMax: 1 },
      },
    });
    // The setting must be visible to the app before the drag reads it.
    await expect
      .poll(async () => (await worldSettings(page)).autoResolveAoos)
      .toBe(false);
  }

  test("a drag that provokes is held and asks; striking spends the ledger and then moves", async ({
    page,
  }) => {
    await manualScene(page);
    // Drag the goblin from (0,0) to (4,0): the walk leaves (0,0)…(3,0) and the fighter at
    // (3,1) threatens (2,0), so the move must not commit until the question is answered.
    await dragToken(page, centre(0, 0), centre(4, 0));

    const prompt = await reactionPrompt(page);
    expect(prompt).not.toBeNull();
    expect(prompt?.combatId).toBe("combat-1");
    expect(prompt?.settled).toBe(false);
    expect(prompt?.rows).toEqual([
      {
        reactorId: "fighter",
        cell: "2,0",
        line: expect.stringContaining("fighter may strike goblin"),
        used: 0,
        max: 1,
        queued: 1,
      },
    ]);
    // Held: the token is still standing where it was.
    expect(
      await hostCall<{ x: number; y: number } | null>(page, "tokenPos"),
    ).toEqual({ x: 50, y: 50 });
    await expect(page.locator("[data-reaction-prompt]")).toBeVisible();
    await expect(page.locator('[data-reaction-row="fighter"]')).toContainText(
      "may strike",
    );

    // The GM strikes: the attack resolves through the host, the card is public, the ledger
    // is spent — and only then does the move commit.
    await page.locator('[data-reaction-strike="fighter"]').click();
    await expect
      .poll(async () => (await combatantState(page, "fighter"))?.aooUsed)
      .toBe(1);
    await expect
      .poll(
        async () =>
          (await hostCall<{ x: number; y: number }>(page, "tokenPos")).x,
      )
      .toBe(450);
    expect(await reactionPrompt(page)).toBeNull();
    const card = await page.evaluate(() => {
      const e2e = (globalThis as { __vttE2E?: Record<string, unknown> })
        .__vttE2E;
      const app = e2e?.app as
        { pf1eCardsContaining: (x: string) => { count: number } } | undefined;
      if (!app) throw new Error("app surface missing");
      return app.pf1eCardsContaining("attack of opportunity");
    });
    expect(card.count).toBe(1);
  });

  test("'let it pass' answers for the table, spends nothing, and still moves the token", async ({
    page,
  }) => {
    await manualScene(page);
    await dragToken(page, centre(0, 0), centre(4, 0));
    expect(await reactionPrompt(page)).not.toBeNull();

    await page.locator("[data-reaction-forgo]").click();
    await expect(page.locator("[data-reaction-prompt]")).toHaveCount(0);
    // The opportunity was declined: no attack, no ledger write — the move goes through.
    expect((await combatantState(page, "fighter"))?.aooUsed).toBe(0);
    await expect
      .poll(
        async () =>
          (await hostCall<{ x: number; y: number }>(page, "tokenPos")).x,
      )
      .toBe(450);
    const notifications = await hostCall<Array<{ message: string }>>(
      page,
      "notifications",
    );
    expect(
      notifications.some((n) =>
        n.message.includes("forgoes the attack of opportunity"),
      ),
    ).toBe(true);
  });

  test("'stay put' drops the held move entirely", async ({ page }) => {
    await manualScene(page);
    await dragToken(page, centre(0, 0), centre(4, 0));
    await page.locator("[data-reaction-cancel]").click();
    await expect(page.locator("[data-reaction-prompt]")).toHaveCount(0);
    // Nothing happened: the token kept its square, no attack, no spend.
    expect(
      await hostCall<{ x: number; y: number } | null>(page, "tokenPos"),
    ).toEqual({ x: 50, y: 50 });
    expect((await combatantState(page, "fighter"))?.aooUsed).toBe(0);
  });
});
