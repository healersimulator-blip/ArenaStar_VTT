/**
 * World-space audiovisual timeline views. Unlike the ping/ruler EffectsLayer,
 * BOTH strata live UNDER fog; an author cannot bypass LOS by setting a layer.
 * Sprites/text are lifetime-managed per cue, not streamed per frame.
 */
import { BlurFilter, ColorMatrixFilter, Container, Graphics, Sprite, Text, type Filter,
  type Texture } from "pixi.js";
import { fxEase, fxFilterStrength, fxStylePlan, type FxEasing, type FxFilterKind,
  type FxFilterPlan, type ResolvedFxMask, type ResolvedFxSection } from "../../core/fx";

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
 * D-304: push a new strength into a filter that is already attached to a view. A blur
 * takes it directly; a colour matrix's setters *compose* onto the current matrix, so it
 * must be reset first — otherwise every frame would stack onto the last and a 0.5×
 * desaturation would be grey within a second.
 */
export function fxSetFilterStrength(kind: FxFilterKind, filter: Filter, strength: number): void {
  if (kind === "blur") { (filter as BlurFilter).strength = strength; return; }
  const matrix = filter as ColorMatrixFilter;
  matrix.reset();
  if (kind === "grayscale") matrix.greyscale(strength, false);
  else if (kind === "brightness") matrix.brightness(strength, false);
  else matrix.saturate(strength, false);
}

/**
 * What a filter is *currently* applying, read back out of pixi rather than remembered
 * beside it — D-302's rule for `inspect`, which must not report a plan the renderer
 * never applied. A blur exposes its strength; a colour matrix is a list of coefficients
 * pixi writes the author's number into (directly for `brightness`/`greyscale`, and as
 * `amount * 2/3 + 1` for `saturate`), so this inverts the one cell it lands in. A unit
 * test round-trips all four, so a pixi change fails there instead of lying here.
 */
export function fxFilterReadback(kind: FxFilterKind, filter: Filter): number {
  if (kind === "blur") return (filter as BlurFilter).strength;
  const first = Number((filter as ColorMatrixFilter).matrix[0]);
  return kind === "saturate" ? (first - 1) * 1.5 : first;
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
  const turned = fxTurned(progress, cycles, eased);
  const spin = section.spinDeg === undefined ? 0 : (section.spinDeg * Math.PI / 180) * turned;
  return { scale, rotation: baseRotation + spin };
}

/**
 * How many times a per-cycle animation has turned by `progress`: completed cycles are
 * already behind it, the current one is eased. Easing each cycle from zero would snap a
 * spinning visual back to its base bearing at every boundary (D-302), and a turn is a
 * bearing — that answer is shared with the mask's own turn (D-305) so there is one rule.
 */
function fxTurned(progress: number, cycles: number, eased: number): number {
  return progress === 1 ? cycles : Math.min(cycles - 1, Math.floor(progress * cycles)) + eased;
}

/**
 * D-305: the region's own animation. A growing region restarts per cycle, exactly like
 * the visual's `scaleTo` (a size is a value); a turning one accumulates like `spinDeg`
 * (a bearing is a position). Either way it is pure and total — a late join, a NaN age or
 * a zero-length section produce the authored still region rather than NaN.
 */
