/**
 * §4 Data model: Documents, collections, embedded collections, ownership.
 * Documents are plain JSON; every field below `system` is part of the shared
 * Foundry-style shape, `system` holds RulesModule/system-package data.
 */
import type { AssetId, DocId, UserId } from "./ids";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Ownership levels: NONE / LIMITED / OBSERVER / OWNER (§4). */
export const OWNERSHIP_LEVELS = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } as const;
export type OwnershipLevel = 0 | 1 | 2 | 3;

/** `ownership: { default: 0..3, [userId]: 0..3 }` (§4). */
export interface Ownership {
  default: OwnershipLevel;
  [userId: string]: OwnershipLevel;
}

/** Roles (§4): GM, ASSISTANT, TRUSTED, PLAYER. */
export type Role = "GM" | "ASSISTANT" | "TRUSTED" | "PLAYER";

/** `flags: { "<scope>": { key: value } }` — e.g. flags.core.scale = "tactical" (§9A). */
export interface FlagStore {
  [scope: string]: Record<string, Json>;
}

/** Common shape of every Document, embedded or top-level (§4). */
export interface BaseDocument {
  _id: DocId;
  /** Document subtype within its collection (system-defined, e.g. "character", "infantry"). */
  type: string;
  name: string;
  ownership: Ownership;
  flags: FlagStore;
  system: Record<string, Json>;
}

/** Reference to a document, possibly embedded via a parent chain (§4, D-012). */
export interface DocRef {
  coll: AnyCollectionName;
  id: DocId;
  parent?: DocRef;
}

// ─── Embedded document shapes (§4) ────────────────────────────────────────────

export interface TokenLight {
  radius: number;
  color: string;
  alpha: number;
}

export interface TokenDocument extends BaseDocument {
  type: "token";
  x: number;
  y: number;
  rotation: number;
  width: number;
  height: number;
  /** Asset hash or external URL (§7 allows both). */
  img: string;
  actorId?: DocId;
  hidden: boolean;
  disposition: "hostile" | "neutral" | "friendly";
  vision: boolean;
  light: TokenLight;
}

/**
 * Wall segment (§9). Restriction codes per axis: 0 = blocks, 1 = conditional
 * (door state applies), 2 = permits (DECISIONS D-009).
 */
export interface WallDocument extends BaseDocument {
  type: "wall";
  /** [x1, y1, x2, y2]. */
  c: [number, number, number, number];
  door: 0 | 1 | 2;
  oneWay: boolean;
  move: 0 | 1 | 2;
  sight: 0 | 1 | 2;
  sound: 0 | 1 | 2;
  light: 0 | 1 | 2;
}

export interface LightDocument extends BaseDocument {
  type: "light";
  x: number;
  y: number;
  dim: number;
  bright: number;
  color: string;
  alpha: number;
}

export interface SoundDocument extends BaseDocument {
  type: "sound";
  x: number;
  y: number;
  radius: number;
  /** Asset hash or external URL. */
  audio: string;
  volume: number;
  loop: boolean;
}

export interface TileDocument extends BaseDocument {
  type: "tile";
  x: number;
  y: number;
  width: number;
  height: number;
  img: string;
  above: boolean;
  occlusion: { mode: "roof" | "fade"; alpha: number };
}

export interface DrawingDocument extends BaseDocument {
  type: "drawing";
  kind: "freehand" | "poly" | "rect" | "text";
  /** Flat point list [x1,y1,x2,y2,...] for freehand/poly. */
  points: number[];
  /** Bounding box [x,y,w,h] for rect/text. */
  box: [number, number, number, number] | null;
  stroke: string;
  fill: string;
  strokeWidth: number;
  text: string | null;
}

export interface TemplateDocument extends BaseDocument {
  type: "template";
  kind: "cone" | "circle" | "ray" | "rect";
  x: number;
  y: number;
  distance: number;
  direction: number;
  width: number;
}

export interface NoteDocument extends BaseDocument {
  type: "note";
  x: number;
  y: number;
  text: string;
  icon: string;
  /** §9A: strategic scenes link to tactical scenes via notes with linkedSceneId. */
  linkedSceneId?: DocId;
}

