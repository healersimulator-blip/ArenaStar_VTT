<script lang="ts">
  import { onMount } from "svelte";
  import { searchCompendia, type CompendiumPack, type CompendiumEntry } from "../../core/compendium";

  let {
    kind = "spell", // "spell" | "feat" | "item"
    onSelect,
    onClose,
  }: {
    kind?: "spell" | "feat" | "item";
    onSelect: (entry: CompendiumEntry, pack: CompendiumPack) => void;
    onClose: () => void;
  } = $props();

  type Row = { packageId: string; pack: CompendiumPack };
  let packs = $state<Row[]>([]);
  let query = $state("");
  let loading = $state(true);

  onMount(async () => {
    loading = true;
    try {
      // Find package compendia matching kind
      // Compendia packs are retrieved from world packages if available
      // or window hook if in browser
      const hostPackages = (window as unknown as { __arenaHostPackages?: { compendia: () => Promise<Row[]> } }).__arenaHostPackages;
      if (hostPackages) {
        const all = await hostPackages.compendia();
        packs = all.filter((r) => {
          if (kind === "spell") return r.pack.name.toLowerCase().includes("spell");
          if (kind === "feat") return r.pack.name.toLowerCase().includes("feat");
          return true;
        });
      }
    } catch {
      // ignore
    } finally {
      loading = false;
    }
  });

  const hits = $derived(
    searchCompendia(
      packs.map((r) => r.pack),
      query,
      40,
    ),
  );
</script>

<div class="compendium-picker-backdrop" role="dialog" aria-modal="true" aria-label="Compendium Picker">
  <div class="compendium-picker-window">
    <header class="picker-header">
      <h4>Add from Compendium ({kind})</h4>
      <button type="button" class="close-btn" onclick={onClose}>✕</button>
    </header>

    <div class="picker-search">
      <input
        type="search"
        placeholder={`Search ${kind}s...`}
        bind:value={query}
      />
    </div>

    {#if loading}
      <p class="status-msg">Loading compendium packs...</p>
    {:else if packs.length === 0}
      <p class="status-msg">No {kind} packs currently active or loaded in this world.</p>
    {:else}
      <p class="stats-msg">{hits.length} result(s) found</p>
      <ul class="results-list">
        {#each hits as hit (hit.pack.name + ":" + hit.entry.id)}
          <li class="result-row">
            <div class="info">
              <span class="name">{hit.entry.name}</span>
              <span class="meta">{hit.pack.name}</span>
            </div>
            <button
              type="button"
              class="add-btn"
              onclick={() => onSelect(hit.entry, hit.pack)}
            >
              Add
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .compendium-picker-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }
  .compendium-picker-window {
    background: #1c2430;
    border: 1px solid #3d4f66;
    border-radius: 6px;
    width: 480px;
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    color: #e0e5ed;
  }
  .picker-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid #2e3e52;
  }
  .picker-header h4 {
    margin: 0;
    font-size: 1rem;
    text-transform: capitalize;
  }
  .close-btn {
    background: transparent;
    border: none;
    color: #9eafc5;
    cursor: pointer;
    font-size: 1.1rem;
  }
  .close-btn:hover {
    color: #fff;
  }
  .picker-search {
    padding: 10px 14px;
  }
  .picker-search input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 10px;
    background: #131922;
    border: 1px solid #3d4f66;
    border-radius: 4px;
    color: #fff;
  }
  .status-msg, .stats-msg {
    margin: 0;
    padding: 6px 14px;
    font-size: 0.85rem;
    color: #9eafc5;
  }
  .results-list {
    list-style: none;
    margin: 0;
    padding: 0 14px 14px 14px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .result-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #232e3d;
    padding: 8px 10px;
    border-radius: 4px;
    border: 1px solid #2e3e52;
  }
  .result-row .name {
    font-weight: 500;
    display: block;
  }
  .result-row .meta {
    font-size: 0.75rem;
    color: #9eafc5;
  }
  .add-btn {
    background: #2d5a88;
    color: #fff;
    border: 1px solid #437ab3;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .add-btn:hover {
    background: #3b73ad;
  }
</style>
