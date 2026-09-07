import { describe, expect, test } from "vitest";
import { ManualSignalingAdapter } from "../../src/net/signaling/manual";
import { deriveRoomKey } from "../../src/net/signaling/crypto";
import type { SignalMsg } from "../../src/core/net";

describe("ManualSignalingAdapter (§6.2 copy/paste, non-trickle)", () => {
  test("send → outbox code → peer receiveCode → onMessage(from, msg)", async () => {
    const roomKey = await deriveRoomKey("secret-1", "room-1");
    const alice = new ManualSignalingAdapter();
    const bob = new ManualSignalingAdapter();
    await alice.open("room-1", roomKey);
    await bob.open("room-1", roomKey);

    const received: Array<{ from: string; msg: SignalMsg }> = [];
    bob.onMessage((from, msg) => received.push({ from, msg }));

    const offer: SignalMsg = { t: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1" };
    await alice.send("host", offer);

    const codes = alice.takeOutbox();
    expect(codes).toHaveLength(1);
    expect(alice.takeOutbox()).toEqual([]); // drained

    await bob.receiveCode(codes[0] ?? "");
    expect(received).toEqual([{ from: alice.selfId, msg: offer }]);
  });

  test("full manual exchange: offer → answer, one code each way", async () => {
    const roomKey = await deriveRoomKey("secret-2", "room-2");
    const player = new ManualSignalingAdapter();
    const host = new ManualSignalingAdapter();
    await player.open("room-2", roomKey);
    await host.open("room-2", roomKey);

    const hostSeen: SignalMsg[] = [];
    const playerSeen: SignalMsg[] = [];
    host.onMessage((_from, msg) => hostSeen.push(msg));
    player.onMessage((_from, msg) => playerSeen.push(msg));

    await player.send("host", { t: "offer", sdp: "OFFER-SDP" });
    await host.receiveCode(player.takeOutbox()[0] ?? "");
    await host.send(player.selfId, { t: "answer", sdp: "ANSWER-SDP" });
    await player.receiveCode(host.takeOutbox()[0] ?? "");

    expect(hostSeen.map((m) => m.t)).toEqual(["offer"]);
    expect(playerSeen.map((m) => m.t)).toEqual(["answer"]);
    expect((hostSeen[0] as { sdp: string }).sdp).toBe("OFFER-SDP");
  });

  test("codes from a different room are rejected", async () => {
    const keyA = await deriveRoomKey("secret", "room-a");
    const keyB = await deriveRoomKey("secret", "room-b");
    const a = new ManualSignalingAdapter();
    const b = new ManualSignalingAdapter();
    await a.open("room-a", keyA);
    await b.open("room-b", keyB);
    await a.send("host", { t: "leave" });
    await expect(b.receiveCode(a.takeOutbox()[0] ?? "")).rejects.toThrow();
  });

  test("send before open throws; close() empties outbox and blocks further use", async () => {
    const adapter = new ManualSignalingAdapter();
    await expect(adapter.send("host", { t: "leave" })).rejects.toThrow("open() not called");

    const key = await deriveRoomKey("s", "r");
    await adapter.open("r", key);
    await adapter.send("host", { t: "leave" });
    adapter.close();
    expect(adapter.takeOutbox()).toEqual([]);
    await expect(adapter.send("host", { t: "leave" })).rejects.toThrow("closed");
  });
});
