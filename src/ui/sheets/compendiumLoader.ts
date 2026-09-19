import { openDB } from "idb";
import { DB_NAME, DB_VERSION, listPackages } from "../../storage/idb";
import { parseCompendiumPack, type CompendiumPack } from "../../core/compendium";
import type { WorldId } from "../../core/ids";

export interface CompendiumPackRow {
  packageId: string;
  pack: CompendiumPack;
}

/**
 * Loads compendium packs for the current world or all worlds directly from indexedDB,
 * bypassing host/client packaging seams so character sheets and compendium pickers
 * can browse feats, spells, and items in any context.
 */
export async function loadWorldCompendia(worldId?: WorldId | string): Promise<CompendiumPackRow[]> {
  const out: CompendiumPackRow[] = [];
  try {
    const db = await openDB(DB_NAME, DB_VERSION);
    const targetWorlds: string[] = [];

    if (worldId) {
      targetWorlds.push(worldId);
    } else {
      const worlds = await db.getAll("worlds");
      for (const w of worlds) {
        targetWorlds.push(w.worldId);
      }
    }

    const seenPackKeys = new Set<string>();

    for (const wId of targetWorlds) {
      const records = await listPackages(db, wId);
      for (const rec of records) {
        for (const descriptor of rec.manifest.packs ?? []) {
          const text = rec.files[descriptor.file];
          if (text === undefined) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            continue;
          }
          const pack = parseCompendiumPack(parsed, { origin: "world" });
          if (pack.ok) {
            const key = `${rec.id}:${pack.value.name}`;
            if (!seenPackKeys.has(key)) {
              seenPackKeys.add(key);
              out.push({ packageId: rec.id, pack: pack.value });
            }
          }
        }
      }
    }
  } catch {
    // Return empty on non-browser / failure
  }
  return out;
}
