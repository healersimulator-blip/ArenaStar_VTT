/**
 * §6.2 signaling crypto — room secret → HKDF → AES-GCM payloads.
 *
 * The invite link carries the room id and secret in the URL FRAGMENT
 * (`#room=<id>&k=<secret>`) so it never reaches a server. All signaling
 * payloads are encrypted with an AES-GCM key derived (HKDF-SHA256) from the
 * secret; adapters only ever exchange `vtt1.<base64url(iv||ciphertext)>`
 * codes, so every transport (copy/paste, Nostr relays, MQTT, trackers) sees
 * only opaque authenticated blobs.
 */
import type { PeerId } from "../../core/ids";
import type { SignalMsg } from "../../core/net";

export interface RoomInvite {
  roomId: string;
  secret: string;
  /** Host's Nostr signaling pubkey (§6.2, `&h=`) — absent for manual-only. */
  hostPubkey?: string;
}

/** Build `<base>#room=<id>&k=<secret>[&h=<hostPubkey>]` (fragment, §6.2). */
export function buildInviteLink(
  base: string,
  roomId: string,
  secret: string,
  hostPubkey?: string,
): string {
  const frag = new URLSearchParams({ room: roomId, k: secret });
  if (hostPubkey) frag.set("h", hostPubkey);
  return `${base}#${frag.toString()}`;
}

/** Parse an invite link; null when the fragment lacks room/k. */
export function parseInviteLink(url: string): RoomInvite | null {
  const hashAt = url.indexOf("#");
  if (hashAt < 0) return null;
  const frag = new URLSearchParams(url.slice(hashAt + 1));
  const roomId = frag.get("room");
  const secret = frag.get("k");
  if (!roomId || !secret) return null;
  const hostPubkey = frag.get("h");
  return {
    roomId,
    secret,
    ...(hostPubkey ? { hostPubkey } : {}),
  };
}

const HKDF_SALT_PREFIX = "vtt:";
const HKDF_INFO = "vtt:room:v1";

/** HKDF-SHA256(secret, salt="vtt:<roomId>", info="vtt:room:v1") → AES-GCM-256. */
export async function deriveRoomKey(secret: string, roomId: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const ikm = new TextEncoder().encode(secret);
  const salt = new TextEncoder().encode(HKDF_SALT_PREFIX + roomId);
  const info = new TextEncoder().encode(HKDF_INFO);
  const key = await subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypted signaling envelope: sender id + SignalMsg (authenticated). */
export interface SignalEnvelope {
  from: PeerId;
  /** Targeted routing (broadcast when absent); authenticated like the rest. */
  to?: PeerId;
  msg: SignalMsg;
}

const CODE_TAG = "vtt1.";

/** Encrypt an envelope → `vtt1.<base64url(iv[12] || ciphertext)>`. */
export async function encryptSignalPayload(
  key: CryptoKey,
  envelope: SignalEnvelope,
): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return CODE_TAG + bytesToBase64Url(out);
}

/** Decrypt a code; throws on wrong key/tampering (AES-GCM auth). */
export async function decryptSignalPayload(key: CryptoKey, code: string): Promise<SignalEnvelope> {
  if (!code.startsWith(CODE_TAG)) throw new Error("signal: unknown code version");
  const bytes = base64UrlToBytes(code.slice(CODE_TAG.length));
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const plaintext = new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ct),
    ),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as SignalEnvelope;
}

// ─── base64url (small payloads; no Node/Browser API divergence) ───────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
