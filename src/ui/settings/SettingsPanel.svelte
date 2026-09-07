<script lang="ts">
  /**
   * §10 settings window (GM) — active-scene grid editor (drives the canvas +
   * measurement), keybinding reference and undo/redo controls. Client-pref
   * and module sections land when their consumers do (D-079).
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { SceneDocument, SceneGrid } from "../../core/documents";
  import { DEFAULT_BINDINGS } from "../../core/keys";

  let {
    client,
    bus,
    onUndo,
    onRedo,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    onUndo: () => void;
    onRedo: () => void;
  } = $props();

  let grid = $state<SceneGrid | null>(null);
  let sceneId = $state("");
  let scale = $state<"tactical" | "strategic">("tactical");

  function refresh(): void {
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const active = scenes.find((s) => s.active) ?? scenes[0] ?? null;
    sceneId = active?._id ?? "";
    grid = active ? { ...active.grid } : null;
    scale =
      (active?.flags as { core?: { scale?: unknown } } | undefined)?.core?.scale === "strategic"
        ? "strategic"
        : "tactical";
  }

  /** §9A: scale flag gates strategic fog + linked-scene behaviour (D-080). */
  function applyScale(next: "tactical" | "strategic"): void {
    if (!sceneId) return;
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const scene = scenes.find((sc) => sc._id === sceneId);
    if (!scene) return;
    const flags = {
      ...scene.flags,
      core: { ...((scene.flags as { core?: object } | undefined)?.core ?? {}), scale: next },
    };
    client.submit([{ kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { flags } }]);
  }

  function apply(): void {
    if (!grid || !sceneId) return;
    client.submit([{ kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { grid } }]);
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    return () => {
      offSnapshot();
      offOps();
    };
  });
</script>

<div class="settings">
  <h4>Scene grid</h4>
  {#if grid}
    <div class="row">
      <label>
        Scale
        <select
          data-scene-scale
          value={scale}
          onchange={(e) => {
            scale = (e.target as HTMLSelectElement).value as "tactical" | "strategic";
            applyScale(scale);
          }}
        >
          {#each ["tactical", "strategic"] as sc (sc)}
            <option value={sc}>{sc}</option>
          {/each}
        </select>
      </label>
      <label>
        Type
        <select
          data-grid-type
          value={grid.type}
          onchange={(e) => {
            grid = { ...grid, type: (e.target as HTMLSelectElement).value as SceneGrid["type"] };
            apply();
          }}
        >
          {#each ["square", "hex", "gridless"] as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </label>
      <label>
        Hex layout
        <select
          data-grid-layout
          value={grid.hexLayout}
          disabled={grid.type !== "hex"}
          onchange={(e) => {
            grid = {
              ...grid,
              hexLayout: (e.target as HTMLSelectElement).value as SceneGrid["hexLayout"],
            };
            apply();
          }}
        >
          {#each ["evenQ", "oddQ", "evenR", "oddR"] as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="row">
      <label>
        Size
        <input
          data-grid-size
          type="number"
          min="10"
          max="400"
          value={grid.size}
          onchange={(e) => {
            grid = { ...grid, size: Number((e.target as HTMLInputElement).value) };
            apply();
          }}
        />
      </label>
      <label>
        Distance
        <input
          data-grid-distance
          type="number"
          min="1"
          value={grid.distance}
          onchange={(e) => {
            grid = { ...grid, distance: Number((e.target as HTMLInputElement).value) };
            apply();
          }}
        />
      </label>
      <label>
        Units
        <input
          data-grid-units
          type="text"
          value={grid.units}
          onchange={(e) => {
            grid = { ...grid, units: (e.target as HTMLInputElement).value };
            apply();
          }}
        />
      </label>
      <label>
        Diagonals
        <select
          data-grid-diagonals
          value={grid.diagonals}
          onchange={(e) => {
            grid = {
              ...grid,
              diagonals: (e.target as HTMLSelectElement).value as SceneGrid["diagonals"],
            };
            apply();
          }}
        >
          {#each ["555", "5105", "euclidean"] as d (d)}
            <option value={d}>{d}</option>
          {/each}
        </select>
      </label>
    </div>
  {/if}

  <h4>Keybindings</h4>
  <table class="keys">
    <tbody>
      {#each Object.entries(DEFAULT_BINDINGS) as [action, combo] (action)}
        <tr>
          <td>{action}</td>
          <td><kbd>{combo}</kbd></td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h4>Edit</h4>
  <div class="row">
    <button data-settings-undo type="button" onclick={onUndo}>Undo</button>
    <button data-settings-redo type="button" onclick={onRedo}>Redo</button>
  </div>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h4 {
    margin: 4px 0 0;
  }
  .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
  }
  input,
  select {
    width: 7em;
  }
  table {
    border-collapse: collapse;
  }
  td {
    padding: 1px 4px;
    font-size: 12px;
    border-bottom: 1px solid #262e3a;
  }
  kbd {
    background: #1d2530;
    border: 1px solid #3a4656;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 11px;
  }
</style>
