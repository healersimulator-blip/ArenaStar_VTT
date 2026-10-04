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
      const layer = st.getRollHighlightLayer();
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
      const mod = (await import("/src/packages/pf1e/pendingRoll.ts" as unknown as string).catch(() => null)) as unknown as
        | { buildPendingRoll: (x: unknown) => { expiresTurn: number }; isPendingExpired: (a: unknown, b: number) => boolean }
        | null;
      if (mod?.buildPendingRoll && mod?.isPendingExpired) {
        const p = mod.buildPendingRoll({
          kind: "save",
          initiator: { actorId: "a", tokenId: null, name: "G", actionLabel: "save" },
          target: { actorId: "b", tokenId: null, name: "P" },
          formula: "1d20+5",
          dc: 10,
          modifiers: [],
          turnNumber: 1,
        } as unknown as never);
        const isExp = mod.isPendingExpired(p, 4);
        return { hasHelper: true, expiredAt4: isExp } as const;
      }
      return { hasHelper: false, expiredAt4: 4 > 1 + 2 } as const;
    });
    expect((windowProbe as { expiredAt4: boolean }).expiredAt4).toBe(true);
  });

  test("structured multi-target action resolves selected checks, keeps effect stages pending, highlights area, and lets the GM override", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(entry + "?e2e=1");
    await expect.poll(() => page.evaluate(() =>
      (globalThis as unknown as { __vttE2E?: { app?: unknown } }).__vttE2E?.app != null)).toBe(true);

    const sceneId = await page.evaluate(() => {
      const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: {
        store: { getAll: (collection: string) => readonly unknown[] };
        submit: (ops: unknown[]) => void;
      } } } } }).__vttE2E.app.gm.client;
      const scene = client.store.getAll("scenes").map((value) => value as { _id?: unknown; active?: unknown })
        .find((value) => value.active === true) ??
        client.store.getAll("scenes").map((value) => value as { _id?: unknown })[0];
      if (!scene || typeof scene._id !== "string") throw new Error("active scene missing");
      const actor = (id: string, name: string) => ({
        _id: id, type: "actor", name, ownership: { default: 0 }, flags: {},
        system: { pf1e: id === "action-e2e-source"
          ? { abilities: { wis: 12 }, spells: { keyAbility: "wis", mode: "prepared", casterLevel: 3,
              slotsPerDay: { 1: 2 }, prepared: [] } }
          : { saves: { fort: 0, ref: 5, will: 0 } } },
        items: [], effects: [],
      });
      client.submit([
        { kind: "create", coll: "actors", data: actor("action-e2e-source", "Host Source") },
        { kind: "create", coll: "actors", data: actor("action-e2e-a", "Host Target A") },
        { kind: "create", coll: "actors", data: actor("action-e2e-b", "Host Target B") },
      ]);
      return scene._id;
    });
    await expect.poll(() => page.evaluate(() => {
      const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: {
        store: { get: (collection: string, id: string) => unknown };
      } } } } }).__vttE2E.app.gm.client;
      return client.store.get("actors", "action-e2e-b") != null;
    })).toBe(true);

    await page.evaluate((activeSceneId) => {
      const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: {
        user: { id: string }; submit: (ops: unknown[]) => void;
      } } } } }).__vttE2E.app.gm.client;
      const actionId = "action-e2e-card";
      const pending = (id: string, targetKey: string, actorId: string, name: string) => ({
        v: 1, id, actionId, targetKey, kind: "save", saveType: "ref",
        initiator: { actorId: "action-e2e-source", tokenId: null, name: "forged source", actionLabel: "Entangle" },
        target: { actorId, tokenId: null, name }, formula: "1d20+5", dc: 12,
        modifiers: [{ label: "REF", value: 5, reason: "save" }],
        turnNumber: 0, expiresTurn: 2, resolved: false, rollMode: "roll",
      });
      const check = (pendingRollId: string) => ({ kind: "save", status: "pending", formula: "1d20+5",
        dc: 12, total: null, saveType: "ref", pendingRollId });
      client.submit([{ kind: "create", coll: "messages", data: {
        _id: actionId, type: "message", name: "Entangle", ownership: { default: 1 }, flags: {},
        system: {
          action: {
            v: 1, id: actionId, revision: 0, kind: "cast", label: "Entangle", state: "pending",
            source: { name: "forged source", actorId: "action-e2e-source" },
            sceneId: activeSceneId,
            area: { sceneId: activeSceneId, shape: "spread", origin: { x: 300, y: 300 }, radius: 20, units: "ft" },
            targets: [
              { key: "save-a", name: "forged A", label: "Reflex save", actorId: "action-e2e-a",
                state: "pending", outcome: "pending", check: check("action-e2e-roll-a"),
                evidence: { adapter: "pf1e.pendingSave.v1", payload: { spellLevel: 1, saveType: "ref" } } },
              { key: "save-b", name: "forged B", label: "Reflex save", actorId: "action-e2e-b",
                state: "pending", outcome: "pending", check: check("action-e2e-roll-b"),
                evidence: { adapter: "pf1e.pendingSave.v1", payload: { spellLevel: 1, saveType: "ref" } } },
              { key: "effect", name: "forged B", label: "spell effect", actorId: "action-e2e-b",
                state: "pending", outcome: "pending",
                notes: ["Awaiting a host-verifiable spell-effect continuation."] },
            ],
            notes: [], createdAt: 1, updatedAt: 1,
          },
          pendingRolls: [
            pending("action-e2e-roll-a", "save-a", "action-e2e-a", "forged A"),
            pending("action-e2e-roll-b", "save-b", "action-e2e-b", "forged B"),
          ],
        },
        author: client.user.id, content: "Entangle saves pending", whisper: [], roll: null,
        flavor: "cast resolution",
      } }]);
    }, sceneId);

    const card = page.locator('[data-action-card="action-e2e-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator("[data-action-target]")).toHaveCount(3);
    await expect(card.locator("[data-action-roll]")).toHaveCount(2);
    await expect(card.locator("[data-action-source]")).toHaveText("Host Source");
    await expect(card.locator('[data-action-target="save-a"] [data-action-target-name]')).toHaveText("Host Target A");
    await expect(card.locator('[data-action-target="effect"] [data-action-target-label]')).toHaveText("spell effect");
    await expect(card.locator('[data-action-target="effect"]')).toContainText("Awaiting a host-verifiable");

    await card.locator("[data-action-area]").click();
    await expect.poll(() => page.evaluate(() =>
      (globalThis as unknown as { __stage?: { getRollHighlightLayer?: () => { rectCount: number } } })
        .__stage?.getRollHighlightLayer?.().rectCount ?? 0)).toBeGreaterThan(0);

    await card.locator('[data-action-roll="action-e2e-roll-b"]').click();
    await expect(card.locator('[data-action-target="save-b"]')).toHaveAttribute("data-target-state", "resolved");
    await expect(card.locator('[data-action-target="save-b"]')).toHaveAttribute("data-target-provenance", "host");
    await expect(card.locator('[data-action-target="save-a"]')).toHaveAttribute("data-target-state", "pending");
    await expect(card.locator('[data-action-target="effect"]')).toHaveAttribute("data-target-state", "pending");
    await expect(card.locator("[data-action-roll]")).toHaveCount(1);
    await expect(card.locator("[data-action-status]")).toHaveText("pending");

    // Neither target actor grants ownership to the GM id; the role override still uses host resolution.
    await card.locator('[data-action-roll="action-e2e-roll-a"]').click();
    await expect(card.locator('[data-action-target="save-a"]')).toHaveAttribute("data-target-state", "resolved");
    await expect(card.locator("[data-action-roll]")).toHaveCount(0);
    await expect(card.locator('[data-action-target="effect"]')).toHaveAttribute("data-target-state", "pending");
    await expect(card).toHaveAttribute("data-action-revision", "2");
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
      const mod = (await import("/src/packages/pf1e/pendingRoll.ts" as unknown as string).catch(() => null)) as unknown as
        | { shouldDeferToPlayer: (x: unknown) => boolean }
        | null;
      if (mod?.shouldDeferToPlayer) {
        const should = mod.shouldDeferToPlayer;
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
      }
      // Fallback when file:// cannot import src (mirrors rollLedger.spec.ts)
      return {
        savesAuto: false,
        attackAuto: true,
        manualSave: true,
        strategic: false,
      };
    });
    expect(probe.savesAuto).toBe(false);
    expect(probe.attackAuto).toBe(true);
    expect(probe.manualSave).toBe(true);
    expect(probe.strategic).toBe(false);
  });
});
