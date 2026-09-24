/**
 * World-space audiovisual timeline views. Unlike the ping/ruler EffectsLayer,
 * BOTH strata live UNDER fog; an author cannot bypass LOS by setting a layer.
 * Sprites/text are lifetime-managed per cue, not streamed per frame.
 */
import { Container, Sprite, Text, type Texture } from "pixi.js";
import type { ResolvedFxSection } from "../../core/fx";

type Located = Extract<ResolvedFxSection, { kind: "image" | "text" }>;
type Point = { x: number; y: number };
type Anchors = { from: Point; to?: Point };

/** A followed token is looked up ONLY in the recipient's currently drawn
 * (projected + fog-filtered) scene. Missing/hidden anchors suppress the visual,
 * rather than freezing it at a stale coordinate or revealing its live position. */
export function fxFollowAnchors(section: Located, tokenCenter: (id: string) => Point | undefined): Anchors | undefined {
  const from = section.followTokenId ? tokenCenter(section.followTokenId) : { x: section.x, y: section.y };
  const to = section.followToTokenId ? tokenCenter(section.followToTokenId)
    : section.toX !== undefined && section.toY !== undefined ? { x: section.toX, y: section.toY } : undefined;
  if (!from || section.followToTokenId && !to) return undefined;
  return { from, ...(to ? { to } : {}) };
}

/** Pure host-time tween: late join/slow decoding jumps to the correct frame. */
export function fxPosition(section: Located, elapsedMs: number, anchors: Anchors = {
  from: { x: section.x, y: section.y },
  ...(section.toX !== undefined && section.toY !== undefined
    ? { to: { x: section.toX, y: section.toY } } : {}),
}): Point {
  if (!anchors.to || section.kind === "image" && section.stretch) return anchors.from;
  const progress = Math.min(1, Math.max(0, elapsedMs / section.durationMs));
  const cycles = section.repeats ?? 1;
  const phase = progress === 1 ? 1 : (progress * cycles) % 1;
  const eased = section.easing === "easeIn" ? phase * phase :
    section.easing === "easeOut" ? 1 - (1 - phase) ** 2 :
    section.easing === "easeInOut" ? phase < 0.5 ? 2 * phase * phase :
      1 - (-2 * phase + 2) ** 2 / 2 : phase;
  return { x: anchors.from.x + (anchors.to.x - anchors.from.x) * eased,
    y: anchors.from.y + (anchors.to.y - anchors.from.y) * eased };
}
interface ActiveVisual {
  runId: string;
  section: Located;
  view: Sprite | Text;
  age: number;
  persistent: boolean;
  finish?: () => void;
}

export class FxLayer {
  private readonly visuals = new Set<ActiveVisual>();
  constructor(
    private readonly belowTokens: Container,
    private readonly aboveTokens: Container,
    private readonly tokenCenter: (id: string) => Point | undefined = () => undefined,
  ) {}

  spawn(runId: string, section: Located, elapsedMs = 0, texture?: Texture, finish?: () => void,
    persistent = false): void {
    if (!persistent && elapsedMs >= section.durationMs) { finish?.(); return; }
    const age = persistent ? Math.max(0, elapsedMs) % section.durationMs : elapsedMs;
    if (section.kind === "image" && !texture) { finish?.(); return; }
    const view = section.kind === "text"
      ? new Text({ text: section.text, style: { fontFamily: "sans-serif", fontSize: 24,
          fill: section.color ?? "#ffffff", align: "center", wordWrap: true, wordWrapWidth: 400 } })
      : new Sprite(texture);
    view.anchor.set(0.5);
    view.scale.set(section.scale ?? 1);
    view.rotation = ((section.rotation ?? 0) * Math.PI) / 180;
    if (section.kind === "image") {
      if (section.tint) view.tint = section.tint;
      if (section.stretch && section.toX !== undefined && section.toY !== undefined) {
        view.anchor.set(0, 0.5);
        view.width = Math.hypot(section.toX - section.x, section.toY - section.y) * (section.scale ?? 1);
        view.rotation += Math.atan2(section.toY - section.y, section.toX - section.x);
      }
    }
    view.position.set(section.x, section.y);
    (section.layer === "belowTokens" ? this.belowTokens : this.aboveTokens).addChild(view);
    const active: ActiveVisual = { runId, section, view, age, persistent, ...(finish ? { finish } : {}) };
    this.visuals.add(active);
    this.setAlpha(active);
  }

  private setAlpha(active: ActiveVisual): void {
    const { section, age } = active;
    const anchors = fxFollowAnchors(section, this.tokenCenter);
    if (!anchors) { active.view.visible = false; return; }
    active.view.visible = true;
    const { x, y } = fxPosition(section, age, anchors);
    active.view.position.set(x, y);
    if (section.kind === "image" && section.stretch && anchors.to) {
      active.view.width = Math.hypot(anchors.to.x - anchors.from.x, anchors.to.y - anchors.from.y) * (section.scale ?? 1);
      active.view.rotation = ((section.rotation ?? 0) * Math.PI) / 180 +
        Math.atan2(anchors.to.y - anchors.from.y, anchors.to.x - anchors.from.x);
    }
    const fadeIn = section.fadeInMs ? Math.min(1, age / section.fadeInMs) : 1;
    const fadeOut = section.fadeOutMs ? Math.min(1, (section.durationMs - age) / section.fadeOutMs) : 1;
    active.view.alpha = (section.opacity ?? 1) * Math.max(0, Math.min(fadeIn, fadeOut));
  }

  tick(deltaMs: number): void {
    for (const active of [...this.visuals]) {
      active.age += Math.max(0, deltaMs);
      if (active.age >= active.section.durationMs && !active.persistent) {
        this.remove(active);
      } else {
        if (active.persistent) active.age %= active.section.durationMs;
        this.setAlpha(active);
      }
    }
  }

  clear(runId?: string): void {
    for (const active of [...this.visuals]) {
      if (runId === undefined || active.runId === runId) this.remove(active);
    }
  }

  get count(): number { return this.visuals.size; }

  private remove(active: ActiveVisual): void {
    this.visuals.delete(active);
    active.view.parent?.removeChild(active.view);
    active.view.destroy(); // media source lifetime is owned by FxPlayer's finish callback
    active.finish?.();
  }

  destroy(): void { this.clear(); }
}
