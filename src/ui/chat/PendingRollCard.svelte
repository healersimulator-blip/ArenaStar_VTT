<script lang="ts">
  import type { PendingRoll } from "../../packages/pf1e/pendingRoll";
  import { isPendingExpired } from "../../packages/pf1e/pendingRoll";

  let {
    pending,
    currentTurn,
    isGM = false,
    isOwner = false,
    fadeSec = 4,
    onRoll,
    onGMResolve,
    onHighlight,
  }: {
    pending: PendingRoll;
    currentTurn: number;
    isGM?: boolean;
    isOwner?: boolean;
    fadeSec?: number;
    onRoll?: () => void;
    onGMResolve?: () => void;
    onHighlight?: (kind: "initiator" | "target" | "area", id: string | null) => void;
  } = $props();

  const expired = $derived(isPendingExpired(pending, currentTurn));
  const canRoll = $derived(!pending.resolved && !expired && (isOwner || isGM));
  const fade = $derived(Math.max(1, Math.min(10, Math.trunc(fadeSec) || 4)));

  function highlight(kind: "initiator" | "target" | "area", id: string | null): void {
    onHighlight?.(kind, id);
  }
</script>

<article
  class="pendingcard"
  data-testid="pending-roll-card"
  data-pending-roll
  data-pending-kind={pending.kind}
  data-pending-formula={pending.formula}
  data-pending-resolved={String(pending.resolved)}
  data-pending-expired={String(expired)}
  data-turn={pending.turnNumber}
  data-fade-sec={fade}
