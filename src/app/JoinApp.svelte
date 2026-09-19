<script lang="ts">
  import { onMount } from "svelte";
  import { bootPlayerApp, type PlayerApp } from "./joinBoot";
  import { parseInvite } from "./hostShare";
  import { createStage, type Stage } from "../canvas/stage";
  import {
    CanvasController,
    domPointerSource,
    type TokenView,
  } from "../canvas/interactions";
  import { can } from "../core/permissions";
  import { ChatPanel } from "../ui/chat";
  import { WindowManager } from "../core/windows";
  import { WindowHost } from "../ui/windows";
  import { openPF1eSheetWindow } from "../ui/sheets/pf1eSheetWindow";
  import { SheetPanel } from "../ui/sheets";
  import type { ActorDocument, SceneDocument, SceneGrid } from "../core/documents";
  import type { Op } from "../core/ops";
  import { copyText } from "../ui/clipboard";
  import { FogExploration } from "../client/fogExploration";
  import { createVisionComputer } from "../workers/visionComputer";

  let app = $state<PlayerApp | null>(null);
  let phase = $state<"invite" | "exchange" | "live" | "dead">("invite");
  let joinError = $state<string | null>(null);
  let inviteText = $state("");
  let answerText = $state("");
  let hostCode = $state("");

  let worldName = $state("—");
  let seq = $state(0);
  let tokenCount = $state(0);
  let playerName = $state("");
  let connState = $state("new");
  let copyStatus = $state("");
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  const wm = new WindowManager({ width: 800, height: 600 });
  let wmVersion = $state(0);
  const wmWindows = $derived.by(() => {
    void wmVersion;
    return [...wm.list()];
  });

  function openActorSheet(actorId: string): void {
    if (!app?.client) return;
    const rect = canvasHost?.getBoundingClientRect();
    openPF1eSheetWindow(
      wm,
      app.client,
      actorId,
      rect ? { width: rect.width, height: rect.height } : undefined,
    );
  }

  let canvasHost = $state<HTMLDivElement | null>(null);
  let canvasError = $state<string | null>(null);
  let loadedMapHash: string | null = null;
  let stage: Stage | null = null;
  let controller: CanvasController | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** D-250: this player's explored fog — revealed by the tokens they control, kept by the host. */
  let fog: FogExploration | null = null;

  async function connect(inviteRaw: string): Promise<void> {
    joinError = null;
    const invite = parseInvite(inviteRaw);
    if (!invite) {
      joinError = "invite must look like #room=<id>&k=<secret>";
      return;
    }
    phase = "exchange";
    try {
      const playerApp = await bootPlayerApp({ invite });
      app = playerApp;
      playerName = playerApp.displayName;
      playerApp.onDisconnected = (reason) => {
        phase = "dead";
        connState = `disconnected (${reason})`;
      };
      playerApp.onConnectionState = (state) => {
        connState = state;
        if (state === "connected" && playerApp.client) phase = "live";
      };
      void playerApp.ready.then(() => {
        phase = "live";
        mountCanvas();
      });
      if (new URLSearchParams(globalThis.location.search).has("e2e")) {
        void import("./e2eHook").then((m) => m.installPlayerE2e(playerApp));
      }
    } catch (err) {
      joinError = err instanceof Error ? err.message : String(err);
      phase = "invite";
    }
  }

  function applyAnswer(): void {
    const code = answerText.trim();
    if (code && app) {
      void app.receiveCode(code).catch((err: unknown) => {
        joinError = err instanceof Error ? err.message : String(err);
        phase = "exchange";
      });
    }
    answerText = "";
  }

  async function copyCode(value: string, label: string): Promise<void> {
    const copied = await copyText(value);
    copyStatus = copied
      ? `${label} copied to clipboard.`
      : `Select the ${label.toLowerCase()} and copy it manually.`;
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copyStatus = ""), 4_000);
  }

  function clearCopyTimer(): void {
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = null;
  }

  function activeScene(): SceneDocument | null {
    const client = app?.client;
    if (!client) return null;
    const scene = client.store.get("scenes", "scene-1");
    return (
      scene ??
      (client.store.getAll("scenes") as readonly SceneDocument[])[0] ??
      null
    );
  }

  function tokenViews(): TokenView[] {
    const scene = activeScene();
    if (!scene) return [];
    return scene.tokens.map((token) => ({ token, sceneId: scene._id }));
  }

  function squareGrid(
    grid: SceneGrid | undefined,
  ): { type: "square"; size: number } | null {
    if (grid && grid.type === "square" && grid.size > 0)
      return { type: "square", size: grid.size };
    return null;
  }

  function refresh(): void {
    const current = app;
    const view = stage;
    const client = current?.client;
    if (!current || !view || !client) return;
    const scene = activeScene();
    worldName = client.world?.name ?? "—";
    seq = client.store.seq;
    tokenCount = scene?.tokens.length ?? 0;
    view.syncTokens(scene?.tokens ?? []);
    void fog?.sync(scene, { shown: true });
    const img = scene?.img ?? null;
    if (img !== null && img !== loadedMapHash && current.fetcher) {
      loadedMapHash = img;
      const manifest = client.store.world.assetManifest[img];
      const mime = manifest?.mime ?? "image/png";
      // §7 thumbnail-first: preview paints immediately; full replaces async
      const thumb = manifest?.thumb;
      if (thumb && thumb.hash !== img) {
        void current.fetcher
          .request(thumb.hash, "ui")
          .then((bytes) => view.setBackgroundImage(bytes, thumb.mime))
          .catch(() => undefined);
      }
      void current.fetcher
        .request(img, "scene")
        .then((bytes) => view.setBackgroundImage(bytes, mime))
        .catch(() => undefined);
    }
    const grid = squareGrid(scene?.grid);
    if (grid) view.setGrid(grid);
  }

  function mountCanvas(): void {
    void (async () => {
      try {
        const current = app;
        if (!current?.client) return;
        const client = current.client;
        await current.ready;
        const scene = activeScene();
        const hostElement = canvasHost;
        if (!hostElement) return;
        const width = Math.max(320, hostElement.clientWidth);
        const height = Math.max(240, hostElement.clientHeight);
        const view = await createStage({ width, height, hostElement });
        stage = view;
        view.fit(scene?.width ?? 2000, scene?.height ?? 1500);
        fog = new FogExploration({
          surfaceFor: (sc) => view.getFogLayer({ width: sc.width, height: sc.height }),
          hideSurface: () => view.hideFogLayer(),
          computer: createVisionComputer(),
          transport: client,
          user: () => client.user,
          actors: () => client.store.getAll("actors") as readonly ActorDocument[],
          onError: (where, error) => console.warn(`fog ${where} failed`, error),
        });
        // a reconnect may reach a host session holding a map this tab never saw
        client.bus.on("welcome", () => void fog?.refreshStored());
        controller = new CanvasController({
          onTokenActivate: ({ token }) => {
            if (token.actorId) openActorSheet(token.actorId);
          },
          stage: view,
          source: domPointerSource(view.app.canvas as HTMLCanvasElement),
          client: {
            submit: (ops: Op[]) => client.submit(ops),
          },
          getTokens: tokenViews,
          getGrid: () => squareGrid(activeScene()?.grid),
          // §5: players move only tokens they own (host re-validates anyway)
          canMove: (tokenView) => {
            const user = client.user;
            if (!user) return false;
            const scene = activeScene();
            return can(
              user,
              "update",
              tokenView.token,
              "tokens",
              scene ? { parent: scene } : {},
            );
          },
        });
        client.bus.on("snapshot", refresh);
        client.bus.on("ops", refresh);
        refresh();
        view.render();
      } catch (err) {
        canvasError = err instanceof Error ? err.message : String(err);
      }
    })();
  }

  onMount(() => {
    const offWm = wm.onChange(() => wmVersion++);
    // auto-join from an invite fragment (?…#room=<id>&k=<secret>)
    const hash = globalThis.location.hash;
    if (hash.length > 1 && hash.includes("room=")) {
      inviteText = hash.slice(1);
      void connect(hash);
    }
    // Mirror poll (non-destructive): shows the latest code without draining
    // the outbox — e2e surfaces drain it directly (D-062).
    pollTimer = setInterval(() => {
      const code = app?.adapter.lastSentCode;
      if (code) hostCode = code;
    }, 250);
    const onPageHide = (): void => void fog?.flush(); // D-250: last reveal before unload
    globalThis.addEventListener("pagehide", onPageHide);
    return () => {
      globalThis.removeEventListener("pagehide", onPageHide);
      offWm();
      clearCopyTimer();
      if (pollTimer !== null) clearInterval(pollTimer);
      controller?.destroy();
      fog?.destroy();
      fog = null;
      stage?.destroy();
      stage = null;
      app?.close();
    };
  });
