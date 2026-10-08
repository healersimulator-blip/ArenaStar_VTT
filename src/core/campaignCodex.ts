/**
 * ArenaStar Campaign Codex schema, validation, graph rules, and viewer projection.
 * Codex metadata is typed document data; this module never executes widget config.
 */
import {
  OWNERSHIP_LEVELS,
  TOP_LEVEL_COLLECTIONS,
  type ActorDocument,
  type BaseDocument,
  type CodexAudience,
  type CodexLink,
  type CodexObjective,
  type CodexQuest,
  type CodexSheet,
  type CodexTabConfig,
  type CodexShopConfig,
  type CodexShopStockRow,
  type CodexWidgetInstance,
  type CollectionName,
  type DocRef,
  type JournalDocument,
  type JournalPageDocument,
  type WorldCollections,
} from "./documents";
import type { PermissionUser } from "./ownership";
import { getEffectiveOwnership } from "./permissions";
import {
  codexWidgetAssetIds,
  codexWidgetConfigError,
  codexWidgetDocumentRefs,
  projectCodexWidgetConfig,
} from "./campaignCodexWidgets";

export const CODEX_VERSION = 1;
export const CODEX_MAX_LINKS = 200;
export const CODEX_MAX_WIDGETS = 32;
export const CODEX_MAX_QUESTS = 128;
export const CODEX_MAX_STOCK_ROWS = 200;
export const CODEX_MAX_CONTAINMENT_DEPTH = 10;
const CODEX_MAX_OBJECTIVE_DEPTH = 5;
const CODEX_MAX_PAGES = 256;
const CODEX_MAX_JSON_BYTES = 16_384;

export interface CodexResolver {
  resolve(ref: DocRef): BaseDocument | undefined;
  /** Asset access follows the existing live manifest/document-reference entitlement policy. */
  canReadAsset?(assetId: string): boolean;
}

const KINDS = new Set(["group", "region", "location", "entry", "npc", "tag"]);
const RELATIONS = new Set([
  "contains",
  "locatedAt",
  "associatedWith",
  "operatedBy",
  "representsActor",
  "linksScene",
  "linksItem",
  "relatedTo",
]);
const TOP_LEVEL_LINK_COLLECTIONS = new Set([
  "journals",
  "actors",
  "items",
  "scenes",
  "rollTables",
]);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const tabPattern = /^[A-Za-z0-9_-]{1,64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  max: number,
  allowEmpty = true,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0)
  );
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function finiteOrder(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= 100_000;
}

function isGm(user: PermissionUser): boolean {
  return user.role === "GM" || user.role === "ASSISTANT";
}

function audienceError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!record(value) || typeof value.kind !== "string")
    return "Codex audience must be an object with a kind";
  if (value.kind === "inherit") return null;
  if (value.kind === "gmOnly") return null;
  if (
    value.kind !== "selectedUsers" ||
    !Array.isArray(value.userIds) ||
    value.userIds.length > 64 ||
    value.userIds.some((id) => !boundedString(id, 128, false)) ||
    new Set(value.userIds).size !== value.userIds.length
  ) {
    return "Codex selected-user audience is invalid";
  }
  return null;
}

function docRefError(value: unknown, depth = 0): string | null {
  if (!record(value) || typeof value.coll !== "string" || !stableId(value.id)) {
    return "Codex document reference is malformed";
  }
  if (depth > 2) return "Codex document reference parent chain is too deep";
  if (value.parent !== undefined) {
    const parentError = docRefError(value.parent, depth + 1);
    if (parentError) return parentError;
    const parent = value.parent as DocRef;
    if (
      value.coll === "pages" &&
      parent.coll === "journals" &&
      parent.parent === undefined
    )
      return null;
    if (
      value.coll === "items" &&
      parent.coll === "actors" &&
      parent.parent === undefined
    )
      return null;
    return "Codex references may only target journal pages or actor items as embedded documents";
  }
  return TOP_LEVEL_LINK_COLLECTIONS.has(value.coll)
    ? null
    : "Codex reference collection is not linkable";
}

export function isCodexDocRef(value: unknown): value is DocRef {
  return docRefError(value) === null;
}

export function codexRefKey(ref: DocRef): string {
  return `${ref.parent ? `${codexRefKey(ref.parent)}/` : ""}${ref.coll}:${encodeURIComponent(ref.id)}`;
}

export function codexRefRootKey(ref: DocRef): string {
  let root = ref;
  while (root.parent) root = root.parent;
  return `${root.coll}:${encodeURIComponent(root.id)}`;
}

