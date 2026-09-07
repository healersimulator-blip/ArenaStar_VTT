import { describe, expect, test } from "vitest";
import { verifyEvent, type Event } from "nostr-tools/pure";
import {
  DEFAULT_NOSTR_RELAYS,
  NOSTR_KIND,
  NostrSignalingAdapter,
  type RelaySocket,
} from "../../src/net/signaling/nostr";
import { deriveRoomKey } from "../../src/net/signaling/crypto";
import type { SignalMsg } from "../../src/core/net";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── in-memory relay hub (NIP-01 subset: REQ/EVENT, filter matching) ──────────

interface SubFilter {
  kinds: number[] | undefined;
  topics: string[] | undefined;
}

class FakeRelaySocket implements RelaySocket {
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  subId: string | null = null;
  filter: SubFilter | null = null;
  readonly sent: unknown[] = [];
  delivered = 0;

  constructor(
    private readonly relay: FakeRelay,
    readonly url: string,
  ) {
    relay.sockets.add(this);
  }

  send(data: string): void {
    const msg: unknown = JSON.parse(data);
    this.sent.push(msg);
    if (Array.isArray(msg) && msg[0] === "REQ") {
      this.subId = String(msg[1]);
      const raw = (msg[2] ?? {}) as { kinds?: number[]; "#t"?: string[] };
      this.filter = { kinds: raw.kinds, topics: raw["#t"] };
    }
    if (Array.isArray(msg) && msg[0] === "EVENT") {
      this.relay.broadcast(this, msg[1] as Event);
    }
  }

  close(): void {
    this.relay.sockets.delete(this);
  }

  /** Relay-side helpers (tests drive these). */
  serverOpen(): void {
    this.onopen?.();
  }

  serverClose(): void {
    this.relay.sockets.delete(this);
    this.onclose?.();
  }

  deliver(event: Event): void {
    this.delivered += 1;
    this.onmessage?.(JSON.stringify(["EVENT", this.subId, event]));
  }
}

class FakeRelay {
  readonly sockets = new Set<FakeRelaySocket>();
  created = 0;

  broadcast(_from: FakeRelaySocket, event: Event): void {
    for (const socket of this.sockets) {
      const filter = socket.filter;
      if (!filter) continue;
      if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
      const tagged = event.tags.some((t) => t[0] === "t" && filter.topics?.includes(t[1] ?? ""));
      if (filter.topics && !tagged) continue;
      socket.deliver(event); // relays echo to every matching subscriber (incl. sender)
    }
  }
}

/** url → hub registry so each relay URL is its own relay. */
function hubFactory(): {
  hubs: Map<string, FakeRelay>;
  socketsOf: (url: string) => FakeRelaySocket[];
  socket: (url: string) => RelaySocket;
} {
  const hubs = new Map<string, FakeRelay>();
  const socketsOf = (url: string): FakeRelaySocket[] => {
    const hub = hubs.get(url);
    return hub ? [...hub.sockets] : [];
  };
  const socket = (url: string): RelaySocket => {
    let hub = hubs.get(url);
    if (!hub) {
      hub = new FakeRelay();
      hubs.set(url, hub);
    }
    hub.created += 1;
    return new FakeRelaySocket(hub, url);
  };
  return { hubs, socketsOf, socket };
}

async function openAdapter(
  hub: ReturnType<typeof hubFactory>,
  roomId: string,
  secret: string,
  relays: string[],
): Promise<NostrSignalingAdapter> {
  const adapter = new NostrSignalingAdapter({
    relays,
    socket: hub.socket,
    backoff: { initialMs: 5, maxMs: 20 },
  });
  await adapter.open(roomId, await deriveRoomKey(secret, roomId));
  for (const url of relays) {
    for (const s of hub.socketsOf(url)) s.serverOpen();
  }
  await sleep(5);
  return adapter;
}

