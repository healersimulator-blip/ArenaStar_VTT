/**
 * §6.2 MQTT-over-WSS adapter — public broker, topic `vtt/<roomHash>` where
 * roomHash = sha256(roomId) hex. Payloads are the §6.2 room-crypto codes, so
 * the broker only relays opaque ciphertext. QoS 0 (signaling is best-effort;
 * the session layer reconnects), no retain.
 *
 * The MQTT client is an injectable async factory port: the browser uses
 * mqtt.js (§17 stack, lazy-imported when the join UI loads this adapter);
 * tests inject a fake broker.
 */
import type { PeerId } from "../../../core/ids";
import type { SignalingAdapter, SignalMsg } from "../../../core/net";
import { encryptSignalPayload } from "../crypto";
import { createEnvelopeSink } from "../dispatch";

/** Public broker over WSS (configurable; self-hosters point elsewhere). */
export const DEFAULT_MQTT_URL = "wss://broker.emqx.io:8084/mqtt";

export async function roomHashHex(roomId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(roomId));
  return bufferToHex(new Uint8Array(digest));
}

function bufferToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ─── Client port ──────────────────────────────────────────────────────────────

export interface MqttClientPort {
  publish(topic: string, message: string): void;
  subscribe(topic: string): void;
  end(force?: boolean): void;
  onConnect(cb: () => void): void;
  onMessage(cb: (topic: string, payload: string) => void): void;
  onError(cb: (error: Error) => void): void;
  onClose(cb: () => void): void;
}

export type MqttClientFactory = (url: string) => Promise<MqttClientPort>;

/** mqtt.js (§17) — lazy import keeps it out of the entry bundle (D-052). */
export async function mqttJsClient(url: string): Promise<MqttClientPort> {
  const { default: mqtt } = await import("mqtt");
  const client = mqtt.connect(url, { reconnectPeriod: 2_000, connectTimeout: 8_000 });
  return {
    publish: (topic, message) => void client.publishAsync(topic, message).catch(() => undefined),
    subscribe: (topic) => void client.subscribeAsync(topic).catch(() => undefined),
    end: (force) => client.end(force),
    onConnect: (cb) => client.on("connect", () => cb()),
    onMessage: (cb) => client.on("message", (t, payload) => cb(t, payload.toString())),
    onError: (cb) => client.on("error", (err) => cb(err)),
    onClose: (cb) => client.on("close", () => cb()),
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export interface MqttAdapterOptions {
  url?: string;
  clientFactory?: MqttClientFactory;
}

export class MqttSignalingAdapter implements SignalingAdapter {
  readonly selfId: PeerId = globalThis.crypto.randomUUID();

  private readonly url: string;
  private readonly factory: MqttClientFactory;
  private client: MqttClientPort | null = null;
  private topic: string | null = null;
  private key: CryptoKey | null = null;
  private cb: ((from: PeerId, msg: SignalMsg) => void) | null = null;
  private closed = false;
  private openedResolve: (() => void) | null = null;
  readonly opened = new Promise<void>((resolve) => {
    this.openedResolve = resolve;
  });

  constructor(options: MqttAdapterOptions = {}) {
    this.url = options.url ?? DEFAULT_MQTT_URL;
    this.factory = options.clientFactory ?? mqttJsClient;
  }

  async open(roomId: string, key: CryptoKey): Promise<void> {
    this.key = key;
    this.topic = `vtt/${await roomHashHex(roomId)}`;
    this.closed = false;
    const client = await this.factory(this.url);
    if (this.closed) return;
    this.client = client;
    client.onConnect(() => {
      if (this.topic) client.subscribe(this.topic);
      this.openedResolve?.();
      this.openedResolve = null;
    });
    client.onMessage((topic, payload) => {
      if (topic === this.topic) void this.sink.handleCode(payload);
    });
    client.onError(() => {
      /* reconnect is the client's job; close() propagates */
    });
  }

  private readonly sink = createEnvelopeSink({
    key: () => this.key,
    selfId: () => this.selfId,
    cb: () => this.cb,
  });

  async send(to: PeerId, msg: SignalMsg): Promise<void> {
    if (this.closed) throw new Error("mqtt signaling: closed");
    const key = this.key;
    const client = this.client;
    const topic = this.topic;
    if (!client || !topic || !key) throw new Error("mqtt signaling: open() not called");
    const code = await encryptSignalPayload(key, { from: this.selfId, to, msg });
    client.publish(topic, code);
  }

  onMessage(cb: (from: PeerId, msg: SignalMsg) => void): void {
    this.cb = cb;
  }

  /** First broker CONNECT (used by the adapter registry). */
  ready(): Promise<void> {
    return this.opened;
  }

  close(): void {
    this.closed = true;
    this.cb = null;
    this.key = null;
    this.client?.end(true);
    this.client = null;
  }
}
