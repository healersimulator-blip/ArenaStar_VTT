/**
 * The image-handling strings added in Phase 4. This is the only table for them: there is no
 * string catalogue yet (D-263 / G-38), so English is the only language. The keys are stable so a
 * catalogue can replace the values later without touching the components.
 */
export const IMAGE_STRINGS = {
  libraryUseAsBackground: "Use as background",
  libraryPlaceAsTile: "Place as tile",
  libraryPlaceFailed: "Could not open this image for placement",
  libraryVariantNotPlaceable: "Thumbnails and mid-size copies are not placed. Place the original image.",
  libraryVideoNote: "Video: scene background only.",
  videoOnlyBackground: "A video can only be used as a scene background.",
  videoPreviewLabel: "Preview of this video",
  videoUnreadable: "The browser could not read this video. Use WebM or MP4.",
  videoNoPicture: "This video has no picture track the browser can show.",
} as const;

export type ImageStringKey = keyof typeof IMAGE_STRINGS;

export function imageString(key: ImageStringKey): string {
  return IMAGE_STRINGS[key];
}
