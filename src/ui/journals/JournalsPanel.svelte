<script lang="ts">
  /**
   * §10 Journals panel — journals with markdown pages. GM edits page text
   * (whole `pages` array replace — embedded docs ride the parent diff, §4);
   * `<secret>` blocks render highlighted for the GM and are stripped by §5
   * projection before other users ever see the doc (core-tested).
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type {
    AssetManifestEntry,
    JournalDocument,
    JournalPageDocument,
  } from "../../core/documents";
  import JournalPage from "./JournalPage.svelte";
  import CampaignCodexPanel from "./CampaignCodexPanel.svelte";

  let {
    client,
    bus,
    popout = null,
    resolveAsset = null,
    getCodexAssetBytes = null,
    importCodexAsset = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    popout?: ((journalId: string, pageId: string) => void) | null;
    resolveAsset?: ((assetId: string) => string | null) | null;
    getCodexAssetBytes?: ((assetId: string) => Promise<Uint8Array | undefined>) | null;
    importCodexAsset?: ((assetId: string, entry: AssetManifestEntry, bytes: Uint8Array) => Promise<void>) | null;
  } = $props();

  let journals = $state<JournalDocument[]>([]);
  let selectedId = $state<string | null>(null);
  let pageId = $state<string | null>(null);
  let editing = $state(false);
  let draft = $state("");
  let view = $state<"journals" | "codex">("journals");

  const journal = $derived(journals.find((j) => j._id === selectedId) ?? null);
  const page = $derived(journal?.pages.find((p) => p._id === pageId) ?? null);
  const isGm = $derived(
    client.user?.role === "GM" || client.user?.role === "ASSISTANT",
  );

  function refresh(): void {
    journals = [
      ...(client.store.getAll("journals") as readonly JournalDocument[]),
    ];
    const standard = journals.filter((item) => item.codex?.version !== 1);
    if (!selectedId && standard[0]) {
      selectedId = standard[0]._id;
      pageId = standard[0].pages[0]?._id ?? null;
    }
    if (selectedId && !standard.some((j) => j._id === selectedId)) {
      selectedId = standard[0]?._id ?? null;
      pageId = standard[0]?.pages[0]?._id ?? null;
    }
  }

  function select(j: JournalDocument): void {
    selectedId = j._id;
    pageId = j.pages[0]?._id ?? null;
    editing = false;
  }

  function createJournal(): void {
    const page: JournalPageDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "page",
      name: "Page 1",
      ownership: { default: 1 },
      flags: {},
      system: {},
      text: "# New page\n\nWrite here. <secret>GM only.</secret>",
      src: null,
    };
    const doc: JournalDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "journal",
      name: `Journal ${journals.length + 1}`,
      ownership: { default: 1 },
      flags: {},
      system: {},
      pages: [page],
    };
    client.submit([{ kind: "create", coll: "journals", data: doc }]);
  }

  function savePage(): void {
    if (!journal || !page) return;
    const pages = journal.pages.map((p) =>
      p._id === page._id ? { ...p, text: draft } : p,
    );
    client.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: journal._id },
        diff: { pages },
      },
    ]);
    editing = false;
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    return () => {
      offSnapshot();
      offOps();
    };
  });
</script>

<section class="journals" aria-label="Journals">
  <h3>Journals</h3>
  <nav class="journal-views" aria-label="Journal views">
    <button
      type="button"
      class:sel={view === "journals"}
      aria-pressed={view === "journals"}
      onclick={() => (view = "journals")}>Journals</button
    >
    <button
      type="button"
      data-open-codex
      class:sel={view === "codex"}
      aria-pressed={view === "codex"}
      onclick={() => (view = "codex")}>Campaign Codex</button
    >
  </nav>
  {#if view === "codex"}
    <CampaignCodexPanel {client} {bus} {resolveAsset} getAssetBytes={getCodexAssetBytes} importBundleAsset={importCodexAsset} />
  {:else}
    {#if isGm}
      <button id="journal-create" type="button" onclick={createJournal}
        >New journal</button
      >
    {/if}
    <ul class="list">
      {#each journals.filter((item) => item.codex?.version !== 1) as j (j._id)}
        <li>
          <button
            type="button"
            class:sel={j._id === selectedId}
            onclick={() => select(j)}>{j.name}</button
          >
        </li>
      {/each}
    </ul>
    {#if journal}
      <ul class="pages">
        {#each journal.pages as p (p._id)}
          <li>
            <button
              type="button"
              class:sel={p._id === pageId}
              onclick={() => {
                pageId = p._id;
                editing = false;
              }}
            >
              {p.name}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if page}
      {#if editing}
        <textarea id="journal-edit" rows="10" bind:value={draft}></textarea>
        <button id="journal-save" type="button" onclick={savePage}>Save</button>
      {:else}
        <div class="pagewrap">
          <JournalPage
            {client}
            journalId={journal._id}
            pageId={page._id}
            text={page.text}
            revealSecrets
          />
        </div>
        {#if popout}
          <button
            id="journal-popout"
            type="button"
            onclick={() => journal && page && popout(journal._id, page._id)}
            >Popout</button
          >
        {/if}
        {#if isGm}
          <button
            id="journal-edit-btn"
            type="button"
            onclick={() => {
              draft = page?.text ?? "";
              editing = true;
            }}>Edit</button
          >
        {/if}
      {/if}
    {/if}
  {/if}
</section>

<style>
  .journals {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .journal-views {
    display: flex;
    gap: 4px;
  }
  .list,
  .pages {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .pages {
    border-left: 2px solid #333c48;
    padding-left: 6px;
  }
  button.sel {
    background: #2c4a6e;
  }
  .pagewrap {
    background: #10141a;
    border: 1px solid #2a323d;
    border-radius: 4px;
    padding: 6px;
    max-height: 260px;
    overflow-y: auto;
  }
  textarea {
    width: 100%;
  }
</style>
