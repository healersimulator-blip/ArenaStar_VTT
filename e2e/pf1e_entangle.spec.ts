/**
 * D-407 — **the Entangle scene**, end to end through the real UI, in the real world.
 *
 * The scene the user described: a player character casts *Entangle* from its **hot bar** over an
 * enemy; the cast resolves (correct DC, a card), the enemy rolls its Reflex save, and:
 *
 *  - **failed save** ⇒ the Entangled condition is applied *to the target, by the spell* (source
 *    `spell`, riding the cast card as a `condition` rider) **and** the vine timeline the author
 *    bound to the spell plays around the token;
 *  - **made save**    ⇒ no condition, and the bound cue is not requested (a made save is the
 *    failure branch, which is "nothing" unless the author bound one).
 *
 * What this spec does **not** cover, because the tree does not implement it yet and the plan says so
 * (`DECISIONS.md` D-407, S3/S4/S5b): the 40-ft. **area** cast (one row per affected actor), the
 * printed **break-free / end-of-caster's-turn re-save** cadence, and the condition↔FX teardown when a
 * condition is removed. The removal demonstrated here is the card's own Revert, which is D-405's
 * contract and does undo both the condition and the rider.
 *
 * Every assertion reads the **host replica** (`pf1eLastActionCard`, `pf1eConditionApps`) or the real
 * DOM (`[data-action-rider]`, `[data-quickbar-status]`) or the Pixi stage (`__stage`), never a toast.
 */
import { expect, test, type Page } from "@playwright/test";
import { entry, hostCall, surfaceCallArg, waitForSurface } from "./lib";

interface RiderRow {
  kind: string;
  label: string;
  state: string;
  save?: { saveType: string; dc: number | null; total: number | null; passed?: boolean };
}

interface ActionReadback {
  messageId: string;
  action: {
    kind: string;
    label: string;
    targets: Array<{ key: string; outcome: string; riders?: RiderRow[] }>;
  };
  pending: Record<string, unknown> | null;
}

interface ConditionApp {
  id: string;
  condition: string;
  sourceKind: string;
  removal: string;
  supported: boolean;
}

const lastAction = (page: Page): Promise<ActionReadback | null> =>
  hostCall<ActionReadback | null>(page, "pf1eLastActionCard");
const conditionApps = (page: Page, actorId: string): Promise<ConditionApp[]> =>
  surfaceCallArg<ConditionApp[]>(page, "app", "pf1eConditionApps", actorId);

/** The Pixi stage's live FX instance count — the fact under test, not an echo of our request. */
function activeFx(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
    ).__stage?.getFxLayer().count ?? 0,
  );
}

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
 * The PC who casts it: Wis 18 and a level-1 slot ⇒ **DC 15** for a 1st-level spell, and one prepared
 * row whose name the tactical catalogue authors (Entangle is the only shipped row today, by design).
 */
async function authorCaster(page: Page): Promise<void> {
  const authored = await surfaceCallArg<{ ok: boolean; error: string | null }>(
    page,
    "app",
    "pf1eAuthorActor",
    {
      actorId: "a-hero",
      patch: {
        hp: 20,
        hpMax: 20,
        abilities: { wis: 18 },
        spells: {
          keyAbility: "wis",
          casterLevel: 1,
          mode: "prepared",
          slotsPerDay: { 1: 3 },
          prepared: [{ name: "Entangle", level: 1 }],
        },
      },
    },
  );
  expect(authored).toMatchObject({ ok: true });
}

/** The target: `dex` decides the Reflex save (the DC is 15 whatever happens). */
async function authorTarget(page: Page, dex: number): Promise<void> {
  const authored = await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
    actorId: "a-orc",
    patch: { hp: 40, hpMax: 40, abilities: { dex } },
  });
  expect(authored).toMatchObject({ ok: true });
}

/** Author the vine timeline in the FX wizard and bind it to the **spell** Entangle (S5a). */
async function bindVineCue(page: Page): Promise<void> {
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-name]").fill("Creeping vines");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill(
    "Vines curl out of the ground",
  );
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li").filter({ hasText: "Creeping vines" })).toContainText(
    "1 sections",
  );
  const binding = wizard.locator("[data-fx-spell-binding]");
  await binding.locator("[data-fx-spell-binding-spell]").selectOption("entangle");
  await binding.locator("[data-fx-spell-binding-save]").click();
  await expect(wizard.getByRole("status")).toContainText("Entangle");
  // The remove verb only exists once the host echoed the authored document back.
  await expect(binding.locator("[data-fx-spell-binding-remove]")).toHaveCount(1);
  await page.locator('[data-window="macros"] [data-window-close]').click();
}

/** Bind the prepared spell to hot-bar slot 1 through the quickbar's own controls. */
async function bindSpellSlot(page: Page): Promise<void> {
  const bind = page.locator("[data-quickbar-bind]");
  await expect
    .poll(async () => (await bind.locator("option").allTextContents()).join("|"), {
      timeout: 20_000,
    })
    .toContain("Entangle (level 1)");
  await bind.selectOption("spell:0");
  await page.locator("[data-quickbar-slot-select]").selectOption("1");
  await page.click("[data-quickbar-bind-apply]");
  await expect(page.locator('[data-quickbar-slot="1"]')).toContainText("Entangle (level 1)");
}

