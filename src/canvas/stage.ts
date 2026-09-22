/**
 * §9 canvas stage (M1 subset) — PixiJS v8 bootstrap with the layer stack
 * Background → Grid → Tokens → Controls (full §9 order lands M2).
 *
 * All layers draw in WORLD coordinates; the root container carries the camera
 * transform (scale + pan). Rendering is ticker-driven; render() forces a frame
 * for deterministic tests.
 */
import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
// file:// and CSP-restricted contexts forbid unsafe-eval; this side-effect
// import swaps Pixi's Function()-based fast paths for eval-free ones (D-058).
import "pixi.js/unsafe-eval";
import type { TokenDocument } from "../core/documents";
import type { Camera, Viewport } from "./camera";
import { fitRect, screenToWorld } from "./camera";
import type { GridSpec, SquareGrid } from "./grid";
import { hexCenter, hexCorners, hexesInView, squareGridLines } from "./grid";
import type { TemplatesLayer } from "./layers/TemplatesLayer";
import { TemplatesLayer as TemplatesLayerImpl } from "./layers/TemplatesLayer";
import type { DrawingsLayer } from "./layers/DrawingsLayer";
import { DrawingsLayer as DrawingsLayerImpl } from "./layers/DrawingsLayer";
import { NotesLayer, NotesLayer as NotesLayerImpl } from "./layers/NotesLayer";
import { dispositionColor, marqueeRect, tokenRect } from "./tokens";
import type { ModelLayer } from "./layers/ModelLayer";
import { ModelLayer as ModelLayerImpl } from "./layers/ModelLayer";
import type { WallsLayer } from "./layers/WallsLayer";
import { WallsLayer as WallsLayerImpl } from "./layers/WallsLayer";
import type { LightingLayer } from "./layers/LightingLayer";
import { LightingLayer as LightingLayerImpl } from "./layers/LightingLayer";
import type { FogLayer } from "./layers/FogLayer";
import { FogLayer as FogLayerImpl } from "./layers/FogLayer";
import type { HexOverlayLayer } from "./layers/HexOverlayLayer";
import { HexOverlayLayer as HexOverlayLayerImpl } from "./layers/HexOverlayLayer";
import type { StrategicFogLayer } from "./layers/StrategicFogLayer";
import { StrategicFogLayer as StrategicFogLayerImpl } from "./layers/StrategicFogLayer";
import type { EffectsLayer } from "./layers/EffectsLayer";
import { EffectsLayer as EffectsLayerImpl } from "./layers/EffectsLayer";
import type { TilesLayer, TilesLayerOptions } from "./layers/TilesLayer";
import { TilesLayer as TilesLayerImpl } from "./layers/TilesLayer";
import type { AreaPreviewLayer } from "./layers/AreaPreviewLayer";
import { AreaPreviewLayer as AreaPreviewLayerImpl } from "./layers/AreaPreviewLayer";
import type { ThreatOverlayLayer } from "./layers/ThreatOverlayLayer";
import { ThreatOverlayLayer as ThreatOverlayLayerImpl } from "./layers/ThreatOverlayLayer";
import type { RollHighlightLayer } from "./layers/RollHighlightLayer";
import { RollHighlightLayer as RollHighlightLayerImpl } from "./layers/RollHighlightLayer";

/** §9 verbatim layer order (§9A models sit between Tokens and Tiles(above)). */
export const LAYER_ORDER = [
  "background",
  "tilesBelow",
  "grid",
  "drawings",
  "templates",
  "walls",
  "lighting",
  "tokens",
  "models",
  "tilesAbove",
  "fog",
  "effects",
  "notes",
  "controls",
] as const;

export interface StageOptions {
  width: number;
  height: number;
  /** Background fill (default: near-black). */
  background?: number;
  /** Element to mount the canvas into (defaults to document.body). */
  hostElement?: HTMLElement;
}

