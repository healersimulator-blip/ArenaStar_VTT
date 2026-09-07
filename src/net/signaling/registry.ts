/**
 * §6.2 adapter registry — adapters are tried in configurable order; Manual is
 * always available in the UI (exposed as `stack.manual`).
 *
 * open(roomId, key) walks the order list; the first adapter whose ready()
 * (first transport connection) settles within the per-adapter timeout becomes
 * active. On exhaustion the stack resolves to Manual-only (caller decides how
 * to surface that).
 */
import type { SignalingAdapter } from "../../core/net";
import { ManualSignalingAdapter } from "./manual";
import { NostrSignalingAdapter, type NostrAdapterOptions } from "./nostr";
import { MqttSignalingAdapter, type MqttAdapterOptions } from "./mqtt";
import { TrackerSignalingAdapter, type TrackerAdapterOptions } from "./tracker";
import { WebSocketSignalingAdapter, type WebSocketAdapterOptions } from "./websocket";

export type AdapterKind = "nostr" | "mqtt" | "tracker" | "websocket";

export const DEFAULT_ADAPTER_ORDER: readonly AdapterKind[] = ["nostr", "mqtt", "tracker"];

export interface SignalingStackOptions {
  /** Try order (default: nostr → mqtt → tracker, §6.2 Nostr is the default). */
  order?: readonly AdapterKind[];
  /** Per-adapter readiness timeout (default 8 s). */
  timeoutMs?: number;
  nostr?: NostrAdapterOptions;
  mqtt?: MqttAdapterOptions;
  tracker?: TrackerAdapterOptions;
  websocket?: WebSocketAdapterOptions;
}

interface ReadyAdapter {
  adapter: SignalingAdapter;
  kind: AdapterKind;
}

export class SignalingStack {
  /** §6.2: Manual is always available in the UI. */
  readonly manual = new ManualSignalingAdapter();

  private activeInner: ReadyAdapter | null = null;
  private closed = false;

  constructor(private readonly options: SignalingStackOptions = {}) {}

  /** Build one adapter by kind (package-private for tests). */
  private build(kind: AdapterKind): ReadyAdapter {
    switch (kind) {
      case "nostr":
        return { adapter: new NostrSignalingAdapter(this.options.nostr), kind };
      case "mqtt":
        return { adapter: new MqttSignalingAdapter(this.options.mqtt), kind };
      case "tracker":
        return { adapter: new TrackerSignalingAdapter(this.options.tracker), kind };
      case "websocket":
        if (!this.options.websocket)
          throw new Error("websocket adapter requires options.websocket.url");
        return { adapter: new WebSocketSignalingAdapter(this.options.websocket), kind };
    }
  }

  /** Try each adapter in order; the first ready one wins. */
  async open(roomId: string, key: CryptoKey): Promise<AdapterKind | null> {
    this.closed = false;
    const order = this.options.order ?? DEFAULT_ADAPTER_ORDER;
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    for (const kind of order) {
      if (this.closed) return null;
      let entry: ReadyAdapter;
      try {
        entry = this.build(kind);
      } catch {
        continue; // e.g. websocket without url
      }
      try {
        await entry.adapter.open(roomId, key);
        const readyAdapter = entry.adapter as SignalingAdapter & { ready(): Promise<void> };
        const ready = await Promise.race([
          readyAdapter.ready().then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        if (ready) {
          this.activeInner = entry;
          return kind;
        }
        entry.adapter.close(); // too slow → next
      } catch {
        entry.adapter.close(); // errored → next
      }
    }
    return null; // manual remains
  }

  get active(): SignalingAdapter | null {
    return this.activeInner?.adapter ?? null;
  }

  get activeKind(): AdapterKind | null {
    return this.activeInner?.kind ?? null;
  }

  close(): void {
    this.closed = true;
    this.activeInner?.adapter.close();
    this.activeInner = null;
    this.manual.close();
  }
}
