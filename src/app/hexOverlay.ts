/**
 * D-271 — one place that decides what the hexcrawl overlay paints, shared by both shells.
 *
 * The GM's app (`App.svelte`) and the player's (`JoinApp.svelte`) already share the stage and the
 * projection, so they share this too: the only difference between what the two render is the
 * `viewer` argument, which reaches `hexOverlayPlan` and decides whether the closed cells are
 * covered or merely dimmed. A second copy of this logic in the player shell is exactly how a fog
 * bug becomes "the GM sees one thing and the table sees another".
 *
 * The cache is deliberately plain state rather than a Svelte rune: it is read inside `refresh()`
 * and the ticker, never in markup. `hexOverlayKey` is the cheap signature — a rebuild only
 * happens when the reveal set, the authored terrain, the grid or the map size actually moves.
 */
import type { Stage } from "../canvas/stage";
import type { BaseDocument, SceneDocument } from "../core/documents";
import {
  hexOverlayKey,
  hexOverlayPlan,
  type HexOverlayPlan,
} from "../core/hexcrawl/overlay";
import { isHexcrawlScene } from "../core/hexcrawl/types";
import { terrainCatalogOrDefault } from "../core/hexcrawl/terrain";
import { worldSettingsFrom } from "../core/worldSettings";

export interface HexOverlaySync {
  /** The plan the last rebuild produced; the layer dedupes its redraw on this identity. */
  plan: HexOverlayPlan | null;
  key: string;
}

export function createHexOverlaySync(): HexOverlaySync {
  return { plan: null, key: "" };
}

/**
 * Paint the active scene's hexcrawl overlay, or clear it when this scene is not a hexcrawl map
 * (that is the feature switch — every other scene keeps its canvas exactly as it was).
 */
export function syncHexOverlay(
  view: Stage,
  sync: HexOverlaySync,
  scene: SceneDocument | null,
  viewer: "gm" | "player",
  settings: readonly BaseDocument[],
): void {
  const layer = view.getHexOverlayLayer();
  if (!scene || !isHexcrawlScene(scene)) {
    if (sync.plan !== null) {
      sync.plan = null;
      sync.key = "";
    }
    layer.sync(null, view.camera);
    return;
  }
  const catalog = terrainCatalogOrDefault(
    worldSettingsFrom(settings)["hexTerrain"],
  );
  const key = hexOverlayKey(scene, viewer, catalog);
  if (key !== sync.key) {
    sync.key = key;
    sync.plan = hexOverlayPlan(scene, { viewer, catalog });
  }
  layer.sync(sync.plan, view.camera);
}

/**
 * The ticker path: restroke on a zoom change without rebuilding the plan (the layer's own zoom
 * bucket keeps this to one redraw per wheel notch).
 */
export function repaintHexOverlay(view: Stage, sync: HexOverlaySync): void {
  view.peekHexOverlayLayer()?.sync(sync.plan, view.camera);
}
