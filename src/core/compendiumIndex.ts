/**
 * §12 compendium **search index** (G-45 / closure plan §1.4) — the scalable half of the
 * compendium reader.
 *
 * `compendium.ts` owns the pack contract and the *reference* search: one linear scan per query,
 * whose semantics the existing tests pin. That scan is O(entries × terms) with a `tokenize()`
 * allocation per entry per keystroke, which at the 25,376 converted entries (D-253) is "type the
 * exact name" rather than "browse like Foundry". This module owns the index that makes the same
 * queries cheap and adds what browsing needs (facets, sorting, virtualization support) **without
 * changing an answer**:
 *
 *  - **Postings built once, at parse time.** Per pack. Every distinct token of every name and
 *    keyword is interned once and its entries stored in flat typed arrays — a third of the memory
 *    a `Map<string, number[]>` per token would take, and no per-keystroke allocation.
 *  - **Contains-substring queries via 3-gram postings.** `searchCompendia`'s "name contains term"
 *    rung is a substring test, so a prefix-only bucket tree would change results. Terms of ≥ 3
 *    characters intersect the gram postings of their own grams; shorter terms scan the distinct
 *    token list (a few thousand short strings, allocation-free). Both paths build a *superset* of
 *    the entries that could match, and the exact rung-by-rung scorer then reproduces
 *    `searchCompendia`'s numbers — which is what the parity test pins.
 *  - **Ranking without a full comparison sort.** Scores are integers in `[1, 4 × terms]`, so the
 *    relevance order is produced by bucketing score classes (see `rankByRelevance`); a 1-character
 *    query that matches thousands of entries at rung 2 never sorts them for a 50-row page.
 *  - **The index adds no document bodies.** It holds the packs' own entry references plus
 *    lowercase names / token strings / facets (5.4 MB accounted at 20k entries, measured by
 *    `indexFootprintBytes`), and the ranked result is indices, not row objects — the reader
 *    materializes only the rows it draws.
 *  - **Facets are read from authored fields, never invented.** `kind`, `level` and `school` each
 *    come from a field the entry actually carries (documented in `entryFacetsOf`), and an entry
 *    that states no level simply has no level facet — it is excluded only while a level filter is
 *    active, which is what a filter means.
 *  - **A deterministic footprint.** `indexFootprintBytes` accounts the index the way it is actually
 *    stored (JS string characters ×2, typed arrays ×4, documented per-key map overhead) so the
 *    §1.4 memory budget is a number a test can assert rather than a heap delta a CI box can flake
 *    on.
 *
 * Semantics: for any packs, query, filters and sort, `rankIndex`/`searchIndex` return the same
 * ranked rows `searchCompendia` returns (same order, same scores) — `tests/core/compendiumIndex.test.ts`
 * proves it over a corpus of queries, including the rungs that are easy to break (keyword substring,
 * contains-in-the-middle-of-a-token, multi-term AND, 1- and 2-character terms) and at every limit
 * (which exercises the bounded top-N selection).
 *
 * Note on indexed reads: this module is written for `noUncheckedIndexedAccess` with the repo's ban
 * on non-null assertions, so every read of a flat array is total (`?? fallback`) or narrowed. The
 * structures built here are dense by construction — the fallbacks are unreachable and are the price
 * of a type-safe hot loop, not a behaviour.
 */
import type { CompendiumEntry, CompendiumPack } from "./compendium";
import { tokenize } from "./compendium";

/** Separator used to join an entry's tokens into one string. Never appears in a query term. */
const SEP = "\u0000";

// ─── facets ───────────────────────────────────────────────────────────────────

/**
 * Data-derived facets. Every field is read from the entry's own document; nothing is guessed and
 * nothing is defaulted (an unknown kind is the document's own `data.type`, title-cased).
 */
export interface EntryFacets {
  /** Display kind — `Spell`, `Feat`, `Creature`, <item category>, `Roll table`, … */
  kind: string;
  /** Spell level where the data states one (the lowest class level for a level record). */
  level: number | null;
  /** Spell school, title-cased, where the data states one. */
  school: string | null;
}

export interface FacetOption {
  value: string;
  count: number;
}

