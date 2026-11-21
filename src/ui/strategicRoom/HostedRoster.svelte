<script lang="ts">
  /**
   * GM roster and live team / unit assignment deck for a hosted strategic battle.
   *
   * Seat IDs remain the cryptographic participant boundary. During `orders` phase,
   * the GM can reassign commander teams (`Blue` / `Red`), auto-distribute N units
   * per commander across all seats, or transfer individual battlefield units.
   */
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import {
    MAX_EDITS,
    type Command,
    type MemberRow,
    type RoomOrder,
  } from "../../core/strategicRoom/protocol";
  import { orderLabel } from "../armies/heroOrders";

  const ROSTER_PAGE_SIZE = 50;

  let {
    members,
    units,
    markers = [],
    factions,
    phase = "orders",
    busy = false,
    onCommand,
  }: {
    members: readonly MemberRow[];
    /** Unit ids and names per commander, from the GM's authorized view. */
    units: ReadonlyMap<
      string,
      readonly { id: string; name: string; factionId: string; order: RoomOrder | null }[]
    >;
    markers?: readonly { id: string; name: string; factionId?: string }[];
    factions: readonly { id: string; name: string; color: string }[];
    phase?: "orders" | "resolution" | "report" | "paused";
    busy?: boolean;
    onCommand: (command: Command) => void;
  } = $props();

  let filter = $state("");
  let page = $state(0);
  let names = $state<Record<string, string>>({});
  let confirming = $state<string | null>(null);
  let unitsPerSeat = $state(5);
  let pickerSeat = $state<string | null>(null);
  let pickerFilter = $state("");
  let pickerSelection = new SvelteSet<string>();

  function seatOrderKey(id: string): [number, string] {
    const m = /^commander-(\d+)$/.exec(id);
    return m ? [Number(m[1]), id] : [Number.MAX_SAFE_INTEGER, id];
  }

  const sortedMembers = $derived(
    [...members].sort((a, b) => {
      const [na, sa] = seatOrderKey(a.id);
      const [nb, sb] = seatOrderKey(b.id);
      return na !== nb ? na - nb : sa < sb ? -1 : sa > sb ? 1 : 0;
    }),
  );

  let online = $derived(members.filter((m) => m.online).length);
  const canAssign = $derived(!busy && phase === "orders");
  const factionById = $derived(new Map(factions.map((f) => [f.id, f])));

  const shown = $derived(
    filter.trim()
      ? sortedMembers.filter((m) => {
          const fName = m.factionId ? (factionById.get(m.factionId)?.name ?? "") : "";
          return `${m.name} ${m.id} ${m.factionId ?? ""} ${fName}`
            .toLowerCase()
            .includes(filter.trim().toLowerCase());
        })
      : sortedMembers,
  );
  const pageCount = $derived(
    shown.length > 60 ? Math.max(1, Math.ceil(shown.length / ROSTER_PAGE_SIZE)) : 1,
  );
  const clampedPage = $derived(Math.min(page, pageCount - 1));
  const pagedShown = $derived(
    pageCount > 1
      ? shown.slice(clampedPage * ROSTER_PAGE_SIZE, (clampedPage + 1) * ROSTER_PAGE_SIZE)
      : shown,
  );

  const markerNameById = $derived.by(() => {
    const map = new SvelteMap<string, string>();
    for (const marker of markers) map.set(marker.id, marker.name);
    for (const list of units.values()) {
      for (const u of list) if (!map.has(u.id)) map.set(u.id, u.name);
    }
    return map;
  });
  const unitName = (id: string) => markerNameById.get(id) ?? id;
  const filteredPickerMarkers = $derived(
    (pickerFilter.trim()
      ? markers.filter((m) =>
          `${m.name} ${m.id}`.toLowerCase().includes(pickerFilter.trim().toLowerCase()),
        )
      : markers
    ).slice(0, 200),
  );

  const ownerByUnit = $derived.by(() => {
    const map = new SvelteMap<string, string>();
    for (const m of sortedMembers) {
      for (const uid of m.units) map.set(uid, m.id);
    }
    return map;
  });

  function send(command: Omit<Command, "requestId">): void {
    onCommand({ ...command, requestId: crypto.randomUUID() } as Command);
  }
  function rename(member: MemberRow): void {
    const name = (names[member.id] ?? member.name).trim();
    if (!name || name === member.name) return;
    send({ kind: "member.update", memberId: member.id, name });
  }
  function setUnits(member: MemberRow, which: string, granted: boolean): void {
    const next = member.units.filter((unit) => unit !== which);
    if (granted) next.push(which);
    send({ kind: "member.update", memberId: member.id, units: next.sort() });
  }
  function changeSeatTeam(member: MemberRow, nextFactionId: string): void {
    if (!nextFactionId || nextFactionId === member.factionId) return;
    send({
      kind: "roster.assign",
      assignments: [{ memberId: member.id, factionId: nextFactionId }],
    });
  }
  function autoBalanceAndDistribute(): void {
    if (factions.length < 2 || sortedMembers.length < 2) return;
    const fA = factions[0];
    const fB = factions[1];
    if (!fA || !fB) return;
    const perSeat = Math.max(1, Math.min(MAX_EDITS, Math.round(unitsPerSeat)));
    const half = Math.ceil(sortedMembers.length / 2);
    const poolA = markers.filter((u) => u.factionId === fA.id).map((u) => u.id);
    const poolB = markers.filter((u) => u.factionId === fB.id).map((u) => u.id);
    const allIds = markers.map((u) => u.id);
    const used = new SvelteSet<string>();
    const takeFrom = (preferred: string[], count: number): string[] => {
      const picked: string[] = [];
      for (const uid of preferred) {
        if (picked.length >= count) break;
        if (!used.has(uid)) {
          used.add(uid);
          picked.push(uid);
        }
      }
      for (const uid of allIds) {
        if (picked.length >= count) break;
        if (!used.has(uid)) {
          used.add(uid);
          picked.push(uid);
        }
      }
      return picked;
    };
    const assignments = sortedMembers.map((m, idx) => {
      const targetFaction = idx < half ? fA.id : fB.id;
      const preferred = idx < half ? poolA : poolB;
      return {
        memberId: m.id,
        factionId: targetFaction,
        units: takeFrom(preferred, perSeat),
      };
    });
    send({ kind: "roster.assign", assignments });
  }
  function openUnitPicker(member: MemberRow): void {
    if (pickerSeat === member.id) {
      pickerSeat = null;
      return;
    }
    pickerSeat = member.id;
    pickerFilter = "";
    pickerSelection.clear();
    for (const uid of member.units) pickerSelection.add(uid);
  }
  function togglePickedUnit(uid: string): void {
    if (pickerSelection.has(uid)) pickerSelection.delete(uid);
    else if (pickerSelection.size < MAX_EDITS) pickerSelection.add(uid);
  }
  function applyPickedUnits(member: MemberRow): void {
    send({
      kind: "roster.assign",
      assignments: [
        {
          memberId: member.id,
          ...(member.factionId ? { factionId: member.factionId } : {}),
          units: [...pickerSelection],
        },
      ],
    });
    pickerSeat = null;
  }
  function invite(member: MemberRow): void {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const code = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    send({ kind: "member.invite", memberId: member.id, invite: code });
  }
