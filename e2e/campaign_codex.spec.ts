/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
  ActorDocument,
  AssetManifestEntry,
  CodexAudience,
  CodexQuest,
  ItemDocument,
  JournalDocument,
  SceneDocument,
} from "../src/core/documents";
import { entry, manualFragment, playerCall, surfaceCallArg, waitForSurface } from "./lib";

const viewerId = "codex-e2e-player";
const otherViewerId = "codex-e2e-other-player";
const rootId = "codex-e2e-group";
const npcId = "codex-e2e-npc";
const tagId = "codex-e2e-tag";
const lootId = "codex-e2e-loot";
const lootItemId = "codex-e2e-loot-item";
const lootActorId = "codex-e2e-loot-actor";
const editorEntryId = "codex-e2e-editor-entry";
const editorActorId = "codex-e2e-editor-actor";

function baseJournal(
  id: string,
  name: string,
  kind: "group" | "npc" | "tag" | "entry",
  text: string,
): JournalDocument {
  return {
    _id: id,
    type: "journal",
    name,
    ownership: { default: 3 },
    flags: {},
    system: {},
    pages: [{
      _id: `${id}-page`,
      type: "page",
      name: "Overview",
      ownership: { default: 3 },
      flags: {},
      system: {},
      text,
      src: null,
      codex: { tabKey: "info", label: "Overview", order: 0, audience: { kind: "inherit" } },
    }],
    codex: {
      version: 1,
      kind,
      subtitle: `${name} field notes`,
      tabs: [{ key: "info", label: "Info", order: 0, audience: { kind: "inherit" } }],
      links: [],
      widgets: [],
      quests: [],
    },
  };
}

function remapBundleZipIds(bytes: Uint8Array, idMap: Readonly<Record<string, string>>): Uint8Array {
  const files = unzipSync(bytes);
  const index = files["campaign-codex.json"];
  if (!index) throw new Error("Campaign Codex bundle index is missing.");
  const replaceIds = (value: unknown): unknown => {
    if (typeof value === "string") return idMap[value] ?? value;
    if (Array.isArray(value)) return value.map(replaceIds);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceIds(child)]));
  };
  files["campaign-codex.json"] = strToU8(JSON.stringify(replaceIds(JSON.parse(strFromU8(index)))));
  return zipSync(files, { level: 6 });
}

function quest(
  id: string,
  title: string,
  pinned: boolean,
  audience: CodexAudience,
): CodexQuest {
  return {
    id,
    title,
    description: "Ask at dawn.",
    state: "active",
    pinned,
    order: 0,
    audience,
    objectives: id === "public-quest"
      ? [{ id: "public-objective", title: "Speak to the ferryman", completed: false, order: 0,
          audience: { kind: "inherit" }, children: [] }]
      : [],
  };
}

function codexFixtures(): JournalDocument[] {
  const group = baseJournal(rootId, "Northern Alliance", "group", "A network of scouts.");
  const npc = baseJournal(
    npcId,
    "Northern Contact",
    "npc",
    "The contact knows the pass. <secret>The cellar cipher is blue lantern.</secret>",
  );
  const tag = baseJournal(tagId, "Old Town", "tag", "A discovery tag.");
  const loot = baseJournal(lootId, "Abandoned supply cache", "entry", "A small cache for testing loot claims.");
  npc.taggerTags = ["Travel", "Northern"];
  npc.codex!.tabs!.push(
    { key: "gm-notes", label: "Private notes", order: 1, audience: { kind: "gmOnly" } },
    { key: "ari-notes", label: "Ari notes", order: 2, audience: { kind: "selectedUsers", userIds: [viewerId] } },
  );
  npc.pages.push(
    {
      _id: `${npcId}-private-page`, type: "page", name: "Cipher notes", ownership: { default: 3 }, flags: {}, system: {},
      text: "The cellar cipher is blue lantern.", src: null,
      codex: { tabKey: "gm-notes", label: "Cipher notes", order: 1, audience: { kind: "gmOnly" } },
    },
    {
      _id: `${npcId}-ari-page`, type: "page", name: "Ari's route", ownership: { default: 3 }, flags: {}, system: {},
      text: "Ari alone knows the river gate.", src: null,
      codex: { tabKey: "ari-notes", label: "Ari's route", order: 0, audience: { kind: "inherit" } },
    },
  );
  npc.codex!.quests = [
    quest("public-quest", "Find the northern bell", true, { kind: "inherit" }),
    quest("selected-quest", "Ari's private clue", false, { kind: "selectedUsers", userIds: [viewerId] }),
    quest("gm-quest", "GM vault quest", false, { kind: "gmOnly" }),
  ];
  npc.codex!.links.push({
    id: "npc-represented-actor",
    relation: "representsActor",
    target: { coll: "actors", id: lootActorId },
  });
  npc.codex!.widgets = [{ id: "quests-widget", type: "quest-list", version: 1, tab: "info", order: 0,
    enabled: true, audience: { kind: "inherit" }, config: {} }];
  group.codex!.links.push(
    { id: "group-npc", relation: "contains", target: { coll: "journals", id: npcId } },
    { id: "group-loot", relation: "contains", target: { coll: "journals", id: lootId } },
  );
  tag.codex!.links.push({ id: "tag-npc", relation: "associatedWith", target: { coll: "journals", id: npcId } });
  loot.codex!.shop = {
    mode: "loot",
    audience: { kind: "inherit" },
    stock: [{ id: "salt-stock", item: { coll: "items", id: lootItemId }, quantity: 5, order: 0 }],
  };
  return [group, npc, tag, loot];
}

function lootItem(): ItemDocument {
  return {
    _id: lootItemId, type: "item", name: "Starlight salt", ownership: { default: 3 }, flags: {},
    system: { quantity: 1, value: 5 }, effects: [],
  };
}

function playerActor(id: string, name: string, items: ItemDocument[] = []): ActorDocument {
  return {
    _id: id, type: "actor", name, ownership: { default: 0, [viewerId]: 3 }, flags: {},
    system: { pf1e: { currency: { gp: 8 } } }, items, effects: [],
  };
}

async function seedWorld(
  page: Page,
  payload: {
    journals: JournalDocument[];
    items: ItemDocument[];
    actors: ActorDocument[];
    scenes?: SceneDocument[];
    assetManifest?: Record<string, AssetManifestEntry>;
  },
): Promise<void> {
  await page.evaluate((serialized) => {
    const { players, journals, items, actors, scenes, assetManifest } = JSON.parse(serialized) as {
      players: Array<{ id: string; name: string }>;
      journals: JournalDocument[];
      items: ItemDocument[];
      actors: ActorDocument[];
      scenes: SceneDocument[];
      assetManifest: Record<string, AssetManifestEntry>;
    };
    const surface = (globalThis as {
      __vttE2E?: { app?: {
        seedPreviewUser(input: { id: string; name: string }): { ok: boolean; error?: string };
        seedAssetManifest(input: { assetId: string; entry: AssetManifestEntry }): { ok: boolean; error?: string };
        gm: { client: { submit(ops: unknown[]): string } };
      } };
    }).__vttE2E;
    const app = surface?.app;
    if (!app) throw new Error("GM E2E app is unavailable");
    for (const [assetId, entry] of Object.entries(assetManifest)) {
      const result = app.seedAssetManifest({ assetId, entry });
      if (!result.ok) throw new Error(result.error ?? "Could not seed a Codex asset-rights entry");
    }
    for (const player of players) {
      const result = app.seedPreviewUser(player);
      if (!result.ok) throw new Error(result.error ?? "Could not seed a Codex preview user");
    }
    app.gm.client.submit([
      ...items.map((data) => ({ kind: "create", coll: "items", data })),
      ...actors.map((data) => ({ kind: "create", coll: "actors", data })),
      ...scenes.map((data) => ({ kind: "create", coll: "scenes", data })),
      ...journals.map((data) => ({ kind: "create", coll: "journals", data })),
    ]);
  }, JSON.stringify({
    ...payload,
    scenes: payload.scenes ?? [],
    assetManifest: payload.assetManifest ?? {},
    players: [
      { id: viewerId, name: "Ari Player" },
      { id: otherViewerId, name: "Bryn Player" },
    ],
  }));
}

async function openCodex(page: Page) {
  await page.locator('[data-tab="journals"]').click();
  await page.locator("[data-open-codex]").click();
  const codex = page.locator("[data-campaign-codex]");
  const nav = codex.getByRole("complementary", { name: "Codex navigator" });
  return { codex, nav };
}

async function openPlayerCodex(page: Page) {
  await page.locator("[data-player-handouts]").click();
  const handouts = page.locator('[data-window="handouts"]');
  await expect(handouts).toBeVisible();
  await handouts.locator("[data-player-codex]").click();
  const codex = handouts.locator("[data-campaign-codex]");
  const nav = codex.getByRole("complementary", { name: "Codex navigator" });
  return { codex, nav };
}

async function connectManualPlayer(host: Page, player: Page, inviteLink: string): Promise<string> {
  const previousAnswer = await host.locator("#share-out").inputValue();
  const joinUrl = `${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`;
  if (player.url() === joinUrl) await player.reload();
  else await player.goto(joinUrl);
  await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
  await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
  await host.locator("#code-apply").click();
  await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe(previousAnswer);
  await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
  await player.locator("#answer-apply").click();
  await expect.poll(() => playerCall<string>(player, "worldName"), { timeout: 30_000 }).toBe("World One");
  await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
  await waitForSurface(player, "player");
  return playerCall<string>(player, "userId");
}

