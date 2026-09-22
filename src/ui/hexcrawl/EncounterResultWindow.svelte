<script lang="ts">
  /**
   * D-272 (plan §5.5) — the **results window**: what the dice said, and what it points at.
   *
   * Phase 3's slice, deliberately: the card, the resolved rows, and an honest `Preview` banner for
   * a wizard *test roll* (nothing created, no ledger, no message). The two ways out the plan lists
   * — **drag a row onto the map** and **Place all** (a ring of tokens ≥ one cell apart, refusing
   * positions inside walls) — are Phase 5's `placeEncounterTokens`, and **Create battle scene**
   * (`duplicateSceneOps`, §5.6) is Phase 5 too; both buttons are present and disabled *with the
   * reason they are waiting*, the same honesty rule the context menu follows.
   *
   * Ref resolution goes through `resolveEncounterRefs`, so a bestiary entry shows the name and art
   * the compendium actually holds, and a world entity shows the actor's own token image.
   */
  import { onDestroy, onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import {
    encounterResultOf,
    forgetEncounterResult,
    resolveEncounterRefs,
    type EncounterResult,
    type ResolvedRef,
  } from "./encounterResult";

  let {
    client,
    resultId,
    onClose = null,
    onPlaceAll = null,
    onBattleScene = null,
  }: {
    client: ClientSync;
    resultId: string;
    /** D-273: closing the window (the host owns window frames); destroy forgets the result. */
    onClose?: (() => void) | null;
    /** D-274: *Place all* — scatter this roll's tokens around its own hex (§5.5). */
    onPlaceAll?: ((resultId: string) => void) | null;
    /**
     * D-274: *Create battle scene* — copy the table's linked scene and place the tokens in the copy
     * (§5.6). The name is what the confirm line asks the GM to agree to.
     */
    onBattleScene?: ((resultId: string) => void) | null;
  } = $props();

  let result = $state<EncounterResult | null>(null);
  let resolved = $state<ResolvedRef[]>([]);
  let resolving = $state(true);

  async function load(): Promise<void> {
    const payload = encounterResultOf(resultId);
    result = payload;
    if (!payload) {
      resolving = false;
      return;
    }
    resolving = true;
    resolved = await resolveEncounterRefs(
      client,
      payload.roll.refs,
      client.world?.id,
    );
    resolving = false;
  }

  onMount(() => {
    void load();
  });
  onDestroy(() => forgetEncounterResult(resultId));

  /** The drag payload the canvas accepts: which result, which row, and how many of it. */
  function startDrag(ev: DragEvent, rowIndex: number): void {
    if (!result) return;
    const payload = {
      resultId,
      rowIndex,
      name: resolved[rowIndex]?.name ?? result.roll.text,
      count: Math.max(1, countOf),
    };
    ev.dataTransfer?.setData("application/x-vtt-encounter", JSON.stringify(payload));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
  }

  /**
   * The confirm line for the battle-scene hand-off (§5.6's own sentence: *Create "Goblin ambush"
   * from "Forest road"?*). An inline two-button row rather than a native `confirm()` — a blocking
   * dialog is untestable in this repo and the window already owns the flow.
   */
  let confirming = $state(false);
  const canPlace = $derived(result !== null && !result.preview && resolved.length > 0);
  /**
   * The battle scene this roll may be played on: the *table's* linked scene (requirement 5d's
   * "optional linked battle scene"). Read here rather than passed down, because the window already
   * holds the client and the roll's table id — a prop would be a second place to keep in step.
   */
  const battleSceneName = $derived.by(() => {
    const tableId = result?.roll.tableId;
    if (!tableId || result?.preview) return null;
    const table = client.store.get("encounterTables", tableId) ?? null;
    const sceneId = table?.sceneId;
    if (!sceneId) return null;
    return client.store.get("scenes", sceneId)?.name ?? null;
  });
  const canBattle = $derived(canPlace && battleSceneName !== null);

  /** How many of the entry the GM asked for: the count applies per ref (§5.4). */
  const countOf = $derived(result?.roll.count ?? 0);
</script>

<div class="result" data-encounter-result>
  {#if !result}
    <p class="hint" data-result-missing>This result is no longer available.</p>
  {:else}
    {#if result.preview}
      <p class="preview" data-result-preview>
        Test roll — nothing was created and no message was posted.
      </p>
    {/if}

    <p class="line">
      <span class="roll" data-result-roll
        >{result.roll.formula} → {result.roll.roll}</span
      >
      <span class="table" data-result-table>{result.roll.tableName}</span>
      {#if result.cellKey}
        <span class="cell" data-result-cell>hex {result.cellKey}</span>
      {/if}
    </p>

    <p class="text" data-result-text>{result.roll.text}</p>
    <p class="count" data-result-count>
      {countOf === 0 ? "nothing to place" : `×${countOf} each`}
    </p>

    {#if resolving}
      <p class="hint">Resolving…</p>
    {:else if resolved.length === 0}
      <p class="hint" data-result-no-refs>
        A text result — drag it nowhere and read it aloud; there is no entity to place.
      </p>
    {:else}
      <ul class="entities">
        {#each resolved as row, i (i)}
          <li
            data-result-entity={i}
            class:missing={row.actor === null && row.note.includes("not found")}
            draggable={canPlace}
            data-result-drag={i}
            title={canPlace ? "drag me onto the map to place one" : ""}
            ondragstart={(ev) => startDrag(ev, i)}
          >
            {#if row.img}
              <img src={row.img} alt="" />
            {:else}
              <span class="noimg" aria-hidden="true">?</span>
            {/if}
            <span class="name" data-result-entity-name={i}>{row.name}</span>
            <span class="note" data-result-entity-note={i}>{row.note}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <footer class="foot">
      {#if confirming && battleSceneName}
        <span class="confirm" data-result-battle-confirm
          >Create “{battleSceneName}” from “{result?.roll.tableName}”?</span
        >
        <button
          type="button"
          data-result-battle-yes
          onclick={() => {
            confirming = false;
            onBattleScene?.(resultId);
          }}>Create it</button
        >
        <button type="button" data-result-battle-no onclick={() => (confirming = false)}
          >Cancel</button
        >
      {:else}
        <button
          type="button"
          data-result-place-all
          disabled={!canPlace}
          title={canPlace
            ? "one token per creature, at least a cell apart, around the hex"
            : "nothing to place — this roll names no entity"}
          onclick={() => onPlaceAll?.(resultId)}>Place all</button
        >
        <button
          type="button"
          data-result-battle-scene
          disabled={!canBattle}
          title={canBattle
            ? `copy ${battleSceneName} and put this encounter's tokens in it`
            : "this table links no battle scene"}
          onclick={() => (confirming = true)}>Create battle scene</button
        >
      {/if}
      <span class="spacer"></span>
      <button
        type="button"
        data-result-close
        onclick={() => {
          // D-273: *Close* used to only forget the result, which left the frame on screen saying
          // "no longer available" — a button that does not do what it says. The host closes it,
          // and the window's own `onDestroy` is what forgets.
          if (onClose) onClose();
          else forgetEncounterResult(resultId);
        }}>Close</button
      >
    </footer>
  {/if}
</div>

<style>
  .result {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    font: 12px/1.45 system-ui, sans-serif;
    color: var(--fg, #e8e8ea);
    height: 100%;
    overflow: auto;
  }
  .preview {
    margin: 0;
    padding: 3px 6px;
    border: 1px solid #6c8;
    border-radius: 3px;
    color: #bfd;
  }
  .line {
    display: flex;
    gap: 8px;
    margin: 0;
  }
  .roll {
    font-weight: 600;
  }
  .table,
  .cell {
    opacity: 0.75;
  }
  .text {
    margin: 0;
    font-size: 13px;
  }
  .count {
    margin: 0;
    opacity: 0.75;
  }
  ul.entities {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  li img,
  .noimg {
    width: 24px;
    height: 24px;
    object-fit: cover;
    border: 1px solid var(--line, #3a3a44);
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.9;
  }
  li.missing .name {
    text-decoration: line-through;
    opacity: 0.7;
  }
  .note {
    opacity: 0.65;
  }
  .entities li[draggable="true"] {
    cursor: grab;
  }
  .confirm {
    font-size: 0.82rem;
    opacity: 0.9;
  }
  .foot {
    display: flex;
    gap: 8px;
    align-items: center;
    border-top: 1px solid var(--line, #3a3a44);
    padding-top: 6px;
    margin-top: auto;
  }
  .spacer {
    flex: 1;
  }
  button {
    background: var(--btn-bg, #26262e);
    color: inherit;
    border: 1px solid var(--line, #3a3a44);
    border-radius: 3px;
    padding: 2px 6px;
    cursor: pointer;
    font: inherit;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hint {
    opacity: 0.75;
  }
</style>
