<script lang="ts">
  /**
   * §10 Logistics Panel — Depots, Supply Routes, Reinforcement Queue, Attrition Forecast & Upkeep.
   */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { RulesModule } from "../../core/rules";
  import type { ArmyDocument, FactionDocument } from "../../core/strategic";
  import {
    calculateLogisticsForecast,
    type DepotDocument,
    type ReinforcementDocument,
    type RouteDocument,
    type LogisticsForecast,
  } from "../../core/logistics";
  import { worldSettingsFrom } from "../../core/worldSettings";

  let {
    client,
    bus,
    rules = null,
    sceneId = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    rules?: RulesModule | null;
    sceneId?: string | null;
  } = $props();

  type Tab = "forecast" | "depots" | "routes" | "reinforcements";
  let tab = $state<Tab>("forecast");

  let depots = $state<DepotDocument[]>([]);
  let routes = $state<RouteDocument[]>([]);
  let reinforcements = $state<ReinforcementDocument[]>([]);
  let armies = $state<ArmyDocument[]>([]);
  let factions = $state<FactionDocument[]>([]);

  // Depot form
  let depotName = $state("Supply Depot Alpha");
  let depotFaction = $state("");
  let depotX = $state(200);
  let depotY = $state(200);
  let depotCapacity = $state(100);
  let depotSupply = $state(80);
  let depotUpkeep = $state(10);

  // Route form
  let routeName = $state("Main Supply Line");
  let routeDepot = $state("");
  let routeTarget = $state("");
  let routeThroughput = $state(30);
  let routeStatus = $state<"active" | "disrupted" | "severed">("active");

  // Reinforcement form
  let reinfFaction = $state("");
  let reinfArmy = $state("");
  let reinfName = $state("2nd Infantry Cohort");
  let reinfType = $state("infantry");
  let reinfStrength = $state(24);
  let reinfTurns = $state(2);

  function refresh(): void {
    depots = [...(client.store.getAll("depots") as readonly DepotDocument[])];
    routes = [...(client.store.getAll("routes") as readonly RouteDocument[])];
    reinforcements = [...(client.store.getAll("reinforcements") as readonly ReinforcementDocument[])];
    armies = [...(client.store.getAll("armies") as readonly ArmyDocument[])];
    factions = [...(client.store.getAll("factions") as readonly FactionDocument[])];

    if (!depotFaction && factions[0]) depotFaction = factions[0]._id;
    if (!routeDepot && depots[0]) routeDepot = depots[0]._id;
    if (!routeTarget && armies[0]) routeTarget = armies[0]._id;
    if (!reinfFaction && factions[0]) reinfFaction = factions[0]._id;
    if (!reinfArmy && armies[0]) reinfArmy = armies[0]._id;
  }

  const forecast = $derived.by<LogisticsForecast>(() => {
    if (rules?.forecast) {
      const ctx = {
        sceneId: sceneId ?? null,
        grid: { type: "square" as const, size: 100, distance: 5, units: "ft", diagonals: "555" as const },
        walls: { x1: new Float32Array(), y1: new Float32Array(), x2: new Float32Array(), y2: new Float32Array(), restriction: new Uint8Array() },
        factions,
        armies,
        leaderActors: {},
        worldSettings: worldSettingsFrom(client.store.getAll("settings")),
      };
      return rules.forecast(ctx, armies, depots, routes, reinforcements);
    }
    return calculateLogisticsForecast(armies, depots, routes, reinforcements);
  });

  function createDepot(): void {
    if (!depotName.trim() || !depotFaction) return;
    const doc: DepotDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "depot",
      name: depotName.trim(),
      factionId: depotFaction,
      sceneId,
      location: { x: depotX, y: depotY },
      capacity: depotCapacity,
      currentSupply: depotSupply,
      upkeepCost: depotUpkeep,
      ownership: { default: 0 },
      flags: {},
      system: {},
    };
    client.submit([{ kind: "create", coll: "depots", data: doc }]);
  }

  function deleteDepot(id: string): void {
    client.submit([{ kind: "delete", ref: { coll: "depots", id } }]);
  }

  function createRoute(): void {
    if (!routeName.trim() || !routeDepot) return;
    const doc: RouteDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "route",
      name: routeName.trim(),
      fromDepotId: routeDepot,
      toTargetId: routeTarget,
      throughput: routeThroughput,
      status: routeStatus,
      ownership: { default: 0 },
      flags: {},
      system: {},
    };
    client.submit([{ kind: "create", coll: "routes", data: doc }]);
  }

  function deleteRoute(id: string): void {
    client.submit([{ kind: "delete", ref: { coll: "routes", id } }]);
  }

  function queueReinforcement(): void {
    if (!reinfFaction || !reinfArmy || reinfStrength <= 0) return;
    const doc: ReinforcementDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "reinforcement",
      factionId: reinfFaction,
      armyId: reinfArmy,
      unitType: reinfType,
      unitName: reinfName.trim() || "Reinforcements",
      strength: reinfStrength,
      turnsRemaining: reinfTurns,
      ownership: { default: 0 },
      flags: {},
      system: {},
    };
    client.submit([{ kind: "create", coll: "reinforcements", data: doc }]);
  }

  function deleteReinforcement(id: string): void {
    client.submit([{ kind: "delete", ref: { coll: "reinforcements", id } }]);
  }

  onMount(() => {
    refresh();
    const offSnap = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    return () => {
      offSnap();
      offOps();
    };
  });
