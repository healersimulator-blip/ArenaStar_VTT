<script lang="ts">
  /** One real ten-slot hotbar; profile-specific presentation never changes execution policy. */
  import type { MacroDocument } from "../../core/documents";
  import { workspaceUi } from "../workspace/state";
  import Icon from "../icons/Icon.svelte";
  let { slots, onRun, onArrange = null, arranging = false, onAssign = null }:
    { slots: ReadonlyArray<MacroDocument | null>; onRun: (index: number) => void;
      onArrange?: (() => void) | null; arranging?: boolean; onAssign?: ((index: number, id: string) => void) | null } = $props();
  let collapsed = $state(false);
  let expandedEmpty = $state(false);
  const emptyModern = $derived($workspaceUi.profile === "modern" && !expandedEmpty && slots.every((slot) => !slot));
  const compact = $derived(collapsed || emptyModern);
  function drop(event: DragEvent, index: number) {
    if (!onAssign) return;
    const id = event.dataTransfer?.getData("application/x-arenastar-macro") ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    event.preventDefault(); event.stopPropagation(); onAssign(index, id);
  }
</script>

<div class="hotbar" class:hotbar-collapsed={compact} data-macro-hotbar aria-label="Macro hotbar">
  <button class="hotbar-toggle" data-icon-button type="button" title={compact ? "Expand macro bar" : "Collapse macro bar"}
    aria-label={compact ? "Expand macro bar" : "Collapse macro bar"} onclick={() => { if (emptyModern) expandedEmpty = true; else collapsed = !collapsed; }}><Icon name="macro" size={16}/></button>
  {#if !compact}
    <div class="hotbar-slots">
      {#each slots as macro, i (i)}
        <button type="button" class="slot" class:bound={!!macro} data-hotbar-slot={i + 1}
          data-hotbar-empty={macro ? undefined : "true"} title={macro ? macro.name : `Empty slot ${i + 1} — open macros to assign`}
          disabled={!macro} onclick={() => { if (macro) onRun(i); }}
          oncontextmenu={(event) => { if (onArrange) { event.preventDefault(); onArrange(); } }}
          ondragover={(event) => { if (onAssign && event.dataTransfer?.types.includes("application/x-arenastar-macro")) event.preventDefault(); }}
          ondrop={(event) => drop(event, i)}>
          <span class="slot-key">{(i + 1) % 10}</span>
          {#if macro}<span class="slot-symbol"><Icon name={macro.kind === "chat" ? "chat" : macro.kind === "sequence" ? "light" : "macro"} size={20}/></span>{/if}
          <span class="slot-name">{macro ? macro.name : $workspaceUi.profile === "roll20" ? "+" : ""}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if onArrange}
    <button class="arrange" type="button" data-player-hotbar-arrange aria-label="Arrange hotbar" title="Arrange macro hotbar"
      aria-haspopup="dialog" aria-expanded={arranging} onclick={onArrange}><Icon name="settings" size={15}/><span>Arrange</span></button>
  {/if}
</div>
