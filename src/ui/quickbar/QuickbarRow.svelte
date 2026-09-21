<!--
  §2.2 item 2 (G-10b, D-261) — the per-character quickbar.

  Five slots bound on the character's own document (`flags.pf1e.quickbar`), each running the sheet's
  own flow: an attack against the chosen target, the attack's damage as a public card (which the
  apply verb can then land), or a castable item's spell. The GM's world-level macro hotbar is
  untouched — these slots are *character* data, so a player sees the same five actions their
  character has on every replica, and binding one is an ordinary undoable op.

  "Title character, chosen target": the character is the selected token's actor (a player plays
  their own character); the target is an explicit choice, and **the character is one of the
  choices** — a buff on yourself, a self-targeted spell or a deliberate self-attack are all legal
  and all flow through the same sheet code, so there is no reason for this bar to know better than
  the rules. Nothing is pre-selected: an attack or an item slot with no target says so rather than
  guessing at one.
-->
<script lang="ts">
  import type { ClientSync } from "../../client/sync";
  import type { ActorDocument } from "../../core/documents";
  import { deriveFromActorDocument } from "../../packages/pf1e/actor";
  import { worldSettingsFrom } from "../../core/worldSettings";
  import {
    bindQuickbarSlot,
    candidateToEntry,
    clearQuickbarSlot,
    quickbarCandidates,
    quickbarSlotNote,
    quickbarWriteOp,
    readQuickbar,
    QUICKBAR_SLOTS,
  } from "./model";
  import { runQuickbarEntry } from "./run";

  let {
    client,
    actor = null,
    targets = [],
  }: {
    client: ClientSync;
    /** The character this bar plays — the selected token's actor, or null with nothing selected. */
    actor?: ActorDocument | null;
    /** Every actor the viewer may read — the target choices, the character included. */
    targets?: readonly ActorDocument[];
  } = $props();

  let busy = $state(false);
  let status = $state("");
  let error = $state("");
  let candidateId = $state("");
  let bindSlot = $state(1);
  let picked = $state("");

  const settings = $derived(client.store.getAll("settings"));
  const derived = $derived(
    actor === null
      ? null
      : deriveFromActorDocument(actor, settings.length > 0 ? worldSettingsFrom(settings) : {}),
  );
  const entries = $derived(actor === null ? [] : readQuickbar(actor));
  const candidates = $derived(
    actor === null || derived === null ? [] : quickbarCandidates(actor, derived),
  );
  /** The picker's answer, and only that — a stale id (the actor left the replica) reads as none. */
  const targetId = $derived(picked !== "" && targets.some((t) => t._id === picked) ? picked : "");
  const target = $derived(targets.find((t) => t._id === targetId) ?? null);

  function slotEntry(slot: number) {
    return entries.find((e) => e.slot === slot) ?? null;
  }

  /** What the slot refuses for *right now* — an empty slot, a target the verb needs, stale gear. */
  function slotHint(slot: number): string | null {
    const entry = slotEntry(slot);
    if (entry === null) return "empty — bind an action below";
    if (actor === null || derived === null) return "no character selected";
    const note = quickbarSlotNote(actor, entry, derived);
    if (note !== null) return note;
    if (entry.kind !== "damage" && target === null) return "pick a target first";
    return null;
  }

  async function run(slot: number): Promise<void> {
    const entry = slotEntry(slot);
    status = "";
    error = "";
    if (actor === null || entry === null) return;
    const hint = slotHint(slot);
    if (hint !== null) {
      error = hint;
      return;
    }
    busy = true;
    try {
      const outcome = await runQuickbarEntry({ client, actor, entry, target });
      if (outcome.ok) status = outcome.note;
      else error = outcome.error;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function bind(): void {
    if (actor === null) return;
    const candidate = candidates.find((c) => c.id === candidateId);
    if (candidate === undefined) return;
    const current = readQuickbar(actor);
    client.submit([quickbarWriteOp(actor, bindQuickbarSlot(current, candidateToEntry(bindSlot, candidate)))]);
    status = `slot ${String(bindSlot)} → ${candidate.label}`;
    error = "";
  }

  function clear(slot: number): void {
    if (actor === null) return;
    client.submit([quickbarWriteOp(actor, clearQuickbarSlot(readQuickbar(actor), slot))]);
    status = `slot ${String(slot)} cleared`;
    error = "";
  }
</script>

<section class="quickbar" data-quickbar>
  <header>
    <span class="label">Quickbar</span>
    {#if actor === null}
      <span class="hint" data-quickbar-actor="none">select a token to play its character</span>
    {:else}
      <span class="hint" data-quickbar-actor={actor._id}>{actor.name}</span>
      <select data-quickbar-target bind:value={picked} aria-label="Target">
        <option value="">{target === null ? "no target" : `target: ${target.name}`}</option>
        {#each targets as choice (choice._id)}
          <option value={choice._id}>{choice.name}</option>
        {/each}
      </select>
    {/if}
  </header>

  <div class="slots">
    {#each QUICKBAR_SLOTS as slot (slot)}
      {@const entry = slotEntry(slot)}
      {@const hint = slotHint(slot)}
      <button
        type="button"
        data-quickbar-slot={slot}
        class:bound={entry !== null}
        title={hint ?? entry?.label ?? "empty"}
        disabled={busy || actor === null}
        onclick={() => void run(slot)}
      >
        <span class="key">{slot}</span>
        <span class="name">{entry?.label ?? "—"}</span>
      </button>
      <button
        type="button"
        class="clear"
        data-quickbar-clear={slot}
        title={`Clear slot ${slot}`}
        disabled={actor === null || entry === null}
        onclick={() => clear(slot)}>✕</button
      >
    {/each}
  </div>

  {#if actor !== null}
    <div class="bind">
      <select data-quickbar-bind bind:value={candidateId} aria-label="Action to bind">
        <option value="">Bind an action…</option>
        {#each candidates as candidate (candidate.id)}
          <option value={candidate.id}>{candidate.label} — {candidate.detail}</option>
        {/each}
      </select>
      <select data-quickbar-slot-select bind:value={bindSlot} aria-label="Slot">
        {#each QUICKBAR_SLOTS as slot (slot)}
          <option value={slot}>slot {slot}</option>
        {/each}
      </select>
      <button
        type="button"
        data-quickbar-bind-apply
        disabled={busy || candidateId === ""}
        onclick={bind}>Bind</button
      >
    </div>
  {/if}

  {#if error !== ""}
    <p class="error" role="alert" data-quickbar-error>{error}</p>
  {:else if status !== ""}
    <p class="status" role="status" data-quickbar-status>{status}</p>
  {/if}
</section>

<style>
  .quickbar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px;
    border-top: 1px solid #2b2f38;
    font-size: 0.8rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    align-items: baseline;
  }
  .label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9a9aa6;
    font-size: 0.7rem;
  }
  .hint {
    color: #7f8490;
    font-size: 0.72rem;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  header select {
    max-width: 45%;
    padding: 2px 4px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #101216;
    color: #e8e8ee;
    font-size: 0.72rem;
  }
  .slots {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .slots button {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 4px 6px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #1d2127;
    color: #e8e8ee;
    cursor: pointer;
  }
  .slots button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .slots button.bound {
    border-color: #4b5566;
  }
  .slots .key {
    color: #9a9aa6;
    font-variant-numeric: tabular-nums;
  }
  .slots .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 120px;
  }
  .clear {
    padding: 2px 4px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #1d2127;
    color: #9a9aa6;
    cursor: pointer;
  }
  .bind {
    display: flex;
    gap: 4px;
  }
  .bind select {
    min-width: 0;
    flex: 1;
    padding: 3px 4px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #101216;
    color: #e8e8ee;
  }
  .bind button {
    padding: 3px 8px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #1d2127;
    color: #e8e8ee;
    cursor: pointer;
  }
  .status {
    margin: 0;
    color: #8fd18f;
  }
  .error {
    margin: 0;
    color: #f0a0a0;
  }
</style>
