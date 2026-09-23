/**
 * MCP connector §6 — the app's half of the bridge: what the *world* looks like to a tool, and how
 * the GM's tab dials the sidecar.
 *
 * The protocol, the resources and the tool table live in `src/core/agents`; this file is only the
 * wiring, and it is deliberately thin. Two things are true of it and worth stating out loud:
 *
 * 1. **Reads are whatever replica the session was built on, and never more.** The view is handed a
 *    `ClientSync`; for the agent's own session (D-280) that store is the host's projection for the
 *    agent's user, which Phase 3 proves field-by-field against `projectWorld()`. Handed the GM's tab
 *    instead, it is the GM's world — which is why nothing here may add a second filter of its own
 *    and why the one thing it does add (`stripRollChips`) only ever *removes* text.
 * 2. **The UI is the GM's, and it is the only way in.** `connectAgentBridge` is a function the
 *    Agents section in Settings calls (Phase 2); nothing hangs off `window`, which is how this repo
 *    already drives things it does not want reachable from a page console (D-045). A connector whose
 *    identity is the whole design does not get a global.
 */
import type { ClientSync } from "../client/sync";
import type {
  ActorDocument,
  BaseDocument,
  CombatDocument,
  CombatantDocument,
  CollectionName,
  Json,
  MessageDocument,
  SceneDocument,
  TokenDocument,
} from "../core/documents";
import { TOP_LEVEL_COLLECTIONS } from "../core/documents";
import type {
  AgentBestiaryHit,
  AgentClock,
  AgentCombatTurn,
  AgentCombatantRow,
  AgentCompendiumEntry,
  AgentDiceApply,
  AgentDiceRoll,
  AgentEncounterCheck,
  AgentEncounterEntryDraft,
  AgentHexFeatureDraft,
  AgentFogOps,
  AgentFogState,
  AgentStrategicOrders,
  AgentStrategicReport,
  AgentStrategicSnapshot,
  AgentTimeOps,
  AgentUnitRow,
  AgentHexCell,
  AgentHexFeature,
  AgentDocument,
  AgentImportPlan,
  AgentMessageRow,
  AgentPackageRow,
  AgentSceneDetail,
  AgentSceneSummary,
  AgentSheet,
  AgentTokenRow,
  AgentTravelAdvance,
  AgentTravelPlan,
  AgentWorldView,
  PageOptions,
} from "../core/agents/types";
import type { Op } from "../core/ops";
import type { DocumentStore } from "../core/store";
import type { CellDocument, CellFeature } from "../core/documents";
import { cellCenterOf, cellsOf } from "../core/hexcrawl/cells";
import {
  openCellKeys,
  partyCellKey,
  partyPointOf,
} from "../core/hexcrawl/visibility";
import {
  profileOf,
  revealCellsOps,
  setTravelRouteOps,
  clearTravelOps,
  createCellOps,
  updateCellOps,
  deleteCellOps,
  enableHexcrawlOps,
  disableHexcrawlOps,
  patchHexcrawlOps,
} from "../core/hexcrawl/scene";
import { hexcrawlProfileOf, isHexcrawlScene } from "../core/hexcrawl/types";
import { DEFAULT_DAYLIGHT } from "../core/clock";
import {
  createEncounterTableOps,
  deleteEncounterTableOps,
  newEncounterTableId,
  updateEncounterTableOps,
} from "../core/hexcrawl/tableOps";
import {
  partyPositionOps,
  partyTokenOf,
  routeSeconds,
  travelAdvance,
  travelProgressOps,
} from "../core/hexcrawl/travel";
import { encounterCheck } from "../core/hexcrawl/encounterFlow";
import {
  encounterTokenData,
  placeEncounterTokens,
  type PlacementEntry,
} from "../core/hexcrawl/placement";
import { revealDueFeatures } from "../core/hexcrawl/features";
import type {
  CellFeatureReveal,
  EncounterEntry,
  EncounterRef,
  EncounterTableDocument,
} from "../core/documents";
import {
  terrainById,
  terrainCatalogOrDefault,
  terrainCost,
  type TerrainCatalog,
} from "../core/hexcrawl/terrain";
import {
  exploredSecondsOf,
  featureRuleLabel,
} from "../core/hexcrawl/features";
import {
  secondsPerRoundOf,
  worldSettingsFrom,
  worldSettingsFrom as coreWorldSettingsFrom,
} from "../core/worldSettings";
import { terrainLetters, type HexGlyph } from "../core/agents/hexRender";
import { cellAtPoint, parseCellKey } from "../core/hexcrawl/cells";
import { paginate } from "../core/agents/paging";
import type { AgentGrant } from "../core/agents/capabilities";
import type { AgentWriter } from "../core/agents/types";
import { createAgentBridge, type AgentBridge } from "../core/agents/bridge";
import {
  advanceWorldClockOps,
  formatWorldClock,
  pf1eClockSweepOps,
  readWorldClock,
  setWorldClockOps,
  wrapAdvanceOps,
} from "../packages/pf1e/worldClock";
import {
  currentCombatant,
  endCombat,
  nextTurn,
  startCombat,
} from "../core/combat";
import {
  pf1eNextTurn,
  readRoundState,
  startWithSurprise,
} from "../packages/pf1e/combatState";
import { readRollApplications } from "../packages/pf1e/rollApply";
import {
  appendFogMask,
  fogMaskLog,
  fogMaskOps,
  sceneRectPoly,
} from "../core/fogMask";
import { sceneFogSettings } from "../core/fogExploration";
import { cellPolygonOf } from "../core/hexcrawl/overlay";
import { isPf1eEncounter } from "../ui/combat/actionBudget";
import {
  activateEncounter,
  encounterList,
  newEncounter,
  selectedEncounter,
} from "../ui/combat/encounters";
import { timeOfDay } from "../core/clock";
import type {
  ArmyDocument,
  FactionDocument,
  ModelPool,
  Order,
  TurnDocument,
  UnitDocument,
  Vec2,
} from "../core/strategic";
import { daylightOf } from "../core/hexcrawl/encounter";
import { advanceClockOnRoundOf } from "../core/worldSettings";
import { pf1eSheetView, isPF1eActor } from "../ui/sheets/pf1eSheetModel";
import { createAgentLink, type AgentLinkStatus } from "../net/agentLink";
import type { CompendiumIndex } from "../core/compendiumIndex";
import { buildCompendiumIndex, rankIndex } from "../core/compendiumIndex";
import type { CompendiumPack } from "../core/compendium";
import { OWNERSHIP_LEVELS } from "../core/documents";
import { getEffectiveOwnership } from "../core/permissions";
import type { PermissionUser } from "../core/ownership";
import { makeToken } from "./hostBoot";
import {
  characterImportOps,
  characterImportReport,
  formatLabel,
  importCharacter as readCharacterDocument,
} from "../packages/pf1e/import";

/** A pack list as the packages runtime hands it over; the shape the compendium index builder wants. */
export interface AgentCompendiumSource {
  (): Promise<unknown>;
}

export interface AgentWorldViewOptions {
  /**
   * The compendium runtime, when this replica has one. Without it `bestiary.search` answers that it
   * cannot search — an honest refusal beats a tool that silently finds nothing.
   */
  compendia?: AgentCompendiumSource;
  /**
   * The world's asset pipeline — `host.importImage`. Without it `asset.import` answers that it
   * cannot: an agent that wants to hang a picture on a hex has to be able to *say* it cannot,
   * rather than inventing a hash that resolves to nothing.
   */
  importImage?: (bytes: Uint8Array, name: string, mime: string) => Promise<{ hash: string }>;
}

/** An agent cannot upload a map the size of a map: 8 MB is three 4k textures. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** The scene's grid, in the shape the tools and the map renderer share. */
function gridOf(scene: SceneDocument): AgentSceneSummary["grid"] {
  return {
    type: scene.grid.type,
    size: scene.grid.size,
    distance: scene.grid.distance,
    units: scene.grid.units,
    hexLayout: scene.grid.hexLayout,
  };
}

function summaryOf(scene: SceneDocument): AgentSceneSummary {
  return {
    id: scene._id,
    name: scene.name,
    active: scene.active === true,
    width: scene.width,
    height: scene.height,
    grid: gridOf(scene),
    darkness: scene.darkness,
    tokens: (scene.tokens ?? []).length,
    walls: (scene.walls ?? []).length,
    // Fog *configuration* is scene data; fog *state* (who has explored what) lives in the fog
    // layers, not in the store, so the renderer is told it has none rather than being handed a guess.
    fog: {
      enabled: (scene.tokens ?? []).length >= 0 && fogEnabled(scene),
      mode: fogMode(scene),
    },
  };
}

/** §2.2/§9: the profile decides the fog model; absent flags mean the table's default (no fog). */
function fogEnabled(scene: SceneDocument): boolean {
  const core = scene.flags?.core as Record<string, Json> | undefined;
  return core?.["fog"] === true;
}

function fogMode(scene: SceneDocument): string {
  const hex = scene.flags?.core as Record<string, Json> | undefined;
  const sight = hex?.["sight"];
  if (sight && typeof sight === "object" && !Array.isArray(sight)) {
    const mode = (sight as Record<string, Json>)["mode"];
    if (typeof mode === "string") return mode;
  }
  return "none";
}

/**
 * `owned` is §4's own cascade (`getEffectiveOwnership`), read with the **session's** user: the
 * agent's session is a user of its own (D-280), so "yours" means the agent's, not the tab's — and a
 * GM or assistant session owns everything, because its role says so rather than any document.
 */
function tokenRowOf(
  scene: SceneDocument,
  token: TokenDocument,
  user: PermissionUser | null,
): AgentTokenRow {
  const key = cellAtPoint(scene, token.x, token.y);
  const coords = key === null ? null : parseCellKey(key);
  return {
    id: token._id,
    name: token.name,
    x: token.x,
    y: token.y,
    col: coords?.q ?? Math.floor(token.x / Math.max(1, scene.grid.size)),
    row: coords?.r ?? Math.floor(token.y / Math.max(1, scene.grid.size)),
    disposition: token.disposition,
    hidden: token.hidden === true,
    actorId: token.actorId ?? null,
    owned:
      user === null
        ? false
        : getEffectiveOwnership(user, token, scene) >= OWNERSHIP_LEVELS.OWNER,
  };
}

function detailOf(
  scene: SceneDocument,
  user: PermissionUser | null,
): AgentSceneDetail {
  return {
    ...summaryOf(scene),
    tokenRows: (scene.tokens ?? []).map((token) => tokenRowOf(scene, token, user)),
    walls: (scene.walls ?? []).map((wall) => ({
      c: wall.c,
      door: wall.door,
      move: wall.move,
      sight: wall.sight,
    })),
    fogCells: null,
  };
}

