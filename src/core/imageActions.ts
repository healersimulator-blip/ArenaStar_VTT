/** Pure document-intent planner for image destinations. Asset bytes are uploaded separately. */
import {
  OWNERSHIP_LEVELS,
  type JournalDocument,
  type JournalPageDocument,
  type SceneDocument,
  type SceneGrid,
  type TileDocument,
} from "./documents";
import type { FlatDiff, Op } from "./ops";
import type { ImageAction, SceneExpressDefaults } from "./imageHandling";
import {
  fitTileToScene,
  rescaleScenePlaceables,
  sceneSizeFromImage,
  tileAtAssetGridSize,
  tileAtNaturalSize,
  type SceneSize,
} from "./imageSizing";

export interface ImageActionPlanInput {
  action: ImageAction;
  image: string;
  name: string;
  width: number;
  height: number;
  scene: SceneDocument | null;
  scenes: readonly SceneDocument[];
  journals: readonly JournalDocument[];
  selectedTokenIds: readonly string[];
  sceneDefaults: SceneExpressDefaults;
  newSceneId: string;
  newTileId: string;
  newJournalId: string;
  newPageId: string;
  targetJournalId: string;
  autoCreateJournal: boolean;
  autoCreateJournalName: string;
  logicalFolder: string;
  thumbnail: string | null;
  background: {
    offset: { x: number; y: number };
    scale: number;
    padding: number;
    color: string;
  };
  sceneSize: SceneSize;
  resizeChoice: "keep" | "rescale";
  grid: SceneGrid;
  assetGridSize: number;
  foregroundElevation: number;
  activateNewScene: boolean;
}

export interface ImageActionPlan {
  ops: Op[];
  focusSceneId: string | null;
}

