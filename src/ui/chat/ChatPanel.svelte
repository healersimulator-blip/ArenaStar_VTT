<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { MessageDocument, UserDocument } from "../../core/documents";
  import { buildChatMessage, parseChatCommand } from "../../core/chat";
  import { renderMarkdown } from "../../core/markdown";
  import RollCard from "./RollCard.svelte";
  import {
    delegateRerollOps,
    invertLedger,
    playerRerollOps,
    rerollOps,
    revertOps,
  } from "../../packages/pf1e/rollLedger";
  import type { RollLedger } from "../../packages/pf1e/rollLedger";
  import { rollHighlightFadeSecOf, worldSettingsFrom } from "../../core/worldSettings";
  import { tokenRect } from "../../canvas/tokens";

  let {
    client,
    bus,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
  } = $props();

  let messages = $state<MessageDocument[]>([]);
  let draft = $state("");
  let logEl: HTMLDivElement;

  // F01 ledger window — combat round if a combat exists, else max ledger turn (so cards appear open until the table advances)
  const currentTurn = $derived.by(() => {
    const combats = client.store.getAll("combats") as readonly Record<string, unknown>[];
    if (combats.length > 0) {
      const c0 = combats[0] as Record<string, unknown>;
      const sys = (c0?.["system"] as Record<string, unknown> | undefined) ?? undefined;
      const r = sys?.["round"];
      if (typeof r === "number" && Number.isFinite(r)) return Math.trunc(r);
      const t = sys?.["turn"];
      if (typeof t === "number" && Number.isFinite(t)) return Math.trunc(t);
    }
    let max = 0;
    for (const m of messages) {
      const ledger = (m.system as unknown as { rollLedger?: RollLedger } | undefined)?.rollLedger;
      if (ledger && typeof ledger.turnNumber === "number") max = Math.max(max, ledger.turnNumber);
    }
    return max;
  });

  const fadeSec = $derived.by(() => {
    try {
      return rollHighlightFadeSecOf(worldSettingsFrom(client.store.getAll("settings") as unknown as Iterable<unknown>));
    } catch {
      return 4;
    }
  });

  const isGMDerived = $derived.by(() => {
    const u = client.user as unknown as { role?: string; isGM?: boolean } | undefined;
    return u?.isGM === true || u?.role === "gm" || u?.role === "GM";
  });

  function highlightFromLedger(
    ledger: RollLedger,
    kind: "initiator" | "target" | "area",
    id: string | null,
  ): void {
    // G §4.5 highlighting: outline the initiator/target token and the area burst.
    // Chat drives the RollHighlightLayer; App.svelte also listens on bus "rollHighlight".
    try {
      (bus.emit as unknown as (ev: string, payload: unknown) => void)("rollHighlight", {
        kind,
        id,
        ledger,
        fadeSec,
      });
    } catch {}
    // Best-effort direct layer sync when a stage is exposed on window (e2e / preview)
    const stage = (globalThis as unknown as { __stage?: { getRollHighlightLayer?: () => { sync: (rects: unknown[], camera: unknown, fadeSec: number) => void }; camera?: unknown } }).__stage;
    if (!stage?.getRollHighlightLayer) return;
    try {
      const tokens = client.store.getAll("tokens") as readonly Record<string, unknown>[];
      const toRect = (tokenId: string | null, fallback: string | null) => {
        if (!tokenId && !fallback) return null;
        const wanted = tokenId ?? fallback;
        const tok = tokens.find((tokDoc) => (tokDoc as Record<string, unknown>)["_id"] === wanted) as unknown as
          | { _id: string; x: number; y: number; width: number; height: number }
          | undefined;
        if (!tok) return null;
        try {
          // tokenRect expects TokenDocument; we have enough fields
          const r = tokenRect(tok as unknown as import("../../core/documents").TokenDocument);
          return { ...r, kind } as unknown as import("../../canvas/layers/RollHighlightLayer").RollHighlightRect;
        } catch {
          return { x: (tok.x as number) ?? 0, y: (tok.y as number) ?? 0, width: (tok.width as number) ?? 1, height: (tok.height as number) ?? 1, kind } as unknown as import("../../canvas/layers/RollHighlightLayer").RollHighlightRect;
        }
      };
      const rects: import("../../canvas/layers/RollHighlightLayer").RollHighlightRect[] = [];
      if (kind === "initiator") {
        const r = toRect(ledger.initiator.tokenId as string | null, ledger.initiator.actorId);
        if (r) rects.push(r as import("../../canvas/layers/RollHighlightLayer").RollHighlightRect);
      } else if (kind === "target" && id) {
        const tgt = ledger.targets?.find((t) => t.actorId === id || t.tokenId === id);
        const r = toRect(tgt?.tokenId as string | null ?? null, tgt?.actorId ?? id);
        if (r) rects.push({ ...r, kind: "target" } as import("../../canvas/layers/RollHighlightLayer").RollHighlightRect);
      } else if (kind === "area" && ledger.area) {
        const a = ledger.area;
        // Burst/cone area: draw a square around the origin with side = diameter in scene units.
        // The exact footprint is templateGeometry's job; here we just outline the burst bounds.
        const gridSize = 50; // 1 square = 50 px fallback (App will have the real grid)
        const rPx = (a.radiusFt / 5) * gridSize;
        rects.push({
          x: a.origin.x - rPx,
          y: a.origin.y - rPx,
          width: rPx * 2,
          height: rPx * 2,
          kind: "area",
        } as unknown as import("../../canvas/layers/RollHighlightLayer").RollHighlightRect);
        for (const tid of a.affectedTokenIds) {
          const r = toRect(tid, null);
          if (r) rects.push({ ...r, kind: "target" } as import("../../canvas/layers/RollHighlightLayer").RollHighlightRect);
        }
      }
      if (rects.length > 0) {
        const camera = (stage as unknown as { camera?: unknown }).camera ?? { x: 0, y: 0, scale: 1 };
        stage.getRollHighlightLayer!().sync(rects, camera as import("../../canvas/camera").Camera, fadeSec);
        // Center the initiator/target point — best-effort (App's camera pan is the real center)
        try {
          const layerRect = rects[0];
          if (layerRect) {
            const appCam = (globalThis as unknown as { __appCamera?: { setCamera?: (c: unknown) => void; camera?: unknown } }).__appCamera;
            void appCam; // kept for e2e hook inspection
          }
        } catch {}
      }
    } catch {}
  }

  function handleReroll(messageId: string, ledger: RollLedger): void {
    // MVP reroll: inverse(old) + a trivial new ledgerOps (no HP change) + new rolls with +1 to every total.
    // The host in a real game would re-derive modifiers and submit the true Ops; tests pin the inverse+new envelope shape.
    const newRolls = ledger.rolls.map((r) => ({ ...r, total: r.total + 1 })) as RollLedger["rolls"];
    const newLedgerOps: import("../../core/ops").Op[] = [];
    const ops = rerollOps({ messageId: messageId as unknown as import("../../core/ids").DocId, ledger, currentTurn, newLedgerOps, newRolls });
    if (!ops) return;
    client.submit(ops);
  }

  function handleRevert(messageId: string, ledger: RollLedger): void {
    const ops = revertOps({ messageId: messageId as unknown as import("../../core/ids").DocId, ledger, currentTurn });
    if (!ops) return;
    client.submit(ops);
  }

  function handleDelegate(messageId: string, ledger: RollLedger, playerId: string): void {
    const ops = delegateRerollOps({
      messageId: messageId as unknown as import("../../core/ids").DocId,
      ledger,
      currentTurn,
      playerId: playerId as unknown as import("../../core/ids").UserId,
    });
    if (!ops) return;
    client.submit(ops);
  }

  function handlePlayerReroll(messageId: string, ledger: RollLedger): void {
    const pid = (client.user as unknown as { id?: string })?.id ?? "";
    if (!pid) return;
    const newRolls = ledger.rolls.map((r) => ({ ...r, total: r.total + 1 })) as RollLedger["rolls"];
    const ops = playerRerollOps({
      messageId: messageId as unknown as import("../../core/ids").DocId,
      ledger,
      currentTurn,
      playerId: pid as unknown as import("../../core/ids").UserId,
      newLedgerOps: [],
      newRolls,
    });
    if (!ops) return;
    client.submit(ops);
  }


  function refresh(): void {
    messages = [...(client.store.getAll("messages") as readonly MessageDocument[])];
  }

  function userName(id: string): string {
    const user = client.store.get("users", id) as UserDocument | undefined;
    return user?.name ?? id.slice(0, 6);
  }

  /** `text [[total|formula]] text` → render segments with roll chips. */
  function segments(
    content: string,
  ): Array<{ kind: "text" | "chip"; text: string; chip?: string }> {
    const out: Array<{ kind: "text" | "chip"; text: string; chip?: string }> = [];
    const re = /\[\[([^[\]|]{1,120})\|([^[\]|]{1,120})\]\]/g;
    let last = 0;
    for (const match of content.matchAll(re)) {
      const at = match.index ?? 0;
      if (at > last) out.push({ kind: "text", text: content.slice(last, at) });
      out.push({ kind: "chip", text: match[1] ?? "", chip: match[2] ?? "" });
      last = at + match[0].length;
    }
    if (last < content.length) out.push({ kind: "text", text: content.slice(last) });
    return out;
  }

  /** Markdown-render one text segment (chips are extracted beforehand). */
  function md(text: string): string {
    return renderMarkdown(text);
  }

  /** Split content into chip/text segments; text parts markdown-rendered. */
  function richSegments(
    content: string,
  ): Array<{ kind: "text" | "chip"; html?: string; text?: string; chip?: string }> {
    return segments(content).map((seg) =>
      seg.kind === "chip" ? seg : { kind: "text" as const, html: md(seg.text) },
    );
  }

  function post(content: string, flavor: string, whisper: string[]): void {
    client.submit([
      {
        kind: "create",
        coll: "messages",
        data: {
          _id: globalThis.crypto.randomUUID(),
          type: "message",
          name: content.slice(0, 40) || "message",
          ownership: { default: 1 },
          flags: {},
          system: {},
          author: client.user?.id ?? "",
          content,
          whisper,
          roll: null,
          flavor,
        },
      },
    ]);
  }

  function send(): void {
    const text = draft.trim();
    if (!text) return;
    draft = "";
    const parsed = parseChatCommand(text);
    // Roll commands ride the §11 host-crypto path (client.roll).
    if (
      parsed.kind === "roll" ||
      parsed.kind === "gmroll" ||
      parsed.kind === "blindroll" ||
      parsed.kind === "selfroll"
    ) {
      if (!parsed.formula) return;
      // §11: explicit roll commands ride the commit-reveal path
      void client.rollVerified(parsed.formula, parsed.kind);
      return;
    }
    if (parsed.kind === "whisper") {
      const users = client.store.getAll("users") as readonly UserDocument[];
      const ids: string[] = [];
      for (const name of parsed.whisperNames) {
        const target = users.find(
          (user) =>
            user.name.toLowerCase() === name.toLowerCase() || user._id === name.toLowerCase(),
        );
        if (!target) {
          post(`⟨whisper failed: unknown user "${name}"⟩`, "system", []);
          return;
        }
        ids.push(target._id);
      }
      if (ids.length === 0) {
        post("⟨whisper failed: no recipient⟩", "system", []);
        return;
      }
      post(parsed.text, "whisper", ids);
      return;
    }
    // say / ooc / emote (and unknown commands echoed as speech) — pure core
    const { message, errors } = buildChatMessage({ author: client.user?.id ?? "", parsed });
    if (errors.length > 0) {
      post(`⟨${errors[0]}⟩`, "system", []);
      if (!parsed.text) return;
    }
    client.submit([{ kind: "create", coll: "messages", data: message }]);
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    // Only re-render when messages actually changed — the handshake streams
    // many unrelated op envelopes and full re-renders keep the input row
    // unstable (actionability) under load.
    const offOps = bus.on("ops", ({ envelope }) => {
      const touches = envelope.ops.some((op) =>
        op.kind === "create" || op.kind === "delete"
          ? op.coll === "messages"
          : op.ref.coll === "messages",
      );
      if (touches) refresh();
    });
    refresh();
    return () => {
      offSnapshot();
      offOps();
    };
  });

  // keep the newest line in view as messages arrive
  $effect(() => {
    void messages;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });
