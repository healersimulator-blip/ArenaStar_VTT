/**
 * D-454: what the fog layer paints into its textures. Pixi's renderer is replaced by a recorder
 * that keeps, per target, the visible fills drawn since that target was last cleared (erase
 * strokes remove instead of paint, so they are kept apart). That is enough to state the
 * contract the screen depends on: the explored cover starts opaque, and the GM's manual mask
 * starts — and after "reveal all" returns to — **transparent**, so it never covers the map.
 */
import { describe, expect, test } from "vitest";
import { Container, Graphics, type Application } from "pixi.js";
import { FOG_COVER_COLOR, FogLayer } from "../../src/canvas/layers/FogLayer";

type Fill = { color: number; alpha: number; erase: boolean };

function recorder() {
  const painted = new Map<unknown, Fill[]>();
  const collect = (node: Container, erase: boolean, out: Fill[]): void => {
    const erasing = erase || node.blendMode === "erase";
    if (node instanceof Graphics) {
      for (const instruction of node.context.instructions) {
        if (instruction.action !== "fill") continue;
        const style = instruction.data.style as { color: number; alpha: number };
        out.push({ color: style.color, alpha: style.alpha, erase: erasing });
      }
    }
    for (const child of node.children) collect(child as Container, erasing, out);
  };
  const app = {
    renderer: {
      render: ({ container, target, clear }: { container: Container; target: unknown; clear?: boolean }) => {
        const fills: Fill[] = [];
        collect(container, false, fills);
        painted.set(target, [...(clear ? [] : painted.get(target) ?? []), ...fills]);
      },
    },
  } as unknown as Application;
  /** Visible paint on a target since its last clear (erase strokes excluded). */
  const visible = (target: unknown) => (painted.get(target) ?? []).filter((f) => !f.erase && f.alpha > 0);
  return { app, visible };
}

const square = [100, 100, 600, 100, 600, 600, 100, 600];

describe("fog layer textures", () => {
  test("a new layer: the explored cover is opaque, the GM's manual mask is empty (transparent)", () => {
    const { app, visible } = recorder();
    const fog = new FogLayer(app, { width: 2200, height: 2200 });
    expect(visible(fog.texture)).toEqual([{ color: FOG_COVER_COLOR, alpha: 1, erase: false }]);
    // Before D-454 this was an opaque black fill: every player saw a black scene under fog.
    expect(visible(fog.manualTexture)).toEqual([]);
  });

  test("a Hide stroke paints the cover colour (never white); an empty log and reset clear it again", () => {
    const { app, visible } = recorder();
    const fog = new FogLayer(app, { width: 2200, height: 2200 });
    fog.applyManualMask([{ mode: "hide", poly: square }]);
    expect(visible(fog.manualTexture)).toEqual([{ color: FOG_COVER_COLOR, alpha: 1, erase: false }]);
    fog.applyManualMask([]);
    expect(visible(fog.manualTexture)).toEqual([]);
    fog.applyManualMask([{ mode: "hide", poly: square }]);
    fog.reset();
    expect(visible(fog.manualTexture)).toEqual([]);
  });

  test("a Reveal stroke erases the manual mask and the explored cover, and paints nothing", () => {
    const { app, visible } = recorder();
    const fog = new FogLayer(app, { width: 2200, height: 2200 });
    fog.applyManualMask([{ mode: "reveal", poly: square }]);
    expect(visible(fog.manualTexture)).toEqual([]);
    expect(visible(fog.texture)).toEqual([{ color: FOG_COVER_COLOR, alpha: 1, erase: false }]); // plus an erase stroke
  });
});
