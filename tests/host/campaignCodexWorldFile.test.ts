import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import type { ActorDocument, ItemDocument, JournalDocument, SceneDocument } from "../../src/core/documents";
import {
  deleteWorldData,
  getAllDocumentRecords,
  openVttDb,
} from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import {
  exportWorldZip,
  importWorldZip,
  type WorldFileDocuments,
} from "../../src/host/worldFile";
import { boot, settle } from "../app/fakes";

describe("Campaign Codex full-world archive integration", () => {
  test("typed Codex fields ride the full World ZIP copy and restore; known corruption is rejected before replacement", async () => {
    const db = await openVttDb();
    const root = new MemDirHandle();
    const app = await boot(root);
    const child: JournalDocument = {
      _id: "codex-archive-child",
      type: "journal",
      name: "The Lower Quay",
      ownership: { default: 3 },
      flags: {},
      system: {},
      pages: [{
        _id: "codex-archive-child-page", type: "page", name: "Ledger", ownership: { default: 3 },
        flags: {}, system: {}, text: "A copper bell was hidden here.", src: null,
      }],
    };
    const item: ItemDocument = {
      _id: "codex-archive-item", type: "item", name: "Harbor key", ownership: { default: 3 },
      flags: {}, system: { quantity: 1, value: 0, weight: 0.1 }, effects: [],
    };
    const actor: ActorDocument = {
      _id: "codex-archive-actor", type: "actor", name: "Mara Venn", ownership: { default: 3 },
      flags: {}, system: {}, items: [], effects: [],
    };
    const scene: SceneDocument = {
      _id: "codex-archive-scene", type: "scene", name: "Black Harbor Map", ownership: { default: 3 },
      flags: {}, system: {}, active: false, img: null, width: 1000, height: 800, darkness: 0,
      grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
      tokens: [], walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
    };
    const codex: JournalDocument = {
      _id: "codex-archive-sheet",
      type: "journal",
      name: "The Black Harbor",
      ownership: { default: 3 },
      flags: {},
      system: {},
      pages: [
        {
          _id: "codex-archive-page",
          type: "page",
          name: "Overview",
          ownership: { default: 3 },
          flags: {},
          system: {},
          text: "Harbor notes",
          src: null,
          codex: { tabKey: "info", audience: { kind: "inherit" }, order: 0 },
        },
      ],
      codex: {
        version: 1,
        kind: "location",
        subtitle: "A salt-stained port",
        tabs: [
          {
            key: "info",
            label: "Info",
            order: 0,
            audience: { kind: "inherit" },
          },
        ],
        links: [
          { id: "archive-child-link", relation: "relatedTo", target: { coll: "journals", id: child._id } },
          { id: "archive-actor-link", relation: "representsActor", target: { coll: "actors", id: actor._id } },
          { id: "archive-item-link", relation: "linksItem", target: { coll: "items", id: item._id } },
          { id: "archive-scene-link", relation: "linksScene", target: { coll: "scenes", id: scene._id } },
        ],
        widgets: [
          {
            id: "widget-archive",
            type: "timeline",
            version: 1,
            tab: "info",
            order: 0,
            enabled: false,
            audience: { kind: "gmOnly" },
            config: { events: [{ id: "storm", date: "Eve", title: "The storm", order: 0 }] },
          },
        ],
        quests: [
          {
            id: "quest-archive",
            title: "Find the bell",
            description: "Below the quay",
            state: "active",
            pinned: true,
            order: 0,
            audience: { kind: "gmOnly" },
            objectives: [],
          },
        ],
        shop: {
          mode: "shop", markup: 1.2, currencyLabel: "gp",
          stock: [{ id: "archive-key-stock", item: { coll: "items", id: item._id }, quantity: 2, order: 0 }],
        },
      },
    };
    app.gm.client.submit([
      { kind: "create", coll: "items", data: item },
      { kind: "create", coll: "actors", data: actor },
      { kind: "create", coll: "scenes", data: scene },
      { kind: "create", coll: "journals", data: child },
      { kind: "create", coll: "journals", data: codex },
    ]);
    await settle();
    await app.persister.flush();
    const sourceWorldId = app.worldId;
    const archive = await exportWorldZip({
      db,
      worldId: sourceWorldId,
      root,
      persister: app.persister,
    });
    const entries = new Map(
      Object.entries(unzipSync(new Uint8Array(await archive.arrayBuffer()))),
    );
    const documentBytes = entries.get("documents.json");
    if (!documentBytes)
      throw new Error("documents.json missing from World ZIP");
    const docs = JSON.parse(strFromU8(documentBytes)) as WorldFileDocuments;
    expect(
      docs.docs.find((row) => row.coll === "journals" && row.id === codex._id)
        ?.doc,
    ).toEqual(codex);
    await app.close();

    const copyId = "w-codex-world-copy";
    const copied = await importWorldZip({
      db,
      file: archive,
      root,
      mode: "copy",
      worldId: copyId,
    });
    const copiedRows = await getAllDocumentRecords(db, copied.worldId);
    expect(
      copiedRows.find((row) => row.coll === "journals" && row.id === codex._id)
        ?.doc,
    ).toEqual(codex);
    for (const expected of [child, item, actor, scene])
      expect(copiedRows.find((row) => row.id === expected._id)?.doc).toEqual(expected);
    const copiedRoot = copiedRows.find((row) => row.coll === "journals" && row.id === codex._id)
      ?.doc as JournalDocument | undefined;
    if (!copiedRoot?.codex) throw new Error("Copied World ZIP omitted the Codex sheet");
    for (const link of copiedRoot.codex.links)
      expect(copiedRows.some((row) => row.coll === link.target.coll && row.id === link.target.id)).toBe(true);
    expect(copiedRoot.codex.shop?.stock[0]?.item.id).toBe(item._id);

    // The source and copy carry the same world-relative identifiers, but each archive world is
    // independently complete. Drift the source, then prove replace restores the original graph.
    const drifted = await boot(root, sourceWorldId);
    drifted.gm.client.submit([
      { kind: "update", ref: { coll: "journals", id: codex._id }, diff: { name: "Drifted Harbor" } },
      { kind: "update", ref: { coll: "journals", id: child._id }, diff: { name: "Drifted Quay" } },
    ]);
    await settle();
    await drifted.persister.flush();
    await drifted.close();
    const beforeRestore = await getAllDocumentRecords(db, sourceWorldId);
    expect(beforeRestore.find((row) => row.id === codex._id)?.doc).toMatchObject({ name: "Drifted Harbor" });
    const restored = await importWorldZip({ db, file: archive, root, mode: "replace" });
    expect(restored.worldId).toBe(sourceWorldId);
    const restoredRows = await getAllDocumentRecords(db, sourceWorldId);
    expect(restoredRows.find((row) => row.coll === "journals" && row.id === codex._id)?.doc).toEqual(codex);
    expect(restoredRows.find((row) => row.coll === "journals" && row.id === child._id)?.doc).toEqual(child);
    expect(restoredRows.find((row) => row.coll === "items" && row.id === item._id)?.doc).toEqual(item);
    for (const link of codex.codex?.links ?? [])
      expect(restoredRows.some((row) => row.coll === link.target.coll && row.id === link.target.id)).toBe(true);

    const malformedDocs: WorldFileDocuments = {
      ...docs,
      docs: docs.docs.map((row) => {
        if (row.coll !== "journals" || row.id !== codex._id) return row;
        const source = row.doc as JournalDocument;
        return {
          ...row,
          doc: {
            ...source,
            codex: {
              version: 1,
              kind: "location",
              links: "invalid",
              widgets: [],
            },
          } as unknown as JournalDocument,
        };
      }),
    };
    const malformedEntries = Object.fromEntries(entries);
    malformedEntries["documents.json"] = strToU8(JSON.stringify(malformedDocs));
    const malformedArchive = zipSync(malformedEntries);
    await expect(
      importWorldZip({ db, file: malformedArchive, mode: "replace", root }),
    ).rejects.toThrow(/journal codex-archive-sheet:.*Codex/i);
    const sourceRows = await getAllDocumentRecords(db, sourceWorldId);
    expect(
      sourceRows.find((row) => row.coll === "journals" && row.id === codex._id)
        ?.doc,
    ).toEqual(codex);

    const futureDocs: WorldFileDocuments = {
      ...docs,
      docs: docs.docs.map((row) =>
        row.coll === "journals" && row.id === codex._id
          ? {
              ...row,
              doc: {
                ...row.doc,
                codex: { version: 2, opaque: { retained: true } },
              } as unknown as JournalDocument,
            }
          : row,
      ),
    };
    const futureEntries = Object.fromEntries(entries);
    futureEntries["documents.json"] = strToU8(JSON.stringify(futureDocs));
    const futureArchive = zipSync(futureEntries);
    const futureCopy = await importWorldZip({
      db,
      file: futureArchive,
      mode: "copy",
      worldId: "w-codex-future",
    });
    const futureRows = await getAllDocumentRecords(db, futureCopy.worldId);
    expect(
      futureRows.find((row) => row.coll === "journals" && row.id === codex._id)
        ?.doc,
    ).toMatchObject({ codex: { version: 2, opaque: { retained: true } } });

    await deleteWorldData(db, sourceWorldId);
    const copyAfterSourceRemoval = await getAllDocumentRecords(db, copied.worldId);
    const survivingRoot = copyAfterSourceRemoval.find((row) => row.coll === "journals" && row.id === codex._id)
      ?.doc as JournalDocument | undefined;
    expect(survivingRoot).toEqual(codex);
    for (const link of survivingRoot?.codex?.links ?? [])
      expect(copyAfterSourceRemoval.some((row) => row.coll === link.target.coll && row.id === link.target.id)).toBe(true);
    expect(copyAfterSourceRemoval.find((row) => row.coll === "items" && row.id === item._id)?.doc).toEqual(item);

    await deleteWorldData(db, copied.worldId);
    await deleteWorldData(db, futureCopy.worldId);
    db.close();
  });

  test("keeps a missing legacy DocRef inert across full World ZIP copy and re-export", async () => {
    const db = await openVttDb();
    const root = new MemDirHandle();
    const app = await boot(root);
    const legacyJournal: JournalDocument = {
      _id: "worldfile-partial-root", type: "journal", name: "Old field notes",
      ownership: { default: 3 }, flags: {}, system: {},
      pages: [{
        _id: "worldfile-partial-page", type: "page", name: "Notes", ownership: { default: 3 },
        flags: {}, system: {}, text: "The archive was lost.", src: null,
      }],
    };
    const sameNameCandidate: JournalDocument = {
      _id: "worldfile-same-name-target", type: "journal", name: "The Missing Archive",
      ownership: { default: 3 }, flags: {}, system: {}, pages: [],
    };
    app.gm.client.submit([
      { kind: "create", coll: "journals", data: legacyJournal },
      { kind: "create", coll: "journals", data: sameNameCandidate },
    ]);
    await settle();
    await app.persister.flush();
    const archive = new Uint8Array(await (await exportWorldZip({
      db, worldId: app.worldId, root, persister: app.persister,
    })).arrayBuffer());
    const entries = unzipSync(archive);
    const documents = JSON.parse(strFromU8(entries["documents.json"] as Uint8Array)) as WorldFileDocuments;
    const missingId = "worldfile-missing-target";
    const codexJournal: JournalDocument = {
      ...legacyJournal,
      codex: {
        version: 1, kind: "entry",
        tabs: [{ key: "info", label: "Info", order: 0, audience: { kind: "inherit" } }],
        links: [{
          id: "legacy-stale-reference", relation: "relatedTo", label: sameNameCandidate.name,
          target: { coll: "journals", id: missingId },
        }],
        widgets: [], quests: [],
      },
    };
    documents.docs = documents.docs.map((row) =>
      row.coll === "journals" && row.id === codexJournal._id ? { ...row, doc: codexJournal } : row,
    );
    entries["documents.json"] = strToU8(JSON.stringify(documents));
    const partialArchive = zipSync(entries);
    const sourceWorldId = app.worldId;
    await app.close();

    const copyId = "w-worldfile-partial-copy";
    await importWorldZip({ db, file: partialArchive, root, mode: "copy", worldId: copyId });
    const copiedRows = await getAllDocumentRecords(db, copyId);
    const copiedRoot = copiedRows.find((row) => row.coll === "journals" && row.id === codexJournal._id)
      ?.doc as JournalDocument | undefined;
    expect(copiedRoot).toEqual(codexJournal);
    expect(copiedRoot?.codex?.links[0]?.target).toEqual({ coll: "journals", id: missingId });
    expect(copiedRows.some((row) => row.coll === "journals" && row.id === missingId)).toBe(false);
    expect(copiedRows.some((row) => row.coll === "journals" && row.id === sameNameCandidate._id)).toBe(true);

    const reexported = new Uint8Array(await (await exportWorldZip({ db, worldId: copyId, root })).arrayBuffer());
    const reexportedDocuments = JSON.parse(
      strFromU8(unzipSync(reexported)["documents.json"] as Uint8Array),
    ) as WorldFileDocuments;
    expect(reexportedDocuments.docs.find((row) => row.coll === "journals" && row.id === codexJournal._id)?.doc)
      .toEqual(codexJournal);

    await deleteWorldData(db, sourceWorldId);
    await deleteWorldData(db, copyId);
    db.close();
  });
});
