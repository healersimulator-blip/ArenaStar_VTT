import { describe, expect, test } from "vitest";
import { frameMessage, deframeMessage, channelFor } from "../../src/net/frame";
import { MsgKind, type MsgName } from "../../src/core/messages";
import { ALL_KINDS, sampleMessage } from "./fixtures";

describe("frameMessage / deframeMessage (§6.1, §13)", () => {
  test("round-trips every one of the 28 message kinds", () => {
    expect(ALL_KINDS).toHaveLength(28);
    for (const kind of ALL_KINDS) {
      const msg = sampleMessage(kind);
      const framed = frameMessage(msg);
      expect(framed[0]).toBe(MsgKind[kind]);
      const back = deframeMessage(framed);
      expect(back.ok, `deframe failed for ${kind}`).toBe(true);
      if (!back.ok) continue;
      expect(back.value).toEqual(msg);
    }
  });

  test("prefix byte is exactly the MsgKind map value", () => {
    const framed = frameMessage(sampleMessage("sim.delta"));
    expect(framed[0]).toBe(0x28);
    expect(frameMessage(sampleMessage("hello"))[0]).toBe(0x01);
    expect(frameMessage(sampleMessage("relay.frame"))[0]).toBe(0x43);
  });

  test("empty and 1-byte frames are rejected", () => {
    expect(deframeMessage(new Uint8Array(0)).ok).toBe(false);
    expect(deframeMessage(new Uint8Array([0x01])).ok).toBe(false);
  });

  test("unknown kind byte is rejected", () => {
    const framed = frameMessage(sampleMessage("ops"));
    framed[0] = 0x7f;
    const res = deframeMessage(framed);
    expect(res.ok).toBe(false);
  });

  test("kind byte / payload kind mismatch is rejected", () => {
    const framed = frameMessage(sampleMessage("intent"));
    framed[0] = MsgKind["turn.ready"];
    const res = deframeMessage(framed);
    expect(res.ok).toBe(false);
  });

  test("truncated msgpack payload is rejected, not thrown", () => {
    const framed = frameMessage(sampleMessage("snapshot"));
    const res = deframeMessage(framed.subarray(0, framed.length - 2));
    expect(res.ok).toBe(false);
  });

  test("binary fields survive the round-trip as Uint8Array", () => {
    const back = deframeMessage(frameMessage(sampleMessage("asset.chunk")));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.kind).toBe("asset.chunk");
    if (back.value.kind !== "asset.chunk") return;
    expect(back.value.bytes).toBeInstanceOf(Uint8Array);
    expect([...back.value.bytes]).toEqual([9, 9]);
  });
});

describe("channelFor (§6.1)", () => {
  test("compile-time exhaustive routing table over all kinds", () => {
    const routing: Record<MsgName, "ops" | "ephemeral" | "assets" | "sim"> = {
      hello: "ops",
      intent: "ops",
      roll: "ops",
    "roll.reveal": "ops",
    "roll.challenge": "ops",
      ephemeral: "ephemeral",
      "asset.get": "assets",
      "fog.put": "ops",
      "relay.offer": "ops",
      "turn.ready": "ops",
      "sim.control": "ops",
      "report.detail": "ops",
      "sim.snapshot.get": "sim",
      "audio.cmd": "ops",
      welcome: "ops",
      snapshot: "ops",
      ops: "ops",
      rejected: "ops",
      "asset.chunk": "assets",
      clock: "ops",
      kick: "ops",
      ban: "ops",
      "sim.delta": "sim",
      "sim.snapshot": "sim",
      "turn.phase": "ops",
      "turn.report": "sim",
      "report.detail.page": "ops",
      heartbeat: "ops",
      ping: "ops",
      pong: "ops",
      "relay.frame": "ops",
    };
    for (const kind of ALL_KINDS) {
      expect(channelFor(kind)).toBe(routing[kind]);
    }
  });

  test("sim traffic stays off ops so large deltas never block chat (§6.1)", () => {
    expect(channelFor("sim.delta")).toBe("sim");
    expect(channelFor("sim.snapshot")).toBe("sim");
    expect(channelFor("turn.report")).toBe("sim");
    expect(channelFor("intent")).toBe("ops");
    expect(channelFor("ephemeral")).toBe("ephemeral");
  });
});
