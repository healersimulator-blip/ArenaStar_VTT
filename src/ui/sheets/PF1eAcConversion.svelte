<script lang="ts">
  import type { ActorDocument } from "../../core/documents";
  import type { PermissionUser } from "../../core/ownership";
  import {
    AC_CONVERSION_FIELDS,
    acRevision,
    emptyAcDraft,
    hasPublishedAc,
    previewAcConversion,
    type AcPreview,
    type AcRequest,
  } from "./pf1eAcConversion";
  let {
    doc,
    user,
    onApply,
  }: {
    doc: ActorDocument;
    user: PermissionUser | null;
    onApply: (request: AcRequest) => void;
  } = $props();
  let draft = $state(emptyAcDraft());
  let preview = $state.raw<AcPreview | null>(null);
  let request = $state.raw<AcRequest | null>(null);
  function prepare(mode: "components" | "published"): void {
    // FlatDiff clones documents. Svelte's deep reactive proxies are not structured-cloneable.
    const actor = $state.snapshot(doc);
    request =
      mode === "components"
        ? { mode, draft: { ...draft }, expected: acRevision(actor) }
        : { mode, expected: acRevision(actor) };
    preview = previewAcConversion(actor, user, request);
  }
</script>

{#if hasPublishedAc(doc)}
  <details data-ac-conversion>
    <summary>Change tactical AC source (preview required)</summary>
    <p>
      No components are guessed from published totals. Enter every component, using 0 where
      absent. Applying this choice may change AC. Original published totals and unrelated data
      are retained; strategic profiles are not changed.
    </p>
    {#each AC_CONVERSION_FIELDS as [field, label] (field)}
      <label
        >{label}<input
          type="number"
          step="1"
          data-ac-component={field}
          value={draft[field]}
          oninput={(e) => {
            draft[field] = e.currentTarget.value;
            preview = null;
            request = null;
          }}
        /></label
      >
    {/each}
    <button type="button" data-preview-components onclick={() => prepare("components")}
      >Preview components</button
    >
    <button type="button" data-preview-published onclick={() => prepare("published")}
      >Preview original published totals</button
    >
    {#if preview?.error}<p role="alert">{preview.error}</p>{/if}
    {#if preview?.before && preview.after && !preview.error}
      <p>
        Current AC / touch / flat-footed: <span data-ac-before
          >{preview.before.normal} / {preview.before.touch} / {preview.before.flatFooted}</span
        >
      </p>
      <p>
        Proposed AC / touch / flat-footed: <span data-ac-after
          >{preview.after.normal} / {preview.after.touch} / {preview.after.flatFooted}</span
        >
      </p>
      <p>
        Both previews include the same active effects. If actor data changes, preview again.
      </p>
      <button
        type="button"
        data-apply-ac-source
        onclick={() => {
          if (request) onApply(request);
          preview = null;
          request = null;
        }}>Apply previewed AC source</button
      >
    {/if}
  </details>
{/if}

<style>
  details {
    border: 1px solid #435773;
    padding: 8px;
    margin: 8px 0;
  }
  label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0;
  }
  input {
    width: 100px;
    min-width: 0;
  }
  button,
  input {
    background: #202b3a;
    color: #e0e5ed;
    padding: 5px;
    border: 1px solid #435773;
    border-radius: 4px;
  }
  button {
    margin: 4px;
    cursor: pointer;
  }
</style>
