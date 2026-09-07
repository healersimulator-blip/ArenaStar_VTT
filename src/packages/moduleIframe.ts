/**
 * §12 sandboxed module host — runs ONE package's module entry inside a
 * hidden <iframe sandbox="allow-scripts"> (opaque origin: no parent DOM,
 * no localStorage, no same-origin) and bridges it to the app via the
 * moduleApi dispatcher. The host validates every frame; hook events are
 * forwarded only for names the module subscribed to.
 */
import type { Json } from "../core/documents";
import { MODULE_RUNTIME_SOURCE } from "./moduleRuntimeSource";
import {
  createModuleDispatcher,
  MODULE_RPC_TAG,
  type ModuleFrameToModule,
  type ModuleHandlers,
  type ModuleHookName,
  type ModuleRpcRequest,
} from "../core/moduleApi";

export interface ModuleIframeOptions {
  packageId: string;
  /** Classic-script source of the package module entry. */
  source: string;
  handlers: ModuleHandlers;
  /** Where to mount the hidden iframe (defaults to document.body). */
  hostElement?: HTMLElement;
  /** Fires when the module subscribes to a hook (e.g. emit "ready" then). */
  onSubscribe?: (event: ModuleHookName) => void;
}

export class ModuleIframe {
  readonly packageId: string;
  private readonly frame: HTMLIFrameElement;
  private readonly dispatcher: ReturnType<typeof createModuleDispatcher>;
  private readonly subscriptions = new Set<ModuleHookName>();
  private readonly onSubscribe: ((event: ModuleHookName) => void) | undefined;
  private disposed = false;

  constructor(options: ModuleIframeOptions) {
    this.packageId = options.packageId;
    this.onSubscribe = options.onSubscribe;
    this.dispatcher = createModuleDispatcher(options.handlers);
    const doc = globalThis.document;
    const frame = doc.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", `module:${options.packageId}`);
    frame.style.display = "none";
    const srcdoc = `<!doctype html><meta charset="utf-8"><body><script>${escapeScript(MODULE_RUNTIME_SOURCE)}</script><script>${escapeScript(options.source)}</script></body>`;
    frame.srcdoc = srcdoc;
    (options.hostElement ?? doc.body).appendChild(frame);
    this.frame = frame;
    globalThis.addEventListener("message", this.onMessage);
  }

  private readonly onMessage = (ev: MessageEvent): void => {
    if (this.disposed) return;
    if (ev.source !== this.frame.contentWindow) return;
    const data = ev.data as ModuleRpcRequest | undefined;
    if (!data || (data as { vttModuleRpc?: number }).vttModuleRpc !== MODULE_RPC_TAG) return;
    if (data.kind !== "request") return;
    if (data.method === "hooks.subscribe") {
      const name = (data.args as { event?: unknown } | undefined)?.event;
      const hook = name as ModuleHookName;
      if (typeof hook === "string" && !this.subscriptions.has(hook)) {
        this.subscriptions.add(hook);
        this.onSubscribe?.(hook);
      }
    }
    this.dispatcher.onFrame(data, (response) => this.post(response));
  };

  private post(frame: ModuleFrameToModule): void {
    if (this.disposed) return;
    this.frame.contentWindow?.postMessage(frame, "*");
  }

  /** Forward a whitelisted app event into the module's Hooks (if subscribed). */
  emitHook(event: ModuleHookName, payload: Json): void {
    if (!this.subscriptions.has(event)) return;
    this.post({ vttModuleRpc: MODULE_RPC_TAG, kind: "event", event, payload });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    globalThis.removeEventListener("message", this.onMessage);
    this.frame.remove();
  }
}

/** Keep user package source from closing the host <script> early. */
function escapeScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}
