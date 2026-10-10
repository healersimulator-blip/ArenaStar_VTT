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
  /** Tagger-style placeable labels. Distinct from encounter-table activation `tags`. */
  taggerTags?: string[];
}

/** Reference to a document, possibly embedded via a parent chain (§4, D-012). */
export interface DocRef {
  coll: AnyCollectionName;
  id: DocId;
  parent?: DocRef;
}

// ─── Embedded document shapes (§4) ────────────────────────────────────────────

export interface TokenLight {
  /** The dim (outer) radius, in scene pixels. `0` = the token carries no light. */
  radius: number;
  /** The bright (fully lit) radius; absent = half the dim radius, as the rail's tool writes it. */
  bright?: number;
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
  /** Vertical position in scene grid units; omitted legacy tokens are at zero. */
  elevation?: number;
  /** Asset hash or external URL (§7 allows both). */
  img: string;
  actorId?: DocId;
  hidden: boolean;
  disposition: "hostile" | "neutral" | "friendly";
  vision: boolean;
  light: TokenLight;
  /**
   * §9 vision bounded by light (plan §2.1): normal sight range in **feet**, absent/0 =
   * unlimited (the scene's fog range and diagonal still cap it). Authored in feet because a
   * stat block says "60 ft.", converted through `grid.distance`/`grid.size` for the math.
   */
  sight?: number | null;
  /** Darkvision range in feet; absent = none. Sees in total darkness within its range. */
  darkvision?: number;
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

/** A conditional-axis wall is a door; ordinary walls/windows must never be opened by a trigger. */
export function isDoorWall(w: Pick<WallDocument, "sight" | "move" | "sound" | "light">): boolean {
  return w.sight === 1 || w.move === 1 || w.sound === 1 || w.light === 1;
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

export interface RegionDocument extends BaseDocument {
  type: "region";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise about the region's center. */
  rotation?: number;
  /** Convex polygon in normalized, region-local coordinates. */
  shape: { kind: "polygon"; points: Array<[number, number]> };
  /** GM-only regions are retained in the host scene but omitted from player replicas. */
  hidden?: boolean;
  /** Inclusive active vertical band in scene grid units. */
  triggerElevation?: { min: number; max: number };
  sort?: number;
}

export interface TileDocument extends BaseDocument {
  type: "tile";
  /** GM-only tile until explicitly revealed; legacy tiles without this field remain visible. */
  hidden?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  img: string;
  /** Degrees clockwise about tile center; legacy tiles default to zero. */
  rotation?: number;
  /** Optional trigger priority/z-sort; ties default to zero and then tile ID. */
  sort?: number;
  /** The image's authored pixels per grid square when placed from Asset Grid Size. */
  assetGridSize?: number;
  /** Optional convex tile-local trigger polygon; absent preserves the rectangular trigger shape. */
  triggerZone?: import("./tileTriggerZone").TileTriggerZone;
  /** Inclusive active vertical band in scene grid units; absent has no elevation restriction. */
  triggerElevation?: { min: number; max: number };
  above: boolean;
  occlusion: { mode: "roof" | "fade"; alpha: number };
}

export interface DrawingDocument extends BaseDocument {
  type: "drawing";
  /**
   * §10 tool shapes: freehand, poly (closed polygon), line (open 2-point segment),
   * rect and ellipse (both from `box`), text.
   */
  kind: "freehand" | "poly" | "rect" | "ellipse" | "line" | "text";
  /** Flat point list [x1,y1,x2,y2,...] for freehand/poly/line. */
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
  /** The GM's note text (D-256: map pins call it the GM tooltip). */
  text: string;
  icon: string;
  /** §9A: strategic scenes link to tactical scenes via notes with linkedSceneId. */
  linkedSceneId?: DocId;
  /**
   * D-256 map pins: what a *player* reads in the tooltip. Roll20 keeps player and GM notes
   * separate on a pin, and a pin is hidden until the GM toggles visibility. The flag below is
   * the gate the projection layer (§5) reads; `ownership.default` is kept in step with it
   * (LIMITED when visible) so the permission engine and the ownership ledger agree.
   */
  playerText?: string;
  /** The handout this pin opens on double-click (§10 window host, kind "journal"). */
  journalId?: DocId;
  /** GM-side visibility state (mirrors the ownership default; players never see false). */
  visible?: boolean;
}

/**
 * A hidden feature of a cell (hexcrawl, D-269) — the shrine nobody has found yet.
 *
 * The reveal *rule* is data and the reveal *state* is a document field, which is what lets one
 * replica decide ("the party spent four hours here") and every replica agree afterwards. The
 * rule kinds are the ones a hexcrawl table asks for: the GM's own checkbox, a Perception DC, a
 * stretch of time spent in the cell, or a dice check. `autoReveal` decides who flips the state:
 * the client that evaluated the rule, or the GM in the hex window.
 *
 * **Projection is the gate, not the drawing** (D-256's lesson for pins): a feature whose
 * `state.revealed` is false must be stripped from the cell document for every non-GM viewer, or
 * the art it points at is readable from the asset manifest no matter what the canvas draws.
 */
export type CellFeatureReveal =
  | { kind: "manual" }
  | {
      kind: "perception";
      dc: number;
      /**
       * D-275: true = roll `1d20 + the party's Perception` against `dc` (an *active* check);
       * absent = the party's passive Perception is the number compared (plan §9.5's default).
       */
      active?: boolean;
    }
  | { kind: "time"; seconds: number }
  | { kind: "dice"; formula: string; target: number };

export interface CellFeature {
  id: string;
  name: string;
  text: string;
  /** Asset hash or external URL (§7 allows both); absent = a text-only feature. */
  img?: string;
  reveal: CellFeatureReveal;
  /** True = the client that evaluates the rule flips the state; false = the GM's checkbox does. */
  autoReveal: boolean;
  state: {
    revealed: boolean;
    /** World clock reading when it was revealed (audit; absent while hidden). */
    atClock?: number;
    by?: UserId;
  };
}

/**
 * One authored cell of a hexcrawl scene (D-269) — a hex, a square, or (on a gridless map) a
 * drawn **zone**. Embedded in its scene, exactly like `walls`/`notes` (D-012), so ownership
 * cascade, projection, the op log and the world file all apply with no new machinery.
 *
 * Cells are *sparse*: only the ones a GM authored exist, and a cell with no document reads as
 * "unexplored, the scene's default terrain". `key` is `q,r` for hex and square grids and the
 * zone's own id for gridless scenes.
 */
export interface CellDocument extends BaseDocument {
  type: "cell";
  key: string;
  /** Zone geometry, flat `[x1,y1,…]` (gridless scenes only); absent for gridded cells. */
  poly?: number[];
  /** Terrain catalog id (world-scoped; see `core/hexcrawl/terrain.ts`). */
  terrain?: string;
  /** The GM's text: what is *actually* here. */
  description?: string;
  /** What players read once the GM opens the cell; never sent for a closed cell. */
  playerText?: string;
  /** Encounter table ids attached to this cell (`encounterTables`). */
  tables?: string[];
  /**
   * Campaign Codex entries (journal ids with a `codex` sheet) this hex is about: a town, a lair's
   * NPC, a region. GM-side context only: a player's replica never receives this list, in the same
   * way it never receives `description`.
   */
  codexEntries?: string[];
  features?: CellFeature[];
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

/** Actor token defaults that are not themselves a scene placeable. Tagger reads and writes
 * `taggerTags` here, then token creation copies the tags onto the placed token document. */
export interface TokenPrototypeData {
  taggerTags?: string[];
  flags?: FlagStore;
  [key: string]: Json | undefined;
}

export interface ActorDocument extends BaseDocument {
  type: "actor";
  items: ItemDocument[];
  effects: EffectDocument[];
  /** Defaults for tokens created from this actor; optional on older/imported documents. */
  prototypeToken?: TokenPrototypeData;
}

export type CodexSheetKind = "group" | "region" | "location" | "entry" | "npc" | "tag";

export type CodexRelation =
  | "contains"
  | "locatedAt"
  | "associatedWith"
  | "operatedBy"
  | "representsActor"
  | "linksScene"
  | "linksItem"
  | "relatedTo";

/** Audience rules only narrow access already granted by the parent document. */
export type CodexAudience =
  | { kind: "inherit" }
  | { kind: "gmOnly" }
  | { kind: "selectedUsers"; userIds: UserId[] };

export interface CodexTabConfig {
  key: string;
  label: string;
  order: number;
  audience?: CodexAudience;
}

export interface CodexLink {
  id: string;
  relation: CodexRelation;
  target: DocRef;
  label?: string;
  audience?: CodexAudience;
}

export interface CodexObjective {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  audience?: CodexAudience;
  order: number;
  children: CodexObjective[];
}

export interface CodexQuest {
  id: string;
  title: string;
  description: string;
  state: "active" | "completed" | "failed";
  pinned: boolean;
  audience?: CodexAudience;
  order: number;
  objectives: CodexObjective[];
}

/** Declarative widget data only; imported configs never execute code. */
export interface CodexWidgetInstance {
  id: string;
  type: string;
  version: number;
  tab: string;
  order: number;
  enabled: boolean;
  audience?: CodexAudience;
  config: Json;
}

export interface CodexShopStockRow {
  id: string;
  item: DocRef;
  quantity: number | null;
  unitPrice?: string;
  order: number;
}

export interface CodexShopConfig {
  mode: "shop" | "loot";
  audience?: CodexAudience;
  markup?: number;
  currencyLabel?: string;
  stock: CodexShopStockRow[];
}

export interface CodexSheet {
  /** Codex metadata version, independent from the World ZIP format. */
  version: number;
  kind: CodexSheetKind;
  subtitle?: string;
  /** ArenaStar asset hash/reference; never an instruction to fetch a remote URL. */
  cover?: string;
  tabs?: CodexTabConfig[];
  links: CodexLink[];
  widgets: CodexWidgetInstance[];
  quests?: CodexQuest[];
  shop?: CodexShopConfig;
}

export interface CodexPageMetadata {
  tabKey?: string;
  label?: string;
  order?: number;
  audience?: CodexAudience;
}

export interface JournalPageDocument extends BaseDocument {
  type: "page";
  /** Markdown; `<secret>` blocks are stripped for non-GM by projection (§5). */
  text: string;
  src: string | null;
  /** Optional Codex presentation/audience metadata; absent on ordinary pages. */
  codex?: CodexPageMetadata;
}

export interface JournalDocument extends BaseDocument {
  type: "journal";
  pages: JournalPageDocument[];
  /** Optional Campaign Codex metadata; absent on ordinary journals. */
  codex?: CodexSheet;
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

/**
 * What an encounter table's activation tags and the roll itself need (hexcrawl, D-269).
 *
 * `day`/`night` are the clock phase (`core/clock.ts` `phaseOf`); the other four are *triggers*:
 * the party entered the cell, is moving through it, spent time exploring it, or a fight started
 * on it. **Every tag defaults to true**, so a freshly created table fires on everything until
 * the GM narrows it — the requirement's "by default all this tag should be ON", and the reason
 * `encounterTagsOf` exists rather than callers reading the bag directly.
 */
export interface EncounterTags {
  day: boolean;
  night: boolean;
  entering: boolean;
  moving: boolean;
  exploring: boolean;
  fighting: boolean;
}

/** A rolled encounter's link to something the world already holds. */
export type EncounterRef =
  | { kind: "compendium"; packId: string; entryId: string }
  | { kind: "actor"; actorId: DocId };

/** One row of an encounter table: its weight (or range), its text, and what it points at. */
export interface EncounterEntry {
  /** Weighted tables: any positive integer (normalised to 100 by `weightsToRanges`). */
  weight: number;
  /** Dice tables: inclusive `[lo, hi]`, validated by `validateEncounterTable`. */
  range?: [number, number];
  /** What the GM reads — "Goblin bandits", "A merchant caravan, wary". */
  text: string;
  /** How many of each ref to place (`goblin warrior ×2` = 2). */
  count: number;
  /** Empty = pure text (nothing to place on the map). */
  refs: EncounterRef[];
}

/**
 * A random-encounter table (hexcrawl, D-269). Top-level collection, because a table outlives
 * any one cell and several cells attach the same one.
 *
 * Two roll types, one storage shape: `"dice"` keeps the GM's own formula (`1d20`, `2d6+1`) and
 * uses each entry's `range`; `"weighted"` uses the percentage ladder compiled from the entries'
 * `weight` fields and rolls `1d100` (the attached generator's model). Both draw through the
 * dice engine, so an encounter roll is as auditable as a chat roll.
 */
export interface EncounterTableDocument extends BaseDocument {
  type: "encounterTable";
  mode: "dice" | "weighted";
  /** Dice mode only; weighted tables roll `1d100` at draw time. */
  formula: string;
  entries: EncounterEntry[];
  tags: EncounterTags;
  /** A battle scene to copy when the encounter resolves (requirement 5d). */
  sceneId?: DocId;
  /** Seconds before this table may fire again in the same cell; absent = one phase (§ encounter.ts). */
  cooldownSeconds?: number;
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
  kind: "chat" | "script" | "sequence" | "summon" | "fxPreset" | "automation" | "composite";
  command: string;
  /** D-394: host-stamped original player draft; owner-only, never GM executable source. */
  playerAuthoring?: import("./playerMacros").PlayerMacroAuthoring;
  /** TR-12/MC-01 (D-381): a GM-authored reference to one saved graph. The binding is
   * private state — players receive the macro as a callable entry, never this id. */
  automation?: import("./macroAutomation").MacroAutomationBinding
    | import("./macroAutomation").MacroAutomationPublic;
  /** MC-01 (D-386): an ordered list of automation macros this composite runs.
   * GM-only state, stripped for every non-GM copy exactly like `automation`. */
  composite?: import("./macroComposite").MacroCompositeBinding;
  /** GM-published summoning preset. Player projection keeps only callable metadata. */
  summon?: import("./summons").SummonDefinition | import("./summons").SummonPublic;
  /**
   * D-311: the item this timeline is bound to. It is stored **here**, on the timeline
   * rather than on the item, so the ordinary macro projection decides who may discover the
   * binding — the item side needs no rule of its own.
   */
  fxItem?: import("./fxBinding").FxItemBinding;
  /**
   * D-407: the spell this timeline is bound to, by stable normalized name key (while preserving
   * legacy tactical-effect ids). Stored on the timeline for the same reason `fxItem` is — the
   * ordinary macro projection decides who may
   * discover the binding, and a spell row is not an item document to hang it on.
   */
  fxSpell?: import("./fxBinding").FxSpellBinding;
  /** D-310: a named bundle of authored FX sections — an authoring aid, never runnable. */
  preset?: import("./fxPresets").FxPresetDefinition;
  /** A versioned, multi-section audiovisual timeline; legacy macros omit it. */
  sequence?: import("./fx").FxSequence;
  /** GM-reviewed JS source/policy. Legacy scripts without approval cannot execute. */
  script?: import("./scriptMacros").ScriptPolicy;
  /** Host-owned durable invocation deduplication; projected away for players. */
  scriptState?: import("./scriptMacros").ScriptHistory;
}

/** GM-owned authoring graph. Never projected to players, regardless of ownership. */
export interface AutomationDocument extends BaseDocument {
  type: "automation";
  definition: import("./automation").AutomationDefinition;
  /** Host-committed history/cooldown survives reload; not part of the authored definition. */
  state?: import("./automation").AutomationState;
}

/** Reusable, GM-only multi-layer placeable template. No prefab bytes reach player replicas. */
export interface PrefabDocument extends BaseDocument {
  type: "prefab";
  definition: import("./prefabs").PrefabDefinition;
}

/** Private, host-owned durable Sequencer instance. Players receive only entitled,
 * resolved playback cues, never this record or its origin/source references. */
export interface FxInstanceDocument extends BaseDocument {
  type: "fxInstance";
  sceneId: DocId;
  macroId: DocId;
  ownerId: UserId;
  /** The run's audience, exactly as authored (D-316): a word or the users it names. */
  audience: import("./fx").FxAudience;
  atHostTime: number;
  sections: import("./fx").ResolvedFxSection[];
  /** Host-private section→group membership; player cues receive only resolved origins. */
  syncGroups?: import("./fx").FxSyncGroupMember[];
  sourceTokenId?: DocId;
  targetTokenId?: DocId;
  /** Exact PF1e condition application whose lifetime owns this persistent visual. */
  conditionApplicationId?: DocId;
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

export interface ActionReceiptDocument extends BaseDocument {
  type: "actionReceipt";
  /** Host-authored, GM-private, persisted pre-images; never sent to players. */
  status: "pending" | "ready" | "reverted";
  createdAt: number;
  /** A crashed worker cannot leave an action permanently pending. */
  pendingUntil?: number;
  outcome?: "completed" | "partial";
  commits: number;
  /** Apply in this order; earlier commits follow later commits in the array. */
  inverses: import("./ops").Op[];
  /** Post-images of every changed document, for fail-closed stale detection. */
  after: Array<{
    ref: DocRef;
    /** Whole-document digest for legacy/default receipts; null when keyed paths are watched. */
    hash: string | null;
    /** Path-level checks are opt-in and used only when inverse Ops are path-addressable. */
    hashMode?: "paths";
    pathHashes?: Array<{ path: string; hash: string | null }>;
  }>;
}

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
  /** D-394: GM-controlled opt-in to save personal chat macros / unapproved script drafts. */
  canSaveMacros?: boolean;
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
  /** Background image — asset hash or HTTPS URL. */
  img: string | null;
  width: number;
  height: number;
  grid: SceneGrid;
  darkness: number;
  /** Optional Foundry-style background presentation; legacy scenes use origin, scale 1, no padding, white. */
  background?: {
    offset?: { x: number; y: number };
    /** Uniform scale. `scaleX`/`scaleY` (when present) are the exact per-axis transform. */
    scale?: number;
    scaleX?: number;
    scaleY?: number;
    padding?: number;
    color?: string;
    /** GM lock: the map ignores editor handles, drags and nudges until unlocked. */
    locked?: boolean;
    /**
     * The map's own square grid in native image pixels, detected or entered by the GM. It is only
     * valid for the image it was measured on (`image`), so a replaced background drops it.
     */
    mapGrid?: {
      image: string;
      sizeX: number;
      sizeY: number;
      offsetX: number;
      offsetY: number;
    };
  };
  /** Optional full-scene foreground layer; the source may be an asset hash or HTTPS URL. */
  foreground?: { img: string | null; elevation: number };
  /** Optional scene-list thumbnail. It points to an immutable asset variant. */
  thumbnail?: AssetId | null;
  /** Logical scene collection; not a server filesystem path. */
  logicalFolder?: string;
  /** Scene Express defaults retained for future compatible UI/automation. */
  navigation?: boolean;
  tokenVision?: boolean;
  fogExploration?: boolean;

  /** flags.core.scale: "tactical" | "strategic" selects §9A behaviour. */
  tokens: TokenDocument[];
  walls: WallDocument[];
  /**
   * Hexcrawl cells (D-269). **Optional on purpose**: scenes written before this feature have no
   * such field, so read it through `cellsOf(scene)` (`core/hexcrawl/cells.ts`) rather than
   * touching it directly — a world file from yesterday must not crash today's reader.
   */
  cells?: CellDocument[];
  lights: LightDocument[];
  sounds: SoundDocument[];
  tiles: TileDocument[];
  /** Optional on legacy scenes; first-class convex scene regions (D-358). */
  regions?: RegionDocument[];
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
export interface AssetImportSource {
  kind: "file" | "paste" | "url" | "tile-browser";
  originalName?: string;
  originalMime?: string;
  /** Optional provenance only; Store-by-URL intentionally omits it by default. */
  url?: string;
  /** Uploader attribution; removed from non-GM projections. */
  importedBy?: UserId;
  /** Original source byte count for the first upload, even when WebP conversion is on. */
  uploadedBytes?: number;
  /** Cumulative original bytes uploaded by each user for this content hash. GM-only metadata. */
  uploadedBytesByUser?: Record<UserId, number>;
}

export interface AssetLogicalFile {
  folder: string;
  name: string;
}

export interface AssetManifestEntry {
  name: string;
  mime: string;
  size: number;
  chunks: number;
  /** New imports default to referenced; legacy entries without this field are handled conservatively. */
  visibility?: "world" | "referenced" | "gm";
  /** Explicit FX-import consent for redistribution in a world archive. Absence means legacy asset,
   * NOT proof that any external premium-pack license permits sharing. */
  exportRights?: "restricted" | "granted";
  /** GM-only import context; never widened or replaced on a content-hash reuse. */
  source?: AssetImportSource;
  /** How the full asset was stored; derived thumb/mid/tiles remain WebP. */
  ingest?: { format: "original" | "webp"; quality?: number };
  /** Virtual aliases. The same content hash may belong to multiple names/folders. */
  logicalFiles?: AssetLogicalFile[];
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
  | "encounterTables"
  | "playlists"
  | "macros"
  | "automations"
  | "actionReceipts"
  | "prefabs"
  | "fxInstances"
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
  "encounterTables",
  "playlists",
  "macros",
  "automations",
  "actionReceipts",
  "prefabs",
  "fxInstances",
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
  | "cells"
  | "lights"
  | "sounds"
  | "tiles"
  | "regions"
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
  encounterTables: EncounterTableDocument[];
  playlists: PlaylistDocument[];
  macros: MacroDocument[];
  automations: AutomationDocument[];
  /** GM-only durable reversible world-action history (not capped with chat). */
  actionReceipts: ActionReceiptDocument[];
  prefabs: PrefabDocument[];
  fxInstances: FxInstanceDocument[];
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
