/**
 * ui.js — Foundry application UI inside the AIS sandbox (D-483, R-04).
 *
 * ArenaStar-authored implementations of the Foundry client classes a module's UI code touches:
 * Application / FormApplication / DocumentSheet / Dialog / Tabs (v1, jQuery-flavoured),
 * ApplicationV2 / HandlebarsApplicationMixin / DialogV2 / DocumentSheetV2 (v2, element-flavoured),
 * FormDataExtended, renderTemplate / loadTemplates / getTemplate over the module's own `.hbs`
 * resources, and Foundry's core Handlebars helpers. Windows are drawn by a small in-frame window
 * manager inside the module's own panel document (D-470 `ui.panel`): the shell shows the panel
 * while at least one window is open and hides it when the last one closes.
 *
 * `install(deps)` is called by adapter.js once `Hooks`, `i18n` and the resource index exist.
 */
(() => {
  "use strict";
  const install = (deps) => {
    const { AIS, Hooks, i18n, warn, resources, foundryId, Handlebars, $, utils } = deps;
    const { mergeObject, expandObject, escapeHTML } = utils;
    const doc = document;
    const SafeString = Handlebars.SafeString;
    // D-484: the emulator's core resource library (templates/lang/css) and the data-field layer.
    const core = globalThis.__aisFoundryCore ?? null;
    const fieldsLayer = globalThis.__aisFoundryFields ? globalThis.__aisFoundryFields.install({ i18n, escapeHTML, doc }) : null;

    // ═══════════════════════════ templates ═══════════════════════════
    const compiledTemplates = new Map();
    const normalizeTemplatePath = (path) => {
      let p = String(path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
      const prefix = `modules/${foundryId}/`;
      if (p.startsWith(prefix)) p = p.slice(prefix.length);
      return p;
    };
    /** D-484: templates the module used from the core library, and core paths it asked for that the library lacks. */
    const templateDiagnostics = { core: new Set(), missing: new Set() };
    const templateSource = (path) => {
      const key = normalizeTemplatePath(path);
      if (resources.has(key)) return { key, source: resources.get(key), origin: "module" };
      if (resources.has(path)) return { key: path, source: resources.get(path), origin: "module" };
      // Resolution order: the module's own files, then the emulator's core library (every Foundry
      // generation's name for a template resolves to the same entry) — modules never ship core files.
      const canonical = core?.resolveTemplate(key);
      if (canonical) return { key: `core:${canonical}`, source: core.templates[canonical], origin: "core", canonical };
      return null;
    };
    const compileTemplate = (path) => {
      const found = templateSource(path);
      if (!found) {
        const normalized = normalizeTemplatePath(path);
        if (/^templates\//.test(normalized)) {
          templateDiagnostics.missing.add(normalized);
          throw new Error(`Core template ${normalized} is not in the AIS Foundry core library yet (${core ? core.templatePaths.length : 0} core templates are); report it with the module name so it can be added.`);
        }
        if (/^systems\//.test(normalized)) throw new Error(`Template ${normalized} belongs to a game system; system templates are outside the Foundry core-API target (Target B).`);
        throw new Error(`Template ${path} is not part of ${foundryId}'s distribution.`);
      }
      if (found.origin === "core") templateDiagnostics.core.add(found.canonical);
      let fn = compiledTemplates.get(found.key);
      if (!fn) {
        fn = Handlebars.compile(found.source);
        compiledTemplates.set(found.key, fn);
      }
      return fn;
    };
    Handlebars.partialResolver = (name) => {
      const found = templateSource(name);
      if (found?.origin === "core") templateDiagnostics.core.add(found.canonical);
      return found?.source;
    };
    const describeTemplates = () => ({ compiled: compiledTemplates.size, core: [...templateDiagnostics.core].sort(), missing: [...templateDiagnostics.missing].sort() });
    const getTemplate = async (path) => compileTemplate(path);
    const renderTemplate = async (path, data = {}) => compileTemplate(path)(data, { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true });
    const loadTemplates = async (paths) => {
      const entries = Array.isArray(paths) ? paths.map((path) => [path, path]) : Object.entries(paths ?? {});
      return entries.map(([name, path]) => {
        const fn = compileTemplate(path);
        Handlebars.registerPartial(name, fn);
        if (name !== path) Handlebars.registerPartial(path, fn);
        return fn;
      });
    };

    // ═══════════════════════════ Foundry core Handlebars helpers ═══════════════════════════
    const localizeText = (key, hash = {}) => {
      const text = key instanceof SafeString ? key.toString() : String(key ?? "");
      return Object.keys(hash).length ? i18n.format(text, hash) : i18n.localize(text);
    };
    const attr = (name, value) => (value === undefined || value === null || value === false ? "" : ` ${name}="${escapeHTML(String(value))}"`);
    const choiceEntries = (choices, { valueAttr, labelAttr, inverted, localize }) => {
      const rows = [];
      if (Array.isArray(choices)) {
        for (const item of choices) {
          if (item && typeof item === "object") rows.push({ value: item[valueAttr ?? "value"], label: item[labelAttr ?? "label"], group: item.group });
          else rows.push({ value: item, label: item });
        }
      } else if (choices instanceof Map) {
        for (const [value, label] of choices) rows.push({ value, label });
      } else if (choices && typeof choices === "object") {
        for (const [key, item] of Object.entries(choices)) {
          if (item && typeof item === "object") rows.push({ value: valueAttr ? item[valueAttr] : key, label: item[labelAttr ?? "label"], group: item.group });
          else rows.push(inverted ? { value: item, label: key } : { value: key, label: item });
        }
      }
      for (const row of rows) row.label = localize ? i18n.localize(String(row.label ?? row.value)) : String(row.label ?? row.value ?? "");
      return rows;
    };
    const coreHelpers = {
      localize(key, options) { return localizeText(key, options?.hash); },
      concat(...args) { const options = args.pop(); return new SafeString(args.join(options?.hash?.join ?? "")); },
      eq: (a, b) => a === b, ne: (a, b) => a !== b, lt: (a, b) => a < b, gt: (a, b) => a > b, lte: (a, b) => a <= b, gte: (a, b) => a >= b,
      and(...args) { args.pop(); return args.every(Boolean); },
      or(...args) { args.pop(); return args.some(Boolean); },
      not: (a) => !a,
      ifThen: (condition, a, b) => (condition ? a : b),
      checked: (value) => (value ? "checked" : ""),
      disabled: (value) => (value ? "disabled" : ""),
      json: (value) => new SafeString(JSON.stringify(value)),
      numberFormat(value, options) {
        const decimals = Number(options?.hash?.decimals ?? 0);
        const number = Number(value ?? 0);
        const text = Number.isFinite(number) ? number.toFixed(decimals) : String(value);
        return options?.hash?.sign && number > 0 ? `+${text}` : text;
      },
      timeSince(value) {
        const ms = Date.now() - new Date(value).getTime();
        if (!Number.isFinite(ms)) return "";
        const minutes = Math.floor(ms / 60_000);
        if (minutes < 1) return "now";
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
      },
      select(selected, options) {
        const html = options.fn(this);
        const escaped = String(selected ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return html.replace(new RegExp(` value=["']${escaped}["']`), "$& selected");
      },
      selectOptions(choices, options) {
        const hash = options?.hash ?? {};
        const selected = hash.selected === undefined || hash.selected === null ? [] : hash.selected instanceof Set ? [...hash.selected] : Array.isArray(hash.selected) ? hash.selected : [hash.selected];
        const selectedText = selected.map((value) => String(value));
        const rows = choiceEntries(choices, hash);
        if (hash.sort) rows.sort((a, b) => a.label.localeCompare(b.label));
        let html = hash.blank !== undefined && hash.blank !== null && hash.blank !== false ? `<option value=""${selectedText.includes("") ? " selected" : ""}>${escapeHTML(String(hash.blank))}</option>` : "";
        let openGroup = null;
        for (const row of rows) {
          const group = hash.groups === undefined && row.group ? String(row.group) : null;
          if (group !== openGroup) {
            if (openGroup !== null) html += "</optgroup>";
            if (group !== null) html += `<optgroup label="${escapeHTML(group)}">`;
            openGroup = group;
          }
          html += `<option${attr("value", row.value)}${selectedText.includes(String(row.value)) ? " selected" : ""}>${escapeHTML(row.label)}</option>`;
        }
        if (openGroup !== null) html += "</optgroup>";
        return new SafeString(html);
      },
      radioBoxes(name, choices, options) {
        const hash = options?.hash ?? {};
        const checked = String(hash.checked ?? "");
        const html = choiceEntries(choices, hash).map((row) =>
          `<label class="checkbox"><input type="radio"${attr("name", name)}${attr("value", row.value)}${String(row.value) === checked ? " checked" : ""}> ${escapeHTML(row.label)}</label>`).join("");
        return new SafeString(html);
      },
      checkboxes(name, choices, options) {
        const hash = options?.hash ?? {};
        const checked = new Set((Array.isArray(hash.checked) ? hash.checked : hash.checked === undefined ? [] : [hash.checked]).map(String));
        const html = choiceEntries(choices, hash).map((row) =>
          `<label class="checkbox"><input type="checkbox"${attr("name", name)}${attr("value", row.value)}${checked.has(String(row.value)) ? " checked" : ""}> ${escapeHTML(row.label)}</label>`).join("");
        return new SafeString(html);
      },
      rangePicker(options) {
        const hash = options?.hash ?? {};
        const value = hash.value ?? hash.min ?? 0;
        return new SafeString(`<input type="range"${attr("name", hash.name)}${attr("value", value)}${attr("min", hash.min)}${attr("max", hash.max)}${attr("step", hash.step)}><span class="range-value">${escapeHTML(String(value))}</span>`);
      },
      colorPicker(options) {
        const hash = options?.hash ?? {};
        const value = hash.value ?? hash.default ?? "";
        return new SafeString(`<input class="color" type="text"${attr("name", hash.name)}${attr("value", value)}><input type="color"${attr("value", value || "#000000")}${attr("data-edit", hash.name)}>`);
      },
      editor(...args) {
        const options = args.pop();
        const hash = options?.hash ?? {};
        const content = args.length ? args[0] : hash.content;
        const target = hash.target;
        if (!target) throw new Error("You must define the name of a target field in the editor helper");
        const text = content instanceof SafeString ? content.toString() : String(content ?? "");
        if (hash.editable === false) return new SafeString(`<div class="editor"><div class="editor-content" data-edit="${escapeHTML(target)}">${text}</div></div>`);
        return new SafeString(`<div class="editor ais-editor-fallback"><textarea class="editor-content" name="${escapeHTML(target)}" rows="6">${escapeHTML(text)}</textarea></div>`);
      },
      filePicker(options) {
        const hash = options?.hash ?? {};
        return new SafeString(`<button type="button" class="file-picker" disabled${attr("data-type", hash.type)}${attr("data-target", hash.target)} title="File pickers are not available in the AIS sandbox"><i class="fas fa-file-import fa-fw"></i></button>`);
      },
      formInput(field, options) { return new SafeString(fieldsLayer ? fieldsLayer.html(fieldsLayer.renderInput(field, options?.hash ?? {})) : formInputHtml(field, options?.hash ?? {})); },
      formField(field, options) { return new SafeString(fieldsLayer ? fieldsLayer.html(fieldsLayer.renderGroup(field, options?.hash ?? {})) : formGroupHtml(field, options?.hash ?? {})); },
      formGroup(field, options) { return new SafeString(fieldsLayer ? fieldsLayer.html(fieldsLayer.renderGroup(field, options?.hash ?? {})) : formGroupHtml(field, options?.hash ?? {})); },
      formFieldset(options) { return new SafeString(`<fieldset>${options?.hash?.legend ? `<legend>${escapeHTML(localizeText(options.hash.legend))}</legend>` : ""}${options?.fn ? options.fn(this) : ""}</fieldset>`); },
      object(options) { return options?.hash ?? {}; },
      array(...args) { args.pop(); return args; },
      log(...args) { args.pop(); console.log("Foundry template |", ...args); },
    };
    /** Duck-typed DataField rendering: enough for `{{formGroup field value=…}}` on simple string/number/boolean/choice fields. */
    const fieldName = (field, hash) => hash.name ?? field?.fieldPath ?? field?.name ?? "";
    const formInputHtml = (field, hash) => {
      const name = fieldName(field, hash);
      const value = hash.value ?? field?.initial ?? "";
      const kind = field?.constructor?.name ?? "";
      const choices = hash.choices ?? field?.choices;
      if (choices) return `<select${attr("name", name)}${hash.disabled ? " disabled" : ""}>${coreHelpers.selectOptions(choices, { hash: { selected: value, localize: hash.localize, blank: hash.blank } })}</select>`;
      if (kind === "BooleanField" || typeof value === "boolean") return `<input type="checkbox"${attr("name", name)}${value ? " checked" : ""}${hash.disabled ? " disabled" : ""}>`;
      if (kind === "NumberField" || typeof value === "number") return `<input type="number"${attr("name", name)}${attr("value", value)}${attr("min", field?.min)}${attr("max", field?.max)}${attr("step", field?.step)}${hash.disabled ? " disabled" : ""}>`;
      if (kind === "HTMLField") return `<textarea${attr("name", name)} rows="4">${escapeHTML(String(value))}</textarea>`;
      return `<input type="text"${attr("name", name)}${attr("value", value)}${attr("placeholder", hash.placeholder)}${hash.disabled ? " disabled" : ""}>`;
    };
    const formGroupHtml = (field, hash) => {
      const label = hash.label ?? field?.label ?? fieldName(field, hash);
      const hint = hash.hint ?? field?.hint;
      const localize = hash.localize ?? false;
      return `<div class="form-group${hash.stacked ? " stacked" : ""}${hash.classes ? ` ${escapeHTML(String(hash.classes))}` : ""}">`
        + `<label>${escapeHTML(localize ? i18n.localize(String(label)) : String(label))}</label>`
        + `<div class="form-fields">${formInputHtml(field, hash)}</div>`
        + (hint ? `<p class="hint">${escapeHTML(localize ? i18n.localize(String(hint)) : String(hint))}</p>` : "") + "</div>";
    };
    Handlebars.registerHelper(coreHelpers);

    // ═══════════════════════════ FormDataExtended ═══════════════════════════
    const castDtype = (value, dtype) => {
      switch (dtype) {
        case "Number": return value === "" || value === null || value === undefined ? null : Number(value);
        case "Boolean": return typeof value === "boolean" ? value : ["true", "1", "on", "yes"].includes(String(value).toLowerCase());
        case "JSON": try { return value === "" ? null : JSON.parse(value); } catch { return value; }
        case "String": return value === null || value === undefined ? "" : String(value);
        default: return value;
      }
    };
    class FormDataExtended extends FormData {
      constructor(form, { dtypes = {}, editors = {}, disabled = false, readonly = false } = {}) {
        super();
        this.dtypes = dtypes;
        this.editors = editors;
        this.object = {};
        if (form) this.#process(form, { disabled, readonly });
      }
      #process(form, options) {
        const groups = new Map();
        for (const el of form.elements) {
          if (!el.name || ["button", "submit", "reset", "file", "fieldset", "output"].includes(el.type)) continue;
          if (el.disabled && !options.disabled) continue;
          if (el.readOnly && !options.readonly && !(el.type === "checkbox" || el.type === "radio")) continue;
          if (!groups.has(el.name)) groups.set(el.name, []);
          groups.get(el.name).push(el);
        }
        for (const [name, elements] of groups) {
          const dtype = this.dtypes[name] ?? elements.find((el) => el.dataset.dtype)?.dataset.dtype;
          let value;
          const first = elements[0];
          if (first.type === "checkbox") {
            if (elements.length > 1) value = elements.filter((el) => el.checked).map((el) => castDtype(el.value, dtype));
            else value = first.checked ? (first.value && first.value !== "on" ? castDtype(first.value, dtype) : true) : false;
          } else if (first.type === "radio") {
            const checked = elements.find((el) => el.checked);
            value = checked ? castDtype(checked.value, dtype ?? "String") : null;
          } else if (first instanceof HTMLSelectElement) {
            value = first.multiple ? [...first.selectedOptions].map((option) => castDtype(option.value, dtype)) : castDtype(first.value, dtype);
          } else if (first.type === "number" || first.type === "range") {
            value = first.value === "" ? null : Number(first.value);
            if (dtype && dtype !== "Number") value = castDtype(first.value, dtype);
          } else {
            value = castDtype(first.value, dtype);
          }
          this.object[name] = value;
          this.append(name, value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
        }
      }
      get(name) { return this.object[name]; }
      set(name, value) { this.object[name] = value; super.set(name, String(value)); }
      delete(name) { Reflect.deleteProperty(this.object, name); super.delete(name); }
      toObject() { return expandObject(this.object); }
    }

    // ═══════════════════════════ window manager ═══════════════════════════
    const STYLE = `
      html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
      body { position: relative; font: 13px/1.4 system-ui, sans-serif; color: #e8e4dc; }
      .hidden { display: none !important; }
      .flexrow { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 4px; }
      .flexcol { display: flex; flex-direction: column; gap: 4px; }
      .flexrow > * { flex: 1; } .flexrow > .flex0 { flex: 0 0 auto; } .flex1 { flex: 1; } .flex2 { flex: 2; } .flex3 { flex: 3; }
      .app, .application { position: absolute; display: flex; flex-direction: column; min-width: 200px; min-height: 80px; max-width: 100%; max-height: 100%;
        background: #1d1c22; color: #e8e4dc; border: 1px solid #5a4a2a; border-radius: 6px; box-shadow: 0 8px 28px rgba(0,0,0,.55); overflow: hidden; }
      .window-header { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: #2b2a33; border-bottom: 1px solid #4b4a55;
        cursor: move; user-select: none; }
      .window-header .window-title { flex: 1 1 auto; margin: 0; font: 600 13px/1.3 system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .window-header .header-button, .window-header .header-control { flex: 0 0 auto; cursor: pointer; color: #cfc9bd; background: none; border: 0; font: 12px system-ui, sans-serif; padding: 2px 4px; }
      .window-header .header-button:hover, .window-header .header-control:hover { color: #fff; }
      .window-content { flex: 1 1 auto; overflow: auto; padding: 8px; background: #26252d; }
      .app.minimized .window-content, .application.minimized .window-content { display: none; }
      .app.minimized, .application.minimized { min-height: 0; height: auto !important; }
      form { margin: 0; }
      .form-group { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
      .form-group > label { flex: 2; font-weight: 600; }
      .form-group .form-fields { flex: 3; display: flex; align-items: center; gap: 4px; }
      .form-group.stacked { flex-direction: column; align-items: stretch; }
      .form-group .hint, .notes { flex: 0 0 100%; margin: 0; font-size: 12px; color: #a9a39a; }
      .form-footer, .dialog-buttons, .sheet-footer { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
      input, select, textarea, button { font: inherit; color: #e8e4dc; background: #15141a; border: 1px solid #4b4a55; border-radius: 3px; padding: 3px 6px; }
      input[type="checkbox"], input[type="radio"] { width: auto; }
      input[type="range"] { padding: 0; background: none; border: 0; }
      button, .dialog-button { cursor: pointer; background: #3a3946; }
      button:hover, .dialog-button:hover { background: #4a4958; }
      button:disabled { cursor: not-allowed; opacity: .6; }
      .dialog-content, .dialog .window-content { font-size: 13px; }
      .tabs, nav.tabs { display: flex; gap: 2px; border-bottom: 1px solid #4b4a55; margin-bottom: 6px; }
      .tabs .item, nav.tabs > a { flex: 1; padding: 4px 8px; text-align: center; cursor: pointer; color: #a9a39a; border-bottom: 2px solid transparent; text-decoration: none; }
      .tabs .item.active, nav.tabs > a.active { color: #fff; border-bottom-color: #d9a441; }
      .tab { display: none; } .tab.active { display: block; }
      a { color: #e0b341; } a.content-link, a.inline-roll { border: 1px dotted #777; padding: 0 3px; }
      .fa-times::before, .fa-xmark::before, .fa-close::before { content: "✕"; } .fa-check::before { content: "✓"; } .fa-trash::before, .fa-trash-alt::before { content: "🗑"; }
      .fa-plus::before { content: "+"; } .fa-minus::before { content: "−"; } .fa-cog::before, .fa-gear::before, .fa-cogs::before { content: "⚙"; }
      .fa-save::before, .fa-floppy-disk::before { content: "💾"; } .fa-edit::before, .fa-pen::before, .fa-pencil::before, .fa-pen-to-square::before { content: "✎"; }
      .fa-undo::before, .fa-rotate-left::before { content: "↶"; } .fa-search::before, .fa-magnifying-glass::before { content: "🔍"; }
      .fa-file-import::before { content: "📄"; } .fa-info-circle::before, .fa-circle-info::before { content: "ⓘ"; } .fa-tags::before, .fa-tag::before { content: "🏷"; }
      .fa-dice-d20::before { content: "⚄"; } .fa-window-minimize::before { content: "▁"; } .fa-window-maximize::before { content: "▢"; } .fa-chevron-down::before { content: "▾"; }
      .ais-foundry-empty { padding: 16px; color: #a9a39a; }
    `;
    const style = doc.createElement("style");
    style.dataset.aisFoundryUi = "base";
    style.textContent = STYLE;
    doc.head.appendChild(style);
    if (core?.css) {
      const coreStyle = doc.createElement("style");
      coreStyle.dataset.aisFoundryUi = "core";
      coreStyle.textContent = core.css;
      doc.head.appendChild(coreStyle);
    }

    const windowRegistry = new Map();   // key → { app, element, v2 }
    let zCounter = 100;
    let cascade = 0;
    let panelRequested = false;
    const viewport = () => ({ width: doc.documentElement.clientWidth || 760, height: doc.documentElement.clientHeight || 560 });
    /** A hidden panel collapses the frame's viewport to 0×0 — the only signal the shell-side Close button leaves. */
    const panelVisible = () => doc.documentElement.clientWidth > 0 && doc.documentElement.clientHeight > 0;
    const syncPanel = () => {
      const wanted = windowRegistry.size > 0;
      if (wanted === panelRequested && (!wanted || panelVisible())) return;
      panelRequested = wanted;
      const call = wanted ? AIS.ui.panel.open() : AIS.ui.panel.close();
      Promise.resolve(call).catch((error) => {
        panelRequested = false;
        warn(`ui.panel.${wanted ? "open" : "close"} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    /** Shell chrome closed the panel (D-483 `ui.panel.closed`): every window really closes, hooks included. */
    const closeAll = () => {
      panelRequested = false;
      const apps = [...windowRegistry.values()].map((entry) => entry.app);
      return Promise.allSettled(apps.map((app) => Promise.resolve(app.close()).catch((error) => warn(`close failed: ${error instanceof Error ? error.message : String(error)}`))));
    };
    if (typeof AIS.events?.on === "function") {
      try { AIS.events.on("ui.panel.closed", () => { void closeAll(); }); }
      catch (error) { warn(`ui.panel.closed subscription failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const bringToTop = (element, app) => {
      element.style.zIndex = String(++zCounter);
      ui.activeWindow = app;
    };
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    const applyPosition = (element, position, defaults) => {
      const view = viewport();
      const width = position.width === "auto" || position.width === null || position.width === undefined ? defaults.width : Number(position.width);
      const height = position.height === "auto" || position.height === null || position.height === undefined ? null : Number(position.height);
      const w = clamp(Number.isFinite(width) ? width : defaults.width, 200, view.width - 8);
      element.style.width = `${w}px`;
      if (height !== null && Number.isFinite(height)) element.style.height = `${clamp(height, 80, view.height - 8)}px`;
      else { element.style.height = ""; element.style.maxHeight = `${view.height - 8}px`; }
      const rect = element.getBoundingClientRect();
      const h = rect.height || Number(height) || 200;
      let left = position.left, top = position.top;
      if (left === undefined || left === null) { left = Math.max(4, (view.width - w) / 2 + (cascade % 6) * 14 - 28); }
      if (top === undefined || top === null) { top = Math.max(4, (view.height - h) / 2 + (cascade % 6) * 14 - 28); }
      if (position.left === undefined || position.left === null || position.top === undefined || position.top === null) cascade += 1;
      position.left = clamp(Math.round(left), 0, Math.max(0, view.width - w));
      position.top = clamp(Math.round(top), 0, Math.max(0, view.height - 40));
      position.width = w; position.height = height !== null && Number.isFinite(height) ? Number(height) : "auto";
      element.style.left = `${position.left}px`;
      element.style.top = `${position.top}px`;
      if (position.scale && position.scale !== 1) element.style.transform = `scale(${position.scale})`;
      return position;
    };
    const makeDraggable = (header, element, position) => {
      let start = null;
      header.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button, a, input, select, textarea, .header-button, .header-control")) return;
        start = { x: event.clientX, y: event.clientY, left: element.offsetLeft, top: element.offsetTop };
        header.setPointerCapture?.(event.pointerId);
      });
      header.addEventListener("pointermove", (event) => {
        if (!start) return;
        const view = viewport();
        position.left = clamp(start.left + event.clientX - start.x, 0, Math.max(0, view.width - element.offsetWidth));
        position.top = clamp(start.top + event.clientY - start.y, 0, Math.max(0, view.height - 40));
        element.style.left = `${position.left}px`;
        element.style.top = `${position.top}px`;
      });
      const stop = () => { start = null; };
      header.addEventListener("pointerup", stop);
      header.addEventListener("pointercancel", stop);
    };
    const topWindow = () => {
      let best = null;
      for (const record of windowRegistry.values()) if (!best || Number(record.element.style.zIndex) > Number(best.element.style.zIndex)) best = record;
      return best;
    };
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const top = topWindow();
      if (top && top.app.options?.closeOnEscape !== false && top.app.options?.window?.closeOnEscape !== false) { event.preventDefault(); void top.app.close(); }
    });
    // The module document is sandboxed without `allow-forms`: the browser blocks form submission
    // BEFORE firing `submit`, so submit buttons and Enter would be dead. Re-create the event the
    // way Foundry code expects it (bubbling, cancelable, with `submitter`); nothing can navigate.
    const syntheticSubmit = (form, submitter) => {
      if (!form.noValidate && typeof form.reportValidity === "function" && !form.reportValidity()) return;
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter }));
    };
    const submitButton = (form) => form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    doc.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const button = event.target.closest?.('button, input[type="submit"], input[type="image"]');
      if (!button || button.disabled || !button.form) return;
      if (button instanceof HTMLButtonElement && button.type !== "submit") return;
      event.preventDefault();
      syntheticSubmit(button.form, button);
    });
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.defaultPrevented || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.form) return;
      if (["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"].includes(target.type)) return;
      const submitter = submitButton(target.form);
      if (!submitter) return;
      event.preventDefault();
      syntheticSubmit(target.form, submitter);
    });
    const ui = { windows: {}, activeWindow: null, registry: windowRegistry };
    const iconHtml = (icon) => (icon ? `<i class="${escapeHTML(String(icon))}"></i>` : "");

    // ═══════════════════════════ Application (v1) ═══════════════════════════
    let appIdCounter = 0;
    const RENDER_STATES = Object.freeze({ CLOSING: -2, CLOSED: -1, NONE: 0, RENDERING: 1, RENDERED: 2, ERROR: 3 });
    class Tabs {
      constructor({ navSelector, contentSelector, initial, callback } = {}) {
        this._navSelector = navSelector;
        this._contentSelector = contentSelector;
        this._nav = null; this._content = null;
        this.active = initial ?? null;
        this.callback = callback ?? null;
      }
      bind(html) {
        const root = html instanceof Element || html instanceof Document ? html : html?.[0];
        if (!root) return;
        this._nav = root.matches?.(this._navSelector) ? root : root.querySelector(this._navSelector);
        if (!this._nav) return;
        this._content = this._contentSelector ? (root.matches?.(this._contentSelector) ? root : root.querySelector(this._contentSelector)) : root;
        const items = [...this._nav.querySelectorAll("[data-tab]")];
        for (const item of items) item.addEventListener("click", (event) => { event.preventDefault(); this.activate(item.dataset.tab, { triggerCallback: true }); });
        const active = items.some((item) => item.dataset.tab === this.active) ? this.active : items[0]?.dataset.tab;
        if (active) this.activate(active, { triggerCallback: false });
      }
      activate(tabName, { triggerCallback = false } = {}) {
        if (!this._nav) return;
        for (const item of this._nav.querySelectorAll("[data-tab]")) item.classList.toggle("active", item.dataset.tab === tabName);
        const scope = this._content ?? this._nav.parentElement;
        for (const tab of scope?.querySelectorAll(".tab[data-tab]") ?? []) tab.classList.toggle("active", tab.dataset.tab === tabName);
        this.active = tabName;
        if (triggerCallback) this.callback?.(null, this, tabName);
      }
    }
    class Application {
      constructor(options = {}) {
        this.options = mergeObject(this.constructor.defaultOptions, options, { insertKeys: true, insertValues: true, overwrite: true, inplace: false });
        this.appId = ++appIdCounter;
        this._element = null;
        this._state = RENDER_STATES.NONE;
        this._minimized = false;
        this.position = { width: this.options.width, height: this.options.height, left: this.options.left, top: this.options.top, scale: this.options.scale ?? 1, zIndex: 0 };
        this._tabs = (this.options.tabs ?? []).map((config) => new Tabs({ ...config, callback: this._onChangeTab.bind(this) }));
      }
      static RENDER_STATES = RENDER_STATES;
      static get defaultOptions() {
        return { baseApplication: null, width: null, height: null, top: null, left: null, scale: null, popOut: true, minimizable: true, resizable: false,
          id: "", classes: [], dragDrop: [], tabs: [], filters: [], title: "", template: null, scrollY: [], closeOnEscape: true };
      }
      static _getInheritanceChain() {
        const chain = [];
        const walk = (cls) => {
          if (!cls || cls === Object || !cls.name) return;
          chain.push(cls);
          if (cls !== Application) walk(Object.getPrototypeOf(cls));
        };
        walk(this);
        return chain;
      }
      get id() { return this.options.id ? this.options.id : `app-${this.appId}`; }
      get element() { return this._element ?? $(); }
      get template() { return this.options.template; }
      get popOut() { return this.options.popOut !== false; }
      get rendered() { return this._state === RENDER_STATES.RENDERED; }
      get title() { return i18n.localize(String(this.options.title ?? "")); }
      getData() { return {}; }
      render(force = false, options = {}) {
        this._render(force, options).catch((error) => {
          this._state = RENDER_STATES.ERROR;
          const message = `${this.constructor.name} failed to render: ${error instanceof Error ? error.message : String(error)}`;
          console.error(message, error);
          globalThis.ui?.notifications?.error?.(message, { console: false });
        });
        return this;
      }
      async _render(force = false, options = {}) {
        if (this._state === RENDER_STATES.RENDERING) return;
        if (!force && this._state <= RENDER_STATES.NONE) return;
        if (this._state === RENDER_STATES.CLOSING) return;
        this._state = RENDER_STATES.RENDERING;
        const data = await this.getData(this.options);
        const html = await this._renderInner(data, options);
        if (this._state !== RENDER_STATES.RENDERING) return;
        if (this._element) this._replaceHTML(this._element, html, options);
        else {
          const outer = await this._renderOuter(options);
          this._injectHTML(outer, html, options);
          this._element = outer;
          windowRegistry.set(`v1:${this.appId}`, { app: this, element: outer[0], v2: false });
          ui.windows[this.appId] = this;
          doc.body.appendChild(outer[0]);
          this.setPosition(this.position);
          this.bringToTop();
        }
        this._activateCoreListeners(html);
        this.activateListeners(html);
        this._state = RENDER_STATES.RENDERED;
        for (const cls of this.constructor._getInheritanceChain()) Hooks.callAll(`render${cls.name}`, this, html, data);
        syncPanel();
      }
      async _renderInner(data) {
        if (!this.template) throw new Error(`${this.constructor.name} has no template; override _renderInner or set options.template`);
        const html = $(await renderTemplate(this.template, data));
        if (!html.length) throw new Error(`No data was returned from template ${this.template}`);
        return html;
      }
      async _renderOuter() {
        const frame = doc.createElement("div");
        frame.className = ["app", "window-app", ...(this.options.classes ?? [])].join(" ");
        frame.id = this.id;
        frame.dataset.appid = String(this.appId);
        const header = doc.createElement("header");
        header.className = "window-header flexrow draggable";
        const title = doc.createElement("h4");
        title.className = "window-title";
        title.textContent = this.title;
        header.appendChild(title);
        for (const button of this._getHeaderButtons()) {
          const link = doc.createElement("a");
          link.className = `header-button control ${button.class ?? ""}`.trim();
          link.innerHTML = `${iconHtml(button.icon)}${escapeHTML(String(button.label ?? ""))}`;
          if (button.tooltip) link.title = button.tooltip;
          link.addEventListener("click", (event) => { event.preventDefault(); button.onclick?.(event); });
          header.appendChild(link);
        }
        const content = doc.createElement("section");
        content.className = "window-content";
        frame.append(header, content);
        frame.addEventListener("pointerdown", () => this.bringToTop());
        makeDraggable(header, frame, this.position);
        if (this.options.resizable) frame.style.resize = "both";
        return $(frame);
      }
      _getHeaderButtons() {
        const buttons = [{ label: "Close", class: "close", icon: "fas fa-times", onclick: () => this.close() }];
        for (const cls of this.constructor._getInheritanceChain()) Hooks.call(`get${cls.name}HeaderButtons`, this, buttons);
        return buttons;
      }
      _injectHTML(outer, html) { outer.find(".window-content").append(html); }
      _replaceHTML(element, html) { element.find(".window-content").empty().append(html); }
      _activateCoreListeners(html) {
        const content = this.popOut ? html.parent() : html;
        for (const tabs of this._tabs) tabs.bind(content[0] ?? html[0]);
      }
      activateListeners() {}
      _onChangeTab() {}
      activateTab(tabName, { group, triggerCallback = true } = {}) {
        const tabs = group ? this._tabs.find((t) => t._navSelector.includes(group)) : this._tabs[0];
        tabs?.activate(tabName, { triggerCallback });
      }
      async close() {
        if (this._state <= RENDER_STATES.NONE && !this._element) return;
        this._state = RENDER_STATES.CLOSING;
        const element = this.element;
        for (const cls of this.constructor._getInheritanceChain()) Hooks.callAll(`close${cls.name}`, this, element);
        element.remove();
        this._element = null;
        windowRegistry.delete(`v1:${this.appId}`);
        Reflect.deleteProperty(ui.windows, this.appId);
        if (ui.activeWindow === this) ui.activeWindow = topWindow()?.app ?? null;
        this._state = RENDER_STATES.CLOSED;
        syncPanel();
      }
      async minimize() { if (!this.rendered || !this.options.minimizable) return; this._minimized = true; this.element[0]?.classList.add("minimized"); }
      async maximize() { if (!this.rendered) return; this._minimized = false; this.element[0]?.classList.remove("minimized"); }
      bringToTop() { const el = this._element?.[0]; if (el) bringToTop(el, this); }
      setPosition({ left, top, width, height, scale } = {}) {
        const el = this._element?.[0];
        if (!el) return this.position;
        if (left !== undefined) this.position.left = left;
        if (top !== undefined) this.position.top = top;
        if (width !== undefined) this.position.width = width;
        if (height !== undefined) this.position.height = height;
        if (scale !== undefined) this.position.scale = scale;
        return applyPosition(el, this.position, { width: 400 });
      }
      _saveScrollPositions() {} _restoreScrollPositions() {}
      toObject() { return { id: this.id, appId: this.appId, class: this.constructor.name, title: this.title, rendered: this.rendered, position: { ...this.position } }; }
    }

    class FormApplication extends Application {
      constructor(object = {}, options = {}) {
        super(options);
        this.object = object;
        this.form = null;
        this.editors = {};
        this.filepickers = [];
      }
      static get defaultOptions() {
        return mergeObject(super.defaultOptions, { classes: ["form"], closeOnSubmit: true, editable: true, sheetConfig: false, submitOnChange: false, submitOnClose: false });
      }
      get isEditable() { return this.options.editable !== false; }
      getData() { return { object: this.object, options: this.options, title: this.title }; }
      async _render(force, options) {
        await super._render(force, options);
      }
      async _renderInner(data, options) {
        const html = await super._renderInner(data, options);
        this.form = html.filter((_i, el) => el instanceof HTMLFormElement)[0] ?? html.find("form")[0] ?? null;
        return html;
      }
      activateListeners(html) {
        super.activateListeners(html);
        if (!this.form) return;
        this.form.addEventListener("submit", (event) => { void this._onSubmit(event); });
        $(this.form).on("change", "input, select, textarea", (event) => { void this._onChangeInput(event); });
        $(this.form).on("input", "input[type=range]", (event) => { this._onChangeRange(event); });
        if (!this.isEditable) for (const el of this.form.elements) el.disabled = true;
      }
      _onChangeRange(event) {
        const input = event.currentTarget;
        const display = input.nextElementSibling;
        if (display?.classList.contains("range-value")) display.textContent = input.value;
      }
      async _onChangeInput(event) {
        if (event.currentTarget?.type === "range") this._onChangeRange(event);
        if (this.options.submitOnChange) return this._onSubmit(event);
        return undefined;
      }
      _getSubmitData(updateData = null) {
        if (!this.form) throw new Error("The FormApplication subclass has no registered form element");
        const data = new FormDataExtended(this.form, { editors: this.editors }).object;
        return updateData ? mergeObject(data, updateData, { inplace: false }) : data;
      }
      async _onSubmit(event, { updateData = null, preventClose = false, preventRender = false } = {}) {
        event?.preventDefault?.();
        if (this._submitting) return false;
        this._submitting = true;
        try {
          if (!this.isEditable) return false;
          const formData = this._getSubmitData(updateData);
          try { await this._updateObject(event, formData); }
          catch (error) {
            console.error(error);
            globalThis.ui?.notifications?.error?.(`${this.constructor.name}: ${error instanceof Error ? error.message : String(error)}`, { console: false });
            preventClose = true; preventRender = true;
          }
          void preventRender;
          if (this.options.closeOnSubmit && !preventClose) await this.close({ submit: false });
          return formData;
        } finally { this._submitting = false; }
      }
      async _updateObject() { throw new Error(`${this.constructor.name} must implement _updateObject`); }
      async submit(options = {}) { return this._onSubmit(new Event("submit"), options); }
      async close(options = {}) {
        if (this.options.submitOnClose && options.submit !== false && this.form && this.rendered) {
          try { await this._onSubmit(new Event("submit"), { preventClose: true, preventRender: true }); }
          catch (error) { console.error(error); }
        }
        return super.close(options);
      }
    }

    class DocumentSheet extends FormApplication {
      static get defaultOptions() { return mergeObject(super.defaultOptions, { classes: ["sheet"], sheetConfig: true, viewPermission: 2 }); }
      get document() { return this.object; }
      get id() { return this.options.id || `${this.constructor.name}-${this.document?.uuid ?? this.document?.id ?? this.appId}`.replace(/[^A-Za-z0-9_-]/g, "-"); }
      get title() { return this.document?.name ?? super.title; }
      getData() { return { ...super.getData(), document: this.document, data: this.document, editable: this.isEditable, cssClass: this.isEditable ? "editable" : "locked", owner: true, limited: false }; }
      async _updateObject(event, formData) {
        if (typeof this.document?.update !== "function") throw new Error(`${this.constructor.name}: the sheet's document cannot be updated here`);
        return this.document.update(formData);
      }
    }

    class Dialog extends Application {
      constructor(data = {}, options = {}) {
        super(options);
        this.data = data;
        this._submitted = false;
      }
      static get defaultOptions() { return mergeObject(super.defaultOptions, { classes: ["dialog"], width: 400, jQuery: true, template: "templates/hud/dialog.html" }); }
      get title() { return this.data.title ?? "Dialog"; }
      async _renderInner() {
        const content = await Promise.resolve(typeof this.data.content === "function" ? this.data.content() : this.data.content);
        const buttons = {};
        for (const [key, button] of Object.entries(this.data.buttons ?? {}))
          if (button && button.condition !== false && (typeof button.condition !== "function" || button.condition())) buttons[key] = button;
        // D-484: the same core template a module may override through `options.template` or render itself.
        const html = await renderTemplate(this.options.template || "templates/hud/dialog.html", { content: content ?? "", buttons, default: this.data.default });
        return $(`<div class="dialog-body">${html}</div>`).contents();
      }
      activateListeners(html) {
        html.find(".dialog-button").on("click", (event) => { void this._onClickButton(event); });
        $(this.element[0]).on("keydown", (event) => this._onKeyDown(event));
        if (this.data.render instanceof Function) this.data.render(this.options.jQuery ? html : html[0]);
      }
      async _onClickButton(event) {
        const id = event.currentTarget.dataset.button;
        const button = this.data.buttons?.[id];
        if (button) await this.submit(button, event);
      }
      _onKeyDown(event) {
        if (event.key !== "Enter" || !this.data.default) return;
        if (event.target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        const button = this.data.buttons?.[this.data.default];
        if (button) void this.submit(button, event);
      }
      async submit(button, event) {
        const target = this.options.jQuery ? this.element.find(".window-content").children() : this.element[0].querySelector(".window-content");
        try {
          if (typeof button.callback === "function") await button.callback(target, event);
          this._submitted = true;
          await this.close();
        } catch (error) {
          globalThis.ui?.notifications?.error?.(`Dialog button failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      }
      async close(options = {}) {
        if (!this._submitted && typeof this.data.close === "function") {
          try { this.data.close(this.options.jQuery ? this.element.find(".window-content").children() : this.element[0]?.querySelector(".window-content")); }
          catch (error) { console.error(error); }
        }
        return super.close(options);
      }
      static async confirm({ title, content, yes, no, render, defaultYes = true, rejectClose = false, options = {} } = {}, legacy = {}) {
        return this.wait({
          title, content, render,
          buttons: {
            yes: { icon: '<i class="fas fa-check"></i>', label: i18n.localize("Yes"), callback: (html) => (yes ? yes(html) : true) },
            no: { icon: '<i class="fas fa-times"></i>', label: i18n.localize("No"), callback: (html) => (no ? no(html) : false) },
          },
          default: defaultYes ? "yes" : "no",
          close: () => { if (rejectClose) throw new Error("The confirmation Dialog was closed without a choice being made."); return null; },
        }, { ...legacy, ...options });
      }
      static async prompt({ title, content, label, callback, render, rejectClose = true, options = {} } = {}) {
        return this.wait({
          title, content, render, default: "ok",
          buttons: { ok: { icon: '<i class="fas fa-check"></i>', label: label ?? i18n.localize("OK"), callback: (html) => callback?.(html) } },
          close: () => { if (rejectClose) throw new Error("The Dialog prompt was closed without being accepted."); return null; },
        }, options);
      }
      static async wait(data = {}, options = {}, renderOptions = {}) {
        return new Promise((resolve, reject) => {
          const buttons = {};
          for (const [id, button] of Object.entries(data.buttons ?? {})) {
            buttons[id] = { ...button, callback: async (html, event) => {
              try { resolve(typeof button.callback === "function" ? await button.callback(html, event) : id); }
              catch (error) { reject(error); }
            } };
          }
          const close = (html) => {
            try { resolve(typeof data.close === "function" ? data.close(html) : null); } catch (error) { reject(error); }
          };
          new this({ ...data, buttons, close }, options).render(true, renderOptions);
        });
      }
    }

    // ═══════════════════════════ ApplicationV2 ═══════════════════════════
    const deepMergeOptions = (base, extra) => {
      const out = { ...base };
      for (const [key, value] of Object.entries(extra ?? {})) {
        if (key === "classes") out.classes = [...new Set([...(base.classes ?? []), ...(value ?? [])])];
        else if (value && typeof value === "object" && !Array.isArray(value) && typeof value !== "function" && out[key] && typeof out[key] === "object" && !Array.isArray(out[key]))
          out[key] = deepMergeOptions(out[key], value);
        else out[key] = value;
      }
      return out;
    };
    let v2Ids = 0;
    const v2Instances = new Map();
    class ApplicationV2 {
      static DEFAULT_OPTIONS = {
        id: "app-{id}", classes: [], tag: "div",
        window: { frame: true, positioned: true, title: "", icon: "", controls: [], minimizable: true, resizable: false, contentTag: "section", contentClasses: [] },
        actions: {}, form: { handler: undefined, submitOnChange: false, closeOnSubmit: false },
        position: { top: undefined, left: undefined, width: "auto", height: "auto", scale: 1, zIndex: 100 },
      };
      static TABS = {};
      static RENDER_STATES = Object.freeze({ ERROR: -3, CLOSING: -2, CLOSED: -1, NONE: 0, RENDERING: 1, RENDERED: 2 });
      static emittedEvents = ["render", "close", "position"];
      static *inheritanceChain() {
        yield this;
        if (this === ApplicationV2) return;
        const parent = Object.getPrototypeOf(this);
        if (parent && typeof parent.inheritanceChain === "function") yield* parent.inheritanceChain();
      }
      static get BASE_APPLICATION() { return ApplicationV2; }
      #element = null; #content = null; #state = 0; #position; #events = new Map(); #uniqueId; #renderPromise = null; #listenersAttached = false;
      constructor(options = {}) {
        this.#uniqueId = String(++v2Ids);
        this.options = Object.freeze(this._initializeApplicationOptions(options));
        this.#position = { ...this.options.position };
        this.tabGroups = {};
        if (this.constructor.TABS) for (const [group, config] of Object.entries(this.constructor.TABS)) this.tabGroups[group] = config.initial ?? config.tabs?.[0]?.id ?? null;
      }
      _initializeApplicationOptions(options) {
        const chain = [...this.constructor.inheritanceChain()].reverse();
        let merged = {};
        for (const cls of chain) if (Object.hasOwn(cls, "DEFAULT_OPTIONS")) merged = deepMergeOptions(merged, cls.DEFAULT_OPTIONS);
        merged = deepMergeOptions(merged, options);
        merged.uniqueId = this.#uniqueId;
        merged.id = String(merged.id ?? "app-{id}").replace("{id}", this.#uniqueId);
        return merged;
      }
      get id() { return this.options.id; }
      get uniqueId() { return this.#uniqueId; }
      get title() { return i18n.localize(String(this.options.window?.title ?? "")); }
      get element() { return this.#element; }
      get rendered() { return this.#state === ApplicationV2.RENDER_STATES.RENDERED; }
      get state() { return this.#state; }
      get position() { return this.#position; }
      get hasFrame() { return this.options.window?.frame !== false; }
      get minimized() { return this.#element?.classList.contains("minimized") === true; }
      get classList() { return this.#element?.classList; }
      get window() { return { header: this.#element?.querySelector(".window-header") ?? null, title: this.#element?.querySelector(".window-title") ?? null, content: this.#content, close: this.#element?.querySelector('[data-action="close"]') ?? null }; }
      get form() { return this.#element instanceof HTMLFormElement ? this.#element : this.#element?.querySelector("form") ?? null; }
      addEventListener(type, listener, { once = false } = {}) { if (!this.#events.has(type)) this.#events.set(type, []); this.#events.get(type).push({ listener, once }); }
      removeEventListener(type, listener) { this.#events.set(type, (this.#events.get(type) ?? []).filter((entry) => entry.listener !== listener)); }
      dispatchEvent(event) {
        const entries = this.#events.get(event.type) ?? [];
        this.#events.set(event.type, entries.filter((entry) => !entry.once));
        Object.defineProperty(event, "target", { configurable: true, value: this });
        for (const entry of entries) entry.listener.call(this, event);
        return !event.defaultPrevented;
      }
      async render(options = {}, _options = {}) {
        if (typeof options === "boolean") options = Object.assign(_options, { force: options });
        if (this.#renderPromise) await this.#renderPromise.catch(() => {});
        const states = ApplicationV2.RENDER_STATES;
        if (!options.force && this.#state <= states.NONE) return this;
        if (this.#state === states.CLOSING) return this;
        this.#renderPromise = this.#render(options).finally(() => { this.#renderPromise = null; });
        return this.#renderPromise;
      }
      async #render(options) {
        const states = ApplicationV2.RENDER_STATES;
        const first = this.#state <= states.NONE;
        options = { ...options, isFirstRender: first };
        this.#state = states.RENDERING;
        try {
          this._configureRenderOptions(options);
          const context = await this._prepareContext(options);
          if (first) {
            await this._preFirstRender(context, options);
            this.#element = await this._renderFrame(options);
            this.#content = this.hasFrame ? this.#element.querySelector(".window-content") : this.#element;
            doc.body.appendChild(this.#element);
            v2Instances.set(this.id, this);
            windowRegistry.set(`v2:${this.#uniqueId}`, { app: this, element: this.#element, v2: true });
          }
          await this._preRender(context, options);
          const result = await this._renderHTML(context, options);
          this._replaceHTML(result, this.#content, options);
          this._updateFrame(options);
          if (first) {
            if (!this.#listenersAttached) { this._attachFrameListeners(); this.#listenersAttached = true; }
            this.setPosition(this.#position);
            this.bringToFront();
          }
          this.#state = states.RENDERED;
          if (first) await this._onFirstRender(context, options);
          await this._onRender(context, options);
          this.dispatchEvent(new Event("render"));
          for (const cls of this.constructor.inheritanceChain()) Hooks.callAll(`render${cls.name}`, this, this.#element, context, options);
          syncPanel();
          return this;
        } catch (error) {
          this.#state = states.ERROR;
          const message = `${this.constructor.name} failed to render: ${error instanceof Error ? error.message : String(error)}`;
          console.error(message, error);
          globalThis.ui?.notifications?.error?.(message, { console: false });
          throw error;
        }
      }
      _configureRenderOptions() {}
      async _prepareContext() { return {}; }
      _prepareTabs(group) {
        const config = this.constructor.TABS?.[group];
        if (!config) return {};
        const active = this.tabGroups[group] ?? config.initial ?? config.tabs?.[0]?.id;
        const tabs = {};
        for (const tab of config.tabs ?? []) {
          const isActive = tab.id === active;
          const label = tab.label ?? (config.labelPrefix ? `${config.labelPrefix}.${tab.id}` : tab.id);
          tabs[tab.id] = { ...tab, group, active: isActive, cssClass: isActive ? "active" : "", label: i18n.localize(label) };
        }
        return tabs;
      }
      async _preFirstRender() {}
      async _preRender() {}
      async _renderHTML() { throw new Error(`${this.constructor.name} must implement _renderHTML (or use HandlebarsApplicationMixin)`); }
      _replaceHTML() { throw new Error(`${this.constructor.name} must implement _replaceHTML (or use HandlebarsApplicationMixin)`); }
      async _renderFrame() {
        const { window: win = {}, tag = "div", classes = [] } = this.options;
        const element = doc.createElement(tag === "dialog" ? "div" : tag);
        element.id = this.id;
        element.className = ["application", ...classes].join(" ");
        if (tag === "form") { element.autocomplete = "off"; element.noValidate = false; }
        if (win.frame === false) return element;
        const header = doc.createElement("header");
        header.className = "window-header";
        header.innerHTML = `${win.icon ? `<i class="window-icon ${escapeHTML(String(win.icon))}"></i>` : ""}<h1 class="window-title"></h1>`;
        for (const control of win.controls ?? []) {
          const button = doc.createElement("button");
          button.type = "button";
          button.className = `header-control icon ${control.icon ?? ""}`.trim();
          button.dataset.action = control.action;
          button.title = i18n.localize(String(control.label ?? control.action));
          header.appendChild(button);
        }
        if (win.minimizable !== false) {
          const minimize = doc.createElement("button");
          minimize.type = "button"; minimize.className = "header-control icon fa-solid fa-window-minimize"; minimize.dataset.action = "toggleMinimize"; minimize.setAttribute("aria-label", "Minimize");
          header.appendChild(minimize);
        }
        const close = doc.createElement("button");
        close.type = "button"; close.className = "header-control icon fa-solid fa-xmark"; close.dataset.action = "close"; close.setAttribute("aria-label", "Close");
        header.appendChild(close);
        const content = doc.createElement(win.contentTag ?? "section");
        content.className = ["window-content", ...(win.contentClasses ?? [])].join(" ");
        element.append(header, content);
        makeDraggable(header, element, this.#position);
        if (win.resizable) element.style.resize = "both";
        return element;
      }
      _updateFrame() {
        const title = this.#element?.querySelector(".window-title");
        if (title) title.textContent = this.title;
      }
      _attachFrameListeners() {
        const element = this.#element;
        element.addEventListener("pointerdown", () => this.bringToFront());
        element.addEventListener("click", (event) => {
          const target = event.target.closest("[data-action]");
          if (!target || !element.contains(target) || target.closest(".application") !== element) return;
          void this.#onClickAction(event, target);
        });
        element.addEventListener("contextmenu", (event) => {
          const target = event.target.closest("[data-action]");
          if (!target || target.closest(".application") !== element) return;
          const config = this.options.actions?.[target.dataset.action];
          if (config && typeof config === "object" && config.buttons?.includes(2)) { event.preventDefault(); void config.handler.call(this, event, target); }
        });
        const formConfig = this.options.form;
        if (formConfig && (this.#element instanceof HTMLFormElement || formConfig.handler || formConfig.submitOnChange || formConfig.closeOnSubmit)) {
          element.addEventListener("submit", (event) => { void this._onSubmitForm(formConfig, event); });
          element.addEventListener("change", (event) => { void this._onChangeForm(formConfig, event); });
        }
      }
      async #onClickAction(event, target) {
        const action = target.dataset.action;
        const config = this.options.actions?.[action];
        const handler = typeof config === "function" ? config : config?.handler;
        if (typeof handler === "function") {
          const buttons = typeof config === "object" ? config.buttons ?? [0] : [0];
          if (!buttons.includes(event.button ?? 0)) return;
          event.preventDefault();
          await handler.call(this, event, target);
          return;
        }
        switch (action) {
          case "close": event.preventDefault(); await this.close(); return;
          case "tab": event.preventDefault(); this.changeTab(target.dataset.tab, target.dataset.group, { event, navElement: target.closest(".tabs") }); return;
          case "toggleMinimize": event.preventDefault(); await (this.minimized ? this.maximize() : this.minimize()); return;
          case "toggleControls": event.preventDefault(); return;
          default: await this._onClickAction(event, target);
        }
      }
      _onClickAction() {}
      async _onSubmitForm(formConfig, event) {
        event.preventDefault();
        const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : event.target.closest("form") ?? this.form;
        const { handler, closeOnSubmit } = formConfig;
        const formData = new FormDataExtended(form);
        if (typeof handler === "function") await handler.call(this, event, form, formData);
        if (closeOnSubmit) await this.close();
      }
      async _onChangeForm(formConfig, event) {
        if (!formConfig.submitOnChange) return;
        const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : event.target.closest("form") ?? this.form;
        if (!form) return;
        const formData = new FormDataExtended(form);
        if (typeof formConfig.handler === "function") await formConfig.handler.call(this, event, form, formData);
      }
      changeTab(tab, group, { event, navElement, force = false, updatePosition = true } = {}) {
        if (!tab || !group) throw new Error("You must pass both the tab and tab group identifier");
        if (!force && this.tabGroups[group] === tab) return;
        this.tabGroups[group] = tab;
        for (const el of this.#element?.querySelectorAll(`[data-group="${CSS.escape(group)}"][data-tab]`) ?? []) {
          const active = el.dataset.tab === tab;
          el.classList.toggle("active", active);
          if (el.matches("a, button")) el.setAttribute("aria-selected", String(active));
        }
        void event; void navElement;
        if (updatePosition && this.#position.height === "auto") this.setPosition({ height: "auto" });
      }
      async _onFirstRender() {}
      async _onRender() {}
      async _preClose() {}
      _onClose() {}
      async close(options = {}) {
        const states = ApplicationV2.RENDER_STATES;
        if (this.#state <= states.NONE || this.#state === states.CLOSING) return this;
        if (this.#state === states.RENDERING && this.#renderPromise) await this.#renderPromise.catch(() => {});
        this.#state = states.CLOSING;
        await this._preClose(options);
        const element = this.#element;
        element?.remove();
        this._onClose(options);
        this.dispatchEvent(new Event("close"));
        for (const cls of this.constructor.inheritanceChain()) Hooks.callAll(`close${cls.name}`, this, element);
        windowRegistry.delete(`v2:${this.#uniqueId}`);
        v2Instances.delete(this.id);
        if (ui.activeWindow === this) ui.activeWindow = topWindow()?.app ?? null;
        this.#element = null; this.#content = null; this.#listenersAttached = false;
        this.#state = states.CLOSED;
        syncPanel();
        return this;
      }
      setPosition(position = {}) {
        if (!this.#element) return this.#position;
        Object.assign(this.#position, position);
        const result = applyPosition(this.#element, this.#position, { width: 480 });
        this.dispatchEvent(new Event("position"));
        return result;
      }
      bringToFront() { if (this.#element) bringToTop(this.#element, this); }
      async minimize() { if (this.options.window?.minimizable === false || !this.#element) return; this.#element.classList.add("minimized"); }
      async maximize() { this.#element?.classList.remove("minimized"); }
      async toggleControls() {}
      toObject() { return { id: this.id, class: this.constructor.name, title: this.title, rendered: this.rendered, position: { ...this.#position } }; }
    }

    const HandlebarsApplicationMixin = (Base) => class HandlebarsApplication extends Base {
      static PARTS = {};
      #parts = {};
      get parts() { return this.#parts; }
      _configureRenderOptions(options) {
        super._configureRenderOptions(options);
        options.parts ??= Object.keys(this.constructor.PARTS ?? {});
      }
      async _preFirstRender(context, options) {
        await super._preFirstRender(context, options);
        const templates = new Set();
        for (const part of Object.values(this.constructor.PARTS ?? {})) {
          if (part.template) templates.add(part.template);
          for (const extra of part.templates ?? []) templates.add(extra);
        }
        await loadTemplates([...templates]);
      }
      async _preparePartContext(partId, context) { return context; }
      async _renderHTML(context, options) {
        const rendered = {};
        for (const partId of options.parts ?? []) {
          const part = this.constructor.PARTS?.[partId];
          if (!part) { warn(`${this.constructor.name}: part "${partId}" is not configured`); continue; }
          const partContext = await this._preparePartContext(partId, { ...context, partId }, options);
          const html = await renderTemplate(part.template, partContext);
          const template = doc.createElement("template");
          template.innerHTML = html;
          let element = template.content.firstElementChild;
          if (template.content.children.length !== 1) {
            warn(`${this.constructor.name}: part "${partId}" must render a single root element; wrapping ${template.content.children.length} roots`);
            element = doc.createElement("div");
            element.append(...template.content.childNodes);
          }
          element.dataset.applicationPart = partId;
          if (part.id) element.id = part.id;
          for (const cls of part.classes ?? []) element.classList.add(cls);
          rendered[partId] = element;
        }
        return rendered;
      }
      _replaceHTML(result, content, options) {
        for (const [partId, element] of Object.entries(result)) {
          const prior = content.querySelector(`[data-application-part="${CSS.escape(partId)}"]`);
          if (prior) prior.replaceWith(element); else content.appendChild(element);
          this.#parts[partId] = element;
          this._attachPartListeners(partId, element, options);
        }
      }
      _attachPartListeners(partId, element) {
        const part = this.constructor.PARTS?.[partId];
        for (const [selector, formConfig] of Object.entries(part?.forms ?? {})) {
          const forms = element.matches(selector) ? [element] : [...element.querySelectorAll(selector)];
          for (const form of forms) {
            form.addEventListener("submit", (event) => { void this._onSubmitForm(formConfig, event); });
            form.addEventListener("change", (event) => { void this._onChangeForm(formConfig, event); });
          }
        }
      }
    };

    class DocumentSheetV2 extends ApplicationV2 {
      static DEFAULT_OPTIONS = { classes: ["sheet"], tag: "form", form: { submitOnChange: false, closeOnSubmit: false }, window: { title: "" } };
      #document;
      constructor(options = {}) {
        super(options);
        this.#document = options.document ?? null;
      }
      get document() { return this.#document; }
      get title() { return this.#document?.name ?? super.title; }
      get isEditable() { return this.options.editable !== false; }
      _initializeApplicationOptions(options) {
        const merged = super._initializeApplicationOptions(options);
        if (typeof merged.form?.handler !== "function")
          merged.form = { ...merged.form, handler: (event, form, formData) => this._onDocumentSubmit(event, form, formData) };
        return merged;
      }
      async _onDocumentSubmit(event, form, formData) {
        const document = this.document;
        if (typeof document?.update !== "function") throw new Error(`${this.constructor.name}: the sheet's document cannot be updated here`);
        await document.update(this._processFormData(event, form, formData));
      }
      _processFormData(event, form, formData) { return formData.object; }
      async _prepareContext(options) { return { ...(await super._prepareContext(options)), document: this.document, source: this.document?.toObject?.() ?? this.document, editable: this.isEditable, fields: {} }; }
    }

    class DialogV2 extends ApplicationV2 {
      static DEFAULT_OPTIONS = { id: "dialog-{id}", classes: ["dialog"], tag: "dialog", form: { closeOnSubmit: true }, window: { frame: true, positioned: true, minimizable: false } };
      #form = null;
      _initializeApplicationOptions(options) {
        const merged = super._initializeApplicationOptions(options);
        if (!Array.isArray(merged.buttons) || merged.buttons.length === 0) throw new Error("You must define at least one entry in config.buttons");
        const buttons = {};
        for (const button of merged.buttons) buttons[button.action] = { ...button };
        if (!merged.buttons.some((button) => button.default)) buttons[merged.buttons[0].action].default = true;
        merged.buttons = buttons;
        return merged;
      }
      get title() { return i18n.localize(String(this.options.window?.title || "Dialog")); }
      async _renderHTML() {
        const form = doc.createElement("form");
        form.className = "dialog-form standard-form";
        form.autocomplete = "off";
        const content = typeof this.options.content === "function" ? await this.options.content() : this.options.content;
        const buttons = Object.values(this.options.buttons).map((button) =>
          `<button type="${button.default ? "submit" : "button"}" data-action="${escapeHTML(String(button.action))}" class="${escapeHTML(String(button.class ?? ""))}"${button.disabled ? " disabled" : ""}>${iconHtml(button.icon)}<span>${escapeHTML(i18n.localize(String(button.label ?? button.action)))}</span></button>`).join("");
        form.innerHTML = `${content ? `<div class="dialog-content standard-form">${content}</div>` : ""}<footer class="form-footer">${buttons}</footer>`;
        return form;
      }
      /** Form submission (default button click, Enter in a field) resolves the default button. */
      async _onSubmitForm(formConfig, event) {
        event.preventDefault();
        const form = this.#form;
        await this._onSubmit(event.submitter ?? form?.querySelector('button[type="submit"]'), event);
      }
      async _onChangeForm() {}
      _replaceHTML(result, content) { content.replaceChildren(result); this.#form = result; }
      get form() { return this.#form; }
      async _onFirstRender(context, options) {
        await super._onFirstRender(context, options);
        if (typeof this.options.render === "function") await this.options.render(new Event("render"), this);
        this.#form?.querySelector('button[type="submit"]')?.focus();
      }
      async _onClickAction(event, target) {
        // type="submit" buttons arrive through the form's submit event instead.
        if (target.type !== "submit" && target.closest(".form-footer") && this.options.buttons[target.dataset.action]) { event.preventDefault(); await this._onSubmit(target, event); }
      }
      async _onSubmit(target, event) {
        const button = this.options.buttons[target?.dataset.action];
        if (!button || this.#submitted) return undefined;
        this.#submitted = true;
        let result;
        try { result = (await button.callback?.(event, target, this)) ?? button.action; }
        catch (error) { this.#submitted = false; throw error; }
        await this.close();
        return result;
      }
      #submitted = false;
      _onClose(options) {
        super._onClose(options);
        if (typeof this.options.close === "function") this.options.close(new Event("close"), this);
      }
      get submitted() { return this.#submitted; }
      static async wait({ rejectClose = false, close, render, ...options } = {}) {
        return new Promise((resolve, reject) => {
          const buttons = (options.buttons ?? []).map((button) => ({ ...button, callback: async (event, target, dialog) => {
            const result = typeof button.callback === "function" ? await button.callback(event, target, dialog) : undefined;
            resolve(result === undefined ? button.action : result);
            return result;
          } }));
          let dialog;
          try { dialog = new this({ ...options, buttons, render }); } catch (error) { reject(error); return; }
          dialog.addEventListener("close", (event) => {
            if (typeof close === "function") close(event, dialog);
            if (rejectClose) reject(new Error("Dialog was dismissed without pressing a button."));
            else resolve(null);
          }, { once: true });
          dialog.render({ force: true }).catch(reject);
        });
      }
      static async confirm({ yes = {}, no = {}, ...options } = {}) {
        options.buttons ??= [];
        options.buttons.unshift(
          mergeObject({ action: "yes", label: "Yes", icon: "fa-solid fa-check", callback: () => true }, yes),
          mergeObject({ action: "no", label: "No", icon: "fa-solid fa-xmark", default: true, callback: () => false }, no),
        );
        return this.wait(options);
      }
      static async prompt({ ok = {}, ...options } = {}) {
        options.buttons ??= [];
        options.buttons.unshift(mergeObject({ action: "ok", label: "Confirm", icon: "fa-solid fa-check", default: true }, ok));
        return this.wait(options);
      }
      static async input({ ok = {}, ...options } = {}) {
        const callback = ok.callback;
        return this.prompt({ ...options, ok: { ...ok, callback: async (event, button, dialog) => {
          const data = new FormDataExtended(button.form).object;
          if (typeof callback === "function") { const custom = await callback(event, button, dialog); if (custom !== undefined) return custom; }
          return data;
        } } });
      }
      static async query() { throw new Error("DialogV2.query needs cross-user sockets (R-06), which the AIS sandbox does not provide"); }
    }

    // ═══════════════════════════ settings menus ═══════════════════════════
    const openMenu = (key, menus) => {
      const menu = menus.get(key);
      if (!menu) throw new Error(`Settings menu ${key} is not registered`);
      const Type = menu.type;
      if (typeof Type !== "function") throw new Error(`Settings menu ${key} has no application type`);
      const app = new Type();
      return { app, result: app.render(true) };
    };
    const describeWindows = () => [...windowRegistry.values()].map(({ app, v2 }) => ({ ...app.toObject(), api: v2 ? "ApplicationV2" : "Application" }));

    return Object.freeze({
      Application, FormApplication, DocumentSheet, Dialog, Tabs, FormDataExtended,
      ApplicationV2, HandlebarsApplicationMixin, DocumentSheetV2, DialogV2,
      renderTemplate, loadTemplates, getTemplate, templateCount: () => compiledTemplates.size, describeTemplates,
      ui, instances: v2Instances, openMenu, describeWindows, syncPanel, closeAll, fields: fieldsLayer, core,
    });
  };
  globalThis.__aisFoundryUi = Object.freeze({ install });
})();
