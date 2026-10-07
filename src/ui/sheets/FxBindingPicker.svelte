<!-- eslint-disable @typescript-eslint/no-unused-vars -->
<script lang="ts">
  /* eslint-disable @typescript-eslint/no-unused-vars */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ActorDocument, MacroDocument, UserDocument } from "../../core/documents";
  import type { Json } from "../../core/documents";
  import { fxBindingOf, fxBindingEvents, fxSpellBindingOf,
    validateFxItemBinding, validateFxSpellBinding } from "../../core/fxBinding";
  import { fxShareDraftOf, fxShareError, fxShareOwnership, fxShareableUsers,
    type FxShareScope } from "../../core/fxSharing";
  import { boundCueFor, boundSpellCueFor, fxSpellBindingIdForName } from "./fxItemCue";
  import type { FxBindingPickerTarget } from "./fxBindingPicker";

  let {
    client,
    bus,
    target,
    onClose,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    target: FxBindingPickerTarget;
    onClose: () => void;
  } = $props();

  let revision = $state(0);
  let macros = $state<MacroDocument[]>([]);
  let users = $state<UserDocument[]>([]);
  let search = $state("");
  let selectedId = $state("");
  let shareScope = $state<FxShareScope>("gm");
  let shareUserIds = $state<string[]>([]);
  let playerCallable = $state(false);
  let error = $state("");
  let status = $state("");

  const isGm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  const key = $derived(target.kind === "spell" ? fxSpellBindingIdForName(target.spellName) : null);
  const title = $derived(target.kind === "spell"
    ? `Attach FX to ${target.spellName}`
    : `Attach FX when ${target.event === "attack" ? "attacking with" : "using"} ${itemName()}`);
  const eligibleUsers = $derived(fxShareableUsers(users));
  const selectedMacro = $derived(macros.find((macro) => macro._id === selectedId) ?? null);
  const currentBinding = $derived.by(() => {
    void revision;
    if (target.kind === "spell") return key === null ? null : boundSpellCueFor(client, key);
    return boundCueFor(client, target.actorId, target.itemId, target.event);
  });
  const candidates = $derived.by(() => {
    void revision;
    const needle = search.trim().toLowerCase();
    return macros.filter((macro) => macro.kind === "sequence" &&
      (needle === "" || macro.name.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id));
  });
  const selectedShareError = $derived(fxShareError({ scope: shareScope, userIds: shareUserIds }, users));
  const sequenceAudienceWarning = $derived.by(() => {
    const audience = selectedMacro?.sequence?.audience;
    if (audience === "gm")
      return "Playback Audience is GM / assistant only. A published player may still trigger this action, but only GMs/assistants see the playback.";
    if (audience === "others")
      return "Playback Audience excludes the requester. A published player may trigger this action, but the caster will not see the playback.";
    if (typeof audience === "object" && audience !== null)
      return "Playback Audience is a chosen-player list. Published players can trigger this action independently; only listed users see the playback.";
    return "";
  });

  function refresh(): void {
    macros = [...client.store.getAll("macros")] as MacroDocument[];
    users = [...client.store.getAll("users")] as UserDocument[];
    const available = new Set(fxShareableUsers(users).map((user) => user._id));
    shareUserIds = shareUserIds.filter((id) => available.has(id));
    revision++;
  }

  function itemName(): string {
    if (target.kind !== "item") return "item";
    const actor = client.store.get("actors", target.actorId) as ActorDocument | undefined;
    return actor?.items.find((item) => item._id === target.itemId)?.name ?? "item";
  }

  function loadShare(macro: MacroDocument): void {
    const draft = fxShareDraftOf(macro, users);
    shareScope = draft.scope;
    shareUserIds = draft.userIds;
    playerCallable = macro.flags?.core?.playerCallable === true;
  }

  function selectTimeline(macro: MacroDocument): void {
    selectedId = macro._id;
    loadShare(macro);
    error = "";
    status = "";
  }

  function changeScope(scope: FxShareScope): void {
    // Visibility is an independent permission; keep the invocation choice when the
    // author changes scope so it is not silently granted or revoked as a side effect.
    shareScope = scope;
  }

  function toggleUser(userId: string, on: boolean): void {
    shareUserIds = on
      ? [...new Set([...shareUserIds, userId])]
      : shareUserIds.filter((id) => id !== userId);
  }

  function nextFlags(macro: MacroDocument): MacroDocument["flags"] {
    return { ...macro.flags, core: { ...macro.flags?.core, playerCallable } };
  }

  function bindingFor(macro: MacroDocument): { field: "fxSpell" | "fxItem"; value: Json } | null {
    if (target.kind === "spell") {
      if (key === null) return null;
      const previous = fxSpellBindingOf(macro);
      const value = {
        spellId: key,
        spellName: target.spellName.trim(),
        ...(previous?.spellId === key && previous.onFailureId ? { onFailureId: previous.onFailureId } : {}),
        ...(previous?.spellId === key && previous.recognition && previous.recognition !== "auto"
          ? { recognition: previous.recognition } : {}),
        ...(previous?.spellId === key && previous.enabled === false ? { enabled: false } : {}),
      };
      const checked = validateFxSpellBinding(value);
      return checked.ok ? { field: "fxSpell", value: checked.binding as unknown as Json } : null;
    }

    const previous = fxBindingOf(macro);
    const sameItem = previous?.actorId === target.actorId && previous.itemId === target.itemId;
    const events = sameItem ? [...new Set([...fxBindingEvents(previous), target.event])] : [target.event];
    const value = {
      actorId: target.actorId,
      itemId: target.itemId,
      ...(sameItem && previous?.onFailureId ? { onFailureId: previous.onFailureId } : {}),
      ...(sameItem && previous?.recognition && previous.recognition !== "auto"
        ? { recognition: previous.recognition } : {}),
      ...(sameItem && previous?.enabled === false ? { enabled: false } : {}),
      ...(events.length === 1 && events[0] === "use" ? {} : { events }),
    };
    const checked = validateFxItemBinding(value);
    return checked.ok ? { field: "fxItem", value: checked.binding as unknown as Json } : null;
  }

  function cloneForTarget(source: MacroDocument): MacroDocument {
    const contextName = target.kind === "spell" ? target.spellName : itemName();
    const suffix = ` — ${contextName}`;
    const name = `${source.name.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
    return {
      _id: globalThis.crypto.randomUUID(),
      type: "macro",
      name,
      command: "",
      kind: "sequence",
      ownership: fxShareOwnership({ scope: shareScope, userIds: shareUserIds }),
      flags: nextFlags(source),
      system: {},
      sequence: structuredClone(source.sequence ?? { version: 1, sections: [] }),
    };
  }

  function attachSelected(): void {
    error = "";
    status = "";
    if (!isGm) { error = "Only a GM or assistant can bind and publish a world FX timeline"; return; }
    if (target.kind === "spell" && key === null) { error = "Enter a spell name the VTT can normalize"; return; }
    if (!selectedMacro || selectedMacro.kind !== "sequence") { error = "Choose a saved FX timeline first"; return; }
    if (currentBinding && currentBinding._id !== selectedMacro._id) {
      error = `This action already has "${currentBinding.name}" attached. Remove it before choosing a different timeline.`;
      return;
    }
    if (selectedShareError) { error = selectedShareError; return; }

    const binding = bindingFor(selectedMacro);
    if (binding === null) { error = "This FX timeline cannot be bound to the selected action"; return; }
    const hasConflictingExistingBinding = target.kind === "spell"
      ? fxSpellBindingOf(selectedMacro) !== null && fxSpellBindingOf(selectedMacro)?.spellId !== key
      : (() => {
          const previous = fxBindingOf(selectedMacro);
          return previous !== null && (previous.actorId !== target.actorId || previous.itemId !== target.itemId);
        })();

    const ownership = fxShareOwnership({ scope: shareScope, userIds: shareUserIds });
    if (hasConflictingExistingBinding) {
      const copy = cloneForTarget(selectedMacro);
      (copy as unknown as Record<string, unknown>)[binding.field] = binding.value;
      client.submit([{ kind: "create", coll: "macros", data: copy }]);
      status = `Created and attached a copy, "${copy.name}". The original library timeline is unchanged.`;
      selectedId = copy._id;
      return;
    }

    const diff: Record<string, Json> = {
      [binding.field]: binding.value,
      ownership: ownership as unknown as Json,
      flags: nextFlags(selectedMacro) as unknown as Json,
    };
    client.submit([{ kind: "update", ref: { coll: "macros", id: selectedMacro._id }, diff }]);
    const visibility = shareScope === "gm" ? "GM-only"
      : shareScope === "all" ? "all-player" : "selected-player";
    status = `Binding submitted for ${target.kind === "spell" ? target.spellName : itemName()}. ` +
      `Visibility: ${visibility}; player invocation: ${playerCallable ? "enabled" : "disabled"}.`;
  }

  function removeBinding(): void {
    if (!currentBinding || !isGm) return;
    error = "";
    status = "";
    if (target.kind === "spell") {
      client.submit([{ kind: "update", ref: { coll: "macros", id: currentBinding._id },
        diff: { "-=fxSpell": null } }]);
    } else {
      const previous = fxBindingOf(currentBinding);
      if (!previous) return;
      const remaining = fxBindingEvents(previous).filter((event) => event !== target.event);
      const diff: Record<string, Json> = remaining.length === 0
        ? { "-=fxItem": null }
        : { fxItem: { ...previous, ...(remaining.length === 1 && remaining[0] === "use"
            ? { events: undefined } : { events: remaining }) } as unknown as Json };
      // `undefined` is not a wire-level clear; omit the default events field explicitly.
      if (remaining.length === 1 && remaining[0] === "use") {
        const { events: _events, ...withoutEvents } = previous;
        diff.fxItem = withoutEvents as unknown as Json;
      }
      client.submit([{ kind: "update", ref: { coll: "macros", id: currentBinding._id }, diff }]);
    }
    status = "Binding removal submitted. The original FX timeline stays in the world library.";
  }

  onMount(() => {
    refresh();
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offRejected = bus.on("rejected", (event) => { error = event.detail; });
    return () => { offSnapshot(); offOps(); offRejected(); };
  });

  $effect(() => {
    if (currentBinding && selectedId === "") selectTimeline(currentBinding);
  });
</script>

<div class="fx-binding-backdrop" role="presentation" onclick={(event) => {
  if (event.target === event.currentTarget) onClose();
}}>
  <div class="fx-binding-dialog" role="dialog" aria-modal="true" aria-label={title}
    data-fx-binding-picker>
    <header>
      <div><h3>{title}</h3>
        <p>Pick a saved timeline from this world's FX library. The binding only plays visuals; spell/item rules still resolve normally.</p>
      </div>
      <button type="button" aria-label="Close FX binding picker" data-fx-binding-close onclick={onClose}>×</button>
    </header>

    {#if !isGm}
      <p role="alert">Only a GM or assistant can manage world action/FX bindings.</p>
    {:else}
      {#if currentBinding}
        <p class="bound" data-fx-binding-current>
          Currently attached: <strong>{currentBinding.name}</strong>
          <button type="button" data-fx-binding-remove onclick={removeBinding}>Remove binding</button>
        </p>
        {#if currentBinding.flags?.core?.playerCallable !== true}
          <p class="hint">This cue is not currently published for player invocation. Share the timeline below and allow player triggers, or edit it in the FX Wizard.</p>
        {/if}
      {/if}

      <label class="search">Search saved FX timelines
        <input type="search" data-fx-binding-search bind:value={search} placeholder="Fireball, lightning, vines…" />
      </label>
      {#if candidates.length === 0}
        <p class="hint">No saved timelines match. Create one in Macros → FX timelines, then return here. FX presets are reusable looks; save them into a timeline before binding.</p>
      {:else}
        <div class="timeline-list" role="listbox" aria-label="Saved FX timelines" data-fx-binding-options>
          {#each candidates as macro (macro._id)}
            <button type="button" role="option" aria-selected={selectedId === macro._id}
              data-fx-binding-option={macro._id} class:selected={selectedId === macro._id}
              onclick={() => selectTimeline(macro)}>
              <strong>{macro.name}</strong>
              <small>{macro.sequence?.sections.length ?? 0} section(s) · {
                macro.flags?.core?.playerCallable === true ? "player-invokable" : "not player-invokable"}</small>
            </button>
          {/each}
        </div>
      {/if}

      {#if selectedMacro}
        <fieldset class="sharing" data-fx-binding-sharing>
          <legend>Who can see this timeline?</legend>
          <label><input type="radio" name="fx-binding-share" value="gm" checked={shareScope === "gm"}
            onchange={() => changeScope("gm")} />GM / assistants only</label>
          <label><input type="radio" name="fx-binding-share" value="all" checked={shareScope === "all"}
            onchange={() => changeScope("all")} />All players in this world</label>
          <label><input type="radio" name="fx-binding-share" value="selected" checked={shareScope === "selected"}
            onchange={() => changeScope("selected")} />Selected players</label>
          {#if shareScope === "selected"}
            <div class="share-users" data-fx-binding-share-users>
              {#each eligibleUsers as user (user._id)}
                <label><input type="checkbox" data-fx-binding-share-user={user._id}
                  checked={shareUserIds.includes(user._id)}
                  onchange={(event) => toggleUser(user._id, event.currentTarget.checked)} />
                  {user.name} <small>{user.role.toLowerCase()}</small></label>
              {/each}
              {#if eligibleUsers.length === 0}<small>No player accounts are available yet.</small>{/if}
            </div>
          {/if}
          {#if selectedShareError}<p role="alert" data-fx-binding-share-error>{selectedShareError}</p>{/if}
          <label class="callable"><input type="checkbox" data-fx-binding-callable
            bind:checked={playerCallable} />Allow published players to trigger this timeline</label>
          <small>Visibility, player invocation, playback Audience and media rights are separate controls. GM-only visibility still blocks players even when invocation is enabled; the host rechecks access on every request. This never grants actor control.</small>
        </fieldset>

        {#if sequenceAudienceWarning}<p class="warn" data-fx-binding-audience-warning>{sequenceAudienceWarning}</p>{/if}
        {#if selectedMacro.sequence?.sections.some((section) => section.kind === "image" || section.kind === "sound")}
          <p class="hint">This timeline uses media. Review player-serving rights in the FX Wizard before publishing; media rights are enforced separately from macro sharing.</p>
        {/if}
        {#if currentBinding && currentBinding._id !== selectedMacro._id}
          <p class="warn">Remove the existing binding before attaching a different timeline. This prevents two FX cues from competing for the same action.</p>
        {/if}
        <button type="button" class="attach" data-fx-binding-attach
          disabled={!selectedMacro || selectedShareError !== null || (!!currentBinding && currentBinding._id !== selectedMacro._id)}
          onclick={attachSelected}>{currentBinding?._id === selectedMacro._id ? "Save binding & sharing" : "Attach selected timeline"}</button>
      {/if}
    {/if}

    {#if error}<p role="alert" data-fx-binding-error>{error}</p>{/if}
    {#if status}<p role="status" data-fx-binding-status>{status}</p>{/if}
    <footer><small>World FX timelines and presets are included in the World File export. Uploaded media still needs explicit world-archive rights.</small></footer>
  </div>
</div>

<style>
  .fx-binding-backdrop { position: fixed; inset: 0; z-index: 10030; display: flex; align-items: center;
    justify-content: center; padding: 20px; background: rgba(4, 8, 14, .72); }
  .fx-binding-dialog { box-sizing: border-box; width: min(620px, 96vw); max-height: min(82vh, 860px); overflow: auto;
    border: 1px solid #435773; border-radius: 10px; padding: 16px; color: #e0e5ed; background: #18222f;
    box-shadow: 0 18px 56px rgba(0,0,0,.65); }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 1px solid #304257; padding-bottom: 8px; }
  h3 { margin: 0 0 4px; }
  p { margin: 8px 0; }
  .hint, small { color: #9eafc5; }
  .warn { color: #ffd68a; }
  .bound { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 8px; background: #223447; border-radius: 6px; }
  .search { display: grid; gap: 5px; margin: 12px 0; }
  input[type="search"] { width: 100%; box-sizing: border-box; }
  .timeline-list { display: grid; gap: 5px; max-height: 220px; overflow: auto; margin: 8px 0 12px; }
  .timeline-list button { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; padding: 8px 10px;
    border: 1px solid #435773; border-radius: 6px; color: inherit; background: #202b3a; cursor: pointer; }
  .timeline-list button.selected { outline: 2px solid #59b9cc; background: #273e50; }
  .sharing { display: grid; gap: 6px; border: 1px solid #435773; border-radius: 6px; margin: 12px 0; padding: 10px; }
  .sharing label { display: flex; align-items: center; gap: 7px; }
  .share-users { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 4px; padding: 7px; background: #111922; border-radius: 5px; }
  .share-users label { justify-content: flex-start; }
  .callable { margin-top: 4px; font-weight: 600; }
  button { border: 1px solid #506987; border-radius: 5px; padding: 6px 10px; color: inherit; background: #24364a; cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .attach { width: 100%; margin: 8px 0; font-weight: 700; background: #235468; }
  footer { margin-top: 12px; border-top: 1px solid #304257; padding-top: 8px; }
</style>
