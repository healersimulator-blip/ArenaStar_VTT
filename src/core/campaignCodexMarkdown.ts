/* eslint-disable no-useless-escape, @typescript-eslint/no-non-null-assertion */
/**
 * Permission-filtered Markdown / Obsidian export for explicitly selected Codex roots.
 * This is a reader-friendly derivative of the selected-content pipeline, never a World ZIP.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { strToU8, zipSync } from "fflate";
import type {
  ActorDocument,
  AssetManifest,
  AssetManifestEntry,
  BaseDocument,
  CodexLink,
  CodexObjective,
  CodexQuest,
  DocRef,
  JournalDocument,
  RollTableDocument,
  SceneDocument,
  WorldCollections,
} from "./documents";
import type { PermissionUser } from "./ownership";
import {
  CODEX_BUNDLE_MAX_ARCHIVE_BYTES,
  CODEX_BUNDLE_MAX_ASSET_BYTES,
  CODEX_BUNDLE_MAX_UNCOMPRESSED_BYTES,
  buildCodexBundleModel,
  type CodexBundleReport,
  type CodexBundleDocuments,
} from "./campaignCodexBundle";

const HASH_RE = /^[a-f0-9]{64}$/i;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};
const LINK_RELATION_LABELS: Record<CodexLink["relation"], string> = {
  contains: "Contains",
  locatedAt: "Located at",
  associatedWith: "Associated with",
  operatedBy: "Operated by",
  representsActor: "Represents actor",
  linksScene: "Links scene",
  linksItem: "Links item",
  relatedTo: "Related to",
};

type MarkdownLinkStyle = "markdown" | "obsidian";
interface LinkTarget { path: string; fragment?: string }

export interface CodexMarkdownExportOptions {
  world: Readonly<WorldCollections>;
  manifest: AssetManifest;
  viewer: PermissionUser;
  rootJournalIds: readonly string[];
  /** Optional local asset loader. Bytes are included only after size and SHA-256 validation. */
  loadAsset?: (assetId: string) => Promise<Uint8Array | undefined>;
  linkStyle?: MarkdownLinkStyle;
}

export interface ExportedCodexMarkdown {
  bytes: Uint8Array;
  report: CodexBundleReport;
  /** Number of otherwise eligible media files omitted for missing bytes or failed validation. */
  omittedLocalMedia: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function topKey(collection: string, id: string): string { return `${collection}:${id}`; }
function refKey(ref: DocRef): string {
  return ref.parent ? `${refKey(ref.parent)}/${ref.coll}:${ref.id}` : topKey(ref.coll, ref.id);
}

function slug(name: string): string {
  const safe = name.normalize("NFKD").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return safe || "codex-record";
}

function headingText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim() || "Untitled";
}
function markdownLabel(value: string): string {
  return headingText(value).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\|/g, "\\|");
}
function wikiLabel(value: string): string {
  return headingText(value).replace(/[\r\n\[\]]/g, " ").replace(/\|/g, "\\|");
}
function safeAssetExtension(entry: AssetManifestEntry): string {
  return IMAGE_EXTENSIONS[entry.mime.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? ""] ?? ".bin";
}

function allTopLevel(documents: CodexBundleDocuments): Array<{ collection: string; doc: BaseDocument }> {
  return [
    ...documents.journals.map((doc) => ({ collection: "journals", doc })),
    ...documents.actors.map((doc) => ({ collection: "actors", doc })),
    ...documents.items.map((doc) => ({ collection: "items", doc })),
    ...documents.scenes.map((doc) => ({ collection: "scenes", doc })),
    ...documents.rollTables.map((doc) => ({ collection: "rollTables", doc })),
  ];
}