</script>

<div class="logistics-panel" data-logistics-panel>
  <header>
    <h3>Logistics & Attrition (§10, §12)</h3>
    <nav>
      {#each ["forecast", "depots", "routes", "reinforcements"] as t (t)}
        <button
          class:active={tab === t}
          onclick={() => (tab = t as Tab)}
          data-tab={t}
        >
          {t}
        </button>
      {/each}
    </nav>
  </header>

  <main>
    {#if tab === "forecast"}
      <div class="forecast-tab" data-forecast-view>
        <h4>Summary</h4>
        <p>Total Depots: {forecast.totalDepots} | Active Routes: {forecast.totalActiveRoutes} | Pending Reinforcements: {forecast.pendingReinforcements}</p>

        <h4>Faction Forecasts</h4>
        {#each Object.values(forecast.factions) as f (f.factionId)}
          {@const fDoc = factions.find((x) => x._id === f.factionId)}
          <div class="faction-card" data-faction-forecast={f.factionId}>
            <div class="f-header">
              <strong>{fDoc?.name ?? f.factionId}</strong>
              <span class="badge">Upkeep: {f.totalUpkeepCost} gold</span>
            </div>
            <div class="stats">
              <span>Supply Avail: {f.totalSupplyAvailable}</span>
              <span>Supply Req: {f.totalSupplyRequired}</span>
              <span>Net: <strong class:negative={f.netSupplyChange < 0}>{f.netSupplyChange}</strong></span>
            </div>
            {#if f.arrivingReinforcementsCount > 0}
              <div class="reinf-info">Arriving soon: +{f.arrivingReinforcementsCount} strength</div>
            {/if}
            {#each f.warnings as w (w)}
              <div class="warning" data-forecast-warning>{w}</div>
            {/each}
          </div>
        {/each}
      </div>
    {:else if tab === "depots"}
      <div class="depots-tab" data-depots-view>
        <h4>Depots</h4>
        <ul class="depot-list">
          {#each depots as d (d._id)}
            <li data-depot-id={d._id}>
              <span><strong>{d.name}</strong> ({d.currentSupply}/{d.capacity} supply, upkeep {d.upkeepCost})</span>
              <button type="button" class="del" onclick={() => deleteDepot(d._id)}>✕</button>
            </li>
          {/each}
        </ul>
        {#if depots.length === 0}<p class="dim">No depots created.</p>{/if}

        <h4>Add Depot</h4>
        <form onsubmit={(e) => { e.preventDefault(); createDepot(); }}>
          <input type="text" bind:value={depotName} placeholder="Depot Name" data-depot-name />
          <select bind:value={depotFaction} data-depot-faction>
            {#each factions as f (f._id)}
              <option value={f._id}>{f.name}</option>
            {/each}
          </select>
          <div class="row">
            <input type="number" bind:value={depotX} placeholder="X" aria-label="X coordinate" />
            <input type="number" bind:value={depotY} placeholder="Y" aria-label="Y coordinate" />
            <input type="number" bind:value={depotCapacity} placeholder="Capacity" aria-label="Depot Capacity" />
            <input type="number" bind:value={depotSupply} placeholder="Current Supply" aria-label="Current Supply" />
            <input type="number" bind:value={depotUpkeep} placeholder="Upkeep" aria-label="Upkeep cost" />
          </div>
          <button type="submit" data-add-depot>Create Depot</button>
        </form>
      </div>
    {:else if tab === "routes"}
      <div class="routes-tab" data-routes-view>
        <h4>Supply Routes</h4>
        <ul class="route-list">
          {#each routes as r (r._id)}
            <li data-route-id={r._id}>
              <span><strong>{r.name}</strong> ({r.throughput} throughput, status: <span class="status">{r.status}</span>)</span>
              <button type="button" class="del" onclick={() => deleteRoute(r._id)}>✕</button>
            </li>
          {/each}
        </ul>
        {#if routes.length === 0}<p class="dim">No routes created.</p>{/if}

        <h4>Add Supply Route</h4>
        <form onsubmit={(e) => { e.preventDefault(); createRoute(); }}>
          <input type="text" bind:value={routeName} placeholder="Route Name" data-route-name />
          <select bind:value={routeDepot} data-route-depot>
            {#each depots as d (d._id)}
              <option value={d._id}>{d.name}</option>
            {/each}
          </select>
          <select bind:value={routeTarget} data-route-target>
            {#each armies as a (a._id)}
              <option value={a._id}>{a.name}</option>
            {/each}
          </select>
          <div class="row">
            <input type="number" bind:value={routeThroughput} placeholder="Throughput" aria-label="Route Throughput" />
            <select bind:value={routeStatus} data-route-status>
              <option value="active">Active</option>
              <option value="disrupted">Disrupted</option>
              <option value="severed">Severed</option>
            </select>
          </div>
          <button type="submit" data-add-route>Create Route</button>
        </form>
      </div>
    {:else if tab === "reinforcements"}
      <div class="reinf-tab" data-reinf-view>
        <h4>Reinforcement Queue</h4>
        <ul class="reinf-list">
          {#each reinforcements as r (r._id)}
            <li data-reinf-id={r._id}>
              <span><strong>{r.unitName}</strong> ({r.strength} {r.unitType}) — arrives in {r.turnsRemaining} turn(s)</span>
              <button type="button" class="del" onclick={() => deleteReinforcement(r._id)}>✕</button>
            </li>
          {/each}
        </ul>
        {#if reinforcements.length === 0}<p class="dim">No pending reinforcements.</p>{/if}

        <h4>Order Reinforcements</h4>
        <form onsubmit={(e) => { e.preventDefault(); queueReinforcement(); }}>
          <select bind:value={reinfFaction} data-reinf-faction>
            {#each factions as f (f._id)}
              <option value={f._id}>{f.name}</option>
            {/each}
          </select>
          <select bind:value={reinfArmy} data-reinf-army>
            {#each armies as a (a._id)}
              <option value={a._id}>{a.name}</option>
            {/each}
          </select>
          <input type="text" bind:value={reinfName} placeholder="Unit Name" data-reinf-name />
          <div class="row">
            <input type="number" bind:value={reinfStrength} placeholder="Strength" aria-label="Reinforcement Strength" />
            <input type="number" bind:value={reinfTurns} placeholder="Turns" aria-label="Turns Remaining" />
          </div>
          <button type="submit" data-add-reinf>Queue Reinforcement</button>
        </form>
      </div>
    {/if}
  </main>
</div>

<style>
  .logistics-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: #181d24;
    border: 1px solid #28303a;
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 12px;
  }
  header {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h3, h4 {
    margin: 4px 0 2px;
  }
  nav {
    display: flex;
    gap: 4px;
  }
  nav button {
    padding: 3px 8px;
    font-size: 11px;
    background: #232a34;
    border: 1px solid #323b46;
    color: #cbd5e0;
    border-radius: 4px;
    cursor: pointer;
  }
  nav button.active {
    background: #3182ce;
    color: #ffffff;
  }
  .faction-card {
    background: #232a34;
    padding: 8px;
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .f-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .stats {
    display: flex;
    gap: 12px;
    font-size: 11px;
  }
  .negative {
    color: #f56565;
  }
  .warning {
    color: #ecc94b;
    font-size: 11px;
    margin-top: 4px;
  }
  .reinf-info {
    color: #48bb78;
    font-size: 11px;
    margin-top: 2px;
  }
  ul {
    list-style: none;
    margin: 4px 0;
    padding: 0;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 6px;
    background: #232a34;
    margin-bottom: 4px;
    border-radius: 4px;
  }
  .del {
    background: none;
    border: none;
    color: #a0aec0;
    cursor: pointer;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  form input, form select {
    padding: 3px 6px;
    background: #232a34;
    border: 1px solid #323b46;
    color: #ffffff;
    border-radius: 4px;
  }
  .row {
    display: flex;
    gap: 4px;
  }
  .row input {
    flex: 1;
  }
  .dim {
    font-style: italic;
    opacity: 0.7;
  }
</style>