export function sameCodexRef(a: DocRef, b: DocRef): boolean {
  if (docRefError(a) || docRefError(b)) return false;
  return codexRefKey(a) === codexRefKey(b);
}

/** Resolve the intentionally small DocRef subset that Codex accepts. */
export function resolveCodexWorldRef(
  world: Readonly<WorldCollections>,
  ref: DocRef,
): BaseDocument | undefined {
  if (docRefError(ref)) return undefined;
  if (!ref.parent) {
    if (!TOP_LEVEL_COLLECTIONS.includes(ref.coll as CollectionName))
      return undefined;
    const docs = (world as unknown as Record<string, BaseDocument[]>)[ref.coll];
    return Array.isArray(docs)
      ? docs.find((doc) => doc._id === ref.id)
      : undefined;
  }
  const parent = resolveCodexWorldRef(world, ref.parent);
  if (!parent) return undefined;
  if (ref.coll === "pages" && parent.type === "journal") {
    return (parent as JournalDocument).pages.find(
      (page) => page._id === ref.id,
    );
  }
  if (ref.coll === "items" && parent.type === "actor") {
    return (parent as ActorDocument).items.find((item) => item._id === ref.id);
  }
  return undefined;
}

export function codexAudienceAllows(
  audience: CodexAudience | undefined,
  user: PermissionUser,
): boolean {
  if (isGm(user) || audience === undefined) return true;
  if (!record(audience)) return false;
  if (audience.kind === "inherit") return true;
  if (audience.kind === "gmOnly") return false;
  return (
    audience.kind === "selectedUsers" &&
    Array.isArray(audience.userIds) &&
    audience.userIds.includes(user.id)
  );
}

export function codexPageVisible(
  page: JournalPageDocument,
  journal: JournalDocument,
  user: PermissionUser,
): boolean {
  const sheet = record(journal.codex) ? journal.codex : undefined;
  if (sheet && sheet.version !== CODEX_VERSION) return page.codex === undefined;
  if (page.codex !== undefined && !record(page.codex)) return false;
  const metadata = page.codex as JournalPageDocument["codex"];
  if (!codexAudienceAllows(metadata?.audience, user)) return false;
  const firstTabKey = Array.isArray(sheet?.tabs)
    ? [...sheet.tabs]
        .filter((tab) => record(tab) && finiteOrder(tab.order))
        .sort((a, b) => Number(a.order) - Number(b.order))[0]?.key
    : undefined;
  const tabKey = metadata?.tabKey ?? firstTabKey;
  if (tabKey === undefined) return true;
  if (typeof tabKey !== "string" || !Array.isArray(sheet?.tabs)) return false;
  const tab = sheet.tabs.find((entry) => record(entry) && entry.key === tabKey);
  return (
    !!tab &&
    codexAudienceAllows((tab as unknown as CodexTabConfig).audience, user)
  );
}

function relationTargetError(
  link: CodexLink,
  target: BaseDocument,
): string | null {
  const coll = link.target.coll;
  const expected: Record<string, string[]> = {
    contains: ["journals"],
    locatedAt: ["journals"],
    operatedBy: ["journals", "actors"],
    representsActor: ["actors"],
    linksScene: ["scenes"],
    linksItem: ["items"],
    associatedWith: ["journals", "actors", "items", "scenes", "pages"],
    relatedTo: ["journals", "actors", "items", "scenes", "pages"],
  };
  if (!(expected[link.relation] ?? []).includes(coll)) {
    return `Codex relation '${link.relation}' cannot target '${coll}'`;
  }
  if (
    (link.relation === "contains" || link.relation === "locatedAt") &&
    target.type !== "journal"
  ) {
    return `Codex relation '${link.relation}' requires a journal sheet`;
  }
  if (
    link.relation === "contains" &&
    (target as JournalDocument).codex === undefined
  ) {
    return "Codex containment can only target another Codex sheet";
  }
  if (link.relation === "representsActor" && target.type !== "actor")
    return "Codex actor link requires an actor";
  if (link.relation === "linksScene" && target.type !== "scene")
    return "Codex scene link requires a scene";
  if (link.relation === "linksItem" && target.type !== "item")
    return "Codex item link requires an item";
  if (coll === "pages" && target.type !== "page")
    return "Codex page link requires a journal page";
  return null;
}

function validateTab(value: unknown): string | null {
  if (
    !record(value) ||
    typeof value.key !== "string" ||
    !tabPattern.test(value.key) ||
    !boundedString(value.label, 80, false) ||
    !finiteOrder(value.order)
  )
    return "Codex tab is malformed";
  return audienceError(value.audience);
}

