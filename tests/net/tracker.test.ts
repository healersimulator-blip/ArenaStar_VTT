import { describe, expect, test } from "vitest";
import { TrackerSignalingAdapter } from "../../src/net/signaling/tracker";
import type { RelaySocket } from "../../src/net/signaling/nostr";
import { deriveRoomKey } from "../../src/net/signaling/crypto";
import type { SignalMsg } from "../../src/core/net";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── fake tracker: swarm semantics (offers broadcast, answers routed) ────────

interface SwarmClient {
  peerId: string;
  infoHash: string;
  socket: FakeTrackerSocket;
}

class FakeTracker {
  readonly swarms = new Map<string, Set<SwarmClient>>(); // infoHash → members

  ingest(from: FakeTrackerSocket, data: string): void {
    const msg = JSON.parse(data) as {
      action?: string;
      info_hash?: string;
      peer_id?: string;
      offers?: Array<{ offer: unknown; offer_id: string }>;
      answer?: unknown;
      to_peer_id?: string;
      offer_id?: string;
    };
    if (msg.action !== "announce" || !msg.info_hash || !msg.peer_id) return;
    const swarm = this.swarms.get(msg.info_hash) ?? new Set<SwarmClient>();
    this.swarms.set(msg.info_hash, swarm);
    const client: SwarmClient = { peerId: msg.peer_id, infoHash: msg.info_hash, socket: from };
    // replace prior registration of the same socket
    for (const existing of swarm) {
      if (existing.socket === from) swarm.delete(existing);
    }
    swarm.add(client);

    if (msg.to_peer_id !== undefined && msg.answer !== undefined) {
      // routed answer: deliver to the addressed peer only
      for (const peer of swarm) {
        if (peer.peerId === msg.to_peer_id) {
          peer.socket.deliver({
            action: "announce",
            info_hash: msg.info_hash,
            peer_id: msg.peer_id,
            answer: msg.answer,
            offer_id: msg.offer_id,
          });
        }
      }
      return;
    }
    for (const offer of msg.offers ?? []) {
      // broadcast: forward the opaque offer to every OTHER member
      for (const peer of swarm) {
        if (peer.socket === from) continue;
        peer.socket.deliver({
          action: "announce",
          info_hash: msg.info_hash,
          peer_id: msg.peer_id,
          offer: offer.offer,
          offer_id: offer.offer_id,
        });
      }
    }
  }
}

class FakeTrackerSocket implements RelaySocket {
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(
    private readonly tracker: FakeTracker,
    readonly url: string,
  ) {}

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    this.tracker.ingest(this, data);
  }

  close(): void {
    /* hub forgets via swarm replacement in tests */
  }

  deliver(msg: Record<string, unknown>): void {
    this.onmessage?.(JSON.stringify(msg));
  }
}

function trackerWorld(): {
  tracker: FakeTracker;
  sockets: FakeTrackerSocket[];
  factory: (url: string) => RelaySocket;
} {
  const tracker = new FakeTracker();
  const sockets: FakeTrackerSocket[] = [];
  const factory = (url: string): RelaySocket => {
    const socket = new FakeTrackerSocket(tracker, url);
    sockets.push(socket);
    return socket;
  };
  return { tracker, sockets, factory };
}

async function openTracker(
  world: ReturnType<typeof trackerWorld>,
  roomId: string,
  secret: string,
): Promise<TrackerSignalingAdapter> {
  const adapter = new TrackerSignalingAdapter({
    trackers: ["wss://t1"],
    socket: world.factory,
    backoff: { initialMs: 5, maxMs: 20 },
  });
  await adapter.open(roomId, await deriveRoomKey(secret, roomId));
  const socket = world.sockets[world.sockets.length - 1];
  socket?.onopen?.();
  await sleep(5);
  return adapter;
}

