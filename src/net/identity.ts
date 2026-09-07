/**
 * §6.4 Identity: per-browser keypair (Ed25519, ECDSA P-256 fallback, WebCrypto),
 * userId = pubkey hex. hello signatures cover "vtt:hello:<roomId>:<displayName>:<ts>"
 * (D-007). Verification tries Ed25519 first, then ECDSA P-256 (SHA-256), so a
 * host accepts both key kinds without a separate alg field.
 */
import type { HelloMsg } from "../core/messages";

export type IdentityAlgorithm = "Ed25519" | "ECDSA_P256";

export interface Identity {
  algorithm: IdentityAlgorithm;
  /** userId (§6.4) — raw public key bytes, hex. */
  publicKeyHex: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("fromHex: odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("fromHex: invalid hex");
    out[i] = byte;
  }
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto unavailable");
  return s;
}

export async function generateIdentity(): Promise<Identity> {
  const crypto = subtle();
  const keyUses: KeyUsage[] = ["sign", "verify"];
  try {
    const pair = (await crypto.generateKey({ name: "Ed25519" }, true, keyUses)) as CryptoKeyPair;
    const raw = await crypto.exportKey("raw", pair.publicKey);
    return {
      algorithm: "Ed25519",
      publicKeyHex: toHex(raw),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    };
  } catch {
    const pair = (await crypto.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      keyUses,
    )) as CryptoKeyPair;
    const raw = await crypto.exportKey("raw", pair.publicKey);
    return {
      algorithm: "ECDSA_P256",
      publicKeyHex: toHex(raw),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    };
  }
}

/** The exact string covered by a hello signature (D-007). */
export function helloPayload(roomId: string, displayName: string, ts: number): string {
  return `vtt:hello:${roomId}:${displayName}:${ts}`;
}

export async function signText(identity: Identity, text: string): Promise<string> {
  const crypto = subtle();
  const data = new TextEncoder().encode(text);
  const sig =
    identity.algorithm === "Ed25519"
      ? await crypto.sign({ name: "Ed25519" }, identity.privateKey, data)
      : await crypto.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, data);
  return toHex(sig);
}

async function tryVerify(
  algorithm: IdentityAlgorithm,
  publicKeyHex: string,
  sigHex: string,
  data: Uint8Array,
): Promise<boolean> {
  const crypto = subtle();
  try {
    const key = await crypto.importKey(
      "raw",
      fromHex(publicKeyHex) as unknown as BufferSource,
      algorithm === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    return algorithm === "Ed25519"
      ? await crypto.verify(
          { name: "Ed25519" },
          key,
          fromHex(sigHex) as unknown as BufferSource,
          data as unknown as BufferSource,
        )
      : await crypto.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          fromHex(sigHex) as unknown as BufferSource,
          data as unknown as BufferSource,
        );
  } catch {
    return false;
  }
}

/** Verify a hello's signature against its claimed pubkey (both algorithms). */
export async function verifyHello(hello: HelloMsg, roomId: string): Promise<boolean> {
  if (!/^[0-9a-f]+$/i.test(hello.pubkey) || hello.pubkey.length < 32) return false;
  if (
    typeof hello.displayName !== "string" ||
    hello.displayName.length === 0 ||
    hello.displayName.length > 64
  ) {
    return false;
  }
  const data = new TextEncoder().encode(helloPayload(roomId, hello.displayName, hello.ts));
  if (await tryVerify("Ed25519", hello.pubkey, hello.sig, data)) return true;
  return tryVerify("ECDSA_P256", hello.pubkey, hello.sig, data);
}
