<script lang="ts">
  /**
   * §10/TR-12 journal page body — one renderer for the GM editor, the popout window and
   * the player's read-only handouts view. Markdown and `<secret>` blocks as before, plus
   * MATT's `@Tile[…]{}` links as real buttons: the click sends the page id and the link's
   * ordinal, never an anchor id (the host resolves it).
   *
   * `revealSecrets` is the GM view. A player's copy has secrets stripped by the host
   * already, and here a secret block renders as a locked placeholder **without** its
   * content, so a leaked replica could not display one.
   */
  import type { ClientSync } from "../../client/sync";
  import { renderMarkdown } from "../../core/markdown";
  import { journalSegments } from "../../core/journalLinks";

  let {
    client,
    journalId,
    pageId,
    text,
    src = null,
    imageAlt = "Journal page image",
    resolveAsset = null,
    revealSecrets = false,
  }: {
    client: ClientSync;
    journalId: string;
    pageId: string;
    text: string;
    src?: string | null;
    imageAlt?: string;
    resolveAsset?: ((assetId: string) => string | null) | null;
    revealSecrets?: boolean;
  } = $props();

  const segments = $derived(journalSegments(text));
  const imageUrl = $derived(
    src
      ? resolveAsset?.(src) ?? (/^https:\/\//i.test(src) ? src : null)
      : null,
  );

  function trigger(index: number): void {
    client.requestJournalTrigger(journalId, pageId, index);
  }
</script>

<div class="page" data-page={pageId}>
  {#if src}
    <figure class="page-image" data-journal-image={pageId}>
      {#if imageUrl}
        <img src={imageUrl} alt={imageAlt || "Journal page image"} loading="lazy" />
      {:else}
        <div class="image-pending" role="status">Loading journal image…</div>
      {/if}
    </figure>
  {/if}
  {#each segments as segment, i (i)}
    {#if segment.kind === "link"}
      {#if segment.hidden && !revealSecrets}
        <!-- inside a secret block: not this viewer's link to fire, and not their text -->
      {:else}
        <button
          type="button"
          class="tile-link"
          data-journal-tile-link={segment.index}
          title={segment.error ?? "Trigger the graphs bound to this anchor"}
          disabled={segment.error !== undefined}
          onclick={() => trigger(segment.index)}>{segment.label}</button
        >
      {/if}
    {:else if segment.kind === "secret"}
      {#if revealSecrets}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped by renderMarkdown -->
        <div class="secret" data-secret>🔒 {@html renderMarkdown(segment.text)}</div>
      {:else}
        <div class="secret" data-secret>🔒 A secret the GM is keeping.</div>
      {/if}
    {:else if segment.text.trim()}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped by renderMarkdown -->
      {@html renderMarkdown(segment.text)}
    {/if}
  {/each}
</div>

<style>
  .page {
    font-size: 13px;
    line-height: 1.45;
  }
  .page :global(p) {
    margin: 4px 0;
  }
  .page-image {
    margin: 0 0 8px;
  }
  .page-image img {
    display: block;
    max-width: 100%;
    max-height: min(70vh, 720px);
    object-fit: contain;
  }
  .image-pending {
    min-height: 36px;
    opacity: 0.7;
  }
  .secret {
    background: #3a2f16;
    border: 1px dashed #8a7433;
    border-radius: 3px;
    padding: 2px 6px;
    margin: 4px 0;
  }
  .tile-link {
    display: inline-block;
    margin: 2px 4px 2px 0;
    padding: 2px 8px;
    border: 1px solid #2f6d63;
    border-radius: 3px;
    background: #16302c;
    color: #cfe9e2;
    font-size: 12px;
    cursor: pointer;
  }
  .tile-link:hover:not(:disabled) {
    background: #1d443d;
  }
  .tile-link:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
