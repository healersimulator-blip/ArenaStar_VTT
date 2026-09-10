<!--
  P4/E01 — the effect apply/persist surface. Minimal by design: the *custom editor*
  (open-ended keys, boosts, grants, immunities, per-level + endsOn) is E02; this tab
  proves the two persistence homes end-to-end with a typed, validated form. All state
  changes are Ops computed by `pf1eEffectOps` and submitted by the parent sheet, so
  host authorization stays decisive.
-->
<script lang="ts">
  import {
    PF1E_BONUS_TYPES,
    type PF1eBonusType,
  } from "../../packages/pf1e/rulesTables";
  import {
    PF1E_MOD_KEYS,
    PF1E_TTL_UNITS,
    describeEffect,
    type PF1eActiveEffect,
    type PF1eEffectPayload,
    type PF1eModKey,
    type PF1eTtl,
  } from "../../packages/pf1e/effects";

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
      payload: PF1eEffectPayload;
      target: "actor" | "combatant";
    }) => void;
    onToggle: (effectId: string, disabled: boolean) => void;
    onRemove: (effectId: string) => void;
  } = $props();

  let name = $state("");
  let condition = $state("");
  let modKey = $state<PF1eModKey>("ability.str");
  let modType = $state<PF1eBonusType>("enhancement");
  let modValue = $state(4);
  let useTtl = $state(true);
  let ttlUnit = $state<PF1eTtl["unit"]>("minute");
  let ttlValue = $state(1);
  let ttlPerLevel = $state(false);
  let target = $state<"actor" | "combatant">("actor");

  function submit(): void {
    const mods =
      modValue === 0
        ? undefined
        : [{ key: modKey, type: modType, value: modValue }];
    const ttl: PF1eTtl | undefined =
      useTtl &&
      (ttlUnit === "round" || ttlUnit === "minute" || ttlUnit === "hour")
        ? {
            unit: ttlUnit,
            value: Math.max(1, Math.trunc(ttlValue)),
            ...(ttlPerLevel ? { perLevel: true } : {}),
          }
        : undefined;
    const payload: PF1eEffectPayload = {
      ...(mods ? { mods } : {}),
      ...(condition.trim() ? { condition: condition.trim() } : {}),
      ...(ttl ? { ttl } : {}),
    };
    onApply({ name: name.trim(), payload, target });
    name = "";
    condition = "";
  }

  /** The one preset (R02-verified): Bull's Strength, +4 enhancement Str, 1 min/level. */
  function applyBullsStrength(): void {
    onApply({
      name: "Bull's Strength",
      payload: {
        mods: [{ key: "ability.str", type: "enhancement", value: 4 }],
        ttl: { unit: "minute", value: 1, perLevel: true },
        source: { kind: "spell", level: 2 },
      },
      target: linkedCombatant ? "combatant" : "actor",
    });
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
        <li class:disabled={e.disabled}>
          <strong>{e.name}</strong>
          <span class="note">{describeEffect(e)}</span>
          {#if e.payload.ttl?.perLevel}
            <span class="note">per level</span>
          {/if}
          {#if editable}
            <button type="button" onclick={() => onToggle(e.id, !e.disabled)}
              >{e.disabled ? "Enable" : "Suppress"}</button
            >
            <button type="button" onclick={() => onRemove(e.id)}>Remove</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if editable}
    <h4>Apply an effect</h4>
    <form
      class="apply"
      onsubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label
        >Name <input
          required
          maxlength={80}
          bind:value={name}
          placeholder="Bless"
        /></label
      >
      <label
        >Condition <input
          maxlength={40}
          bind:value={condition}
          placeholder="optional label"
        /></label
      >
      <label
        >Stat
        <select bind:value={modKey}>
          {#each PF1E_MOD_KEYS as key (key)}
            <option value={key}>{key}</option>
          {/each}
        </select>
      </label>
      <label
        >Type
        <select bind:value={modType}>
          {#each PF1E_BONUS_TYPES as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </label>
      <label>Value <input type="number" step="1" bind:value={modValue} /></label
      >
      <label>Expires <input type="checkbox" bind:checked={useTtl} /></label>
      {#if useTtl}
        <label
          >Unit
          <select bind:value={ttlUnit}>
            {#each PF1E_TTL_UNITS.filter((u) => u !== "instant") as u (u)}
              <option value={u}>{u}</option>
            {/each}
          </select>
        </label>
        <label
          >Every <input
            type="number"
            min="1"
            step="1"
            bind:value={ttlValue}
          /></label
        >
        <label
          >per level <input type="checkbox" bind:checked={ttlPerLevel} /></label
        >
      {/if}
      {#if linkedCombatant}
        <label
          >Home
          <select bind:value={target}>
            <option value="actor">actor (until removed)</option>
            <option value="combatant">combatant (ticks in combat)</option>
          </select>
        </label>
      {/if}
      <button type="submit" disabled={name.trim() === ""}>Apply</button>
      <button type="button" onclick={applyBullsStrength}>Bull's Strength</button
      >
    </form>
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
  .apply {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 6px;
    border: 1px solid #3a4656;
    border-radius: 6px;
  }
  .apply label {
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
