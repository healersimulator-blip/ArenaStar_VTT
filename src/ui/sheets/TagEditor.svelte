<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientEvents, ClientSync } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { BaseDocument } from "../../core/documents";
  import { normalizeTags, prototypeTokenTagsOf, tagAutocompleteSuggestions, tagEditOps, tagsOf, type TagRef } from "../../core/tags";

  let {
    doc,
    targetRef,
    client,
    bus,
    editable,
    scope,
  }: {
    doc: BaseDocument;
    targetRef: TagRef;
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    editable: boolean;
    scope: "actor" | "prototypeToken" | "item";
  } = $props();

  let draftTags = $state<string[]>([]);
  let newTag = $state("");
  let availableTags = $state<string[]>([]);
  let dirty = $state(false);
  let pendingTxId = $state<string | null>(null);
  let pendingTags = $state<string[] | null>(null);
  let status = $state("");
  let error = $state("");
  const label = $derived(scope === "actor" ? "actor" : scope === "prototypeToken" ? "prototype token" : "item");
  const suggestions = $derived(tagAutocompleteSuggestions(availableTags, newTag));

  function currentTags(): string[] {
    return scope === "prototypeToken" ? prototypeTokenTagsOf(doc) : tagsOf(doc);
  }

  $effect(() => {
    const latest = currentTags();
    if (!dirty && pendingTxId === null) draftTags = [...latest];
  });

  function refreshVocabulary(): void {
    const actors = client.store.getAll("actors") as readonly BaseDocument[];
    const worldItems = client.store.getAll("items") as readonly BaseDocument[];
    const embeddedItems = actors.flatMap((actor) => {
      const items = (actor as BaseDocument & { items?: unknown }).items;
      return Array.isArray(items) ? items as BaseDocument[] : [];
    });
    availableTags = [...new Set([
      ...[...actors, ...worldItems, ...embeddedItems].flatMap(tagsOf),
      ...actors.flatMap(prototypeTokenTagsOf),
    ])];
  }

  function addTag(raw: string = newTag): void {
    error = "";
    status = "";
    try {
      const value = raw.trim();
      if (!value) return;
      draftTags = normalizeTags([...draftTags, value]);
      newTag = "";
      dirty = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Invalid tag.";
    }
  }

  function removeTag(tag: string): void {
    draftTags = draftTags.filter((value) => value !== tag);
    dirty = true;
    error = "";
    status = "";
  }

  function clearTags(): void {
    draftTags = [];
    dirty = true;
    error = "";
    status = "";
  }

  function reset(): void {
    draftTags = [...currentTags()];
    newTag = "";
    dirty = false;
    error = "";
    status = "";
  }

  function save(): void {
    if (!editable || pendingTxId !== null) return;
    error = "";
    status = "";
    try {
      const tags = normalizeTags(draftTags);
      const ops = tagEditOps([{ ref: targetRef, doc }], "replace", tags);
      if (ops.length === 0) {
        draftTags = tags;
        dirty = false;
        status = "Tags unchanged.";
        return;
      }
      pendingTags = tags;
      status = "Saving tags…";
      pendingTxId = client.submit(ops);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Invalid tags.";
    }
  }

  onMount(() => {
    refreshVocabulary();
    const offOps = bus.on("ops", ({ reconciled }) => {
      refreshVocabulary();
      if (pendingTxId !== null && reconciled === pendingTxId) {
        draftTags = [...(pendingTags ?? draftTags)];
        pendingTags = null;
        pendingTxId = null;
        dirty = false;
        error = "";
        status = "Tags saved.";
      }
    });
    const offSnapshot = bus.on("snapshot", refreshVocabulary);
    const offRejected = bus.on("rejected", ({ txId, reason, detail }) => {
      if (pendingTxId !== null && txId === pendingTxId) {
        pendingTxId = null;
        pendingTags = null;
        status = "";
        error = `Tag update rejected (${reason}): ${detail}`;
      }
    });
    return () => {
      offOps();
      offSnapshot();
      offRejected();
    };
  });
</script>

<section class="tag-editor" data-document-tags={scope} aria-label={`${label} tags`}>
  <h4>{scope === "actor" ? "Actor tags" : scope === "prototypeToken" ? "Prototype token tags" : "Item tags"}</h4>
  {#if scope === "prototypeToken"}<p class="hint">New tokens created from this actor inherit these labels.</p>{/if}
  <div class="pills" aria-label={`Current ${label} tags`}>
    {#each draftTags as tag, index (`${tag}-${index}`)}
      <span class="pill" data-tag-pill={tag}>
        <span>{tag}</span>
        {#if editable}
          <button type="button" aria-label={`Remove tag ${tag}`} disabled={pendingTxId !== null}
            onclick={() => removeTag(tag)}>×</button
          >
        {/if}
      </span>
    {:else}
      <span class="empty">No tags.</span>
    {/each}
  </div>
  <p class="hint">Tags are labels only; they do not grant visibility or editing access.</p>

  {#if editable}
    <label class="add-row">
      Add {label} tag
      <input
        type="text"
        aria-label={`New ${label} tag`}
        aria-autocomplete="list"
        autocomplete="off"
        maxlength="128"
        value={newTag}
        disabled={pendingTxId !== null}
        oninput={(event) => {
          newTag = event.currentTarget.value;
          error = "";
        }}
        onkeydown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            addTag();
          }
        }}
        data-tag-input
      />
    </label>
    {#if suggestions.length > 0}
      <div class="suggestions" role="listbox" aria-label="Visible tag suggestions">
        {#each suggestions as suggestion (suggestion)}
          <button type="button" role="option" aria-selected="false" data-tag-suggestion={suggestion}
            onclick={() => addTag(suggestion)}>{suggestion}</button
          >
        {/each}
      </div>
    {/if}
    <div class="actions">
      <button type="button" onclick={() => addTag()} disabled={!newTag.trim() || pendingTxId !== null}
        >Add tag</button
      >
      <button type="button" onclick={clearTags} disabled={draftTags.length === 0 || pendingTxId !== null}
        >Clear all</button
      >
      <button type="button" data-tag-save onclick={save} disabled={!dirty || pendingTxId !== null}
        >{pendingTxId === null ? "Save tags" : "Saving…"}</button
      >
      <button type="button" onclick={reset} disabled={!dirty || pendingTxId !== null}>Reset</button>
    </div>
  {/if}
  {#if status}<p role="status" data-tag-status>{status}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  .tag-editor { display: grid; gap: 0.45rem; margin: 0.8rem 0; padding: 0.65rem; border: 1px solid #59616d; border-radius: 0.4rem; }
  h4 { margin: 0; font-size: 0.95rem; }
  .pills, .actions, .suggestions { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
  .pill { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.15rem 0.45rem; border: 1px solid #77808c; border-radius: 999px; background: #29323e; }
  .pill button { padding: 0 0.15rem; border: 0; background: transparent; }
  .add-row { display: grid; gap: 0.25rem; max-width: 24rem; }
  .add-row input { width: 100%; }
  .suggestions button { font-size: 0.85rem; }
  .empty, [role="status"] { opacity: 0.8; }
  [role="alert"] { color: #ffb8ad; }
</style>
