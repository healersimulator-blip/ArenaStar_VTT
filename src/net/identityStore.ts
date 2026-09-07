/**
 * §6.4 identity persistence — the per-browser keypair lives in the "vtt" IDB
 * settings store (scope "client"), so the userId (pubkey) survives reloads and
 * the host recognizes rejoining players as known pubkeys (auto-approve).
 *
 * Private keys are generated extractable (identity.ts) and stored as JWK —
 * browser-local, never on the wire.
 */
import type { IDBPDatabase } from "idb";
import { getSetting, putSetting } from "../storage/idb";
import { generateIdentity, type Identity, type IdentityAlgorithm } from "./identity";

const SCOPE = "client";
const KEY = "identity";

interface StoredIdentity {
  algorithm: IdentityAlgorithm;
  publicKeyHex: string;
  privateJwk: JsonWebKey;
}

async function toStored(identity: Identity): Promise<StoredIdentity> {
  const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", identity.privateKey);
  return { algorithm: identity.algorithm, publicKeyHex: identity.publicKeyHex, privateJwk };
}

function hexToBytes(hex: string): Uint8Array {
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return raw;
}

async function fromStored(stored: StoredIdentity): Promise<Identity> {
  const subtle = globalThis.crypto.subtle;
  const algo: AlgorithmIdentifier | EcKeyImportParams =
    stored.algorithm === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
  const privateKey = await subtle.importKey("jwk", stored.privateJwk, algo, true, ["sign"]);
  const publicKey = await subtle.importKey(
    "raw",
    hexToBytes(stored.publicKeyHex) as unknown as BufferSource,
    algo,
    true,
    ["verify"],
  );
  return {
    algorithm: stored.algorithm,
    publicKeyHex: stored.publicKeyHex,
    privateKey,
    publicKey,
  };
}

/** Load the persisted identity; null when this browser has none yet. */
export async function loadIdentity(db: IDBPDatabase): Promise<Identity | null> {
  const rec = await getSetting(db, SCOPE, KEY);
  if (!rec) return null;
  const stored = rec.value as unknown as StoredIdentity;
  if (
    !stored ||
    (stored.algorithm !== "Ed25519" && stored.algorithm !== "ECDSA_P256") ||
    typeof stored.publicKeyHex !== "string" ||
    !stored.privateJwk
  ) {
    return null;
  }
  try {
    return await fromStored(stored);
  } catch {
    return null; // corrupt record — regenerate below
  }
}

/** Persist the identity (idempotent per browser). */
export async function saveIdentity(db: IDBPDatabase, identity: Identity): Promise<void> {
  await putSetting(db, { scope: SCOPE, key: KEY, value: (await toStored(identity)) as never });
}

/** Load or create + persist the per-browser identity (§6.4). */
export async function ensureIdentity(db: IDBPDatabase): Promise<Identity> {
  const existing = await loadIdentity(db);
  if (existing) return existing;
  const identity = await generateIdentity();
  await saveIdentity(db, identity);
  return identity;
}
