/**
 * §6.2 Nostr signaling adapter — the DEFAULT adapter.
 *
 * - Publishes to 3–4 public relays (configurable list/order) over WebSocket.
 * - Events are EPHEMERAL (kind 20250, NIP-01 range 20000–29999: relays must
 *   not store them) and tagged with the room id (`["t", roomId]`, the
 *   indexed single-letter tag; standard relays only index single-char tags).
 * - Content is our §6.2 room crypto: `vtt1.<AES-GCM(...)>` — relays never see
 *   plaintext, sender ids or room semantics beyond an opaque topic string.
 * - nostr-tools (§17 stack) builds and verifies NIP-01 events (schnorr
 *   secp256k1); the socket layer is an injectable port so tests run against
 *   an in-memory relay hub and the browser uses global WebSocket.
 * - Reliability: every event is sent to ALL connected relays; receiving is
 *   deduped by event id; each relay reconnects with exponential backoff
 *   (1 s ×2 → 30 s cap).
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools/pure";
import type { PeerId } from "../../../core/ids";
import type { SignalingAdapter, SignalMsg } from "../../../core/net";
import { decryptSignalPayload, encryptSignalPayload } from "../crypto";

/** §6.2: 3–4 public relays by default. */
export const DEFAULT_NOSTR_RELAYS: readonly string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

/** Ephemeral signaling kind (NIP-01 ephemeral range 20000–29999, D-051). */
export const NOSTR_KIND = 20_250;

// ─── Socket port ──────────────────────────────────────────────────────────────

export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: Error) => void) | null;
}

export type RelaySocketFactory = (url: string) => RelaySocket;

class BrowserRelaySocket implements RelaySocket {
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.onopen = () => this.onopen?.();
    ws.onmessage = (ev) => this.onmessage?.(String(ev.data));
    ws.onclose = () => this.onclose?.();
    ws.onerror = () => this.onerror?.(new Error(`relay error: ${ws.url}`));
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}

