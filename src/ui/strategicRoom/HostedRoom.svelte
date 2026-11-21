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
    type Command,
    type ReportPage,
    type RoomOrder,
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
  let report = $state.raw<ReportPage | null>(null);
  let reportNotice = $state("");
  let GMduration = $state<number | undefined>();
  let revokeSlot = $state("");
  let rosterOpen = $state(false);
  let region = $state<{ x: number; y: number } | null>(null);
  let turn = 0;
  let handled = "";
  let reportTicket = 0;
  const view = $derived(state.view);
  const preloadedMedia = new SvelteSet<string>();
  // Service-hosted battle art is immutable and content-addressed. A GM view may advertise it;
  // make the browser actually fetch/cache those bytes instead of leaving `media` inert.
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
  // Heads and private orders can change without replacing the authorized marker list.
  const enemies = $derived(
    markers?.filter((u) => u.factionId !== factionId) ?? [],
  );
  const ownById = $derived(new Map(view?.own.map((u) => [u.id, u])));
  const accepted = $derived(
    new Map(view?.orders.edits.map((e) => [e.unitId, e.order])),
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
  const entangle = $derived(unit?.spells?.find((spell) => spell.id === "entangle"));
  const recentLogActions = $derived((view?.actions ?? []).slice(-10).reverse());
  /** GM unit list per commander, with any order accepted this turn, for the roster. */
  const gmUnits = $derived.by(() => {
    const byId = new Map(
      (view?.markers ?? []).map((marker) => [marker.id, marker.name]),
    );
    const edges = new SvelteMap<
      string,
      { id: string; name: string; factionId: string; order: RoomOrder | null }[]
    >();
    for (const member of view?.members ?? []) {
      // Enumerate the deployment, not the grant: an unchecked unit must stay re-grantable.
      edges.set(
        member.id,
        member.deployed.map((id) => ({
          id,
          name: byId.get(id) ?? id,
          factionId: view?.markers.find((marker) => marker.id === id)?.factionId ?? member.factionId ?? "",
          order: accepted.get(id) ?? null,
        })),
      );
    }
    return edges;
  });
  const label = (order: RoomOrder | null | undefined) =>
    order === null
      ? "Clear"
      : order?.kind === "cast"
        ? `cast Entangle → (${order.origin.x}, ${order.origin.y})`
      : order
        ? orderLabel(
            order,
            (id) =>
              view?.markers.find((u) => u.id === id)?.name ??
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
              if (next.receipt.revision !== undefined) draft.clear();
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
  function sendOrders() {
    if (!view || !allowed || !draft.size) return;
    const command: Command = {
      kind: "orders.submit",
      requestId: crypto.randomUUID(),
      turnId: view.head.turnId,
      expectedRevision: view.orders.revision,
      unitEdits: [...draft].map(([unitId, order]) => ({ unitId, order })),
    };
    client?.submit(command);
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
  <header>
    <div class="brand">
      <span class="seal" aria-hidden="true">✦</span>
      <div>
        <div class="eyebrow">ARENASTAR &nbsp;/&nbsp; STRATEGIC</div>
        <h1>{view?.name ?? "Hosted Strategic Room"}</h1>
      </div>
    </div>
    <span class="pill">Hosted pilot · PF1e simultaneous</span>
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
    <div
      class="phasebar"
      data-turn={view.head.turnId}
      data-version={view.head.version}
      data-phase={view.head.phase}
    >
      <strong>Turn {view.head.turnId}</strong><span class="pill phase"
        >{view.head.phase}</span
      >
      <span
        >{view.role === "GM"
          ? "Game Master"
          : `${view.factions.find((f) => f.id === view?.factionId)?.name ?? ""} commander`}</span
      >
      {#if view.head.deadlineMs}<span
          >Closes {new Date(view.head.deadlineMs).toLocaleTimeString()}</span
        >{/if}
      <span class="connection"
        ><TurnProgress stage={state.progress} />{#if !state.progress}<span
            >{state.notice}</span
          >{/if}</span
      >
    </div>
    <div class="layout">
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
          <span class="pill">{view.markers.length} visible units</span>
        </div>
        <HostedMap
          {view}
          models={state.models}
          {selected}
          {region}
          onRegion={(r) => {
            region = r;
            client?.selectRegion(r);
          }}
          onPoint={(p) => {
            aimX = p.x;
            aimY = p.y;
          }}
        />
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
            {#if view.head.phase === "orders"}<button
                class="primary"
                disabled={blocked}
                onclick={() => control("turn.close")}>Close and resolve</button
              >
            {:else if view.head.phase === "resolution"}<p>
                Resolving frozen orders…
              </p>
            {:else if view.head.phase === "paused"}<p>
                Resolution paused. The frozen orders are unchanged.
              </p>
              <button disabled={blocked} onclick={() => control("turn.retry")}
                >Retry frozen turn</button
              >
            {:else}<label
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
              >{/if}
            {#if view.members}<button
                type="button"
                data-roster-toggle
                onclick={() => (rosterOpen = !rosterOpen)}
                >{rosterOpen
                  ? "Hide commanders"
                  : `Commanders (${view.members.length})`}</button
              >{/if}
            {#if rosterOpen && view.members}
              <HostedRoster
                members={view.members}
                units={gmUnits}
                markers={view.markers}
                factions={view.factions}
                busy={blocked}
                onCommand={(command) => client?.submit(command)}
              />
            {/if}
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
          {:else}
            <label
              >Assigned unit <select bind:value={selected} disabled={!allowed}>
                {#each view.own as u (u.id)}<option value={u.id}
                    >{u.name} · {u.alive} alive</option
                  >{/each}
              </select></label
            >
            <div class="buttons">
              <button
                disabled={!allowed || !unit?.alive}
                onclick={() => add({ kind: "hold", stance: "hold" })}
                >Draft hold</button
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
                /></label
              ><label
                >March Y <input
                  type="number"
                  step="any"
                  bind:value={aimY}
                /></label
              >
            </div>
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
                    path: [{ x: aimX, y: aimY }],
                  });
              }}>Draft march</button
            >
            {#if entangle}
              <button
                disabled={!allowed || !unit.alive || entangle.slots < 1 ||
                  aimX === undefined || aimY === undefined}
                onclick={() => {
                  if (aimX !== undefined && aimY !== undefined)
                    add({ kind: "cast", spellId: "entangle", itemId: entangle.itemId,
                      origin: { x: aimX, y: aimY } });
                }}
                >Draft Entangle ({entangle.slots} slot{entangle.slots === 1 ? "" : "s"})</button
              >
            {/if}
            <label
              >Visible enemy <select bind:value={target} disabled={!allowed}
                ><option value="">Choose target</option>
                {#each enemies as enemy (enemy.id)}<option value={enemy.id}
                    >{enemy.name}</option
                  >{/each}
              </select></label
            >
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
          {:else}<p>No published chat or action entries yet.</p>{/if}
        </section>
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
          {:else}<p>No turn has been published yet.</p>{/if}
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
      15px/1.45 system-ui,
      sans-serif;
  }
  main {
    --border: #3b4841;
    --muted: #b5beb3;
    --accent: #efd398;
    max-width: 1536px;
    padding: 1.4rem clamp(0.8rem, 2.8vw, 2.8rem);
    margin: auto;
  }
  header,
  .brand,
  .phasebar,
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
    flex-wrap: wrap;
  }
  header {
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .brand {
    justify-content: flex-start;
  }
  .seal {
    color: var(--accent);
    border: 1px solid #8d7951;
    border-radius: 0.6rem;
    padding: 0.23rem 0.55rem;
    font-size: 1.7rem;
  }
  .eyebrow {
    color: var(--accent);
    font-size: 0.69rem;
    font-weight: 700;
    letter-spacing: 0.18em;
  }
  h1,
  h2 {
    font-family: Georgia, serif;
    font-weight: 500;
    line-height: 1.2;
    margin: 0.17rem 0 0.4rem;
  }
  h1 {
    font-size: clamp(1.5rem, 3vw, 2.25rem);
  }
  h2 {
    font-size: 1.55rem;
  }
  .phasebar {
    justify-content: flex-start;
    margin: 1rem 0;
  }
  .phase {
    text-transform: capitalize;
  }
  .pill {
    color: var(--muted);
    background: #262f29;
    border: 1px solid var(--border);
    border-radius: 2rem;
    padding: 0.27rem 0.65rem;
    font-size: 0.78rem;
  }
  .connection {
    margin-left: auto;
    min-height: 1.7rem;
    display: inline-flex;
    align-items: center;
    color: var(--muted);
    font-size: 0.86rem;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(17rem, 23rem);
    gap: 1rem;
    align-items: start;
  }
  .panel,
  .entry {
    background: #1c2520;
    border: 1px solid var(--border);
    border-radius: 0.85rem;
    padding: 1rem;
    min-width: 0;
  }
  .entry {
    max-width: 33rem;
    margin: clamp(1.5rem, 8vh, 6rem) auto;
    padding: 1.5rem;
  }
  .sidebar {
    display: grid;
    gap: 1rem;
  }
  .panel-head {
    margin-bottom: 0.65rem;
  }
  .coords,
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin: 0.45rem 0;
  }
  .coords label {
    flex: 1;
    min-width: 5rem;
    margin: 0;
  }
  label {
    display: block;
    margin: 0.64rem 0;
    color: var(--muted);
    font-size: 0.81rem;
  }
  input,
  select {
    display: block;
    width: 100%;
    margin-top: 0.2rem;
  }
  :global(button),
  input,
  select {
    color: inherit;
    background: #131a17;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    padding: 0.45rem 0.6rem;
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
    font-size: 0.79rem;
    margin-bottom: 0.15rem;
  }
  .warning {
    color: #ffba9b;
  }
  .drafts {
    display: grid;
    gap: 0.25rem;
    margin: 0.6rem 0;
    font-size: 0.81rem;
  }
  .drafts div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  details {
    margin: 0.65rem 0;
    color: var(--muted);
  }
  .battle-log {
    display: grid;
    gap: 0.65rem;
    max-height: 34rem;
    overflow: auto;
  }
  table {
    width: 100%;
    font-size: 0.8rem;
    text-align: left;
    border-collapse: collapse;
  }
  th,
  td {
    border-bottom: 1px solid var(--border);
    padding: 0.26rem 0.15rem;
  }
  @media (max-width: 800px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .connection {
      margin-left: 0;
    }
  }
</style>
