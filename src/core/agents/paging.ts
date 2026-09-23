/**
 * MCP connector §7.4 — pagination and the read caps.
 *
 * The failure this exists to prevent is not an error, it is a **success**: a model asks for "the
 * documents", a helpful tool returns all 25,000 compendium entries, and the context window is gone —
 * along with the table. So every list-shaped read is capped by default (`DEFAULT_ROW_CAP`), hard-capped
 * (`MAX_ROW_CAP`) and answers with a cursor when there is more, never with a silently truncated list.
 *
 * Cursors are opaque to the model but readable to a maintainer (`o:<offset>`): an opaque blob is no
 * safer here (the offset is not a secret — the grant is), and a cursor you can read in an audit log is
 * a cursor you can debug.
 */
export const DEFAULT_ROW_CAP = 50;
export const MAX_ROW_CAP = 500;

export interface Page<T> {
  rows: T[];
  /** How many rows existed before the cap — the number a model needs to know it is not seeing all. */
  total: number;
  /** Cursor for the next page, or null when this page was the last one. */
  next: string | null;
  /** The cap that was applied, echoed back so the answer is self-describing. */
  cap: number;
}

export function capOf(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROW_CAP;
  return Math.min(Math.floor(n), MAX_ROW_CAP);
}

/** `null` = start at the beginning; `"o:120"` = the offset form. Anything else is a bad cursor. */
export function parseCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string") return null;
  const match = /^o:(\d+)$/.exec(cursor);
  if (!match) return null;
  return Number(match[1]);
}

export function isCursor(cursor: unknown): boolean {
  return (
    cursor === undefined ||
    cursor === null ||
    cursor === "" ||
    /^o:\d+$/.test(String(cursor))
  );
}

export const cursorFor = (offset: number): string => `o:${offset}`;

/**
 * Slice one page. `total` is the whole set's length, so a caller can tell "20 of 20" (done) from
 * "20 of 25,000" (a drop in the ocean, and it should narrow its query instead of paging 500 times).
 */
export function paginate<T>(
  rows: readonly T[],
  options: { limit?: unknown; cursor?: unknown } = {},
): Page<T> {
  const cap = capOf(options.limit);
  const offset = parseCursor(options.cursor) ?? 0;
  const start = Math.min(offset, rows.length);
  const slice = rows.slice(start, start + cap);
  const nextOffset = start + slice.length;
  return {
    rows: [...slice],
    total: rows.length,
    next: nextOffset < rows.length ? cursorFor(nextOffset) : null,
    cap,
  };
}

/** The sentence every paged tool ends its text block with. */
export function pageNote(page: Page<unknown>, noun = "rows"): string {
  const shown = page.rows.length;
  if (page.total <= shown) return `All ${page.total} ${noun}.`;
  return `${shown} of ${page.total} ${noun} (cap ${page.cap})${
    page.next ? ` — next cursor "${page.next}"` : ""
  }.`;
}
