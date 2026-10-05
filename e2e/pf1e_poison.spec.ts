/**
 * D-406 poison riders, end to end through the real UI (plan Phase 6e).
 *
 * The delivering interaction is an ordinary attack from the sheet's own resolve flow, run by the
 * quickbar exactly as the table runs it; the poison is a **rider** on the landed row. The two
 * victim classes take the two host paths:
 *
 *  - a GM-owned victim: the host rolls the initial Fort save, attaches an `applied`/`resisted`
 *    rider and writes the course/effect in the same envelope; the GM's named Revert restores the
 *    ability damage and removes the rider.
 *  - a player-owned victim: the rider's save is a host pending roll, and the victim's own player
 *    rolls it from the card. Nothing lands until that roll does.
 *
 * Every assertion reads the **host replica** (`pf1eLastActionCard`, `pf1ePoisonState`,
 * `pf1eAbilityDamage`) or the real DOM (`[data-action-rider]`, `[data-rider-roll]`).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  manualFragment,
  playerCall,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

interface RiderRow {
  kind: string;
  label: string;
  state: string;
  save?: { saveType: string; dc: number | null; total: number | null; passed?: boolean };
}

interface ActionReadback {
  messageId: string;
  action: { targets: Array<{ outcome: string; riders?: RiderRow[] }> };
  pending: Record<string, unknown> | null;
}

interface CourseRow {
  id: string;
  profile: string;
  state: string;
  doses: number;
  nextSaveInSeconds: number | null;
  frequencyEndsInSeconds: number | null;
  cureProgress: number;
  cureRequired: number;
  consecutive: boolean;
}

interface PoisonReadback {
  courses: CourseRow[];
  delayPoison: { active: boolean; endsInSeconds: number | null };
  queuedExposures: number;
}

const lastAction = (page: Page): Promise<ActionReadback | null> =>
  hostCall<ActionReadback | null>(page, "pf1eLastActionCard");
const poisonState = (page: Page, actorId: string): Promise<PoisonReadback | null> =>
  surfaceCallArg<PoisonReadback | null>(page, "app", "pf1ePoisonState", actorId);
const abilityDamage = (page: Page, actorId: string): Promise<Record<string, number>> =>
  surfaceCallArg<Record<string, number>>(page, "app", "pf1eAbilityDamage", actorId);

const riderOf = (card: ActionReadback | null): RiderRow | null =>
  card?.action.targets[0]?.riders?.[0] ?? null;

/** Click a world point on a real canvas (the selection path the table uses). */
async function clickWorld(
  page: Page,
  at: { x: number; y: number },
  camera: { x: number; y: number; scale: number },
): Promise<void> {
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas not mounted");
  await page.mouse.click(
    box.x + (at.x - camera.x) * camera.scale,
    box.y + (at.y - camera.y) * camera.scale,
  );
}

/**
 * Run the sheet's coated attack from the GM's quickbar until it lands. A natural 1 is a real miss,
 * so the loop retries a bounded number of times rather than pretending d20s are scripted.
 */
async function coatedStrike(page: Page, targetActorId: string): Promise<void> {
  const slot = page.locator('[data-quickbar-slot="1"]');
  await expect(slot).toContainText("Venom fang");
  await page.locator("[data-quickbar-target]").selectOption(targetActorId);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await slot.click();
    const landed = await expect
      .poll(async () => (await lastAction(page))?.action.targets[0]?.outcome ?? null, {
        timeout: 8_000,
      })
      .toBe("hit")
      .then(() => true)
      .catch(() => false);
    if (!landed) continue;
    const rider = await expect
      .poll(async () => riderOf(await lastAction(page))?.kind ?? null, { timeout: 8_000 })
      .toBe("poison")
      .then(() => true)
      .catch(() => false);
    if (rider) return;
  }
  throw new Error("the coated strike never landed with a poison rider");
}

