/**
 * §9 ephemeral visuals (D-083): pings (expanding rings) and per-user rulers
 * with waypoints. Driven by tick(dtMs) from the stage ticker; state is plain
 * data so the drawing stays a thin projection of ephemera.ts logic.
 */
import { Container, Graphics, Text } from "pixi.js";
import { PING_TTL_MS, pingPhase, rulerLabel, type TileRect } from "../ephemera";
import type { MeasureGrid } from "../grid/measure";
import { measurePath } from "../grid/measure";

interface PingItem {
  x: number;
  y: number;
  color: number;
  age: number;
  g: Graphics;
}

interface RulerItem {
  points: Array<{ x: number; y: number }>;
  g: Graphics;
  label: Text;
  labelUnits: string;
  /** ms since the last update; removed after RULER_LINGER_MS. */
  idle: number;
}

export class EffectsLayer {
  readonly container = new Container();
  private readonly pings = new Map<string, PingItem>();
  private readonly rulers = new Map<string, RulerItem>();
  private nextPingId = 0;

  constructor() {
    this.container.label = "effects";
    this.container.eventMode = "none";
  }

  /** Spawn an expanding-ring ping at a world point. */
  spawnPing(at: { x: number; y: number }, color = 0x53b7ff): void {
    const id = `ping-${this.nextPingId++}`;
    const g = new Graphics();
    const item: PingItem = { x: at.x, y: at.y, color, age: 0, g };
    this.pings.set(id, item);
    this.container.addChild(g);
    // never let the id-space grow unbounded for a long session
    if (this.nextPingId > 1e9) this.nextPingId = 0;
  }

  /** Show (or replace) one user's ruler; resets its idle timer. */
  showRuler(
    userId: string,
    points: ReadonlyArray<{ x: number; y: number }>,
    grid: MeasureGrid | null,
    units = "ft",
  ): void {
    if (points.length === 0) {
      this.clearRuler(userId);
      return;
    }
    let item = this.rulers.get(userId);
    if (!item) {
      const g = new Graphics();
      const label = new Text({ text: "", style: { fontSize: 12, fill: 0xffffff } });
      label.anchor.set(0, 1);
      this.container.addChild(g, label);
      item = { points: [], g, label, labelUnits: units, idle: 0 };
      this.rulers.set(userId, item);
    }
    item.points = [...points];
    item.idle = 0;
    item.labelUnits = units;
    this.drawRuler(item, grid);
  }

  clearRuler(userId: string): void {
    const item = this.rulers.get(userId);
    if (!item) return;
    this.container.removeChild(item.g, item.label);
    item.g.destroy();
    item.label.destroy();
    this.rulers.delete(userId);
  }

  /** Advance animations by dtMs; removes finished pings/rulers. */
  tick(dtMs: number, grid: MeasureGrid | null = null): void {
    for (const [id, ping] of this.pings) {
      ping.age += dtMs;
      const phase = pingPhase(ping.age, PING_TTL_MS);
      if (!phase.alive) {
        this.container.removeChild(ping.g);
        ping.g.destroy();
        this.pings.delete(id);
        continue;
      }
      const radius = 8 + 34 * phase.t;
      const alpha = 0.9 * (1 - phase.t);
      ping.g
        .clear()
        .circle(ping.x, ping.y, radius)
        .stroke({ width: 3, color: ping.color, alpha })
        .circle(ping.x, ping.y, 3)
        .fill({ color: ping.color, alpha });
    }
    for (const [userId, item] of this.rulers) {
      item.idle += dtMs;
      if (item.idle > 2500) {
        this.clearRuler(userId);
        continue;
      }
      const fade = Math.min(1, (2500 - item.idle) / 600);
      item.g.alpha = fade;
      item.label.alpha = fade;
    }
    void grid;
  }

  private drawRuler(item: RulerItem, grid: MeasureGrid | null): void {
    const pts = item.points;
    item.g.clear();
    item.g.moveTo(pts[0]?.x ?? 0, pts[0]?.y ?? 0);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p) item.g.lineTo(p.x, p.y);
    }
    item.g.stroke({ width: 2, color: 0xffd166, alpha: 0.95 });
    for (const p of pts) {
      item.g.circle(p.x, p.y, 4).fill({ color: 0xffd166, alpha: 0.95 });
    }
    const total = measurePath(grid, pts);
    item.label.text = pts.length >= 2 ? rulerLabel(total, item.labelUnits) : "";
    const last = pts[pts.length - 1];
    if (last) item.label.position.set(last.x + 8, last.y - 4);
  }

  /** Readbacks (e2e/tests): live ping + ruler counts. */
  get pingCount(): number {
    return this.pings.size;
  }

  get rulerCount(): number {
    return this.rulers.size;
  }

  rulerPoints(userId: string): Array<{ x: number; y: number }> | null {
    return this.rulers.get(userId)?.points ?? null;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

export type { TileRect };
