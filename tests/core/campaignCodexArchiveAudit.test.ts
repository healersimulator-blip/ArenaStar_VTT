import { describe, expect, it } from "vitest";
import type { JournalDocument } from "../../src/core/documents";
import { auditCodexArchiveDependencies } from "../../src/core/campaignCodexArchiveAudit";

const hash = "a".repeat(64);

function journal(
  id: string,
  name: string,
  codex: Record<string, unknown>,
): JournalDocument {
  return {
    _id: id,
    type: "journal",
    name,
    ownership: { default: 3 },
    flags: {},
    system: {},
    pages: [],
    codex: codex as unknown as NonNullable<JournalDocument["codex"]>,
  };
}

function row(coll: string, id: string, doc: unknown) {
  return { coll, id, doc };
}

describe("Campaign Codex full-world archive dependency audit", () => {
  it("recognizes top-level and embedded dependencies without reporting healthy refs", () => {
    const child = journal("child", "Northern Gate", {
      version: 1,
      kind: "location",
      links: [],
      widgets: [],
      quests: [],
    });
    const actor = {
      _id: "actor",
      type: "actor",
      name: "Ari",
      items: [{ _id: "embedded-item", type: "item", name: "Rations" }],
    };
    const root = journal("root", "Atlas", {
      version: 1,
      kind: "group",
      cover: hash,
      links: [
        {
          id: "inside",
          relation: "contains",
          target: { coll: "journals", id: "child" },
        },
        {
          id: "actor-link",
          relation: "representsActor",
          target: { coll: "actors", id: "actor" },
        },
        {
          id: "scene-link",
          relation: "linksScene",
          target: { coll: "scenes", id: "scene" },
        },
      ],
      shop: {
        mode: "loot",
        stock: [
          {
            id: "stock",
            item: {
              coll: "items",
              id: "embedded-item",
              parent: { coll: "actors", id: "actor" },
            },
            quantity: 1,
            order: 0,
          },
        ],
      },
      widgets: [
        {
          id: "roll",
          type: "roll-table",
          version: 1,
          tab: "info",
          order: 0,
          enabled: true,
          config: { tableId: "table" },
        },
        {
          id: "links",
          type: "linked-entities",
          version: 1,
          tab: "info",
          order: 1,
          enabled: true,
          config: { linkIds: ["inside"] },
        },
        {
          id: "scene-map",
          type: "scene-map",
          version: 1,
          tab: "info",
          order: 2,
          enabled: true,
          config: { linkId: "scene-link" },
        },
        {
          id: "quests",
          type: "quest-list",
          version: 1,
          tab: "info",
          order: 3,
          enabled: true,
          config: { questIds: ["quest"] },
        },
        {
          id: "gallery",
          type: "image-gallery",
          version: 1,
          tab: "info",
          order: 4,
          enabled: true,
          config: { images: [{ assetId: hash }] },
        },
      ],
      quests: [{ id: "quest", title: "Reach the gate" }],
    });
    const docs = {
      docs: [
        row("journals", root._id, root),
        row("journals", child._id, child),
        row("actors", "actor", actor),
        row("scenes", "scene", { _id: "scene", type: "scene", name: "North" }),
        row("rollTables", "table", {
          _id: "table",
          type: "rollTable",
          name: "Weather",
        }),
      ],
    };

    const audit = auditCodexArchiveDependencies(
      docs,
      [{ hash }],
      new Set([hash]),
    );
    expect(audit).toMatchObject({
      status: "complete",
      codexSheets: 2,
      referencesChecked: 10,
      uninspectedSheetCount: 0,
      uninspectedWidgetCount: 0,
      missingCount: 0,
      incompatibleCount: 0,
      invalidCount: 0,
      issues: [],
      omittedIssueCount: 0,
    });
    expect(root.codex?.links).toHaveLength(3);
  });

  it("matches asset IDs exactly as World ZIP restore looks up blob paths", () => {
    const upperHash = hash.toUpperCase();
    const root = journal("case-sensitive", "Asset path", {
      version: 1,
      kind: "entry",
      cover: upperHash,
      links: [],
      widgets: [],
    });
    const audit = auditCodexArchiveDependencies(
      { docs: [row("journals", root._id, root)] },
      [{ hash: upperHash }],
      new Set([hash]),
    );
    expect(audit).toMatchObject({
      status: "complete",
      missingCount: 1,
      issues: [
        {
          kind: "Codex cover",
          target: `assets:${upperHash}`,
          problem: "missing",
        },
      ],
    });
  });

  it("reports missing, incompatible and malformed refs and never mutates archived data", () => {
    const original = journal("root", "Broken Atlas", {
      version: 1,
      kind: "group",
      cover: hash,
      links: [
        {
          id: "lost",
          relation: "relatedTo",
          target: { coll: "journals", id: "missing" },
        },
        {
          id: "wrong-kind",
          relation: "linksScene",
          target: { coll: "items", id: "item" },
        },
        {
          id: "bad-ref",
          relation: "relatedTo",
          target: { coll: "custom", id: "invalid" },
        },
      ],
      shop: {
        mode: "loot",
        stock: [
          {
            id: "stock",
            item: { coll: "items", id: "gone" },
            quantity: 1,
            order: 0,
          },
        ],
      },
      widgets: [
        {
          id: "roll",
          type: "roll-table",
          version: 1,
          tab: "info",
          order: 0,
          enabled: true,
          config: { tableId: "missing-table" },
        },
        {
          id: "links",
          type: "linked-entities",
          version: 1,
          tab: "info",
          order: 1,
          enabled: true,
          config: { linkIds: ["absent-link"] },
        },
        {
          id: "scene-map",
          type: "scene-map",
          version: 1,
          tab: "info",
          order: 2,
          enabled: true,
          config: { linkId: "absent-scene-link" },
        },
        {
          id: "quests",
          type: "quest-list",
          version: 1,
          tab: "info",
          order: 3,
          enabled: true,
          config: { questIds: ["absent-quest"] },
        },
        {
          id: "gallery",
          type: "image-gallery",
          version: 1,
          tab: "info",
          order: 4,
          enabled: true,
          config: { images: [{ assetId: hash }] },
        },
      ],
      quests: [],
    });
    const before = JSON.stringify(original);
    const audit = auditCodexArchiveDependencies(
      {
        docs: [
          row("journals", original._id, original),
          row("items", "item", { _id: "item", type: "item", name: "Sword" }),
        ],
      },
      [],
      new Set(),
    );

    expect(audit).toMatchObject({
      status: "complete",
      codexSheets: 1,
      missingCount: 8,
      incompatibleCount: 1,
      invalidCount: 1,
    });
    expect(audit.referencesChecked).toBe(10);
    expect(audit.issues.map((issue) => issue.kind)).toContain("relationship");
    expect(audit.issues.some((issue) => issue.problem === "invalid")).toBe(
      true,
    );
    expect(JSON.stringify(original)).toBe(before);
  });

  it("bounds preview details while preserving exact issue counts", () => {
    const root = journal("many", "Many broken links", {
      version: 1,
      kind: "entry",
      links: Array.from({ length: 35 }, (_, index) => ({
        id: `link-${index}`,
        relation: "relatedTo",
        target: { coll: "journals", id: `missing-${index}` },
      })),
      widgets: [],
    });
    const audit = auditCodexArchiveDependencies(
      { docs: [row("journals", root._id, root)] },
      [],
      new Set(),
    );
    expect(audit.missingCount).toBe(35);
    expect(audit.referencesChecked).toBe(35);
    expect(audit.issues).toHaveLength(30);
    expect(audit.omittedIssueCount).toBe(5);
  });

  it("reports malformed references in supported widget configs and Codex covers", () => {
    const root = journal("malformed", "Malformed fields", {
      version: 1,
      kind: "entry",
      cover: "not-a-content-hash",
      links: [],
      widgets: [
        {
          id: "roll",
          type: "roll-table",
          version: 1,
          tab: "info",
          order: 0,
          enabled: true,
          config: { tableId: "bad id" },
        },
        {
          id: "gallery",
          type: "image-gallery",
          version: 1,
          tab: "info",
          order: 1,
          enabled: true,
          config: { images: [{ assetId: "bad" }] },
        },
        {
          id: "quests",
          type: "quest-list",
          version: 1,
          tab: "info",
          order: 2,
          enabled: true,
          config: { questIds: ["not a stable id"] },
        },
        {
          id: "links",
          type: "linked-entities",
          version: 1,
          tab: "info",
          order: 3,
          enabled: true,
          config: { linkIds: [42] },
        },
      ],
    });
    const audit = auditCodexArchiveDependencies(
      { docs: [row("journals", root._id, root)] },
      [],
      new Set(),
    );
    expect(audit).toMatchObject({
      status: "complete",
      referencesChecked: 5,
      invalidCount: 5,
      missingCount: 0,
      incompatibleCount: 0,
      uninspectedWidgetCount: 0,
    });
  });

  it("discloses unknown sheet versions and malformed sheet fields instead of claiming full coverage", () => {
    const future = journal("future-sheet", "Future schema", {
      version: 3,
      kind: "entry",
      links: [
        {
          id: "unknown",
          relation: "relatedTo",
          target: { coll: "actors", id: "missing" },
        },
      ],
      widgets: [],
    });
    const malformed = journal("malformed-sheet", "Malformed schema", {
      version: 1,
      kind: "entry",
      links: null,
      widgets: [],
    });
    const audit = auditCodexArchiveDependencies(
      {
        docs: [
          row("journals", future._id, future),
          row("journals", malformed._id, malformed),
        ],
      },
      [],
      new Set(),
    );
    expect(audit).toMatchObject({
      status: "complete",
      codexSheets: 2,
      uninspectedSheetCount: 2,
      referencesChecked: 0,
      missingCount: 0,
    });
  });

  it("discloses unknown widget types and future versions instead of claiming their refs were scanned", () => {
    const root = journal("future", "Future widget", {
      version: 1,
      kind: "entry",
      links: [],
      widgets: [
        {
          id: "plugin-widget",
          type: "third-party-map",
          version: 3,
          tab: "info",
          order: 0,
          enabled: true,
          config: { sceneId: "missing" },
        },
      ],
    });
    const audit = auditCodexArchiveDependencies(
      { docs: [row("journals", root._id, root)] },
      [],
      new Set(),
    );
    expect(audit).toMatchObject({
      status: "complete",
      uninspectedWidgetCount: 1,
      referencesChecked: 0,
      missingCount: 0,
      issues: [],
    });
  });

  it("fails open with explicit limits for oversized row and reference counts", () => {
    const tooManyRows = auditCodexArchiveDependencies(
      { docs: new Array(100_001).fill(null) },
      [],
      new Set(),
    );
    expect(tooManyRows).toMatchObject({
      status: "unavailable",
      reason:
        "The document index contains too many rows for the bounded Codex audit.",
    });
    const tooManyAssets = auditCodexArchiveDependencies(
      { docs: [] },
      new Array(100_001).fill(null),
      new Set(),
    );
    expect(tooManyAssets).toMatchObject({
      status: "unavailable",
      reason:
        "The asset index contains too many rows for the bounded Codex audit.",
    });
    const link = {
      id: "lost",
      relation: "relatedTo",
      target: { coll: "journals", id: "absent" },
    };
    const root = journal("many-refs", "Many refs", {
      version: 1,
      kind: "entry",
      links: new Array(100_001).fill(link),
      widgets: [],
    });
    expect(
      auditCodexArchiveDependencies(
        { docs: [row("journals", root._id, root)] },
        [],
        new Set(),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason:
        "The archive contains too many Codex references for the bounded audit.",
    });
  });

  it("fails open as an unavailable diagnostic for malformed or ambiguous archive indexes", () => {
    expect(auditCodexArchiveDependencies({}, [], new Set())).toMatchObject({
      status: "unavailable",
    });
    expect(
      auditCodexArchiveDependencies({ docs: [] }, {}, new Set()),
    ).toMatchObject({ status: "unavailable" });
    expect(
      auditCodexArchiveDependencies(
        {
          docs: [
            row("journals", "row-id", { _id: "different-id", type: "journal" }),
          ],
        },
        [],
        new Set(),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason:
        "The document index contains malformed or inconsistent document rows.",
    });
    expect(
      auditCodexArchiveDependencies(
        {
          docs: [
            row("actors", "same", { _id: "same", type: "actor" }),
            row("actors", "same", { _id: "same", type: "actor" }),
          ],
        },
        [],
        new Set(),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "The document index contains duplicate Codex target identities.",
    });
    expect(
      auditCodexArchiveDependencies(
        { docs: [] },
        [{ hash }, { hash }],
        new Set(),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "The asset index contains duplicate asset identities.",
    });
    expect(
      auditCodexArchiveDependencies(
        { docs: [] },
        [{ hash: "not-a-hash" }],
        new Set(),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "The asset index contains malformed asset records.",
    });
  });
});