describe("NostrSignalingAdapter (§6.2)", () => {
  test("defaults: 3 public relays, ephemeral kind in the NIP-01 20000-range", () => {
    expect(DEFAULT_NOSTR_RELAYS).toHaveLength(3);
    expect(NOSTR_KIND).toBeGreaterThanOrEqual(20_000);
    expect(NOSTR_KIND).toBeLessThanOrEqual(29_999);
  });

  test("open subscribes with {kinds:[K], #t:[room]}; send publishes signed events to every relay", async () => {
    const hub = hubFactory();
    const a = await openAdapter(hub, "room-n1", "s1", ["wss://r1", "wss://r2"]);

    for (const url of ["wss://r1", "wss://r2"]) {
      const req = hub.socketsOf(url)[0]?.sent[0] as unknown[];
      expect(req?.[0]).toBe("REQ");
      expect(req?.[2]).toMatchObject({ kinds: [NOSTR_KIND], "#t": ["room-n1"], limit: 0 });
    }

    await a.send(a.selfId, { t: "leave" });
    await sleep(5);
    for (const url of ["wss://r1", "wss://r2"]) {
      const events = hub
        .socketsOf(url)[0]
        ?.sent.filter((m) => Array.isArray(m) && m[0] === "EVENT");
      expect(events).toHaveLength(1);
      const event = (events?.[0] as unknown[])[1] as Event;
      expect(event.kind).toBe(NOSTR_KIND);
      expect(event.tags).toContainEqual(["t", "room-n1"]);
      expect(event.content.startsWith("vtt1.")).toBe(true); // encrypted payload
      expect(event.content).not.toContain("leave"); // no plaintext leakage
      expect(verifyEvent(event)).toBe(true); // real NIP-01 signature
    }
    a.close();
  });

  test("room delivery: broadcast reaches all room members; sender id is the nostr pubkey", async () => {
    const hub = hubFactory();
    const relays = ["wss://r1"];
    const host = await openAdapter(hub, "room-n2", "s2", relays);
    const player = await openAdapter(hub, "room-n2", "s2", relays);

    const hostSeen: Array<{ from: string; msg: SignalMsg }> = [];
    host.onMessage((from, msg) => hostSeen.push({ from, msg }));

    const offer: SignalMsg = { t: "offer", sdp: "v=0 OFFER" };
    await player.send(host.selfId, offer);
    await sleep(10);

    expect(hostSeen).toEqual([{ from: player.selfId, msg: offer }]);
    host.close();
    player.close();
  });

  test("targeted send: only the addressed peer dispatches", async () => {
    const hub = hubFactory();
    const relays = ["wss://r1"];
    const host = await openAdapter(hub, "room-n3", "s3", relays);
    const p1 = await openAdapter(hub, "room-n3", "s3", relays);
    const p2 = await openAdapter(hub, "room-n3", "s3", relays);

    const p1Seen: SignalMsg[] = [];
    const p2Seen: SignalMsg[] = [];
    p1.onMessage((_f, m) => p1Seen.push(m));
    p2.onMessage((_f, m) => p2Seen.push(m));

    await host.send(p1.selfId, { t: "answer", sdp: "ANS" });
    await sleep(10);

    expect(p1Seen.map((m) => m.t)).toEqual(["answer"]);
    expect(p2Seen).toEqual([]); // routed, not broadcast
    host.close();
    p1.close();
    p2.close();
  });

  test("wrong room key or topic never dispatches", async () => {
    const hub = hubFactory();
    const relays = ["wss://r1"];
    const host = await openAdapter(hub, "room-n4", "s4", relays);
    // same topic but a different room secret → decryption fails silently
    const stranger = await openAdapter(hub, "room-n4", "OTHER-SECRET", relays);

    const strangerSeen: SignalMsg[] = [];
    stranger.onMessage((_f, m) => strangerSeen.push(m));

    await host.send(stranger.selfId, { t: "offer", sdp: "X" });
    await sleep(10);
    expect(strangerSeen).toEqual([]);

    // different topic: the relay filter itself blocks delivery
    const otherRoom = await openAdapter(hub, "room-OTHER", "s4", relays);
    const otherSeen: SignalMsg[] = [];
    otherRoom.onMessage((_f, m) => otherSeen.push(m));
    await host.send(otherRoom.selfId, { t: "offer", sdp: "Y" });
    await sleep(10);
    expect(otherSeen).toEqual([]);

    host.close();
    stranger.close();
    otherRoom.close();
  });

  test("multi-relay dedupe: identical event from two relays dispatches once", async () => {
    const hub = hubFactory();
    const relays = ["wss://r1", "wss://r2"];
    const host = await openAdapter(hub, "room-n5", "s5", relays);
    const player = await openAdapter(hub, "room-n5", "s5", relays);

    let dispatches = 0;
    host.onMessage(() => {
      dispatches += 1;
    });

    await player.send(host.selfId, { t: "ice", candidate: { candidate: "c" } });
    await sleep(10);

    // both relay sockets delivered the same event id...
    const d1 = hub.socketsOf("wss://r1")[0]?.delivered ?? 0;
    const d2 = hub.socketsOf("wss://r2")[0]?.delivered ?? 0;
    expect(d1).toBeGreaterThanOrEqual(1);
    expect(d2).toBeGreaterThanOrEqual(1);
    // ...but the adapter dispatched exactly once (and skipped the sender echo)
    expect(dispatches).toBe(1);
    host.close();
    player.close();
  });

  test("own broadcasts echoed by relays are not dispatched to self", async () => {
    const hub = hubFactory();
    const relays = ["wss://r1"];
    const host = await openAdapter(hub, "room-n6", "s6", relays);

    const selfSeen: SignalMsg[] = [];
    host.onMessage((_f, m) => selfSeen.push(m));
    await host.send(host.selfId, { t: "leave" });
    await sleep(10);

    // the hub echoed the event back to the sender's own subscription
    expect(hub.socketsOf("wss://r1")[0]?.delivered ?? 0).toBeGreaterThanOrEqual(1);
    expect(selfSeen).toEqual([]);
    host.close();
  });

  test("forged events (bad signature) are dropped", async () => {
    const hub = hubFactory();
    const relays = ["wss://r1"];
    const host = await openAdapter(hub, "room-n7", "s7", relays);
    const player = await openAdapter(hub, "room-n7", "s7", relays);

    const seen: SignalMsg[] = [];
    host.onMessage((_f, m) => seen.push(m));

    // forge: real signed event with the signature replaced
    await player.send(host.selfId, { t: "offer", sdp: "REAL" });
    await sleep(10);
    expect(seen).toHaveLength(1);

    const wire = hub
      .socketsOf("wss://r1")
      .flatMap((s) => s.sent)
      .find((m) => Array.isArray(m) && m[0] === "EVENT");
    const original = (wire as unknown[])[1] as Event;
    const forged: Event = {
      ...original,
      sig: original.sig.slice(0, 62) + (original.sig.endsWith("0") ? "1" : "0"),
    };
    hub.socketsOf("wss://r1")[0]?.deliver(forged);
    await sleep(10);

    expect(seen).toHaveLength(1); // forged copy dropped
    host.close();
    player.close();
  });

  test("relay drop → reconnect with REQ re-sent", async () => {
    const hub = hubFactory();
    const relays = ["wss://r1"];
    const host = await openAdapter(hub, "room-n8", "s8", relays);
    expect(hub.hubs.get("wss://r1")?.created).toBe(1);

    hub.socketsOf("wss://r1")[0]?.serverClose(); // relay drops us
    await sleep(30); // backoff 5 ms → reconnect

    expect(hub.hubs.get("wss://r1")?.created).toBe(2);
    const reconnected = hub.socketsOf("wss://r1")[0];
    expect(reconnected).toBeDefined();
    reconnected?.serverOpen();
    await sleep(5);
    const reqAgain = reconnected?.sent[0] as unknown[];
    expect(reqAgain?.[2]).toMatchObject({ kinds: [NOSTR_KIND], "#t": ["room-n8"] });
    host.close();
  });
});
