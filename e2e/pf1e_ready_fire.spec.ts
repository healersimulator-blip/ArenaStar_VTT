/**
 * P07/D-195 — a fired readied action **resolves** through the sheet's own attack flow (browser).
 * D-194's tracker spec proves the reorder; this spec proves the resolution the fired note now
 * actually performs: the readied combatant's primary melee attack rolls against the triggerer,
 * hit points move, a card lands labelled "— readied action", and the ready is spent — all against
 * a real booted host (no scripted dice), so what is asserted is the invariant the rules fix
 * (damage = hpBefore − hpAfter), the same way the D-186 auto-resolved AoO spec does.
 */
import { expect, test, type Page } from "@playwright/test";
import { entry, waitForSurface } from "./lib";

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

const ARCHER_STATS = {
  abilities: { dex: 16, con: 12 },
  baseAttack: 4,
  hp: 20,
  hpMax: 20,
  armorClass: { armor: 3 },
  attacks: [
    {
      name: "Longbow",
      damageDice: "1d8",
      damageBonus: 3,
      damageType: "piercing",
      critThreatMin: 20,
      critMultiplier: 3,
      ranged: true,
    },
  ],
};

const WIZARD_STATS = {
  abilities: { dex: 14, con: 12 },
  hp: 12,
  hpMax: 12,
  armorClass: { armor: 4 },
};

const place = (
  page: Page,
  tokens: Array<{ id: string; col: number; row: number }>,
) =>
  page.evaluate((t) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | { pf1ePlaceTokens: (x: unknown) => { ok: boolean; placed: number } }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1ePlaceTokens(t);
  }, tokens);

const tacticalEncounter = (page: Page, spec: Record<string, unknown>) =>
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

interface ReadyFireResult {
  ok: boolean;
  error: string | null;
  lines: string[];
  damage: number;
  resolved: boolean;
  initiative: number | null;
  readyCleared: boolean;
}

const readyFire = (page: Page, spec: Record<string, unknown>) =>
  page.evaluate((s) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | { pf1eReadyFire: (x: unknown) => Promise<ReadyFireResult> }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eReadyFire(s);
  }, spec);

const combatantState = (page: Page, tokenId: string) =>
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

const cardsContaining = (page: Page, needle: string) =>
  page.evaluate((n) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | {
          pf1eCardsContaining: (x: string) => {
            count: number;
            first: string | null;
          };
        }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eCardsContaining(n);
  }, needle);

/** Place two tokens, author their stats, and start the encounter — the D-186 setup shape. */
async function readyScene(
  page: Page,
  stats: Record<string, unknown>,
): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  expect(
    await place(page, [
      { id: "fighter", col: 1, row: 0 },
      { id: "wizard", col: 0, row: 0 },
    ]),
  ).toMatchObject({ ok: true, placed: 2 });
  expect(
    await tacticalEncounter(page, {
      stats,
      initiatives: { fighter: 20, wizard: 5 },
      combatantFlags: { fighter: { acted: true }, wizard: { acted: true } },
    }),
  ).toMatchObject({ ok: true, combatants: 2 });
}

test("a fired readied attack rolls, moves hit points, spends the ready, and reorders", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await readyScene(page, { fighter: FIGHTER_STATS, wizard: WIZARD_STATS });

  const fired = await readyFire(page, {
    readiedTokenId: "fighter",
    triggererTokenId: "wizard",
  });
  expect(fired).toMatchObject({
    ok: true,
    error: null,
    resolved: true,
    readyCleared: true,
  });
  // The fighter moves to the wizard's initiative (5) + 1.
  expect(fired.initiative).toBe(6);
  // The line names the readied primary melee attack through the normal defence.
  expect(fired.lines).toHaveLength(1);
  expect(fired.lines[0]).toMatch(
    /^fighter \(actor\) (hits|misses|critically hits) wizard \(actor\) for \d+ \(\d+ vs AC 16\)$/,
  );
  // Real host rolls: the damage reported is the hit points the write took off, so the
  // wizard's HP lands at `12 − damage` once the write echoes (the D-186 AoO poll shape).
  await expect
    .poll(async () => (await combatantState(page, "wizard"))?.hp)
    .toBe(12 - fired.damage);
  // The public card is the sheet's own, labelled with the readied action.
  expect((await cardsContaining(page, "readied action")).count).toBeGreaterThanOrEqual(
    1,
  );

  expect(errors).toEqual([]);
});

test("a ranged-only readied combatant reorders and is handed off by name, not given a melee strike", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await readyScene(page, { fighter: ARCHER_STATS, wizard: WIZARD_STATS });

  const fired = await readyFire(page, {
    readiedTokenId: "fighter",
    triggererTokenId: "wizard",
  });
  expect(fired).toMatchObject({
    ok: true,
    error: null,
    resolved: false,
    readyCleared: true,
    damage: 0,
  });
  expect(fired.initiative).toBe(6);
  expect(fired.lines[0]).toContain("ranged-only");
  expect(errors).toEqual([]);
});
