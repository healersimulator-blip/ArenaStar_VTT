<script lang="ts">
  /**
   * `[data-browse-compendium-feats]` picker (G-45): search runs through `core/compendiumIndex`
   * (same ranking as the reference search) and the result list is windowed, so a 25k-entry world
   * browses at the same cost as a small one — the previous fixed `searchCompendia(…, 60)` cap made
   * every feat past the first 60 unfindable.
   */
  import { onMount } from "svelte";
  import { type CompendiumPack, type CompendiumEntry } from "../../core/compendium";
  import { buildCompendiumIndex, rankIndex } from "../../core/compendiumIndex";
  import { windowRows } from "../virtual";
  import { loadWorldCompendia, type CompendiumPackRow } from "./compendiumLoader";

  let {
    kind = "spell", // "spell" | "feat" | "item" | "actor"
    worldId,
    onSelect,
    onClose,
  }: {
    kind?: "spell" | "feat" | "item" | "actor";
    worldId?: string;
    onSelect: (entry: CompendiumEntry, pack: CompendiumPack) => void;
    onClose: () => void;
  } = $props();

  const ROW_H = 30;
  const OVERSCAN = 8;
  const INITIAL_CAP = 400;

  let packs = $state<CompendiumPackRow[]>([]);
  let query = $state("");
  let loading = $state(true);
  let rankCap = $state(INITIAL_CAP);
  let scrollTop = $state(0);
  let viewportHeight = $state(300);
  let listEl = $state<HTMLDivElement | null>(null);

  onMount(async () => {
    loading = true;
    try {
      const all = await loadWorldCompendia(worldId);
      packs = all.filter((r) => {
        const pType = r.pack.type.toLowerCase();
        const pName = r.pack.name.toLowerCase();
        if (kind === "spell") return pType.includes("spell") || pName.includes("spell");
        if (kind === "feat") return pType.includes("feat") || pName.includes("feat");
        if (kind === "item") return pType.includes("item") || pName.includes("item") || pType.includes("weapon") || pType.includes("armor");
        // D-272: an encounter entry may point at a creature, so the same picker browses actor
        // packs (bestiary/NPC). The pack's own `type` is the collection it imports into, which is
        // the only honest signal — "PF1e Bestiary" is an actors pack and a name filter would miss
        // a bestiary pack called something else.
        if (kind === "actor")
          return (
            pType.includes("actor") ||
            pName.includes("bestiary") ||
            pName.includes("monster") ||
            pName.includes("npc")
          );
        return true;
      });
    } catch {
      // ignore
    } finally {
      loading = false;
    }
  });

  const index = $derived(buildCompendiumIndex(packs.map((r) => r.pack)));
  const ranking = $derived(rankIndex(index, query, { cap: rankCap }));
  const win = $derived(windowRows(ranking.total, scrollTop, viewportHeight, ROW_H, OVERSCAN));
  const visibleIndices = $derived(ranking.indices.subarray(win.start, win.end));

  // Grow the ranked window as the list scrolls past it (doubling: logarithmic re-ranks).
  $effect(() => {
    if (win.end > ranking.indices.length && ranking.indices.length < ranking.total) {
      rankCap = Math.max(rankCap * 2, win.end + ROW_H);
    }
  });
  $effect(() => {
    void query;
    rankCap = INITIAL_CAP;
    scrollTop = 0;
    if (listEl) listEl.scrollTop = 0;
  });
  $effect(() => {
    const el = listEl;
    if (!el) return;
    const measure = (): void => {
      if (el.clientHeight > 0) viewportHeight = el.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
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
        data-picker-search
      />
    </div>

    {#if loading}
      <p class="status-msg">Loading compendium packs...</p>
    {:else if packs.length === 0}
      <p class="status-msg">No {kind} packs currently active or loaded in this world.</p>
    {:else}
      <p class="stats-msg">{ranking.total} result(s) found</p>
      <div
        class="results-list"
        bind:this={listEl}
        onscroll={(ev) => (scrollTop = ev.currentTarget.scrollTop)}
        data-picker-rows
      >
        <div style={`height:${win.padTop}px`}></div>
        {#each visibleIndices as entryIndex (entryIndex)}
          {@const row = index.entries[entryIndex]}
          {#if row}
            <div class="result-row" data-picker-row>
              <div class="info">
                <span class="name">{row.entry.name}</span>
                <span class="meta">{index.packs[row.packIndex]?.name ?? ""} · {row.facets.kind}</span>
              </div>
              <button
                type="button"
                class="add-btn"
                data-add-compendium-entry
                onclick={() => {
                  const pack = index.packs[row.packIndex];
                  if (pack) onSelect(row.entry, pack);
                }}
              >
                Add
              </button>
            </div>
          {/if}
        {/each}
        <div style={`height:${win.padBottom}px`}></div>
      </div>
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
    padding: 2px 6px;
  }
  .close-btn:hover {
    color: #fff;
  }
  .picker-search {
    padding: 8px 12px;
    background: #141a22;
    border-bottom: 1px solid #273547;
  }
  .picker-search input {
    width: 100%;
    background: #1c2430;
    border: 1px solid #3d4f66;
    color: #fff;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 0.9rem;
    box-sizing: border-box;
  }
  .status-msg, .stats-msg {
    padding: 10px 14px;
    font-size: 0.85rem;
    color: #9eafc5;
    margin: 0;
  }
  .results-list {
    padding: 0;
    margin: 0;
    overflow-y: auto;
    max-height: 50vh;
    min-height: 120px;
  }
  .result-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    border-bottom: 1px solid #273547;
  }
  .result-row:hover {
    background: #232e3d;
  }
  .info {
    display: flex;
    flex-direction: column;
  }
  .name {
    font-weight: 500;
    font-size: 0.9rem;
    color: #e0e5ed;
  }
  .meta {
    font-size: 0.75rem;
    color: #7b8ea6;
  }
  .add-btn {
    background: #2b593f;
    border: 1px solid #3d7d59;
    color: #fff;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .add-btn:hover {
    background: #366f4e;
  }
</style>
