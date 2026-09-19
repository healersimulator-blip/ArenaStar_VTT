<script lang="ts">
  import type { RollLedger } from "../../packages/pf1e/rollLedger";
  import { canReroll, canRevert } from "../../packages/pf1e/rollLedger";

  interface StagedModifier {
    label: string;
    value: number;
    reason: string;
  }

  let {
    ledger,
    currentTurn,
    isGM = false,
    fadeSec = 4,
    onReroll,
    onRevert,
    onDelegate,
    onPlayerReroll,
    onHighlight,
  }: {
    ledger: RollLedger;
    currentTurn: number;
    isGM?: boolean;
    fadeSec?: number;
    onReroll?: (newModifiers?: StagedModifier[]) => void;
    onRevert?: () => void;
    onDelegate?: (playerId: string) => void;
    onPlayerReroll?: () => void;
    onHighlight?: (kind: "initiator" | "target" | "area", id: string | null) => void;
  } = $props();

  const rerollable = $derived(canReroll(ledger, currentTurn));
  const revertable = $derived(canRevert(ledger, currentTurn) && !ledger.reverted);
  const fade = $derived(Math.max(1, Math.min(10, Math.trunc(fadeSec) || 4)));

  let delegatePlayerId = $state("");
  // Situational modifiers staged for the NEXT reroll (folded into the first
  // roll by the host, with an honest total = dice + Σ values).
  let staged = $state<StagedModifier[]>([]);

  function stageFromSelect(e: Event): void {
    const select = e.target as HTMLSelectElement;
    const v = select.value;
    if (!v) return;
    const [label, val] = v.split("|");
    const value = Number(val);
    select.value = "";
    if (!label || !Number.isFinite(value)) return;
    staged = [...staged, { label, value, reason: label }];
  }

  function unstage(idx: number): void {
    staged = staged.filter((_, i) => i !== idx);
  }

  function reroll(): void {
    onReroll?.(staged.length > 0 ? staged : undefined);
    staged = [];
  }

  function highlight(kind: "initiator" | "target" | "area", id: string | null): void {
    onHighlight?.(kind, id);
  }
</script>

<article
  class="rollcard"
  data-testid="roll-card"
  data-ledger-turn={ledger.turnNumber}
  data-ledger-reverted={String(ledger.reverted)}
  data-fade-sec={fade}