function validateLink(value: unknown): string | null {
  if (
    !record(value) ||
    !stableId(value.id) ||
    typeof value.relation !== "string" ||
    !RELATIONS.has(value.relation) ||
    !value.target
  )
    return "Codex relationship is malformed";
  const refError = docRefError(value.target);
  if (refError) return refError;
  if (value.label !== undefined && !boundedString(value.label, 160))
    return "Codex relationship label is too long";
  return audienceError(value.audience);
}

function validateObjective(
  value: unknown,
  ids: Set<string>,
  depth: number,
): string | null {
  if (depth > CODEX_MAX_OBJECTIVE_DEPTH)
    return "Codex objective nesting is too deep";
  if (
    !record(value) ||
    !stableId(value.id) ||
    ids.has(value.id) ||
    !boundedString(value.title, 200, false) ||
    typeof value.completed !== "boolean" ||
    !finiteOrder(value.order) ||
    !Array.isArray(value.children) ||
    value.children.length > 100
  ) {
    return "Codex objective is malformed or duplicated";
  }
  ids.add(value.id);
  if (
    value.description !== undefined &&
    !boundedString(value.description, 2_000)
  )
    return "Codex objective description is too long";
  const audience = audienceError(value.audience);
  if (audience) return audience;
  for (const child of value.children) {
    const error = validateObjective(child, ids, depth + 1);
    if (error) return error;
  }
  return null;
}

function validateQuest(value: unknown, ids: Set<string>): string | null {
  if (
    !record(value) ||
    !stableId(value.id) ||
    ids.has(value.id) ||
    !boundedString(value.title, 200, false) ||
    !boundedString(value.description, 10_000) ||
    !["active", "completed", "failed"].includes(String(value.state)) ||
    typeof value.pinned !== "boolean" ||
    !finiteOrder(value.order) ||
    !Array.isArray(value.objectives) ||
    value.objectives.length > 200
  ) {
    return "Codex quest is malformed or duplicated";
  }
  ids.add(value.id);
  const audience = audienceError(value.audience);
  if (audience) return audience;
  const objectiveIds = new Set<string>();
  for (const objective of value.objectives) {
    const error = validateObjective(objective, objectiveIds, 1);
    if (error) return error;
  }
  return null;
}

function validateWidget(value: unknown, ids: Set<string>): string | null {
  if (
    !record(value) ||
    !stableId(value.id) ||
    ids.has(value.id) ||
    !boundedString(value.type, 96, false) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.tab !== "string" ||
    !tabPattern.test(value.tab) ||
    !finiteOrder(value.order) ||
    typeof value.enabled !== "boolean" ||
    value.config === undefined
  )
    return "Codex widget config is malformed or duplicated";
  ids.add(value.id);
  const audience = audienceError(value.audience);
  if (audience) return audience;
  try {
    if (JSON.stringify(value.config).length > CODEX_MAX_JSON_BYTES)
      return "Codex widget config is too large";
  } catch {
    return "Codex widget config is not JSON data";
  }
  return codexWidgetConfigError(value.type, value.version as number, value.config);
}

function validateShop(value: unknown): string | null {
  if (
    !record(value) ||
    !["shop", "loot"].includes(String(value.mode)) ||
    !Array.isArray(value.stock) ||
    value.stock.length > CODEX_MAX_STOCK_ROWS
  )
    return "Codex shop is malformed";
  const audience = audienceError(value.audience);
  if (audience) return audience;
  if (
    value.markup !== undefined &&
    (typeof value.markup !== "number" ||
      !Number.isFinite(value.markup) ||
      value.markup < 0 ||
      value.markup > 1_000)
  ) {
    return "Codex shop markup is invalid";
  }
  if (
    value.currencyLabel !== undefined &&
    !boundedString(value.currencyLabel, 32)
  )
    return "Codex shop currency label is too long";
  const ids = new Set<string>();
  for (const row of value.stock) {
    if (
      !record(row) ||
      !stableId(row.id) ||
      ids.has(row.id) ||
      !row.item ||
      (row.quantity !== null &&
        (!Number.isSafeInteger(row.quantity) ||
          (row.quantity as number) < 0 ||
          (row.quantity as number) > 1_000_000_000)) ||
      !finiteOrder(row.order) ||
      (row.unitPrice !== undefined && !boundedString(row.unitPrice, 100))
    ) {
      return "Codex shop stock row is malformed or duplicated";
    }
    ids.add(row.id);
    const refError = docRefError(row.item);
    if (refError) return refError;
  }
  return null;
}

