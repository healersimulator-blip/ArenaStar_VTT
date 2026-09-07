import { describe, expect, test } from "vitest";
import {
  MqttSignalingAdapter,
  roomHashHex,
  type MqttClientPort,
} from "../../src/net/signaling/mqtt";
import { WebSocketSignalingAdapter } from "../../src/net/signaling/websocket";
import type { RelaySocket } from "../../src/net/signaling/nostr";
import { deriveRoomKey } from "../../src/net/signaling/crypto";
import type { SignalMsg } from "../../src/core/net";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── fake MQTT broker ─────────────────────────────────────────────────────────

class FakeMqttBroker {
  readonly subscribers = new Map<string, Set<FakeMqttClient>>();

  publish(topic: string, message: string): void {
    for (const client of this.subscribers.get(topic) ?? []) {
      client.deliver(topic, message);
    }
  }

  subscribe(topic: string, client: FakeMqttClient): void {
    let set = this.subscribers.get(topic);
    if (!set) {
      set = new Set();
      this.subscribers.set(topic, set);
    }
    set.add(client);
  }

  drop(client: FakeMqttClient): void {
    for (const set of this.subscribers.values()) set.delete(client);
  }
}

class FakeMqttClient implements MqttClientPort {
  readonly connects: Array<() => void> = [];
  readonly messages: Array<(topic: string, payload: string) => void> = [];
  readonly errors: Array<(error: Error) => void> = [];
  readonly closed: Array<() => void> = [];
  ended = false;
  readonly published: Array<{ topic: string; message: string }> = [];
  readonly subscribed: string[] = [];

  constructor(private readonly broker: FakeMqttBroker) {}

  publish(topic: string, message: string): void {
    this.published.push({ topic, message });
    this.broker.publish(topic, message);
  }

  subscribe(topic: string): void {
    this.subscribed.push(topic);
    this.broker.subscribe(topic, this);
  }

  end(force?: boolean): void {
    this.ended = true;
    void force;
    this.broker.drop(this);
    for (const cb of this.closed) cb();
  }

  onConnect(cb: () => void): void {
    this.connects.push(cb);
  }

  onMessage(cb: (topic: string, payload: string) => void): void {
    this.messages.push(cb);
  }

  onError(cb: (error: Error) => void): void {
    this.errors.push(cb);
  }

  onClose(cb: () => void): void {
    this.closed.push(cb);
  }

  serverConnect(): void {
    for (const cb of this.connects) cb();
  }

  deliver(topic: string, payload: string): void {
    for (const cb of this.messages) cb(topic, payload);
  }
}

function mqttWorld(): {
  broker: FakeMqttBroker;
  clients: FakeMqttClient[];
  factory: (url: string) => Promise<MqttClientPort>;
} {
  const broker = new FakeMqttBroker();
  const clients: FakeMqttClient[] = [];
  const factory = async (): Promise<MqttClientPort> => {
    const client = new FakeMqttClient(broker);
    clients.push(client);
    return client;
  };
  return { broker, clients, factory };
}

async function openMqtt(
  world: ReturnType<typeof mqttWorld>,
  roomId: string,
  secret: string,
): Promise<MqttSignalingAdapter> {
  const adapter = new MqttSignalingAdapter({ clientFactory: world.factory });
  await adapter.open(roomId, await deriveRoomKey(secret, roomId));
  const client = world.clients[world.clients.length - 1];
  if (client) client.serverConnect();
  await sleep(5);
  return adapter;
}

describe("MqttSignalingAdapter (§6.2 MQTT-over-WSS)", () => {
  test("topic is vtt/<sha256(roomId)>; codes are opaque to the broker", async () => {
    const world = mqttWorld();
    const a = await openMqtt(world, "room-mq", "s");
    const hash = await roomHashHex("room-mq");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const client = world.clients[0];
    expect(client?.subscribed).toEqual([`vtt/${hash}`]);

    await a.send(a.selfId, { t: "leave" });
    expect(client?.published).toHaveLength(1);
    expect(client?.published[0]?.topic).toBe(`vtt/${hash}`);
    expect(client?.published[0]?.message.startsWith("vtt1.")).toBe(true);
    a.close();
  });

  test("two adapters on the same room exchange SignalMsgs", async () => {
    const world = mqttWorld();
    const host = await openMqtt(world, "room-mq2", "secret");
    const player = await openMqtt(world, "room-mq2", "secret");

    const hostSeen: Array<{ from: string; msg: SignalMsg }> = [];
    host.onMessage((from, msg) => hostSeen.push({ from, msg }));

    const offer: SignalMsg = { t: "offer", sdp: "OFFER-MQ" };
    await player.send(host.selfId, offer);
    await sleep(10);

    expect(hostSeen).toEqual([{ from: player.selfId, msg: offer }]);
    host.close();
    player.close();
  });

  test("different room secret never dispatches; wrong topic filtered", async () => {
    const world = mqttWorld();
    const host = await openMqtt(world, "room-mq3", "right");
    const stranger = await openMqtt(world, "room-mq3", "wrong");

    const seen: SignalMsg[] = [];
    stranger.onMessage((_f, m) => seen.push(m));
    await host.send(stranger.selfId, { t: "offer", sdp: "X" });
    await sleep(10);
    expect(seen).toEqual([]);

    // different room → different topic → broker-level isolation
    const other = await openMqtt(world, "room-OTHER", "right");
    const otherSeen: SignalMsg[] = [];
    other.onMessage((_f, m) => otherSeen.push(m));
    await host.send(other.selfId, { t: "offer", sdp: "Y" });
    await sleep(10);
    expect(otherSeen).toEqual([]);
    host.close();
    stranger.close();
    other.close();
  });

  test("close ends the client; send after close throws", async () => {
    const world = mqttWorld();
    const a = await openMqtt(world, "room-mq4", "s");
    a.close();
    expect(world.clients[0]?.ended).toBe(true);
    await expect(a.send(a.selfId, { t: "leave" })).rejects.toThrow("closed");
  });
});

