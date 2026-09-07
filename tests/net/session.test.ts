import { describe, expect, test } from "vitest";
import {
  ClientPeerSession,
  HostSessions,
  type PeerConnectionFactory,
  type PeerWire,
} from "../../src/net/peerSession";
import type {
  PeerConnectionState,
  SignalingAdapter,
  SignalMsg,
  Transport,
} from "../../src/core/net";
import { createTransportPair } from "../../src/net/memory";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── fake signaling bus (plaintext delivery, single-slot listeners) ───────────

class SignalBus {
  readonly listeners = new Map<string, (from: string, msg: SignalMsg) => void>();
}

class FakeAdapter implements SignalingAdapter {
  constructor(
    private readonly bus: SignalBus,
    readonly selfId: string,
  ) {}
  async open(): Promise<void> {}
  async send(to: string, msg: SignalMsg): Promise<void> {
    this.bus.listeners.get(to)?.(this.selfId, msg);
  }
  onMessage(cb: (from: string, msg: SignalMsg) => void): void {
    this.bus.listeners.set(this.selfId, cb);
  }
  close(): void {
    this.bus.listeners.delete(this.selfId);
  }
}

// ─── loopback peer factory: token SDPs over InMemoryTransport pairs ───────────

class SimplePeer implements PeerWire {
  private readonly cbs: Array<(s: PeerConnectionState) => void> = [];
  state: PeerConnectionState = "new";

  constructor(
    private readonly factory: SimpleFactory,
    readonly transport: Transport,
    readonly offerToken: string,
  ) {}

  offer(): Promise<string> {
    return Promise.resolve(this.offerToken);
  }

  answer(): Promise<string> {
    return Promise.resolve(`ans-${this.offerToken}`);
  }

  async acceptAnswer(answerToken: string): Promise<void> {
    const host = this.factory.hostByToken.get(answerToken.slice(4));
    if (!host) throw new Error(`fake: unknown answer ${answerToken}`);
    host.setState("connected");
    this.setState("connected");
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  onStateChange(cb: (s: PeerConnectionState) => void): void {
    this.cbs.push(cb);
  }

  setState(s: PeerConnectionState): void {
    this.state = s;
    for (const cb of this.cbs) cb(s);
  }

  close(): void {
    this.setState("closed");
  }
}

class SimpleFactory implements PeerConnectionFactory {
  offersSent = 0;
  lastClient: SimplePeer | null = null;
  private readonly mates = new Map<string, Transport>();
  readonly hostByToken = new Map<string, SimplePeer>();

  createClientPeer(): PeerWire {
    const pair = createTransportPair();
    const token = `off-${++this.offersSent}`;
    this.mates.set(token, pair.b);
    const peer = new SimplePeer(this, pair.a, token);
    this.lastClient = peer;
    return peer;
  }