/**
 * Cast from the hot bar until the target's save lands on `wanted`. A d20 is a d20: a natural 20
 * saves inside a 40-ft. thicket of vines and a natural 1 fails against the surest-footed elf, so the
 * loop retries a bounded number of times rather than pretending the die is scripted. Each attempt is
 * a real cast with its own card; only the last one is asserted on.
 */
async function castUntil(page: Page, wanted: "failedSave" | "saved"): Promise<ActionReadback> {
  const slot = page.locator('[data-quickbar-slot="1"]');
  await page.locator("[data-quickbar-target]").selectOption("a-orc");
  let previous = (await lastAction(page))?.messageId ?? null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await slot.click();
    // Wait for *this* cast's own card rather than for "some card says what I want": a retry's card
    // is a new document with a new id, so a stale read cannot satisfy the wait.
    const fresh = await expect
      .poll(async () => (await lastAction(page))?.messageId ?? null, { timeout: 8_000 })
      .not.toBe(previous)
      .then(() => true)
      .catch(() => false);
    if (!fresh) continue;
    const card = await lastAction(page);
    if (!card) continue;
    previous = card.messageId;
    if (card.action.targets[0]?.outcome === wanted) return card;
  }
  throw new Error(`the target's save never came up "${wanted}"`);
}

test.describe("D-407 — the Entangle scene", () => {
  test("a failed save delivers Entangled and plays the cue bound to the spell; Revert undoes both", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    expect(
      await surfaceCallArg<{ ok: boolean; placed: number }>(page, "app", "pf1ePlaceTokens", [
        { id: "hero", col: 1, row: 1 },
        { id: "orc", col: 3, row: 1, owner: "gm" },
      ]),
    ).toMatchObject({ ok: true, placed: 2 });
    await authorCaster(page);
    // Dex 1 ⇒ Reflex −5 against DC 15: every roll but a natural 20 fails, which is what this
    // branch is here to watch.
    await authorTarget(page, 1);
    await bindVineCue(page);

    const camera = await hostCall<{ x: number; y: number; scale: number } | null>(page, "camera");
    if (!camera) throw new Error("no GM camera");
    await clickWorld(page, { x: 150, y: 150 }, camera);
    await expect(page.locator('[data-quickbar-actor="a-hero"]')).toBeVisible();
    await bindSpellSlot(page);

    const card = await castUntil(page, "failedSave");
    expect(card.action.kind).toBe("cast");
    expect(card.action.targets[0]).toMatchObject({ key: "a-orc", outcome: "failedSave" });
    expect(card.action.targets[0]?.riders?.[0]).toMatchObject({
      kind: "condition",
      label: "Entangled",
      state: "applied",
    });

    // ── the card carries the rider visibly, and the condition's source is the spell ──────────
    await expect(page.locator('[data-action-rider="condition"]')).toBeVisible();
    await expect(page.locator('[data-action-rider="condition"]')).toHaveAttribute(
      "data-rider-state",
      "applied",
    );
    const apps = await conditionApps(page, "a-orc");
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ condition: "Entangled", sourceKind: "spell", supported: true });

    // ── the committed cast asked for the cue the timeline bound to *this spell* ──────────────
    await expect(page.locator("[data-quickbar-status]")).toContainText(
      'bound spell cue "Creeping vines" requested',
    );
    await expect
      .poll(() => activeFx(page), { timeout: 5_000, intervals: [50, 100, 100] })
      .toBeGreaterThan(0);
    await expect.poll(() => activeFx(page), { timeout: 5_000 }).toBe(0);

    // ── the cast card's own Revert is the inverse: condition and rider leave together ────────
    const receipt = page
      .locator('[data-testid="action-revert-card"]')
      .filter({ hasText: "Entangled" });
    await expect(receipt).toContainText("ready");
    await receipt.getByTestId("action-revert").click();
    await expect(receipt).toContainText("reverted");
    await expect.poll(async () => (await conditionApps(page, "a-orc")).length).toBe(0);
    await expect(page.locator('[data-action-rider="condition"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a made save leaves no condition and requests no cue", async ({ page }) => {
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
    await authorCaster(page);
    // Dex 30 ⇒ Reflex +10: DC 15 asks for a 5 or better, so the save is the common case.
    await authorTarget(page, 30);
    await bindVineCue(page);

    const camera = await hostCall<{ x: number; y: number; scale: number } | null>(page, "camera");
    if (!camera) throw new Error("no GM camera");
    await clickWorld(page, { x: 150, y: 150 }, camera);
    await expect(page.locator('[data-quickbar-actor="a-hero"]')).toBeVisible();
    await bindSpellSlot(page);

    const card = await castUntil(page, "saved");
    expect(card.action.targets[0]).toMatchObject({ key: "a-orc", outcome: "saved" });
    // No condition rider on the row, no condition instance on the actor, and the cue is silent:
    // a made save is the failure branch, and this author bound none.
    expect(card.action.targets[0]?.riders ?? []).toEqual([]);
    await expect(page.locator('[data-action-rider="condition"]')).toHaveCount(0);
    expect(await conditionApps(page, "a-orc")).toEqual([]);
    // The cast itself says which half of the binding was consulted, in the spell's own words.
    await expect(page.locator("[data-quickbar-status]")).toContainText(
      "the spell has no cue for that outcome",
    );
    await expect(page.locator("[data-quickbar-status]")).not.toContainText("requested");
    await page.waitForTimeout(1_500); // the cue's own lead is 300 ms; past that it landed or never will
    expect(await activeFx(page)).toBe(0);
    expect(errors).toEqual([]);
  });
});
