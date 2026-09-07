/**
 * §10/§9A GM view state — module-level runes (shared by the GM Extras window,
 * the App shell and the strategic fog sync). godView = see everything;
 * viewAsFaction previews faction fog when godView is off (strategic scenes).
 */
export const gmState = $state({
  godView: true,
  viewAsFaction: "",
});
