<script lang="ts">
  import { onMount } from "svelte";
  import { bootPlayerApp, type PlayerApp } from "./joinBoot";
  import { parseInvite } from "./hostShare";
  import { createStage, type Stage } from "../canvas/stage";
  import { CanvasController, domPointerSource, type TokenView } from "../canvas/interactions";
  import { can } from "../core/permissions";
  import { ChatPanel } from "../ui/chat";
  import { SheetPanel } from "../ui/sheets";
  import type { SceneDocument, SceneGrid } from "../core/documents";
  import type { Op } from "../core/ops";

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

  let canvasHost: HTMLDivElement;
  let canvasError = $state<string | null>(null);
  let loadedMapHash: string | null = null;
  let stage: Stage | null = null;
  let controller: CanvasController | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

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
    if (code && app) void app.receiveCode(code);
    answerText = "";
  }

  function activeScene(): SceneDocument | null {
    const client = app?.client;
    if (!client) return null;
    const scene = client.store.get("scenes", "scene-1");
    return scene ?? (client.store.getAll("scenes") as readonly SceneDocument[])[0] ?? null;
  }

  function tokenViews(): TokenView[] {
    const scene = activeScene();
    if (!scene) return [];
    return scene.tokens.map((token) => ({ token, sceneId: scene._id }));
  }

  function squareGrid(grid: SceneGrid | undefined): { type: "square"; size: number } | null {
    if (grid && grid.type === "square" && grid.size > 0) return { type: "square", size: grid.size };
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
        const width = Math.max(320, canvasHost.clientWidth);
        const height = Math.max(240, canvasHost.clientHeight);
        const view = await createStage({ width, height, hostElement: canvasHost });
        stage = view;
        view.fit(scene?.width ?? 2000, scene?.height ?? 1500);
        controller = new CanvasController({
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
            return can(user, "update", tokenView.token, "tokens", scene ? { parent: scene } : {});
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
    return () => {
      if (pollTimer !== null) clearInterval(pollTimer);
      controller?.destroy();
      stage?.destroy();
      stage = null;
      app?.close();
    };
  });
</script>

<main>
  <h1>VTT — player</h1>
  {#if joinError}
    <p class="error">{joinError}</p>
  {/if}

  {#if phase === "invite"}
    <section class="join-panel" aria-label="Join a game">
      <label for="invite-input">Invite (link or #room=…&k=…)</label>
      <textarea id="invite-input" rows="3" bind:value={inviteText} placeholder="#room=…&k=…"
      ></textarea>
      <button id="join-connect" type="button" onclick={() => void connect(inviteText)}>
        Connect
      </button>
    </section>
  {:else if phase === "exchange" || phase === "dead"}
    <section class="join-panel" aria-label="Signaling exchange">
      {#if phase === "dead"}
        <p class="error" id="disconnect-notice">Host disconnected — connection lost.</p>
      {/if}
      <label for="offer-out">Your code (send to the host)</label>
      <textarea id="offer-out" rows="4" readonly value={hostCode}></textarea>
      <label for="answer-input">Host's code (paste here)</label>
      <textarea
        id="answer-input"
        rows="4"
        bind:value={answerText}
        placeholder="paste the host's answer"></textarea>
      <button id="answer-apply" type="button" onclick={applyAnswer}>Apply host code</button>
      <p class="hint">state: {connState}</p>
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
          <SheetPanel client={app.client} bus={app.bus} />
        {/if}
      </aside>
      <div class="canvas-host" bind:this={canvasHost}></div>
    </section>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #101014;
    color: #e8e8ee;
    font-family: system-ui, sans-serif;
  }
  main {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h1 {
    font-size: 18px;
    margin: 8px 0 0 8px;
  }
  .join-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 480px;
    margin: 8px;
    padding: 12px;
    border: 1px solid #3a3f4a;
    border-radius: 8px;
    background: #16181d;
  }
  textarea {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    background: #101216;
    color: #cfd3dc;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    padding: 6px;
  }
  button {
    padding: 8px 12px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #1d2127;
    color: #e8e8ee;
    cursor: pointer;
  }
  button:hover {
    background: #262b33;
  }
  .hint {
    color: #8b93a3;
    font-size: 12px;
  }
  .error {
    color: #ff6b6b;
  }
  .shell {
    display: flex;
    gap: 8px;
    height: calc(100vh - 48px);
    padding: 8px;
    box-sizing: border-box;
  }
  .sidebar {
    width: 200px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  #pstatus {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    font-size: 13px;
  }
  #pstatus strong {
    font-size: 14px;
  }
  .canvas-host {
    flex: 1;
    border: 1px solid #3a3f4a;
    border-radius: 8px;
    overflow: hidden;
  }
  .canvas-host :global(canvas) {
    display: block;
  }
</style>