export interface EffectDocument extends BaseDocument {
  type: "effect";
  changes: Array<{ path: string; value: Json }>;
  disabled: boolean;
}

export interface ItemDocument extends BaseDocument {
  type: "item";
  effects: EffectDocument[];
}

export interface ActorDocument extends BaseDocument {
  type: "actor";
  items: ItemDocument[];
  effects: EffectDocument[];
}

export interface JournalPageDocument extends BaseDocument {
  type: "page";
  /** Markdown; `<secret>` blocks are stripped for non-GM by projection (§5). */
  text: string;
  src: string | null;
}

export interface JournalDocument extends BaseDocument {
  type: "journal";
  pages: JournalPageDocument[];
}

export interface RollTableResult {
  range: [number, number];
  text: string;
  documentRef: DocRef | null;
}

export interface RollTableDocument extends BaseDocument {
  type: "rollTable";
  formula: string;
  results: RollTableResult[];
}

export interface PlaylistSoundDocument extends BaseDocument {
  type: "playlistSound";
  audio: string;
  volume: number;
  loop: boolean;
}

export interface PlaylistDocument extends BaseDocument {
  type: "playlist";
  mode: string;
  sounds: PlaylistSoundDocument[];
}

export interface CombatantDocument extends BaseDocument {
  type: "combatant";
  tokenId: DocId | null;
  actorId: DocId | null;
  initiative: number | null;
  hidden: boolean;
  defeated: boolean;
}

export interface CombatDocument extends BaseDocument {
  type: "combat";
  round: number;
  turn: number;
  combatants: CombatantDocument[];
}

export interface MacroDocument extends BaseDocument {
  type: "macro";
  kind: "chat" | "script";
  command: string;
}

export interface CardEntry {
  name: string;
  img: string;
}

export interface CardDocument extends BaseDocument {
  type: "cards";
  cards: CardEntry[];
}

/** Record of a resolved roll, embedded in chat messages (§11). */
export interface RollRecord {
  formula: string;
  total: number;
  /** Evaluated terms (dice pools with kept/exploded values, math). */
  terms: Json[];
  /** Present in commit-reveal mode (M3): both seeds, hex. */
  seedClient: string | null;
  seedHost: string | null;
  /** §11: SHA-256(seedClient) hex recorded with the roll (audit). */
  commit?: string | null;
}

/** Roll visibility mode (§10/§11): who may see the result of a chat roll. */
export type RollMode = "roll" | "gmroll" | "blindroll" | "selfroll";

export interface MessageDocument extends BaseDocument {
  type: "message";
  author: UserId;
  content: string;
  /** Whisper recipients (§10); empty = public. */
  whisper: UserId[];
  roll: RollRecord | null;
  /** Visibility of `roll` (§5 projection: GM-only roll results stripped). */
  rollMode?: RollMode;
  flavor: string;
}

export interface UserDocument extends BaseDocument {
  type: "user";
  role: Role;
  character: DocId | null;
  color: string;
}

export interface FolderDocument extends BaseDocument {
  type: "folder";
  parent: DocId | null;
  targetType: CollectionName;
}

export type HexLayout = "evenQ" | "oddQ" | "evenR" | "oddR";

export interface SceneGrid {
  type: "square" | "hex" | "gridless";
  /** Grid cell size in pixels. */
  size: number;
  /** Distance of one cell in `units`. */
  distance: number;
  units: string;
  /** Diagonal measurement rule, pluggable by system (§9): 555 / 5105 / euclidean. */
  diagonals: "555" | "5105" | "euclidean";
  /** Hex orientation — 4 layouts (§9). */
  hexLayout: HexLayout;
}

export interface SceneDocument extends BaseDocument {
  type: "scene";
  active: boolean;
  /** Background image — asset hash or external URL. */
  img: string | null;
  width: number;
  height: number;
  grid: SceneGrid;
  darkness: number;
  /** flags.core.scale: "tactical" | "strategic" selects §9A behaviour. */
  tokens: TokenDocument[];
  walls: WallDocument[];
  lights: LightDocument[];
  sounds: SoundDocument[];
  tiles: TileDocument[];
  drawings: DrawingDocument[];
  templates: TemplateDocument[];
  notes: NoteDocument[];
}

