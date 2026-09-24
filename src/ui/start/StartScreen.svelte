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
  const db = (): Promise<import("idb").IDBPDatabase> =>
    (dbPromise ??= openVttDb());

  const latest = $derived(worlds[0] ?? null);
  const existingForPending = $derived(
    pending?.kind === "world"
      ? (worlds.find((w) => w.worldId === pending.info.worldId) ?? null)
      : null,
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

  const when = (ts: number): string =>
    ts > 0 ? new Date(ts).toLocaleDateString() : "never";

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
      copyName = kind.starter
        ? kind.name.replace(/\s+[—-]\s+starter$/i, "")
        : `${kind.name} (copy)`;
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
        ...(mode === "copy" && copyName.trim()
          ? { name: copyName.trim() }
          : {}),
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
      const blob = await exportWorldZip({
        db: await db(),
        worldId: w.worldId,
        root: await opfsRoot(),
      });
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
  <div class="launcher">
    <div class="launch-top">
      <div class="welcome">
        <div class="welcome-mark" aria-hidden="true">✦</div>
        <p class="eyebrow">ARENASTAR / YOUR TABLE</p>
        <h1>VTT</h1>
        <p class="sub">A place for every adventure.</p>
        <p class="welcome-note">
          Your worlds live on this device. Set the scene, invite your party, and
          let the story unfold.
        </p>
      </div>

      <section class="picker" aria-label="Choose a role">
        <button
          id="role-host"
          type="button"
          disabled={busy}
          onclick={() => onHost(latest?.worldId ?? null)}
        >
          {#if latest}
            Continue “{latest.name}”
          {:else}
            Host a world
          {/if}
        </button>
        <button id="role-join" type="button" onclick={onJoin}
          >Join a game</button
        >
        <button
          id="new-world"
          type="button"
          disabled={busy}
          onclick={() => onNewWorld(null)}
        >
          New world…
          <small>pick a strategic ruleset and content packs</small>
        </button>
        <label class="btn" for="role-import">
          Open file (.zip)
          <small
            >a world file, a starter world, a ruleset or a content pack</small
          >
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
    </div>

    {#if pending}
      <div
        class="dialog"
        role="dialog"
        aria-labelledby="open-h"
        data-open-dialog
        data-open-kind={pending.kind}
      >
        {#if pending.kind === "world"}
          <h2 id="open-h">
            {pending.info.starter ? "Starter world" : "World file"}: {pending
              .info.name}
          </h2>
          <p class="detail" data-open-contents>
            Brings along: {describeWorldContents(pending.info)} · format {pending
              .info.format}
          </p>
          {#if pending.info.starter}
            <p class="detail">
              A starter is a template — it always opens as a fresh world of its
              own.
            </p>
          {/if}
          <label class="field">
            <span>Name for the new world</span>
            <input
              id="open-copy-name"
              type="text"
              bind:value={copyName}
              maxlength="80"
            />
          </label>
          <div class="actions">
            <button
              type="button"
              data-open-cancel
              disabled={busy}
              onclick={() => (pending = null)}>Cancel</button
            >
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
                {existingForPending
                  ? `Restore over “${existingForPending.name}”`
                  : "Restore (keep its id)"}
              </button>
            {/if}
            <button
              type="button"
              class="primary"
              data-open-copy
              disabled={busy}
              onclick={() => void importPending("copy")}
            >
              Open as new world
            </button>
          </div>
        {:else}
          <h2 id="open-h">{describePackage(pending.manifest)}</h2>
          <p class="detail" data-open-contents>
            This is a package, not a world. A {pending.manifest.type ===
            "system"
              ? "strategic ruleset"
              : "content pack"} is chosen when a world is created (or added under
            Settings inside an open world).
          </p>
          <div class="actions">
            <button
              type="button"
              data-open-cancel
              onclick={() => (pending = null)}>Cancel</button
            >
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
          None yet. Host a world for a quick start, or New world… to pick a
          strategic ruleset.
        </p>
      {:else}
        <div class="rows">
          {#each worlds as w (w.worldId)}
            <div class="world" data-world-row data-world-id={w.worldId}>
              <div class="meta">
                <span class="name" data-world-name>{w.name}</span>
                <span class="detail"
                  >{rulesetLabel(w)} · opened {when(w.lastOpened)}</span
                >
              </div>
              <div class="row-actions">
                <button
                  type="button"
                  data-world-open
                  disabled={busy}
                  onclick={() => onHost(w.worldId)}>Open</button
                >
                <button
                  type="button"
                  data-world-export
                  disabled={busy}
                  onclick={() => void exportWorld(w)}
                >
                  Export
                </button>
                <button
                  type="button"
                  class:danger={confirmDeleteId === w.worldId}
                  data-world-delete
                  data-world-delete-armed={confirmDeleteId === w.worldId
                    ? "true"
                    : undefined}
                  disabled={busy}
                  onclick={() => void deleteWorld(w)}
                >
                  {confirmDeleteId === w.worldId
                    ? "Delete? (click again)"
                    : "Delete"}
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <details class="capabilities">
      <summary id="caps-h"
        >Runtime capabilities ({capsReady}/{capRows.length} available)</summary
      >
      <ul>
        {#each capRows as [name, ok] (name)}
          <li class:ok class:missing={!ok}>
            <span class="dot" aria-hidden="true"></span>
            <span class="name">{name}</span>
            <span class="state">{ok ? "Available" : "Unavailable"}</span>
          </li>
        {/each}
      </ul>
    </details>
  </div>
</main>

<style>
  main {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 42px clamp(18px, 4vw, 64px);
    background:
      radial-gradient(circle at 24% 4%, #193c3a 0%, transparent 37%),
      radial-gradient(circle at 82% 65%, #202f43 0%, transparent 45%), #0c141d;
    color: #f1f8f7;
  }
  .launcher {
    width: min(100%, 1030px);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .launch-top {
    display: grid;
    grid-template-columns: minmax(260px, 1fr) minmax(420px, 1.12fr);
    align-items: center;
    gap: clamp(26px, 4vw, 56px);
    padding: clamp(26px, 3vw, 40px);
    border: 1px solid #3e5b61;
    border-radius: 20px;
    background: linear-gradient(135deg, #1d3639e6, #192835fa 58%, #17232e);
    box-shadow: 0 24px 80px #030b13a1;
  }
  .welcome {
    max-width: 380px;
  }
  .welcome-mark {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-bottom: 26px;
    border-radius: 13px;
    background: linear-gradient(145deg, #8be8d0, #459d99);
    box-shadow: 0 6px 22px #70deba35;
    color: #142933;
    font-size: 1.8rem;
  }
  .eyebrow {
    margin: 0 0 6px;
    color: #9ce8d5;
    font-size: 0.73rem;
    font-weight: 800;
    letter-spacing: 0.17em;
  }
  h1 {
    margin: 0;
    font-size: clamp(3.4rem, 7vw, 5.1rem);
    line-height: 1;
    font-weight: 800;
    letter-spacing: -0.05em;
  }
  .sub {
    margin: 13px 0 0;
    color: #f3fbf9;
    font-size: clamp(1.1rem, 2vw, 1.4rem);
    font-weight: 630;
    letter-spacing: -0.02em;
  }
  .welcome-note {
    margin: 10px 0 0;
    color: #b4c8cc;
    font-size: 0.92rem;
    line-height: 1.6;
  }
  .picker {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .picker button,
  .picker .btn {
    display: flex;
    flex-direction: column;
    justify-content: center;
    width: 100%;
    min-height: 90px !important;
    padding: 15px 16px;
    border: 1px solid #4b6570;
    border-radius: 12px;
    background: #22313e;
    color: #f1f8f7;
    cursor: pointer;
    text-align: left;
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.3;
    transition:
      background 0.16s,
      border-color 0.16s,
      transform 0.16s;
  }
  .picker button:first-child {
    border-color: #6ecab7;
    background: #28645c;
    color: #fff;
  }
  .picker button:hover,
  .picker .btn:hover {
    transform: translateY(-2px);
    border-color: #88d7c7;
    background: #2b4c52;
  }
  .picker button:first-child:hover {
    background: #37786d;
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
    margin-top: 5px;
    color: #c1d5d9;
    font-size: 0.77rem;
    font-weight: 450;
    line-height: 1.35;
  }
  .error {
    margin: 0;
    color: #ffb8b0;
    font-size: 0.92rem;
  }
  .notice {
    margin: 0;
    color: #93e2bc;
    font-size: 0.92rem;
  }
  .picker > .error,
  .picker > .notice {
    grid-column: 1 / -1;
  }
  .dialog,
  .worlds,
  .capabilities {
    width: 100%;
    padding: 20px 24px;
    border: 1px solid #3a5260;
    border-radius: 14px;
    background: #172430ec;
  }
  .dialog {
    border-color: #63bdaa;
    box-shadow: 0 14px 42px #0007;
  }
  .dialog h2,
  .worlds h2 {
    margin: 0 0 12px;
    color: #f3f9f8;
    font-size: 1.06rem;
  }
  .detail {
    margin: 0;
    color: #b6c8ce;
    font-size: 0.86rem;
    line-height: 1.5;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 12px 0;
    color: #d2e1e3;
    font-size: 0.86rem;
  }
  .field input {
    padding: 9px 12px;
    border: 1px solid #54707a;
    border-radius: 8px;
    background: #1e303d;
    color: #fff;
    font-size: 1rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
  }
  .dialog button,
  .row-actions button {
    min-height: 38px;
    padding: 7px 12px;
    border: 1px solid #536c77;
    border-radius: 8px;
    background: #263845;
    color: #f1f8f7;
    font-weight: 650;
    cursor: pointer;
  }
  .dialog button:hover,
  .row-actions button:hover {
    background: #30515a;
    border-color: #8cddc9;
  }
  .dialog button.primary,
  .row-actions [data-world-open] {
    border-color: #5fb29f;
    background: #28645c;
  }
  .row-actions button.danger {
    border-color: #d48e89;
    background: #683839;
  }
  .dialog button:disabled,
  .row-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .world {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 14px 0;
    border-top: 1px solid #324955;
  }
  .world:first-child {
    border-top: 0;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .meta .name {
    overflow: hidden;
    color: #f1f8f7;
    font-weight: 720;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-actions {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 6px;
  }
  .capabilities {
    padding-block: 13px;
  }
  .capabilities summary {
    color: #a9c1c4;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 650;
  }
  .capabilities summary:hover {
    color: #e8fbf4;
  }
  .capabilities ul {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 7px 16px;
    list-style: none;
    margin: 14px 0 0;
    padding: 0;
  }
  .capabilities li {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 26px;
    color: #d1e0e3;
    font-size: 0.86rem;
  }
  .dot {
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #7b8d97;
  }
  .ok .dot {
    background: #71dec2;
    box-shadow: 0 0 0 3px #71dec21d;
  }
  .missing .dot {
    background: #e9908c;
  }
  .state {
    margin-left: auto;
    color: #a7b8bf;
  }
  @media (max-width: 840px) {
    .launch-top {
      grid-template-columns: 1fr;
      gap: 26px;
    }
    .welcome {
      max-width: 600px;
    }
    .welcome-mark {
      margin-bottom: 16px;
    }
  }
  @media (max-width: 560px) {
    main {
      align-items: stretch;
      padding: 22px 12px;
    }
    .launch-top {
      padding: 22px 16px;
    }
    .picker {
      grid-template-columns: 1fr;
    }
    .picker button,
    .picker .btn {
      min-height: 58px !important;
    }
    .world {
      flex-direction: column;
      align-items: stretch;
    }
    .row-actions button {
      flex: 1 1 auto;
    }
    .dialog,
    .worlds,
    .capabilities {
      padding-inline: 16px;
    }
    .capabilities ul {
      grid-template-columns: 1fr;
    }
  }
</style>
