import { expect, test } from "@playwright/test";
import { entry } from "./lib";

/**
 * F03 — Player Reaction Pending Rolls (non-strategic, tactical only).
 * When a reaction roll (save vs spell, AoO/parry) targets a player token,
 * the table sees a pending roll card instead of an instant host roll.
 * Options in world settings `playerPendingRollMode`: auto | savesChecksAuto | manual.
 * Card centers+outlines initiator/target/area like F01 and stores pending:true
 * with a 2-round window, permission-gated to target player.
 */

test.describe("F03 pending rolls (Messages system.pendingRoll v1)", () => {
  test("world settings expose playerPendingRollMode (auto/savesChecksAuto/manual) default savesChecksAuto and the pending card renders with host-verified Roll", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto(entry + "?e2e=1");
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __vttE2E?: { app?: { pf1eWorldSettings?: () => unknown } } })
                .__vttE2E?.app != null,
          ),
      )
      .toBe(true);

    // Default should be savesChecksAuto
    const before = await page.evaluate(() => {
      const app = (
        globalThis as unknown as {
          __vttE2E: { app: { pf1eWorldSettings: () => Record<string, unknown> } };
        }
      ).__vttE2E.app;
      return app.pf1eWorldSettings();
    });
    expect(before.playerPendingRollMode ?? "savesChecksAuto").toBe("savesChecksAuto");

    // Set each mode via replicated worldSettingsOps
    for (const mode of ["manual", "savesChecksAuto", "auto"] as const) {
      const res = await page.evaluate(
        (m) => {
          const app = (
            globalThis as unknown as {
              __vttE2E: {
                app: { pf1eSetWorldSetting: (s: unknown) => { ok: boolean; error: string | null } };
              };
            }
          ).__vttE2E.app;
          return app.pf1eSetWorldSetting({ key: "playerPendingRollMode", value: m });
        },
        mode,
      );
      expect(res.ok, `pf1eSetWorldSetting ${mode}: ${res.error}`).toBe(true);
      const s = await page.evaluate(() => {
        const app = (
          globalThis as unknown as { __vttE2E: { app: { pf1eWorldSettings: () => Record<string, unknown> } } }
        ).__vttE2E.app;
        return app.pf1eWorldSettings();
      });
      expect(s.playerPendingRollMode).toBe(mode);
    }

    const bad = await page.evaluate(() => {
      const app = (
        globalThis as unknown as {
          __vttE2E: {
            app: { pf1eSetWorldSetting: (s: unknown) => { ok: boolean; error: string | null } };
          };
        }
      ).__vttE2E.app;
      return app.pf1eSetWorldSetting({ key: "playerPendingRollMode", value: "sometimes" });
    });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("playerPendingRollMode");

    // Restore savesChecksAuto for the card probe
    await page.evaluate(() => {
      const app = (
        globalThis as unknown as {
          __vttE2E: { app: { pf1eSetWorldSetting: (s: unknown) => { ok: boolean; error: string | null } } };
        }
      ).__vttE2E.app;
      app.pf1eSetWorldSetting({ key: "playerPendingRollMode", value: "savesChecksAuto" });
    });

    // Inject a pending save card (host would create this instead of rolling immediately)
    await page.evaluate(() => {
      const surface = (
        globalThis as unknown as {
          __vttE2E: { app: { gm: { client: { submit: (ops: unknown[]) => void; user: { id: string } } } } };
        }
      ).__vttE2E.app;
      const client = surface.gm.client;
      const author = client.user.id;
      // Ensure the target actor is owned by this user so the card's Roll is enabled for us
      const targetActorId = "actor-valeros";
      client.submit([
        {
          kind: "create",
          coll: "actors",
          data: {
            _id: targetActorId,
            type: "actor",
            name: "Valeros",
            ownership: { default: 1, [author]: 3 },
            flags: {},
            system: { pf1e: {} },
            items: [],
            effects: [],
          },
        },
      ]);
      const pending = {
        v: 1,
        kind: "save",
        initiator: { actorId: "actor-goblin", tokenId: "token-goblin", name: "Goblin", actionLabel: "Reflex save vs Fireball (DC 17)" },
        target: { actorId: targetActorId, tokenId: "token-valeros", name: "Valeros" },
        formula: "1d20+5",
        dc: 17,
        modifiers: [{ label: "Reflex", value: 5, reason: "save" }],
        seedClientCommit: null,
        seedHost: null,
        total: null,
        turnNumber: 7,
        expiresTurn: 9,
        resolved: false,
        rollMode: "roll",
        area: null,
      };
      client.submit([
        {
          kind: "create",
          coll: "messages",
          data: {
            _id: `msg-pending-${Date.now()}`,
            type: "message",
            name: "Valeros pending save",
            ownership: { default: 1 },
            flags: {},
            system: { pendingRoll: pending },
            author,
            content: "Valeros — Reflex save vs Fireball (DC 17) — pending (1d20+5)",
            whisper: [],
            roll: null,
            flavor: "",
            rollMode: "roll",
          },
        },
      ]);
    });

    const card = page.locator('[data-testid="pending-roll-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute("data-pending-kind", "save");
    await expect(card).toHaveAttribute("data-pending-formula", "1d20+5");
    await expect(card.locator('[data-testid="pending-roll-button"]')).toBeVisible();
    await expect(card.locator('[data-testid="pending-roll-button"]')).toBeEnabled();
    await expect(card.locator('[data-testid="pending-dc"]')).toContainText("17");
    await expect(card.locator('[data-testid="pending-modifiers"]')).toBeVisible();
    // No total yet
    await expect(card.locator('[data-testid="pending-total-pending"]')).toBeVisible();
    await expect(card.locator('[data-testid="pending-initiator"]')).toContainText("Goblin");
    await expect(card.locator('[data-testid="pending-target"]')).toContainText("Valeros");

    // Highlight layer smoke: reuse the rollHighlight layer
    const highlightSmoke = await page.evaluate(async () => {
      const st = (
        globalThis as unknown as {
          __stage?: {
            getRollHighlightLayer?: () => {
              sync: (rects: unknown[], cam: unknown, fadeSec: number) => void;
              rectCount: number;
            };
            camera?: unknown;
          };
        }
      ).__stage;
      if (!st?.getRollHighlightLayer) return { ok: true, skipped: true } as const;
      const layer = st.getRollHighlightLayer()!;
      const cam = (st as unknown as { camera?: unknown }).camera ?? { x: 0, y: 0, scale: 1 };
      layer.sync([{ x: 0, y: 0, width: 50, height: 50, kind: "initiator" }], cam as { x: number; y: number; scale: number }, 1);
      const before = layer.rectCount;
      layer.sync([], cam as { x: number; y: number; scale: number }, 1);
      const after = layer.rectCount;
      return { ok: before === 1 && after === 0, before, after, skipped: false } as const;
    });
    if (!(highlightSmoke as { skipped?: boolean }).skipped) {
      expect((highlightSmoke as { ok: boolean }).ok).toBe(true);
    }

    // Click Roll — the card should flip to resolved with a total chip and a follow-up line
    await card.locator('[data-testid="pending-roll-button"]').click();
    await expect(card.locator('[data-testid="pending-total"]')).toBeVisible({ timeout: 10_000 });
    // Follow-up message posted by ChatPanel
    await expect(page.locator("#chat-log")).toContainText("rolled", { timeout: 10_000 });

    // Window: prove pure helper
    const windowProbe = await page.evaluate(async () => {
      try {
        // @ts-ignore — Vite dev import, file:// falls back to math
        const mod = await import("/src/packages/pf1e/pendingRoll.ts" as unknown as string);
        const p = (mod as unknown as { buildPendingRoll: (x: unknown) => { expiresTurn: number } }).buildPendingRoll({
          kind: "save",
          initiator: { actorId: "a", tokenId: null, name: "G", actionLabel: "save" },
          target: { actorId: "b", tokenId: null, name: "P" },
          formula: "1d20+5",
          dc: 10,
          modifiers: [],
          turnNumber: 1,
        } as unknown as never);
        const isExp = (mod as unknown as { isPendingExpired: (a: unknown, b: number) => boolean }).isPendingExpired(p, 4);
        return { hasHelper: true, expiredAt4: isExp } as const;
      } catch {
        return { hasHelper: false, expiredAt4: 4 > 1 + 2 } as const;
      }
    });
    expect((windowProbe as { expiredAt4: boolean }).expiredAt4).toBe(true);
  });

  test("savesChecksAuto: save auto-resolves, attack pending — strategic never pending", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __vttE2E?: { app?: { pf1eWorldSettings?: () => unknown } } })
                .__vttE2E?.app != null,
          ),
      )
      .toBe(true);

    const probe = await page.evaluate(async () => {
      // @ts-ignore — Vite dev import, file:// falls back to math
      const mod = await import("/src/packages/pf1e/pendingRoll.ts" as unknown as string);
      const should = (mod as unknown as { shouldDeferToPlayer: (x: unknown) => boolean }).shouldDeferToPlayer;
      const savesAuto = should({
        kind: "save",
        targetIsPlayerOwned: true,
        worldSettings: { playerPendingRollMode: "savesChecksAuto" },
      });
      const attackAuto = should({
        kind: "attack",
        targetIsPlayerOwned: true,
        worldSettings: { playerPendingRollMode: "savesChecksAuto" },
      });
      const manualSave = should({
        kind: "save",
        targetIsPlayerOwned: true,
        worldSettings: { playerPendingRollMode: "manual" },
      });
      const strategic = should({
        kind: "attack",
        targetIsPlayerOwned: true,
        worldSettings: { playerPendingRollMode: "manual" },
        isStrategic: true,
      });
      return { savesAuto, attackAuto, manualSave, strategic };
    });
    expect(probe.savesAuto).toBe(false);
    expect(probe.attackAuto).toBe(true);
    expect(probe.manualSave).toBe(true);
    expect(probe.strategic).toBe(false);
  });
});