test("Campaign Codex navigation, Quest Board privacy, loot claims, and read-only preview", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.goto(`${entry}?e2e=1`);
  await waitForSurface(page, "app");

  const journals = codexFixtures();
  const lootCharacter = playerActor(lootActorId, "Ari's pack");
  await seedWorld(page, { journals, items: [lootItem()], actors: [lootCharacter] });
  const { codex, nav } = await openCodex(page);
  const sheetRows = nav.locator(".sheet-list [data-codex-sheet]");
  await nav.getByLabel("Filter Codex by relation").selectOption("contains");
  await expect(sheetRows).toHaveCount(1);
  await expect(sheetRows.first()).toHaveAttribute("data-codex-sheet", rootId);
  await nav.getByLabel("Filter Codex by relation").selectOption("associatedWith");
  await expect(sheetRows).toHaveCount(1);
  await expect(sheetRows.first()).toHaveAttribute("data-codex-sheet", tagId);
  await nav.getByLabel("Filter Codex by relation").selectOption("all");

  const npcRow = nav.locator(`[data-codex-sheet="${npcId}"]`);
  await expect(npcRow).toBeVisible();
  await expect(npcRow).toContainText("Northern Contact");
  await npcRow.click();
  await expect(codex.locator("main h2")).toHaveText("Northern Contact");
  await expect(codex.locator("main")).toContainText("The cellar cipher is blue lantern.");
  await expect(codex.locator("main")).toContainText("Ari's route");
  await expect(codex.locator(".page-content")).not.toContainText("Cipher notes");
  await codex.getByRole("button", { name: "Open actor sheet" }).click();
  const actorSheet = page.locator(`[data-window="pf1e-sheet:${lootActorId}"]`);
  await expect(actorSheet).toBeVisible();
  await actorSheet.locator("[data-window-close]").click();

  await page.getByLabel("Preview Campaign Codex as player").selectOption(viewerId);
  await expect(codex.getByText("Read-only permission preview")).toBeVisible();
  await codex.locator('[data-codex-hub-tab="quests"]').click();
  const questBoard = codex.locator("[data-codex-quest-board]");
  const questRows = codex.locator(".quest-board-list [data-codex-quest-id]");
  await expect(questBoard).toBeVisible();
  await expect(questRows).toHaveCount(2);
  await expect(questRows.first()).toContainText("Find the northern bell");
  await expect(questRows.filter({ hasText: "Ari's private clue" })).toHaveCount(1);
  await expect(questRows.filter({ hasText: "GM vault quest" })).toHaveCount(0);
  await expect(questBoard).toContainText("Speak to the ferryman");
  await codex.getByLabel("Search Codex quests").fill("bell");
  await expect(questRows).toHaveCount(1);
  await expect(questRows.first()).toContainText("Find the northern bell");
  await codex.getByLabel("Search Codex quests").fill("");
  await codex.getByLabel("Show unpinned quests").uncheck();
  await expect(questRows).toHaveCount(1);
  await codex.getByLabel("Show unpinned quests").check();
  await expect(questRows).toHaveCount(2);
  await questRows.first().click();
  await codex.locator("[data-codex-open-quest-source]").click();
  await expect(codex.locator("main h2")).toHaveText("Northern Contact");

  await page.getByLabel("Preview Campaign Codex as player").selectOption("");
  await nav.locator(`[data-codex-sheet="${lootId}"]`).click();
  await expect(codex.locator("main h2")).toHaveText("Abandoned supply cache");
  const lootRow = codex.locator(".stock-row").filter({ hasText: "Starlight salt" });
  await expect(lootRow).toContainText("Qty 5");
  await expect(lootRow).not.toContainText("gp");
  await expect(codex.getByLabel("Character for loot claim")).toBeVisible();
  await codex.getByLabel("Character for loot claim").selectOption(lootActorId);
  await codex.getByLabel("Stock transfer quantity").fill("2");
  await codex.getByLabel("Stock transfer quantity").press("Tab");
  await lootRow.getByRole("button", { name: "Claim Starlight salt" }).click();
  await expect(codex.getByRole("status")).toHaveText("Claimed 2 × Starlight salt.");
  await expect(lootRow).toContainText("Qty 3");
  const claimed = await page.evaluate((id) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
    const actor = app?.gm?.client?.store?.get("actors", id) as ActorDocument | undefined;
    if (!actor) return null;
    const currency = (actor.system as { pf1e?: { currency?: { gp?: number } } }).pf1e?.currency;
    return { gp: currency?.gp ?? null, items: actor.items.map((item) => ({ name: item.name, quantity: item.system.quantity })) };
  }, lootActorId);
  expect(claimed).toEqual({ gp: 8, items: [{ name: "Starlight salt", quantity: 2 }] });

  await page.getByLabel("Preview Campaign Codex as player").selectOption(viewerId);
  await expect(codex.getByText("Read-only permission preview")).toBeVisible();
  await expect(codex.getByLabel("Create a campaign quest")).toHaveCount(0);
  await expect(codex.getByRole("button", { name: "Claim loot" })).toHaveCount(0);
  await codex.getByLabel("Northern Contact · NPC").check();
  const markdownDownloadPromise = page.waitForEvent("download");
  await codex.getByRole("button", { name: "Export Markdown" }).click();
  const markdownDownload = await markdownDownloadPromise;
  const exportPath = await markdownDownload.path();
  if (!exportPath) throw new Error("Markdown export did not produce a downloadable file.");
  const archive = unzipSync(new Uint8Array(readFileSync(exportPath)));
  const exportedText = Object.entries(archive).map(([file, bytes]) => `${file}\n${strFromU8(bytes)}`).join("\n");
  expect(exportedText).toContain("Find the northern bell");
  expect(exportedText).toContain("Ari's private clue");
  expect(exportedText).not.toContain("blue lantern");
  expect(exportedText).not.toContain("GM vault quest");

  const playerBundleDownloadPromise = page.waitForEvent("download");
  await codex.getByRole("button", { name: "Export selected bundle" }).click();
  const playerBundleDownload = await playerBundleDownloadPromise;
  const playerBundlePath = await playerBundleDownload.path();
  if (!playerBundlePath) throw new Error("Player-preview selected bundle did not produce a downloadable file.");
  const playerBundleFiles = unzipSync(new Uint8Array(readFileSync(playerBundlePath)));
  const playerBundleIndexBytes = playerBundleFiles["campaign-codex.json"];
  if (!playerBundleIndexBytes) throw new Error("Player-preview bundle omitted its index.");
  const playerBundleIndex = JSON.parse(strFromU8(playerBundleIndexBytes)) as {
    documents: { journals: JournalDocument[] };
    worldId?: string;
  };
  const playerBundleRoot = playerBundleIndex.documents.journals.find((journal) => journal._id === npcId);
  expect(playerBundleRoot?.pages.map((page) => page.name)).toEqual(["Overview", "Ari's route"]);
  expect(playerBundleRoot?.codex?.quests?.map((entry) => entry.title)).toEqual([
    "Find the northern bell", "Ari's private clue",
  ]);
  expect(strFromU8(playerBundleIndexBytes)).not.toContain("blue lantern");
  expect(strFromU8(playerBundleIndexBytes)).not.toContain("GM vault quest");
  expect(playerBundleIndex).not.toHaveProperty("worldId");
  expect(errors).toEqual([]);
});

