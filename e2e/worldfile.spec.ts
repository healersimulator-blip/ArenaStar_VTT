import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ItemDocument, JournalDocument } from "../src/core/documents";

const entry =
  "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

const appCall = <T>(
  page: Page,
  method: string,
  ...args: unknown[]
): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const surface = (
        globalThis as {
          __vttE2E?: { app: Record<string, (...x: unknown[]) => T> | null };
        }
      ).__vttE2E;
      const fn = surface?.app?.[m];
      if (typeof fn !== "function")
        throw new Error(`app surface missing: ${m}`);
      return fn(...a) as T;
    },
    { m: method, a: args },
  );

/** A minimal §12 strategic ruleset the SimWorker accepts (shape as in packages.spec.ts). */
const RULES_JS = [
  "export default {",
  "  schema: { version: '9.9.9', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] },",
  "  validateOrder() { return { ok: true }; },",
  "  resolveTurn() {},",
  "  detection() { return 5; },",
  "};",
].join("\n");
const RULESET_MANIFEST = {
  id: "probe-rules",
  name: "Probe Rules",
  version: "9.9.9",
  type: "system",
  rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
};
const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  );

const waitForApp = (page: Page): Promise<void> =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as { __vttE2E?: { app: unknown } }).__vttE2E?.app != null,
      ),
    )
    .toBe(true);

