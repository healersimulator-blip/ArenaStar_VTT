<script lang="ts">
  import type { ActorDocument, Json } from "../../core/documents";
  import {
    ARMOR_FIELDS,
    MONSTER_FIELDS,
    armorFieldValue,
    sheetRecord,
    type DetailEdit,
  } from "./pf1eSheetModel";
  let {
    doc,
    editable,
    mode,
    publishedAc,
    onEdit,
  }: {
    doc: ActorDocument;
    editable: boolean;
    mode: "armor" | "features" | "monster";
    publishedAc: boolean;
    onEdit: (edit: DetailEdit) => void;
  } = $props();
  let raw = $derived(sheetRecord(doc.system.pf1e) ?? {});
  let creature = $derived(sheetRecord(raw.creature));
  function stringList(value: Json | undefined): boolean {
    return (
      value === undefined ||
      (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    );
  }
</script>

{#if mode === "armor"}
  <h4>Authored armor and AC components</h4>
  {#if publishedAc}
    <p class="note">
      This actor uses published AC totals. Component editing is disabled: the imported totals
      cannot be reconstructed into armor components without an explicit conversion.
    </p>
  {:else}
    <p class="note">
      These are base values, before active effects. Blank maximum Dexterity means no armor cap.
      Check penalty and spell failure are recorded only; skill and casting automation are not
      implemented here.
    </p>
  {/if}
  {#each ARMOR_FIELDS as [field, label] (field)}
    <label
      >{label}<input
        type="number"
        step="1"
        data-pf1e-detail={field}
        value={armorFieldValue(doc, field) ?? ""}
        placeholder={field === "armor.maxDexBonus" ? "No cap" : "Not authored"}
        disabled={!editable || publishedAc}
        onchange={(e) => onEdit({ kind: "armor", field, raw: e.currentTarget.value })}
      /></label
    >
  {/each}
{:else if mode === "features"}
  <h4>Feats and traits</h4>
  <p class="note">
    One name per line. Names are recorded here; most feat and trait effects are not automated.
    Structured imported entries remain read-only to preserve their notes.
  </p>
  {#each ["feats", "traits"] as field (field)}
    {#if stringList(raw[field])}
      <label
        >{field}<textarea
          rows="5"
          data-pf1e-detail={field}
          value={((raw[field] ?? []) as string[]).join("\n")}
          disabled={!editable}
          onchange={(e) =>
            onEdit({
              kind: "list",
              field: field as "feats" | "traits",
              raw: e.currentTarget.value,
              expected: raw[field],
            })}></textarea></label
      >
    {:else}
      <h4>{field} (structured import, read-only)</h4>
      <pre>{JSON.stringify(raw[field], null, 2)}</pre>
    {/if}
  {/each}
  {#if !creature && (raw.creature === undefined || raw.creature === null)}
    <button
      type="button"
      data-pf1e-add-monster
      disabled={!editable}
      onclick={() => onEdit({ kind: "monster-start" })}>Add monster details</button
    >
  {/if}
{:else if creature}
  <h4>Monster details</h4>
  <p class="note">
    Descriptive stat-block information only. Challenge rating accepts fractions; senses and
    special attacks do not automatically grant rules or vision modes.
  </p>
  {#each MONSTER_FIELDS as [field, label] (field)}
    {#if creature[field] === undefined || typeof creature[field] === "string" || typeof creature[field] === "number"}
      <label
        >{label}<textarea
          rows={field === "specialAttacks" || field === "sq" ? 3 : 1}
          data-pf1e-detail={`creature.${field}`}
          value={String(creature[field] ?? "")}
          disabled={!editable}
          onchange={(e) =>
            onEdit({
              kind: "monster",
              field,
              raw: e.currentTarget.value,
              expected: creature?.[field],
            })}></textarea></label
      >
    {:else}
      <h4>{label} (structured import, read-only)</h4>
      <pre>{JSON.stringify(creature[field], null, 2)}</pre>
    {/if}
  {/each}
  <details>
    <summary>Complete authored creature data</summary>
    <pre>{JSON.stringify(creature, null, 2)}</pre>
  </details>
{:else}
  <p>Creature data is not available.</p>
{/if}

<style>
  h4 {
    margin: 10px 0;
  }
  .note {
    color: #9eafc5;
  }
  label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 8px 0;
  }
  input,
  textarea {
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid #435773;
    border-radius: 4px;
    padding: 5px;
    background: #202b3a;
    color: #e0e5ed;
  }
  input {
    width: 100px;
  }
  textarea {
    width: 100%;
    resize: vertical;
  }
  :disabled {
    opacity: 0.6;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  button {
    border: 1px solid #435773;
    border-radius: 4px;
    padding: 6px;
    background: #202b3a;
    color: #e0e5ed;
    cursor: pointer;
  }
</style>
