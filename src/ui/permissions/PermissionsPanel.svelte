<script lang="ts">
  /**
   * §10 permissions (GM window) — user roles + per-document ownership editor.
   * Roles ride users-update ops; ownership rides {coll}-update ops on the
   * doc's `ownership` field (projection + can() already consume it, §4/§5).
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import {
    OWNERSHIP_LEVELS,
    type ActorDocument,
    type SceneDocument,
    type UserDocument,
    type CollectionName,
    type BaseDocument,
  } from "../../core/documents";
  import {
    assignCharacterOps,
    playerRows,
    removeUserOps,
    setPlayerColorOps,
    setTokenControlOps,
    type PlayerRow,
  } from "../../core/players";

  /** D-465: what the host shell knows about live connections (absent in a player's shell). */
  export interface PlayerPresence {
    online: () => readonly string[];
    banned?: (userId: string) => boolean;
    kick?: (userId: string) => void;
    ban?: (userId: string) => void;
    unban?: (userId: string) => void;
  }

  let {
    client,
    bus,
    presence = null,
    activeSceneId = null,
    compact = false,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    presence?: PlayerPresence | null;
    /** The scene whose tokens the roster offers for control (null = the active one). */
    activeSceneId?: string | null;
    /** Roster only (the world Settings embeds it); the ownership editor stays in the window. */
    compact?: boolean;
  } = $props();

  const ROLES: UserDocument["role"][] = ["GM", "ASSISTANT", "TRUSTED", "PLAYER"];
  const LEVELS: Array<[string, number]> = [
    ["NONE", OWNERSHIP_LEVELS.NONE],
    ["LIMITED", OWNERSHIP_LEVELS.LIMITED],
    ["OBSERVER", OWNERSHIP_LEVELS.OBSERVER],
    ["OWNER", OWNERSHIP_LEVELS.OWNER],
  ];
  const EDITABLE: CollectionName[] = [
    "actors",
    "items",
    "journals",
    "rollTables",
    "macros", // D-394: GM may revoke an author's per-document management rights.
    "factions", // §4A: OBSERVER+ grants strategic frames (§5A projection)
    "armies", // ownership cascades to embedded units
  ];

  let users = $state<UserDocument[]>([]);
  let actors = $state<ActorDocument[]>([]);
  let scene = $state<SceneDocument | null>(null);
  let online = $state<string[]>([]);
  let presenceTick = $state(0);
  let renameDraft = $state<Record<string, string>>({});
  let revision = $state(0);
  /** D-465: the roster — presence, role, colour, character and token control per player. */
  const rows = $derived.by((): PlayerRow[] => {
    void presenceTick;
    const banned = new Set(users.filter((user) => presence?.banned?.(user._id)).map((user) => user._id));
    return playerRows(users, actors, scene, { online: new Set(online), banned });
  });
  const myId = $derived(client.user?.id ?? null);
  /** Which player's token list is unfolded (one at a time keeps the table short). */
  let tokensFor = $state<string | null>(null);
  let confirmRemove = $state<string | null>(null);
  let coll = $state<CollectionName>("actors");
  let docId = $state<string>("");
  const docs = $derived.by(() => {
    void revision;
    return ((client.store.getAll(coll) ?? []) as readonly BaseDocument[]).map((d) => ({ id: d._id, name: d.name }));
  });
  const doc = $derived.by(() => {
    void revision;
    return docId ? ((client.store.get(coll, docId) as BaseDocument | undefined) ?? null) : null;
  });

  function refresh(): void {
    revision++;
    users = [...(client.store.getAll("users") as readonly UserDocument[])];
    actors = [...(client.store.getAll("actors") as readonly ActorDocument[])];
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    scene = (activeSceneId ? scenes.find((entry) => entry._id === activeSceneId) : null) ?? scenes.find((entry) => entry.active) ?? null;
    refreshPresence();
    if (docId && !docs.some((d) => d.id === docId)) docId = docs[0]?.id ?? "";
    if (!docId && docs[0]) docId = docs[0].id;
  }
  function refreshPresence(): void {
    // The host's own user is not one of its sessions, but it is plainly connected.
    online = presence ? [...presence.online(), ...(myId ? [myId] : [])] : [];
    presenceTick++;
  }
  function userOf(id: string): UserDocument | undefined {
    return users.find((user) => user._id === id);
  }
  function assignCharacter(row: PlayerRow, actorId: string): void {
    const user = userOf(row.id);
    if (!user) return;
    const actor = actorId ? actors.find((entry) => entry._id === actorId) ?? null : null;
    const previous = row.characterId ? actors.find((entry) => entry._id === row.characterId) ?? null : null;
    client.submit(assignCharacterOps(user, actor, { previous }));
  }
  function setTokenControl(row: PlayerRow, tokenId: string, control: boolean): void {
    const token = scene?.tokens.find((entry) => entry._id === tokenId);
    if (!scene || !token) return;
    const ops = setTokenControlOps(scene, token, row.id, control);
    if (ops.length) client.submit(ops);
  }
  function setColor(row: PlayerRow, color: string): void {
    const user = userOf(row.id);
    if (!user) return;
    const ops = setPlayerColorOps(user, color);
    if (ops.length) client.submit(ops);
  }

  function setName(userId: string, name: string): void {
    const user = userOf(userId);
    if (!user || !name.trim()) return;
    client.submit([{ kind: "update", ref: { coll: "users", id: userId }, diff: { name: name.trim(), nameSetByGm: true } }]);
  }
  function removeUser(row: PlayerRow): void {
    const user = userOf(row.id);
    if (!user) return;
    const ops = removeUserOps(user, row.online);
    confirmRemove = null;
    if (ops.length) client.submit(ops);
  }

  function setRole(user: UserDocument, role: UserDocument["role"]): void {
    client.submit([{ kind: "update", ref: { coll: "users", id: user._id }, diff: { role } }]);
  }

  function setMacroSaving(user: UserDocument, enabled: boolean): void {
    client.submit([{ kind: "update", ref: { coll: "users", id: user._id }, diff: { canSaveMacros: enabled } }]);
  }

  function setDefault(level: number): void {
    if (!doc) return;
    client.submit([
      {
        kind: "update",
        ref: { coll, id: doc._id },
        diff: { ownership: { ...doc.ownership, default: level } },
      },
    ]);
  }

  function setUserLevel(userId: string, level: number | null): void {
    if (!doc) return;
    const next: Record<string, number> = { default: doc.ownership.default };
    for (const [key, value] of Object.entries(doc.ownership)) {
      if (key !== "default" && typeof value === "number" && key !== userId) next[key] = value;
    }
    if (level !== null && level >= 0) next[userId] = level;
    client.submit([{ kind: "update", ref: { coll, id: doc._id }, diff: { ownership: next } }]);
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    // Presence is not a document, so it never arrives as an op: poll it while the window is open.
    const timer = presence ? setInterval(refreshPresence, 1500) : null;
    return () => {
      offSnapshot();
      offOps();
      if (timer) clearInterval(timer);
    };
  });
