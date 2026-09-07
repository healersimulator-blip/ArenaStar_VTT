import { describe, expect, test } from "vitest";
import {
  buildInviteLink,
  decryptSignalPayload,
  deriveRoomKey,
  encryptSignalPayload,
  parseInviteLink,
} from "../../src/net/signaling/crypto";
import type { SignalMsg } from "../../src/core/net";

describe("invite link (§6.2 `#room=<id>&k=<secret>`)", () => {
  test("round-trips room id and secret in the fragment", () => {
    const link = buildInviteLink("https://host.example/app", "grand-crusade", "topsecret-á");
    expect(link).toBe("https://host.example/app#room=grand-crusade&k=topsecret-%C3%A1");
    const parsed = parseInviteLink(link);
    expect(parsed).toEqual({ roomId: "grand-crusade", secret: "topsecret-á" });
  });

  test("fragment only: the secret never appears before the #", () => {
    const link = buildInviteLink("https://host.example/", "r1", "s3cret");
    const [before, after] = link.split("#");
    expect(before).not.toContain("s3cret");
    expect(after).toContain("k=s3cret");
  });

  test("malformed links return null", () => {
    expect(parseInviteLink("https://x.example/nothing")).toBeNull();
    expect(parseInviteLink("https://x.example/#room=onlyroom")).toBeNull();
    expect(parseInviteLink("https://x.example/#k=onlykey")).toBeNull();
  });
});

describe("room key + signal encryption (§6.2 HKDF → AES-GCM)", () => {
  test("same secret+room derives interchangeable keys (deterministic HKDF)", async () => {
    const a = await deriveRoomKey("hunter2", "room-9");
    const b = await deriveRoomKey("hunter2", "room-9");
    const msg: SignalMsg = { t: "offer", sdp: "v=0..." };
    const code = await encryptSignalPayload(a, { from: "peer-a", msg });
    const out = await decryptSignalPayload(b, code);
    expect(out).toEqual({ from: "peer-a", msg });
  });

  test("different room or secret yields keys that cannot decrypt", async () => {
    const key = await deriveRoomKey("hunter2", "room-9");
    const otherRoom = await deriveRoomKey("hunter2", "room-10");
    const code = await encryptSignalPayload(key, { from: "p", msg: { t: "leave" } });
    await expect(decryptSignalPayload(otherRoom, code)).rejects.toThrow();
  });

  test("tampered ciphertext fails authentication", async () => {
    const key = await deriveRoomKey("s", "r");
    const code = await encryptSignalPayload(key, { from: "p", msg: { t: "leave" } });
    const flipped = code.slice(0, -2) + (code.endsWith("A") ? "B" : "A") + "A";
    await expect(decryptSignalPayload(key, flipped)).rejects.toThrow();
  });

  test("unknown code version is rejected", async () => {
    const key = await deriveRoomKey("s", "r");
    await expect(decryptSignalPayload(key, "vtt9.abcdef")).rejects.toThrow("unknown code version");
  });
});
