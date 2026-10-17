/** Data-only catalogue projection. No sibling code is executed or exposed by this service. */
import type { Json } from "../core/documents";
import type { CompendiumPack } from "../core/compendium";
import type { AisCompendiumSource } from "./aisModuleHandlers";

export interface CatalogueModule {
  packageId: string;
  resources?: Record<string, string>;
  runtimeContext?: Json;
}
type Entry = Awaited<ReturnType<AisCompendiumSource>>[number];
const collections = {
  Actor: "actors",
  Item: "items",
  JournalEntry: "journals",
  RollTable: "rollTables",
  Macro: "macros",
  Playlist: "playlists",
  Scene: "scenes",
} as const;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function parseRows(text: string): Record<string, unknown>[] {
  const source = text.trim();
  if (!source) return [];
  let rows: unknown[];
  try {
    const parsed: unknown = JSON.parse(source);
    rows = Array.isArray(parsed)
      ? parsed
      : record(parsed) && Array.isArray(parsed.entries)
        ? parsed.entries
        : [parsed];
  } catch {
    rows = source
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown);
  }
  return rows.filter(record);
}

/** Cache parsing by immutable resource snapshot; authorization is deliberately NOT cached. */
export function createFoundryCatalogue() {
  const cache = new WeakMap<object, Map<string, Entry[]>>();
  return (
    module: CatalogueModule,
    reader: { isGM: boolean; id?: string },
  ): Entry[] => {
    const context = module.runtimeContext;
    if (
      !record(context) ||
      context.profile !== "foundry-module" ||
      !record(context.distribution) ||
      !module.resources
    )
      return [];
    const distribution = context.distribution;
    if (
      typeof distribution.foundryId !== "string" ||
      !safeId.test(distribution.foundryId) ||
      !Array.isArray(distribution.packs)
    )
      return [];
    // Read the original manifest, not a module-supplied runtime registration. Its
    // privacy/role policy remains authoritative even on older distribution metadata.
    if (!record(context.configuration)) return [];
    const manifest = context.configuration;
    const declarations = Array.isArray(manifest.packs)
      ? (manifest.packs as unknown[]).filter(record)
      : [];
    const policyKey = reader.isGM ? "GM" : `PLAYER:${reader.id ?? ""}`;
    let variants = cache.get(module.resources);
    if (!variants) {
      variants = new Map();
      cache.set(module.resources, variants);
    }
    const key = `${module.packageId}:${policyKey}`;
    const cached = variants.get(key);
    if (cached) return cached;
    const result: Entry[] = [];
    for (const pack of distribution.packs) {
      if (
        !record(pack) ||
        typeof pack.path !== "string" ||
        typeof pack.name !== "string" ||
        !safeId.test(pack.name)
      )
        continue;
      const declaration = declarations.find((p) => p.name === pack.name);
      if (!declaration) continue;
      if (!reader.isGM) {
        if (declaration.private === true) continue;
        if (record(declaration.ownership)) {
          const level =
            declaration.ownership[reader.id ?? ""] ??
            declaration.ownership.PLAYER ??
            declaration.ownership.default ??
            0;
          if (typeof level !== "number" || level < 2) continue;
        }
      }
      const type = collections[pack.type as keyof typeof collections];
      if (!type) continue;
      const prefix = pack.path.replace(/\/$/, "") + "/";
      const texts = Object.entries(module.resources).filter(
        ([path]) => path === pack.path || path.startsWith(prefix),
      );
      if (!texts.length) continue;
      const byId = new Map<string, Record<string, unknown>>();
      for (const [, text] of texts)
        for (const row of parseRows(text)) {
          if (typeof row._id !== "string" || !safeId.test(row._id)) continue;
          if (row.$$deleted === true) {
            byId.delete(row._id);
            continue;
          }
          if (typeof row.name !== "string" || !row.name) continue;
          byId.set(row._id, row);
        }
      const entries = [...byId].map(([id, raw]) => {
        const data = { ...raw };
        delete data._id;
        return {
          id,
          name: String(raw.name),
          ...(typeof raw.img === "string" ? { img: raw.img } : {}),
          data: {
            ...data,
            name: String(raw.name),
            type: typeof raw.type === "string" ? raw.type : "base",
          },
        };
      });
      if (!entries.length) continue;
      result.push({
        packageId: module.packageId,
        packFile: pack.path,
        collectionId: `${distribution.foundryId}.${pack.name}`,
        packageType: distribution.kind === "system" ? "system" : "module",
        pack: {
          name: String(pack.label ?? pack.name),
          type,
          entries,
        } satisfies CompendiumPack,
      });
    }
    variants.set(key, result);
    return result;
  };
}
