/**
 * §2/§6.2/§6.4 — GM-side "share invite" flow: one room secret per world,
 * Manual signaling (always available, incl. file://) with the SignalingStack
 * (nostr/mqtt/tracker) as a lazy background upgrade.
 *
 * Wire-up: HostSessions listens on the adapter; every connected peer becomes a
 * HostSync session (hello → join:request → auto-approve PLAYER in M1, D-061).
 */
import { ManualSignalingAdapter } from "../net/signaling/manual";
import { NostrSignalingAdapter } from "../net/signaling/nostr";
import { HostSessions, type PeerConnectionFactory } from "../net/peerSession";
import {
  buildInviteLink,
  deriveRoomKey,
  parseInviteLink,
  type RoomInvite,
} from "../net/signaling/crypto";
import { getSetting, putSetting } from "../storage/idb";
import type { Transport } from "../core/net";
import type { HostApp } from "./hostBoot";

export interface HostShareOptions {
  /** Reuse an explicit secret instead of the stored one (tests). */
  secret?: string;
  /** Override the Manual adapter (tests: paired fake channel). */
  adapter?: ManualSignalingAdapter;
  /** Override the RTC factory (tests: in-memory wire). */
  factory?: PeerConnectionFactory;
  /** Nostr relay override (tests: local relay); default: public relays. */
  relays?: string[];
}

export interface HostShare {
  /** Full invite text (`<base>#room=<id>&k=<secret>&h=<nostr-pubkey>`). */
  inviteLink: string;
  roomId: string;
  secret: string;
  /** The manual adapter codes flow through (tests pump it directly). */
  adapter: ManualSignalingAdapter;
  /** Host's Nostr signaling pubkey (in the invite as `&h=`; §6.2). */
  nostrPubkey: string;
  /** "nostr" once the relay stack connected, else null (manual-only). */
  signalingKind: () => string | null;
  /** Outbound manual codes (offer answers) for the UI to render. */
  takeOutbox(): string[];
  /** Feed a pasted player code. */
  receiveCode(code: string): Promise<void>;
  close(): void;
}

const INVITE_KEY = "invite-secret";

/** The stored secret for a world (stable across host restarts, §6.5 rejoin). */
async function roomSecret(app: HostApp, explicit?: string): Promise<string> {
  if (explicit) {
    await putSetting(app.db, {
      scope: "world",
      key: INVITE_KEY,
      value: explicit as never,
    });
    return explicit;
  }
  const rec = await getSetting(app.db, "world", INVITE_KEY);
  if (rec && typeof rec.value === "string") return rec.value;
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await putSetting(app.db, { scope: "world", key: INVITE_KEY, value: secret as never });
  return secret;
}

export async function startHostShare(
  app: HostApp,
  options: HostShareOptions = {},
): Promise<HostShare> {
  const roomId = app.worldId;
  const secret = await roomSecret(app, options.secret);
  const key = await deriveRoomKey(secret, roomId);
  const adapter = options.adapter ?? new ManualSignalingAdapter();
  await adapter.open(roomId, key);

  // §6.2: Nostr (default stack head) alongside Manual — the invite carries the
  // host's nostr pubkey so players can auto-join through relays; manual
  // copy/paste always remains available (tests may pin a local relay).
  const relays = options.relays ?? relayOverride();
  const nostr = new NostrSignalingAdapter(relays !== undefined ? { relays } : {});
  const remoteSessions: HostSessions[] = [];
  let kind: string | null = null;
  void (async () => {
    try {
      await nostr.open(roomId, key);
      await Promise.race([nostr.ready(), new Promise((_, fail) => setTimeout(fail, 8_000))]);
      kind = "nostr";
      const remote = new HostSessions({
        adapter: nostr,
        ...(options.factory !== undefined ? { factory: options.factory } : {}),
      });
      remote.onSession = (peerId, transport) => app.host.addSession(peerId, transport);
      remote.onClosed = (peerId) => app.host.removeSession(peerId, "peer session closed");
      remote.start();
      remoteSessions.push(remote);
    } catch {
      nostr.close(); // relays unreachable — Manual remains (§6.2)
    }
  })();

  const sessions = new HostSessions({
    adapter,
    ...(options.factory !== undefined ? { factory: options.factory } : {}),
  });
  sessions.onSession = (peerId: string, transport: Transport) => {
    app.host.addSession(peerId, transport);
  };
  sessions.onClosed = (peerId: string) => {
    app.host.removeSession(peerId, "peer session closed");
  };
  // M1: auto-approve unknown pubkeys as PLAYER (D-061); approval UI is M2.
  const offJoin = app.host.bus.on("join:request", (req) => req.approve("PLAYER"));
  sessions.start();

  const base = globalThis.location?.href.split("#")[0] ?? "https://vtt.local/";
  return {
    inviteLink: buildInviteLink(base, roomId, secret, nostr.selfId),
    roomId,
    secret,
    adapter,
    nostrPubkey: nostr.selfId,
    signalingKind: () => kind,
    takeOutbox: () => adapter.takeOutbox(),
    receiveCode: (code) => adapter.receiveCode(code),
    close() {
      offJoin();
      sessions.close();
      for (const remote of remoteSessions) remote.close();
      nostr.close();
      adapter.close();
    },
  };
}

/** ?relay=ws://… override for the Nostr stack (e2e-only plumbing). */
function relayOverride(): string[] | undefined {
  const raw = globalThis.location?.search;
  if (!raw) return undefined;
  const value = new URLSearchParams(raw).get("relay");
  return value ? [value] : undefined;
}

/** Parse an invite string (link or bare fragment) for the join side. */
export function parseInvite(text: string): RoomInvite | null {
  const trimmed = text.trim();
  return parseInviteLink(trimmed.includes("#") ? trimmed : `x#${trimmed}`);
}
