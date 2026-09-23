<script lang="ts">
  /**
   * MCP connector §3.2 — Settings → Agents: the GM's surface for everything an agent may do.
   *
   * Three things it has to say out loud, because they are the difference between a GM who knows
   * what they granted and one who does not:
   *
   * - **A GM-scoped agent is exactly as powerful as the GM's own tab.** Not "an assistant with
   *   some tools" — the same writes, the same reads, including whispers. §7.4 asks for those
   *   words on screen, and they are in the preset hint below.
   * - **Revoking does not delete.** The record stays so the world file remembers what was
   *   allowed; "forget" is a separate button, and it says which it is.
   * - **The audit is the record of attempts, not just of successes.** A refused call is a line in
   *   the ring, because "the agent tried to delete a scene three times" is the thing a GM wants to
   *   know and the OpLog can never show.
   */
  import {
    AGENT_CAPABILITIES,
    PRESETS,
    PRESET_ROLE,
    AGENT_PRESETS,
    type AgentCapability,
    type AgentPreset,
  } from "../../core/agents/capabilities";
  import type { AgentRecord } from "../../core/agents/grants";
  import type { AgentAuditEntry } from "../../core/agents/bridge";
  import type { AgentManager } from "../../app/agentManager";

  let {
    rows,
    scenes,
    audit,
    onAdd,
    onGrant,
    onRevoke,
    onForget,
    onConnect,
  }: {
    /** The agent rows, re-read from the replicated grant document by the window above. */
    rows: ReturnType<AgentManager["list"]>;
    /** Scene id + name, for the scope picker. */
    scenes: Array<{ id: string; name: string }>;
    audit: readonly AgentAuditEntry[];
    onAdd: (name: string, preset: AgentPreset) => void;
    onGrant: (id: string, patch: {
      preset?: AgentPreset;
      capabilities?: readonly AgentCapability[];
      sceneScope?: string | null;
      auditNote?: boolean;
    }) => void;
    onRevoke: (id: string) => void;
    onForget: (id: string) => void;
    onConnect: (id: string, url: string, token: string) => void;
  } = $props();

  const PRESET_HINT: Record<AgentPreset, string> = {
    gm: "Everything, including the GM's own data: hidden tokens, whispers and GM-only roll results. This agent is exactly as powerful as the GM's tab — say so out loud before you enable it.",
    "gm-no-delete":
      "Everything except deleting documents — the plan's own recommendation. It can still create, edit and move, and it still reads the GM's data.",
    player:
      "Its own projection: it reads what a player reads, speaks, rolls, and moves the tokens it owns. Ownership, not this mask, is what stops it touching anyone else's.",
    observer: "Read-only. Every write tool is refused before it reaches the host.",
  };

  let newName = $state("");
  let newPreset = $state<AgentPreset>("gm-no-delete");
  let url = $state("ws://127.0.0.1:8787");
  let token = $state("");
  let expanded = $state<string | null>(null);
  let error = $state("");

  function submitAdd(): void {
    const name = newName.trim();
    if (name === "") {
      error = "give the agent a name — it becomes the user the table sees";
      return;
    }
    error = "";
    onAdd(name, newPreset);
    newName = "";
  }

  function toggle(record: AgentRecord, capability: AgentCapability): void {
    const has = record.capabilities.includes(capability);
    const next = has
      ? record.capabilities.filter((c) => c !== capability)
      : [...record.capabilities, capability];
    onGrant(record.id, { capabilities: next });
  }

  const granted = (record: AgentRecord): readonly AgentCapability[] =>
    PRESETS[record.preset].filter((c) => record.capabilities.includes(c));

  const clock = (ms: number): string => new Date(ms).toLocaleTimeString();

  const outcomeColour = (outcome: AgentAuditEntry["outcome"]): string =>
    outcome === "refused"
      ? "#ffd166"
      : outcome === "invalid"
        ? "#e0736b"
        : outcome === "error"
          ? "#e0736b"
          : "#8fbc8f";
</script>

