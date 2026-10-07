<!-- eslint-disable @typescript-eslint/no-unused-vars, svelte/prefer-svelte-reactivity, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-dynamic-delete -->
<script lang="ts">
  /* eslint-disable @typescript-eslint/no-unused-vars, svelte/prefer-svelte-reactivity, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-dynamic-delete */
  /**
   * Campaign Codex Hub and common sheet reader/editor. All display data comes from the
   * recipient's projected DocumentStore; widget config is never interpreted as code.
   */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type {
    ActorDocument,
    BaseDocument,
    CodexAudience,
    CodexLink,
    CodexObjective,
    CodexQuest,
    CodexSheet,
    CodexSheetKind,
    CodexShopConfig,
    CodexShopStockRow,
    CodexTabConfig,
    AssetManifestEntry,
    CodexWidgetInstance,
    DocRef,
    ItemDocument,
    JournalDocument,
    JournalPageDocument,
    SceneDocument,
    UserDocument,
    RollTableDocument,
    Json,
  } from "../../core/documents";
  import JournalPage from "./JournalPage.svelte";
  import CodexAudienceEditor from "./CodexAudienceEditor.svelte";
  import { codexRefKey } from "../../core/campaignCodex";
  import { can } from "../../core/permissions";
  import { projectJournal } from "../../core/projection";
  import { CODEX_BUILTIN_WIDGET_TYPES, defaultCodexWidgetConfig } from "../../core/campaignCodexWidgets";
  import {
    codexWidgetViewForCapabilities,
    getCodexWidget,
    getCurrentCodexWidget,
    prepareCodexWidget,
    type CodexWidgetViewModel,
  } from "./codexWidgetRegistry";
  import {
    CODEX_BUNDLE_MAX_ARCHIVE_BYTES,
    exportCodexBundle,
    parseCodexBundleZip,
    planCodexBundleImport,
    type CodexBundleConflictChoice,
    type CodexBundleImportPlan,
    type ParsedCodexBundle,
  } from "../../core/campaignCodexBundle";
  import { exportCodexMarkdownZip } from "../../core/campaignCodexMarkdown";
  import { projectAssetManifest } from "../../core/assetAccess";
  import { normalizeTags } from "../../core/tags";
  import "./codexWidgetBuiltins";

  let {
    client,
    bus,
    resolveAsset = null,
    getAssetBytes = null,
    importBundleAsset = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    resolveAsset?: ((assetId: string) => string | null) | null;
    getAssetBytes?: ((assetId: string) => Promise<Uint8Array | undefined>) | null;
    importBundleAsset?: ((assetId: string, entry: AssetManifestEntry, bytes: Uint8Array) => Promise<void>) | null;
  } = $props();

  interface LinkChoice {
    key: string;
    ref: DocRef;
    doc: BaseDocument;
    label: string;
  }

  interface BundleImportSession {
    parsed: ParsedCodexBundle;
    choices: Record<string, CodexBundleConflictChoice>;
  }

  const KINDS: Array<{ value: CodexSheetKind; label: string }> = [
    { value: "group", label: "Group" },
    { value: "region", label: "Region" },
    { value: "location", label: "Location" },
    { value: "entry", label: "Entry" },
    { value: "npc", label: "NPC" },
    { value: "tag", label: "Tag" },
  ];
  const WIDGET_TYPES = CODEX_BUILTIN_WIDGET_TYPES;
  const UID = () => globalThis.crypto.randomUUID();

  let journals = $state<JournalDocument[]>([]);
  let audienceUsers = $state<UserDocument[]>([]);
  let linkChoices = $state<LinkChoice[]>([]);
  let selectedId = $state<string | null>(null);
  let previewUserId = $state<string | null>(null);
  let backStack = $state<string[]>([]);
  let recentIds = $state<string[]>([]);
  let tagFilter = $state("all");
  let activeTabKey = $state<string | null>(null);
  let pageId = $state<string | null>(null);
  let query = $state("");
  let kindFilter = $state("all");
  let createName = $state("");
  let createKind = $state<CodexSheetKind>("entry");
  let convertJournalId = $state("");
  let conversionPreviewId = $state<string | null>(null);
  let convertedJournalId = $state<string | null>(null);
  let selectedBundleRoots = $state<string[]>([]);
  let markdownLinkStyle = $state<"markdown" | "obsidian">("markdown");
  let bundleImport = $state<BundleImportSession | null>(null);
  let bundleMessage = $state<string | null>(null);
  let bundleBusy = $state(false);
  let pendingBundleTxId = $state<string | null>(null);
  let newTabLabel = $state("");
  let newPageName = $state("");
  let newLinkTarget = $state("");
  let linkTargetSearch = $state("");
  let newLinkRelation = $state("relatedTo");
  let newLinkLabel = $state("");
  let newQuestTitle = $state("");
  let objectiveDrafts = $state<Record<string, string>>({});
  let newWidgetType = $state<(typeof WIDGET_TYPES)[number]>("linked-entities");
  let widgetEditorId = $state<string | null>(null);
  let widgetAssetId = $state("");
  let widgetAssetCaption = $state("");
  let widgetAssetAlt = $state("");
  let widgetEventDate = $state("");
  let widgetEventTitle = $state("");
  let widgetEventDescription = $state("");
  let newStockTarget = $state("");
  let purchaseActorId = $state("");
  let purchaseQuantity = $state(1);
  let pendingPurchaseRequestId = $state<string | null>(null);
  let editingPage = $state(false);
  let pageDraft = $state("");
  let basicsName = $state("");
  let basicsSubtitle = $state("");
  let basicsTags = $state("");
  let basicsCover = $state("");
  let basicsKind = $state<CodexSheetKind>("entry");
  let operationMessage = $state("");

  const isGm = $derived(
    client.user?.role === "GM" || client.user?.role === "ASSISTANT",
  );
  const canEdit = $derived(isGm && previewUserId === null);
  const sheets = $derived(
    journals.filter((journal) => journal.codex?.version === 1),
  );
  const bundlePlan = $derived.by(() => {
    if (!bundleImport) return null;
    // Destination records are refreshed on every committed op; keep the conflict preview live.
    void journals.length;
    return planCodexBundleImport(bundleImport.parsed.bundle, client.store.world, bundleImport.choices);
  });
  const viewUser = $derived.by(() => {
    if (previewUserId !== null) {
      const selected = audienceUsers.find((user) => user._id === previewUserId);
      return selected ? { id: selected._id, role: selected.role } : null;
    }
    return client.user;
  });
  const viewSheets = $derived.by(() => {
    if (previewUserId === null) return sheets;
    if (!viewUser) return [] as JournalDocument[];
    const viewerManifest = projectAssetManifest(client.store.world, client.store.world.assetManifest, viewUser);
    return journals
      .filter((journal) => can(viewUser, "read", journal, "journals"))
      .map((journal) =>
        projectJournal(journal, viewUser, {
          resolve: (ref) => client.store.resolve(ref),
          canReadAsset: (assetId) => Object.prototype.hasOwnProperty.call(viewerManifest, assetId),
        }),
      )
      .filter((journal) => journal.codex?.version === 1);
  });
  const ordinaryJournals = $derived(
    journals.filter((journal) => journal.codex === undefined),
  );
  const selectedOrdinaryJournal = $derived(
    ordinaryJournals.find((journal) => journal._id === convertJournalId) ?? null,
  );
  const tagSheets = $derived(
    viewSheets.filter((journal) => journal.codex?.kind === "tag"),
  );
  const taggerTagNames = $derived([...new Set(viewSheets.flatMap((journal) => journal.taggerTags ?? []))]
    .sort((a, b) => a.localeCompare(b)));

  $effect(() => {
    const visible = new Set(viewSheets.map((journal) => journal._id));
    const remaining = selectedBundleRoots.filter((id) => visible.has(id));
    if (remaining.length !== selectedBundleRoots.length) selectedBundleRoots = remaining;
  });

  function tagNamesFor(journal: JournalDocument): string[] {
    return tagSheets
      .filter((tag) =>
        tag.codex?.links.some(
          (link) =>
            (link.relation === "relatedTo" || link.relation === "associatedWith") &&
            link.target.coll === "journals" &&
            link.target.id === journal._id &&
            link.target.parent === undefined,
        ),
      )
      .map((tag) => tag.name);
  }

  function searchTextFor(journal: JournalDocument): string {
    const pageText = journal.pages
      .map((page) => `${page.name} ${page.codex?.label ?? ""} ${page.text}`)
      .join(" ");
    const linkedText = (journal.codex?.links ?? [])
      .map((link) => client.store.resolve(link.target)?.name ?? link.label ?? "")
      .join(" ");
    return [journal.name, journal.codex?.subtitle ?? "", pageText, linkedText, ...tagNamesFor(journal), ...(journal.taggerTags ?? [])]
      .join(" ")
      .toLocaleLowerCase();
  }

  const filteredSheets = $derived(
    viewSheets.filter((journal) => {
      const matchesType =
        kindFilter === "all" || journal.codex?.kind === kindFilter;
      const selectedCodexTag = tagFilter.startsWith("c:")
        ? tagSheets.find((tag) => tag._id === tagFilter.slice(2))?.name
        : undefined;
      const selectedTaggerTag = tagFilter.startsWith("t:") ? tagFilter.slice(2) : undefined;
      const matchesTag = tagFilter === "all" ||
        selectedCodexTag !== undefined && tagNamesFor(journal).includes(selectedCodexTag) ||
        selectedTaggerTag !== undefined && (journal.taggerTags ?? []).includes(selectedTaggerTag);
      const search = query.trim().toLocaleLowerCase();
      const matchesSearch = !search || searchTextFor(journal).includes(search);
      return matchesType && matchesTag && matchesSearch;
    }),
  );

  function containingParents(targetId: string): JournalDocument[] {
    const result: JournalDocument[] = [];
    const seen = new Set([targetId]);
    let currentId = targetId;
    while (result.length < 10) {
      const parent = viewSheets.find((candidate) =>
        candidate.codex?.links.some(
          (link) =>
            link.relation === "contains" &&
            link.target.coll === "journals" &&
            link.target.id === currentId &&
            link.target.parent === undefined,
        ),
      );
      if (!parent || seen.has(parent._id)) break;
      seen.add(parent._id);
      result.unshift(parent);
      currentId = parent._id;
    }
    return result;
  }

  const parentChain = $derived(sheet ? containingParents(sheet._id) : []);
  const recentSheets = $derived(
    recentIds.map((id) => viewSheets.find((journal) => journal._id === id)).filter((journal): journal is JournalDocument => journal !== undefined),
  );
  const reverseLinkIndex = $derived.by(() => {
    const index = new Map<string, Array<{ source: JournalDocument; link: CodexLink }>>();
    for (const source of viewSheets) {
      for (const link of source.codex?.links ?? []) {
        try {
          const key = codexRefKey(link.target);
          const incoming = index.get(key) ?? [];
          incoming.push({ source, link });
          index.set(key, incoming);
        } catch {
          // Malformed legacy references are omitted and can be repaired by the GM.
        }
      }
    }
    return index;
  });
  const backlinks = $derived.by(() => {
    if (!sheet) return [] as Array<{ source: JournalDocument; link: CodexLink }>;
    const targetRefs = [
      { coll: "journals", id: sheet._id } as DocRef,
      ...sheet.pages.map((page) => ({
        coll: "pages",
        id: page._id,
        parent: { coll: "journals", id: sheet._id },
      }) as DocRef),
    ];
    const incoming = targetRefs.flatMap((ref) => reverseLinkIndex.get(codexRefKey(ref)) ?? []);
    return incoming.filter((entry) => entry.source._id !== sheet._id);
  });

  const groupTree = $derived.by(() => {
    if (!sheet || (sheet.codex?.kind !== "group" && sheet.codex?.kind !== "region")) return [];
    const rows: Array<{ journal: JournalDocument; depth: number }> = [];
    const visited = new Set([sheet._id]);
    const visit = (parent: JournalDocument, depth: number): void => {
      if (depth >= 10) return;
      const children = (parent.codex?.links ?? [])
        .filter((link) => link.relation === "contains" && link.target.coll === "journals")
        .map((link) => viewSheets.find((candidate) => candidate._id === link.target.id))
        .filter((candidate): candidate is JournalDocument => candidate !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id));
      for (const child of children) {
        if (visited.has(child._id)) continue;
        visited.add(child._id);
        rows.push({ journal: child, depth });
        visit(child, depth + 1);
      }
    };
    visit(sheet, 0);
    return rows;
  });
  const sheet = $derived(
    viewSheets.find((journal) => journal._id === selectedId) ?? viewSheets[0] ?? null,
  );
  const tabs = $derived(
    sheet
      ? [...(sheet.codex?.tabs ?? [])].sort(
          (a, b) => a.order - b.order || a.label.localeCompare(b.label),
        )
      : [],
  );
  const activeTab = $derived(
    tabs.find((tab) => tab.key === activeTabKey) ?? tabs[0] ?? null,
  );
  const pages = $derived(
    sheet
      ? sheet.pages
          .filter(
            (page) =>
              (page.codex?.tabKey ?? tabs[0]?.key ?? "info") ===
              (activeTab?.key ?? "info"),
          )
          .sort(
            (a, b) =>
              (a.codex?.order ?? sheet.pages.indexOf(a)) -
                (b.codex?.order ?? sheet.pages.indexOf(b)) ||
              sheet.pages.indexOf(a) - sheet.pages.indexOf(b),
          )
      : [],
  );
  const page = $derived(
    pages.find((candidate) => candidate._id === pageId) ?? pages[0] ?? null,
  );
  const selectedTarget = $derived(
    linkChoices.find((choice) => choice.key === newLinkTarget) ?? null,
  );
  const filteredTargetChoices = $derived.by(() => {
    const needle = linkTargetSearch.trim().toLocaleLowerCase();
    return linkChoices.filter((choice) => !needle || choice.label.toLocaleLowerCase().includes(needle)).slice(0, 40);
  });
  const relationChoices = $derived(
    selectedTarget ? relationOptions(selectedTarget.ref) : [],
  );
  const stockChoices = $derived(
    linkChoices.filter((choice) => choice.doc.type === "item"),
  );
  const widgetAssetChoices = $derived(
    Object.entries(client.store.world.assetManifest)
      .filter(([, entry]) => entry.mime.startsWith("image/") && entry.visibility !== "gm")
      .map(([assetId, entry]) => ({ assetId, name: entry.name, mime: entry.mime }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const widgetRollTables = $derived(
    (client.store.getAll("rollTables") as readonly RollTableDocument[])
      .filter((table) => viewUser !== null && can(viewUser, "read", table, "rollTables"))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const purchaseViewer = $derived.by(() => {
    if (previewUserId === null) return client.user;
    const selected = audienceUsers.find((user) => user._id === previewUserId);
    return selected ? { id: selected._id, role: selected.role } : null;
  });
  const purchaseActors = $derived(
    (client.store.getAll("actors") as readonly ActorDocument[]).filter(
      (actor) => purchaseViewer !== null && can(purchaseViewer, "update", actor, "actors"),
    ),
  );
  const canPurchase = $derived(previewUserId === null && client.user !== null);
  const selectedPurchaseActor = $derived(
    purchaseActors.find((actor) => actor._id === purchaseActorId) ?? null,
  );

  function refresh(): void {
    journals = [
      ...(client.store.getAll("journals") as readonly JournalDocument[]),
    ];
    audienceUsers = [
      ...(client.store.getAll("users") as readonly UserDocument[]),
    ];
    linkChoices = collectLinkChoices();
    const viewer = previewUserId === null
      ? client.user
      : audienceUsers.find((user) => user._id === previewUserId) ?? null;
    const allowedActors = (client.store.getAll("actors") as readonly ActorDocument[])
      .filter((actor) => viewer !== null && can(viewer, "update", actor, "actors"));
    const preferredActorId = audienceUsers.find((user) => user._id === viewer?.id)?.character ?? null;
    if (!allowedActors.some((actor) => actor._id === purchaseActorId))
      purchaseActorId = allowedActors.find((actor) => actor._id === preferredActorId)?._id ?? allowedActors[0]?._id ?? "";
    if (!sheets.some((journal) => journal._id === selectedId)) {
      selectedId = sheets[0]?._id ?? null;
      activeTabKey = sheets[0]?.codex?.tabs?.[0]?.key ?? null;
      pageId = null;
      editingPage = false;
    }
  }

  function collectLinkChoices(): LinkChoice[] {
    const result: LinkChoice[] = [];
    const add = (ref: DocRef, doc: BaseDocument): void => {
      result.push({
        key: JSON.stringify(ref),
        ref,
        doc,
        label: `${doc.type}: ${doc.name}`,
      });
    };
    for (const journal of client.store.getAll(
      "journals",
    ) as readonly JournalDocument[]) {
      add({ coll: "journals", id: journal._id }, journal);
      for (const page of journal.pages ?? [])
        add(
          {
            coll: "pages",
            id: page._id,
            parent: { coll: "journals", id: journal._id },
          },
          page,
        );
    }
    for (const actor of client.store.getAll(
      "actors",
    ) as readonly ActorDocument[]) {
      add({ coll: "actors", id: actor._id }, actor);
      for (const item of actor.items ?? [])
        add(
          {
            coll: "items",
            id: item._id,
            parent: { coll: "actors", id: actor._id },
          },
          item,
        );
    }
    for (const item of client.store.getAll("items") as readonly ItemDocument[])
      add({ coll: "items", id: item._id }, item);
    for (const scene of client.store.getAll(
      "scenes",
    ) as readonly SceneDocument[])
      add({ coll: "scenes", id: scene._id }, scene);
    return result.sort((a, b) => a.label.localeCompare(b.label));
  }

  function relationOptions(ref: DocRef): string[] {
    if (ref.coll === "actors")
      return ["representsActor", "operatedBy", "associatedWith", "relatedTo"];
    if (ref.coll === "scenes")
      return ["linksScene", "associatedWith", "relatedTo"];
    if (ref.coll === "items")
      return ["linksItem", "associatedWith", "relatedTo"];
    if (ref.coll === "pages") return ["associatedWith", "relatedTo"];
    return [
      "contains",
      "locatedAt",
      "operatedBy",
      "associatedWith",
      "relatedTo",
    ];
  }

  function openSheet(candidate: JournalDocument, trackHistory: boolean): void {
    if (selectedId === candidate._id) return;
    if (trackHistory && selectedId) backStack = [...backStack, selectedId].slice(-40);
    selectedId = candidate._id;
    recentIds = [candidate._id, ...recentIds.filter((id) => id !== candidate._id)].slice(0, 10);
    activeTabKey = candidate.codex?.tabs?.[0]?.key ?? null;
    pageId = null;
    editingPage = false;
    operationMessage = "";
  }

  function selectSheet(candidate: JournalDocument): void {
    openSheet(candidate, true);
  }

  function goBack(): void {
    while (backStack.length > 0) {
      const priorId = backStack[backStack.length - 1];
      backStack = backStack.slice(0, -1);
      if (!priorId) continue;
      const prior = viewSheets.find((candidate) => candidate._id === priorId);
      if (prior) {
        openSheet(prior, false);
        return;
      }
    }
  }

  function selectTab(tab: CodexTabConfig): void {
    activeTabKey = tab.key;
    pageId = null;
    editingPage = false;
  }

  function moveTab(key: string, offset: -1 | 1): void {
    if (!canEdit || !sheet?.codex) return;
    const ordered = [...(sheet.codex.tabs ?? [])].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    const index = ordered.findIndex((tab) => tab.key === key);
    const destination = index + offset;
    if (index < 0 || destination < 0 || destination >= ordered.length) return;
    [ordered[index], ordered[destination]] = [ordered[destination]!, ordered[index]!];
    updateSheet({ ...sheet.codex, tabs: ordered.map((tab, order) => ({ ...tab, order })) });
  }

  function movePage(pageIdToMove: string, offset: -1 | 1): void {
    if (!canEdit || !sheet || !activeTab) return;
    const ordered = [...pages];
    const index = ordered.findIndex((page) => page._id === pageIdToMove);
    const destination = index + offset;
    if (index < 0 || destination < 0 || destination >= ordered.length) return;
    [ordered[index], ordered[destination]] = [ordered[destination]!, ordered[index]!];
    client.submit(ordered.map((page, order) => ({
      kind: "update" as const,
      ref: { coll: "pages" as const, id: page._id, parent: { coll: "journals" as const, id: sheet._id } },
      diff: { codex: { ...(page.codex ?? {}), tabKey: activeTab.key, order } },
    })));
  }

  function submitCreate(): void {
    if (!canEdit) return;
    const name =
      createName.trim() ||
      `${KINDS.find((kind) => kind.value === createKind)?.label ?? "Entry"} ${sheets.length + 1}`;
    const infoTab: CodexTabConfig = {
      key: "info",
      label: "Info",
      order: 0,
      audience: { kind: "inherit" },
    };
    const page: JournalPageDocument = {
      _id: UID(),
      type: "page",
      name: "Overview",
      ownership: { default: 1 },
      flags: {},
      system: {},
      text: `# ${name}\n\nAdd campaign notes here.`,
      src: null,
      codex: { tabKey: infoTab.key, order: 0, audience: { kind: "inherit" } },
    };
    const journal: JournalDocument = {
      _id: UID(),
      type: "journal",
      name,
      ownership: { default: 1 },
      flags: {},
      system: {},
      pages: [page],
      codex: {
        version: 1,
        kind: createKind,
        links: [],
        widgets: [],
        quests: [],
        tabs: [infoTab],
      },
    };
    client.submit([{ kind: "create", coll: "journals", data: journal }]);
    createName = "";
    selectedId = journal._id;
    activeTabKey = infoTab.key;
    pageId = page._id;
    operationMessage = "Codex sheet created.";
  }

  function previewConversion(): void {
    if (!canEdit || !selectedOrdinaryJournal) return;
    conversionPreviewId = selectedOrdinaryJournal._id;
  }

  function toggleBundleRoot(journalId: string, selected: boolean): void {
    if (selected) {
      if (selectedBundleRoots.length >= 16) {
        bundleMessage = "A selected-content bundle can have at most 16 roots.";
        return;
      }
      selectedBundleRoots = [...selectedBundleRoots, journalId];
    } else {
      selectedBundleRoots = selectedBundleRoots.filter((id) => id !== journalId);
    }
  }

  function downloadZip(bytes: Uint8Array, filename: string): void {
    const blob = new Blob([bytes], { type: "application/zip" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  }

  function selectedVisibleRoots(): string[] | null {
    if (selectedBundleRoots.length === 0) return [];
    const visible = new Set(viewSheets.map((journal) => journal._id));
    const roots = selectedBundleRoots.filter((id) => visible.has(id));
    if (roots.length !== selectedBundleRoots.length) {
      bundleMessage = "A selected root is not visible to this audience preview. Clear the hidden selection before exporting.";
      return null;
    }
    return roots;
  }

  async function exportSelectedBundle(): Promise<void> {
    if (!viewUser || !selectedBundleRoots.length || bundleBusy) return;
    const roots = selectedVisibleRoots();
    if (!roots) return;
    bundleBusy = true;
    bundleMessage = null;
    try {
      const exported = await exportCodexBundle({
        world: client.store.world,
        manifest: client.store.world.assetManifest,
        viewer: viewUser,
        rootJournalIds: roots,
        loadAsset: getAssetBytes ?? (async () => undefined),
      });
      downloadZip(exported.bytes, `campaign-codex-${new Date().toISOString().slice(0, 10)}.codex.zip`);
      const count = Object.values(exported.report.included).reduce((sum, item) => sum + item, 0);
      const notices = [
        `${count} readable document(s) included.`,
        ...(exported.report.omittedMedia > 0 ? [`${exported.report.omittedMedia} media reference(s) omitted because rights or local bytes were unavailable.`] : []),
        ...(exported.report.hasUnavailableDependencies ? ["Some dependencies were not readable and were left out without identifying them."] : []),
      ];
      bundleMessage = notices.join(" ");
    } catch (error) {
      bundleMessage = error instanceof Error ? error.message : "Selected-content export failed.";
    } finally {
      bundleBusy = false;
    }
  }

  async function exportSelectedMarkdown(): Promise<void> {
    if (!viewUser || !selectedBundleRoots.length || bundleBusy) return;
    const roots = selectedVisibleRoots();
    if (!roots) return;
    bundleBusy = true;
    bundleMessage = null;
    try {
      const exported = await exportCodexMarkdownZip({
        world: client.store.world,
        manifest: client.store.world.assetManifest,
        viewer: viewUser,
        rootJournalIds: roots,
        loadAsset: getAssetBytes ?? undefined,
        linkStyle: markdownLinkStyle,
      });
      downloadZip(exported.bytes, `campaign-codex-${new Date().toISOString().slice(0, 10)}.${markdownLinkStyle}.zip`);
      const count = Object.values(exported.report.included).reduce((sum, item) => sum + item, 0);
      const notices = [
        `${count} readable record(s) exported as ${markdownLinkStyle === "obsidian" ? "Obsidian" : "Markdown"}.`,
        ...(exported.report.omittedMedia + exported.omittedLocalMedia > 0
          ? [`${exported.report.omittedMedia + exported.omittedLocalMedia} media reference(s) omitted because rights, local bytes, or hash verification were unavailable.`]
          : []),
        ...(exported.report.hasUnavailableDependencies ? ["Some dependencies were not readable and were left out without identifying them."] : []),
      ];
      bundleMessage = notices.join(" ");
    } catch (error) {
      bundleMessage = error instanceof Error ? error.message : "Markdown export failed.";
    } finally {
      bundleBusy = false;
    }
  }

  async function loadBundleFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || bundleBusy) return;
    if (file.size > CODEX_BUNDLE_MAX_ARCHIVE_BYTES) {
      bundleMessage = "The selected bundle exceeds the 64 MiB limit.";
      return;
    }
    bundleBusy = true;
    bundleMessage = null;
    try {
      const parsed = parseCodexBundleZip(new Uint8Array(await file.arrayBuffer()));
      bundleImport = { parsed, choices: {} };
      bundleMessage = "Bundle validated. Review dependencies and resolve every matched-document conflict before commit.";
    } catch (error) {
      bundleImport = null;
      bundleMessage = error instanceof Error ? error.message : "The selected Codex bundle could not be read.";
    } finally {
      bundleBusy = false;
    }
  }

  function bundleChoiceValue(key: string): string {
    const choice = bundleImport?.choices[key];
    return !choice ? "" : choice.action === "skip" ? "skip" : `${choice.action}:${choice.targetId ?? ""}`;
  }

  function changeBundleConflict(key: string, value: string): void {
    if (!bundleImport) return;
    const choices = { ...bundleImport.choices };
    if (!value) delete choices[key];
    else if (value === "skip") choices[key] = { action: "skip" };
    else {
      const [action, targetId] = value.split(":", 2);
      if ((action === "link" || action === "replace") && targetId)
        choices[key] = { action, targetId };
    }
    bundleImport = { ...bundleImport, choices };
  }

  function closeBundleImport(): void {
    bundleImport = null;
    bundleMessage = null;
  }

  async function commitBundleImport(): Promise<void> {
    if (!canEdit || !bundleImport || !bundlePlan?.ready || bundleBusy) return;
    if (bundleImport.parsed.assetBytes.size > 0 && !importBundleAsset) {
      bundleMessage = "This app cannot import bundle media into the current world.";
      return;
    }
    bundleBusy = true;
    bundleMessage = "Importing permitted media and preparing one atomic document transaction…";
    try {
      for (const [assetId, bytes] of bundleImport.parsed.assetBytes) {
        const entry = bundleImport.parsed.bundle.assets[assetId];
        if (!entry) throw new Error("A bundled asset has no validated manifest entry.");
        await importBundleAsset?.(assetId, entry, bytes);
      }
      const operationCount = bundlePlan.ops.length;
      const txId = client.submit(bundlePlan.ops);
      pendingBundleTxId = txId;
      bundleImport = null;
      bundleMessage = `Submitted ${operationCount} document operation(s) as one host-validated transaction; imported media is marked restricted until locally reviewed.`;
    } catch (error) {
      bundleMessage = error instanceof Error ? error.message : "Codex bundle import failed before document commit.";
    } finally {
      bundleBusy = false;
    }
  }

  function convertJournal(): void {
    if (
      !canEdit ||
      !selectedOrdinaryJournal ||
      conversionPreviewId !== selectedOrdinaryJournal._id
    ) return;
    const journal = selectedOrdinaryJournal;
    const infoTab: CodexTabConfig = {
      key: "info",
      label: "Info",
      order: 0,
      audience: { kind: "inherit" },
    };
    client.submit([{
      kind: "update",
      ref: { coll: "journals", id: journal._id },
      diff: {
        codex: {
          version: 1,
          kind: "entry",
          links: [],
          widgets: [],
          quests: [],
          tabs: [infoTab],
        },
      },
    }]);
    convertedJournalId = journal._id;
    conversionPreviewId = null;
    selectedId = journal._id;
    activeTabKey = infoTab.key;
    pageId = journal.pages[0]?._id ?? null;
    operationMessage = `Converted “${journal.name}”. Existing pages and text were left unchanged.`;
  }

  function undoConversion(): void {
    if (!canEdit || !convertedJournalId) return;
    const journal = journals.find((candidate) => candidate._id === convertedJournalId);
    if (!journal?.codex || journal.codex.version !== 1) return;
    client.submit([{
      kind: "update",
      ref: { coll: "journals", id: convertedJournalId },
      diff: { "-=codex": null },
    }]);
    operationMessage = `Removed Codex metadata from “${journal.name}”; journal pages were preserved.`;
    convertedJournalId = null;
  }

  function saveBasics(): void {
    if (!canEdit || !sheet?.codex) return;
    const codex: CodexSheet = { ...sheet.codex, kind: basicsKind };
    const subtitle = basicsSubtitle.trim();
    if (subtitle) codex.subtitle = subtitle;
    else delete codex.subtitle;
    const cover = basicsCover.trim();
    if (cover) {
      const entry = client.store.world.assetManifest[cover];
      if (!/^[a-f0-9]{64}$/i.test(cover) || !entry || !entry.mime.startsWith("image/") || entry.visibility === "gm") {
        operationMessage = "Choose a readable local image from this world's asset library for the Codex cover.";
        return;
      }
      codex.cover = cover;
    } else delete codex.cover;
    let taggerTags: string[];
    try {
      taggerTags = normalizeTags(basicsTags.split(",").map((tag) => tag.trim()).filter(Boolean));
    } catch (error) {
      operationMessage = error instanceof Error ? error.message : "Tags are invalid.";
      return;
    }
    client.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: sheet._id },
        diff: { name: basicsName.trim() || sheet.name, codex, taggerTags },
      },
    ]);
    operationMessage = "Sheet details, cover, and tags saved.";
  }

  function addTab(): void {
    if (!canEdit || !sheet?.codex) return;
    const label = newTabLabel.trim();
    if (!label) return;
    const base =
      label
        .toLocaleLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64) || `tab-${UID().slice(0, 8)}`;
    let key = base;
    let suffix = 2;
    while (sheet.codex.tabs?.some((tab) => tab.key === key))
      key = `${base.slice(0, 58)}-${suffix++}`;
    const tabs = [
      ...(sheet.codex.tabs ?? []),
      {
        key,
        label,
        order: sheet.codex.tabs?.length ?? 0,
        audience: { kind: "inherit" as const },
      },
    ];
    updateSheet({ ...sheet.codex, tabs });
    newTabLabel = "";
    activeTabKey = key;
  }

  function addPage(): void {
    if (!canEdit || !sheet || !activeTab) return;
    const name = newPageName.trim() || `Page ${sheet.pages.length + 1}`;
    const data: JournalPageDocument = {
      _id: UID(),
      type: "page",
      name,
      ownership: { default: 1 },
      flags: {},
      system: {},
      text: `# ${name}\n\nWrite here.`,
      src: null,
      codex: {
        tabKey: activeTab.key,
        order: pages.length,
        audience: { kind: "inherit" },
      },
    };
    client.submit([
      {
        kind: "create",
        coll: "pages",
        parent: { coll: "journals", id: sheet._id },
        data,
      },
    ]);
    newPageName = "";
    pageId = data._id;
    editingPage = false;
  }

  function updateSheet(codex: CodexSheet): void {
    if (!sheet) return;
    client.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: sheet._id },
        diff: { codex },
      },
    ]);
  }

  function savePage(): void {
    if (!sheet || !page) return;
    client.submit([
      {
        kind: "update",
        ref: {
          coll: "pages",
          id: page._id,
          parent: { coll: "journals", id: sheet._id },
        },
        diff: { text: pageDraft },
      },
    ]);
    editingPage = false;
    operationMessage = "Page saved.";
  }

  function setPageAudience(audience: CodexAudience): void {
    if (!canEdit || !page || !sheet) return;
    const codex = { ...(page.codex ?? {}), audience };
    client.submit([
      {
        kind: "update",
        ref: {
          coll: "pages",
          id: page._id,
          parent: { coll: "journals", id: sheet._id },
        },
        diff: { codex },
      },
    ]);
  }

  function setTabAudience(tabKey: string, audience: CodexAudience): void {
    if (!sheet?.codex) return;
    updateSheet({
      ...sheet.codex,
      tabs: (sheet.codex.tabs ?? []).map((tab) =>
        tab.key === tabKey ? { ...tab, audience } : tab,
      ),
    });
  }

  const CODEX_DRAG_REF = "application/x-arenastar-codex-ref";

  function dragLinkChoice(event: DragEvent, choice: LinkChoice): void {
    if (!canEdit || !event.dataTransfer) return;
    event.dataTransfer.setData(CODEX_DRAG_REF, choice.key);
    event.dataTransfer.setData("text/plain", choice.label);
    event.dataTransfer.effectAllowed = "link";
  }

  function dragJournalChoice(event: DragEvent, journalId: string): void {
    const choice = linkChoices.find((candidate) => candidate.ref.coll === "journals" &&
      candidate.ref.id === journalId && candidate.ref.parent === undefined);
    if (choice) dragLinkChoice(event, choice);
  }

  function acceptRelationshipDrop(event: DragEvent): void {
    event.preventDefault();
    const key = event.dataTransfer?.getData(CODEX_DRAG_REF);
    const choice = key ? linkChoices.find((candidate) => candidate.key === key) : undefined;
    if (!choice) return;
    newLinkTarget = choice.key;
    newLinkRelation = relationOptions(choice.ref)[0] ?? "relatedTo";
    linkTargetSearch = choice.label;
  }

  function addLink(): void {
    if (
      !sheet?.codex ||
      !selectedTarget ||
      !relationChoices.includes(newLinkRelation)
    )
      return;
    const link: CodexLink = {
      id: UID(),
      relation: newLinkRelation as CodexLink["relation"],
      target: selectedTarget.ref,
      ...(newLinkLabel.trim() ? { label: newLinkLabel.trim() } : {}),
      audience: { kind: "inherit" },
    };
    updateSheet({ ...sheet.codex, links: [...sheet.codex.links, link] });
    newLinkTarget = "";
    newLinkLabel = "";
  }

  function removeLink(id: string): void {
    if (sheet?.codex)
      updateSheet({
        ...sheet.codex,
        links: sheet.codex.links.filter((link) => link.id !== id),
      });
  }

  function linkName(link: CodexLink): string {
    const target = client.store.resolve(link.target);
    return target?.name ?? "Unavailable link";
  }

  function addQuest(): void {
    if (!sheet?.codex || !newQuestTitle.trim()) return;
    const quests = sheet.codex.quests ?? [];
    const quest: CodexQuest = {
      id: UID(),
      title: newQuestTitle.trim(),
      description: "",
      state: "active",
      pinned: false,
      audience: { kind: "inherit" },
      order: quests.length,
      objectives: [],
    };
    updateSheet({ ...sheet.codex, quests: [...quests, quest] });
    newQuestTitle = "";
  }

  function patchQuest(id: string, patch: Partial<CodexQuest>): void {
    if (sheet?.codex)
      updateSheet({
        ...sheet.codex,
        quests: (sheet.codex.quests ?? []).map((quest) =>
          quest.id === id ? { ...quest, ...patch } : quest,
        ),
      });
  }

  function addObjective(quest: CodexQuest): void {
    if (!sheet?.codex) return;
    const title = (objectiveDrafts[quest.id] ?? "").trim();
    if (!title) return;
    const objectives: CodexObjective[] = [
      ...quest.objectives,
      {
        id: UID(),
        title,
        completed: false,
        order: quest.objectives.length,
        audience: { kind: "inherit" },
        children: [],
      },
    ];
    patchQuest(quest.id, { objectives });
    objectiveDrafts = { ...objectiveDrafts, [quest.id]: "" };
  }

  function patchObjectiveTree(
    objectives: readonly CodexObjective[],
    objectiveId: string,
    patch: Partial<CodexObjective>,
  ): CodexObjective[] {
    return objectives.map((objective) => objective.id === objectiveId
      ? { ...objective, ...patch }
      : { ...objective, children: patchObjectiveTree(objective.children, objectiveId, patch) });
  }

  function findObjective(objectives: readonly CodexObjective[], objectiveId: string): CodexObjective | undefined {
    for (const objective of objectives) {
      if (objective.id === objectiveId) return objective;
      const child = findObjective(objective.children, objectiveId);
      if (child) return child;
    }
    return undefined;
  }

  function objectiveRows(objectives: readonly CodexObjective[], depth = 0): Array<{
    objective: CodexObjective; depth: number; index: number; count: number;
  }> {
    const ordered = [...objectives].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return ordered.flatMap((objective, index) => [
      { objective, depth, index, count: ordered.length },
      ...objectiveRows(objective.children, depth + 1),
    ]);
  }

  function reorderObjectiveTree(objectives: readonly CodexObjective[], objectiveId: string, offset: -1 | 1): CodexObjective[] {
    const ordered = [...objectives].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const index = ordered.findIndex((objective) => objective.id === objectiveId);
    if (index >= 0) {
      const destination = index + offset;
      if (destination < 0 || destination >= ordered.length) return objectives as CodexObjective[];
      [ordered[index], ordered[destination]] = [ordered[destination]!, ordered[index]!];
      return ordered.map((objective, order) => ({ ...objective, order }));
    }
    for (let index = 0; index < objectives.length; index += 1) {
      const objective = objectives[index];
      if (!objective) continue;
      const children = reorderObjectiveTree(objective.children, objectiveId, offset);
      if (children !== objective.children) {
        const next = [...objectives];
        next[index] = { ...objective, children };
        return next;
      }
    }
    return objectives as CodexObjective[];
  }

  function patchObjective(quest: CodexQuest, objectiveId: string, patch: Partial<CodexObjective>): void {
    patchQuest(quest.id, { objectives: patchObjectiveTree(quest.objectives, objectiveId, patch) });
  }

  function questMoveDisabled(questId: string, offset: -1 | 1): boolean {
    const ordered = [...(sheet?.codex?.quests ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order);
    const index = ordered.findIndex((quest) => quest.id === questId);
    const destination = index + offset;
    return index < 0 || destination < 0 || destination >= ordered.length || ordered[destination]?.pinned !== ordered[index]?.pinned;
  }

  function moveQuest(questId: string, offset: -1 | 1): void {
    if (!sheet?.codex || questMoveDisabled(questId, offset)) return;
    const ordered = [...(sheet.codex.quests ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order);
    const index = ordered.findIndex((quest) => quest.id === questId);
    const destination = index + offset;
    [ordered[index], ordered[destination]] = [ordered[destination]!, ordered[index]!];
    updateSheet({ ...sheet.codex, quests: ordered.map((quest, order) => ({ ...quest, order })) });
  }

  function moveObjective(quest: CodexQuest, objectiveId: string, offset: -1 | 1): void {
    const objectives = reorderObjectiveTree(quest.objectives, objectiveId, offset);
    if (objectives !== quest.objectives) patchQuest(quest.id, { objectives });
  }

  function addSubObjective(quest: CodexQuest, parentId: string): void {
    const parent = findObjective(quest.objectives, parentId);
    const draftKey = `${quest.id}:${parentId}`;
    const title = (objectiveDrafts[draftKey] ?? "").trim();
    if (!parent || !title) return;
    const child: CodexObjective = {
      id: UID(), title, completed: false, order: parent.children.length,
      audience: { kind: "inherit" }, children: [],
    };
    patchObjective(quest, parentId, { children: [...parent.children, child] });
    objectiveDrafts = { ...objectiveDrafts, [draftKey]: "" };
  }

  function addWidget(): void {
    if (!sheet?.codex || !activeTab) return;
    const widgets: CodexWidgetInstance[] = [
      ...sheet.codex.widgets,
      {
        id: UID(),
        type: newWidgetType,
        version: 1,
        tab: activeTab.key,
        order: sheet.codex.widgets.length,
        enabled: true,
        audience: { kind: "inherit" },
        config: defaultCodexWidgetConfig(newWidgetType),
      },
    ];
    updateSheet({ ...sheet.codex, widgets });
  }

  function patchWidget(id: string, patch: Partial<CodexWidgetInstance>): void {
    if (sheet?.codex)
      updateSheet({
        ...sheet.codex,
        widgets: sheet.codex.widgets.map((widget) =>
          widget.id === id ? { ...widget, ...patch } : widget,
        ),
      });
  }

  function toggleWidgetId(widget: CodexWidgetInstance, key: "linkIds" | "questIds", id: string, checked: boolean, allIds: string[]): void {
    const config = widgetConfig(widget);
    const current = Array.isArray(config[key])
      ? config[key].filter((value): value is string => typeof value === "string")
      : allIds;
    const next = checked ? [...new Set([...current, id])] : current.filter((value) => value !== id);
    updateWidgetConfig(widget.id, { ...config, [key]: next });
  }

  function widgetIdChecked(widget: CodexWidgetInstance, key: "linkIds" | "questIds", id: string): boolean {
    const selected = widgetConfig(widget)[key];
    return !Array.isArray(selected) || selected.includes(id);
  }

  function patchWidgetConfigField(widget: CodexWidgetInstance, key: string, value: unknown): void {
    updateWidgetConfig(widget.id, { ...widgetConfig(widget), [key]: value });
  }

  function ensureShop(): CodexShopConfig | null {
    if (!sheet?.codex) return null;
    return (
      sheet.codex.shop ?? {
        mode: "shop",
        stock: [],
        audience: { kind: "inherit" },
      }
    );
  }

  function saveShop(shop: CodexShopConfig): void {
    if (sheet?.codex) updateSheet({ ...sheet.codex, shop });
  }

  function setShopAudience(audience: CodexAudience): void {
    const shop = ensureShop();
    if (!shop) return;
    saveShop({ ...shop, audience });
  }

  function setShopMarkup(value: string): void {
    const shop = ensureShop();
    if (!shop || value.trim() === "") return;
    const markup = Number(value);
    if (Number.isFinite(markup))
      saveShop({ ...shop, markup: Math.min(1_000, Math.max(0, markup)) });
  }

  function addStock(): void {
    const shop = ensureShop();
    const choice = stockChoices.find((item) => item.key === newStockTarget);
    if (!shop || !choice || !sheet?.codex) return;
    saveShop({
      ...shop,
      stock: [
        ...shop.stock,
        {
          id: UID(),
          item: choice.ref,
          quantity: null,
          ...(shop.mode === "shop" ? { unitPrice: "0" } : {}),
          order: shop.stock.length,
        },
      ],
    });
    newStockTarget = "";
  }

  function patchStock(
    id: string,
    patch: { quantity?: number | null; unitPrice?: string },
  ): void {
    const shop = ensureShop();
    if (!shop) return;
    saveShop({
      ...shop,
      stock: shop.stock.map((row) =>
        row.id === id ? { ...row, ...patch } : row,
      ),
    });
  }

  function setStockQuantity(id: string, value: string): void {
    if (value === "") {
      patchStock(id, { quantity: null });
      return;
    }
    const quantity = Number(value);
    if (Number.isFinite(quantity))
      patchStock(id, {
        quantity: Math.min(1_000_000_000, Math.max(0, Math.floor(quantity))),
      });
  }

  function removeStock(id: string): void {
    const shop = ensureShop();
    if (shop)
      saveShop({ ...shop, stock: shop.stock.filter((row) => row.id !== id) });
  }

  function setShopMode(mode: "shop" | "loot"): void {
    const shop = ensureShop();
    if (!shop) return;
    saveShop({ ...shop, mode });
  }

  function purchaseStock(stockRowId: string): void {
    if (!canPurchase || !sheet || !selectedPurchaseActor || pendingPurchaseRequestId) return;
    pendingPurchaseRequestId = client.requestCodexPurchase(
      sheet._id,
      stockRowId,
      purchaseQuantity,
      selectedPurchaseActor._id,
    );
    operationMessage = "Purchase submitted for host validation…";
  }

  function priceLabel(stock: CodexShopStockRow): string {
    const item = client.store.resolve(stock.item);
    const raw = stock.unitPrice !== undefined
      ? Number(stock.unitPrice)
      : item?.type === "item" && typeof item.system.value === "number"
        ? item.system.value
        : Number.NaN;
    if (!Number.isFinite(raw) || raw < 0) return "Price unavailable";
    const markup = canEdit ? (sheet?.codex?.shop?.markup ?? 1) : 1;
    return `${(Math.round(raw * markup * 100) / 100).toFixed(2)} gp`;
  }

  function widgetConfig(widget: CodexWidgetInstance): Record<string, unknown> {
    return widget.config && typeof widget.config === "object" && !Array.isArray(widget.config)
      ? widget.config as Record<string, unknown>
      : {};
  }

  function widgetView(widget: CodexWidgetInstance): CodexWidgetViewModel {
    const config = widgetConfig(widget);
    const linkIds = Array.isArray(config.linkIds)
      ? new Set(config.linkIds.filter((id): id is string => typeof id === "string"))
      : null;
    const relation = typeof config.relation === "string" ? config.relation : null;
    const limit = typeof config.maxItems === "number" && Number.isSafeInteger(config.maxItems)
      ? Math.max(1, Math.min(50, config.maxItems)) : 50;
    const links = (sheet?.codex?.links ?? [])
      .filter((link) => (!linkIds || linkIds.has(link.id)) && (!relation || link.relation === relation))
      .map((link) => {
        const target = client.store.resolve(link.target);
        if (!target) return null;
        const targetIsCodexSheet = target.type === "journal" &&
          (target as JournalDocument).codex?.version === 1;
        return {
          id: link.id,
          relation: link.relation,
          label: link.label?.trim() || target.name,
          targetName: target.name,
          targetCollection: link.target.coll,
          ...(targetIsCodexSheet ? { targetId: target._id } : {}),
          targetIsCodexSheet,
        };
      })
      .filter((link): link is NonNullable<typeof link> => link !== null)
      .slice(0, limit);
    const selectedQuestIds = Array.isArray(config.questIds)
      ? new Set(config.questIds.filter((id): id is string => typeof id === "string"))
      : null;
    const quests = (sheet?.codex?.quests ?? [])
      .filter((quest) => (!selectedQuestIds || selectedQuestIds.has(quest.id)) &&
        (config.showCompleted !== false || quest.state !== "completed"))
      .map((quest) => {
        const objectives: Array<{ id: string; title: string; completed: boolean }> = [];
        const walk = (rows: CodexObjective[]): void => {
          for (const objective of rows) {
            objectives.push({ id: objective.id, title: objective.title, completed: objective.completed });
            walk(objective.children ?? []);
          }
        };
        walk(quest.objectives);
        return { id: quest.id, title: quest.title, description: quest.description, state: quest.state, pinned: quest.pinned, objectives };
      });
    const manifest = client.store.world.assetManifest;
    const images = Array.isArray(config.images)
      ? config.images.flatMap((raw) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
          const image = raw as Record<string, unknown>;
          const assetId = typeof image.assetId === "string" ? image.assetId : "";
          const entry = manifest[assetId];
          if (!/^[a-f0-9]{64}$/i.test(assetId) || !entry || !entry.mime.startsWith("image/") || entry.visibility === "gm") return [];
          return [{ assetId, caption: typeof image.caption === "string" ? image.caption : "", alt: typeof image.alt === "string" ? image.alt : "" }];
        })
      : [];
    const timeline = Array.isArray(config.events)
      ? config.events.flatMap((raw) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
          const event = raw as Record<string, unknown>;
          if (typeof event.id !== "string" || typeof event.title !== "string" || typeof event.date !== "string") return [];
          return [{ id: event.id, title: event.title, date: event.date,
            description: typeof event.description === "string" ? event.description : "",
            order: typeof event.order === "number" ? event.order : 0 }];
        }).sort((a, b) => a.order - b.order || a.date.localeCompare(b.date))
      : [];
    let scene: CodexWidgetViewModel["scene"] = null;
    if (typeof config.linkId === "string") {
      const link = sheet?.codex?.links.find((candidate) => candidate.id === config.linkId && candidate.relation === "linksScene");
      const target = link ? client.store.resolve(link.target) : undefined;
      if (target?.type === "scene") {
        const sceneDoc = target as SceneDocument;
        const img = typeof sceneDoc.img === "string" && /^[a-f0-9]{64}$/i.test(sceneDoc.img) && manifest[sceneDoc.img]?.visibility !== "gm"
          ? sceneDoc.img : null;
        scene = { name: sceneDoc.name, imageAssetId: img };
      }
    }
    let rollTable: CodexWidgetViewModel["rollTable"] = null;
    if (typeof config.tableId === "string") {
      const table = widgetRollTables.find((candidate) => candidate._id === config.tableId);
      if (table) rollTable = { name: table.name, formula: table.formula,
        results: table.results.map((result) => ({ range: result.range, text: result.text })) };
    }
    return { links, quests, images, timeline, scene, rollTable };
  }

  function updateWidgetConfig(id: string, config: Record<string, unknown>): void {
    patchWidget(id, { config: config as Json });
  }

  function saveWidgetMigration(widget: CodexWidgetInstance): void {
    patchWidget(widget.id, { version: widget.version, config: widget.config });
  }

  function addGalleryImage(widget: CodexWidgetInstance): void {
    const config = widgetConfig(widget);
    const images = Array.isArray(config.images) ? [...config.images] : [];
    const entry = client.store.world.assetManifest[widgetAssetId];
    if (!widgetAssetId || !entry || !entry.mime.startsWith("image/") || entry.visibility === "gm" || images.length >= 40) return;
    if (images.some((image) => image && typeof image === "object" && !Array.isArray(image) && (image as Record<string, unknown>).assetId === widgetAssetId)) return;
    images.push({ assetId: widgetAssetId, caption: widgetAssetCaption.trim(), alt: widgetAssetAlt.trim() });
    updateWidgetConfig(widget.id, { ...config, images });
    widgetAssetId = "";
    widgetAssetCaption = "";
    widgetAssetAlt = "";
  }

  function patchGalleryImage(widget: CodexWidgetInstance, index: number, patch: { caption?: string; alt?: string }): void {
    const config = widgetConfig(widget);
    const images = Array.isArray(config.images) ? config.images.map((image) => image && typeof image === "object" ? { ...(image as Record<string, unknown>) } : image) : [];
    const image = images[index];
    if (!image || typeof image !== "object" || Array.isArray(image)) return;
    images[index] = { ...image as Record<string, unknown>, ...patch };
    updateWidgetConfig(widget.id, { ...config, images });
  }

  function removeGalleryImage(widget: CodexWidgetInstance, index: number): void {
    const config = widgetConfig(widget);
    const images = Array.isArray(config.images) ? config.images.filter((_, row) => row !== index) : [];
    updateWidgetConfig(widget.id, { ...config, images });
  }

  function addTimelineEvent(widget: CodexWidgetInstance): void {
    const title = widgetEventTitle.trim();
    const date = widgetEventDate.trim();
    if (!title || !date) return;
    const config = widgetConfig(widget);
    const events = Array.isArray(config.events) ? [...config.events] : [];
    if (events.length >= 100) return;
    events.push({ id: UID(), date, title, description: widgetEventDescription.trim(), order: events.length });
    updateWidgetConfig(widget.id, { ...config, events });
    widgetEventTitle = "";
    widgetEventDate = "";
    widgetEventDescription = "";
  }

  function removeTimelineEvent(widget: CodexWidgetInstance, eventId: string): void {
    const config = widgetConfig(widget);
    const events = Array.isArray(config.events) ? config.events.filter((event) =>
      !event || typeof event !== "object" || Array.isArray(event) || (event as Record<string, unknown>).id !== eventId,
    ) : [];
    updateWidgetConfig(widget.id, { ...config, events: events.map((event, order) =>
      event && typeof event === "object" && !Array.isArray(event) ? { ...(event as Record<string, unknown>), order } : event,
    ) });
  }

  function moveWidget(widget: CodexWidgetInstance, offset: -1 | 1): void {
    if (!sheet?.codex) return;
    const widgets = [...sheet.codex.widgets].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const index = widgets.findIndex((item) => item.id === widget.id);
    const destination = index + offset;
    if (index < 0 || destination < 0 || destination >= widgets.length) return;
    [widgets[index], widgets[destination]] = [widgets[destination]!, widgets[index]!];
    updateSheet({ ...sheet.codex, widgets: widgets.map((item, order) => ({ ...item, order })) });
  }

  $effect(() => {
    if (!sheet) return;
    basicsName = sheet.name;
    basicsKind = sheet.codex?.kind ?? "entry";
    basicsSubtitle = sheet.codex?.subtitle ?? "";
    basicsTags = (sheet.taggerTags ?? []).join(", ");
    basicsCover = sheet.codex?.cover ?? "";
  });

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", (envelope) => {
      refresh();
      if (pendingBundleTxId !== null && envelope.txId === pendingBundleTxId) {
        pendingBundleTxId = null;
        bundleMessage = "Codex bundle import committed successfully.";
      }
    });
    const offRejected = bus.on("rejected", (event) => {
      if (pendingBundleTxId !== null && event.txId === pendingBundleTxId) {
        pendingBundleTxId = null;
        bundleMessage = `Bundle transaction rejected (${event.reason}): ${event.detail}`;
      } else {
        operationMessage = `Not saved (${event.reason}): ${event.detail}`;
      }
    });
    const offPurchase = bus.on("codexPurchaseResult", (event) => {
      if (pendingPurchaseRequestId !== event.requestId) return;
      pendingPurchaseRequestId = null;
      operationMessage = event.detail;
    });
    refresh();
    return () => {
      offSnapshot();
      offOps();
      offRejected();
      offPurchase();
    };
  });