async function authorAttacker(page: Page): Promise<void> {
  const authored = await surfaceCallArg<{ ok: boolean; error: string | null }>(page, "app", "pf1eAuthorActor", {
    actorId: "a-hero",
    patch: {
      hp: 20,
      hpMax: 20,
      abilities: { str: 16, con: 12 },
      // +40: the strike lands unless the die itself says 1 (a natural 1 is an automatic miss).
      baseAttack: 40,
      attacks: [
        {
          name: "Venom fang",
          damageDice: "1d4",
          damageBonus: 2,
          damageType: "piercing",
          poisonId: "giant-octopus-poison",
        },
      ],
    },
  });
  expect(authored).toMatchObject({ ok: true });
}

/** Bind the coated attack to slot 1 through the quickbar's real controls. */
async function bindCoatedAttack(page: Page): Promise<void> {
  const bind = page.locator("[data-quickbar-bind]");
  await expect
    .poll(async () => (await bind.locator("option").allTextContents()).join("|"), { timeout: 20_000 })
    .toContain("Venom fang");
  await bind.selectOption("attack:0");
  await page.locator("[data-quickbar-slot-select]").selectOption("1");
  await page.click("[data-quickbar-bind-apply]");
  await expect(page.locator('[data-quickbar-slot="1"]')).toContainText("Venom fang");
}