export interface FacetOptions {
  packs: Array<{ name: string; type: string; count: number }>;
  kinds: FacetOption[];
  schools: FacetOption[];
  levels: FacetOption[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const title = (s: string): string =>
  s.length === 0 ? s : (s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());

const hasKeyword = (keywords: readonly string[] | undefined, word: string): boolean =>
  (keywords ?? []).some((k) => k.toLowerCase() === word);

/**
 * The display kind of one entry. Precedence over fields the data actually carries:
 *
 *  1. non-item documents → their own document type (Actor / Journal / Roll table / …);
 *  2. a **spell**: `system.school`, or the `spell` keyword. Both are needed by the shipped data —
 *     the hand-authored core pack writes `system.school` (75 entries, `systems/pf1e-core/packs/
 *     spells.json`), while 1,569 of the converted corpus's 3,028 spells carry no school at all and
 *     are marked only by their `spell` keyword (`dist/content/pf1e/packs/spells-core.json`);
 *  3. a **table**: `system.table` (a string key in the core pack, a record elsewhere) or
 *     `system.rows` (an array in some packs, an object keyed by size in others);
 *  4. an item with the `feat` keyword — the pf1 system's catch-all item type. Its `system.category`
 *     is the only place that says *what kind of* feat-shaped thing this is, so the four subtypes
 *     that are not feats get their own label: `classFeat` → **Class ability** (4,727),
 *     `trait` → **Trait** (1,915 character traits), `racial` → **Racial** (1,536 — one subtype for
 *     racial feats in the feats pack *and* racial traits in the racial-traits pack; the pack facet
 *     disambiguates rather than the reader guessing), `misc` → **Misc** (333 universal monster
 *     rules in the special-qualities pack). Every other category under `feat` is a real PF1 feat
 *     category (combat, general, monster, teamwork, metamagic, …) and reads as **Feat**;
 *  5. `system.category` → that category, title-cased (Weapon, Equipment, Loot, Buff, Consumable,
 *     Container, Ammo, Race, Implant, …), with `classFeat` spelled out;
 *  6. an actor with `system.hd`/`babProgression` → **Class**, with `system.pf1e` → **Creature**;
 *  7. otherwise the document type, title-cased.
 */
export function entryFacetsOf(entry: CompendiumEntry): EntryFacets {
  const data = rec(entry.data);
  const sys = rec(data.system);
  const type = typeof data.type === "string" ? data.type : "document";
  return { kind: kindOf(type, sys, entry.keywords), level: levelOf(sys), school: schoolOf(sys) };
}

function kindOf(
  type: string,
  sys: Record<string, unknown>,
  keywords: readonly string[] | undefined,
): string {
  if (type === "actor") {
    // Class markers first: they are the specific shape (hit dice + a BAB progression), and a
    // class pack that also carried a `pf1e` block would otherwise read as a creature.
    if (isRecord(sys.hd) || typeof sys.babProgression === "string") return "Class";
    if (isRecord(sys.pf1e)) return "Creature";
    return "Actor";
  }
  if (type === "item") {
    if (typeof sys.school === "string" && sys.school.length > 0) return "Spell";
    if (hasKeyword(keywords, "spell")) return "Spell";
    if (isTable(sys)) return "Table";
    if (hasKeyword(keywords, "feat")) return featKindOf(sys);
    if (typeof sys.category === "string" && sys.category.length > 0) return subtypeLabel(sys.category);
    return "Item";
  }
  if (type === "rollTable") return "Roll table";
  if (type === "journal") return "Journal";
  return title(type);
}

/** A rules table, in any of the shapes the shipped packs author: a key/record `table`, rows as an
 *  array or as an object keyed by size (`systems/pf1e-core/packs/equipment.json`). */
const isTable = (sys: Record<string, unknown>): boolean =>
  typeof sys.table === "string" || isRecord(sys.table) || Array.isArray(sys.rows) || isRecord(sys.rows);

/**
 * The kind of a `feat`-keyword item: **Feat** unless the category is one of the pf1 system's four
 * non-feat subtypes (see `entryFacetsOf`), which are named for what they are.
 */
function featKindOf(sys: Record<string, unknown>): string {
  const category = typeof sys.category === "string" ? sys.category : "";
  if (category === "classFeat" || category === "trait" || category === "racial" || category === "misc") {
    return subtypeLabel(category);
  }
  return "Feat";
}

/** Display label for a `system.category` value: the data's own word, spelled for a reader. */
function subtypeLabel(category: string): string {
  return category === "classFeat" ? "Class ability" : title(category);
}

/**
 * Spell level, where the data states one. A level record (`{sorcererWizard: 3, …}`) reports the
 * **lowest** class level — the level a player looks for — and a record whose values are all
 * non-numeric states nothing (null), as does an item without a level.
 */
function levelOf(sys: Record<string, unknown>): number | null {
  const raw = sys.level;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (isRecord(raw)) {
    let best: number | null = null;
    for (const v of Object.values(raw)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (best === null || v < best) best = v;
    }
    return best;
  }
  return null;
}

function schoolOf(sys: Record<string, unknown>): string | null {
  const raw = sys.school;
  return typeof raw === "string" && raw.length > 0 ? title(raw) : null;
}

// ─── index ────────────────────────────────────────────────────────────────────

export interface IndexedEntry {
  /** Index of the entry's pack inside the index's `packs`. */
  packIndex: number;
  entry: CompendiumEntry;
  nameLower: string;
  /** The name's tokens joined by {@link SEP} — prefix tests walk it without allocating. */
  nameTokens: string;
  /** The keywords' tokens joined by {@link SEP} — the last rung of the scorer. */
  keywordTokens: string;
  facets: EntryFacets;
}

export interface CompendiumIndex {
  readonly packs: readonly CompendiumPack[];
  readonly entries: readonly IndexedEntry[];
  readonly counts: { packs: number; entries: number };
  readonly facetOptions: FacetOptions;
  /** Distinct tokens, id-ordered; `tokenEntryIndices` slices are keyed by these ids. */
  readonly tokenList: readonly string[];
  readonly tokenEntryOffsets: Uint32Array;
  readonly tokenEntryIndices: Uint32Array;
  /** 3-grams of the distinct tokens; `gramTokenIndices` holds token ids ascending. */
  readonly gramList: readonly string[];
  readonly gramTokenOffsets: Uint32Array;
  readonly gramTokenIndices: Uint32Array;
  /** Gram → `gramList` position (the query path's lookup; built once, not rebuilt per query). */
  readonly gramIds: ReadonlyMap<string, number>;
  /** Per-entry scratch for the rung scores (entryCount × 8 B). */
  readonly scores: Float64Array;
  /** Per-entry scratch marks, stamped per candidate collection (entryCount × 4 B). */
  readonly marks: Uint32Array;
  /** Monotonic stamp so a fresh collection never reads a stale mark. */
  readonly scratch: { stamp: number };
}

export function buildCompendiumIndex(packs: readonly CompendiumPack[]): CompendiumIndex {
  const entries: IndexedEntry[] = [];
  const tokenIds = new Map<string, number>();
  const tokenList: string[] = [];
  /** token id → number of entries carrying it (index-posting counts). */
  const tokenCounts: number[] = [];
  /** token id → gram ids (build-time only; the flat postings are what survives). */
  const tokenGramIds = new Map<number, number[]>();
  /** entry index → distinct token ids. */
  const entryTokens: number[][] = [];

  const gramIds = new Map<string, number>();
  const gramList: string[] = [];
  const gramCounts: number[] = [];

  /** Intern a token and, on first sight, its 3-grams. */
  const internToken = (token: string): number => {
    const known = tokenIds.get(token);
    if (known !== undefined) return known;
    const id = tokenList.length;
    tokenIds.set(token, id);
    tokenList.push(token);
    tokenCounts.push(0);
    const grams: number[] = [];
    if (token.length >= 3) {
      const seen = new Set<string>();
      for (let i = 0; i + 3 <= token.length; i++) {
        const gram = token.slice(i, i + 3);
        if (seen.has(gram)) continue;
        seen.add(gram);
        let gid = gramIds.get(gram);
        if (gid === undefined) {
          gid = gramList.length;
          gramIds.set(gram, gid);
          gramList.push(gram);
          gramCounts.push(0);
        }
        grams.push(gid);
        gramCounts[gid] = (gramCounts[gid] ?? 0) + 1;
      }
    }
    tokenGramIds.set(id, grams);
    return id;
  };

  for (const [packIndex, pack] of packs.entries()) {
    for (const entry of pack.entries) {
      const nameLower = entry.name.toLowerCase();
      const nameTokens = tokenize(entry.name);
      const keywordTokens = (entry.keywords ?? []).flatMap((k) => tokenize(k));
      // One posting per entry per distinct token: a name token that is also a keyword token must
      // not double-count, or a hit's score would depend on how the pack spelled things.
      const distinct = new Set<string>([...nameTokens, ...keywordTokens]);
      const ids: number[] = [];
      for (const token of distinct) {
        const id = internToken(token);
        ids.push(id);
        tokenCounts[id] = (tokenCounts[id] ?? 0) + 1;
      }
      entryTokens.push(ids);
      entries.push({
        packIndex,
        entry,
        nameLower,
        nameTokens: nameTokens.join(SEP),
        keywordTokens: keywordTokens.join(SEP),
        facets: entryFacetsOf(entry),
      });
    }
  }

  // Flat postings: offsets by prefix sum, then fill in entry order (ascending per token).
  const tokenEntryOffsets = new Uint32Array(tokenList.length + 1);
  for (let i = 0; i < tokenList.length; i++) {
    tokenEntryOffsets[i + 1] = (tokenEntryOffsets[i] ?? 0) + (tokenCounts[i] ?? 0);
  }
  const tokenEntryIndices = new Uint32Array(tokenEntryOffsets[tokenList.length] ?? 0);
  const cursor = new Uint32Array(tokenList.length);
  for (const [entryIndex, ids] of entryTokens.entries()) {
    for (const tokenId of ids) {
      const at = (tokenEntryOffsets[tokenId] ?? 0) + (cursor[tokenId] ?? 0);
      tokenEntryIndices[at] = entryIndex;
      cursor[tokenId] = (cursor[tokenId] ?? 0) + 1;
    }
  }

  // Flat gram postings over the distinct tokens (token ids ascend inside a slice).
  const gramTokenOffsets = new Uint32Array(gramList.length + 1);
  for (let i = 0; i < gramList.length; i++) {
    gramTokenOffsets[i + 1] = (gramTokenOffsets[i] ?? 0) + (gramCounts[i] ?? 0);
  }
  const gramTokenIndices = new Uint32Array(gramTokenOffsets[gramList.length] ?? 0);
  const gramCursor = new Uint32Array(gramList.length);
  for (let tokenId = 0; tokenId < tokenList.length; tokenId++) {
    for (const gid of tokenGramIds.get(tokenId) ?? []) {
      const at = (gramTokenOffsets[gid] ?? 0) + (gramCursor[gid] ?? 0);
      gramTokenIndices[at] = tokenId; // token ids ascend: the slice stays sorted
      gramCursor[gid] = (gramCursor[gid] ?? 0) + 1;
    }
  }

  return {
    packs,
    entries,
    counts: { packs: packs.length, entries: entries.length },
    facetOptions: facetOptionsOf(packs, entries),
    tokenList,
    tokenEntryOffsets,
    tokenEntryIndices,
    gramList,
    gramTokenOffsets,
    gramTokenIndices,
    gramIds,
    scores: new Float64Array(entries.length),
    marks: new Uint32Array(entries.length),
    scratch: { stamp: 0 },
  };
}

function facetOptionsOf(
  packs: readonly CompendiumPack[],
  entries: readonly IndexedEntry[],
): FacetOptions {
  const kinds = new Map<string, number>();
  const schools = new Map<string, number>();
  const levels = new Map<string, number>();
  const packCounts = packs.map((p) => ({ name: p.name, type: p.type, count: 0 }));
  for (const e of entries) {
    kinds.set(e.facets.kind, (kinds.get(e.facets.kind) ?? 0) + 1);
    if (e.facets.school !== null) {
      schools.set(e.facets.school, (schools.get(e.facets.school) ?? 0) + 1);
    }
    if (e.facets.level !== null) {
      const key = String(e.facets.level);
      levels.set(key, (levels.get(key) ?? 0) + 1);
    }
    const pack = packCounts[e.packIndex];
    if (pack) pack.count += 1;
  }
  const sorted = (m: Map<string, number>): FacetOption[] =>
    [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value, "en"));
  return {
    packs: packCounts,
    kinds: sorted(kinds),
    schools: sorted(schools),
    levels: sorted(levels).sort((a, b) => Number(a.value) - Number(b.value)),
  };
}

// ─── search ───────────────────────────────────────────────────────────────────

export interface IndexFilters {
  /** Pack names to include (empty/absent = every pack). */
  packs?: readonly string[];
  /** Kinds to include (empty/absent = every kind). */
  kinds?: readonly string[];
  /** Spell schools to include. */
  schools?: readonly string[];
  /** Spell levels to include (as strings, matching `FacetOptions.levels`). */
  levels?: readonly string[];
}

export type IndexSort = "relevance" | "name" | "kind" | "level";

export interface IndexSearchOptions {
  /** Cap on returned hits; `undefined` = no cap (the browser virtualizes instead). */
  limit?: number | undefined;
  filters?: IndexFilters | undefined;
  sort?: IndexSort | undefined;
}

export interface IndexHit {
  /** Position in `index.entries` — the id the UI keys rows by. */
  index: number;
  pack: CompendiumPack;
  entry: CompendiumEntry;
  facets: EntryFacets;
  score: number;
}

/**
 * A ranked result as **indices**, not objects: 4 bytes per row instead of a hit object per row.
 * A virtualized list needs the exact match count plus the handful of rows it draws, so ranking
 * 25k rows costs 100 KB per keystroke rather than 25k allocations.
 *
 * `indices` shares nothing mutable, but the *scores* of a scored query live in `index.scores`
 * (the per-entry scratch) and stay valid only until the next search on this index — materialize
 * hits (`searchIndex`) or read scores immediately.
 */
export interface IndexRanking {
  /** Ranked entry indices (positions into `index.entries`), best first. */
  readonly indices: Uint32Array;
  /** Exact number of matches; `indices.length` is smaller when `cap` was used. */
  readonly total: number;
}

export interface IndexRankOptions {
  filters?: IndexFilters | undefined;
  sort?: IndexSort | undefined;
  /**
   * How many ranked rows the caller needs (`undefined` = all of them). Rows past the cap are not
   * ranked — that is what lets a 1-character query over 25k entries answer in a few milliseconds —
   * while `total` stays exact so a virtualized list can still size its scrollbar.
   */
  cap?: number | undefined;
}

const passesFilters = (facets: EntryFacets, filters: IndexFilters | undefined): boolean => {
  if (!filters) return true;
  if (filters.kinds && filters.kinds.length > 0 && !filters.kinds.includes(facets.kind)) {
    return false;
  }
  if (
    filters.schools &&
    filters.schools.length > 0 &&
    (facets.school === null || !filters.schools.includes(facets.school))
  ) {
    return false;
  }
  if (
    filters.levels &&
    filters.levels.length > 0 &&
    (facets.level === null || !filters.levels.includes(String(facets.level)))
  ) {
    return false;
  }
  return true;
};

/**
 * Ranked search as indices. With an empty query it browses: every entry, packs interleaved
 * round-robin (the D-253/V05 property — one large pack must never hide the others), each pack in
 * its own authored order. With terms, it is `searchCompendia`'s ranking, term rung by term rung.
 */
export function rankIndex(
  index: CompendiumIndex,
  query: string,
  opts: IndexRankOptions = {},
): IndexRanking {
  const filters = opts.filters;
  const terms = tokenize(query);
  const packFilter = filters?.packs && filters.packs.length > 0 ? new Set(filters.packs) : null;

  const allowed = (i: number): boolean => {
    const e = index.entries[i];
    if (e === undefined) return false;
    if (packFilter) {
      const pack = index.packs[e.packIndex];
      if (pack === undefined || !packFilter.has(pack.name)) return false;
    }
    return passesFilters(e.facets, filters);
  };

  if (terms.length === 0) {
    const sort = opts.sort ?? "relevance";
    const browse = rankBrowse(index, allowed, sort === "relevance" ? opts.cap : undefined);
    if (sort === "relevance") return browse;
    // An explicit sort replaces the round-robin order, and the cap cuts the *sorted* order — which
    // is why the browse pass above is taken uncapped first.
    return {
      indices: rankByComparator(index, [...browse.indices], sort, opts.cap),
      total: browse.total,
    };
  }

  // Scored search: every term must match, exactly as `searchCompendia` requires. The first term's
  // candidates bound the work (a multi-term hit must match every term, so it is a subset); each
  // later term is then scored exactly over that shrinking set — no second candidate collection,
  // and the scores are the reference's own numbers.
  const first = terms[0] ?? "";
  const candidates = new Uint32Array(index.marks.length);
  const length = collectCandidates(index, first, candidates);
  const live: number[] = [];
  for (let k = 0; k < length; k++) {
    const i = candidates[k];
    if (i === undefined || !allowed(i)) continue;
    const entry = index.entries[i];
    if (entry === undefined) continue;
    const s = rungScore(entry, first);
    if (s <= 0) continue;
    index.scores[i] = s;
    live.push(i);
  }
  live.sort((a, b) => a - b);
  for (let t = 1; t < terms.length && live.length > 0; t++) {
    const term = terms[t] ?? "";
    let write = 0;
    for (let read = 0; read < live.length; read++) {
      const i = live[read];
      if (i === undefined || !allowed(i)) continue;
      const entry = index.entries[i];
      if (entry === undefined) continue;
      const s = rungScore(entry, term);
      if (s <= 0) continue;
      index.scores[i] = (index.scores[i] ?? 0) + s;
      live[write++] = i;
    }
    live.length = write;
  }

  const sort = opts.sort ?? "relevance";
  const indices =
    sort === "relevance"
      ? rankByRelevance(index, live, opts.cap)
      : rankByComparator(index, live, sort, opts.cap);
  return { indices, total: live.length };
}

/** Browse ranking: round-robin across packs, authored order inside a pack. */
function rankBrowse(
  index: CompendiumIndex,
  allowed: (i: number) => boolean,
  cap: number | undefined,
): IndexRanking {
  const byPack = new Map<number, number[]>();
  for (let i = 0; i < index.entries.length; i++) {
    if (!allowed(i)) continue;
    const entry = index.entries[i];
    if (entry === undefined) continue;
    const list = byPack.get(entry.packIndex);
    if (list) list.push(i);
    else byPack.set(entry.packIndex, [i]);
  }
  const packOrder = [...byPack.keys()].sort((a, b) => a - b);
  const total = packOrder.reduce((n, p) => n + (byPack.get(p)?.length ?? 0), 0);
  const size = cap === undefined ? total : Math.min(total, cap);
  const indices = new Uint32Array(size);
  let n = 0;
  let row = 0;
  while (n < size) {
    let advanced = false;
    for (const packIndex of packOrder) {
      const list = byPack.get(packIndex);
      if (list === undefined) continue;
      const i = list[row];
      if (i === undefined) continue;
      advanced = true;
      indices[n++] = i;
      if (n >= size) break;
    }
    if (!advanced) break;
    row += 1;
  }
  return { indices: indices.subarray(0, n), total };
}

/**
 * Relevance ranking without a comparison sort over the whole hit set.
 *
 * Scores are integers in `[1, 4 × terms]` (see `rungScore`), so the ranking is exactly
 * `score desc, name asc` and can be produced by bucketing: walk the score classes from the top,
 * name-sort each, and stop as soon as `cap` rows are collected. A 1-character query matches
 * thousands of entries at rung 2; the reference search sorts all of them for a 50-row page, which
 * is what made it slow — here the wide low-score buckets are never even sorted when the page is
 * already full, and when one *is* needed for the page only the alphabetically-first rows are
 * selected (`selectSmallestNames`).
 *
 * Ties (identical names) keep insertion order — the entries are pushed in ascending index order,
 * which is pack order then authored order, the order the reference's stable sort preserves.
 */
function rankByRelevance(
  index: CompendiumIndex,
  live: readonly number[],
  cap: number | undefined,
): Uint32Array {
  let maxScore = 0;
  for (const i of live) {
    const s = index.scores[i] ?? 0;
    if (s > maxScore) maxScore = s;
  }
  const buckets: number[][] = Array.from({ length: maxScore + 1 }, () => []);
  for (const i of live) buckets[index.scores[i] ?? 0]?.push(i);
  const indices = new Uint32Array(cap === undefined ? live.length : Math.min(cap, live.length));
  let n = 0;
  for (let s = maxScore; s >= 1; s--) {
    const bucket = buckets[s];
    if (bucket === undefined || bucket.length === 0) continue;
    const room = indices.length - n;
    if (room <= 0) break;
    if (room < bucket.length) {
      selectSmallestNames(index, bucket, room);
      for (const i of bucket.slice(0, room)) indices[n++] = i;
      break; // the page is full: lower buckets cannot enter it
    }
    nameSortIndices(index, bucket);
    for (const i of bucket) indices[n++] = i;
  }
  return indices.subarray(0, n);
}

/** Explicit sorts (browse by name/kind/level) order every match, then cut to the cap. */
function rankByComparator(
  index: CompendiumIndex,
  live: readonly number[],
  sort: Exclude<IndexSort, "relevance">,
  cap: number | undefined,
): Uint32Array {
  const nameAt = (i: number): string => index.entries[i]?.entry.name ?? "";
  const order = [...live];
  const byName = (a: number, b: number): number => compareName(nameAt(a), nameAt(b));
  if (sort === "name") {
    order.sort(byName);
  } else if (sort === "kind") {
    order.sort((a, b) => {
      const ka = index.entries[a]?.facets.kind ?? "";
      const kb = index.entries[b]?.facets.kind ?? "";
      return ka.localeCompare(kb, "en") || byName(a, b);
    });
  } else {
    order.sort(
      (a, b) =>
        (index.entries[a]?.facets.level ?? Number.POSITIVE_INFINITY) -
          (index.entries[b]?.facets.level ?? Number.POSITIVE_INFINITY) || byName(a, b),
    );
  }
  const size = cap === undefined ? order.length : Math.min(cap, order.length);
  return Uint32Array.from(order.slice(0, size));
}

/** Materialized ranked search — same hits, order and scores as `searchCompendia`. */
export function searchIndex(
  index: CompendiumIndex,
  query: string,
  opts: IndexSearchOptions = {},
): IndexHit[] {
  const ranking = rankIndex(index, query, {
    filters: opts.filters,
    sort: opts.sort,
    cap: opts.limit,
  });
  const scored = tokenize(query).length > 0;
  const hits: IndexHit[] = [];
  for (const i of ranking.indices) {
    pushHit(index, hits, i, scored ? (index.scores[i] ?? 0) : 0);
  }
  return hits;
}

/** Sort entry indices by name, ascending. */
function nameSortIndices(index: CompendiumIndex, bucket: number[]): void {
  const nameAt = (i: number): string => index.entries[i]?.entry.name ?? "";
  bucket.sort((x, y) => compareName(nameAt(x), nameAt(y)));
}

/**
 * Keep the `need` alphabetically-first entries of `bucket` in place: they are the only ones that
 * can appear on the page, so selecting them beats sorting the whole bucket.
 */
function selectSmallestNames(index: CompendiumIndex, bucket: number[], need: number): void {
  const nameAt = (i: number): string => index.entries[i]?.entry.name ?? "";
  const cmp = (x: number, y: number): number => compareName(nameAt(x), nameAt(y));
  const top: number[] = []; // ascending by name; equal names keep insertion order
  for (const i of bucket) {
    const last = top[top.length - 1];
    if (top.length === need && last !== undefined && cmp(i, last) >= 0) continue;
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const probe = top[mid];
      if (probe !== undefined && cmp(probe, i) <= 0) lo = mid + 1;
      else hi = mid;
    }
    top.splice(lo, 0, i);
    if (top.length > need) top.pop();
  }
  for (const [k, v] of top.entries()) bucket[k] = v;
}

