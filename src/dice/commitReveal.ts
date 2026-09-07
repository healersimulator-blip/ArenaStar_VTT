/**
 * §11 commit-reveal rolls — Blum-style two-party fairness for chat dice.
 *
 *   1. CLIENT picks seed_c and sends H(seed_c) (the commitment) with the roll.
 *   2. HOST answers with seed_h — chosen BEFORE seeing seed_c, so the host
 *      cannot grind the outcome.
 *   3. CLIENT reveals seed_c; the host verifies H(seed_c) equals the
 *      commitment and derives the result deterministically from BOTH seeds.
 *
 * The RollRecord stores seed_c, seed_h and the commitment, so anyone can
 * re-derive the total later (`verifyCommitRoll`) — provably fair dice.
 */
import { evaluateFormula } from "./engine";
import type { RollEvaluation } from "./engine";
import type { Json } from "../core/documents";
import { XoshiroPRNG } from "../sim/prng";
import type { Result } from "../core/result";
import { err, okVal } from "../core/result";

/** 16 random bytes, hex-encoded (128 bits of entropy). */
export function randomSeedHex(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** First 4 bytes of SHA-256(`${seed_c}:${seed_h}`) as a uint32 PRNG seed. */
export async function deriveSeed32(seedClient: string, seedHost: string): Promise<number> {
  const hex = await sha256Hex(`${seedClient}:${seedHost}`);
  return Number.parseInt(hex.slice(0, 8), 16) >>> 0;
}

/** Deterministic evaluation of a formula from a seed pair. */
export async function evaluateCommitRoll(
  formula: string,
  seedClient: string,
  seedHost: string,
  rollData?: Record<string, Json>,
): Promise<Result<RollEvaluation>> {
  const seed = await deriveSeed32(seedClient, seedHost);
  const prng = new XoshiroPRNG(seed);
  return evaluateFormula(formula, rollData, () => prng.nextFloat());
}

export interface CommitRollRecord {
  formula: string;
  total: number;
  seedClient: string | null;
  seedHost: string | null;
  commit?: string | null;
}

/**
 * Full verification: the revealed seed matches the recorded commitment, and
 * re-deriving the roll from (seed_c, seed_h) reproduces the recorded total.
 */
export async function verifyCommitRoll(
  record: CommitRollRecord,
): Promise<Result<{ total: number }>> {
  const { formula, total, seedClient, seedHost, commit } = record;
  if (!seedClient || !seedHost || !commit) {
    return err("roll is not commit-reveal (missing seeds/commit)");
  }
  if ((await sha256Hex(seedClient)) !== commit) {
    return err("commitment mismatch: H(seedClient) ≠ recorded commit");
  }
  const rederive = await evaluateCommitRoll(formula, seedClient, seedHost);
  if (!rederive.ok) return err(`cannot re-derive: ${rederive.error}`);
  if (rederive.value.total !== total) {
    return err(`total mismatch: recorded ${total}, re-derived ${rederive.value.total}`);
  }
  return okVal({ total });
}