/** An actor's derived sheet, trimmed to the numbers a model acts on (§5.4). */
function sheetOf(actor: ActorDocument): AgentSheet {
  const view = pf1eSheetView(actor);
  const derived = view.derived;
  const skills = Object.values(derived.skills)
    .filter((skill) => skill.ranks > 0 || skill.total !== 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .map((skill) => ({ name: skill.name, bonus: skill.total }));
  const authored = view.authored as {
    items?: Array<{ name?: string; type?: string }>;
  };
  const feats = (authored.items ?? [])
    .filter((item) => item.type === "feat")
    .map((item) => item.name ?? "")
    .filter((name) => name !== "");
  return {
    actorId: actor._id,
    name: actor.name,
    hp: {
      current: derived.hp,
      max: derived.hpMax,
      nonlethal: derived.nonlethalDamage,
    },
    ac: derived.ac,
    saves: derived.saves,
    initiative: derived.initiative,
    baseAttack: derived.baseAttack,
    cmb: derived.cmb,
    cmd: derived.cmd,
    speedFt: derived.speedFt,
    conditions: [...derived.conditions],
    attacks: derived.attacks.map((attack) => ({
      name: attack.name,
      bonus: attack.attackBonus,
      damage: attack.damageDice,
      ranged: attack.ranged,
    })),
    skills,
    feats,
  };
}

/** A fresh document id, in the app's own shape. */
const newId = (): string => globalThis.crypto.randomUUID();

/**
 * The hexmap's window. A 20 000-hex world rendered one character at a time is not an answer, it is
 * a denial of service on a context; 48×24 is a screen, which is what a map is for.
 */
const HEXMAP_COLS = 48;
const HEXMAP_ROWS = 24;
/** How far around a named cell `hexmap.render` draws when the agent asks for one region. */
const HEXMAP_RADIUS = 6;

/** `[[16|1d20+5]]` — the inline chip the chat renders; the total is the first half. */
const ROLL_CHIP = /\[\[[^[\]|]{1,120}\|([^[\]|]{1,120})\]\]/g;

/**
 * §5 projection, the half `projectMessage` does not cover. A redacted roll card keeps its content,
 * and the content carries the total a second time (`[[16|1d20+5]]`): the player's chat renders that
 * chip, so the number is not secret at the table, but an agent gets no second pair of eyes on it —
 * it reads the text. So the view drops the total and keeps the formula: "the GM rolled 1d20+5" is
 * a fact, "it came to 16" is not this grant's.
 */
function stripRollChips(content: string): string {
  return content.replace(ROLL_CHIP, (_match, formula: string) => `[rolled ${formula}]`);
}

/**
 * True when the card carries a roll whose result this replica does not hold. The test is the
 * replica's own state, not the agent's identity: `projectMessage` (redactMessage) nulls `roll` and
 * leaves the mode, so "no roll, but a mode that withholds" is exactly the redacted card.
 */
function resultWithheld(message: MessageDocument): boolean {
  if (message.roll !== null) return false;
  return message.rollMode === "gmroll" || message.rollMode === "blindroll";
}

/**
 * The terrain catalog the hexcrawl reads names from: the world's own setting, defaulted the way
 * every other reader in the app defaults it (D-252's discipline — a bad entry is dropped, not
 * thrown). Read per call because a GM can edit it while an agent is connected.
 */
function hexCatalogOf(store: DocumentStore): TerrainCatalog {
  return terrainCatalogOrDefault(worldSettingsFrom(store.getAll("settings"))["hexTerrain"]);
}

/** One cell, as this replica holds it — the projection already decided what is here. */
function hexCellRowOf(
  catalog: TerrainCatalog,
  cell: CellDocument,
  open: ReadonlySet<string>,
): AgentHexCell {
  const def = terrainById(catalog, cell.terrain);
  const coords = parseCellKey(cell.key);
  const explored = exploredSecondsOf(cell);
  const features: AgentHexFeature[] = (cell.features ?? []).map((feature: CellFeature) => ({
    id: feature.id,
    name: feature.name,
    revealed: feature.state?.revealed === true,
    rule: featureRuleLabel(feature),
  }));
  return {
    key: cell.key,
    // A cell's name defaults to its key (see `createCellOps`), so an unnamed hex reads as its
    // address rather than as blank — the same thing the map's tooltip shows the GM.
    name: cell.name ?? cell.key,
    col: coords?.q ?? 0,
    row: coords?.r ?? 0,
    terrain: cell.terrain ?? null,
    terrainName: def?.name ?? null,
    cost: terrainCost(catalog, cell.terrain),
    open: open.has(cell.key),
    // null, not "": an absent field and an empty one are different facts about a cell.
    description: typeof cell.description === "string" ? cell.description : null,
    playerText: typeof cell.playerText === "string" ? cell.playerText : null,
    tables: [...(cell.tables ?? [])],
    features,
    exploredSeconds: explored,
  };
}

/**
 * A new cell's id. The key is the cell's identity on the map; the id is the document's, and it
 * has to be distinct from every other embedded cell on the scene — including one the GM deleted
 * and re-authored with the same key.
 */
function newCellId(key: string): string {
  const slug = key.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  const suffix = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, "0")
    .slice(0, 4);
  return `cell-${slug || "zone"}-${suffix}`;
}

/**
 * One hidden feature, from the draft a tool was given. The rule is validated here rather than in
 * the tool, because the same four shapes are what the hex window's own form writes and the words
 * a refusal uses should be the app's, not the connector's.
 */
function buildFeature(draft: AgentHexFeatureDraft, cellKey: string): CellFeature | string {
  const name = (draft.name ?? "").trim();
  if (name === "") return `a hidden feature of "${cellKey}" needs a name`;
  const text = (draft.text ?? "").trim();
  const rule = draft.reveal;
  if (!rule || typeof rule !== "object") {
    return `feature "${name}" needs a reveal rule: manual, perception, time or dice`;
  }
  // The four shapes, checked rather than cast. A feature with a rule the evaluator cannot read is
  // the worst thing an authoring tool can write: it sits in the hex looking authored, and the
  // party walks over it forever because nothing ever asks the question it answers. So the refusal
  // names the field that is missing, in the words the rule itself uses.
  const reveal: CellFeatureReveal | string = ((): CellFeatureReveal | string => {
    switch (rule.kind) {
      case "manual":
        return { kind: "manual" };
      case "perception":
        return typeof rule.dc === "number" && Number.isFinite(rule.dc)
          ? { kind: "perception", dc: Math.trunc(rule.dc), ...(rule.active ? { active: true } : {}) }
          : `feature "${name}" has a perception rule with no dc — how hard is it to spot?`;
      case "time":
        return typeof rule.seconds === "number" && Number.isFinite(rule.seconds)
          ? { kind: "time", seconds: Math.trunc(rule.seconds) }
          : `feature "${name}" has a time rule with no seconds — how long in the hex before it is found?`;
      case "dice":
        if (typeof rule.formula !== "string" || rule.formula.trim() === "")
          return `feature "${name}" has a dice rule with no formula — "1d6", "2d6+1"`;
        return typeof rule.target === "number" && Number.isFinite(rule.target)
          ? { kind: "dice", formula: rule.formula.trim(), target: Math.trunc(rule.target) }
          : `feature "${name}" has a dice rule with no target — what does the roll have to reach?`;
      default:
        return `feature "${name}" has a reveal rule this app does not read: manual, perception, time or dice`;
    }
  })();
  if (typeof reveal === "string") return reveal;
  const made: CellFeature = {
    id: (draft.id ?? "").trim() || `feat-${newCellId(cellKey).slice(5)}`,
    name,
    text,
    reveal,
    autoReveal: draft.autoReveal !== false,
    // Nothing is found before a party finds it.
    state: { revealed: false },
  };
  if (draft.img !== undefined && draft.img !== "") made.img = draft.img;
  return made;
}

/**
 * The party's Perception, read the way the UI reads it for the same rule: the party token's own
 * actor when it has one (the scout), else the best of the world's characters — a party is a group,
 * and the lookout who spots the shrine is a member of it. Read through this view's own `sheet()`
 * so the number is the derivation the app shows, not a second one.
 */
function partyPerceptionOf(view: AgentWorldView, actorId: string | null): number {
  const bonusOf = (id: string): number => {
    const sheet = view.sheet(id);
    return sheet?.skills.find((skill) => skill.name === "Perception")?.bonus ?? 0;
  };
  if (actorId !== null && actorId !== "") return bonusOf(actorId);
  let best = 0;
  for (const row of view.documents("actors", { limit: 500 }).rows) {
    if (row.type !== "actor") continue;
    const bonus = bonusOf(row.id);
    if (bonus > best) best = bonus;
  }
  return best;
}

/**
 * The world as this tab holds it. Counts are non-empty collections only: an agent asking what the
 * world *is* wants to know it has 3 scenes and 41 actors, not that it has zero depots.
 */