test("Campaign Codex navigator is keyboard-accessible on a narrow viewport with a large relationship graph", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${entry}?e2e=1`);
  await waitForSurface(page, "app");

  const root = baseJournal("codex-narrow-atlas", "Narrow Atlas", "group", "Large graph viewport test.");
  const children = Array.from({ length: 160 }, (_, index) =>
    baseJournal(`codex-narrow-child-${index}`, `Atlas record ${String(index).padStart(3, "0")}`, "entry", `Record ${index}.`),
  );
  root.codex!.links = children.map((child, index) => ({
    id: `narrow-link-${index}`,
    relation: "contains",
    target: { coll: "journals", id: child._id },
  }));
  await seedWorld(page, { journals: [root, ...children], items: [], actors: [] });
  const { codex, nav } = await openCodex(page);

  const search = nav.getByLabel("Search Codex");
  await expect(search).toBeVisible();
  await expect(nav.getByLabel("Filter Codex by role")).toBeVisible();
  await expect(nav.getByLabel("Filter Codex by tag")).toBeVisible();
  await expect(nav.getByLabel("Filter Codex by relation")).toBeVisible();
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(nav.getByLabel("Filter Codex by role")).toBeFocused();

  await nav.getByLabel("Filter Codex by relation").selectOption("contains");
  const rows = nav.locator(".sheet-list [data-codex-sheet]");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-codex-sheet", root._id);
  await nav.getByLabel("Filter Codex by relation").selectOption("all");
  await expect(rows).toHaveCount(children.length + 1);
  await rows.first().click();
  await expect(codex.locator(".tree-list li")).toHaveCount(children.length);
  await expect(codex.locator(".tree-list .tree-preview").first()).toContainText("Atlas record 000");

  const layout = codex.locator(".codex-layout");
  const columns = await layout.evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(columns.trim().split(/\s+/)).toHaveLength(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("two connected players receive live Codex projections, revocation, and reconnect catch-up", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  const hostCtx = await browser.newContext();
  const ariCtx = await browser.newContext();
  const brynCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const ari = await ariCtx.newPage();
    const bryn = await brynCtx.newPage();
    const errors: string[] = [];
    for (const page of [host, ari, bryn]) page.on("pageerror", (error) => errors.push(error.message));
    await host.goto(`${entry}?e2e=1`);
    await waitForSurface(host, "app");
    await host.locator("#share").click();
    const invite = await host.locator("#invite-link").inputValue();
    const ariId = await connectManualPlayer(host, ari, invite);
    const brynId = await connectManualPlayer(host, bryn, invite);
    expect(brynId).not.toBe(ariId);

    const sheetId = "codex-e2e-multiplayer-atlas";
    const ariActorId = "codex-e2e-multiplayer-ari-actor";
    const brynActorId = "codex-e2e-multiplayer-bryn-actor";
    const privateJournalId = "codex-e2e-multiplayer-private-journal";
    const privateActorId = "codex-e2e-multiplayer-private-actor";
    const privateItemId = "codex-e2e-multiplayer-private-item";
    const privateSceneId = "codex-e2e-multiplayer-private-scene";
    const readableAssetId = "e".repeat(64);
    const gmAssetId = "f".repeat(64);
    const ariAudience: CodexAudience = { kind: "selectedUsers", userIds: [ariId] };
    const brynAudience: CodexAudience = { kind: "selectedUsers", userIds: [brynId] };

    const ariPageId = "codex-e2e-multiplayer-ari-page";
    const root = baseJournal(sheetId, "Shared campaign atlas", "group", "Everyone can read the public overview.");
    root.codex!.cover = gmAssetId;
    root.codex!.tabs!.push(
      { key: "ari-notes", label: "Ari's notes", order: 1, audience: ariAudience },
      { key: "bryn-notes", label: "Bryn's notes", order: 2, audience: brynAudience },
      { key: "gm-notes", label: "GM vault", order: 3, audience: { kind: "gmOnly" } },
    );
    root.pages.push(
      {
        _id: ariPageId, type: "page", name: "Ari's route", ownership: { default: 3 },
        flags: {}, system: {}, text: "ARI_PAGE_SECRET_MARKER", src: null,
        codex: { tabKey: "ari-notes", label: "Ari's route", order: 0, audience: ariAudience },
      },
      {
        _id: "codex-e2e-multiplayer-bryn-page", type: "page", name: "Bryn's route", ownership: { default: 3 },
        flags: {}, system: {}, text: "BRYN_PAGE_SECRET_MARKER", src: null,
        codex: { tabKey: "bryn-notes", label: "Bryn's route", order: 0, audience: brynAudience },
      },
      {
        _id: "codex-e2e-multiplayer-gm-page", type: "page", name: "GM's sealed route", ownership: { default: 3 },
        flags: {}, system: {}, text: "GM_PAGE_SECRET_MARKER", src: null,
        codex: { tabKey: "gm-notes", label: "GM's sealed route", order: 0, audience: { kind: "gmOnly" } },
      },
    );
    const sharedQuest = quest("shared-quest", "Shared quest", true, { kind: "inherit" });
    sharedQuest.objectives.push(
      { id: "public-objective", title: "Public objective", completed: false, order: 0,
        audience: { kind: "inherit" }, children: [] },
      { id: "ari-objective", title: "ARI_OBJECTIVE_SECRET_MARKER", completed: false, order: 1,
        audience: ariAudience, children: [] },
      { id: "bryn-objective", title: "BRYN_OBJECTIVE_SECRET_MARKER", completed: false, order: 2,
        audience: brynAudience, children: [] },
      { id: "gm-objective", title: "GM_OBJECTIVE_SECRET_MARKER", completed: false, order: 3,
        audience: { kind: "gmOnly" }, children: [] },
    );
    root.codex!.quests = [
      sharedQuest,
      quest("ari-quest", "ARI_QUEST_SECRET_MARKER", false, ariAudience),
      quest("bryn-quest", "BRYN_QUEST_SECRET_MARKER", false, brynAudience),
      quest("gm-quest", "GM_QUEST_SECRET_MARKER", false, { kind: "gmOnly" }),
    ];
    root.codex!.links = [
      { id: "ari-link", relation: "representsActor", target: { coll: "actors", id: ariActorId }, audience: ariAudience },
      { id: "bryn-link", relation: "representsActor", target: { coll: "actors", id: brynActorId }, audience: brynAudience },
      { id: "private-journal-link", relation: "relatedTo", target: { coll: "journals", id: privateJournalId } },
      { id: "private-actor-link", relation: "representsActor", target: { coll: "actors", id: privateActorId } },
      { id: "private-item-link", relation: "linksItem", target: { coll: "items", id: privateItemId } },
      { id: "private-scene-link", relation: "linksScene", target: { coll: "scenes", id: privateSceneId } },
    ];
    root.codex!.widgets = [
      { id: "linked-widget", type: "linked-entities", version: 1, tab: "info", order: 0, enabled: true,
        audience: { kind: "inherit" }, config: { linkIds: root.codex!.links.map((link) => link.id) } },
      { id: "quest-widget", type: "quest-list", version: 1, tab: "info", order: 1, enabled: true,
        audience: { kind: "inherit" }, config: { questIds: root.codex!.quests.map((entry) => entry.id) } },
      { id: "gallery-widget", type: "image-gallery", version: 1, tab: "info", order: 2, enabled: true,
        audience: { kind: "inherit" }, config: { images: [
          { assetId: readableAssetId, caption: "Shared map" },
          { assetId: gmAssetId, caption: "GM-only map" },
        ] } },
    ];

    const privateJournal = baseJournal(privateJournalId, "PRIVATE_JOURNAL_NAME_MARKER", "entry", "PRIVATE_JOURNAL_PAGE_MARKER");
    privateJournal.ownership = { default: 0 };
    for (const page of privateJournal.pages) page.ownership = { default: 0 };
    const actor = (id: string, name: string, ownership: 0 | 1): ActorDocument => ({
      _id: id, type: "actor", name, ownership: { default: ownership }, flags: {}, system: {}, items: [], effects: [],
    });
    const actors = [
      actor(ariActorId, "Ari's linked actor", 1),
      actor(brynActorId, "Bryn's linked actor", 1),
      actor(privateActorId, "PRIVATE_ACTOR_NAME_MARKER", 0),
    ];
    const privateItem: ItemDocument = {
      _id: privateItemId, type: "item", name: "PRIVATE_ITEM_NAME_MARKER", ownership: { default: 0 }, flags: {},
      system: { quantity: 1 }, effects: [],
    };
    const privateScene: SceneDocument = {
      _id: privateSceneId, type: "scene", name: "PRIVATE_SCENE_NAME_MARKER", ownership: { default: 0 }, flags: {}, system: {},
      active: false, img: null, width: 1000, height: 800, darkness: 0,
      grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
      tokens: [], walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
    };
    const assetManifest: Record<string, AssetManifestEntry> = {
      [readableAssetId]: { name: "shared.webp", mime: "image/webp", size: 8, chunks: 1,
        visibility: "referenced", exportRights: "granted" },
      [gmAssetId]: { name: "PRIVATE_ASSET_NAME_MARKER", mime: "image/webp", size: 8, chunks: 1,
        visibility: "gm", exportRights: "restricted" },
    };
    await host.evaluate((serialized) => {
      const { root, privateJournal, actors, privateItem, privateScene, assetManifest } = JSON.parse(serialized) as {
        root: JournalDocument; privateJournal: JournalDocument; actors: ActorDocument[];
        privateItem: ItemDocument; privateScene: SceneDocument; assetManifest: Record<string, AssetManifestEntry>;
      };
      const app = (globalThis as { __vttE2E?: { app?: {
        seedAssetManifest(input: { assetId: string; entry: AssetManifestEntry }): { ok: boolean; error?: string };
        gm: { client: { submit(ops: unknown[]): string } };
      } } }).__vttE2E?.app;
      if (!app?.gm?.client) throw new Error("GM E2E client is unavailable");
      for (const [assetId, entry] of Object.entries(assetManifest)) {
        const result = app.seedAssetManifest({ assetId, entry });
        if (!result.ok) throw new Error(result.error ?? "Could not seed the Codex asset manifest");
      }
      app.gm.client.submit([
        ...actors.map((data) => ({ kind: "create", coll: "actors", data })),
        { kind: "create", coll: "items", data: privateItem },
        { kind: "create", coll: "scenes", data: privateScene },
        { kind: "create", coll: "journals", data: privateJournal },
        { kind: "create", coll: "journals", data: root },
      ]);
    }, JSON.stringify({ root, privateJournal, actors, privateItem, privateScene, assetManifest }));

    type Projection = Array<{
      _id: string;
      name: string;
      pages: Array<{ _id: string; name: string; text: string }>;
      codex: NonNullable<JournalDocument["codex"]>;
    }>;
    const readProjection = (page: Page) => playerCall<Projection>(page, "codexProjection");
    type ReplicaSummary = {
      journals: Array<{ id: string; name: string }>;
      actors: Array<{ id: string; name: string }>;
      items: Array<{ id: string; name: string }>;
      scenes: Array<{ id: string; name: string }>;
      assetIds: string[];
    };
    const readReplica = (page: Page) => playerCall<ReplicaSummary>(page, "codexReplicaSummary");
    const assertPrivateRowsOmitted = async (page: Page) => {
      const replica = await readReplica(page);
      expect(replica.journals.map((journal) => journal.id)).not.toContain(privateJournalId);
      expect(replica.actors.map((actor) => actor.id)).not.toContain(privateActorId);
      expect(replica.items.map((item) => item.id)).not.toContain(privateItemId);
      expect(replica.scenes.map((scene) => scene.id)).not.toContain(privateSceneId);
      expect(replica.assetIds).not.toContain(gmAssetId);
      return replica;
    };
    await expect.poll(async () => (await readProjection(ari)).some((journal) => journal._id === sheetId)).toBe(true);
    await expect.poll(async () => (await readProjection(bryn)).some((journal) => journal._id === sheetId)).toBe(true);
    const ariSnapshot = await readProjection(ari);
    const brynSnapshot = await readProjection(bryn);
    const ariRoot = ariSnapshot.find((journal) => journal._id === sheetId);
    const brynRoot = brynSnapshot.find((journal) => journal._id === sheetId);
    expect(ariRoot).toBeDefined();
    expect(brynRoot).toBeDefined();
    expect(ariRoot?.pages.map((page) => page.name).sort()).toEqual(["Ari's route", "Overview"]);
    expect(brynRoot?.pages.map((page) => page.name).sort()).toEqual(["Bryn's route", "Overview"]);
    expect(ariRoot?.codex.tabs?.map((tab) => tab.key)).toEqual(["info", "ari-notes"]);
    expect(brynRoot?.codex.tabs?.map((tab) => tab.key)).toEqual(["info", "bryn-notes"]);
    expect(ariRoot?.codex.links.map((link) => link.id)).toEqual(["ari-link"]);
    expect(brynRoot?.codex.links.map((link) => link.id)).toEqual(["bryn-link"]);
    expect(ariRoot?.codex.quests?.map((entry) => entry.id)).toEqual(["shared-quest", "ari-quest"]);
    expect(brynRoot?.codex.quests?.map((entry) => entry.id)).toEqual(["shared-quest", "bryn-quest"]);
    expect(ariRoot?.codex.quests?.[0]?.objectives.map((objective) => objective.id)).toEqual(["public-objective", "ari-objective"]);
    expect(brynRoot?.codex.quests?.[0]?.objectives.map((objective) => objective.id)).toEqual(["public-objective", "bryn-objective"]);
    const ariLinkedWidget = ariRoot?.codex.widgets.find((widget) => widget.id === "linked-widget");
    const brynLinkedWidget = brynRoot?.codex.widgets.find((widget) => widget.id === "linked-widget");
    expect(ariLinkedWidget?.config).toEqual({ linkIds: ["ari-link"] });
    expect(brynLinkedWidget?.config).toEqual({ linkIds: ["bryn-link"] });
    const ariQuestWidget = ariRoot?.codex.widgets.find((widget) => widget.id === "quest-widget");
    const brynQuestWidget = brynRoot?.codex.widgets.find((widget) => widget.id === "quest-widget");
    expect(ariQuestWidget?.config).toEqual({ questIds: ["shared-quest", "ari-quest"] });
    expect(brynQuestWidget?.config).toEqual({ questIds: ["shared-quest", "bryn-quest"] });
    const ariGallery = ariRoot?.codex.widgets.find((widget) => widget.id === "gallery-widget")?.config as
      | { images: Array<{ assetId: string }> }
      | undefined;
    const brynGallery = brynRoot?.codex.widgets.find((widget) => widget.id === "gallery-widget")?.config as
      | { images: Array<{ assetId: string }> }
      | undefined;
    expect(ariGallery?.images.map((image) => image.assetId)).toEqual([readableAssetId]);
    expect(brynGallery?.images.map((image) => image.assetId)).toEqual([readableAssetId]);
    const ariSerialized = JSON.stringify(ariSnapshot);
    const brynSerialized = JSON.stringify(brynSnapshot);
    expect(ariSerialized).toContain("ARI_PAGE_SECRET_MARKER");
    expect(ariSerialized).toContain("ARI_QUEST_SECRET_MARKER");
    expect(ariSerialized).toContain("ARI_OBJECTIVE_SECRET_MARKER");
    expect(ariSerialized).not.toContain("BRYN_PAGE_SECRET_MARKER");
    expect(ariSerialized).not.toContain("BRYN_QUEST_SECRET_MARKER");
    expect(ariSerialized).not.toContain("BRYN_OBJECTIVE_SECRET_MARKER");
    expect(brynSerialized).toContain("BRYN_PAGE_SECRET_MARKER");
    expect(brynSerialized).toContain("BRYN_QUEST_SECRET_MARKER");
    expect(brynSerialized).toContain("BRYN_OBJECTIVE_SECRET_MARKER");
    expect(brynSerialized).not.toContain("ARI_PAGE_SECRET_MARKER");
    expect(brynSerialized).not.toContain("ARI_QUEST_SECRET_MARKER");
    expect(brynSerialized).not.toContain("ARI_OBJECTIVE_SECRET_MARKER");
    for (const serialized of [ariSerialized, brynSerialized]) {
      for (const marker of [
        "GM_PAGE_SECRET_MARKER", "GM_QUEST_SECRET_MARKER", "GM_OBJECTIVE_SECRET_MARKER",
        "PRIVATE_JOURNAL_PAGE_MARKER", privateJournalId, privateActorId, privateItemId, privateSceneId, gmAssetId,
        "PRIVATE_JOURNAL_NAME_MARKER", "PRIVATE_ACTOR_NAME_MARKER", "PRIVATE_ITEM_NAME_MARKER",
        "PRIVATE_SCENE_NAME_MARKER", "PRIVATE_ASSET_NAME_MARKER", "private-journal-link", "private-actor-link",
        "private-item-link", "private-scene-link",
      ]) expect(serialized).not.toContain(marker);
    }
    const ariPanel = await openPlayerCodex(ari);
    const brynPanel = await openPlayerCodex(bryn);
    for (const { codex } of [ariPanel, brynPanel]) {
      await expect(codex.locator("main h2")).toHaveText("Shared campaign atlas");
      await expect(codex.locator(".page-content")).toContainText("Everyone can read the public overview.");
    }
    const ariCodex = ariPanel.codex;
    const brynCodex = brynPanel.codex;
    await ariCodex.locator('[data-codex-tab="ari-notes"]').click();
    await expect(ariCodex.locator(".page-content")).toContainText("ARI_PAGE_SECRET_MARKER");
    await expect(ariCodex.locator('[data-codex-tab="bryn-notes"]')).toHaveCount(0);
    await brynCodex.locator('[data-codex-tab="bryn-notes"]').click();
    await expect(brynCodex.locator(".page-content")).toContainText("BRYN_PAGE_SECRET_MARKER");
    await expect(brynCodex.locator('[data-codex-tab="ari-notes"]')).toHaveCount(0);

    const updatedCodex = structuredClone(root.codex!);
    if (updatedCodex.tabs) {
      updatedCodex.tabs = updatedCodex.tabs.map((tab) => tab.key === "ari-notes" ? { ...tab, audience: brynAudience } : tab);
    }
    updatedCodex.links = updatedCodex.links.map((link) => link.id === "ari-link" ? { ...link, audience: brynAudience } : link);
    if (updatedCodex.quests) {
      updatedCodex.quests = updatedCodex.quests.map((entry) => entry.id === "ari-quest" ? { ...entry, audience: brynAudience } : entry);
      updatedCodex.quests[0]?.objectives.forEach((objective) => {
        if (objective.id === "ari-objective") objective.audience = brynAudience;
      });
    }
    await host.evaluate(({ sheetId, pageId, codexJson, brynAudience }) => { const codex = JSON.parse(codexJson) as JournalDocument["codex"];
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { submit(ops: unknown[]): string } } } } }).__vttE2E?.app;
      if (!app?.gm?.client) throw new Error("GM E2E client is unavailable");
      app.gm.client.submit([
        { kind: "update", ref: { coll: "journals", id: sheetId }, diff: { codex } },
        { kind: "update", ref: { coll: "pages", id: pageId, parent: { coll: "journals", id: sheetId } },
          diff: { codex: { tabKey: "ari-notes", label: "Ari's route", order: 0, audience: brynAudience } } },
      ]);
    }, { sheetId, pageId: ariPageId, codexJson: JSON.stringify(updatedCodex), brynAudience });

    await expect.poll(async () => JSON.stringify(await readProjection(ari))).not.toContain("ARI_PAGE_SECRET_MARKER");
    await expect.poll(async () => JSON.stringify(await readProjection(ari))).not.toContain("ARI_QUEST_SECRET_MARKER");
    await expect.poll(async () => JSON.stringify(await readProjection(bryn))).toContain("ARI_PAGE_SECRET_MARKER");
    await expect.poll(async () => JSON.stringify(await readProjection(bryn))).toContain("ARI_QUEST_SECRET_MARKER");
    const ariAfterRevoke = await readProjection(ari);
    const brynAfterGrant = await readProjection(bryn);
    expect(ariAfterRevoke.find((journal) => journal._id === sheetId)?.pages.map((page) => page.name).sort()).toEqual([
      "Overview",
    ]);
    expect(brynAfterGrant.find((journal) => journal._id === sheetId)?.pages.map((page) => page.name).sort()).toEqual([
      "Ari's route", "Bryn's route", "Overview",
    ]);
    expect(ariAfterRevoke.find((journal) => journal._id === sheetId)?.codex.links.map((link) => link.id)).toEqual([]);
    expect(brynAfterGrant.find((journal) => journal._id === sheetId)?.codex.links.map((link) => link.id)).toEqual([
      "ari-link", "bryn-link",
    ]);
    expect(ariAfterRevoke.find((journal) => journal._id === sheetId)?.codex.widgets
      .find((widget) => widget.id === "linked-widget")?.config).toEqual({ linkIds: [] });
    expect(brynAfterGrant.find((journal) => journal._id === sheetId)?.codex.widgets
      .find((widget) => widget.id === "linked-widget")?.config).toEqual({ linkIds: ["ari-link", "bryn-link"] });
    expect(ariAfterRevoke.find((journal) => journal._id === sheetId)?.codex.widgets
      .find((widget) => widget.id === "quest-widget")?.config).toEqual({ questIds: ["shared-quest"] });
    expect(brynAfterGrant.find((journal) => journal._id === sheetId)?.codex.widgets
      .find((widget) => widget.id === "quest-widget")?.config).toEqual({
        questIds: ["shared-quest", "ari-quest", "bryn-quest"],
      });
    await expect(ariCodex.locator('[data-codex-tab="ari-notes"]')).toHaveCount(0);
    await expect(ariCodex.locator(".page-content")).not.toContainText("ARI_PAGE_SECRET_MARKER");
    await expect(brynCodex.locator('[data-codex-tab="ari-notes"]')).toHaveCount(1);
    await brynCodex.locator('[data-codex-tab="ari-notes"]').click();
    await expect(brynCodex.locator(".page-content")).toContainText("ARI_PAGE_SECRET_MARKER");
    await assertPrivateRowsOmitted(ari);
    await assertPrivateRowsOmitted(bryn);
    expect(errors).toEqual([]);

    expect(await connectManualPlayer(host, ari, invite)).toBe(ariId);
    await waitForSurface(ari, "player");
    const reconnectedProjection = await readProjection(ari);
    expect(JSON.stringify(reconnectedProjection)).not.toContain("ARI_PAGE_SECRET_MARKER");
    expect(JSON.stringify(reconnectedProjection)).not.toContain("ARI_QUEST_SECRET_MARKER");
    expect(JSON.stringify(reconnectedProjection)).not.toContain("ARI_OBJECTIVE_SECRET_MARKER");
    await expect.poll(async () => JSON.stringify(await readProjection(ari))).not.toContain("PRIVATE_JOURNAL_NAME_MARKER");
    await assertPrivateRowsOmitted(ari);
    const reconnectedPanel = await openPlayerCodex(ari);
    await expect(reconnectedPanel.codex.locator('[data-codex-tab="ari-notes"]')).toHaveCount(0);
    await expect(reconnectedPanel.codex.locator("main")).not.toContainText("ARI_PAGE_SECRET_MARKER");
    expect(errors).toEqual([]);
  } finally {
    await brynCtx.close();
    await ariCtx.close();
    await hostCtx.close();
  }
});

test("GM creates stock items and manages player-character inventory without making preview actionable", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.goto(`${entry}?e2e=1`);
  await waitForSurface(page, "app");

  const characterItem: ItemDocument = {
    _id: "codex-editor-rations", type: "item", name: "Trail rations", ownership: { default: 0 }, flags: {},
    system: { category: "equipment", quantity: 2, value: 1, weight: 1, description: { value: "Dry travel food." } },
    effects: [],
  };
  const actor = playerActor(editorActorId, "Mira", [characterItem]);
  const unsupportedWalletActor = { ...actor, _id: "codex-editor-no-wallet", name: "No wallet", system: {} };
  const unsupportedPriceItem: ItemDocument = {
    _id: "codex-editor-unpriced", type: "item", name: "Unpriced relic", ownership: { default: 1 }, flags: {},
    system: { category: "equipment", quantity: 1, value: "not-a-price", weight: 0.5 }, effects: [],
  };
  const market = baseJournal(editorEntryId, "Market Supplies", "entry", "A public market.");
  market.codex!.shop = {
    mode: "shop", audience: { kind: "inherit" }, markup: 1,
    stock: [{ id: "codex-editor-unpriced-stock", item: { coll: "items", id: unsupportedPriceItem._id }, quantity: 1, order: 0 }],
  };
  await seedWorld(page, { journals: [market], items: [unsupportedPriceItem], actors: [actor, unsupportedWalletActor] });

  const { codex, nav } = await openCodex(page);
  await expect(nav.locator(`[data-codex-sheet="${editorEntryId}"]`)).toBeVisible();
  await nav.locator(`[data-codex-sheet="${editorEntryId}"]`).click();
  await expect(codex.locator("main h2")).toHaveText("Market Supplies");
  const purchaseCharacter = codex.getByLabel("Character for purchase");
  await purchaseCharacter.selectOption(editorActorId);
  const unpricedRow = codex.locator(".stock-row").filter({ hasText: "Unpriced relic" });
  await expect(unpricedRow).toContainText("Price unavailable");
  await expect(unpricedRow).toContainText("This item has no supported non-negative PF1e price.");
  await expect(unpricedRow.getByRole("button", { name: "Purchase unavailable" })).toBeDisabled();

  await codex.getByText("Create an item for this stock").click();
  await codex.getByLabel("New shop item name").fill("Silverleaf Antidote");
  await codex.getByLabel("New shop item description").fill("A bitter green cure.");
  await codex.getByLabel("New shop item weight").fill("0.25");
  await codex.getByLabel("New shop item price").fill("2.50");
  await codex.getByLabel("New shop item quantity").fill("4");
  await codex.getByRole("button", { name: "Create item and add stock" }).click();
  const stockRow = codex.locator(".stock-row").filter({ hasText: "Silverleaf Antidote" });
  await expect(stockRow).toContainText("Qty 4");
  await expect(stockRow).toContainText("2.50 gp");
  await stockRow.getByText("Edit item details").click();
  const stockName = codex.getByLabel("Name for Silverleaf Antidote");
  await stockName.fill("Silverleaf Antidote Plus");
  await stockName.press("Tab");
  await expect(stockRow.locator(".stock-row-summary strong")).toHaveText("Silverleaf Antidote Plus");
  const stockQuantity = codex.getByLabel("Quantity for Silverleaf Antidote Plus");
  await stockQuantity.fill("3");
  await stockQuantity.press("Tab");
  await expect(stockRow).toContainText("Qty 3");
  const stockPrice = codex.getByLabel("Unit price for Silverleaf Antidote Plus");
  await stockPrice.fill("4.25");
  await stockPrice.press("Tab");
  await expect(stockRow).toContainText("4.25 gp");
  await codex.getByLabel("Shop markup").fill("2");
  await codex.getByLabel("Shop markup").press("Tab");
  await expect(stockRow).toContainText("8.50 gp");
  await purchaseCharacter.selectOption(unsupportedWalletActor._id);
  await expect(stockRow.getByRole("button", { name: "Purchase unavailable" })).toBeDisabled();
  await expect(stockRow).toContainText("This actor has no supported PF1e currency block.");
  await purchaseCharacter.selectOption(editorActorId);
  // The wallet is valid (but only 8 GP), so the UI leaves the 8.50 GP purchase to host validation.
  await expect(stockRow.getByRole("button", { name: "Buy · 8.50 gp" })).toBeEnabled();

  await codex.getByText("Manage a character's inventory").click();
  await codex.getByLabel("Character inventory to edit").selectOption(editorActorId);
  const inventoryQuantity = codex.getByLabel("Inventory quantity for Trail rations");
  await inventoryQuantity.fill("5");
  await inventoryQuantity.press("Tab");
  await expect(codex.getByLabel("Inventory quantity for Trail rations")).toHaveValue("5");
  const inventoryName = codex.getByLabel("Inventory item name Trail rations");
  await inventoryName.fill("Trail rations bundle");
  await inventoryName.press("Tab");
  await expect(codex.locator(".inventory-item-card").filter({ hasText: "Trail rations bundle" })).toBeVisible();
  await codex.getByLabel("New inventory item name").fill("Dried fruit");
  await codex.getByLabel("New inventory item description").fill("A small travel snack.");
  await codex.getByLabel("New inventory item weight").fill("0.2");
  await codex.getByLabel("New inventory item price").fill("0.5");
  await codex.getByLabel("New inventory item quantity").fill("3");
  await codex.getByRole("button", { name: "Add to inventory" }).click();
  await expect(codex.locator(".inventory-item-card")).toHaveCount(2);
  await expect(codex.locator(".inventory-item-list")).toContainText("Dried fruit");

  await codex.getByLabel("Preview Campaign Codex as player").selectOption(viewerId);
  await expect(codex.getByText("Read-only permission preview")).toBeVisible();
  await expect(stockRow).toContainText("8.50 gp");
  await expect(codex.getByText("Create an item for this stock")).toHaveCount(0);
  await expect(codex.getByText("Manage a character's inventory")).toHaveCount(0);
  await expect(stockRow.getByRole("button", { name: "Purchase preview" })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("a connected player purchases shop stock through the Codex UI", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const errors: string[] = [];
    for (const page of [host, player]) page.on("pageerror", (error) => errors.push(error.message));
    await host.goto(`${entry}?e2e=1`);
    await waitForSurface(host, "app");

    const itemId = "codex-e2e-shop-tonic";
    const shopId = "codex-e2e-live-shop";
    const stockRowId = "codex-e2e-tonic-stock";
    const actorId = "codex-e2e-live-buyer";
    const item: ItemDocument = {
      _id: itemId, type: "item", name: "Ember Draught", ownership: { default: 1 }, flags: {},
      system: { category: "equipment", quantity: 1, value: 2, weight: 0.1,
        description: { value: "A warm, restorative drink." } }, effects: [],
    };
    const shop = baseJournal(shopId, "Wayfarer's Shelf", "entry", "A roadside shop.");
    shop.codex!.shop = {
      mode: "shop", audience: { kind: "inherit" }, markup: 1,
      stock: [{ id: stockRowId, item: { coll: "items", id: itemId }, quantity: 6, unitPrice: "2", order: 0 }],
    };
    await seedWorld(host, { journals: [shop], items: [item], actors: [] });

    await host.locator("#share").click();
    const invite = await host.locator("#invite-link").inputValue();
    await player.goto(`${entry}?e2e=1&join=1#${manualFragment(invite)}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => player.locator("#pstatus").textContent(), { timeout: 30_000 }).toContain("World One");
    await waitForSurface(player, "player");
    const playerId = await playerCall<string>(player, "userId");

    const actor: ActorDocument = {
      _id: actorId, type: "actor", name: "Ari's pack", ownership: { default: 0, [playerId]: 3 },
      flags: {}, system: { pf1e: { currency: { pp: 0, gp: 10, sp: 0, cp: 0 } } }, items: [], effects: [],
    };
    await host.evaluate((serialized) => {
      const data = JSON.parse(serialized) as ActorDocument;
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { submit(ops: unknown[]): string } } } } }).__vttE2E?.app;
      if (!app?.gm?.client) throw new Error("GM E2E client is unavailable");
      app.gm.client.submit([{ kind: "create", coll: "actors", data }]);
    }, JSON.stringify(actor));

    await player.locator("[data-player-handouts]").click();
    const handouts = player.locator('[data-window="handouts"]');
    await expect(handouts).toBeVisible();
    await handouts.locator("[data-player-codex]").click();
    const codex = handouts.locator("[data-campaign-codex]");
    const nav = codex.getByRole("complementary", { name: "Codex navigator" });
    await nav.locator(`[data-codex-sheet="${shopId}"]`).click();
    await expect(codex.locator("main h2")).toHaveText("Wayfarer's Shelf");
    const stockRow = codex.locator(".stock-list li").filter({ hasText: "Ember Draught" });
    await expect(stockRow).toContainText("Qty 6");
    const character = codex.getByLabel("Character for purchase");
    await expect(character.locator(`option[value="${actorId}"]`)).toHaveCount(1);
    await character.selectOption(actorId);
    const quantity = codex.getByLabel("Stock transfer quantity");
    await quantity.fill("2");
    await quantity.press("Tab");
    await stockRow.getByRole("button", { name: "Buy · 2.00 gp" }).click();
    await expect(codex.getByRole("status")).toHaveText("Purchased 2 × Ember Draught.");
    await expect(stockRow).toContainText("Qty 4");

    // Four more would cost 8 GP, but only 6 remain: host denial leaves stock and actor untouched.
    await quantity.fill("4");
    await quantity.press("Tab");
    await stockRow.getByRole("button", { name: "Buy · 2.00 gp" }).click();
    await expect(codex.getByRole("status")).toHaveText("There are not enough funds for this purchase.");
    await expect(stockRow).toContainText("Qty 4");

    const purchased = await host.evaluate((id) => {
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
      const actor = app?.gm?.client?.store?.get("actors", id) as ActorDocument | undefined;
      if (!actor) return null;
      const currency = (actor.system as { pf1e?: { currency?: { gp?: number } } }).pf1e?.currency;
      return {
        gp: currency?.gp ?? null,
        items: actor.items.map((owned) => ({ name: owned.name, quantity: owned.system.quantity })),
      };
    }, actorId);
    expect(purchased).toEqual({ gp: 6, items: [{ name: "Ember Draught", quantity: 2 }] });
    await expect(player.locator('[data-testid="action-revert-history"]')).toHaveCount(0);
    await host.locator('[data-tab="chat"]').click();
    const receipt = host.locator('[data-testid="action-revert-card"]').filter({ hasText: "Codex purchase: Ember Draught" });
    await expect(receipt).toContainText("ready");
    await receipt.getByTestId("action-revert").click();
    await expect(receipt).toContainText("reverted");
    await expect(stockRow).toContainText("Qty 6");
    const restored = await host.evaluate((id) => {
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
      const actor = app?.gm?.client?.store?.get("actors", id) as ActorDocument | undefined;
      if (!actor) return null;
      const currency = (actor.system as { pf1e?: { currency?: { gp?: number } } }).pf1e?.currency;
      return { gp: currency?.gp ?? null, items: actor.items.map((owned) => owned.name) };
    }, actorId);
    expect(restored).toEqual({ gp: 10, items: [] });

    // Send the same host-authoritative purchase request twice with one ID. The retry may be
    // acknowledged again, but it must not spend currency or stock twice.
    const retryRequest = {
      sheetId: shopId, stockRowId, quantity: 1, actorId, requestId: "codex-e2e-purchase-retry",
    };
    const retryIds = await Promise.all([
      surfaceCallArg<string>(player, "player", "codexPurchase", retryRequest),
      surfaceCallArg<string>(player, "player", "codexPurchase", retryRequest),
    ]);
    expect(retryIds).toEqual([retryRequest.requestId, retryRequest.requestId]);
    await expect(stockRow).toContainText("Qty 5");
    const afterRetry = await host.evaluate((id) => {
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
      const actor = app?.gm?.client?.store?.get("actors", id) as ActorDocument | undefined;
      if (!actor) return null;
      const currency = (actor.system as { pf1e?: { currency?: { gp?: number } } }).pf1e?.currency;
      return {
        gp: currency?.gp ?? null,
        items: actor.items.map((owned) => ({ name: owned.name, quantity: owned.system.quantity })),
      };
    }, actorId);
    expect(afterRetry).toEqual({ gp: 8, items: [{ name: "Ember Draught", quantity: 1 }] });
    await expect.poll(() => surfaceCallArg(player, "player", "codexTransferResult", retryRequest.requestId))
      .toMatchObject({ action: "purchase", ok: true, replayed: true });

    // Rejoin with the browser-persisted identity. The host snapshot catches this client up to
    // current stock, and replaying the uncertain request ID returns its durable result only.
    const reconnectedUserId = await connectManualPlayer(host, player, invite);
    expect(reconnectedUserId).toBe(playerId);
    await player.locator("[data-player-handouts]").click();
    const reconnectedHandouts = player.locator('[data-window="handouts"]');
    await reconnectedHandouts.locator("[data-player-codex]").click();
    const reconnectedCodex = reconnectedHandouts.locator("[data-campaign-codex]");
    const reconnectedNav = reconnectedCodex.getByRole("complementary", { name: "Codex navigator" });
    await reconnectedNav.locator(`[data-codex-sheet="${shopId}"]`).click();
    const reconnectedStockRow = reconnectedCodex.locator(".stock-list li").filter({ hasText: "Ember Draught" });
    await expect(reconnectedStockRow).toContainText("Qty 5");
    expect(await surfaceCallArg<string>(player, "player", "codexPurchase", retryRequest)).toBe(retryRequest.requestId);
    await expect.poll(() => surfaceCallArg(player, "player", "codexTransferResult", retryRequest.requestId))
      .toMatchObject({ action: "purchase", ok: true, replayed: true });
    await expect(reconnectedStockRow).toContainText("Qty 5");
    const afterReconnect = await host.evaluate((id) => {
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
      const actor = app?.gm?.client?.store?.get("actors", id) as ActorDocument | undefined;
      if (!actor) return null;
      const currency = (actor.system as { pf1e?: { currency?: { gp?: number } } }).pf1e?.currency;
      return { gp: currency?.gp ?? null, items: actor.items.map((owned) => ({ name: owned.name, quantity: owned.system.quantity })) };
    }, actorId);
    expect(afterReconnect).toEqual({ gp: 8, items: [{ name: "Ember Draught", quantity: 1 }] });

    const gmCodex = await openCodex(host);
    await gmCodex.nav.locator(`[data-codex-sheet="${shopId}"]`).click();
    await gmCodex.codex.getByLabel("Shop audience").selectOption("gmOnly");
    await expect(reconnectedCodex.getByLabel("Character for purchase")).toHaveCount(0);
    await expect(reconnectedStockRow).toHaveCount(0);
    const revokedRequest = { ...retryRequest, requestId: "codex-e2e-revoked-purchase" };
    expect(await surfaceCallArg<string>(player, "player", "codexPurchase", revokedRequest)).toBe(revokedRequest.requestId);
    await expect.poll(() => surfaceCallArg(player, "player", "codexTransferResult", revokedRequest.requestId))
      .toMatchObject({ action: "purchase", ok: false, detail: "This shop is unavailable." });
    const afterRevocation = await host.evaluate((id) => {
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
      const actor = app?.gm?.client?.store?.get("actors", id) as ActorDocument | undefined;
      const journal = app?.gm?.client?.store?.get("journals", "codex-e2e-live-shop") as JournalDocument | undefined;
      if (!actor || !journal) return null;
      const currency = (actor.system as { pf1e?: { currency?: { gp?: number } } }).pf1e?.currency;
      return { gp: currency?.gp ?? null, items: actor.items.map((owned) => owned.system.quantity), stock: journal.codex?.shop?.stock[0]?.quantity };
    }, actorId);
    expect(afterRevocation).toEqual({ gp: 8, items: [1], stock: 5 });
    expect(errors).toEqual([]);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("two connected players racing for the last unit cannot oversell a Codex shop", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext();
  const firstCtx = await browser.newContext();
  const secondCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const first = await firstCtx.newPage();
    const second = await secondCtx.newPage();
    const errors: string[] = [];
    for (const page of [host, first, second]) page.on("pageerror", (error) => errors.push(error.message));
    await host.goto(`${entry}?e2e=1`);
    await waitForSurface(host, "app");

    const itemId = "codex-e2e-race-item";
    const shopId = "codex-e2e-race-shop";
    const stockRowId = "codex-e2e-race-stock";
    const firstActorId = "codex-e2e-race-buyer-one";
    const secondActorId = "codex-e2e-race-buyer-two";
    const item: ItemDocument = {
      _id: itemId,
      type: "item",
      name: "Last Sunstone",
      ownership: { default: 1 },
      flags: {},
      system: { category: "equipment", quantity: 1, value: 2, weight: 0.25 },
      effects: [],
    };
    const shop = baseJournal(shopId, "Twin Lantern Market", "entry", "One sunstone remains.");
    shop.codex!.shop = {
      mode: "shop",
      audience: { kind: "inherit" },
      markup: 2,
      stock: [{ id: stockRowId, item: { coll: "items", id: itemId }, quantity: 1, unitPrice: "2", order: 0 }],
    };
    await seedWorld(host, { journals: [shop], items: [item], actors: [] });
    await host.locator("#share").click();
    const invite = await host.locator("#invite-link").inputValue();
    const firstPlayerId = await connectManualPlayer(host, first, invite);
    const secondPlayerId = await connectManualPlayer(host, second, invite);
    expect(secondPlayerId).not.toBe(firstPlayerId);

    const actors: ActorDocument[] = [
      {
        _id: firstActorId,
        type: "actor",
        name: "First buyer",
        ownership: { default: 0, [firstPlayerId]: 3 },
        flags: {},
        system: { pf1e: { currency: { pp: 0, gp: 10, sp: 0, cp: 0 } } },
        items: [],
        effects: [],
      },
      {
        _id: secondActorId,
        type: "actor",
        name: "Second buyer",
        ownership: { default: 0, [secondPlayerId]: 3 },
        flags: {},
        system: { pf1e: { currency: { pp: 0, gp: 10, sp: 0, cp: 0 } } },
        items: [],
        effects: [],
      },
    ];
    await host.evaluate((serialized) => {
      const data = JSON.parse(serialized) as ActorDocument[];
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { submit(ops: unknown[]): string } } } } }).__vttE2E?.app;
      if (!app?.gm?.client) throw new Error("GM E2E client is unavailable");
      app.gm.client.submit(data.map((actor) => ({ kind: "create", coll: "actors", data: actor })));
    }, JSON.stringify(actors));

    const openBuyerShop = async (page: Page, actorId: string) => {
      await page.locator("[data-player-handouts]").click();
      const handouts = page.locator('[data-window="handouts"]');
      await expect(handouts).toBeVisible();
      await handouts.locator("[data-player-codex]").click();
      const codex = handouts.locator("[data-campaign-codex]");
      const nav = codex.getByRole("complementary", { name: "Codex navigator" });
      await nav.locator(`[data-codex-sheet="${shopId}"]`).click();
      const row = codex.locator(".stock-list li").filter({ hasText: "Last Sunstone" });
      await expect(row).toContainText("Qty 1");
      await expect(row).toContainText("4.00 gp");
      const character = codex.getByLabel("Character for purchase");
      await expect(character.locator(`option[value="${actorId}"]`)).toHaveCount(1);
      await character.selectOption(actorId);
      return { codex, row };
    };
    const firstShop = await openBuyerShop(first, firstActorId);
    const secondShop = await openBuyerShop(second, secondActorId);

    const firstRequest = {
      sheetId: shopId,
      stockRowId,
      quantity: 1,
      actorId: firstActorId,
      requestId: "codex-e2e-race-first",
    };
    const secondRequest = {
      sheetId: shopId,
      stockRowId,
      quantity: 1,
      actorId: secondActorId,
      requestId: "codex-e2e-race-second",
    };
    const sent = await Promise.all([
      surfaceCallArg<string>(first, "player", "codexPurchase", firstRequest),
      surfaceCallArg<string>(second, "player", "codexPurchase", secondRequest),
    ]);
    expect(sent).toEqual([firstRequest.requestId, secondRequest.requestId]);
    await expect.poll(() => surfaceCallArg(first, "player", "codexTransferResult", firstRequest.requestId))
      .toMatchObject({ action: "purchase", requestId: firstRequest.requestId });
    await expect.poll(() => surfaceCallArg(second, "player", "codexTransferResult", secondRequest.requestId))
      .toMatchObject({ action: "purchase", requestId: secondRequest.requestId });
    const firstResult = await surfaceCallArg<{
      ok: boolean; detail: string; totalCopper: number | null;
    }>(first, "player", "codexTransferResult", firstRequest.requestId);
    const secondResult = await surfaceCallArg<{
      ok: boolean; detail: string; totalCopper: number | null;
    }>(second, "player", "codexTransferResult", secondRequest.requestId);
    expect([firstResult?.ok, secondResult?.ok].filter(Boolean)).toHaveLength(1);
    expect([firstResult?.ok, secondResult?.ok].filter((value) => value === false)).toHaveLength(1);
    const winner = firstResult?.ok ? firstResult : secondResult;
    const loser = firstResult?.ok ? secondResult : firstResult;
    expect(winner).toMatchObject({ ok: true, totalCopper: 400 });
    expect(loser).toMatchObject({ ok: false, detail: "There is not enough stock for that quantity." });
    await expect(firstShop.row).toContainText("Qty 0");
    await expect(secondShop.row).toContainText("Qty 0");

    const afterRace = await host.evaluate((serialized) => {
      const { actorIds, sheetId } = JSON.parse(serialized) as { actorIds: string[]; sheetId: string };
      const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: {
        get(collection: string, id: string): unknown;
        getAll(collection: string): unknown[];
      } } } } } }).__vttE2E?.app;
      const store = app?.gm?.client?.store;
      const journal = store?.get("journals", sheetId) as JournalDocument | undefined;
      const buyers = actorIds.map((id) => {
        const actor = store?.get("actors", id) as ActorDocument | undefined;
        const currency = (actor?.system as { pf1e?: { currency?: { gp?: number } } } | undefined)?.pf1e?.currency;
        return {
          gp: currency?.gp ?? null,
          items: actor?.items.map((owned) => ({ name: owned.name, quantity: owned.system.quantity })) ?? [],
        };
      });
      const receipts = store?.getAll("actionReceipts").filter((receipt) =>
        (receipt as { system?: { action?: string; sheetId?: string } }).system?.action === "codex.purchase" &&
        (receipt as { system?: { sheetId?: string } }).system?.sheetId === sheetId,
      ).length ?? 0;
      return { stock: journal?.codex?.shop?.stock[0]?.quantity ?? null, buyers, receipts };
    }, JSON.stringify({ actorIds: [firstActorId, secondActorId], sheetId: shopId }));
    expect(afterRace.stock).toBe(0);
    expect(afterRace.buyers.filter((buyer) => buyer.gp === 6 && buyer.items[0]?.quantity === 1)).toHaveLength(1);
    expect(afterRace.buyers.filter((buyer) => buyer.gp === 10 && buyer.items.length === 0)).toHaveLength(1);
    expect(afterRace.receipts).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await secondCtx.close();
    await firstCtx.close();
    await hostCtx.close();
  }
});

