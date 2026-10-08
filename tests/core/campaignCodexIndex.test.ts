import { describe, expect, it } from "vitest";
import type { CodexLink, CodexSheetKind, CodexShopStockRow, DocRef, JournalDocument } from "../../src/core/documents";
import {
  buildCodexIndex,
  codexParentChain,
  replaceCodexLinkTarget,
  replaceCodexStockTarget,
  searchCodexIndex,
} from "../../src/core/campaignCodexIndex";

function sheet(
  id: string,
  name: string,
  kind: CodexSheetKind,
  links: CodexLink[] = [],
  options: { text?: string; taggerTags?: string[]; subtitle?: string } = {},
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
      text: options.text ?? "",
      src: null,
    }],
    taggerTags: options.taggerTags ?? [],
    codex: {
      version: 1,
      kind,
      ...(options.subtitle ? { subtitle: options.subtitle } : {}),
      links,
      widgets: [],
      quests: [],
    },
  };
}

function link(id: string, relation: CodexLink["relation"], targetId: string): CodexLink {
  return { id, relation, target: { coll: "journals", id: targetId } };
}

function resolveIn(sheets: readonly JournalDocument[]) {
  return (ref: DocRef) => ref.coll === "journals" && !ref.parent
    ? sheets.find((candidate) => candidate._id === ref.id)
    : undefined;
}