export function agentWorldView(
  client: ClientSync,
  options: AgentWorldViewOptions = {},
): AgentWorldView {
  const store = client.store;
  const importImage = options.importImage ?? null;
  // Assigned once the object below exists: a view method that needs another view method (the
  // party's Perception, read through `sheet()`) calls it without reaching past what is being built.
  let thisView: AgentWorldView | null = null;
  /**
   * Who this replica is for. `token.list`'s "yours" and `token.move`'s permission to move are read
   * with it, and it is null until the session has been welcomed — an agent may be built before its
   * grant lands, and "owns nothing yet" is the honest answer until then.
   */
  const userOf = (): PermissionUser | null =>
    client.user === null
      ? null
      : { id: client.user.id, role: client.user.role };
  const scenes = (): readonly SceneDocument[] => store.getAll("scenes");
  const activeScene = (): SceneDocument | null =>
    scenes().find((scene) => scene.active === true) ?? scenes()[0] ?? null;
  const pick = (id: string | null): SceneDocument | null =>
    id === null
      ? activeScene()
      : (scenes().find((scene) => scene._id === id) ?? null);

  const counts = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const coll of TOP_LEVEL_COLLECTIONS) {
      const count = store.getAll(coll).length;
      if (count > 0) out[coll] = count;
    }
    return out;
  };

  // ── the strategic layer: one unit as a commander reads it ───────────────────────────────────
  const unitRow = (
    army: ArmyDocument,
    unit: UnitDocument,
    pool: ModelPool | null,
  ): AgentUnitRow => {
    // The document's range is the truth about how many models a unit *has*; the pool is the truth
    // about how many are still standing. Without a pool the range is still worth reporting.
    const size = unit.modelRange
      ? Math.max(0, (unit.modelRange[1] as number) - (unit.modelRange[0] as number))
      : null;
    let alive: number | null = null;
    let at: AgentUnitRow["at"] = null;
    if (pool && unit.modelRange) {
      let sx = 0;
      let sy = 0;
      alive = 0;
      for (let i = unit.modelRange[0]; i < Math.min(unit.modelRange[1], pool.count); i++) {
        // Status bits 0–1 are dead/routed: a routed model is still a model, but it is not one the
        // commander can order, so the centre of mass is the centre of the ones that answer.
        if (((pool.status[i] ?? 0) & 3) !== 0) continue;
        sx += pool.x[i] ?? 0;
        sy += pool.y[i] ?? 0;
        alive += 1;
      }
      at = alive > 0 ? { x: Math.round(sx / alive), y: Math.round(sy / alive) } : null;
    }
    const stats = unit.stats ?? { strength: 0, morale: 0, supply: 0, fatigue: 0 };
    return {
      id: unit._id,
      armyId: army._id,
      armyName: army.name,
      name: unit.name,
      type: typeof unit.profile?.["type"] === "string" ? (unit.profile["type"] as string) : null,
      sceneId: unit.sceneId ?? null,
      formation: unit.formation ?? "",
      models: size,
      modelsAlive: alive,
      at,
      stats: {
        strength: stats.strength ?? 0,
        morale: stats.morale ?? 0,
        supply: stats.supply ?? 0,
        fatigue: stats.fatigue ?? 0,
      },
      doctrine: unit.doctrine ?? null,
      activeOrder: unit.orders?.active?.kind ?? null,
      pendingOrders: (unit.orders?.pending ?? []).map((order) => order.kind),
      issuedBy: unit.orders?.issuedBy ?? null,
      issuedTurn: unit.orders?.issuedTurn ?? null,
    };
  };

  /** One order, from the tool's flat arguments to the §4A union — validated, never guessed. */
  const buildOrder = (
    request: {
      kind: string;
      path?: number[];
      pace?: string;
      facing?: number;
      targetUnitId?: string;
      mode?: string;
      stance?: string;
      formation?: string;
      toward?: number[];
      action?: string;
      type?: string;
      data?: Json;
    },
  ): { kind: string; order: Order } | { error: string } => {
    const flat = (points: number[] | undefined): Vec2[] | null => {
      if (!points || points.length < 4 || points.length % 2 !== 0) return null;
      const out: Vec2[] = [];
      for (let i = 0; i < points.length; i += 2)
        out.push({ x: points[i] as number, y: points[i + 1] as number });
      return out;
    };
    switch (request.kind) {
      case "move": {
        const path = flat(request.path);
        if (!path) return { error: "a move order needs `path` — a flat list of x,y waypoints" };
        const pace =
          request.pace === "run" || request.pace === "charge" || request.pace === "march"
            ? request.pace
            : "march";
        return {
          kind: "move",
          order: {
            kind: "move",
            path,
            pace,
            ...(request.facing === undefined ? {} : { facing: request.facing }),
          },
        };
      }
      case "attack": {
        if (!request.targetUnitId)
          return { error: "an attack order needs `targetUnitId` — strategic.snapshot names them" };
        return {
          kind: "attack",
          order: {
            kind: "attack",
            targetUnitId: request.targetUnitId,
            ...(request.mode === undefined ? {} : { mode: request.mode }),
          },
        };
      }
      case "hold":
        return { kind: "hold", order: { kind: "hold", stance: request.stance ?? "defend" } };
      case "formation":
        if (!request.formation) return { error: "a formation order needs `formation`" };
        return { kind: "formation", order: { kind: "formation", formation: request.formation } };
      case "retreat": {
        const toward = flat(request.toward);
        if (!toward || toward.length === 0)
          return { error: "a retreat order needs `toward` — [x, y] to fall back to" };
        return { kind: "retreat", order: { kind: "retreat", toward: toward[0] as Vec2 } };
      }
      case "supply":
        if (!request.action) return { error: "a supply order needs `action`" };
        return { kind: "supply", order: { kind: "supply", action: request.action } };
      case "custom":
        if (!request.type) return { error: 'a custom order needs `type` — the module names them' };
        return {
          kind: "custom",
          order: { kind: "custom", type: request.type, data: request.data ?? null },
        };
      default:
        return {
          error: `unknown order "${request.kind}" — the kinds are move, attack, hold, formation, retreat, supply and custom`,
        };
    }
  };

  // ── dice: waiting on the host ───────────────────────────────────────────────────────────────
  const ROLL_MODES = new Set(["roll", "gmroll", "blindroll", "selfroll"]);

  /** A roll card is the host's answer, and it arrives as a document — find it by its roll id. */
  const rollCardOf = (rollId: string): BaseDocument | null =>
    (store.getAll("messages") as unknown as BaseDocument[]).find(
      (doc) =>
        ((doc.flags as { core?: { rollId?: unknown } } | undefined)?.core?.rollId ?? null) ===
        rollId,
    ) ?? null;

  /**
   * Poll the replica until the host's answer lands. A tool that rolls is the only place in this
   * file that cannot build its own ops, so it is also the only place that waits — four seconds,
   * because a card the host has not committed in four seconds is not coming.
   */
  const waitForDoc = async (
    found: () => BaseDocument | boolean | null,
    timeoutMs = 4_000,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = found();
      if (hit) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** The hit points a card is applied to, read the way the host's own planner reads them. */
  const hpOf = (actor: ActorDocument | undefined): number => {
    if (!actor) return 0;
    const derived = pf1eSheetView(actor);
    return derived?.derived?.hp ?? 0;
  };

  // ── the turn tracker, as this view reads it ─────────────────────────────────────────────────
  //
  // These four helpers exist so the ports above can *call the app's* combat engine instead of
  // growing a second one. `combatUpdateOps` is the panel's own `push()`: the round, the turn, the
  // combatants and the flags are what a transition writes, and nothing else on the document is
  // the tracker's to touch.
  const legacySceneId = (): string => store.getAll("scenes")[0]?._id ?? "";
  const combatsOf = (): readonly CombatDocument[] =>
    store.getAll("combats") as unknown as CombatDocument[];
  const encounterOf = (scene: SceneDocument): CombatDocument | null =>
    selectedEncounter(combatsOf(), scene, legacySceneId());

  const combatUpdateOps = (combat: CombatDocument): Op[] => [
    {
      kind: "update",
      ref: { coll: "combats", id: combat._id },
      diff: {
        round: combat.round,
        turn: combat.turn,
        combatants: combat.combatants as unknown as Json[],
        flags: combat.flags as unknown as Json,
      },
    },
  ];

  const applyValues = (
    combat: CombatDocument,
    values: Record<string, number> | undefined,
  ): { combat: CombatDocument } =>
    values === undefined || Object.keys(values).length === 0
      ? { combat }
      : {
          combat: {
            ...combat,
            combatants: combat.combatants.map((member) =>
              member._id in values
                ? { ...member, initiative: Math.trunc(values[member._id] as number) }
                : member,
            ),
          },
        };

  /** Create the encounter when the scene has none; otherwise hand back the one the tracker shows. */
  const openEncounter = (
    scene: SceneDocument,
    name?: string,
  ): { combat: CombatDocument; ops: Op[] } | { error: string } => {
    const existing = encounterOf(scene);
    if (existing) return { combat: existing, ops: [] };
    const count = encounterList(combatsOf(), scene, legacySceneId()).length;
    const doc = newEncounter(scene, newId(), name ?? `Encounter ${count + 1}`, () => newId());
    const activation = activateEncounter(scene, doc, userOf(), legacySceneId());
    if (activation.error) return { error: activation.error };
    return {
      combat: doc,
      ops: [
        { kind: "create", coll: "combats", data: doc as unknown as BaseDocument },
        ...activation.ops,
      ],
    };
  };

  /** One combat, in the shape the tools report: the order, whose turn it is, and what happened. */
  const stateOf = (
    combat: CombatDocument,
    note: string | null,
    ops: Op[],
    clockDeltaSeconds: number,
    dyingChecks: AgentCombatTurn["dyingChecks"] = [],
  ): AgentCombatTurn => {
    const state = readRoundState(combat);
    const inSurprise = state.phase === "surprise";
    const currentId = inSurprise
      ? (state.surpriseOrder[state.surpriseTurn] ?? null)
      : (currentCombatant(combat)?._id ?? null);
    const rows: AgentCombatantRow[] = combat.combatants.map((member) => ({
      id: member._id,
      name: member.name,
      initiative: member.initiative,
      defeated: member.defeated === true,
      hidden: member.hidden === true,
      tokenId: member.tokenId ?? null,
      actorId: member.actorId ?? null,
      isCurrent: member._id === currentId,
    }));
    const current = rows.find((row) => row.isCurrent) ?? null;
    return {
      id: combat._id,
      name: combat.name,
      round: combat.round,
      turn: combat.turn,
      // A surprise round is running before `round` reaches 1: the tracker's own rule, not ours.
      started: combat.round >= 1 || inSurprise,
      phase: inSurprise ? "surprise" : null,
      current,
      order: rows,
      clockDeltaSeconds,
      ops,
      note,
      dyingChecks,
    };
  };

  const view: AgentWorldView = {
    worldInfo() {
      const meta = store.meta;
      return {
        id: meta.worldId,
        name: meta.name,
        system: meta.system,
        version: meta.systemVersion,
        seq: store.seq,
        collections: counts(),
      };
    },
    snapshot() {
      return { seq: store.seq, collections: counts() };
    },
    identity() {
      const me = client.user;
      return me ? { id: me.id, name: me.name, role: me.role } : null;
    },
    clockSeconds() {
      return readWorldClock(store.getAll("settings"));
    },
    scenes() {
      return [...scenes()]
        .sort(
          (a, b) =>
            Number(b.active === true) - Number(a.active === true) ||
            a.name.localeCompare(b.name),
        )
        .map(summaryOf);
    },
    scene(id) {
      const scene = pick(id);
      return scene === null ? null : detailOf(scene, userOf());
    },
    tokens(sceneId, paging: PageOptions) {
      const scene = pick(sceneId);
      if (scene === null) return { rows: [], total: 0, next: null, cap: 0 };
      const raw = (scene.tokens ?? []).map((token) =>
        tokenRowOf(scene, token, userOf()),
      );
      const page = paginate(raw, paging);
      return {
        rows: page.rows,
        total: page.total,
        next: page.next,
        cap: page.cap,
      };
    },
    documents(coll, paging: PageOptions) {
      if (!TOP_LEVEL_COLLECTIONS.includes(coll as CollectionName)) {
        return { rows: [], total: 0, next: null, cap: 0 };
      }
      const raw = store.getAll(coll as CollectionName);
      const page = paginate(raw, paging);
      return {
        rows: page.rows.map((doc) => ({
          id: doc._id,
          name: doc.name,
          type: doc.type,
          parent: null,
        })),
        total: page.total,
        next: page.next,
        cap: page.cap,
      };
    },
    document(coll, id) {
      if (!TOP_LEVEL_COLLECTIONS.includes(coll as CollectionName)) return null;
      const doc = store
        .getAll(coll as CollectionName)
        .find((row) => row._id === id);
      if (!doc) return null;
      const fields = doc as unknown as Record<string, Json>;
      const row: AgentDocument = {
        id: doc._id,
        type: doc.type,
        name: doc.name,
        fields,
      };
      return row;
    },
    messages(paging) {
      const all = store.getAll("messages");
      // The chat is a capped log (trimmed oldest-first), so the only stable "since" is the id of the
      // last message seen: if it has been trimmed away, the honest answer is the whole log.
      const since = paging.since;
      const start =
        typeof since === "string" && since !== ""
          ? all.findIndex((message) => message._id === since) + 1
          : 0;
      const rows = start > 0 ? all.slice(start) : all;
      const page = paginate(rows, paging);
      const users = new Map(
        store.getAll("users").map((user) => [user._id, user.name]),
      );
      return {
        rows: page.rows.map((message): AgentMessageRow => {
          const withheld = resultWithheld(message);
          return {
            id: message._id,
            author: message.author,
            authorName: users.get(message.author) ?? message.author,
            // The total lives in the content chip as well as in `roll`, and a redacted card keeps
            // its content: strip it here so "the dice are not yours" is true of the whole row.
            content: withheld ? stripRollChips(message.content) : message.content,
            whisper: [...message.whisper],
            hasRoll: message.roll !== null,
            rollMode: message.rollMode ?? null,
            resultWithheld: withheld,
          };
        }),
        total: page.total,
        next: page.next,
        cap: page.cap,
      };
    },
    sheet(actorId) {
      const actor = store
        .getAll("actors")
        .find((row): row is ActorDocument => row._id === actorId);
      if (!actor || !isPF1eActor(actor as BaseDocument)) return null;
      return sheetOf(actor);
    },
    async bestiary(query: string, limit: number): Promise<AgentBestiaryHit[]> {
      const source = options.compendia;
      if (!source) return [];
      const packs = (await source()) as Parameters<
        typeof buildCompendiumIndex
      >[0];
      const index: CompendiumIndex = buildCompendiumIndex(packs);
      const ranking = rankIndex(index, query, { cap: limit });
      const hits: AgentBestiaryHit[] = [];
      for (const entryIndex of ranking.indices) {
        const entry = index.entries[entryIndex];
        if (!entry) continue;
        // The index entry wraps the pack's own entry (`IndexedEntry`), which is where the id,
        // the name and the type live — the wrapper carries only the ranking's bookkeeping.
        hits.push({
          id: entry.entry.id,
          name: entry.entry.name,
          type: entry.entry.data.type,
          pack: index.packs[entry.packIndex]?.name ?? "",
        });
        if (hits.length >= limit) break;
      }
      return hits;
    },
    packages() {
      const rows: AgentPackageRow[] = store.getAll("compendia").map((pack) => ({
        id: pack._id,
        label: pack.label,
        entries: (pack.index ?? []).length,
      }));
      return rows;
    },
    async compendiumEntry(id: string): Promise<AgentCompendiumEntry | null> {
      const source = options.compendia;
      if (!source) return null;
      const packs = (await source()) as CompendiumPack[];
      for (const pack of packs) {
        const entry = pack.entries.find((row) => row.id === id);
        if (!entry) continue;
        // The entry's own create payload, unmodified: this is what the Compendia panel's Import
        // button submits, so an agent's import lands the same document a GM's click lands. Packs
        // are already in this app's document shape — which is why this is *not* the character
        // importer: re-reading a pack entry as an export would find none of its fields and author
        // an actor that opens as a blank sheet.
        return {
          id: entry.id,
          name: entry.name,
          pack: pack.name,
          coll: pack.type,
          data: entry.data as unknown as Json,
        };
      }
      return null;
    },
    importCharacter(text: string, spec: { id: string }): AgentImportPlan | { error: string } {
      const parsed = readCharacterDocument(text);
      // The importer's own sentence, not a summary of it: "a stat block starts with the creature's
      // name and its CR" is the thing that tells an agent what to paste next time.
      if (!parsed.ok) return { error: parsed.error };
      const report = characterImportReport(parsed.value);
      // The actor belongs to the session that imported it, the same way the app's own import hands
      // a character to the GM: an import is not published to the table until somebody shares it.
      const owner = userOf()?.id;
      return {
        name: report.name,
        format: formatLabel(report.format),
        ops: characterImportOps(parsed.value, {
          id: spec.id,
          ...(owner === undefined ? {} : { gmId: owner }),
        }),
        read: [...report.read],
        warnings: [...report.warnings],
      };
    },
    hexSummary(sceneId) {
      const scene = pick(sceneId);
      if (!scene) return null;
      const catalog = hexCatalogOf(store);
      const rows = cellsOf(scene);
      if (rows.length === 0) return null;
      const open = openCellKeys(scene);
      const counts = new Map<string, number>();
      for (const cell of rows) {
        const id = cell.terrain ?? "";
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      // The legend is the catalog's own order, with the catalog's default standing in for a cell
      // that names none — which is how the overlay paints it too.
      const byTerrain = catalog.terrains.map((def) => ({
        id: def.id,
        name: def.name,
        count: counts.get(def.id) ?? 0,
        cost: def.cost,
      }));
      const unauthored = counts.get("") ?? 0;
      if (unauthored > 0) {
        const def = terrainById(catalog, catalog.defaultTerrain);
        byTerrain.unshift({
          id: "",
          name: def ? `${def.name} (the catalog's default)` : "no terrain set",
          count: unauthored,
          cost: terrainCost(catalog, null),
        });
      }
      const partyKey = partyCellKey(scene);
      const partyCoords = partyKey === null ? null : parseCellKey(partyKey);
      const travel = profileOf(scene).travel;
      return {
        sceneId: scene._id,
        sceneName: scene.name,
        grid: gridOf(scene),
        cells: rows.length,
        open: open.size,
        byTerrain: byTerrain.filter((entry) => entry.count > 0),
        party:
          partyKey === null || partyCoords === null
            ? null
            : { key: partyKey, col: partyCoords.q, row: partyCoords.r },
        catalog: catalog.name,
        travel: travel
          ? { speedPerDay: travel.speedPerDay, pace: travel.pace }
          : null,
      };
    },
    hexCells(sceneId, paging) {
      const scene = pick(sceneId);
      if (!scene) return { rows: [], total: 0, next: null, cap: 0 };
      const catalog = hexCatalogOf(store);
      const open = openCellKeys(scene);
      const rows = cellsOf(scene).map((cell) => hexCellRowOf(catalog, cell, open));
      const page = paginate(rows, paging);
      return {
        rows: page.rows,
        total: page.total,
        next: page.next,
        cap: page.cap,
      };
    },
    hexCell(sceneId, key) {
      const scene = pick(sceneId);
      if (!scene) return null;
      const cell = cellsOf(scene).find((row) => row.key === key);
      // A cell the projection did not send is not "a cell with nothing in it" — it is absent, and
      // the tool's refusal says so rather than inventing an empty hex.
      if (!cell) return null;
      return hexCellRowOf(hexCatalogOf(store), cell, openCellKeys(scene));
    },
    hexMap(sceneId, spec) {
      const scene = pick(sceneId);
      if (!scene) return null;
      const catalog = hexCatalogOf(store);
      const letters = terrainLetters(catalog.terrains);
      const open = openCellKeys(scene);
      const party = partyCellKey(scene);
      const cells = cellsOf(scene);
      if (cells.length === 0) return null;

      // The region: the whole authored set when it fits, otherwise a window on the party (or on
      // the cell the agent named). A 20 000-hex world is not a thing to paste into a context.
      let minCol = Infinity;
      let maxCol = -Infinity;
      let minRow = Infinity;
      let maxRow = -Infinity;
      for (const cell of cells) {
        const coords = parseCellKey(cell.key);
        if (!coords) continue;
        if (coords.q < minCol) minCol = coords.q;
        if (coords.q > maxCol) maxCol = coords.q;
        if (coords.r < minRow) minRow = coords.r;
        if (coords.r > maxRow) maxRow = coords.r;
      }
      const centre =
        spec.around !== undefined && spec.around !== null
          ? parseCellKey(spec.around)
          : party === null
            ? null
            : parseCellKey(party);
      const radius = spec.radius ?? HEXMAP_RADIUS;
      let col0 = minCol;
      let row0 = minRow;
      let cols = maxCol - minCol + 1;
      let rows = maxRow - minRow + 1;
      let clamped = false;
      if (centre !== null && spec.around !== undefined && spec.around !== null) {
        col0 = centre.q - radius;
        row0 = centre.r - radius;
        cols = radius * 2 + 1;
        rows = radius * 2 + 1;
      }
      if (cols > HEXMAP_COLS || rows > HEXMAP_ROWS) {
        const c = centre ?? { q: Math.round((minCol + maxCol) / 2), r: Math.round((minRow + maxRow) / 2) };
        cols = Math.min(cols, HEXMAP_COLS);
        rows = Math.min(rows, HEXMAP_ROWS);
        col0 = c.q - Math.floor(cols / 2);
        row0 = c.r - Math.floor(rows / 2);
        clamped = true;
      }

      const glyphs: HexGlyph[] = cells.map((cell) => {
        const coords = parseCellKey(cell.key);
        const def = terrainById(catalog, cell.terrain);
        return {
          key: cell.key,
          col: coords?.q ?? 0,
          row: coords?.r ?? 0,
          letter: (cell.terrain === undefined ? "" : letters[cell.terrain]) ?? "",
          name: def?.name ?? "",
          open: open.has(cell.key),
          party: cell.key === party,
        };
      });
      return {
        options: {
          sceneName: scene.name,
          // The scene's own grid, not the summary's widened one: the renderer wants the hex
          // layout it was written with, and a "hex" that renders as a square is worse than a
          // refusal.
          grid: {
            type: scene.grid.type,
            size: scene.grid.size,
            distance: scene.grid.distance,
            units: scene.grid.units,
            hexLayout: scene.grid.hexLayout,
          },
          col0,
          row0,
          cols,
          rows,
          totalCells: cells.length,
          terrains: catalog.terrains.map((def) => ({
            id: def.id,
            name: def.name,
            letter: letters[def.id] ?? "?",
            count: 0,
            cost: def.cost,
          })),
          ...(clamped ? { clamped: true } : {}),
        },
        glyphs,
      };
    },
    hexTravel(sceneId): AgentTravelPlan | null {
      const scene = pick(sceneId);
      if (!scene) return null;
      const plan = profileOf(scene).travel;
      if (!plan) return null;
      const catalog = hexCatalogOf(store);
      const party = partyTokenOf(scene);
      const rest = plan.path.slice(plan.cursor);
      return {
        sceneId: scene._id,
        path: [...plan.path],
        cursor: plan.cursor,
        progressSeconds: plan.progressSeconds,
        speedPerDay: plan.speedPerDay,
        pace: plan.pace,
        remaining: [...rest],
        remainingSeconds: Math.max(
          0,
          routeSeconds({ scene, path: rest, speedPerDay: plan.speedPerDay, pace: plan.pace, catalog }) -
            plan.progressSeconds,
        ),
        party:
          party === null
            ? null
            : {
                key: partyCellKey(scene) ?? plan.path[plan.cursor] ?? "",
                tokenId: party._id,
              },
      };
    },
    hexCellOps(sceneId, spec) {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene to author a hex on" };
      const key = (spec.key ?? "").trim();
      if (key === "") return { error: "hex.write needs a cell key — 'col,row'" };
      if (!isHexcrawlScene(scene)) {
        return {
          error: `${scene.name} is not a hexcrawl scene — hexcrawl.configure switches the profile on`,
        };
      }
      // A gridded scene's cells are addresses; only a gridless map paints them as zones, and a
      // zone must have at least three points to be a shape at all.
      const gridless = scene.grid?.type === "gridless";
      if (gridless && !spec.poly) {
        return { error: `${scene.name} is gridless — a cell there is a zone, and needs a 'poly' list` };
      }
      const existing = cellsOf(scene).find((cell) => cell.key === key) ?? null;
      if (spec.delete === true) {
        if (!existing) return { error: `no cell '${key}' on ${scene.name} to delete` };
        return deleteCellOps(scene, key);
      }
      const catalog = hexCatalogOf(store);
      if (spec.terrain !== undefined && !catalog.terrains.some((t) => t.id === spec.terrain)) {
        return {
          error: `terrain '${spec.terrain}' is not in this world's catalog — ${catalog.terrains
            .map((t) => t.id)
            .join(", ")}`,
        };
      }
      if (spec.tables !== undefined) {
        const known = store.getAll("encounterTables") as unknown as EncounterTableDocument[];
        for (const id of spec.tables) {
          if (!known.some((table) => table._id === id)) {
            return {
              error: `no encounter table '${id}' in this world — encounterTable.create makes one`,
            };
          }
        }
      }
      const ops: Op[] = [];
      const patch: Record<string, unknown> = {};
      /** Equal enough to not be a change: values here are JSON-ish, not identity-bearing. */
      const same = (a: unknown, b: unknown): boolean =>
        a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      /**
       * Write a field only when it differs from what the cell already holds, so a second identical
       * `hex.write` is **no ops at all**. That is what makes a retry after a dropped connection
       * safe, and the GM's undo stack honest: an entry that changes nothing is a lie in the log.
       */
      const put = (field: string, value: unknown, current: unknown): void => {
        if (same(value, current)) return;
        patch[field] = value;
      };
      /** Whether the caller said anything at all — see the no-op branch below. */
      let named = spec.open !== undefined || spec.delete !== undefined;
      /** `named` and `put` in one step: every field the caller named is a field it meant. */
      const write = (field: string, value: unknown, current: unknown): void => {
        named = true;
        put(field, value, current);
      };
      if (spec.name !== undefined) write("name", spec.name, existing?.name);
      if (spec.terrain !== undefined) write("terrain", spec.terrain, existing?.terrain ?? null);
      if (spec.description !== undefined)
        write("description", spec.description, existing?.description ?? null);
      if (spec.playerText !== undefined)
        write("playerText", spec.playerText, existing?.playerText ?? null);
      if (spec.poly !== undefined && gridless) write("poly", spec.poly, existing?.poly);
      if (spec.tables !== undefined) write("tables", spec.tables, existing?.tables ?? []);
      const features = [...(existing?.features ?? [])];
      for (const draft of spec.features ?? []) {
        const feature = buildFeature(draft, key);
        if (typeof feature === "string") return { error: feature };
        const at = features.findIndex((f) => f.id === feature.id);
        if (at >= 0) features[at] = feature;
        else features.push(feature);
      }
      const dropped = new Set(spec.removeFeatures ?? []);
      if (dropped.size > 0) {
        named = true;
        put("features", features.filter((f) => !dropped.has(f.id)), existing?.features ?? []);
      } else if ((spec.features ?? []).length > 0) {
        named = true;
        put("features", features, existing?.features ?? []);
      }
      if (Object.keys(patch).length === 0 && spec.open === undefined) {
        // Nothing named at all is a malformed call, and says so. Everything named but already true
        // is a no-op, and returns no ops so the tool can say exactly that instead of failing — the
        // difference between "you forgot the arguments" and "this was already done".
        if (!named) return { error: `hex.write has nothing to write on '${key}'` };
        return [];
      }
      if (!existing) {
        ops.push(...createCellOps(scene, newCellId(key), { key, ...patch } as never));
      } else if (Object.keys(patch).length > 0) {
        ops.push(...updateCellOps(scene, key, patch as never));
      }
      // Opening a hex is the profile's own list, not the cell's: a closed cell is a cell the
      // party has no document for, and the projection strips it either way.
      // `revealCellsOps` takes two lists — the cells to open and the cells to close — so one
      // call can do both and a no-op is genuinely no ops.
      if (spec.open !== undefined) {
        ops.push(...revealCellsOps(scene, spec.open === true ? [key] : [], spec.open ? [] : [key]));
      }
      return ops;
    },
    hexRevealOps(sceneId, spec) {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene to open hexes on" };
      if (!isHexcrawlScene(scene)) {
        return { error: `${scene.name} is not a hexcrawl scene — hexcrawl.configure switches it on` };
      }
      const keys = spec.keys.filter((key) => typeof key === "string" && key !== "");
      if (keys.length === 0) return { error: "hex.reveal needs at least one cell key" };
      return revealCellsOps(scene, spec.open === false ? [] : keys, spec.open === false ? keys : []);
    },
    hexSceneOps(sceneId, spec) {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene to configure" };
      const ops: Op[] = [];
      const on = spec.enable !== false;
      if (on && !isHexcrawlScene(scene)) {
        // Switching a scene on and setting its scale are usually the same act, so one call does
        // both: enable the profile, then write the grid it walks on.
        ops.push(...enableHexcrawlOps(scene, { daylight: DEFAULT_DAYLIGHT }));
      }
      if (!on) {
        if (!isHexcrawlScene(scene)) return { error: `${scene.name} is not a hexcrawl scene` };
        return disableHexcrawlOps(scene);
      }
      if (spec.cellDistance !== undefined || spec.units !== undefined || spec.hexLayout !== undefined) {
        const grid = { ...(scene.grid ?? {}) } as Record<string, unknown>;
        if (spec.cellDistance !== undefined) grid["distance"] = spec.cellDistance;
        if (spec.units !== undefined) grid["units"] = spec.units;
        if (spec.hexLayout !== undefined) grid["hexLayout"] = spec.hexLayout;
        ops.push({ kind: "update", ref: { coll: "scenes", id: scene._id }, diff: { grid } as never });
      }
      const oneOf = (value: string, allowed: readonly string[]): string | null =>
        allowed.includes(value)
          ? null
          : `${value} is not one of ${allowed.join(", ")} — the app reads no other value`;
      const patch: Record<string, unknown> = {};
      if (spec.sight !== undefined) {
        if (spec.sight.mode !== undefined) {
          const bad = oneOf(spec.sight.mode, ["gm", "gm+party"] as const);
          if (bad !== null) return { error: `hexcrawl.configure: sightMode ${bad}` };
        }
        const sight = { ...(hexcrawlProfileOf(scene)?.sight ?? {}) } as Record<string, unknown>;
        if (spec.sight.mode === "gm" || spec.sight.mode === "gm+party") sight["mode"] = spec.sight.mode;
        if (spec.sight.radiusCells !== undefined) sight["radiusCells"] = spec.sight.radiusCells;
        patch["sight"] = sight;
      }
      if (spec.daylight !== undefined) {
        const daylight = { ...(hexcrawlProfileOf(scene)?.daylight ?? DEFAULT_DAYLIGHT) };
        if (spec.daylight.dawnHour !== undefined) daylight.dawnHour = spec.daylight.dawnHour;
        if (spec.daylight.duskHour !== undefined) daylight.duskHour = spec.daylight.duskHour;
        patch["daylight"] = daylight;
      }
      if (spec.encounterMode !== undefined) {
        const bad = oneOf(spec.encounterMode, ["auto", "prompt", "manual"] as const);
        if (bad !== null) return { error: `hexcrawl.configure: encounterMode ${bad}` };
        patch["encounterMode"] = spec.encounterMode;
      }
      if (spec.encounterAnnounce !== undefined) {
        const bad = oneOf(spec.encounterAnnounce, ["names", "hidden"] as const);
        if (bad !== null) return { error: `hexcrawl.configure: encounterAnnounce ${bad}` };
        patch["encounterAnnounce"] = spec.encounterAnnounce;
      }
      if (spec.terrain !== undefined) {
        // Named, not checked: a scene may name a catalog this world's settings do not carry, and
        // the app falls back to the default rather than refusing to draw. The enums above are a
        // different matter — a mode the app does not read is a value that does nothing at all.
        patch["terrain"] = spec.terrain;
      }
      if (spec.partyTokenId !== undefined) patch["partyTokenId"] = spec.partyTokenId;
      if (Object.keys(patch).length > 0) ops.push(...patchHexcrawlOps(scene, patch as never));
      if (ops.length === 0) return { error: "hexcrawl.configure has nothing to change" };
      return ops;
    },
    encounterTableOps(spec) {
      if (spec.action === "delete") {
        const id = spec.tableId ?? "";
        if (id === "") return { error: "encounterTable.delete needs the table's id" };
        const tables = store.getAll("encounterTables") as unknown as EncounterTableDocument[];
        if (!tables.some((table) => table._id === id)) {
          return { error: `no encounter table '${id}' in this world` };
        }
        return deleteEncounterTableOps(id);
      }
      // An update that names no entries keeps the rows the table already has: rewriting a table's
      // name should not demand that the agent re-send every row it does not mean to touch.
      const existing =
        spec.action === "update"
          ? ((store.getAll("encounterTables") as unknown as EncounterTableDocument[]).find(
              (row) => row._id === (spec.tableId ?? ""),
            ) ?? null)
          : null;
      // The same courtesy for the name: `encounterTable.update` with only new rows is the common
      // case, and "an encounter table needs a name" is a lie when the table already has one.
      const name = (spec.name ?? existing?.name ?? "").trim();
      if (name === "") return { error: "an encounter table needs a name" };
      // An update names the table it means, so that is the first thing checked: "no encounter
      // table 'x' in this world" is the sentence that helps, and "needs at least one entry" for a
      // table the agent is trying to *edit* is a sentence that misleads.
      if (spec.action === "update" && !existing) {
        return { error: `no encounter table '${spec.tableId ?? ""}' in this world to update` };
      }
      const mode = spec.mode === "dice" ? "dice" : "weighted";
      const rows: AgentEncounterEntryDraft[] =
        spec.entries ??
        (existing?.entries ?? []).map((entry) => ({
          text: entry.text,
          count: entry.count,
          weight: entry.weight,
          ...(entry.range ? { range: entry.range } : {}),
          refs: entry.refs.map((ref: EncounterRef) =>
            ref.kind === "actor"
              ? { kind: "actor" as const, actorId: ref.actorId }
              : { kind: "compendium" as const, packId: ref.packId, entryId: ref.entryId },
          ),
        }));
      const entries: EncounterEntry[] = [];
      for (const row of rows) {
        const index = entries.length;
        const range = row.range ?? (mode === "dice" ? [index + 1, index + 1] : undefined);
        const refs: EncounterRef[] = [];
        for (const ref of row.refs ?? []) {
          // A ref is a promise the drawer will find something. Silently dropping one that cannot
          // be kept was the first draft, and it fails the way silence always fails: the table
          // looks authored, the encounter draws it, and it places nothing on the map with no
          // sentence anywhere saying why. So the refusal names the actor instead, while the row
          // can still be written.
          if (ref.kind === "actor") {
            const actor = store.get("actors", ref.actorId) ?? null;
            if (!actor) {
              return {
                error: `no actor '${ref.actorId}' in this world — actor.from_compendium or actor.from_statblock makes the thing a table row can point at`,
              };
            }
          }
          refs.push(ref);
        }
        entries.push({
          weight: Math.max(0, Math.trunc(row.weight ?? 1)),
          ...(range ? { range } : {}),
          text: row.text,
          count: Math.max(0, Math.trunc(row.count ?? 0)),
          refs,
        });
      }
      if (entries.length === 0) return { error: "an encounter table needs at least one entry" };
      const draft = {
        name,
        mode,
        formula: mode === "dice" ? (spec.formula ?? `1d${entries.length}`) : "",
        entries,
        tags: {
          day: spec.tags?.day !== false,
          night: spec.tags?.night !== false,
          entering: spec.tags?.entering !== false,
          moving: spec.tags?.moving !== false,
          exploring: spec.tags?.exploring === true,
          fighting: spec.tags?.fighting === true,
        },
        ...(spec.sceneId ? { sceneId: spec.sceneId } : {}),
        ...(typeof spec.cooldownSeconds === "number" ? { cooldownSeconds: spec.cooldownSeconds } : {}),
      };
      if (spec.action === "update") {
        return updateEncounterTableOps(existing as EncounterTableDocument, draft as never);
      }
      return createEncounterTableOps(newEncounterTableId(name), draft as never);
    },
    async importAsset(spec) {
      if (!importImage) return { error: "the world's asset pipeline is not on this replica" };
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(spec.base64, "base64"));
      } catch {
        return { error: "asset.import needs the image as base64" };
      }
      if (bytes.byteLength === 0) return { error: "asset.import got an empty file" };
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        return { error: `that image is ${bytes.byteLength} bytes — the limit is ${MAX_ASSET_BYTES}` };
      }
      try {
        const made = await importImage(bytes, spec.name, spec.mime);
        return { hash: made.hash };
      } catch (e) {
        return { error: `image import failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    travelPlanOps(sceneId, spec) {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene to plan a route on" };
      const path = spec.path;
      // A route of one cell is not a route: `setTravelRouteOps` clears the plan below two, which is
      // also how the GM cancels a march — an empty path is "called off", not an error.
      if (path.length > 1) {
        for (const key of path) {
          if (!cellsOf(scene).some((cell) => cell.key === key)) {
            return {
              error: `cell "${key}" is not an authored cell of ${scene.name} — hexcrawl.cells names them`,
            };
          }
        }
      }
      if (path.length === 0) return clearTravelOps(scene);
      return setTravelRouteOps(scene, path, {
        ...(spec.speedPerDay === undefined ? {} : { speedPerDay: spec.speedPerDay }),
        ...(spec.pace === "forced" || spec.pace === "normal"
          ? { pace: spec.pace }
          : {}),
      });
    },
    travelAdvanceOps(sceneId, seconds) {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no hexcrawl scene to march on" };
      const plan = profileOf(scene).travel;
      if (!plan) {
        return { error: "this scene has no route — travel.plan commits one first" };
      }
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { error: "travel.advance needs a positive number of seconds" };
      }
      const catalog = hexCatalogOf(store);
      const settingsDocs = store.getAll("settings");
      const startClock = readWorldClock(settingsDocs);
      const delta = Math.trunc(seconds);
      const advance = travelAdvance({
        scene,
        plan,
        elapsedSeconds: delta,
        catalog,
        startClock,
      });
      const party = partyTokenOf(scene);
      const arrivalKey = advance.cellKey;
      const centre = arrivalKey === null ? null : cellCenterOf(scene, arrivalKey);

      // Feature reveals are judged at the reading the march *ended* at: the party has been there by
      // then. The facts come from this view's own sheet, so a shrine found on foot is a shrine the
      // GM's own march would have found.
      const scoutBonus =
        thisView === null ? 0 : partyPerceptionOf(thisView, party?.actorId ?? null);
      const facts = {
        clockSeconds: startClock + delta,
        passivePerception: 10 + scoutBonus,
        perceptionModifier: scoutBonus,
        rng: Math.random,
      };
      const revealed: AgentTravelAdvance["revealed"] = [];
      const featureOps: Op[] = [];
      for (const [key, spent] of Object.entries(advance.spentSeconds)) {
        const result = revealDueFeatures({ scene, cellKey: key, facts, spentSeconds: spent });
        featureOps.push(...result.ops);
        if (result.revealed.length > 0)
          revealed.push({
            cellKey: key,
            names: result.revealed.map((feature) => feature.name),
          });
      }

      const ops: Op[] = [
        // The clock and its sweep first: the UI submits these as their own envelope because it has
        // listeners to keep in step, and an agent has none — a march that moved the party but not
        // the hour is a world nobody can describe.
        ...advanceWorldClockOps(settingsDocs, delta),
        ...(pf1eClockSweepOps(
          store.getAll("actors") as never,
          store.getAll("combats") as never,
          startClock + delta,
          secondsPerRoundOf(coreWorldSettingsFrom(settingsDocs)),
        ).ops as unknown as Op[]),
        ...travelProgressOps(scene, advance.plan),
        ...(party && centre && arrivalKey
          ? partyPositionOps(scene, party._id, centre)
          : []),
        ...featureOps,
      ];
      return {
        ops,
        seconds: delta,
        arrival: arrivalKey,
        arrived: advance.arrived,
        steps: advance.steps.map((step) => ({
          cellKey: step.cellKey,
          seconds: step.seconds,
          triggers: [...step.triggers],
        })),
        revealed,
        spent: { ...advance.spentSeconds },
      };
    },
    encounterCheckOps(sceneId, spec): AgentEncounterCheck | { error: string } {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no hexcrawl scene here" };
      const key = spec.cellKey ?? partyCellKey(scene);
      if (key === null) {
        return { error: "no cell to check — name one with key, or place the party" };
      }
      const tables = store.getAll("encounterTables") as unknown as EncounterTableDocument[];
      const check = encounterCheck({
        scene,
        tables,
        cellKey: key,
        trigger: (spec.trigger ?? "moving") as never,
        clockSeconds: readWorldClock(store.getAll("settings")),
        rng: Math.random,
      });
      const roll = check.roll;
      return {
        ops: [...check.ops],
        action: check.action,
        reason: check.reason,
        cellKey: check.cellKey,
        phase: check.phase,
        eligible: check.eligible.map((table) => ({ id: table._id, name: table.name })),
        roll:
          roll === null
            ? null
            : {
                tableId: roll.tableId,
                tableName: roll.tableName,
                formula: roll.formula,
                roll: roll.roll,
                die: roll.die,
                text: roll.text,
                count: roll.count,
                actorIds: roll.refs
                  .map((ref) => String((ref as { id?: string }).id ?? ""))
                  .filter((id) => id !== ""),
              },
      };
    },
    encounterPlaceOps(sceneId, spec) {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene to place an encounter on" };
      const actors = spec.actors.filter((entry) => entry.count > 0);
      if (actors.length === 0) {
        return { error: "encounter.place needs at least one actor with a count" };
      }
      const docs = store.getAll("actors") as unknown as ActorDocument[];
      const entries: PlacementEntry[] = [];
      for (const entry of actors) {
        const actor = docs.find((row) => row._id === entry.actorId);
        if (!actor) {
          return { error: `no actor "${entry.actorId}" — document.list actors names them` };
        }
        for (let i = 0; i < Math.min(entry.count, 25); i++) {
          entries.push({ actorId: actor._id, name: actor.name, img: "" });
        }
      }
      // Every branch below assigns; the `if (!origin)` after them is the exhaustiveness check.
      let origin: { x: number; y: number } | null;
      if (spec.cellKey !== undefined && spec.cellKey !== null) {
        origin = cellCenterOf(scene, spec.cellKey) ?? null;
        if (!origin) {
          return {
            error: `cell "${spec.cellKey}" is not a cell of ${scene.name} — hexcrawl.cells names them`,
          };
        }
      } else if (spec.col !== undefined && spec.row !== undefined) {
        const size = scene.grid.size > 0 ? scene.grid.size : 100;
        origin = { x: (spec.col + 0.5) * size, y: (spec.row + 0.5) * size };
      } else {
        origin = partyPointOf(scene);
      }
      if (!origin) {
        return { error: "no origin — name a cell, a col/row, or place the party" };
      }
      const points = placeEncounterTokens({ scene, origin, count: entries.length });
      const tokens = encounterTokenData(entries, points, () => newId());
      return tokens.map(
        (token): Op => ({
          kind: "create",
          coll: "tokens",
          parent: { coll: "scenes", id: scene._id },
          data: token,
        }),
      );
    },
    // ── the clock (§5.5) ─────────────────────────────────────────────────────────────────────
    //
    // One integral clock, in seconds, and every subsystem spends it: a round is `secondsPerRound`,
    // an hour 600 rounds, a day 14 400. "Three days pass" is therefore one call, and the sweep that
    // ends clock-counted effects rides in the same envelope — which is exactly what the Settings
    // window's buttons do, and the reason an agent's "a night passes" is indistinguishable from
    // the GM clicking *day*.
    clock(): AgentClock {
      const settingsDocs = store.getAll("settings");
      const settings = coreWorldSettingsFrom(settingsDocs);
      const seconds = readWorldClock(settingsDocs);
      // Day and night come from the active scene's dawn/dusk window when it names one: a world can
      // be lit by two scenes at once, and the one on screen is the one the party is standing in.
      const tod = timeOfDay(seconds, daylightOf(pick(null)));
      return {
        seconds,
        stamp: formatWorldClock(seconds),
        hour: tod.hour,
        minute: tod.minute,
        phase: tod.phase,
        day: tod.day,
        label: tod.label,
        secondsPerRound: secondsPerRoundOf(settings),
        advanceOnRound: advanceClockOnRoundOf(settings),
      };
    },
    timeOps(spec): AgentTimeOps | { error: string } {
      const settingsDocs = store.getAll("settings");
      const settings = coreWorldSettingsFrom(settingsDocs);
      const spr = secondsPerRoundOf(settings);
      const current = readWorldClock(settingsDocs);
      const delta =
        typeof spec.delta === "number" && Number.isFinite(spec.delta)
          ? Math.trunc(spec.delta)
          : null;
      const absolute =
        typeof spec.seconds === "number" && Number.isFinite(spec.seconds)
          ? Math.trunc(spec.seconds)
          : null;
      if (delta === null && absolute === null) {
        return { error: "say `seconds` to set the clock, or `days`/`hours`/`rounds` to move it" };
      }
      const next = Math.max(
        0,
        absolute !== null ? absolute : current + (delta as number),
      );
      const moved = next - current;
      const ops: Op[] =
        absolute !== null ? setWorldClockOps(settingsDocs, next) : advanceWorldClockOps(settingsDocs, moved);
      // A backward jump expires nothing — a GM correcting the hour has not cast a spell backwards.
      // Forward, the sweep ends exactly what the Settings buttons would end.
      const sweep =
        moved > 0
          ? pf1eClockSweepOps(
              store.getAll("actors") as never,
              store.getAll("combats") as never,
              next,
              spr,
            )
          : { ops: [], expired: [] };
      return {
        seconds: next,
        delta: moved,
        ops: [...ops, ...(sweep.ops as unknown as Op[])],
        expired: sweep.expired.map((row) => ({
          home: row.home,
          ownerId: row.ownerId,
          effectId: row.effectId,
        })),
      };
    },

    // ── the turn tracker (§5.5) ───────────────────────────────────────────────────────────────
    //
    // The tracker is the app's own state machine (`core/combat.ts`, and PF1e's `combatState.ts`
    // over it), and these ports call it rather than reimplementing it: a surprise round, an
    // initiative tie and a dying creature's stabilization check are rules, and a connector that
    // invented its own "next turn" would be a second combat engine with no tests.
    combatState(sceneId) {
      const scene = pick(sceneId);
      if (!scene) return null;
      const combat = encounterOf(scene);
      return combat === null ? null : stateOf(combat, null, [], 0);
    },
    combatStartOps(sceneId, spec): AgentCombatTurn | { error: string } {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene here — scene.list names them" };
      const opened = openEncounter(scene, spec.name);
      if ("error" in opened) return { error: opened.error };
      const combat = opened.combat;
      if (combat.combatants.length === 0) {
        return {
          error: `${combat.name} has no combatants — combat.add names the tokens that are in it`,
        };
      }
      const actors = store.getAll("actors") as unknown as ActorDocument[];
      let next: CombatDocument;
      let note: string | null;
      if (isPf1eEncounter(combat, actors)) {
        const rolls = combat.combatants.map((member) => ({
          combatantId: member._id,
          value: spec.initiative?.[member._id] ?? member.initiative ?? null,
          dexMod: 0,
        }));
        if (rolls.some((roll) => roll.value === null)) {
          return {
            error:
              "a PF1e encounter needs an initiative for every combatant — pass them to combat.start, or set them with combat.add",
          };
        }
        const started = startWithSurprise(applyValues(combat, spec.initiative).combat, {
          initiative: rolls.map((roll) => ({ ...roll, value: roll.value as number })),
          ...(spec.unaware === undefined ? {} : { unaware: spec.unaware }),
        });
        if (started.state.ties.some((tie) => tie.resolvedBy === "reroll-needed")) {
          return {
            error:
              "initiative ties are unresolved — give one of the tied combatants a different initiative",
          };
        }
        next = started.combat;
        note =
          started.surprise?.surpriseRound === true
            ? `surprise round — ${started.surprise.aware.length} aware, ${started.surprise.flatFooted.length} caught flat-footed`
            : (started.surprise?.note ?? "round 1");
      } else {
        next = startCombat(applyValues(combat, spec.initiative).combat).combat;
        note = "round 1";
      }
      return stateOf(next, note, [...opened.ops, ...combatUpdateOps(next)], 0);
    },
    combatAddOps(sceneId, spec): AgentCombatTurn | { error: string } {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene here — scene.list names them" };
      if (spec.combatants.length === 0) {
        return { error: "combat.add needs at least one combatant" };
      }
      const opened = openEncounter(scene, spec.name);
      if ("error" in opened) return { error: opened.error };
      const combat = opened.combat;
      const tokens = (scene.tokens ?? []) as readonly TokenDocument[];
      const additions: CombatantDocument[] = spec.combatants.map((entry) => {
        const token = entry.tokenId ? tokens.find((row) => row._id === entry.tokenId) : undefined;
        const actorId = entry.actorId ?? token?.actorId ?? null;
        return {
          _id: newId(),
          type: "combatant",
          name: entry.name ?? token?.name ?? actorId ?? "combatant",
          ownership: { default: 1 },
          flags: {},
          system: {},
          tokenId: entry.tokenId ?? null,
          actorId,
          initiative:
            typeof entry.initiative === "number" && Number.isFinite(entry.initiative)
              ? Math.trunc(entry.initiative)
              : null,
          hidden: false,
          defeated: false,
        } as unknown as CombatantDocument;
      });
      const merged: CombatDocument = {
        ...combat,
        combatants: [...combat.combatants, ...additions],
      };
      return stateOf(
        merged,
        `${additions.length} combatant(s) added — ${merged.combatants.length} in the order`,
        [...opened.ops, ...combatUpdateOps(merged)],
        0,
      );
    },
    combatNextOps(sceneId, count): AgentCombatTurn | { error: string } {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene here — scene.list names them" };
      const combat = encounterOf(scene);
      if (!combat) {
        return { error: "there is no encounter on this scene — combat.start opens one" };
      }
      const steps = Math.min(Math.max(Math.trunc(count) || 1, 1), 20);
      const actors = store.getAll("actors") as unknown as ActorDocument[];
      const settingsDocs = store.getAll("settings");
      let acc = combat;
      let clockDeltaSeconds = 0;
      const dying: AgentCombatTurn["dyingChecks"] = [];
      let phase: string | null = null;
      for (let i = 0; i < steps; i++) {
        if (isPf1eEncounter(acc, actors)) {
          const result = pf1eNextTurn(acc, { actors });
          acc = result.combat;
          clockDeltaSeconds += result.clockDeltaSeconds;
          for (const check of result.dyingChecks)
            dying.push({
              combatantId: check.combatantId,
              actorId: check.actorId,
              actorName: check.actorName,
              hp: check.hp,
            });
          phase = result.state.phase;
        } else {
          acc = nextTurn(acc).combat;
        }
      }
      const settings = coreWorldSettingsFrom(settingsDocs);
      // The tracker's own rule, not ours: a round wrap moves the clock only in a world that says
      // so, and it moves it by the round the transition reports (a surprise round: not at all).
      const clockOps =
        clockDeltaSeconds > 0 && advanceClockOnRoundOf(settings)
          ? wrapAdvanceOps(settingsDocs, clockDeltaSeconds)
          : [];
      return stateOf(
        acc,
        phase === "surprise" ? "surprise round" : `round ${acc.round}`,
        [...combatUpdateOps(acc), ...clockOps],
        clockOps.length > 0 ? clockDeltaSeconds : 0,
        dying,
      );
    },
    combatEndOps(sceneId): AgentCombatTurn | { error: string } {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene here — scene.list names them" };
      const combat = encounterOf(scene);
      if (!combat) {
        return { error: "there is no encounter on this scene — combat.start opens one" };
      }
      const ended = endCombat(combat).combat;
      return stateOf(ended, "combat ended", combatUpdateOps(ended), 0);
    },
    // ── dice (§5.5) ──────────────────────────────────────────────────────────────────────────
    //
    // Dice are the host's, and that is the whole design: the formula travels out, the number comes
    // back from the host's own RNG through the commit-reveal path, and the card it commits is a
    // document on the replica. So these two are **async** where every other tool is not — and they
    // are the only two that ask the host for something instead of submitting ops for it. An agent
    // that could roll its own dice could quietly roll again until it liked the answer.
    async diceRoll(spec): Promise<AgentDiceRoll | { error: string }> {
      const mode = ROLL_MODES.has(spec.mode ?? "roll") ? (spec.mode ?? "roll") : "roll";
      const rollId = await client.rollVerified(
        spec.formula,
        mode as "roll" | "gmroll" | "blindroll" | "selfroll",
        spec.to,
        spec.flavor,
      );
      // The host commits a card carrying this id; the wait is the price of the number being the
      // host's rather than ours, and a timeout is a refusal an agent can route around.
      const answered = await waitForDoc(() => rollCardOf(rollId) !== null);
      if (!answered) {
        return {
          error: `the host did not answer the roll of ${spec.formula} — try again, or chat.post the result you need`,
        };
      }
      const card = rollCardOf(rollId) as unknown as MessageDocument | null;
      if (!card) return { error: `the host did not answer the roll of ${spec.formula}` };
      const roll = (card.roll ?? null) as { total?: unknown; terms?: unknown } | null;
      return {
        messageId: card._id,
        formula: spec.formula,
        total: typeof roll?.total === "number" ? roll.total : 0,
        terms: Array.isArray(roll?.terms) ? (roll?.terms as Json[]) : [],
        mode,
        to: [...(card.whisper ?? [])],
        flavor: card.flavor ?? null,
      };
    },
    async diceApply(spec): Promise<AgentDiceApply | { error: string }> {
      const card = store.get("messages", spec.messageId) as unknown as
        | MessageDocument
        | undefined;
      if (!card) {
        return { error: `no message "${spec.messageId}" — chat.read names the cards you may see` };
      }
      const actor = store.get("actors", spec.actorId) as unknown as ActorDocument | undefined;
      if (!actor) {
        return { error: `no actor "${spec.actorId}" — document.list actors names them` };
      }
      const total = typeof card.roll?.total === "number" ? card.roll.total : null;
      if (total === null) {
        return { error: `that card carries no rolled total — dice.roll makes one` };
      }
      const before = hpOf(actor);
      // No amount travels: the host re-reads the card's own total and decides, exactly as the chat
      // card's *Apply* button does. The number above is only for reporting what the host did.
      client.rollApply(spec.messageId, spec.actorId, spec.mode);
      // Re-read the card each poll: the store hands out a new document when the host updates it,
      // so a captured one would wait forever for a flag that has already landed.
      const done = await waitForDoc(() => {
        const now = store.get("messages", spec.messageId);
        return now === undefined
          ? false
          : readRollApplications(now)[spec.actorId]?.[spec.mode] !== undefined;
      });
      if (!done) {
        return {
          error: `the host did not apply ${spec.mode} from "${spec.messageId}" — it may have been refused, or the card already counted against ${actor.name}`,
        };
      }
      const after = hpOf(store.get("actors", spec.actorId) as unknown as ActorDocument | undefined);
      return {
        messageId: spec.messageId,
        actorId: spec.actorId,
        actorName: actor.name,
        mode: spec.mode,
        amount: total,
        hpBefore: before,
        hpAfter: after,
        note: null,
      };
    },
    // ── fog (§5.5) ───────────────────────────────────────────────────────────────────────────
    //
    // The manual mask is a log of strokes on the scene (`flags.core.fogMask`), and the hexcrawl's
    // open cells are the profile's own list. Painting one and opening the other are the same act to
    // a GM — "show them the clearing" — so a cell edit does both, and the geometry (a cell is a
    // hexagon on a hex grid and a square on a square one) is the app's to build, not the agent's
    // to guess.
    fogState(sceneId): AgentFogState | null {
      const scene = pick(sceneId);
      if (!scene) return null;
      const settings = sceneFogSettings(scene);
      const log = fogMaskLog(scene);
      const cells = cellsOf(scene);
      return {
        sceneId: scene._id,
        sceneName: scene.name,
        enabled: settings.enabled,
        rangeSquares: settings.rangeSquares,
        revealStrokes: log.filter((op) => op.mode === "reveal").length,
        hideStrokes: log.filter((op) => op.mode === "hide").length,
        cellsRevealed: cells.length > 0 ? openCellKeys(scene).size : null,
        cellsTotal: cells.length > 0 ? cells.length : null,
      };
    },
    fogOps(sceneId, spec): AgentFogOps | { error: string } {
      const scene = pick(sceneId);
      if (!scene) return { error: "there is no scene here — scene.list names them" };
      const polys: number[][] = [];
      // Every branch assigns; the error returns are the ones that never reach the write.
      let what: string;
      if (spec.all === true) {
        polys.push(sceneRectPoly(scene));
        what = `the whole of ${scene.name}`;
      } else if (spec.rect !== undefined) {
        const rect = spec.rect;
        if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) {
          return { error: "`rect` is four numbers — [x1, y1, x2, y2] in world units" };
        }
        const [x1, y1, x2, y2] = [rect[0] as number, rect[1] as number, rect[2] as number, rect[3] as number];
        polys.push([x1, y1, x2, y1, x2, y2, x1, y2]);
        what = `the rectangle ${x1},${y1} → ${x2},${y2}`;
      } else if (spec.poly !== undefined) {
        const poly = spec.poly;
        if (poly.length < 6 || poly.length % 2 !== 0 || poly.some((n) => !Number.isFinite(n))) {
          return {
            error: "`poly` is a flat list of at least three points — [x1, y1, x2, y2, x3, y3]",
          };
        }
        polys.push([...poly]);
        what = `a ${poly.length / 2}-sided polygon`;
      } else if (spec.cells !== undefined) {
        if (spec.cells.length === 0) {
          return { error: "name at least one cell, or paint the whole scene with `all`" };
        }
        for (const key of spec.cells) {
          const poly = cellPolygonOf(scene, key);
          if (!poly) {
            return {
              error: `"${key}" is not a cell of ${scene.name} — hexcrawl.cells names them`,
            };
          }
          polys.push(poly);
        }
        what = `${spec.cells.length} cell(s)`;
      } else {
        return {
          error: "say what to paint — `cells`, a `rect`, a `poly`, or `all` for the whole scene",
        };
      }
      const ops: Op[] = [];
      let working = scene;
      if (spec.cells !== undefined && cellsOf(scene).length > 0) {
        // A cell edit is two records at once: the mask the players' canvas paints, and the hex
        // list the tools read. Doing one without the other is how a map ends up open on one
        // screen and shut on another.
        const cellOps = revealCellsOps(
          scene,
          spec.mode === "reveal" ? spec.cells : [],
          spec.mode === "hide" ? spec.cells : [],
        );
        ops.push(...cellOps);
        // Both writes replace the whole `flags` object (D-012: a flat diff cannot create the
        // intermediates), so the second must be built from the document the first produced —
        // otherwise the mask stroke quietly erases the reveal it was painted beside.
        for (const op of cellOps) {
          if (op.kind !== "update") continue;
          const flags = (op.diff as Record<string, unknown> | undefined)?.["flags"];
          if (flags !== undefined && flags !== null)
            working = { ...working, flags: flags as SceneDocument["flags"] };
        }
      }
      let log = fogMaskLog(working);
      for (const poly of polys) log = appendFogMask(log, { mode: spec.mode, poly });
      ops.push(...fogMaskOps(working, log));
      return {
        sceneId: scene._id,
        sceneName: scene.name,
        mode: spec.mode,
        ops,
        strokes: polys.length,
        what,
        cells: spec.cells === undefined ? [] : [...spec.cells],
      };
    },
    // ── the strategic layer (§5.6) ───────────────────────────────────────────────────────────
    //
    // Armies, units and factions are documents, and orders are an ordinary embedded update — so
    // this layer is the least exotic in the catalogue. What it adds is the pool: a unit's *models*
    // are columns in the §5A replica, so "how many are still standing" and "where are they" are
    // read off the pool rather than off the document, which only ever names a range.
    strategicSnapshot(): AgentStrategicSnapshot {
      const armies = store.getAll("armies") as unknown as ArmyDocument[];
      const factions = store.getAll("factions") as unknown as FactionDocument[];
      const turns = store.getAll("turns") as unknown as TurnDocument[];
      const turn = turns[0] ?? null;
      const pool = client.simReplica;
      const rows: AgentUnitRow[] = [];
      const armyRows = armies.map((army) => {
        const faction = army.factionId
          ? factions.find((row) => row._id === army.factionId)
          : undefined;
        for (const unit of army.units ?? []) rows.push(unitRow(army, unit, pool));
        return {
          id: army._id,
          name: army.name,
          factionId: army.factionId ?? null,
          factionName: faction?.name ?? null,
          factionColor: faction?.color ?? null,
          commanders: (army.commander ?? []).length,
          units: (army.units ?? []).length,
          supply: Object.keys(army.supply ?? {}),
        };
      });
      return {
        armies: armyRows,
        units: rows,
        factions: factions.map((faction) => ({
          id: faction._id,
          name: faction.name,
          color: faction.color,
          allies: (faction.allies ?? []).length,
        })),
        turn: turn
          ? {
              id: turn._id,
              number: turn.number,
              phase: turn.phase,
              mode: turn.mode,
              sceneId: turn.sceneId ?? null,
              readyUsers: (turn.readyUsers ?? []).length,
            }
          : null,
        models: pool?.count ?? null,
      };
    },
    strategicReport(): AgentStrategicReport | null {
      const last = client.lastTurnReport;
      if (!last) return null;
      const report = last.report;
      return {
        turnId: last.turnId,
        turn: report.turn,
        sceneId: report.sceneId ?? null,
        subPhases: [...report.subPhases],
        // Every event, but only the fields an agent reads: the model indices a 10k-model battle
        // reports are not an answer, they are a second copy of the pool.
        events: report.events.map((event) => ({
          subPhase: event.subPhase,
          type: event.type,
          unitId: event.unitId,
          text: event.text,
        })),
        summary: { ...report.summary },
        rulesVersion: report.rulesVersion,
      };
    },
    strategicOrderOps(spec): AgentStrategicOrders | { error: string } {
      if (spec.orders.length === 0) {
        return { error: "strategic.order needs at least one order" };
      }
      const armies = store.getAll("armies") as unknown as ArmyDocument[];
      const turns = store.getAll("turns") as unknown as TurnDocument[];
      const issuedTurn = turns[0]?.number ?? 0;
      const issuedBy = client.user?.id ?? "";
      const ops: Op[] = [];
      const issued: AgentStrategicOrders["issued"] = [];
      const missing: string[] = [];
      for (const request of spec.orders) {
        let found: { army: ArmyDocument; unit: UnitDocument } | null = null;
        for (const army of armies) {
          const unit = (army.units ?? []).find((row) => row._id === request.unitId);
          if (!unit) continue;
          if (request.armyId !== undefined && request.armyId !== army._id) continue;
          found = { army, unit };
          break;
        }
        if (!found) {
          missing.push(request.unitId);
          continue;
        }
        const built = buildOrder(request);
        if ("error" in built) return { error: built.error };
        issued.push({
          unitId: found.unit._id,
          armyId: found.army._id,
          kind: built.kind,
          unitName: found.unit.name,
        });
        ops.push({
          kind: "update",
          ref: {
            coll: "units",
            id: found.unit._id,
            parent: { coll: "armies", id: found.army._id },
          },
          diff: {
            "orders.pending": [built.order as unknown as Json],
            "orders.issuedBy": issuedBy,
            "orders.issuedTurn": issuedTurn,
          },
        });
      }
      if (ops.length === 0) {
        return {
          error: `no unit on this replica answers to ${missing.join(", ")} — strategic.snapshot names the ones you may see`,
        };
      }
      return { ops, issued, missing, issuedTurn };
    },
    tokenCreate(spec): Op | { error: string } {
      const scene = scenes().find((row) => row._id === spec.sceneId);
      if (!scene) {
        return {
          error: `no scene "${spec.sceneId}" — scene.list names the ones you may see`,
        };
      }
      const size = scene.grid.size > 0 ? scene.grid.size : 100;
      const cols = Math.max(1, Math.floor(scene.width / size));
      const rows = Math.max(1, Math.floor(scene.height / size));
      if (spec.col < 0 || spec.col >= cols || spec.row < 0 || spec.row >= rows) {
        return {
          error: `cell ${spec.col},${spec.row} is off ${scene.name} — it is ${cols}×${rows} cells`,
        };
      }
      // The app's own token (D-061: the table may see and move it), centred on the cell the way
      // `token.move` and the encounter placement both centre. Built here rather than in core
      // because the shape — vision, light, ownership defaults — is the app's, and a second builder
      // would drift from `makeToken`.
      const token: TokenDocument = {
        ...makeToken(newId(), (spec.col + 0.5) * size, (spec.row + 0.5) * size, spec.name),
        ...(spec.actorId === null || spec.actorId === undefined
          ? {}
          : { actorId: spec.actorId }),
      };
      return {
        kind: "create",
        coll: "tokens",
        parent: { coll: "scenes", id: scene._id },
        data: token,
      };
    },
  };

  thisView = view;
  return view;
}

/** The connect URL, with the pairing token in the query the sidecar checks on upgrade. */
export function agentLinkUrl(base: string, token: string): string {
  const url = new URL(base);
  if (url.pathname === "/") url.pathname = "/bridge";
  url.searchParams.set("token", token);
  return url.toString();
}

export interface ConnectAgentBridgeOptions extends AgentWorldViewOptions {
  /** e.g. `ws://127.0.0.1:8787` — the sidecar prints this when it starts. */
  url: string;
  /** The one-time pairing token the sidecar printed. */
  token: string;
  client: ClientSync;
  grant: AgentGrant;
  /**
   * The agent's own write port (§6.2). **Absent means read-only** — the bridge will answer every
   * write tool with "this connection cannot write" rather than pretending the verb is broken.
   */
  writer?: AgentWriter | undefined;
  /** The user id the writes are attributed to; what `whoami` reports as the agent's own. */
  agentId?: string | null | undefined;
  onStatus?: (status: AgentLinkStatus) => void;
}

export function connectAgentBridge(
  options: ConnectAgentBridgeOptions,
): AgentBridge {
  const { url, token, client, grant, onStatus } = options;
  const transport = createAgentLink(
    onStatus === undefined
      ? { url: agentLinkUrl(url, token) }
      : { url: agentLinkUrl(url, token), onStatus },
  );
  return createAgentBridge({
    transport,
    view: agentWorldView(client, options),
    grant,
    // Phase 2: when the bridge belongs to an agent's own session, that session's writer and id
    // come along, so writes are attributed and the reads are the agent's projection.
    ...(options.writer ? { writer: options.writer } : {}),
    agentId: options.agentId ?? null,
  });
}
