/**
 * World-space audiovisual timeline views. Unlike the ping/ruler EffectsLayer,
 * BOTH strata live UNDER fog; an author cannot bypass LOS by setting a layer.
 * Sprites/text are lifetime-managed per cue, not streamed per frame.
 */
import { BlurFilter, ColorMatrixFilter, Container, Graphics, Sprite, Text, type Filter,
  type Texture } from "pixi.js";
import { fxEase, fxStylePlan, type FxEasing, type FxFilterKind, type ResolvedFxSection } from "../../core/fx";

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

/**
 * The renderer's half of `fxStylePlan`: one section, one pixi filter. A blur is a
 * real blur; the colour adjustments are a colour matrix, so an author can desaturate
 * a ghost or push a fire sprite brighter without shipping a second asset.
 */
export function fxPixiFilter(filter: { kind: FxFilterKind; strength: number } | undefined): Filter | undefined {
  if (!filter) return undefined;
  if (filter.kind === "blur") return new BlurFilter({ strength: filter.strength });
  const matrix = new ColorMatrixFilter();
  if (filter.kind === "grayscale") matrix.greyscale(filter.strength, false);
  else if (filter.kind === "brightness") matrix.brightness(filter.strength, false);
  else matrix.saturate(filter.strength, false);
  return matrix;
}

/**
 * D-302: the transform a section's *animation* produces at `elapsedMs`. Scale walks
 * from `scale` to `scaleTo`; rotation adds `spinDeg` **per cycle** to the section's
 * own base rotation, eased with the same curve as position — so a spinning coin and a
 * flying projectile of the same timeline read as one motion, not two conventions.
 *
 * Pure and total: a zero-length section, a missing field, or a non-finite age all
 * produce the authored still frame rather than NaN.
 */
export function fxTransform(
  section: { scale?: number; scaleTo?: number; spinDeg?: number; rotation?: number;
    easing?: FxEasing; repeats?: number; durationMs: number },
  elapsedMs: number,
): { scale: number; rotation: number } {
  const base = section.scale ?? 1;
  const baseRotation = ((section.rotation ?? 0) * Math.PI) / 180;
  if (!Number.isFinite(elapsedMs) || section.durationMs <= 0)
    return { scale: base, rotation: baseRotation };
  const progress = Math.min(1, Math.max(0, elapsedMs / section.durationMs));
  const cycles = section.repeats ?? 1;
  const phase = progress === 1 ? 1 : (progress * cycles) % 1;
  const eased = fxEase(section.easing, phase);
  const scale = section.scaleTo === undefined ? base : base + (section.scaleTo - base) * eased;
  // A spin ACCUMULATES: completed cycles are already turned, the current one is eased.
  // Easing each cycle from zero would snap the visual back to its base bearing at every
  // cycle boundary — a spinner that flinches once a second instead of turning.
  const turned = progress === 1 ? cycles : Math.min(cycles - 1, Math.floor(progress * cycles)) + eased;
  const spin = section.spinDeg === undefined ? 0 : (section.spinDeg * Math.PI / 180) * turned;
  return { scale, rotation: baseRotation + spin };
}

/**
 * D-301: the graphics an effect is clipped by. A mask lives in the **parent's** space
 * (a world-space region), so it does not rotate or scale with the art — a 15 ft circle
 * on the ground stays a circle whichever way the sprite is turned. `invert` is the
 * cutout: a rectangle big enough to cover the sprite with the shape removed, which the
 * renderer builds with pixi's own hole operation.
 *
 * `extent` is half the sprite's drawn size, so the inverse rectangle always covers it.
 */