test.describe("D-406 poison riders (plan Phase 6e)", () => {
  test("a coated strike delivers an applied rider; the GM Revert restores the ability damage", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    expect(
      await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1ePlaceTokens", [
        { id: "hero", col: 1, row: 1 },
        { id: "orc", col: 3, row: 1, owner: "gm" },
      ]),
    ).toMatchObject({ ok: true });
    await authorAttacker(page);
    // Con 1 ⇒ Fort −5, and the highest hostile roll is 15 against the octopus's DC 19: the host's
    // initial save fails deterministically, so the applied branch is the one under test.
    expect(
      await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
        actorId: "a-orc",
        patch: { hp: 40, hpMax: 40, abilities: { con: 1 } },
      }),
    ).toMatchObject({ ok: true });

    const camera = await hostCall<{ x: number; y: number; scale: number } | null>(page, "camera");
    if (!camera) throw new Error("no GM camera");
    await clickWorld(page, { x: 150, y: 150 }, camera);
    await expect(page.locator('[data-quickbar-actor="a-hero"]')).toBeVisible();
    await bindCoatedAttack(page);
    await coatedStrike(page, "a-orc");

    // ── the card is the delivery record: the rider row is rendered and host-owned ──
    await expect(page.locator('[data-action-rider="poison"]')).toBeVisible();
    await expect(page.locator('[data-action-rider="poison"]')).toHaveAttribute(
      "data-rider-state",
      "applied",
    );
    const card = await lastAction(page);
    if (!card) throw new Error("no action card");
    expect(riderOf(card)).toMatchObject({
      kind: "poison",
      label: "Giant octopus poison",
      state: "applied",
      save: { saveType: "fort", dc: 19, passed: false },
    });
    // The rider's applied outcome is not a reported client claim: the attack row carries host
    // evidence for its roll, and the poison row is host-written (the card's own provenance reads
    // `host` for the rider-bearing row only when a recognized adapter verified it; the poison
    // request is host-validated regardless, so the mechanics below are the assertion).

    // ── the course exists with its dose, cure wording and schedule, and the effect landed ──
    const poisoned = await poisonState(page, "a-orc");
    expect(poisoned?.courses).toHaveLength(1);
    expect(poisoned?.courses[0]).toMatchObject({
      profile: "Giant octopus poison",
      state: "active",
      doses: 1,
      cureRequired: 2,
      consecutive: false,
    });
    expect(poisoned?.courses[0]?.nextSaveInSeconds).not.toBeNull();
    const damage = await abilityDamage(page, "a-orc");
    expect(damage.str ?? 0).toBeGreaterThanOrEqual(1);

    // ── the named GM Revert is the receipt's inverse: no course, no ability damage ──
    const receipt = page
      .locator('[data-testid="action-revert-card"]')
      .filter({ hasText: "Poison exposure: Giant octopus poison" });
    await expect(receipt).toContainText("ready");
    await receipt.getByTestId("action-revert").click();
    await expect(receipt).toContainText("reverted");
    await expect.poll(async () => (await abilityDamage(page, "a-orc")).str ?? 0).toBe(0);
    await expect
      .poll(async () => (await poisonState(page, "a-orc"))?.courses.length ?? 0)
      .toBe(0);
    expect(errors).toEqual([]);
  });

  test("a player-owned victim's save waits for that player's own roll", async ({ browser }: { browser: Browser }) => {
    test.setTimeout(240_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const errors: string[] = [];
    for (const page of [host, player]) page.on("pageerror", (e) => errors.push(String(e)));

    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    expect(
      await surfaceCallArg<{ ok: boolean }>(host, "app", "pf1ePlaceTokens", [
        { id: "hero", col: 1, row: 1 },
      ]),
    ).toMatchObject({ ok: true });
    await authorAttacker(host);

    // ── a player joins; the victim is owned by that player alone ──
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    await player.goto(`${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue());
    await player.click("#answer-apply");
    await expect.poll(() => playerCall<number>(player, "tokenCount"), { timeout: 20_000 }).toBe(1);
    const playerId = await playerCall<string>(player, "userId");
    expect(playerId).toBeTruthy();

    expect(
      await surfaceCallArg<{ ok: boolean; placed: number }>(host, "app", "pf1ePlaceTokens", [
        { id: "victim", col: 3, row: 1, ownerUserId: playerId },
      ]),
    ).toMatchObject({ ok: true, placed: 1 });
    expect(
      await surfaceCallArg<{ ok: boolean }>(host, "app", "pf1eAuthorActor", {
        actorId: "a-victim",
        patch: { hp: 40, hpMax: 40, abilities: { con: 1 } },
      }),
    ).toMatchObject({ ok: true });
    await expect.poll(() => playerCall<number>(player, "tokenCount"), { timeout: 20_000 }).toBe(2);

    const camera = await hostCall<{ x: number; y: number; scale: number } | null>(host, "camera");
    if (!camera) throw new Error("no GM camera");
    await clickWorld(host, { x: 150, y: 150 }, camera);
    await expect(host.locator('[data-quickbar-actor="a-hero"]')).toBeVisible();
    await bindCoatedAttack(host);
    await coatedStrike(host, "a-victim");

    // ── the save is a host pending roll; nothing is applied before the victim rolls ──
    const card = await lastAction(host);
    if (!card) throw new Error("no action card");
    expect(riderOf(card)).toMatchObject({
      kind: "poison",
      state: "pending",
      save: { saveType: "fort", dc: 19, total: null, pendingRollId: expect.any(String) },
    });
    expect(card.pending).toMatchObject({ kind: "save", saveType: "fort", dc: 19, resolved: false });
    expect(await poisonState(host, "a-victim")).toBeNull();
    expect(await abilityDamage(host, "a-victim")).toEqual({});

    // ── the player rolls the rider save from the card, through the commit-reveal path ──
    await expect.poll(() => player.locator('[data-rider-roll]').count(), { timeout: 20_000 }).toBe(1);
    await player.locator('[data-rider-roll]').click();
    await expect
      .poll(async () => riderOf(await lastAction(host))?.state ?? null, { timeout: 20_000 })
      .toBe("applied");
    const resolved = await lastAction(host);
    expect(riderOf(resolved)?.save?.passed).toBe(false);
    expect(riderOf(resolved)?.save?.total).not.toBeNull();
    const poisoned = await poisonState(host, "a-victim");
    expect(poisoned?.courses[0]).toMatchObject({ profile: "Giant octopus poison", doses: 1 });
    expect((await abilityDamage(host, "a-victim")).str ?? 0).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await hostCtx.close();
    await playerCtx.close();
  });
});
