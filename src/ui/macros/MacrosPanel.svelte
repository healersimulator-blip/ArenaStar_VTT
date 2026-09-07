<script lang="ts">
  /**
   * §10 macros (GM window) — chat macros with hotbar slot assignment.
   * `flags.core.slot` (1-5) binds a macro to a hotbar key; running a chat
   * macro goes through the pure chat core (buildChatMessage). Script macros
   * are stored but NOT executed — the system API lands in M3 (D-079).
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { MacroDocument } from "../../core/documents";
  import { runChatMacro } from "./run";

  let {
    client,
    bus,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
  } = $props();

  let macros = $state<MacroDocument[]>([]);
  let name = $state("");
  let command = $state("");

  function refresh(): void {
    macros = [...(client.store.getAll("macros") as readonly MacroDocument[])];
  }

  function create(): void {
    if (!command.trim()) return;
    const doc: MacroDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "macro",
      name: name.trim() || command.slice(0, 20),
      ownership: { default: 1 },
      flags: {},
      system: {},
      kind: "chat",
      command: command.trim(),
    };
    client.submit([{ kind: "create", coll: "macros", data: doc }]);
    name = "";
    command = "";
  }

  function assignSlot(m: MacroDocument, slot: number): void {
    client.submit([
      {
        kind: "update",
        ref: { coll: "macros", id: m._id },
        diff: {
          flags:
            slot > 0
              ? { ...(m.flags as object), core: { ...(m.flags as { core?: object }).core, slot } }
              : {},
        },
      },
    ]);
  }

  function remove(id: string): void {
    client.submit([{ kind: "delete", ref: { coll: "macros", id } }]);
  }

  function slotOf(m: MacroDocument): number {
    const core = (m.flags as { core?: { slot?: unknown } }).core;
    return typeof core?.slot === "number" ? core.slot : 0;
  }

  function runMacro(m: MacroDocument): void {
    runChatMacro(client, m);
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

<div class="macros">
  <form
    onsubmit={(e) => {
      e.preventDefault();
      create();
    }}
  >
    <input data-macro-name type="text" bind:value={name} placeholder="Name" />
    <input
      data-macro-command
      type="text"
      bind:value={command}
      placeholder="/me waves — or hello [[1d6]]"
    />
    <button data-macro-create type="submit">Create</button>
  </form>
  <ul>
    {#each macros as m (m._id)}
      <li data-macro={m._id}>
        <span class="name" title={m.command}>{m.name}</span>
        <select
          data-macro-slot
          value={slotOf(m)}
          aria-label={`Hotbar slot for ${m.name}`}
          onchange={(e) => assignSlot(m, Number((e.target as HTMLSelectElement).value))}
        >
          <option value={0}>—</option>
          {#each [1, 2, 3, 4, 5] as s (s)}
            <option value={s}>{s}</option>
          {/each}
        </select>
        <button data-macro-run type="button" onclick={() => runMacro(m)}>Run</button>
        <button type="button" onclick={() => remove(m._id)}>✕</button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .macros {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  form {
    display: flex;
    gap: 4px;
  }
  form input {
    flex: 1;
    min-width: 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .name {
    flex: 1;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
