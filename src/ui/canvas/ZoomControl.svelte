<script lang="ts">
  import type { Stage } from "../../canvas/stage";
  import { zoomAt } from "../../canvas/camera";

  let { stage, onInput }: { stage: Stage | null; onInput: () => void } = $props();
  let scale = $state(1);
  let menu: HTMLDetailsElement | undefined = $state();
  // Subscribe to the same camera used by wheel, toolbar, fit and FX playback.
  $effect(() => {
    const view = stage;
    if (!view) return;
    const sync = () => { scale = view.camera.scale; };
    sync();
    view.app.ticker.add(sync);
    return () => { view.app.ticker.remove(sync); };
  });

  function change(event: Event) {
    const view = stage;
    if (!view) return;
    const value = Number((event.currentTarget as HTMLInputElement).value);
    const bounds = view.app.canvas.getBoundingClientRect();
    onInput();
    view.setCamera(zoomAt(view.camera, bounds.width / 2, bounds.height / 2,
      Math.pow(10, value) / view.camera.scale));
    scale = view.camera.scale;
  }
</script>

<svelte:window onkeydown={(event) => {
  if (event.key === "Escape" && menu?.open && menu.contains(event.target as Node)) {
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
}} />

<details class="zoom-control" bind:this={menu}>
  <summary aria-label="Scene zoom" title="Scene zoom">⌕ <span>{Math.round(scale * 100)}%</span></summary>
  <div class="zoom-panel">
    <label>Scene zoom
      <input aria-label="Scene zoom level" type="range" min="-1" max="1" step="0.01"
        value={Math.log10(scale)} aria-valuetext={`${Math.round(scale * 100)} percent`}
        disabled={!stage} oninput={change} />
    </label>
    <div class="limits"><span>10%</span><output>{Math.round(scale * 100)}%</output><span>1000%</span></div>
  </div>
</details>

<style>
  .zoom-control { position: absolute; top: 10px; right: 10px; z-index: 30; color: #eee; font-size: 12px; }
  summary { margin-left: auto; width: max-content; min-height: 44px; min-width: 44px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 6px 10px; cursor: pointer; background: #202631; border: 1px solid #596579; border-radius: 7px; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:focus-visible, input:focus-visible { outline: 2px solid #8bbdff; outline-offset: 3px; }
  .zoom-panel { width: min(220px, 60vw); margin-top: 6px; padding: 12px; background: #202631; border: 1px solid #596579; border-radius: 7px; box-shadow: 0 4px 16px #0006; }
  label { display: grid; gap: 4px; }
  input { width: 100%; min-height: 44px; margin: 0; touch-action: pan-y; }
  .limits { display: flex; justify-content: space-between; color: #cbd4e1; }
</style>
