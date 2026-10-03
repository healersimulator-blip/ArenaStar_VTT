<script lang="ts">
  /**
   * MC-01: the five macro hotbar slots (`flags.core.slot`), one row shared by the
   * GM and the player shell. The shell owns what a slot *does* (`runMacroSlot`)
   * and its key bindings; an empty slot is inert.
   */
  import type { MacroDocument } from "../../core/documents";

  let {
    slots,
    onRun,
  }: {
    slots: ReadonlyArray<MacroDocument | null>;
    onRun: (index: number) => void;
  } = $props();
</script>

<div class="hotbar" data-macro-hotbar aria-label="Macro hotbar">
  {#each slots as macro, i (i)}
    <button
      type="button"
      class="slot"
      data-hotbar-slot={i + 1}
      data-hotbar-empty={macro ? undefined : "true"}
      title={macro ? macro.name : `Empty slot ${i + 1}`}
      disabled={!macro}
      onclick={() => onRun(i)}
    >
      {macro ? macro.name.slice(0, 6) : i + 1}
    </button>
  {/each}
</div>

<style>
  .hotbar {
    display: flex;
    gap: 4px;
  }

  .slot {
    width: 34px;
    height: 26px;
    padding: 0;
    font-size: 0.75rem;
    overflow: hidden;
  }

  .slot:disabled {
    opacity: 0.55;
  }
</style>