export interface Stage {
  readonly app: Application;
  readonly root: Container;
  readonly camera: Camera;
  readonly viewport: Viewport;
  /** §9A ModelLayer (created on first use; sits between Tokens and Controls). */
  getModelLayer(): ModelLayer;
  /** §9 Walls(GM) overlay. */
  getWallsLayer(): WallsLayer;
  /** §9 Lighting (darkness + additive polygon-clipped lights). */
  getLightingLayer(): LightingLayer;
  /** §9 per-user explored fog (one per scene size — recreate per scene). */
  getFogLayer(sceneSize: { width: number; height: number }): FogLayer;
  /** §9 fog is off for the scene: hide the mounted layer (if any) without dropping it. */
  hideFogLayer(): void;
  /** The mounted fog layer, if any (readbacks for e2e). */
  peekFogLayer(): FogLayer | null;
  /** §9A faction fog cover (strategic scenes). */
  getStrategicFogLayer(): StrategicFogLayer;
  /**
   * D-271 hexcrawl overlay: cell grid + terrain tints below the tokens, and the cover players see
   * over unopened ground above them. Mounted on first use; `sync(null)` clears it.
   */
  getHexOverlayLayer(): HexOverlayLayer;
  /** The mounted hexcrawl overlay, if any (readbacks for e2e). */
  peekHexOverlayLayer(): HexOverlayLayer | null;
  /** §9 pings + rulers (ephemeral overlays, ticker-driven). */
  getEffectsLayer(): EffectsLayer;
  /** §9 tiles below/above with roof/fade occlusion. */
  getTilesLayer(options?: TilesLayerOptions): TilesLayer;
  setBackground(color: number): void;
  setBackgroundImage(bytes: Uint8Array, mime?: string): Promise<void>;
  setGrid(grid: GridSpec | null): void;
  /** §9 templates overlay (cone/circle/ray/rect). */
  getTemplatesLayer(): TemplatesLayer;
  /** P5/C01 (D-154) PF1e area preview overlay — caster UI in the controls holder. */
  getAreaPreviewLayer(): AreaPreviewLayer;
  /** P02/D-197 PF1e threatened-square overlay — selection UI in the controls holder. */
  getThreatOverlayLayer(): ThreatOverlayLayer;
  /** F01 — Roll-card highlight overlay — chat card UI in the controls holder, fades 1–10 s. */
  getRollHighlightLayer(): RollHighlightLayer;
  /** §9 drawings (freehand/poly/rect/text). */
  getDrawingsLayer(): DrawingsLayer;
  /** D-256 map pins (notes) — placed with the rail's Pin tool. */
  getNotesLayer(): NotesLayer;
  /** Fit the camera to a scene rect (§9 scene load). */
  fit(width: number, height: number): void;
  setCamera(camera: Camera): void;
  /**
   * Sync tactical tokens; `badges` (E06, D-147) optionally carries the condition/effect chips
   * per token id — structural {code, tint} chips so core canvas never imports a package.
   * `hpBars` (§2.2/G-10a) carries the derived hit points to draw under each token, structural
   * for the same reason. Absent (the default) draws no bar.
   */
  syncTokens(
    tokens: readonly TokenDocument[],
    badges?: ReadonlyMap<string, readonly { code: string; tint: number }[]>,
    hpBars?: ReadonlyMap<string, TokenHpBarNumbers>,
  ): void;
  /**
   * §2.2/G-10a: `"all"` draws every bar it was handed, `"hover"` draws only the bar of the token
   * under the pointer. (Whether a replica was handed bars at all is the world setting's business —
   * `tokenHpBarsMap` — not the stage's.)
   */
  setTokenHpBarMode(mode: "all" | "hover"): void;
  /** §2.2/G-10a e2e readback: the bars drawn right now, with the label text each one shows. */
  tokenHpBars(): Array<
    TokenHpBarNumbers & { id: string; label: string }
  >;
  /**
   * D-251: which token ids are drawn (null = all). Applied to the views now and to every
   * later `syncTokens`, so a token entering the replica while fog hides it never flashes.
   */
  setTokenVisibility(visible: ReadonlySet<string> | null): void;
  /** Ids of the token views actually drawn right now (sorted; e2e readback). */
  drawnTokenIds(): string[];
  /** Rubber-band selection rectangle in world coords (null clears). */
  setMarquee(
    a: { x: number; y: number } | null,
    b?: { x: number; y: number },
  ): void;
  render(): void;
  destroy(): void;
}

/**
 * E06 (D-147): condition/effect chips above a token. At most MAX_TOKEN_CHIPS render; the rest
 * fold into a "+N" chip. Chips rebuild only when the badge signature changes, so refreshes
 * (camera pan, unrelated doc updates) never churn Pixi display objects.
 */
const MAX_TOKEN_CHIPS = 3;

type BadgeChip = { code: string; tint: number };

/**
 * §2.2/G-10a (D-261): one token's bar. The numbers are derived package-side
 * (`packages/pf1e/tokenHpBars`) and reach the stage structurally, exactly as the badge chips do —
 * core canvas never imports a package.
 */
