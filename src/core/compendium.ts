/**
 * §12 compendia — read-only packs of documents inside packages (D-087 pack
 * descriptors). A pack file is JSON: { name, type (target collection),
 * entries[] } where each entry carries display metadata and a document
 * create payload WITHOUT _id (assigned fresh at import — read-only source,
 * owned world copies). Indexed + searched client-side; imports go through
 * ordinary create Ops.
 */
import type { BaseDocument, CollectionName } from "./documents";
import { TOP_LEVEL_COLLECTIONS } from "./documents";
import type { Op } from "./ops";
import type { Result } from "./result";
import { err, okVal } from "./result";

/** Max entries per pack and chars per entry name (DoS guard). */
export const COMPENDIUM_MAX_ENTRIES = 2_000;
export const COMPENDIUM_MAX_NAME = 80;

export interface CompendiumEntry {
  /** Stable pack-local slug. */
  id: string;
  name: string;
  img?: string;
  keywords?: string[];
  /** Create payload: must have type + name, must NOT carry _id. */
  data: Record<string, unknown> & { type: string; name: string };
}

export interface CompendiumPack {
  name: string;
  /** Target top-level collection for imports. */
  type: CollectionName;
  entries: CompendiumEntry[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Parse + validate a pack file body (already JSON.parse'd by the loader). */
export function parseCompendiumPack(raw: unknown): Result<CompendiumPack> {
  if (!isRecord(raw)) return err("compendium: pack is not an object");
  const { name, type, entries } = raw;
  if (typeof name !== "string" || name.length === 0 || name.length > COMPENDIUM_MAX_NAME) {
    return err("compendium: pack.name must be 1-80 chars");
  }
  if (typeof type !== "string" || !TOP_LEVEL_COLLECTIONS.includes(type as CollectionName)) {
    return err(`compendium ${name}: pack.type must be a top-level collection`);
  }
  if (!Array.isArray(entries) || entries.length > COMPENDIUM_MAX_ENTRIES) {
    return err(`compendium ${name}: entries must be an array of ≤ ${COMPENDIUM_MAX_ENTRIES}`);
  }
  const seen = new Set<string>();
  const list: CompendiumEntry[] = [];
  for (const raw0 of entries) {
    if (!isRecord(raw0)) return err(`compendium ${name}: entry must be an object`);
    const { id, name: eName, img, keywords, data } = raw0;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      return err(`compendium ${name}: entry.id must be a lowercase slug`);
    }
    if (seen.has(id)) return err(`compendium ${name}: duplicate entry id ${id}`);
    seen.add(id);
    if (typeof eName !== "string" || eName.length === 0 || eName.length > COMPENDIUM_MAX_NAME) {
      return err(`compendium ${name}: entry ${id} name must be 1-80 chars`);
    }
    if (img !== undefined && typeof img !== "string") {
      return err(`compendium ${name}: entry ${id} img must be a string`);
    }
    if (
      keywords !== undefined &&
      (!Array.isArray(keywords) || keywords.some((k) => typeof k !== "string"))
    ) {
      return err(`compendium ${name}: entry ${id} keywords must be string[]`);
    }
    if (!isRecord(data)) return err(`compendium ${name}: entry ${id} data must be an object`);
    if (typeof data.type !== "string" || data.type.length === 0) {
      return err(`compendium ${name}: entry ${id} data.type must be a string`);
    }
    if (typeof data.name !== "string" || data.name.length === 0) {
      return err(`compendium ${name}: entry ${id} data.name must be a string`);
    }
    if ("_id" in data) {
      return err(`compendium ${name}: entry ${id} data must not carry _id (world assigns fresh)`);
    }
    list.push({
      id,
      name: eName,
      ...(img !== undefined ? { img } : {}),
      ...(keywords !== undefined ? { keywords: keywords as string[] } : {}),
      data: data as CompendiumEntry["data"],
    });
  }
  return okVal({ name, type: type as CollectionName, entries: list });
}

// ─── index + search ───────────────────────────────────────────────────────────

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

/** Entry → searchable tokens (name + keywords), cached per pack object. */
const indexCache = new WeakMap<CompendiumPack, Map<string, CompendiumEntry>>();

export function indexPack(pack: CompendiumPack): Map<string, CompendiumEntry> {
  let index = indexCache.get(pack);
  if (index) return index;
  index = new Map();
  for (const entry of pack.entries) index.set(entry.id, entry);
  indexCache.set(pack, index);
  return index;
}

export interface SearchHit {
  pack: CompendiumPack;
  entry: CompendiumEntry;
  score: number;
}

/** Ranked search: name prefix > name word-prefix > name contains > keyword. */
export function searchCompendia(
  packs: readonly CompendiumPack[],
  query: string,
  limit = 50,
): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return packs
      .flatMap((pack) => pack.entries.slice(0, limit).map((entry) => ({ pack, entry, score: 0 })))
      .slice(0, limit);
  }
  const hits: SearchHit[] = [];
  for (const pack of packs) {
    for (const entry of pack.entries) {
      const name = entry.name.toLowerCase();
      const keywords = (entry.keywords ?? []).map((k) => k.toLowerCase());
      let score = 0;
      for (const term of terms) {
        if (name.startsWith(term)) score += 4;
        else if (tokenize(name).some((w) => w.startsWith(term))) score += 3;
        else if (name.includes(term)) score += 2;
        else if (keywords.some((k) => k.includes(term))) score += 1;
        else {
          score = -1;
          break;
        }
      }
      if (score > 0) hits.push({ pack, entry, score });
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score || (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0),
  );
  return hits.slice(0, limit);
}

// ─── import ───────────────────────────────────────────────────────────────────

/** Build the create Op for one entry import (fresh world-owned _id). */
export function importEntryOp(pack: CompendiumPack, entry: CompendiumEntry, newId: string): Op {
  return {
    kind: "create",
    coll: pack.type,
    data: { ...entry.data, _id: newId } as BaseDocument,
  };
}