test.describe("world.zip export/import (§8)", () => {
  test("export downloads a zip; importing it restores the export point", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForApp(page);

    await page.click("#add-token");
    await page.click("#add-token");
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(2);

    // ── export: browser download of the world zip ──
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#export-world"),
    ]);
    expect(download.suggestedFilename()).toMatch(/^world-.*\.zip$/);
    const zipPath = (await download.path()) as string;
    const archive = new Uint8Array(await readFile(zipPath));
    const files = unzipSync(archive);
    const meta = JSON.parse(strFromU8(files["world.json"] as Uint8Array)) as {
      worldId: string;
      seq: number;
      format: number;
      rules: { active: string | null };
    };
    // D-248: format 2 carries the strategic ruleset pin + package index (empty here: built-in)
    expect(meta.format).toBe(2);
    expect(meta.rules).toEqual({ active: null });
    expect(JSON.parse(strFromU8(files["packages.json"] as Uint8Array))).toEqual(
      [],
    );
    expect(files["documents.json"]).toBeDefined();
    const worldId = meta.worldId;
    const seqAtExport = meta.seq;

    // ── drift past the export point ──
    await page.click("#add-token");
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(3);

    // ── D-249: importing happens on the start screen — Close world, Open file, Restore ──
    await page.click("#close-world");
    const list = page.locator("[data-world-list]");
    await expect(
      list.locator(`[data-world-row][data-world-id="${worldId}"]`),
    ).toBeVisible();
    await expect
      .poll(() => appCall<string>(page, "worldId").catch(() => null))
      .toBeNull(); // surface detached
    await page.setInputFiles("#role-import", zipPath);
    const dialog = page.locator("[data-open-dialog]");
    await expect(dialog).toHaveAttribute("data-open-kind", "world");
    await expect(dialog.locator("[data-open-contents]")).toContainText(
      "built-in strategic rules",
    );
    await expect(dialog.locator("[data-open-replace]")).toContainText(
      "Restore over",
    );
    await dialog.locator("[data-open-replace]").click();
    await waitForApp(page); // Root re-attaches the e2e surface to the rebooted world
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(2); // restored to the export point
    expect(await appCall<string>(page, "worldId")).toBe(worldId);
    await expect.poll(() => appCall<number>(page, "seq")).toBe(seqAtExport);
  });

  test("Codex journals and relationship refs survive a full World ZIP restore through the start screen", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const rootId = "worldfile-codex-root";
    const childId = "worldfile-codex-child";
    const makeJournal = (
      id: string,
      name: string,
      kind: "group" | "location",
      text: string,
    ): JournalDocument => ({
      _id: id,
      type: "journal",
      name,
      ownership: { default: 3 },
      flags: {},
      system: {},
      pages: [
        {
          _id: `${id}-page`,
          type: "page",
          name: "Overview",
          ownership: { default: 3 },
          flags: {},
          system: {},
          text,
          src: null,
          codex: {
            tabKey: "info",
            label: "Overview",
            order: 0,
            audience: { kind: "inherit" },
          },
        },
      ],
      codex: {
        version: 1,
        kind,
        links: [],
        widgets: [],
        quests: [],
        tabs: [
          {
            key: "info",
            label: "Info",
            order: 0,
            audience: { kind: "inherit" },
          },
        ],
      },
    });
    const child = makeJournal(
      childId,
      "The Lantern Archive",
      "location",
      "A brass lantern marks the safe door.",
    );
    const root = makeJournal(
      rootId,
      "Northern Passage",
      "group",
      "Field notes for the northern passage.",
    );
    root.codex?.links.push({
      id: "archive-relationship",
      relation: "contains",
      target: { coll: "journals", id: childId },
    });

    await page.goto(entry + "?e2e=1");
    await waitForApp(page);
    await page.evaluate((serialized) => {
      const { root, child } = JSON.parse(serialized) as {
        root: JournalDocument;
        child: JournalDocument;
      };
      const client = (
        globalThis as {
          __vttE2E?: {
            app?: { gm?: { client?: { submit(ops: unknown[]): string } } };
          };
        }
      ).__vttE2E?.app?.gm?.client;
      if (!client) throw new Error("GM E2E client is unavailable");
      client.submit([
        { kind: "create", coll: "journals", data: child },
        { kind: "create", coll: "journals", data: root },
      ]);
    }, JSON.stringify({ root, child }));
    await expect
      .poll(() =>
        page.evaluate(
          (ids) => {
            const store = (
              globalThis as {
                __vttE2E?: {
                  app?: {
                    gm?: {
                      client?: {
                        store?: {
                          get(collection: string, id: string): unknown;
                        };
                      };
                    };
                  };
                };
              }
            ).__vttE2E?.app?.gm?.client?.store;
            return Boolean(
              store?.get("journals", ids.root) &&
              store.get("journals", ids.child),
            );
          },
          { root: rootId, child: childId },
        ),
      )
      .toBe(true);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#export-world"),
    ]);
    const archivePath = await download.path();
    if (!archivePath)
      throw new Error("World ZIP export did not produce a downloadable file.");
    const archive = new Uint8Array(await readFile(archivePath));
    const files = unzipSync(archive);
    const documents = JSON.parse(
      strFromU8(files["documents.json"] as Uint8Array),
    ) as {
      docs: Array<{ coll: string; id: string; doc: unknown }>;
      seq: number;
    };
    const archivedRoot = documents.docs.find(
      (row) => row.coll === "journals" && row.id === rootId,
    )?.doc as JournalDocument | undefined;
    const archivedChild = documents.docs.find(
      (row) => row.coll === "journals" && row.id === childId,
    )?.doc as JournalDocument | undefined;
    expect(archivedRoot).toEqual(root);
    expect(archivedChild).toEqual(child);
    expect(archivedRoot?.codex?.links[0]?.target).toEqual({
      coll: "journals",
      id: childId,
    });
    const exportSeq = documents.seq;
    const worldId = JSON.parse(
      strFromU8(files["world.json"] as Uint8Array),
    ) as { worldId: string };

    await page.evaluate(
      ({ rootId, childId }) => {
        const client = (
          globalThis as {
            __vttE2E?: {
              app?: { gm?: { client?: { submit(ops: unknown[]): string } } };
            };
          }
        ).__vttE2E?.app?.gm?.client;
        if (!client) throw new Error("GM E2E client is unavailable");
        client.submit([
          {
            kind: "update",
            ref: { coll: "journals", id: rootId },
            diff: { name: "Drifted passage" },
          },
          {
            kind: "update",
            ref: { coll: "journals", id: childId },
            diff: { name: "Drifted archive" },
          },
        ]);
      },
      { rootId, childId },
    );
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const store = (
            globalThis as {
              __vttE2E?: {
                app?: {
                  gm?: {
                    client?: {
                      store?: { get(collection: string, id: string): unknown };
                    };
                  };
                };
              };
            }
          ).__vttE2E?.app?.gm?.client?.store;
          return (
            (store?.get("journals", id) as JournalDocument | undefined)?.name ??
            null
          );
        }, rootId),
      )
      .toBe("Drifted passage");

    await page.click("#close-world");
    await page.setInputFiles("#role-import", archivePath);
    const dialog = page.locator("[data-open-dialog]");
    await expect(dialog).toHaveAttribute("data-open-kind", "world");
    await expect(dialog.locator("[data-open-codex-audit]")).toContainText(
      "2 Codex sheet(s), 1 supported reference(s) checked.",
    );
    await expect(dialog.locator("[data-open-codex-audit]")).toContainText(
      "No unresolved dependencies in the supported Codex fields",
    );
    await dialog.locator("[data-open-replace]").click();
    await waitForApp(page);
    await expect
      .poll(() =>
        page.evaluate(
          (ids) => {
            const store = (
              globalThis as {
                __vttE2E?: {
                  app?: {
                    gm?: {
                      client?: {
                        store?: {
                          get(collection: string, id: string): unknown;
                        };
                      };
                    };
                  };
                };
              }
            ).__vttE2E?.app?.gm?.client?.store;
            const restoredRoot = store?.get("journals", ids.root) as
              JournalDocument | undefined;
            const restoredChild = store?.get("journals", ids.child) as
              JournalDocument | undefined;
            const targetId = restoredRoot?.codex?.links[0]?.target.id;
            return {
              rootName: restoredRoot?.name ?? null,
              childName: restoredChild?.name ?? null,
              pageText: restoredRoot?.pages[0]?.text ?? null,
              linkResolves:
                targetId === ids.child && restoredChild !== undefined,
              childText: restoredChild?.pages[0]?.text ?? null,
            };
          },
          { root: rootId, child: childId },
        ),
      )
      .toEqual({
        rootName: "Northern Passage",
        childName: "The Lantern Archive",
        pageText: "Field notes for the northern passage.",
        linkResolves: true,
        childText: "A brass lantern marks the safe door.",
      });
    expect(await appCall<string>(page, "worldId")).toBe(worldId.worldId);
    await expect.poll(() => appCall<number>(page, "seq")).toBe(exportSeq);
  });

  test("an imported dangling Codex link is explicitly repaired without guessing its target", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const rootId = "worldfile-codex-repair-root";
    const childId = "worldfile-codex-repair-missing-child";
    const replacementId = "worldfile-codex-repair-replacement";
    const missingItemId = "worldfile-codex-repair-missing-stock-item";
    const replacementItemId = "worldfile-codex-repair-stock-replacement";
    const missingTableId = "worldfile-codex-repair-missing-table";
    const replacementTableId = "worldfile-codex-repair-table-replacement";
    const missingWidgetLinkId = "worldfile-codex-repair-missing-widget-link";
    const missingSceneLinkId = "worldfile-codex-repair-missing-scene-link";
    const missingQuestId = "worldfile-codex-repair-missing-quest";
    const survivingWidgetLinkId = "worldfile-codex-repair-widget-link";
    const survivingQuestId = "worldfile-codex-repair-widget-quest";
    const missingAssetId = "c".repeat(64);
    const makeJournal = (
      id: string,
      name: string,
      kind: "group" | "location",
    ): JournalDocument => ({
      _id: id,
      type: "journal",
      name,
      ownership: { default: 3 },
      flags: {},
      system: {},
      pages: [
        {
          _id: `${id}-page`,
          type: "page",
          name: "Overview",
          ownership: { default: 3 },
          flags: {},
          system: {},
          text: `${name} notes`,
          src: null,
        },
      ],
      codex: { version: 1, kind, links: [], widgets: [], quests: [] },
    });
    const root = makeJournal(rootId, "Broken Route", "group");
    const missingTarget = makeJournal(childId, "Old Destination", "location");
    const replacement = makeJournal(
      replacementId,
      "Replacement Destination",
      "location",
    );
    const rootCodex = root.codex;
    if (!rootCodex)
      throw new Error("Codex repair fixture is missing its metadata");
    rootCodex.links.push(
      {
        id: "repair-me",
        relation: "contains",
        target: { coll: "journals", id: childId },
        label: "Destination to repair",
      },
      {
        id: survivingWidgetLinkId,
        relation: "relatedTo",
        target: { coll: "journals", id: replacementId },
        label: "Existing widget relationship",
      },
    );
    rootCodex.quests = [
      {
        id: survivingQuestId,
        title: "Existing widget quest",
        description: "",
        state: "active",
        pinned: false,
        order: 0,
        objectives: [],
      },
    ];
    rootCodex.widgets = [];
    rootCodex.shop = {
      mode: "loot",
      stock: [
        {
          id: "repair-stock-row",
          item: { coll: "items", id: missingItemId },
          quantity: 1,
          order: 0,
        },
      ],
    };
    const makeItem = (id: string, name: string): ItemDocument => ({
      _id: id,
      type: "item",
      name,
      ownership: { default: 3 },
      flags: {},
      system: { quantity: 1, value: 4, weight: 1 },
      effects: [],
    });
    const missingItem = makeItem(missingItemId, "Stale stock item");
    const replacementItem = makeItem(
      replacementItemId,
      "Replacement stock item",
    );

    await page.goto(entry + "?e2e=1");
    await waitForApp(page);
    await page.evaluate((serialized) => {
      const { root, missingTarget, replacement, missingItem, replacementItem } =
        JSON.parse(serialized) as {
          root: JournalDocument;
          missingTarget: JournalDocument;
          replacement: JournalDocument;
          missingItem: ItemDocument;
          replacementItem: ItemDocument;
        };
      const client = (
        globalThis as {
          __vttE2E?: {
            app?: { gm?: { client?: { submit(ops: unknown[]): string } } };
          };
        }
      ).__vttE2E?.app?.gm?.client;
      if (!client) throw new Error("GM E2E client is unavailable");
      client.submit([
        { kind: "create", coll: "journals", data: root },
        { kind: "create", coll: "journals", data: missingTarget },
        { kind: "create", coll: "journals", data: replacement },
        { kind: "create", coll: "items", data: missingItem },
        { kind: "create", coll: "items", data: replacementItem },
      ]);
    }, JSON.stringify({ root, missingTarget, replacement, missingItem, replacementItem }));
    await expect
      .poll(() =>
        page.evaluate(
          (ids) => {
            const store = (
              globalThis as {
                __vttE2E?: {
                  app?: {
                    gm?: {
                      client?: {
                        store?: {
                          get(collection: string, id: string): unknown;
                        };
                      };
                    };
                  };
                };
              }
            ).__vttE2E?.app?.gm?.client?.store;
            return Boolean(
              store?.get("journals", ids.root) &&
              store.get("journals", ids.child) &&
              store.get("journals", ids.replacement),
            );
          },
          { root: rootId, child: childId, replacement: replacementId },
        ),
      )
      .toBe(true);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#export-world"),
    ]);
    const archivePath = await download.path();
    if (!archivePath)
      throw new Error("World ZIP export did not produce a downloadable file.");
    const files = unzipSync(new Uint8Array(await readFile(archivePath)));
    const documentBytes = files["documents.json"];
    if (!documentBytes)
      throw new Error("World ZIP export omitted documents.json.");
    const documents = JSON.parse(strFromU8(documentBytes)) as {
      docs: Array<{ coll: string; id: string; doc: unknown }>;
      [key: string]: unknown;
    };
    expect(
      documents.docs.some(
        (row) => row.coll === "journals" && row.id === childId,
      ),
    ).toBe(true);
    const brokenDocuments = {
      ...documents,
      docs: documents.docs.filter(
        (row) =>
          !(row.coll === "journals" && row.id === childId) &&
          !(row.coll === "items" && row.id === missingItemId),
      ),
    };
    const archivedRootRow = brokenDocuments.docs.find(
      (row) => row.coll === "journals" && row.id === rootId,
    );
    if (!archivedRootRow)
      throw new Error("World ZIP export omitted the Codex repair fixture");
    const archivedRoot = archivedRootRow.doc as JournalDocument;
    if (!archivedRoot.codex)
      throw new Error("World ZIP export omitted Codex metadata");
    archivedRoot.codex.cover = missingAssetId;
    archivedRoot.codex.widgets = [
      {
        id: "repair-roll-table-widget",
        type: "roll-table",
        version: 1,
        tab: "info",
        order: 0,
        enabled: true,
        config: { tableId: missingTableId },
      },
      {
        id: "repair-link-widget",
        type: "linked-entities",
        version: 1,
        tab: "info",
        order: 1,
        enabled: true,
        config: { linkIds: [missingWidgetLinkId] },
      },
      {
        id: "repair-scene-widget",
        type: "scene-map",
        version: 1,
        tab: "info",
        order: 2,
        enabled: true,
        config: { linkId: missingSceneLinkId },
      },
      {
        id: "repair-quest-widget",
        type: "quest-list",
        version: 1,
        tab: "info",
        order: 3,
        enabled: true,
        config: { questIds: [missingQuestId] },
      },
      {
        id: "repair-gallery-widget",
        type: "image-gallery",
        version: 1,
        tab: "info",
        order: 4,
        enabled: true,
        config: { images: [{ assetId: missingAssetId, caption: "Stale art" }] },
      },
    ];
    files["documents.json"] = strToU8(JSON.stringify(brokenDocuments));
    const brokenArchivePath = join(
      tmpdir(),
      `codex-broken-reference-${Date.now()}.zip`,
    );
    writeFileSync(brokenArchivePath, zipSync(files, { level: 6 }));

    try {
      await page.click("#close-world");
      await page.setInputFiles("#role-import", brokenArchivePath);
      const dialog = page.locator("[data-open-dialog]");
      await expect(dialog).toHaveAttribute("data-open-kind", "world");
      const audit = dialog.locator("[data-open-codex-audit]");
      await expect(audit).toContainText(
        "2 Codex sheet(s), 9 supported reference(s) checked.",
      );
      await expect(audit).toContainText(
        "Found 8 missing, 0 incompatible, and 0 malformed reference(s).",
      );
      await expect(audit).toContainText("Broken Route");
      await expect(audit).toContainText(childId);
      await expect(audit).toContainText(missingItemId);
      await expect(audit).toContainText(missingTableId);
      await expect(audit).toContainText(
        "3 additional diagnostic(s) are not listed here",
      );
      await dialog.locator("[data-open-replace]").click();
      await waitForApp(page);
      await expect
        .poll(() =>
          page.evaluate(
            (ids) => {
              const store = (
                globalThis as {
                  __vttE2E?: {
                    app?: {
                      gm?: {
                        client?: {
                          store?: {
                            get(collection: string, id: string): unknown;
                          };
                        };
                      };
                    };
                  };
                }
              ).__vttE2E?.app?.gm?.client?.store;
              const restoredRoot = store?.get("journals", ids.root) as
                JournalDocument | undefined;
              const widgetConfig = (widgetId: string) => {
                const value = restoredRoot?.codex?.widgets.find(
                  (widget) => widget.id === widgetId,
                )?.config;
                return value &&
                  typeof value === "object" &&
                  !Array.isArray(value)
                  ? (value as Record<string, unknown>)
                  : {};
              };
              return {
                missingTarget: store?.get("journals", ids.child) ?? null,
                missingStockItem: store?.get("items", ids.item) ?? null,
                linkTargetId: restoredRoot?.codex?.links[0]?.target.id ?? null,
                stockTargetId:
                  restoredRoot?.codex?.shop?.stock[0]?.item.id ?? null,
                archivedWidgetRefs: {
                  rollTable:
                    widgetConfig("repair-roll-table-widget").tableId ?? null,
                  relationship:
                    (
                      widgetConfig("repair-link-widget").linkIds as
                        string[] | undefined
                    )?.[0] ?? null,
                  sceneLink: widgetConfig("repair-scene-widget").linkId ?? null,
                  quest:
                    (
                      widgetConfig("repair-quest-widget").questIds as
                        string[] | undefined
                    )?.[0] ?? null,
                  galleryAsset:
                    (
                      widgetConfig("repair-gallery-widget").images as
                        Array<{ assetId?: string }> | undefined
                    )?.[0]?.assetId ?? null,
                  cover: restoredRoot?.codex?.cover ?? null,
                },
              };
            },
            { root: rootId, child: childId, item: missingItemId },
          ),
        )
        .toEqual({
          missingTarget: null,
          missingStockItem: null,
          linkTargetId: childId,
          stockTargetId: missingItemId,
          archivedWidgetRefs: {
            rollTable: missingTableId,
            relationship: missingWidgetLinkId,
            sceneLink: missingSceneLinkId,
            quest: missingQuestId,
            galleryAsset: missingAssetId,
            cover: missingAssetId,
          },
        });

      await page.evaluate((id) => {
        const client = (
          globalThis as {
            __vttE2E?: {
              app?: { gm?: { client?: { submit(ops: unknown[]): string } } };
            };
          }
        ).__vttE2E?.app?.gm?.client;
        if (!client) throw new Error("GM E2E client is unavailable");
        client.submit([
          {
            kind: "create",
            coll: "rollTables",
            data: {
              _id: id,
              type: "rollTable",
              name: "Replacement Weather",
              ownership: { default: 3 },
              flags: {},
              system: {},
              formula: "1d6",
              results: [{ range: [1, 6], text: "Clear", documentRef: null }],
            },
          },
        ]);
      }, replacementTableId);
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const store = (
              globalThis as {
                __vttE2E?: {
                  app?: {
                    gm?: {
                      client?: {
                        store?: {
                          get(collection: string, id: string): unknown;
                        };
                      };
                    };
                  };
                };
              }
            ).__vttE2E?.app?.gm?.client?.store;
            return store?.get("rollTables", id) != null;
          }, replacementTableId),
        )
        .toBe(true);

      await page.locator('[data-tab="journals"]').click();
      await page.locator("[data-open-codex]").click();
      const codex = page.locator("[data-campaign-codex]");
      await codex.locator(`[data-codex-sheet="${rootId}"]`).click();
      const brokenLinks = codex.getByRole("region", {
        name: "Broken Codex links",
      });
      await expect(brokenLinks).not.toContainText("Old Destination");
      await expect(brokenLinks).toContainText(
        "worldfile-codex-repair-missing-child",
      );
      await expect(brokenLinks).toContainText("never guessed by name");
      const brokenStock = codex.getByRole("region", {
        name: "Broken shop item references",
      });
      await expect(brokenStock).toContainText(missingItemId);
      await expect(brokenStock).not.toContainText("Stale stock item");
      await brokenStock
        .getByLabel("Replacement item for stock row repair-stock-row")
        .selectOption({ label: "item: Replacement stock item" });
      await brokenStock
        .getByRole("button", { name: "Repair stock row" })
        .click();
      await expect(codex.locator('p.status[role="status"]')).toContainText(
        "Submitted repair for stock row",
        { timeout: 5_000 },
      );
      await expect(brokenStock).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const store = (
              globalThis as {
                __vttE2E?: {
                  app?: {
                    gm?: {
                      client?: {
                        store?: {
                          get(collection: string, id: string): unknown;
                        };
                      };
                    };
                  };
                };
              }
            ).__vttE2E?.app?.gm?.client?.store;
            const restoredRoot = store?.get("journals", id) as
              JournalDocument | undefined;
            return restoredRoot?.codex?.shop?.stock[0]?.item.id ?? null;
          }, rootId),
        )
        .toBe(replacementItemId);

      const brokenWidgetRefs = codex.getByRole("region", {
        name: "Broken widget references",
      });
      await expect(brokenWidgetRefs.locator("li")).toHaveCount(5);
      const tableIssue = brokenWidgetRefs
        .locator("li")
        .filter({ hasText: missingTableId });
      await tableIssue
        .getByLabel(
          `Replacement for roll-table widget repair-roll-table-widget roll-table ${missingTableId}`,
        )
        .selectOption({ label: "Replacement Weather" });
      await tableIssue
        .getByRole("button", { name: "Repair reference" })
        .click();
      await expect(codex.locator('p.status[role="status"]')).toContainText(
        "Submitted repair for roll-table reference",
        { timeout: 5_000 },
      );
      await expect(brokenWidgetRefs.getByText(missingTableId)).toHaveCount(0);

      const linkWidgetIssue = brokenWidgetRefs
        .locator("li")
        .filter({ hasText: missingWidgetLinkId });
      await linkWidgetIssue
        .getByLabel(
          `Replacement for linked-entities widget repair-link-widget relationship ${missingWidgetLinkId}`,
        )
        .selectOption({ label: "Existing widget relationship" });
      await linkWidgetIssue
        .getByRole("button", { name: "Repair reference" })
        .click();
      await expect(codex.locator('p.status[role="status"]')).toContainText(
        "Submitted repair for relationship reference",
        { timeout: 5_000 },
      );
      await expect(brokenWidgetRefs.getByText(missingWidgetLinkId)).toHaveCount(
        0,
      );

      const questWidgetIssue = brokenWidgetRefs
        .locator("li")
        .filter({ hasText: missingQuestId });
      await questWidgetIssue
        .getByLabel(
          `Replacement for quest-list widget repair-quest-widget quest ${missingQuestId}`,
        )
        .selectOption({ label: "Existing widget quest" });
      await questWidgetIssue
        .getByRole("button", { name: "Repair reference" })
        .click();
      await expect(codex.locator('p.status[role="status"]')).toContainText(
        "Submitted repair for quest reference",
        { timeout: 5_000 },
      );
      await expect(brokenWidgetRefs.getByText(missingQuestId)).toHaveCount(0);

      const sceneWidgetIssue = brokenWidgetRefs
        .locator("li")
        .filter({ hasText: missingSceneLinkId });
      await sceneWidgetIssue
        .getByRole("button", { name: "Remove stale reference" })
        .click();
      await expect(codex.locator('p.status[role="status"]')).toContainText(
        "Removed stale scene-link reference",
        { timeout: 5_000 },
      );
      await expect(brokenWidgetRefs.getByText(missingSceneLinkId)).toHaveCount(
        0,
      );

      const galleryWidgetIssue = brokenWidgetRefs
        .locator("li")
        .filter({ hasText: missingAssetId });
      await galleryWidgetIssue
        .getByRole("button", { name: "Remove stale reference" })
        .click();
      await expect(codex.locator('p.status[role="status"]')).toContainText(
        "Removed stale gallery-image reference",
        { timeout: 5_000 },
      );
      await expect(brokenWidgetRefs).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(
            (ids) => {
              const store = (
                globalThis as {
                  __vttE2E?: {
                    app?: {
                      gm?: {
                        client?: {
                          store?: {
                            get(collection: string, id: string): unknown;
                          };
                        };
                      };
                    };
                  };
                }
              ).__vttE2E?.app?.gm?.client?.store;
              const root = store?.get("journals", ids.root) as
                JournalDocument | undefined;
              const configFor = (widgetId: string) => {
                const config = root?.codex?.widgets.find(
                  (widget) => widget.id === widgetId,
                )?.config;
                return config &&
                  typeof config === "object" &&
                  !Array.isArray(config)
                  ? (config as Record<string, unknown>)
                  : {};
              };
              return {
                tableId: configFor("repair-roll-table-widget").tableId ?? null,
                relationshipIds:
                  configFor("repair-link-widget").linkIds ?? null,
                sceneLink: configFor("repair-scene-widget").linkId ?? null,
                questIds: configFor("repair-quest-widget").questIds ?? null,
                galleryImages:
                  configFor("repair-gallery-widget").images ?? null,
              };
            },
            { root: rootId },
          ),
        )
        .toEqual({
          tableId: replacementTableId,
          relationshipIds: [survivingWidgetLinkId],
          sceneLink: null,
          questIds: [survivingQuestId],
          galleryImages: [],
        });

      const basicsEditor = codex.locator("details.basics-editor");
      await basicsEditor.locator("summary").click();
      await expect(basicsEditor).toContainText(
        "saved cover is missing or unavailable",
      );
      await basicsEditor.getByLabel("Codex cover image").selectOption("");
      await basicsEditor.getByRole("button", { name: "Save details" }).click();
      await expect(codex.locator('p.status[role="status"]')).toContainText(
        "Sheet details, cover, and tags saved.",
        { timeout: 5_000 },
      );
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const store = (
              globalThis as {
                __vttE2E?: {
                  app?: {
                    gm?: {
                      client?: {
                        store?: {
                          get(collection: string, id: string): unknown;
                        };
                      };
                    };
                  };
                };
              }
            ).__vttE2E?.app?.gm?.client?.store;
            return (
              (store?.get("journals", id) as JournalDocument | undefined)?.codex
                ?.cover ?? null
            );
          }, rootId),
        )
        .toBeNull();

      const replacementSelect = brokenLinks.getByLabel(
        "Replacement target for Destination to repair",
      );
      await replacementSelect.selectOption({
        label: "journal: Replacement Destination",
      });
      await brokenLinks.getByRole("button", { name: "Repair link" }).click();
      await expect(codex.locator('p.status[role="status"]')).toContainText(
        "Submitted repair",
        { timeout: 5_000 },
      );
      await expect(brokenLinks).toHaveCount(0);
      await expect(
        codex.locator("#codex-links-heading").locator(".."),
      ).toContainText("Destination to repair");
      await expect
        .poll(() =>
          page.evaluate(
            (ids) => {
              const store = (
                globalThis as {
                  __vttE2E?: {
                    app?: {
                      gm?: {
                        client?: {
                          store?: {
                            get(collection: string, id: string): unknown;
                          };
                        };
                      };
                    };
                  };
                }
              ).__vttE2E?.app?.gm?.client?.store;
              const repairedRoot = store?.get("journals", ids.root) as
                JournalDocument | undefined;
              return repairedRoot?.codex?.links[0]?.target.id ?? null;
            },
            { root: rootId },
          ),
        )
        .toBe(replacementId);
    } finally {
      rmSync(brokenArchivePath, { force: true });
    }
  });

  test("D-248/D-249: Settings sorts zips by kind, and the world file carries its strategic ruleset to another browser", async ({
    page,
    browser,
  }: {
    page: Page;
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(120_000);
    const dir = join(tmpdir(), `vtt-worldpkg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const rulesetPath = join(dir, "probe-rules.zip");
    writeFileSync(
      rulesetPath,
      zipOf({
        "manifest.json": JSON.stringify(RULESET_MANIFEST),
        "rules.js": RULES_JS,
      }),
    );
    const junkPath = join(dir, "junk.zip");
    writeFileSync(
      junkPath,
      zipOf({ "readme.txt": "not a world, not a package" }),
    );

    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);
      await expect(page.locator("#status [data-rules-status]")).toHaveText(
        /strategic rules: built-in/,
      );

      // ── D-249: the sidebar no longer imports; packages live under Settings ──
      await expect(page.locator("#import-world")).toHaveCount(0);
      await page.click("#gm-settings");
      const extras = page.locator('[data-window="settings"]');
      await expect(extras.locator("[data-pkg-section] h4")).toHaveText(
        "Strategic ruleset & content (§12)",
      );
      await expect(extras.locator("[data-pkg-status-ruleset]")).toContainText(
        "built-in",
      );
      await expect(extras.locator("[data-pkg-pinned]")).toHaveCount(0); // fresh campaign: switchable

      // ── Settings takes a RULESET: added to this world, no reboot ──
      await extras.locator("#pkg-file").setInputFiles(rulesetPath);
      const row = extras.locator('[data-pkg-row][data-pkg-id="probe-rules"]');
      await expect(row).toContainText("strategic ruleset");
      await expect
        .poll(() => appCall<Array<{ id: string }>>(page, "packages"))
        .toEqual([
          expect.objectContaining({ id: "probe-rules", active: false }),
        ]);
      expect(await appCall<string>(page, "worldId")).toBeTruthy(); // same page, same world

      // ── junk is named, not failed with a zip-internal message ──
      await extras.locator("#pkg-file").setInputFiles(junkPath);
      await expect(extras.locator("[data-pkg-error]")).toContainText(
        "neither a world file",
      );

      // ── activate: the section talks about strategic scenes and offers the reload ──
      await row.locator("[data-pkg-activate]").click();
      await expect(row.locator("[data-pkg-active]")).toHaveCount(1);
      await expect(extras.locator("[data-pkg-reload]")).toBeVisible();

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click("#export-world"),
      ]);
      const worldPath = (await download.path()) as string;
      const archive = new Uint8Array(await readFile(worldPath));
      const files = unzipSync(archive);
      const meta = JSON.parse(strFromU8(files["world.json"] as Uint8Array)) as {
        format: number;
        worldId: string;
        name: string;
        system: string;
        rules: { active: string | null };
      };
      expect(meta.format).toBe(2);
      expect(meta.rules).toEqual({ active: "probe-rules" });
      expect(meta.system).toBe("probe-rules");
      expect(
        JSON.parse(strFromU8(files["packages.json"] as Uint8Array)) as Array<{
          id: string;
        }>,
      ).toEqual([
        expect.objectContaining({ id: "probe-rules", type: "system" }),
      ]);
      expect(
        strFromU8(files["packages/probe-rules/rules.js"] as Uint8Array),
      ).toBe(RULES_JS);

      // …and refuses a WORLD file, pointing at the start screen
      await extras.locator("#pkg-file").setInputFiles(worldPath);
      await expect(extras.locator("[data-pkg-error]")).toContainText(
        "is a world file",
      );

      // ── reload: the package now runs the strategic slot, and the status says so ──
      await page.reload();
      await waitForApp(page);
      await expect
        .poll(() =>
          appCall<{ source: string; packageId: string | null }>(
            page,
            "rulesBoot",
          ),
        )
        .toEqual(
          expect.objectContaining({
            source: "package",
            packageId: "probe-rules",
          }),
        );
      await expect(page.locator("#status [data-rules-status]")).toHaveText(
        "strategic rules: probe-rules v9.9.9",
      );
      await expect(page.locator("[data-rules-boot-error]")).toHaveCount(0);
      await page.click("#gm-settings");
      await expect(extras.locator("[data-pkg-status-ruleset]")).toContainText(
        "Probe Rules v9.9.9 (package)",
      );

      // ── "another GM's machine": a fresh browser context has no packages at all ──
      const other = await browser.newContext();
      try {
        const picker = await other.newPage();
        await picker.goto(entry);
        await expect(picker.locator("#role-host")).toBeVisible();
        await expect(picker.locator("[data-world-empty]")).toBeVisible();
        // Open file names a package for what it is and offers the wizard instead of failing
        await picker.setInputFiles("#role-import", rulesetPath);
        const pkgDialog = picker.locator("[data-open-dialog]");
        await expect(pkgDialog).toHaveAttribute("data-open-kind", "package");
        await expect(pkgDialog).toContainText(
          "Probe Rules v9.9.9 (strategic ruleset)",
        );
        await expect(pkgDialog.locator("[data-open-wizard]")).toBeVisible();
        await pkgDialog.locator("[data-open-cancel]").click();
        await expect(pkgDialog).toHaveCount(0);
        // …and a world file is described (ruleset it carries) and opened as a copy
        await picker.setInputFiles("#role-import", worldPath);
        await expect(pkgDialog).toHaveAttribute("data-open-kind", "world");
        await expect(pkgDialog.locator("[data-open-contents]")).toContainText(
          "strategic ruleset Probe Rules v9.9.9",
        );
        await expect(pkgDialog.locator("#open-copy-name")).toHaveValue(
          `${meta.name} (copy)`,
        );
        await expect(pkgDialog.locator("[data-open-replace]")).toContainText(
          "Restore (keep its id)",
        );
        await pkgDialog.locator("[data-open-copy]").click();
        // the picker route mounts the shell only once the boot has an app (status + canvas live)
        await expect(picker.locator("#status")).toContainText(
          `${meta.name} (copy)`,
          { timeout: 20_000 },
        );
        await expect(picker.locator("canvas").first()).toBeVisible();
        await expect(picker.locator("#status [data-rules-status]")).toHaveText(
          "strategic rules: probe-rules v9.9.9",
        );
        await expect(picker.locator("[data-rules-boot-error]")).toHaveCount(0);
        await picker.click("#gm-settings");
        const otherSettings = picker.locator('[data-window="settings"]');
        await expect(
          otherSettings.locator(
            '[data-pkg-row][data-pkg-id="probe-rules"] [data-pkg-active]',
          ),
        ).toHaveCount(1);

        // ── back on the start screen the copy is listed under its own id; Export + Delete work ──
        await picker.click("#close-world");
        const rows = picker.locator("[data-world-list] [data-world-row]");
        await expect(rows).toHaveCount(1);
        await expect(rows.first().locator("[data-world-name]")).toHaveText(
          `${meta.name} (copy)`,
        );
        await expect(rows.first()).toContainText("probe-rules v9.9.9");
        const copyId = await rows.first().getAttribute("data-world-id");
        expect(copyId).toBeTruthy();
        expect(copyId).not.toBe(meta.worldId);
        const [listDownload] = await Promise.all([
          picker.waitForEvent("download"),
          rows.first().locator("[data-world-export]").click(),
        ]);
        const listed = unzipSync(
          new Uint8Array(await readFile((await listDownload.path()) as string)),
        );
        const listedMeta = JSON.parse(
          strFromU8(listed["world.json"] as Uint8Array),
        ) as {
          worldId: string;
          rules: { active: string | null };
        };
        expect(listedMeta.worldId).toBe(copyId);
        expect(listedMeta.rules).toEqual({ active: "probe-rules" });
        // delete is two-step: the first click arms, the second removes the world
        await rows.first().locator("[data-world-delete]").click();
        await expect(
          rows.first().locator("[data-world-delete]"),
        ).toHaveAttribute("data-world-delete-armed", "true");
        await rows.first().locator("[data-world-delete]").click();
        await expect(picker.locator("[data-world-empty]")).toBeVisible();
        await expect(picker.locator("[data-start-notice]")).toContainText(
          "Deleted",
        );
      } finally {
        await other.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
