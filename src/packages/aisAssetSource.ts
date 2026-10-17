/** Shared GM/player asset composition. The caller supplies its already-entitled
 * manifest and the normal host store/player transfer path; never a parallel IDB store.
 */
import type { AssetManifest } from "../core/documents";
import type { AisModuleHandlerContext } from "./aisModuleHandlers";

export function createAisAssetSource(
  manifest: () => AssetManifest,
  read: (hash: string, mime: string) => Promise<Uint8Array | undefined>,
): Pick<AisModuleHandlerContext, "assets" | "assetBytes"> {
  // Hash-addressed bytes are immutable. Retain only one small encoded asset to
  // avoid re-reading/re-encoding it for every 8 KiB RPC page.
  let cached: { hash: string; base64: string; mime: string } | null = null;
  return {
    assets: async () =>
      Object.fromEntries(
        Object.entries(manifest()).map(([hash, entry]) => [
          hash,
          { name: entry.name, mime: entry.mime, size: entry.size ?? 0 },
        ]),
      ),
    assetBytes: async (hash) => {
      const entry = manifest()[hash];
      if (!entry) return null; // Recheck entitlement even for a cache hit.
      if (cached?.hash === hash)
        return { base64: cached.base64, mime: cached.mime };
      const bytes = await read(hash, entry.mime);
      if (!bytes || !manifest()[hash]) return null;
      const parts: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 8192)
        parts.push(
          String.fromCharCode(...bytes.subarray(offset, offset + 8192)),
        );
      const result = { base64: btoa(parts.join("")), mime: entry.mime };
      cached = bytes.length <= 4 * 1024 * 1024 ? { hash, ...result } : null;
      return result;
    },
  };
}
