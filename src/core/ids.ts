/** Identity types shared by every layer (§4, §4A, §6). */

/** User identity = Ed25519 (fallback ECDSA P-256) public key, hex (§6.4). */
export type UserId = string;

/** WebRTC peer identity (host or player). */
export type PeerId = string;

/** Document id — unique within its collection (`_id`, §4). */
export type DocId = string;

/** Content address of an asset = sha256 hex digest of its bytes (§7). */
export type AssetId = string;

/** World id — key of the IndexedDB `worlds` store (§8). */
export type WorldId = string;

/** Client-generated transaction id (`OpEnvelope.txId`, §4). */
export type TxId = string;

/** Signaling room id from the invite link `#room=<id>&k=<secret>` (§6.2). */
export type RoomId = string;

/** Strategic ids (§4A) — aliases of DocId. */
export type FactionId = DocId;
export type ArmyId = DocId;
export type UnitId = DocId;
export type TurnId = DocId;
