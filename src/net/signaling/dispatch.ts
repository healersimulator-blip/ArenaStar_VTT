/**
 * Shared envelope dispatch for broadcast-style signaling adapters (§6.2):
 * decrypt a room-crypto code, enforce self-echo skip + authenticated `to`
 * routing, then hand {from, msg} to the consumer. All failures are silent —
 * wrong-key traffic and junk are normal on public transports.
 */
import type { PeerId } from "../../core/ids";
import type { SignalMsg } from "../../core/net";
import { decryptSignalPayload } from "./crypto";

export interface EnvelopeReceipt {
  /** True when the consumer was invoked (broadcast or addressed to us). */
  delivered: boolean;
  /** Authenticated sender id when decryption succeeded (even if routed away). */
  from: PeerId | null;
}

export interface EnvelopeSink {
  /** Decrypt + route one inbound code; never throws. */
  handleCode(code: string): Promise<EnvelopeReceipt>;
}

export function createEnvelopeSink(deps: {
  key: () => CryptoKey | null;
  selfId: () => PeerId;
  cb: () => ((from: PeerId, msg: SignalMsg) => void) | null;
}): EnvelopeSink {
  return {
    async handleCode(code: string): Promise<EnvelopeReceipt> {
      const key = deps.key();
      if (!key) return { delivered: false, from: null };
      let envelope;
      try {
        envelope = await decryptSignalPayload(key, code);
      } catch {
        return { delivered: false, from: null }; // wrong room / tampered / junk
      }
      if (envelope.from === deps.selfId()) return { delivered: false, from: envelope.from }; // own echo
      if (envelope.to !== undefined && envelope.to !== deps.selfId()) {
        return { delivered: false, from: envelope.from }; // routed elsewhere
      }
      deps.cb()?.(envelope.from, envelope.msg);
      return { delivered: true, from: envelope.from };
    },
  };
}
