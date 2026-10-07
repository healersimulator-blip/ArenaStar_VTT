import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import type { JournalDocument } from "../../src/core/documents";
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
        links: [],
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
        shop: { mode: "shop", markup: 1.2, currencyLabel: "gp", stock: [] },
      },
    };
    app.gm.client.submit([{ kind: "create", coll: "journals", data: codex }]);
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

    await deleteWorldData(db, copied.worldId);
    await deleteWorldData(db, futureCopy.worldId);
    await deleteWorldData(db, sourceWorldId);
    db.close();
  });
});
