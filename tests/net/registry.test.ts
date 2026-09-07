import { describe, expect, test } from "vitest";
import { SignalingStack, DEFAULT_ADAPTER_ORDER } from "../../src/net/signaling/registry";
import { ManualSignalingAdapter } from "../../src/net/signaling/manual";
import type { RelaySocket } from "../../src/net/signaling/nostr";
import { deriveRoomKey } from "../../src/net/signaling/crypto";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function socketFactoryFor(openUrls: string[]): (url: string) => RelaySocket {
  // sockets for URLs NOT in openUrls connect but never open (never ready)
  return (url: string): RelaySocket => {
    const socket: RelaySocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: () => undefined,
    };
    if (openUrls.includes(url)) {
      queueMicrotask(() => socket.onopen?.());
    }
    return socket;
  };
}

describe("SignalingStack (§6.2 adapter ordering)", () => {
  test("default order: nostr → mqtt → tracker (Nostr is the default)", () => {
    expect(DEFAULT_ADAPTER_ORDER).toEqual(["nostr", "mqtt", "tracker"]);
  });

  test("tries adapters in order; first ready wins", async () => {
    const stack = new SignalingStack({
      order: ["nostr", "websocket"],
      timeoutMs: 150,
      nostr: { relays: ["wss://dead.example"], socket: socketFactoryFor([]) },
      websocket: {
        url: "wss://alive.example/vtt/x",
        socket: socketFactoryFor(["wss://alive.example/vtt/x"]),
      },
    });
    const key = await deriveRoomKey("s", "room-r1");
    const kind = await stack.open("room-r1", key);
    expect(kind).toBe("websocket");
    expect(stack.activeKind).toBe("websocket");
    expect(stack.active).not.toBeNull();
    stack.close();
  });

  test("falls back to Manual-only when nothing becomes ready", async () => {
    const stack = new SignalingStack({
      order: ["nostr"],
      timeoutMs: 100,
      nostr: { relays: ["wss://dead.example"], socket: socketFactoryFor([]) },
    });
    const key = await deriveRoomKey("s", "room-r2");
    const kind = await stack.open("room-r2", key);
    expect(kind).toBeNull();
    expect(stack.active).toBeNull();
    // §6.2: Manual is always available in the UI
    expect(stack.manual).toBeInstanceOf(ManualSignalingAdapter);
    stack.close();
  });

  test("manual on the stack still works end-to-end while transports fail", async () => {
    const stack = new SignalingStack({
      order: ["nostr"],
      timeoutMs: 50,
      nostr: { relays: ["wss://dead.example"], socket: socketFactoryFor([]) },
    });
    const key = await deriveRoomKey("s", "room-r3");
    expect(await stack.open("room-r3", key)).toBeNull();

    const peerStack = new SignalingStack({
      order: ["nostr"],
      timeoutMs: 50,
      nostr: { relays: ["wss://dead.example"], socket: socketFactoryFor([]) },
    });
    await peerStack.open("room-r3", key);

    await stack.manual.open("room-r3", key);
    await peerStack.manual.open("room-r3", key);
    const seen: string[] = [];
    peerStack.manual.onMessage((_from, msg) => seen.push(msg.t));
    await stack.manual.send(peerStack.manual.selfId, { t: "offer", sdp: "MANUAL-FALLBACK" });
    await peerStack.manual.receiveCode(stack.manual.takeOutbox()[0] ?? "");
    await sleep(5);
    expect(seen).toEqual(["offer"]);

    stack.close();
    peerStack.close();
  });
});