export function codexSheetError(value: unknown): string | null {
  if (
    !record(value) ||
    value.version !== CODEX_VERSION ||
    typeof value.kind !== "string" ||
    !KINDS.has(value.kind) ||
    !Array.isArray(value.links) ||
    value.links.length > CODEX_MAX_LINKS ||
    !Array.isArray(value.widgets) ||
    value.widgets.length > CODEX_MAX_WIDGETS
  ) {
    return `Codex sheet must use supported version ${CODEX_VERSION}`;
  }
  if (value.subtitle !== undefined && !boundedString(value.subtitle, 400))
    return "Codex subtitle is too long";
  if (
    value.cover !== undefined &&
    (typeof value.cover !== "string" || !/^[a-f0-9]{64}$/i.test(value.cover))
  ) {
    return "Codex cover must reference a content-addressed local asset";
  }
  if (
    value.tabs !== undefined &&
    (!Array.isArray(value.tabs) || value.tabs.length > 32)
  )
    return "Codex tabs are invalid";
  const tabIds = new Set<string>();
  for (const tab of (value.tabs ?? []) as unknown[]) {
    const error = validateTab(tab);
    if (error) return error;
    const key = (tab as { key: string }).key;
    if (tabIds.has(key)) return "Codex tab keys must be unique";
    tabIds.add(key);
  }
  const linkIds = new Set<string>();
  const edges = new Set<string>();
  for (const link of value.links as unknown[]) {
    const error = validateLink(link);
    if (error) return error;
    const typed = link as CodexLink;
    if (linkIds.has(typed.id)) return "Codex relationship IDs must be unique";
    linkIds.add(typed.id);
    const edge = `${typed.relation}:${codexRefKey(typed.target)}`;
    if (edges.has(edge)) return "Codex relationship is duplicated";
    edges.add(edge);
  }
  const widgetIds = new Set<string>();
  for (const widget of value.widgets as unknown[]) {
    const error = validateWidget(widget, widgetIds);
    if (error) return error;
    if (
      Array.isArray(value.tabs) &&
      record(widget) &&
      !value.tabs.some((tab) => record(tab) && tab.key === widget.tab)
    ) {
      return "Codex widget references an unknown tab";
    }
  }
  if (
    value.quests !== undefined &&
    (!Array.isArray(value.quests) || value.quests.length > CODEX_MAX_QUESTS)
  ) {
    return "Codex quests are invalid";
  }
  const questIds = new Set<string>();
  for (const quest of (value.quests ?? []) as unknown[]) {
    const error = validateQuest(quest, questIds);
    if (error) return error;
  }
  if (value.shop !== undefined) {
    const error = validateShop(value.shop);
    if (error) return error;
  }
  return null;
}

export function codexPageMetadataError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!record(value)) return "Codex page metadata is malformed";
  if (
    value.tabKey !== undefined &&
    (typeof value.tabKey !== "string" || !tabPattern.test(value.tabKey))
  ) {
    return "Codex page tab key is invalid";
  }
  if (value.label !== undefined && !boundedString(value.label, 120, false))
    return "Codex page label is too long";
  if (value.order !== undefined && !finiteOrder(value.order))
    return "Codex page order is invalid";
  return audienceError(value.audience);
}

export function codexJournalError(journal: JournalDocument): string | null {
  if (
    journal.type !== "journal" ||
    !Array.isArray(journal.pages) ||
    journal.pages.length > CODEX_MAX_PAGES
  ) {
    return "Codex journal page list is invalid";
  }
  if (journal.codex !== undefined) {
    const error = codexSheetError(journal.codex);
    if (error) return error;
  }
  for (const rawPage of journal.pages as unknown[]) {
    if (
      !record(rawPage) ||
      rawPage.type !== "page" ||
      typeof rawPage._id !== "string" ||
      rawPage._id.length === 0
    )
      return "Codex journal contains an invalid page document";
    const pageCodex = rawPage.codex;
    const error = codexPageMetadataError(pageCodex);
    if (error) return error;
    if (pageCodex !== undefined && !journal.codex)
      return "Codex page metadata requires a Codex sheet";
    const tabs = journal.codex?.tabs;
    if (
      record(pageCodex) &&
      pageCodex.tabKey !== undefined &&
      (!Array.isArray(tabs) ||
        !tabs.some((tab) => tab.key === pageCodex.tabKey))
    ) {
      return `Codex page references unknown tab '${String(pageCodex.tabKey)}'`;
    }
  }
  return null;
}

