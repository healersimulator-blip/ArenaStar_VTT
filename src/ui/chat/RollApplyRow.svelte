<!--
  §2.2 item 3 (G-20/D-261) — the apply/heal verbs on one roll card.

  The buttons carry no damage figure: they name the card and the selected token's actor, and the
  host re-reads `roll.total` from its own committed card (`roll.apply`) and re-checks that the
  sender may update that actor. What this component adds is the *state* of that decision: a target
  the viewer cannot update renders as a named refusal, and a verb the card already applied renders
  as the amount applied, so the same card cannot be counted twice by a double click.
-->
<script lang="ts">
  import type { ClientSync } from "../../client/sync";
  import type { MessageDocument } from "../../core/documents";
  import {
    readRollApplications,
    type PF1eRollApplyMode,
  } from "../../packages/pf1e/rollApply";
  import { appliedLabelFor, type RollApplyTarget } from "./applyTarget";

  let {
    client,
    message,
    target,
  }: {
    client: ClientSync;
    message: MessageDocument;
    /** The selected token's actor, or null when the table has selected nothing (or several). */
    target: RollApplyTarget | null;
  } = $props();

  const applied = $derived(readRollApplications(message));
  const label = $derived(target ? appliedLabelFor(applied, target.actorId) : null);

  function apply(mode: PF1eRollApplyMode): void {
    if (!target || !message.roll) return;
    client.rollApply(message._id, target.actorId, mode);
  }
</script>

{#if target && message.roll}
  <span class="apply-row" data-apply-message={message._id} data-apply-target={target.actorId}>
    {#if target.canUpdate}
      <button
        type="button"
        data-apply-damage={message._id}
        disabled={applied[target.actorId]?.damage !== undefined}
        onclick={() => apply("damage")}
        >Damage → {target.name}</button
      >
      <button
        type="button"
        data-apply-healing={message._id}
        disabled={applied[target.actorId]?.healing !== undefined}
        onclick={() => apply("healing")}
        >Heal → {target.name}</button
      >
    {:else}
      <span class="note" data-apply-refused={message._id}
        >no permission over {target.name}</span
      >
    {/if}
    {#if label}
      <span class="applied" data-apply-applied={message._id}>{label}</span>
    {/if}
  </span>
{/if}

<style>
  .apply-row {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
  }
  .apply-row button {
    padding: 1px 6px;
    border: 1px solid #3a3f4a;
    border-radius: 5px;
    background: #1d2127;
    color: #d8d8e0;
    cursor: pointer;
    font-size: 0.75rem;
  }
  .apply-row button:hover:not(:disabled) {
    background: #262b33;
  }
  .apply-row button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .note {
    color: #9a9aa6;
    font-size: 0.75rem;
  }
  .applied {
    color: #8fd18f;
    font-size: 0.75rem;
  }
</style>
