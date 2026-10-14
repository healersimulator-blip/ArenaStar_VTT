<script lang="ts">
  import { workspaceUi, setWorkspacePanel, toggleWorkspacePanel } from "./state";
  import { workspaceTabOrder, workspaceTabLabel } from "../../core/workspaceUi";
  import Icon from "../icons/Icon.svelte";
  let { active, onSelect, tabs, player = false }: { active: string; onSelect: (id: string) => void; tabs: readonly string[]; player?: boolean } = $props();
  let more = $state(false);
  const ordered = $derived(workspaceTabOrder($workspaceUi.profile).filter((id) => tabs.includes(id)));
  const open = $derived($workspaceUi.panels[$workspaceUi.profile]);
  // Every document tab is one click away in the modern rail and the Foundry column; only the
  // Roll20 strip keeps its reference seven-tab width with an overflow menu (D-464).
  const primary = $derived($workspaceUi.profile === "roll20" ? ordered.slice(0, 7) : ordered);
  // Selecting a tab always shows it; the chevron collapses the drawer. (Re-clicking the active tab
  // used to collapse the modern drawer, which surprised keyboard users and every flow that re-selects
  // a tab to be sure it is open.)
  function select(id: string) {
    setWorkspacePanel(true); onSelect(id);
    more = false;
  }
</script>
<nav class="workspace-tabs" aria-label={player ? "Player content tabs" : "Sidebar tabs"} data-workspace-tabs>
  {#each primary as id (id)}
    <button type="button" data-tab={player ? undefined : id} data-player-tab={player ? id : undefined} data-workspace-tab={id}
      class:active={active === id && open} aria-pressed={active === id && open} aria-label={workspaceTabLabel($workspaceUi.profile, id)}
      title={workspaceTabLabel($workspaceUi.profile, id)} onclick={() => select(id)}>
      <Icon name={id} size={18} /><span class="tab-label">{workspaceTabLabel($workspaceUi.profile, id)}</span>
    </button>
  {/each}
  {#if primary.length < ordered.length}
    <div class="tab-more"><button type="button" title="More panels" aria-label="More panels" aria-expanded={more} data-workspace-more-tabs onclick={() => more = !more}><Icon name="more" size={18}/></button>
      {#if more}<div class="tab-more-menu" role="menu" aria-label="More content panels">
        {#each ordered.slice(primary.length) as id (id)}<button role="menuitem" data-tab={id} data-workspace-tab={id} onclick={() => select(id)}><Icon name={id} size={16}/>{workspaceTabLabel($workspaceUi.profile,id)}</button>{/each}
      </div>{/if}
    </div>
  {/if}
  <button class="sidebar-toggle" type="button" data-workspace-sidebar-toggle aria-label={open ? "Collapse content panel" : "Expand content panel"} title={open ? "Collapse content panel" : "Expand content panel"} onclick={toggleWorkspacePanel}><Icon name={open ? "chevronRight" : "chevronLeft"} size={16}/></button>
</nav>
