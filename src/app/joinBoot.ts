/**
 * §2/§6.4 — player-side boot: identity (per-browser keypair), Manual
 * signaling, one reconnecting ClientPeerSession to the host, ClientSync over
 * its transport, and the shared AssetCache/Fetcher pair (§7).
 *
 * The player NEVER touches host internals — every mutation goes through
 * client.submit() and is permission-checked by the host (§5).
 */
import { createEventBus } from "../core/events";
import type { StoreMeta } from "../core/store";
import type { ClientEvents } from "../client/sync";
import { ClientSync } from "../client/sync";
import { AssetCache, AssetFetcher } from "../client/assets";
import { ClientPeerSession, type PeerConnectionFactory } from "../net/peerSession";
import type { PeerConnectionState } from "../core/net";
import { ManualSignalingAdapter } from "../net/signaling/manual";
import { NostrSignalingAdapter } from "../net/signaling/nostr";
import { deriveRoomKey, type RoomInvite } from "../net/signaling/crypto";
import { helloPayload, signText, type Identity } from "../net/identity";
import { ensureIdentity } from "../net/identityStore";
import { openVttDb } from "../storage/idb";

export interface PlayerAppOptions {
  invite: RoomInvite;
  displayName?: string;
  /** Override the Manual adapter (tests: paired fake channel). */
  adapter?: ManualSignalingAdapter;
  /** Override the RTC factory (tests: in-memory wire). */
  factory?: PeerConnectionFactory;
  /** Nostr relay override (tests: local relay); default: public relays. */
  relays?: string[];
  db?: Awaited<ReturnType<typeof openVttDb>>;
  now?: () => number;
}

export interface PlayerApp {
  readonly roomId: string;
  readonly identity: Identity;
  readonly displayName: string;
  readonly adapter: ManualSignalingAdapter;
  readonly session: ClientPeerSession;
  readonly bus: ReturnType<typeof createEventBus<ClientEvents>>;
  /** Null until the DataChannel connects; then the live replica. */
  readonly client: ClientSync | null;
  readonly fetcher: AssetFetcher | null;
  /** Outbound manual codes (the player's offer) for the UI. */
  takeOutbox(): string[];
  /** Feed a pasted host answer code. */
  receiveCode(code: string): Promise<void>;
  /** Resolves once welcome arrives (replica hydrated); rejects on close. */
  ready: Promise<void>;
  /** "nostr" when the session rides relays; "manual" for copy/paste. */
  readonly transportKind: string;
  /** §7: asset chunks streamed over the wire this session. */
  assetChunks: number;
  cacheHas(hash: string): Promise<boolean>;
  /** UI hooks (assignment-safe; joinBoot chains the internal handlers). */
  onDisconnected: ((reason: string) => void) | null;
  onConnectionState: ((state: PeerConnectionState) => void) | null;
  close(): void;
}

export class PlayerAppImpl implements PlayerApp {
  private readonly inner: {
    client: ClientSync | null;
    fetcher: AssetFetcher | null;
  } = { client: null, fetcher: null };
  /** UI hooks (joinBoot owns the raw session callbacks). */
  onDisconnected: ((reason: string) => void) | null = null;
  onConnectionState: ((state: PeerConnectionState) => void) | null = null;
  /** §7: asset chunks streamed over the wire this session. */
  assetChunks = 0;
  private cacheRef: AssetCache | null = null;
  readonly ready: Promise<void>;

  constructor(
    readonly roomId: string,
    readonly identity: Identity,
    readonly displayName: string,
    readonly adapter: ManualSignalingAdapter,
    readonly session: ClientPeerSession,
    readonly bus: ReturnType<typeof createEventBus<ClientEvents>>,
    ready: Promise<void>,
    readonly transportKind: string,
  ) {
    this.ready = ready;
  }

  get client(): ClientSync | null {
    return this.inner.client;
  }

  get fetcher(): AssetFetcher | null {
    return this.inner.fetcher;
  }

  /** @internal wired by bootPlayerApp on transport connect. */
  attach(client: ClientSync, fetcher: AssetFetcher, cache: AssetCache): void {
    this.inner.client = client;
    this.inner.fetcher = fetcher;
    this.cacheRef = cache;
  }

  async cacheHas(hash: string): Promise<boolean> {
    return this.cacheRef !== null && (await this.cacheRef.has(hash));
  }

  takeOutbox(): string[] {
    return this.adapter.takeOutbox();
  }

  receiveCode(code: string): Promise<void> {
    return this.adapter.receiveCode(code);
  }

  close(): void {
    this.session.close("player app closed");
    this.adapter.close();
  }
}