function makeFilePaths(documents: CodexBundleDocuments): Map<string, LinkTarget> {
  const paths = new Map<string, LinkTarget>();
  for (const { collection, doc } of allTopLevel(documents)) {
    const file = `${slug(doc.name)}-${encodeURIComponent(doc._id)}.md`;
    paths.set(topKey(collection, doc._id), { path: `records/${file}` });
    if (doc.type === "journal") {
      for (const page of (doc as JournalDocument).pages)
        paths.set(`${topKey("journals", doc._id)}/pages:${page._id}`, {
          path: `records/${file}`,
          fragment: `page-${page._id}`,
        });
    } else if (doc.type === "actor") {
      for (const item of (doc as ActorDocument).items)
        paths.set(`${topKey("actors", doc._id)}/items:${item._id}`, {
          path: `records/${file}`,
          fragment: `item-${item._id}`,
        });
    }
  }
  return paths;
}

function linkTo(
  target: LinkTarget | undefined,
  label: string,
  style: MarkdownLinkStyle,
  fromRecordsFile: boolean,
): string | null {
  if (!target) return null;
  const fragment = target.fragment ? `#${target.fragment}` : "";
  const file = target.path.slice("records/".length);
  if (style === "obsidian")
    return `[[${target.path.replace(/\.md$/i, "")}${fragment}|${wikiLabel(label)}]]`;
  return `[${markdownLabel(label)}](${fromRecordsFile ? "./" : "records/"}${file}${fragment})`;
}

function resolveDocument(documents: CodexBundleDocuments, ref: DocRef): BaseDocument | undefined {
  if (ref.parent) {
    const parent = resolveDocument(documents, ref.parent);
    if (ref.coll === "pages" && parent?.type === "journal")
      return (parent as JournalDocument).pages.find((page) => page._id === ref.id);
    if (ref.coll === "items" && parent?.type === "actor")
      return (parent as ActorDocument).items.find((item) => item._id === ref.id);
    return undefined;
  }
  switch (ref.coll) {
    case "journals": return documents.journals.find((doc) => doc._id === ref.id);
    case "actors": return documents.actors.find((doc) => doc._id === ref.id);
    case "items": return documents.items.find((doc) => doc._id === ref.id);
    case "scenes": return documents.scenes.find((doc) => doc._id === ref.id);
    case "rollTables": return documents.rollTables.find((doc) => doc._id === ref.id);
    default: return undefined;
  }
}

function objectiveMarkdown(objectives: readonly CodexObjective[], depth = 0): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(Math.min(depth, 12));
  for (const objective of objectives) {
    lines.push(`${indent}- [${objective.completed ? "x" : " "}] ${markdownLabel(objective.title)}`);
    if (objective.description) lines.push(`${indent}  ${objective.description}`);
    lines.push(...objectiveMarkdown(objective.children, depth + 1));
  }
  return lines;
}

function questMarkdown(quests: readonly CodexQuest[]): string[] {
  const lines: string[] = [];
  for (const quest of quests) {
    lines.push(`### ${headingText(quest.title)} · ${quest.state}${quest.pinned ? " · pinned" : ""}`);
    if (quest.description) lines.push("", quest.description);
    if (quest.objectives.length) lines.push("", ...objectiveMarkdown(quest.objectives));
    lines.push("");
  }
  return lines;
}

