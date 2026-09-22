/**
 * Parsed-pack memo — the "lazy per-pack parse" half of G-45 (closure plan §1.4).
 *
 * Packs are parsed when a compendium surface first asks for them, never at world load: both
 * readers (`HostPackages.compendia()`, `ui/sheets/compendiumLoader.ts`) call in on demand. What
 * this cache adds is the *second* half — asking twice must not re-parse 25,376 entries. Before
 * it, every visit to the compendia tab, and every compendium picker opened from a sheet,
 * `JSON.parse`d and re-validated the whole converted world.
 *
 * Keying: `worldId:packageId@version#importedAt:file`. Version is in the key because a package
 * upgrade is expected to bump it (the schema-migration gate keys on the same field), and
 * `importedAt` is in it because re-importing a package — same id, same version, new bytes — is a
 * normal authoring loop and must win over a cached parse. Callers therefore never see a pack from
 * a different package record.
 *
 * Shared parse results are returned **by reference**: callers treat packs as read-only (the index
 * reads names/keywords and never mutates an entry, and imports copy the entry's `data` into a new
 * document). Invalid packs cache as `null` so a broken pack is not re-validated per call either.
 */
import { parseCompendiumPack, type CompendiumPack } from "./compendium";

export interface PackCacheKeyParts {
  worldId: string;
  packageId: string;
  version: string;
  importedAt: number;
  file: string;
}

export const packCacheKey = (parts: PackCacheKeyParts): string =>
  `${parts.worldId}:${parts.packageId}@${parts.version}#${parts.importedAt}:${parts.file}`;

const cache = new Map<string, CompendiumPack | null>();

/**
 * Parse `raw` as a world-origin pack, memoized by `key`. Returns `null` for a pack that fails
 * validation (the caller skips it exactly as it did before the cache existed).
 */
export function parsePackCached(key: string, raw: unknown): CompendiumPack | null {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const parsed = parseCompendiumPack(raw, { origin: "world" });
  const value = parsed.ok ? parsed.value : null;
  cache.set(key, value);
  return value;
}

/** Entries currently memoized (a diagnostic; the caches are otherwise invisible). */
export const parsedPackCacheSize = (): number => cache.size;

/** Drop the memo (tests, and any future "reload packages" surface). */
export const clearParsedPackCache = (): void => cache.clear();