>
  <header class="head">
    <button
      data-testid="roll-initiator"
      class="link initiator"
      onclick={() => highlight("initiator", ledger.initiator.actorId)}
      title="Center and outline initiator {ledger.initiator.name}"
    >
      {ledger.initiator.name}
    </button>
    <span class="meta">turn {ledger.turnNumber} · fade {fade}s</span>
    {#if ledger.reverted}
      <span class="tag reverted" data-testid="roll-reverted">reverted</span>
    {/if}
  </header>

  {#if ledger.targets && ledger.targets.length > 0}
    <div class="targets">
      {#each ledger.targets as target (target.actorId)}
        <button
          data-testid="roll-target"
          data-target-id={target.actorId}
          class="link target"
          onclick={() => highlight("target", target.actorId)}
          title="Center and outline {target.name}"
        >
          {target.name}
        </button>
      {/each}
    </div>
  {/if}

  {#if ledger.area}
    <div class="area">
      <button
        data-testid="roll-area"
        class="link area"
        onclick={() => highlight("area", null)}
        title="Outline area {ledger.area.shape} r{ledger.area.radiusFt}ft"
      >
        {ledger.area.shape} · {ledger.area.radiusFt}ft
        {#if ledger.area.affectedTokenIds.length > 0}
          · {ledger.area.affectedTokenIds.length} in area
        {/if}
      </button>
    </div>
  {/if}

  <div class="rolls">
    {#each ledger.rolls as roll, idx (idx)}
      <div class="roll" data-testid="roll-entry" data-roll-kind={roll.kind}>
        <div class="roll-head">
          <span class="kind">{roll.kind}</span>
          <span class="formula" title={roll.formula}>{roll.formula}</span>
          <span class="total" data-testid="roll-total">{roll.total}</span>
          {#if roll.seedHost || roll.seedClient}
            <span class="seeds" title="host:{roll.seedHost} client:{roll.seedClient}">🎲</span>
          {/if}
        </div>
        {#if roll.modifiers.length > 0}
          <details class="modifiers" data-testid="roll-modifiers">
            <summary>{roll.modifiers.length} modifier{roll.modifiers.length === 1 ? "" : "s"}</summary>
            <ul>
              {#each roll.modifiers as mod, mIdx (mIdx)}
                <li class="modifier">
                  <span class="mod-label">{mod.label}</span>
                  <span class="mod-value">{mod.value > 0 ? "+" : ""}{mod.value}</span>
                  <!-- read-only reason dropdown — the recorded breakdown, not an editor -->
                  <select
                    data-testid="roll-modifier-dropdown"
                    data-mod-idx={mIdx}
                    value={mod.reason}
                    disabled
                    aria-label="modifier reason"
                  >
                    <option value={mod.reason}>{mod.reason}</option>
                  </select>
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>
    {/each}
  </div>

  {#if isGM && rerollable}
    <div class="staging">
      <label class="add-mod">
        <span>Stage for reroll</span>
        <select data-testid="roll-add-modifier" onchange={stageFromSelect}>
          <option value="">— pick —</option>
          <option value="flanking|+2">flanking +2</option>
          <option value="higher ground|+1">higher ground +1</option>
          <option value="cover|-4">cover −4</option>
          <option value="inspire courage|+1">inspire +1</option>
          <option value="power attack|-2">power attack −2</option>
        </select>
      </label>
      {#each staged as mod, sIdx (sIdx)}
        <button
          class="chip staged"
          data-testid="roll-staged-modifier"
          title="Remove staged modifier"
          onclick={() => unstage(sIdx)}
        >
          {mod.label} {mod.value > 0 ? "+" : ""}{mod.value} ✕
        </button>
      {/each}
    </div>
  {/if}

  <footer class="actions">
    {#if isGM}
      <button
        data-testid="roll-reroll"
        class="primary"
        disabled={!rerollable}
        title={rerollable ? "Reroll (inverse + new envelope)" : "Outside 2-round window or reverted"}
        onclick={reroll}
      >
        Reroll
      </button>
      <button
        data-testid="roll-revert"
        disabled={!revertable}
        title={revertable ? "Revert (inverse of ledgerOps)" : "Outside window or already reverted"}
        onclick={() => onRevert?.()}
      >
        Revert
      </button>
      <label class="delegate">
        <span>Delegate to</span>
        <input
          data-testid="roll-delegate-input"
          type="text"
          placeholder="player id"
          bind:value={delegatePlayerId}
        />
        <button
          data-testid="roll-delegate"
          disabled={!rerollable || !delegatePlayerId.trim()}
          onclick={() => {
            const id = delegatePlayerId.trim();
            if (id) onDelegate?.(id);
          }}
        >
          Give reroll
        </button>
      </label>
    {:else if ledger.pendingReroll}
      <button
        data-testid="roll-player-reroll"
        class="primary"
        onclick={() => onPlayerReroll?.()}
      >
        Reroll for {ledger.initiator.name}
      </button>
      <span class="hint">GM delegated this roll to you (expires turn {ledger.pendingReroll.expiresTurn})</span>
    {/if}
    {#if ledger.rerollCount > 0}
      <span class="meta" data-testid="roll-reroll-count">rerolled {ledger.rerollCount}×</span>
    {/if}
  </footer>
</article>

<style>
  .rollcard {
    border: 1px solid #2e8b57;
    border-radius: 8px;
    background: #12201a;
    color: #e8e8ee;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.9rem;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .link {
    background: none;
    border: none;
    color: #7fb0d8;
    cursor: pointer;
    font-weight: 600;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link:hover { color: #a8d0f0; }
  .meta { color: #8b93a3; font-size: 0.8125rem; margin-left: auto; }
  .tag { font-size: 0.8125rem; padding: 1px 6px; border-radius: 999px; background: #3a2a2a; color: #e0a0a0; }
  .targets, .area { display: flex; flex-wrap: wrap; gap: 6px; }
  .rolls { display: flex; flex-direction: column; gap: 6px; }
  .roll { border: 1px solid #2a3a2e; border-radius: 6px; padding: 6px; background: #0e1510; }
  .roll-head { display: flex; align-items: baseline; gap: 6px; }
  .kind { font-size: 0.8125rem; text-transform: uppercase; letter-spacing: 0.06em; color: #8b93a3; }
  .formula { color: #8b93a3; font-family: monospace; font-size: 0.8125rem; }
  .total { font-weight: 800; color: #7fe0a7; margin-left: auto; }
  .modifiers { margin-top: 6px; }
  .modifiers summary { cursor: pointer; color: #9eafc5; }
  .modifier { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
  .mod-label { font-weight: 600; }
  .mod-value { font-family: monospace; }
  .add-mod { display: flex; align-items: center; gap: 6px; }
  .staging { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .add-mod select, .modifier select { padding: 2px 6px; border-radius: 4px; border: 1px solid #3a3f4a; background: #1d2127; color: #e8e8ee; }
  .modifier select:disabled { opacity: 0.85; color: #8b93a3; }
  .chip.staged { padding: 2px 8px; border-radius: 999px; border: 1px solid #2e8b57; background: #1e3a2a; color: #7fe0a7; cursor: pointer; font-size: 0.8125rem; }
  .actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .actions button { padding: 4px 10px; border-radius: 6px; border: 1px solid #3a3f4a; background: #1d2127; color: #e8e8ee; cursor: pointer; }
  .actions button.primary { background: #1e3a2a; border-color: #2e8b57; color: #7fe0a7; }
  .actions button:disabled { opacity: 0.45; cursor: not-allowed; }
  .delegate { display: flex; align-items: center; gap: 4px; margin-left: auto; }
  .delegate input { padding: 3px 6px; border-radius: 4px; border: 1px solid #3a3f4a; background: #101216; color: #e8e8ee; width: 120px; }
  .hint { color: #8b93a3; font-size: 0.8125rem; }
</style>