/** Archive validation keeps unknown future versions opaque but bounded and inert. */
export function codexArchiveJournalError(
  journal: JournalDocument,
): string | null {
  if (!journal || journal.type !== "journal" || !Array.isArray(journal.pages))
    return null;
  const sheet = journal.codex as unknown;
  if (sheet === undefined) {
    return journal.pages.some((page) => page?.codex !== undefined)
      ? "Codex page metadata cannot exist without a sheet"
      : null;
  }
  if (
    !record(sheet) ||
    !Number.isSafeInteger(sheet.version) ||
    (sheet.version as number) < 1
  ) {
    return "Codex archive metadata version is invalid";
  }
  if (sheet.version === CODEX_VERSION) return codexJournalError(journal);
  try {
    if (
      JSON.stringify({
        codex: sheet,
        pages: journal.pages.map((page) => page?.codex),
      }).length > 1_048_576
    ) {
      return "Unsupported Codex archive metadata is too large";
    }
  } catch {
    return "Unsupported Codex archive metadata is not JSON data";
  }
  return null;
}

export function hasCodexMetadata(
  value: BaseDocument | undefined,
): value is JournalDocument {
  if (value?.type !== "journal") return false;
  const journal = value as JournalDocument;
  return (
    journal.codex !== undefined ||
    (Array.isArray(journal.pages) &&
      journal.pages.some((page) => page?.codex !== undefined))
  );
}

export function isCodexJournal(
  value: BaseDocument | undefined,
): value is JournalDocument & { codex: CodexSheet } {
  return value?.type === "journal" && record((value as JournalDocument).codex);
}

export function codexLinkTargetError(link: CodexLink, target: BaseDocument): string | null {
  return relationTargetError(link, target);
}

function targetTypeError(link: CodexLink, target: BaseDocument): string | null {
  return codexLinkTargetError(link, target);
}

/** Validate only new/changed refs so an imported dangling ref can be repaired or left inert. */
export function codexReferenceError(
  candidate: JournalDocument,
  previous: JournalDocument | undefined,
  resolve: (ref: DocRef) => BaseDocument | undefined,
  assetExists?: (assetId: string) => boolean,
): string | null {
  const sheet = candidate.codex;
  if (!sheet) return null;
  if (
    sheet.cover !== undefined &&
    sheet.cover !== previous?.codex?.cover &&
    assetExists &&
    !assetExists(sheet.cover)
  ) {
    return `Codex cover asset '${sheet.cover}' does not exist`;
  }
  const oldLinks = new Map(
    (Array.isArray(previous?.codex?.links)
      ? (previous.codex.links.filter((link) => record(link)) as CodexLink[])
      : []
    ).map((link) => [link.id, link]),
  );
  for (const link of sheet.links) {
    const old = oldLinks.get(link.id);
    if (
      old &&
      old.relation === link.relation &&
      sameCodexRef(old.target, link.target)
    )
      continue;
    const target = resolve(link.target);
    if (!target)
      return `Codex relationship target '${link.target.id}' does not exist`;
    const error = targetTypeError(link, target);
    if (error) return error;
  }
  const priorStock = previous?.codex?.shop?.stock;
  const oldStock = new Map(
    (Array.isArray(priorStock)
      ? (priorStock.filter((row) => record(row)) as CodexShopStockRow[])
      : []
    ).map((row) => [row.id, row]),
  );
  for (const row of sheet.shop?.stock ?? []) {
    const old = oldStock.get(row.id);
    if (old && sameCodexRef(old.item, row.item)) continue;
    const target = resolve(row.item);
    if (!target || target.type !== "item")
      return `Codex shop item '${row.item.id}' does not exist`;
  }
  const oldWidgets = new Map(
    (Array.isArray(previous?.codex?.widgets) ? previous.codex.widgets : [])
      .filter((widget) => record(widget))
      .map((widget) => [widget.id, widget as CodexWidgetInstance]),
  );
  for (const widget of sheet.widgets ?? []) {
    const old = oldWidgets.get(widget.id);
    for (const ref of codexWidgetDocumentRefs(widget)) {
      if (old && codexWidgetDocumentRefs(old).some((prior) => sameCodexRef(prior, ref))) continue;
      const target = resolve(ref);
      if (!target || target.type !== "rollTable")
        return `Codex widget roll table '${ref.id}' does not exist`;
    }
    if (assetExists) {
      const oldAssets = new Set(old ? codexWidgetAssetIds(old) : []);
      for (const assetId of codexWidgetAssetIds(widget)) {
        if (!oldAssets.has(assetId) && !assetExists(assetId))
          return `Codex widget asset '${assetId}' does not exist`;
      }
    }
  }
  return null;
}