</script>

<div class="perms" class:compact>
  <h4>Players</h4>
  <p class="hint">
    Who is in this world and what they may do. The dot shows who is connected right now; the role sets trust
    (TRUSTED players may place tokens and drawings; ASSISTANT is a co-GM). A character is the actor a player
    plays — assigning it makes them its owner. Token control is per token on the current scene.
  </p>
  <!-- The roster scrolls sideways in a narrow window instead of clipping its Actions column. -->
  <div class="roster-scroll">
  <table class="users" data-perm-users>
    <thead>
      <tr><th>Player</th><th>Role</th><th>Character</th><th>Tokens here</th><th>Macros</th><th class="actions-head">Actions</th></tr>
    </thead>
    <tbody>
      {#each rows as row (row.id)}
        <tr data-user={row.id} data-online={row.online ? "true" : "false"}>
          <td class="who">
            <span class="dot" class:online={row.online} title={row.online ? "Connected" : "Offline"} aria-label={row.online ? "connected" : "offline"} data-perm-online={row.online ? "true" : "false"}></span>
            <input type="color" class="swatch" aria-label={`Colour for ${row.name}`} data-perm-color value={row.color || "#888888"} onchange={(event) => setColor(row, event.currentTarget.value)} />
            <span class="name">{row.name}{#if row.id === myId} <small>(you)</small>{/if}{#if row.banned} <small class="banned">banned</small>{/if}</span>
            <span class="player-id" data-perm-user-id>{row.id}</span>
            <input
              class="player-name-input"
              data-perm-player-name
              type="text"
              aria-label={`Player name for ${row.name}`}
              value={renameDraft[row.id] ?? row.name}
              oninput={(event) => { renameDraft = { ...renameDraft, [row.id]: event.currentTarget.value }; }}
            />
            <button type="button" class="link" data-perm-rename onclick={() => setName(row.id, renameDraft[row.id] ?? row.name)}>Rename</button>
          </td>
          <td>
            <select
              value={row.role}
              aria-label={`Role for ${row.name}`}
              disabled={row.id === myId}
              onchange={(e) => { const user = userOf(row.id); if (user) setRole(user, (e.target as HTMLSelectElement).value as UserDocument["role"]); }}
            >
              {#each ROLES as r (r)}
                <option value={r}>{r}</option>
              {/each}
            </select>
          </td>
          <td>
            <select data-perm-character aria-label={`Character for ${row.name}`} value={row.characterId ?? ""} onchange={(e) => assignCharacter(row, (e.target as HTMLSelectElement).value)}>
              <option value="">— none —</option>
              {#each actors as actor (actor._id)}
                <option value={actor._id}>{actor.name}</option>
              {/each}
            </select>
          </td>
          <td>
            {#if row.role === "GM" || row.role === "ASSISTANT"}
              <span class="muted">all</span>
            {:else if !scene || row.tokens.length === 0}
              <span class="muted">no tokens</span>
            {:else}
              <button type="button" class="link" data-perm-tokens aria-expanded={tokensFor === row.id} onclick={() => (tokensFor = tokensFor === row.id ? null : row.id)}>
                {row.tokens.filter((token) => token.via).length} of {row.tokens.length}
              </button>
            {/if}
          </td>
          <td>
            <input type="checkbox" data-perm-macro-save
              aria-label={`Save macros in world for ${row.name}`}
              checked={row.canSaveMacros}
              disabled={row.role === "GM" || row.role === "ASSISTANT"}
              onchange={(event) => { const user = userOf(row.id); if (user) setMacroSaving(user, event.currentTarget.checked); }} />
          </td>
          <td class="actions">
            {#if presence && row.id !== myId}
              {#if row.online && presence.kick}
                <button type="button" class="link" data-perm-kick onclick={() => presence?.kick?.(row.id)}>Disconnect</button>
              {/if}
              {#if row.banned && presence.unban}
                <button type="button" class="link" data-perm-unban onclick={() => { presence?.unban?.(row.id); refreshPresence(); }}>Unban</button>
              {:else if presence.ban && row.role !== "GM"}
                <button type="button" class="link danger" data-perm-ban onclick={() => { presence?.ban?.(row.id); refreshPresence(); }}>Ban</button>
              {/if}
            {/if}
            {#if row.role !== "GM" && !row.online && row.id !== myId}
              {#if confirmRemove === row.id}
                <button type="button" class="link danger" data-perm-remove-confirm onclick={() => removeUser(row)}>Really remove</button>
                <button type="button" class="link" onclick={() => (confirmRemove = null)}>Keep</button>
              {:else}
                <button type="button" class="link" data-perm-remove onclick={() => (confirmRemove = row.id)}>Remove</button>
              {/if}
            {/if}
          </td>
        </tr>
        {#if tokensFor === row.id && scene}
          <tr class="tokens-row" data-perm-tokens-for={row.id}>
            <td colspan="6">
              <div class="tokens">
                <span class="tokens-title">Tokens {row.name} controls on “{scene.name}”</span>
                {#each row.tokens as token (token.tokenId)}
                  <label class="token">
                    <input type="checkbox" data-perm-token={token.tokenId} data-perm-token-via={token.via ?? "none"}
                      checked={token.via !== null}
                      disabled={token.via === "actor" || token.via === "everyone"}
                      onchange={(event) => setTokenControl(row, token.tokenId, event.currentTarget.checked)} />
                    {token.name}{#if token.via === "actor"} <small class="muted">(through their character)</small>{:else if token.via === "everyone"} <small class="muted">(open to everyone)</small>{/if}
                  </label>
                {/each}
              </div>
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
  </div>
  {#if !presence}
    <p class="hint">Connection status is only visible from the host.</p>
  {/if}
  <p class="hint">Save macros: per-player opt-in to save personal macros into this world for the next export. Script drafts still require separate GM review; turning this off prevents further saves/deletes, not existing execution.</p>

  {#if !compact}
  <h4>Document ownership</h4>
  <div class="picker">
    <select data-perm-coll bind:value={coll} onchange={() => (docId = "")}>
      {#each EDITABLE as c (c)}
        <option value={c}>{c}</option>
      {/each}
    </select>
    <select data-perm-doc bind:value={docId}>
      {#each docs as d (d.id)}
        <option value={d.id}>{d.name}</option>
      {/each}
    </select>
  </div>
  {#if doc}
    <label>
      Default
      <select
        data-perm-default
        value={doc.ownership.default}
        onchange={(e) => setDefault(Number((e.target as HTMLSelectElement).value))}
      >
        {#each LEVELS as [name, level] (level)}
          <option value={level}>{name}</option>
        {/each}
      </select>
    </label>
    <table class="overrides">
      <thead>
        <tr><th>User</th><th>Level</th></tr>
      </thead>
      <tbody>
        {#each users as u (u._id)}
          <tr>
            <td>{u.name}</td>
            <td>
              <select
                data-perm-owner={u._id}
                value={doc.ownership[u._id] ?? -1}
                aria-label={`Ownership for ${u.name}`}
                onchange={(e) => setUserLevel(u._id, Number((e.target as HTMLSelectElement).value))}
              >
                <option value={-1}>inherit</option>
                {#each LEVELS as [name, level] (level)}
                  <option value={level}>{name}</option>
                {/each}
              </select>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="empty">No {coll} documents yet.</p>
  {/if}
  {/if}
</div>

<style>
  .perms {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h4 {
    margin: 4px 0 0;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    padding: 2px 4px;
    border-bottom: 1px solid #262e3a;
    font-size: 0.875rem;
  }
  .picker {
    display: flex;
    gap: 4px;
  }
  .hint { color: #99b4c5; font-size: 0.8rem; margin: 0; }
  .roster-scroll { overflow-x: auto; max-width: 100%; }
  .users th { white-space: nowrap; }
  .users select { max-width: 11rem; }
  .who { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #55606f; box-shadow: 0 0 0 1px #0b0f16 inset; flex: 0 0 auto; }
  .dot.online { background: #3fd37a; box-shadow: 0 0 6px #3fd37a99; }
  .swatch { width: 22px; height: 18px; padding: 0; border: 1px solid #3a455e; border-radius: 3px; background: transparent; }
  .name small { color: #99b4c5; }
  .banned { color: #ff9a9a; }
  .muted { color: #8f9bb0; font-size: 0.8rem; }
  .actions { white-space: nowrap; }
  .actions-head { text-align: right; }
  .actions { text-align: right; }
  button.link { padding: 0 4px; color: #8fb8ff; background: transparent; border: 0; text-decoration: underline; cursor: pointer; font: inherit; font-size: 0.8rem; }
  button.link.danger { color: #ff9a9a; }
  .tokens-row td { padding: 4px 8px 8px; background: #0f1621; }
  .tokens { display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .tokens-title { flex-basis: 100%; color: #99b4c5; font-size: 0.8rem; }
  .token { display: inline-flex; align-items: center; gap: 4px; font-size: 0.85rem; }
  select { max-width: 150px; }
  .empty {
    opacity: 0.7;
    font-size: 0.875rem;
  }
</style>
