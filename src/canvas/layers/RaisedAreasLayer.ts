/**
 * D-453: the GM's outline of each raised area (crates, a dais, a scaffold) with its height and
 * whether it is solid. Players never get this layer; they see the map art.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { RaisedMarker } from "../../core/raisedAreas";

export class RaisedAreasLayer {
  private readonly container = new Container();
  private signature = "";
  constructor(parent: Container) {
    this.container.label = "raisedAreas";
    parent.addChild(this.container);
  }
  sync(markers: readonly RaisedMarker[]): void {
    const signature = JSON.stringify(markers);
    if (signature === this.signature) return;
    this.signature = signature;
    for (const child of this.container.removeChildren()) child.destroy();
    for (const marker of markers) {
      if (marker.points.length < 6 || !marker.points.every(Number.isFinite)) continue;
      const color = marker.solid ? 0xff9a5c : 0x5cd6c0;
      const outline = new Graphics();
      outline.label = `raised:${marker.id}`;
      outline.poly(marker.points).fill({ color, alpha: marker.solid ? 0.12 : 0.06 }).stroke({ width: 2, color, alpha: 0.9 });
      this.container.addChild(outline);
      let cx = 0, cy = 0;
      const n = marker.points.length / 2;
      for (let i = 0; i < marker.points.length; i += 2) { cx += marker.points[i] ?? 0; cy += marker.points[i + 1] ?? 0; }
      const label = new Text({ text: marker.label, style: { fontSize: 13, fill: 0xfff3e6, fontFamily: "sans-serif", fontWeight: "bold", stroke: { color: 0x1b1408, width: 4 } } });
      label.label = `raisedLabel:${marker.id}`;
      label.anchor.set(0.5);
      label.position.set(cx / n, cy / n);
      this.container.addChild(label);
    }
  }
  /** Readback: `id → label` of the outlines drawn. */
  labels(): Array<{ id: string; label: string }> {
    return this.container.children.filter((c): c is Text => c instanceof Text)
      .map((c) => ({ id: c.label.slice("raisedLabel:".length), label: c.text })).sort((a, b) => a.id.localeCompare(b.id));
  }
  destroy(): void {
    for (const child of this.container.removeChildren()) child.destroy();
    this.container.destroy();
  }
}
