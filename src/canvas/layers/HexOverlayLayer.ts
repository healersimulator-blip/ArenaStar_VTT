/**
 * §9/§20 — the hexcrawl overlay: the map's cell grid, the GM's terrain tints, and the cover a
 * player sees over ground the table has not opened (D-271, plan §4/§8).
 *
 * The layer is deliberately **dumb**: `core/hexcrawl/overlay.ts` decides which cells exist, which
 * of them are open and what colour each one is, and this class strokes and fills polygons. That
 * split is why the GM's view and a player's view are one code path with two plans — the difference
 * is `plan.viewer`, not a second renderer.
 *
 * Two containers, because they sit at two different places in the stage's stack:
 *
 * - `container` (terrain + grid) goes **below the tokens**, so a tint never washes a token.
 * - `coverContainer` goes **inside the fog holder**, above tokens — a token standing in an
 *   unexplored hex is exactly what a cover is for. It is inserted at the bottom of that holder so
 *   the tactical freehand fog (if the GM also enabled it) still paints over the top.
 *
 * The cover is painted as *everything minus the open cells*: the full map is filled and the open
 * cells are cut out of it (`Graphics.cut`, Pixi v8). That is what lets a player see a covered map
 * without holding a single document for a cell they have not opened (D-271's projection rule).
 */
import { Container, Graphics } from "pixi.js";
import type { HexOverlayPlan } from "../../core/hexcrawl/overlay";
import type { Camera } from "../camera";

const COVER_COLOR = 0x05070c;
const COVER_ALPHA = 0.92;
const TERRAIN_ALPHA = 0.22;
const GRID_ALPHA = 0.32;
/** The cover the GM sees over closed cells: a wash, not a wall — the GM prepares under it. */
const GM_DIM_ALPHA = 0.12;

export class HexOverlayLayer {
  /** Terrain tints + cell outlines. Mounted below the token layer. */
  readonly container = new Container();
  /** The cover. Mounted in the fog holder, above tokens. */
  readonly coverContainer = new Container();
  private readonly terrain = new Graphics();
  private readonly grid = new Graphics();
  private readonly cover = new Graphics();
  private lastPlan: HexOverlayPlan | null = null;
  private lastBucket = -1;

  /** Readbacks for the browser spec: what the last redraw actually painted. */
  cellCount = 0;
  terrainCells = 0;
  openCells = 0;
  coverHoles = 0;
  /** The world rect the cover was painted over (0×0 when there is no cover). */
  coverWidth = 0;
  coverHeight = 0;
  /** The viewer the last plan was built for (null when nothing is painted) — a readback. */
  planViewer: "gm" | "player" | null = null;

  constructor() {
    this.container.label = "hexOverlay";
    this.terrain.label = "hexOverlayTerrain";
    this.grid.label = "hexOverlayGrid";
    this.container.addChild(this.terrain, this.grid);
    this.coverContainer.label = "hexOverlayCover";
    this.cover.label = "hexOverlayCoverFill";
    this.coverContainer.addChild(this.cover);
  }

  /**
   * Redraw when the plan identity or the zoom bucket changes. The plan is already cached by the
   * caller (`hexOverlayKey`), so panning never rebuilds anything and zooming only restrokes the
   * outlines at a screen-constant width.
   */
  sync(plan: HexOverlayPlan | null, camera: Camera): void {
    const bucket = Math.max(1, Math.round(6 / (camera.scale || 1)));
    if (plan === this.lastPlan && bucket === this.lastBucket) return;
    this.lastPlan = plan;
    this.lastBucket = bucket;

    this.terrain.clear();
    this.grid.clear();
    this.cover.clear();
    this.cellCount = 0;
    this.terrainCells = 0;
    this.openCells = 0;
    this.coverHoles = 0;
    this.coverWidth = 0;
    this.coverHeight = 0;
    this.planViewer = plan?.viewer ?? null;
    if (!plan) return;

    const scale = camera.scale || 1;
    for (const cell of plan.cells) {
      this.cellCount++;
      if (cell.open) this.openCells++;
      // Terrain is the GM's own data: only an authored cell carries an assignment worth painting
      // (a map with no terrain painted keeps its own art).
      if (cell.authored && cell.fill !== null) {
        this.terrainCells++;
        this.terrain
          .poly(cell.poly)
          .fill({ color: cell.fill, alpha: TERRAIN_ALPHA });
      }
      this.grid.poly(cell.poly).stroke({
        width: 1.5 / scale,
        color: 0x0b0f14,
        alpha: GRID_ALPHA,
        alignment: 0.5,
      });
    }

    if (plan.viewer === "player" && plan.covers) {
      // Pad the rect so an edge cell opened by the party is fully inside the shape being cut:
      // `cut()` needs each hole to lie within the filled path.
      const padX = plan.map.width * 0.05 + 64;
      const padY = plan.map.height * 0.05 + 64;
      this.coverWidth = plan.map.width + padX * 2;
      this.coverHeight = plan.map.height + padY * 2;
      this.cover.rect(-padX, -padY, this.coverWidth, this.coverHeight).fill({
        color: COVER_COLOR,
        alpha: COVER_ALPHA,
      });
      for (const cell of plan.cells) {
        if (!cell.open) continue;
        this.cover.poly(cell.poly);
        this.coverHoles++;
      }
      this.cover.cut();
      return;
    }

    // The GM (and a player on a map with nothing left closed) gets a faint wash over the closed
    // cells instead: what the table has *not* been told, without hiding the map being prepared.
    if (plan.viewer === "gm" && plan.closedCells > 0) {
      for (const cell of plan.cells) {
        if (cell.open) continue;
        this.terrain
          .poly(cell.poly)
          .fill({ color: COVER_COLOR, alpha: GM_DIM_ALPHA });
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.coverContainer.destroy({ children: true });
  }
}
