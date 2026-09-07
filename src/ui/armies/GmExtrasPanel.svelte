<script lang="ts">
  /**
   * §10 GM extras (window): faction editor, god-view / faction preview,
   * mass spawn (Army + Unit docs — the sim materializes models per profile),
   * casualty/heal (unit strength ops), batch order override (template ops on
   * every selected unit across armies).
   */
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ArmyDocument, FactionDocument, UnitDocument } from "../../core/strategic";
  import { ORDER_TEMPLATES, rulesContextFromStore } from "./armyModel";
  import type { HostPackages, PackageSummary } from "../../app/hostBoot";
  import { gmState } from "./gmState.svelte";

  let {
    client,
    bus,
    sceneId = null,
    packages = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    sceneId?: string | null;
    packages?: HostPackages | null;
  } = $props();

  let factions = $state<FactionDocument[]>([]);
  let armies = $state<ArmyDocument[]>([]);
  const allUnits = $derived(
    armies.flatMap((a) => a.units.map((u) => ({ unit: u, armyId: a._id, factionId: a.factionId }))),
  );

  // faction editor
  let newFactionName = $state("");
  // mass spawn
  let spawnFaction = $state("");
  let spawnName = $state("New Army");
  let spawnCount = $state(12);
  let spawnFormation = $state("line");
  // casualty/heal
  let adjustUnit = $state("");
  let adjustDelta = $state(-2);
  // campaign (§5A turn controls via sim.control)
  let phase = $state("idle");
  // §5A realtime clock state (from turn.phase frames)
  let rtMode = $state(false);
  let rtPaused = $state(false);
  let rtHz = $state(5);
  let rateChoice = $state("5");
  // batch orders
  const selected = new SvelteSet<string>();
  let batchAnchorX = $state(0);
  let batchAnchorY = $state(0);
  let batchFacing = $state(0);

  function refresh(): void {
    factions = [...(client.store.getAll("factions") as readonly FactionDocument[])];
    armies = [...(client.store.getAll("armies") as readonly ArmyDocument[])];
    if (!spawnFaction && factions[0]) spawnFaction = factions[0]._id;
    if (adjustUnit && !allUnits.some((u) => u.unit._id === adjustUnit)) {
      adjustUnit = allUnits[0]?.unit._id ?? "";
    } else if (!adjustUnit && allUnits[0]) adjustUnit = allUnits[0].unit._id;
  }

  function createFaction(): void {
    if (!newFactionName.trim()) return;
    client.submit([
      {
        kind: "create",
        coll: "factions",
        data: {
          _id: globalThis.crypto.randomUUID(),
          type: "faction",
          name: newFactionName.trim(),
          ownership: { default: 0 },
          flags: {},
          system: {},
          color: "#7aa2f7",
          allies: [],
        },
      },
    ]);
    newFactionName = "";
  }

  function setAlly(f: FactionDocument, allyId: string, on: boolean): void {
    const allies = on
      ? [...new Set([...f.allies, allyId])].filter((a) => a !== f._id)
      : f.allies.filter((a) => a !== allyId);
    client.submit([{ kind: "update", ref: { coll: "factions", id: f._id }, diff: { allies } }]);
  }

  function massSpawn(): void {
    if (!spawnFaction || spawnCount <= 0) return;
    const unit: UnitDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "infantry",
      name: `${spawnName} — vanguard`,
      ownership: { default: 0 },
      flags: {},
      system: {},
      profile: {},
      formation: spawnFormation,
      sceneId,
      modelRange: null,
      orders: { pending: [], issuedBy: client.user?.id ?? "gm", issuedTurn: 0 },
      stats: { strength: spawnCount, morale: 5, supply: 5, fatigue: 0 },
    };
    client.submit([
      {
        kind: "create",
        coll: "armies",
        data: {
          _id: globalThis.crypto.randomUUID(),
          type: "army",
          name: spawnName.trim() || "New Army",
          ownership: { default: 0 },
          flags: {},
          system: {},
          factionId: spawnFaction,
          commander: [],
          supply: { level: 5 },
          units: [unit],
        },
      },
    ]);
  }

  function applyAdjust(): void {
    const entry = allUnits.find((u) => u.unit._id === adjustUnit);
    if (!entry || !Number.isFinite(adjustDelta)) return;
    const army = armies.find((a) => a._id === entry.armyId);
    if (!army) return;
    const units = army.units.map((u) =>
      u._id === entry.unit._id
        ? { ...u, stats: { ...u.stats, strength: Math.max(0, u.stats.strength + adjustDelta) } }
        : u,
    );
    client.submit([{ kind: "update", ref: { coll: "armies", id: army._id }, diff: { units } }]);
  }

  function toggleUnit(id: string): void {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }

  function batchOrder(templateId: string): void {
    const tpl = ORDER_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const ctx = rulesContextFromStore(client.store);
    const ops = [];
    for (const army of armies) {
      const units = army.units.map((u) => {
        if (!selected.has(u._id)) return u;
        const order = tpl.build({ x: batchAnchorX, y: batchAnchorY }, batchFacing);
        return {
          ...u,
          orders: {
            pending: [...u.orders.pending, order],
            issuedBy: client.user?.id ?? "gm",
            issuedTurn: u.orders.issuedTurn,
          },
        };
      });
      if (units.some((u, i) => u !== army.units[i])) {
        ops.push({
          kind: "update" as const,
          ref: { coll: "armies" as const, id: army._id },
          diff: { units },
        });
      }
    }
    void ctx;
    if (ops.length > 0) client.submit(ops);
  }

  // §12 system/data packages (import + activate; applies on world reload)
  let pkgList = $state<PackageSummary[]>([]);
  let pkgBusy = $state(false);
  let pkgError = $state("");
  let pkgFileInput = $state<HTMLInputElement | null>(null);
  const refreshPackages = (): void => {
    if (!packages) return;
    void packages
      .list()
      .then((list) => {
        pkgList = list;
      })
      .catch(() => {});
  };
  async function importPackageZip(): Promise<void> {
    if (!packages || !pkgFileInput?.files?.[0]) return;
    pkgBusy = true;
    pkgError = "";
    try {
      const bytes = new Uint8Array(await pkgFileInput.files[0].arrayBuffer());
      const res = await packages.importZip(bytes);
      if (!res.ok) pkgError = res.error;
      refreshPackages();
    } finally {
      pkgBusy = false;
    }
  }
  async function activatePackage(id: string): Promise<void> {
    if (!packages) return;
    pkgBusy = true;
    pkgError = "";
    try {
      const res = await packages.activate(id);
      if (!res.ok) pkgError = res.error;
      refreshPackages();
    } finally {
      pkgBusy = false;
    }
  }

  // §12 trusted in-page execution: two-step GM consent (first click arms,
  // second click within 3 s grants)
  let trustConfirmId = $state("");
  let trustTimer: ReturnType<typeof setTimeout> | null = null;
  function requestGrantTrust(id: string): void {
    if (trustConfirmId !== id) {
      trustConfirmId = id;
      if (trustTimer !== null) clearTimeout(trustTimer);
      trustTimer = setTimeout(() => (trustConfirmId = ""), 3_000);
      return;
    }
    trustConfirmId = "";
    if (trustTimer !== null) clearTimeout(trustTimer);
    void grantTrust(id);
  }
  async function grantTrust(id: string): Promise<void> {
    if (!packages) return;
    pkgBusy = true;
    pkgError = "";
    try {
      const res = await packages.grantTrust(id);
      if (!res.ok) pkgError = res.error;
      refreshPackages();
    } finally {
      pkgBusy = false;
    }
  }
  async function revokeTrust(id: string): Promise<void> {
    if (!packages) return;
    pkgBusy = true;
    pkgError = "";
    try {
      const res = await packages.revokeTrust(id);
      if (!res.ok) pkgError = res.error;
      refreshPackages();
    } finally {
      pkgBusy = false;
    }
  }
  onMount(refreshPackages);

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offPhase = bus.on("turnPhase", (m) => {
      phase = m.phase;
      rtMode = m.mode === "realtime";
      rtPaused = m.paused === true;
      if (typeof m.simHz === "number" && m.simHz > 0) rtHz = m.simHz;
    });
    refresh();
    return () => {
      offSnapshot();
      offOps();
      offPhase();
    };
  });