function containmentGraphError(
  candidate: JournalDocument,
  journals: readonly JournalDocument[],
): string | null {
  if (!candidate.codex) return null;
  const byId = new Map(
    journals
      .filter(
        (journal) =>
          journal?.type === "journal" &&
          record(journal.codex) &&
          journal.codex.version === CODEX_VERSION &&
          Array.isArray(journal.codex.links),
      )
      .map((journal) => [journal._id, journal]),
  );
  byId.set(candidate._id, candidate);
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const [sourceId, journal] of byId) {
    const links = Array.isArray(journal.codex?.links)
      ? journal.codex.links
      : [];
    for (const rawLink of links) {
      if (
        !record(rawLink) ||
        rawLink.relation !== "contains" ||
        !record(rawLink.target) ||
        rawLink.target.coll !== "journals" ||
        rawLink.target.parent !== undefined ||
        typeof rawLink.target.id !== "string"
      )
        continue;
      const childId = rawLink.target.id;
      if (!byId.has(childId)) continue;
      const list = children.get(sourceId) ?? [];
      list.push(childId);
      children.set(sourceId, list);
      const parentList = parents.get(childId) ?? [];
      parentList.push(sourceId);
      parents.set(childId, parentList);
    }
  }
  const ancestorDepth = (id: string, path: Set<string>): number | null => {
    if (path.has(id)) return null;
    const nextPath = new Set(path).add(id);
    let max = 0;
    for (const parent of parents.get(id) ?? []) {
      const depth = ancestorDepth(parent, nextPath);
      if (depth === null) return null;
      max = Math.max(max, depth + 1);
    }
    return max;
  };
  const ancestors = ancestorDepth(candidate._id, new Set());
  if (ancestors === null) return "Codex containment graph contains a cycle";
  const walk = (
    id: string,
    depth: number,
    path: Set<string>,
  ): string | null => {
    if (path.has(id)) return "Codex containment graph contains a cycle";
    if (depth > CODEX_MAX_CONTAINMENT_DEPTH)
      return `Codex containment depth exceeds ${CODEX_MAX_CONTAINMENT_DEPTH}`;
    const next = new Set(path).add(id);
    for (const child of children.get(id) ?? []) {
      const error = walk(child, depth + 1, next);
      if (error) return error;
    }
    return null;
  };
  return walk(candidate._id, ancestors + 1, new Set());
}

function selectedAudienceIds(journal: JournalDocument | undefined): Set<string> {
  const ids = new Set<string>();
  if (!journal) return ids;
  const take = (value: unknown): void => {
    if (!record(value) || value.kind !== "selectedUsers" || !Array.isArray(value.userIds)) return;
    for (const id of value.userIds) if (typeof id === "string") ids.add(id);
  };
  const objectives = (rows: unknown): void => {
    if (!Array.isArray(rows)) return;
    for (const objective of rows) {
      if (!record(objective)) continue;
      take(objective.audience);
      objectives(objective.children);
    }
  };
  const codex = record(journal.codex) ? journal.codex : undefined;
  for (const tab of codex?.tabs ?? []) if (record(tab)) take(tab.audience);
  for (const link of codex?.links ?? []) if (record(link)) take(link.audience);
  for (const widget of codex?.widgets ?? []) if (record(widget)) take(widget.audience);
  for (const quest of codex?.quests ?? []) {
    if (!record(quest)) continue;
    take(quest.audience);
    objectives(quest.objectives);
  }
  if (record(codex?.shop)) take(codex.shop.audience);
  for (const page of journal.pages ?? []) take(page?.codex?.audience);
  return ids;
}

export function codexDocumentError(
  candidate: JournalDocument,
  previous: JournalDocument | undefined,
  journals: readonly JournalDocument[],
  resolve: (ref: DocRef) => BaseDocument | undefined,
  assetExists?: (assetId: string) => boolean,
): string | null {
  const version = record(candidate.codex) ? candidate.codex.version : undefined;
  if (version !== undefined && version !== CODEX_VERSION) {
    const archiveError = codexArchiveJournalError(candidate);
    if (archiveError) return archiveError;
    const opaque = (journal: JournalDocument) =>
      JSON.stringify({
        codex: journal.codex,
        pages: Array.isArray(journal.pages)
          ? journal.pages.map((page) => [page?._id, page?.codex])
          : [],
      });
    if (previous && opaque(previous) !== opaque(candidate))
      return "Unsupported Codex metadata is read-only";
    return null; // Future schemas are retained, but never interpreted by this client.
  }
  const schema = codexJournalError(candidate);
  if (schema) return schema;
  const previousAudiences = selectedAudienceIds(previous);
  for (const userId of selectedAudienceIds(candidate)) {
    if (previousAudiences.has(userId)) continue;
    const target = resolve({ coll: "users", id: userId });
    if (!target || target.type !== "user")
      return "Codex audience references an unavailable player";
  }
  if (!candidate.codex) return null;
  return (
    codexReferenceError(candidate, previous, resolve, assetExists) ??
    containmentGraphError(candidate, journals)
  );
}

