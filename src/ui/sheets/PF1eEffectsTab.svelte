<!--
  P4 — the effect surface: the list (suppress/enable/remove/edit) plus the E02
  custom editor. All state changes are Ops computed by `pf1eEffectOps` and
  submitted by the parent sheet, so host authorization stays decisive.
-->
<script lang="ts">
  import {
    describeEffect,
    type PF1eActiveEffect,
    type PF1eEffectPayload,
  } from "../../packages/pf1e/effects";
  import {
    PF1E_CONDITION_NAMES,
    conditionRefusalFor,
    pf1eConditionDef,
    pf1eConditionRequest,
  } from "../../packages/pf1e/conditions";
  import { resolveTacticalEffects } from "../../packages/pf1e/effectOps";

  let {
    effects,
    effectErrors = [],
    editable,
    linkedCombatant,
    onApply,
    onToggle,
    onRemove,
  }: {
    effects: readonly PF1eActiveEffect[];
    effectErrors?: readonly string[];
    editable: boolean;
    /** A linked encounter combatant exists — the combat-timed home is offered. */
    linkedCombatant: boolean;
    onApply: (request: {
      name: string;
      icon?: string;
      payload: PF1eEffectPayload;
      target: "actor" | "combatant";
      effectId?: string;
    }) => void;
    onToggle: (effectId: string, disabled: boolean) => void;
    onRemove: (effectId: string) => void;
  } = $props();

  import PF1eEffectEditor from "./PF1eEffectEditor.svelte";

  /** The effect loaded into the editor for an in-place edit (null = apply mode). */
  let editing = $state<PF1eActiveEffect | null>(null);
  const editId = $derived(editing?.id ?? null);

  function startEdit(effect: PF1eActiveEffect): void {
    editing = effect;
  }
  function cancelEdit(): void {
    editing = null;
  }
  function submitEdit(request: {
    name: string;
    icon?: string;
    payload: PF1eEffectPayload;
    target: "actor" | "combatant";
    effectId?: string;
  }): void {
    onApply(request);
    // Stay in edit mode only if the parent refused; a successful apply clears
    // optimistically — the projected store refreshes the list.
    editing = null;
  }

  /** E03 quick-apply: the library payload, refused by immunity, never silent. */
  let conditionName = $state("");
  let conditionError = $state("");
  function applyCondition(): void {
    conditionError = "";
    const def = pf1eConditionDef(conditionName);
    if (!def) {
      conditionError = "Pick a condition first.";
      return;
    }
    const refusal = conditionRefusalFor(def, resolveTacticalEffects(effects));
    if (refusal) {
      conditionError = refusal;
      return;
    }
    const request = pf1eConditionRequest(conditionName);
    if (!request.ok) {
      conditionError = request.error;
      return;
    }
    onApply({
      name: request.value.name,
      payload: request.value.payload,
      target: "actor",
    });
    conditionName = "";
  }
</script>

<section aria-label="Effects" data-pf1e-effects>
  <h4>Active effects</h4>
  {#if effectErrors.length > 0}
    <p class="warn">
      {#each effectErrors as e (e)}
        <span>{e}</span>
      {/each}
    </p>
  {/if}
  {#if effects.length === 0}
    <p class="note">No effects.</p>
  {:else}
    <ul class="effect-list">
      {#each effects as e (e.id)}
        <li class:disabled={e.disabled} data-pf1e-effect={e.id}>
          <strong>{e.name}</strong>
          <span class="note">{describeEffect(e)}</span>
          {#if e.payload.ttl?.perLevel}
            <span class="note">per level</span>
          {/if}
          {#if editable}
            <button type="button" onclick={() => onToggle(e.id, !e.disabled)}
              >{e.disabled ? "Enable" : "Suppress"}</button
            >
            <button
              type="button"
              data-pf1e-effect-edit
              onclick={() => (editId === e.id ? cancelEdit() : startEdit(e))}
              >{editId === e.id ? "Close" : "Edit"}</button
            >
            <button type="button" onclick={() => onRemove(e.id)}>Remove</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if editable}
    <div class="condition-row" data-pf1e-condition-apply>
      <label>
        Condition
        <select bind:value={conditionName} disabled={!editable}>
          <option value="">— condition —</option>
          {#each PF1E_CONDITION_NAMES as name (name)}
            <option value={name}>{name}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        disabled={!editable || conditionName === ""}
        onclick={applyCondition}>Apply condition</button
      >
      {#if conditionError}<span class="warn" role="alert">{conditionError}</span
        >{/if}
    </div>
    <PF1eEffectEditor
      {editing}
      {editable}
      {linkedCombatant}
      onSubmit={submitEdit}
      onCancelEdit={cancelEdit}
    />
    <p class="note">
      Different bonus types add; the same type keeps the best. A suppressed
      effect changes nothing until re-enabled.
    </p>
  {/if}
</section>

<style>
  .effect-list {
    list-style: none;
    margin: 4px 0;
    padding: 0;
  }
  .effect-list li {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 3px 0;
    border-top: 1px solid #2a3547;
  }
  .effect-list li.disabled :global(strong),
  .effect-list li.disabled :global(span) {
    opacity: 0.5;
  }
  .condition-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 6px;
    border: 1px solid #3a4656;
    border-radius: 6px;
  }
  .condition-row label {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .note {
    color: #9eafc5;
  }
  .warn {
    color: #d9a441;
  }
</style>