/** Push one hit; the index is dense by construction, so the guard is totality, not behaviour. */
function pushHit(index: CompendiumIndex, hits: IndexHit[], i: number, score: number): void {
  const e = index.entries[i];
  const pack = e === undefined ? undefined : index.packs[e.packIndex];
  if (e === undefined || pack === undefined) return;
  hits.push({ index: i, pack, entry: e.entry, facets: e.facets, score });
}

const compareName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every entry that *could* score for `term` — prefix tokens, tokens containing the term, and
 * keyword tokens containing the term — written into `out` and marked in `index.marks` with a fresh
 * stamp. A superset by construction; `rungScore` then reproduces the reference score exactly.
 */
function collectCandidates(index: CompendiumIndex, term: string, out: Uint32Array): number {
  const marks = index.marks;
  const stamp = (index.scratch.stamp = index.scratch.stamp + 1);
  let length = 0;
  const add = (i: number): void => {
    if (marks[i] === stamp) return;
    marks[i] = stamp;
    out[length++] = i;
  };
  const addToken = (tokenId: number): void => {
    const from = index.tokenEntryOffsets[tokenId] ?? 0;
    const to = index.tokenEntryOffsets[tokenId + 1] ?? from;
    for (const i of index.tokenEntryIndices.subarray(from, to)) add(i);
  };

  if (term.length >= 3) {
    // Intersect the gram postings of the term's own grams: a token containing the term contains all
    // of them, so this is a superset (and usually a very small one). A gram no token carries
    // proves the term is contained nowhere.
    let current: Uint32Array | null = null;
    for (let i = 0; i + 3 <= term.length; i++) {
      const gid = index.gramIds.get(term.slice(i, i + 3));
      if (gid === undefined) return 0;
      const slice = index.gramTokenIndices.subarray(
        index.gramTokenOffsets[gid] ?? 0,
        index.gramTokenOffsets[gid + 1] ?? 0,
      );
      current = current === null ? slice : intersect(current, slice);
      if (current.length === 0) return 0;
    }
    if (current === null) return 0;
    for (const tokenId of current) addToken(tokenId);
    return length;
  }

  // 1–2 character terms: no gram to intersect, so walk the distinct tokens once. Allocation-free
  // and bounded by the vocabulary, not by the entry count.
  for (const tokenId of index.tokenList.keys()) {
    if (index.tokenList[tokenId]?.includes(term) === true) addToken(tokenId);
  }
  return length;
}