export type TokenHpBarNumbers = {
  hp: number;
  hpMax: number;
  tempHp: number;
  nonlethalDamage: number;
};

/** The child label the bar lives under, and the e2e readback walks. */
const HP_BAR_LABEL = "hpBar";

/** Green above half, amber above a quarter, red under it — the sheet's own injury bands. */
function hpBarColor(fraction: number): number {
  if (fraction > 0.5) return 0x4caf50;
  if (fraction > 0.25) return 0xffc107;
  return 0xe53935;
}

const badgeChips = new Map<string, string>();

function syncTokenBadges(
  tokenId: string,
  view: Container,
  tokenWidth: number,
  badges: readonly BadgeChip[] | undefined,
): void {
  const signature = badges?.map((b) => `${b.code}:${b.tint}`).join("|") ?? "";
  if (badgeChips.get(tokenId) === signature) return;
  badgeChips.set(tokenId, signature);
  const existing = view.getChildByLabel("badges");
  if (existing) existing.destroy({ children: true });
  if (!badges || badges.length === 0) return;
  const chips = new Container();
  chips.label = "badges";
  const shown = badges.slice(0, MAX_TOKEN_CHIPS);
  const overflow = badges.length - shown.length;
  let x = 0;
  for (const badge of shown) {
    const width = 8 + badge.code.length * 6.5;
    const bg = new Graphics();
    bg.roundRect(x, -7, width, 13, 4)
      .fill({ color: 0x14171c, alpha: 0.92 })
      .stroke({ width: 1, color: badge.tint });
    const text = new Text({
      text: badge.code,
      style: { fontSize: 9, fill: badge.tint, fontFamily: "sans-serif" },
    });
    text.anchor.set(0, 0.5);
    text.position.set(x + 4, -0.5);
    chips.addChild(bg, text);
    x += width + 3;
  }
  if (overflow > 0) {
    const more = new Text({
      text: `+${overflow}`,
      style: { fontSize: 9, fill: 0xb0b0b0, fontFamily: "sans-serif" },
    });
    more.anchor.set(0, 0.5);
    more.position.set(x + 2, -0.5);
    chips.addChild(more);
  }
  chips.x = Math.max(0, (tokenWidth - x) / 2);
  chips.y = 0;
  view.addChild(chips);
}

/** The text one bar shows: `12/20`, plus temp HP and nonlethal when they are not zero. */
function hpBarText(bar: TokenHpBarNumbers): string {
  const parts = [`${bar.hp}/${bar.hpMax}`];
  if (bar.tempHp > 0) parts.push(`+${bar.tempHp}`);
  if (bar.nonlethalDamage > 0) parts.push(`NL ${bar.nonlethalDamage}`);
  return parts.join(" ");
}

/**
 * §2.2/G-10a — draw (or drop) one token's HP bar. Rebuilt only when the numbers change, so a pan
 * or an unrelated document update never churns the display objects; the caller then applies the
 * mode's visibility (a `"hover"` bar exists but starts hidden).
 */