describe("Campaign Codex derived index", () => {
  it("indexes viewer-projected relationships, hierarchy, backlinks, tags, and searchable fields", () => {
    const region = sheet("region", "Northmere", "region", [], { text: "The frost-bound highlands." });
    const group = sheet("group", "Wayfarer Guild", "group", [
      link("contains-region", "contains", region._id),
      { id: "operated-by", relation: "operatedBy", target: { coll: "actors", id: "guildmaster" } },
    ], { subtitle: "Expedition organizers", taggerTags: ["Frontier"] });
    const tag = sheet("tag", "Lost Civilization", "tag", [
      link("tag-region", "associatedWith", region._id),
    ]);
    const sheets = [group, region, tag];
    const index = buildCodexIndex(sheets, resolveIn(sheets));

    expect(index.childrenByParentId.get(group._id)?.map((child) => child._id)).toEqual([region._id]);
    expect(index.parentIdsByChildId.get(region._id)).toEqual([group._id]);
    expect(codexParentChain(index, region._id).map((parent) => parent._id)).toEqual([group._id]);
    expect(index.incomingByRef.get("journals:region")?.map((incoming) => [
      incoming.source._id,
      incoming.link.id,
    ])).toEqual([[group._id, "contains-region"], [tag._id, "tag-region"]]);
    expect(index.codexTagIdsBySheetId.get(region._id)).toEqual([tag._id]);
    expect(index.codexTagNamesBySheetId.get(region._id)).toEqual([tag.name]);
    expect(searchCodexIndex(index, { query: "NORTHMERE frost-bound" })).toEqual([region]);
    expect(searchCodexIndex(index, { query: "expedition frontier" })).toEqual([group]);
    expect(searchCodexIndex(index, { query: "lost civilization" })).toEqual([region, tag]);
    expect(searchCodexIndex(index, { relation: "contains" })).toEqual([group]);
    expect(searchCodexIndex(index, { relation: "associatedWith" })).toEqual([tag]);
    expect(searchCodexIndex(index, { codexTagId: tag._id })).toEqual([region]);
    expect(searchCodexIndex(index, { taggerTag: "Frontier" })).toEqual([group]);
  });

  it("rebuilds safely after committed changes and keeps malformed or unresolved refs inert", () => {
    const child = sheet("child", "Child", "entry");
    const parent = sheet("parent", "Parent", "group", [
      link("stale", "contains", "missing"),
      { id: "malformed", relation: "relatedTo", target: { coll: "journals", id: "broken/%" } },
    ]);
    const before = buildCodexIndex([parent, child], resolveIn([parent, child]));
    expect(before.childrenByParentId.get(parent._id)).toBeUndefined();
    expect(searchCodexIndex(before, { query: "missing private secret" })).toEqual([]);

    const updatedParent = sheet("parent", "Parent", "group", [link("contains-child", "contains", child._id)]);
    const after = buildCodexIndex([updatedParent, child], resolveIn([updatedParent, child]));
    expect(after.childrenByParentId.get(updatedParent._id)?.map((row) => row._id)).toEqual([child._id]);
    expect(codexParentChain(after, child._id).map((row) => row._id)).toEqual([updatedParent._id]);
  });

  it("repairs exactly the selected relationship and leaves other links untouched", () => {
    const links = [
      link("first", "relatedTo", "missing"),
      link("sibling", "contains", "child"),
    ];
    const next = replaceCodexLinkTarget(links, "first", { coll: "journals", id: "replacement" });
    expect(next).not.toBeNull();
    expect(next?.[0]).toEqual({ ...links[0], target: { coll: "journals", id: "replacement" } });
    expect(next?.[1]).toBe(links[1]);
    expect(replaceCodexLinkTarget(links, "absent", { coll: "journals", id: "replacement" })).toBeNull();
  });

  it("repairs one dangling shop item reference without mutating sibling stock rows", () => {
    const stock: CodexShopStockRow[] = [
      { id: "missing-row", item: { coll: "items", id: "missing-item" }, quantity: 3, order: 0 },
      { id: "sibling-row", item: { coll: "items", id: "readable-item" }, quantity: null, unitPrice: "4.25", order: 1 },
    ];
    const replacement: DocRef = {
      coll: "items",
      id: "replacement-item",
      parent: { coll: "actors", id: "owner-actor" },
    };
    const next = replaceCodexStockTarget(stock, "missing-row", replacement);
    expect(next).not.toBeNull();
    expect(next?.[0]?.item).toEqual(replacement);
    expect(next?.[0]?.item).not.toBe(replacement);
    expect(next?.[0]?.item.parent).not.toBe(replacement.parent);
    expect(next?.[1]).toBe(stock[1]);
    expect(stock[0]?.item).toEqual({ coll: "items", id: "missing-item" });
    expect(replaceCodexStockTarget(stock, "absent-row", replacement)).toBeNull();
    expect(replaceCodexStockTarget(stock, "missing-row", { coll: "items", id: "bad/%" })).toBeNull();
  });

  it("handles a large relationship graph without losing deterministic navigation or search", () => {
    const count = 2_500;
    const sheets = Array.from({ length: count }, (_, index) =>
      sheet(`scale-${index}`, `Atlas record ${index}`, index === 0 ? "group" : "entry"),
    );
    for (let index = 0; index < count - 1; index += 1) {
      const parent = sheets[index];
      const child = sheets[index + 1];
      if (parent?.codex && child)
        parent.codex.links.push(link(`edge-${index}`, "contains", child._id));
    }
    const sheetsById = new Map(sheets.map((record) => [record._id, record]));
    const index = buildCodexIndex(sheets, (ref) =>
      ref.coll === "journals" && !ref.parent ? sheetsById.get(ref.id) : undefined,
    );

    expect(index.sheetsById.size).toBe(count);
    expect(index.incomingByRef.get(`journals:scale-${count - 1}`)).toHaveLength(1);
    expect(codexParentChain(index, `scale-${count - 1}`).map((parent) => parent._id)).toHaveLength(10);
    expect(searchCodexIndex(index, { query: `atlas record ${count - 1}` }).map((record) => record._id))
      .toEqual([`scale-${count - 2}`, `scale-${count - 1}`]);
  });

  it("does not search data that is absent from the current viewer projection", () => {
    const visible = sheet("visible", "Public Chronicle", "entry");
    const hidden = sheet("hidden", "GM Secret Cipher", "entry", [], { text: "Private rendezvous." });
    const viewerProjection = [visible];
    const index = buildCodexIndex(viewerProjection, resolveIn([visible, hidden]));
    expect(searchCodexIndex(index, { query: "cipher" })).toEqual([]);
    expect(searchCodexIndex(index, { query: "rendezvous" })).toEqual([]);
    expect(index.searchTextBySheetId.get(visible._id)).not.toContain("secret");
  });
});
