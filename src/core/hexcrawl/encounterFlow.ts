/**
 * **The encounter engine's flow** (D-273, plan §6) — the half of the encounter engine that turns a
 * *trigger* into something the table sees: the decision, the draw, the ledger write and the two
 * chat cards. Pure and DOM-free, like the rest of `core/hexcrawl`, so the trigger wiring in the
 * shells is a call and the interesting behaviour is unit-testable.
 *
 * Three rules from §6 live here and nowhere else:
 *
 * 1. **Eligibility is by attachment and by tag.** Only the tables a cell actually names are
 *    candidates (`cell.tables`), and `eligibleTables` then filters them by the trigger and the
 *    clock's phase. A table with no ladder space, or on cooldown, is not eligible.
 * 2. **A firing is written to the ledger, a *prompt* is not.** `ledgerOps` records
 *    `flags.core.encounters[tableId] = clockSeconds` on the cell when a table actually rolls — that
 *    is what the cooldown reads back, and it is replicated, so two GMs cannot double-fire. A
 *    `prompt` (or a `manual` mode decision) writes **nothing**: the table has not fired, and
 *    marking it as fired would silently swallow the rest of the phase.
 * 3. **A public card never carries what a player may not read.** When the scene's
 *    `encounterAnnounce` is `"hidden"`, the public result card's payload has no creature text and
 *    no refs at all — not a blanked-out field, an absent one — because a payload is part of the
 *    document a player's replica holds. (D-271's rule, one document type over.)
 *
 * The cards themselves are `MessageDocument`s: a `prompt` is whispered to the GM user ids, so
 * `core/projection.ts` omits it from every player's snapshot, and a result is public or GM-only
 * per the mode. That is the whole "GM-only pending message" mechanism — no new wire, no new
 * collection, and the chat log is the audit trail §6 rule 5 asks for.
 */
import type {
  CellDocument,
  EncounterTableDocument,
  EncounterTags,
  MessageDocument,
  SceneDocument,
} from "../documents";
import type { Op } from "../ops";
import { cellByKey } from "./cells";
import {
  cooldownRemaining,
  drawEncounter,
  encounterDecision,
  encounterPhase,
  lastFiredAt,
  ledgerOps,
  readLedger,
  type EncounterNoneReason,
  type EncounterRoll,
  type EncounterTrigger,
  type RngFn,
} from "./encounter";
import { encounterTagsOf } from "./tables";
import type { ClockPhase } from "../clock";
import { hexcrawlProfileOf } from "./types";

/**
 * What *Explore this hex* costs on the world clock: one hour of looking around, the same unit the
 * terrain ladder and the march speed are written in. One constant, so the time a player pays and
 * the ledger's reading cannot drift apart.
 */
export const EXPLORE_SECONDS = 3600;

/** The world-clock reading as a plain number (same clamp `validateWorldSettingsPatch` enforces). */
export function hexcrawlClockSeconds(settings: {
  clockSeconds?: number;
}): number {
  const v = settings.clockSeconds;
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.min(3_153_600_000, Math.max(0, Math.trunc(v)));
}

// ─── the check ───────────────────────────────────────────────────────────────

export interface EncounterCheckInput {
  scene: SceneDocument;
  /** Every table in the world; the cell's own list does the filtering. */
  tables: readonly EncounterTableDocument[];
  cellKey: string;
  trigger: EncounterTrigger;
  clockSeconds: number;
  rng?: RngFn;
}

export type EncounterAction = "none" | "roll" | "prompt" | "manual";

export interface EncounterCheck {
  action: EncounterAction;
  /** The reading this check was made at — what a card records and a ledger writes. */
  clockSeconds: number;
  /** Why nothing happened, when nothing did (`none-eligible`, `no-tables`, …). */
  reason: EncounterNoneReason | null;
  cellKey: string;
  trigger: EncounterTrigger;
  phase: ClockPhase;
  /** The attached tables that *would* fire now — what a prompt lists and a manual roll offers. */
  eligible: EncounterTableDocument[];
  /** Set when `action === "roll"`. */
  table: EncounterTableDocument | null;
  roll: EncounterRoll | null;
  /** The ledger write. Empty for every action except `roll` — a prompt fires nothing. */
  ops: Op[];
}

