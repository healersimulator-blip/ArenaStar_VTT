/**
 * §2.3 tail (G-41 remainder, D-263) — the links the in-app help can honestly offer.
 *
 * Two kinds of document surround a table, and only one of them can be linked from inside the app:
 * the app's *own* design documents (DECISIONS.md, PROTOCOL.md and friends) live in the source
 * repository, which is not shipped with the build and is not published — the help text says so
 * rather than offering a dead link — while the *rules* references are public pages that work from
 * any browser, which is what a table argues about mid-session.
 *
 * The list is deliberately short. A help window that enumerates the internet is a help window
 * nobody reads, and the credits panel already carries provenance for the converted content.
 */

export interface DocsLink {
  id: string;
  label: string;
  url: string;
  /** Why a table would open this — a bare link is a puzzle, not help. */
  note: string;
}

/** Public Pathfinder 1e references: the rules the PF1e sheets implement. */
export const RULES_REFERENCE_LINKS: readonly DocsLink[] = [
  {
    id: "d20pfsrd",
    label: "d20PFSRD",
    url: "https://www.d20pfsrd.com/",
    note: "Community Pathfinder 1e reference — the tables behind carrying capacity, encumbrance and the combat numbers.",
  },
  {
    id: "aonprd",
    label: "Archives of Nethys",
    url: "https://www.aonprd.com/",
    note: "Paizo's own rules reference (the OGL/SRD site) — the first-party wording when the two differ.",
  },
];