function syncTokenHpBar(
  tokenId: string,
  view: Container,
  tokenWidth: number,
  tokenHeight: number,
  bar: TokenHpBarNumbers | undefined,
  signatures: Map<string, string>,
): void {
  const existing = view.getChildByLabel(HP_BAR_LABEL) as Container | null;
  if (!bar) {
    if (existing) existing.destroy({ children: true });
    signatures.delete(tokenId);
    return;
  }
  const signature = hpBarText(bar);
  if (existing && signatures.get(tokenId) === signature) return;
  if (existing) existing.destroy({ children: true });
  signatures.set(tokenId, signature);

  const width = Math.max(24, tokenWidth - 8);
  const height = 5;
  const x = Math.max(0, (tokenWidth - width) / 2);
  const y = tokenHeight - height - 3;
  const fraction = (value: number) => Math.max(0, Math.min(1, value / Math.max(1, bar.hpMax)));
  const lethalWidth = Math.round(width * fraction(bar.hp));
  const tempWidth = Math.min(Math.round(width * fraction(bar.tempHp)), width - lethalWidth);
  const nonlethalWidth = Math.round(width * fraction(bar.nonlethalDamage));

  const container = new Container();
  container.label = HP_BAR_LABEL;
  const track = new Graphics();
  track
    .roundRect(x, y, width, height, 2)
    .fill({ color: 0x14171c, alpha: 0.92 })
    .stroke({ width: 1, color: 0x000000, alpha: 0.55 });
  container.addChild(track);
  if (lethalWidth > 0) {
    const lethal = new Graphics();
    lethal
      .roundRect(x, y, lethalWidth, height, 2)
      .fill({ color: hpBarColor(fraction(bar.hp)) });
    container.addChild(lethal);
  }
  if (tempWidth > 0) {
    // Temporary hit points sit *beside* the lethal fill, never on top of it (H02/D-206).
    const temp = new Graphics();
    temp.rect(x + lethalWidth, y, tempWidth, height).fill({ color: 0x64b5f6 });
    container.addChild(temp);
  }
  if (nonlethalWidth > 0) {
    // Nonlethal damage is its own thin track under the bar (CRB p.187 — it is not subtracted
    // from hit points, it is counted against them).
    const nonlethal = new Graphics();
    nonlethal
      .rect(x, y + height + 1, nonlethalWidth, 2)
      .fill({ color: 0x9ecbff, alpha: 0.9 });
    container.addChild(nonlethal);
  }
  const text = new Text({
    text: hpBarText(bar),
    style: { fontSize: 9, fill: 0xffffff, fontFamily: "sans-serif" },
  });
  text.anchor.set(0.5, 1);
  text.position.set(tokenWidth / 2, y - 1);
  container.addChild(text);
  view.addChild(container);
}

