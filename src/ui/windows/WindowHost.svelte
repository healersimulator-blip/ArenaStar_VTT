<script lang="ts">
  /**
   * §10 window host — renders WindowManager windows over the canvas, chrome
   * INLINE: the Svelte compiler only marks {#each} items reactive (flags 21)
   * when item fields are read inside the block — passing the item OBJECT to
   * a child component compiles items as snapshots (flags 17) and geometry
   * goes stale (D-079). GM tools + journal popouts are the residents.
   */
  import type { WindowManager, WindowSpec } from "../../core/windows";
  import type { HostPackages, HostRulesBoot } from "../../app/hostBoot";
  import PermissionsPanel from "../permissions/PermissionsPanel.svelte";
  import MacrosPanel from "../macros/MacrosPanel.svelte";
  import SettingsPanel from "../settings/SettingsPanel.svelte";
  import JournalPopout from "../journals/JournalPopout.svelte";
  import PF1eSheetWindow from "../sheets/PF1eSheetWindow.svelte";
  import GmExtrasPanel from "../armies/GmExtrasPanel.svelte";
  import ArmiesTab from "../armies/ArmiesTab.svelte";
  import CombatPanel from "../combat/CombatPanel.svelte";
  import HelpPanel from "../canvas/HelpPanel.svelte";
  import ArmyWindow from "../armies/ArmyWindow.svelte";
  import { armyWindowRules } from "../armies/armyModel";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";

  let {
    manager,
    windows,
    client,
    bus,
    sceneId = null,
    onUndo,
    onRedo,
    packages = null,
    rulesBoot = null,
    bindings = {},
    isGM = false,
  }: {
    manager: WindowManager;
    /** App-derived copy (manager.list() is a live ref — each{} needs fresh identity). */
    windows: readonly WindowSpec[];
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    sceneId?: string | null;
    onUndo: () => void;
    onRedo: () => void;
    packages?: HostPackages | null;
    /** Which strategic ruleset booted (Settings → ruleset section status line). */
    rulesBoot?: HostRulesBoot | null;
    /** §10 keybinding map for the help window (D-256). */
    bindings?: Readonly<Record<string, string>>;
    isGM?: boolean;
  } = $props();

  /**
   * Geometry/z-order/minimized sync as an ACTION: Svelte 5.57 compiles
   * {#each} items that only feed child markup as snapshots (flags 17), so
   * imperative sync via a manager subscription is the reliable path for
   * in-place updates (D-079). Open/close still ride the each (array identity).
   */
  export function bindWindow(
    el: HTMLElement,
    params: { manager: WindowManager; id: string },
  ): {
    update(p: { manager: WindowManager; id: string }): void;
    destroy(): void;
  } {
    let p = params;
    const apply = (): void => {
      const w = p.manager.get(p.id);
      if (!w) return;
      el.style.left = `${w.x}px`;
      el.style.top = `${w.y}px`;
      el.style.width = `${w.width}px`;
      el.style.height = `${w.minimized ? 34 : w.height}px`;
      el.style.zIndex = String(w.z);
      el.classList.toggle("minimized", w.minimized);
    };
    const off = params.manager.onChange(apply);
    apply();
    return {
      update(next) {
        p = next;
        apply();
      },
      destroy: off,
    };
  }

  /** Global move/up listeners — survive manager re-renders mid-drag. */
  function dragGlobals(onMove: (ev: PointerEvent) => void): void {
    const up = (): void => {
      globalThis.removeEventListener("pointermove", onMove);
      globalThis.removeEventListener("pointerup", up);
    };
    globalThis.addEventListener("pointermove", onMove);
    globalThis.addEventListener("pointerup", up);
  }

  function startDrag(e: PointerEvent, win: WindowSpec): void {
    manager.focus(win.id);
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, wx: win.x, wy: win.y };
    dragGlobals((ev) => {
      manager.moveTo(
        win.id,
        start.wx + (ev.clientX - start.x),
        start.wy + (ev.clientY - start.y),
      );
    });
  }

  function startResize(e: PointerEvent, win: WindowSpec): void {
    manager.focus(win.id);
    e.stopPropagation();
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, w: win.width, h: win.height };
    dragGlobals((ev) => {
      manager.resize(
        win.id,
        start.w + (ev.clientX - start.x),
        start.h + (ev.clientY - start.y),
      );
    });
  }
