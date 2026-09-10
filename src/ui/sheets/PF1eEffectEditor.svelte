<!--
  P4/E02 — the custom effect editor. Builds a complete `flags.pf1e` payload:
  typed mod rows, damage boosts, deny/grant tokens, condition label (SRD picker,
  presentation only), immunity block, structural flags, stacking group,
  concentration, ttl (unit/value/per-level/ends-on) and the effect origin.
  All arithmetic-free decisions live in `pf1eEffectEditorModel`; persistence is
  the parent's `onSubmit` → `effectOps` → ClientSync.
-->
<script lang="ts">
  import {
    buildEffectRequest,
    emptyEffectForm,
    EFFECT_SOURCE_KINDS,
    formFromEffect,
    PF1E_BONUS_TYPES,
    PF1E_MOD_KEYS,
    PF1E_TTL_UNITS,
    SRD_CONDITION_NAMES,
    SUGGESTED_DENY_TOKENS,
    type EffectForm,
    type EffectModForm,
  } from "./pf1eEffectEditorModel";
  import type { PF1eActiveEffect } from "../../packages/pf1e/effects";

  let {
    editing = null,
    editable,
    linkedCombatant,
    onSubmit,
    onCancelEdit,
  }: {
    /** An effect loaded for editing (same id, new payload on submit). */
    editing?: PF1eActiveEffect | null;
    editable: boolean;
    linkedCombatant: boolean;
    onSubmit: (request: {
      name: string;
      icon?: string;
      payload: import("../../packages/pf1e/effects").PF1eEffectPayload;
      target: "actor" | "combatant";
      effectId?: string;
    }) => void;
    onCancelEdit: () => void;
  } = $props();

  let form = $state<EffectForm>(emptyEffectForm());
  let target = $state<"actor" | "combatant">("actor");
  let error = $state("");

  // Loading an effect for edit (or clearing it) resets the form from its payload.
  $effect(() => {
    form = editing ? formFromEffect(editing) : emptyEffectForm();
    error = "";
  });

  function addModRow(): void {
    form.mods = [
      ...form.mods,
      { key: "", type: "untyped", value: "", source: "" },
    ];
  }
  function removeModRow(index: number): void {
    form.mods = form.mods.filter((_, i) => i !== index);
  }
  function addBoostRow(): void {
    form.boosts = [
      ...form.boosts,
      { dice: "", sides: "6", bonus: "", energy: "", precision: false },
    ];
  }
  function removeBoostRow(index: number): void {
    form.boosts = form.boosts.filter((_, i) => i !== index);
  }
  function modKeyTouched(row: EffectModForm): boolean {
    return row.key !== "" || row.value.trim() !== "";
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const { request, error: buildError } = buildEffectRequest(form);
    if (!request) {
      error = buildError ?? "This effect cannot be built.";
      return;
    }
    error = "";
    onSubmit({
      name: request.name,
      ...(request.icon !== undefined ? { icon: request.icon } : {}),
      payload: request.payload,
      target,
      ...(editing ? { effectId: editing.id } : {}),
    });
    if (!editing) form = emptyEffectForm();
  }
</script>

<form
  class="editor"
  data-pf1e-effect-editor
  onsubmit={submit}
  aria-label={editing ? `Edit ${editing.name}` : "Apply an effect"}