describe("TrackerSignalingAdapter (§6.2 WebTorrent trackers)", () => {
  test("announce carries info_hash = sha1(roomId) (40 hex) and joins the swarm", async () => {
    const world = trackerWorld();
    const a = await openTracker(world, "room-tr", "s");
    const join = world.sockets[0]?.sent[0];
    expect(join?.["action"]).toBe("announce");
    expect(String(join?.["info_hash"])).toMatch(/^[0-9a-f]{40}$/);
    expect(join?.["numwant"]).toBe(0);
    void a;
    a.close();
  });

  test("unknown target broadcasts as an opaque offer; peer receives + dispatches", async () => {
    const world = trackerWorld();
    const host = await openTracker(world, "room-tr2", "s");
    const player = await openTracker(world, "room-tr2", "s");

    const hostSeen: Array<{ from: string; msg: SignalMsg }> = [];
    host.onMessage((from, msg) => hostSeen.push({ from, msg }));

    const offer: SignalMsg = { t: "offer", sdp: "TR-OFFER" };
    await player.send(host.selfId, offer); // host unknown to player yet → broadcast
    await sleep(15);

    // broadcast announce shape: offers[] with the ciphertext riding `offer`
    const broadcast = world.sockets[1]?.sent.find(
      (m) => Array.isArray(m["offers"]) && (m["offers"] as unknown[]).length > 0,
    );
    expect(broadcast).toBeDefined();
    const offers = broadcast?.["offers"] as Array<{ offer: string }>;
    expect(offers[0]?.offer.startsWith("vtt1.")).toBe(true);

    expect(hostSeen).toEqual([{ from: player.selfId, msg: offer }]);
    host.close();
    player.close();
  });

  test("after learning the peer, replies route as answers via to_peer_id", async () => {
    const world = trackerWorld();
    const host = await openTracker(world, "room-tr3", "s");
    const player = await openTracker(world, "room-tr3", "s");

    const playerSeen: Array<{ from: string; t: string }> = [];
    player.onMessage((from, msg) => playerSeen.push({ from, t: msg.t }));

    // player broadcasts an offer → host receives (and learns player's transport id)
    const hostSeen: Array<{ from: string; t: string }> = [];
    host.onMessage((from, msg) => hostSeen.push({ from, t: msg.t }));
    await player.send(host.selfId, { t: "offer", sdp: "O1" });
    await sleep(15);
    expect(hostSeen).toHaveLength(1);

    // host now knows the player → the answer is a ROUTED tracker answer
    await host.send(player.selfId, { t: "answer", sdp: "A1" });
    await sleep(15);

    const routed = world.sockets[0]?.sent.find((m) => m["to_peer_id"] !== undefined);
    expect(routed).toBeDefined();
    expect(String(routed?.["answer"]).startsWith("vtt1.")).toBe(true);
    expect(routed?.["to_peer_id"]).toBeDefined();

    expect(playerSeen).toEqual([{ from: host.selfId, t: "answer" }]);
    host.close();
    player.close();
  });

  test("different rooms are separate swarms (info_hash isolation)", async () => {
    const world = trackerWorld();
    const a = await openTracker(world, "room-A", "s");
    const b = await openTracker(world, "room-B", "s");

    const bSeen: SignalMsg[] = [];
    b.onMessage((_f, m) => bSeen.push(m));
    await a.send(b.selfId, { t: "offer", sdp: "X" });
    await sleep(15);
    expect(bSeen).toEqual([]);
    a.close();
    b.close();
  });

  test("duplicate delivery (offer seen twice) dispatches once", async () => {
    const world = trackerWorld();
    const host = await openTracker(world, "room-tr4", "s");
    const player = await openTracker(world, "room-tr4", "s");

    let dispatches = 0;
    host.onMessage(() => {
      dispatches += 1;
    });
    await player.send(host.selfId, { t: "ice", candidate: { candidate: "c1" } });
    await sleep(15);
    // replay the same announce frame directly at the host socket
    const wire = world.sockets[1]?.sent.find(
      (m) => Array.isArray(m["offers"]) && (m["offers"] as unknown[]).length > 0,
    );
    const infoHash = wire?.["info_hash"];
    const peerId = wire?.["peer_id"];
    const offers = wire?.["offers"] as Array<{ offer: string; offer_id: string }>;
    world.sockets[0]?.deliver({
      action: "announce",
      info_hash: infoHash,
      peer_id: peerId,
      offer: offers[0]?.offer,
      offer_id: offers[0]?.offer_id,
    });
    await sleep(15);
    expect(dispatches).toBe(1);
    host.close();
    player.close();
  });
});
