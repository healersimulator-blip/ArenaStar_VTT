<script lang="ts">
  /**
   * §9A TurnReport timeline animation + scrubber component.
   * Displays step-by-step resolution events with sub-phase indicators, scrubber control,
   * play/pause/speed playback, active event canvas pings, and GM skip button.
   */
  import { onDestroy } from "svelte";
  import type { SimEvent, TurnReport } from "../../core/sim";
  import { TurnReportPlayback, type PlaybackState } from "./turnReportPlayback";

  let {
    report,
    onEventFocus = null,
    isGm = false,
    onComplete = null,
  }: {
    report: TurnReport;
    onEventFocus?: ((event: SimEvent) => void) | null;
    isGm?: boolean;
    onComplete?: (() => void) | null;
  } = $props();

  let playback = new TurnReportPlayback(report);
  let state = $state<PlaybackState>(playback.getState());
  let animFrameId: number | null = null;
  let lastTime: number | null = null;

  function handleStateChange(newState: PlaybackState): void {
    state = newState;
    if (newState.activeEvent && onEventFocus) {
      onEventFocus(newState.activeEvent);
    }
    if (newState.completed && onComplete) {
      onComplete();
    }
  }

  function loop(time: number): void {
    if (lastTime !== null) {
      const dt = time - lastTime;
      playback.tick(dt);
    }
    lastTime = time;
    if (state.playing) {
      animFrameId = requestAnimationFrame(loop);
    }
  }

  $effect(() => {
    playback = new TurnReportPlayback(report, handleStateChange);
    state = playback.getState();
  });

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
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
    }
  });

  function onScrub(e: Event): void {
    const val = Number((e.target as HTMLInputElement).value);
    playback.seek(val);
  }
</script>

<div class="turn-timeline" data-report-timeline>
  <div class="timeline-header">
    <span class="title">Turn {report.turn} Timeline</span>
    <span class="phase-badge" data-current-subphase>{state.currentSubPhase ?? "—"}</span>
    <span class="counter" data-event-counter>
      {report.events.length > 0 ? state.eventIndex + 1 : 0} / {report.events.length}
    </span>
  </div>

  <div class="scrubber-row">
    <input
      type="range"
      min="0"
      max={Math.max(0, report.events.length - 1)}
      value={state.eventIndex}
      disabled={report.events.length === 0}
      oninput={onScrub}
      data-scrubber
      aria-label="Turn report timeline scrubber"
    />
  </div>

  <div class="controls-row">
    <button
      type="button"
      title="Step Back"
      disabled={state.eventIndex <= 0}
      onclick={() => playback.stepBack()}
      data-btn-prev
    >
      ⏮
    </button>

    <button
      type="button"
      title={state.playing ? "Pause" : "Play"}
      disabled={report.events.length === 0}
      onclick={() => playback.togglePlay()}
      data-btn-play
    >
      {state.playing ? "⏸ Pause" : "▶ Play"}
    </button>

    <button
      type="button"
      title="Step Forward"
      disabled={state.eventIndex >= report.events.length - 1}
      onclick={() => playback.stepForward()}
      data-btn-next
    >
      ⏭
    </button>

    <select
      value={String(state.speed)}
      aria-label="Playback speed"
      onchange={(e) => playback.setSpeed(Number(e.currentTarget.value))}
      data-speed-select
    >
      {#each ["0.5", "1", "2", "4"] as sp (sp)}
        <option value={sp}>{sp}x</option>
      {/each}
    </select>

    {#if isGm}
      <button
        type="button"
        title="GM Skip to End"
        onclick={() => playback.skip()}
        data-btn-gmskip
      >
        ⏩ GM Skip
      </button>
    {/if}
  </div>

  {#if state.activeEvent}
    <div class="event-card" data-active-event>
      <div class="event-type">
        [{state.activeEvent.subPhase}] <strong data-event-type>{state.activeEvent.type}</strong>
        {#if state.activeEvent.at}
          <span class="event-loc">at ({state.activeEvent.at.x}, {state.activeEvent.at.y})</span>
        {/if}
      </div>
      <div class="event-text" data-event-text>{state.activeEvent.text}</div>
    </div>
  {:else if report.events.length === 0}
    <div class="empty-hint">No events recorded for this turn.</div>
  {/if}
</div>

<style>
  .turn-timeline {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    background: #1a202c;
    border: 1px solid #2d3748;
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 12px;
  }
  .timeline-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 600;
  }
  .phase-badge {
    background: #3182ce;
    color: #ffffff;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    text-transform: uppercase;
  }
  .counter {
    font-size: 11px;
    opacity: 0.8;
  }
  .scrubber-row input[type="range"] {
    width: 100%;
    cursor: pointer;
  }
  .controls-row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .controls-row button {
    padding: 4px 8px;
    font-size: 12px;
  }
  .controls-row select {
    padding: 2px 4px;
    font-size: 12px;
  }
  .event-card {
    background: #2d3748;
    padding: 8px;
    border-radius: 4px;
    border-left: 3px solid #4299e1;
  }
  .event-type {
    font-size: 11px;
    color: #a0aec0;
    margin-bottom: 2px;
  }
  .event-loc {
    margin-left: 6px;
    color: #cbd5e0;
  }
  .event-text {
    font-size: 12px;
    color: #ffffff;
  }
  .empty-hint {
    font-style: italic;
    opacity: 0.7;
  }
</style>
