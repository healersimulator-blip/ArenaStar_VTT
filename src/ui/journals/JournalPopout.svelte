<script lang="ts">
  /** §10 journal page popout window body — one renderer for everyone. */
  import type { ClientSync } from "../../client/sync";
  import type { JournalDocument } from "../../core/documents";
  import JournalPage from "./JournalPage.svelte";

  let {
    client,
    journalId,
    pageId,
    resolveAsset = null,
  }: {
    client: ClientSync;
    journalId: string;
    pageId: string;
    resolveAsset?: ((assetId: string) => string | null) | null;
  } = $props();

  const journal = $derived(
    (client.store.get("journals", journalId) as JournalDocument | undefined) ?? null,
  );
  const page = $derived(journal?.pages.find((p) => p._id === pageId) ?? journal?.pages[0] ?? null);
  const isGm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
</script>

{#if page && journal}
  <JournalPage
    {client}
    journalId={journal._id}
    pageId={page._id}
    text={page.text}
    src={page.src}
    imageAlt={page.name}
    {resolveAsset}
    revealSecrets={isGm}
  />
{:else}
  <p class="empty">Page not found.</p>
{/if}

<style>
  .empty {
    opacity: 0.7;
  }
</style>
