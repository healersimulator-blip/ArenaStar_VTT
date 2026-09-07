import type { DerivedImage, DeriveTarget, ImageCodec } from "../../src/workers/assetJob";
import { bootHostApp, type HostApp } from "../../src/app/hostBoot";
import { openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";

/** Deterministic fake codec: no real decode, fixed 2000×1500 derivations. */
export class FakeCodec implements ImageCodec {
  constructor(
    private readonly w = 2000,
    private readonly h = 1500,
  ) {}

  async metadata(): Promise<{ width: number; height: number }> {
    return { width: this.w, height: this.h };
  }

  async derive(
    bytes: Uint8Array,
    _m: string,
    targets: readonly DeriveTarget[],
  ): Promise<DerivedImage[]> {
    return targets.map((t, i) => ({
      bytes: new Uint8Array([...bytes, i]),
      mime: t.mime,
      width: this.w,
      height: this.h,
    }));
  }

  async tile(): Promise<never> {
    throw new Error("no tiling in this fake");
  }
}

export const settle = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

export async function boot(root?: MemDirHandle, worldId?: string): Promise<HostApp> {
  return bootHostApp({
    db: await openVttDb(),
    root: root ?? new MemDirHandle(),
    codec: new FakeCodec(),
    ...(worldId !== undefined ? { worldId: worldId as HostApp["worldId"] } : {}),
  });
}

// ─── in-memory RTC halves (join/reconnect tests) ─────────────────────────────

import type { PeerConnectionFactory, PeerWire } from "../../src/net/peerSession";
import type { PeerConnectionState, Transport } from "../../src/core/net";
import { createTransportPair } from "../../src/net/memory";
import { ManualSignalingAdapter } from "../../src/net/signaling/manual";

export class MemClientWire implements PeerWire {
  onStateCb: ((state: PeerConnectionState) => void) | null = null;
  hostSide: MemHostWire | null = null;
  constructor(readonly transport: Transport) {}

  async offer(): Promise<string> {
    return "mem-offer";
  }
  async acceptAnswer(sdp: string): Promise<void> {
    void sdp;
    this.onStateCb?.("connected");
    this.hostSide?.onStateCb?.("connected");
  }
  async answer(): Promise<string> {
    throw new Error("client never answers");
  }
  async addIceCandidate(): Promise<void> {}
  onStateChange(cb: (state: PeerConnectionState) => void): void {
    this.onStateCb = cb;
  }
  close(): void {
    this.onStateCb?.("closed");
    this.hostSide?.onStateCb?.("failed"); // ICE-death equivalent
  }
}

export class MemHostWire implements PeerWire {
  onStateCb: ((state: PeerConnectionState) => void) | null = null;
  clientSide: MemClientWire | null = null;
  constructor(readonly transport: Transport) {}

  async offer(): Promise<string> {
    throw new Error("host never offers");
  }
  async acceptAnswer(): Promise<void> {
    throw new Error("host never accepts");
  }
  async answer(): Promise<string> {
    return "mem-answer";
  }
  async addIceCandidate(): Promise<void> {}
  onStateChange(cb: (state: PeerConnectionState) => void): void {
    this.onStateCb = cb;
  }
  close(): void {
    this.onStateCb?.("closed");
    this.clientSide?.onStateCb?.("failed"); // the player sees the drop
  }
}

/** Pairs client/host halves; one instance must be shared by BOTH peers. */
export class MemFactory implements PeerConnectionFactory {
  private pending: MemHostWire | null = null;

  createClientPeer(): PeerWire {
    const pair = createTransportPair();
    const client = new MemClientWire(pair.a);
    this.pending = new MemHostWire(pair.b);
    client.hostSide = this.pending;
    this.pending.clientSide = client;
    return client;
  }

  async createHostPeer(offerSdp: string): Promise<PeerWire> {
    void offerSdp;
    const host = this.pending;
    if (!host) throw new Error("mem factory: no pending client offer");
    this.pending = null;
    return host;
  }
}

/** Ferries manual outbox codes between already-OPEN adapters until stopped. */
export class ManualPump {
  private readonly sides: ManualSignalingAdapter[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  addSide(adapter: ManualSignalingAdapter): void {
    this.sides.push(adapter); // caller opens it with the real room key
  }

  start(intervalMs = 5): void {
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  tick(): void {
    for (const from of this.sides) {
      let codes: string[];
      try {
        codes = from.takeOutbox();
      } catch {
        continue; // closed side
      }
      for (const code of codes) {
        for (const to of this.sides) {
          if (to !== from) void to.receiveCode(code).catch(() => undefined);
        }
      }
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

// ─── joined host+player pair over the real manual-crypto path ────────────────

import { startHostShare, type HostShare } from "../../src/app/hostShare";
import { bootPlayerApp, type PlayerApp } from "../../src/app/joinBoot";

export interface JoinedPair {
  hostApp: HostApp;
  playerApp: PlayerApp;
  share: HostShare;
  pump: ManualPump;
}

/** Boot host + player, join them, resolve once the player replica is live. */
export async function joinHostPlayer(secret = "sheet-secret"): Promise<JoinedPair> {
  const db = await openVttDb();
  const hostApp = await boot();
  const pump = new ManualPump();
  const factory = new MemFactory();
  const share = await startHostShare(hostApp, {
    adapter: new ManualSignalingAdapter(),
    secret,
    factory,
  });
  pump.addSide(share.adapter);
  pump.start();
  const playerAdapter = new ManualSignalingAdapter();
  const playerApp = await bootPlayerApp({
    invite: { roomId: share.roomId, secret },
    adapter: playerAdapter,
    factory,
    db,
  });
  pump.addSide(playerAdapter);
  await Promise.race([
    playerApp.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("join timeout")), 5_000)),
  ]);
  return { hostApp, playerApp, share, pump };
}
