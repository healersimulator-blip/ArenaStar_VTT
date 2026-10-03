<script lang="ts">
  /**
   * §10/TR-12 player handouts — the read-only journal reader in the player shell. Lists the
   * journals the projection actually delivered to this user (ownership-filtered, secrets
   * stripped, `@Tile[…]` targets blanked by the host) and renders a page with
   * {@link JournalPage}, so a GM-authored `@Tile[…]{}` link is a real button that fires the
   * graphs bound to that anchor — the MATT "Triggering a Tile via Journal" flow.
   *
   * This panel is player-facing by construction: `revealSecrets` stays false, and a link
   * hidden inside a `<secret>` block is not rendered (it is not in this viewer's ordinal
   * list either, so a click could not address it).
   */
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { JournalDocument } from "../../core/documents";
  import JournalPage from "./JournalPage.svelte";
  import { onMount } from "svelte";

  let { client, bus }: { client: ClientSync; bus: EventBus<ClientEvents> } = $props();

  let journals = $state<JournalDocument[]>([]);
  let selectedId = $state<string | null>(null);
  let pageId = $state<string | null>(null);

  const journal = $derived(journals.find((item) => item._id === selectedId) ?? null);
  const page = $derived(journal?.pages.find((item) => item._id === pageId) ?? journal?.pages[0] ?? null);

  function refresh(): void {
    journals = [...(client.store.getAll("journals") as readonly JournalDocument[])]
      .filter((item) => item.pages.length > 0);
    if (!journals.some((item) => item._id === selectedId)) {
      selectedId = journals[0]?._id ?? null;
      pageId = journals[0]?.pages[0]?._id ?? null;
    }
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

<section class="handouts" data-player-handouts data-handouts aria-label="Handouts">
  <h3>Handouts</h3>
  {#if !journals.length}
    <p class="empty" data-handouts-empty>No handouts shared with you yet.</p>
  {:else}
    <ul class="list">
      {#each journals as item (item._id)}
        <li>
          <button
            type="button"
            data-handout-journal={item._id}
            class:sel={item._id === selectedId}
            onclick={() => {
              selectedId = item._id;
              pageId = item.pages[0]?._id ?? null;
            }}>{item.name}</button
          >
        </li>
      {/each}
    </ul>
    {#if journal}
      <ul class="pages">
        {#each journal.pages as item (item._id)}
          <li>
            <button
              type="button"
              data-handout-page={item._id}
              class:sel={item._id === pageId}
              onclick={() => (pageId = item._id)}>{item.name}</button
            >
          </li>
        {/each}
      </ul>
    {/if}
    {#if journal && page}
      <JournalPage client={client} journalId={journal._id} pageId={page._id} text={page.text} />
    {/if}
  {/if}
</section>

<style>
  .handouts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
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
  .empty {
    opacity: 0.75;
  }
</style>
