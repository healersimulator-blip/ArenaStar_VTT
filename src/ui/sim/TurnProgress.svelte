<script lang="ts">
  import type { TurnProgressStage } from "../../core/turnProgress";
  let {
    stage,
    board = false,
  }: { stage: TurnProgressStage | null; board?: boolean } = $props();
  const labels: Record<TurnProgressStage, string> = {
    closing: "Closing orders…",
    retrying: "Restarting resolution…",
    resolving: "Resolving turn…",
    applying: "Applying results…",
  };
</script>

<span
  class="turn-progress"
  class:board
  role="status"
  aria-live="polite"
  aria-atomic="true"
  data-turn-progress={stage ?? "idle"}
>
  {#if stage}<span class="pill"
      ><span class="spinner" aria-hidden="true"></span>{labels[stage]}</span
    >{/if}
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
    align-items: center;
    gap: 0.45rem;
    padding: 0.3rem 0.65rem;
    border-radius: 999px;
    color: #f4eedb;
    background: #1d2626;
    border: 1px solid #74705b;
    font:
      600 0.78rem/1.3 system-ui,
      sans-serif;
  }
  .spinner {
    width: 0.78rem;
    height: 0.78rem;
    border-radius: 50%;
    border: 2px solid #b4aa894d;
    border-top-color: #f0d591;
    animation: spin 0.85s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      border-color: #f0d591;
    }
  }
</style>
