/**
 * §12 compendium reader — the parts of the panel that are pure data (G-45).
 *
 * The panel itself is a Svelte component over `core/compendiumIndex`; everything that can be
 * decided without a DOM lives here so it is unit-testable: the filter state reducer, the filter
 * summary, and the detail-pane field list (which must never invent a field a document does not
 * carry).
 */
import type { CompendiumEntry } from "../../core/compendium";
import type { EntryFacets, FacetOption } from "../../core/compendiumIndex";

export interface CompendiumFilterState {
  packs: string[];
  kinds: string[];
  schools: string[];
  levels: string[];
}

export const emptyFilters = (): CompendiumFilterState => ({
  packs: [],
  kinds: [],
  schools: [],
  levels: [],
});

/** Toggle one facet value. Returns a new array (the panel assigns a new filter object). */
export const toggleFilter = (list: readonly string[], value: string): string[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export const activeFilterCount = (f: CompendiumFilterState): number =>
  f.packs.length + f.kinds.length + f.schools.length + f.levels.length;

/** Short human summary of the active facets, e.g. `1 pack · 2 kinds`. Empty when unfiltered. */
export function filterSummary(f: CompendiumFilterState): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(f.packs.length, "pack", "packs");
  add(f.kinds.length, "kind", "kinds");
  add(f.schools.length, "school", "schools");
  add(f.levels.length, "level", "levels");
  return parts.join(" · ");
}

/**
 * One facet group as the panel renders it: a stable key, a label, and **chip options that always
 * carry a defined, unique `value`**.
 *
 * The panel keys chips by `option.value`, so a group whose options are shaped differently (packs
 * carry `name`, not `value`) produces `undefined` keys for every chip — a runtime
 * `each_key_duplicate` crash that only a browser run sees. Building the groups here makes that
 * invariant testable without a DOM.
 */
export interface FacetChipGroup {
  key: keyof CompendiumFilterState;
  label: string;
  options: FacetOption[];
}

export function facetChipGroups(
  options: { packs: PackFacetOption[]; kinds: FacetOption[]; schools: FacetOption[]; levels: FacetOption[] },
  max = 24,
): FacetChipGroup[] {
  // Packs are sorted by entry count (the useful ones first); the others arrive alphabetically/
  // numerically from the index.
  const packs = [...options.packs]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en"))
    .map((p) => ({ value: p.name, count: p.count }));
  const groups: FacetChipGroup[] = [
    { key: "kinds", label: "Kind", options: options.kinds },
    { key: "packs", label: "Pack", options: packs },
    { key: "schools", label: "School", options: options.schools },
    { key: "levels", label: "Level", options: options.levels },
  ];
  return groups
    .filter((g) => g.options.length > 1)
    .map((g) => ({ ...g, options: g.options.slice(0, max) }));
}

export interface PackFacetOption {
  name: string;
  count: number;
}

export interface DetailField {
  label: string;
  value: string;
  /** The `data.system` key this row came from — used only to qualify a duplicated label. */
  key?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `camelCase` / `snake_case` / `kebab-case` → `Camel case`, deterministically. */
export function labelOf(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const MAX_VALUE = 160;

/**
 * One-line description of any JSON value. Deliberately lossy: the pane shows what a document
 * *has*, and `[12 rows]` is a truer answer for a table than 12 rows of text.
 */
export function summarizeValue(v: unknown, max = MAX_VALUE): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.length} ${v.length === 1 ? "entry" : "entries"}]`;
  if (typeof v === "string") {
    const text = v.replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isRecord(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{ }";
    const shown = keys.slice(0, 6).join(", ");
    return keys.length > 6 ? `{ ${shown}, … }` : `{ ${shown} }`;
  }
  return String(v);
}

/**
 * The detail pane's fields, in a fixed order, read from the document itself:
 * identity (id / document type / kind / level / school / keywords), then one row per
 * `data.system` key (alphabetical, so the pane is stable), then the effect and item counts that
 * make a spell or a creature act in play.
 *
 * Nothing is defaulted into existence: an entry without a level shows no level row.
 */
export function detailFieldsOf(entry: CompendiumEntry, facets: EntryFacets): DetailField[] {
  const fields: DetailField[] = [{ label: "Id", value: entry.id }];
  const data = entry.data; // already `Record<string, unknown> & {type, name}` — no narrowing needed
  fields.push({
    label: "Document",
    value: typeof data.type === "string" ? data.type : "unknown",
  });
  fields.push({ label: "Kind", value: facets.kind });
  if (facets.level !== null) fields.push({ label: "Level", value: String(facets.level) });
  if (facets.school !== null) fields.push({ label: "School", value: facets.school });
  if (entry.keywords && entry.keywords.length > 0) {
    fields.push({ label: "Keywords", value: entry.keywords.join(", ") });
  }
  const sys = isRecord(data.system) ? data.system : {};
  for (const key of Object.keys(sys).sort()) {
    fields.push({ label: labelOf(key), value: summarizeValue(sys[key]), key });
  }
  if (Array.isArray(data.effects) && data.effects.length > 0) {
    fields.push({ label: "Effects", value: `${data.effects.length} active effect(s)` });
  }
  if (Array.isArray(data.items) && data.items.length > 0) {
    fields.push({ label: "Items", value: `${data.items.length} embedded item(s)` });
  }
  return disambiguateLabels(fields);
}

/**
 * Labels rendered as a description list are **keys** in the panel, so two rows may never share
 * one. That happens with real content: a spell's identity rows say `Level`/`School` (the facets)
 * and its own `system.level`/`system.school` say the same words again — and Svelte refuses a
 * duplicate key at runtime (`each_key_duplicate`, which is how this was found: a browser run of
 * the reader, not a unit test). The second occurrence is qualified with the key it came from
 * rather than being dropped: both facts are worth showing, and the qualifier says which is which.
 */
function disambiguateLabels(fields: DetailField[]): DetailField[] {
  const seen = new Set<string>();
  return fields.map((field) => {
    if (!seen.has(field.label)) {
      seen.add(field.label);
      return field;
    }
    let label = `${field.label} (system.${field.key ?? "?"})`;
    let n = 2;
    while (seen.has(label)) label = `${field.label} (system.${field.key ?? "?"} ${n++})`;
    seen.add(label);
    return { label, value: field.value };
  });
}

/** The entry's document as pretty JSON, clipped — the pane's "what is actually in here?" answer. */
export function documentPreview(entry: CompendiumEntry, max = 4000): string {
  let text: string;
  try {
    text = JSON.stringify(entry.data, null, 2);
  } catch {
    text = "[unserializable document]";
  }
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length} characters total)` : text;
}
