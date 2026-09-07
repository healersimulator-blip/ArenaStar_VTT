<script lang="ts">
  /**
   * §8A After-action replay browser component.
   * Loads turn checkpoints from IDB, provides timeline controls, and feeds historical
   * ModelPool frames back to the canvas or host preview.
   */
  import { onDestroy, onMount } from "svelte";
  import type { IDBPDatabase } from "idb";
  import { listCheckpoints, listReports } from "../../storage/strategicStore";
  import { ReplayEngine, type ReplayFrame, type ReplayState } from "../../sim/replay";
  import type { SysSchema } from "../../sim/pool";

  let {
    db,
    worldId,
    sceneId,
    sys = {},
    onFrameChange = null,
    onClose,
  }: {
    db: IDBPDatabase;
    worldId: string;
    sceneId: string;
    sys?: SysSchema;
    onFrameChange?: ((frame: ReplayFrame) => void) | null;
    onClose: () => void;
  } = $props();

  let engine = new ReplayEngine(sys);
  let state = $state<ReplayState>(engine.getState());
  let loading = $state(true);
  let animFrameId: number | null = null;
  let lastTime: number | null = null;

  function handleStateChange(newState: ReplayState): void {
    state = newState;
    if (newState.frame && onFrameChange) {
      onFrameChange(newState.frame);
    }
  }

  function loop(time: number): void {
    if (lastTime !== null) {
      const dt = time - lastTime;
      engine.tick(dt);
    }
    lastTime = time;
    if (state.playing) {
      animFrameId = requestAnimationFrame(loop);
    }
  }

  $effect(() => {
    if (state.playing) {
      lastTime = performance.now();
      animFrameId = requestAnimationFrame(loop);
    } else if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
      lastTime = null;
    }
  });

  onDestroy(() => {
    if (animFrameId !== null) cancelAnimationFrame(animFrameId);
  });

  async function loadData(): Promise<void> {
    loading = true;
    try {
      const checkpoints = await listCheckpoints(db, worldId, sceneId);
      const reports = await listReports(db, worldId, sceneId);
      engine = new ReplayEngine(sys, handleStateChange);
      engine.load(checkpoints, reports);
      state = engine.getState();
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadData();
  });

  function onScrub(e: Event): void {
    const idx = Number((e.target as HTMLInputElement).value);
    engine.seek(idx);
  }
</script>

<div class="replay-panel" data-replay-panel>
  <header>
    <h3>After-Action Replay (§8A)</h3>
    <button type="button" class="close-btn" onclick={onClose}>✕</button>
  </header>

  {#if loading}
    <div class="loading">Loading checkpoints…</div>
  {:else if state.total === 0}
    <div class="empty">No turn checkpoints found for this scene.</div>
  {:else}
    <div class="replay-body">
      <div class="header-info">
        <span>Turn: <strong>{state.frame?.turnNumber ?? "—"}</strong></span>
        <span class="hash dim">Hash: {state.frame?.hash ? state.frame.hash.slice(0, 8) : "—"}</span>
        <span>Models: {state.frame?.pool.count ?? 0}</span>
      </div>

      <div class="scrubber-row">
        <input
          type="range"
          min="0"
          max={Math.max(0, state.total - 1)}
          value={state.index}
          oninput={onScrub}
          data-replay-scrubber
          aria-label="Replay scrubber"
        />
      </div>

      <div class="controls-row">
        <button
          type="button"
          disabled={state.index <= 0}
          onclick={() => engine.stepBack()}
          data-replay-prev
        >
          ⏮
        </button>

        <button
          type="button"
          onclick={() => engine.togglePlay()}
          data-replay-play
        >
          {state.playing ? "⏸ Pause" : "▶ Play"}
        </button>

        <button
          type="button"
          disabled={state.index >= state.total - 1}
          onclick={() => engine.stepForward()}
          data-replay-next
        >
          ⏭
        </button>

        <select
          value={String(state.speed)}
          onchange={(e) => engine.setSpeed(Number(e.currentTarget.value))}
          data-replay-speed
          aria-label="Replay speed"
        >
          {#each ["0.5", "1", "2", "4"] as sp (sp)}
            <option value={sp}>{sp}x</option>
          {/each}
        </select>
      </div>

      {#if state.frame?.report}
        <div class="report-preview" data-replay-report>
          <h4>Turn {state.frame.report.turn} Report Events ({state.frame.report.events.length})</h4>
          <ul>
            {#each state.frame.report.events.slice(0, 5) as ev, i (i)}
              <li>[{ev.subPhase}] {ev.text}</li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .replay-panel {
    position: absolute;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    width: 440px;
    background: #181d24;
    border: 1px solid #28303a;
    border-radius: 8px;
    padding: 12px;
    color: #e2e8f0;
    font-size: 12px;
    z-index: 50;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  h3, h4 {
    margin: 0;
  }
  .close-btn {
    background: none;
    border: none;
    color: #a0aec0;
    cursor: pointer;
  }
  .header-info {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .dim {
    opacity: 0.7;
  }
  .scrubber-row input[type="range"] {
    width: 100%;
    cursor: pointer;
  }
  .controls-row {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 6px;
  }
  .controls-row button, .controls-row select {
    padding: 3px 8px;
    font-size: 12px;
    background: #232a34;
    border: 1px solid #323b46;
    color: #ffffff;
    border-radius: 4px;
  }
  .report-preview {
    margin-top: 8px;
    background: #232a34;
    padding: 6px 8px;
    border-radius: 4px;
  }
  .report-preview ul {
    margin: 4px 0 0;
    padding-left: 16px;
    font-size: 11px;
  }
</style>