</script>

<div class="wm-layer" aria-label="Windows">
  {#each windows as win (win.id)}
    <section
      class="wm-window"
      data-window={win.id}
      use:bindWindow={{ manager, id: win.id }}
      onpointerdown={() => manager.focus(win.id)}
      aria-label={win.title}
    >
      <header
        class="wm-title"
        role="toolbar"
        tabindex="-1"
        aria-label={`${win.title} window controls`}
        onpointerdown={(e) => startDrag(e, win)}
      >
        <span class="wm-name">{win.title}</span>
        <span class="wm-buttons">
          <button
            type="button"
            data-window-min
            title="Minimize"
            onclick={() => manager.toggleMinimize(win.id)}
          >
            {win.minimized ? "▾" : "–"}
          </button>
          <button
            type="button"
            data-window-close
            title="Close"
            onclick={() => manager.close(win.id)}
          >
            ×
          </button>
        </span>
      </header>
      <div class="wm-body">
        {#if win.kind === "pf1e-sheet" && win.data}
          <PF1eSheetWindow
            {client}
            {bus}
            actorId={win.data.actorId ?? ""}
            initialTab={typeof win.data.tab === "string"
              ? win.data.tab
              : "summary"}
          />
        {:else if win.kind === "combat"}
          <CombatPanel {client} {bus} />
        {:else if win.kind === "help"}
          <HelpPanel {bindings} {isGM} />
        {:else if win.kind === "permissions"}
          <PermissionsPanel {client} {bus} />
        {:else if win.kind === "macros"}
          <MacrosPanel {client} {bus} />
        {:else if win.kind === "settings"}
          <SettingsPanel {client} {bus} {onUndo} {onRedo} {packages} {rulesBoot} />
        {:else if win.kind === "journal" && win.data}
          <JournalPopout
            {client}
            journalId={win.data.journalId ?? ""}
            pageId={win.data.pageId ?? ""}
          />
        {:else if win.kind === "gmextras"}
          <GmExtrasPanel {client} {bus} {sceneId} />
        {:else if win.kind === "armies"}
          <ArmiesTab
            {client}
            {bus}
            onOpen={(armyId) => {
              const name = client.store.get("armies", armyId)?.name ?? "Army";
              manager.open({
                id: `army:${armyId}`,
                title: `Army — ${name}`,
                kind: "army",
                x: 60,
                y: 60,
                width: 520,
                height: 560,
                data: { armyId },
              });
            }}
          />
        {:else if win.kind === "army" && win.data}
          {#await armyWindowRules(packages) then rules}
            <ArmyWindow
              {client}
              {bus}
              armyId={win.data.armyId ?? ""}
              {rules}
              onClose={() => manager.close(win.id)}
            />
          {/await}
        {/if}
      </div>
      <div
        class="wm-resize"
        role="separator"
        aria-label={`Resize ${win.title}`}
        tabindex="-1"
        onpointerdown={(e) => startResize(e, win)}
        title="Resize window"
      ></div>
    </section>
  {/each}
</div>

<style>
  .wm-layer {
    position: absolute;
    inset: 0;
    pointer-events: none; /* windows re-enable their own pointer events */
    overflow: visible; /* windows may hang past the canvas edge (manager keeps
      the title bar reachable); hidden clipped the resize handle after a
      downward drag — elementFromPoint hit <html> (D-079) */
  }
  .wm-window {
    pointer-events: auto;
    position: absolute;
    display: flex;
    flex-direction: column;
    background: #141821;
    border: 1px solid #3a4656;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.5);
    overflow: hidden;
  }
  .wm-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 44px;
    height: 44px;
    padding: 0 10px;
    background: #1d2530;
    cursor: grab;
    user-select: none;
    touch-action: none;
  }
  .wm-name {
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wm-buttons {
    display: flex;
    gap: 6px;
  }
  .wm-buttons button {
    width: 34px;
    height: 34px;
    line-height: 1;
    padding: 0;
    border-radius: 6px;
    font-size: 1rem;
  }
  .wm-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 14px;
    font-size: 1rem;
  }
  :global(.wm-window.minimized .wm-body),
  :global(.wm-window.minimized .wm-resize) {
    display: none;
  }
  .wm-resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    touch-action: none;
    background: linear-gradient(135deg, transparent 50%, #3a4656 50%);
  }
</style>
