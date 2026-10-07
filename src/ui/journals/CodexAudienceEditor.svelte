<script lang="ts">
  import type { CodexAudience, UserDocument } from "../../core/documents";

  let {
    label,
    audience,
    users,
    disabled = false,
    onChange,
  }: {
    label: string;
    audience?: CodexAudience;
    users: readonly UserDocument[];
    disabled?: boolean;
    onChange: (audience: CodexAudience) => void;
  } = $props();

  const playerOptions = $derived(
    users
      .filter((user) => user.role !== "GM" && user.role !== "ASSISTANT")
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  function changeKind(kind: string): void {
    if (kind === "gmOnly") onChange({ kind: "gmOnly" });
    else if (kind === "selectedUsers") {
      onChange(
        audience?.kind === "selectedUsers"
          ? audience
          : { kind: "selectedUsers", userIds: [] },
      );
    } else onChange({ kind: "inherit" });
  }

  function changeUsers(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    const userIds = Array.from(select.selectedOptions, (option) => option.value);
    onChange({ kind: "selectedUsers", userIds });
  }
</script>

<div class="audience-editor">
  <label>
    {label}
    <select
      aria-label={label}
      value={audience?.kind ?? "inherit"}
      disabled={disabled}
      onchange={(event) => changeKind(event.currentTarget.value)}
    >
      <option value="inherit">Readers of this journal</option>
      <option value="selectedUsers">Selected readers</option>
      <option value="gmOnly">GM/Assistant only</option>
    </select>
  </label>
  {#if audience?.kind === "selectedUsers"}
    <label>
      Readers
      <select
        aria-label={`${label}: selected readers`}
        multiple
        size={Math.max(2, Math.min(5, playerOptions.length))}
        value={audience.userIds}
        disabled={disabled || playerOptions.length === 0}
        onchange={changeUsers}
      >
        {#each playerOptions as user (user._id)}
          <option value={user._id}>{user.name} ({user.role.toLocaleLowerCase()})</option>
        {/each}
      </select>
    </label>
    {#if playerOptions.length === 0}
      <small>No player or trusted users are available yet.</small>
    {:else}
      <small>Use Ctrl/Cmd-click to select multiple readers. An empty selection is private.</small>
    {/if}
  {/if}
</div>

<style>
  .audience-editor { display:flex; align-items:flex-end; flex-wrap:wrap; gap:7px; }
  label { display:flex; flex-direction:column; gap:4px; }
  select[multiple] { min-width:190px; }
  small { color:var(--muted,#9aa8b7); max-width:280px; }
</style>
