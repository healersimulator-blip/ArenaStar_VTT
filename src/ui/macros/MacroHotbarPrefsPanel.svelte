<script lang="ts">
  /** MC-01/D-392: local bindings; the parent owns storage and the live dispatch. */
  import type { MacroDocument } from "../../core/documents";
  import type { MacroHotbarBinding, MacroHotbarPrefs } from "../../core/macroHotbar";

  let { prefs, defaults, choices, onAssign, onReset, status = "" }: {
    prefs: MacroHotbarPrefs;
    defaults: ReadonlyArray<MacroDocument | null>;
    choices: readonly MacroDocument[];
    onAssign: (index: number, binding: MacroHotbarBinding) => void;
    onReset: () => void;
    status?: string;
  } = $props();

  function selectValue(binding: MacroHotbarBinding): string {
    return binding === null ? "inherit" : binding === "" ? "empty" : `macro:${binding}`;
  }
  function assign(index: number, value: string): void {
    if (value === "inherit") onAssign(index, null);
    else if (value === "empty") onAssign(index, "");
    else if (value.startsWith("macro:")) onAssign(index, value.slice(6));
  }
</script>

<section class="hotbar-prefs" aria-label="Hotbar on this device" data-player-hotbar-prefs>
  <p class="hint">Your five slots, saved in this browser for this player and world only.
    This does not change the GM's assignments, anyone else's hotbar or who may run a macro.</p>
  {#each prefs.slots as binding, i (i)}
    <label>Slot {i + 1}
      <select data-player-hotbar-binding={i + 1} aria-label={`Macro hotbar slot ${i + 1}`}
        value={selectValue(binding)} onchange={(event) => assign(i, event.currentTarget.value)}>
        <option value="inherit">GM default: {defaults[i]?.name ?? "empty"}</option>
        <option value="empty">Empty (this device)</option>
        {#if binding && !choices.some((macro) => macro._id === binding)}
          <option value={selectValue(binding)} disabled>Unavailable macro (not in your catalog)</option>
        {/if}
        <optgroup label="Published macros">
          {#each choices as macro (macro._id)}
            <option value={`macro:${macro._id}`}>{macro.name} · {macro.kind}</option>
          {/each}
        </optgroup>
      </select>
    </label>
  {/each}
  <button type="button" data-player-hotbar-reset onclick={onReset}>Use GM defaults</button>
  <p class="hint">Only macros delivered to you are offered; the host checks each request before it may run.
    An assignment missing from your catalog stays empty until it returns, never running a different macro instead.</p>
  {#if status}<p role="status" data-player-hotbar-save-status>{status}</p>{/if}
</section>

<style>
  .hotbar-prefs { display: grid; gap: 7px; }
  label { display: grid; grid-template-columns: 3.5em minmax(0, 1fr); align-items: center; gap: 6px; }
  select { width: 100%; min-width: 0; }
  button { justify-self: start; }
  p { margin: 0; font-size: 0.8125rem; }
  .hint { color: #b4bdc8; }
</style>