function renderJournal(
  journal: JournalDocument,
  paths: Map<string, LinkTarget>,
  documents: CodexBundleDocuments,
  style: MarkdownLinkStyle,
  loadedAssets: ReadonlySet<string>,
  assetEntries: AssetManifest,
): string {
  const sheet = journal.codex;
  const lines = [`# ${headingText(journal.name)}`, ""];
  if (!sheet) return lines.join("\n");
  const kind = sheet.kind[0]?.toLocaleUpperCase() + sheet.kind.slice(1);
  lines.push(`> ${kind} · Campaign Codex`);
  if (sheet.subtitle) lines.push(`> ${headingText(sheet.subtitle)}`);
  lines.push("");
  if (sheet.cover && loadedAssets.has(sheet.cover)) {
    const entry = assetEntries[sheet.cover];
    if (entry && safeAssetExtension(entry) !== ".bin")
      lines.push(`![${markdownLabel(`${journal.name} cover`)}](../assets/${sheet.cover}${safeAssetExtension(entry)})`, "");
  }
  const tabs = new Map((sheet.tabs ?? []).map((tab) => [tab.key, tab.label]));
  for (const page of journal.pages) {
    const anchor = `page-${page._id}`;
    lines.push(`<a id="${anchor}"></a>`, `## ${headingText(page.codex?.label ?? page.name)}`);
    if (page.codex?.tabKey && tabs.has(page.codex.tabKey)) lines.push(`*${headingText(tabs.get(page.codex.tabKey) ?? "")}*`);
    lines.push("", page.text, "");
  }
  const readableLinks = sheet.links.flatMap((link) => {
    const targetDoc = resolveDocument(documents, link.target);
    const target = paths.get(refKey(link.target));
    if (!targetDoc || !target) return [];
    const label = link.label?.trim() || targetDoc.name;
    const rendered = linkTo(target, label, style, true);
    return rendered ? [`- **${LINK_RELATION_LABELS[link.relation]}:** ${rendered}`] : [];
  });
  if (readableLinks.length) lines.push("## Relationships", "", ...readableLinks, "");
  if (sheet.quests?.length) lines.push("## Quests", "", ...questMarkdown(sheet.quests));
  if (sheet.shop?.stock.length) {
    lines.push(`## ${sheet.shop.mode === "shop" ? "Shop" : "Loot"}`, "");
    for (const stock of sheet.shop.stock) {
      const targetDoc = resolveDocument(documents, stock.item);
      const target = paths.get(refKey(stock.item));
      if (!targetDoc || !target) continue;
      const rendered = linkTo(target, targetDoc.name, style, true);
      if (!rendered) continue;
      const quantity = stock.quantity === null ? "unlimited" : String(stock.quantity);
      const price = stock.unitPrice ? ` · ${stock.unitPrice} ${sheet.shop.currencyLabel ?? ""}`.trimEnd() : "";
      lines.push(`- ${rendered} · quantity: ${quantity}${price}`);
    }
    lines.push("");
  }
  const timelineWidgets = sheet.widgets.filter((widget) => widget.enabled && widget.type === "timeline" &&
    widget.version === 1 && isRecord(widget.config) && Array.isArray(widget.config.events));
  for (const widget of timelineWidgets) {
    const events = (widget.config as Record<string, unknown>).events;
    if (!Array.isArray(events)) continue;
    const eventLines = events.filter(isRecord).sort((a, b) => Number(a.order) - Number(b.order)).flatMap((event) => {
      if (typeof event.title !== "string" || typeof event.date !== "string") return [];
      return [`- **${headingText(event.date)} — ${headingText(event.title)}**${typeof event.description === "string" && event.description ? `\n  ${event.description}` : ""}`];
    });
    if (eventLines.length) lines.push("## Timeline", "", ...eventLines, "");
  }
  const sceneMapWidgets = sheet.widgets.filter((widget) => widget.enabled && widget.type === "scene-map" &&
    widget.version === 1 && isRecord(widget.config) && typeof widget.config.linkId === "string");
  for (const widget of sceneMapWidgets) {
    const link = sheet.links.find((candidate) => candidate.id === (widget.config as Record<string, unknown>).linkId && candidate.relation === "linksScene");
    if (!link) continue;
    const scene = resolveDocument(documents, link.target);
    const rendered = scene && linkTo(paths.get(refKey(link.target)), scene.name, style, true);
    if (rendered) lines.push("## Scene map", "", rendered, "");
  }
  const tableWidgets = sheet.widgets.filter((widget) => widget.enabled && widget.type === "roll-table" &&
    widget.version === 1 && isRecord(widget.config) && typeof widget.config.tableId === "string");
  for (const widget of tableWidgets) {
    const tableId = (widget.config as Record<string, unknown>).tableId;
    const tableRef: DocRef = { coll: "rollTables", id: String(tableId) };
    const table = resolveDocument(documents, tableRef);
    const rendered = table && linkTo(paths.get(refKey(tableRef)), table.name, style, true);
    if (rendered) lines.push("## Roll table", "", rendered, "");
  }
  const galleryWidgets = sheet.widgets.filter((widget) => widget.enabled && widget.type === "image-gallery" &&
    widget.version === 1 && isRecord(widget.config) && Array.isArray(widget.config.images));
  for (const widget of galleryWidgets) {
    const config = widget.config as Record<string, unknown>;
    const images = Array.isArray(config.images) ? config.images : [];
    const renderedImages = images.flatMap((image) => {
      if (!isRecord(image) || typeof image.assetId !== "string" || !loadedAssets.has(image.assetId)) return [];
      const entry = assetEntries[image.assetId];
      if (!entry || safeAssetExtension(entry) === ".bin") return [];
      const alt = typeof image.alt === "string" ? image.alt : typeof image.caption === "string" ? image.caption : "Campaign image";
      const caption = typeof image.caption === "string" && image.caption ? `\n*${image.caption}*` : "";
      return [`![${markdownLabel(alt)}](../assets/${image.assetId}${safeAssetExtension(entry)})${caption}`];
    });
    if (renderedImages.length) lines.push("## Gallery", "", ...renderedImages, "");
  }
  return lines.join("\n");
}

