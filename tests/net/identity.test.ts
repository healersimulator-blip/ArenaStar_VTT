import { describe, expect, test } from "vitest";
import { generateIdentity, helloPayload, signText, verifyHello } from "../../src/net/identity";
import type { HelloMsg } from "../../src/core/messages";

async function signedHello(
  roomId: string,
  displayName = "Rex",
  ts = 123,
): Promise<{ hello: HelloMsg; identity: Awaited<ReturnType<typeof generateIdentity>> }> {
  const identity = await generateIdentity();
  const sig = await signText(identity, helloPayload(roomId, displayName, ts));
  return {
    hello: { kind: "hello", pubkey: identity.publicKeyHex, displayName, ts, sig },
    identity,
  };
}

describe("Identity & hello verification (§6.4)", () => {
  test("generated identities use a supported algorithm with hex pubkeys", async () => {
    const identity = await generateIdentity();
    expect(["Ed25519", "ECDSA_P256"]).toContain(identity.algorithm);
    expect(identity.publicKeyHex).toMatch(/^[0-9a-f]+$/);
    expect(identity.publicKeyHex.length).toBeGreaterThanOrEqual(64);
  });

  test("verifyHello accepts a genuine signature (either algorithm)", async () => {
    const { hello } = await signedHello("room-7");
    expect(await verifyHello(hello, "room-7")).toBe(true);
  });

  test("verifyHello rejects tampered payloads, wrong rooms, bad keys", async () => {
    const { hello } = await signedHello("room-7");
    expect(await verifyHello({ ...hello, displayName: "Evil" }, "room-7")).toBe(false); // payload changed
    expect(await verifyHello(hello, "other-room")).toBe(false); // replayed into another room
    expect(await verifyHello({ ...hello, sig: "ff".repeat(64) }, "room-7")).toBe(false); // garbage sig
    expect(await verifyHello({ ...hello, pubkey: "zz" }, "room-7")).toBe(false); // invalid hex
  });

  test("hello payload format is exactly vtt:hello:<roomId>:<name>:<ts> (D-007)", () => {
    expect(helloPayload("r", "Rex", 5)).toBe("vtt:hello:r:Rex:5");
  });
});