export async function bootPlayerApp(options: PlayerAppOptions): Promise<PlayerApp> {
  const db = options.db ?? (await openVttDb());
  const identity = await ensureIdentity(db);
  const displayName = options.displayName ?? `Player ${identity.publicKeyHex.slice(0, 4)}`;
  const key = await deriveRoomKey(options.invite.secret, options.invite.roomId);
  const adapter = options.adapter ?? new ManualSignalingAdapter();
  await adapter.open(options.invite.roomId, key);

  // §6.2/§19 M1: invites carrying &h=<nostr pubkey> join automatically via
  // relays; on failure (or h-less invites) Manual copy/paste remains.
  let sessionAdapter: ManualSignalingAdapter | NostrSignalingAdapter = adapter;
  let hostId = "host";
  if (!options.adapter && options.invite.hostPubkey) {
    const relays = options.relays ?? relayOverride();
    const nostr = new NostrSignalingAdapter(relays !== undefined ? { relays } : {});
    try {
      await nostr.open(options.invite.roomId, key);
      await Promise.race([nostr.ready(), new Promise((_, fail) => setTimeout(fail, 8_000))]);
      sessionAdapter = nostr;
      hostId = options.invite.hostPubkey;
    } catch {
      nostr.close(); // relays unreachable — manual exchange
    }
  }

  const session = new ClientPeerSession({
    adapter: sessionAdapter,
    hostId,
    // Manual signaling: a human ferries codes; re-offering faster than the
    // exchange round-trip only invalidates pending answers (D-062).
    backoff: { initialMs: 5_000, maxMs: 30_000 },
    ...(options.factory !== undefined ? { factory: options.factory } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const bus = createEventBus<ClientEvents>();

  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const app = new PlayerAppImpl(
    options.invite.roomId,
    identity,
    displayName,
    adapter,
    session,
    bus,
    ready,
    hostId === "host" ? "manual" : "nostr",
  );

  let welcomed = false;
  bus.on("welcome", () => {
    welcomed = true;
    resolveReady();
  });
  session.onClosed = (reason) => {
    if (!welcomed) rejectReady(new Error(`connection closed before welcome: ${reason}`));
    app.onDisconnected?.(reason);
  };
  let dropped = false;
  session.onStateChange = (state) => {
    app.onConnectionState?.(state);
    if (state === "failed") {
      // §6.5 keeps retrying underneath; over Manual signaling the player must
      // re-exchange codes, so surface the drop ("Host disconnected").
      if (!dropped && welcomed) {
        dropped = true;
        app.onDisconnected?.("connection lost");
      }
    }
    if (state === "connected") dropped = false;
    if (state === "connected" && app.client) {
      // §5/D-031 reconnect: same replica, fresh transport — the hello carries
      // lastSeq so the host answers ops-since-seq instead of a full snapshot.
      void (async () => {
        await session.transportOpen().catch(() => undefined);
        try {
          app.client?.reattach(session.transport);
        } catch (error) {
          console.warn("vtt: reattach failed", error);
        }
      })();
      return;
    }
    if (state === "connected" && !app.client) {
      void (async () => {
        const meta: StoreMeta = {
          worldId: options.invite.roomId,
          name: "Joining…",
          system: "mass-battle-basic",
          systemVersion: "1.0.0",
        };
        const client = new ClientSync({
          transport: session.transport,
          bus,
          meta,
          // §5A/N01: no schema/scene guess — the joiner adopts the host's
          // welcome-announced battle (active package columns + scene) before
          // the first sim frame, so PF1e campaigns decode correctly on join.
        });
        const cache = await AssetCache.open();
        const fetcher = new AssetFetcher({
          cache,
          request: (id, priority, offset) => client.requestAsset(id, priority, offset),
        });
        bus.on("asset", (chunk) => {
          app.assetChunks += 1;
          fetcher.onChunk(chunk);
        });
        app.attach(client, fetcher, cache);
        await session.transportOpen().catch(() => undefined); // channels ready
        const ts = Date.now();
        const sig = await signText(identity, helloPayload(options.invite.roomId, displayName, ts));
        client.connect({ kind: "hello", pubkey: identity.publicKeyHex, displayName, ts, sig });
      })().catch((error: unknown) => {
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      });
    }
  };

  await session.connect(); // pushes the offer code into the manual outbox
  return app;
}

/** ?relay=ws://… override (e2e-only plumbing; inert in normal use). */
function relayOverride(): string[] | undefined {
  const raw = globalThis.location?.search;
  if (!raw) return undefined;
  const value = new URLSearchParams(raw).get("relay");
  return value ? [value] : undefined;
}
