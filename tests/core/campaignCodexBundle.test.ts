/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AssetManifest, JournalDocument, WorldCollections } from "../../src/core/documents";
import { exportCodexMarkdownZip } from "../../src/core/campaignCodexMarkdown";
import {
  CODEX_BUNDLE_MAX_ASSET_BYTES,
  buildCodexBundleModel,
  exportCodexBundle,
  parseCodexBundleZip,
  planCodexBundleImport,
  type CodexContentBundle,
} from "../../src/core/campaignCodexBundle";
import { emptyWorld } from "../net/fixtures";

const player = { id: "bundle-player", role: "PLAYER" as const };
const gm = { id: "bundle-gm", role: "GM" as const };
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
const imageId = bytesToHex(sha256(bytes));
const restrictedImageId = "d".repeat(64);

function journal(id: string, name: string, ownership: 0 | 1 | 3 = 3): JournalDocument {
  return {
    _id: id, type: "journal", name, ownership: { default: ownership }, flags: {}, system: {},
    pages: [{ _id: `${id}-page`, type: "page", name: "Info", ownership: { default: ownership },
      flags: {}, system: {}, text: `${name} page`, src: null, codex: { tabKey: "info", audience: { kind: "inherit" } } }],
    codex: { version: 1, kind: "entry", tabs: [{ key: "info", label: "Info", order: 0 }],
      links: [], quests: [], widgets: [] },
  };
}

function fixture(): { world: WorldCollections; manifest: AssetManifest; root: JournalDocument; child: JournalDocument } {
  const world = emptyWorld();
  const root = journal("root", "Root", 3);
  const child = journal("child", "Distant Archive", 1);
  root.codex!.links.push({ id: "child-link", relation: "relatedTo", target: { coll: "journals", id: child._id } });
  root.codex!.widgets.push({ id: "gallery", type: "image-gallery", version: 1, tab: "info", order: 0,
    enabled: true, audience: { kind: "inherit" }, config: { images: [
      { assetId: imageId, caption: "Public map" },
      { assetId: restrictedImageId, caption: "No redistribution rights" },
    ] } });
  const privateJournal = journal("private", "Hidden vault", 0);
  root.codex!.links.push({ id: "hidden-link", relation: "relatedTo", target: { coll: "journals", id: privateJournal._id } });
  world.journals.push(root, child, privateJournal);
  const manifest: AssetManifest = {
    [imageId]: { name: "map.webp", mime: "image/webp", size: bytes.length, chunks: 1,
      visibility: "referenced", exportRights: "granted" },
    [restrictedImageId]: { name: "licensed.webp", mime: "image/webp", size: 10, chunks: 1,
      visibility: "referenced", exportRights: "restricted" },
  };
  world.assetManifest = manifest;
  return { world, manifest, root, child };
}

function nextIdFactory() {
  let id = 0;
  return () => `import-${++id}`;
}

