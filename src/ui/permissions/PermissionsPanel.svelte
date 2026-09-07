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
    type UserDocument,
    type CollectionName,
    type BaseDocument,
  } from "../../core/documents";

  let {
    client,
    bus,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
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
    "factions", // §4A: OBSERVER+ grants strategic frames (§5A projection)
    "armies", // ownership cascades to embedded units
  ];

  let users = $state<UserDocument[]>([]);
  let coll = $state<CollectionName>("actors");
  let docId = $state<string>("");
  const docs = $derived(
    ((client.store.getAll(coll) ?? []) as readonly BaseDocument[]).map((d) => ({
      id: d._id,
      name: d.name,
    })),
  );
  const doc = $derived(
    docId ? ((client.store.get(coll, docId) as BaseDocument | undefined) ?? null) : null,
  );

  function refresh(): void {
    users = [...(client.store.getAll("users") as readonly UserDocument[])];
    if (docId && !docs.some((d) => d.id === docId)) docId = docs[0]?.id ?? "";
    if (!docId && docs[0]) docId = docs[0].id;
  }

  function setRole(user: UserDocument, role: UserDocument["role"]): void {
    client.submit([{ kind: "update", ref: { coll: "users", id: user._id }, diff: { role } }]);
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
    return () => {
      offSnapshot();
      offOps();
    };
  });
</script>

<div class="perms">
  <h4>Players</h4>
  <table class="users" data-perm-users>
    <thead>
      <tr><th>Name</th><th>Role</th></tr>
    </thead>
    <tbody>
      {#each users as u (u._id)}
        <tr data-user={u._id}>
          <td>{u.name}</td>
          <td>
            <select
              value={u.role}
              aria-label={`Role for ${u.name}`}
              onchange={(e) =>
                setRole(u, (e.target as HTMLSelectElement).value as UserDocument["role"])}
            >
              {#each ROLES as r (r)}
                <option value={r}>{r}</option>
              {/each}
            </select>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

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
    font-size: 12px;
  }
  .picker {
    display: flex;
    gap: 4px;
  }
  .empty {
    opacity: 0.7;
    font-size: 12px;
  }
</style>
