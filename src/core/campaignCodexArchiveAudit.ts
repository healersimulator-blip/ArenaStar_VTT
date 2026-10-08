/**
 * Dependency diagnostics for full-world ZIP previews. The audit is read-only: it never repairs,
 * rebinds, drops, or otherwise mutates an archived reference. Callers must keep using host
 * validation when an explicit GM repair is submitted.
 */
import type {
  BaseDocument,
  CodexLink,
  CodexWidgetInstance,
  DocRef,
  JournalDocument,
} from "./documents";
import {
  codexLinkTargetError,
  codexRefKey,
  isCodexDocRef,
} from "./campaignCodex";
import {
  CODEX_BUILTIN_WIDGET_TYPES,
  codexWidgetAssetIds,
  codexWidgetDocumentRefs,
} from "./campaignCodexWidgets";

export type CodexArchiveDependencyKind =
  | "relationship"
  | "shop stock"
  | "widget document"
  | "widget link"
  | "widget quest"
  | "Codex cover"
  | "widget asset";

export interface CodexArchiveDependencyIssue {
  sourceId: string;
  sourceName: string;
  kind: CodexArchiveDependencyKind;
  ownerId: string;
  target: string;
  problem: "missing" | "incompatible" | "invalid";
}

export interface CodexArchiveDependencyAudit {
  status: "complete" | "unavailable";
  codexSheets: number;
  referencesChecked: number;
  /** Sheets with unknown versions or malformed top-level fields are not fully interpretable. */
  uninspectedSheetCount: number;
  /** Widgets with unknown types/versions or unusable configs are deliberately not interpreted. */
  uninspectedWidgetCount: number;
  missingCount: number;
  incompatibleCount: number;
  invalidCount: number;
  /** First 30 diagnostics are retained for the preview; counts include any omitted details. */
  issues: CodexArchiveDependencyIssue[];
  omittedIssueCount: number;
  reason?: string;
}

interface WorldArchiveDocumentRow {
  coll: string;
  id: string;
  doc: unknown;
}

const MAX_AUDIT_DETAILS = 30;
const MAX_AUDIT_DOCUMENT_ROWS = 100_000;
const MAX_AUDIT_ASSET_ROWS = 100_000;
const MAX_AUDIT_REFERENCES = 100_000;
const AUDIT_REFERENCE_LIMIT = Symbol("Codex audit reference limit");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStableId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isAssetHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const knownWidgetTypes = new Set<string>(CODEX_BUILTIN_WIDGET_TYPES);

export function codexArchiveAuditUnavailable(
  reason: string,
): CodexArchiveDependencyAudit {
  return {
    status: "unavailable",
    codexSheets: 0,
    referencesChecked: 0,
    uninspectedSheetCount: 0,
    uninspectedWidgetCount: 0,
    missingCount: 0,
    incompatibleCount: 0,
    invalidCount: 0,
    issues: [],
    omittedIssueCount: 0,
    reason,
  };
}

/**
 * Audit typed Codex references against the documents/assets present in a full World ZIP. Inputs
 * are parsed JSON data; malformed top-level indexes yield an unavailable result rather than
 * changing the archive's classification or restore behavior.
 */
