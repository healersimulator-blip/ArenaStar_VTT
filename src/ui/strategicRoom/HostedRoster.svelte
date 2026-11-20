<script lang="ts">
  /**
   * GM roster for a hosted strategic battle.
   *
   * The seat ID — not the display name — is the participant boundary: invites, keys,
   * unit grants, kick and ban all key off it. The name is a GM-assigned label that
   * travels to the commander for reference only.
   *
   * "Kick" ends the holder's live session now; the same browser may claim the seat
   * again. "Ban / revoke" deactivates the seat for the rest of the battle and unbound
   * invites (the server refuses a bound key afterwards). Control changes delete any
   * accepted order for a unit the commander no longer owns, so nothing resolves
   * silently on their behalf.
   */
  import type {
    Command,
    MemberRow,
    RoomOrder,
  } from "../../core/strategicRoom/protocol";
  import { orderLabel } from "../armies/heroOrders";

  let {
    members,
    units,
    markers = [],
    busy = false,
    onCommand,
  }: {
    members: readonly MemberRow[];
    /** Unit ids and names per commander, from the GM's authorized view. */
    units: ReadonlyMap<
      string,
      readonly { id: string; name: string; order: RoomOrder | null }[]
    >;
    markers?: readonly { id: string; name: string }[];
    busy?: boolean;
    onCommand: (command: Command) => void;
  } = $props();

  let filter = $state("");
  let names = $state<Record<string, string>>({});
  /** `kick:<seat>` / `ban:<seat>`: the destructive action waits for a second click. */
  let confirming = $state<string | null>(null);
  let online = $derived(members.filter((m) => m.online).length);
  const shown = $derived(
    filter.trim()
      ? members.filter((m) =>
          `${m.name} ${m.id} ${m.factionId ?? ""}`
            .toLowerCase()
            .includes(filter.trim().toLowerCase()),
        )
      : members,
  );
  const unitName = (id: string) =>
    markers.find((marker) => marker.id === id)?.name ??
    [...units.values()].flat().find((unit) => unit.id === id)?.name ??
    id;

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
  function invite(member: MemberRow): void {
    // The code is rendered only after the server's accepted roster view returns it.
    // A refused command, disconnect or reload therefore cannot leave a phantom invite on screen.
    const code = crypto.randomUUID().replace(/-/g, "");
    send({ kind: "member.invite", memberId: member.id, invite: code });
  }
</script>

<div class="roster" data-hosted-roster>
  <header>
    <strong>Commanders</strong>
    <span data-roster-count>{members.length} seats · {online} connected</span>
  </header>
  <p class="hint">
    Names are labels for you and the commander; the seat ID and its browser key
    are the actual boundary. A claimed seat needs a kick or a ban before another
    browser can take it. Unchecking a unit stops that commander ordering it and
    withdraws any order already accepted for it this turn.
  </p>
  <label class="filter"
    >Find <input
      type="search"
      bind:value={filter}
      placeholder="name, seat or side"
    /></label
  >
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Commander</th>
          <th>Seat</th>
          <th>Units they control</th>
          <th>Invite</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each shown as member (member.id)}
          {@const list = units.get(member.id) ?? []}
          <tr
            data-member={member.id}
            data-online={member.online ? "true" : "false"}
          >
            <td>
              <span class="dot" class:online={member.online} aria-hidden="true"
              ></span>
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
              <small>{member.factionId ?? "—"}</small>
            </td>
            <td><code data-member-id>{member.id}</code></td>
            <td class="units">
              {#each list as unit (unit.id)}
                <label title={unitName(unit.id)}>
                  <input
                    type="checkbox"
                    data-member-unit={unit.id}
                    aria-label={`${unit.name} for ${member.name}`}
                    checked={member.units.includes(unit.id)}
                    disabled={busy}
                    onchange={(event) =>
                      setUnits(member, unit.id, event.currentTarget.checked)}
                  />
                  {unit.name}
                  {#if unit.order}<small class="order"
                      >{orderLabel(unit.order, (id) => unitName(id))}</small
                    >{/if}
                </label>
              {:else}<small>no deployment</small>{/each}
            </td>
            <td class="invite">
              {#if member.claimed}<small>claimed</small>
              {:else}
                {#if member.invite}
                  <code data-member-invite>{member.invite}</code>
                  <small>one-time, 30 min</small>
                {/if}
                <button
                  type="button"
                  disabled={busy}
                  data-member-invite-new
                  onclick={() => invite(member)}
                  >{member.invite ? "Reissue invite" : "Create invite"}</button
                >
              {/if}
            </td>
            <td class="actions">
              {#if member.online && confirming !== `kick:${member.id}`}
                <button
                  type="button"
                  disabled={busy}
                  data-member-kick
                  onclick={() => (confirming = `kick:${member.id}`)}
                  >Kick</button
                >
              {/if}
              {#if confirming === `kick:${member.id}`}
                <button
                  type="button"
                  disabled={busy}
                  data-member-kick-confirm
                  onclick={() => {
                    send({ kind: "member.kick", memberId: member.id });
                    confirming = null;
                  }}>Confirm kick</button
                >
                <button type="button" onclick={() => (confirming = null)}
                  >Cancel</button
                >
              {:else if confirming === `ban:${member.id}`}
                <button
                  type="button"
                  disabled={busy}
                  class="danger"
                  data-member-ban-confirm
                  onclick={() => {
                    send({ kind: "member.revoke", memberId: member.id });
                    confirming = null;
                  }}>Confirm ban</button
                >
                <button type="button" onclick={() => (confirming = null)}
                  >Cancel</button
                >
              {:else}
                <button
                  type="button"
                  disabled={busy}
                  class="danger"
                  data-member-ban
                  onclick={() => (confirming = `ban:${member.id}`)}>Ban</button
                >
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
    gap: 6px;
    font-size: 12px;
  }
  header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
  }
  .hint,
  .filter {
    font-size: 11px;
    line-height: 1.45;
  }
  .hint {
    opacity: 0.8;
    margin: 0;
  }
  .scroll {
    max-height: 45vh;
    overflow: auto;
    border: 1px solid #3d4f63;
    border-radius: 4px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    position: sticky;
    top: 0;
    background: #1d2a39;
    text-align: left;
    padding: 4px 6px;
    font-weight: 600;
  }
  td {
    padding: 4px 6px;
    border-top: 1px solid #2b3a4b;
    vertical-align: top;
  }
  td input[type="text"] {
    width: 9em;
  }
  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #64748b;
    margin-right: 4px;
  }
  .dot.online {
    background: #4ade80;
  }
  .units label {
    display: block;
    white-space: nowrap;
  }
  .units {
    max-width: 22em;
  }
  .order,
  .invite small {
    opacity: 0.75;
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
