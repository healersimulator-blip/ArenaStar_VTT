<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ActionReceiptDocument } from "../../core/documents";

  let { client, bus }: { client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  let receipts = $state<ActionReceiptDocument[]>([]);
  let role = $state("");
  let shown = $state(20);
  let now = $state(Date.now());
  let error = $state("");
  let requested = $state("");
  const isGM = $derived(role === "GM");
  const canView = $derived(isGM || role === "ASSISTANT");
  const ordered = $derived([...receipts].sort((a, b) =>
    b.createdAt - a.createdAt || b._id.localeCompare(a._id)));

  function refresh(): void {
    role = client.user?.role ?? "";
    receipts = [...client.store.getAll("actionReceipts")];
  }
  function revert(id: string): void {
    error = "";
    requested = id;
    client.actionRevert(id);
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offWelcome = bus.on("welcome", refresh);
    const offOps = bus.on("ops", ({ envelope }) => {
      if (envelope.ops.some((op) =>
        (op.kind === "create" ? op.coll : op.ref.coll) === "actionReceipts")) {
        refresh();
        requested = "";
      }
    });
    const offRejected = bus.on("rejected", ({ txId, detail }) => {
      if (txId === requested) { error = detail; requested = ""; }
    });
    const timer = setInterval(() => { now = Date.now(); }, 5000);
    refresh();
    return () => { offSnapshot(); offWelcome(); offOps(); offRejected(); clearInterval(timer); };
  });
</script>

{#if canView && receipts.length > 0}
  <details class="action-history" data-testid="action-revert-history" open>
    <summary>World actions <span>{receipts.filter((r) => r.status !== "reverted").length} reversible</span></summary>
    {#if error}<p class="error" role="alert" data-testid="action-revert-error">{error}</p>{/if}
    <div class="action-list">
      {#each ordered.slice(0, shown) as receipt (receipt._id)}
        <div class="action-row" data-testid="action-revert-card" data-action-id={receipt._id}>
          <div class="action-name"><strong>{receipt.name}</strong>
            <small>{receipt.commits} commit{receipt.commits === 1 ? "" : "s"} · {receipt.outcome === "partial" ? "partial run" : receipt.status}</small>
          </div>
          {#if isGM && receipt.status !== "reverted"}
            <button type="button" data-testid="action-revert" title="Restore this action’s exact pre-images; refuses later changes"
              disabled={requested === receipt._id || (receipt.status === "pending" && now < (receipt.pendingUntil ?? Infinity))}
              onclick={() => revert(receipt._id)}>Revert</button>
          {/if}
        </div>
      {/each}
      {#if ordered.length > shown}
        <button type="button" class="more" onclick={() => shown += 20}>Show earlier actions</button>
      {/if}
    </div>
  </details>
{/if}

<style>
  .action-history { border: 1px solid var(--border, #354354); border-radius: 10px; margin: 8px 10px;
    background: color-mix(in srgb, var(--surface, #1d2832) 92%, #69b5c1); }
  summary { cursor: pointer; padding: 9px 11px; font-weight: 700; font-size: .86rem; }
  summary span { font-weight: 400; opacity: .7; float: right; }
  .action-list { max-height: 230px; overflow: auto; padding: 0 8px 6px; }
  .action-row { display: flex; gap: 8px; justify-content: space-between; align-items: center;
    border-top: 1px solid var(--border, #354354); padding: 7px 3px; }
  .action-name { min-width: 0; display: grid; gap: 2px; }
  strong { font-size: .82rem; font-weight: 600; overflow-wrap: anywhere; }
  small { font-size: .7rem; opacity: .72; }
  button { cursor: pointer; border-radius: 6px; padding: 5px 9px; border: 1px solid var(--border, #4c6575);
    background: var(--surface, #253641); color: inherit; font-size: .78rem; }
  button:disabled { cursor: default; opacity: .5; }
  .more { width: 100%; margin-top: 5px; }
  .error { color: #f5aaa3; font-size: .75rem; padding: 0 8px; }
</style>
