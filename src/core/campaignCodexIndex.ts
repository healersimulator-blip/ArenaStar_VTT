/**
 * Disposable navigation/search index for the viewer-projected Codex sheets.
 * This index contains no authority: host projections stay authoritative and
 * callers must only pass sheets/targets the current viewer may read.
 */
import type {
  BaseDocument,
  CodexLink,
  CodexRelation,
  CodexSheetKind,
  CodexShopStockRow,
  DocRef,
  JournalDocument,
} from "./documents";
import { codexRefKey, isCodexDocRef } from "./campaignCodex";

export interface CodexIndexedLink {
  source: JournalDocument;
  link: CodexLink;
}

export interface CodexIndex {
  sheets: readonly JournalDocument[];
  sheetsById: ReadonlyMap<string, JournalDocument>;
  incomingByRef: ReadonlyMap<string, readonly CodexIndexedLink[]>;
  childrenByParentId: ReadonlyMap<string, readonly JournalDocument[]>;
  parentIdsByChildId: ReadonlyMap<string, readonly string[]>;
  codexTagNamesBySheetId: ReadonlyMap<string, readonly string[]>;
  codexTagIdsBySheetId: ReadonlyMap<string, readonly string[]>;
  relationsBySheetId: ReadonlyMap<string, ReadonlySet<CodexRelation>>;
  searchTextBySheetId: ReadonlyMap<string, string>;
}

export interface CodexSearchFilters {
  query?: string;
  kind?: CodexSheetKind | "all";
  codexTagId?: string | "all";
  taggerTag?: string | "all";
  relation?: CodexRelation | "all";
}

/** Replace one stable-ID relationship without altering its sibling records. */
function copyDocRef(ref: DocRef): DocRef {
  return {
    coll: ref.coll,
    id: ref.id,
    ...(ref.parent ? { parent: copyDocRef(ref.parent) } : {}),
  };
}

export function replaceCodexLinkTarget(
  links: readonly CodexLink[],
  linkId: string,
  target: DocRef,
): CodexLink[] | null {
  if (!isCodexDocRef(target)) return null;
  let found = false;
  const next = links.map((link) => {
    if (link.id !== linkId) return link;
    found = true;
    return { ...link, target: copyDocRef(target) };
  });
  return found ? next : null;
}

/** Replace one shop stock item's stable reference without altering sibling rows. */
export function replaceCodexStockTarget(
  stock: readonly CodexShopStockRow[],
  rowId: string,
  target: DocRef,
): CodexShopStockRow[] | null {
  if (!isCodexDocRef(target)) return null;
  let found = false;
  const next = stock.map((row) => {
    if (row.id !== rowId) return row;
    found = true;
    return { ...row, item: copyDocRef(target) };
  });
  return found ? next : null;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function textMatchesQuery(indexedText: string, query: string): boolean {
  const terms = normalizeSearchText(query)
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);
  return terms.every((term) => indexedText.includes(term));
}

function addToMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** Build a fresh disposable index after store commits or viewer changes. */
export function buildCodexIndex(
  sheets: readonly JournalDocument[],
  resolve: (ref: DocRef) => BaseDocument | undefined,
): CodexIndex {
  const sheetsById = new Map(sheets.map((sheet) => [sheet._id, sheet]));
  const incomingByRef = new Map<string, CodexIndexedLink[]>();
  const childrenByParentId = new Map<string, JournalDocument[]>();
  const parentIdsByChildId = new Map<string, string[]>();
  const codexTagNamesBySheetId = new Map<string, string[]>();
  const codexTagIdsBySheetId = new Map<string, string[]>();
  const relationsBySheetId = new Map<string, Set<CodexRelation>>();

  for (const source of sheets) {
    const relations = new Set<CodexRelation>();
    for (const link of source.codex?.links ?? []) {
      relations.add(link.relation);
      try {
        addToMapList(incomingByRef, codexRefKey(link.target), { source, link });
      } catch {
        // Malformed imported references remain inert and can be repaired by a GM.
        continue;
      }
      if (
        link.relation === "contains" &&
        link.target.coll === "journals" &&
        link.target.parent === undefined
      ) {
        const child = sheetsById.get(link.target.id);
        if (child) {
          addToMapList(childrenByParentId, source._id, child);
          const parents = parentIdsByChildId.get(child._id) ?? [];
          if (!parents.includes(source._id)) parents.push(source._id);
          parentIdsByChildId.set(child._id, parents);
        }
      }
    }
    relationsBySheetId.set(source._id, relations);
  }

  for (const tagSheet of sheets.filter((sheet) => sheet.codex?.kind === "tag")) {
    for (const link of tagSheet.codex?.links ?? []) {
      if (
        (link.relation !== "relatedTo" && link.relation !== "associatedWith") ||
        link.target.coll !== "journals" ||
        link.target.parent !== undefined
      ) continue;
      const names = codexTagNamesBySheetId.get(link.target.id) ?? [];
      if (!names.includes(tagSheet.name)) names.push(tagSheet.name);
      codexTagNamesBySheetId.set(link.target.id, names);
      const ids = codexTagIdsBySheetId.get(link.target.id) ?? [];
      if (!ids.includes(tagSheet._id)) ids.push(tagSheet._id);
      codexTagIdsBySheetId.set(link.target.id, ids);
    }
  }

  for (const [parentId, children] of childrenByParentId) {
    childrenByParentId.set(
      parentId,
      children.sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id)),
    );
  }
  for (const [childId, parents] of parentIdsByChildId) {
    parentIdsByChildId.set(
      childId,
      parents.sort((a, b) =>
        (sheetsById.get(a)?.name ?? "").localeCompare(sheetsById.get(b)?.name ?? "") || a.localeCompare(b),
      ),
    );
  }
  for (const [sheetId, names] of codexTagNamesBySheetId)
    codexTagNamesBySheetId.set(sheetId, names.sort((a, b) => a.localeCompare(b)));
  for (const [sheetId, ids] of codexTagIdsBySheetId)
    codexTagIdsBySheetId.set(sheetId, ids.sort((a, b) => a.localeCompare(b)));

  const searchTextBySheetId = new Map<string, string>();
  for (const sheet of sheets) {
    const pageText = (sheet.pages ?? []).flatMap((page) => [
      page.name,
      page.codex?.label ?? "",
      page.text,
    ]);
    const linkText = (sheet.codex?.links ?? []).flatMap((link) => {
      let targetName = "";
      try {
        targetName = resolve(link.target)?.name ?? "";
      } catch {
        // A stale or malformed target contributes no searchable target data.
      }
      return [link.relation, link.label ?? "", targetName];
    });
    const allText = [
      sheet.name,
      sheet.codex?.subtitle ?? "",
      ...pageText,
      ...linkText,
      ...(sheet.taggerTags ?? []),
      ...(codexTagNamesBySheetId.get(sheet._id) ?? []),
    ].join(" ");
    searchTextBySheetId.set(sheet._id, normalizeSearchText(allText));
  }

  return {
    sheets,
    sheetsById,
    incomingByRef,
    childrenByParentId,
    parentIdsByChildId,
    codexTagNamesBySheetId,
    codexTagIdsBySheetId,
    relationsBySheetId,
    searchTextBySheetId,
  };
}

/** Match only the viewer-projected sheets from which the index was built. */
export function searchCodexIndex(
  index: CodexIndex,
  filters: CodexSearchFilters = {},
): JournalDocument[] {
  const query = filters.query?.trim() ?? "";
  return index.sheets.filter((sheet) => {
    if (filters.kind && filters.kind !== "all" && sheet.codex?.kind !== filters.kind) return false;
    if (filters.codexTagId && filters.codexTagId !== "all" &&
      !index.codexTagIdsBySheetId.get(sheet._id)?.includes(filters.codexTagId)) return false;
    if (filters.taggerTag && filters.taggerTag !== "all" &&
      !(sheet.taggerTags ?? []).includes(filters.taggerTag)) return false;
    if (filters.relation && filters.relation !== "all" &&
      !index.relationsBySheetId.get(sheet._id)?.has(filters.relation)) return false;
    if (query && !textMatchesQuery(index.searchTextBySheetId.get(sheet._id) ?? "", query)) return false;
    return true;
  });
}

/** Resolve a viewer-safe parent chain with cycle and depth protection. */
export function codexParentChain(index: CodexIndex, childId: string, maxDepth = 10): JournalDocument[] {
  const result: JournalDocument[] = [];
  const seen = new Set([childId]);
  let currentId = childId;
  while (result.length < maxDepth) {
    const parentId = index.parentIdsByChildId.get(currentId)?.[0];
    if (!parentId || seen.has(parentId)) break;
    const parent = index.sheetsById.get(parentId);
    if (!parent) break;
    seen.add(parentId);
    result.unshift(parent);
    currentId = parentId;
  }
  return result;
}