</script>

<main class="vtt-ui">
  <header class="join-header">
    <p class="eyebrow">ARENASTAR</p>
    <h1>Join a game</h1>
    <p class="sub">
      Connect to a host with an invite link and a short manual code exchange.
    </p>
  </header>
  {#if joinError}
    <p class="error" role="alert">{joinError}</p>
  {/if}

  {#if phase === "invite"}
    <section class="join-panel" aria-label="Join a game">
      <div class="panel-heading">
        <h2>Game invite</h2>
        <p>
          Paste the invite link or the full <code>#room=…&amp;k=…</code> fragment
          from the host.
        </p>
      </div>
      <label for="invite-input">Invite link or room fragment</label>
      <textarea
        id="invite-input"
        rows="3"
        bind:value={inviteText}
        placeholder="#room=…&amp;k=…"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"></textarea>
      <button
        id="join-connect"
        type="button"
        onclick={() => void connect(inviteText)}
      >
        Connect to game
      </button>
    </section>
  {:else if phase === "exchange" || phase === "dead"}
    <section class="join-panel exchange-panel" aria-label="Signaling exchange">
      {#if phase === "dead"}
        <p class="error" id="disconnect-notice" role="alert">
          Host disconnected — connection lost.
        </p>
      {/if}
      <div class="panel-heading">
        <h2>Secure connection</h2>
        <p>
          Copy your code to the host. Then paste the host's answer below and
          apply it.
        </p>
      </div>
      <div class="code-field">
        <label for="offer-out"
          >Your player code <span class="required-note">(send to host)</span
          ></label
        >
        <textarea
          id="offer-out"
          class="signal-code"
          rows="5"
          readonly
          value={hostCode}
          spellcheck="false"
          aria-describedby="offer-help"></textarea>
        <div class="field-actions">
          <button
            id="copy-offer-out"
            class="secondary"
            type="button"
            disabled={!hostCode}
            onclick={() => void copyCode(hostCode, "player code")}
            >Copy player code</button
          >
          <p id="offer-help" class="hint">
            Give this one-time code to the host.
          </p>
        </div>
      </div>
      <div class="code-field">
        <label for="answer-input">Host's answer code</label>
        <textarea
          id="answer-input"
          class="signal-code"
          rows="5"
          bind:value={answerText}
          placeholder="Paste the host's answer here"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"></textarea>
      </div>
      <button id="answer-apply" type="button" onclick={applyAnswer}
        >Apply host code</button
      >
      <p class="hint status-line" aria-live="polite">
        Connection state: <strong>{connState}</strong>
      </p>
      {#if copyStatus}<p class="copy-status" role="status">{copyStatus}</p>{/if}
    </section>
  {/if}

  {#if phase === "live" || phase === "dead"}
    {#if canvasError}
      <p class="error">canvas: {canvasError}</p>
    {/if}
    <section class="shell" aria-label="Player shell">
      <aside class="sidebar">
        <div id="pstatus">
          <strong>{worldName}</strong>
          <span>{playerName}</span>
          <span>seq {seq}</span>
          <span>tokens {tokenCount}</span>
        </div>
        {#if app?.client}
          <ChatPanel client={app.client} bus={app.bus} />
          <SheetPanel
            client={app.client}
            bus={app.bus}
            onOpenActor={openActorSheet}
          />
        {/if}
      </aside>
      <div class="canvas-area">
        <div
          class="canvas-host"
          bind:this={canvasHost}
          role="application"
          aria-label="Game board"
          tabindex="-1"
        ></div>
        {#if app?.client}
          <WindowHost
            manager={wm}
            windows={wmWindows}
            client={app.client}
            bus={app.bus}
            onUndo={() => undefined}
            onRedo={() => undefined}
          />
        {/if}
      </div>
    </section>
  {/if}
</main>

<style>
  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    padding: clamp(24px, 4vw, 48px) clamp(16px, 4vw, 56px);
    background:
      radial-gradient(circle at 85% 0%, #203d56 0%, transparent 42%), #0d1117;
  }
  .join-header {
    width: min(100%, 760px);
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
    color: #f4f7fb;
    font-size: clamp(2rem, 5vw, 3.25rem);
    line-height: 1.1;
    letter-spacing: -0.03em;
  }
  .sub {
    max-width: 620px;
    margin: 10px auto 0;
    color: #bdc9d6;
    font-size: 1.05rem;
  }
  .join-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(100%, 720px);
    margin: 0;
    padding: clamp(18px, 3vw, 28px);
    border: 1px solid #41566d;
    border-radius: 14px;
    background: #151f2aee;
    box-shadow: 0 16px 40px #0005;
  }
  .panel-heading h2 {
    margin: 0;
    color: #f2f5f8;
    font-size: 1.35rem;
  }
  .panel-heading p {
    margin: 6px 0 0;
    color: #bdc9d6;
    font-size: 0.95rem;
  }
  code {
    padding: 2px 5px;
    border: 1px solid #405369;
    border-radius: 4px;
    background: #0d151f;
    color: #c6e5ff;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  label {
    font-weight: 700;
  }
  textarea {
    width: 100%;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 1rem;
    line-height: 1.5;
    background: #0d151f;
    color: #edf6ff;
    border: 1px solid #50677f;
    border-radius: 8px;
    padding: 12px;
  }
  textarea::placeholder {
    color: #7f93a7;
  }
  textarea:read-only {
    background: #101d2b;
    border-color: #5b7895;
  }
  #invite-input {
    min-height: 96px !important;
  }
  .signal-code {
    min-height: 138px !important;
    white-space: pre;
    overflow-x: auto;
    overflow-y: auto;
    overflow-wrap: normal;
    resize: vertical;
  }
  button {
    padding: 12px 18px;
    border: 1px solid #52708e;
    border-radius: 9px;
    background: #1c2d3e;
    color: #f2f5f8;
    cursor: pointer;
    font-weight: 700;
  }
  button:hover:not(:disabled) {
    background: #2a4862;
    border-color: #79c5ff;
  }
  button:disabled {
    opacity: 0.55;
  }
  .join-panel > button:not(.secondary) {
    background: #1f689b;
    border-color: #69baf2;
  }
  .join-panel > button:not(.secondary):hover:not(:disabled) {
    background: #2d82bb;
  }
  .code-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .required-note {
    color: #aebdcb;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .field-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .field-actions .secondary {
    flex: 0 0 auto;
    padding-inline: 14px;
  }
  .field-actions .hint {
    flex: 1 1 220px;
  }
  .hint {
    margin: 0;
    color: #aebdcb;
    font-size: 0.875rem;
  }
  .status-line {
    padding-top: 4px;
    border-top: 1px solid #2f4153;
  }
  .copy-status {
    margin: 0;
    color: #81e0b4;
    font-size: 0.9rem;
  }
  .error {
    width: min(100%, 720px);
    margin: 0;
    color: #ffb4b4;
    font-size: 1rem;
  }
  .shell {
    display: flex;
    gap: 14px;
    width: min(100%, 1440px);
    height: min(780px, calc(100vh - 180px));
    min-height: 520px;
    padding: 12px;
    border: 1px solid #2f4052;
    border-radius: 14px;
    background: #101923;
    box-shadow: 0 16px 40px #0005;
  }
  .sidebar {
    width: 280px;
    flex: 0 0 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  #pstatus {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 12px;
    border: 1px solid #40566d;
    border-radius: 9px;
    background: #172331;
    font-size: 0.95rem;
    color: #cbd8e5;
  }
  #pstatus strong {
    color: #f2f5f8;
    font-size: 1.1rem;
  }
  .canvas-area {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .canvas-host {
    height: 100%;
    min-height: 280px;
    border: 1px solid #40566d;
    border-radius: 10px;
    overflow: hidden;
    background: #0a0f15;
  }
  .canvas-host :global(canvas) {
    display: block;
  }
  @media (max-width: 760px) {
    main {
      align-items: stretch;
      padding: 20px 12px;
    }
    .join-header {
      text-align: left;
    }
    .join-panel,
    .error {
      width: 100%;
    }
    .shell {
      flex-direction: column;
      height: auto;
      min-height: 0;
    }
    .sidebar {
      width: 100%;
      flex-basis: auto;
      max-height: 420px;
    }
    .canvas-area {
      min-height: 58vh;
    }
  }
</style>
