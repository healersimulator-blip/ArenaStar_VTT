/**
 * §2.3 (G-25 remainder, D-262) — **the GM's "view as player X"**.
 *
 * The plan's own note: "the host already keeps explored fog **per user + scene** … and `e2eHook`
 * already exposes masked `fogMaskStrokes()`; the slice is a viewer switch in the fog layer, not
 * new state." This module is that switch, minus the wiring:
 *
 * - *who* can be previewed (`viewAsOptions` / `viewAsUser`) — the users a preview is meaningful
 *   for, i.e. the players, because a GM or assistant sees everything and previewing them would be
 *   a no-op that only looks like a feature;
 * - the one rule a preview has to add to the player gate (`withoutHiddenTokens`) — §5 withholds
 *   `hidden` documents from a player's replica entirely, so the GM's replica holding them must not
 *   resurrect them through a gate that runs client-side.
 *
 * Everything else the preview needs already exists and is *called*, not reimplemented: the fog
 * loop computes whose eyes reveal (`fogViewers`), what they reach (§2.1's light-bounded radius)
 * and what they may see (`fogVisibleTokenIds`, D-251 + D-256's manual mask), all from the
 * `PermissionUser` it is handed. Pointing that at somebody else is the whole feature; a second
 * implementation would be a second answer to "what does this player see".
 *
 * **What a preview is not.** It is a view of what the *table's rules* show that user — never a
 * permission change: nothing is written, the fog the viewed player has explored is read and never
 * touched (the loop uploads under the GM's own identity or not at all), and the preview cannot
 * fabricate what the host's §5 projection kept out of a player's replica (a GM-only actor simply
 * is in the GM's store; the canvas shows what the GM holds, gated as the player's gate would).
 */
import type { SceneDocument, TokenDocument, UserDocument } from "./documents";
import type { PermissionUser } from "./ownership";
import { fogVisibleTokenIds, type FogViewerContext } from "./fogExploration";

/** One previewable user, as the GM's picker lists it. */
export interface ViewAsOption {
  id: string;
  name: string;
}

/**
 * The users a GM can preview: the players. A GM or assistant sees every token by role, so
 * "previewing" one would show the GM's own view under another name — the picker leaves them out
 * rather than offering a control that does nothing. The viewer's own id is left out too.
 */
export function viewAsOptions(
  users: readonly UserDocument[],
  me: PermissionUser | null,
): ViewAsOption[] {
  const out: ViewAsOption[] = [];
  for (const user of users) {
    if (user.role !== "PLAYER") continue;
    if (me !== null && user._id === me.id) continue;
    out.push({ id: user._id, name: typeof user.name === "string" && user.name ? user.name : user._id });
  }
  return out;
}

/**
 * The identity a preview runs as, or null when there is nothing to preview (no id chosen, or a
 * user document this replica does not hold — e.g. removed while the preview was on).
 */
export function viewAsUser(
  users: readonly UserDocument[],
  userId: string,
): PermissionUser | null {
  if (!userId) return null;
  const user = users.find((u) => u._id === userId);
  return user === undefined ? null : { id: user._id, role: user.role };
}

/**
 * The gate a preview needs on top of everything §2.1/D-251/D-256 already do: the tokens the host
 * withheld from *that* user (§5's `hidden` projection). The GM's replica holds them, a player's
 * does not, so a client-side preview would otherwise draw a secret token the player cannot even
 * know about — the one place where a faithful preview needs more than the fog rules.
 *
 * `null` (fog off / nothing gated) stays `null`, and the input set is never mutated.
 */
export function withoutHiddenTokens(
  scene: SceneDocument | null,
  visible: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  if (scene === null || visible === null) return visible;
  const hidden = new Set<string>();
  for (const token of scene.tokens) if (isHiddenToken(token)) hidden.add(token._id);
  if (hidden.size === 0) return visible;
  return new Set([...visible].filter((id) => !hidden.has(id)));
}

/** A token the host withholds from players (`hidden` is authored data, absent means visible). */
function isHiddenToken(token: TokenDocument): boolean {
  return token.hidden === true;
}

/**
 * What a previewed user is shown, in one call: the D-251/D-256/D-260 gate as that user, minus the
 * documents §5 never gave them. The shells that run the loop get this for free through
 * `FogExplorationOptions.visibilityFilter`; this export is for callers that want the same answer
 * without a loop (and is what the unit tests pin).
 */
export function viewAsVisibleTokenIds(
  scene: SceneDocument,
  user: PermissionUser | null,
  polys: readonly Float32Array[],
  context: FogViewerContext = {},
): Set<string> {
  const gate = fogVisibleTokenIds(scene, user, polys, context);
  const filtered = withoutHiddenTokens(scene, gate);
  return filtered === gate ? gate : new Set(filtered ?? []);
}