>
  <header class="head">
    <button
      data-testid="pending-initiator"
      class="link initiator"
      onclick={() => highlight("initiator", pending.initiator.actorId)}
      title="Center and outline initiator {pending.initiator.name}"
    >
      {pending.initiator.name}
    </button>
    <span class="arrow">→</span>
    <span class="action" data-testid="pending-action">{pending.initiator.actionLabel}</span>
    <span class="arrow">→</span>
    <button
      data-testid="pending-target"
      class="link target"
      onclick={() => highlight("target", pending.target.actorId)}
      title="Center and outline target {pending.target.name}"
    >
      {pending.target.name}
    </button>
    <span class="meta">T{pending.turnNumber} · expires T{pending.expiresTurn} · {fade}s</span>
    {#if pending.resolved}
      <span class="tag resolved" data-testid="pending-resolved">resolved</span>
    {:else if expired}
      <span class="tag expired" data-testid="pending-expired">expired</span>
    {:else}
      <span class="tag pending" data-testid="pending-tag">pending</span>
    {/if}
  </header>

  {#if pending.area}
    <div class="area">
      <button
        data-testid="pending-area"
        class="link area"
        onclick={() => highlight("area", null)}
        title="Outline area {pending.area.shape} r{pending.area.radiusFt}ft"
      >
        {pending.area.shape} · {pending.area.radiusFt}ft
      </button>
    </div>
  {/if}

  <div class="body">
    <div class="line">
      <span class="kind" data-testid="pending-kind">{pending.kind}</span>
      <span class="formula" data-testid="pending-formula-display" data-pending-formula={pending.formula}>{pending.formula}</span>
      {#if pending.dc !== null}
        <span class="dc" data-testid="pending-dc">vs DC {pending.dc}</span>
      {/if}
      {#if pending.resolved && pending.total !== null && pending.total !== undefined}
        <span class="total chip" data-testid="pending-total">[[{pending.total}|{pending.formula}]]</span>
      {:else}
        <span class="total pending" data-testid="pending-total-pending">pending — no total yet</span>
      {/if}
    </div>

    {#if pending.modifiers.length > 0}
      <details class="modifiers" data-testid="pending-modifiers">
        <summary>{pending.modifiers.length} modifier{pending.modifiers.length === 1 ? "" : "s"}</summary>
        <ul>
          {#each pending.modifiers as mod, idx (idx)}
            <li class="modifier">
              <span class="mod-label">{mod.label}</span>
              <span class="mod-value">{mod.value > 0 ? "+" : ""}{mod.value}</span>
              <span class="mod-reason">({mod.reason})</span>
            </li>
          {/each}
        </ul>
      </details>
    {:else}
      <details class="modifiers" data-testid="pending-modifiers">
        <summary>modifiers</summary>
        <p class="hint">no modifiers</p>
      </details>
    {/if}

    {#if pending.resolved}
      <p class="hint resolved" data-testid="pending-rolled-hint">— rolled {pending.total}</p>
    {:else if expired}
      <p class="hint expired" data-testid="pending-expired-hint">— expired (window closed, 2 rounds)</p>
    {/if}
  </div>

  <footer class="actions">
    {#if !pending.resolved && !expired}
      <button
        data-testid="pending-roll-button"
        data-pending-roll-button
        class="primary"
        disabled={!canRoll}
        title={canRoll ? "Roll {pending.formula} (host-verified)" : isOwner || isGM ? "expired" : "Only the target player or GM may roll"}
        onclick={() => onRoll?.()}
      >
        Roll — {pending.formula}
      </button>
      {#if isGM}
        <button
          data-testid="pending-gm-resolve"
          class="secondary"
          onclick={() => onGMResolve?.()}
          title="GM auto-resolves with host RNG"
        >
          Resolve (GM)
        </button>
      {/if}
      {#if !canRoll && !isGM && !isOwner}
        <span class="hint">Only {pending.target.name} or the GM may roll</span>
      {/if}
    {:else if pending.resolved}
      <span class="meta" data-testid="pending-disabled">— resolved</span>
    {:else}
      <span class="meta" data-testid="pending-disabled">— expired</span>
    {/if}
  </footer>
</article>

<style>
  .pendingcard {
    border: 1px solid #3a5a7f;
    border-radius: 8px;
    background: #14202e;
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
    gap: 6px;
    flex-wrap: wrap;
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
  .arrow { color: #8b93a3; }
  .action { font-weight: 600; color: #e8c07a; }
  .meta { color: #8b93a3; font-size: 0.8125rem; margin-left: auto; }
  .tag { font-size: 0.8125rem; padding: 1px 6px; border-radius: 999px; }
  .tag.pending { background: #2a3a5a; color: #8ab4ff; }
  .tag.resolved { background: #1a3a2a; color: #7fe0a7; }
  .tag.expired { background: #3a2a2a; color: #e0a0a0; }
  .area { display: flex; gap: 6px; }
  .body { display: flex; flex-direction: column; gap: 6px; }
  .line { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .kind { font-size: 0.8125rem; text-transform: uppercase; letter-spacing: 0.06em; color: #8b93a3; }
  .formula { color: #8b93a3; font-family: monospace; font-size: 0.8125rem; }
  .dc { font-weight: 600; color: #e8c07a; }
  .total.chip {
    display: inline-block;
    padding: 0 6px;
    border: 1px solid #2e8b57;
    border-radius: 999px;
    color: #7fe0a7;
    font-weight: 700;
  }
  .total.pending { color: #8b93a3; font-style: italic; }
  .modifiers { margin-top: 2px; }
  .modifiers summary { cursor: pointer; color: #9eafc5; }
  .modifier { display: flex; gap: 6px; margin: 4px 0; }
  .mod-label { font-weight: 600; }
  .mod-value { font-family: monospace; }
  .mod-reason { color: #8b93a3; }
  .hint { color: #8b93a3; font-size: 0.8125rem; margin: 2px 0 0; }
  .actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .actions button { padding: 4px 10px; border-radius: 6px; border: 1px solid #3a3f4a; background: #1d2127; color: #e8e8ee; cursor: pointer; }
  .actions button.primary { background: #1e3a5a; border-color: #3a5a9f; color: #8ab4ff; }
  .actions button.secondary { background: #1d2127; border-color: #3a5a7f; color: #9eafc5; }
  .actions button:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
