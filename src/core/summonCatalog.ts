/**
 * Read-only authoring index for Foundry Summons-style source selection. A pack
 * entry is only a reference until the HOST resolves it at placement; searching
 * or selecting never imports an actor into the world or grants pack bytes to a
 * player. Only the GM wizard calls this with its installed pack inventory.
 */
import type { ActorDocument } from "./documents";
import type { CompendiumPack } from "./compendium";
import type { SummonSource } from "./summons";

export interface SummonCatalogPack { packageId: string; packFile: string; pack: CompendiumPack }
export interface SummonCatalogChoice {
  key: string;
  label: string;
  source: SummonSource;
  actor?: ActorDocument;
  packKey?: string;
  size?: string;
  cr?: number;
  keywords: string[];
}
export interface SummonCatalogFilter {
  search?: string;
  showWorld?: boolean;
  showPacks?: boolean;
  packKey?: string;
  size?: string;
  minCr?: number;
  maxCr?: number;
  sort?: "asc" | "desc" | "crAsc" | "crDesc";
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Index only known *display* fields. Neither index nor UI is a host grant. */
export function summonIndexFields(data: unknown): { cr?: number; size?: string } {
  const system = record(data) && record(data.system) ? data.system : {};
  const pf1e = record(system.pf1e) ? system.pf1e : {};
  const mirror = record(system.mirror) ? system.mirror : {};
  const rating = [pf1e.cr, mirror.cr, system.cr].find((v) => typeof v === "number" &&
    Number.isFinite(v) && v >= 0 && v <= 1000);
  const rawSize = pf1e.size ?? system.size;
  const size = typeof rawSize === "string" && /^[\p{L}\p{N} _-]{1,32}$/u.test(rawSize) ? rawSize : undefined;
  return { ...(typeof rating === "number" ? { cr: rating } : {}), ...(size ? { size } : {}) };
}

export function indexSummonCatalog(actors: readonly ActorDocument[], packs: readonly SummonCatalogPack[]): SummonCatalogChoice[] {
  const world: SummonCatalogChoice[] = actors.map((actor) => ({
    key: `world:${actor._id}`, label: `World · ${actor.name}`,
    source: { kind: "world", actorId: actor._id }, actor,
    keywords: [actor.name], ...summonIndexFields(actor),
  }));
  const imported: SummonCatalogChoice[] = packs.filter(({ pack }) => pack.type === "actors")
    .flatMap(({ packageId, packFile, pack }) => pack.entries.filter((entry) => entry.data.type === "actor")
      .map((entry) => ({
        key: `pack:${packageId}:${packFile}:${entry.id}`,
        label: `${pack.name} (${packageId}) · ${entry.name}`,
        source: { kind: "compendium" as const, packageId, packFile, entryId: entry.id },
        packKey: `${packageId}:${packFile}`,
        keywords: [entry.name, pack.name, packageId, ...(entry.keywords ?? [])],
        ...summonIndexFields(entry.data),
      })));
  return [...world, ...imported];
}

export function filterSummonCatalog(choices: readonly SummonCatalogChoice[], filter: SummonCatalogFilter): SummonCatalogChoice[] {
  const terms = (filter.search ?? "").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = choices.filter((choice) => {
    if (choice.source.kind === "world" ? filter.showWorld === false :
        filter.showPacks === false || !!filter.packKey && choice.packKey !== filter.packKey) return false;
    if (filter.size && choice.size !== filter.size) return false;
    if (filter.minCr !== undefined && (choice.cr === undefined || choice.cr < filter.minCr)) return false;
    if (filter.maxCr !== undefined && (choice.cr === undefined || choice.cr > filter.maxCr)) return false;
    const searchable = [choice.label, choice.size ?? "", ...choice.keywords].join(" ").toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const cmp = (a: SummonCatalogChoice, b: SummonCatalogChoice) => a.label.localeCompare(b.label);
  const sort = filter.sort ?? "asc";
  return filtered.sort((a, b) => sort === "asc" ? cmp(a, b) : sort === "desc" ? cmp(b, a) :
    sort === "crAsc" ? (a.cr ?? Infinity) - (b.cr ?? Infinity) || cmp(a, b) :
      (b.cr ?? -Infinity) - (a.cr ?? -Infinity) || cmp(a, b));
}