export function auditCodexArchiveDependencies(
  documentsValue: unknown,
  assetsValue: unknown,
  assetBlobIds: ReadonlySet<string>,
): CodexArchiveDependencyAudit {
  if (!isRecord(documentsValue) || !Array.isArray(documentsValue.docs))
    return codexArchiveAuditUnavailable(
      "The document index could not be checked.",
    );
  if (!Array.isArray(assetsValue))
    return codexArchiveAuditUnavailable(
      "The asset index could not be checked.",
    );
  if (documentsValue.docs.length > MAX_AUDIT_DOCUMENT_ROWS)
    return codexArchiveAuditUnavailable(
      "The document index contains too many rows for the bounded Codex audit.",
    );
  if (assetsValue.length > MAX_AUDIT_ASSET_ROWS)
    return codexArchiveAuditUnavailable(
      "The asset index contains too many rows for the bounded Codex audit.",
    );

  const documentsByRef = new Map<string, BaseDocument>();
  const duplicateDocumentRefs = new Set<string>();
  const journals: JournalDocument[] = [];
  const documentTypesByCollection: Record<string, string> = {
    journals: "journal",
    actors: "actor",
    items: "item",
    scenes: "scene",
    rollTables: "rollTable",
  };
  let malformedDocumentIndex = false;
  const add = (ref: DocRef, doc: unknown): void => {
    if (isCodexDocRef(ref) && isRecord(doc) && typeof doc.type === "string") {
      const key = codexRefKey(ref);
      if (documentsByRef.has(key)) duplicateDocumentRefs.add(key);
      documentsByRef.set(key, doc as unknown as BaseDocument);
    }
  };

  for (const rawRow of documentsValue.docs) {
    if (
      !isRecord(rawRow) ||
      typeof rawRow.coll !== "string" ||
      typeof rawRow.id !== "string" ||
      !isRecord(rawRow.doc) ||
      typeof rawRow.doc.type !== "string"
    ) {
      malformedDocumentIndex = true;
      continue;
    }
    const row = rawRow as unknown as WorldArchiveDocumentRow;
    const doc = rawRow.doc;
    if (doc._id !== row.id) malformedDocumentIndex = true;
    const expectedType = documentTypesByCollection[row.coll];
    if (expectedType !== undefined && doc.type !== expectedType)
      malformedDocumentIndex = true;
    add({ coll: row.coll, id: row.id } as DocRef, row.doc);
    if (
      row.coll === "journals" &&
      isRecord(row.doc) &&
      row.doc.type === "journal"
    ) {
      const journal = row.doc as unknown as JournalDocument;
      journals.push(journal);
      for (const page of Array.isArray(journal.pages) ? journal.pages : []) {
        if (isRecord(page) && typeof page._id === "string")
          add(
            {
              coll: "pages",
              id: page._id,
              parent: { coll: "journals", id: row.id },
            },
            page,
          );
      }
    }
    if (
      row.coll === "actors" &&
      isRecord(row.doc) &&
      row.doc.type === "actor"
    ) {
      const actor = row.doc as unknown as { items?: unknown };
      for (const item of Array.isArray(actor.items) ? actor.items : []) {
        if (isRecord(item) && typeof item._id === "string")
          add(
            {
              coll: "items",
              id: item._id,
              parent: { coll: "actors", id: row.id },
            },
            item,
          );
      }
    }
  }

  if (malformedDocumentIndex)
    return codexArchiveAuditUnavailable(
      "The document index contains malformed or inconsistent document rows.",
    );
  if (duplicateDocumentRefs.size > 0)
    return codexArchiveAuditUnavailable(
      "The document index contains duplicate Codex target identities.",
    );

  const assetIds = new Set<string>();
  for (const entry of assetsValue) {
    if (!isRecord(entry) || !isAssetHash(entry.hash))
      return codexArchiveAuditUnavailable(
        "The asset index contains malformed asset records.",
      );
    if (assetIds.has(entry.hash))
      return codexArchiveAuditUnavailable(
        "The asset index contains duplicate asset identities.",
      );
    assetIds.add(entry.hash);
  }

  const audit: CodexArchiveDependencyAudit = {
    status: "complete",
    codexSheets: 0,
    referencesChecked: 0,
    uninspectedSheetCount: 0,
    uninspectedWidgetCount: 0,
    missingCount: 0,
    incompatibleCount: 0,
    invalidCount: 0,
    issues: [],
    omittedIssueCount: 0,
  };
  const addIssue = (
    journal: JournalDocument,
    kind: CodexArchiveDependencyKind,
    ownerId: string,
    target: string,
    problem: CodexArchiveDependencyIssue["problem"],
  ): void => {
    if (problem === "missing") audit.missingCount += 1;
    else if (problem === "incompatible") audit.incompatibleCount += 1;
    else audit.invalidCount += 1;
    const issue: CodexArchiveDependencyIssue = {
      sourceId:
        typeof journal._id === "string" ? journal._id : "unknown journal",
      sourceName:
        typeof journal.name === "string" ? journal.name : "Unnamed journal",
      kind,
      ownerId,
      target,
      problem,
    };
    if (audit.issues.length < MAX_AUDIT_DETAILS) audit.issues.push(issue);
    else audit.omittedIssueCount += 1;
  };
  const resolve = (ref: unknown): BaseDocument | undefined => {
    if (!isCodexDocRef(ref)) return undefined;
    return documentsByRef.get(codexRefKey(ref));
  };
  const assetExists = (assetId: string): boolean =>
    assetIds.has(assetId) && assetBlobIds.has(assetId);
  const checkReference = (): void => {
    if (audit.referencesChecked >= MAX_AUDIT_REFERENCES)
      throw AUDIT_REFERENCE_LIMIT;
    audit.referencesChecked += 1;
  };

  try {
    for (const journal of journals) {
      const sheet = journal.codex;
      if (sheet === undefined) continue;
      audit.codexSheets += 1;
      if (!isRecord(sheet) || sheet.version !== 1) {
        audit.uninspectedSheetCount += 1;
        continue;
      }
      if (
        !Array.isArray(sheet.links) ||
        !Array.isArray(sheet.widgets) ||
        (sheet.quests !== undefined && !Array.isArray(sheet.quests)) ||
        (sheet.shop !== undefined &&
          (!isRecord(sheet.shop) || !Array.isArray(sheet.shop.stock)))
      )
        audit.uninspectedSheetCount += 1;
      for (const rawLink of Array.isArray(sheet.links) ? sheet.links : []) {
        if (!isRecord(rawLink)) {
          checkReference();
          addIssue(
            journal,
            "relationship",
            "unknown link",
            "malformed relationship",
            "invalid",
          );
          continue;
        }
        const link = rawLink as unknown as CodexLink;
        checkReference();
        const ref = link.target as unknown;
        const refLabel = isCodexDocRef(ref)
          ? `${ref.coll}:${ref.id}`
          : "malformed DocRef";
        const target = resolve(ref);
        if (!isCodexDocRef(ref)) {
          addIssue(
            journal,
            "relationship",
            String(link.id ?? "unknown link"),
            refLabel,
            "invalid",
          );
        } else if (!target) {
          addIssue(
            journal,
            "relationship",
            String(link.id ?? "unknown link"),
            refLabel,
            "missing",
          );
        } else {
          const typeError = codexLinkTargetError(link, target);
          if (typeError)
            addIssue(
              journal,
              "relationship",
              String(link.id ?? "unknown link"),
              refLabel,
              "incompatible",
            );
        }
      }

      if (sheet.shop && isRecord(sheet.shop)) {
        const stock = Array.isArray(sheet.shop.stock) ? sheet.shop.stock : [];
        for (const rawRow of stock) {
          if (!isRecord(rawRow)) {
            checkReference();
            addIssue(
              journal,
              "shop stock",
              "unknown row",
              "malformed stock row",
              "invalid",
            );
            continue;
          }
          checkReference();
          const ref = rawRow.item as unknown;
          const refLabel = isCodexDocRef(ref)
            ? `${ref.coll}:${ref.id}`
            : "malformed DocRef";
          const target = resolve(ref);
          if (!isCodexDocRef(ref))
            addIssue(
              journal,
              "shop stock",
              String(rawRow.id ?? "unknown row"),
              refLabel,
              "invalid",
            );
          else if (!target)
            addIssue(
              journal,
              "shop stock",
              String(rawRow.id ?? "unknown row"),
              refLabel,
              "missing",
            );
          else if (target.type !== "item")
            addIssue(
              journal,
              "shop stock",
              String(rawRow.id ?? "unknown row"),
              refLabel,
              "incompatible",
            );
        }
      }

      const links = Array.isArray(sheet.links)
        ? sheet.links.filter(isRecord)
        : [];
      const quests = Array.isArray(sheet.quests)
        ? sheet.quests.filter(isRecord)
        : [];
      for (const rawWidget of Array.isArray(sheet.widgets)
        ? sheet.widgets
        : []) {
        if (!isRecord(rawWidget)) {
          audit.uninspectedWidgetCount += 1;
          continue;
        }
        const widget = rawWidget as unknown as CodexWidgetInstance;
        const ownerId =
          typeof widget.id === "string" ? widget.id : "unknown widget";
        const config = widget.config;
        if (
          !knownWidgetTypes.has(widget.type) ||
          widget.version !== 1 ||
          !isRecord(config)
        ) {
          audit.uninspectedWidgetCount += 1;
          continue;
        }

        for (const ref of codexWidgetDocumentRefs(widget)) {
          checkReference();
          const target = resolve(ref);
          const label = `${ref.coll}:${ref.id}`;
          if (!target)
            addIssue(journal, "widget document", ownerId, label, "missing");
          else if (target.type !== "rollTable")
            addIssue(
              journal,
              "widget document",
              ownerId,
              label,
              "incompatible",
            );
        }
        if (
          widget.type === "roll-table" &&
          Object.hasOwn(config, "tableId") &&
          config.tableId !== ""
        ) {
          if (!isStableId(config.tableId)) {
            checkReference();
            addIssue(
              journal,
              "widget document",
              ownerId,
              `rollTables:${String(config.tableId)}`,
              "invalid",
            );
          }
        }

        for (const assetId of codexWidgetAssetIds(widget)) {
          checkReference();
          if (!assetExists(assetId))
            addIssue(
              journal,
              "widget asset",
              ownerId,
              `assets:${assetId}`,
              "missing",
            );
        }
        if (
          widget.type === "image-gallery" &&
          Object.hasOwn(config, "images")
        ) {
          if (!Array.isArray(config.images)) {
            audit.uninspectedWidgetCount += 1;
          } else {
            for (const image of config.images) {
              if (!isRecord(image) || !isAssetHash(image.assetId)) {
                checkReference();
                const assetId = isRecord(image) ? image.assetId : undefined;
                addIssue(
                  journal,
                  "widget asset",
                  ownerId,
                  `assets:${String(assetId ?? "malformed")}`,
                  "invalid",
                );
              }
            }
          }
        }

        if (
          widget.type === "linked-entities" &&
          Object.hasOwn(config, "linkIds")
        ) {
          if (!Array.isArray(config.linkIds)) {
            audit.uninspectedWidgetCount += 1;
          } else {
            for (const id of config.linkIds) {
              checkReference();
              if (!isStableId(id))
                addIssue(
                  journal,
                  "widget link",
                  ownerId,
                  `link:${String(id)}`,
                  "invalid",
                );
              else if (!links.some((link) => link.id === id))
                addIssue(
                  journal,
                  "widget link",
                  ownerId,
                  `link:${id}`,
                  "missing",
                );
            }
          }
        } else if (
          widget.type === "scene-map" &&
          Object.hasOwn(config, "linkId") &&
          config.linkId !== ""
        ) {
          checkReference();
          if (!isStableId(config.linkId)) {
            addIssue(
              journal,
              "widget link",
              ownerId,
              `scene-link:${String(config.linkId)}`,
              "invalid",
            );
          } else {
            const sceneLink = links.find((link) => link.id === config.linkId);
            if (!sceneLink)
              addIssue(
                journal,
                "widget link",
                ownerId,
                `scene-link:${config.linkId}`,
                "missing",
              );
            else if (sceneLink.relation !== "linksScene")
              addIssue(
                journal,
                "widget link",
                ownerId,
                `scene-link:${config.linkId}`,
                "incompatible",
              );
          }
        }
        if (widget.type === "quest-list" && Object.hasOwn(config, "questIds")) {
          if (!Array.isArray(config.questIds)) {
            audit.uninspectedWidgetCount += 1;
          } else {
            for (const id of config.questIds) {
              checkReference();
              if (!isStableId(id))
                addIssue(
                  journal,
                  "widget quest",
                  ownerId,
                  `quest:${String(id)}`,
                  "invalid",
                );
              else if (!quests.some((quest) => quest.id === id))
                addIssue(
                  journal,
                  "widget quest",
                  ownerId,
                  `quest:${id}`,
                  "missing",
                );
            }
          }
        }
      }

      if (sheet.cover !== undefined) {
        checkReference();
        if (!isAssetHash(sheet.cover))
          addIssue(
            journal,
            "Codex cover",
            typeof journal._id === "string" ? journal._id : "unknown journal",
            `assets:${String(sheet.cover)}`,
            "invalid",
          );
        else if (!assetExists(sheet.cover))
          addIssue(
            journal,
            "Codex cover",
            typeof journal._id === "string" ? journal._id : "unknown journal",
            `assets:${sheet.cover}`,
            "missing",
          );
      }
    }
  } catch (error) {
    if (error === AUDIT_REFERENCE_LIMIT)
      return codexArchiveAuditUnavailable(
        "The archive contains too many Codex references for the bounded audit.",
      );
    throw error;
  }

  return audit;
}