function renderStub(
  doc: BaseDocument,
  collection: string,
  documents: CodexBundleDocuments,
  paths: Map<string, LinkTarget>,
  style: MarkdownLinkStyle,
  loadedAssets: ReadonlySet<string>,
  assetEntries: AssetManifest,
): string {
  const lines = [`# ${headingText(doc.name)}`, "", `> ${doc.type} record included as a readable Codex dependency.`, ""];
  if (doc.type === "actor") {
    const actor = doc as ActorDocument;
    if (actor.items.length) {
      lines.push("## Items", "");
      for (const item of actor.items) {
        const target = paths.get(`${topKey("actors", actor._id)}/items:${item._id}`);
        const rendered = linkTo(target, item.name, style, true);
        if (rendered) lines.push(`- ${rendered}`);
      }
      lines.push("");
    }
  } else if (doc.type === "scene") {
    const scene = doc as SceneDocument;
    if (HASH_RE.test(scene.img ?? "") && loadedAssets.has(scene.img ?? "")) {
      const entry = assetEntries[scene.img!];
      if (entry && safeAssetExtension(entry) !== ".bin")
        lines.push(`![${markdownLabel(`${scene.name} map`)}](../assets/${scene.img}${safeAssetExtension(entry)})`, "");
    }
    const noteLinks = scene.notes.flatMap((note) => {
      if (!note.journalId) return [];
      const target = paths.get(topKey("journals", note.journalId));
      const rendered = linkTo(target, note.name || "Journal note", style, true);
      return rendered ? [`- ${rendered}`] : [];
    });
    if (noteLinks.length) lines.push("## Journal notes", "", ...noteLinks, "");
  } else if (doc.type === "rollTable") {
    const table = doc as RollTableDocument;
    lines.push(`**Formula:** ${table.formula}`, "", "## Results", "");
    for (const result of table.results) {
      const [low, high] = result.range;
      const ref = result.documentRef;
      const targetDoc = ref ? resolveDocument(documents, ref) : undefined;
      const link = ref ? linkTo(paths.get(refKey(ref)), targetDoc?.name ?? result.text, style, true) : null;
      lines.push(`- ${low === high ? low : `${low}–${high}`}: ${link ?? result.text}`);
    }
  } else if (collection === "items") {
    // The item system payload is deliberately not copied into Markdown; the selected document's
    // readable name is enough to preserve relationship navigation without exporting game internals.
  }
  return lines.join("\n");
}

