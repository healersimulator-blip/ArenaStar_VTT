/**
 * §10/§9A GM view state — module-level runes (shared by the GM Extras window,
 * the App shell and the strategic fog sync). godView = see everything;
 * viewAsFaction previews faction fog when godView is off (strategic scenes).
 *
 * §2.3/G-25 (D-262): `viewAsUser` previews **one player's** table view — the fog loop, the token
 * gate and the HP bars all run as that user, so the GM sees exactly what their player sees. It is
 * a view, never a permission: nothing is written, and the previewed player's explored map is read
 * and never uploaded. Empty string = the GM's own view.
 */
export const gmState = $state({
  godView: true,
  viewAsFaction: "",
  viewAsUser: "",
});
