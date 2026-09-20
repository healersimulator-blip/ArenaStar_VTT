<script lang="ts">
  export type CanvasTool = "select" | "pan" | "draw" | "text" | "measure" | "dice";
  let { active = $bindable<CanvasTool>("select"), collapsed = $bindable(false), isGM = false, onEraseAll = () => {}, onRoll = (_formula: string) => {} } = $props<{
    active?: CanvasTool;
    collapsed?: boolean;
    isGM?: boolean;
    onEraseAll?: () => void;
    onRoll?: (formula: string) => void;
  }>();
  let formula = $state("1d20");
  const tools: Array<{ id: CanvasTool; label: string; icon: string; shortcut: string }> = [
    { id: "select", label: "Select", icon: "↖", shortcut: "V" },
    { id: "pan", label: "Pan / hand", icon: "✋", shortcut: "H" },
    { id: "draw", label: "Draw", icon: "✎", shortcut: "D" },
    { id: "text", label: "Text label", icon: "T", shortcut: "T" },
    { id: "measure", label: "Measure", icon: "⌁", shortcut: "M" },
    { id: "dice", label: "Dice", icon: "d20", shortcut: "R" },
  ];
  function choose(tool: CanvasTool) { active = tool; globalThis.dispatchEvent(new CustomEvent("vtt-canvas-tool", { detail: tool })); }
  function onKey(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    const tool = tools.find((item) => item.shortcut.toLowerCase() === key);
    if (tool) { event.preventDefault(); choose(tool.id); }
    if (event.key === "Escape") choose("select");
  }
</script>

<svelte:window onkeydown={onKey} />
<div class:collapsed class="canvas-toolbar" aria-label="Canvas tools" data-canvas-toolbar>
  <button class="collapse" type="button" aria-label={collapsed ? "Expand toolbar" : "Collapse toolbar"} title={collapsed ? "Expand toolbar" : "Collapse toolbar"} onclick={() => (collapsed = !collapsed)}>{collapsed ? "›" : "‹"}</button>
  {#if !collapsed}
    {#each tools as tool (tool.id)}
      <button type="button" class:active={active === tool.id} aria-pressed={active === tool.id} title={`${tool.label} (${tool.shortcut})`} aria-label={tool.label} data-canvas-tool={tool.id} onclick={() => choose(tool.id)}>
        <span class="icon">{tool.icon}</span><span class="label">{tool.label}</span>
      </button>
    {/each}
    {#if active === "dice"}
      <form class="dice-form" onsubmit={(event) => { event.preventDefault(); if (formula.trim()) onRoll(formula.trim()); }}>
        <input aria-label="Dice formula" bind:value={formula} placeholder="1d20+5" />
        <button type="submit">Roll</button>
      </form>
    {/if}
    {#if isGM}
      <button type="button" class="danger" aria-label="Erase all drawings" title="Erase all drawings" onclick={onEraseAll}>⌫ <span class="label">Erase drawings</span></button>
    {/if}
  {/if}
</div>

<style>
  .canvas-toolbar { position:absolute; z-index:20; left:8px; top:48px; display:flex; flex-direction:column; gap:4px; padding:5px; border:1px solid #343c50; border-radius:7px; background:#151a24eF; box-shadow:0 5px 18px #0008; }
  .canvas-toolbar button { display:flex; align-items:center; gap:7px; min-width:112px; padding:7px 8px; border:1px solid transparent; border-radius:4px; color:#d9dfeb; background:transparent; cursor:pointer; text-align:left; }
  .canvas-toolbar button:hover, .canvas-toolbar button.active { border-color:#6c8fd6; background:#2a3858; color:#fff; }
  .canvas-toolbar .collapse { min-width:28px; justify-content:center; padding:4px; font-size:18px; }
  .icon { width:25px; text-align:center; font-weight:700; }
  .label { font-size:12px; }
  .collapsed { padding:4px; }
  .dice-form { display:flex; gap:3px; }
  .dice-form input { width:72px; min-width:0; padding:5px; color:#fff; background:#0c111b; border:1px solid #3a455e; border-radius:3px; }
  .dice-form button { min-width:0; padding:5px; }
  .danger { color:#ffb4b4 !important; }
</style>