/** Sorted intersection of two ascending token-id slices. */
function intersect(a: Uint32Array, b: Uint32Array): Uint32Array {
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  const out = new Uint32Array(small.length);
  let n = 0;
  let j = 0;
  for (const v of small) {
    while (j < large.length && (large[j] ?? Number.POSITIVE_INFINITY) < v) j++;
    if (large[j] === v) out[n++] = v;
  }
  return out.subarray(0, n);
}

/**
 * The reference scorer, rung for rung (`compendium.ts`'s `searchCompendia`): name prefix 4, name
 * word-prefix 3, name contains 2, keyword contains 1, otherwise 0.
 *
 * The "contains" rungs read the *whole* lowercased string in the reference. A term never contains a
 * separator (it comes from `tokenize`), so a separator-free occurrence inside a string always lies
 * inside one token — which is why the token-joined strings here answer the same question. The
 * parity test covers that argument's edge cases (short terms, punctuation, possessives) rather than
 * trusting it.
 */
function rungScore(e: IndexedEntry, term: string): number {
  if (e.nameLower.startsWith(term)) return 4;
  if (tokenHasPrefix(e.nameTokens, term)) return 3;
  if (e.nameLower.includes(term)) return 2;
  if (e.keywordTokens.includes(term)) return 1;
  return 0;
}

