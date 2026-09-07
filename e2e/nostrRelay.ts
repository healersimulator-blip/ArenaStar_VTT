import { WebSocketServer, type WebSocket } from "ws";

/**
 * Minimal local Nostr relay for e2e (deterministic, no external networks).
 * Faithful to the ephemeral-signaling semantics the adapter relies on:
 * EVENTs are live-pushed to matching REQ subscribers and NEVER stored
 * (NIP-01 ephemeral kinds; the adapter subscribes with limit: 0).
 */
export interface LocalRelay {
  url: string;
  close(): Promise<void>;
}

interface NostrEvent {
  kind: number;
  tags: string[][];
  pubkey: string;
  [key: string]: unknown;
}

export function startNostrRelay(kind: number): Promise<LocalRelay> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  // socket → subId → room tag filter ("" = any)
  const subs = new Map<WebSocket, Map<string, string>>();

  wss.on("connection", (ws) => {
    subs.set(ws, new Map());
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      const [type] = parsed as [string, ...unknown[]];
      if (type === "REQ") {
        const [, subId, filter] = parsed as [string, string, { "#t"?: string[] }];
        subs.get(ws)?.set(subId, filter?.["#t"]?.[0] ?? "");
        return;
      }
      if (type === "CLOSE") {
        const [, subId] = parsed as [string, string];
        subs.get(ws)?.delete(subId);
        return;
      }
      if (type === "EVENT") {
        const [, event] = parsed as [string, NostrEvent];
        if (event.pubkey === undefined) return;
        for (const [socket, subscriptions] of subs) {
          if (socket === ws || socket.readyState !== socket.OPEN) continue;
          for (const [subId, room] of subscriptions) {
            const matches =
              event.kind === kind &&
              (room === "" || (event.tags ?? []).some((t) => t[0] === "t" && t[1] === room));
            if (matches) socket.send(JSON.stringify(["EVENT", subId, event]));
          }
        }
        return;
      }
    });
    ws.on("close", () => subs.delete(ws));
  });

  return new Promise((resolve) => {
    wss.on("listening", () => {
      const address = wss.address() as { port: number };
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            for (const [socket] of subs) socket.close();
            wss.close(() => done());
          }),
      });
    });
  });
}
