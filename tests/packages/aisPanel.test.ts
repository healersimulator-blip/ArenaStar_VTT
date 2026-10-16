/**
 * D-470 — host-chromed sandboxed module panels. The suite runs in Node, so a minimal element
 * double stands in for the DOM: enough to prove the structure, the visibility protocol and the
 * no-re-parenting rule (the iframe host element is created once and never moved).
 */
import { describe, expect, test } from "vitest";
import { createAisPanelHost } from "../../src/packages/aisPanel";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly style: Record<string, string> = {};
  readonly classes = new Set<string>();
  parent: FakeElement | null = null;
  hidden = false;
  id = "";
  textContent = "";
  type = "";
  constructor(readonly doc: FakeDocument, readonly tagName: string) {}
  get classList() {
    return { add: (name: string) => { this.classes.add(name); }, contains: (name: string) => this.classes.has(name) };
  }
  set className(value: string) { this.classes.clear(); for (const name of value.split(" ")) if (name) this.classes.add(name); }
  get ownerDocument(): FakeDocument { return this.doc; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  appendChild(child: FakeElement): FakeElement { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = this; this.children.push(child); return child; }
  append(...nodes: FakeElement[]): void { for (const node of nodes) this.appendChild(node); }
  remove(): void { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  addEventListener(name: string, fn: () => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  click(): void { for (const fn of this.listeners.get("click") ?? []) fn(); }
  find(predicate: (el: FakeElement) => boolean): FakeElement | null {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested) return nested;
    }
    return null;
  }
}

class FakeDocument {
  readonly head = new FakeElement(this, "head");
  readonly body = new FakeElement(this, "body");
  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
  getElementById(id: string): FakeElement | null {
    const inHead = this.head.find((el) => el.id === id);
    return inHead ?? this.body.find((el) => el.id === id);
  }
}

const asDom = (el: FakeElement): HTMLElement => el as unknown as HTMLElement;

describe("createAisPanelHost", () => {
  test("mounts a hidden, host-chromed section whose body hosts the iframe; open/close toggle section and frame", () => {
    const doc = new FakeDocument();
    const layer = doc.body.appendChild(doc.createElement("div"));
    const host = createAisPanelHost(asDom(layer));
    expect(doc.head.children.some((el) => el.tagName === "style" && el.id === "ais-panel-style")).toBe(true);
    expect(layer.getAttribute("data-ais-panel-layer")).toBe("");

    const closes: string[] = [];
    const body = host.mount("mounts", { title: "Mounts", moduleName: "Mount Helper", width: 320, height: 200, onClose: () => closes.push("mounts") });
    const section = layer.children[0];
    expect(section?.getAttribute("data-ais-panel")).toBe("mounts");
    expect(section?.getAttribute("role")).toBe("dialog");
    expect(section?.getAttribute("aria-label")).toBe("Mounts — Mount Helper (sandboxed module)");
    expect(section?.hidden).toBe(true);
    expect(section?.style.width).toBe("320px");
    expect(section?.style.height).toBe("200px");
    const chrome = section?.children[0];
    expect(chrome?.children.map((el) => el.textContent)).toEqual(["Mounts", "Mount Helper · sandboxed module", "×"]);
    expect(section?.children[1]).toBe(body as unknown as FakeElement);
    expect(host.entries()).toEqual([{ packageId: "mounts", title: "Mounts", open: false }]);

    // The frame is created by the runtime inside `body`; the host only learns how to show/hide it.
    const frame = doc.createElement("iframe");
    (body as unknown as FakeElement).appendChild(frame);
    const visibility: boolean[] = [];
    host.attach("mounts", { setVisible: (visible) => visibility.push(visible) });
    expect(visibility).toEqual([false]);

    expect(host.open("mounts")).toBe(true);
    expect(host.open("mounts")).toBe(false); // already open
    expect(section?.hidden).toBe(false);
    expect(section?.getAttribute("data-ais-panel-open")).toBe("true");
    expect(visibility).toEqual([false, true]);
    expect(host.isOpen("mounts")).toBe(true);
    expect(frame.parent).toBe(body); // never re-parented

    // The host-drawn Close button hides and reports; the module's own document is untouched.
    const close = chrome?.find((el) => el.getAttribute("data-ais-panel-close") !== null) ?? chrome?.children[2];
    close?.click();
    expect(section?.hidden).toBe(true);
    expect(closes).toEqual(["mounts"]);
    expect(visibility).toEqual([false, true, false]);
    expect(host.close("mounts")).toBe(false);
    expect(host.open("nope")).toBe(false);

    host.remove("mounts");
    expect(layer.children).toHaveLength(0);
    expect(host.entries()).toEqual([]);
  });

  test("several panels stagger and dispose removes them all; the style tag is added once per document", () => {
    const doc = new FakeDocument();
    const layer = doc.body.appendChild(doc.createElement("div"));
    const host = createAisPanelHost(asDom(layer));
    createAisPanelHost(asDom(doc.body.appendChild(doc.createElement("div"))));
    expect(doc.head.children.filter((el) => el.id === "ais-panel-style")).toHaveLength(1);
    host.mount("a", { title: "A", moduleName: "A", width: 240, height: 160, onClose: () => {} });
    host.mount("b", { title: "B", moduleName: "B", width: 240, height: 160, onClose: () => {} });
    expect(layer.children.map((el) => el.style.right)).toEqual(["16px", "40px"]);
    // Re-mounting the same id replaces the old section instead of duplicating it.
    host.mount("a", { title: "A2", moduleName: "A", width: 240, height: 160, onClose: () => {} });
    expect(host.entries().map((e) => `${e.packageId}:${e.title}`)).toEqual(["b:B", "a:A2"]);
    host.dispose();
    expect(layer.children).toHaveLength(0);
  });
});