</script>

<section class="codex" data-campaign-codex aria-label="Campaign Codex">
  <header class="codex-header">
    <div>
      <h3>Campaign Codex</h3>
      <p class="muted">
        Connected campaign records, filtered to what you can read.
      </p>
    </div>
    {#if isGm}
      <div class="preview-tools">
        <label>
          Preview as player
          <select
            aria-label="Preview Campaign Codex as player"
            value={previewUserId ?? ""}
            onchange={(event) => {
              previewUserId = event.currentTarget.value || null;
              selectedId = null;
              backStack = [];
              pageId = null;
              editingPage = false;
            }}
          >
            <option value="">GM view</option>
            {#each audienceUsers.filter((user) => user.role !== "GM" && user.role !== "ASSISTANT") as user (user._id)}
              <option value={user._id}>{user.name} ({user.role.toLocaleLowerCase()})</option>
            {/each}
          </select>
        </label>
        {#if previewUserId}
          <span class="preview-badge">Read-only permission preview</span>
          <button type="button" class="secondary" onclick={() => (previewUserId = null)}>Stop preview</button>
        {/if}
      </div>
    {/if}
    {#if canEdit}
      <details class="create-sheet">
        <summary>New Codex sheet</summary>
        <label
          >Sheet name <input
            aria-label="New Codex sheet name"
            bind:value={createName}
            placeholder="e.g. The Silver Circle"
          /></label
        >
        <label
          >Role
          <select aria-label="New Codex sheet role" bind:value={createKind}>
            {#each KINDS as kind (kind.value)}<option value={kind.value}
                >{kind.label}</option
              >{/each}
          </select>
        </label>
        <button type="button" data-codex-create onclick={submitCreate}
          >Create sheet</button
        >
      </details>
      <details class="create-sheet">
        <summary>Convert a journal</summary>
        <label>
          Existing journal
          <select
            aria-label="Journal to convert"
            value={convertJournalId}
            onchange={(event) => {
              convertJournalId = event.currentTarget.value;
              conversionPreviewId = null;
            }}
          >
            <option value="">Choose an ordinary journal</option>
            {#each ordinaryJournals as journal (journal._id)}
              <option value={journal._id}>{journal.name} · {journal.pages.length} page(s)</option>
            {/each}
          </select>
        </label>
        <button type="button" disabled={!selectedOrdinaryJournal} onclick={previewConversion}>Preview conversion</button>
        {#if selectedOrdinaryJournal && conversionPreviewId === selectedOrdinaryJournal._id}
          <div class="conversion-preview" role="status">
            <strong>Preview: {selectedOrdinaryJournal.name}</strong>
            <p>{selectedOrdinaryJournal.pages.length} existing page(s), text, ownership, and ordering will be retained. An Info tab and Entry role will be added; no links, quests, or widgets are created.</p>
            <button type="button" onclick={convertJournal}>Convert journal</button>
          </div>
        {/if}
      </details>
      {#if convertedJournalId}
        <button type="button" class="secondary" onclick={undoConversion}>Undo last conversion</button>
      {/if}
    {/if}
  </header>

  {#if viewUser}
    <section class="bundle-tools panel-section" aria-labelledby="codex-bundle-heading">
      <h4 id="codex-bundle-heading">Selected-content exports</h4>
      <p class="muted">Exports contain only records readable by the current viewer (or the selected audience preview). A Codex bundle is separate from the private full-world ZIP backup.</p>
      <div class="bundle-root-list" aria-label="Codex export roots">
        {#each viewSheets as candidate (candidate._id)}
          <label class="choice">
            <input type="checkbox" checked={selectedBundleRoots.includes(candidate._id)}
              onchange={(event) => toggleBundleRoot(candidate._id, event.currentTarget.checked)} />
            {candidate.name} · {KINDS.find((kind) => kind.value === candidate.codex?.kind)?.label ?? "Codex"}
          </label>
        {/each}
      </div>
      <div class="row">
        <button type="button" disabled={selectedBundleRoots.length === 0 || bundleBusy}
          onclick={() => void exportSelectedBundle()}>{bundleBusy ? "Working…" : "Export selected bundle"}</button>
        <label>Markdown links
          <select aria-label="Markdown export link style" bind:value={markdownLinkStyle} disabled={bundleBusy}>
            <option value="markdown">Standard Markdown</option>
            <option value="obsidian">Obsidian wikilinks</option>
          </select>
        </label>
        <button type="button" class="secondary" disabled={selectedBundleRoots.length === 0 || bundleBusy}
          onclick={() => void exportSelectedMarkdown()}>{bundleBusy ? "Working…" : "Export Markdown"}</button>
        {#if canEdit}
          <label class="bundle-file">Import selected bundle
            <input type="file" accept=".zip,.codex.zip,application/zip" disabled={bundleBusy}
              onchange={(event) => void loadBundleFile(event)} />
          </label>
        {/if}
      </div>
      {#if canEdit && bundleImport}
        <div class="bundle-preview" role="region" aria-label="Codex bundle import preview">
          <strong>Import preview</strong>
          <p>Roots: {bundleImport.parsed.bundle.roots.map((ref) => bundleImport.parsed.bundle.documents.journals.find((entry) => entry._id === ref.id)?.name ?? "Codex sheet").join(", ")}</p>
          <p>Readable closure: {Object.entries(bundleImport.parsed.bundle.report.included).map(([coll, count]) => `${count} ${coll}`).join(" · ")}</p>
          {#if bundleImport.parsed.bundle.report.omittedMedia > 0}
            <p class="warning">Some media was omitted because export rights or local bytes were unavailable.</p>
          {/if}
          {#if bundleImport.parsed.bundle.report.hasUnavailableDependencies}
            <p class="warning">Some dependencies were unavailable to the exporter and were not included.</p>
          {/if}
          {#if bundleImport.parsed.bundle.report.hasPortablePermissionResets}
            <p class="warning">Source-world user grants were removed or made GM-only. Review access rules before publishing this imported content.</p>
          {/if}
          {#if bundlePlan?.conflicts.length}
            <h5>Matched-document choices</h5>
            {#each bundlePlan.conflicts as conflict (conflict.key)}
              <label class="bundle-conflict">{conflict.collection}: {conflict.sourceName}
                <select aria-label={`Conflict choice for ${conflict.sourceName}`} value={bundleChoiceValue(conflict.key)}
                  onchange={(event) => changeBundleConflict(conflict.key, event.currentTarget.value)}>
                  <option value="">Choose a conflict action…</option>
                  <option value="skip">Skip incoming record</option>
                  {#each conflict.candidates as candidate (candidate.id)}
                    <option value={`link:${candidate.id}`}>Link to existing: {candidate.name}</option>
                    <option value={`replace:${candidate.id}`}>Replace existing: {candidate.name}</option>
                  {/each}
                </select>
              </label>
            {/each}
          {/if}
          {#if bundlePlan?.warnings.length}
            <ul class="bundle-warnings">{#each bundlePlan.warnings as warning (warning)}<li>{warning}</li>{/each}</ul>
          {/if}
          <div class="row">
            <button type="button" disabled={!bundlePlan?.ready || bundleBusy} onclick={() => void commitBundleImport()}>
              Import atomically ({bundlePlan?.ops.length ?? 0} document op(s))
            </button>
            <button type="button" class="secondary" disabled={bundleBusy} onclick={closeBundleImport}>Cancel import</button>
          </div>
        </div>
      {/if}
      {#if bundleMessage}<p class="bundle-message" role="status">{bundleMessage}</p>{/if}
    </section>
  {/if}

  <div class="codex-layout">
    <aside class="hub" aria-label="Codex navigator">
      <label class="search"
        >Search <input
          type="search"
          aria-label="Search Codex"
          bind:value={query}
          placeholder="Name or subtitle"
        /></label
      >
      <label
        >Role
        <select aria-label="Filter Codex by role" bind:value={kindFilter}>
          <option value="all">All roles</option>
          {#each KINDS as kind (kind.value)}<option value={kind.value}
              >{kind.label}</option
            >{/each}
        </select>
      </label>
      <label>
        Codex tag
        <select aria-label="Filter Codex by tag" bind:value={tagFilter}>
          <option value="all">All tags</option>
          {#each tagSheets as tag (tag._id)}<option value={`c:${tag._id}`}>Codex · {tag.name}</option>{/each}
          {#each taggerTagNames as tag (tag)}<option value={`t:${tag}`}>Tagger · {tag}</option>{/each}
        </select>
      </label>
      <div class="navigation-tools">
        <button type="button" data-codex-back disabled={backStack.length === 0} onclick={goBack}>Back</button>
        {#if recentSheets.length > 0}
          <details>
            <summary>Recent</summary>
            <ul class="recent-list">
              {#each recentSheets as recent (recent._id)}
                <li><button type="button" onclick={() => selectSheet(recent)}>{recent.name}</button></li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>
      {#if filteredSheets.length === 0}
        <p class="empty">
          {viewSheets.length
            ? "No sheets match these filters."
            : "No Codex sheets are shared with you yet."}
        </p>
      {:else}
        <ul class="sheet-list">
          {#each filteredSheets as item (item._id)}
            <li>
              <button
                type="button"
                data-codex-sheet={item._id}
                class:selected={item._id === selectedId}
                draggable={canEdit}
                ondragstart={(event) => dragJournalChoice(event, item._id)}
                onclick={() => selectSheet(item)}
              >
                <span class="kind"
                  >{KINDS.find((kind) => kind.value === item.codex?.kind)
                    ?.label ?? "Codex"}</span
                >
                <strong>{item.name}</strong>
                {#if item.codex?.subtitle}<small>{item.codex.subtitle}</small
                  >{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    <main class="sheet" aria-live="polite">
      {#if !sheet || !sheet.codex}
        <div class="empty-sheet">
          <h4>Choose a Codex sheet</h4>
          <p>Campaign records appear here when they are shared with you.</p>
        </div>
      {:else}
        {#if parentChain.length > 0}
          <nav class="breadcrumbs" aria-label="Codex hierarchy">
            {#each parentChain as ancestor (ancestor._id)}
              <button type="button" onclick={() => selectSheet(ancestor)}>{ancestor.name}</button>
              <span aria-hidden="true">›</span>
            {/each}
            <span aria-current="page">{sheet.name}</span>
          </nav>
        {/if}
        <header class="sheet-heading">
          <div>
            <div class="eyebrow">
              {KINDS.find((kind) => kind.value === sheet.codex?.kind)?.label ??
                "Codex"}
            </div>
            <h2>{sheet.name}</h2>
            {#if sheet.codex.subtitle}<p>{sheet.codex.subtitle}</p>{/if}
          </div>
          {#if canEdit}<span class="gm-badge">GM editor</span>{/if}
        </header>
        {#if sheet.codex.cover && /^[a-f0-9]{64}$/i.test(sheet.codex.cover)}
          <figure class="codex-cover">
            {#if resolveAsset?.(sheet.codex.cover)}
              <img src={resolveAsset?.(sheet.codex.cover) ?? undefined} alt={`${sheet.name} cover`} loading="lazy" />
            {:else}
              <figcaption role="status">Cover image is not available in this local asset cache.</figcaption>
            {/if}
          </figure>
        {/if}

        <nav class="tabs" aria-label="Codex tabs">
          {#each tabs as tab, index (tab.key)}
            <div class="tab-item">
              <button
                type="button"
                data-codex-tab={tab.key}
                class:selected={tab.key === activeTab?.key}
                onclick={() => selectTab(tab)}>{tab.label}</button
              >
              {#if canEdit}
                <button type="button" class="secondary tiny" aria-label={`Move ${tab.label} tab up`}
                  disabled={index === 0} onclick={() => moveTab(tab.key, -1)}>↑</button>
                <button type="button" class="secondary tiny" aria-label={`Move ${tab.label} tab down`}
                  disabled={index === tabs.length - 1} onclick={() => moveTab(tab.key, 1)}>↓</button>
              {/if}
            </div>
          {/each}
        </nav>

        {#if canEdit && activeTab}
          <div class="page-tools">
            <label
              >Page <select
                aria-label="Codex page"
                value={page?._id ?? ""}
                onchange={(event) => {
                  pageId = event.currentTarget.value;
                  editingPage = false;
                }}
              >
                {#each pages as item (item._id)}<option value={item._id}
                    >{item.codex?.label ?? item.name}</option
                  >{/each}
              </select></label
            >
            {#if page}
              <button type="button" class="secondary" aria-label={`Move ${page.codex?.label ?? page.name} page up`}
                disabled={pages[0]?._id === page._id} onclick={() => movePage(page._id, -1)}>↑</button>
              <button type="button" class="secondary" aria-label={`Move ${page.codex?.label ?? page.name} page down`}
                disabled={pages.at(-1)?._id === page._id} onclick={() => movePage(page._id, 1)}>↓</button>
            {/if}
            <details>
              <summary>Add tab</summary><label
                >Tab name <input
                  aria-label="New Codex tab name"
                  bind:value={newTabLabel}
                /></label
              ><button type="button" onclick={addTab}>Add tab</button>
            </details>
            <details>
              <summary>Add page</summary><label
                >Page name <input
                  aria-label="New Codex page name"
                  bind:value={newPageName}
                /></label
              ><button type="button" onclick={addPage}>Add page</button>
            </details>
          </div>
        {/if}

        {#if activeTab && canEdit}
          <div class="audience-control">
            <CodexAudienceEditor
              label="Tab audience"
              audience={activeTab.audience}
              users={audienceUsers}
              onChange={(audience) => setTabAudience(activeTab.key, audience)}
            />
            {#if page}
              <CodexAudienceEditor
                label="Page audience"
                audience={page.codex?.audience}
                users={audienceUsers}
                onChange={setPageAudience}
              />
            {/if}
          </div>
        {/if}

        {#if page}
          <section class="page-content" aria-label="Codex page">
            <header>
              <h3>{page.codex?.label ?? page.name}</h3>
              {#if canEdit && !editingPage}<button
                  type="button"
                  onclick={() => {
                    pageDraft = page.text;
                    editingPage = true;
                  }}>Edit page</button
                >{/if}
            </header>
            {#if editingPage && canEdit}
              <textarea
                aria-label="Codex page text"
                rows="12"
                bind:value={pageDraft}></textarea>
              <div class="row">
                <button type="button" onclick={savePage}>Save page</button
                ><button
                  type="button"
                  class="secondary"
                  onclick={() => (editingPage = false)}>Cancel</button
                >
              </div>
            {:else}
              <JournalPage
                {client}
                journalId={sheet._id}
                pageId={page._id}
                text={page.text}
                revealSecrets={canEdit}
              />
            {/if}
          </section>
        {:else}
          <p class="empty">This tab has no pages yet.</p>
        {/if}

        <section class="panel-section" aria-labelledby="codex-links-heading">
          <h3 id="codex-links-heading">Relationships</h3>
          {#if sheet.codex.links.length === 0}<p class="muted">
              No linked records.
            </p>{/if}
          <ul class="card-list">
            {#each sheet.codex.links as link (link.id)}
              <li class="link-card">
                <span class="relation">{link.relation}</span><strong
                  >{link.label ?? linkName(link)}</strong
                >
                {#if link.target.coll === "journals"}<button
                    type="button"
                    class="secondary"
                    onclick={() => {
                      const target = viewSheets.find(
                        (item) => item._id === link.target.id,
                      );
                      if (target?.codex) selectSheet(target);
                    }}>Open sheet</button
                  >{/if}
                {#if canEdit}<button
                    type="button"
                    class="danger"
                    aria-label={`Remove link to ${linkName(link)}`}
                    onclick={() => removeLink(link.id)}>Remove</button
                  >{/if}
              </li>
            {/each}
          </ul>
          {#if canEdit}
            <details class="editor">
              <summary>Add relationship</summary>
              <label>Search visible targets
                <input aria-label="Search relationship targets" type="search" bind:value={linkTargetSearch}
                  placeholder="Journal, actor, item, scene…" />
              </label>
              <label
                >Target <select
                  aria-label="Relationship target"
                  bind:value={newLinkTarget}
                  ><option value="">Choose a visible document</option
                  >{#each filteredTargetChoices as choice (choice.key)}<option
                      value={choice.key}>{choice.label}</option
                    >{/each}</select
                ></label
              >
              <ul class="drag-target-list" aria-label="Draggable visible relationship targets">
                {#each filteredTargetChoices.slice(0, 12) as choice (choice.key)}
                  <li><button type="button" class="secondary" draggable="true" aria-label={`Select or drag ${choice.label}`}
                    onclick={() => { newLinkTarget = choice.key; }} ondragstart={(event) => dragLinkChoice(event, choice)}>{choice.label}</button></li>
                {/each}
              </ul>
              <div class="relationship-drop" role="region" aria-label="Relationship drop target"
                ondragover={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "link"; }}
                ondrop={acceptRelationshipDrop}>
                Drop a visible journal here to preselect it; confirm by adding the relationship below.
              </div>
              {#if selectedTarget}<label
                  >Relationship
                  <select
                    aria-label="Relationship type"
                    bind:value={newLinkRelation}
                    >{#each relationChoices as relation (relation)}<option
                        value={relation}>{relation}</option
                      >{/each}</select
                  >
                </label>{/if}
              <label
                >Label (optional) <input
                  aria-label="Relationship label"
                  bind:value={newLinkLabel}
                /></label
              >
              <button type="button" disabled={!selectedTarget} onclick={addLink}
                >Add relationship</button
              >
            </details>
          {/if}
        </section>

        {#if sheet.codex.kind === "npc"}
          <section class="panel-section" aria-labelledby="codex-npc-heading">
            <h3 id="codex-npc-heading">Character profile</h3>
            {#each sheet.codex.links.filter((link) => link.relation === "representsActor") as link (link.id)}
              {@const actor = client.store.resolve(link.target)}
              <article class="role-card">
                <strong>{actor?.type === "actor" ? actor.name : "Unavailable actor"}</strong>
                <span>{actor?.type === "actor" ? actor.type : "The linked actor is not readable or no longer exists."}</span>
              </article>
            {/each}
            {#if !sheet.codex.links.some((link) => link.relation === "representsActor")}
              <p class="muted">Link an Actor using “Represents Actor” to connect game stats.</p>
            {/if}
          </section>
        {/if}

        {#if sheet.codex.kind === "region" || sheet.codex.kind === "location"}
          <section class="panel-section" aria-labelledby="codex-scenes-heading">
            <h3 id="codex-scenes-heading">{sheet.codex.kind === "region" ? "Region scenes" : "Location scenes"}</h3>
            {#each sheet.codex.links.filter((link) => link.relation === "linksScene") as link (link.id)}
              {@const scene = client.store.resolve(link.target)}
              <article class="role-card"><strong>{scene?.type === "scene" ? scene.name : "Unavailable scene"}</strong><span>{link.label ?? "Linked scene"}</span></article>
            {/each}
            {#if !sheet.codex.links.some((link) => link.relation === "linksScene")}
              <p class="muted">No readable scenes linked.</p>
            {/if}
          </section>
        {/if}

        {#if sheet.codex.kind === "tag"}
          <section class="panel-section" aria-labelledby="codex-tag-heading">
            <h3 id="codex-tag-heading">Tagged records</h3>
            {#if sheet.codex.links.length === 0}<p class="muted">Link records to apply this Codex tag.</p>{/if}
            <ul class="card-list">
              {#each sheet.codex.links as link (link.id)}
                <li class="link-card"><span class="relation">{link.target.coll}</span><strong>{linkName(link)}</strong></li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if backlinks.length > 0}
          <section class="panel-section" aria-labelledby="codex-backlinks-heading">
            <h3 id="codex-backlinks-heading">Referenced from</h3>
            <ul class="card-list">
              {#each backlinks as backlink (`${backlink.source._id}:${backlink.link.id}`)}
                <li class="link-card">
                  <span class="relation">{backlink.link.relation}</span>
                  <strong>{backlink.source.name}</strong>
                  <button type="button" class="secondary" onclick={() => selectSheet(backlink.source)}>Open source</button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if sheet.codex.kind === "group" || sheet.codex.kind === "region"}
          <section class="panel-section" aria-labelledby="codex-children-heading">
            <h3 id="codex-children-heading">{sheet.codex.kind === "group" ? "Group tree" : "Regional hierarchy"}</h3>
            {#if groupTree.length === 0}<p class="muted">No readable child records are linked.</p>{/if}
            <ul class="card-list tree-list">
              {#each groupTree as row (`${row.depth}:${row.journal._id}`)}
                <li style={`--tree-depth:${row.depth}`}>
                  <span class="kind">{KINDS.find((kind) => kind.value === row.journal.codex?.kind)?.label ?? "Codex"}</span>
                  <strong>{row.journal.name}</strong>
                  <button type="button" class="secondary" onclick={() => selectSheet(row.journal)}>Open</button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="panel-section" aria-labelledby="codex-quests-heading">
          <h3 id="codex-quests-heading">Quests</h3>
          {#if (sheet.codex.quests ?? []).length === 0}<p class="muted">
              No published quests.
            </p>{/if}
          {#each [...(sheet.codex.quests ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order) as quest (quest.id)}
            <article class="quest-card">
              <header>
                <div>
                  <strong>{quest.title}</strong>{#if quest.pinned}<span
                      class="pin">Pinned</span
                    >{/if}
                </div>
                <span class="state">{quest.state}</span>
              </header>
              {#if quest.description}<p>{quest.description}</p>{/if}
              <ul class="objectives">
                {#each objectiveRows(quest.objectives) as row (row.objective.id)}
                  {@const objective = row.objective}
                  <li class:complete={objective.completed} style={`padding-left:${row.depth * 14}px`}>
                    <span aria-hidden="true">{objective.completed ? "✓" : "○"}</span>
                    <span>{objective.title}</span>
                    {#if canEdit}
                      <details class="objective-audience">
                        <summary>Audience</summary>
                        <CodexAudienceEditor
                          label={`Audience for ${objective.title}`}
                          audience={objective.audience}
                          users={audienceUsers}
                          onChange={(audience) => patchObjective(quest, objective.id, { audience })}
                        />
                      </details>
                      <button type="button" class="tiny" aria-label={`Toggle objective ${objective.title}`}
                        onclick={() => patchObjective(quest, objective.id, { completed: !objective.completed })}
                        >{objective.completed ? "Reopen" : "Complete"}</button>
                      <button type="button" class="tiny" aria-label={`Move objective ${objective.title} up`}
                        disabled={row.index === 0} onclick={() => moveObjective(quest, objective.id, -1)}>↑</button>
                      <button type="button" class="tiny" aria-label={`Move objective ${objective.title} down`}
                        disabled={row.index === row.count - 1} onclick={() => moveObjective(quest, objective.id, 1)}>↓</button>
                      <details class="objective-audience">
                        <summary>Add sub-objective</summary>
                        <input aria-label={`New sub-objective for ${objective.title}`}
                          value={objectiveDrafts[`${quest.id}:${objective.id}`] ?? ""}
                          oninput={(event) => objectiveDrafts = { ...objectiveDrafts,
                            [`${quest.id}:${objective.id}`]: event.currentTarget.value }} />
                        <button type="button" class="tiny" disabled={!(objectiveDrafts[`${quest.id}:${objective.id}`] ?? "").trim()}
                          onclick={() => addSubObjective(quest, objective.id)}>Add sub-objective</button>
                      </details>
                    {/if}
                  </li>
                {/each}
              </ul>
              {#if canEdit}<div class="quest-controls">
                  <CodexAudienceEditor
                    label={`Audience for ${quest.title}`}
                    audience={quest.audience}
                    users={audienceUsers}
                    onChange={(audience) => patchQuest(quest.id, { audience })}
                  />
                  <button
                    type="button"
                    class="secondary"
                    onclick={() =>
                      patchQuest(quest.id, { pinned: !quest.pinned })}
                    >{quest.pinned ? "Unpin" : "Pin"}</button
                  >
                  <button type="button" class="secondary" aria-label={`Move quest ${quest.title} up`}
                    disabled={questMoveDisabled(quest.id, -1)} onclick={() => moveQuest(quest.id, -1)}>↑</button>
                  <button type="button" class="secondary" aria-label={`Move quest ${quest.title} down`}
                    disabled={questMoveDisabled(quest.id, 1)} onclick={() => moveQuest(quest.id, 1)}>↓</button>
                  <select
                    aria-label={`State for ${quest.title}`}
                    value={quest.state}
                    onchange={(event) =>
                      patchQuest(quest.id, {
                        state: event.currentTarget.value as CodexQuest["state"],
                      })}
                    ><option value="active">Active</option><option
                      value="completed">Completed</option
                    ><option value="failed">Failed</option></select
                  >
                  <label class="objective-add"
                    >Add objective <input
                      aria-label={`New objective for ${quest.title}`}
                      value={objectiveDrafts[quest.id] ?? ""}
                      oninput={(event) =>
                        (objectiveDrafts = {
                          ...objectiveDrafts,
                          [quest.id]: event.currentTarget.value,
                        })}
                    /></label
                  >
                  <button type="button" onclick={() => addObjective(quest)}
                    >Add objective</button
                  >
                </div>{/if}
            </article>
          {/each}
          {#if canEdit}<details class="editor">
              <summary>Add quest</summary><label
                >Quest title <input
                  aria-label="New quest title"
                  bind:value={newQuestTitle}
                /></label
              ><button
                type="button"
                disabled={!newQuestTitle.trim()}
                onclick={addQuest}>Create quest</button
              >
            </details>{/if}
        </section>

        <section class="panel-section" aria-labelledby="codex-widgets-heading">
          <h3 id="codex-widgets-heading">Widgets</h3>
          {#each [...sheet.codex.widgets].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).filter((widget) => widget.enabled || canEdit) as widget (widget.id)}
            {@const exactRegistration = getCodexWidget(widget.type, widget.version)}
            {@const registration = exactRegistration ?? getCurrentCodexWidget(widget.type)}
            {@const preparedWidget = registration ? prepareCodexWidget(widget, registration) : null}
            {@const config = preparedWidget?.ok ? widgetConfig(preparedWidget.widget) : widgetConfig(widget)}
            {@const WidgetRenderer = registration?.renderer}
            <article class="widget-card" data-codex-widget={widget.type}>
              <header>
                <div>
                  <strong>{registration?.type === widget.type ? widget.type : `${widget.type} · unsupported`}</strong>
                  {#if !widget.enabled}<span class="muted">Disabled</span>{/if}
                </div>
                {#if canEdit}
                  <div class="widget-controls">
                    <label>Tab <select aria-label={`Tab for ${widget.type} widget`} value={widget.tab}
                      onchange={(event) => patchWidget(widget.id, { tab: event.currentTarget.value })}>
                      {#each tabs as tab (tab.key)}<option value={tab.key}>{tab.label}</option>{/each}
                    </select></label>
                    <button type="button" class="secondary" aria-label={`Move ${widget.type} widget up`} onclick={() => moveWidget(widget, -1)}>↑</button>
                    <button type="button" class="secondary" aria-label={`Move ${widget.type} widget down`} onclick={() => moveWidget(widget, 1)}>↓</button>
                    <CodexAudienceEditor label={`Audience for widget ${widget.type}`} audience={widget.audience}
                      users={audienceUsers} onChange={(audience) => patchWidget(widget.id, { audience })} />
                    <button type="button" class="secondary" onclick={() => patchWidget(widget.id, { enabled: !widget.enabled })}>{widget.enabled ? "Disable" : "Enable"}</button>
                    <button type="button" class="danger" onclick={() => updateSheet({ ...sheet.codex,
                      widgets: sheet.codex.widgets.filter((item) => item.id !== widget.id) })}>Remove</button>
                  </div>
                {/if}
              </header>
              {#if widget.enabled && WidgetRenderer && preparedWidget?.ok}
                <WidgetRenderer widget={preparedWidget.widget}
                  view={codexWidgetViewForCapabilities(widgetView(preparedWidget.widget), registration?.capabilities ?? [])}
                  {resolveAsset}
                  onOpenSheet={(id) => { const target = viewSheets.find((candidate) => candidate._id === id); if (target) selectSheet(target); }} />
                {#if preparedWidget.migrated && canEdit}
                  <p class="warning">A trusted migration can update this widget from v{widget.version} to v{preparedWidget.widget.version}. Saved data has not changed yet.</p>
                  <button type="button" onclick={() => saveWidgetMigration(preparedWidget.widget)}>Save migrated config</button>
                {/if}
              {:else if widget.enabled && registration && preparedWidget && !preparedWidget.ok}
                <p class="muted">{preparedWidget.error} The renderer was not run; the original saved data is preserved for repair.</p>
              {:else if widget.enabled}
                <p class="muted">No trusted renderer is registered for this widget version. Data is preserved and not executed.</p>
              {:else}
                <p class="muted">This widget is disabled. Its configuration is preserved.</p>
              {/if}
              {#if canEdit && registration && preparedWidget?.ok && !preparedWidget.migrated}
                <details class="widget-editor" open={widgetEditorId === widget.id} ontoggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) widgetEditorId = widget.id; else if (widgetEditorId === widget.id) widgetEditorId = null; }}>
                  <summary>Configure {widget.type}</summary>
                  {#if widget.type === "linked-entities"}
                    <label>Relationship filter <select value={typeof config.relation === "string" ? config.relation : ""}
                      onchange={(event) => { const value = event.currentTarget.value; const next = { ...widgetConfig(widget) }; if (value) next.relation = value; else delete next.relation; updateWidgetConfig(widget.id, next); }}>
                      <option value="">All relationships</option>
                      {#each ["contains", "locatedAt", "associatedWith", "operatedBy", "representsActor", "linksScene", "linksItem", "relatedTo"] as relation (relation)}<option value={relation}>{relation}</option>{/each}
                    </select></label>
                    <label>Maximum records <input type="number" min="1" max="50" step="1" value={typeof config.maxItems === "number" ? config.maxItems : 50}
                      onchange={(event) => patchWidgetConfigField(widget, "maxItems", Math.min(50, Math.max(1, Number(event.currentTarget.value) || 1)))} /></label>
                    <fieldset><legend>Included relationships</legend>
                      {#each sheet.codex.links as link (link.id)}
                        <label class="choice"><input type="checkbox" checked={widgetIdChecked(widget, "linkIds", link.id)}
                          onchange={(event) => toggleWidgetId(widget, "linkIds", link.id, event.currentTarget.checked, sheet.codex.links.map((item) => item.id))} />{link.label ?? linkName(link)}</label>
                      {/each}
                    </fieldset>
                  {:else if widget.type === "quest-list"}
                    <label class="choice"><input type="checkbox" checked={config.showCompleted !== false}
                      onchange={(event) => patchWidgetConfigField(widget, "showCompleted", event.currentTarget.checked)} />Show completed quests</label>
                    <fieldset><legend>Included quests</legend>
                      {#each sheet.codex.quests ?? [] as quest (quest.id)}
                        <label class="choice"><input type="checkbox" checked={widgetIdChecked(widget, "questIds", quest.id)}
                          onchange={(event) => toggleWidgetId(widget, "questIds", quest.id, event.currentTarget.checked, (sheet.codex.quests ?? []).map((item) => item.id))} />{quest.title}</label>
                      {/each}
                    </fieldset>
                  {:else if widget.type === "image-gallery"}
                    <div class="widget-add-row">
                      <label>Local image <select bind:value={widgetAssetId}><option value="">Choose an image…</option>
                        {#each widgetAssetChoices as asset (asset.assetId)}<option value={asset.assetId}>{asset.name} · {asset.mime}</option>{/each}
                      </select></label>
                      <label>Caption <input bind:value={widgetAssetCaption} maxlength="240" /></label>
                      <label>Alt text <input bind:value={widgetAssetAlt} maxlength="240" /></label>
                      <button type="button" disabled={!widgetAssetId || (Array.isArray(config.images) && config.images.length >= 40)} onclick={() => addGalleryImage(widget)}>Add image</button>
                    </div>
                    {#if Array.isArray(config.images)}
                      {#each config.images as rawImage, index (index)}
                        {@const image = rawImage && typeof rawImage === "object" && !Array.isArray(rawImage) ? rawImage as Record<string, unknown> : {}}
                        <div class="widget-add-row">
                          <span class="asset-name">{widgetAssetChoices.find((asset) => asset.assetId === image.assetId)?.name ?? String(image.assetId ?? "Unavailable image")}</span>
                          <label>Caption <input value={typeof image.caption === "string" ? image.caption : ""} maxlength="240" onchange={(event) => patchGalleryImage(widget, index, { caption: event.currentTarget.value })} /></label>
                          <label>Alt <input value={typeof image.alt === "string" ? image.alt : ""} maxlength="240" onchange={(event) => patchGalleryImage(widget, index, { alt: event.currentTarget.value })} /></label>
                          <button type="button" class="danger" onclick={() => removeGalleryImage(widget, index)}>Remove image</button>
                        </div>
                      {/each}
                    {/if}
                    <p class="muted">Only locally imported, viewer-authorized image hashes can render. Export rights remain a separate choice.</p>
                  {:else if widget.type === "timeline"}
                    <div class="widget-add-row">
                      <label>Date / era <input bind:value={widgetEventDate} maxlength="80" placeholder="e.g. 3rd Moon, 482" /></label>
                      <label>Event title <input bind:value={widgetEventTitle} maxlength="200" /></label>
                      <label>Description <input bind:value={widgetEventDescription} maxlength="2000" /></label>
                      <button type="button" disabled={!widgetEventDate.trim() || !widgetEventTitle.trim()} onclick={() => addTimelineEvent(widget)}>Add event</button>
                    </div>
                    {#if Array.isArray(config.events)}
                      <ul class="timeline-edit-list">
                        {#each config.events as rawEvent, index (index)}
                          {@const event = rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent) ? rawEvent as Record<string, unknown> : {}}
                          <li><strong>{String(event.date ?? "")}</strong> · {String(event.title ?? "")}
                            <button type="button" class="danger" onclick={() => removeTimelineEvent(widget, String(event.id ?? ""))}>Remove</button></li>
                        {/each}
                      </ul>
                    {/if}
                  {:else if widget.type === "scene-map"}
                    <label>Readable linked scene <select value={typeof config.linkId === "string" ? config.linkId : ""}
                      onchange={(event) => patchWidgetConfigField(widget, "linkId", event.currentTarget.value)}>
                      <option value="">Choose a linked scene…</option>
                      {#each sheet.codex.links.filter((link) => link.relation === "linksScene") as link (link.id)}
                        <option value={link.id}>{link.label ?? linkName(link)}</option>
                      {/each}
                    </select></label>
                    <label>Preview zoom <input type="number" min="0.5" max="2" step="0.1" value={typeof config.zoom === "number" ? config.zoom : 1}
                      onchange={(event) => patchWidgetConfigField(widget, "zoom", Math.min(2, Math.max(0.5, Number(event.currentTarget.value) || 1)))} /></label>
                  {:else if widget.type === "roll-table"}
                    <label>Readable roll table <select value={typeof config.tableId === "string" ? config.tableId : ""}
                      onchange={(event) => patchWidgetConfigField(widget, "tableId", event.currentTarget.value)}>
                      <option value="">Choose a roll table…</option>
                      {#each widgetRollTables as table (table._id)}<option value={table._id}>{table.name} · {table.formula}</option>{/each}
                    </select></label>
                    <label class="choice"><input type="checkbox" checked={config.showRanges !== false}
                      onchange={(event) => patchWidgetConfigField(widget, "showRanges", event.currentTarget.checked)} />Show result ranges</label>
                  {/if}
                </details>
              {/if}
            </article>
          {/each}
          {#if canEdit}<details class="editor">
              <summary>Add widget</summary><label
                >Widget type <select
                  aria-label="Widget type"
                  bind:value={newWidgetType}
                  >{#each WIDGET_TYPES as type (type)}<option value={type}
                      >{type}</option
                    >{/each}</select
                ></label
              ><button type="button" onclick={addWidget}>Add widget</button
              >
              <p class="muted">Registered widgets are read-only views over permission-filtered data. Unsupported types remain inert and are preserved.</p>
            </details>{/if}
        </section>

        {#if sheet.codex.kind === "entry" || sheet.codex.shop}
          <section
            class="panel-section"
            aria-labelledby="codex-inventory-heading"
          >
            <h3 id="codex-inventory-heading">Inventory &amp; shop</h3>
            {#if sheet.codex.shop}
              <p class="muted">
                Mode: {sheet.codex.shop.mode === "loot"
                  ? "Loot"
                  : "Shop"}{#if sheet.codex.shop.currencyLabel}
                  · {sheet.codex.shop.currencyLabel}{/if}
              </p>
              {#if canPurchase && sheet.codex.shop.mode === "shop"}
                <div class="purchase-controls">
                  <label>Character
                    <select aria-label="Character for purchase" bind:value={purchaseActorId}>
                      <option value="">Choose an owned character</option>
                      {#each purchaseActors as actor (actor._id)}<option value={actor._id}>{actor.name}</option>{/each}
                    </select>
                  </label>
                  <label>Quantity
                    <input aria-label="Purchase quantity" type="number" min="1" max="1000" step="1" value={purchaseQuantity}
                      onchange={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (Number.isSafeInteger(value)) purchaseQuantity = Math.min(1000, Math.max(1, value));
                      }} />
                  </label>
                </div>
                {#if purchaseActors.length === 0}<p class="muted">No readable character you control can receive this purchase.</p>{/if}
              {:else if previewUserId && sheet.codex.shop.mode === "shop"}
                <p class="muted">Preview only: purchases are disabled. This viewer controls {purchaseActors.length} eligible character(s).</p>
              {/if}
              <ul class="stock-list">
                {#each sheet.codex.shop.stock as stock (stock.id)}
                  {@const target = client.store.resolve(stock.item)}
                  <li>
                    <strong>{target?.name ?? "Unavailable item"}</strong><span
                      >{stock.quantity === null
                        ? "Unlimited"
                        : `Qty ${stock.quantity}`}</span
                    >{#if sheet.codex.shop.mode === "shop"}<span>{priceLabel(stock)}</span>{/if}
                    {#if canEdit}<label
                        >Qty <input
                          aria-label={`Quantity for ${target?.name ?? "item"}`}
                          type="number"
                          min="0"
                          value={stock.quantity ?? ""}
                          onchange={(event) =>
                            setStockQuantity(
                              stock.id,
                              event.currentTarget.value,
                            )}
                        /></label
                      >{#if sheet.codex.shop.mode === "shop"}<label
                          >Price <input
                            aria-label={`Unit price for ${target?.name ?? "item"}`}
                            type="number"
                            min="0"
                            step="0.01"
                            value={stock.unitPrice ?? ""}
                            onchange={(event) =>
                              patchStock(stock.id, {
                                unitPrice: event.currentTarget.value,
                              })}
                          /></label
                        >{/if}<button
                        type="button"
                        class="danger"
                        aria-label={`Remove ${target?.name ?? "stock item"}`}
                        onclick={() => removeStock(stock.id)}>Remove</button
                      >{/if}
                    {#if canPurchase && sheet.codex.shop.mode === "shop"}
                      <button type="button" disabled={!target || !selectedPurchaseActor || pendingPurchaseRequestId !== null || stock.quantity !== null && stock.quantity < purchaseQuantity}
                        onclick={() => purchaseStock(stock.id)}>
                        {pendingPurchaseRequestId ? "Processing…" : `Buy · ${priceLabel(stock)}`}
                      </button>
                    {:else if previewUserId && sheet.codex.shop.mode === "shop"}
                      <button type="button" disabled>Purchase preview</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}<p class="muted">No inventory configured.</p>{/if}
            {#if canEdit}
              <div class="shop-controls">
                <label
                  >Mode <select
                    aria-label="Shop mode"
                    value={sheet.codex.shop?.mode ?? "shop"}
                    onchange={(event) =>
                      setShopMode(event.currentTarget.value as "shop" | "loot")}
                    ><option value="shop">Shop</option><option value="loot"
                      >Loot</option
                    ></select
                  ></label
                >
                <CodexAudienceEditor
                  label="Shop audience"
                  audience={sheet.codex.shop?.audience}
                  users={audienceUsers}
                  onChange={setShopAudience}
                />
                <label
                  >Markup <input
                    aria-label="Shop markup"
                    type="number"
                    min="0"
                    max="1000"
                    step="0.01"
                    value={sheet.codex.shop?.markup ?? 1}
                    onchange={(event) =>
                      setShopMarkup(event.currentTarget.value)}
                  /></label
                >
                <label
                  >Currency label <input
                    aria-label="Currency label"
                    value={sheet.codex.shop?.currencyLabel ?? ""}
                    onchange={(event) => {
                      const shop = ensureShop();
                      if (shop)
                        saveShop({
                          ...shop,
                          currencyLabel: event.currentTarget.value,
                        });
                    }}
                  /></label
                >
                <label
                  >Add item <select
                    aria-label="Shop item"
                    bind:value={newStockTarget}
                    ><option value="">Choose an item</option
                    >{#each stockChoices as choice (choice.key)}<option
                        value={choice.key}>{choice.label}</option
                      >{/each}</select
                  ></label
                ><button
                  type="button"
                  disabled={!newStockTarget}
                  onclick={addStock}>Add stock</button
                >
              </div>
              <p class="muted">
                PF1e purchases use GP, recheck live ownership/funds/stock on the host, and create a GM-revertible receipt. Unsupported wallets or item-price shapes stay unavailable.
              </p>
            {/if}
          </section>
        {/if}

        {#if canEdit}
          <details class="editor basics-editor">
            <summary>Edit sheet details</summary>
            <label
              >Name <input
                aria-label="Codex sheet name"
                bind:value={basicsName}
              /></label
            >
            <label
              >Role <select
                aria-label="Codex sheet role"
                bind:value={basicsKind}
                >{#each KINDS as kind (kind.value)}<option value={kind.value}
                    >{kind.label}</option
                  >{/each}</select
              ></label
            >
            <label
              >Subtitle <input
                aria-label="Codex sheet subtitle"
                bind:value={basicsSubtitle}
              /></label
            >
            <label>Cover image
              <select aria-label="Codex cover image" bind:value={basicsCover}>
                <option value="">No cover</option>
                {#each widgetAssetChoices as asset (asset.assetId)}<option value={asset.assetId}>{asset.name} · {asset.mime}</option>{/each}
              </select>
            </label>
            <label
              >Tagger tags (comma-separated; separate from Codex Tag sheets) <input
                aria-label="Codex Tagger tags"
                bind:value={basicsTags}
                placeholder="e.g. travel, northern"
              /></label
            >
            <button type="button" onclick={saveBasics}>Save details</button>
          </details>
        {/if}
        {#if operationMessage}<p class="status" role="status">
            {operationMessage}
          </p>{/if}
      {/if}
    </main>
  </div>
</section>

<style>
  .codex {
    display: flex;
    flex-direction: column;
    gap: 10px;
    color: var(--text, #e2e8f0);
  }
  .codex-header,
  .sheet-heading,
  .sheet-heading > div,
  .page-content > header,
  .quest-card > header,
  .widget-card,
  .link-card,
  .stock-list li,
  .row,
  .page-tools,
  .audience-control,
  .shop-controls,
  .quest-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .codex-header,
  .sheet-heading,
  .page-content > header,
  .quest-card > header {
    justify-content: space-between;
  }
  .codex-header h3,
  .sheet-heading h2,
  .sheet-heading p,
  .page-content h3,
  .panel-section h3,
  .codex-header p {
    margin: 0;
  }
  .codex-header p,
  .muted,
  .empty,
  .sheet-heading p {
    color: var(--muted, #9aa8b7);
    font-size: 0.9em;
  }
  .codex-header {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .create-sheet,
  .editor {
    border: 1px solid #394655;
    border-radius: 6px;
    padding: 7px;
  }
  .editor [aria-label="Search relationship targets"] { width: 100%; }
  .drag-target-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-height: 92px;
    overflow: auto;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .drag-target-list button { max-width: 100%; overflow-wrap: anywhere; }
  .relationship-drop {
    border: 1px dashed #59718a;
    border-radius: 5px;
    padding: 8px;
    color: #a9bdd1;
    text-align: center;
  }
  .codex-layout {
    display: grid;
    grid-template-columns: minmax(190px, 260px) minmax(0, 1fr);
    gap: 12px;
    align-items: start;
  }
  .hub,
  .sheet {
    min-width: 0;
    background: #121820;
    border: 1px solid #2b3541;
    border-radius: 8px;
    padding: 10px;
  }
  .hub {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hub label,
  .create-sheet label,
  .editor label,
  .page-tools label,
  .quest-controls label,
  .shop-controls label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  input,
  select,
  textarea {
    color: inherit;
    background: #0d1218;
    border: 1px solid #3b4653;
    border-radius: 4px;
    padding: 5px 7px;
    min-width: 0;
  }
  button {
    color: inherit;
    cursor: pointer;
    background: #26384b;
    border: 1px solid #43566b;
    border-radius: 4px;
    padding: 5px 8px;
  }
  button:hover {
    background: #34506b;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.secondary {
    background: #202a35;
  }
  button.danger {
    background: #3b2628;
    border-color: #684247;
  }
  .sheet-list,
  .card-list,
  .objectives,
  .stock-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sheet-list button {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sheet-list button.selected,
  .tabs button.selected {
    border-color: #75a9d6;
    background: #243e56;
  }
  .sheet-list small,
  .kind,
  .eyebrow,
  .relation,
  .state,
  .pin,
  .gm-badge {
    color: #a9bdd1;
    font-size: 0.78em;
  }
  .sheet {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sheet-heading {
    align-items: flex-start;
  }
  .sheet-heading > div {
    align-items: flex-start;
    flex-direction: column;
  }
  .codex-cover { margin: 0; max-height: 220px; overflow: hidden; border: 1px solid #303d4b; border-radius: 6px; }
  .codex-cover img { display: block; width: 100%; max-height: 220px; object-fit: contain; background: #0b1016; }
  .codex-cover figcaption { padding: 8px; color: #aab9c8; }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .gm-badge,
  .pin {
    border: 1px solid #52677c;
    border-radius: 99px;
    padding: 2px 7px;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    border-bottom: 1px solid #2f3a47;
    padding-bottom: 7px;
  }
  .tab-item { display: inline-flex; align-items: center; gap: 3px; }
  .tab-item > button:first-child { min-height: 32px; }
  .page-tools,
  .audience-control,
  .shop-controls,
  .quest-controls {
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .page-tools details {
    border: 1px solid #303c49;
    border-radius: 4px;
    padding: 4px 6px;
  }
  .page-content,
  .panel-section,
  .quest-card,
  .widget-card,
  .link-card {
    border: 1px solid #293541;
    border-radius: 6px;
    padding: 8px;
  }
  .page-content {
    max-height: 380px;
    overflow: auto;
  }
  .page-content > header {
    margin-bottom: 8px;
  }
  .page-content textarea {
    width: 100%;
  }
  .panel-section {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .link-card,
  .widget-card,
  .stock-list li {
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .relation {
    min-width: 95px;
  }
  .quest-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .quest-card p {
    margin: 0;
  }
  .objectives li {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .objectives li.complete {
    opacity: 0.72;
    text-decoration: line-through;
  }
  .quest-controls {
    border-top: 1px solid #303a46;
    padding-top: 6px;
  }
  .tiny {
    padding: 2px 5px;
    font-size: 0.8em;
  }
  .objective-add {
    min-width: 140px;
  }
  .widget-card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: initial;
  }
  .widget-card > header,
  .widget-controls,
  .widget-add-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: flex-end;
  }
  .widget-card > header { justify-content: space-between; }
  .widget-card p {
    margin: 3px 0 0;
    color: #9aa8b7;
    font-size: 0.9em;
  }
  .widget-controls label,
  .widget-editor > label,
  .widget-add-row label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: min(100%, 150px);
  }
  .widget-controls button { align-self: flex-end; }
  .widget-editor {
    border-top: 1px solid #303a46;
    padding-top: 6px;
    display: grid;
    gap: 7px;
  }
  .widget-editor fieldset {
    border: 1px solid #394655;
    border-radius: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
  }
  .widget-editor legend { color: #a9bdd1; }
  .widget-editor label.choice {
    display: inline-flex;
    align-items: center;
    flex-direction: row;
    gap: 5px;
  }
  .widget-editor input[type="checkbox"] { min-width: auto; }
  .asset-name { overflow-wrap: anywhere; }
  .timeline-edit-list { display: grid; gap: 5px; list-style: none; padding: 0; }
  .timeline-edit-list li { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .stock-list li {
    border-top: 1px solid #303a46;
    padding: 5px 0;
  }
  .stock-list input[type="number"] {
    width: 75px;
  }
  .status {
    color: #a9dbb2;
  }
  .empty-sheet {
    text-align: center;
    padding: 40px 10px;
    color: #9aa8b7;
  }
  .bundle-root-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
    gap: 4px 12px;
    max-height: 150px;
    overflow: auto;
  }
  .bundle-root-list label.choice {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bundle-preview {
    display: grid;
    gap: 6px;
    border-top: 1px solid #394655;
    padding-top: 8px;
  }
  .bundle-preview p { margin: 0; }
  .bundle-conflict { display: grid; gap: 4px; }
  .bundle-file { display: grid; gap: 4px; }
  .bundle-file input { max-width: 100%; }
  .bundle-warnings { margin: 0; padding-left: 20px; color: #edc98a; }
  .warning { color: #edc98a; }
  .bundle-message { overflow-wrap: anywhere; color: #a9bdd1; }
  @media (max-width: 700px) {
    .codex-layout {
      grid-template-columns: 1fr;
    }
    .hub {
      max-height: 35vh;
      overflow: auto;
    }
  }
</style>
