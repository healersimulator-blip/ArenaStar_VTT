import { Container, Graphics, Text } from "pixi.js";
import type { StairMarker } from "../../core/levelPlay";

/**
 * G-10/G-14 (D-430): stair outlines with up/down arrows and a label. Players get only the
 * host-filtered markers for their floor; the GM canvas shows every stairwell, hidden ones too.
 * The layer sits below lighting and fog, so unexplored or unlit stairs are not given away.
 */
export class StairMarkersLayer {
  private readonly container = new Container();
  private signature = "";
  constructor(parent: Container) {
    this.container.label = "stairMarkers";
    parent.addChild(this.container);
  }
  sync(markers: readonly StairMarker[]): void {
    const signature = JSON.stringify(markers);
    if (signature === this.signature) return;
    this.signature = signature;
    for (const child of this.container.removeChildren()) child.destroy();
    for (const marker of markers) {
      if (marker.points.length < 6 || !marker.points.every(Number.isFinite)) continue;
      const color = marker.locked ? 0x9a7b4f : 0xe0b84f;
      const outline = new Graphics();
      outline.label = `stair:${marker.id}`;
      outline.poly(marker.points).fill({ color, alpha: 0.1 }).stroke({ width: 2, color, alpha: 0.9 });
      this.container.addChild(outline);
      const arrows = `${marker.up ? "↑" : ""}${marker.down ? "↓" : ""}`;
      const text = [arrows, marker.label, marker.locked ? "(locked)" : ""].filter(Boolean).join(" ");
      if (!text) continue;
      let cx = 0, cy = 0;
      const n = marker.points.length / 2;
      for (let i = 0; i < marker.points.length; i += 2) { cx += marker.points[i] ?? 0; cy += marker.points[i + 1] ?? 0; }
      const label = new Text({ text, style: { fontSize: 14, fill: 0xfff0c2, fontFamily: "sans-serif", fontWeight: "bold", stroke: { color: 0x1b1408, width: 4 } } });
      label.label = `stairLabel:${marker.id}`;
      label.anchor.set(0.5);
      label.position.set(cx / n, cy / n);
      this.container.addChild(label);
    }
  }
  ids(): string[] {
    return this.container.children.filter((c) => c.label.startsWith("stair:")).map((c) => c.label.slice("stair:".length));
  }
  destroy(): void {
    for (const child of this.container.removeChildren()) child.destroy();
    this.container.destroy();
  }
}
