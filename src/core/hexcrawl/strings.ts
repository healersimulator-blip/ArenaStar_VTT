/**
 * **One table for the hexcrawl's words (D-276, plan §8 Phase 7).**
 *
 * G-38 (localization) is **open** and `src/ui/i18n/index.ts` is still the empty barrel it was
 * always meant to be until a non-English table is genuinely in scope — D-263's decision, and not
 * one this feature gets to relitigate by inventing a catalogue with no consumer. What the plan
 * does ask for is the half of that work that pays for itself today: **the feature must not scatter
 * its prose across modules.** So every sentence a GM or a player reads — a rule label, a note, a
 * log line, a menu entry, a hint — is composed here, and nowhere else.
 *
 * Two rules keep the table small enough to be worth having:
 *
 * - **It imports nothing.** Not even `formatDuration`: the callers format their own numbers and
 *   hand the pieces over. A module with no imports is a module that can be handed to G-38's
 *   extraction whole, whatever shape that slice eventually takes.
 * - **It holds sentences, not names.** `Travel`, `Pace`, *Commit route* and the rest of a
 *   control's own labels stay in the markup next to the control they name — they are one word
 *   long, they are already in one file, and moving them would make the template harder to read
 *   without making the table more useful. Everything that is *composed* (a rule, a reason, a
 *   report of what just happened) lives here.
 */
export const hexMenu = {
  unexplored: "Unexplored",
  openDescription: "Open hex description",
  partyHere: "the party is here",
  closeHex: "Close hex (hide from players)",
  openHex: "Open hex (reveal to players)",
  noZone: "no zone authored here — a gridless cell needs its own shape",
  attachTable: "Attach encounter table…",
  rollFromTable: "Roll from a table…",
  explore: "Explore this hex",
  featuresOf: "Features of this hex…",
  revealFeature: "Reveal feature…",
  moveParty: "Move party here",
  noPartyToken: "this scene has no party token yet",
  addToPath: "Add to path",
} as const;

/** How a feature's rule reads, and what the engine says when it judges one. */
export const hexFeature = {
  /** The `manual` rule, and the fallback for anything this build cannot read. */
  manual: "the GM reveals it",
  /** Appended to every rule whose `autoReveal` is off: the engine may judge it, not apply it. */
  decides: " — the GM decides",
  perceptionCheck: (dc: number): string => `Perception check vs ${dc}`,
  perceptionPassive: (dc: number): string => `passive Perception ${dc}`,
  time: (duration: string): string => `${duration} spent here`,
  dice: (formula: string, target: number): string => `${formula} ≥ ${target}`,
  /** A `time` rule that has not fired yet. */
  noteTime: (name: string, spent: string, need: string): string =>
    `${name}: ${spent} here vs ${need}`,
  notePerception: (name: string, passive: number, target: number): string =>
    `${name}: passive Perception ${passive} vs ${target}`,
  notePerceptionRoll: (name: string, total: number, target: number): string =>
    `${name}: Perception ${total} vs ${target}`,
  notePerceptionBroken: (name: string): string =>
    `${name}: the Perception check could not be rolled`,
  noteBadFormula: (name: string, formula: string): string =>
    `${name}: “${formula}” is not a formula this engine can roll`,
  noteDice: (name: string, formula: string, total: number, target: number): string =>
    `${name}: ${formula} → ${total} vs ${target}`,
  /** Found, but `autoReveal` is off — the GM's checkbox is still the switch. */
  noteFound: (name: string): string => `${name}: found — reveal it when you are ready`,
  /** The chat card a reveal leaves behind (D-275). */
  found: (cellKey: string, name: string): string => `Found at ${cellKey}: ${name}`,
} as const;

/** What the travel panel says, before and after a march. */
export const hexTravel = {
  hint: "Every button spends the world clock; the party camps where the road ends.",
  pathHint:
    "Click hexes to extend the route; click the last one again to take it back. Esc clears, and the itinerary under the rail commits it.",
  routeTooShort: "A route needs at least a second hex — click one, then Commit.",
  committed: (hexes: number, duration: string): string =>
    `Route committed: ${hexes} hexes, ${duration} on the road.`,
  calledOff: "The march is called off.",
  noRoute: "No route is committed — draw one in path mode first.",
  arrives: (where: string, duration: string, spent: string): string =>
    `The party arrives at ${where} — ${duration} on the road, ${spent} spent there.`,
  atCell: (where: string, duration: string): string =>
    `The party is at ${where} — ${duration} on the road.`,
  /** Shift+H on a map that is not a hexcrawl one, and on one that has no party yet. */
  partyKeyNoScene: "Shift+H opens the party's hex — this scene is not a hexcrawl map.",
  partyKeyNoToken:
    "This hexcrawl scene has no party token yet — name one in the scene wizard or the scene editor.",
} as const;