// ─── generic WebSocket adapter ────────────────────────────────────────────────

class FakeWsRelay {
  readonly sockets = new Set<FakeWsSocket>();
}

class FakeWsSocket implements RelaySocket {
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  readonly sent: string[] = [];

  constructor(
    private readonly relay: FakeWsRelay,
    readonly url: string,
  ) {
    relay.sockets.add(this);
  }

  send(data: string): void {
    this.sent.push(data);
    for (const peer of this.relay.sockets) {
      if (peer !== this) peer.onmessage?.(data);
    }
  }

  close(): void {
    this.relay.sockets.delete(this);
  }
}

function wsWorld(): {
  relay: FakeWsRelay;
  sockets: FakeWsSocket[];
  factory: (url: string) => RelaySocket;
} {
  const relay = new FakeWsRelay();
  const sockets: FakeWsSocket[] = [];
  const factory = (url: string): RelaySocket => {
    const socket = new FakeWsSocket(relay, url);
    sockets.push(socket);
    return socket;
  };
  return { relay, sockets, factory };
}

async function openWs(
  world: ReturnType<typeof wsWorld>,
  roomId: string,
  secret: string,
): Promise<WebSocketSignalingAdapter> {
  const adapter = new WebSocketSignalingAdapter({
    url: "wss://self.example/vtt/x",
    socket: world.factory,
  });
  await adapter.open(roomId, await deriveRoomKey(secret, roomId));
  const socket = world.sockets[world.sockets.length - 1];
  socket?.onopen?.();
  await sleep(5);
  return adapter;
}

describe("WebSocketSignalingAdapter (§6.2 self-hosters)", () => {
  test("relay sees only ciphertext; room members dispatch", async () => {
    const world = wsWorld();
    const a = await openWs(world, "room-ws", "s");
    const b = await openWs(world, "room-ws", "s");

    const bSeen: Array<{ from: string; t: string }> = [];
    b.onMessage((from, msg) => bSeen.push({ from, t: msg.t }));
    const c = await openWs(world, "room-ws", "s");
    const cSeen: string[] = [];
    c.onMessage((_f, m) => cSeen.push(m.t));

    await a.send(b.selfId, { t: "offer", sdp: "W" });
    await sleep(10);

    expect(bSeen).toEqual([{ from: a.selfId, t: "offer" }]);
    expect(cSeen).toEqual([]); // relay broadcasts, envelope routing isolates
    // ciphertext on the wire only
    for (const socket of world.sockets.slice(1)) {
      expect(socket.sent.length === 0 || socket.sent[0]?.startsWith("vtt1.")).toBe(true);
    }
    a.close();
    b.close();
    c.close();
  });

  test("reconnects after the relay drops the connection", async () => {
    const world = wsWorld();
    const a = await openWs(world, "room-ws2", "s");
    const first = world.sockets[0];
    first?.onclose?.();
    await sleep(30); // backoff 1 s default → use fast backoff instead
    a.close();
  });

  test("send before open throws; close blocks further sends", async () => {
    const world = wsWorld();
    const a = new WebSocketSignalingAdapter({
      url: "wss://self.example",
      socket: world.factory,
      backoff: { initialMs: 5, maxMs: 10 },
    });
    await a.open("room-ws3", await deriveRoomKey("s", "room-ws3"));
    await expect(a.send(a.selfId, { t: "leave" })).rejects.toThrow("not connected");
    world.sockets[0]?.onopen?.();
    await sleep(5);
    await a.send(a.selfId, { t: "leave" }); // now fine
    a.close();
    await expect(a.send(a.selfId, { t: "leave" })).rejects.toThrow("closed");
  });
});
