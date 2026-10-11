/**
 * G-02 (D-429): a host refusal of a canvas move is explained to the person who made it, never a
 * silent snap-back. Only transactions submitted through the canvas controller are tracked, so
 * flows that already await their own result (sheets, dialogs) do not get a second message.
 */
import type { EventBus } from "../core";
import type { ClientEvents } from "./sync";

/** Short, player-facing text. The host's `detail` is already written for people. */
export function moveRefusalMessage(reason: string, detail: string): string {
  const text = detail.trim().replace(/\s+/g, " ").slice(0, 200);
  if (reason === "rate_limited") return "Too many moves at once. Wait a moment and try again.";
  if (reason === "phase_locked") return text ? `Not right now: ${text}` : "Movement is locked during this phase.";
  if (reason === "forbidden") return text && !/^not authenticated$/i.test(text) ? `You can't move that: ${text}` : "You can't move that token.";
  return text ? `Move refused: ${text}` : "The host refused that move.";
}

export interface RefusalNotifier {
  /** Remember a submitted transaction; returns the same ID so it can wrap `client.submit`. */
  track(txId: string): string;
  dispose(): void;
}

/** Bounded: a disconnected host never grows the pending set without limit. */
export function refusalNotifier(bus: EventBus<ClientEvents>, notify: (message: string) => void, limit = 64): RefusalNotifier {
  const pending = new Set<string>();
  const offRejected = bus.on("rejected", ({ txId, reason, detail }) => {
    if (pending.delete(txId)) notify(moveRefusalMessage(reason, detail));
  });
  const offOps = bus.on("ops", ({ envelope }) => { pending.delete(envelope.txId); });
  return {
    track(txId) {
      pending.add(txId);
      while (pending.size > limit) {
        const oldest = pending.values().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      return txId;
    },
    dispose() { offRejected(); offOps(); pending.clear(); },
  };
}
