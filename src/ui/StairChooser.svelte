<script lang="ts">
  /** G-01 (D-430): non-modal stairwell choice. Number keys pick a floor, Escape stays. */
  import { onMount } from "svelte";
  import type { StairOfferMsg } from "../core/messages";
  let { offer, tokenName = "", onChoose }: { offer: StairOfferMsg; tokenName?: string; onChoose: (levelId: string | null) => void } = $props();
  const arrow = (direction: string) => direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key === "Escape") { event.preventDefault(); onChoose(null); return; }
      const index = Number(event.key) - 1;
      const choice = Number.isInteger(index) && index >= 0 ? offer.choices[index] : undefined;
      if (choice) { event.preventDefault(); onChoose(choice.levelId); }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  });
</script>
<div class="stair-chooser" role="dialog" aria-label="Choose a floor" data-stair-chooser={offer.tokenId}>
  <p><strong>{offer.label ?? "Stairs"}</strong>{tokenName ? ` · ${tokenName}` : ""}: which floor?</p>
  <div class="choices">
    {#each offer.choices as choice, i (choice.levelId)}
      <button type="button" data-stair-choice={choice.levelId} aria-keyshortcuts={String(i + 1)} title={`Press ${i + 1}`} onclick={() => onChoose(choice.levelId)}>
        <span aria-hidden="true">{arrow(choice.direction)}</span> {choice.name}
      </button>
    {/each}
    <button type="button" data-stair-stay aria-keyshortcuts="Escape" title="Press Esc" onclick={() => onChoose(null)}>Stay here</button>
  </div>
</div>
<style>
  .stair-chooser { position:fixed; z-index:4600; left:50%; bottom:88px; transform:translateX(-50%); min-width:220px; max-width:min(92vw, 420px);
    padding:8px 10px; border:1px solid #8c7542; border-radius:8px; background:rgba(28, 24, 16, .96); color:#f5e7c8; box-shadow:0 6px 24px rgba(0,0,0,.45); }
  p { margin:0 0 6px; font-size:.8rem; } .choices { display:flex; flex-wrap:wrap; gap:6px; }
  button { padding:6px 10px; border:1px solid #a88c52; border-radius:6px; background:#3a301c; color:#fff3d6; cursor:pointer; font-size:.8rem; }
  button:hover, button:focus-visible { background:#584623; outline:none; } [data-stair-stay] { border-color:#5b6476; background:#262c37; color:#d8dee8; }
</style>