export function browserRelaySocket(url: string): RelaySocket {
  return new BrowserRelaySocket(new WebSocket(url));
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export interface NostrAdapterOptions {
  /** Relay URLs in priority order (default: 3 public relays). */
  relays?: readonly string[];
  /** Socket factory (tests inject a fake hub). */
  socket?: RelaySocketFactory;
  now?: () => number;
  /** Reconnect backoff (defaults 1 s ×2 → 30 s cap). */
  backoff?: { initialMs?: number; maxMs?: number; factor?: number };
}

interface RelayConn {
  url: string;
  socket: RelaySocket | null;
  open: boolean;
  attempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class NostrSignalingAdapter implements SignalingAdapter {
  /** Nostr pubkey (hex) — doubles as this adapter's signaling PeerId. */
  readonly selfId: PeerId;

  private readonly relays: readonly string[];
  private readonly socketFactory: RelaySocketFactory;
  private readonly now: () => number;
  private readonly backoffInitial: number;
  private readonly backoffMax: number;
  private readonly backoffFactor: number;

  private readonly conns: RelayConn[] = [];
  private readonly seen = new Set<string>();
  private readonly sk: Uint8Array;
  private readonly subId = globalThis.crypto.randomUUID().slice(0, 8);
  private key: CryptoKey | null = null;
  private roomId: string | null = null;
  private cb: ((from: PeerId, msg: SignalMsg) => void) | null = null;
  private closed = false;
  private openedResolve: (() => void) | null = null;
  /** Resolves on the first relay socket open (adapter registry readiness). */
  readonly opened = new Promise<void>((resolve) => {
    this.openedResolve = resolve;
  });

  constructor(options: NostrAdapterOptions = {}) {
    this.sk = generateSecretKey();
    this.selfId = getPublicKey(this.sk);
    this.relays = options.relays ?? DEFAULT_NOSTR_RELAYS;
    this.socketFactory = options.socket ?? browserRelaySocket;
    this.now = options.now ?? (() => Date.now());
    this.backoffInitial = options.backoff?.initialMs ?? 1_000;
    this.backoffMax = options.backoff?.maxMs ?? 30_000;
    this.backoffFactor = options.backoff?.factor ?? 2;
  }

  async open(roomId: string, key: CryptoKey): Promise<void> {
    this.roomId = roomId;
    this.key = key;
    this.closed = false;
    for (const url of this.relays) {
      const conn: RelayConn = { url, socket: null, open: false, attempts: 0, reconnectTimer: null };
      this.conns.push(conn);
      this.connect(conn);
    }
  }

  private connect(conn: RelayConn): void {
    if (this.closed) return;
    let socket: RelaySocket;
    try {
      socket = this.socketFactory(conn.url);
    } catch {
      this.scheduleReconnect(conn);
      return;
    }
    conn.socket = socket;
    socket.onopen = () => {
      conn.open = true;
      conn.attempts = 0;
      this.openedResolve?.();
      this.openedResolve = null;
      // §6.2 subscription: ephemeral room events only (no history)
      socket.send(
        JSON.stringify([
          "REQ",
          this.subId,
          { kinds: [NOSTR_KIND], "#t": [this.roomId ?? ""], limit: 0 },
        ]),
      );
    };
    socket.onmessage = (data) => this.onWire(conn, data);
    socket.onclose = () => {
      conn.open = false;
      this.scheduleReconnect(conn);
    };
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(conn: RelayConn): void {
    if (this.closed || conn.reconnectTimer !== null) return;
    const delay = Math.min(
      this.backoffInitial * this.backoffFactor ** conn.attempts,
      this.backoffMax,
    );
    conn.attempts += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.connect(conn);
    }, delay);
  }

  private onWire(_conn: RelayConn, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed[0] !== "EVENT") return;
    if (parsed[1] !== this.subId) return;
    const event = parsed[2] as Event;
    void this.handleEvent(event);
  }

  private async handleEvent(event: Event): Promise<void> {
    if (this.seen.has(event.id)) return; // multi-relay dedupe
    this.remember(event.id);
    if (event.pubkey === this.selfId) return; // own broadcast echoed back
    if (event.kind !== NOSTR_KIND) return;
    if (!this.key) return;
    if (!safeVerify(event)) return; // relays may forward junk; drop it
    try {
      const envelope = await decryptSignalPayload(this.key, event.content);
      if (envelope.to !== undefined && envelope.to !== this.selfId) return;
      this.cb?.(envelope.from, envelope.msg);
    } catch {
      // wrong room key or tampering — nothing to do (§6.2 authenticated anyway)
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 2_000) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  async send(to: PeerId, msg: SignalMsg): Promise<void> {
    if (this.closed) throw new Error("nostr signaling: closed");
    if (!this.key) throw new Error("nostr signaling: open() not called");
    const content = await encryptSignalPayload(this.key, { from: this.selfId, to, msg });
    const template: EventTemplate = {
      kind: NOSTR_KIND,
      created_at: Math.floor(this.now() / 1000),
      tags: [["t", this.roomId ?? ""]],
      content,
    };
    const event = finalizeEvent(template, this.sk);
    const wire = JSON.stringify(["EVENT", event]);
    for (const conn of this.conns) {
      if (conn.open && conn.socket) conn.socket.send(wire);
    }
  }

  onMessage(cb: (from: PeerId, msg: SignalMsg) => void): void {
    this.cb = cb;
  }

  ready(): Promise<void> {
    return this.opened;
  }

  close(): void {
    this.closed = true;
    this.cb = null;
    this.key = null;
    this.roomId = null;
    for (const conn of this.conns) {
      if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
      conn.socket?.close();
      conn.socket = null;
      conn.open = false;
    }
    this.conns.length = 0;
    this.seen.clear();
  }
}

function safeVerify(event: Event): boolean {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}
