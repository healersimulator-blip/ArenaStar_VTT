/**
 * MCP connector §6 — the app's half of the bridge: what the *world* looks like to a tool, and how
 * the GM's tab dials the sidecar.
 *
 * The protocol, the resources and the tool table live in `src/core/agents`; this file is only the
 * wiring, and it is deliberately thin. Two things are true of it and worth stating out loud:
 *
 * 1. **Reads are the GM's replica, not a projection.** A tool that reads the world today reads the
 *    store this tab holds. That is correct for a GM-scoped agent and wrong for a player-scoped one,
 *    which is exactly the gap Phase 3 closes by routing reads through `projectWorld()` for the
 *    agent's user and proving it field-by-field. Nothing here pretends otherwise.
 * 2. **There is no UI yet.** `connectAgentBridge` is a function, not a window: the Agents section in
 *    Settings (Phase 2) is the production entry point, and until it exists the only callers are the
 *    integration test and the e2e surface — which is how this repo already drives things it does not
 *    want reachable from a page console (D-045). A connector whose identity is the whole design does
 *    not get a global.
 */
import type { ClientSync } from "../client/sync";
import type {
  ActorDocument,
  BaseDocument,
  CollectionName,
  Json,
  SceneDocument,
  TokenDocument,
} from "../core/documents";
import { TOP_LEVEL_COLLECTIONS } from "../core/documents";
import type {
  AgentBestiaryHit,
  AgentDocument,
  AgentMessageRow,
  AgentPackageRow,
  AgentSceneDetail,
  AgentSceneSummary,
  AgentSheet,
  AgentTokenRow,
  AgentWorldView,
  PageOptions,
} from "../core/agents/types";
import { cellAtPoint, parseCellKey } from "../core/hexcrawl/cells";
import { paginate } from "../core/agents/paging";
import type { AgentGrant } from "../core/agents/capabilities";
import { createAgentBridge, type AgentBridge } from "../core/agents/bridge";
import { readWorldClock } from "../packages/pf1e/worldClock";
import { pf1eSheetView, isPF1eActor } from "../ui/sheets/pf1eSheetModel";
import { createAgentLink, type AgentLinkStatus } from "../net/agentLink";
import type { CompendiumIndex } from "../core/compendiumIndex";
import { buildCompendiumIndex, rankIndex } from "../core/compendiumIndex";

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
}

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

function tokenRowOf(scene: SceneDocument, token: TokenDocument): AgentTokenRow {
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
  };
}

function detailOf(scene: SceneDocument): AgentSceneDetail {
  return {
    ...summaryOf(scene),
    tokenRows: (scene.tokens ?? []).map((token) => tokenRowOf(scene, token)),
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

/**
 * The world as this tab holds it. Counts are non-empty collections only: an agent asking what the
 * world *is* wants to know it has 3 scenes and 41 actors, not that it has zero depots.
 */
export function agentWorldView(
  client: ClientSync,
  options: AgentWorldViewOptions = {},
): AgentWorldView {
  const store = client.store;
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

  return {
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
      return scene === null ? null : detailOf(scene);
    },
    tokens(sceneId, paging: PageOptions) {
      const scene = pick(sceneId);
      if (scene === null) return { rows: [], total: 0, next: null, cap: 0 };
      const raw = (scene.tokens ?? []).map((token) => tokenRowOf(scene, token));
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
        rows: page.rows.map((message): AgentMessageRow => ({
          id: message._id,
          author: message.author,
          authorName: users.get(message.author) ?? message.author,
          content: message.content,
          whisper: [...message.whisper],
          hasRoll: message.roll !== null,
          rollMode: message.rollMode ?? null,
        })),
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
  };
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
  });
}
