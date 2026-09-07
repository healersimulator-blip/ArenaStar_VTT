/**
 * §6.3 Peer Relay — relay.offer (0x07) and relay.frame (0x43)
 *
 * Provides peer-to-peer relaying for players behind strict NATs who cannot
 * establish a direct WebRTC connection. An intermediary peer forwards opaque
 * e2e-encrypted frames between the source and destination peers.
 */
import type { Transport } from "../core/net";
import type { RelayFrameMsg, RelayOfferMsg } from "../core/messages";
import { deframeMessage, frameMessage } from "./frame";

export type RelayFrameHandler = (from: string, channel: string, bytes: Uint8Array) => void;

export class PeerRelayRouter {
  private readonly peers = new Map<string, Transport>();
  onRelayFrame: RelayFrameHandler | null = null;
  onRelayOffer: ((from: string, sdp: string) => void) | null = null;

  constructor(public readonly selfId: string) {}

  addPeer(peerId: string, transport: Transport): void {
    this.peers.set(peerId, transport);
    const prevOnMsg = transport.onMessage;
    transport.onMessage = (channel, bytes) => {
      prevOnMsg?.(channel, bytes);
      this.handleIncoming(peerId, channel, bytes);
    };
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  forwardFrame(msg: RelayFrameMsg): void {
    if (msg.to === this.selfId) {
      this.onRelayFrame?.(msg.from, "ops", msg.bytes);
      return;
    }

    const targetTransport = this.peers.get(msg.to);
    if (targetTransport) {
      const framed = frameMessage(msg);
      targetTransport.send("ops", framed);
    }
  }

  sendRelayOffer(toPeerId: string, sdp: string): void {
    const msg: RelayOfferMsg = {
      kind: "relay.offer",
      from: this.selfId,
      sdp,
    };
    const targetTransport = this.peers.get(toPeerId);
    if (targetTransport) {
      targetTransport.send("ops", frameMessage(msg));
    }
  }

  private handleIncoming(_fromPeerId: string, channel: string, bytes: Uint8Array): void {
    if (channel !== "ops") return;
    const result = deframeMessage(bytes);
    if (!result.ok) return;
    const parsed = result.value;
    if (parsed.kind === "relay.frame") {
      this.forwardFrame(parsed);
    } else if (parsed.kind === "relay.offer") {
      this.onRelayOffer?.(parsed.from, parsed.sdp);
    }
  }
}