export function fxMaskGraphics(mask: { area: Point[]; invert?: boolean }, extent = 0): Graphics {
  const graphics = new Graphics();
  const points = mask.area.flatMap((point) => [point.x, point.y]);
  if (!mask.invert) {
    graphics.poly(points).fill({ color: 0xffffff, alpha: 1 });
    return graphics;
  }
  const reach = Math.max(1, extent) + Math.max(0, ...mask.area.map((point) =>
    Math.max(Math.abs(point.x), Math.abs(point.y)))) + 32;
  graphics.rect(-reach, -reach, reach * 2, reach * 2).fill({ color: 0xffffff, alpha: 1 });
  graphics.poly(points).cut();
  return graphics;
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
  // One shared curve with the camera cues (`fxEase`), so a section's motion and a
  // pan of the same timeline are eased by the same rule.
  const eased = fxEase(section.easing, phase);
  return { x: anchors.from.x + (anchors.to.x - anchors.from.x) * eased,
    y: anchors.from.y + (anchors.to.y - anchors.from.y) * eased };
}
interface ActiveVisual {
  runId: string;
  section: Located;
  view: Sprite | Text;
  age: number;
  persistent: boolean;
  /** What this visual was actually built with, for inspection (`inspect`). */
  filterLabel: string | null;
  /** The clipping region, positioned with the anchor every frame. */
  mask: Graphics | null;
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
    const start = fxTransform(section, age);
    view.scale.set(start.scale);
    view.rotation = start.rotation;
    if (section.kind === "image") {
      if (section.tint) view.tint = section.tint;
      if (section.stretch && section.toX !== undefined && section.toY !== undefined) {
        view.anchor.set(0, 0.5);
        view.width = Math.hypot(section.toX - section.x, section.toY - section.y) * (section.scale ?? 1);
        view.rotation += Math.atan2(section.toY - section.y, section.toX - section.x);
      }
    }
    // Appearance is applied here, once: neither the blend nor the filter changes
    // during a section, so a per-frame rebuild would only cost work.
    const style = fxStylePlan(section);
    view.blendMode = style.blend as typeof view.blendMode;
    const filter = fxPixiFilter(style.filter);
    if (filter) view.filters = [filter];
    view.position.set(section.x, section.y);
    const parent = section.layer === "belowTokens" ? this.belowTokens : this.aboveTokens;
    parent.addChild(view);
    // A mask is built once, like the filter, and only *moved* per frame: the polygon is
    // relative to the anchor, so a followed effect's region travels with it.
    const mask = section.mask
      ? fxMaskGraphics(section.mask, Math.max(view.width, view.height) / 2) : null;
    if (mask) {
      mask.position.set(section.x, section.y);
      parent.addChild(mask);
      view.mask = mask;
    }
    const active: ActiveVisual = { runId, section, view, mask, age, persistent,
      filterLabel: style.filter ? `${style.filter.kind}:${style.filter.strength}` : null,
      ...(finish ? { finish } : {}) };
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
    active.mask?.position.set(x, y);
    // Scale and rotation are animated here rather than at spawn: a section that grows
    // or spins has to be re-derived from its own elapsed time every frame.
    const transform = fxTransform(section, age);
    active.view.scale.set(transform.scale);
    if (section.kind === "image" && section.stretch && anchors.to) {
      // A stretched image points at its destination; a spin adds to that bearing rather
      // than replacing it, so a spinning bolt still flies along its own line.
      active.view.width = Math.hypot(anchors.to.x - anchors.from.x, anchors.to.y - anchors.from.y)
        * transform.scale;
      active.view.rotation = transform.rotation +
        Math.atan2(anchors.to.y - anchors.from.y, anchors.to.x - anchors.from.x);
    } else {
      active.view.rotation = transform.rotation;
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

  /** Read-only: what a run (or everything) is drawing with. Tests and diagnostics only. */
  inspect(runId?: string): Array<{ kind: string; blend: string; filter: string | null; scale: number;
    rotationDeg: number; mask: { points: number; invert: boolean } | null }> {
    return [...this.visuals]
      .filter((active) => runId === undefined || active.runId === runId)
      .map((active) => ({ kind: active.section.kind, blend: String(active.view.blendMode),
        filter: active.filterLabel,
        // Read back from the drawn view, so a test cannot pass on a plan the renderer
        // never applied.
        scale: active.view.scale.x,
        rotationDeg: (active.view.rotation * 180) / Math.PI,
        mask: active.section.kind === "image" || active.section.kind === "text"
          ? (active.section.mask ? { points: active.section.mask.area.length,
              invert: active.section.mask.invert === true } : null)
          : null }));
  }

  private remove(active: ActiveVisual): void {
    active.mask?.destroy();
    this.visuals.delete(active);
    active.view.parent?.removeChild(active.view);
    active.view.destroy(); // media source lifetime is owned by FxPlayer's finish callback
    active.finish?.();
  }

  destroy(): void { this.clear(); }
}
