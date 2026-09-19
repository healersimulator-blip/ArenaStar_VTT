/**
 * Type surface of the pure mappers in mappers.mjs. The converter tooling is plain ESM JS
 * (no TS build step for tools/), so tests and future importers get their types from here.
 * Keep in sync with the exported functions of mappers.mjs.
 */

/** Per-pack drop report: what the converter did, category by category. */
export interface ConversionReport {
  total: number;
  converted: number;
  dropped: string[];
  fields: Record<string, number>;
}

/** A mapped compendium entry: display metadata + a document create payload. */
export interface MappedEntry {
  id: string;
  name: string;
  keywords?: string[];
  /**
   * The create payload (item / actor / rollTable / journal, …). `system` is kind-specific;
   * tests and consumers cast to the shape they read.
   */
  data: { type: string; name: string; system?: Record<string, unknown> } & Record<string, unknown>;
}

export const SCHOOL: Record<string, string>;
export const SIZE: Record<string, string>;
export const BAB: Record<string, string>;
/** The in-repo class `levels` tables' save convention (D-234): per-level totals. */
export const SAVE_PROGRESSION: Record<"high" | "medium" | "low", (n: number) => number>;
/** PF1e class BAB progression, per level. */
export const BAB_PROGRESSION: Record<"good" | "medium" | "low", (n: number) => number>;

export function newReport(): ConversionReport;
export function dropField(report: ConversionReport, category: string): void;

/** A Foundry `system.actions` block (an id-keyed object) as an array, "Use" first. */
export function actionsOf(system: unknown): unknown[];
/** HTML → plain text (undefined for non-strings). */
export function stripHtml(html: string): string | undefined;
/** HTML → markdown for journal pages (undefined for empty / non-strings). */
export function htmlToMarkdown(html: string): string | undefined;
/** The compendium id: a lowercase slug of the name, unique within the pack. */
export function slugify(name: string, used?: Set<string>): string;
/** Entry names must fit the 80-char compendium guard; truncate + count. */
export function fitName(name: string, report: ConversionReport): string;

export function mapSpell(src: unknown, report: ConversionReport, used?: Set<string>): MappedEntry | null;
export function mapFeat(src: unknown, report: ConversionReport, used?: Set<string>): MappedEntry | null;
export function mapClass(src: unknown, report: ConversionReport, used?: Set<string>): MappedEntry | null;
export function mapItem(src: unknown, report: ConversionReport, used?: Set<string>): MappedEntry | null;
export function mapActor(src: unknown, report: ConversionReport, used?: Set<string>): MappedEntry | null;
export function mapRollTable(src: unknown, report: ConversionReport, used?: Set<string>): MappedEntry | null;
export function mapJournal(src: unknown, report: ConversionReport, used?: Set<string>): MappedEntry | null;
/** Dispatch on the Foundry entry type (with shape fallbacks for type-less documents). */
export function mapEntry(src: unknown, report: ConversionReport, used?: Set<string>): MappedEntry | null;
