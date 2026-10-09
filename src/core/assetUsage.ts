/**
 * §6.8 clean-up: which stored images are still needed.
 *
 * An asset is in use when its hash appears anywhere in the live world collections, or when it is a
 * derived variant (thumb / mid / tiles) of an asset that is in use. The scan is deliberately
 * structural: a hash that is merely present in a document keeps it, so a new document kind can never
 * make a live image look unused. Undo history is not a root: the OpLog is not compacted in the app,
 * so keeping it would make a replaced background permanently undeletable. Clean-up therefore says
 * that Undo can no longer restore a deleted image.
 */
import type { AssetManifest, AssetManifestEntry } from "./documents";
import type { AssetId } from "./ids";

const ASSET_HASH = /^[a-f0-9]{64}$/;

export interface AssetLibraryEntry {
  hash: AssetId;
  name: string;
  mime: string;
  size: number;
  /** True when the asset is still referenced (directly, by undo history, or as a derived variant). */
  inUse: boolean;
  /** True when the asset is a thumbnail, mid-resolution copy or tile of another asset. */
  derived: boolean;
}

/**
 * The live documents that count as usage. The image-upload audit message records the hash it stored
 * as provenance: the log line is readable without the bytes, so that field is not a use of the image.
 * Everything else in the world, including the manifest's own entries, is walked in full.
 */
export function assetUsageRoots(collections: Record<string, unknown>): unknown[] {
  const roots: unknown[] = [];
  for (const [coll, docs] of Object.entries(collections)) {
    if (coll === "assetManifest") continue;
    if (coll === "messages" && docs !== null && typeof docs === "object") {
      for (const doc of Object.values(docs as Record<string, unknown>)) roots.push(withoutAuditProvenance(doc));
    } else {
      roots.push(docs);
    }
  }
  return roots;
}

function withoutAuditProvenance(doc: unknown): unknown {
  if (doc === null || typeof doc !== "object") return doc;
  const system = (doc as { system?: unknown }).system;
  if (system === null || typeof system !== "object" || typeof (system as { auditKind?: unknown }).auditKind !== "string") return doc;
  const rest: Record<string, unknown> = { ...(system as Record<string, unknown>) };
  delete rest.assetId;
  delete rest.preparedHash;
  return { ...doc, system: rest };
}

/** Asset hashes referenced by a value tree. Walks iteratively and tolerates shared or cyclic objects. */
export function referencedAssetIds(roots: Iterable<unknown>, manifest: AssetManifest): Set<AssetId> {
  const found = new Set<AssetId>();
  const seen = new WeakSet<object>();
  const stack: unknown[] = [...roots];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (ASSET_HASH.test(value) && Object.prototype.hasOwnProperty.call(manifest, value)) found.add(value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (ArrayBuffer.isView(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else {
      for (const item of Object.values(value)) stack.push(item);
    }
  }
  return found;
}

/** Variant ids a manifest entry owns. Thumbnails and tiles are stored as separate assets. */
export function derivedAssetIds(entry: AssetManifestEntry | undefined): AssetId[] {
  if (!entry) return [];
  const out: AssetId[] = [];
  if (entry.thumb?.assetId) out.push(entry.thumb.assetId);
  if (entry.mid?.assetId) out.push(entry.mid.assetId);
  if (entry.tiles?.ids) out.push(...entry.tiles.ids);
  return out;
}

/**
 * Close the referenced set over derived variants: a thumbnail or tile of a live image stays live,
 * even though no document names it directly.
 */
export function closeOverDerived(referenced: Set<AssetId>, manifest: AssetManifest): Set<AssetId> {
  const queue = [...referenced];
  while (queue.length > 0) {
    const hash = queue.pop() as AssetId;
    for (const variant of derivedAssetIds(manifest[hash])) {
      if (!Object.prototype.hasOwnProperty.call(manifest, variant) || referenced.has(variant)) continue;
      referenced.add(variant);
      queue.push(variant);
    }
  }
  return referenced;
}

/** Every stored asset with its usage state, sorted by name then hash so the list is stable. */
export function assetLibrary(manifest: AssetManifest, liveRoots: Iterable<unknown>): AssetLibraryEntry[] {
  const inUse = closeOverDerived(referencedAssetIds(liveRoots, manifest), manifest);
  const derived = new Set<AssetId>();
  for (const hash of Object.keys(manifest) as AssetId[]) for (const v of derivedAssetIds(manifest[hash])) derived.add(v);
  return (Object.keys(manifest) as AssetId[])
    .map((hash) => {
      const entry = manifest[hash] as AssetManifestEntry;
      return {
        hash,
        name: entry.name,
        mime: entry.mime,
        size: entry.size,
        inUse: inUse.has(hash),
        derived: derived.has(hash),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}

/** The assets clean-up may delete: stored and not referenced by any live document or variant. */
export function unusedAssetIds(manifest: AssetManifest, liveRoots: Iterable<unknown>): AssetId[] {
  return assetLibrary(manifest, liveRoots).filter((entry) => !entry.inUse).map((entry) => entry.hash);
}