test("standard journal conversion preview can be cancelled and undone without changing pages or permissions", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.goto(`${entry}?e2e=1`);
  await waitForSurface(page, "app");

  const journalId = "codex-e2e-legacy-travel-diary";
  const legacy: JournalDocument = {
    _id: journalId,
    type: "journal",
    name: "Old Captain's Log",
    ownership: { default: 2, [viewerId]: 3 },
    flags: { legacy: { source: "hand-written" } },
    system: { campaign: { chapter: 4 } },
    pages: [
      {
        _id: "legacy-log-page-one", type: "page", name: "First watch", ownership: { default: 2 }, flags: {}, system: {},
        text: "# First watch\nThe tide turned at midnight. <secret>The beacon is false.</secret>", src: null,
      },
      {
        _id: "legacy-log-page-two", type: "page", name: "Second watch", ownership: { default: 3 }, flags: {}, system: {},
        text: "The crew found a silver compass.", src: null,
      },
    ],
  };
  await seedWorld(page, { journals: [legacy], items: [], actors: [] });
  const { codex } = await openCodex(page);
  await codex.getByText("Convert a journal", { exact: true }).click();
  await codex.getByLabel("Journal to convert").selectOption(journalId);

  const previewText = codex.getByText("Preview: Old Captain's Log", { exact: true });
  await codex.getByRole("button", { name: "Preview conversion" }).click();
  await expect(previewText).toBeVisible();
  await expect(codex.getByRole("button", { name: "Convert journal" })).toBeVisible();
  const afterPreview = await page.evaluate((id) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
    return app?.gm?.client?.store?.get("journals", id) as JournalDocument | undefined;
  }, journalId);
  expect(afterPreview?.codex).toBeUndefined();

  await codex.getByRole("button", { name: "Cancel preview" }).click();
  await expect(previewText).toHaveCount(0);
  const afterCancel = await page.evaluate((id) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
    return app?.gm?.client?.store?.get("journals", id) as JournalDocument | undefined;
  }, journalId);
  expect(afterCancel).toEqual(legacy);

  await codex.getByRole("button", { name: "Preview conversion" }).click();
  await codex.getByRole("button", { name: "Convert journal" }).click();
  await expect.poll(() => page.evaluate((id) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
    return (app?.gm?.client?.store?.get("journals", id) as JournalDocument | undefined)?.codex?.version ?? null;
  }, journalId)).toBe(1);
  const converted = await page.evaluate((id) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
    return app?.gm?.client?.store?.get("journals", id) as JournalDocument | undefined;
  }, journalId);
  expect(converted?.pages).toEqual(legacy.pages);
  expect(converted?.ownership).toEqual(legacy.ownership);
  expect(converted?.flags).toEqual(legacy.flags);
  expect(converted?.system).toEqual(legacy.system);
  expect(converted?.codex).toMatchObject({ version: 1, kind: "entry", links: [], widgets: [], quests: [] });

  await codex.getByRole("button", { name: "Undo last conversion" }).click();
  await expect.poll(() => page.evaluate((id) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
    return (app?.gm?.client?.store?.get("journals", id) as JournalDocument | undefined)?.codex ?? null;
  }, journalId)).toBeNull();
  const undone = await page.evaluate((id) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { get(collection: string, id: string): unknown } } } } } }).__vttE2E?.app;
    return app?.gm?.client?.store?.get("journals", id) as JournalDocument | undefined;
  }, journalId);
  expect(undone).toEqual(legacy);
  expect(errors).toEqual([]);
});

