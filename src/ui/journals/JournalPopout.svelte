<script lang="ts">
  /** §10 journal page popout window body — markdown + GM secret blocks. */
  import { renderMarkdown, splitSecretBlocks } from "../../core/markdown";
  import type { ClientSync } from "../../client/sync";
  import type { JournalDocument } from "../../core/documents";

  let { client, journalId, pageId }: { client: ClientSync; journalId: string; pageId: string } =
    $props();

  const journal = $derived(
    (client.store.get("journals", journalId) as JournalDocument | undefined) ?? null,
  );
  const page = $derived(journal?.pages.find((p) => p._id === pageId) ?? journal?.pages[0] ?? null);
  const blocks = $derived(page ? splitSecretBlocks(page.text) : []);
</script>

<div class="popout" data-page={page?._id ?? ""}>
  {#if page}
    {#each blocks as b, i (i)}
      {#if b.secret}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped by renderMarkdown -->
        <div class="secret" data-secret>🔒 {@html renderMarkdown(b.text)}</div>
      {:else if b.text.trim()}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped by renderMarkdown -->
        {@html renderMarkdown(b.text)}
      {/if}
    {/each}
  {:else}
    <p class="empty">Page not found.</p>
  {/if}
</div>

<style>
  .popout {
    font-size: 13px;
    line-height: 1.45;
  }
  .popout :global(p) {
    margin: 4px 0;
  }
  .secret {
    background: #3a2f16;
    border: 1px dashed #8a7433;
    border-radius: 3px;
    padding: 2px 6px;
    margin: 4px 0;
  }
  .empty {
    opacity: 0.7;
  }
</style>
