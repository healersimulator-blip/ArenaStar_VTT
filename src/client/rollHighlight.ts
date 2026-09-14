/**
 * F01/F03 — roll-card canvas highlight request.
 * A chat card click emits this semantic event on the ClientEvents bus; the App
 * (owner of the stage) resolves tokens against the active scene, syncs the
 * RollHighlightLayer and centers the camera. Kept in the client layer so the
 * bus contract does not depend on the PF1e rules packages (layering: packages
 * import core, never the reverse).
 */

export interface RollHighlightArea {
  shape: "burst" | "cone" | "line" | "cylinder" | "spread" | "emanation";
  origin: { x: number; y: number };
  radiusFt: number;
  direction?: { x: number; y: number } | undefined;
}

export interface RollHighlightRequest {
  /** Which link was clicked: the initiator, one target, or the area epicenter. */
  kind: "initiator" | "target" | "area";
  /** Preferred token to outline + center (null when no linked token exists). */
  tokenId: string | null;
  /** Actor id of the clicked entry (diagnostics / fallback lookups). */
  actorId: string | null;
  /** Area descriptor when the card carries one (drives the shape outline). */
  area: RollHighlightArea | null;
  /** Extra tokens outlined alongside an area click. */
  affectedTokenIds: string[];
  /** Fade duration in seconds (world setting rollHighlightFadeSec). */
  fadeSec: number;
}
