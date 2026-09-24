<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import {
    getByTag, listTaggable, tagEditOps,
    type TagMatchMode, type TagPattern, type TagSearchResult, type TagEdit,
  } from "../../core/tags";

  let { client, bus }: { client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  let sceneId = $state("");
  let kind = $state("");
  let query = $state("");
  let nameFilter = $state("");
  let mode = $state<TagMatchMode>("all");
  let pattern = $state<TagPattern>("literal");
  let exact = $state(true);
  let caseSensitive = $state(true);
  let editText = $state("");
  let error = $state("");
  let status = $state("");
  let pendingRules = $state<string | null>(null);
  let results = $state<TagSearchResult[]>([]);
  let scenes = $state<Array<{ _id: string; name: string }>>([]);
  const selected = new SvelteSet<string>();

  const canEdit = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  const selectedResults = $derived(results.filter((row) => selected.has(key(row))));
  function key(row: TagSearchResult): string {
    return `${row.sceneId}:${row.collection}:${row.doc._id}`;
  }

  function refresh(): void {
    scenes = [...client.store.getAll("scenes")].map((sc) => ({ _id: sc._id, name: sc.name }));
    try {
      const opts = {
        ...(sceneId ? { sceneId } : {}),
        ...(kind ? { collections: [kind as TagSearchResult["collection"]] } : {}),
      };
      const terms = pattern === "regex" ? [query.trim()] : query.split(",").map((s) => s.trim()).filter(Boolean);
      const matches = query.trim()
        ? getByTag(client.store.world, terms, {
            ...opts, mode, pattern, contains: !exact, caseSensitive,
          })
        : listTaggable(client.store.world, opts);
      const needle = nameFilter.toLocaleLowerCase().trim();
      results = needle
        ? matches.filter((row) => row.doc.name.toLocaleLowerCase().includes(needle))
        : matches;
      error = "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      results = [];
    }
  }

  function toggle(row: TagSearchResult): void {
    if (selected.has(key(row))) selected.delete(key(row));
    else selected.add(key(row));
  }

  function apply(edit: TagEdit): void {
    if (!canEdit) return;
    error = "";
    status = "";
    try {
      if (selectedResults.length === 0) throw new Error("Select placeables first");
      const tags = editText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (tags.length === 0 && edit !== "replace") throw new Error("Enter at least one tag");
      const ops = tagEditOps(selectedResults, edit, tags);
      if (ops.length > 0) client.submit(ops);
      status = `${ops.length} placeable(s) ${edit === "replace" ? "updated" : edit + "ed"}`;
      selected.clear();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function applyRules(): void {
    if (!canEdit || pendingRules) return;
    error = ""; status = "";
    if (selectedResults.length === 0 || selectedResults.length > 32) {
      error = "Select 1–32 scene-qualified targets for Tagger rules.";
      return;
    }
    pendingRules = client.requestTagRules(selectedResults.map((row) => row.ref));
    status = "Allocating existing {#}/{id} templates against live scene tags on the host…";
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offRules = bus.on("taggerRulesResult", (result) => {
      if (result.requestId !== pendingRules) return;
      pendingRules = null;
      selected.clear();
      status = `${result.changed} target(s) expanded on the host at seq ${result.seq}`;
      refresh();
    });
    const offRejected = bus.on("rejected", (msg) => {
      if (msg.txId !== pendingRules) return;
      pendingRules = null;
      status = "";
      error = `${msg.reason}: ${msg.detail}`;
    });
    refresh();
    return () => { offSnapshot(); offOps(); offRules(); offRejected(); };
  });
</script>

<section class="tagger" aria-label="Tag explorer and editor" data-tagger>
  <h3>Tags · scene-wide explorer</h3>
  <div class="filters">
    <select aria-label="Tag scene" data-tag-scene bind:value={sceneId} onchange={refresh}>
      <option value="">All scenes</option>
      {#each scenes as scene (scene._id)}
        <option value={scene._id}>{scene.name}</option>
      {/each}
    </select>
    <select aria-label="Placeable type" bind:value={kind} onchange={refresh}>
      <option value="">All placeables</option>
      {#each ["scenes", "tokens", "tiles", "walls", "lights", "sounds", "drawings", "templates", "notes", "cells"] as c (c)}
        <option value={c}>{c}</option>
      {/each}
    </select>
    <input aria-label="Search placeable name" placeholder="Name…" bind:value={nameFilter} oninput={refresh} />
    <input aria-label="Search tags" data-tag-search placeholder="tag, another tag…" bind:value={query} oninput={refresh} />
  </div>
  <div class="filters">
    <select aria-label="Tag match mode" bind:value={mode} onchange={refresh}>
      <option value="all">All tags</option><option value="any">Any tag</option><option value="exactSet">Exact set</option>
    </select>
    <select aria-label="Tag pattern" bind:value={pattern} onchange={refresh}>
      <option value="literal">Literal</option><option value="wildcard">Wildcard * ?</option><option value="regex">Safe regex</option>
    </select>
    <label><input type="checkbox" bind:checked={exact} onchange={refresh} /> Exact</label>
    <label><input type="checkbox" bind:checked={caseSensitive} onchange={refresh} /> Case sensitive</label>
  </div>
  <p class="hint">API: exact, case-sensitive by default. Empty query shows untagged objects too. Select objects to edit atomically. Apply Tag Rules expands templates already on selected documents (not the text field); scene-wide numbering is allocated by the host.</p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if status}<p role="status">{status}</p>{/if}
  <div class="results" data-tag-results>
    {#each results.slice(0, 200) as row (key(row))}
      <label class="result">
        <input type="checkbox" checked={selected.has(key(row))} disabled={!canEdit} onchange={() => toggle(row)} />
        <strong>{row.doc.name}</strong> <small>{row.sceneId}/{row.collection}</small>
        <span>{row.tags.join(", ") || "(untagged)"}</span>
      </label>
    {/each}
    {#if results.length > 200}<p>Showing 200 of {results.length}; narrow your search to edit more.</p>{/if}
    {#if results.length === 0 && !error}<p>No matching placeables.</p>{/if}
  </div>
  {#if canEdit}
    <div class="edit">
      <input aria-label="Tags to edit" data-tags-edit placeholder="Tags (comma-separated)" bind:value={editText} />
      <button type="button" disabled={selectedResults.length === 0} onclick={() => apply("add")}>Add</button>
      <button type="button" disabled={selectedResults.length === 0} onclick={() => apply("remove")}>Remove</button>
      <button type="button" disabled={selectedResults.length === 0} onclick={() => apply("toggle")}>Toggle</button>
      <button type="button" disabled={selectedResults.length === 0} onclick={() => apply("replace")}>Replace</button>
      <button type="button" data-tagger-apply-rules disabled={pendingRules !== null || selectedResults.length === 0 || selectedResults.length > 32}
        onclick={applyRules}>Apply Tag Rules</button>
    </div>
  {/if}
</section>

<style>
  .tagger { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid #424654; font-size: .8rem; }
  h3 { margin: 0; font-size: .95rem; }
  .filters, .edit { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  input:not([type="checkbox"]) { min-width: 100px; flex: 1; }
  select { min-width: 95px; max-width: 175px; }
  .hint { color: #b4bdc8; margin: 0; }
  .results { max-height: 180px; overflow-y: auto; border: 1px solid #444; border-radius: 3px; }
  .result { display: flex; gap: 6px; align-items: center; padding: 3px 5px; border-bottom: 1px solid #303540; }
  .result strong { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .result small { color: #a6afc0; }
  .result span { color: #d2c9ab; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error { color: #ff9f9f; } .edit input { flex: 1; }
</style>
