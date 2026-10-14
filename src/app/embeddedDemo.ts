/** Explicit preview artifact bootstrap. Normal index.html contains no embedded world and is unchanged. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getSetting, getWorld, openVttDb, putSetting } from "../storage/idb";
import { opfsRoot } from "../storage/opfs";
import { importWorldZip } from "../host/worldFile";

export interface EmbeddedDemo { id: string; sha256: string; archive: string }
export function parseEmbeddedDemo(text: string): EmbeddedDemo {
  if (text.length > 8 * 1024 * 1024) throw new Error("Embedded demo exceeds its budget");
  const value = JSON.parse(text) as Partial<EmbeddedDemo>;
  if (!value || typeof value.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.id) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.archive !== "string" || !/^[a-z0-9+/]+={0,2}$/i.test(value.archive)) throw new Error("Invalid embedded demo");
  return value as EmbeddedDemo;
}
export async function openEmbeddedDemo(demo: EmbeddedDemo): Promise<{ worldId: string; fresh: boolean }> {
  const db = await openVttDb();
  try {
    const key = `${demo.id}:${demo.sha256}`;
    const saved = await getSetting(db, "embedded-demos", key);
    if (typeof saved?.value === "string" && await getWorld(db, saved.value)) return { worldId: saved.value, fresh: false };
    const bytes = Uint8Array.from(atob(demo.archive), (character) => character.charCodeAt(0));
    if (bytesToHex(sha256(bytes)) !== demo.sha256) throw new Error("Embedded demo integrity check failed");
    // Always COPY. Never replace a user's campaign or import execution approvals.
    const imported = await importWorldZip({ db, root: await opfsRoot(), file: bytes, mode: "copy" });
    await putSetting(db, { scope: "embedded-demos", key, value: imported.worldId });
    return { worldId: imported.worldId, fresh: true };
  } finally { db.close(); }
}