export interface SettingsDocument extends BaseDocument {
  type: "settings";
}

export interface CompendiumIndexEntry {
  id: DocId;
  name: string;
  type: string;
}

/** Compendia: read-only, lazy packs stored as hash-addressed assets (§12). */
export interface CompendiumDocument extends BaseDocument {
  type: "compendium";
  label: string;
  packAsset: AssetId;
  index: CompendiumIndexEntry[];
}

/** A derived image variant (thumbnail / mid-res), itself hash-addressed (§7). */
export interface AssetVariant {
  assetId: AssetId;
  width: number;
  height: number;
}

/** Tile descriptor for maps > 4096 px on a side (§7); ids are row-major. */
export interface AssetTiles {
  size: number;
  cols: number;
  rows: number;
  ids: AssetId[];
}

/** assetManifest entry: hash → { name, mime, size, chunks } + image variants (§4, §7). */
export interface AssetManifestEntry {
  name: string;
  mime: string;
  size: number;
  chunks: number;
  /** Intrinsic pixel dimensions (present on image assets after import). */
  width?: number;
  height?: number;
  /** ≤ 256 px preview, WebP (D-042). */
  thumb?: AssetVariant;
  /** Mid-res WebP, ≤ 1024 px (D-042). */
  mid?: AssetVariant;
  /** Present when the map exceeded 4096 px on a side (§7). */
  tiles?: AssetTiles;
}

export type AssetManifest = Record<AssetId, AssetManifestEntry>;

// ─── Top-level collections (§4; strategic collections of §4A included) ─────────

export type CollectionName =
  | "users"
  | "folders"
  | "scenes"
  | "actors"
  | "items"
  | "journals"
  | "rollTables"
  | "playlists"
  | "macros"
  | "cards"
  | "combats"
  | "messages"
  | "settings"
  | "compendia"
  | "factions"
  | "armies"
  | "turns"
  | "depots"
  | "routes"
  | "reinforcements";

/** Every top-level collection, in canonical order (indexes IDB `documents` too, §8). */
export const TOP_LEVEL_COLLECTIONS: readonly CollectionName[] = [
  "users",
  "folders",
  "scenes",
  "actors",
  "items",
  "journals",
  "rollTables",
  "playlists",
  "macros",
  "cards",
  "combats",
  "messages",
  "settings",
  "compendia",
  "factions",
  "armies",
  "turns",
  "depots",
  "routes",
  "reinforcements",
];

/**
 * Embedded collection names (§4) — addressed via a DocRef whose `parent` chain
 * ends at a top-level collection (D-012). `units` embeds in armies (§4A).
 */
export type EmbeddedCollectionName =
  | "tokens"
  | "walls"
  | "lights"
  | "sounds"
  | "tiles"
  | "drawings"
  | "templates"
  | "notes"
  | "items"
  | "effects"
  | "pages"
  | "combatants"
  | "units";

/** Op/store addressing space: top-level or embedded collections. */
export type AnyCollectionName = CollectionName | EmbeddedCollectionName;

/** The whole world as top-level collections. */
export interface WorldCollections {
  users: UserDocument[];
  folders: FolderDocument[];
  scenes: SceneDocument[];
  actors: ActorDocument[];
  items: ItemDocument[];
  journals: JournalDocument[];
  rollTables: RollTableDocument[];
  playlists: PlaylistDocument[];
  macros: MacroDocument[];
  cards: CardDocument[];
  combats: CombatDocument[];
  /** Capped / paginated (§4); trims oldest-first, deterministically (D-018). */
  messages: MessageDocument[];
  settings: SettingsDocument[];
  compendia: CompendiumDocument[];
  factions: import("./strategic").FactionDocument[];
  armies: import("./strategic").ArmyDocument[];
  turns: import("./strategic").TurnDocument[];
  depots: import("./logistics").DepotDocument[];
  routes: import("./logistics").RouteDocument[];
  reinforcements: import("./logistics").ReinforcementDocument[];
  /** Maintained by the host AssetServer, not an Op target (D-015). */
  assetManifest: AssetManifest;
}
