import {
  STRATEGIC_CODEC,
  type Head,
  type ReportRow,
  type RoomOrder,
} from "../../../src/core/strategicRoom/protocol";
import { decodeSimSnapshot, poolFromSnapshot } from "../../../src/sim/codec";
import { PF1E_MODEL_SCHEMA } from "../../../src/packages/pf1e/schema";
import type { Scenario, UnitState } from "./scenario";

export type Member = {
  id: string;
  role: "GM" | "PLAYER";
  factionId: string | null;
  epoch: number;
};
export type FrozenOrder = {
  unitId: string;
  memberId: string;
  order: RoomOrder;
};
export type Published = {
  version: number;
  bytes: Uint8Array;
  maxHpMax: number;
  hash: string;
  units: UnitState[];
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
export type RoomRecord = Head & { generation: number };

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
  const { turnId, version, phase, deadlineMs } = room;
  return { turnId, version, phase, deadlineMs };
}