export function fxMaskTransform(
  animate: { scale?: number; spinDeg?: number } | undefined,
  section: { easing?: FxEasing; repeats?: number; durationMs: number },
  elapsedMs: number,
): { scale: number; rotation: number } {
  if (!animate || !Number.isFinite(elapsedMs) || section.durationMs <= 0)
    return { scale: 1, rotation: 0 };
  const progress = Math.min(1, Math.max(0, elapsedMs / section.durationMs));
  const cycles = section.repeats ?? 1;
  const phase = progress === 1 ? 1 : (progress * cycles) % 1;
  const eased = fxEase(section.easing, phase);
  const scale = animate.scale === undefined ? 1 : 1 + (animate.scale - 1) * eased;
  const turned = animate.spinDeg === undefined ? 0 : fxTurned(progress, cycles, eased);
  return { scale, rotation: (turned * (animate.spinDeg ?? 0) * Math.PI) / 180 };
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
export function fxMaskGraphics(mask: { area: Point[]; invert?: boolean }, extent = 0,
  transform: { scale: number; rotation: number } = { scale: 1, rotation: 0 }): Graphics {
  return fxMaskDraw(new Graphics(), mask, extent, transform);
}

/**
 * The same drawing, into a graphics that already exists — the path an *animated* region
 * takes every frame. It clears first, so the shape is replaced rather than accumulated,
 * and it is deliberately the only way a mask's geometry is ever produced: one recipe for
 * the first frame and the thousandth.
 */
export function fxMaskDraw(graphics: Graphics, mask: { area: Point[]; invert?: boolean }, extent = 0,
  transform: { scale: number; rotation: number } = { scale: 1, rotation: 0 }): Graphics {
  graphics.clear();
  // Both transforms are exact for every shape here, because each is defined *about* the
  // anchor (a circle's centre, a cone's apex, a rectangle's own centre): turning the
  // region's vertices about the origin spins it, and scaling them grows depth and width
  // together. The polygon travels, so a client never re-derives the scene's metric.
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  const points = mask.area.flatMap((point) => [
    (point.x * cos - point.y * sin) * transform.scale,
    (point.x * sin + point.y * cos) * transform.scale,
  ]);
  if (!mask.invert) {
    graphics.poly(points).fill({ color: 0xffffff, alpha: 1 });
    return graphics;
  }
  const reach = Math.max(1, extent) + Math.max(0, ...mask.area.map((point) =>
    Math.hypot(point.x, point.y))) * transform.scale + 32;
  graphics.rect(-reach, -reach, reach * 2, reach * 2).fill({ color: 0xffffff, alpha: 1 });
  graphics.poly(points).cut();
  return graphics;
}

/**
 * D-305: what a mask's polygon *is*, read out of the graphics it was drawn into rather
 * than remembered beside it (D-302's rule for `inspect`). `radius` is the drawn reach —
 * the largest distance from the anchor — and `bearingDeg` is the direction the region
 * points, which only a cone or a ray can say: a circle has no facing and a rectangle's
 * four corners are symmetric, so both report `null` instead of a made-up number.
 */
export function fxMaskReadback(view: Graphics): { points: number; radius: number; bearingDeg: number | null;
  bounds: { minX: number; maxX: number; minY: number; maxY: number } } {
  type RecordedPath = { instructions?: Array<{ action: string; data?: unknown[] }> };
  const flat = (path: unknown): number[] | null => {
    const poly = (path as RecordedPath | undefined)?.instructions?.find((it) => it.action === "poly");
    const data = poly?.data?.[0];
    return Array.isArray(data) && data.every((value) => typeof value === "number") ? data as number[] : null;
  };
  let polygon: number[] | null = null;
  for (const instruction of view.context.instructions) {
    const data = (instruction as { data?: { path?: unknown; hole?: unknown } }).data;
    // A plain mask fills its own polygon; a cutout carries it as the hole of the
    // covering rectangle. Either way the region is the poly subpath.
    polygon = flat(data?.path) ?? flat(data?.hole) ?? polygon;
  }
  const points: Point[] = [];
  const values = polygon ?? [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const x = values[i]; const y = values[i + 1];
    if (x === undefined || y === undefined) break;
    points.push({ x, y });
  }
  const radius = points.reduce((most, point) => Math.max(most, Math.hypot(point.x, point.y)), 0);
  const far = points.filter((point) => Math.hypot(point.x, point.y) >= radius - 1e-6);
  const centroid = far.reduce((sum, point) => ({ x: sum.x + point.x / far.length,
    y: sum.y + point.y / far.length }), { x: 0, y: 0 });
  const decided = radius > 1e-6 && Math.hypot(centroid.x, centroid.y) > radius * 1e-3;
  const axis = points.map((point) => point.x);
  const ordinate = points.map((point) => point.y);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  // The drawn polygon's own extent, offsets from the anchor: how a *trimmed* region is
  // checked without shipping its vertices around (D-307 — the wall side flattens, the
  // open side keeps the authored reach).
  return { points: points.length, radius: round(radius),
    bearingDeg: decided ? Math.round(((Math.atan2(centroid.y, centroid.x) * 180) / Math.PI) * 10) / 10 : null,
    bounds: { minX: round(points.length ? Math.min(...axis) : 0),
      maxX: round(points.length ? Math.max(...axis) : 0),
      minY: round(points.length ? Math.min(...ordinate) : 0),
      maxY: round(points.length ? Math.max(...ordinate) : 0) } };
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
  /**
   * The attached filters, in authored order (D-313): one pixi instance per chain entry, for
   * the section's whole life (D-299), each with the plan it was built from so an entry that
   * animates is re-derived per frame (D-304) while its neighbours stay exactly as spawn set
   * them.
   */
  filters: Array<{ plan: FxFilterPlan; view: Filter }>;
  /**
   * The clipping region, positioned with the anchor every frame. What it was built from
   * is kept beside it so an *animated* region can be re-derived per frame (D-305) while a
   * still one is never redrawn at all (D-301).
   */
  mask: { view: Graphics; plan: ResolvedFxMask; extent: number } | null;
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
    // Appearance is applied here, once: the blend never changes during a section, and a
    // filter is built once and then only *nudged* when it animates (D-304).
    const style = fxStylePlan(section);
    view.blendMode = style.blend as typeof view.blendMode;
    // One instance per entry, in the author's order: pixi applies `filters` in array order,
    // so the chain an author wrote is the chain that renders.
    const filters = style.filters.flatMap((plan) => {
      const built = fxPixiFilter(plan);
      return built === undefined ? [] : [{ plan, view: built }];
    });
    if (filters.length > 0) view.filters = filters.map((entry) => entry.view);
    // A late join starts mid-animation, so every animated entry takes its start value from
    // the same elapsed time the transform does rather than from the authored beginning.
    for (const entry of filters) {
      if (entry.plan.to !== undefined)
        fxSetFilterStrength(entry.plan.kind, entry.view,
          fxFilterStrength(entry.plan, section, age));
    }
    view.position.set(section.x, section.y);
    const parent = section.layer === "belowTokens" ? this.belowTokens : this.aboveTokens;
    parent.addChild(view);
    // A mask is built once, like the filter, and only *moved* per frame: the polygon is
    // relative to the anchor, so a followed effect's region travels with it. Only a
    // region that animates is ever drawn again (D-305).
    const extent = Math.max(view.width, view.height) / 2;
    const maskView = section.mask
      ? fxMaskGraphics(section.mask, extent, fxMaskTransform(section.mask.animate, section, age)) : null;
    const mask = section.mask && maskView ? { view: maskView, plan: section.mask, extent } : null;
    if (mask) {
      mask.view.position.set(section.x, section.y);
      parent.addChild(mask.view);
      view.mask = mask.view;
    }
    const active: ActiveVisual = { runId, section, view, mask, age, persistent, filters,
      ...(finish ? { finish } : {}) };
    this.visuals.add(active);
    this.applyFrame(active);
  }

  private applyFrame(active: ActiveVisual): void {
    const { section, age } = active;
    const anchors = fxFollowAnchors(section, this.tokenCenter);
    if (!anchors) { active.view.visible = false; return; }
    active.view.visible = true;
    const { x, y } = fxPosition(section, age, anchors);
    active.view.position.set(x, y);
    active.mask?.view.position.set(x, y);
    // A turning or growing region is redrawn from its own elapsed time; the polygon is
    // relative to the anchor, so this only ever changes the shape, never the placement.
    if (active.mask?.plan.animate) {
      fxMaskDraw(active.mask.view, active.mask.plan, active.mask.extent,
        fxMaskTransform(active.mask.plan.animate, section, age));
    }
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
    // A constant filter is left exactly as spawn applied it: only an animated one costs
    // anything per frame (D-304), which is the property D-299 bought and this keeps. In a
    // chain that is per entry (D-313): a deepening blur never re-touches the brightness
    // beside it.
    for (const entry of active.filters) {
      if (entry.plan.to !== undefined)
        fxSetFilterStrength(entry.plan.kind, entry.view,
          fxFilterStrength(entry.plan, section, age));
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
        this.applyFrame(active);
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
  inspect(runId?: string): Array<{ kind: string; blend: string; filters: string[]; scale: number;
    rotationDeg: number;
    mask: { points: number; radius: number; bearingDeg: number | null;
      bounds: { minX: number; maxX: number; minY: number; maxY: number }; invert: boolean } | null }> {
    return [...this.visuals]
      .filter((active) => runId === undefined || active.runId === runId)
      .map((active) => ({ kind: active.section.kind, blend: String(active.view.blendMode),
        // Read back out of each live instance, in chain order: a test cannot pass on a plan
        // the renderer never applied, and the array is the chain the author wrote.
        filters: active.filters.map((entry) =>
          `${entry.plan.kind}:${Math.round(fxFilterReadback(entry.plan.kind, entry.view) * 1000) / 1000}`),
        // Read back from the drawn view, so a test cannot pass on a plan the renderer
        // never applied.
        scale: active.view.scale.x,
        rotationDeg: (active.view.rotation * 180) / Math.PI,
        mask: active.mask
          ? { ...fxMaskReadback(active.mask.view), invert: active.mask.plan.invert === true }
          : null }));
  }

  private remove(active: ActiveVisual): void {
    active.mask?.view.destroy();
    this.visuals.delete(active);
    active.view.parent?.removeChild(active.view);
    active.view.destroy(); // media source lifetime is owned by FxPlayer's finish callback
    active.finish?.();
  }

  destroy(): void { this.clear(); }
}
