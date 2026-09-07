/**
 * §7 end-to-end over the loopback transport: AssetServer ⇄ HostSync ⇄
 * InMemoryTransport ⇄ ClientSync ⇄ AssetCache/AssetFetcher.
 */
import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { HostSync, type HostEvents } from "../../src/host/sync";
import { AssetServer, wireManifestToStore } from "../../src/host/assets";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { AssetCache, AssetFetcher, type AssetCacheBackend } from "../../src/client/assets";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";

const meta: StoreMeta = {
  worldId: "w-loop",
  name: "Loop",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};

class MemBackend implements AssetCacheBackend {
  readonly map = new Map<string, { bytes: Uint8Array; mime: string }>();
  async get(hash: string) {
    return this.map.get(hash);
  }
  async put(hash: string, bytes: Uint8Array, mime: string) {
    this.map.set(hash, { bytes: new Uint8Array(bytes), mime });
  }
  async has(hash: string) {
    return this.map.has(hash);
  }
}

interface Peer {
  client: ClientSync;
  bus: ReturnType<typeof createEventBus<ClientEvents>>;
  fetcher: AssetFetcher;
  pair: ReturnType<typeof createTransportPair>;
}

async function setup(worldId: string): Promise<{
  host: HostSync;
  server: AssetServer;
  hostStore: DocumentStore;
  importAsset: (size: number, name: string) => Promise<string>;
  addPeer: (pubkey: string, cache: AssetCache) => Promise<Peer>;
}> {
  const db = await openVttDb();
  const root = new MemDirHandle();
  const hostStore = new DocumentStore({ meta });
  const server = await AssetServer.open({ worldId, db, root, chunkSize: 1024 });
  wireManifestToStore(server, hostStore);
  const hostBus = createEventBus<HostEvents>();
  const host = new HostSync({
    store: hostStore,
    log: new OpLog(),
    undo: new UndoStack(),
    bus: hostBus,
    systemUserId: "gm-loop",
    roomId: "room-loop",
    verifyHelloSig: async () => true,
    rng: () => 0.25,
    assets: server,
    assetTransfer: { chunkSize: 1024, bytesPerSecond: 1 << 30 }, // real clock: pacing gate must be able to fall due
  });
  hostBus.on("join:request", ({ approve }) => approve());

  const importAsset = async (size: number, name: string) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7) % 256;
    const { hash } = await server.import(bytes, name, "application/octet-stream");
    return hash;
  };

  const addPeer = async (pubkey: string, cache: AssetCache) => {
    const pair = createTransportPair();
    host.addSession(`peer-${pubkey}`, pair.a);
    const bus = createEventBus<ClientEvents>();
    const client = new ClientSync({ transport: pair.b, bus, meta });
    const fetcher = new AssetFetcher({
      cache,
      request: (id, priority, offset) => client.requestAsset(id, priority, offset),
    });
    bus.on("asset", (m) => fetcher.onChunk(m));
    client.connect({ kind: "hello", pubkey, displayName: pubkey, ts: 1, sig: "valid" });
    await flushMicrotasks();
    return { client, bus, fetcher, pair };
  };

  return { host, server, hostStore, importAsset, addPeer };
}

describe("assets over the wire (§7)", () => {
  test("import → manifest in world → lazy fetch streams chunks → cache filled", async () => {
    const h = await setup("w-loop-a");
    const hash = await h.importAsset(2500, "map.bin"); // 3 chunks @ 1024
    expect(h.hostStore.world.assetManifest[hash]).toMatchObject({
      name: "map.bin",
      size: 2500,
      chunks: 3,
    });

    const cache = AssetCache.withBackend(new MemBackend());
    const peer = await h.addPeer("loop-pl", cache);
    const bytes = await peer.fetcher.request(hash, "scene");
    expect(bytes.length).toBe(2500);
    expect(bytes[1024]).toBe((1024 * 7) % 256);
    expect(await cache.has(hash)).toBe(true);
  });

  test("cache hit on rejoin: no asset.get on the wire", async () => {
    const h = await setup("w-loop-b");
    const hash = await h.importAsset(800, "shared.bin");
    const backend = new MemBackend();
    const cache = AssetCache.withBackend(backend);

    const first = await h.addPeer("joiner-a", cache);
    expect((await first.fetcher.request(hash)).length).toBe(800);
    expect(await cache.has(hash)).toBe(true);

    const second = await h.addPeer("joiner-b", cache);
    const sentBefore = second.pair.b.stats.channels.ops.sentMessages; // hello only
    const bytes = await second.fetcher.request(hash); // must come from cache
    expect(bytes.length).toBe(800);
    expect(second.pair.b.stats.channels.ops.sentMessages).toBe(sentBefore); // no asset.get
  });

  test("wire resume: asset.get with a non-zero offset restarts there", async () => {
    const h = await setup("w-loop-c");
    const hash = await h.importAsset(2500, "resume.bin");
    const peer = await h.addPeer("resumer", AssetCache.withBackend(new MemBackend()));
    const offsets: number[] = [];
    peer.bus.on("asset", (m) => offsets.push(m.offset));
    peer.client.requestAsset(hash, "scene", 1024);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(offsets[0]).toBe(1024);
    expect(offsets[offsets.length - 1]).toBe(2048); // final chunk of 3
  });

  test("asset requests are rate limited per session (§16): burst 20, rest dropped", async () => {
    const h = await setup("w-loop-d");
    const peer = await h.addPeer("flood", AssetCache.withBackend(new MemBackend()));
    const misses: string[] = [];
    peer.bus.on("asset", (m) => {
      if (m.total === 0) misses.push(m.assetId);
    });
    for (let i = 0; i < 25; i++) {
      peer.client.requestAsset(`unknown-${i}`, "scene", 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(misses).toHaveLength(20); // burst consumed; 5 dropped silently
  });

  test("unauthenticated sessions get no assets (§16)", async () => {
    const h = await setup("w-loop-e");
    const hash = await h.importAsset(100, "locked.bin");
    // a session that never sends hello stays unauthenticated
    const pair = createTransportPair();
    h.host.addSession("peer-never", pair.a);
    const bus = createEventBus<ClientEvents>();
    const silent = new ClientSync({ transport: pair.b, bus, meta });
    const chunks: number[] = [];
    bus.on("asset", () => chunks.push(1));
    silent.requestAsset(hash, "scene", 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks).toHaveLength(0);
  });
});
