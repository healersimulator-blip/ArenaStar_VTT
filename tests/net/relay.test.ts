import { describe, expect, test } from "vitest";
import { buildIceServers, DEFAULT_ICE_SERVERS } from "../../src/net/webrtc";
import { PeerRelayRouter } from "../../src/net/peerRelay";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";

describe("§6.3 User-supplied TURN credentials", () => {
  test("buildIceServers merges default STUN with custom TURN configs", () => {
    const customTurn = [
      {
        urls: ["turn:turn.example.com:3478"],
        username: "user1",
        credential: "secretpassword",
      },
    ];
    const servers = buildIceServers(customTurn);
    expect(servers.length).toBe(DEFAULT_ICE_SERVERS.length + 1);
    expect(servers[servers.length - 1]).toEqual({
      urls: ["turn:turn.example.com:3478"],
      username: "user1",
      credential: "secretpassword",
    });
  });

  test("buildIceServers returns defaults when no custom TURN provided", () => {
    const servers = buildIceServers();
    expect(servers).toEqual(DEFAULT_ICE_SERVERS);
  });
});

describe("§6.3 Peer Relay (relay.offer / relay.frame)", () => {
  test("relays frame from source through intermediary to destination", async () => {
    const pair1 = createTransportPair();
    const pair2 = createTransportPair();

    const routerIntermediary = new PeerRelayRouter("intermediary");
    routerIntermediary.addPeer("source", pair1.b);
    routerIntermediary.addPeer("dest", pair2.a);

    const routerDest = new PeerRelayRouter("dest");
    routerDest.addPeer("intermediary", pair2.b);

    const received: { channel: string; bytes: Uint8Array }[] = [];
    routerDest.onRelayFrame = (_from, channel, bytes) => {
      received.push({ channel, bytes: new Uint8Array(bytes) });
    };

    // Source sends a relayed frame to dest through intermediary
    const frameData = new Uint8Array([10, 20, 30]);
    routerIntermediary.forwardFrame({
      kind: "relay.frame",
      from: "source",
      to: "dest",
      bytes: frameData,
    });

    await flushMicrotasks();

    expect(received.length).toBe(1);
    expect(received[0]?.bytes).toEqual(frameData);
  });
});
