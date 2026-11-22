<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import TurnProgress from "../sim/TurnProgress.svelte";
  import HostedMap from "./HostedMap.svelte";
  import HostedRoster from "./HostedRoster.svelte";
  import ActionCardView from "../chat/ActionCard.svelte";
  import { HostedRoomClient, type HostedState } from "../../client/hostedRoom";
  import { openVttDb } from "../../storage/idb";
  import { ensureIdentity } from "../../net/identityStore";
  import { orderLabel } from "../armies/heroOrders";
  import {
    isId,
    STRATEGIC_SPELL_CATALOG,
    type Command,
    type HostedTemplate,
    type ReadyResponse,
    type ReadyTrigger,
    type ReportPage,
    type RoomOrder,
    type StrategicSpellId,
  } from "../../core/strategicRoom/protocol";

  const campaignPath = /^\/battle\/[0-9a-f-]{36}\/$/.test(location.pathname)
    ? location.pathname
    : null;
  const resumeKey = "arenastar.hosted.resume" + (campaignPath ?? "");
  let client: HostedRoomClient | undefined;
  let state = $state.raw<HostedState>({
    view: null,
    head: null,
    progress: null,
    models: new Map(),
    notice: "Preparing this browser's identity…",
    busy: false,
    receipt: null,
    truncated: false,
  });
  let ready = $state(false);
  let invite = $state("");
  const draft = new SvelteMap<string, RoomOrder | null>();
  let selected = $state("");
  let target = $state("");
  let aimX = $state<number | undefined>();
  let aimY = $state<number | undefined>();
  let reformMarch = $state(false);
  let envelopAttack = $state(false);
  let selectedSpellId = $state<StrategicSpellId | "">("");
  let selectedItemId = $state("");
  let itemTargetId = $state("");
  let readyTrigger = $state<ReadyTrigger>("enemyEntersReach");
  let readyResponse = $state<ReadyResponse>("melee");
  let chatText = $state("");
  let chatRoll = $state("");
  let chatScope = $state<"public" | "faction" | "gm">("public");
  let tplShape = $state<HostedTemplate["shape"]>("circle");
  let tplDist = $state(20);
  let tplDir = $state(0);
  let selectedJournalId = $state("");
  let report = $state.raw<ReportPage | null>(null);
  let reportNotice = $state("");
  let GMduration = $state<number | undefined>();
  let revokeSlot = $state("");
  let rosterOpen = $state(false);
  let zoomOutUnitToken = $state(false);
  let muteFxSound = $state(false);
  let region = $state<{ x: number; y: number } | null>(null);
  let aimFromMap = $state(false);
  let pendingOrdersRequestId = "";
  let turn = 0;
  let handled = "";
  let reportTicket = 0;
  const view = $derived(state.view);
  const preloadedMedia = new SvelteSet<string>();

  $effect(() => {
    for (const asset of [view?.background, ...(view?.media ?? [])]) {
      if (!asset) continue;
      if (preloadedMedia.has(asset.hash) || !asset.mime.startsWith("image/"))
        continue;
      preloadedMedia.add(asset.hash);
      const image = new Image();
      image.decoding = "async";
      image.src = new URL(asset.url, location.href).href;
    }
  });

  const markers = $derived(view?.markers);
  const factionId = $derived(view?.factionId);
  const ownById = $derived(new Map(view?.own.map((u) => [u.id, u])));
  const accepted = $derived(
    new Map(view?.orders.edits.map((e) => [e.unitId, e.order])),
  );
  const activeOrders = $derived(
    new Map<string, RoomOrder | null>([...accepted, ...draft]),
  );
  const current = $derived(state.head ?? view?.head);
  const blocked = $derived(state.busy || state.progress !== null);
  const allowed = $derived(
    view?.head.phase === "orders" &&
      current?.phase === "orders" &&
      current.turnId === view.head.turnId &&
      !blocked,
  );
  const unit = $derived(ownById.get(selected));
  const unitFactionId = $derived(unit?.factionId ?? factionId);
  const markerById = $derived.by(() => {
    const map = new SvelteMap<string, { id: string; name: string; factionId: string; at: { x: number; y: number } }>();
    for (const m of markers ?? []) map.set(m.id, m);
    return map;
  });
  const enemies = $derived.by(() => {
    const all = markers?.filter((u) => u.factionId !== unitFactionId) ?? [];
    if (all.length <= 200) return all;
    const ref = unit?.at;
    const sorted = ref
      ? [...all].sort(
          (a, b) =>
            (a.at.x - ref.x) ** 2 + (a.at.y - ref.y) ** 2 -
            ((b.at.x - ref.x) ** 2 + (b.at.y - ref.y) ** 2),
        )
      : all;
    const sliced = sorted.slice(0, 200);
    if (target && !sliced.some((m) => m.id === target)) {
      const picked = markerById.get(target);
      if (picked && picked.factionId !== unitFactionId) sliced.unshift(picked);
    }
    return sliced;
  });
  const chosenSpell = $derived(
    unit?.spells?.find((sp) => sp.id === selectedSpellId) ?? unit?.spells?.[0],
  );
  const chosenItem = $derived(
    unit?.items?.find((it) => it.id === selectedItemId) ?? unit?.items?.[0],
  );
  const spellPreview = $derived(
    chosenSpell
      ? { shape: chosenSpell.shape, radius: chosenSpell.radius }
      : null,
  );
  const doorWalls = $derived(
    (view?.walls ?? []).filter((w) => Boolean(w.id) && w.door !== undefined),
  );
  const recentLogActions = $derived((view?.actions ?? []).slice(-10).reverse());
  const recentChat = $derived((view?.chat ?? []).slice(-20));
  const aimPoint = $derived(
    aimX !== undefined && aimY !== undefined ? { x: aimX, y: aimY } : null,
  );

  const gmUnits = $derived.by(() => {
    const edges = new SvelteMap<
      string,
      { id: string; name: string; factionId: string; order: RoomOrder | null }[]
    >();
    for (const member of view?.members ?? []) {
      edges.set(
        member.id,
        member.deployed.map((id) => ({
          id,
          name: markerById.get(id)?.name ?? id,
          factionId:
            member.unitFactions?.[id] ??
            markerById.get(id)?.factionId ??
            member.factionId ??
            "",
          order: accepted.get(id) ?? null,
        })),
      );
    }
    return edges;
  });

  const label = (order: RoomOrder | null | undefined) =>
    order === null
      ? "Clear"
      : order?.kind === "reform"
        ? "reform front"
      : order?.kind === "cast"
        ? `cast ${STRATEGIC_SPELL_CATALOG[order.spellId]?.name ?? order.spellId} → (${order.origin.x}, ${order.origin.y})`
      : order?.kind === "useItem"
        ? `use item ${order.itemId}${order.targetUnitId ? ` → ${ownById.get(order.targetUnitId)?.name ?? order.targetUnitId}` : ""}`
      : order?.kind === "ready"
        ? `ready ${order.response} (${order.trigger})`
      : order
        ? orderLabel(
            order,
            (id) =>
              markerById.get(id)?.name ??
              "unavailable target",
          )
        : "—";

  onMount(() => {
    let stopped = false;
    void (async () => {
      const db = await openVttDb();
      try {
        const identity = await ensureIdentity(db);
        if (stopped) return;
        client = new HostedRoomClient(
          identity,
          (next) => {
            state = next;
            if (!next.view) {
              report = null;
              reportNotice = "";
              reportTicket++;
              return;
            }
            if (turn !== next.view.head.turnId) {
              turn = next.view.head.turnId;
              draft.clear();
            }
            if (
              next.receipt?.status === "accepted" &&
              next.receipt.requestId !== handled
            ) {
              handled = next.receipt.requestId;
              if (next.receipt.requestId === pendingOrdersRequestId) {
                pendingOrdersRequestId = "";
                draft.clear();
              }
            }
            if (!next.view.own.some((u) => u.id === selected))
              selected = next.view.own[0]?.id ?? "";
            try {
              localStorage.setItem(resumeKey, "1");
            } catch {
              /* optional preference */
            }
            invite = "";
          },
          campaignPath ? `${campaignPath}api/strategic` : undefined,
        );
        ready = true;
        state = {
          ...state,
          notice: "Enter a one-time invite, or resume from this browser.",
        };
        try {
          if (
            (campaignPath && location.search === "?resume") ||
            localStorage.getItem(resumeKey)
          )
            client.join();
        } catch {
          /* manual resume */
        }
      } finally {
        db.close();
      }
    })().catch(() => {
      if (!stopped)
        state = {
          ...state,
          notice:
            "Browser identity unavailable. Use HTTPS (or local development) and enable site storage.",
        };
    });
    return () => {
      stopped = true;
      client?.close();
    };
  });

  function add(order: RoomOrder | null) {
    if (selected && allowed) draft.set(selected, order);
  }
  function draftBrigadeStance(stance: "hold" | "defend") {
    if (!view || !allowed) return;
    for (const u of view.own) {
      if (u.alive > 0) draft.set(u.id, { kind: "hold", stance });
    }
  }
  function marchWaypointForUnit(
    u: { at: { x: number; y: number } | null; leadAt?: { x: number; y: number } | null } | undefined,
    destX: number,
    destY: number,
    relativeToCenter: boolean,
  ): { x: number; y: number } {
    if (!relativeToCenter || !u?.at || !u.leadAt || !view) {
      return { x: destX, y: destY };
    }
    const b = view.bounds;
    const rawX = Math.round((destX + (u.leadAt.x - u.at.x)) * 16) / 16;
    const rawY = Math.round((destY + (u.leadAt.y - u.at.y)) * 16) / 16;
    return {
      x: Math.min(b.maxX, Math.max(b.minX, rawX)),
      y: Math.min(b.maxY, Math.max(b.minY, rawY)),
    };
  }
  function draftBrigadeMarch() {
    if (!view || !allowed || aimX === undefined || aimY === undefined) return;
    const living = view.own.filter((u) => u.alive > 0 && u.at !== null);
    if (living.length === 0) return;
    const cx = living.reduce((s, u) => s + (u.at?.x ?? 0), 0) / living.length;
    const cy = living.reduce((s, u) => s + (u.at?.y ?? 0), 0) / living.length;
    const dx = aimX - cx;
    const dy = aimY - cy;
    const b = view.bounds;
    const margin = 35;
    for (const u of living) {
      if (!u.at) continue;
      const targetCenterX = Math.min(b.maxX - margin, Math.max(b.minX + margin, u.at.x + dx));
      const targetCenterY = Math.min(b.maxY - margin, Math.max(b.minY + margin, u.at.y + dy));
      const wp = marchWaypointForUnit(u, targetCenterX, targetCenterY, true);
      draft.set(u.id, {
        kind: "move",
        pace: "march",
        path: [wp],
        ...(reformMarch ? { reform: true } : {}),
      });
    }
  }
  function sendOrders() {
    if (!view || !allowed || !draft.size) return;
    const requestId = crypto.randomUUID();
    const command: Command = {
      kind: "orders.submit",
      requestId,
      turnId: view.head.turnId,
      expectedRevision: view.orders.revision,
      unitEdits: [...draft].map(([unitId, order]) => ({ unitId, order })),
    };
    if (client?.submit(command)) pendingOrdersRequestId = requestId;
  }
  function control(kind: "turn.close" | "turn.next" | "turn.retry") {
    if (!view || blocked || view.head.turnId !== current?.turnId) return;
    const common = { requestId: crypto.randomUUID(), turnId: view.head.turnId };
    if (kind === "turn.next")
      client?.submit({
        ...common,
        kind,
        durationMs: GMduration ? Math.trunc(GMduration * 1000) : null,
      });
    else client?.submit({ ...common, kind });
  }
  async function resultPage(version: number, page: number) {
    const ticket = ++reportTicket;
    reportNotice = "Loading report…";
    try {
      const result = await client?.report(version, page);
      if (reportTicket !== ticket || !result || !view) return;
      report = result;
      reportNotice = "";
    } catch {
      if (ticket === reportTicket && view)
        reportNotice = "Report unavailable. Try again.";
    }
  }
  let reportTurn = $state<number | undefined>();
