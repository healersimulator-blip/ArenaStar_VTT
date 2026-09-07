/**
 * src/net barrel (§18): Transport implementations, framing, signaling, identity.
 * Contracts live in src/core/net.ts (§3); this layer implements them.
 */
export { frameMessage, deframeMessage, channelFor } from "./frame";
export { createTransportPair, flushMicrotasks, type TransportPair } from "./memory";
export {
  generateIdentity,
  helloPayload,
  signText,
  verifyHello,
  type Identity,
  type IdentityAlgorithm,
} from "./identity";
export * from "./transfer";
export * from "./webrtc";
export * from "./signaling";
export * from "./peerSession";
