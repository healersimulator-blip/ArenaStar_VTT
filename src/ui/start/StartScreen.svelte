<script lang="ts">
  /**
   * Start screen (D-249, proposal §6.1/§6.2): the worlds on this device, one "Open file"
   * entry for every kind of zip, and the way into the New-world wizard. Rulesets and content
   * packs are never loaded from here on their own — they arrive inside a world file or are
   * chosen in the wizard — which is the whole point: a GM handles one file per campaign.
   */
  import { onDestroy, onMount } from "svelte";
  import { detectCapabilities } from "../../app/capabilities";
  import { BUILTIN_SYSTEM_ID } from "../../app/hostBoot";
  import { exportWorldZip, importWorldZip } from "../../host/worldFile";
  import {
    classifyZip,
    describePackage,
    describeWorldContents,
    type WorldZipInfo,
  } from "../../host/zipKind";
  import type { PackageManifest } from "../../core/packageManifest";
  import {
    deleteWorldData,
    listWorlds,
    openVttDb,
    type WorldId,
    type WorldsRecord,
  } from "../../storage/idb";
  import { deleteWorldFiles, opfsRoot } from "../../storage/opfs";

  let {
    onHost,
    onJoin,
    onNewWorld,
  }: {
    /** Boot a world; null = most recent (or a fresh default world when there is none). */
    onHost: (worldId: string | null) => void;
    onJoin: () => void;
    /** Open the wizard, optionally pre-loaded with a package zip the GM picked here. */
    onNewWorld: (initialPackage?: Uint8Array | null) => void;
  } = $props();

  type Pending =
    | { kind: "world"; info: WorldZipInfo; bytes: Uint8Array }
    | { kind: "package"; manifest: PackageManifest; bytes: Uint8Array };

  const caps = detectCapabilities();
  const capRows: Array<[string, boolean]> = Object.entries(caps);
  const capsReady = capRows.filter(([, ok]) => ok).length;

  let worlds = $state<WorldsRecord[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busy = $state(false);
  let pending = $state<Pending | null>(null);
  let copyName = $state("");
  let confirmDeleteId = $state<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let fileInput = $state<HTMLInputElement | null>(null);

  let dbPromise: Promise<import("idb").IDBPDatabase> | null = null;
  const db = (): Promise<import("idb").IDBPDatabase> => (dbPromise ??= openVttDb());

  const latest = $derived(worlds[0] ?? null);
  const existingForPending = $derived(
    pending?.kind === "world" ? (worlds.find((w) => w.worldId === pending.info.worldId) ?? null) : null,
  );

  async function refresh(): Promise<void> {
    try {
      worlds = await listWorlds(await db());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loaded = true;
    }
  }

  const rulesetLabel = (w: WorldsRecord): string =>
    w.system === BUILTIN_SYSTEM_ID || !w.activeRulesPackage
      ? "built-in strategic rules"
      : `${w.system} v${w.version}`;

  const when = (ts: number): string => (ts > 0 ? new Date(ts).toLocaleDateString() : "never");

  async function pickFile(): Promise<void> {
    const file = fileInput?.files?.[0];
    if (!file) return;
    error = null;
    notice = null;
    pending = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = await classifyZip(bytes);
      if (kind.kind === "unknown") {
        error = kind.reason;
        return;
      }
      if (kind.kind === "package") {
        pending = { kind: "package", manifest: kind.manifest, bytes };
        return;
      }
      pending = { kind: "world", info: kind, bytes };
      // A starter is a template: its copy is the campaign, so it drops the " — starter" tag.
      copyName = kind.starter ? kind.name.replace(/\s+[—-]\s+starter$/i, "") : `${kind.name} (copy)`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (fileInput) fileInput.value = "";
    }
  }

  async function importPending(mode: "replace" | "copy"): Promise<void> {
    if (pending?.kind !== "world") return;
    busy = true;
    error = null;
    try {
      const imported = await importWorldZip({
        db: await db(),
        root: await opfsRoot(),
        file: pending.bytes,
        mode,
        ...(mode === "copy" && copyName.trim() ? { name: copyName.trim() } : {}),
      });
      pending = null;
      onHost(imported.worldId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function exportWorld(w: WorldsRecord): Promise<void> {
    busy = true;
    error = null;
    try {
      const blob = await exportWorldZip({ db: await db(), worldId: w.worldId, root: await opfsRoot() });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `world-${w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
      notice = `Exported “${w.name}”.`;
    } catch (err) {
      error = `export failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busy = false;
    }
  }

  /** Two-step delete: first click arms the row for 4 s, second click deletes. */
  async function deleteWorld(w: WorldsRecord): Promise<void> {
    if (confirmDeleteId !== w.worldId) {
      confirmDeleteId = w.worldId;
      if (confirmTimer !== null) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => (confirmDeleteId = null), 4_000);
      return;
    }
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmDeleteId = null;
    busy = true;
    error = null;
    try {
      await deleteWorldData(await db(), w.worldId as WorldId);
      await deleteWorldFiles(await opfsRoot(), w.worldId as WorldId);
      notice = `Deleted “${w.name}”.`;
      await refresh();
    } catch (err) {
      error = `delete failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busy = false;
    }
  }

  onMount(() => void refresh());
  onDestroy(() => {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    void dbPromise?.then((d) => d.close()).catch(() => {});
  });
</script>

<main class="vtt-ui">
  <div class="welcome">
    <p class="eyebrow">ARENASTAR</p>
    <h1>VTT</h1>
    <p class="sub">A browser-only virtual tabletop for playing together.</p>
  </div>

  <section class="picker" aria-label="Choose a role">
    <button id="role-host" type="button" disabled={busy} onclick={() => onHost(latest?.worldId ?? null)}>
      {#if latest}
        Continue “{latest.name}”
      {:else}
        Host a world
      {/if}
    </button>
    <button id="role-join" type="button" onclick={onJoin}>Join a game</button>
    <button id="new-world" type="button" disabled={busy} onclick={() => onNewWorld(null)}>
      New world…
      <small>pick a strategic ruleset and content packs</small>
    </button>
    <label class="btn" for="role-import">
      Open file (.zip)
      <small>a world file, a starter world, a ruleset or a content pack</small>
      <input
        id="role-import"
        type="file"
        accept=".zip,application/zip"
        bind:this={fileInput}
        onchange={() => void pickFile()}
        hidden
      />
    </label>
    {#if error}
      <p class="error" role="alert" data-import-error>{error}</p>
    {/if}
    {#if notice}
      <p class="notice" role="status" data-start-notice>{notice}</p>
    {/if}
  </section>

  {#if pending}
    <div class="dialog" role="dialog" aria-labelledby="open-h" data-open-dialog data-open-kind={pending.kind}>
      {#if pending.kind === "world"}
        <h2 id="open-h">{pending.info.starter ? "Starter world" : "World file"}: {pending.info.name}</h2>
        <p class="detail" data-open-contents>
          Brings along: {describeWorldContents(pending.info)} · format {pending.info.format}
        </p>
        {#if pending.info.starter}
          <p class="detail">A starter is a template — it always opens as a fresh world of its own.</p>
        {/if}
        <label class="field">
          <span>Name for the new world</span>
          <input id="open-copy-name" type="text" bind:value={copyName} maxlength="80" />
        </label>
        <div class="actions">
          <button type="button" data-open-cancel disabled={busy} onclick={() => (pending = null)}>Cancel</button>
          {#if !pending.info.starter}
            <button
              type="button"
              data-open-replace
              disabled={busy}
              title={existingForPending
                ? `Overwrites the local world “${existingForPending.name}” (${existingForPending.worldId}) with the archive`
                : `Restores the archive under its own id (${pending.info.worldId})`}
              onclick={() => void importPending("replace")}
            >
              {existingForPending ? `Restore over “${existingForPending.name}”` : "Restore (keep its id)"}
            </button>
          {/if}
          <button type="button" class="primary" data-open-copy disabled={busy} onclick={() => void importPending("copy")}>
            Open as new world
          </button>
        </div>
      {:else}
        <h2 id="open-h">{describePackage(pending.manifest)}</h2>
        <p class="detail" data-open-contents>
          This is a package, not a world. A {pending.manifest.type === "system"
            ? "strategic ruleset"
            : "content pack"} is chosen when a world is created (or added under Settings inside an open
          world).
        </p>
        <div class="actions">
          <button type="button" data-open-cancel onclick={() => (pending = null)}>Cancel</button>
          <button
            type="button"
            class="primary"
            data-open-wizard
            onclick={() => {
              const bytes = pending?.bytes ?? null;
              pending = null;
              onNewWorld(bytes);
            }}
          >
            New world with it…
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <section class="worlds" aria-labelledby="worlds-h" data-world-list>
    <h2 id="worlds-h">Worlds on this device</h2>
    {#if !loaded}
      <p class="detail">Loading…</p>
    {:else if worlds.length === 0}
      <p class="detail" data-world-empty>
        None yet. Host a world for a quick start, or New world… to pick a strategic ruleset.
      </p>
    {:else}
      <div class="rows">
        {#each worlds as w (w.worldId)}
          <div class="world" data-world-row data-world-id={w.worldId}>
            <div class="meta">
              <span class="name" data-world-name>{w.name}</span>
              <span class="detail">{rulesetLabel(w)} · opened {when(w.lastOpened)}</span>
            </div>
            <div class="row-actions">
              <button type="button" data-world-open disabled={busy} onclick={() => onHost(w.worldId)}>Open</button>
              <button type="button" data-world-export disabled={busy} onclick={() => void exportWorld(w)}>
                Export
              </button>
              <button
                type="button"
                class:danger={confirmDeleteId === w.worldId}
                data-world-delete
                data-world-delete-armed={confirmDeleteId === w.worldId ? "true" : undefined}
                disabled={busy}
                onclick={() => void deleteWorld(w)}
              >
                {confirmDeleteId === w.worldId ? "Delete? (click again)" : "Delete"}
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="capabilities" aria-labelledby="caps-h">
    <h2 id="caps-h">
      Runtime capabilities ({capsReady}/{capRows.length} available)
    </h2>
    <ul>
      {#each capRows as [name, ok] (name)}
        <li class:ok class:missing={!ok}>
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{name}</span>
          <span class="state">{ok ? "Available" : "Unavailable"}</span>
        </li>
      {/each}
    </ul>
  </section>
</main>

<style>
  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: clamp(24px, 6vw, 72px) 20px;
    background:
      radial-gradient(circle at 50% 0%, #243b55 0%, transparent 48%), #0d1117;
    color: #f2f5f8;
  }
  .welcome {
    max-width: 620px;
    text-align: center;
  }
  .eyebrow {
    margin: 0 0 8px;
    color: #66b7ff;
    font-size: 0.8rem;
    font-weight: 800;
    letter-spacing: 0.18em;
  }
  h1 {
    margin: 0;
    font-size: clamp(2.25rem, 6vw, 4rem);
    line-height: 1.05;
    letter-spacing: -0.035em;
  }
  .sub {
    margin: 12px 0 0;
    color: #c1ccd8;
    font-size: 1.1rem;
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(100%, 360px);
  }
  .picker button,
  .picker .btn {
    min-height: 50px !important;
    padding: 12px 18px;
    border: 1px solid #49627d;
    border-radius: 10px;
    background: #182331;
    color: #f2f5f8;
    cursor: pointer;
    text-align: center;
    font-size: 1rem;
    font-weight: 700;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      transform 120ms ease;
  }
  .picker button:first-child {
    background: #1f5f8f;
    border-color: #68b9f2;
  }
  .picker button:hover,
  .picker .btn:hover {
    background: #29415a;
    border-color: #79c5ff;
    transform: translateY(-1px);
  }
  .picker button:first-child:hover {
    background: #2878ae;
  }
  .picker button:disabled {
    opacity: 0.6;
    cursor: default;
    transform: none;
  }
  .picker input[type="file"] {
    display: none;
  }
  .picker small,
  .picker .btn small {
    display: block;
    margin-top: 2px;
    font-size: 0.75rem;
    font-weight: 400;
    opacity: 0.7;
  }
  .error {
    max-width: 620px;
    margin: 0;
    color: #ffb4b4;
    font-size: 1rem;
    text-align: center;
  }
  .notice {
    margin: 0;
    color: #9fe1c0;
    font-size: 0.95rem;
    text-align: center;
  }
  .dialog,
  .worlds,
  .capabilities {
    width: min(100%, 620px);
    padding: 18px 20px;
    border: 1px solid #293a4d;
    border-radius: 12px;
    background: #111a25cc;
  }
  .dialog {
    border-color: #68b9f2;
  }
  .dialog h2,
  .worlds h2,
  .capabilities h2 {
    margin: 0 0 12px;
    color: #dce8f4;
    font-size: 1rem;
  }
  .detail {
    margin: 0;
    color: #aebdcb;
    font-size: 0.85rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 12px 0;
    font-size: 0.85rem;
    color: #c1ccd8;
  }
  .field input {
    padding: 8px 10px;
    border: 1px solid #49627d;
    border-radius: 8px;
    background: #182331;
    color: #f2f5f8;
    font-size: 1rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .dialog button,
  .row-actions button {
    min-height: 36px;
    padding: 6px 12px;
    border: 1px solid #49627d;
    border-radius: 8px;
    background: #182331;
    color: #f2f5f8;
    font-weight: 700;
    cursor: pointer;
  }
  .dialog button.primary {
    background: #1f5f8f;
    border-color: #68b9f2;
  }
  .row-actions button.danger {
    background: #6b2b2b;
    border-color: #ee7777;
  }
  .dialog button:disabled,
  .row-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .capabilities ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .world {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid #1f2b3a;
  }
  .world:first-child {
    border-top: 0;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .meta .name {
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-actions {
    display: flex;
    gap: 6px;
    flex: 0 0 auto;
  }
  .capabilities ul {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px 16px;
  }
  .capabilities li {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 28px;
    color: #d5e0eb;
    font-size: 0.9rem;
  }
  .dot {
    width: 10px;
    height: 10px;
    flex: 0 0 10px;
    border-radius: 50%;
    background: #69798a;
    box-shadow: 0 0 0 3px #69798a22;
  }
  .ok .dot {
    background: #4fd09a;
    box-shadow: 0 0 0 3px #4fd09a22;
  }
  .missing .dot {
    background: #ee7777;
    box-shadow: 0 0 0 3px #ee777722;
  }
  .state {
    margin-left: auto;
    color: #aebdcb;
  }
  @media (max-width: 560px) {
    main {
      justify-content: flex-start;
      padding-top: 48px;
    }
    .capabilities ul {
      grid-template-columns: 1fr;
    }
    .world {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
