import {
  STRATEGIC_CODEC,
  type Head,
  type ReportRow,
  type RoomOrder,
} from "../../../src/core/strategicRoom/protocol";
import { decodeSimSnapshot, poolFromSnapshot } from "../../../src/sim/codec";
import { PF1E_MODEL_SCHEMA } from "../../../src/packages/pf1e/schema";
import type { SpellHazard } from "../../../src/core/strategicRoom/hazardAvoidance";
import type { ActionCard } from "../../../src/core/action";
import type { Scenario, UnitState } from "./scenario";

export type Member = {
  id: string;
  /** GM-assigned label; absent on plain test fixtures and older callers. */
  name?: string;
  role: "GM" | "PLAYER";
  factionId: string | null;
  epoch: number;
};
export type FrozenOrder = {
  unitId: string;
  memberId: string;
  order: RoomOrder;
};
/**
 * Commander slot → the units that seat may order. A missing key or `null` means the seat's
 * own deployment; an empty array means explicitly no units. Frozen with each publication.
 */
export type Control = Record<string, string[] | null>;
export type MemberRecord = {
  id: string;
  name: string;
  role: Member["role"];
  factionId: string | null;
  /** Units the seat may order now. */
  units: string[];
  /** Every unit in the seat's own deployment, granted or not. */
  deployed: string[];
  claimed: boolean;
  /** GM-only recoverable invite code, or null when no active invite can be resent. */
  invite: string | null;
};
export type Published = {
  version: number;
  bytes: Uint8Array;
  maxHpMax: number;
  hash: string;
  units: UnitState[];
  /** Areas created during hosted play; authored launch areas remain in Scenario. */
  hazards?: SpellHazard[];
  /** Bounded shared action evidence created by hosted authoritative resolution. */
  actions?: ActionCard[];
  control?: Control;
};
export type Frozen = {
  turnId: number;
  seed: number;
  orders: FrozenOrder[];
  start: Published;
  scenario: Scenario;
};
export type OutcomeRow = ReportRow & { memberId: string };
export type Result = {
  state: Published;
  rows: OutcomeRow[];
  report: Uint8Array;
  metrics: { resolveMs: number; rulesMs: number; artifactMs: number };
};
export type RoomRecord = Head & { generation: number; members: number };

export function checkpointPool(state: Published) {
  const frame = decodeSimSnapshot(state.bytes, STRATEGIC_CODEC);
  if (
    frame.snapshot.version !== state.version ||
    frame.maxHpMax !== state.maxHpMax
  )
    throw new Error("Invalid checkpoint metadata.");
  return poolFromSnapshot(frame.snapshot, frame.maxHpMax, PF1E_MODEL_SCHEMA);
}

export function publicHead(room: RoomRecord): Head {
  const { turnId, version, phase, deadlineMs, members } = room;
  return { turnId, version, phase, deadlineMs, members };
}
