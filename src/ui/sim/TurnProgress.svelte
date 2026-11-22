<script lang="ts">
  import type { TurnProgressStage } from "../../core/turnProgress";
  let {
    stage,
    board = false,
    delayMs = 250,
  }: {
    stage: TurnProgressStage | null;
    board?: boolean;
    /** Debounce before showing the bar so instant (<0.25s) rounds never flash UI chrome. */
    delayMs?: number;
  } = $props();

  const labels: Record<TurnProgressStage, string> = {
    closing: "Closing orders…",
    retrying: "Restarting resolution…",
    resolving: "Resolving turn…",
    applying: "Applying results…",
  };

  let visible = $state(false);
  let elapsedSec = $state(0);

  $effect(() => {
    const active = stage;
    if (!active) {
      visible = false;
      elapsedSec = 0;
      return;
    }
    const startedAt = performance.now();
    const wait = Math.max(0, delayMs);
    let tickId: ReturnType<typeof setInterval> | null = null;
    const startClock = () => {
      visible = true;
      elapsedSec = Math.max(0, (performance.now() - startedAt) / 1000);
      tickId = setInterval(() => {
        elapsedSec = Math.max(0, (performance.now() - startedAt) / 1000);
      }, 100);
    };
    if (wait === 0) {
      startClock();
      return () => {
        if (tickId !== null) clearInterval(tickId);
      };
    }
    const timerId = setTimeout(startClock, wait);
    return () => {
      clearTimeout(timerId);
      if (tickId !== null) clearInterval(tickId);
    };
  });
</script>

<span
  class="turn-progress"
  class:board
  role="status"
  aria-live="polite"
  aria-atomic="true"
  data-turn-progress={stage ?? "idle"}
  data-turn-progress-visible={visible ? "true" : "false"}
>
  {#if stage && visible}
    <span class="pill">
      <span class="row">
        <span class="spinner" aria-hidden="true"></span>
        <span>{labels[stage]}</span>
        {#if elapsedSec >= 0.3}
          <span class="elapsed" aria-hidden="true">{elapsedSec.toFixed(1)}s</span>
        {/if}
      </span>
      <span class="bar-track" aria-hidden="true">
        <span class="bar-fill"></span>
      </span>
    </span>
  {/if}
</span>

<style>
  .turn-progress {
    display: inline-flex;
    pointer-events: none;
    min-height: 1px;
    white-space: nowrap;
  }
  .turn-progress.board {
    position: absolute;
    z-index: 8;
    top: 0.65rem;
    left: 50%;
    transform: translateX(-50%);
  }
  .pill {
    display: inline-flex;
    flex-direction: column;
    gap: 0.22rem;
    padding: 0.28rem 0.68rem 0.32rem;
    border-radius: 0.6rem;
    color: #f4eedb;
    background: rgba(24, 32, 32, 0.92);
    border: 1px solid #74705b;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    font:
      600 0.76rem/1.25 system-ui,
      sans-serif;
  }
  .row {
    display: inline-flex;
    align-items: center;
    gap: 0.42rem;
  }
  .elapsed {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    font-size: 0.7rem;
    color: #c7bfa6;
  }
  .spinner {
    width: 0.72rem;
    height: 0.72rem;
    border-radius: 50%;
    border: 2px solid #b4aa894d;
    border-top-color: #f0d591;
    animation: spin 0.85s linear infinite;
  }
  .bar-track {
    position: relative;
    width: 100%;
    min-width: 7.5rem;
    height: 3px;
    border-radius: 999px;
    background: rgba(180, 170, 137, 0.22);
    overflow: hidden;
  }
  .bar-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 42%;
    border-radius: 999px;
    background: linear-gradient(90deg, #b89a52, #f5dfa0, #b89a52);
    animation: sweep 1.15s ease-in-out infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes sweep {
    0% {
      left: -42%;
    }
    100% {
      left: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      border-color: #f0d591;
    }
    .bar-fill {
      animation: none;
      left: 0;
      width: 100%;
    }
  }
</style>