<div class="agents">
  <h3>Agents</h3>
  <p class="hint">
    An agent is a <strong>user</strong> with its own session: its writes are attributed to it in the
    OpLog and undoable in one click, and its reads are the projection for its role. Grants live in a
    replicated document, so they survive a reload and every replica can see what was allowed.
  </p>

  {#if rows.length === 0}
    <p class="hint">No agents have been granted anything in this world yet.</p>
  {/if}

  {#each rows as agent (agent.record.id)}
    {@const record = agent.record}
    <div class="agent" class:revoked={record.status === "revoked"}>
      <div class="head">
        <strong>{record.name}</strong>
        <span class="status {record.status}">{record.status}</span>
        <span class="hint">
          {granted(record).length}/{PRESETS[record.preset].length} capabilities · role
          {PRESET_ROLE[record.preset]}
        </span>
        {#if agent.bridge}
          <span class="live">connected</span>
        {:else}
          <span class="hint">not connected</span>
        {/if}
        <span class="grow"></span>
        <button onclick={() => (expanded = expanded === record.id ? null : record.id)}>
          {expanded === record.id ? "Hide" : "Edit"}
        </button>
        {#if record.status !== "revoked"}
          <button class="danger" onclick={() => onRevoke(record.id)}>Revoke</button>
        {:else}
          <button onclick={() => onGrant(record.id, { status: "active" })}>Re-grant</button>
          <button class="danger" onclick={() => onForget(record.id)}>Forget</button>
        {/if}
      </div>

      {#if record.client}
        <p class="hint">Connected as {record.client}.</p>
      {/if}
      {#if record.sceneScope}
        <p class="hint">Scoped to one scene: {scenes.find((s) => s.id === record.sceneScope)?.name ?? record.sceneScope}</p>
      {/if}

      {#if expanded === record.id}
        <label class="row">
          Preset
          <select
            value={record.preset}
            onchange={(e) =>
              onGrant(record.id, {
                preset: e.currentTarget.value as AgentPreset,
                capabilities: record.capabilities,
              })}
          >
            {#each AGENT_PRESETS as preset (preset)}
              <option value={preset}>{preset}</option>
            {/each}
          </select>
        </label>
        <p class="hint">{PRESET_HINT[record.preset]}</p>

        <label class="row">
          Scene scope
          <select
            value={record.sceneScope ?? ""}
            onchange={(e) =>
              onGrant(record.id, { sceneScope: e.currentTarget.value || null })}
          >
            <option value="">the whole world</option>
            {#each scenes as scene (scene.id)}
              <option value={scene.id}>{scene.name}</option>
            {/each}
          </select>
        </label>

        <p class="hint">Capabilities the preset allows — untick to narrow it:</p>
        <div class="caps">
          {#each PRESETS[record.preset] as capability (capability)}
            <label>
              <input
                type="checkbox"
                checked={record.capabilities.includes(capability)}
                onchange={() => toggle(record, capability)}
              />
              {capability}
            </label>
          {/each}
        </div>
        {#if granted(record).length < record.capabilities.length}
          <p class="warn">
            {record.capabilities.length - granted(record).length} ticked capability/ies are not in
            this preset and do not apply.
          </p>
        {/if}
        {#if AGENT_CAPABILITIES.length > PRESETS[record.preset].length}
          <p class="hint">
            The other {AGENT_CAPABILITIES.length - PRESETS[record.preset].length} capabilities are
            not in this preset — changing the preset is how an agent gets them, never a tick box.
          </p>
        {/if}

        <label class="row">
          <input
            type="checkbox"
            checked={record.auditNote}
            onchange={(e) => onGrant(record.id, { auditNote: e.currentTarget.checked })}
          />
          Post a GM-only chat card for every write
        </label>

        <div class="row">
          <input placeholder="ws://127.0.0.1:8787" bind:value={url} />
          <input placeholder="pairing token" bind:value={token} />
          <button
            disabled={token.trim() === ""}
            onclick={() => onConnect(record.id, url.trim(), token.trim())}
          >
            Connect
          </button>
        </div>
        <p class="hint">
          The sidecar prints both when it starts (<code>pnpm mcp</code>). The tab dials
          <em>out</em> to it — the app never listens on a port.
        </p>
      {/if}
    </div>
  {/each}

  <div class="add">
    <input placeholder="agent name" bind:value={newName} />
    <select bind:value={newPreset}>
      {#each AGENT_PRESETS as preset (preset)}
        <option value={preset}>{preset}</option>
      {/each}
    </select>
    <button onclick={submitAdd}>Add agent</button>
  </div>
  <p class="hint">{PRESET_HINT[newPreset]}</p>
  {#if error}
    <p class="error">{error}</p>
  {/if}

  <h4>Recent calls</h4>
  {#if audit.length === 0}
    <p class="hint">Nothing has called in yet.</p>
  {:else}
    <table class="audit">
      <thead>
        <tr><th>time</th><th>tool</th><th>args</th><th>outcome</th><th>answer</th></tr>
      </thead>
      <tbody>
        {#each audit as entry, i (i)}
          <tr>
            <td>{clock(entry.at)}</td>
            <td>{entry.tool ?? entry.method}</td>
            <td class="args">{entry.args}</td>
            <td style="color: {outcomeColour(entry.outcome)}">{entry.outcome}</td>
            <td class="args">{entry.detail}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="hint">
      The last {audit.length} calls, in memory only — a refused call is here too, because what an
      agent <em>tried</em> is the half the OpLog cannot show.
    </p>
  {/if}
</div>

<style>
  .agents h3 {
    margin: 8px 0 4px;
    font-size: 0.875rem;
  }
  .agents h4 {
    margin: 12px 0 4px;
    font-size: 0.8125rem;
  }
  .agent {
    border: 1px solid #2b3a52;
    border-radius: 6px;
    padding: 6px 8px;
    margin-bottom: 6px;
  }
  .agent.revoked {
    opacity: 0.7;
  }
  .head {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.8125rem;
  }
  .grow {
    flex: 1;
  }
  .status {
    font-size: 0.6875rem;
    padding: 0 4px;
    border-radius: 999px;
    background: #22304a;
  }
  .status.active {
    background: #2f4a34;
  }
  .status.revoked {
    background: #4a2f2f;
  }
  .live {
    font-size: 0.6875rem;
    color: #8fbc8f;
  }
  .caps {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 2px;
    margin: 4px 0;
    font-size: 0.75rem;
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.8125rem;
  }
  .add {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 6px;
  }
  .hint {
    margin: 2px 0;
    font-size: 0.75rem;
    color: #7d8ea6;
  }
  .warn {
    margin: 2px 0;
    font-size: 0.75rem;
    color: var(--vtt-focus, #ffd166);
  }
  .error {
    margin: 2px 0;
    font-size: 0.75rem;
    color: #e0736b;
  }
  table.audit {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.6875rem;
  }
  table.audit th {
    text-align: left;
    color: #7d8ea6;
    font-weight: 600;
  }
  table.audit td,
  table.audit th {
    padding: 1px 4px;
    border-bottom: 1px solid #22304a;
    vertical-align: top;
  }
  .args {
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  button {
    font-size: 0.75rem;
  }
  button.danger {
    color: #e0736b;
  }
  input,
  select {
    font-size: 0.75rem;
  }
</style>
