import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chromeAction, openSceneNav, waitForSurface } from "./lib";

test("Full VTT at Formation Scale (Phases A–E): doors/LOS, lighting, PF1e spells/items/reactions, live chat/tables/macros/playlists, conflict-aware reconciliation & single-step undo", async ({
  page,
  browser,
}) => {
  const db = process.env.STRATEGIC_TEST_DATABASE_URL;
  test.skip(!db, "Set STRATEGIC_TEST_DATABASE_URL to a disposable database");
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);

  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`;
  const key = `${randomUUID()}${randomUUID()}`;
  const slot = `full-vtt-${randomUUID()}`;

  const service: ChildProcess = spawn(
    process.execPath,
    ["services/strategic-room/dist/server/main.mjs", "campaign"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: db,
        PORT: String(address.port),
        STRATEGIC_ROOM: slot,
        STRATEGIC_ORIGINS: origin,
        STRATEGIC_LAUNCH_KEY: key,
      },
    },
  );

  const contexts: BrowserContext[] = [];
  const stop = async () => {
    for (const ctx of contexts) {
      await ctx.close().catch(() => undefined);
    }
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
  };

  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(origin)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(200);

    await page.goto(`${origin}/?e2e=1`);
    await waitForSurface(page, "app");

    // 1. Author a rich PF1e campaign scene (D-257 gatehouse door, darkness/lights, elevated rampart,
    //    measured template, PF1e Archmage & Warlord actors, armies, public/GM journals, rollTable, playlist, macros).
    await page.evaluate(() => {
      const client = (
        globalThis as {
          __vttE2E?: {
            app?: {
              gm?: {
                client?: {
                  submit(ops: unknown[]): string;
                };
              };
            };
          };
        }
      ).__vttE2E?.app?.gm?.client;
      if (!client) throw new Error("GM E2E client unavailable");

      client.submit([
        {
          kind: "create",
          coll: "factions",
          data: {
            _id: "fac-blue",
            type: "faction",
            name: "Silver Guard",
            color: "#5aa9ff",
            allies: [],
            ownership: { default: 1 },
            flags: {},
            system: {},
          },
        },
        {
          kind: "create",
          coll: "factions",
          data: {
            _id: "fac-red",
            type: "faction",
            name: "Iron Host",
            color: "#ff6b6b",
            allies: [],
            ownership: { default: 1 },
            flags: {},
            system: {},
          },
        },
        {
          kind: "create",
          coll: "actors",
          data: {
            _id: "act-blue-cap",
            type: "actor",
            name: "Archmage Valeria",
            ownership: { default: 0 },
            flags: {},
            effects: [],
            items: [
              {
                _id: "wand-clw",
                type: "item",
                name: "Wand of Cure Light Wounds",
                ownership: { default: 0 },
                flags: {},
                effects: [],
                system: { pf1e: { subtype: "wand", charges: 4, maxCharges: 50 } },
              },
              {
                _id: "horn-haste",
                type: "item",
                name: "Warhorn of Haste",
                ownership: { default: 0 },
                flags: {},
                effects: [],
                system: { pf1e: { subtype: "wondrous", charges: 2 } },
              },
            ],
            system: {
              pf1e: {
                hp: 42,
                hpMax: 42,
                baseAttack: 7,
                abilities: { str: 14, dex: 14, con: 14, int: 20, wis: 14, cha: 12 },
                saves: { fort: 6, ref: 5, will: 8 },
                armor: { armorBonus: 6, shieldBonus: 2 },
                conditions: [],
                spells: {
                  mode: "prepared",
                  tradition: "arcane",
                  casterLevel: 7,
                  keyAbility: "int",
                  slotsPerDay: { "1": 3, "3": 2 },
                  slotsUsed: {},
                  prepared: [
                    { id: "prep-fb-1", name: "Fireball", level: 3, expended: false },
                    { id: "prep-fb-2", name: "Fireball", level: 3, expended: false },
                    { id: "prep-ent-1", name: "Entangle", level: 1, expended: false },
                  ],
                },
              },
            },
          },
        },
        {
          kind: "create",
          coll: "actors",
          data: {
            _id: "act-red-warlord",
            type: "actor",
            name: "Warlord Ghor",
            ownership: { default: 0 },
            flags: {},
            effects: [],
            items: [],
            system: {
              pf1e: {
                hp: 24,
                hpMax: 24,
                baseAttack: 5,
                abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
                saves: { fort: 5, ref: 2, will: 2 },
                armor: { armorBonus: 5 },
              },
            },
          },
        },
        {
          kind: "create",
          coll: "armies",
          data: {
            _id: "army-blue",
            type: "army",
            name: "Silver Guard Host",
            factionId: "fac-blue",
            commander: [],
            supply: {},
            ownership: { default: 0 },
            flags: {},
            system: {},
            units: [
              {
                _id: "u-blue",
                type: "infantry",
                name: "Valeria Guard",
                leaderTokenId: "tok-blue",
                formation: "line",
                sceneId: "scene-gate",
                profile: { anchor: { x: 22.5, y: 22.5 } },
                stats: { strength: 12 },
                orders: { pending: [], issuedBy: null, issuedTurn: 0 },
                ownership: { default: 0 },
                flags: {},
                system: {},
              },
            ],
          },
        },
        {
          kind: "create",
          coll: "armies",
          data: {
            _id: "army-red",
            type: "army",
            name: "Iron Host",
            factionId: "fac-red",
            commander: [],
            supply: {},
            ownership: { default: 0 },
            flags: {},
            system: {},
            units: [
              {
                _id: "u-red",
                type: "infantry",
                name: "Iron Raiders",
                leaderTokenId: "tok-red",
                formation: "line",
                sceneId: "scene-gate",
                profile: { anchor: { x: 47.5, y: 22.5 } },
                stats: { strength: 12 },
                orders: { pending: [], issuedBy: null, issuedTurn: 0 },
                ownership: { default: 0 },
                flags: {},
                system: {},
              },
            ],
          },
        },
        {
          kind: "create",
          coll: "scenes",
          data: {
            _id: "scene-gate",
            type: "scene",
            name: "Gate of Thorns",
            active: false,
            img: null,
            width: 2400,
            height: 1600,
            darkness: 0.75,
            grid: {
              type: "square",
              size: 100,
              units: "ft",
              distance: 5,
              diagonals: "555",
              hexLayout: "oddR",
            },
            tokens: [
              {
                _id: "tok-blue",
                type: "token",
                name: "Valeria Guard",
                actorId: "act-blue-cap",
                x: 400,
                y: 400,
                width: 100,
                height: 100,
                rotation: 0,
                img: "",
                hidden: false,
                disposition: "friendly",
                vision: true,
                darkvision: 60,
                light: { radius: 0, dim: 0, color: "#ffffff", alpha: 0 },
                ownership: { default: 1 },
                flags: {},
                system: {},
              },
              {
                _id: "tok-red",
                type: "token",
                name: "Iron Raiders",
                actorId: "act-red-warlord",
                x: 900,
                y: 400,
                width: 100,
                height: 100,
                rotation: 180,
                img: "",
                hidden: false,
                disposition: "hostile",
                vision: true,
                light: { radius: 0, dim: 0, color: "#ffffff", alpha: 0 },
                ownership: { default: 0 },
                flags: {},
                system: {},
              },
            ],
            walls: [
              {
                _id: "door-gate",
                type: "wall",
                name: "Fortress Gate",
                c: [600, 0, 600, 1600],
                move: 1,
                sight: 1,
                sound: 1,
                light: 1,
                door: 0,
                dir: 0,
                ownership: { default: 0 },
                flags: {},
                system: {},
              },
            ],
            lights: [
              {
                _id: "light-brazier",
                type: "light",
                name: "Gate Brazier",
                x: 950,
                y: 450,
                radius: 400,
                dim: 400,
                bright: 200,
                color: "#ff9933",
                alpha: 0.6,
                hidden: false,
                ownership: { default: 0 },
                flags: {},
                system: {},
              },
            ],
            regions: [
              {
                _id: "reg-rampart",
                type: "region",
                name: "North Rampart",
                x: 100,
                y: 100,
                width: 300,
                height: 200,
                shape: {
                  kind: "polygon",
                  points: [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 1],
                  ],
                },
                raised: { height: 15, solid: true },
                ownership: { default: 0 },
                flags: {},
                system: {},
              },
            ],
            sounds: [],
            tiles: [],
            drawings: [],
            templates: [
              {
                _id: "tpl-watch",
                type: "template",
                name: "Watch Arc",
                kind: "cone",
                x: 450,
                y: 450,
                distance: 30,
                direction: 0,
                angle: 90,
                width: 0,
                color: "#44ccff",
                ownership: { default: 0 },
                flags: {},
                system: {},
              },
            ],
            notes: [],
            ownership: { default: 1 },
            flags: { core: { scale: "strategic" } },
            system: {},
          },
        },
        {
          kind: "create",
          coll: "journals",
          data: {
            _id: "jrn-brief",
            type: "journal",
            name: "Orders of the Day",
            pages: [
              {
                _id: "pg-1",
                type: "page",
                name: "Briefing",
                text: "Hold the gatehouse. <secret>Hidden sally port east.</secret>",
                src: null,
                ownership: { default: 2 },
                flags: {},
                system: {},
              },
            ],
            ownership: { default: 2 },
            flags: {},
            system: {},
          },
        },
        {
          kind: "create",
          coll: "journals",
          data: {
            _id: "jrn-gm",
            type: "journal",
            name: "GM Ambush Notes",
            pages: [
              {
                _id: "pg-gm",
                type: "page",
                name: "Secret",
                text: "Reserve wyverns arrive turn 6.",
                src: null,
                ownership: { default: 0 },
                flags: {},
                system: {},
              },
            ],
            ownership: { default: 0 },
            flags: {},
            system: {},
          },
        },
        {
          kind: "create",
          coll: "rollTables",
          data: {
            _id: "tbl-omens",
            type: "rollTable",
            name: "Battlefield Omens",
            formula: "1d6",
            results: [
              { range: [1, 3], text: "Cold mist blankets the field", documentRef: null },
              { range: [4, 6], text: "Golden eagle circles the banner", documentRef: null },
            ],
            ownership: { default: 2 },
            flags: {},
            system: {},
          },
        },
        {
          kind: "create",
          coll: "playlists",
          data: {
            _id: "pl-war",
            type: "playlist",
            name: "Siege Drums",
            mode: "sequential",
            sounds: [
              {
                _id: "trk-drums",
                type: "playlistSound",
                name: "War Drums",
                audio: "",
                volume: 0.8,
                loop: true,
                ownership: { default: 2 },
                flags: {},
                system: {},
              },
            ],
            ownership: { default: 2 },
            flags: {},
            system: {},
          },
        },
        {
          kind: "create",
          coll: "macros",
          data: {
            _id: "mac-brace",
            type: "macro",
            name: "Shield Wall",
            kind: "chat",
            command: "/order defend",
            ownership: { default: 2 },
            flags: {},
            system: {},
          },
        },
      ]);
    });
    expect(
      await page.evaluate(
        () =>
          (globalThis as { __vttE2E?: { app?: { lastRejected(): string | null } } }).__vttE2E?.app?.lastRejected() ??
          null,
      ),
    ).toBeNull();

    // 2. Switch to Gate of Thorns and launch the multiplayer battle through CampaignBattle.svelte
    await openSceneNav(page);
    await page.getByRole("button", { name: "Gate of Thorns", exact: true }).click();
    await openSceneNav(page);
    await page.getByRole("button", { name: "Multiplayer battle…" }).click();
    await page.getByLabel("GM launch key").fill(key);
    await page.getByRole("button", { name: "Launch multiplayer battle" }).click();

    const gmFrame = page.frameLocator('iframe[title="Live strategic battlefield"]');
    await expect(gmFrame.getByRole("button", { name: "Close and resolve" })).toBeVisible({
      timeout: 20_000,
    });

    const roomSrc = (
      await page.locator('iframe[title="Live strategic battlefield"]').getAttribute("src")
    )?.split("?")[0];
    expect(roomSrc).toMatch(/^\/battle\//);

    await page.getByText(/Commander admission \(/).click();
    const codes = await page.locator(".campaign details code").allTextContents();
    expect(codes).toHaveLength(2);

    const joinCommander = async (invite: string): Promise<Page> => {
      const ctx = await browser.newContext();
      contexts.push(ctx);
      const p = await ctx.newPage();
      p.setDefaultTimeout(20_000);
      await p.goto(`${origin}${roomSrc}`);
      await p.getByLabel("One-time invite").fill(invite);
      await p.getByRole("button", { name: "Join room" }).click();
      await expect(p.locator("[data-own-unit-card]").first()).toBeVisible();
      return p;
    };

    const code0 = codes[0];
    const code1 = codes[1];
    if (!code0 || !code1) throw new Error("Missing commander invite codes");
    const p1 = await joinCommander(code0);
    const p2 = await joinCommander(code1);
    const isP1Blue = (await p1.locator('[data-own-unit-card="u-blue"]').count()) > 0;
    const bluePage = isP1Blue ? p1 : p2;
    const redPage = isP1Blue ? p2 : p1;

    // 3. Phase A/D: Verify closed gatehouse door blocks enemy visibility & entitlements prevent secret leakage!
    const targetSelect = bluePage.getByLabel("Visible enemy");
    await expect(targetSelect.locator("option")).toHaveCount(1); // Only "Choose target", Iron Raiders hidden behind closed door!

    await expect(bluePage.locator('[data-journal-content="jrn-brief"]')).toContainText("Hold the gatehouse.");
    await expect(bluePage.locator('[data-journal-content="jrn-brief"]')).not.toContainText("Hidden sally port");
    await expect(bluePage.locator('[data-journal-select] option[value="jrn-gm"]')).toHaveCount(0);

    // Blue sends Faction-scoped dispatch + host-rolled 1d20+5 -> visible to Blue & GM, hidden from Red!
    await bluePage.locator("[data-chat-scope]").selectOption("faction");
    await bluePage.locator("[data-chat-roll]").fill("1d20+5");
    await bluePage.locator("[data-chat-input]").fill("Valeria scouting gate");
    await bluePage.locator('[data-chat-form] button[type="submit"]').click();
    await expect(bluePage.locator("[data-chat-entries]")).toContainText("Valeria scouting gate");
    await expect(bluePage.locator("[data-chat-entries]")).toContainText("1d20+5");
    await expect(redPage.locator("[data-chat-entries]")).toHaveCount(0);

    // Roll Table + Declarative Macro execution
    await bluePage.locator('[data-roll-table="tbl-omens"] button').click();
    await expect(bluePage.locator("[data-chat-entries]")).toContainText("Battlefield Omens");
    await expect(redPage.locator("[data-chat-entries]")).toContainText("Battlefield Omens");
    await expect(redPage.locator("[data-chat-entries]")).not.toContainText("Valeria scouting gate");

    await redPage.locator('[data-macro-btn="mac-brace"]').click();
    await expect(redPage.locator("[data-revision]")).toHaveText("1");

    // 4. Phase D Live GM Scene Controls: GM opens the gatehouse door & starts Siege Drums -> SSE reveals enemy to Blue!
    await gmFrame.locator('[data-gm-door="door-gate"]').getByRole("button", { name: "Open" }).click();
    await expect(gmFrame.locator('[data-gm-door="door-gate"]')).toContainText("Open");

    // Blue's enemy target dropdown immediately populates with Iron Raiders over SSE!
    await expect(targetSelect.locator("option")).toHaveCount(2);
    await expect(targetSelect).toContainText("Iron Raiders");

    // GM starts playlist track War Drums -> live Playing indicator appears for commanders
    await gmFrame.locator('[data-playlist-track="trk-drums"] button').click();
    await expect(bluePage.locator('[data-playlist-track="trk-drums"]')).toContainText("Playing");

    // 5. Phase C Turn 1: Blue casts PF1e Fireball at Iron Raiders (47.5, 22.5); Red readies Countermarch on enemyCasts!
    await bluePage.getByLabel("March X").fill("47.5");
    await bluePage.getByLabel("March Y").fill("22.5");
    await bluePage.locator("[data-spell-select]").selectOption("fireball");
    await bluePage.locator("[data-draft-spell]").click();
    await bluePage.getByRole("button", { name: "Submit orders" }).click();
    await expect(bluePage.locator("[data-revision]")).toHaveText("1");

    await redPage.locator("[data-ready-box] summary").click();
    await redPage.locator("[data-ready-trigger]").selectOption("enemyCasts");
    await redPage.locator("[data-ready-response]").selectOption("countermarch");
    await redPage.locator("[data-draft-ready]").click();
    await redPage.getByRole("button", { name: "Submit orders" }).click();
    await expect(redPage.locator("[data-revision]")).toHaveText("2");

    await gmFrame.getByRole("button", { name: "Close and resolve" }).click();
    await expect(gmFrame.locator('[data-version="1"]')).toBeVisible({ timeout: 20_000 });
    await expect(bluePage.locator('[data-version="1"]')).toBeVisible();

    // Fireball slot decremented (2 -> 1 left) and Iron Raiders took PF1e Reflex-save casualties (< 12 alive)!
    await expect(bluePage.locator("[data-draft-spell]")).toContainText("1 left");
    const redAliveTurn1 = await redPage
      .locator('[data-own-unit-card="u-red"] .unit-weapon')
      .textContent();
    expect(redAliveTurn1).toMatch(/Melee · ([0-9]|1[01])\b/);

    // 6. Phase C Turn 2: GM opens Turn 2, Blue uses Wand of Cure Light Wounds (4 -> 3 charges)!
    await gmFrame.getByRole("button", { name: "Open next turn" }).click();
    await expect(bluePage.locator("[data-item-select]")).toBeEnabled();
    await bluePage.locator("[data-item-select]").selectOption("wand-clw");
    await bluePage.locator("[data-draft-item]").click();
    await bluePage.getByRole("button", { name: "Submit orders" }).click();

    await gmFrame.getByRole("button", { name: "Close and resolve" }).click();
    await expect(gmFrame.locator('[data-version="2"]')).toBeVisible({ timeout: 20_000 });
    await expect(bluePage.locator("[data-draft-item]")).toContainText("3 left");

    // 7. Phase E: Simulate concurrent campaign edit on Warlord Ghor -> Preview reconciliation -> Apply -> Undo!
    await page.evaluate(() => {
      const client = (
        globalThis as {
          __vttE2E?: { app?: { gm?: { client?: { submit(ops: unknown[]): string } } } };
        }
      ).__vttE2E?.app?.gm?.client;
      client?.submit([
        {
          kind: "update",
          ref: { coll: "actors", id: "act-red-warlord" },
          diff: { name: "Warlord Ghor (Edited in Campaign)" },
        },
      ]);
    });

    await page.getByRole("button", { name: "Manage battle & invites" }).click();
    await page.getByLabel("GM launch key").fill(key);
    await page.locator("[data-reconcile-preview-btn]").click();
    const preview = page.locator("[data-reconciliation-preview]");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Reconciliation Preview · Turn 2");
    await expect(preview.locator('[data-reconcile-door="door-gate"]')).toContainText("Open");
    await expect(preview.locator("[data-reconciliation-conflicts]")).toContainText(
      "actors/act-red-warlord",
    );

    await page.locator("[data-reconcile-apply-btn]").click();
    await expect(page.getByLabel("Multiplayer strategic battle", { exact: true })).toHaveCount(0);

    // Verify atomic campaign write-back (door open, darkness preserved, Fireball expended, wand charges 3, conflicted actor preserved)
    const reconciledState = await page.evaluate(() => {
      const store = (
        globalThis as {
          __vttE2E?: {
            app?: {
              gm?: {
                client?: {
                  store?: {
                    get(coll: string, id: string): Record<string, unknown> | undefined;
                  };
                };
              };
            };
          };
        }
      ).__vttE2E?.app?.gm?.client?.store;
      const scene = store?.get("scenes", "scene-gate") as
        | { walls: Array<{ door: number }>; flags: { core?: Record<string, unknown> } }
        | undefined;
      const blueCap = store?.get("actors", "act-blue-cap") as
        | {
            items: Array<{ _id: string; system: { pf1e: { charges: number } } }>;
            system: { pf1e: { spells: { prepared: Array<{ id: string; expended?: boolean }> } } };
          }
        | undefined;
      const redWarlord = store?.get("actors", "act-red-warlord") as { name: string } | undefined;
      return {
        door: scene?.walls[0]?.door,
        hasActiveBinding: Boolean(scene?.flags?.core?.campaignBattle),
        hasAuditSummary: Boolean(scene?.flags?.core?.lastHostedBattle),
        wandCharges: blueCap?.items.find((i) => i._id === "wand-clw")?.system.pf1e.charges,
        fireballExpended: blueCap?.system.pf1e.spells.prepared.find((p) => p.id === "prep-fb-1")
          ?.expended,
        redWarlordName: redWarlord?.name,
      };
    });

    expect(reconciledState).toEqual({
      door: 1,
      hasActiveBinding: false,
      hasAuditSummary: true,
      wandCharges: 3,
      fireballExpended: true,
      redWarlordName: "Warlord Ghor (Edited in Campaign)",
    });

    // Single-step GM Undo reverts the entire battle reconciliation envelope cleanly!
    await chromeAction(page, "gm-undo");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const store = (
            globalThis as {
              __vttE2E?: {
                app?: {
                  gm?: {
                    client?: {
                      store?: {
                        get(coll: string, id: string): Record<string, unknown> | undefined;
                      };
                    };
                  };
                };
              };
            }
          ).__vttE2E?.app?.gm?.client?.store;
          const scene = store?.get("scenes", "scene-gate") as
            | { walls: Array<{ door: number }> }
            | undefined;
          const blueCap = store?.get("actors", "act-blue-cap") as
            | { items: Array<{ _id: string; system: { pf1e: { charges: number } } }> }
            | undefined;
          return {
            door: scene?.walls[0]?.door,
            wandCharges: blueCap?.items.find((i) => i._id === "wand-clw")?.system.pf1e.charges,
          };
        }),
      )
      .toEqual({
        door: 0,
        wandCharges: 4,
      });
  } finally {
    await stop();
  }
});