/**
 * What a trigger does *now*, at this reading of the clock. The caller submits `ops`; nothing here
 * touches a store, a window or the bus.
 */
export function encounterCheck(input: EncounterCheckInput): EncounterCheck {
  const rng = input.rng ?? Math.random;
  const phase = encounterPhase(input.clockSeconds, input.scene);
  const attached = new Set(cellByKey(input.scene, input.cellKey)?.tables ?? []);
  const tables = input.tables.filter((t) => attached.has(t._id));
  const decision = encounterDecision({
    scene: input.scene,
    tables,
    cellKey: input.cellKey,
    trigger: input.trigger,
    clockSeconds: input.clockSeconds,
    fired: readLedger(input.scene),
    rng,
  });

  const base = {
    cellKey: input.cellKey,
    trigger: input.trigger,
    phase,
    clockSeconds: input.clockSeconds,
  };

  switch (decision.kind) {
    case "none":
      return {
        ...base,
        action: "none",
        reason: decision.reason,
        eligible: [],
        table: null,
        roll: null,
        ops: [],
      };
    case "manual":
      return {
        ...base,
        action: "manual",
        reason: null,
        eligible: decision.tables,
        table: null,
        roll: null,
        ops: [],
      };
    case "prompt":
      return {
        ...base,
        action: "prompt",
        reason: null,
        eligible: decision.tables,
        table: null,
        roll: null,
        ops: [],
      };
    case "roll": {
      const table = decision.table;
      const roll = drawEncounter(table, rng);
      return {
        ...base,
        action: "roll",
        reason: null,
        eligible: decision.tables,
        table,
        roll,
        // The firing is real: the cooldown starts here, at this reading.
        ops: ledgerOps(input.scene, input.cellKey, [
          { tableId: table._id, atClock: input.clockSeconds },
        ]),
      };
    }
  }
}

export interface RollTableInput {
  scene: SceneDocument;
  table: EncounterTableDocument;
  cellKey: string;
  clockSeconds: number;
  rng?: RngFn;
}

/**
 * Roll one named table **by hand** — the prompt card's *Roll* button and the hex window's row
 * buttons. Same draw, same ledger write as `auto`; the only difference is who asked.
 */
export function rollTableNow(input: RollTableInput): {
  roll: EncounterRoll;
  ops: Op[];
} {
  const roll = drawEncounter(input.table, input.rng ?? Math.random);
  return {
    roll,
    ops: ledgerOps(input.scene, input.cellKey, [
      { tableId: input.table._id, atClock: input.clockSeconds },
    ]),
  };
}

/**
 * How long until this table may fire again *in this cell* — the hex window's cooldown line and the
 * "why did nothing happen" answer. `0` = ready now.
 */
export function readyIn(input: {
  scene: SceneDocument;
  table: EncounterTableDocument;
  cellKey: string;
  clockSeconds: number;
}): number {
  return cooldownRemaining(
    input.table,
    {
      cellKey: input.cellKey,
      clockSeconds: input.clockSeconds,
      fired: readLedger(input.scene),
    },
    hexcrawlProfileOf(input.scene)?.daylight ?? { dawnHour: 6, duskHour: 18 },
  );
}

/** The clock reading this table last fired at in this cell (`null` = never). */
export function firedAtIn(input: {
  scene: SceneDocument;
  tableId: string;
  cellKey: string;
}): number | null {
  return lastFiredAt(readLedger(input.scene), input.cellKey, input.tableId);
}

