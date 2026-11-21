/** Short-lived invite resend material. The room secret never leaves the database. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AAD_VERSION = "arenastar-strategic-invite-v2";

export const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * Derive a purpose-separated subkey from the room's projection key. The same root
 * secret backs both invite encryption and marker HMACs; deriving per-purpose keys
 * keeps a compromise or misuse in one primitive from leaking into the other.
 * The "invite" purpose preserves the original `AAD_VERSION` prefix so already-
 * sealed `invite_cipher` rows remain decryptable after this change.
 */
export function deriveRoomKey(secret: Uint8Array, purpose: string): Buffer {
  const prefix =
    purpose === "invite"
      ? AAD_VERSION
      : `arenastar-strategic-${purpose}-v1`;
  return createHash("sha256")
    .update(prefix)
    .update(Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength))
    .digest();
}

function keyFor(secret: Uint8Array): Buffer {
  return deriveRoomKey(secret, "invite");
}

function aad(roomId: string, memberId: string): Buffer {
  return Buffer.from(JSON.stringify([AAD_VERSION, roomId, memberId]), "utf8");
}

/**
 * Keep a GM-recoverable copy of a one-time invite without storing the code in clear text.
 * A database leak alone does not reveal the code; the caller must also hold the room key.
 */
export function sealInvite(
  secret: Uint8Array,
  roomId: string,
  memberId: string,
  code: string,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(secret), nonce);
  cipher.setAAD(aad(roomId, memberId));
  const body = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString(
    "base64url",
  );
}

export function openInvite(
  secret: Uint8Array,
  roomId: string,
  memberId: string,
  sealed: string,
): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.byteLength < NONCE_BYTES + TAG_BYTES + 1) return null;
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(raw.byteLength - TAG_BYTES);
    const body = raw.subarray(NONCE_BYTES, raw.byteLength - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, keyFor(secret), nonce);
    decipher.setAAD(aad(roomId, memberId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}
