/**
 * Attribution data for the in-app credits surface (plan §1.1, gap G-44).
 *
 * The provenance rows come from `tools/content/sources.json` — the same pinned manifest
 * `pnpm content:fetch` materialises and `pnpm content:convert` reads — so the app can never
 * advertise a different upstream commit than the one the content was converted from. Vite inlines
 * the JSON at build time; it is a few hundred bytes, not a second copy of the data.
 *
 * The *full* legal texts are not in the app: they ship with the content itself (`OGL.txt` and
 * `CREDITS.md` inside every content package and world zip), which is where a licence notice
 * belongs — next to the material it covers. This module is the pointer a player can actually
 * find from inside the app.
 */
import sourcesJson from "../../tools/content/sources.json";

export interface ContentSourceCredit {
  id: string;
  url: string;
  /** Short commit, for display. The full sha is in the manifest. */
  commit: string;
  license: string;
}

interface RawSource {
  id: string;
  url: string;
  commit: string;
  license: string;
}

export const CONTENT_SOURCE_CREDITS: readonly ContentSourceCredit[] = (
  (sourcesJson as { sources: RawSource[] }).sources
).map((s) => ({ id: s.id, url: s.url, commit: s.commit.slice(0, 7), license: s.license }));

/**
 * The application's own licence status. There is no LICENSE file in the repository yet, and the
 * plan's open decision (Wave 1.1, risk 1) is that the project owner picks one — so the app says
 * exactly that instead of implying a grant that does not exist.
 */
export const APP_LICENSE_NOTE =
  "No licence has been published for the application itself yet (see LEGAL.md). Until one is, all rights are reserved.";

/** Where the packaged notices live, spoken to a reader of the credits panel. */
export const CONTENT_NOTICE_NOTE =
  "Each converted content package ships its notices beside its packs: OGL.txt (the Open Game License 1.0a text and the Section 15 copyright notice) and CREDITS.md (which sources produced which pack). They travel inside the world zip.";