function projectedAudience<T extends { audience?: CodexAudience }>(
  value: T,
): Omit<T, "audience"> | T {
  if (!value.audience) return value;
  const safe = { ...value };
  delete safe.audience;
  return safe;
}

function projectObjectives(
  objectives: readonly CodexObjective[],
  user: PermissionUser,
): CodexObjective[] {
  if (!Array.isArray(objectives)) return [];
  return objectives
    .filter(
      (objective) =>
        record(objective) &&
        codexAudienceAllows(
          (objective as unknown as CodexObjective).audience,
          user,
        ),
    )
    .map(
      (objective) =>
        ({
          ...projectedAudience(objective),
          children: projectObjectives(
            Array.isArray(objective.children) ? objective.children : [],
            user,
          ),
        }) as CodexObjective,
    );
}

function projectQuest(quest: CodexQuest, user: PermissionUser): CodexQuest {
  return {
    ...projectedAudience(quest),
    objectives: projectObjectives(quest.objectives, user),
  } as CodexQuest;
}

function projectShop(
  shop: CodexShopConfig,
  user: PermissionUser,
  resolver: CodexResolver | undefined,
): CodexShopConfig | undefined {
  if (!record(shop) || !codexAudienceAllows(shop.audience, user))
    return undefined;
  if (!resolver || !Array.isArray(shop.stock)) return undefined; // Fail closed: item access cannot be checked.
  const stock = shop.stock
    .filter((row) => record(row) && canReadCodexRef(user, row.item, resolver))
    .map((row) => {
      const safe = { ...row };
      if (shop.mode === "loot") {
        delete safe.unitPrice;
        return safe;
      }
      const target = resolver.resolve(row.item);
      const raw = row.unitPrice !== undefined
        ? row.unitPrice
        : target?.type === "item" && record(target.system)
          ? target.system.value
          : undefined;
      const amount = typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^(?:\d{1,10}(?:\.\d{1,2})?|\.\d{1,2})$/.test(raw.trim())
          ? Number(raw.trim())
          : Number.NaN;
      const markup = typeof shop.markup === "number" && Number.isFinite(shop.markup)
        ? shop.markup
        : 1;
      if (Number.isFinite(amount) && amount >= 0 && amount <= 1e12 && markup >= 0 && markup <= 1_000)
        safe.unitPrice = String(Math.round(amount * markup * 100) / 100);
      else delete safe.unitPrice;
      return safe;
    });
  const safeShop = { ...shop, stock };
  delete safeShop.audience;
  delete safeShop.markup;
  return safeShop;
}

export function canReadCodexRef(
  user: PermissionUser,
  ref: DocRef,
  resolver: CodexResolver,
): boolean {
  if (docRefError(ref)) return false;
  if (isGm(user)) return true;
  const target = resolver.resolve(ref);
  if (!target) return false;
  const parent = ref.parent ? resolver.resolve(ref.parent) : undefined;
  if (ref.parent && (!parent || !canReadCodexRef(user, ref.parent, resolver)))
    return false;
  if (getEffectiveOwnership(user, target, parent) < OWNERSHIP_LEVELS.LIMITED)
    return false;
  if (
    target.type === "page" &&
    parent?.type === "journal" &&
    !codexPageVisible(
      target as JournalPageDocument,
      parent as JournalDocument,
      user,
    )
  )
    return false;
  return true;
}

