/**
 * P7/H01/D-205 — the dying round's stabilization check through the real
 * tracker: a dying, linked combatant whose turn starts makes the panel roll
 * the Constitution check publicly, write the outcome (the Stable condition
 * on a success — or the lost hit point on a failure), and show the line.
 *
 * The hero's Constitution is authored at 35 (mod +12), so even a natural 1
 * clears the DC (1 + 12 = 13 ≥ 10 + 3 for hp −3) — the success is
 * deterministic despite the host's real d20.
 */
import { expect, test } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

interface HeroSystem {
  hp?: number;
  conditions?: string[];
}

test.describe("PF1e dying stabilization (P7/H01/D-205)", () => {
  test("a dying combatant's turn rolls the Constitution check and writes the outcome", async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    // Two linked tokens: a goblin and the tough hero (who will be dying).
    // The goblin is placed first so it holds the first slot — startCombat
    // makes the first combatant active, and the encounter below keeps the
    // goblin's slot through the initiative edits.
    expect(
      await surfaceCallArg<{ ok: boolean; placed: number }>(
        page,
        "app",
        "pf1ePlaceTokens",
        [
          { id: "goblin", col: 0, row: 0 },
          { id: "hero", col: 3, row: 0 },
        ],
      ),
    ).toMatchObject({ ok: true, placed: 2 });
    // The hero: Con 35 (mod +12 — even a natural 1 clears the DC), hp −3,
    // hpMax 20.
    expect(
      await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
        actorId: "a-hero",
        patch: { abilities: { con: 35 }, hp: -3, hpMax: 20 },
      }),
    ).toMatchObject({ ok: true });
    // The goblin just needs to exist.
    expect(
      await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
        actorId: "a-goblin",
        patch: { abilities: { dex: 12 }, hp: 6, hpMax: 6 },
      }),
    ).toMatchObject({ ok: true });

    // Start the encounter from the scene's tokens. Initiative is set by
    // hand (no #combat-init — its rolls are random and the retained active
    // slot would depend on them); the goblin leads, the hero goes second.
    await page.click('[data-tab="combat"]');
    await page.click("#combat-start");
    const rows = page.locator(".combat .order li");
    await expect(rows).toHaveCount(2);
    const heroRow = rows.filter({ hasText: "hero" });
    const goblinRow = rows.filter({ hasText: "goblin" });
    // Fill the leader's initiative first: while every initiative is still
    // blank the tracker lets the sorted-first combatant keep the active slot,
    // so the goblin stays active through both edits.
    await goblinRow.locator(".init").fill("15");
    await heroRow.locator(".init").fill("5");
    await expect(rows.first()).toContainText("goblin");
    await expect(rows.nth(1)).toContainText("hero");
    await expect(page.locator(".combat .round")).toContainText(/Round 1/);
    // The goblin holds round 1's opening slot.
    await expect(goblinRow).toHaveClass(/active/);
    await expect(heroRow).not.toHaveClass(/active/);

    // The hero's turn starts: the stabilization check fires.
    await page.click("#combat-next");
    const note = page.locator("[data-dying-note]");
    await expect(note).toBeVisible();
    await expect(note).toContainText("hero (actor)");
    await expect(note).toContainText("stabilizes");

    // The roll was public: the chat log carries the stabilization rollcard.
    // (#chat-log mounts only while the Chat sidebar tab is active.)
    await page.click('[data-tab="chat"]');
    const chat = page.locator("#chat-log");
    await expect(
      chat.locator(".rollcard", {
        hasText: "dying stabilization check",
      }),
    ).toHaveCount(1);

    // The outcome was written: the actor carries the Stable condition.
    const heroSystem = await surfaceCallArg<HeroSystem | null>(
      page,
      "app",
      "pf1eActorSystem",
      "a-hero",
    );
    expect(heroSystem?.conditions).toContain("Stable");
    expect(heroSystem?.hp).toBe(-3); // a success loses nothing

    // A stabilized creature owes nothing on its next turn: wrap the round
    // (goblin → hero again) and no second roll happens.
    await page.click('[data-tab="combat"]');
    await page.click("#combat-next");
    await page.click("#combat-next");
    await page.click('[data-tab="chat"]');
    await expect(
      chat.locator(".rollcard", { hasText: "dying stabilization check" }),
    ).toHaveCount(1);
    expect(runtimeErrors).toEqual([]);
  });
});
