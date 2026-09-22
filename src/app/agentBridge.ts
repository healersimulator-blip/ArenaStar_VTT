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
  CollectionName,
  Json,
  MessageDocument,
  SceneDocument,
  TokenDocument,
} from "../core/documents";
import { TOP_LEVEL_COLLECTIONS } from "../core/documents";
import type {
  AgentBestiaryHit,
  AgentCompendiumEntry,
  AgentDocument,
  AgentImportPlan,
  AgentMessageRow,
  AgentPackageRow,
  AgentSceneDetail,
  AgentSceneSummary,
  AgentSheet,
  AgentTokenRow,
  AgentWorldView,
  PageOptions,
} from "../core/agents/types";
import type { Op } from "../core/ops";
import { cellAtPoint, parseCellKey } from "../core/hexcrawl/cells";
import { paginate } from "../core/agents/paging";
import type { AgentGrant } from "../core/agents/capabilities";
import type { AgentWriter } from "../core/agents/types";
import { createAgentBridge, type AgentBridge } from "../core/agents/bridge";
import { readWorldClock } from "../packages/pf1e/worldClock";
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
 * The world as this tab holds it. Counts are non-empty collections only: an agent asking what the
 * world *is* wants to know it has 3 scenes and 41 actors, not that it has zero depots.
 */
export function agentWorldView(
  client: ClientSync,
  options: AgentWorldViewOptions = {},
): AgentWorldView {
  const store = client.store;
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
