/**
 * §2 InMemoryTransport: joins Host Core and Client Core inside the GM tab.
 * Implements the exact Transport interface WebRTC does (§6.1); messages sent
 * on one side are delivered to the peer's onMessage on the same channel via a
 * microtask (ordered, reliable — all four channels behave identically here;
 * the unreliable ephemeral channel only exists over WebRTC).
 */
import type { ChannelName, Transport, TransportMessageHandler, TransportStats } from "../core/net";

class InMemoryTransport implements Transport {
  onMessage: TransportMessageHandler | null = null;
  private peer: InMemoryTransport | null = null;
  private closedState = { closed: false };
  private sentBytes = 0;
  private sentMessages = 0;

  /** Link to the other side (pair factory only). */
  setPeer(peer: InMemoryTransport): void {
    this.peer = peer;
  }

  send(channel: ChannelName, bytes: Uint8Array): void {
    const peer = this.peer;
    if (!peer || this.closedState.closed || peer.closedState.closed)
      throw new Error("transport closed");
    this.sentBytes += bytes.length;
    this.sentMessages += 1;
    const copy = new Uint8Array(bytes); // no shared-buffer aliasing across sides
    queueMicrotask(() => {
      // Read the handler at delivery time: receivers may attach after send.
      if (!peer.closedState.closed) peer.onMessage?.(channel, copy);
    });
  }

  close(): void {
    this.closedState.closed = true;
  }

  get stats(): TransportStats {
    const connected =
      this.peer !== null && !this.closedState.closed && !this.peer.closedState.closed;
    return {
      connected,
      channels: {
        ops: this.channelStats(),
        ephemeral: this.channelStats(),
        assets: this.channelStats(),
        sim: this.channelStats(),
      },
    };
  }

  private channelStats() {
    return {
      sentBytes: this.sentBytes,
      sentMessages: this.sentMessages,
      bufferedAmount: 0,
    };
  }
}

export interface TransportPair {
  a: Transport;
  b: Transport;
}

/** Create a connected loopback pair (a ⇄ b), e.g. host-side ⇄ GM client. */
export function createTransportPair(): TransportPair {
  const a = new InMemoryTransport();
  const b = new InMemoryTransport();
  a.setPeer(b);
  b.setPeer(a);
  return { a, b };
}

/** Await queued microtask deliveries (one macrotask tick). */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
