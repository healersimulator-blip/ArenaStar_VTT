<script lang="ts">
  import type { ActorDocument } from "../../core/documents";
  import type { PF1eDerivedAttack } from "../../packages/pf1e/actor";
  import {
    ATTACK_TEXT_FIELDS,
    ATTACK_NUMBER_FIELDS,
    ATTACK_BOOLEAN_FIELDS,
    MAX_SHEET_ATTACKS,
    pf1eAttackEditorView,
    type AttackEdit,
  } from "./pf1eAttackEditor";
  let {
    doc,
    editable,
    derivedAttacks,
    onEdit,
  }: {
    doc: ActorDocument;
    editable: boolean;
    derivedAttacks: PF1eDerivedAttack[];
    onEdit: (edit: AttackEdit) => void;
  } = $props();
  let view = $derived(pf1eAttackEditorView(doc));
</script>

<section aria-label="Weapon and attack authoring">
  <h4>Authored attack lines</h4>
  <p class="note">
    These are weapon inputs, not rolled results. Blank optional fields use existing defaults. An
    authored range increment implies ranged attacks; clear it to return to melee. Secondary
    implies natural. Ability-included damage disables the additional Strength contribution.
  </p>
  {#if view.legacyWeapon !== undefined}
    <p class="note">
      Imported weapon data is retained below. Editing here creates or changes tactical attack
      lines only; it does not update the strategic weapon profile.
    </p>
    <details>
      <summary>Original strategic weapon (read-only)</summary>
      <pre>{JSON.stringify(view.legacyWeapon, null, 2)}</pre>
    </details>
  {/if}
  {#if view.error}<p role="alert">{view.error}</p>{/if}
  {#each view.rows as row, index (index)}
    <fieldset data-pf1e-attack-row={index} disabled={!editable || view.error !== null}>
      <legend>Attack {index + 1}</legend>
      {#each ATTACK_TEXT_FIELDS as [field, label] (field)}
        {#if row[field] !== null && typeof row[field] === "object"}
          <p>{label} (structured import, read-only)</p>
          <pre>{JSON.stringify(row[field], null, 2)}</pre>
        {:else}
          <label
            >{label}<input
              type="text"
              maxlength="200"
              data-attack-field={field}
              value={String(row[field] ?? "")}
              placeholder="Not authored"
              onchange={(e) =>
                onEdit({
                  kind: "set",
                  index,
                  field,
                  value: e.currentTarget.value,
                  expected: view.rows,
                })}
            /></label
          >
        {/if}
      {/each}
      {#each ATTACK_NUMBER_FIELDS as [field, label] (field)}
        {#if row[field] !== null && typeof row[field] === "object"}
          <p>{label} (structured import, read-only)</p>
          <pre>{JSON.stringify(row[field], null, 2)}</pre>
        {:else}
          <label
            >{label}<input
              type="number"
              step="1"
              data-attack-field={field}
              value={typeof row[field] === "number" ? (row[field] as number) : ""}
              placeholder="Not authored"
              onchange={(e) =>
                onEdit({
                  kind: "set",
                  index,
                  field,
                  value: e.currentTarget.value,
                  expected: view.rows,
                })}
            /></label
          >
        {/if}
      {/each}
      {#each ATTACK_BOOLEAN_FIELDS as [field, label] (field)}
        {#if row[field] !== null && typeof row[field] === "object"}
          <p>{label} (structured import, read-only)</p>
          <pre>{JSON.stringify(row[field], null, 2)}</pre>
        {:else}
          <label
            >{label}<input
              type="checkbox"
              data-attack-field={field}
              checked={row[field] === true}
              onchange={(e) =>
                onEdit({
                  kind: "set",
                  index,
                  field,
                  value: e.currentTarget.checked,
                  expected: view.rows,
                })}
            /></label
          >
        {/if}
      {/each}
      <button
        type="button"
        data-remove-attack
        onclick={() => onEdit({ kind: "remove", index, expected: view.rows })}
        >Remove attack {index + 1}</button
      >
      <details>
        <summary>Complete authored line</summary>
        <pre>{JSON.stringify(row, null, 2)}</pre>
      </details>
    </fieldset>
  {/each}
  {#if view.rows.length === 0 && !view.error}<p>
      No authored attacks. The existing derivation supplies its default unarmed readout.
    </p>{/if}
  <button
    type="button"
    data-add-attack
    disabled={!editable || view.error !== null || view.rows.length >= MAX_SHEET_ATTACKS}
    onclick={() => onEdit({ kind: "add", expected: view.rows })}>Add attack</button
  >
  <h4>Derived attack readout</h4>
  {#each derivedAttacks as attack, index (index)}
    <p data-derived-attack>
      <strong>{attack.name}</strong> · {attack.attackBonuses.join(" / ")} · {attack.damageDice ??
        "—"}
      {attack.damageBonus >= 0 ? "+" : ""}{attack.damageBonus} · {attack.critThreatMin}–20/×{attack.critMultiplier}
    </p>
  {/each}
  <p class="note">
    Attack rolls, ammo, legality, critical resolution and damage application remain P3/P6 work.
    This editor does not certify those rules.
  </p>
</section>

<style>
  h4 {
    margin: 10px 0;
  }
  .note {
    color: #9eafc5;
  }
  fieldset {
    border: 1px solid #435773;
    border-radius: 4px;
    margin: 10px 0;
    min-width: 0;
  }
  label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0;
  }
  input,
  button {
    border: 1px solid #435773;
    border-radius: 4px;
    padding: 5px;
    background: #202b3a;
    color: #e0e5ed;
  }
  input {
    min-width: 0;
    width: 125px;
  }
  input[type="checkbox"] {
    width: auto;
  }
  button {
    cursor: pointer;
  }
  :disabled {
    opacity: 0.6;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
