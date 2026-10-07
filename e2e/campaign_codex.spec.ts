/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import type { JournalDocument, UserDocument } from "../src/core/documents";
import { entry, waitForSurface } from "./lib";

const viewerId = "codex-e2e-player";
const rootId = "codex-e2e-group";
const npcId = "codex-e2e-npc";
const tagId = "codex-e2e-tag";

function user(): UserDocument {
  return {
    _id: viewerId, type: "user", name: "Ari Player", role: "PLAYER", ownership: { default: 0 },
    flags: {}, system: {}, character: null, color: "#acd3f0",
  };
}

function baseJournal(id: string, name: string, kind: "group" | "npc" | "tag", text: string): JournalDocument {
  const pageId = `${id}-page`;
  return {
    _id: id, type: "journal", name, ownership: { default: 3 }, flags: {}, system: {},
    pages: [{
      _id: pageId, type: "page", name: "Overview", ownership: { default: 3 }, flags: {}, system: {},
      text, src: null, codex: { tabKey: "info", label: "Overview", order: 0, audience: { kind: "inherit" } },
    }],
    codex: {
      version: 1, kind, subtitle: `${name} field notes`,
      tabs: [{ key: "info", label: "Info", order: 0, audience: { kind: "inherit" } }],
      links: [], widgets: [], quests: [],
    },
  };
}

function fixture(): JournalDocument[] {
  const group = baseJournal(rootId, "Northern Alliance", "group", "A network of scouts.");
  const npc = baseJournal(npcId, "Northern Contact", "npc",
    "The contact knows the pass. <secret>The cellar cipher is blue lantern.</secret>");
  npc.taggerTags = ["Travel", "Northern"];
  const tag = baseJournal(tagId, "Old Town", "tag", "A discovery tag.");
  group.codex!.links.push({ id: "group-npc", relation: "contains", target: { coll: "journals", id: npcId } });
  npc.codex!.tabs!.push({ key: "gm-notes", label: "Private notes", order: 1, audience: { kind: "gmOnly" } });
  npc.pages.push({
    _id: `${npcId}-private-page`, type: "page", name: "Cipher notes", ownership: { default: 3 }, flags: {}, system: {},
    text: "The cellar cipher is blue lantern.", src: null,
    codex: { tabKey: "gm-notes", label: "Cipher notes", order: 1, audience: { kind: "gmOnly" } },
  });
  npc.codex!.quests = [
    { id: "public-quest", title: "Find the northern bell", description: "Ask at dawn.", state: "active",
      pinned: true, order: 0, audience: { kind: "inherit" }, objectives: [
        { id: "public-objective", title: "Speak to the ferryman", completed: false, order: 0,
          audience: { kind: "inherit" }, children: [] },
      ] },
    { id: "selected-quest", title: "Ari's private clue", description: "For Ari only.", state: "active",
      pinned: false, order: 1, audience: { kind: "selectedUsers", userIds: [viewerId] }, objectives: [] },
    { id: "gm-quest", title: "GM vault quest", description: "Never shown to players.", state: "active",
      pinned: false, order: 2, audience: { kind: "gmOnly" }, objectives: [] },
  ];
  npc.codex!.widgets = [{ id: "quests-widget", type: "quest-list", version: 1, tab: "info", order: 0,
    enabled: true, audience: { kind: "inherit" }, config: {} }];
  tag.codex!.links.push({ id: "tag-npc", relation: "associatedWith", target: { coll: "journals", id: npcId } });
  return [group, npc, tag];
}

test("Campaign Codex navigation, audience preview, and permission-filtered Markdown export", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.goto(`${entry}?e2e=1`);
  await waitForSurface(page, "app");

  const seed = JSON.stringify({ player: user(), journals: fixture() });
  await page.evaluate((serialized) => {
    const { player, journals } = JSON.parse(serialized) as { player: UserDocument; journals: JournalDocument[] };
    const surface = (globalThis as { __vttE2E?: { app?: { gm: { client: { submit(ops: unknown[]): string } } } } }).__vttE2E;
    const client = surface?.app?.gm.client;
    if (!client) throw new Error("GM E2E client is unavailable");
    client.submit([
      { kind: "create", coll: "users", data: player },
      ...journals.map((data) => ({ kind: "create", coll: "journals", data })),
    ]);
  }, seed);

  await page.locator('[data-tab="journals"]').click();
  await page.locator("[data-open-codex]").click();
  const codex = page.locator("[data-campaign-codex]");
  const nav = codex.getByRole("complementary", { name: "Codex navigator" });
  await expect(nav.locator(`[data-codex-sheet="${rootId}"]`)).toBeVisible();
  await nav.locator(`[data-codex-sheet="${rootId}"]`).click();
  await expect(codex.locator(".tree-list")).toContainText("Northern Contact");
  await codex.locator(".tree-list button", { hasText: "Open" }).click();
  await expect(codex.locator("main h2")).toHaveText("Northern Contact");
  await expect(codex.locator(".breadcrumbs")).toContainText("Northern Alliance");
  await codex.locator("[data-codex-back]").click();
  await expect(codex.locator("main h2")).toHaveText("Northern Alliance");

  await nav.getByLabel("Codex tag").selectOption(`c:${tagId}`);
  await expect(nav.locator(`[data-codex-sheet="${npcId}"]`)).toBeVisible();
  await nav.getByLabel("Codex tag").selectOption("t:Travel");
  await expect(nav.locator(`[data-codex-sheet="${npcId}"]`)).toBeVisible();
  await nav.getByLabel("Codex tag").selectOption("all");

  await codex.getByLabel("Preview Campaign Codex as player").selectOption(viewerId);
  await expect(codex.getByText("Read-only permission preview")).toBeVisible();
  await expect(nav.locator(`[data-codex-sheet="${npcId}"]`)).toBeVisible();
  await nav.locator(`[data-codex-sheet="${npcId}"]`).click();
  await expect(codex.locator("main h2")).toHaveText("Northern Contact");
  await expect(codex.locator(".page-content")).toContainText("knows the pass");
  await expect(codex.locator(".page-content")).not.toContainText("blue lantern");
  await expect(codex.locator(".quest-card")).toContainText("Find the northern bell");
  await expect(codex.locator(".quest-card")).toContainText("Ari's private clue");
  await expect(codex.locator(".quest-card")).not.toContainText("GM vault quest");
  await codex.getByLabel("Search Codex").fill("blue lantern");
  await expect(nav.locator("[data-codex-sheet]")).toHaveCount(0);
  await codex.getByLabel("Search Codex").fill("");

  await codex.locator('.bundle-root-list input[type="checkbox"]').first().check();
  const downloadPromise = page.waitForEvent("download");
  await codex.getByRole("button", { name: "Export Markdown" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("Markdown export did not produce a downloadable file");
  const archive = unzipSync(new Uint8Array(readFileSync(path)));
  const exportedText = Object.entries(archive).map(([file, bytes]) => `${file}\n${strFromU8(bytes)}`).join("\n");
  expect(exportedText).toContain("[Northern Contact](./northern-contact-codex-e2e-npc.md)");
  expect(exportedText).toContain("Find the northern bell");
  expect(exportedText).toContain("Ari's private clue");
  expect(exportedText).not.toContain("blue lantern");
  expect(exportedText).not.toContain("GM vault quest");
  expect(errors).toEqual([]);
});