</script>

<section class="chat" aria-label="Chat">
  <h3>Chat</h3>
  <div id="chat-log" bind:this={logEl}>
    {#each messages as message (message._id)}
      {@const ledger = (message.system as unknown as { rollLedger?: RollLedger } | undefined)?.rollLedger}
      {#if ledger}
        <RollCard
          ledger={ledger}
          currentTurn={currentTurn}
          isGM={isGMDerived}
          fadeSec={fadeSec}
          onReroll={() => handleReroll(message._id, ledger)}
          onRevert={() => handleRevert(message._id, ledger)}
          onDelegate={(playerId: string) => handleDelegate(message._id, ledger, playerId)}
          onPlayerReroll={() => handlePlayerReroll(message._id, ledger)}
          onHighlight={(kind: "initiator" | "target" | "area", id: string | null) => highlightFromLedger(ledger, kind, id)}
        />
        {#if message.roll}
          <p class="line rollcard" data-mode={message.rollMode ?? "roll"}>
            <span class="author">{userName(message.author)}</span>
            <span class="total">{message.roll.total}</span>
            <span class="formula">= {message.roll.formula}</span>
            {#if message.flavor}
              <span class="flavor">{message.flavor}</span>
            {/if}
            {#if message.rollMode === "gmroll"}<span class="tag">gm</span>{/if}
            {#if message.whisper.length > 0}
              <span class="tag">🔒 {message.whisper.map(userName).join(", ")}</span>
            {/if}
          </p>
        {/if}
      {:else if message.roll}
        <p class="line rollcard" data-mode={message.rollMode ?? "roll"}>
          <span class="author">{userName(message.author)}</span>
          <span class="total">{message.roll.total}</span>
          <span class="formula">= {message.roll.formula}</span>
          {#if message.flavor}
            <span class="flavor">{message.flavor}</span>
          {/if}
          {#if message.rollMode === "gmroll"}<span class="tag">gm</span>{/if}
          {#if message.whisper.length > 0}
            <span class="tag">🔒 {message.whisper.map(userName).join(", ")}</span>
          {/if}
        </p>
      {:else}
        <p
          class="line"
          class:whisper={message.whisper.length > 0}
          class:emote={message.flavor === "emote"}
        >
          <span class="author">{userName(message.author)}</span>
          {#each richSegments(message.content) as segment, i (i)}
            {#if segment.kind === "chip"}
              <span class="chip" title={segment.chip}>{segment.text}</span>
            {:else}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown is HTML-escaped by renderMarkdown before any transform -->
              {@html segment.html}
            {/if}
          {/each}
          {#if message.whisper.length > 0}
            <span class="tag">🔒 {message.whisper.map(userName).join(", ")}</span>
          {/if}
        </p>
      {/if}
    {/each}
  </div>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      send();
    }}
  >
    <input
      id="chat-input"
      type="text"
      bind:value={draft}
      placeholder="Message — /roll 1d20+5 · /gmroll · /emote · /w <name>"
      autocomplete="off"
    />
    <button id="chat-send" type="submit">Send</button>
  </form>
</section>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 180px;
  }
  h3 {
    margin: 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8b93a3;
  }
  #chat-log {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 120px;
    min-height: 120px;
    padding: 6px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #101216;
    font-size: 12.5px;
  }
  .line {
    margin: 0;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .author {
    color: #7fb0d8;
    margin-right: 4px;
    font-weight: 600;
  }
  .whisper {
    color: #c9a6e0;
  }
  .emote {
    font-style: italic;
    color: #b9c2a8;
  }
  .chip {
    display: inline-block;
    padding: 0 6px;
    margin: 0 1px;
    border: 1px solid #2e8b57;
    border-radius: 999px;
    color: #7fe0a7;
    font-weight: 700;
    cursor: help;
  }
  .rollcard {
    display: flex;
    align-items: baseline;
    gap: 6px;
    border: 1px solid #2e8b57;
    border-radius: 6px;
    padding: 3px 6px;
    background: #12201a;
  }
  .rollcard .total {
    font-size: 16px;
    font-weight: 800;
    color: #7fe0a7;
  }
  .rollcard .formula {
    color: #8b93a3;
  }
  .rollcard .flavor {
    display: block;
    color: #9eafc5;
    font-size: 11px;
  }
  .tag {
    margin-left: auto;
    color: #8b93a3;
    font-size: 11px;
  }
  form {
    display: flex;
    gap: 4px;
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #101216;
    color: #e8e8ee;
    font-size: 12.5px;
  }
  button {
    padding: 6px 10px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #1d2127;
    color: #e8e8ee;
    cursor: pointer;
  }
  button:hover {
    background: #262b33;
  }
</style>
