<script lang="ts">
  /**
   * §12 compendia panel — searchable read-only packs from imported packages
   * (D-087 pack files). Entries import as world-owned copies via ordinary
   * create Ops; rows are HTML5-draggable onto the canvas (App drop handler
   * imports + places a linked token for actor packs).
   *
   * G-45 scale UX: the converted tester world carries 25,376 entries across 28 packs, which the
   * original 50-row linear scan could not browse. The panel now searches through
   * `core/compendiumIndex` (the same ranking as `searchCompendia`, proven equal by
   * `tests/core/compendiumIndex.test.ts`), with facet filters, explicit sorts, a virtualized row
   * list (`ui/virtual.ts`) and a detail pane. A keystroke ranks rows as indices and the DOM only
   * ever holds the visible window, so both the search cost and the DOM stay bounded by the
   * window, not by the corpus.
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { HostPackages } from "../../app/hostBoot";
  import type { CompendiumPack } from "../../core/compendium";
  import {
    buildCompendiumIndex,
    rankIndex,
    type IndexSort,
    type IndexedEntry,
  } from "../../core/compendiumIndex";
  import { windowRows } from "../virtual";
  import {
    activeFilterCount,
    detailFieldsOf,
    documentPreview,
    emptyFilters,
    facetChipGroups,
    filterSummary,
    toggleFilter,
    type CompendiumFilterState,
  } from "./panelModel";

  let {
    client,
    packages = null,
  }: {
    client: ClientSync;
    packages?: HostPackages | null;
  } = $props();

  type Row = { packageId: string; pack: CompendiumPack };

  const ROW_H = 30;
  const OVERSCAN = 8;
  /** Ranked rows materialized up front; the effect below doubles it as the scroll window grows. */
  const INITIAL_CAP = 600;
  /** Facet chips rendered per group before the rest are summarized. */
  const MAX_CHIPS = 24;

  let packs = $state<Row[]>([]);
  let query = $state("");
  let sort = $state<IndexSort>("relevance");
  let filters = $state<CompendiumFilterState>(emptyFilters());
  let showFilters = $state(false);
  let selected = $state<number | null>(null);
  let rankCap = $state(INITIAL_CAP);
  let scrollTop = $state(0);
  let viewportHeight = $state(340);
  let listEl = $state<HTMLDivElement | null>(null);

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

  const packList = $derived(packs.map((r) => r.pack));
  const index = $derived(buildCompendiumIndex(packList));
  const entryCount = $derived(index.counts.entries);
  const ranking = $derived(
    rankIndex(index, query, { filters, sort, cap: rankCap }),
  );
  const win = $derived(windowRows(ranking.total, scrollTop, viewportHeight, ROW_H, OVERSCAN));
  const visibleIndices = $derived(ranking.indices.subarray(win.start, win.end));
  const facets = $derived(index.facetOptions);
  const filtersActive = $derived(activeFilterCount(filters) > 0);
  const selectedEntry = $derived(selected === null ? null : (index.entries[selected] ?? null));

  // Grow the ranked window when the reader scrolls past what was ranked (doubling keeps the
  // re-rank frequency logarithmic in the list length).
  $effect(() => {
    if (win.end > ranking.indices.length && ranking.indices.length < ranking.total) {
      rankCap = Math.max(rankCap * 2, win.end + ROW_H);
    }
  });

  // A new query/filter/sort starts at the top of its own result list.
  $effect(() => {
    void query;
    void filters;
    void sort;
    rankCap = INITIAL_CAP;
    scrollTop = 0;
    if (listEl) listEl.scrollTop = 0;
  });

  // Measure the scroll viewport (a hidden tab measures 0 — keep the last real height then).
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

  const packNameOf = (row: IndexedEntry | null): string =>
    row === null ? "" : (index.packs[row.packIndex]?.name ?? "");

  function importEntry(row: IndexedEntry | null): void {
    if (row === null) return;
    const pack = index.packs[row.packIndex];
    if (!pack) return;
    const id = `${pack.type.slice(0, -1)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    client.submit([
      { kind: "create", coll: pack.type, data: { ...row.entry.data, _id: id } },
    ]);
  }

  /**
   * The entry under the pointer when the button went down — see `onDragStart`.
   * Cleared on drop/drag end, and on a press that turns out to be a plain click.
   */
  let pressed = $state<number | null>(null);

  /**
   * A drag payload must describe the row the user **pressed**, not whichever row the browser
   * hit-tests when the gesture passes the drag threshold: the document is taller than the window
   * in a short viewport, so a jump of the pointer (or a scroll between press and drag, which is
   * what `dragTo` in the specs does) can leave a *different* row under the pointer — and the
   * import would then create the wrong entry. `pressed` is that row; when it is still the row the
   * event fired on (the normal case) nothing changes.
   */
  function onDragStart(ev: DragEvent, row: IndexedEntry): void {
    if (!ev.dataTransfer) return;
    const source = (pressed !== null ? index.entries[pressed] : null) ?? row;
    const pack = index.packs[source.packIndex];
    if (!pack) return;
    ev.dataTransfer.setData(
      "application/x-vtt-compendium",
      JSON.stringify({ packName: pack.name, entryId: source.entry.id }),
    );
    ev.dataTransfer.effectAllowed = "copy";
  }

  const toggle = (key: keyof CompendiumFilterState, value: string): void => {
    filters = { ...filters, [key]: toggleFilter(filters[key], value) };
  };
  const clearFilters = (): void => {
    filters = emptyFilters();
  };
  /** Facet groups for the chips (packs biggest-first); every option carries a `value` to key on. */
  const chipGroups = $derived(facetChipGroups(facets, MAX_CHIPS));
</script>

<div class="compendia" data-compendium-reader>
  {#if !packages}
    <p class="hint">Packages unavailable.</p>
  {:else}
    <div class="controls">
      <input
        id="compendium-search"
        type="search"
        placeholder="Search compendia…"
        bind:value={query}
        data-compendium-search
      />
      <select bind:value={sort} data-compendium-sort aria-label="Sort">
        <option value="relevance">Relevance</option>
        <option value="name">Name</option>
        <option value="kind">Kind</option>
        <option value="level">Level</option>
      </select>
      <button
        type="button"
        class="toggle"
        class:active={filtersActive}
        aria-pressed={showFilters}
        onclick={() => (showFilters = !showFilters)}
        data-compendium-filters-toggle
      >
        Filters{filtersActive ? ` (${activeFilterCount(filters)})` : ""}
      </button>
    </div>
    <p class="hint" data-compendium-stats>
      {packs.length} pack(s) · {entryCount} entries · {ranking.total} shown
    </p>

    {#if showFilters}
      <div class="facets" data-compendium-filters>
        {#if filtersActive}
          <div class="facet-head">
            <span class="hint" data-compendium-filter-summary>{filterSummary(filters)}</span>
            <button type="button" class="clear" onclick={clearFilters} data-compendium-clear-filters>
              Clear
            </button>
          </div>
        {/if}
        {#each chipGroups as group (group.key)}
          <div class="facet-group">
            <span class="facet-label">{group.label}</span>
            <div class="chips">
              {#each group.options as option (option.value)}
                <button
                  type="button"
                  class="chip"
                  class:on={filters[group.key].includes(option.value)}
                  aria-pressed={filters[group.key].includes(option.value)}
                  data-compendium-facet={`${group.key}:${option.value}`}
                  onclick={() => toggle(group.key, option.value)}
                >
                  {option.value} <span class="count">{option.count}</span>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if packs.length === 0}
      <p class="hint">Import a package with packs (§12) to fill the compendium.</p>
    {:else if ranking.total === 0}
      <p class="hint" data-compendium-empty>No entries match this search.</p>
    {/if}

    <div
      class="results"
      bind:this={listEl}
      onscroll={(ev) => (scrollTop = ev.currentTarget.scrollTop)}
      data-compendium-rows
    >
      <div style={`height:${win.padTop}px`}></div>
      {#each visibleIndices as entryIndex (entryIndex)}
        {@const row = index.entries[entryIndex]}
        {#if row}
          <div
            class="entry"
            class:selected={selected === entryIndex}
            data-entry-id={row.entry.id}
            data-compendium-row
            data-entry-pack={packNameOf(row)}
            data-entry-type={index.packs[row.packIndex]?.type ?? ""}
            draggable="true"
            onmousedown={() => (pressed = entryIndex)}
            onmouseup={() => (pressed = null)}
            ondragstart={(ev) => onDragStart(ev, row)}
            ondragend={() => (pressed = null)}
            onclick={() => (selected = selected === entryIndex ? null : entryIndex)}
            role="button"
            tabindex="0"
            onkeydown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") selected = entryIndex;
            }}
          >
            <span class="name">{row.entry.name}</span>
            <span class="meta">{packNameOf(row)} · {row.facets.kind}</span>
            {#if row.facets.level !== null}
              <span class="meta level">lvl {row.facets.level}</span>
            {/if}
            <button
              type="button"
              data-entry-import
              onclick={(ev) => {
                ev.stopPropagation();
                importEntry(row);
              }}
            >
              Import
            </button>
          </div>
        {/if}
      {/each}
      <div style={`height:${win.padBottom}px`}></div>
    </div>

    {#if selectedEntry}
      <div class="detail" data-compendium-detail>
        <div class="detail-head">
          <strong data-compendium-detail-name>{selectedEntry.entry.name}</strong>
          <span class="meta">{packNameOf(selectedEntry)}</span>
          <button
            type="button"
            data-compendium-detail-import
            onclick={() => importEntry(selectedEntry)}
          >
            Import
          </button>
          <button
            type="button"
            class="clear"
            onclick={() => (selected = null)}
            data-compendium-detail-close
          >
            Close
          </button>
        </div>
        <dl class="fields">
          {#each detailFieldsOf(selectedEntry.entry, selectedEntry.facets) as field (field.label)}
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          {/each}
        </dl>
        <details class="document">
          <summary>Document</summary>
          <pre data-compendium-document>{documentPreview(selectedEntry.entry)}</pre>
        </details>
      </div>
    {/if}
  {/if}
</div>

<style>
  .compendia {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .controls {
    display: flex;
    gap: 6px;
  }
  #compendium-search {
    flex: 1;
    min-width: 0;
    background: #171a22;
    border: 1px solid #2c3242;
    color: #e8e8ee;
    border-radius: 4px;
    padding: 4px 8px;
  }
  .controls select {
    background: #171a22;
    border: 1px solid #2c3242;
    color: #e8e8ee;
    border-radius: 4px;
    padding: 4px 6px;
  }
  .toggle {
    background: #1d2129;
    border: 1px solid #2c3242;
    color: #e8e8ee;
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .toggle.active {
    border-color: #4d7ecb;
    color: #cfe0ff;
  }
  .hint {
    margin: 0;
    font-size: 0.8125rem;
    opacity: 0.7;
  }
  .facets {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    background: #14171d;
    border: 1px solid #2c3242;
    border-radius: 4px;
    max-height: 190px;
    overflow-y: auto;
  }
  .facet-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .facet-group {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .facet-label {
    font-size: 0.75rem;
    opacity: 0.6;
    min-width: 46px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    background: #1d2129;
    border: 1px solid #2c3242;
    color: #cfd6e4;
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .chip.on {
    background: #23405f;
    border-color: #4d7ecb;
    color: #fff;
  }
  .chip .count {
    opacity: 0.55;
  }
  .clear {
    background: transparent;
    border: none;
    color: #8fa6c8;
    cursor: pointer;
    font-size: 0.75rem;
  }
  /*
   * The row list must be a **block** container, not a flex column: a virtualized list sizes its
   * scroll range with padTop/padBottom spacers, and in a column flex container with a max-height
   * those spacers are flex items with the default `flex-shrink: 1`, so they collapse to 0 px and
   * the list stops being scrollable past the first window (found by `e2e/compendium_scale.spec.ts`
   * on the 340-entry package — the scrollHeight was one window's worth). The 4 px gap is a row
   * margin instead, which keeps the pitch exactly `ROW_H` (30 px) for the window math.
   */
  .results {
    flex: 1;
    min-height: 160px;
    max-height: 340px;
    overflow-y: auto;
    /* A windowed list must not be re-anchored by the browser when rows swap above the viewport. */
    overflow-anchor: none;
    padding-right: 2px;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    height: 26px;
    margin-bottom: 4px;
    box-sizing: border-box;
    background: #171a22;
    border: 1px solid #2c3242;
    border-radius: 4px;
    cursor: grab;
  }
  .entry.selected {
    border-color: #4d7ecb;
  }
  .entry .name {
    flex: 1;
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry .meta {
    font-size: 0.8125rem;
    opacity: 0.6;
    white-space: nowrap;
  }
  .entry .level {
    opacity: 0.75;
  }
  .detail {
    border: 1px solid #2c3242;
    border-radius: 4px;
    background: #14171d;
    padding: 6px 8px;
    max-height: 300px;
    overflow-y: auto;
  }
  .detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .detail-head strong {
    flex: 1;
  }
  .detail-head button {
    background: #1d2129;
    border: 1px solid #2c3242;
    color: #e8e8ee;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 0.75rem;
  }
  .fields {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 1px 8px;
    margin: 0;
    font-size: 0.8125rem;
  }
  .fields dt {
    opacity: 0.6;
  }
  .fields dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .document summary {
    cursor: pointer;
    font-size: 0.8125rem;
    opacity: 0.7;
    margin-top: 4px;
  }
  .document pre {
    max-height: 200px;
    overflow: auto;
    font-size: 0.75rem;
    background: #10131a;
    padding: 6px;
    border-radius: 4px;
  }
</style>