/** `2h 30m` / `1d 4h` — the cooldown line the hex window shows. */
export function formatCooldown(seconds: number): string {
  if (seconds <= 0) return "ready";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ─── the cards ───────────────────────────────────────────────────────────────

/** One candidate as the prompt card lists it (JSON-safe: it is stored in `message.system`). */
export interface EncounterCandidate {
  id: string;
  name: string;
  tags: EncounterTags;
}

export interface EncounterCardRoll {
  tableId: string;
  tableName: string;
  die: number;
  roll: number;
  formula: string;
  /** The entry's text — **absent** on a public card when the scene hides names. */
  text?: string;
  count?: number;
  /** **Absent** on a public card when the scene hides names. */
  refs?: EncounterRoll["refs"];
}

/** The payload a chat card carries under `message.system.encounter`. */
export interface EncounterCardPayload {
  kind: "prompt" | "result";
  sceneId: string;
  cellKey: string;
  trigger: EncounterTrigger;
  phase: ClockPhase;
  clockSeconds: number;
  /** Prompt: the candidates. Result: the table that fired. */
  candidates: EncounterCandidate[];
  /** Result only. */
  roll?: EncounterCardRoll;
  /** GM-only result (mode `prompt`/`manual`) — the card says so on its face. */
  gmOnly?: boolean;
  /** True once a prompt has been answered, so it is never offered twice. */
  answered?: boolean;
  /** The roll that answered it (audit). */
  answeredRoll?: number;
}

export function encounterCandidate(
  table: EncounterTableDocument,
): EncounterCandidate {
  return { id: table._id, name: table.name, tags: encounterTagsOf(table) };
}

const TRIGGER_LABEL: Record<EncounterTrigger, string> = {
  entering: "entering",
  moving: "moving through",
  exploring: "exploring",
  fighting: "fighting here",
};

/** `Encounter check — hex 3,2 · entering · night`. */
export function encounterCardTitle(payload: EncounterCardPayload): string {
  return `hex ${payload.cellKey} · ${TRIGGER_LABEL[payload.trigger]} · ${payload.phase}`;
}

export interface EncounterMessageInput {
  payload: EncounterCardPayload;
  authorId: string;
  /** Whisper recipients; empty = public. */
  whisper: readonly string[];
  roll?: EncounterRoll | null;
  rollMode?: "roll" | "gmroll" | "blindroll";
}

/** The document one card is. `_id`/`name`/`ownership`/`flags` are the store's common fields. */
export function encounterCardMessage(
  input: EncounterMessageInput,
): MessageDocument {
  const { payload } = input;
  const content =
    payload.kind === "prompt"
      ? `Encounter check — ${encounterCardTitle(payload)}: ${
          payload.candidates.length === 1
            ? `**${payload.candidates[0]?.name ?? ""}** may fire.`
            : `${payload.candidates.length} tables may fire.`
        }`
      : `Encounter — ${encounterCardTitle(payload)}: ${payload.roll?.tableName ?? ""}${
          payload.roll?.text ? ` — ${payload.roll.text}` : ""
        }`;
  return {
    _id: globalThis.crypto.randomUUID(),
    type: "message",
    name: `Encounter ${payload.cellKey}`.slice(0, 40),
    ownership: { default: 1 },
    flags: {},
    system: { encounter: payload as unknown as Record<string, never> },
    author: input.authorId,
    content,
    whisper: [...input.whisper],
    roll: input.roll
      ? {
          formula: input.roll.formula,
          total: input.roll.roll,
          terms: [],
          seedClient: null,
          seedHost: null,
        }
      : null,
    ...(input.rollMode ? { rollMode: input.rollMode } : {}),
    flavor: "encounter",
  };
}

export interface PromptMessageInput {
  scene: SceneDocument;
  check: EncounterCheck;
  authorId: string;
  /** The GM user ids the card is whispered to — the whole GM-only mechanism. */
  gmIds: readonly string[];
}

/** The GM-only pending card for a `prompt` (or a tie): every candidate, in authored order. */
export function encounterPromptMessage(
  input: PromptMessageInput,
): MessageDocument {
  return encounterCardMessage({
    payload: {
      kind: "prompt",
      sceneId: input.scene._id,
      cellKey: input.check.cellKey,
      trigger: input.check.trigger,
      phase: input.check.phase,
      clockSeconds: input.check.clockSeconds,
      candidates: input.check.eligible.map(encounterCandidate),
      // A prompt *is* GM-only: it is whispered to the GM ids, and the card says so. The whisper
      // is the enforcement (`core/projection.ts` drops it for everyone else); this is the label.
      gmOnly: true,
    },
    authorId: input.authorId,
    whisper: input.gmIds,
  });
}

export interface ResultMessageInput {
  scene: SceneDocument;
  cellKey: string;
  trigger: EncounterTrigger;
  phase: ClockPhase;
  clockSeconds: number;
  table: EncounterTableDocument;
  roll: EncounterRoll;
  authorId: string;
  gmIds: readonly string[];
  /** `true` for a roll the GM made by hand: GM-only, and never public even if the whisper fails. */
  gmOnly: boolean;
  /** `false` when the scene hides creature names from the public card. */
  announceNames: boolean;
}

/**
 * The card a roll leaves behind. **A public card with `announceNames: false` carries no text and
 * no refs** — the payload is narrowed, not blanked, because a document a player receives is a
 * document a player can read.
 */
export function encounterResultMessage(
  input: ResultMessageInput,
): MessageDocument {
  const publicCard = !input.gmOnly;
  const withNames = publicCard ? input.announceNames : true;
  const roll: EncounterCardRoll = {
    tableId: input.roll.tableId,
    tableName: input.roll.tableName,
    die: input.roll.die,
    roll: input.roll.roll,
    formula: input.roll.formula,
    ...(withNames
      ? {
          text: input.roll.text,
          count: input.roll.count,
          refs: input.roll.refs,
        }
      : {}),
  };
  const payload: EncounterCardPayload = {
    kind: "result",
    sceneId: input.scene._id,
    cellKey: input.cellKey,
    trigger: input.trigger,
    phase: input.phase,
    clockSeconds: input.clockSeconds,
    candidates: [encounterCandidate(input.table)],
    roll,
    ...(input.gmOnly ? { gmOnly: true } : {}),
  };
  return encounterCardMessage({
    payload,
    authorId: input.authorId,
    whisper: input.gmOnly ? input.gmIds : [],
    roll: input.roll,
    rollMode: input.gmOnly ? "gmroll" : "roll",
  });
}

/** The card a prompt posts says it is a prompt; the roll that answers it says `answered`. */
export function answerPromptOps(messageId: string, roll: EncounterRoll): Op[] {
  return [
    {
      kind: "update",
      ref: { coll: "messages", id: messageId },
      diff: {
        "system.encounter.answered": true,
        "system.encounter.answeredRoll": roll.roll,
      },
    },
  ];
}

/** Read the encounter payload off a message (`null` for every other kind of message). */
export function encounterPayloadOf(
  message: Pick<MessageDocument, "system"> | null | undefined,
): EncounterCardPayload | null {
  const raw = message?.system?.["encounter"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as unknown as EncounterCardPayload;
  if (payload.kind !== "prompt" && payload.kind !== "result") return null;
  return payload;
}

/**
 * An **unanswered** prompt for this cell, if one is already in the log. The engine asks before
 * posting: walking around inside a hex must not stack identical GM cards, and once the GM has
 * rolled the ledger's cooldown is what keeps the table quiet — so only the *open* case dedupes.
 */
export function openPromptFor(
  messages: readonly MessageDocument[],
  sceneId: string,
  cellKey: string,
): MessageDocument | null {
  for (const message of messages) {
    const payload = encounterPayloadOf(message);
    if (!payload || payload.kind !== "prompt") continue;
    if (payload.sceneId !== sceneId || payload.cellKey !== cellKey) continue;
    if (payload.answered === true) continue;
    return message;
  }
  return null;
}

/** The cell's ledger as `{ [tableId]: clockSeconds }` — the readback the tests and the panel use. */
export function ledgerOfCell(
  scene: SceneDocument,
  cellKey: string,
): Record<string, number> {
  const cell: CellDocument | null = cellByKey(scene, cellKey);
  const core = (cell?.flags as { core?: { encounters?: unknown } } | undefined)
    ?.core;
  const raw = core?.encounters;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [tableId, at] of Object.entries(raw)) {
    if (typeof at === "number" && Number.isFinite(at))
      out[tableId] = Math.trunc(at);
  }
  return out;
}
