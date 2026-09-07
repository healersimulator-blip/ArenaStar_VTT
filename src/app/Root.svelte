<script lang="ts">
  import { onMount } from "svelte";
  import App from "./App.svelte";
  import { detectCapabilities } from "./capabilities";
  import JoinApp from "./JoinApp.svelte";
  import { bootHostApp, type HostApp } from "./hostBoot";
  import { importWorldZip } from "../host/worldFile";
  import { openVttDb } from "../storage/idb";
  import { opfsRoot } from "../storage/opfs";

  type Mode = "picker" | "hosting" | "joining";

  const caps = detectCapabilities();
  const capRows: Array<[string, boolean]> = Object.entries(caps);
  const capsReady = capRows.filter(([, ok]) => ok).length;

  let mode = $state<Mode>("picker");
  let app = $state<HostApp | null>(null);
  let bootError = $state<string | null>(null);
  let importError = $state<string | null>(null);

  async function host(): Promise<void> {
    mode = "hosting";
    bootError = null;
    try {
      app = await bootHostApp();
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
    }
  }

  async function importWorldFile(ev: Event): Promise<void> {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    importError = null;
    try {
      const db = await openVttDb();
      const root = await opfsRoot();
      const imported = await importWorldZip({ db, root, file });
      await hostFrom(imported.worldId);
    } catch (err) {
      importError = err instanceof Error ? err.message : String(err);
      mode = "picker";
    }
  }

  async function hostFrom(worldId: string): Promise<void> {
    mode = "hosting";
    try {
      app = await bootHostApp({ worldId: worldId as HostApp["worldId"] });
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
    }
  }

  onMount(() => {
    return () => app?.close();
  });
</script>

{#if mode === "picker"}
  <main>
    <h1>VTT</h1>
    <p class="sub">browser-only virtual tabletop</p>
    <section class="picker" aria-label="Choose a role">
      <button id="role-host" type="button" onclick={() => void host()}>Host a world</button>
      <button id="role-join" type="button" onclick={() => (mode = "joining")}> Join a game </button>
      <label class="btn">
        Import world file (.zip)
        <input
          id="role-import"
          type="file"
          accept=".zip,application/zip"
          onchange={importWorldFile}
          hidden
        />
      </label>
      {#if importError}
        <p class="error">import failed: {importError}</p>
      {/if}
    </section>
    <section aria-labelledby="caps-h">
      <h2 id="caps-h">Runtime capabilities ({capsReady}/{capRows.length} available)</h2>
      <ul>
        {#each capRows as [name, ok] (name)}
          <li class:ok class:missing={!ok}>
            <span class="dot" aria-hidden="true"></span>
            <span class="name">{name}</span>
            <span class="state">{ok ? "available" : "unavailable"}</span>
          </li>
        {/each}
      </ul>
    </section>
  </main>
{:else if mode === "joining"}
  <JoinApp />
{:else}
  {#if bootError && !app}
    <main>
      <p class="error">boot failed: {bootError}</p>
      <button type="button" onclick={() => (mode = "picker")}>Back</button>
    </main>
  {:else}
    <App {app} {bootError} />
  {/if}
{/if}

<style>
  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: #101014;
    color: #e8e8ee;
    font-family: system-ui, sans-serif;
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 260px;
  }
  button,
  .btn {
    padding: 10px 14px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #1d2127;
    color: #e8e8ee;
    cursor: pointer;
    text-align: center;
  }
  button:hover,
  .btn:hover {
    background: #262b33;
  }
  .error {
    color: #ff6b6b;
  }
  section[aria-labelledby="caps-h"] {
    margin-top: 16px;
  }
  section[aria-labelledby="caps-h"] ul {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  section[aria-labelledby="caps-h"] h2 {
    font-size: 14px;
    color: #aab2c0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #cfd3dc;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555b66;
  }
  .ok .dot {
    background: #2e8b57;
  }
  .missing .dot {
    background: #cd5c5c;
  }
  .state {
    color: #8b93a3;
    margin-left: auto;
  }
</style>