/** Build one HostSync batch; callers must separately store/share the asset when needed. */
export function planImageAction(input: ImageActionPlanInput): ImageActionPlan {
  const size = sceneSizeFromImage({ width: input.width, height: input.height });
  switch (input.action) {
    case "preview":
    case "showPlayers":
      return { ops: [], focusSceneId: null };
    case "newScene": {
      const defaults = input.sceneDefaults;
      const active = input.activateNewScene || defaults.activateImmediately;
      const scene: SceneDocument = {
        _id: input.newSceneId,
        type: "scene",
        name: input.name,
        ownership: { default: defaults.ownership === "all" ? OWNERSHIP_LEVELS.LIMITED : OWNERSHIP_LEVELS.NONE },
        flags: { core: { fog: defaults.fogExploration, tokenVision: defaults.tokenVision } },
        system: {},
        active,
        img: input.image,
        width: input.sceneSize.width,
        height: input.sceneSize.height,
        grid: { ...input.grid },
        darkness: 0,
        background: { ...input.background, offset: { ...input.background.offset } },
        thumbnail: input.thumbnail,
        logicalFolder: input.logicalFolder,
        navigation: defaults.navigation,
        tokenVision: defaults.tokenVision,
        fogExploration: defaults.fogExploration,
        tokens: [], walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
      };
      const ops: Op[] = [];
      if (active) {
        for (const existing of input.scenes) {
          if (existing.active) ops.push({ kind: "update", ref: { coll: "scenes", id: existing._id }, diff: { active: false } });
        }
      }
      ops.push({ kind: "create", coll: "scenes", data: scene });
      return { ops, focusSceneId: scene._id };
    }
    case "replaceBackground": {
      const scene = requireScene(input.scene, input.action);
      const resized = input.resizeChoice === "rescale"
        ? rescaleScenePlaceables(scene, input.sceneSize.width, input.sceneSize.height)
        : null;
      const diff: Record<string, unknown> = {
        img: input.image,
        width: input.sceneSize.width,
        height: input.sceneSize.height,
        thumbnail: input.thumbnail,
        background: { ...input.background, offset: { ...input.background.offset } },
      };
      if (resized) {
        diff.tokens = resized.tokens;
        diff.walls = resized.walls;
        diff.lights = resized.lights;
        diff.sounds = resized.sounds;
        diff.tiles = resized.tiles;
        diff.drawings = resized.drawings;
        diff.templates = resized.templates;
        diff.notes = resized.notes;
        if (resized.cells) diff.cells = resized.cells;
        if (resized.regions) diff.regions = resized.regions;
      }
      return { ops: [{ kind: "update", ref: { coll: "scenes", id: scene._id }, diff: diff as unknown as FlatDiff }], focusSceneId: scene._id };
    }
    case "replaceForeground": {
      const scene = requireScene(input.scene, input.action);
      return {
        ops: [{ kind: "update", ref: { coll: "scenes", id: scene._id }, diff: {
          foreground: { img: input.image, elevation: input.foregroundElevation },
        } }],
        focusSceneId: scene._id,
      };
    }
    case "tileNatural":
    case "tileFit":
    case "tileGrid": {
      const scene = requireScene(input.scene, input.action);
      const imageSize = { width: size.width, height: size.height };
      const sceneSize = { width: scene.width, height: scene.height };
      const placement = input.action === "tileNatural"
        ? tileAtNaturalSize(imageSize, sceneSize)
        : input.action === "tileFit"
          ? fitTileToScene(imageSize, sceneSize)
          : tileAtAssetGridSize(imageSize, input.assetGridSize, scene.grid.size, sceneSize);
      const tile: TileDocument = {
        _id: input.newTileId,
        type: "tile",
        name: input.name,
        ownership: { default: OWNERSHIP_LEVELS.NONE },
        flags: {},
        system: {},
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
        img: input.image,
        ...(input.action === "tileGrid" ? { assetGridSize: input.assetGridSize } : {}),
        above: false,
        occlusion: { mode: "roof", alpha: 0.5 },
      };
      return { ops: [{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: scene._id }, data: tile }], focusSceneId: scene._id };
    }
    case "journalPage": {
      const page: JournalPageDocument = {
        _id: input.newPageId,
        type: "page",
        name: input.name,
        ownership: { default: OWNERSHIP_LEVELS.LIMITED },
        flags: {},
        system: {},
        text: "",
        src: input.image,
      };
      const journal = input.journals.find((entry) => entry._id === input.targetJournalId);
      if (journal) {
        return {
          ops: [{ kind: "update", ref: { coll: "journals", id: journal._id }, diff: { pages: [...journal.pages, page] } as unknown as FlatDiff }],
          focusSceneId: null,
        };
      }
      if (!input.autoCreateJournal) throw new Error("Choose a target journal or enable Auto-Create Journal");
      const created: JournalDocument = {
        _id: input.newJournalId,
        type: "journal",
        name: input.autoCreateJournalName.trim() || "mini-uploader",
        ownership: { default: OWNERSHIP_LEVELS.LIMITED },
        flags: {},
        system: {},
        pages: [page],
      };
      return { ops: [{ kind: "create", coll: "journals", data: created }], focusSceneId: null };
    }
    case "tokenArt": {
      const scene = requireScene(input.scene, input.action);
      const ids = new Set(input.selectedTokenIds);
      if (ids.size === 0) throw new Error("Select one or more tokens first");
      const tokens = scene.tokens.map((token) => ids.has(token._id) ? { ...token, img: input.image } : token);
      if (![...ids].every((id) => scene.tokens.some((token) => token._id === id)))
        throw new Error("One or more selected tokens are no longer in this scene");
      return { ops: [{ kind: "update", ref: { coll: "scenes", id: scene._id }, diff: { tokens } as unknown as FlatDiff }], focusSceneId: scene._id };
    }
  }
}

function requireScene(scene: SceneDocument | null, action: ImageAction): SceneDocument {
  if (!scene) throw new Error(`“${actionLabel(action)}” needs an active scene`);
  return scene;
}

function actionLabel(action: ImageAction): string {
  switch (action) {
    case "replaceBackground": return "Replace background";
    case "replaceForeground": return "Replace foreground";
    case "tileNatural": return "Tile at natural size";
    case "tileFit": return "Fit tile to scene";
    case "tileGrid": return "Tile at Asset Grid Size";
    case "tokenArt": return "Token artwork";
    default: return action;
  }
}