  async createHostPeer(offerSdp: string): Promise<PeerWire> {
    const mate = this.mates.get(offerSdp);
    if (!mate) throw new Error(`fake: unknown offer ${offerSdp}`);
    const host = new SimplePeer(this, mate, offerSdp);
    this.hostByToken.set(offerSdp, host);
    return host;
  }
}

const SKEW_MS = 5_000; // host clock runs 5 s ahead

async function makeHost(
  bus: SignalBus,
  factory: SimpleFactory,
): Promise<{
  host: HostSessions;
  sessions: Array<{ peerId: string; transport: Transport }>;
  closed: Array<{ peerId: string; reason: string }>;
}> {
  const host = new HostSessions({
    adapter: new FakeAdapter(bus, "host-1"),
    factory,
    heartbeatMs: 5,
    staleMs: 40,
    now: () => Date.now() + SKEW_MS,
  });
  const sessions: Array<{ peerId: string; transport: Transport }> = [];
  const closed: Array<{ peerId: string; reason: string }> = [];
  (host as unknown as { onSession: (p: string, t: Transport) => void }).onSession = (p, t) =>
    sessions.push({ peerId: p, transport: t });
  (host as unknown as { onClosed: (p: string, r: string) => void }).onClosed = (p, r) =>
    closed.push({ peerId: p, reason: r });
  host.start();
  return { host, sessions, closed };
}

function makeClient(bus: SignalBus, factory: SimpleFactory, id: string): ClientPeerSession {
  return new ClientPeerSession({
    adapter: new FakeAdapter(bus, id),
    hostId: "host-1",
    factory,
    heartbeatMs: 5,
    backoff: { initialMs: 10, factor: 2, maxMs: 40 },
  });
}

describe("PeerSession layer (§6.5)", () => {
  test("handshake over signaling establishes both transports and fires onSession", async () => {
    const bus = new SignalBus();
    const factory = new SimpleFactory();
    const { host, sessions } = await makeHost(bus, factory);
    const client = makeClient(bus, factory, "client-1");
    await client.connect();
    await sleep(20);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.peerId).toBe("client-1");
    expect(client.stats.state).toBe("connected");
    expect(host.size).toBe(1);

    client.close("done");
    host.close();
  });

  test("heartbeat: client pings, host pongs; rtt + NTP-style clock offset", async () => {
    const bus = new SignalBus();
    const factory = new SimpleFactory();
    const { host } = await makeHost(bus, factory);
    const client = makeClient(bus, factory, "client-2");
    await client.connect();
    await sleep(40);

    expect(client.stats.rttMs).not.toBeNull();
    expect(client.stats.rttMs).toBeLessThan(30);
    // host clock is SKEW_MS ahead: offset ≈ +5000 ms
    expect(client.stats.clockOffsetMs).not.toBeNull();
    expect(Math.abs((client.stats.clockOffsetMs ?? 0) - SKEW_MS)).toBeLessThan(30);

    client.close("done");
    host.close();
  });

  test("ping/pong never reach consumers; other frames pass through untouched", async () => {
    const bus = new SignalBus();
    const factory = new SimpleFactory();
    const { host, sessions } = await makeHost(bus, factory);
    const client = makeClient(bus, factory, "client-3");
    await client.connect();
    await sleep(15);

    const seenByClient: Array<[string, number]> = [];
    client.transport.onMessage = (channel, bytes) => {
      seenByClient.push([channel, bytes[0] ?? 0]);
    };
    sessions[0]?.transport.send("ops", new Uint8Array([9, 9, 9]));
    await sleep(15);

    // exactly the one passthrough frame — zero pings/pongs surfaced
    expect(seenByClient).toEqual([["ops", 9]]);

    client.close("done");
    host.close();
  });

  test("host reaps silent peers as heartbeat timeouts (§6.5)", async () => {
    const bus = new SignalBus();
    const factory = new SimpleFactory();
    const { host, closed } = await makeHost(bus, factory);
    const client = makeClient(bus, factory, "client-4");
    await client.connect();
    await sleep(10);
    expect(host.size).toBe(1);

    // go silent: leave "connected" without closing (heartbeats stop)
    (client as unknown as { state: string }).state = "connecting";
    await sleep(80);

    expect(closed).toContainEqual({ peerId: "client-4", reason: "heartbeat timeout" });
    expect(host.size).toBe(0);
    client.close("done");
    host.close();
  });

  test("failure → exponential reconnect re-offers; host replaces the session", async () => {
    const bus = new SignalBus();
    const factory = new SimpleFactory();
    const { host, sessions, closed } = await makeHost(bus, factory);
    const client = makeClient(bus, factory, "client-5");
    await client.connect();
    await sleep(15);
    expect(sessions).toHaveLength(1);
    expect((client as unknown as { attempts: number }).attempts).toBe(0);

    factory.lastClient?.setState("failed");
    await sleep(50); // 10 ms backoff → re-offer → new session

    expect(factory.offersSent).toBe(2);
    expect(sessions).toHaveLength(2);
    expect(closed).toContainEqual({ peerId: "client-5", reason: "replaced by new offer" });
    expect(client.stats.state).toBe("connected");
    expect((client as unknown as { attempts: number }).attempts).toBe(0); // reset on success

    client.close("done");
    host.close();
  });

  test("host leave closes the client session", async () => {
    const bus = new SignalBus();
    const factory = new SimpleFactory();
    const { host } = await makeHost(bus, factory);
    const client = makeClient(bus, factory, "client-6");
    await client.connect();
    await sleep(10);

    const reasons: string[] = [];
    client.onClosed = (reason) => reasons.push(reason);
    // the host's adapter sends leave addressed to the client's signaling id
    bus.listeners.get("client-6")?.("host-1", { t: "leave" });
    await sleep(10);

    expect(reasons).toEqual(["host left"]);
    expect(client.stats.state).toBe("closed");
    host.close();
  });

  test("transport before connect throws; close() is idempotent and fires onClosed once", async () => {
    const bus = new SignalBus();
    const factory = new SimpleFactory();
    const { host } = await makeHost(bus, factory);
    const client = makeClient(bus, factory, "client-7");
    expect(() => client.transport).toThrow("not connected");

    await client.connect();
    await sleep(10);
    const reasons: string[] = [];
    client.onClosed = (r) => reasons.push(r);
    client.close("bye");
    client.close("bye");
    expect(reasons).toEqual(["bye"]);
    host.close();
  });
});
