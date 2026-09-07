import { describe, expect, test } from "vitest";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { frameMessage } from "../../src/net/frame";
import { sampleMessage } from "./fixtures";
import type { TransportMessageHandler } from "../../src/core/net";

describe("createTransportPair (InMemoryTransport, §2/§6.1)", () => {
  test("delivers frames to the peer's onMessage on the same channel (ordered)", async () => {
    const { a, b } = createTransportPair();
    const received: Array<{ channel: string; firstByte: number }> = [];
    const handler: TransportMessageHandler = (channel, bytes) => {
      received.push({ channel, firstByte: bytes[0] ?? -1 });
    };
    b.onMessage = handler;
    a.send("ops", frameMessage(sampleMessage("intent")));
    a.send("sim", frameMessage(sampleMessage("sim.delta")));
    a.send("ephemeral", frameMessage(sampleMessage("ephemeral")));
    expect(received).toEqual([]); // async delivery
    await flushMicrotasks();
    expect(received).toEqual([
      { channel: "ops", firstByte: 0x02 },
      { channel: "sim", firstByte: 0x28 },
      { channel: "ephemeral", firstByte: 0x04 },
    ]);
  });

  test("both directions work; bytes are copies (no buffer aliasing)", async () => {
    const { a, b } = createTransportPair();
    let got: Uint8Array | null = null;
    a.onMessage = (_c, bytes) => {
      got = bytes;
    };
    const sent = frameMessage(sampleMessage("ops"));
    b.send("ops", sent);
    await flushMicrotasks();
    sent[0] = 0xff;
    expect(got?.[0]).toBe(0x22);
  });

  test("send after close throws; stats reflect traffic and connection state", async () => {
    const { a, b } = createTransportPair();
    a.send("ops", frameMessage(sampleMessage("heartbeat")));
    a.close();
    expect(() => a.send("ops", new Uint8Array([1, 2]))).toThrow(/closed/);
    expect(() => b.send("ops", new Uint8Array([1, 2]))).toThrow(/closed/);
    expect(a.stats.connected).toBe(false);
    expect(a.stats.channels.ops?.sentMessages).toBe(1);
    expect(a.stats.channels.ops?.sentBytes).toBeGreaterThan(1);
  });
});