/** Filter all nested Codex surfaces before sending a journal to a non-GM replica. */
export function projectCodexJournal(
  journal: JournalDocument,
  user: PermissionUser,
  resolver?: CodexResolver,
): JournalDocument {
  if (isGm(user)) return journal;
  const source = record(journal.codex)
    ? (journal.codex as unknown as CodexSheet)
    : undefined;
  const tabs =
    source && Array.isArray(source.tabs)
      ? (source.tabs.filter(record) as unknown as CodexTabConfig[])
      : [];
  const allPages = Array.isArray(journal.pages)
    ? (journal.pages.filter(record) as unknown as JournalPageDocument[])
    : [];
  const visibleTabs = tabs
    .filter((tab) => codexAudienceAllows(tab.audience, user))
    .map((tab) => projectedAudience(tab) as CodexTabConfig);
  const pages = allPages
    .filter((page) =>
      codexPageVisible(
        page,
        { ...journal, codex: source } as JournalDocument,
        user,
      ),
    )
    .map((page) => {
      if (!record(page.codex) || page.codex.audience === undefined) return page;
      const metadata = { ...page.codex };
      delete metadata.audience;
      return { ...page, codex: metadata };
    });
  if (!source) {
    if (journal.codex === undefined && pages.length === allPages.length)
      return journal;
    const safe = { ...journal };
    delete safe.codex;
    return { ...safe, pages } as JournalDocument;
  }
  // Unsupported future schemas remain intact for the GM, but are not interpreted or exposed.
  if (
    source.version !== CODEX_VERSION ||
    !Array.isArray(source.links) ||
    !Array.isArray(source.widgets)
  ) {
    const safe = { ...journal };
    delete safe.codex;
    return {
      ...safe,
      pages: pages.filter((page) => page.codex === undefined),
    } as JournalDocument;
  }
  const links = source.links
    .filter(
      (link) =>
        record(link) &&
        codexAudienceAllows(link.audience, user) &&
        resolver !== undefined &&
        canReadCodexRef(user, link.target, resolver),
    )
    .map((link) => projectedAudience(link) as CodexLink);
  const quests = (Array.isArray(source.quests) ? source.quests : [])
    .filter(
      (quest) => record(quest) && codexAudienceAllows(quest.audience, user),
    )
    .map((quest) => projectQuest(quest, user));
  const widgets = source.widgets
    .filter(
      (widget) =>
        record(widget) &&
        widget.enabled === true &&
        codexAudienceAllows(widget.audience, user),
    )
    .map((widget) => ({
      ...projectedAudience(widget),
      config: projectCodexWidgetConfig(
        widget,
        links,
        quests,
        (assetId) => resolver?.canReadAsset?.(assetId) === true,
        (tableId) => resolver !== undefined && canReadCodexRef(
          user,
          { coll: "rollTables", id: tableId },
          resolver,
        ),
      ),
    }) as CodexWidgetInstance);
  const shop = source.shop
    ? projectShop(source.shop, user, resolver)
    : undefined;
  const base = { ...source };
  if (!source.cover || resolver?.canReadAsset?.(source.cover) !== true)
    delete base.cover;
  delete base.quests;
  delete base.shop;
  const codex: CodexSheet = {
    ...base,
    tabs: visibleTabs,
    links,
    widgets,
    quests,
    ...(shop ? { shop } : {}),
  };
  return { ...journal, pages, codex };
}

export function codexReferencesRef(
  journal: JournalDocument,
  ref: DocRef,
): boolean {
  const sheet =
    record(journal.codex) && journal.codex.version === CODEX_VERSION
      ? (journal.codex as unknown as CodexSheet)
      : undefined;
  if (!sheet) return false;
  const links = Array.isArray(sheet.links) ? sheet.links : [];
  const targetsRef = (target: unknown): boolean =>
    record(target) &&
    !docRefError(target) &&
    (sameCodexRef(target as unknown as DocRef, ref) ||
      (ref.parent === undefined &&
        codexRefRootKey(target as unknown as DocRef) === codexRefRootKey(ref)));
  if (links.some((link) => record(link) && targetsRef(link.target)))
    return true;
  const stock = Array.isArray(sheet.shop?.stock) ? sheet.shop.stock : [];
  if (stock.some((row) => record(row) && targetsRef(row.item))) return true;
  const widgets = Array.isArray(sheet.widgets) ? sheet.widgets : [];
  return widgets.some((widget) =>
    record(widget) && codexWidgetDocumentRefs(widget as unknown as CodexWidgetInstance)
      .some((target) => targetsRef(target)),
  );
}

export function codexLinksTargetingRoots(
  journal: JournalDocument,
  changedRoots: ReadonlySet<string>,
): boolean {
  const links = Array.isArray(journal.codex?.links) ? journal.codex.links : [];
  return links.some(
    (link) =>
      record(link) &&
      record(link.target) &&
      !docRefError(link.target) &&
      changedRoots.has(codexRefRootKey(link.target as unknown as DocRef)),
  );
}
