/**
 * §6.2 generic WebSocket adapter (optional, self-hosters): connects to a
 * user-supplied relay URL; the server relays frames between clients of the
 * same room (self-hosters scope rooms by URL path, e.g. wss://host/vtt/<hash>).
 * Payloads are the §6.2 room-crypto codes — the relay sees only ciphertext.
 */
import type { PeerId } from "../../../core/ids";
import type { SignalingAdapter, SignalMsg } from "../../../core/net";
import { encryptSignalPayload } from "../crypto";
import { createEnvelopeSink } from "../dispatch";
import { browserRelaySocket, type RelaySocket, type RelaySocketFactory } from "../nostr";

export interface WebSocketAdapterOptions {
  /** Self-hosted relay URL (required). */
  url: string;
  socket?: RelaySocketFactory;
  backoff?: { initialMs?: number; maxMs?: number; factor?: number };
}

export class WebSocketSignalingAdapter implements SignalingAdapter {
  readonly selfId: PeerId = globalThis.crypto.randomUUID();

  private readonly url: string;
  private readonly socketFactory: RelaySocketFactory;
  private readonly backoffInitial: number;
  private readonly backoffMax: number;
  private readonly backoffFactor: number;

  private socket: RelaySocket | null = null;
  private isOpen = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private key: CryptoKey | null = null;
  private cb: ((from: PeerId, msg: SignalMsg) => void) | null = null;
  private closed = false;
  private openedResolve: (() => void) | null = null;
  readonly opened = new Promise<void>((resolve) => {
    this.openedResolve = resolve;
  });

  constructor(options: WebSocketAdapterOptions) {
    this.url = options.url;
    this.socketFactory = options.socket ?? browserRelaySocket;
    this.backoffInitial = options.backoff?.initialMs ?? 1_000;
    this.backoffMax = options.backoff?.maxMs ?? 30_000;
    this.backoffFactor = options.backoff?.factor ?? 2;
  }

  async open(_roomId: string, key: CryptoKey): Promise<void> {
    this.key = key;
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    let socket: RelaySocket;
    try {
      socket = this.socketFactory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.isOpen = true;
      this.attempts = 0;
      this.openedResolve?.();
      this.openedResolve = null;
    };
    socket.onmessage = (data) => void this.sink.handleCode(data);
    socket.onclose = () => {
      this.isOpen = false;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = Math.min(
      this.backoffInitial * this.backoffFactor ** this.attempts,
      this.backoffMax,
    );
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private readonly sink = createEnvelopeSink({
    key: () => this.key,
    selfId: () => this.selfId,
    cb: () => this.cb,
  });

  async send(to: PeerId, msg: SignalMsg): Promise<void> {
    if (this.closed) throw new Error("websocket signaling: closed");
    if (!this.key) throw new Error("websocket signaling: open() not called");
    const code = await encryptSignalPayload(this.key, { from: this.selfId, to, msg });
    if (!this.socket || !this.isOpen) throw new Error("websocket signaling: not connected");
    this.socket.send(code);
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
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.isOpen = false;
  }
}
