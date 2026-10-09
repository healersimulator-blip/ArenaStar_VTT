/** Grid detection status shown by the Map & background panel. */
export type BackgroundDetectionView =
  | { status: "idle" }
  | { status: "running" }
  | { status: "found"; confidence: number }
  | { status: "none"; message: string }
  | { status: "error"; message: string };
