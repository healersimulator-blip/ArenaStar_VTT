/**
 * §6.1/§13 wire framing: [u8 MsgKind][msgpack payload].
 * frameMessage/deframeMessage are the single encode/decode chokepoint every
 * transport uses; channelFor routes a message to its §6.1 DataChannel.
 * Decoding validates the kind byte ↔ payload.kind agreement exhaustively.
 */
import { decode, encode } from "@msgpack/msgpack";
import { MsgKind, type MsgName, type WireMessage } from "../core/messages";
import type { ChannelName } from "../core/net";
import { type Result, err, okVal } from "../core/result";

const BYTE_TO_NAME = new Map<number, MsgName>(
  (Object.entries(MsgKind) as Array<[MsgName, number]>).map(([name, byte]) => [byte, name]),
);

export function frameMessage(msg: WireMessage): Uint8Array {
  const byte = MsgKind[msg.kind];
  if (byte === undefined) throw new Error(`frame: unknown kind '${String(msg.kind)}'`);
  const payload = encode(msg);
  const out = new Uint8Array(payload.length + 1);
  out[0] = byte;
  out.set(payload, 1);
  return out;
}

/** Structural validation: kind field matches the prefix byte (exhaustive switch). */
function validateDecoded(obj: unknown, name: MsgName): Result<WireMessage> {
  if (typeof obj !== "object" || obj === null) return err("payload is not an object");
  const record = obj as Record<string, unknown>;
  if (record["kind"] !== name) {
    return err(`kind mismatch: prefix says '${name}', payload says '${String(record["kind"])}'`);
  }
  switch (name) {
    case "hello":
    case "intent":
    case "roll":
    case "roll.challenge":
    case "roll.reveal":
    case "ephemeral":
    case "asset.get":
    case "fog.put":
    case "relay.offer":
    case "turn.ready":
    case "sim.control":
    case "report.detail":
    case "sim.snapshot.get":
    case "audio.cmd":
    case "welcome":
    case "snapshot":
    case "ops":
    case "rejected":
    case "asset.chunk":
    case "clock":
    case "kick":
    case "ban":
    case "sim.delta":
    case "sim.snapshot":
    case "turn.phase":
    case "turn.report":
    case "report.detail.page":
    case "heartbeat":
    case "ping":
    case "pong":
    case "relay.frame":
      return okVal(record as unknown as WireMessage);
  }
}

export function deframeMessage(bytes: Uint8Array): Result<WireMessage> {
  if (bytes.length < 2) return err("frame too short");
  const byte = bytes[0] as number;
  const name = BYTE_TO_NAME.get(byte);
  if (!name) return err(`unknown message kind byte 0x${byte.toString(16)}`);
  let decoded: unknown;
  try {
    decoded = decode(bytes.subarray(1));
  } catch (cause) {
    return err(`msgpack decode failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return validateDecoded(decoded, name);
}

/**
 * §6.1 channel routing. sim carries sim.delta / sim.snapshot / turn.report /
 * sim.snapshot.get so chat & sheets never block behind large deltas; assets
 * carries the chunked transfer; ephemeral is unreliable; everything else ops.
 */
export function channelFor(kind: MsgName): ChannelName {
  switch (kind) {
    case "ephemeral":
      return "ephemeral";
    case "asset.get":
    case "asset.chunk":
      return "assets";
    case "sim.delta":
    case "sim.snapshot":
    case "sim.snapshot.get":
    case "audio.cmd":
    case "turn.report":
      return "sim";
    case "hello":
    case "intent":
    case "roll":
    case "roll.challenge":
    case "roll.reveal":
    case "fog.put":
    case "relay.offer":
    case "turn.ready":
    case "sim.control":
    case "report.detail":
    case "welcome":
    case "snapshot":
    case "ops":
    case "rejected":
    case "clock":
    case "kick":
    case "ban":
    case "turn.phase":
    case "report.detail.page":
    case "heartbeat":
    case "ping":
    case "pong":
    case "relay.frame":
      return "ops";
  }
}
