/**
 * jq.js — an ArenaStar-authored jQuery-compatible subset (D-483, R-04).
 *
 * Foundry v1 applications receive their rendered markup as a jQuery object (`activateListeners(html)`)
 * and module code chains `html.find(...).click(...)`, `.val()`, `.on("change", "input", fn)` and so
 * on. The AIS sandbox cannot load jQuery itself, so this file implements the traversal, manipulation,
 * attribute, form, event (incl. delegated + namespaced) and instant "animation" methods those
 * modules use, over the native DOM. `$.fn` is the prototype, so simple plugins register normally.
 *
 * Not implemented: `$.ajax`/`$.get`/`$.post` (the sandbox has no network), Deferred/Callbacks,
 * `.live/.delegate`, real animations (they complete immediately) and the Sizzle-only selectors.
 */
(() => {
  "use strict";
  const create = (doc) => {
    const win = doc.defaultView ?? globalThis;
    const dataStore = new WeakMap();
    const handlerStore = new WeakMap();
    const UNITLESS = new Set(["opacity", "zIndex", "fontWeight", "lineHeight", "flex", "flexGrow", "flexShrink", "order", "zoom"]);
    const camel = (text) => text.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
    const isHtml = (text) => /^\s*<[\w!][^>]*>/.test(text);
    const parseHtml = (html) => {
      const template = doc.createElement("template");
      template.innerHTML = String(html).trim();
      return [...template.content.childNodes];
    };
    const toNodes = (content) => {
      if (content === null || content === undefined) return [];
      if (content instanceof JQ) return [...content];
      if (typeof content === "string") return isHtml(content) ? parseHtml(content) : [doc.createTextNode(content)];
      if (typeof content === "number") return [doc.createTextNode(String(content))];
      if (content.nodeType) return [content];
      if (typeof content[Symbol.iterator] === "function") return [...content].flatMap(toNodes);
      return [];
    };
    const matches = (element, selector) => element.nodeType === 1 && element.matches(selector);
    const unique = (nodes) => [...new Set(nodes)];
    const coerceData = (value) => {
      if (value === "true") return true;
      if (value === "false") return false;
      if (value === "null") return null;
      if (value !== "" && !Number.isNaN(Number(value)) && String(Number(value)) === value) return Number(value);
      if (/^[[{]/.test(value)) { try { return JSON.parse(value); } catch { return value; } }
      return value;
    };
    const elementData = (element) => { let store = dataStore.get(element); if (!store) { store = {}; dataStore.set(element, store); } return store; };
    const parseEvents = (events) => String(events).trim().split(/\s+/).filter(Boolean).map((token) => {
      const [type, ...namespaces] = token.split(".");
      return { type, namespaces };
    });
    const wrapEvent = (event, currentTarget, extra) => new Proxy(event, {
      get(target, key) {
        if (key === "currentTarget") return currentTarget;
        if (key === "originalEvent") return target;
        if (key === "delegateTarget") return currentTarget;
        if (key === "data") return extra?.data;
        if (key === "isDefaultPrevented") return () => target.defaultPrevented;
        if (key === "isPropagationStopped") return () => target.__jqStopped === true;
        if (key === "isImmediatePropagationStopped") return () => target.__jqImmediateStopped === true;
        if (key === "stopPropagation") return () => { target.__jqStopped = true; target.stopPropagation(); };
        if (key === "stopImmediatePropagation") return () => { target.__jqImmediateStopped = true; target.stopImmediatePropagation(); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const visible = (element) => element.nodeType === 1 && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

    class JQ {
      constructor(nodes = [], prevObject = null) {
        let i = 0;
        for (const node of nodes) this[i++] = node;
        this.length = i;
        if (prevObject) this.prevObject = prevObject;
      }
      get jquery() { return "ais-jq/1 (jQuery 3 compatible subset)"; }
      [Symbol.iterator]() { return Array.prototype.slice.call(this, 0, this.length)[Symbol.iterator](); }
      toArray() { return Array.prototype.slice.call(this, 0, this.length); }
      get(index) { return index === undefined ? this.toArray() : this[index < 0 ? this.length + index : index]; }
      pushStack(nodes) { return new JQ(unique(nodes), this); }
      end() { return this.prevObject ?? new JQ(); }
      each(fn) { this.toArray().forEach((node, i) => fn.call(node, i, node)); return this; }
      map(fn) { return this.pushStack(this.toArray().flatMap((node, i) => { const r = fn.call(node, i, node); return r === null || r === undefined ? [] : Array.isArray(r) ? r : [r]; })); }
      eq(index) { const node = this.get(index); return this.pushStack(node ? [node] : []); }
      first() { return this.eq(0); }
      last() { return this.eq(-1); }
      slice(start, end) { return this.pushStack(this.toArray().slice(start, end)); }
      index(target) {
        if (target === undefined) { const el = this[0]; return el?.parentNode ? [...el.parentNode.children].indexOf(el) : -1; }
        const node = typeof target === "string" ? $(target)[0] : target instanceof JQ ? target[0] : target;
        return this.toArray().indexOf(node);
      }
      add(content) { return this.pushStack([...this, ...toNodes(typeof content === "string" && !isHtml(content) ? $(content) : content)]); }
      // ── traversal ──
      find(selector) {
        if (typeof selector !== "string") return this.pushStack(toNodes(selector).filter((node) => this.toArray().some((root) => root !== node && root.contains(node))));
        return this.pushStack(this.toArray().flatMap((node) => node.querySelectorAll ? [...node.querySelectorAll(selector)] : []));
      }
      filter(selector) {
        const nodes = this.toArray();
        if (typeof selector === "function") return this.pushStack(nodes.filter((node, i) => selector.call(node, i, node)));
        if (typeof selector === "string") return this.pushStack(nodes.filter((node) => matches(node, selector)));
        const set = new Set(toNodes(selector));
        return this.pushStack(nodes.filter((node) => set.has(node)));
      }
      not(selector) {
        const keep = new Set(this.filter(selector).toArray());
        return this.pushStack(this.toArray().filter((node) => !keep.has(node)));
      }
      is(selector) { return this.filter(selector).length > 0; }
      has(selector) { return this.pushStack(this.toArray().filter((node) => node.querySelector?.(selector))); }
      closest(selector) {
        return this.pushStack(this.toArray().flatMap((node) => {
          if (typeof selector !== "string") { const set = new Set(toNodes(selector)); for (let el = node; el; el = el.parentElement) if (set.has(el)) return [el]; return []; }
          const el = node.nodeType === 1 ? node : node.parentElement;
          const hit = el?.closest(selector);
          return hit ? [hit] : [];
        }));
      }
      parent(selector) { return this.pushStack(this.toArray().map((node) => node.parentNode).filter((node) => node && node.nodeType !== 11 && (!selector || matches(node, selector)))); }
      parents(selector) {
        return this.pushStack(this.toArray().flatMap((node) => { const out = []; for (let el = node.parentElement; el; el = el.parentElement) if (!selector || matches(el, selector)) out.push(el); return out; }));
      }
      parentsUntil(selector) {
        return this.pushStack(this.toArray().flatMap((node) => { const out = []; for (let el = node.parentElement; el && !(selector && matches(el, selector)); el = el.parentElement) out.push(el); return out; }));
      }
      children(selector) { return this.pushStack(this.toArray().flatMap((node) => [...(node.children ?? [])].filter((child) => !selector || matches(child, selector)))); }
      contents() { return this.pushStack(this.toArray().flatMap((node) => [...(node.content?.childNodes ?? node.childNodes ?? [])])); }
      siblings(selector) { return this.pushStack(this.toArray().flatMap((node) => [...(node.parentNode?.children ?? [])].filter((child) => child !== node && (!selector || matches(child, selector))))); }
      next(selector) { return this.pushStack(this.toArray().map((node) => node.nextElementSibling).filter((node) => node && (!selector || matches(node, selector)))); }
      prev(selector) { return this.pushStack(this.toArray().map((node) => node.previousElementSibling).filter((node) => node && (!selector || matches(node, selector)))); }
      nextAll(selector) { return this.pushStack(this.toArray().flatMap((node) => { const out = []; for (let el = node.nextElementSibling; el; el = el.nextElementSibling) if (!selector || matches(el, selector)) out.push(el); return out; })); }
      prevAll(selector) { return this.pushStack(this.toArray().flatMap((node) => { const out = []; for (let el = node.previousElementSibling; el; el = el.previousElementSibling) if (!selector || matches(el, selector)) out.push(el); return out; })); }
      // ── classes / attributes / properties / data ──
      addClass(names) { return this.each((i, el) => { const list = typeof names === "function" ? names.call(el, i, el.className) : names; el.classList?.add(...String(list ?? "").split(/\s+/).filter(Boolean)); }); }
      removeClass(names) { return this.each((i, el) => { if (names === undefined) { el.className = ""; return; } const list = typeof names === "function" ? names.call(el, i, el.className) : names; el.classList?.remove(...String(list ?? "").split(/\s+/).filter(Boolean)); }); }
      toggleClass(names, state) { return this.each((_i, el) => { for (const name of String(names).split(/\s+/).filter(Boolean)) el.classList?.toggle(name, state); }); }
      hasClass(name) { return this.toArray().some((el) => el.classList?.contains(name)); }
      attr(name, value) {
        if (typeof name === "object") { for (const [key, item] of Object.entries(name)) this.attr(key, item); return this; }
        if (value === undefined) { const el = this[0]; const result = el?.getAttribute?.(name); return result === null ? undefined : result; }
        return this.each((i, el) => {
          const item = typeof value === "function" ? value.call(el, i, el.getAttribute(name)) : value;
          if (item === null || item === undefined || item === false) el.removeAttribute(name); else el.setAttribute(name, item === true ? name : String(item));
        });
      }
      removeAttr(name) { return this.each((_i, el) => { for (const item of String(name).split(/\s+/)) el.removeAttribute(item); }); }
      prop(name, value) {
        if (typeof name === "object") { for (const [key, item] of Object.entries(name)) this.prop(key, item); return this; }
        if (value === undefined) return this[0]?.[name];
        return this.each((i, el) => { el[name] = typeof value === "function" ? value.call(el, i, el[name]) : value; });
      }
      removeProp(name) { return this.each((_i, el) => { Reflect.deleteProperty(el, name); }); }
      data(key, value) {
        const el = this[0];
        if (key === undefined) {
          if (!el) return undefined;
          const out = {};
          for (const [k, v] of Object.entries(el.dataset ?? {})) out[k] = coerceData(v);
          return Object.assign(out, elementData(el));
        }
        if (typeof key === "object") { this.each((_i, node) => Object.assign(elementData(node), key)); return this; }
        if (value === undefined) {
          if (!el) return undefined;
          const store = elementData(el);
          const name = camel(String(key));
          if (Object.hasOwn(store, name)) return store[name];
          const raw = el.dataset?.[name];
          return raw === undefined ? undefined : coerceData(raw);
        }
        return this.each((_i, node) => { elementData(node)[camel(String(key))] = value; });
      }
      removeData(key) { return this.each((_i, node) => { if (key === undefined) dataStore.delete(node); else Reflect.deleteProperty(elementData(node), camel(String(key))); }); }
      val(value) {
        const el = this[0];
        if (value === undefined) {
          if (!el) return undefined;
          if (el instanceof win.HTMLSelectElement && el.multiple) return [...el.selectedOptions].map((option) => option.value);
          return el.value;
        }
        return this.each((i, node) => {
          const item = typeof value === "function" ? value.call(node, i, node.value) : value;
          if (node instanceof win.HTMLSelectElement) {
            const wanted = new Set((Array.isArray(item) ? item : [item]).map(String));
            for (const option of node.options) option.selected = wanted.has(option.value);
          } else if (node.type === "checkbox" || node.type === "radio") node.checked = (Array.isArray(item) ? item : [item]).map(String).includes(node.value);
          else node.value = item === null || item === undefined ? "" : String(item);
        });
      }
      text(value) {
        if (value === undefined) return this.toArray().map((node) => node.textContent ?? "").join("");
        return this.each((i, node) => { node.textContent = typeof value === "function" ? value.call(node, i, node.textContent) : String(value); });
      }
      html(value) {
        if (value === undefined) return this[0]?.innerHTML;
        return this.each((i, node) => {
          const item = typeof value === "function" ? value.call(node, i, node.innerHTML) : value;
          if (item instanceof JQ || item?.nodeType) { node.replaceChildren(...toNodes(item)); return; }
          node.innerHTML = item === null || item === undefined ? "" : String(item);
        });
      }
      css(name, value) {
        if (typeof name === "object") { for (const [key, item] of Object.entries(name)) this.css(key, item); return this; }
        if (value === undefined) { const el = this[0]; return el ? win.getComputedStyle(el).getPropertyValue(name.startsWith("--") ? name : name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)) : undefined; }
        return this.each((i, el) => {
          const item = typeof value === "function" ? value.call(el, i, el.style[camel(name)]) : value;
          const prop = camel(name);
          if (name.startsWith("--")) el.style.setProperty(name, item);
          else el.style[prop] = typeof item === "number" && !UNITLESS.has(prop) ? `${item}px` : item;
        });
      }
      // ── dimensions ──
      width(value) { if (value !== undefined) return this.css("width", value); const el = this[0]; return el ? (el === win ? win.innerWidth : el === doc ? doc.documentElement.scrollWidth : el.getBoundingClientRect().width) : undefined; }
      height(value) { if (value !== undefined) return this.css("height", value); const el = this[0]; return el ? (el === win ? win.innerHeight : el === doc ? doc.documentElement.scrollHeight : el.getBoundingClientRect().height) : undefined; }
      innerWidth() { return this[0]?.clientWidth; }
      innerHeight() { return this[0]?.clientHeight; }
      outerWidth(margin) { const el = this[0]; if (!el) return undefined; const style = win.getComputedStyle(el); return el.offsetWidth + (margin ? parseFloat(style.marginLeft) + parseFloat(style.marginRight) : 0); }
      outerHeight(margin) { const el = this[0]; if (!el) return undefined; const style = win.getComputedStyle(el); return el.offsetHeight + (margin ? parseFloat(style.marginTop) + parseFloat(style.marginBottom) : 0); }
      offset() { const el = this[0]; if (!el?.getBoundingClientRect) return undefined; const rect = el.getBoundingClientRect(); return { top: rect.top + win.scrollY, left: rect.left + win.scrollX }; }
      position() { const el = this[0]; return el ? { top: el.offsetTop, left: el.offsetLeft } : undefined; }
      scrollTop(value) { if (value === undefined) return this[0] === win ? win.scrollY : this[0]?.scrollTop; return this.each((_i, el) => { el.scrollTop = value; }); }
      scrollLeft(value) { if (value === undefined) return this[0]?.scrollLeft; return this.each((_i, el) => { el.scrollLeft = value; }); }
      // ── manipulation ──
      append(...contents) { return this.each((_i, node) => node.append(...contents.flatMap((c) => toNodes(typeof c === "function" ? c.call(node) : c)).map((n) => (this.length > 1 ? n.cloneNode(true) : n)))); }
      prepend(...contents) { return this.each((_i, node) => node.prepend(...contents.flatMap(toNodes).map((n) => (this.length > 1 ? n.cloneNode(true) : n)))); }
      before(...contents) { return this.each((_i, node) => node.before(...contents.flatMap(toNodes))); }
      after(...contents) { return this.each((_i, node) => node.after(...contents.flatMap(toNodes))); }
      appendTo(target) { $(target).append(this); return this; }
      prependTo(target) { $(target).prepend(this); return this; }
      insertBefore(target) { $(target).before(this); return this; }
      insertAfter(target) { $(target).after(this); return this; }
      replaceWith(content) { return this.each((_i, node) => node.replaceWith(...toNodes(typeof content === "function" ? content.call(node) : content))); }
      replaceAll(target) { $(target).replaceWith(this); return this; }
      wrap(wrapper) { return this.each((_i, node) => { const wrap = toNodes(wrapper)[0]?.cloneNode(true); if (!wrap) return; node.replaceWith(wrap); (wrap.querySelector("*:not(:has(*))") ?? wrap).append(node); }); }
      wrapInner(wrapper) { return this.each((_i, node) => { const wrap = toNodes(wrapper)[0]?.cloneNode(true); if (!wrap) return; wrap.append(...node.childNodes); node.append(wrap); }); }
      unwrap() { return this.each((_i, node) => { const parent = node.parentNode; if (parent && parent !== doc.body) parent.replaceWith(...parent.childNodes); }); }
      remove() { return this.each((_i, node) => { handlerStore.delete(node); dataStore.delete(node); node.remove(); }); }
      detach() { return this.each((_i, node) => node.remove()); }
      empty() { return this.each((_i, node) => node.replaceChildren()); }
      clone() { return this.pushStack(this.toArray().map((node) => node.cloneNode(true))); }
      // ── visibility and instant "animations" ──
      show() { return this.each((_i, el) => { if (!el.style) return; if (el.style.display === "none") el.style.display = ""; if (win.getComputedStyle(el).display === "none") el.style.display = "block"; }); }
      hide() { return this.each((_i, el) => { if (el.style) el.style.display = "none"; }); }
      toggle(state) { return this.each((_i, el) => { const show = state === undefined ? !visible(el) : !!state; $(el)[show ? "show" : "hide"](); }); }
      slideDown(_d, cb) { return this.show().#done(cb); }
      slideUp(_d, cb) { return this.hide().#done(cb); }
      slideToggle(_d, cb) { return this.toggle().#done(cb); }
      fadeIn(_d, cb) { return this.show().#done(cb); }
      fadeOut(_d, cb) { return this.hide().#done(cb); }
      fadeToggle(_d, cb) { return this.toggle().#done(cb); }
      animate(props, _d, _e, cb) { this.css(props ?? {}); return this.#done(typeof _d === "function" ? _d : typeof _e === "function" ? _e : cb); }
      stop() { return this; }
      promise() { return Promise.resolve(this); }
      #done(callback) { if (typeof callback === "function") win.setTimeout(() => this.each((_i, el) => callback.call(el)), 0); return this; }
      // ── events ──
      on(events, selector, data, handler) {
        if (typeof selector === "function") { handler = selector; selector = null; data = undefined; }
        else if (typeof data === "function") { handler = data; data = undefined; }
        if (typeof events === "object") { for (const [name, fn] of Object.entries(events)) this.on(name, selector, data, fn); return this; }
        if (typeof handler !== "function") return this;
        for (const { type, namespaces } of parseEvents(events)) {
          this.each((_i, node) => {
            const listener = (event) => {
              if (event.__jqImmediateStopped) return;
              let currentTarget = node;
              if (selector) {
                const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
                const hit = target?.closest?.(selector);
                if (!hit || !node.contains(hit)) return;
                currentTarget = hit;
              }
              const extra = { data };
              const wrapped = wrapEvent(event, currentTarget, extra);
              const result = handler.call(currentTarget, wrapped, ...(event.__jqExtra ?? []));
              if (result === false) { event.preventDefault(); event.stopPropagation(); }
              return result;
            };
            let records = handlerStore.get(node);
            if (!records) { records = []; handlerStore.set(node, records); }
            records.push({ type, namespaces, selector, handler, listener });
            node.addEventListener(type, listener);
          });
        }
        return this;
      }
      one(events, selector, data, handler) {
        if (typeof selector === "function") { handler = selector; selector = null; }
        else if (typeof data === "function") { handler = data; }
        // jQuery semantics: the wrapper detaches itself from the element it fired on (`this`).
        const once = function (...args) { $(this).off(events, once); return handler.apply(this, args); };
        once.__jqOnce = handler;
        return this.on(events, typeof selector === "string" ? selector : null, undefined, once);
      }
      off(events, selector, handler) {
        if (typeof selector === "function") { handler = selector; selector = undefined; }
        const wanted = events === undefined ? null : parseEvents(events);
        return this.each((_i, node) => {
          const records = handlerStore.get(node);
          if (!records) return;
          const keep = [];
          for (const record of records) {
            const hit = !wanted || wanted.some(({ type, namespaces }) => (!type || type === record.type) && namespaces.every((ns) => record.namespaces.includes(ns)));
            const sameSelector = selector === undefined || record.selector === selector;
            const sameHandler = handler === undefined || record.handler === handler || record.handler.__jqOnce === handler;
            if (hit && sameSelector && sameHandler) node.removeEventListener(record.type, record.listener);
            else keep.push(record);
          }
          handlerStore.set(node, keep);
        });
      }
      trigger(eventOrName, extra) {
        const params = extra === undefined ? [] : Array.isArray(extra) ? extra : [extra];
        return this.each((_i, node) => {
          const type = typeof eventOrName === "string" ? eventOrName.split(".")[0] : eventOrName.type;
          if (type === "focus" || type === "blur") { node[type]?.(); return; }
          // Sandboxed documents never get a native submit; the synthetic event reaches every listener the same way.
          if (type === "submit" && node instanceof win.HTMLFormElement) {
            node.dispatchEvent(new win.SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: node.querySelector('button[type="submit"], button:not([type]), input[type="submit"]') }));
            return;
          }
          let event;
          if (typeof eventOrName !== "string") event = eventOrName;
          else if (/^(click|dblclick|mousedown|mouseup|mouseenter|mouseleave|mouseover|mouseout|contextmenu)$/.test(type)) event = new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win });
          else if (/^(keydown|keyup|keypress)$/.test(type)) event = new win.KeyboardEvent(type, { bubbles: true, cancelable: true });
          else if (/^(change|input|reset|select|scroll)$/.test(type)) event = new win.Event(type, { bubbles: type !== "scroll", cancelable: true });
          else event = new win.CustomEvent(type, { bubbles: true, cancelable: true, detail: params[0] });
          if (params.length) event.__jqExtra = params;
          node.dispatchEvent(event);
        });
      }
      triggerHandler(name, extra) {
        const node = this[0];
        if (!node) return undefined;
        const event = new win.CustomEvent(String(name).split(".")[0], { bubbles: false, cancelable: true });
        if (extra !== undefined) event.__jqExtra = Array.isArray(extra) ? extra : [extra];
        let result;
        for (const record of handlerStore.get(node) ?? []) if (record.type === event.type && !record.selector) result = record.handler.call(node, wrapEvent(event, node), ...(event.__jqExtra ?? []));
        return result;
      }
      hover(enter, leave) { return this.on("mouseenter", enter).on("mouseleave", leave ?? enter); }
      ready(fn) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", () => fn($)); else fn($); return this; }
      serializeArray() {
        return this.toArray().flatMap((node) => {
          const elements = node instanceof win.HTMLFormElement ? [...node.elements] : node.matches?.("input,select,textarea") ? [node] : [...(node.querySelectorAll?.("input,select,textarea") ?? [])];
          return elements.flatMap((el) => {
            if (!el.name || el.disabled || ((el.type === "checkbox" || el.type === "radio") && !el.checked) || ["submit", "button", "reset", "file"].includes(el.type)) return [];
            if (el instanceof win.HTMLSelectElement && el.multiple) return [...el.selectedOptions].map((option) => ({ name: el.name, value: option.value }));
            return [{ name: el.name, value: el.value }];
          });
        });
      }
      serialize() { return this.serializeArray().map(({ name, value }) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&"); }
    }
    for (const name of ["click", "dblclick", "change", "input", "submit", "focus", "blur", "focusin", "focusout", "keydown", "keyup", "keypress", "mousedown", "mouseup",
      "mouseenter", "mouseleave", "mouseover", "mouseout", "mousemove", "contextmenu", "scroll", "resize", "select", "wheel", "drop", "dragstart", "dragover", "dragenter", "dragleave", "dragend"]) {
      JQ.prototype[name] = function (data, handler) { return (typeof data === "function" || typeof handler === "function") ? this.on(name, undefined, typeof data === "function" ? undefined : data, typeof data === "function" ? data : handler) : this.trigger(name); };
    }

    const $ = (selector, context) => {
      if (selector === undefined || selector === null) return new JQ();
      if (selector instanceof JQ) return new JQ([...selector]);
      if (typeof selector === "function") { new JQ([doc]).ready(selector); return new JQ([doc]); }
      if (typeof selector === "string") {
        if (isHtml(selector)) return new JQ(parseHtml(selector));
        const roots = context ? $(context).toArray() : [doc];
        return new JQ(unique(roots.flatMap((root) => (root.querySelectorAll ? [...root.querySelectorAll(selector)] : []))));
      }
      if (selector === win || selector.nodeType) return new JQ([selector]);
      if (typeof selector[Symbol.iterator] === "function") return new JQ(unique([...selector].filter((node) => node?.nodeType || node === win)));
      return new JQ([selector]);
    };
    $.fn = JQ.prototype;
    $.fn.extend = (methods) => Object.assign(JQ.prototype, methods);
    $.extend = (...args) => {
      let deep = false;
      if (typeof args[0] === "boolean") deep = args.shift();
      const target = args.shift() ?? {};
      const merge = (into, from) => {
        for (const [key, value] of Object.entries(from ?? {})) {
          if (deep && value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
            into[key] = merge(into[key] && typeof into[key] === "object" ? into[key] : {}, value);
          else if (value !== undefined) into[key] = deep && Array.isArray(value) ? [...value] : value;
        }
        return into;
      };
      for (const source of args) merge(target, source);
      return target;
    };
    $.each = (collection, fn) => {
      if (Array.isArray(collection) || typeof collection?.length === "number") Array.prototype.some.call(collection, (item, i) => fn.call(item, i, item) === false);
      else Object.entries(collection ?? {}).some(([key, item]) => fn.call(item, key, item) === false);
      return collection;
    };
    $.map = (collection, fn) => (Array.isArray(collection) ? collection.flatMap((item, i) => { const r = fn(item, i); return r === null || r === undefined ? [] : [r]; })
      : Object.entries(collection ?? {}).flatMap(([key, item]) => { const r = fn(item, key); return r === null || r === undefined ? [] : [r]; }));
    $.grep = (array, fn, invert = false) => array.filter((item, i) => !!fn(item, i) !== invert);
    $.inArray = (item, array) => (array ?? []).indexOf(item);
    $.isArray = Array.isArray;
    $.isFunction = (value) => typeof value === "function";
    $.isPlainObject = (value) => !!value && Object.getPrototypeOf(value) === Object.prototype;
    $.isEmptyObject = (value) => !value || Object.keys(value).length === 0;
    $.isNumeric = (value) => value !== "" && value !== null && !Number.isNaN(Number(value));
    $.trim = (text) => String(text ?? "").trim();
    $.noop = () => {};
    $.now = () => Date.now();
    $.contains = (container, node) => container !== node && container.contains(node);
    $.unique = unique;
    $.uniqueSort = unique;
    $.parseHTML = (html) => parseHtml(html);
    $.parseJSON = (text) => JSON.parse(text);
    $.camelCase = camel;
    $.type = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
    $.Event = (type, props) => Object.assign(new win.CustomEvent(type, { bubbles: true, cancelable: true }), props ?? {});
    $.when = (...promises) => Promise.all(promises);
    $.expr = { ":": {}, pseudos: {} };
    for (const name of ["ajax", "get", "post", "getJSON", "getScript", "load"])
      $[name] = () => { throw new Error(`jQuery.${name} is not available: the AIS sandbox has no network access`); };
    $.Deferred = () => { throw new Error("jQuery.Deferred is not available in the AIS sandbox; use Promise"); };
    $.JQ = JQ;
    return $;
  };
  globalThis.__aisFoundryJq = Object.freeze({ create });
})();