function tokenHasPrefix(joined: string, term: string): boolean {
  let pos = 0;
  for (;;) {
    if (joined.startsWith(term, pos)) return true;
    const next = joined.indexOf(SEP, pos);
    if (next < 0) return false;
    pos = next + 1;
  }
}

// ─── footprint ────────────────────────────────────────────────────────────────

/**
 * The index's accounted footprint in bytes — the number the §1.4 budget is asserted against.
 *
 * Model (deliberately explicit, so a reader can argue with it rather than with a heap delta): JS
 * strings are 2 bytes per character; every typed array is 4 bytes per element; the two id maps cost
 * `MAP_SLOT` per distinct key (a rough but stable allowance for the hash-table slot plus the key
 * string header). Entry bodies are **not** counted because they are not retained.
 */
export function indexFootprintBytes(index: CompendiumIndex): number {
  const STRING_HEADER = 16;
  const MAP_SLOT = 48;
  let bytes = 0;
  for (const e of index.entries) {
    bytes += e.nameLower.length * 2 + STRING_HEADER;
    bytes += e.nameTokens.length * 2 + STRING_HEADER;
    bytes += e.keywordTokens.length * 2 + STRING_HEADER;
    bytes += 64; // the IndexedEntry object itself + its facet strings/numbers
  }
  for (const token of index.tokenList) bytes += token.length * 2 + STRING_HEADER + MAP_SLOT;
  for (const gram of index.gramList) bytes += gram.length * 2 + STRING_HEADER + MAP_SLOT;
  bytes += index.tokenEntryOffsets.length * 4;
  bytes += index.tokenEntryIndices.length * 4;
  bytes += index.gramTokenOffsets.length * 4;
  bytes += index.gramTokenIndices.length * 4;
  bytes += index.scores.length * 8;
  bytes += index.marks.length * 4;
  return bytes;
}
