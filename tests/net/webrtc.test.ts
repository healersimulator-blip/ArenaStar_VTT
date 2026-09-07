import { describe, expect, test } from "vitest";
import { createIncoming, createOutgoing, runWebrtcLoopback } from "../../src/net/webrtc";

// Real RTCPeerConnection exists in browsers; in Node these execute in the
// Playwright e2e suite (e2e/webrtc.spec.ts drives the bundled loopback).
describe.skipIf(typeof RTCPeerConnection === "undefined")("WebRTCTransport (§6.1)", () => {
  test("loopback: 4 channels, one frame each way, stats connected", async () => {
    const result = await runWebrtcLoopback();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.channels).toEqual(["ops", "ephemeral", "assets", "sim"]);
    expect(result.frames).toBe(8);
  }, 15_000);

  test("send after close throws", async () => {
    const outgoing = createOutgoing([]);
    outgoing.close();
    expect(() => outgoing.transport.send("ops", new Uint8Array([1]))).toThrow("transport closed");
  });

  test("setRemote with a garbage offer rejects", async () => {
    await expect(createIncoming("not-an-sdp", [])).rejects.toThrow();
  });
});
