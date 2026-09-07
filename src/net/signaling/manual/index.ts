/**
 * §6.2 Manual signaling adapter — copy/paste + QR, non-trickle offers with
 * pre-gathered ICE.
 *
 * There is no server: `send` encrypts with the room key and queues a code in
 * the outbox for the UI to render (copy button + QR); inbound codes arrive via
 * `receiveCode` (paste box). Works everywhere, including file:// — Manual is
 * always available in the UI (§6.2).
 */
import type { PeerId } from "../../../core/ids";
import type { SignalMsg, SignalingAdapter } from "../../../core/net";
import { decryptSignalPayload, encryptSignalPayload, type SignalEnvelope } from "../crypto";

export class ManualSignalingAdapter implements SignalingAdapter {
  private key: CryptoKey | null = null;
  private roomId: string | null = null;
  private cb: ((from: PeerId, msg: SignalMsg) => void) | null = null;
  private readonly outbox: string[] = [];
  private closed = false;
  /** Random per-instance sender id (surface in the UI as "this device"). */
  readonly selfId: PeerId = globalThis.crypto.randomUUID();
  /** Latest outbound code (mirror; does NOT drain the outbox) — UI display. */
  private lastSent: string | null = null;

  /** Last code produced by send() — non-destructive peek for the UI/tests. */
  get lastSentCode(): string | null {
    return this.lastSent;
  }

  /** Room this adapter was opened for (UI label). */
  get room(): string | null {
    return this.roomId;
  }

  async open(roomId: string, key: CryptoKey): Promise<void> {
    this.assertNotClosed();
    this.roomId = roomId;
    this.key = key;
  }

  async send(_to: PeerId, msg: SignalMsg): Promise<void> {
    this.assertNotClosed();
    if (!this.key) throw new Error("manual signaling: open() not called");
    const envelope: SignalEnvelope = { from: this.selfId, msg };
    const code = await encryptSignalPayload(this.key, envelope);
    this.lastSent = code;
    this.outbox.push(code);
  }

  onMessage(cb: (from: PeerId, msg: SignalMsg) => void): void {
    this.cb = cb;
  }

  /** Drain queued outbound codes (each renders once: copy/paste + QR). */
  takeOutbox(): string[] {
    const codes = [...this.outbox];
    this.outbox.length = 0;
    return codes;
  }

  /** Feed a pasted code; dispatches onMessage when it decrypts. */
  async receiveCode(code: string): Promise<void> {
    this.assertNotClosed();
    if (!this.key) throw new Error("manual signaling: open() not called");
    const envelope = await decryptSignalPayload(this.key, code.trim());
    this.cb?.(envelope.from, envelope.msg);
  }

  close(): void {
    this.closed = true;
    this.outbox.length = 0;
    this.cb = null;
    this.key = null;
    this.roomId = null;
  }

  private assertNotClosed(): void {
    if (this.closed) throw new Error("manual signaling: closed");
  }
}