test("selected-content bundle import resolves conflicts, remaps the full dependency graph, filters restricted media, and rejects oversized assets", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.goto(`${entry}?e2e=1`);
  await waitForSurface(page, "app");

  const sourceRootId = "codex-e2e-bundle-source-root";
  const sourceRootPageId = `${sourceRootId}-page`;
  const sourceChildId = "codex-e2e-bundle-source-child";
  const sourceChildPageId = `${sourceChildId}-page`;
  const sourceActorId = "codex-e2e-bundle-source-actor";
  const sourceActorItemId = "codex-e2e-bundle-source-actor-item";
  const sourceItemId = "codex-e2e-bundle-source-item";
  const sourceSceneId = "codex-e2e-bundle-source-scene";
  const destinationRootId = "codex-e2e-bundle-destination-root";
  const destinationPageId = `${destinationRootId}-page`;
  const restrictedAssetId = "e".repeat(64);

  const root = baseJournal(sourceRootId, "Silver Cartographers", "group", "Route notes from the northern coast.");
  root.codex!.tabs![0]!.audience = { kind: "selectedUsers", userIds: [viewerId] };
  root.codex!.cover = restrictedAssetId;
  root.codex!.widgets.push({
    id: "restricted-map-gallery", type: "image-gallery", version: 1, tab: "info", order: 0,
    enabled: true, audience: { kind: "inherit" },
    config: { images: [{ assetId: restrictedAssetId, caption: "Rights-reserved atlas" }] },
  });
  const child = baseJournal(sourceChildId, "Archive Below the Wharf", "entry", "A water-damaged ledger.");
  const stockItem: ItemDocument = {
    _id: sourceItemId, type: "item", name: "Flood Ledger", ownership: { default: 3 }, flags: {},
    system: { category: "equipment", quantity: 1, value: 0, weight: 0.2 }, effects: [],
  };
  child.codex!.shop = {
    mode: "loot", audience: { kind: "inherit" },
    stock: [{ id: "archive-stock-row", item: { coll: "items", id: sourceItemId }, quantity: 2, order: 0 }],
  };
  const embeddedItem: ItemDocument = {
    _id: sourceActorItemId, type: "item", name: "Compass", ownership: { default: 3 }, flags: {},
    system: { quantity: 1, weight: 0.1 }, effects: [],
  };
  const actor: ActorDocument = {
    _id: sourceActorId, type: "actor", name: "Mira Stone", ownership: { default: 3 }, flags: {},
    system: { pf1e: { level: 2 } }, items: [embeddedItem], effects: [],
  };
  const scene: SceneDocument = {
    _id: sourceSceneId, type: "scene", name: "Flooded Gallery", ownership: { default: 3 }, flags: {}, system: {},
    active: false, img: null, width: 1000, height: 800, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [{
      _id: "archive-scene-token", type: "token", name: "Mira marker", ownership: { default: 3 }, flags: {}, system: {},
      x: 100, y: 100, rotation: 0, width: 100, height: 100, img: "", actorId: sourceActorId,
      hidden: false, disposition: "friendly", vision: true, light: { radius: 0, color: "#ffffff", alpha: 0.5 },
    }],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [],
    notes: [{
      _id: "archive-scene-note", type: "note", name: "Old chart", ownership: { default: 3 }, flags: {}, system: {},
      x: 200, y: 200, text: "See the chart in the Codex.", icon: "", journalId: sourceRootId,
    }],
  };
  root.codex!.links.push(
    { id: "bundle-child-link", relation: "contains", target: { coll: "journals", id: sourceChildId } },
    { id: "bundle-actor-link", relation: "representsActor", target: { coll: "actors", id: sourceActorId } },
    { id: "bundle-item-link", relation: "linksItem", target: { coll: "items", id: sourceItemId } },
    { id: "bundle-scene-link", relation: "linksScene", target: { coll: "scenes", id: sourceSceneId } },
  );
  const destination = baseJournal(destinationRootId, "Silver Cartographers", "entry", "Local destination notes.");
  delete destination.codex;
  delete destination.pages[0]!.codex;

  await seedWorld(page, {
    journals: [root, child, destination], items: [stockItem], actors: [actor], scenes: [scene],
    assetManifest: {
      [restrictedAssetId]: {
        name: "Rights-reserved atlas.webp", mime: "image/webp", size: 8, chunks: 1,
        visibility: "referenced", exportRights: "restricted",
      },
    },
  });

  const { codex } = await openCodex(page);
  const rootChoice = codex.locator(".bundle-root-list label").filter({ hasText: "Silver Cartographers · Group" });
  await expect(rootChoice).toHaveCount(1);
  await rootChoice.locator("input").check();
  const bundleDownloadPromise = page.waitForEvent("download");
  await codex.getByRole("button", { name: "Export selected bundle" }).click();
  const bundleDownload = await bundleDownloadPromise;
  const bundlePath = await bundleDownload.path();
  if (!bundlePath) throw new Error("Selected-content export did not produce a downloadable file.");
  const exportedBytes = new Uint8Array(readFileSync(bundlePath));
  const exportedArchive = unzipSync(exportedBytes);
  const exportedIndexBytes = exportedArchive["campaign-codex.json"];
  if (!exportedIndexBytes) throw new Error("Selected-content export omitted its index.");
  const exportedIndex = JSON.parse(strFromU8(exportedIndexBytes)) as {
    report: { omittedMedia: number; hasPortablePermissionResets: boolean };
    documents: { journals: JournalDocument[]; actors: ActorDocument[]; items: ItemDocument[]; scenes: SceneDocument[] };
  };
  const exportedText = strFromU8(exportedIndexBytes);
  expect(exportedIndex.report.omittedMedia).toBe(1);
  expect(exportedIndex.report.hasPortablePermissionResets).toBe(true);
  expect(exportedIndex.documents.journals.map((journal) => journal._id).sort()).toEqual([sourceRootId, sourceChildId].sort());
  expect(exportedIndex.documents.actors).toHaveLength(1);
  expect(exportedIndex.documents.items).toHaveLength(1);
  expect(exportedIndex.documents.scenes).toHaveLength(1);
  expect(exportedText).not.toContain(restrictedAssetId);
  expect(exportedText).not.toContain("Rights-reserved atlas");
  expect(Object.keys(exportedArchive).some((path) => path.startsWith("assets/"))).toBe(false);

  // Model a bundle from a second world: its opaque document ids differ, while the root name
  // deliberately matches a local ordinary journal so the import UI must resolve a conflict.
  const externalIds: Record<string, string> = {
    [sourceRootId]: "external-codex-root",
    [sourceRootPageId]: "external-codex-root-page",
    [sourceChildId]: "external-codex-child",
    [sourceChildPageId]: "external-codex-child-page",
    [sourceActorId]: "external-codex-actor",
    [sourceActorItemId]: "external-codex-actor-item",
    [sourceItemId]: "external-codex-item",
    [sourceSceneId]: "external-codex-scene",
  };
  const externalFiles = unzipSync(remapBundleZipIds(exportedBytes, externalIds));
  const externalIndexBytes = externalFiles["campaign-codex.json"];
  if (!externalIndexBytes) throw new Error("External selected-content export omitted its index.");
  const externalIndex = JSON.parse(strFromU8(externalIndexBytes)) as {
    roots: Array<{ coll: string; id: string }>;
    report: { hasUnavailableDependencies: boolean };
    documents: { journals: JournalDocument[] };
  };
  const externalRoot = externalIndex.documents.journals.find((journal) => journal._id === externalIds[sourceRootId]);
  if (!externalRoot?.codex) throw new Error("External root journal is missing Codex metadata.");
  externalRoot.codex.links.push({
    id: "stale-legacy-link", relation: "relatedTo", target: { coll: "journals", id: "missing-source-reference" },
  });
  externalIndex.report.hasUnavailableDependencies = true;
  externalFiles["campaign-codex.json"] = strToU8(JSON.stringify(externalIndex));
  const externalBundleBytes = zipSync(externalFiles, { level: 6 });

  await page.evaluate((serialized) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: {
      submit(ops: unknown[]): string;
      store?: { get(collection: string, id: string): unknown };
    } } } } }).__vttE2E?.app;
    if (!app?.gm?.client) throw new Error("GM E2E client is unavailable");
    const ids = JSON.parse(serialized) as { root: string; child: string; actor: string; item: string; scene: string };
    app.gm.client.submit([
      { kind: "update", ref: { coll: "journals", id: ids.root }, diff: { name: "Local source root copy" } },
      { kind: "update", ref: { coll: "journals", id: ids.child }, diff: { name: "Local source child copy" } },
      { kind: "update", ref: { coll: "actors", id: ids.actor }, diff: { name: "Local source actor copy" } },
      { kind: "update", ref: { coll: "items", id: ids.item }, diff: { name: "Local source item copy" } },
      { kind: "update", ref: { coll: "scenes", id: ids.scene }, diff: { name: "Local source scene copy" } },
    ]);
  }, JSON.stringify({ root: sourceRootId, child: sourceChildId, actor: sourceActorId, item: sourceItemId, scene: sourceSceneId }));

  const input = codex.locator('input[type="file"][accept*=".codex.zip"]');
  await input.setInputFiles({
    name: "campaign-codex-external.codex.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(externalBundleBytes),
  });
  const importPreview = codex.getByRole("region", { name: "Codex bundle import preview" });
  await expect(importPreview).toBeVisible();
  await expect(importPreview).toContainText("Some dependencies were unavailable to the exporter");
  await expect(importPreview).toContainText("Some media was omitted because export rights or local bytes were unavailable.");
  await expect(importPreview).toContainText("Source-world user grants were removed or made GM-only.");
  const importButton = importPreview.getByRole("button", { name: /^Import atomically/ });
  await expect(importButton).toBeDisabled();
  const conflictChoice = importPreview.getByLabel("Conflict choice for Silver Cartographers");
  await conflictChoice.selectOption(`replace:${destinationRootId}`);
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(codex.getByRole("status").filter({ hasText: "Codex bundle import committed successfully." }))
    .toBeVisible();

  const imported = await page.evaluate((ids) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: {
      get(collection: string, id: string): unknown;
    } } } } } }).__vttE2E?.app;
    const store = app?.gm?.client?.store;
    const root = store?.get("journals", ids.destinationRoot) as JournalDocument | undefined;
    const relation = (name: string) => root?.codex?.links.find((link) => link.id === name)?.target.id ?? null;
    const childId = relation("bundle-child-link");
    const actorId = relation("bundle-actor-link");
    const itemId = relation("bundle-item-link");
    const sceneId = relation("bundle-scene-link");
    const child = childId ? store?.get("journals", childId) as JournalDocument | undefined : undefined;
    const actor = actorId ? store?.get("actors", actorId) as ActorDocument | undefined : undefined;
    const item = itemId ? store?.get("items", itemId) as ItemDocument | undefined : undefined;
    const scene = sceneId ? store?.get("scenes", sceneId) as SceneDocument | undefined : undefined;
    return {
      rootLinks: root?.codex?.links.map((link) => ({ id: link.id, coll: link.target.coll, idTarget: link.target.id })) ?? [],
      childId, childName: child?.name, stockItemId: child?.codex?.shop?.stock[0]?.item.id,
      stockItemResolves: child?.codex?.shop?.stock[0]?.item.id === item?._id,
      actorId, actorName: actor?.name, embeddedItemId: actor?.items[0]?._id,
      itemId, itemName: item?.name,
      sceneId, sceneName: scene?.name, sceneActorId: scene?.tokens[0]?.actorId,
      sceneJournalId: scene?.notes[0]?.journalId,
      rootPageIds: root?.pages.map((page) => page._id) ?? [],
      childPageIds: child?.pages.map((page) => page._id) ?? [],
      preservedDestinationPage: root?.pages.some((page) => page._id === ids.destinationPage) ?? false,
      unresolvedExternalIdsPresent: [
        ids.externalRoot, ids.externalChild, ids.externalActor, ids.externalActorItem,
        ids.externalItem, ids.externalScene, "missing-source-reference",
      ].some((id) => root?.codex?.links.some((link) => link.target.id === id) ?? false),
      sourceRecordsRemainLocal: store?.get("journals", ids.sourceRoot) !== undefined &&
        store?.get("journals", ids.sourceChild) !== undefined && store?.get("actors", ids.sourceActor) !== undefined,
    };
  }, {
    destinationRoot: destinationRootId, destinationPage: destinationPageId,
    sourceRoot: sourceRootId, sourceChild: sourceChildId, sourceActor: sourceActorId,
    externalRoot: externalIds[sourceRootId], externalChild: externalIds[sourceChildId],
    externalActor: externalIds[sourceActorId], externalActorItem: externalIds[sourceActorItemId],
    externalItem: externalIds[sourceItemId], externalScene: externalIds[sourceSceneId],
  });
  expect(imported.rootLinks).toHaveLength(4);
  expect(imported.childName).toBe("Archive Below the Wharf");
  expect(imported.actorName).toBe("Mira Stone");
  expect(imported.itemName).toBe("Flood Ledger");
  expect(imported.sceneName).toBe("Flooded Gallery");
  expect(imported.stockItemResolves).toBe(true);
  expect(imported.embeddedItemId).toBeTruthy();
  expect(imported.embeddedItemId).not.toBe(externalIds[sourceActorItemId]);
  expect(imported.sceneActorId).toBe(imported.actorId);
  expect(imported.sceneJournalId).toBe(destinationRootId);
  expect(imported.preservedDestinationPage).toBe(true);
  expect(imported.unresolvedExternalIdsPresent).toBe(false);
  expect(imported.sourceRecordsRemainLocal).toBe(true);
  expect(imported.rootPageIds).not.toContain(externalIds[sourceRootPageId]);
  expect(imported.childPageIds).not.toContain(externalIds[sourceChildPageId]);
  for (const importedId of [imported.childId, imported.actorId, imported.itemId, imported.sceneId]) {
    expect(importedId).toBeTruthy();
    expect(Object.values(externalIds)).not.toContain(importedId);
  }
  expect(imported.rootPageIds).toContain(`${destinationRootId}-page`);

  // A compressed ZIP with an over-limit uncompressed media entry is rejected before import and
  // before the document store changes, even though its compressed file itself is small.
  const oversizedAsset = new Uint8Array(32 * 1024 * 1024 + 1);
  const oversizedZip = zipSync({
    "campaign-codex.json": strToU8("{}"),
    [`assets/${"f".repeat(64)}`]: oversizedAsset,
  }, { level: 9 });
  expect(oversizedZip.length).toBeLessThan(64 * 1024);
  await input.setInputFiles({
    name: "oversized-codex-asset.codex.zip", mimeType: "application/zip", buffer: Buffer.from(oversizedZip),
  });
  await expect(codex.getByRole("status").filter({ hasText: "A bundled asset exceeds 32 MiB." })).toBeVisible();
  await expect(importPreview).toHaveCount(0);
  const afterOversized = await page.evaluate((id) => {
    const app = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: {
      get(collection: string, id: string): unknown;
      getAll(collection: string): unknown[];
    } } } } } }).__vttE2E?.app;
    const store = app?.gm?.client?.store;
    return {
      destinationRoot: store?.get("journals", id) as JournalDocument | undefined,
      journalCount: store?.getAll("journals").length ?? 0,
    };
  }, destinationRootId);
  expect(afterOversized.destinationRoot?.codex?.links).toHaveLength(4);
  expect(afterOversized.journalCount).toBe(4);
  expect(errors).toEqual([]);
});
