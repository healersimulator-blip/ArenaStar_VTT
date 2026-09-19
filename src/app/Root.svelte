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
    // Teardown only: nothing replaces the world rows here, so the final flush
    // does not have to be awaited (D-179) — but it must not be left implicit.
    return () => void app?.close();
  });
</script>

{#if mode === "picker"}
  <main class="vtt-ui">
    <div class="welcome">
      <p class="eyebrow">ARENASTAR</p>
      <h1>VTT</h1>
      <p class="sub">A browser-only virtual tabletop for playing together.</p>
    </div>
    <section class="picker" aria-label="Choose a role">
      <button id="role-host" type="button" onclick={() => void host()}
        >Host a world</button
      >
      <button id="role-join" type="button" onclick={() => (mode = "joining")}
        >Join a game</button
      >
      <label class="btn" for="role-import">
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
        <p class="error" role="alert">Import failed: {importError}</p>
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
{:else if mode === "joining"}
  <JoinApp />
{:else}
  {#if bootError && !app}
    <main class="vtt-ui">
      <p class="error" role="alert">Boot failed: {bootError}</p>
      <button type="button" onclick={() => (mode = "picker")}
        >Back to start</button
      >
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
  .picker input[type="file"] {
    display: none;
  }
  .error {
    max-width: 620px;
    margin: 0;
    color: #ffb4b4;
    font-size: 1rem;
    text-align: center;
  }
  .capabilities {
    width: min(100%, 620px);
    padding: 18px 20px;
    border: 1px solid #293a4d;
    border-radius: 12px;
    background: #111a25cc;
  }
  .capabilities h2 {
    margin: 0 0 12px;
    color: #dce8f4;
    font-size: 1rem;
  }
  .capabilities ul {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px 16px;
    list-style: none;
    margin: 0;
    padding: 0;
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
  }
</style>
