/**
 * §12 module handlers — the host-side implementation of the module API
 * (game/settings/tokens/chat/notify), shared by BOTH execution tiers:
 * the sandboxed iframe (ModuleIframe, postMessage RPC) and trusted in-page
 * execution (TrustedModuleHost, direct calls after GM opt-in).
 */
import type { IDBPDatabase } from "idb";
import type { Json, MessageDocument } from "../core/documents";
import type { Op } from "../core/ops";
import type { ModuleHandlers } from "../core/moduleApi";
import { getSetting, putSetting } from "../storage/idb";

export interface ModuleHostContext {
  worldId: string;
  worldName: string;
  packageId: string;
  db: IDBPDatabase;
  user: () => { id: string; name: string };
  /** Light active-scene shape (ids + token rows). */
  activeScene: () => {
    id: string;
    tokens: ReadonlyArray<{ id: string; name: string; x: number; y: number }>;
  } | null;
  submit: (ops: Op[]) => unknown;
  notify: (message: string, level: string) => void;
  newId: (prefix: string) => string;
}

const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

export function createModuleHandlers(ctx: ModuleHostContext): ModuleHandlers {
  const scope = `module:${ctx.packageId}`;
  return {
    "game.info": () => ({
      worldId: ctx.worldId,
      worldName: ctx.worldName,
      userId: ctx.user().id,
      userName: ctx.user().name,
      isGM: true,
      packageId: ctx.packageId,
    }),
    "settings.get": async (args) =>
      (await getSetting(ctx.db, scope, String(asRecord(args).key ?? "")))?.value ?? null,
    "settings.set": async (args) => {
      const key = String(asRecord(args).key ?? "");
      if (key.length === 0) throw new Error("settings.set: key required");
      const value = asRecord(args).value;
      if (JSON.stringify(value) === undefined) {
        throw new Error("settings.set: value must be JSON-safe");
      }
      await putSetting(ctx.db, { scope, key, value: value as never });
      return { ok: true };
    },
    "tokens.list": () => ({
      tokens: (ctx.activeScene()?.tokens ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        x: t.x,
        y: t.y,
      })),
    }),
    "tokens.move": (args) => {
      const { id, x, y } = asRecord(args);
      const scene = ctx.activeScene();
      const token = scene?.tokens.find((t) => t.id === id);
      if (!token || !scene) throw new Error(`tokens.move: unknown token ${String(id)}`);
      const nx = Number(x);
      const ny = Number(y);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
        throw new Error("tokens.move: x/y must be finite");
      }
      ctx.submit([
        {
          kind: "update",
          ref: { coll: "tokens", id: token.id, parent: { coll: "scenes", id: scene.id } },
          diff: { x: nx, y: ny },
        },
      ]);
      return { ok: true };
    },
    "chat.create": (args) => {
      const content = asRecord(args).content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("chat.create: content required");
      }
      const flavor = asRecord(args).flavor;
      const id = ctx.newId("msg-");
      const doc: MessageDocument = {
        _id: id,
        type: "message",
        name: "message",
        ownership: { default: 1 },
        flags: {},
        system: {},
        author: ctx.user().id,
        content,
        whisper: [],
        roll: null,
        flavor: typeof flavor === "string" ? flavor : "",
      };
      ctx.submit([{ kind: "create", coll: "messages", data: doc }]);
      return { id };
    },
    notify: (args) => {
      const message = asRecord(args).message;
      const level = asRecord(args).level;
      if (typeof message !== "string") throw new Error("notify: message required");
      ctx.notify(message, typeof level === "string" ? level : "info");
      return { ok: true };
    },
    "hooks.subscribe": () => ({ ok: true }),
  };
}

/** Shared emitter surface both hosts implement (iframe RPC / in-page direct). */
export interface ModuleHost {
  emitHook(event: string, payload: Json): void;
  dispose(): void;
}
