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
  import {
    advanceClockOnRoundOf,
    secondsPerRoundOf,
    validateWorldSettingsPatch,
    worldSettingsFrom,
    worldSettingsOps,
  } from "../../core/worldSettings";
  import {
    TICKS_PER_DAY,
    advanceWorldClockOps,
    formatWorldClock,
    pf1eClockSweepOps,
    readWorldClock,
    setWorldClockOps,
  } from "../../packages/pf1e/worldClock";
  import { autoResolveAoosOf } from "../../packages/pf1e/aooSettings";

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

  /** World rules options (the replicated `settings` document, D-113). */
  let rulesError = $state("");
  interface RulesOptions {
    secondsPerRound: number;
    detectionMultiplier: number;
    advanceClockOnRound: boolean;
    /** P06/D-186: the app resolves movement attacks of opportunity itself. On by default. */
    autoResolveAoos: boolean;
  }
  /** E05 (D-146): the replicated world clock, seconds. */
  let clockSeconds = $state(0);
  const DEFAULT_RULES: RulesOptions = {
    secondsPerRound: 6,
    detectionMultiplier: 1,
    advanceClockOnRound: true,
    autoResolveAoos: true,
  };
  // Initialize only after the defaults exist (opening the window executes this script).
  let rules = $state<RulesOptions>(DEFAULT_RULES);
  let scale = $state<"tactical" | "strategic">("tactical");

  function refresh(): void {
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const active = scenes.find((s) => s.active) ?? scenes[0] ?? null;
    sceneId = active?._id ?? "";
    grid = active ? { ...active.grid } : null;
    scale =
      (active?.flags as { core?: { scale?: unknown } } | undefined)?.core
        ?.scale === "strategic"
        ? "strategic"
        : "tactical";
    const settingsDocs = client.store.getAll("settings");
    const settings = worldSettingsFrom(settingsDocs);
    clockSeconds = readWorldClock(settingsDocs);
    rules = {
      secondsPerRound: secondsPerRoundOf(settings),
      detectionMultiplier:
        typeof settings.detectionMultiplier === "number" &&
        settings.detectionMultiplier > 0
          ? settings.detectionMultiplier
          : DEFAULT_RULES.detectionMultiplier,
      advanceClockOnRound: advanceClockOnRoundOf(settings),
      autoResolveAoos: autoResolveAoosOf(settings),
    };
  }

  /**
   * E05 (D-146): GM out-of-combat time controls. Advancing the replicated clock also sweeps
   * clock-counted effect durations (round/minute/hour/day anchored at apply) from both effect
   * homes, so out-of-combat time passing ends buffs exactly as combat rounds would; the deltas
   * follow this world's duration ladder (a "1 minute" button advances what a 1-minute duration
   * means here). Reset rewinds to 0 and sweeps nothing (a backward jump expires nothing).
   */
  function changeClock(unit: "minute" | "hour" | "day" | "reset"): void {
    const settingsDocs = client.store.getAll("settings");
    const settings = worldSettingsFrom(settingsDocs);
    const spr = secondsPerRoundOf(settings);
    if (unit === "reset") {
      const reset = setWorldClockOps(settingsDocs, 0);
      if (reset.length > 0) client.submit(reset);
      return;
    }
    const ticks =
      unit === "minute" ? 10 : unit === "hour" ? 100 : TICKS_PER_DAY;
    const delta = ticks * spr;
    const ops = advanceWorldClockOps(settingsDocs, delta);
    if (ops.length === 0) return;
    const sweep = pf1eClockSweepOps(
      client.store.getAll("actors") as never,
      client.store.getAll("combats") as never,
      readWorldClock(settingsDocs) + delta,
      spr,
    );
    client.submit([...ops, ...sweep.ops]);
  }

  /** Submit a rules-option patch, creating the world's settings document on first edit. */
  function applyRules(patch: Partial<RulesOptions>): void {
    const checked = validateWorldSettingsPatch({ ...patch });
    rulesError = checked.error ?? "";
    if (!checked.ok) return;
    const ops = worldSettingsOps(
      client.store.getAll("settings"),
      checked.clean,
    );
    if (ops.length === 0) return;
    client.submit(ops);
  }

  /** §9A: scale flag gates strategic fog + linked-scene behaviour (D-080). */
  function applyScale(next: "tactical" | "strategic"): void {
    if (!sceneId) return;
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const scene = scenes.find((sc) => sc._id === sceneId);
    if (!scene) return;
    const flags = {
      ...scene.flags,
      core: {
        ...((scene.flags as { core?: object } | undefined)?.core ?? {}),
        scale: next,
      },
    };
    client.submit([
      { kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { flags } },
    ]);
  }

  function apply(): void {
    if (!grid || !sceneId) return;
    client.submit([
      { kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { grid } },
    ]);
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
            scale = (e.target as HTMLSelectElement).value as
              "tactical" | "strategic";
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
            grid = {
              ...grid,
              type: (e.target as HTMLSelectElement).value as SceneGrid["type"],
            };
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
              hexLayout: (e.target as HTMLSelectElement)
                .value as SceneGrid["hexLayout"],
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
            grid = {
              ...grid,
              size: Number((e.target as HTMLInputElement).value),
            };
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
            grid = {
              ...grid,
              distance: Number((e.target as HTMLInputElement).value),
            };
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
              diagonals: (e.target as HTMLSelectElement)
                .value as SceneGrid["diagonals"],
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

  <h4>Rules options</h4>
  <div class="row">
    <label>
      <input
        data-world-auto-aoo
        type="checkbox"
        checked={rules.autoResolveAoos}
        onchange={(e) => {
          rules = {
            ...rules,
            autoResolveAoos: (e.target as HTMLInputElement).checked,
          };
          applyRules({ autoResolveAoos: rules.autoResolveAoos });
        }}
      />
      Auto-resolve attacks of opportunity
    </label>
  </div>
  <div class="row">
    <label>
      Seconds / round
      <input
        data-world-seconds
        type="number"
        min="1"
        max="3600"
        value={rules.secondsPerRound}
        onchange={(e) => {
          rules = {
            ...rules,
            secondsPerRound: Number((e.target as HTMLInputElement).value),
          };
          applyRules({ secondsPerRound: rules.secondsPerRound });
        }}
      />
    </label>
    <label>
      Detection ×
      <input
        data-world-detection
        type="number"
        min="0"
        step="0.25"
        value={rules.detectionMultiplier}
        onchange={(e) => {
          rules = {
            ...rules,
            detectionMultiplier: Number((e.target as HTMLInputElement).value),
          };
          applyRules({ detectionMultiplier: rules.detectionMultiplier });
        }}
      />
    </label>
    <label>
      Advance clock
      <input
        data-world-clock
        type="checkbox"
        checked={rules.advanceClockOnRound}
        onchange={(e) => {
          rules = {
            ...rules,
            advanceClockOnRound: (e.target as HTMLInputElement).checked,
          };
          applyRules({ advanceClockOnRound: rules.advanceClockOnRound });
        }}
      />
    </label>
  </div>
  <p class="hint">
    Stored as a replicated <code>settings</code> document, so players see the clock
    their durations tick against.
  </p>
  {#if rulesError}<p class="error" data-world-error>{rulesError}</p>{/if}

  <h4>World clock</h4>
  <div class="row" data-world-clock-row>
    <span class="clock" data-clock-readout
      >{formatWorldClock(clockSeconds)}</span
    >
    <button
      data-clock-minute
      type="button"
      onclick={() => changeClock("minute")}>+1 min</button
    >
    <button data-clock-hour type="button" onclick={() => changeClock("hour")}
      >+1 h</button
    >
    <button data-clock-day type="button" onclick={() => changeClock("day")}
      >+1 day</button
    >
    <button data-clock-reset type="button" onclick={() => changeClock("reset")}
      >Reset</button
    >
  </div>
  <p class="hint">
    Out-of-combat time. Advancing it ends clock-counted effect durations
    (round/minute/hour/day) in the same measure the combat tracker uses; effects
    applied before the clock existed are never swept.
  </p>

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
  .hint {
    margin: 0;
    font-size: 10px;
    color: #7d8ea6;
  }
  .error {
    margin: 0;
    font-size: 11px;
    color: #e0736b;
  }
  kbd {
    background: #1d2530;
    border: 1px solid #3a4656;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 11px;
  }
</style>
