/**
 * §2.2 item 2 (G-10b, D-261) — the per-character quickbar, end to end through the real UI.
 *
 * A player binds one of *their character's* actions to a slot (the picker is built from the same
 * derivation the sheet reads), presses the slot, and the sheet's own flow runs: the damage slot
 * posts the attack line's damage as a public card — which the §2.2 item 3 verb then lands on the
 * selected token — and the attack slot resolves against the chosen target through
 * `resolveAttackFlow` (resolution card and hit points on the host replica). A slot that cannot run
 * says why, and the bindings themselves are document data: every assertion below reads the **host
 * replica** (`pf1eQuickbar`, `pf1eDerivedHp`, `pf1eLastRoll`) or the DOM of a real click.
 *
 * The GM's world-level macro hotbar is untouched by this: the bar follows the *selected* token's
 * character, so the GM picks a token and plays that character's slots (checked at the end).
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

interface DerivedHp {
  hp: number;
  hpMax: number;
  tempHp: number;
  nonlethalDamage: number;
}

interface RollCard {
  id: string;
  total: number;
  formula: string;
  applied: Record<string, { damage?: number; healing?: number }>;
}

interface QuickbarBinding {
  slot: number;
  kind: string;
  label: string;
  attackIndex: number;
  itemId: string | null;
}

const derivedHp = (page: Page, actorId: string): Promise<DerivedHp | null> =>
  surfaceCallArg<DerivedHp | null>(page, "app", "pf1eDerivedHp", actorId);
const quickbar = (page: Page, actorId: string): Promise<QuickbarBinding[]> =>
  surfaceCallArg<QuickbarBinding[]>(page, "app", "pf1eQuickbar", actorId);
const lastRoll = (page: Page): Promise<RollCard | null> =>
  hostCall<RollCard | null>(page, "pf1eLastRoll");
const cardsContaining = (
  page: Page,
  needle: string,
): Promise<{ count: number; first: string | null }> =>
  surfaceCallArg(page, "app", "pf1eCardsContaining", needle);

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

test.describe("per-character quickbar (§2.2/G-10b)", () => {
  test("a player binds their axe, rolls its damage into a card, and attacks the chosen target", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(240_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const errors: string[] = [];
    for (const page of [host, player]) page.on("pageerror", (e) => errors.push(String(e)));

    // ── host: a hero with a real greataxe line, and a GM-owned orc ──
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "gm");
    const placed = await surfaceCallArg<{ ok: boolean; placed: number }>(
      host,
      "app",
      "pf1ePlaceTokens",
      [
        { id: "hero", col: 1, row: 1 },
        { id: "orc", col: 3, row: 1, owner: "gm" },
      ],
    );
    expect(placed).toMatchObject({ ok: true, placed: 2 });
    const authored = await surfaceCallArg<{ ok: boolean }>(host, "app", "pf1eAuthorActor", {
      actorId: "a-hero",
      patch: {
        hp: 20,
        hpMax: 20,
        abilities: { str: 16 },
        attacks: [
          {
            name: "Greataxe",
            damageDice: "1d12",
            damageBonus: 2,
            damageType: "slashing",
            twoHanded: true,
          },
        ],
      },
    });
    expect(authored.ok).toBe(true);
    // the orc must be resolvable as a *defender*: the resolve flow reads its defended hit points
    const orcAuthored = await surfaceCallArg<{ ok: boolean }>(host, "app", "pf1eAuthorActor", {
      actorId: "a-orc",
      patch: { hp: 12, hpMax: 12 },
    });
    expect(orcAuthored.ok).toBe(true);
    expect(await quickbar(host, "a-hero")).toEqual([]);

    // ── a player joins and binds their own character's damage slot ──
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    await player.goto(`${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue());
    await player.click("#answer-apply");
    await expect.poll(() => playerCall<number>(player, "tokenCount"), { timeout: 20_000 }).toBe(2);
    await waitForSurface(player, "playerCanvas");

    // the bar plays the player's own character without any selection
    await expect(player.locator(`[data-quickbar-actor="a-hero"]`)).toBeVisible();
    const bind = player.locator("[data-quickbar-bind]");
    await expect
      .poll(async () => (await bind.locator("option").allTextContents()).join("|"), { timeout: 20_000 })
      .toContain("Greataxe damage");
    await bind.selectOption("damage:0");
    await player.locator("[data-quickbar-slot-select]").selectOption("1");
    await player.click("[data-quickbar-bind-apply]");
    // the binding is an op: the host replica is where the table's truth lives
    await expect
      .poll(async () => (await quickbar(host, "a-hero")).map((b) => `${String(b.slot)}:${b.label}`))
      .toEqual(["1:Greataxe damage"]);
    await expect(player.locator('[data-quickbar-slot="1"]')).toContainText("Greataxe damage");

    // ── pressing the slot rolls the line's damage as the host's own card ──
    await player.click('[data-quickbar-slot="1"]');
    await expect
      .poll(async () => (await lastRoll(host))?.formula ?? null, { timeout: 20_000 })
      .toContain("1d12");
    const card = await lastRoll(host);
    if (!card) throw new Error("no damage card");
    expect(card.applied).toEqual({});

    // ── and the §2.2 item 3 verb lands it on the selected token (the player's own hero) ──
    const playerCamera = await playerCall<{ x: number; y: number; scale: number }>(player, "camera");
    await clickWorld(player, { x: 150, y: 150 }, playerCamera);
    await expect(
      player.locator(`[data-apply-message="${card.id}"][data-apply-target="a-hero"]`),
    ).toBeVisible();
    await player.click(`[data-apply-damage="${card.id}"]`);
    await expect
      .poll(async () => (await derivedHp(host, "a-hero"))?.hp, { timeout: 20_000 })
      .toBe(20 - card.total);

    // ── an attack slot refuses without a target, then runs with one ──
    await bind.selectOption("attack:0");
    await player.locator("[data-quickbar-slot-select]").selectOption("2");
    await player.click("[data-quickbar-bind-apply]");
    await expect
      .poll(async () => (await quickbar(host, "a-hero")).map((b) => b.kind))
      .toEqual(["damage", "attack"]);
    // The character is one of its own target choices — a self-buff (or a deliberate self-attack)
    // is a table's business, and this is the same rule the apply verb's row follows.
    await expect
      .poll(async () =>
        (await player.locator("[data-quickbar-target] option").allTextContents()).join("|"),
      )
      .toContain("hero");
    await player.locator("[data-quickbar-target]").selectOption("");
    await player.click('[data-quickbar-slot="2"]');
    await expect(player.locator("[data-quickbar-error]")).toHaveText("pick a target first");
    // ... and nothing is pre-selected: an attack slot with no target says so instead of guessing.

    // ── the GM's bar plays the *selected* token's character (the macro hotbar is untouched) ──
    const gmCamera = await hostCall<{ x: number; y: number; scale: number } | null>(host, "camera");
    if (!gmCamera) throw new Error("no GM camera");
    await clickWorld(host, { x: 150, y: 150 }, gmCamera);
    await expect(host.locator('[data-quickbar-actor="a-hero"]')).toBeVisible();
    await expect(host.locator("[data-slot]")).toHaveCount(5);
    // the hero's slots were bound by the *player*: the binding is the actor's, so the GM reads it
    await expect(host.locator('[data-quickbar-slot="2"]')).toContainText("Greataxe");

    // pick the orc as this attack's target, then run the slot: the sheet's own resolve flow
    const heroHpBefore = (await derivedHp(host, "a-hero"))?.hp ?? 0;
    await host.locator("[data-quickbar-target]").selectOption("a-orc");
    await host.click('[data-quickbar-slot="2"]');
    await expect
      .poll(async () => (await cardsContaining(host, "Greataxe vs")).count, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(host.locator("[data-quickbar-status]")).toContainText("Greataxe vs");
    // the resolution card is the flow's own report — a hit can only lower hit points
    expect((await derivedHp(host, "a-orc"))?.hp ?? 0).toBeLessThanOrEqual(12);
    expect((await derivedHp(host, "a-hero"))?.hp ?? 0).toBe(heroHpBefore);

    // ── and another token means another character's slots ──
    await clickWorld(host, { x: 350, y: 150 }, gmCamera);
    await expect(host.locator('[data-quickbar-actor="a-orc"]')).toBeVisible();
    const gmBind = host.locator("[data-quickbar-bind]");
    await expect
      .poll(async () => (await gmBind.locator("option").allTextContents()).join("|"))
      .toContain("Unarmed strike");
    await gmBind.selectOption("damage:0");
    await host.locator("[data-quickbar-slot-select]").selectOption("5");
    await host.click("[data-quickbar-bind-apply]");
    await expect
      .poll(async () => (await quickbar(host, "a-orc")).map((b) => `${String(b.slot)}:${b.label}`))
      .toEqual(["5:Unarmed strike damage"]);
    const before = (await lastRoll(host))?.id ?? null;
    await host.click('[data-quickbar-slot="5"]');
    await expect
      .poll(async () => (await lastRoll(host))?.id ?? null, { timeout: 20_000 })
      .not.toBe(before);

    expect(errors).toEqual([]);
    await hostCtx.close();
    await playerCtx.close();
  });
});
