/**
 * §10 map pins (D-256) — Roll20's Place Pin tool. A `NoteDocument` is a pin: it renders as a
 * screen-sized marker at its world point, dashed and grey while it is GM-only, solid and
 * coloured once the GM makes it visible. Hidden pins never reach a player's replica (the
 * projection layer withholds them by ownership), so this layer draws whatever it is given and
 * only the GM ever sees the dashed state.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { Camera } from "../camera";
import type { NoteDocument } from "../../core/documents";

/** Marker radius in screen pixels (constant zoom-independent size, like Roll20's pins). */
export const PIN_RADIUS = 11;

export class NotesLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private readonly labels = new Container();
  private readonly views = new Map<string, Text>();
  /** What the layer last drew — the shells' e2e readback and the hover tooltip. */
  private drawn: NoteDocument[] = [];
  private key = "";

  constructor() {
    this.container.label = "notes";
    this.g.label = "notePins";
    this.container.addChild(this.g, this.labels);
  }

  /** Pins currently drawn (world coords + text), for hit-testing and readbacks. */
  get pins(): ReadonlyArray<NoteDocument> {
    return this.drawn;
  }

  sync(notes: readonly NoteDocument[], camera: Camera): void {
    const scale = camera.scale > 0 ? camera.scale : 1;
    const key = `${Math.round(scale * 100)}|${notes
      .map((n) => `${n._id}:${n.x},${n.y}:${n.visible === true ? 1 : 0}:${n.text}`)
      .join("#")}`;
    if (key === this.key) return;
    this.key = key;
    this.drawn = notes.map((n) => ({ ...n }));
    const g = this.g;
    g.clear();
    const seen = new Set<string>();
    const r = PIN_RADIUS / scale;
    for (const note of notes) {
      const visible = note.visible === true;
      const stroke = visible ? 0x9ad1ff : 0x8b93a7;
      // a pin: circle head over a short stem, so it reads as a map marker, not a token
      g.moveTo(note.x, note.y + r * 1.9);
      g.lineTo(note.x, note.y + r * 0.4);
      g.stroke({ width: Math.max(1, 2), color: stroke, alpha: 0.95 });
      g.circle(note.x, note.y, r);
      g.fill({ color: visible ? 0x2f6fd0 : 0x2a2f3d, alpha: visible ? 0.95 : 0.75 });
      g.stroke({ width: Math.max(1, 2), color: stroke, alpha: 0.95 });
      if (!note.text) continue;
      seen.add(note._id);
      let view = this.views.get(note._id);
      if (!view) {
        view = new Text({ text: "", style: { fontSize: 12, fill: 0xe8ecf2 } });
        this.views.set(note._id, view);
        this.labels.addChild(view);
      }
      view.text = note.text;
      view.style.fontSize = 12 / scale;
      view.position.set(note.x + r * 1.4, note.y - r);
    }
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.views.delete(id);
        view.destroy();
      }
    }
  }

  /** The pin under a world point (radius in world units), topmost first. */
  pinAt(world: { x: number; y: number }, radiusWorld: number): NoteDocument | null {
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const pin = this.drawn[i];
      if (!pin) continue;
      if (Math.hypot(pin.x - world.x, pin.y - world.y) <= radiusWorld) return pin;
    }
    return null;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.views.clear();
    this.drawn = [];
  }
}
