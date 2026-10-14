/**
 * D-470 — host-chromed windows for sandboxed module panels (AIS_PLAYER_RUNTIME_PLAN.md P2a).
 *
 * A module that declares `interconnect.panel` draws its UI inside its *own* iframe document
 * (`sandbox="allow-scripts"`, opaque origin, CSP without network or images). The shell never
 * renders module markup in its page; it only decides where the module's iframe sits and whether
 * it is visible. This helper owns that decision for both shells:
 *
 * - one `<section data-ais-panel>` per module, created hidden *before* the iframe so the iframe is
 *   born inside the panel body (`hostElement`) and never re-parented — moving an iframe reloads it,
 *   which `AisModuleIframe` treats as a navigation and stops the module;
 * - chrome the module cannot draw or forge: title, "<module name> · sandboxed module" origin line,
 *   a Close button; the frame is clipped to the panel body;
 * - open/close toggles visibility of the section and of the frame (`AisModuleIframe.setVisible`).
 *
 * Plain DOM on purpose: a Svelte `{#if}` would destroy and recreate the iframe with the module in
 * it. The shells mount one persistent layer element and hand it here.
 */

export interface AisPanelSpec {
  title: string;
  moduleName: string;
  width: number;
  height: number;
  onClose: () => void;
}

export interface AisPanelEntry {
  packageId: string;
  title: string;
  open: boolean;
}

export interface AisPanelHost {
  /** Creates the hidden panel; returns the element the module iframe must be created in. */
  mount(packageId: string, spec: AisPanelSpec): HTMLElement;
  /** Binds the visibility toggle of the frame created inside the body (called once the frame exists). */
  attach(packageId: string, frame: { setVisible(visible: boolean): void }): void;
  open(packageId: string): boolean;
  close(packageId: string): boolean;
  remove(packageId: string): void;
  isOpen(packageId: string): boolean;
  entries(): AisPanelEntry[];
  /** Removes every panel (world closed). */
  dispose(): void;
}

interface PanelRecord {
  section: HTMLElement;
  body: HTMLElement;
  title: string;
  open: boolean;
  frame: { setVisible(visible: boolean): void } | null;
}

const STYLE_ID = "ais-panel-style";
const PANEL_CSS = `
.ais-panel-layer { position: fixed; inset: 0; pointer-events: none; z-index: 60; }
.ais-panel { position: absolute; right: 16px; bottom: 16px; pointer-events: auto; display: flex; flex-direction: column;
  background: var(--panel-bg, #1b1d22); color: var(--panel-fg, #e8e8e8); border: 1px solid var(--panel-border, #3a3d45);
  border-radius: 8px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45); overflow: hidden; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); }
.ais-panel[hidden] { display: none; }
.ais-panel-chrome { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; font: 600 13px/1.3 system-ui, sans-serif;
  background: var(--panel-chrome-bg, #272a31); border-bottom: 1px solid var(--panel-border, #3a3d45); user-select: none; }
.ais-panel-title { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ais-panel-origin { flex: 0 1 auto; font-weight: 400; font-size: 11px; opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ais-panel-close { flex: 0 0 auto; appearance: none; border: 0; background: transparent; color: inherit; font-size: 16px; line-height: 1;
  width: 24px; height: 24px; border-radius: 4px; cursor: pointer; }
.ais-panel-close:hover, .ais-panel-close:focus-visible { background: rgba(255, 255, 255, 0.12); outline: none; }
.ais-panel-body { flex: 1 1 auto; min-height: 0; background: #fff; }
.ais-panel-body > iframe { display: block; width: 100%; height: 100%; border: 0; }
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  doc.head.appendChild(style);
}

const LAYER_ID = "ais-panel-layer";

/** The one persistent layer of a shell document (created on first use, appended to <body>). */
export function aisPanelLayer(doc: Document = globalThis.document): HTMLElement {
  const existing = doc.getElementById(LAYER_ID);
  if (existing) return existing;
  const layer = doc.createElement("div");
  layer.id = LAYER_ID;
  doc.body.appendChild(layer);
  return layer;
}

export function createAisPanelHost(layer: HTMLElement): AisPanelHost {
  const doc = layer.ownerDocument;
  ensureStyle(doc);
  layer.classList.add("ais-panel-layer");
  layer.setAttribute("data-ais-panel-layer", "");
  const panels = new Map<string, PanelRecord>();

  const setOpen = (packageId: string, open: boolean): boolean => {
    const record = panels.get(packageId);
    if (!record || record.open === open) return false;
    record.open = open;
    record.section.hidden = !open;
    record.section.setAttribute("data-ais-panel-open", open ? "true" : "false");
    record.frame?.setVisible(open);
    return true;
  };

  return {
    mount(packageId, spec) {
      this.remove(packageId);
      const section = doc.createElement("section");
      section.className = "ais-panel";
      section.setAttribute("data-ais-panel", packageId);
      section.setAttribute("data-ais-panel-open", "false");
      section.setAttribute("role", "dialog");
      section.setAttribute("aria-label", `${spec.title} — ${spec.moduleName} (sandboxed module)`);
      section.hidden = true;
      section.style.width = `${spec.width}px`;
      section.style.height = `${spec.height}px`;
      // Stagger panels so several open modules do not fully overlap.
      const offset = 24 * panels.size;
      section.style.right = `${16 + offset}px`;
      section.style.bottom = `${16 + offset}px`;

      const chrome = doc.createElement("header");
      chrome.className = "ais-panel-chrome";
      const title = doc.createElement("span");
      title.className = "ais-panel-title";
      title.textContent = spec.title;
      const origin = doc.createElement("span");
      origin.className = "ais-panel-origin";
      origin.textContent = `${spec.moduleName} · sandboxed module`;
      const close = doc.createElement("button");
      close.type = "button";
      close.className = "ais-panel-close";
      close.setAttribute("data-ais-panel-close", "");
      close.setAttribute("aria-label", `Close ${spec.title}`);
      close.textContent = "×";
      close.addEventListener("click", () => { if (setOpen(packageId, false)) spec.onClose(); });
      chrome.append(title, origin, close);

      const body = doc.createElement("div");
      body.className = "ais-panel-body";
      section.append(chrome, body);
      layer.appendChild(section);
      panels.set(packageId, { section, body, title: spec.title, open: false, frame: null });
      return body;
    },
    attach(packageId, frame) {
      const record = panels.get(packageId);
      if (!record) return;
      record.frame = frame;
      frame.setVisible(record.open);
    },
    open: (packageId) => setOpen(packageId, true),
    close: (packageId) => setOpen(packageId, false),
    remove(packageId) {
      const record = panels.get(packageId);
      if (!record) return;
      panels.delete(packageId);
      record.section.remove();
    },
    isOpen: (packageId) => panels.get(packageId)?.open === true,
    entries: () => Array.from(panels, ([packageId, record]) => ({ packageId, title: record.title, open: record.open })),
    dispose() {
      for (const packageId of Array.from(panels.keys())) this.remove(packageId);
    },
  };
}
