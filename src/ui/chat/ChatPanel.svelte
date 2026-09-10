<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { MessageDocument, UserDocument } from "../../core/documents";
  import { buildChatMessage, parseChatCommand } from "../../core/chat";
  import { renderMarkdown } from "../../core/markdown";

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