>
  <h4>{editing ? `Edit: ${editing.name}` : "Apply an effect"}</h4>
  {#if !editable}
    <p class="note">Read-only (no ownership).</p>
  {/if}
  {#if error}
    <p class="warn" role="alert">{error}</p>
  {/if}

  <div class="rows">
    <label>
      Name
      <input
        required
        maxlength={80}
        data-pf1e-effect-name
        disabled={!editable}
        bind:value={form.name}
        placeholder="Bless"
      />
    </label>
    <label>
      Icon
      <input
        maxlength={16}
        disabled={!editable}
        bind:value={form.icon}
        placeholder="⚔"
      />
    </label>
    <label>
      Condition
      <input
        maxlength={40}
        disabled={!editable}
        data-pf1e-effect-condition
        bind:value={form.condition}
        list="pf1e-condition-names"
        placeholder="display only"
      />
      <datalist id="pf1e-condition-names">
        {#each SRD_CONDITION_NAMES as name (name)}
          <option value={name}></option>
        {/each}
      </datalist>
    </label>
  </div>

  <fieldset>
    <legend>Modifiers (typed — same type competes, different types add)</legend>
    {#each form.mods as row, i (i)}
      <div class="row" data-pf1e-effect-mod>
        <select disabled={!editable} bind:value={row.key} aria-label="Stat">
          <option value="">— stat —</option>
          {#each PF1E_MOD_KEYS as key (key)}
            <option value={key}>{key}</option>
          {/each}
        </select>
        <select
          disabled={!editable}
          bind:value={row.type}
          aria-label="Bonus type"
        >
          {#each PF1E_BONUS_TYPES as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
        <input
          type="number"
          step="1"
          disabled={!editable}
          bind:value={row.value}
          placeholder="±value"
          aria-label="Value"
        />
        <input
          maxlength={40}
          disabled={!editable}
          bind:value={row.source}
          placeholder="source (untyped/circumstance)"
          aria-label="Source"
        />
        {#if form.mods.length > 1}
          <button
            type="button"
            disabled={!editable}
            onclick={() => removeModRow(i)}>×</button
          >
        {/if}
      </div>
      {#if !modKeyTouched(row) && i === form.mods.length - 1}
        <p class="note">Untouched rows are ignored.</p>
      {/if}
    {/each}
    <button type="button" disabled={!editable} onclick={addModRow}
      >Add modifier</button
    >
  </fieldset>

  <fieldset>
    <legend>Damage boosts (never multiplied on a critical)</legend>
    {#each form.boosts as row, i (i)}
      <div class="row" data-pf1e-effect-boost>
        <input
          type="number"
          step="1"
          min="1"
          disabled={!editable}
          bind:value={row.dice}
          placeholder="dice"
          aria-label="Dice"
        />
        <span>d</span>
        <input
          type="number"
          step="1"
          min="2"
          disabled={!editable}
          bind:value={row.sides}
          placeholder="sides"
          aria-label="Die size"
        />
        <input
          type="number"
          step="1"
          disabled={!editable}
          bind:value={row.bonus}
          placeholder="flat"
          aria-label="Flat bonus"
        />
        <input
          maxlength={20}
          disabled={!editable}
          bind:value={row.energy}
          placeholder="energy type"
          aria-label="Energy type"
        />
        <label class="inline"
          ><input
            type="checkbox"
            disabled={!editable}
            bind:checked={row.precision}
          />precision</label
        >
        <button
          type="button"
          disabled={!editable}
          onclick={() => removeBoostRow(i)}>×</button
        >
      </div>
    {/each}
    <button
      type="button"
      disabled={!editable}
      data-pf1e-effect-add-boost
      onclick={addBoostRow}>Add boost</button
    >
  </fieldset>

  <fieldset>
    <legend>Restrictions and grants</legend>
    <div class="row">
      <label class="grow"
        >Denies
        <input
          disabled={!editable}
          data-pf1e-effect-denies
          bind:value={form.denies}
          list="pf1e-deny-tokens"
          placeholder="e.g. charge, full-attack"
        />
        <datalist id="pf1e-deny-tokens">
          {#each SUGGESTED_DENY_TOKENS as token (token)}
            <option value={token}></option>
          {/each}
        </datalist>
      </label>
      <label class="grow"
        >Grants
        <input
          disabled={!editable}
          bind:value={form.grants}
          placeholder="evasion, uncanny-dodge…"
        />
      </label>
    </div>
    <div class="row">
      <label class="inline"
        ><input
          type="checkbox"
          disabled={!editable}
          bind:checked={form.flatFooted}
        />flat-footed</label
      >
      <label class="inline"
        ><input
          type="checkbox"
          disabled={!editable}
          bind:checked={form.deniedDexToAc}
        />denied Dex to AC</label
      >
      <label class="inline"
        ><input
          type="checkbox"
          disabled={!editable}
          bind:checked={form.cannotAoO}
        />cannot take AoOs</label
      >
      <label class="inline"
        ><input
          type="checkbox"
          disabled={!editable}
          bind:checked={form.concentration}
        />requires concentration</label
      >
    </div>
    <div class="row">
      <label class="grow"
        >Stacking group
        <input
          maxlength={40}
          disabled={!editable}
          bind:value={form.stackGroup}
          placeholder="e.g. rage — best only between members"
        />
      </label>
      <label class="inline"
        >Immune: mind-affecting
        <input
          type="checkbox"
          disabled={!editable}
          bind:checked={form.immuneMindAffecting}
        />
      </label>
      <label class="grow"
        >Immune: conditions
        <input disabled={!editable} bind:value={form.immuneConditions} />
      </label>
      <label class="grow"
        >Immune: energy
        <input disabled={!editable} bind:value={form.immuneEnergy} />
      </label>
      <label
        >Immune: DR
        <input
          type="number"
          step="1"
          min="0"
          disabled={!editable}
          bind:value={form.immuneDr}
          class="num"
        />
      </label>
    </div>
  </fieldset>

  <fieldset>
    <legend>Duration</legend>
    <div class="row">
      <label>
        Unit
        <select disabled={!editable} bind:value={form.ttlUnit}>
          <option value="">permanent (until removed)</option>
          {#each PF1E_TTL_UNITS.filter((u) => u !== "instant" && u !== "permanent") as u (u)}
            <option value={u}>{u}</option>
          {/each}
        </select>
      </label>
      {#if form.ttlUnit !== ""}
        <label>
          Every
          <input
            type="number"
            min="1"
            step="1"
            disabled={!editable}
            bind:value={form.ttlValue}
            class="num"
          />
        </label>
        <label class="inline"
          >per level
          <input
            type="checkbox"
            disabled={!editable}
            bind:checked={form.ttlPerLevel}
          />
        </label>
        <label>
          Ends on
          <select disabled={!editable} bind:value={form.ttlEndsOn}>
            <option value="own-turn">own turn end</option>
            <option value="round-start">round start</option>
          </select>
        </label>
      {/if}
    </div>
    <p class="note">
      1 minute = 10 rounds, 1 hour = 100 rounds. Minutes/hours outside combat
      end through the world clock (E05).
    </p>
  </fieldset>

  <fieldset>
    <legend>Origin</legend>
    <div class="row">
      <label>
        Kind
        <select disabled={!editable} bind:value={form.sourceKind}>
          <option value="">—</option>
          {#each EFFECT_SOURCE_KINDS as kind (kind)}
            <option value={kind}>{kind}</option>
          {/each}
        </select>
      </label>
      <label
        >Id <input
          maxlength={40}
          disabled={!editable}
          bind:value={form.sourceId}
        /></label
      >
      <label
        >Level
        <input
          type="number"
          step="1"
          disabled={!editable}
          bind:value={form.sourceLevel}
          class="num"
        /></label
      >
      <label
        >DC
        <input
          type="number"
          step="1"
          disabled={!editable}
          bind:value={form.sourceDc}
          class="num"
        /></label
      >
    </div>
  </fieldset>

  {#if editable}
    <div class="rows">
      {#if linkedCombatant}
        <label>
          Home
          <select disabled={!!editing} bind:value={target}>
            <option value="actor">actor (until removed)</option>
            <option value="combatant">combatant (ticks in combat)</option>
          </select>
        </label>
      {/if}
      <button type="submit" data-pf1e-effect-submit>
        {editing ? "Save changes" : "Apply"}
      </button>
      {#if editing}
        <button type="button" onclick={onCancelEdit}>Cancel</button>
      {/if}
    </div>
  {/if}
</form>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  fieldset {
    border: 1px solid #2a3547;
    border-radius: 6px;
    padding: 4px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  legend {
    color: #9eafc5;
    padding: 0 4px;
  }
  .rows,
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .row label,
  .rows label {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  label.grow {
    flex: 1 1 140px;
  }
  label.inline {
    white-space: nowrap;
  }
  .row input:not([type="checkbox"]):not(.num) {
    flex: 1 1 90px;
  }
  .num {
    width: 64px;
  }
  .note {
    color: #9eafc5;
    margin: 0;
  }
  .warn {
    color: #d9a441;
    margin: 0;
  }
</style>