/** Create a filtered ZIP of Markdown pages and locally verified permitted media. */
export async function exportCodexMarkdownZip(
  options: CodexMarkdownExportOptions,
): Promise<ExportedCodexMarkdown> {
  const built = buildCodexBundleModel(options.world, options.manifest, options.viewer, options.rootJournalIds);
  const style = options.linkStyle ?? "markdown";
  const assetEntries = built.bundle.assets;
  const loadedAssets = new Set<string>();
  const assetBytes = new Map<string, Uint8Array>();
  let totalAssetBytes = 0;
  let omittedLocalMedia = 0;
  for (const [assetId, entry] of Object.entries(assetEntries)) {
    let bytes: Uint8Array | undefined;
    if (options.loadAsset) {
      try { bytes = await options.loadAsset(assetId); } catch { bytes = undefined; }
    }
    if (!bytes || !HASH_RE.test(assetId) || bytes.length !== entry.size ||
      bytes.length > CODEX_BUNDLE_MAX_ASSET_BYTES || totalAssetBytes + bytes.length > CODEX_BUNDLE_MAX_UNCOMPRESSED_BYTES ||
      bytesToHex(sha256(bytes)) !== assetId) {
      omittedLocalMedia++;
      continue;
    }
    totalAssetBytes += bytes.length;
    loadedAssets.add(assetId);
    assetBytes.set(assetId, new Uint8Array(bytes));
  }

  const documents = built.bundle.documents;
  const paths = makeFilePaths(documents);
  const files: Record<string, Uint8Array> = {};
  const encode = (text: string): Uint8Array => strToU8(text);
  for (const journal of documents.journals) {
    const path = paths.get(topKey("journals", journal._id))?.path;
    if (path) files[path] = encode(renderJournal(journal, paths, documents, style, loadedAssets, assetEntries));
  }
  for (const { collection, doc } of allTopLevel(documents)) {
    if (doc.type === "journal") continue;
    const path = paths.get(topKey(collection, doc._id))?.path;
    if (path) files[path] = encode(renderStub(doc, collection, documents, paths, style, loadedAssets, assetEntries));
  }
  for (const [assetId, bytes] of assetBytes) {
    const entry = assetEntries[assetId];
    if (entry) files[`assets/${assetId}${safeAssetExtension(entry)}`] = bytes;
  }

  const rootLinks = built.bundle.roots.flatMap((ref) => {
    const doc = documents.journals.find((journal) => journal._id === ref.id);
    const target = paths.get(refKey(ref));
    if (!doc || !target) return [];
    const link = linkTo(target, doc.name, style, false);
    return link ? [`- ${link} · ${doc.codex?.kind ?? "Codex"}`] : [];
  });
  const records = allTopLevel(documents).flatMap(({ collection, doc }) => {
    const target = paths.get(topKey(collection, doc._id));
    const link = target ? linkTo(target, doc.name, style, false) : null;
    return link ? [`- ${link} · ${doc.type}`] : [];
  });
  const notes = [
    "Generated from the current viewer's readable projection and the explicitly selected roots.",
    "This is a Markdown/Obsidian reading export, not a full-world backup or an import/merge archive.",
    ...(built.bundle.report.hasUnavailableDependencies ? ["Some unreadable dependencies were omitted without identifying them."] : []),
    ...(built.bundle.report.hasPortablePermissionResets ? ["Source-world user-specific permissions were not carried into this export."] : []),
    ...(built.bundle.report.omittedMedia + omittedLocalMedia > 0 ? ["Some media was omitted because rights, local bytes, or hash verification were unavailable."] : []),
  ];
  files["README.md"] = encode([
    "# Campaign Codex export", "", "## Selected roots", "", ...rootLinks, "",
    "## Included readable records", "", ...records, "", "## Export notes", "", ...notes.map((note) => `- ${note}`), "",
  ].join("\n"));

  let uncompressed = 0;
  for (const value of Object.values(files)) {
    uncompressed += value.length;
    if (uncompressed > CODEX_BUNDLE_MAX_UNCOMPRESSED_BYTES)
      throw new Error("The Markdown export exceeds the 96 MiB uncompressed limit.");
  }
  const bytes = zipSync(files, { level: 6 });
  if (bytes.length > CODEX_BUNDLE_MAX_ARCHIVE_BYTES)
    throw new Error("The Markdown export exceeds the 64 MiB download limit.");
  return {
    bytes,
    report: built.bundle.report,
    omittedLocalMedia,
  };
}
