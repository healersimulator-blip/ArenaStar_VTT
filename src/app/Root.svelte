<script lang="ts">
  /**
   * Top-level router: start screen ⇄ wizard ⇄ hosting ⇄ joining (D-249). Owns the HostApp
   * lifetime: boot on Open/Continue/import/create, close on "Close world…" (back to the start
   * screen, where worlds are listed, exported and deleted) and on page teardown.
   */
  import { onMount, untrack } from "svelte";
  import App from "./App.svelte";
  import JoinApp from "./JoinApp.svelte";
  import { bootHostApp, type HostApp } from "./hostBoot";
  import NewWorldWizard from "../ui/start/NewWorldWizard.svelte";
  import StartScreen from "../ui/start/StartScreen.svelte";

  type Mode = "picker" | "wizard" | "hosting" | "joining";

  let {
    autoHost = false,
    onApp = null,
  }: {
    /** Boot the most recent (or a fresh default) world immediately — the e2e host route (D-045). */
    autoHost?: boolean;
    /** Called with each booted HostApp (and null after it closes) — attaches the e2e surface. */
    onApp?: ((app: HostApp | null) => void | Promise<void>) | null;
  } = $props();

  // Initial value only — `autoHost` is a boot-time switch, not a live prop.
  let mode = $state<Mode>(untrack(() => autoHost) ? "hosting" : "picker");
  let app = $state<HostApp | null>(null);
  let bootError = $state<string | null>(null);
  let wizardPackage = $state<Uint8Array | null>(null);
  // A newly created campaign opens the setup surface once. Returning to an
  // existing world goes directly to the board; Session & world stays available.
  let initialSetup = $state(false);

  async function host(worldId: string | null, fresh = false): Promise<void> {
    initialSetup = fresh;
    mode = "hosting";
    bootError = null;
    try {
      const booted = await bootHostApp(worldId ? { worldId: worldId as HostApp["worldId"] } : {});
      app = booted;
      await onApp?.(booted);
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
    }
  }

  async function closeWorld(): Promise<void> {
    const current = app;
    app = null;
    mode = "picker";
    // AWAITED: the persister's final batched flush must land before the start screen lists
    // or exports this world (D-179) — otherwise the archive would miss the last edits.
    if (current) await current.close();
    await onApp?.(null);
  }

  function openWizard(initialPackage: Uint8Array | null = null): void {
    wizardPackage = initialPackage;
    mode = "wizard";
  }

  onMount(() => {
    if (autoHost) void host(null);
    // Teardown only: nothing replaces the world rows here, so the final flush
    // does not have to be awaited (D-179) — but it must not be left implicit.
    return () => void app?.close();
  });
</script>

{#if mode === "picker"}
  <StartScreen onHost={(id) => void host(id, id === null)} onJoin={() => (mode = "joining")} onNewWorld={openWizard} />
{:else if mode === "wizard"}
  <main class="vtt-ui">
    <NewWorldWizard
      initialPackage={wizardPackage}
      onCancel={() => (mode = "picker")}
      onCreated={(id) => void host(id, true)}
    />
  </main>
{:else if mode === "joining"}
  <JoinApp />
{:else}
  {#if bootError && !app}
    <main class="vtt-ui">
      <p class="error" role="alert">Boot failed: {bootError}</p>
      <button type="button" onclick={() => (mode = "picker")}>Back to start</button>
    </main>
  {:else if app}
    <!-- App wires its canvas, bus listeners and status in onMount from the `app` prop, so it
         must not mount before the boot has produced one (mounting on null left a dead shell:
         no canvas, status "—" — found by the D-248 picker-import e2e). -->
    <App {app} {bootError} {initialSetup} onExit={() => void closeWorld()} />
  {:else}
    <main class="vtt-ui">
      <p class="sub" role="status" data-booting>Starting world…</p>
    </main>
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
      radial-gradient(circle at 28% 8%, #1b403d 0%, transparent 42%),
      radial-gradient(circle at 78% 70%, #202f43 0%, transparent 48%), #0c141d;
    color: #f2f5f8;
  }
  .sub {
    margin: 12px 0 0;
    color: #c1ccd8;
    font-size: 1.1rem;
  }
  .error {
    max-width: 620px;
    margin: 0;
    color: #ffb4b4;
    font-size: 1rem;
    text-align: center;
  }
</style>