</script>

<div class="gmextras">
  <h4>Campaign</h4>
  <div class="row">
    <button
      id="campaign-start"
      type="button"
      disabled={phase !== "idle"}
      onclick={() => client.simControl("start", { mode: "stepwise" })}
    >
      Start (stepwise)
    </button>
    <button
      id="campaign-start-rt"
      type="button"
      disabled={phase !== "idle"}
      onclick={() => client.simControl("start", { mode: "realtime" })}
    >
      Start (realtime)
    </button>
    <button
      id="campaign-pause"
      type="button"
      disabled={!rtMode || rtPaused}
      onclick={() => client.simControl("pause")}
    >
      Pause
    </button>
    <button
      id="campaign-resume"
      type="button"
      disabled={!rtPaused}
      onclick={() => client.simControl("resume")}
    >
      Resume
    </button>
    <select
      id="campaign-rate"
      aria-label="Sim rate (Hz)"
      disabled={!rtMode}
      value={rateChoice}
      onchange={(e) => {
        rateChoice = e.currentTarget.value;
        const hz = Number(rateChoice);
        if (Number.isFinite(hz) && hz > 0) client.simControl("rate", { rateHz: hz });
      }}
    >
      {#each ["2", "5", "10"] as hz}
        <option value={hz}>{hz} Hz</option>
      {/each}
    </select>
    <button
      data-campaign-advance
      type="button"
      disabled={phase !== "orders"}
      onclick={() => client.simControl("advance")}
    >
      Advance turn
    </button>
    <button
      data-campaign-next
      type="button"
      disabled={phase !== "report"}
      onclick={() => client.simControl("next")}
    >
      Next turn
    </button>
    <span class="dim" data-campaign-phase>
      phase: {phase}{rtMode ? (rtPaused ? " (paused)" : ` (realtime ${rtHz} Hz)`) : ""}
    </span>
  </div>

  <h4>View</h4>
  <label class="row">
    <input
      id="god-view"
      type="checkbox"
      bind:checked={gmState.godView}
      onchange={() => {
        if (gmState.godView) gmState.viewAsFaction = "";
      }}
    />
    God view (see everything)
  </label>
  {#if !gmState.godView}
    <label class="row">
      View as faction
      <select data-view-faction bind:value={gmState.viewAsFaction}>
        <option value="">—</option>
        {#each factions as f (f._id)}
          <option value={f._id}>{f.name}</option>
        {/each}
      </select>
    </label>
  {/if}

  <h4>Factions</h4>
  <table data-faction-rows>
    <thead>
      <tr><th>Name</th><th>Color</th><th>Allies</th></tr>
    </thead>
    <tbody>
      {#each factions as f (f._id)}
        <tr data-faction={f._id}>
          <td>{f.name}</td>
          <td><span class="swatch" style:background={f.color}></span></td>
          <td class="allies">
            {#each factions as other (other._id)}
              {#if other._id !== f._id}
                <label class="ally">
                  <input
                    type="checkbox"
                    checked={f.allies.includes(other._id)}
                    onchange={(e) => setAlly(f, other._id, (e.target as HTMLInputElement).checked)}
                  />
                  {other.name}
                </label>
              {/if}
            {/each}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      createFaction();
    }}
  >
    <input id="faction-name" type="text" bind:value={newFactionName} placeholder="New faction" />
    <button id="faction-create" type="submit">Create</button>
  </form>

  <h4>Mass spawn</h4>
  <div class="row">
    <select data-spawn-faction bind:value={spawnFaction}>
      {#each factions as f (f._id)}
        <option value={f._id}>{f.name}</option>
      {/each}
    </select>
    <input data-spawn-name type="text" bind:value={spawnName} aria-label="Army name" />
    <input
      data-spawn-count
      type="number"
      min="1"
      max="500"
      bind:value={spawnCount}
      aria-label="Model count"
    />
    <select data-spawn-formation bind:value={spawnFormation}>
      {#each ["line", "column", "wedge"] as fm (fm)}
        <option value={fm}>{fm}</option>
      {/each}
    </select>
    <button id="mass-spawn" type="button" onclick={massSpawn}>Spawn</button>
  </div>

  <h4>Casualty / heal</h4>
  <div class="row">
    <select data-adjust-unit bind:value={adjustUnit}>
      {#each allUnits as u (u.unit._id)}
        <option value={u.unit._id}>{u.unit.name} ({u.unit.stats.strength})</option>
      {/each}
    </select>
    <input data-adjust-delta type="number" bind:value={adjustDelta} aria-label="Strength delta" />
    <button id="apply-adjust" type="button" onclick={applyAdjust}>Apply</button>
  </div>

  <h4>Batch orders</h4>
  <p class="dim">
    Select units, then apply a template (anchor {batchAnchorX},{batchAnchorY} facing {batchFacing}°).
  </p>
  <div class="row">
    <input data-batch-x type="number" bind:value={batchAnchorX} aria-label="Anchor X" />
    <input data-batch-y type="number" bind:value={batchAnchorY} aria-label="Anchor Y" />
    <input data-batch-facing type="number" bind:value={batchFacing} aria-label="Facing degrees" />
  </div>
  <ul class="unitlist">
    {#each allUnits as u (u.unit._id)}
      <li>
        <label>
          <input
            type="checkbox"
            data-unit-check={u.unit._id}
            checked={selected.has(u.unit._id)}
            onchange={() => toggleUnit(u.unit._id)}
          />
          {u.unit.name}
        </label>
      </li>
    {/each}
  </ul>
  <div class="row">
    {#each ORDER_TEMPLATES as tpl (tpl.id)}
      <button
        type="button"
        data-batch-template={tpl.id}
        disabled={selected.size === 0}
        onclick={() => batchOrder(tpl.id)}
      >
        {tpl.label}
      </button>
    {/each}
  </div>
</div>

{#if packages}
  <div class="section" data-pkg-section>
    <h4>System package (§12)</h4>
    {#each pkgList as p (p.id)}
      <div class="row" data-pkg-row data-pkg-id={p.id}>
        <span
          >{p.name} v{p.version} · {p.type}{p.packCount > 0
            ? ` · ${p.packCount} pack(s)`
            : ""}</span
        >
        {#if p.active}
          <span data-pkg-active>active</span>
        {:else if p.type === "system"}
          <button
            type="button"
            data-pkg-activate
            disabled={pkgBusy}
            onclick={() => activatePackage(p.id)}
          >
            Activate
          </button>
        {/if}
        {#if p.trustRequested}
          {#if p.trusted}
            <span data-pkg-trusted>trusted (in-page)</span>
            <button
              type="button"
              data-trust-revoke
              disabled={pkgBusy}
              onclick={() => revokeTrust(p.id)}
            >
              Revoke trust
            </button>
          {:else}
            <span data-pkg-trust-requested>wants in-page</span>
            <button
              type="button"
              data-trust-grant
              disabled={pkgBusy}
              onclick={() => requestGrantTrust(p.id)}
            >
              {trustConfirmId === p.id ? "Confirm grant?" : "Grant in-page"}
            </button>
          {/if}
        {/if}
      </div>
    {/each}
    <div class="row">
      <input
        id="pkg-file"
        type="file"
        accept=".zip"
        bind:this={pkgFileInput}
        onchange={() => void importPackageZip()}
      />
    </div>
    {#if pkgError}<p data-pkg-error>{pkgError}</p>{/if}
    <p class="hint">Activation applies when the world reloads; fresh campaigns only.</p>
  </div>
{/if}

<style>
  .gmextras {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h4 {
    margin: 4px 0 0;
  }
  .hint {
    margin: 0;
    font-size: 11px;
    opacity: 0.7;
  }
  .row {
    display: flex;
    gap: 4px;
    align-items: center;
    flex-wrap: wrap;
  }
  .row input[type="number"] {
    width: 5em;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    padding: 2px 4px;
    font-size: 12px;
    border-bottom: 1px solid #262e3a;
  }
  .allies {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 8px;
  }
  .ally {
    font-size: 11px;
    display: flex;
    gap: 2px;
    align-items: center;
  }
  .swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }
  .dim {
    font-size: 11px;
    opacity: 0.7;
    margin: 0;
  }
  .unitlist {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 120px;
    overflow-y: auto;
    font-size: 12px;
  }
  form {
    display: flex;
    gap: 4px;
  }
  form input {
    flex: 1;
  }
</style>
