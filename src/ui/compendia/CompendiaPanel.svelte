<script lang="ts">
  /**
   * §12 compendia panel — searchable read-only packs from imported packages
   * (D-087 pack files). Entries import as world-owned copies via ordinary
   * create Ops; rows are HTML5-draggable onto the canvas (App drop handler
   * imports + places a linked token for actor packs).
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { HostPackages } from "../../app/hostBoot";
  import { searchCompendia, type CompendiumPack } from "../../core/compendium";

  let {
    client,
    packages = null,
  }: {
    client: ClientSync;
    packages?: HostPackages | null;
  } = $props();

  type Row = { packageId: string; pack: CompendiumPack };
  let packs = $state<Row[]>([]);
  let query = $state("");

  const refresh = (): void => {
    if (!packages) return;
    void packages
      .compendia()
      .then((list) => {
        packs = list;
      })
      .catch(() => {});
  };
  onMount(refresh);

  const hits = $derived(
    searchCompendia(
      packs.map((r) => r.pack),
      query,
      50,
    ),
  );
  const packOf = (name: string): Row | undefined => packs.find((r) => r.pack.name === name);

  function importEntry(packName: string, entryId: string): void {
    const row = packOf(packName);
    const entry = row?.pack.entries.find((e) => e.id === entryId);
    if (!row || !entry) return;
    const id = `${row.pack.type.slice(0, -1)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    client.submit([
      {
        kind: "create",
        coll: row.pack.type,
        data: { ...entry.data, _id: id },
      },
    ]);
  }

  function onDragStart(ev: DragEvent, packName: string, entryId: string): void {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.setData("application/x-vtt-compendium", JSON.stringify({ packName, entryId }));
    ev.dataTransfer.effectAllowed = "copy";
  }
</script>

<div class="compendia">
  {#if !packages}
    <p class="hint">Packages unavailable.</p>
  {:else}
    <input
      id="compendium-search"
      type="search"
      placeholder="Search compendia…"
      bind:value={query}
    />
    <p class="hint" data-compendium-stats>
      {packs.length} pack(s) · {packs.reduce((n, r) => n + r.pack.entries.length, 0)} entries ·
      {hits.length} shown
    </p>
    {#if packs.length === 0}
      <p class="hint">Import a package with packs (§12) to fill the compendium.</p>
    {/if}
    <ul class="results">
      {#each hits as hit (hit.pack.name + ":" + hit.entry.id)}
        <li
          class="entry"
          data-entry-id={hit.entry.id}
          draggable="true"
          ondragstart={(ev) => onDragStart(ev, hit.pack.name, hit.entry.id)}
        >
          <span class="name">{hit.entry.name}</span>
          <span class="meta">{hit.pack.name} · {hit.pack.type}</span>
          <button
            type="button"
            data-entry-import
            onclick={() => importEntry(hit.pack.name, hit.entry.id)}
          >
            Import
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .compendia {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  #compendium-search {
    background: #171a22;
    border: 1px solid #2c3242;
    color: #e8e8ee;
    border-radius: 4px;
    padding: 4px 8px;
  }
  .hint {
    margin: 0;
    font-size: 11px;
    opacity: 0.7;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: #171a22;
    border: 1px solid #2c3242;
    border-radius: 4px;
    cursor: grab;
  }
  .entry .name {
    flex: 1;
    font-size: 12px;
  }
  .entry .meta {
    font-size: 10px;
    opacity: 0.6;
  }
</style>