</script>

<main>
  <header class="topbar">
    <div class="brand">
      <span class="seal" aria-hidden="true">✦</span>
      <div>
        <div class="eyebrow">ARENASTAR &nbsp;/&nbsp; STRATEGIC</div>
        <h1>{view?.name ?? "Hosted Strategic Room"}</h1>
      </div>
    </div>
    {#if view}
      <div
        class="phasebar"
        data-turn={view.head.turnId}
        data-version={view.head.version}
        data-phase={view.head.phase}
      >
        <strong>Turn {view.head.turnId}</strong>
        <span class="pill phase">{view.head.phase}</span>
        <span
          class="role-badge"
          style:border-color={view.factions.find((f) => f.id === view?.factionId)?.color}
        >
          {view.role === "GM"
            ? "Game Master"
            : `${view.factions.find((f) => f.id === view?.factionId)?.name ?? ""} commander`}
        </span>
        {#if view.head.deadlineMs}
          <span class="pill">Closes {new Date(view.head.deadlineMs).toLocaleTimeString()}</span>
        {/if}
        <span class="connection">
          <TurnProgress stage={state.progress} />
          {#if !state.progress}<span>{state.notice}</span>{/if}
        </span>
      </div>
    {:else}
      <span class="pill">Hosted pilot · PF1e simultaneous</span>
    {/if}
  </header>

  {#if !view}
    <section class="entry">
      <div class="eyebrow">ROOM ADMISSION</div>
      <h2>Enter the battlefield</h2>
      <p>
        Join as the GM or a commander with a fixed army. Your browser identity
        lets you return to the same assignment.
      </p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          client?.join(invite);
        }}
      >
        <label
          >One-time invite <input
            type="password"
            autocomplete="off"
            maxlength="128"
            placeholder="Leave blank to resume"
            bind:value={invite}
          /></label
        >
        <button class="primary" disabled={!ready} type="submit"
          >Join room</button
        >
      </form>
      <p role="status">{state.notice}</p>
    </section>
  {:else}
    <div class="layout">
      {#if rosterOpen && view.members}
        <section class="panel roster-drawer" aria-label="Commander roster">
          <HostedRoster
            members={view.members}
            units={gmUnits}
            markers={view.markers}
            factions={view.factions}
            phase={view.head.phase}
            busy={state.busy}
            onCommand={(command) => client?.submit(command)}
          />
        </section>
      {/if}

      <section
        class="panel map-panel"
        aria-label="Battlefield"
        aria-busy={state.progress === "applying"}
      >
        <div class="panel-head">
          <div>
            <div class="eyebrow">FIELD VIEW</div>
            <h2>Battlefield</h2>
          </div>
          <div class="map-badges">
            <label class="pill token-zoom-opt">
              <input
                type="checkbox"
                data-zoom-out-unit-token
                bind:checked={zoomOutUnitToken}
              />
              Unit tokens on zoom-out
            </label>
            <label class="pill token-zoom-opt">
              <input
                type="checkbox"
                data-mute-fx-sound
                bind:checked={muteFxSound}
              />
              Mute battle FX
            </label>
            {#each view.factions as f (f.id)}
              <span class="pill" style:border-color={f.color} style:color={f.color}>
                {f.name}: {view.markers.filter((m) => m.factionId === f.id).length} units
              </span>
            {/each}
            <span class="pill">{view.markers.length} visible units</span>
          </div>
        </div>
        <div class="map-canvas-wrap">
          <TurnProgress stage={state.progress} board />
          <HostedMap
            {view}
            models={state.models}
            orders={activeOrders}
            {selected}
            {target}
            aim={aimPoint}
            {spellPreview}
            {zoomOutUnitToken}
            {muteFxSound}
            {region}
            onRegion={(r) => {
              region = r;
              client?.selectRegion(r);
            }}
            onPoint={(p) => {
              aimX = p.x;
              aimY = p.y;
              aimFromMap = true;
            }}
            onSelectUnit={(id) => {
              selected = id;
            }}
            onSelectTarget={(id) => {
              target = id;
            }}
            onToggleDoor={(wallId, door) => {
              if (!state.busy) {
                client?.submit({
                  kind: "scene.door",
                  requestId: crypto.randomUUID(),
                  wallId,
                  door,
                });
              }
            }}
          />
        </div>
        {#if region}<p class="small" data-models={state.models.size}>
            Region {region.x}, {region.y} · {state.models.size} visible models{state.truncated
              ? " · detail capped"
              : ""}
          </p>{/if}
      </section>

      <div class="sidebar">
        <section class="panel">
          <div class="eyebrow">COMMAND</div>
          <h2>{view.role === "GM" ? "Turn control" : "Army orders"}</h2>
          {#if view.role === "GM"}
            <div class="buttons">
              {#if view.head.phase === "orders"}
                <button
                  class="primary"
                  disabled={blocked}
                  onclick={() => control("turn.close")}>Close and resolve</button
                >
              {:else if view.head.phase === "resolution"}
                <p>Resolving frozen orders…</p>
              {:else if view.head.phase === "paused"}
                <p>Resolution paused. The frozen orders are unchanged.</p>
                <button disabled={blocked} onclick={() => control("turn.retry")}
                  >Retry frozen turn</button
                >
              {:else}
                <label class="grow-field"
                  >Next order window (seconds) <input
                    type="number"
                    min="1"
                    max="86400"
                    placeholder="Manual close"
                    bind:value={GMduration}
                  /></label
                >
                <button
                  class="primary"
                  disabled={blocked ||
                    (GMduration !== undefined &&
                      (GMduration < 1 || GMduration > 86400))}
                  onclick={() => control("turn.next")}>Open next turn</button
                >
              {/if}
              {#if view.members}
                <button
                  type="button"
                  data-roster-toggle
                  onclick={() => (rosterOpen = !rosterOpen)}
                >{rosterOpen
                    ? "Hide commanders"
                    : `Commanders (${view.members.length})`}</button
                >
              {/if}
            </div>
            <details>
              <summary>Membership (revoke by seat ID)</summary>
              <label
                >Commander slot <input
                  maxlength="64"
                  bind:value={revokeSlot}
                /></label
              >
              <button
                disabled={blocked || !isId(revokeSlot)}
                onclick={() => {
                  if (
                    isId(revokeSlot) &&
                    confirm(`Revoke access for ${revokeSlot}?`)
                  ) {
                    client?.submit({
                      kind: "member.revoke",
                      requestId: crypto.randomUUID(),
                      memberId: revokeSlot,
                    });
                    revokeSlot = "";
                  }
                }}>Revoke commander</button
              >
            </details>

            <details open data-gm-scene-controls>
              <summary>Scene controls (doors, darkness, lights, templates)</summary>
              <label>
                Darkness ({Math.round((view.darkness ?? 0) * 100)}%)
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  data-gm-darkness
                  value={view.darkness ?? 0}
                  disabled={state.busy}
                  onchange={(e) => {
                    const darkness = Number((e.currentTarget as HTMLInputElement).value);
                    client?.submit({
                      kind: "scene.light",
                      requestId: crypto.randomUUID(),
                      darkness,
                    });
                  }}
                />
              </label>
              {#if view.lights?.length}
                <div class="vtt-sublist">
                  {#each view.lights as light (light.id)}
                    <div class="vtt-row" data-gm-light={light.id}>
                      <span>Light {light.id} ({light.bright}/{light.dim} ft)</span>
                      <button
                        type="button"
                        class="tiny"
                        disabled={state.busy}
                        onclick={() =>
                          client?.submit({
                            kind: "scene.light",
                            requestId: crypto.randomUUID(),
                            lightId: light.id,
                            hidden: !light.hidden,
                          })}
                      >{light.hidden ? "Enable" : "Extinguish"}</button>
                    </div>
                  {/each}
                </div>
              {/if}
              {#if doorWalls.length}
                <div class="vtt-sublist">
                  {#each doorWalls as dw (dw.id)}
                    {@const dState = (dw.id && view.doors?.[dw.id]) ?? dw.door ?? 0}
                    <div class="vtt-row" data-gm-door={dw.id}>
                      <span>Door {dw.id}: {dState === 1 ? "Open" : dState === 2 ? "Locked" : "Closed"}</span>
                      <div class="buttons">
                        <button
                          type="button"
                          class="tiny"
                          disabled={state.busy || dState === 1}
                          onclick={() =>
                            dw.id &&
                            client?.submit({
                              kind: "scene.door",
                              requestId: crypto.randomUUID(),
                              wallId: dw.id,
                              door: 1,
                            })}
                        >Open</button>
                        <button
                          type="button"
                          class="tiny"
                          disabled={state.busy || dState === 0}
                          onclick={() =>
                            dw.id &&
                            client?.submit({
                              kind: "scene.door",
                              requestId: crypto.randomUUID(),
                              wallId: dw.id,
                              door: 0,
                            })}
                        >Close</button>
                        <button
                          type="button"
                          class="tiny"
                          disabled={state.busy || dState === 2}
                          onclick={() =>
                            dw.id &&
                            client?.submit({
                              kind: "scene.door",
                              requestId: crypto.randomUUID(),
                              wallId: dw.id,
                              door: 2,
                            })}
                        >Lock</button>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
              <div class="coords">
                <label>Template
                  <select bind:value={tplShape}>
                    <option value="circle">Circle</option>
                    <option value="cone">Cone</option>
                    <option value="line">Line</option>
                    <option value="rect">Rect</option>
                  </select>
                </label>
                <label>Radius/Len <input type="number" min="5" max="400" bind:value={tplDist} /></label>
                <label>Angle° <input type="number" min="-360" max="360" bind:value={tplDir} /></label>
              </div>
              <button
                type="button"
                data-gm-place-template
                disabled={state.busy || aimX === undefined || aimY === undefined}
                onclick={() => {
                  if (aimX !== undefined && aimY !== undefined) {
                    client?.submit({
                      kind: "scene.template",
                      requestId: crypto.randomUUID(),
                      op: "put",
                      template: {
                        id: `tpl-${Date.now().toString(36)}`,
                        shape: tplShape,
                        x: aimX,
                        y: aimY,
                        distance: tplDist,
                        direction: tplDir,
                        ...(tplShape === "line" ? { width: 5 } : {}),
                        color: "#7dd3fc",
                      },
                    });
                  }
                }}
              >Place template at aim ({aimX ?? "—"}, {aimY ?? "—"})</button>
              {#if view.templates?.length}
                <div class="vtt-sublist">
                  {#each view.templates as tpl (tpl.id)}
                    <div class="vtt-row">
                      <span>{tpl.shape} ({tpl.distance} ft)</span>
                      <button
                        type="button"
                        class="tiny"
                        disabled={state.busy}
                        onclick={() =>
                          client?.submit({
                            kind: "scene.template",
                            requestId: crypto.randomUUID(),
                            op: "delete",
                            templateId: tpl.id,
                          })}
                      >Remove</button>
                    </div>
                  {/each}
                </div>
              {/if}
            </details>

            <details open data-gm-autonomy>
              <summary>Autonomous AI &amp; spatial combat</summary>
              <label>
                <input
                  type="checkbox"
                  data-gm-spatial-combat
                  checked={view.autonomy?.spatialCombat === true}
                  disabled={state.busy}
                  onchange={(e) =>
                    client?.submit({
                      kind: "autonomy.configure",
                      requestId: crypto.randomUUID(),
                      spatialCombat: (e.currentTarget as HTMLInputElement).checked,
                    })}
                />
                Per-model spatial melee/ranged (5-ft step, stride + AoO, volley cover)
              </label>
              <label>
                <input
                  type="checkbox"
                  data-gm-autonomy-global
                  checked={view.autonomy?.global === true}
                  disabled={state.busy}
                  onchange={(e) =>
                    client?.submit({
                      kind: "autonomy.configure",
                      requestId: crypto.randomUUID(),
                      global: (e.currentTarget as HTMLInputElement).checked,
                    })}
                />
                Global autonomous AI (unordered units advance &amp; engage)
              </label>
              <div class="vtt-sublist">
                {#each view.factions as fac (fac.id)}
                  {@const fVal = view.autonomy?.factions?.[fac.id]}
                  <div class="vtt-row" data-gm-autonomy-faction={fac.id}>
                    <span style:color={fac.color}>■ {fac.name}</span>
                    <select
                      aria-label="{fac.name} autonomy"
                      disabled={state.busy}
                      value={fVal === true ? "on" : fVal === false ? "off" : "inherit"}
                      onchange={(e) => {
                        const raw = (e.currentTarget as HTMLSelectElement).value;
                        client?.submit({
                          kind: "autonomy.configure",
                          requestId: crypto.randomUUID(),
                          factions: {
                            [fac.id]: raw === "on" ? true : raw === "off" ? false : null,
                          },
                        });
                      }}
                    >
                      <option value="inherit">Inherit global</option>
                      <option value="on">Autonomous ON</option>
                      <option value="off">Manual only</option>
                    </select>
                  </div>
                {/each}
              </div>
              {#if selected && view.markers.some((m) => m.id === selected)}
                {@const selMarker = view.markers.find((m) => m.id === selected)}
                {@const uVal = view.autonomy?.units?.[selected] ?? "inherit"}
                {#if selMarker}
                  <div class="vtt-row" data-gm-autonomy-unit={selected}>
                    <span>Unit: {selMarker.name}</span>
                    <select
                      aria-label="{selMarker.name} autonomy"
                      disabled={state.busy}
                      value={uVal}
                      onchange={(e) => {
                        const raw = (e.currentTarget as HTMLSelectElement).value;
                        client?.submit({
                          kind: "autonomy.configure",
                          requestId: crypto.randomUUID(),
                          units: {
                            [selected]:
                              raw === "advance" || raw === "hold" || raw === "off"
                                ? raw
                                : null,
                          },
                        });
                      }}
                    >
                      <option value="inherit">Inherit faction/global</option>
                      <option value="advance">Auto-advance &amp; engage</option>
                      <option value="hold">Hold position</option>
                      <option value="off">Manual only</option>
                    </select>
                  </div>
                {/if}
              {/if}
            </details>
          {:else}
            {#if view.own.length > 0}
              <div class="unit-cards" aria-label="Your command companies">
                {#each view.own as u (u.id)}
                  {@const uOrder = draft.has(u.id) ? draft.get(u.id) : accepted.get(u.id)}
                  <button
                    type="button"
                    class="unit-card"
                    class:selected={selected === u.id}
                    class:drafted={draft.has(u.id)}
                    data-own-unit-card={u.id}
                    onclick={() => (selected = u.id)}
                  >
                    {#if u.badgeUrl}
                      <img class="unit-emblem" src={u.badgeUrl} alt="" />
                    {/if}
                    <span class="unit-card-body">
                      <span class="unit-card-top">
                        <strong>{u.name}</strong>
                        <span class="unit-weapon">{u.weapon === "shot" ? "Ranged" : "Melee"} · {u.alive}</span>
                      </span>
                      <span class="unit-card-order">
                        {draft.has(u.id)
                          ? `Draft · ${label(uOrder)}`
                          : accepted.has(u.id)
                            ? `Sent · ${label(uOrder)}`
                            : "Standing order"}
                      </span>
                    </span>
                  </button>
                {/each}
              </div>
              {#if view.own.length > 1}
                <div class="brigade-bar">
                  <span class="eyebrow">BRIGADE ({view.own.length})</span>
                  <button type="button" class="tiny" disabled={!allowed} onclick={() => draftBrigadeStance("hold")}>All hold</button>
                  <button type="button" class="tiny" disabled={!allowed} onclick={() => draftBrigadeStance("defend")}>All brace</button>
                  <button
                    type="button"
                    class="tiny"
                    data-brigade-march
                    disabled={!allowed || aimX === undefined || aimY === undefined}
                    onclick={draftBrigadeMarch}
                  >Line march → aim</button>
                </div>
              {/if}
            {/if}

            <label
              >Assigned unit <select bind:value={selected} disabled={!allowed}>
                {#each view.own as u (u.id)}<option value={u.id}
                    >{u.name} · {u.alive} alive</option
                  >{/each}
              </select></label
            >
            {#if unit?.statsSummary || unit?.conditions?.length || unit?.elevation}
              <div class="stat-strip" data-unit-statblock>
                {#if unit.statsSummary}
                  <span>AC {unit.statsSummary.ac}</span>
                  <span>BAB +{unit.statsSummary.bab}</span>
                  <span>{unit.statsSummary.hp} HP/soldier</span>
                  <span>Vision: {unit.statsSummary.vision}</span>
                {/if}
                {#if unit.elevation}
                  <span class="cond-tag elev">+{unit.elevation} ft elev</span>
                {/if}
                {#if unit.modelStatsSummary}
                  <span data-unit-model-stats>⚔ {unit.modelStatsSummary.kills} kills · {unit.modelStatsSummary.damageDealt} dmg{#if unit.modelStatsSummary.topVeteran} (Ace #{unit.modelStatsSummary.topVeteran.slot}: {unit.modelStatsSummary.topVeteran.kills}K/{unit.modelStatsSummary.topVeteran.damageDealt}D){/if}</span>
                {/if}
                {#each unit.conditions ?? [] as cond (cond)}
                  <span class="cond-tag">{cond}</span>
                {/each}
              </div>
            {/if}
            {#if doorWalls.length}
              <div class="vtt-sublist">
                {#each doorWalls as dw (dw.id)}
                  {@const dState = (dw.id && view.doors?.[dw.id]) ?? dw.door ?? 0}
                  <div class="vtt-row" data-player-door={dw.id}>
                    <span>Door {dw.id}: {dState === 1 ? "Open" : dState === 2 ? "Locked" : "Closed"}</span>
                    <button
                      type="button"
                      class="tiny"
                      disabled={state.busy || dState === 2}
                      onclick={() =>
                        dw.id &&
                        client?.submit({
                          kind: "scene.door",
                          requestId: crypto.randomUUID(),
                          wallId: dw.id,
                          door: dState === 1 ? 0 : 1,
                        })}
                    >{dState === 2 ? "Locked" : dState === 1 ? "Close door" : "Open door"}</button>
                  </div>
                {/each}
              </div>
            {/if}
            <div class="buttons">
              <button
                disabled={!allowed || !unit?.alive}
                onclick={() => add({ kind: "hold", stance: "hold" })}
                >Draft hold</button
              >
              <button
                data-order-defend
                disabled={!allowed || !unit?.alive}
                onclick={() => add({ kind: "hold", stance: "defend" })}
                >Draft brace (+2 AC)</button
              >
              <button
                data-order-reform
                disabled={!allowed || !unit?.alive}
                onclick={() => add({ kind: "reform" })}
                >Draft reform front</button
              >
              <button disabled={!allowed} onclick={() => add(null)}
                >Clear order</button
              >
            </div>
            <div class="coords">
              <label
                >March X <input
                  type="number"
                  step="any"
                  bind:value={aimX}
                  oninput={() => (aimFromMap = false)}
                /></label
              ><label
                >March Y <input
                  type="number"
                  step="any"
                  bind:value={aimY}
                  oninput={() => (aimFromMap = false)}
                /></label
              >
            </div>
            <label class="inline-check">
              <input
                type="checkbox"
                data-order-march-reform
                disabled={!allowed}
                bind:checked={reformMarch}
              />
              Reform front while marching (half speed)
            </label>
            <div class="buttons">
              <button
                disabled={!allowed ||
                  !unit?.alive ||
                  aimX === undefined ||
                  aimY === undefined}
                onclick={() => {
                  if (aimX !== undefined && aimY !== undefined)
                    add({
                      kind: "move",
                      pace: "march",
                      path: [marchWaypointForUnit(unit, aimX, aimY, aimFromMap)],
                      ...(reformMarch ? { reform: true } : {}),
                    });
                }}>Draft march</button
              >
              <button
                data-order-charge
                disabled={!allowed ||
                  !unit?.alive ||
                  aimX === undefined ||
                  aimY === undefined}
                onclick={() => {
                  if (aimX !== undefined && aimY !== undefined)
                    add({
                      kind: "move",
                      pace: "charge",
                      path: [marchWaypointForUnit(unit, aimX, aimY, aimFromMap)],
                    });
                }}>Draft charge</button
              >
            </div>
            {#if unit?.spells && unit.spells.length > 0}
              <div class="vtt-box" data-spellbook>
                <label>PF1e Spellbook
                  <select data-spell-select bind:value={selectedSpellId} disabled={!allowed}>
                    {#each unit.spells as sp (sp.id)}
                      <option value={sp.id}>{sp.name} ({sp.shape}, {sp.slots} slot{sp.slots === 1 ? "" : "s"})</option>
                    {/each}
                  </select>
                </label>
                {#if chosenSpell}
                  <button
                    type="button"
                    data-draft-spell
                    disabled={!allowed ||
                      !unit.alive ||
                      chosenSpell.slots < 1 ||
                      aimX === undefined ||
                      aimY === undefined}
                    onclick={() => {
                      if (aimX === undefined || aimY === undefined || !chosenSpell) return;
                      if (chosenSpell.shape === "cone" || chosenSpell.shape === "line") {
                        const baseAt = unit.leadAt ?? unit.at ?? { x: aimX, y: aimY };
                        const dx = aimX - baseAt.x;
                        const dy = aimY - baseAt.y;
                        const len = Math.max(0.001, Math.hypot(dx, dy));
                        add({
                          kind: "cast",
                          spellId: chosenSpell.id,
                          itemId: chosenSpell.itemId,
                          origin: { x: baseAt.x, y: baseAt.y },
                          dir: {
                            x: Math.round((dx / len) * 1000) / 1000,
                            y: Math.round((dy / len) * 1000) / 1000,
                          },
                        });
                      } else {
                        add({
                          kind: "cast",
                          spellId: chosenSpell.id,
                          itemId: chosenSpell.itemId,
                          origin: { x: aimX, y: aimY },
                        });
                      }
                    }}
                  >Draft {chosenSpell.name} ({chosenSpell.slots} left)</button>
                {/if}
              </div>
            {/if}
            {#if unit?.items && unit.items.length > 0}
              <div class="vtt-box" data-unit-items>
                <label>PF1e Items &amp; Wands
                  <select data-item-select bind:value={selectedItemId} disabled={!allowed}>
                    {#each unit.items as it (it.id)}
                      <option value={it.id}>{it.name} ({it.effect}, {it.charges} chg)</option>
                    {/each}
                  </select>
                </label>
                <label>Support target
                  <select bind:value={itemTargetId} disabled={!allowed}>
                    <option value="">Self ({unit.name})</option>
                    {#each view.own as ally (ally.id)}
                      {#if ally.id !== unit.id}
                        <option value={ally.id}>{ally.name}</option>
                      {/if}
                    {/each}
                  </select>
                </label>
                {#if chosenItem}
                  <button
                    type="button"
                    data-draft-item
                    disabled={!allowed || !unit.alive || chosenItem.charges < 1}
                    onclick={() =>
                      add({
                        kind: "useItem",
                        itemId: chosenItem.id,
                        ...(itemTargetId ? { targetUnitId: itemTargetId } : {}),
                      })}
                  >Draft {chosenItem.name} ({chosenItem.charges} left)</button>
                {/if}
              </div>
            {/if}
            <details class="vtt-box" data-ready-box>
              <summary>Readied reaction</summary>
              <div class="coords">
                <label>Trigger
                  <select data-ready-trigger bind:value={readyTrigger} disabled={!allowed}>
                    <option value="enemyEntersReach">Enemy enters reach</option>
                    <option value="enemyCasts">Enemy casts spell</option>
                    <option value="allyAttacked">Ally attacked</option>
                  </select>
                </label>
                <label>Response
                  <select data-ready-response bind:value={readyResponse} disabled={!allowed}>
                    <option value="melee">Melee strike</option>
                    {#if unit?.weapon === "shot"}<option value="shot">Ranged volley</option>{/if}
                    <option value="countermarch">Countermarch</option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                data-draft-ready
                disabled={!allowed || !unit?.alive}
                onclick={() =>
                  add({
                    kind: "ready",
                    trigger: readyTrigger,
                    response: readyResponse,
                    ...(target && enemies.some((e) => e.id === target)
                      ? { targetUnitId: target }
                      : {}),
                  })}
              >Draft readied reaction</button>
            </details>
            <label
              >Visible enemy <select bind:value={target} disabled={!allowed}
                ><option value="">Choose target</option>
                {#each enemies as enemy (enemy.id)}<option value={enemy.id}
                    >{enemy.name}</option
                  >{/each}
              </select></label
            >
            {#if unit?.weapon !== "shot"}
              <label class="inline-check">
                <input
                  type="checkbox"
                  data-order-envelop
                  disabled={!allowed}
                  bind:checked={envelopAttack}
                />
                Envelop flanks &amp; rear on contact
              </label>
            {/if}
            <button
              disabled={!allowed ||
                !unit?.alive ||
                !enemies.some((u) => u.id === target)}
              onclick={() => {
                if (unit)
                  add({
                    kind: "attack",
                    targetUnitId: target,
                    mode: unit.weapon,
                    ...(unit.weapon === "melee" && envelopAttack
                      ? { envelop: true }
                      : {}),
                  });
              }}
              >Draft {unit?.weapon === "shot" ? "ranged" : "melee"} attack</button
            >
            <div class="drafts">
              {#each view.own as u (u.id)}
                {#if draft.has(u.id) || accepted.has(u.id)}
                  <div>
                    <strong>{u.name}</strong><span
                      >{draft.has(u.id)
                        ? `Draft: ${label(draft.get(u.id))}`
                        : `Accepted: ${label(accepted.get(u.id))}`}</span
                    >
                  </div>
                {/if}
              {/each}
            </div>
            <div class="buttons">
              <button
                class="primary"
                disabled={!allowed || draft.size === 0}
                onclick={sendOrders}>Submit orders</button
              >
              <button
                disabled={!allowed || !draft.size}
                onclick={() => {
                  draft.clear();
                }}>Discard draft</button
              >
            </div>
            <p class="small">
              Accepted revision <strong data-revision
                >{view.orders.revision}</strong
              >
            </p>
          {/if}
          {#if view.content?.macros?.length}
            <div class="vtt-box" data-macro-bar>
              <div class="eyebrow">VETTED MACROS</div>
              <div class="buttons">
                {#each view.content.macros as macro (macro.id)}
                  <button
                    type="button"
                    class="tiny"
                    data-macro-btn={macro.id}
                    data-macro-disabled={!macro.executable ? "true" : undefined}
                    disabled={state.busy || !macro.executable}
                    title={macro.disabledReason ?? macro.name}
                    onclick={() => {
                      if (selected) draft.delete(selected);
                      client?.submit({
                        kind: "macro.exec",
                        requestId: crypto.randomUUID(),
                        macroId: macro.id,
                        ...(selected ? { unitId: selected } : {}),
                      });
                    }}
                  >
                    {macro.name}{#if !macro.executable} (Script disabled){/if}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
          {#if state.receipt}<p
              class="small"
              role="status"
              class:warning={state.receipt.status === "rejected"}
            >
              {state.receipt.status === "accepted"
                ? `Accepted for turn ${state.receipt.turnId}`
                : `${state.receipt.code}: ${state.receipt.detail}`}
            </p>{/if}
          {#if state.receipt?.status === "rejected" && ["busy", "unavailable"].includes(state.receipt.code)}
            <button onclick={() => client?.retry()}>Retry same request</button>
          {/if}
        </section>

        <section class="panel" aria-label="Battle log">
          <div class="eyebrow">BATTLE LOG</div>
          <h2>Chat and actions</h2>
          {#if recentChat.length}
            <div class="chat-feed" data-chat-entries>
              {#each recentChat as msg (msg.id)}
                <div class="chat-entry" data-chat-scope-badge={msg.scope}>
                  <div class="chat-meta">
                    <strong>{msg.senderName}</strong>
                    <span class="chat-scope">[{msg.scope}]</span>
                  </div>
                  <div class="chat-body">{msg.text}</div>
                  {#if msg.roll}
                    <div class="chat-roll" data-roll-provenance={msg.roll.provenance}>
                      🎲 {msg.roll.formula}: <strong>{msg.roll.total}</strong> ({msg.roll.breakdown}) · {msg.roll.provenance}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
          {#if recentLogActions.length}
            <div class="battle-log">
              {#each recentLogActions as action (action.id)}
                <ActionCardView
                  {action}
                  currentTurn={view.head.turnId}
                  isGM={view.role === "GM"}
                  canRoll={() => false}
                  onRoll={() => {}}
                />
              {/each}
            </div>
            {#if (view.actions?.length ?? 0) > recentLogActions.length}<p class="small">Showing the latest {recentLogActions.length} of {view.actions?.length} retained log entries.</p>{/if}
          {:else if !recentChat.length}<p class="small">No published chat or action entries yet.</p>{/if}
          <form
            class="chat-form"
            data-chat-form
            onsubmit={(e) => {
              e.preventDefault();
              const trimmed = chatText.trim();
              const formula = chatRoll.trim();
              if ((!trimmed && !formula) || state.busy) return;
              client?.submit({
                kind: "chat.send",
                requestId: crypto.randomUUID(),
                scope: chatScope,
                text: trimmed || `Rolls ${formula}`,
                ...(formula ? { rollFormula: formula } : {}),
              });
              chatText = "";
              chatRoll = "";
            }}
          >
            <div class="coords">
              <label>Channel
                <select data-chat-scope bind:value={chatScope}>
                  <option value="public">Public</option>
                  {#if view.factionId}<option value="faction">Faction</option>{/if}
                  {#if view.role === "GM"}<option value="gm">GM Note</option>{/if}
                </select>
              </label>
              <label>Dice (NdS+M)
                <input
                  data-chat-roll
                  maxlength="24"
                  placeholder="e.g. 1d20+6"
                  bind:value={chatRoll}
                />
              </label>
            </div>
            <div class="coords">
              <label class="grow-field">Message
                <input
                  data-chat-input
                  maxlength="400"
                  placeholder="Send dispatch or roll…"
                  bind:value={chatText}
                />
              </label>
              <button type="submit" disabled={state.busy || (!chatText.trim() && !chatRoll.trim())}>Send</button>
            </div>
          </form>
        </section>

        {#if view.content?.journals?.length || view.content?.rollTables?.length || view.content?.playlists?.length}
          <section class="panel" data-campaign-content aria-label="Campaign content">
            <div class="eyebrow">CAMPAIGN CONTENT</div>
            <h2>Journals, tables &amp; audio</h2>
            {#if view.content?.journals?.length}
              <label>Briefings &amp; journals
                <select data-journal-select bind:value={selectedJournalId}>
                  {#each view.content.journals as j (j.id)}
                    <option value={j.id}>{j.name} ({j.visibility})</option>
                  {/each}
                </select>
              </label>
              {@const activeJournal =
                view.content.journals.find((j) => j.id === selectedJournalId) ??
                view.content.journals[0]}
              {#if activeJournal}
                <div class="journal-card" data-journal-content={activeJournal.id}>
                  <strong>{activeJournal.name}</strong>
                  <p class="small">{activeJournal.markdown}</p>
                </div>
              {/if}
            {/if}
            {#if view.content?.rollTables?.length}
              <div class="vtt-sublist" data-roll-tables>
                {#each view.content.rollTables as tbl (tbl.id)}
                  <div class="vtt-row" data-roll-table={tbl.id}>
                    <span>{tbl.name} ({tbl.formula})</span>
                    <button
                      type="button"
                      class="tiny"
                      disabled={state.busy}
                      onclick={() =>
                        client?.submit({
                          kind: "table.roll",
                          requestId: crypto.randomUUID(),
                          tableId: tbl.id,
                        })}
                    >Roll table</button>
                  </div>
                {/each}
              </div>
            {/if}
            {#if view.content?.playlists?.length}
              <div class="vtt-sublist" data-playlists>
                {#each view.content.playlists as pl (pl.id)}
                  {#each pl.tracks as tr (tr.id)}
                    {@const isPlaying = view.content.activeTrackId === tr.id}
                    <div class="vtt-row" data-playlist-track={tr.id}>
                      <span>🎵 {pl.name}: {tr.name}{#if isPlaying} · <strong>Playing</strong>{/if}</span>
                      {#if view.role === "GM"}
                        <button
                          type="button"
                          class="tiny"
                          disabled={state.busy}
                          onclick={() =>
                            client?.submit({
                              kind: "scene.playlist",
                              requestId: crypto.randomUUID(),
                              trackId: isPlaying ? null : tr.id,
                            })}
                        >{isPlaying ? "Stop" : "Play"}</button>
                      {/if}
                    </div>
                  {/each}
                {/each}
              </div>
            {/if}
          </section>
        {/if}

        <section class="panel">
          <div class="eyebrow">AFTER ACTION</div>
          <h2>Turn reports</h2>
          {#if view.head.version > 0}
            <label
              >Published turn <input
                type="number"
                min="1"
                max={view.head.version}
                placeholder={String(view.head.version)}
                bind:value={reportTurn}
              /></label
            >
            <button
              onclick={() => {
                if (view) void resultPage(reportTurn ?? view.head.version, 0);
              }}>View report</button
            >
          {:else}<p class="small">No turn has been published yet.</p>{/if}
          {#if reportNotice}<p role="status">{reportNotice}</p>{/if}
          {#if report}
            <p class="small">Turn {report.version} · page {report.page + 1}</p>
            <table>
              <thead><tr><th>Unit</th><th>Alive</th><th>Lost</th></tr></thead
              ><tbody>
                {#each report.rows as row (row.unitId)}<tr
                    data-report-unit={row.unitId}
                    ><td
                      >{row.name}{#if row.marchBlocked}
                        · March blocked{/if}</td
                    ><td>{row.alive} / {row.before}</td><td>{row.lost}</td></tr
                  >{/each}
              </tbody>
            </table>
            <div class="buttons">
              <button
                disabled={report.page === 0}
                onclick={() => {
                  if (report) void resultPage(report.version, report.page - 1);
                }}>Previous</button
              >
              <button
                disabled={!report.hasMore}
                onclick={() => {
                  if (report) void resultPage(report.version, report.page + 1);
                }}>Next page</button
              >
            </div>
          {/if}
        </section>
      </div>
    </div>
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    background: #141917;
    color: #f1efe7;
    font:
      14.5px/1.42 system-ui,
      sans-serif;
  }
  main {
    --border: #3b4841;
    --muted: #b5beb3;
    --accent: #efd398;
    max-width: 1680px;
    padding: 0.7rem clamp(0.65rem, 1.8vw, 1.5rem);
    margin: auto;
  }
  .topbar,
  .brand,
  .phasebar,
  .panel-head,
  .map-badges {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.65rem;
    flex-wrap: wrap;
  }
  .topbar {
    padding-bottom: 0.6rem;
    margin-bottom: 0.7rem;
    border-bottom: 1px solid var(--border);
  }
  .brand {
    justify-content: flex-start;
  }
  .seal {
    color: var(--accent);
    border: 1px solid #8d7951;
    border-radius: 0.5rem;
    padding: 0.15rem 0.45rem;
    font-size: 1.3rem;
  }
  .eyebrow {
    color: var(--accent);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.16em;
  }
  h1,
  h2 {
    font-family: Georgia, serif;
    font-weight: 500;
    line-height: 1.18;
    margin: 0.1rem 0 0.25rem;
  }
  h1 {
    font-size: clamp(1.15rem, 2vw, 1.55rem);
  }
  h2 {
    font-size: 1.25rem;
  }
  .phasebar {
    justify-content: flex-end;
    flex: 1;
  }
  .phase {
    text-transform: capitalize;
  }
  .role-badge {
    background: #202925;
    border: 1px solid var(--border);
    border-radius: 2rem;
    padding: 0.22rem 0.65rem;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .pill {
    color: var(--muted);
    background: #262f29;
    border: 1px solid var(--border);
    border-radius: 2rem;
    padding: 0.22rem 0.6rem;
    font-size: 0.76rem;
  }
  .connection {
    min-height: 1.5rem;
    display: inline-flex;
    align-items: center;
    color: var(--muted);
    font-size: 0.82rem;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(19rem, 23.5rem);
    gap: 0.85rem;
    align-items: start;
  }
  .roster-drawer {
    grid-column: 1 / -1;
  }
  .panel,
  .entry {
    background: #1c2520;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 0.85rem;
    min-width: 0;
  }
  .entry {
    max-width: 33rem;
    margin: clamp(1.5rem, 8vh, 6rem) auto;
    padding: 1.5rem;
  }
  .sidebar {
    display: grid;
    gap: 0.8rem;
  }
  .panel-head {
    margin-bottom: 0.45rem;
  }
  .map-canvas-wrap {
    position: relative;
  }
  .token-zoom-opt {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
    user-select: none;
  }
  .token-zoom-opt input {
    margin: 0;
  }
  .unit-cards {
    display: grid;
    gap: 0.35rem;
    margin: 0.45rem 0;
  }
  .unit-card {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.55rem;
    background: #141c18;
    border: 1px solid #2e3b34;
    border-radius: 0.45rem;
  }
  .unit-card.selected {
    border-color: var(--accent);
    background: #242e25;
  }
  .unit-card.drafted {
    box-shadow: inset 3px 0 0 #67d4ff;
  }
  .unit-emblem {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
    border: 1px solid #efd39888;
    flex-shrink: 0;
  }
  .unit-card-body {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
  }
  .unit-card-top {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: 0.82rem;
  }
  .unit-weapon {
    color: var(--muted);
    font-size: 0.74rem;
  }
  .unit-card-order {
    color: #b9c9be;
    font-size: 0.73rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .brigade-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
    padding: 0.35rem 0.45rem;
    border-radius: 0.4rem;
    background: #141b18;
    border: 1px solid #2d3a33;
    margin-bottom: 0.4rem;
  }
  .brigade-bar .tiny {
    padding: 0.22rem 0.5rem;
    font-size: 0.76rem;
  }
  .coords,
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.4rem 0;
  }
  .coords label,
  .grow-field {
    flex: 1;
    min-width: 5rem;
    margin: 0;
  }
  label {
    display: block;
    margin: 0.5rem 0;
    color: var(--muted);
    font-size: 0.8rem;
  }
  label.inline-check {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0.3rem 0;
  }
  input:not([type="checkbox"]),
  select {
    display: block;
    width: 100%;
    margin-top: 0.18rem;
  }
  input[type="checkbox"] {
    width: auto;
    margin: 0;
    padding: 0;
  }
  :global(button),
  input,
  select {
    color: inherit;
    background: #131a17;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    padding: 0.4rem 0.58rem;
    font: inherit;
  }
  :global(button) {
    cursor: pointer;
  }
  :global(button:hover:not(:disabled)) {
    border-color: var(--accent);
  }
  :global(button:disabled) {
    opacity: 0.45;
    cursor: default;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #282218;
    font-weight: 700;
  }
  .small,
  p {
    color: var(--muted);
  }
  .small {
    font-size: 0.78rem;
    margin: 0.25rem 0 0.1rem;
  }
  .warning {
    color: #ffba9b;
  }
  .drafts {
    display: grid;
    gap: 0.2rem;
    margin: 0.45rem 0;
    font-size: 0.78rem;
  }
  .drafts div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  details {
    margin: 0.5rem 0;
    color: var(--muted);
  }
  .battle-log {
    display: grid;
    gap: 0.55rem;
    max-height: 22rem;
    overflow: auto;
  }
  .stat-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    padding: 0.35rem 0.45rem;
    background: #141c18;
    border: 1px solid #2d3a33;
    border-radius: 0.4rem;
    font-size: 0.74rem;
    color: #dbe4dc;
  }
  .cond-tag {
    padding: 0.08rem 0.42rem;
    border-radius: 1rem;
    background: #4e2d2d;
    border: 1px solid #a86464;
    color: #ffd7d7;
    font-weight: 600;
  }
  .cond-tag.elev {
    background: #38331e;
    border-color: #bca35b;
    color: #f9e8b2;
  }
  .vtt-box,
  .journal-card {
    margin: 0.4rem 0;
    padding: 0.45rem 0.55rem;
    background: #141b18;
    border: 1px solid #2d3a33;
    border-radius: 0.45rem;
  }
  .vtt-sublist {
    display: grid;
    gap: 0.28rem;
    margin: 0.35rem 0;
  }
  .vtt-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    font-size: 0.76rem;
  }
  .tiny {
    padding: 0.22rem 0.5rem;
    font-size: 0.75rem;
  }
  .chat-feed {
    display: grid;
    gap: 0.35rem;
    max-height: 14rem;
    overflow: auto;
    margin-bottom: 0.5rem;
  }
  .chat-entry {
    padding: 0.35rem 0.5rem;
    background: #141b18;
    border: 1px solid #2b3831;
    border-radius: 0.4rem;
    font-size: 0.78rem;
  }
  .chat-meta {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .chat-roll {
    margin-top: 0.18rem;
    color: var(--accent);
    font-size: 0.74rem;
  }
  .chat-form {
    margin-top: 0.5rem;
    padding-top: 0.45rem;
    border-top: 1px solid var(--border);
  }
  table {
    width: 100%;
    font-size: 0.79rem;
    text-align: left;
    border-collapse: collapse;
  }
  th,
  td {
    border-bottom: 1px solid var(--border);
    padding: 0.24rem 0.15rem;
  }
  @media (max-width: 860px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .phasebar {
      justify-content: flex-start;
    }
  }
</style>