export async function createStage(options: StageOptions): Promise<Stage> {
  const app = new Application();
  await app.init({
    width: options.width,
    height: options.height,
    background: options.background ?? 0x14171c,
    antialias: true,
    autoDensity: false,
  });
  (options.hostElement ?? globalThis.document.body).appendChild(app.canvas);

  const root = new Container();
  root.label = "world";
  app.stage.addChild(root);

  // ── Background ──────────────────────────────────────────────────────────────
  const backgroundLayer = new Container();
  backgroundLayer.label = "background";
  const bgFill = new Graphics();
  backgroundLayer.addChild(bgFill);
  let bgSprite: Sprite | null = null;
  let bgTextureUrl: string | null = null;
  root.addChild(backgroundLayer);

  // ── Tiles(below) (§9 order: Background → Tiles(below) → Grid) ───────────────
  const tilesBelowLayer = new Container();
  tilesBelowLayer.label = "tilesBelow";
  root.addChild(tilesBelowLayer);

  // ── Grid ─────────────────────────────────────────────────────────────────────
  const gridLayer = new Container();
  gridLayer.label = "grid";
  const gridGraphics = new Graphics();
  gridLayer.addChild(gridGraphics);
  root.addChild(gridLayer);
  let grid: GridSpec | null = null;
  let templatesLayer: TemplatesLayerImpl | null = null;
  let drawingsLayer: DrawingsLayerImpl | null = null;
  let strategicFogLayer: StrategicFogLayerImpl | null = null;
  let hexOverlayLayer: HexOverlayLayerImpl | null = null;
  let effectsLayer: EffectsLayerImpl | null = null;
  let tilesLayer: TilesLayerImpl | null = null;
  let areaPreviewLayer: AreaPreviewLayerImpl | null = null;
  let threatOverlayLayer: ThreatOverlayLayerImpl | null = null;
  let rollHighlightLayer: RollHighlightLayerImpl | null = null;

  // ── §9 placeholders (Drawings/Templates) + Walls + Lighting ─────────────────
  const drawingsHolder = new Container();
  drawingsHolder.label = "drawings";
  root.addChild(drawingsHolder);
  const templatesHolder = new Container();
  templatesHolder.label = "templates";
  root.addChild(templatesHolder);
  const wallsHolder = new Container();
  wallsHolder.label = "walls";
  root.addChild(wallsHolder);
  let wallsLayer: WallsLayerImpl | null = null;
  const lightingHolder = new Container();
  lightingHolder.label = "lighting";
  root.addChild(lightingHolder);
  let lightingLayer: LightingLayerImpl | null = null;

  // ── §20 hexcrawl overlay (D-271): tints + cell grid under the tokens ─────────
  const hexOverlayHolder = new Container();
  hexOverlayHolder.label = "hexcrawl";
  root.addChild(hexOverlayHolder);

  // ── Tokens ──────────────────────────────────────────────────────────────────
  const tokenLayer = new Container();
  tokenLayer.label = "tokens";
  root.addChild(tokenLayer);
  const tokenViews = new Map<string, Container>();
  /** D-251: fog's token gate (null = draw every token). */
  let tokenFilter: ReadonlySet<string> | null = null;
  /** Glide targets (§9 animated movement): views lerp here each tick. */
  const tokenTargets = new Map<string, { x: number; y: number }>();
  // §2.2/G-10a — HP bars. This state is deliberately *per stage* (the badge signature cache above
  // is module-level, which two stages in one page would share); `tokenRects` is what the hover
  // hit-test walks, since the DOM pointer source does not make token bodies interactive.
  let hpBarMode: "all" | "hover" = "all";
  let hoveredTokenId: string | null = null;
  const hpBarSignatures = new Map<string, string>();
  const tokenHpBarNumbers = new Map<string, TokenHpBarNumbers>();
  const tokenRects = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();

  // ── Models (§9A: between Tokens and Tiles(above); placeholder until used) ──
  const modelsLayer = new Container();
  modelsLayer.label = "models";
  root.addChild(modelsLayer);
  let modelLayer: ModelLayerImpl | null = null;

  // ── §9 stack above models: Tiles(above)/Fog/Effects/Notes ───────────────────
  const tilesAboveLayer = new Container();
  tilesAboveLayer.label = "tilesAbove";
  root.addChild(tilesAboveLayer);
  const fogHolder = new Container();
  fogHolder.label = "fog";
  root.addChild(fogHolder);
  let fogLayer: FogLayerImpl | null = null;
  const effectsHolder = new Container();
  effectsHolder.label = "effects";
  root.addChild(effectsHolder);
  const notesHolder = new Container();
  notesHolder.label = "notes";
  root.addChild(notesHolder);
  let notesPins: NotesLayerImpl | null = null;

  // ── Controls (top) ──────────────────────────────────────────────────────────
  const controlsLayer = new Container();
  controlsLayer.label = "controls";
  const marqueeGraphics = new Graphics();
  controlsLayer.addChild(marqueeGraphics);
  root.addChild(controlsLayer);

  const state: { camera: Camera } = { camera: { x: 0, y: 0, scale: 1 } };
  const viewport: Viewport = { width: options.width, height: options.height };

  const applyCamera = (): void => {
    const cam = state.camera;
    root.scale.set(cam.scale);
    root.position.set(-cam.x * cam.scale, -cam.y * cam.scale);
  };

  /**
   * §2.2/G-10a — a `"hover"` bar is a bar the pointer is standing on. Token bodies are not
   * interactive (the DOM pointer source in `canvas/interactions` owns picking), so the stage keeps
   * the world rects it drew and hit-tests them here — topmost (last synced) wins, as on the canvas.
   */
  const tokenIdAtWorld = (world: { x: number; y: number }): string | null => {
    let hit: string | null = null;
    for (const [id, rect] of tokenRects) {
      if (
        world.x >= rect.x &&
        world.x <= rect.x + rect.width &&
        world.y >= rect.y &&
        world.y <= rect.y + rect.height
      )
        hit = id;
    }
    return hit;
  };

  const applyHpBarVisibility = (): void => {
    for (const [id, view] of tokenViews) {
      const bar = view.getChildByLabel(HP_BAR_LABEL) as Container | null;
      if (bar) bar.visible = hpBarMode === "all" || hoveredTokenId === id;
    }
  };

  const onStagePointerMove = (event: PointerEvent): void => {
    if (hpBarMode !== "hover") return;
    const box = app.canvas.getBoundingClientRect();
    const hit = tokenIdAtWorld(
      screenToWorld(
        state.camera,
        event.clientX - box.left,
        event.clientY - box.top,
      ),
    );
    if (hit === hoveredTokenId) return;
    hoveredTokenId = hit;
    applyHpBarVisibility();
    app.render();
  };

  // The hover readback is one passive listener on the stage canvas; the mode check is first so
  // an `"all"` stage pays nothing per move.
  app.canvas.addEventListener("pointermove", onStagePointerMove);

  const stage: Stage = {
    app,
    root,
    viewport,
    get camera(): Camera {
      return { ...state.camera };
    },
    setBackground(color: number): void {
      bgFill.clear().rect(0, 0, viewport.width, viewport.height).fill(color);
      if (bgSprite) bgSprite.tint = color;
    },
    async setBackgroundImage(
      bytes: Uint8Array,
      mime = "image/png",
    ): Promise<void> {
      const blob = new Blob([new Uint8Array(bytes)], { type: mime });
      const url = URL.createObjectURL(blob);
      const texture = (await Assets.load(url)) as Texture;
      if (bgTextureUrl !== null) URL.revokeObjectURL(bgTextureUrl);
      bgTextureUrl = url;
      if (bgSprite) {
        backgroundLayer.removeChild(bgSprite);
        bgSprite.destroy();
      }
      bgSprite = new Sprite(texture);
      backgroundLayer.addChildAt(bgSprite, 0);
      bgFill.clear();
    },
    setGrid(next: GridSpec | null): void {
      grid = next;
    },
    getStrategicFogLayer(): StrategicFogLayer {
      if (!strategicFogLayer) {
        strategicFogLayer = new StrategicFogLayerImpl();
        fogHolder.addChild(strategicFogLayer.container);
      }
      return strategicFogLayer;
    },
    getHexOverlayLayer(): HexOverlayLayer {
      if (!hexOverlayLayer) {
        hexOverlayLayer = new HexOverlayLayerImpl();
        hexOverlayHolder.addChild(hexOverlayLayer.container);
        // The cover goes above the tokens, at the *bottom* of the fog holder, so a scene that
        // also uses the freehand fog keeps that mask on top of it.
        fogHolder.addChildAt(hexOverlayLayer.coverContainer, 0);
      }
      return hexOverlayLayer;
    },
    peekHexOverlayLayer(): HexOverlayLayer | null {
      return hexOverlayLayer;
    },
    getEffectsLayer(): EffectsLayer {
      if (!effectsLayer) {
        effectsLayer = new EffectsLayerImpl();
        effectsLayer.container.label = "effects";
        effectsHolder.addChild(effectsLayer.container);
      }
      return effectsLayer;
    },
    getTilesLayer(options?: TilesLayerOptions): TilesLayer {
      if (!tilesLayer) {
        tilesLayer = new TilesLayerImpl(
          tilesBelowLayer,
          tilesAboveLayer,
          options ?? {},
        );
      }
      return tilesLayer;
    },
    getTemplatesLayer(): TemplatesLayer {
      if (!templatesLayer) {
        templatesLayer = new TemplatesLayerImpl();
        templatesLayer.container.visible = true;
        templatesHolder.addChild(templatesLayer.container);
      }
      return templatesLayer;
    },
    getDrawingsLayer(): DrawingsLayer {
      if (!drawingsLayer) {
        drawingsLayer = new DrawingsLayerImpl();
        drawingsHolder.addChild(drawingsLayer.container);
      }
      return drawingsLayer;
    },
    getNotesLayer(): NotesLayer {
      if (!notesPins) {
        notesPins = new NotesLayerImpl();
        notesHolder.addChild(notesPins.container);
      }
      return notesPins;
    },
    getAreaPreviewLayer(): AreaPreviewLayer {
      if (!areaPreviewLayer) {
        areaPreviewLayer = new AreaPreviewLayerImpl();
        // Caster-facing UI, not a replicated document: it rides the controls
        // holder so the §9 layer stack above tokens stays untouched.
        controlsLayer.addChild(areaPreviewLayer.container);
      }
      return areaPreviewLayer;
    },
    getThreatOverlayLayer(): ThreatOverlayLayer {
      if (!threatOverlayLayer) {
        threatOverlayLayer = new ThreatOverlayLayerImpl();
        // Selection-facing UI, not a replicated document: it rides the
        // controls holder so the §9 layer stack above tokens stays untouched.
        controlsLayer.addChild(threatOverlayLayer.container);
      }
      return threatOverlayLayer;
    },
    getRollHighlightLayer(): RollHighlightLayer {
      if (!rollHighlightLayer) {
        rollHighlightLayer = new RollHighlightLayerImpl();
        // Chat-card UI, not a replicated document: it rides the controls
        // holder so the §9 layer stack above tokens stays untouched.
        controlsLayer.addChild(rollHighlightLayer.container);
      }
      return rollHighlightLayer;
    },
    fit(width: number, height: number): void {
      state.camera = fitRect({ x: 0, y: 0, width, height }, viewport, 24);
      applyCamera();
    },
    setCamera(camera: Camera): void {
      state.camera = { ...camera };
      applyCamera();
    },
    syncTokens(
      tokens: readonly TokenDocument[],
      badges?: ReadonlyMap<string, readonly { code: string; tint: number }[]>,
      hpBars?: ReadonlyMap<string, TokenHpBarNumbers>,
    ): void {
      const seen = new Set<string>();
      for (const token of tokens) {
        seen.add(token._id);
        const rect = tokenRect(token);
        let view = tokenViews.get(token._id);
        if (!view) {
          view = new Container();
          const body = new Graphics();
          body.label = "body";
          const label = new Text({
            text: token.name,
            style: { fontSize: 12, fill: 0xffffff },
          });
          label.anchor.set(0.5);
          label.y = rect.height / 2 + 10;
          view.addChild(body, label);
          tokenLayer.addChild(view);
          tokenViews.set(token._id, view);
        }
        const jump = !tokenViews.has(token._id);
        tokenTargets.set(token._id, { x: rect.x, y: rect.y });
        tokenRects.set(token._id, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
        if (jump) view.position.set(rect.x, rect.y); // new tokens appear in place
        view.alpha = token.hidden ? 0.5 : 1;
        view.visible = tokenFilter === null || tokenFilter.has(token._id);
        const body = view.getChildByLabel("body") as Graphics | null;
        if (body) {
          body
            .clear()
            .rect(0, 0, rect.width, rect.height)
            .fill({ color: 0x2b3138, alpha: 0.9 })
            .stroke({ width: 2, color: dispositionColor(token.disposition) });
        }
        const label = view.children.find((c) => c instanceof Text) as
          Text | undefined;
        if (label && label.text !== token.name) label.text = token.name;
        syncTokenBadges(token._id, view, rect.width, badges?.get(token._id));
        const hpBar = hpBars?.get(token._id);
        if (hpBar) tokenHpBarNumbers.set(token._id, hpBar);
        else tokenHpBarNumbers.delete(token._id);
        syncTokenHpBar(
          token._id,
          view,
          rect.width,
          rect.height,
          hpBar,
          hpBarSignatures,
        );
      }
      for (const [id, view] of tokenViews) {
        if (!seen.has(id)) {
          tokenLayer.removeChild(view);
          view.destroy({ children: true });
          tokenViews.delete(id);
          tokenTargets.delete(id);
          tokenRects.delete(id);
          badgeChips.delete(id);
          hpBarSignatures.delete(id);
          tokenHpBarNumbers.delete(id);
        }
      }
      applyHpBarVisibility();
    },
    setTokenHpBarMode(mode: "all" | "hover"): void {
      hpBarMode = mode;
      hoveredTokenId = null;
      applyHpBarVisibility();
    },
    tokenHpBars(): Array<TokenHpBarNumbers & { id: string; label: string }> {
      const out: Array<TokenHpBarNumbers & { id: string; label: string }> = [];
      for (const [id, view] of tokenViews) {
        const bar = view.getChildByLabel(HP_BAR_LABEL) as Container | null;
        const numbers = tokenHpBarNumbers.get(id);
        if (!bar || !bar.visible || !view.visible || !numbers) continue;
        out.push({ id, label: hpBarText(numbers), ...numbers });
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    setTokenVisibility(visible: ReadonlySet<string> | null): void {
      tokenFilter = visible;
      for (const [id, view] of tokenViews) {
        view.visible = visible === null || visible.has(id);
      }
    },
    drawnTokenIds(): string[] {
      return [...tokenViews]
        .filter(([, view]) => view.visible)
        .map(([id]) => id)
        .sort();
    },
    getModelLayer(): ModelLayer {
      if (!modelLayer) {
        modelLayer = new ModelLayerImpl(app);
        modelsLayer.addChild(modelLayer.container);
      }
      return modelLayer;
    },
    getWallsLayer(): WallsLayer {
      if (!wallsLayer) {
        wallsLayer = new WallsLayerImpl();
        wallsHolder.addChild(wallsLayer.container);
      }
      return wallsLayer;
    },
    getLightingLayer(): LightingLayer {
      if (!lightingLayer) {
        lightingLayer = new LightingLayerImpl();
        lightingHolder.addChild(lightingLayer.container);
      }
      return lightingLayer;
    },
    getFogLayer(sceneSize): FogLayer {
      if (fogLayer) {
        if (
          Math.abs(fogLayer.coverWidth - sceneSize.width) < 1e-6 &&
          Math.abs(fogLayer.coverHeight - sceneSize.height) < 1e-6
        ) {
          return fogLayer;
        }
        fogLayer.destroy();
        fogHolder.removeChild(fogLayer.container);
        fogLayer = null;
      }
      fogLayer = new FogLayerImpl(app, sceneSize);
      fogHolder.addChild(fogLayer.container);
      return fogLayer;
    },
    hideFogLayer(): void {
      fogLayer?.setShown(false);
    },
    peekFogLayer(): FogLayer | null {
      return fogLayer;
    },
    setMarquee(a, b): void {
      marqueeGraphics.clear();
      if (!a) return;
      const rect = marqueeRect(a, b ?? a);
      marqueeGraphics
        .rect(rect.x, rect.y, rect.width, rect.height)
        .stroke({ width: 1, color: 0x53b7ff, alpha: 0.9 })
        .fill({ color: 0x53b7ff, alpha: 0.08 });
    },
    render(): void {
      app.render();
    },
    destroy(): void {
      areaPreviewLayer?.destroy();
      areaPreviewLayer = null;
      rollHighlightLayer?.destroy();
      rollHighlightLayer = null;
      threatOverlayLayer?.destroy();
      threatOverlayLayer = null;
      effectsLayer?.destroy();
      effectsLayer = null;
      tilesLayer?.destroy();
      tilesLayer = null;
      modelLayer?.destroy();
      modelLayer = null;
      strategicFogLayer?.destroy();
      strategicFogLayer = null;
      hexOverlayLayer?.destroy();
      hexOverlayLayer = null;
      templatesLayer?.destroy();
      templatesLayer = null;
      drawingsLayer?.destroy();
      drawingsLayer = null;
      wallsLayer?.destroy();
      wallsLayer = null;
      notesPins?.destroy();
      notesPins = null;
      lightingLayer?.destroy();
      lightingLayer = null;
      fogLayer?.destroy();
      fogLayer = null;
      tokenViews.clear();
      app.canvas.removeEventListener("pointermove", onStagePointerMove);
      app.destroy({ removeView: true }, { children: true });
      if (bgTextureUrl !== null) URL.revokeObjectURL(bgTextureUrl);
      bgTextureUrl = null;
    },
  };

  // initial grid pass once a camera exists
  app.ticker.add((t) => {
    effectsLayer?.tick(t.deltaMS);
    // §9 animated movement: exponential glide toward each token target
    for (const [id, view] of tokenViews) {
      const target = tokenTargets.get(id);
      if (!target) continue;
      const dx = target.x - view.position.x;
      const dy = target.y - view.position.y;
      if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) {
        view.position.set(target.x, target.y);
      } else {
        view.position.set(
          view.position.x + dx * 0.25,
          view.position.y + dy * 0.25,
        );
      }
    }
    const cam = state.camera;
    if (!grid) {
      gridGraphics.clear();
      return;
    }
    const world: Parameters<typeof squareGridLines>[1] = {
      x: cam.x,
      y: cam.y,
      width: viewport.width / cam.scale,
      height: viewport.height / cam.scale,
    };
    gridGraphics.clear();
    if (grid.type === "gridless") return;
    if (grid.type === "hex") {
      gridGraphics.setStrokeStyle({
        width: 1 / cam.scale,
        color: 0x5c6672,
        alpha: 0.35,
      });
      const hexes = hexesInView(grid, world);
      for (const hex of hexes) {
        const center = hexCenter(grid, hex.q, hex.r);
        const corners = hexCorners(grid, center);
        const first = corners[0];
        if (!first) continue;
        gridGraphics.moveTo(first.x, first.y);
        for (let i = 1; i < corners.length; i++) {
          const c = corners[i];
          if (c) gridGraphics.lineTo(c.x, c.y);
        }
        gridGraphics.closePath();
      }
      gridGraphics.stroke();
      return;
    }
    const square: SquareGrid = grid;
    const lines = squareGridLines(square, world);
    gridGraphics.setStrokeStyle({
      width: 1 / cam.scale,
      color: 0x5c6672,
      alpha: 0.35,
    });
    const y0 = world.y - 1 / cam.scale;
    const y1 = world.y + world.height + 1 / cam.scale;
    for (const x of lines.verticals) gridGraphics.moveTo(x, y0).lineTo(x, y1);
    const x0 = world.x - 1 / cam.scale;
    const x1 = world.x + world.width + 1 / cam.scale;
    for (const y of lines.horizontals) gridGraphics.moveTo(x0, y).lineTo(x1, y);
    gridGraphics.stroke();
  });

  stage.setBackground(options.background ?? 0x14171c);
  applyCamera();
  return stage;
}
