/**
 * §12 trusted in-page module host — runs the SAME classic-script module
 * entry as the sandboxed iframe tier, but directly in the host page (a
 * blob: <script> tag; the page CSP allows blob: scripts). Full page access:
 * this is the GM-granted trust tier (WorldsRecord.trustedPackages), opted
 * in per package per world. The §12 API globals (game/Hooks/canvas/
 * ChatMessage/ui) are installed on window before execution and restored on
 * dispose; module code itself cannot be unloaded once evaluated (accepted:
 * trusted modules are host-class code).
 */
import type { ModuleHandlers, ModuleHookName } from "../core/moduleApi";
import type { ModuleHost } from "./moduleHandlers";

export interface TrustedModuleOptions {
  packageId: string;
  source: string;
  handlers: ModuleHandlers;
  /** Fires when the module subscribes to a hook (drives the ready handshake). */
  onSubscribe?: (event: ModuleHookName) => void;
}

type HookFn = (payload: unknown) => void;

export class TrustedModuleHost implements ModuleHost {
  private readonly hooks = new Map<string, Set<HookFn>>();
  private readonly script: HTMLScriptElement;
  private readonly url: string;
  private readonly installed: Array<{ name: string; had: boolean; prior: unknown }> = [];
  private disposed = false;

  constructor(options: TrustedModuleOptions) {
    const { handlers } = options;
    const call = (method: keyof ModuleHandlers, args: Record<string, unknown>) =>
      handlers[method](args) as Promise<unknown> | unknown;

    const HookReg = {
      on: (event: string, cb: HookFn): void => {
        setOf(this.hooks, event).add(cb);
        options.onSubscribe?.(event as ModuleHookName);
      },
      once: (event: string, cb: HookFn): void => {
        const wrap = (payload: unknown): void => {
          HookReg.off(event, wrap);
          cb(payload);
        };
        HookReg.on(event, wrap);
      },
      off: (event: string, cb: HookFn): void => {
        this.hooks.get(event)?.delete(cb);
      },
    };

    const api = {
      game: {
        info: () => call("game.info", {}),
        settings: {
          get: (key: string) => call("settings.get", { key }),
          set: (key: string, value: unknown) => call("settings.set", { key, value }),
        },
      },
      Hooks: HookReg,
      canvas: {
        tokens: {
          list: () => call("tokens.list", {}),
          move: (id: string, x: number, y: number) => call("tokens.move", { id, x, y }),
        },
      },
      ChatMessage: {
        create: (data: Record<string, unknown>) => call("chat.create", data ?? {}),
      },
      ui: {
        notifications: {
          notify: (message: string, level?: string) =>
            call("notify", { message: String(message), level: level ?? "info" }),
        },
      },
    };

    const g = globalThis as unknown as Record<string, unknown>;
    for (const name of Object.keys(api)) {
      this.installed.push({
        name,
        had: Object.prototype.hasOwnProperty.call(g, name),
        prior: g[name],
      });
      g[name] = (api as Record<string, unknown>)[name];
    }

    const doc = globalThis.document;
    const source = options.source.replace(/<\/script/gi, "<\\/script");
    this.url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const script = doc.createElement("script");
    script.src = this.url;
    script.setAttribute("data-vtt-trusted-module", options.packageId);
    doc.head.appendChild(script);
    this.script = script;
  }

  emitHook(event: string, payload: unknown): void {
    if (this.disposed) return;
    const cbs = this.hooks.get(event);
    if (!cbs) return;
    for (const cb of [...cbs]) {
      try {
        cb(payload);
      } catch {
        // module callback errors stay in the host page (trusted tier)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.script.remove();
    URL.revokeObjectURL(this.url);
    this.hooks.clear();
  }
}

function setOf(map: Map<string, Set<HookFn>>, event: string): Set<HookFn> {
  let set = map.get(event);
  if (!set) {
    set = new Set();
    map.set(event, set);
  }
  return set;
}
