<script lang="ts">
  /** §10 Armies tab — army cards from the local replica; opens the AMW. */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ArmyDocument, FactionDocument } from "../../core/strategic";
  import { armyCards, moveUnitOps, type ArmyCard } from "./armyModel";

  let {
    client,
    bus,
    onOpen,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    onOpen: (armyId: string) => void;
  } = $props();

  let cards = $state<ArmyCard[]>([]);
  let dragOver = $state<string | null>(null);

  function refresh(): void {
    cards = armyCards(
      client.store.getAll("armies") as ArmyDocument[],
      client.store.getAll("factions") as FactionDocument[],
    );
  }

  onMount(() => {
    refresh();
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offSim = bus.on("sim", refresh);
    return () => {
      offSnapshot();
      offOps();
      offSim();
    };
  });

  /** AMW unit drag → army card = reorganisation (emits Ops, §10). */
  function onDrop(ev: DragEvent, armyId: string): void {
    ev.preventDefault();
    dragOver = null;
    const raw = ev.dataTransfer?.getData("application/x-vtt-unit");
    if (!raw) return;
    try {
      const { unitId, fromArmyId } = JSON.parse(raw) as { unitId: string; fromArmyId: string };
      const from = client.store.get("armies", fromArmyId);
      const unit = from?.units.find((u) => u._id === unitId);
      if (!from || !unit) return;
      const ops = moveUnitOps(unit, fromArmyId, armyId);
      if (ops.length > 0) client.submit(ops);
    } catch {
      // malformed drag payload — ignore
    }
  }
</script>

<div class="armies">
  {#if cards.length === 0}
    <p class="empty">No armies in this world yet.</p>
  {/if}
  {#each cards as card (card.id)}
    <button
      class="card"
      style:border-left-color={card.color}
      onclick={() => onOpen(card.id)}
      ondragover={(ev) => {
        ev.preventDefault();
        dragOver = card.id;
      }}
      ondragleave={() => (dragOver = card.id === dragOver ? null : dragOver)}
      ondrop={(ev) => onDrop(ev, card.id)}
      class:drop={dragOver === card.id}
      data-army={card.id}
    >
      <span class="name">{card.name}</span>
      <span class="faction">{card.factionName}</span>
      <span class="stats">
        {card.unitCount} units · {card.strength} str · mor {card.morale} · sup {card.supplyLevel}
      </span>
    </button>
  {/each}
</div>

<style>
  .armies {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
  }
  .empty {
    color: #8b93a1;
    font-size: 12px;
    padding: 8px;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid #2b3138;
    border-left: 4px solid #9aa0a8;
    border-radius: 6px;
    background: #171b21;
    color: #e8ecf2;
    cursor: pointer;
  }
  .card.drop {
    outline: 2px dashed #53b7ff;
  }
  .name {
    font-weight: 600;
    font-size: 13px;
  }
  .faction {
    font-size: 11px;
    color: #9aa0a8;
  }
  .stats {
    font-size: 11px;
    color: #6f7885;
  }
</style>
