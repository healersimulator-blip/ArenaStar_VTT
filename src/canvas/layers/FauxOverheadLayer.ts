import { Container, Graphics } from "pixi.js";
import type { RegionDocument, TokenDocument } from "../../core/documents";
import {
  compileOverhead,
  overheadAffects,
  overheadCoversPoint,
  type CompiledOverhead,
} from "../../core/fauxOverhead";
import {
  shapeIntersectsRect,
  type SpatialPoint,
} from "../../core/multilevelGeometry";

/**
 * Native inverse vector masks. Only token containers are masked; the map and fog never
 * enter this layer. Masks stay in world coordinates while token animations move beneath them.
 */
export class FauxOverheadLayer {
  private covers: CompiledOverhead[] = [];
  private signature = "";
  private revision = 0;
  private views = new Map<
    string,
    {
      token: TokenDocument;
      view: Container;
      mask: Graphics | null;
      key: string;
    }
  >();
  constructor(private readonly parent: Container) {}
  get active(): boolean {
    return this.covers.length > 0;
  }

  setRegions(regions: readonly RegionDocument[]): void {
    // Ignore unrelated automation/name/permission edits in the derived geometry cache.
    const signature = JSON.stringify(
      regions
        .filter((r) => r.fauxOverhead)
        .map((r) => [
          r._id,
          r.x,
          r.y,
          r.width,
          r.height,
          r.rotation,
          r.shape,
          r.fauxOverhead,
        ]),
    );
    if (signature === this.signature) return;
    this.signature = signature;
    this.covers = compileOverhead(regions);
    this.revision++;
    for (const { token, view } of this.views.values())
      this.syncToken(token, view);
  }

  syncToken(token: TokenDocument, view: Container): void {
    let state = this.views.get(token._id);
    if (!state) {
      state = { token, view, mask: null, key: "" };
      this.views.set(token._id, state);
    }
    state.token = token;
    const key = `${this.revision}:${token.elevation ?? 0}`;
    if (state.key === key) return;
    state.key = key;
    view.mask = null;
    view.setMask({ inverse: false });
    state.mask?.destroy();
    state.mask = null;
    const covers = this.covers.filter((cover) => overheadAffects(cover, token));
    if (!covers.length) return;
    const mask = new Graphics();
    mask.label = `overheadMask:${token._id}`;
    for (const cover of covers) {
      for (const component of cover.shape.components) {
        mask.poly(component.outer.flatMap((p) => [p.x, p.y])).fill(0xffffff);
        // One cut per component: Pixi's consecutive cut() calls may also attach a
        // later hole to the previous fill. Submit all local holes in one path.
        for (const hole of component.holes)
          mask.poly(hole.flatMap((p) => [p.x, p.y]));
        if (component.holes.length) mask.cut();
      }
    }
    this.parent.addChild(mask);
    view.setMask({ mask, inverse: true });
    state.mask = mask;
  }

  pointVisible(id: string, point: SpatialPoint): boolean {
    const state = this.views.get(id);
    return (
      !!state?.view.visible &&
      !overheadCoversPoint(this.covers, state.token, point)
    );
  }

  /** Conservative decoration/marquee gate, not a token LOS or whole-body visibility test. */
  obscured(id: string): boolean {
    const state = this.views.get(id);
    if (!state || !this.active) return false;
    const { token, view } = state;
    // Rotation-safe bounds: decorations disappear early rather than float outside a cover.
    const radius = Math.hypot(token.width, token.height) / 2;
    const rect = {
      x: view.x + token.width / 2 - radius,
      y: view.y + token.height / 2 - radius,
      width: radius * 2,
      height: radius * 2,
    };
    return this.covers.some(
      (cover) =>
        overheadAffects(cover, token) && shapeIntersectsRect(cover.shape, rect),
    );
  }

  remove(id: string): void {
    const state = this.views.get(id);
    if (!state) return;
    state.view.mask = null;
    state.view.setMask({ inverse: false });
    state.mask?.destroy();
    this.views.delete(id);
  }
  destroy(): void {
    for (const id of this.views.keys()) this.remove(id);
    this.covers = [];
  }
}