</script>

<div class="roster" data-hosted-roster>
  <header class="roster-head">
    <div>
      <strong>Commanders &amp; Force Assignment</strong>
      <span class="meta" data-roster-count>{members.length} seats · {online} connected</span>
    </div>
    <div class="roster-tools">
      <label class="inline-tool">
        Units / seat
        <input
          type="number"
          min="1"
          max={MAX_EDITS}
          data-roster-units-per-seat
          disabled={!canAssign}
          bind:value={unitsPerSeat}
        />
      </label>
      <button
        type="button"
        class="assign-btn"
        data-roster-auto-assign
        disabled={!canAssign || members.length < 2 || markers.length < 2}
        onclick={autoBalanceAndDistribute}
      >
        Balance {factions[0]?.name ?? "Blue"}/{factions[1]?.name ?? "Red"} &amp; assign {unitsPerSeat} units/player
      </button>
      <label class="inline-tool">
        Find
        <input
          type="search"
          bind:value={filter}
          oninput={() => (page = 0)}
          placeholder="name, seat or side"
        />
      </label>
      {#if pageCount > 1}
        <span class="inline-tool" data-roster-pagination>
          <button type="button" data-roster-prev disabled={clampedPage <= 0} onclick={() => (page = Math.max(0, clampedPage - 1))}>Prev</button>
          <span data-roster-page>Page {clampedPage + 1}/{pageCount}</span>
          <button type="button" data-roster-next disabled={clampedPage >= pageCount - 1} onclick={() => (page = Math.min(pageCount - 1, clampedPage + 1))}>Next</button>
        </span>
      {/if}
    </div>
  </header>

  <p class="hint">
    Assign each player to {factions[0]?.name ?? "Blue"} or {factions[1]?.name ?? "Red"} and grant up to {MAX_EDITS} units per commander while orders are open. Unchecking a unit withdraws control immediately.
  </p>

  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Commander</th>
          <th>Seat</th>
          <th>Team</th>
          <th>Assigned units</th>
          <th>Invite</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each pagedShown as member (member.id)}
          {@const list = units.get(member.id) ?? []}
          {@const teamColor = member.factionId ? factionById.get(member.factionId)?.color : undefined}
          <tr
            data-member={member.id}
            data-online={member.online ? "true" : "false"}
          >
            <td>
              <div class="commander-cell">
                <span class="dot" class:online={member.online} aria-hidden="true"></span>
                <input
                  type="text"
                  maxlength="64"
                  aria-label={`Name for ${member.name}`}
                  data-member-name
                  value={names[member.id] ?? member.name}
                  oninput={(event) => {
                    names = { ...names, [member.id]: event.currentTarget.value };
                  }}
                  onchange={() => rename(member)}
                  onblur={() => rename(member)}
                />
              </div>
            </td>
            <td class="seat"><code data-member-id>{member.id}</code></td>
            <td>
              <select
                aria-label={`Team for ${member.name}`}
                data-member-team={member.id}
                value={member.factionId ?? ""}
                disabled={!canAssign}
                style:border-color={teamColor}
                onchange={(event) => changeSeatTeam(member, event.currentTarget.value)}
              >
                {#each factions as faction (faction.id)}
                  <option value={faction.id}>{faction.name}</option>
                {/each}
              </select>
            </td>
            <td class="units">
              <div class="unit-chips">
                {#each list as unit (unit.id)}
                  <label class="unit-chip" title={unitName(unit.id)}>
                    <input
                      type="checkbox"
                      data-member-unit={unit.id}
                      aria-label={`${unit.name} for ${member.name}`}
                      checked={member.units.includes(unit.id)}
                      disabled={busy}
                      onchange={(event) =>
                        setUnits(member, unit.id, event.currentTarget.checked)}
                    />
                    <span>{unit.name}</span>
                    <select
                      aria-label={`Allegiance for ${unit.name}`}
                      data-member-unit-faction={unit.id}
                      value={unit.factionId}
                      disabled={!canAssign}
                      onchange={(event) =>
                        send({
                          kind: "unit.faction",
                          unitId: unit.id,
                          factionId: event.currentTarget.value,
                        })}
                    >
                      {#each factions as faction (faction.id)}
                        <option value={faction.id}>{faction.name}</option>
                      {/each}
                    </select>
                    {#if unit.order}
                      <small class="order">{orderLabel(unit.order, (id) => unitName(id))}</small>
                    {/if}
                  </label>
                {:else}
                  <small class="muted">0 units assigned</small>
                {/each}
              </div>
              {#if markers.length > 0}
                <button
                  type="button"
                  class="tiny-btn"
                  data-member-pick-units={member.id}
                  disabled={!canAssign}
                  onclick={() => openUnitPicker(member)}
                >
                  {pickerSeat === member.id ? "Close unit picker" : `Reassign units (${member.units.length}/${MAX_EDITS})…`}
                </button>
                {#if pickerSeat === member.id}
                  <div class="unit-picker" data-unit-picker={member.id}>
                    <div class="picker-head">
                      <span>Select up to {MAX_EDITS} units for {member.name} ({pickerSelection.size}/{MAX_EDITS})</span>
                      <div>
                        {#if markers.length > 40}
                          <input type="search" placeholder="Filter units…" bind:value={pickerFilter} />
                        {/if}
                        <button type="button" class="assign-btn" disabled={!canAssign} onclick={() => applyPickedUnits(member)}>Apply</button>
                        <button type="button" onclick={() => (pickerSeat = null)}>Cancel</button>
                      </div>
                    </div>
                    <div class="picker-grid">
                      {#each filteredPickerMarkers as m (m.id)}
                        {@const owner = ownerByUnit.get(m.id)}
                        <label class="picker-item" class:selected={pickerSelection.has(m.id)}>
                          <input
                            type="checkbox"
                            checked={pickerSelection.has(m.id)}
                            disabled={!pickerSelection.has(m.id) && pickerSelection.size >= MAX_EDITS}
                            onchange={() => togglePickedUnit(m.id)}
                          />
                          <span>{m.name}</span>
                          {#if owner && owner !== member.id}<small>({owner})</small>{/if}
                        </label>
                      {/each}
                    </div>
                  </div>
                {/if}
              {/if}
            </td>
            <td class="invite">
              {#if member.claimed}
                <span class="claimed-badge">✓ Claimed</span>
              {:else}
                {#if member.invite}
                  <code data-member-invite>{member.invite}</code>
                {/if}
                <button
                  type="button"
                  class="tiny-btn"
                  disabled={busy}
                  data-member-invite-new
                  onclick={() => invite(member)}
                >{member.invite ? "Reissue" : "Create invite"}</button>
              {/if}
            </td>
            <td class="actions">
              {#if member.online && confirming !== `kick:${member.id}`}
                <button
                  type="button"
                  class="tiny-btn"
                  disabled={busy}
                  data-member-kick
                  onclick={() => (confirming = `kick:${member.id}`)}
                >Kick</button>
              {/if}
              {#if confirming === `kick:${member.id}`}
                <button
                  type="button"
                  class="tiny-btn"
                  disabled={busy}
                  data-member-kick-confirm
                  onclick={() => {
                    send({ kind: "member.kick", memberId: member.id });
                    confirming = null;
                  }}
                >Confirm kick</button>
                <button type="button" class="tiny-btn" onclick={() => (confirming = null)}>Cancel</button>
              {:else if confirming === `ban:${member.id}`}
                <button
                  type="button"
                  disabled={busy}
                  class="tiny-btn danger"
                  data-member-ban-confirm
                  onclick={() => {
                    send({ kind: "member.revoke", memberId: member.id });
                    confirming = null;
                  }}
                >Confirm ban</button>
                <button type="button" class="tiny-btn" onclick={() => (confirming = null)}>Cancel</button>
              {:else}
                <button
                  type="button"
                  disabled={busy}
                  class="tiny-btn danger"
                  data-member-ban
                  onclick={() => (confirming = `ban:${member.id}`)}
                >Ban</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .roster {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12.5px;
  }
  .roster-head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .meta {
    margin-left: 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .roster-tools {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  input:not([type="checkbox"]),
  select,
  button {
    font: inherit;
    color: #eef3ee;
    background: #0d1512;
    border: 1px solid #2f4038;
    border-radius: 5px;
    padding: 4px 7px;
  }
  button {
    cursor: pointer;
    background: #1a2621;
  }
  button:disabled,
  input:disabled,
  select:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .inline-tool {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin: 0;
    font-size: 12px;
  }
  .inline-tool input[type="number"] {
    width: 4rem;
    margin: 0;
    padding: 4px 6px;
  }
  .inline-tool input[type="search"] {
    width: 11rem;
    margin: 0;
    padding: 4px 7px;
  }
  .assign-btn {
    background: #2b4c3f;
    border-color: #548c73;
    color: #e9fff4;
    font-weight: 600;
    padding: 5px 10px;
    font-size: 12px;
  }
  .tiny-btn {
    padding: 3px 7px;
    font-size: 11.5px;
  }
  .hint {
    font-size: 11.5px;
    opacity: 0.82;
    margin: 0;
  }
  .scroll {
    max-height: 46vh;
    overflow: auto;
    border: 1px solid #3d4f63;
    border-radius: 6px;
    background: #141c19;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    background: #1f2b26;
    text-align: left;
    padding: 6px 8px;
    font-weight: 600;
    border-bottom: 1px solid #3a4a42;
  }
  td {
    padding: 6px 8px;
    border-top: 1px solid #28352f;
    vertical-align: top;
  }
  .commander-cell {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .commander-cell input[type="text"] {
    width: 10.5rem;
    margin: 0;
    padding: 3px 6px;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    flex-shrink: 0;
    border-radius: 50%;
    background: #64748b;
  }
  .dot.online {
    background: #4ade80;
    box-shadow: 0 0 6px #4ade80aa;
  }
  .unit-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 4px;
  }
  .unit-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    padding: 2px 6px;
    border-radius: 4px;
    background: #1d2723;
    border: 1px solid #33433b;
    white-space: nowrap;
    font-size: 11.5px;
  }
  .unit-chip select {
    display: inline-block;
    width: auto;
    margin: 0;
    padding: 1px 4px;
    font-size: 11px;
  }
  .unit-picker {
    margin-top: 6px;
    padding: 8px;
    border-radius: 6px;
    background: #101714;
    border: 1px solid #496055;
  }
  .picker-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .picker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: 4px;
    max-height: 11rem;
    overflow: auto;
  }
  .picker-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    padding: 3px 5px;
    border-radius: 4px;
    background: #18221e;
    font-size: 11px;
  }
  .picker-item.selected {
    border: 1px solid #efd398;
    background: #283327;
  }
  .claimed-badge {
    color: #8ee6b1;
    font-size: 11.5px;
    font-weight: 600;
  }
  .invite code {
    display: block;
    max-width: 11rem;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    margin-bottom: 3px;
  }
  .order,
  .muted {
    opacity: 0.78;
  }
  .seat {
    white-space: nowrap;
    font-family: ui-monospace, monospace;
    font-size: 11.5px;
    color: #b7c2bc;
  }
  .actions {
    display: flex;
    gap: 4px;
    white-space: nowrap;
  }
  button.danger {
    border-color: #a34a4a;
  }
</style>
