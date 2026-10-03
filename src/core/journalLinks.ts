/**
 * §10/TR-12 — journal tile links (MATT's "Triggering a Tile via Journal").
 *
 * A handout page may name a tile (or an engine region) with an inline link:
 *
 *     @Tile[<anchorId>]{Open the gate}                     — the viewer's own scene
 *     @Tile[Scene.<sceneId>.Tile.<anchorId> landing:win]{Open the gate}
 *     @Tile[<anchorId> active:true]{Open the gate}
 *
 * Clicking it fires every `manual`-method graph bound to that anchor, as `manual`,
 * with `originSource: "journal"` — MATT's other way to trigger a tile "manually",
 * usable from a handout instead of the map.
 *
 * Two views of one page must never drift apart:
 *
 *   - the **author's** text (this parse) is what the host resolves against;
 *   - the **player's** replica ({@link maskJournalLinkTargets}) blanks every target
 *     payload before delivery, so a player never receives the id of an anchor they may
 *     not see, and {@link visibleJournalLinks} re-derives the list a player can click by
 *     dropping links hidden inside `<secret>` blocks. Masking preserves link count and
 *     order, so the ordinal a client sends always means the same link on the host.
 *
 * `active:true` matches MATT's "only if the tile is active" option; this engine enforces
 * the paused gate on every path, so a link can never drive a paused graph either way.
 * Parsing never trusts unknown option tokens — a malformed payload stays a link (so the
 * ordinals around it do not shift) and carries an `error` the host refuses on.
 */
import { splitSecretBlocks } from "./markdown";

const LINK = /@Tile\[([^\]]*)\]\{([^}]*)\}/g;
const TARGET_ONLY = /@Tile\[[^\]]*\]/g;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const LANDING = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export interface JournalTileLink {
  /** Ordinal in the text the viewer received (document order). */
  index: number;
  /** Anchor id (a tile or a region), empty when the payload is malformed. */
  tileId: string;
  /** Set by the `Scene.<id>.Tile.<id>` form; otherwise the viewer's own scene. */
  sceneId?: string;
  /** `landing:<name>` — start the graph at that named landing. */
  landing?: string;
  /** `active:true` — parsed for MATT compatibility (the paused gate is always enforced). */
  activeOnly: boolean;
  /** The link text between `{}`. */
  label: string;
  /** Inside a `<secret>` block: delivered to the GM only. */
  hidden: boolean;
  /** Why this link can never fire (the host refuses it); absent on a valid link. */
  error?: string;
  /** Offset of the `@` in the source text (used to align block rendering). */
  start: number;
}

function parsePayload(payload: string): { tileId: string; sceneId?: string; landing?: string;
  activeOnly: boolean; error?: string } {
  const parts = payload.split(/\s+/).filter((part) => part.length > 0);
  let tileId = "";
  let sceneId: string | undefined;
  let landing: string | undefined;
  let activeOnly = false;
  let error: string | undefined;
  for (const part of parts) {
    if (part.startsWith("Scene.") && part.includes(".Tile.")) {
      const [, scene, anchor] = /^Scene\.([^.\s]+)\.Tile\.([^.\s]+)$/.exec(part) ?? [];
      if (!scene || !anchor || !ID.test(scene) || !ID.test(anchor)) { error ??= "malformed scene target"; continue; }
      sceneId = scene;
      tileId = anchor;
    } else if (part.startsWith("landing:")) {
      const name = part.slice("landing:".length);
      if (!LANDING.test(name)) { error ??= "malformed landing"; continue; }
      landing = name;
    } else if (part === "active:true") {
      activeOnly = true;
    } else if (part === "active:false") {
      activeOnly = false;
    } else if (part.startsWith("Tile.")) {
      const anchor = part.slice("Tile.".length);
      if (!ID.test(anchor)) { error ??= "malformed tile id"; continue; }
      tileId = anchor;
    } else if (ID.test(part) && tileId === "") {
      tileId = part;
    } else {
      error ??= `unknown link option ${part}`;
    }
  }
  if (tileId === "" && error === undefined) error = "missing tile id";
  return { tileId, ...(sceneId !== undefined ? { sceneId } : {}), ...(landing !== undefined ? { landing } : {}),
    activeOnly, ...(error !== undefined ? { error } : {}) };
}

/** Secret ranges mirror the projection's own stripping (`<secret>…</secret>`, case-insensitive). */
function secretRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const match of text.matchAll(/<secret>[\s\S]*?<\/secret>/gi)) {
    const start = match.index ?? 0;
    out.push([start, start + match[0].length]);
  }
  return out;
}

/**
 * Every `@Tile[…]` link in `text`, in document order, with secret membership and the
 * absolute ordinal. This is the author's/GM's view; use {@link visibleJournalLinks} for
 * the list a player could click.
 */
export function journalLinks(text: string): JournalTileLink[] {
  const secrets = secretRanges(text);
  const out: JournalTileLink[] = [];
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0;
    const parsed = parsePayload(match[1] ?? "");
    out.push({ index: out.length, ...parsed, label: (match[2] ?? "").trim() || "Trigger tile",
      hidden: secrets.some(([from, to]) => start >= from && start < to), start });
  }
  return out;
}

/** The links a non-GM viewer can see and click, re-indexed to their own text. */
export function visibleJournalLinks(text: string): JournalTileLink[] {
  return journalLinks(text).filter((link) => !link.hidden)
    .map((link, index) => ({ ...link, index }));
}

/**
 * Non-GM delivery: replace every target payload with the opaque placeholder `masked`
 * (labels stay), so a player replica never carries the id of an anchor they were not
 * given. The placeholder still parses as a well-formed link, so the reader renders an
 * enabled button; order and count are preserved, which is what keeps the client's
 * ordinal comparable with the host's. The host never resolves a placeholder: it always
 * re-reads the stored page.
 */
export function maskJournalLinkTargets(text: string): string {
  return text.replace(TARGET_ONLY, "@Tile[masked]");
}

export type JournalSegment =
  | { kind: "text"; text: string }
  | { kind: "secret"; text: string }
  | { kind: "link"; text: string; index: number; label: string; hidden: boolean; error?: string };

/**
 * One ordered walk for renderers: markdown/secret blocks interleaved with the page's
 * links, each carrying its **page-absolute** ordinal. `splitSecretBlocks` reports the
 * offset of each block's text, so a link inside a secret block keeps the index it has in
 * `journalLinks` (the index the host resolves a GM's click with).
 */
export function journalSegments(text: string): JournalSegment[] {
  const byOffset = new Map(journalLinks(text).map((link) => [link.start, link]));
  const out: JournalSegment[] = [];
  for (const block of splitSecretBlocks(text)) {
    const kind = block.secret ? "secret" : "text";
    let last = 0;
    for (const match of block.text.matchAll(LINK)) {
      const local = match.index ?? 0;
      const absolute = block.start + local;
      const link = byOffset.get(absolute);
      if (local > last) out.push({ kind, text: block.text.slice(last, local) });
      out.push(link
        ? { kind: "link", text: match[0], index: link.index, label: link.label, hidden: link.hidden,
            ...(link.error !== undefined ? { error: link.error } : {}) }
        : { kind, text: match[0] });
      last = local + match[0].length;
    }
    if (last < block.text.length) out.push({ kind, text: block.text.slice(last) });
  }
  return out;
}