describe("Campaign Codex selected-content bundle", () => {
  test("exports only selected readable dependency closure and rights-cleared media", () => {
    const { world, manifest, root, child } = fixture();
    const { bundle, assetIds } = buildCodexBundleModel(world, manifest, player, [root._id]);
    expect(assetIds).toEqual([imageId]);
    expect(bundle.documents.journals.map((doc) => doc._id).sort()).toEqual([child._id, root._id].sort());
    expect(bundle.documents.journals.some((doc) => doc._id === "private")).toBe(false);
    const exportedRoot = bundle.documents.journals.find((doc) => doc._id === root._id)!;
    expect(exportedRoot.codex?.links.map((link) => link.id)).toEqual(["child-link"]);
    expect(exportedRoot.codex?.widgets[0]?.config).toEqual({ images: [{ assetId: imageId, caption: "Public map" }] });
    expect(bundle.report.omittedMedia).toBe(1);
    expect(bundle.report.hasUnavailableDependencies).toBe(false);
  });

  test("removes source-world user ids and makes selected-user policies private", () => {
    const world = emptyWorld();
    const root = journal("portable", "Portable", 3);
    root.ownership = { default: 3, "source-user-opaque": 3 };
    root.codex!.tabs![0]!.audience = { kind: "selectedUsers", userIds: ["source-user-opaque"] };
    world.journals.push(root);
    world.assetManifest = {};
    const bundle = buildCodexBundleModel(world, {}, gm, [root._id]).bundle;
    const portableRoot = bundle.documents.journals[0]!;
    expect(portableRoot.ownership).toEqual({ default: 3 });
    expect(portableRoot.codex?.tabs?.[0]?.audience).toEqual({ kind: "gmOnly" });
    expect(bundle.report.hasPortablePermissionResets).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain("source-user-opaque");
  });

  test("writes a hash-verified selected ZIP and rejects tampered asset bytes", async () => {
    const { world, manifest, root } = fixture();
    const exported = await exportCodexBundle({ world, manifest, viewer: player, rootJournalIds: [root._id],
      loadAsset: async (assetId) => assetId === imageId ? bytes : undefined });
    const parsed = parseCodexBundleZip(exported.bytes);
    expect(parsed.assetBytes.get(imageId)).toEqual(bytes);
    expect(parsed.bundle.report.omittedMedia).toBe(1);
    const archive = unzipSync(exported.bytes);
    const listing = strFromU8(archive["campaign-codex.json"]!);
    expect(listing).not.toContain("Hidden vault");
    expect(parsed.bundle).not.toHaveProperty("worldId");
    const damagedFiles = unzipSync(exported.bytes);
    const damagedAsset = new Uint8Array(damagedFiles[`assets/${imageId}`]!);
    damagedAsset[0] = (damagedAsset[0] ?? 0) ^ 0xff;
    damagedFiles[`assets/${imageId}`] = damagedAsset;
    expect(() => parseCodexBundleZip(zipSync(damagedFiles))).toThrow(/hash check/);
  });

  test("does not accept a private World ZIP as a selected-content bundle", () => {
    const privateWorldZip = zipSync({ "world.json": new TextEncoder().encode(JSON.stringify({ worldId: "private-world" })) });
    expect(() => parseCodexBundleZip(privateWorldZip)).toThrow(/unsupported file path/);
  });

  test("exports visibility-filtered Markdown with mapped Obsidian links and only licensed local media", async () => {
    const { world, manifest, root, child } = fixture();
    root.pages[0]!.text = "Public page text. <secret>GM-only page text.</secret>";
    child.pages[0]!.text = "Visible child page.";
    const exported = await exportCodexMarkdownZip({
      world, manifest, viewer: player, rootJournalIds: [root._id],
      loadAsset: async (assetId) => assetId === imageId ? bytes : undefined,
      linkStyle: "obsidian",
    });
    const files = unzipSync(exported.bytes);
    const entries = Object.entries(files).map(([path, data]) => [path, strFromU8(data)] as const);
    const output = entries.map(([path, text]) => `${path}\n${text}`).join("\n");
    expect(output).toContain("[[records/distant-archive-child|Distant Archive]]");
    expect(output).toContain("Public page text.");
    expect(output).toContain("Visible child page.");
    expect(output).toContain(`assets/${imageId}.webp`);
    expect(output).not.toContain("GM-only page text");
    expect(output).not.toContain("Hidden vault");
    expect(output).not.toContain(restrictedImageId);
    expect(output).not.toContain("worldId");
    expect(exported.report.hasUnavailableDependencies).toBe(false);
    expect(exported.report.omittedMedia).toBe(1);
    expect(exported.omittedLocalMedia).toBe(0);

    const markdown = await exportCodexMarkdownZip({ world, manifest, viewer: player,
      rootJournalIds: [root._id], loadAsset: async () => bytes, linkStyle: "markdown" });
    const markdownFiles = unzipSync(markdown.bytes);
    const markdownText = Object.entries(markdownFiles).map(([path, data]) => `${path}\n${strFromU8(data)}`).join("\n");
    expect(markdownText).toContain("[Distant Archive](./distant-archive-child.md)");
  });

  test("remaps document, page, and relationship references before one create batch", async () => {
    const { world, manifest, root } = fixture();
    const exported = await exportCodexBundle({ world, manifest, viewer: player, rootJournalIds: [root._id],
      loadAsset: async (assetId) => assetId === imageId ? bytes : undefined });
    const bundle = parseCodexBundleZip(exported.bytes).bundle;
    const destination = emptyWorld();
    const plan = planCodexBundleImport(bundle, destination, {}, nextIdFactory());
    expect(plan.ready).toBe(true);
    expect(plan.ops).toHaveLength(2);
    const creates = plan.ops.filter((op) => op.kind === "create");
    const newRoot = creates.find((op) => op.kind === "create" && op.data.name === "Root")?.data as JournalDocument;
    const newChild = creates.find((op) => op.kind === "create" && op.data.name === "Distant Archive")?.data as JournalDocument;
    expect(newRoot._id).not.toBe(root._id);
    expect(newRoot.pages[0]?._id).not.toBe(root.pages[0]?._id);
    expect(newRoot.codex?.links[0]?.target.id).not.toBe("child");
    expect(newRoot.codex?.links[0]?.target.id).toBe(newChild._id);
    expect(newRoot.codex?.widgets[0]?.config).toEqual({ images: [{ assetId: imageId, caption: "Public map" }] });
    expect(plan.operationBytes).toBeGreaterThan(0);
  });

  test("requires explicit skip/link/replace choices for name matches", () => {
    const incoming = journal("incoming-root", "Root", 3);
    const dependency = journal("incoming-child", "New Record", 3);
    incoming.codex!.links.push({ id: "new-link", relation: "relatedTo", target: { coll: "journals", id: dependency._id } });
    const bundle: CodexContentBundle = {
      format: "arenastar-codex-bundle", version: 1,
      roots: [{ coll: "journals", id: incoming._id }],
      documents: { journals: [incoming, dependency], actors: [], items: [], scenes: [], rollTables: [] },
      assets: {}, report: { included: { journals: 2, actors: 0, items: 0, scenes: 0, rollTables: 0 }, omittedMedia: 0,
        hasUnavailableDependencies: false, hasPortablePermissionResets: false },
    };
    const destination = emptyWorld();
    destination.journals.push(journal("local-child", "new record", 3));
    const pending = planCodexBundleImport(bundle, destination, {}, nextIdFactory());
    expect(pending.ready).toBe(false);
    expect(pending.pendingConflicts).toEqual(["journals:incoming-child"]);
    expect(pending.ops).toHaveLength(0);

    const skipped = planCodexBundleImport(bundle, destination, {
      "journals:incoming-child": { action: "skip" },
    }, nextIdFactory());
    expect(skipped.ready).toBe(true);
    expect(skipped.ops).toHaveLength(1);
    const skippedRoot = skipped.ops.find((op) => op.kind === "create" && op.data.name === "Root");
    expect(skippedRoot?.kind).toBe("create");
    const skippedJournal = skippedRoot?.kind === "create" ? skippedRoot.data as JournalDocument : undefined;
    expect(skippedJournal?.codex?.links).toEqual([]);

    const linked = planCodexBundleImport(bundle, destination, {
      "journals:incoming-child": { action: "link", targetId: "local-child" },
    }, nextIdFactory());
    expect(linked.ready).toBe(true);
    expect(linked.ops).toHaveLength(1);
    const linkedRoot = linked.ops.find((op) => op.kind === "create" && op.data.name === "Root");
    expect(linkedRoot?.kind).toBe("create");
    const linkedJournal = linkedRoot?.kind === "create" ? linkedRoot.data as JournalDocument : undefined;
    expect(linkedJournal?.codex?.links[0]?.target).toEqual({ coll: "journals", id: "local-child" });

    const replaced = planCodexBundleImport(bundle, destination, {
      "journals:incoming-child": { action: "replace", targetId: "local-child" },
    }, nextIdFactory());
    expect(replaced.ready).toBe(true);
    const update = replaced.ops.find((op) => op.kind === "update");
    expect(update?.kind).toBe("update");
    expect(update?.ref).toEqual({ coll: "journals", id: "local-child" });
    const rewritten = JSON.stringify(update?.diff);
    expect(rewritten).not.toContain("incoming-child");
    const replacedRoot = replaced.ops.find((op) => op.kind === "create" && op.data.name === "Root");
    expect(replacedRoot?.kind).toBe("create");
    const replacedJournal = replacedRoot?.kind === "create" ? replacedRoot.data as JournalDocument : undefined;
    expect(replacedJournal?.codex?.links[0]?.target).toEqual({ coll: "journals", id: "local-child" });
  });

  test("reports partially missing dependencies and removes dangling links during import remapping", async () => {
    const { world, manifest, root } = fixture();
    root.codex!.links.push({
      id: "legacy-dangling-link", relation: "relatedTo",
      target: { coll: "journals", id: "missing-legacy-record" },
    });
    const exported = await exportCodexBundle({
      world, manifest, viewer: gm, rootJournalIds: [root._id], loadAsset: async () => undefined,
    });
    const parsed = parseCodexBundleZip(exported.bytes).bundle;
    expect(parsed.report.hasUnavailableDependencies).toBe(true);
    const exportedRoot = parsed.documents.journals.find((doc) => doc._id === root._id)!;
    expect(exportedRoot.codex?.links.some((link) => link.id === "legacy-dangling-link")).toBe(false);

    // A legacy archive may still carry the stale DocRef itself. Keep that import repairable:
    // warn generically, remap the valid closure, and drop only the reference with no target.
    exportedRoot.codex!.links.push({
      id: "legacy-dangling-link", relation: "relatedTo",
      target: { coll: "journals", id: "missing-legacy-record" },
    });
    const plan = planCodexBundleImport(parsed, emptyWorld(), {}, nextIdFactory());
    expect(plan.ready).toBe(true);
    expect(plan.warnings).toContain("Some dependencies were unavailable to the exporter and are not included.");
    const rootOp = plan.ops.find((op) => op.kind === "create" && op.data.name === "Root");
    expect(rootOp?.kind).toBe("create");
    if (rootOp?.kind !== "create") throw new Error("Expected a remapped bundle root");
    expect((rootOp.data as JournalDocument).codex?.links.some((link) => link.id === "legacy-dangling-link")).toBe(false);
    expect((rootOp.data as JournalDocument).codex?.links.every((link) => link.target.id !== "missing-legacy-record")).toBe(true);
  });

  test("rejects an oversized compressed asset entry before extracting it", () => {
    const archive = zipSync({
      "campaign-codex.json": strToU8("{}"),
      [`assets/${"a".repeat(64)}`]: new Uint8Array(CODEX_BUNDLE_MAX_ASSET_BYTES + 1),
    }, { level: 9 });
    expect(archive.length).toBeLessThan(64 * 1024);
    expect(() => parseCodexBundleZip(archive)).toThrow(/asset exceeds 32 MiB/);
  });
});
