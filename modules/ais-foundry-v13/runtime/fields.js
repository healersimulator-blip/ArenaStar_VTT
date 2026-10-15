/*
 * fields.js — `foundry.data.fields`, `foundry.applications.fields` and `foundry.abstract.DataModel`
 * for the AIS sandbox (D-484). Modern modules describe their forms with DataField instances and
 * hand them to `{{formGroup field …}}`; settings menus and `game.settings.register({ type: Model })`
 * use DataModel subclasses. This is ArenaStar's own implementation of that surface: the classes
 * carry the options modules set (`required`, `nullable`, `initial`, `choices`, `min/max/step`,
 * `blank`, `label`, `hint`), clean/validate values the way the names promise and render inputs
 * through one DOM builder, so every field renders the same `.form-group > label + .form-fields`
 * contract the core templates and CSS rely on. Nothing here is Foundry code.
 */
(() => {
  "use strict";
  const install = ({ i18n, escapeHTML, doc }) => {
    const localize = (key) => (key === undefined || key === null ? "" : i18n.localize(String(key)));
    const isPlainObject = (value) => value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    const deepClone = (value) => {
      if (Array.isArray(value)) return value.map(deepClone);
      if (value instanceof Set) return new Set([...value].map(deepClone));
      if (isPlainObject(value)) { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = deepClone(v); return out; }
      return value;
    };
    const el = (tag, attrs = {}, children = []) => {
      const node = doc.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (value === true) node.setAttribute(name, "");
        else node.setAttribute(name, String(value));
      }
      for (const child of children) if (child !== undefined && child !== null) node.append(child instanceof Node ? child : doc.createTextNode(String(child)));
      return node;
    };

    // ═══════════════════════════ foundry.applications.fields ═══════════════════════════
    /** Normalise the many shapes modules use for choices into `[{ value, label, group?, disabled?, selected? }]`. */
    const prepareSelectOptionGroups = ({ options = [], groups = [], blank, localize: doLocalize = false, sort = false, valueAttr = "value", labelAttr = "label", value, selected, disabled: disabledValues } = {}) => {
      const chosen = new Set((selected ?? value) === undefined || (selected ?? value) === null ? [] : (selected ?? value) instanceof Set ? [...(selected ?? value)].map(String) : Array.isArray(selected ?? value) ? (selected ?? value).map(String) : [String(selected ?? value)]);
      const disabled = new Set((disabledValues ?? []).map(String));
      const rows = [];
      const push = (optionValue, label, group) => {
        const text = doLocalize ? localize(label) : String(label ?? optionValue);
        rows.push({ value: optionValue, label: text, group: group ?? "", selected: chosen.has(String(optionValue)), disabled: disabled.has(String(optionValue)) });
      };
      const source = typeof options === "function" ? options() : options;
      if (Array.isArray(source)) {
        for (const option of source) {
          if (option === null || option === undefined) continue;
          if (typeof option !== "object") { push(option, option); continue; }
          push(option[valueAttr] ?? option.value ?? option.id ?? option.key, option[labelAttr] ?? option.label ?? option.name ?? option[valueAttr], option.group);
        }
      } else if (source instanceof Map) {
        for (const [optionValue, label] of source) push(optionValue, typeof label === "object" && label ? (label[labelAttr] ?? label.label ?? label.name) : label, typeof label === "object" && label ? label.group : undefined);
      } else if (source && typeof source === "object") {
        for (const [optionValue, label] of Object.entries(source)) push(optionValue, typeof label === "object" && label ? (label[labelAttr] ?? label.label ?? label.name ?? optionValue) : label, typeof label === "object" && label ? label.group : undefined);
      }
      if (sort) rows.sort((a, b) => a.label.localeCompare(b.label));
      const groupOrder = [...(groups ?? [])];
      for (const row of rows) if (row.group && !groupOrder.includes(row.group)) groupOrder.push(row.group);
      const result = [];
      if (blank !== undefined && blank !== null && blank !== false) result.push({ group: "", options: [{ value: "", label: blank === true ? "" : (doLocalize ? localize(blank) : String(blank)), selected: chosen.has("") }] });
      result.push({ group: "", options: rows.filter((row) => !row.group) });
      for (const group of groupOrder) result.push({ group: doLocalize ? localize(group) : group, options: rows.filter((row) => row.group === group) });
      return result.filter((group) => group.options.length > 0);
    };
    const setInputAttributes = (input, { disabled, readonly, required, autofocus, placeholder, id, dataset, classes, ariaLabel } = {}) => {
      if (disabled) input.disabled = true;
      if (readonly) input.setAttribute("readonly", "");
      if (required) input.required = true;
      if (autofocus) input.autofocus = true;
      if (placeholder !== undefined && "placeholder" in input) input.placeholder = String(placeholder);
      if (id) input.id = String(id);
      if (ariaLabel) input.setAttribute("aria-label", String(ariaLabel));
      if (classes) input.className = Array.isArray(classes) ? classes.join(" ") : String(classes);
      for (const [key, value] of Object.entries(dataset ?? {})) input.dataset[key] = String(value);
      return input;
    };
    const createSelectInput = (config = {}) => {
      const select = el("select", { name: config.name });
      if (config.multiple) select.multiple = true;
      for (const group of prepareSelectOptionGroups(config)) {
        const parent = group.group ? el("optgroup", { label: group.group }) : select;
        for (const option of group.options) parent.append(el("option", { value: option.value, selected: option.selected, disabled: option.disabled }, [option.label]));
        if (parent !== select) select.append(parent);
      }
      return setInputAttributes(select, config);
    };
    const createMultiSelectInput = (config = {}) => createSelectInput({ ...config, multiple: true });
    const createNumberInput = (config = {}) => {
      const input = el("input", { type: "number", name: config.name, min: config.min, max: config.max, step: config.step ?? (config.integer ? 1 : "any"), "data-dtype": "Number" });
      // Attributes, not properties: these nodes are serialised through outerHTML by the Handlebars helpers.
      if (config.value !== undefined && config.value !== null && config.value !== "") input.setAttribute("value", String(config.value));
      return setInputAttributes(input, config);
    };
    const createTextInput = (config = {}) => {
      const input = el("input", { type: config.type ?? "text", name: config.name, "data-dtype": config.dtype ?? undefined, maxlength: config.maxlength });
      input.setAttribute("value", config.value === undefined || config.value === null ? "" : String(config.value));
      return setInputAttributes(input, config);
    };
    const createTextareaInput = (config = {}) => {
      const input = el("textarea", { name: config.name, rows: config.rows ?? 4 });
      input.textContent = config.value === undefined || config.value === null ? "" : String(config.value);
      return setInputAttributes(input, config);
    };
    const createCheckboxInput = (config = {}) => {
      const input = el("input", { type: "checkbox", name: config.name, "data-dtype": "Boolean" });
      if (config.value) input.setAttribute("checked", "");
      return setInputAttributes(input, config);
    };
    const createEditorInput = (config = {}) => createTextareaInput({ ...config, rows: config.rows ?? 8, classes: ["editor-content", ...(Array.isArray(config.classes) ? config.classes : [])] });
    const createColorInput = (config = {}) => {
      const wrapper = el("color-picker", { class: "color-picker" });
      const text = createTextInput({ name: config.name, value: config.value ?? "", placeholder: config.placeholder ?? "#000000", disabled: config.disabled, readonly: config.readonly });
      text.setAttribute("pattern", "^#[0-9a-fA-F]{6}$");
      const picker = el("input", { type: "color", "data-edit": config.name });
      picker.setAttribute("value", /^#[0-9a-fA-F]{6}$/.test(String(config.value ?? "")) ? String(config.value) : "#000000");
      if (config.disabled) picker.disabled = true;
      picker.addEventListener("input", () => { text.value = picker.value; text.dispatchEvent(new Event("change", { bubbles: true })); });
      text.addEventListener("change", () => { if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value; });
      wrapper.append(text, picker);
      return wrapper;
    };
    const createFilePathInput = (config = {}) => {
      const wrapper = el("file-picker", { class: "file-picker-input flexrow" });
      const text = createTextInput({ name: config.name, value: config.value ?? "", placeholder: config.placeholder ?? "path/to/file", disabled: config.disabled });
      const button = el("button", { type: "button", class: "file-picker", disabled: true, title: "File pickers are not available in the AIS sandbox", "data-type": config.type ?? config.categories?.[0]?.toLowerCase?.() ?? "any", "data-target": config.name }, [el("i", { class: "fas fa-file-import fa-fw", inert: true })]);
      wrapper.append(text, button);
      return wrapper;
    };
    const createRangeInput = (config = {}) => {
      const wrapper = el("range-picker", { class: "range-picker flexrow" });
      const range = el("input", { type: "range", name: config.name, min: config.min ?? 0, max: config.max ?? 1, step: config.step ?? "any", "data-dtype": "Number" });
      range.setAttribute("value", String(config.value ?? config.min ?? 0));
      const output = el("span", { class: "range-value" }, [range.value]);
      range.addEventListener("input", () => { output.textContent = range.value; });
      if (config.disabled) range.disabled = true;
      wrapper.append(range, output);
      return wrapper;
    };
    const createFormGroup = ({ label, hint, input, stacked = false, classes = [], rootId, localize: doLocalize = false, units, hidden = false } = {}) => {
      const group = el("div", { class: ["form-group", stacked ? "stacked" : "", ...(Array.isArray(classes) ? classes : String(classes).split(/\s+/))].filter(Boolean).join(" ") });
      if (hidden) group.hidden = true;
      if (label !== undefined && label !== null && label !== "") {
        const labelEl = el("label", { for: rootId });
        labelEl.textContent = doLocalize ? localize(label) : String(label);
        if (units) labelEl.append(" ", el("span", { class: "units" }, [`(${doLocalize ? localize(units) : units})`]));
        group.append(labelEl);
      }
      const fields = el("div", { class: "form-fields" });
      const inputs = Array.isArray(input) ? input : [input];
      for (const item of inputs) {
        if (item === undefined || item === null) continue;
        if (item instanceof Node) { if (rootId && "id" in item && !item.id && item.matches?.("input,select,textarea")) item.id = rootId; fields.append(item); }
        else { const span = doc.createElement("span"); span.innerHTML = String(item); fields.append(...span.childNodes); }
      }
      group.append(fields);
      if (hint) group.append(el("p", { class: "hint" }, [doLocalize ? localize(hint) : String(hint)]));
      return group;
    };
    const applicationsFields = Object.freeze({ createFormGroup, createSelectInput, createMultiSelectInput, createNumberInput, createTextInput, createTextareaInput, createCheckboxInput, createEditorInput, createColorInput, createFilePathInput, createRangeInput, prepareSelectOptionGroups, setInputAttributes });

    // ═══════════════════════════ foundry.data.fields ═══════════════════════════
    class DataModelValidationError extends Error {
      constructor(failure, model) { super(`${model ? `${model} validation errors:\n  ` : ""}${failure instanceof DataModelValidationFailure ? failure.message : String(failure)}`); this.name = "DataModelValidationError"; this.failure = failure instanceof DataModelValidationFailure ? failure : undefined; }
      getFailure() { return this.failure; }
      getAllFailures() { return this.failure ? { [this.failure.fieldPath ?? ""]: this.failure } : {}; }
    }
    class DataModelValidationFailure {
      constructor({ invalidValue, fallback, message, fieldPath, unresolved = true } = {}) { this.invalidValue = invalidValue; this.fallback = fallback; this.message = message ?? ""; this.fieldPath = fieldPath; this.unresolved = unresolved; }
      asError(model) { return new DataModelValidationError(this, model); }
      toString() { return this.message; }
    }
    class DataField {
      constructor(options = {}, { name, parent } = {}) {
        this.options = { ...options };
        this.name = name;
        this.parent = parent;
        const defaults = this.constructor._defaults;
        for (const [key, value] of Object.entries(defaults)) this[key] = Object.hasOwn(options, key) ? options[key] : value;
        for (const key of ["label", "hint", "validate", "choices", "min", "max", "step", "integer", "positive", "blank", "trim", "textSearch", "categories", "idOnly", "initial", "gmOnly", "readonly"])
          if (Object.hasOwn(options, key) && !(key in defaults)) this[key] = options[key];
      }
      static get _defaults() { return { required: false, nullable: false, initial: undefined, readonly: false, gmOnly: false, label: "", hint: "", validationError: "is not a valid value" }; }
      static recursive = false;
      static hierarchical = false;
      get fieldPath() { return [this.parent?.fieldPath, this.name].filter(Boolean).join("."); }
      getInitialValue(data) { return typeof this.initial === "function" ? this.initial(data ?? {}) : deepClone(this.initial); }
      clean(value, options = {}) {
        if (value === undefined || value === null) {
          if (value === null && this.nullable) return null;
          const initial = this.getInitialValue(options.source);
          return initial === undefined && this.nullable ? null : initial;
        }
        return this._cast(value);
      }
      _cast(value) { return value; }
      validate(value, options = {}) {
        const fail = (message) => new DataModelValidationFailure({ invalidValue: value, fieldPath: this.fieldPath, message: `${this.fieldPath || "field"} ${message}` });
        if (value === undefined) return this.required && !options.partial ? fail("is required") : undefined;
        if (value === null) return this.nullable ? undefined : fail("may not be null");
        const failure = this._validateType(value, options);
        if (failure instanceof DataModelValidationFailure) return failure;
        if (failure === false) return fail(this.validationError);
        if (typeof this.options.validate === "function") {
          let custom;
          try { custom = this.options.validate.call(this, value, options); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
          if (custom === false) return fail(this.options.validationError ?? this.validationError);
          if (custom instanceof DataModelValidationFailure) return custom;
        }
        return undefined;
      }
      _validateType() { return undefined; }
      initialize(value) { return value; }
      toObject(value) { return deepClone(value); }
      apply(fn, value, options = {}) { return typeof fn === "string" ? this[fn](value, options) : fn.call(this, value, options); }
      _getChoices() { const choices = this.choices; return typeof choices === "function" ? choices() : choices; }
      /** Render the field's input. Subclasses implement `_toInput`; `config.input` lets a template substitute its own builder. */
      toInput(config = {}) {
        const input = typeof config.input === "function" ? config.input(this, config) : this._toInput({ ...config, name: config.name ?? this.fieldPath, value: config.value === undefined ? this.getInitialValue() : config.value });
        if (input instanceof Node && this.readonly && "readOnly" in input) input.readOnly = true;
        return input;
      }
      _toInput(config) { return createTextInput(config); }
      toFormGroup(groupConfig = {}, inputConfig = {}) {
        const config = { ...groupConfig, label: groupConfig.label ?? this.label ?? this.fieldPath, hint: groupConfig.hint ?? this.hint, localize: groupConfig.localize ?? false };
        const rootId = groupConfig.rootId ?? inputConfig.id;
        return createFormGroup({ ...config, rootId, input: this.toInput({ ...inputConfig, id: rootId }) });
      }
    }
    class BooleanField extends DataField {
      static get _defaults() { return { ...super._defaults, required: true, nullable: false, initial: false }; }
      _cast(value) { return typeof value === "boolean" ? value : typeof value === "string" ? ["true", "1", "on", "yes"].includes(value.toLowerCase()) : Boolean(value); }
      _validateType(value) { return typeof value === "boolean"; }
      _toInput(config) { return createCheckboxInput(config); }
    }
    class NumberField extends DataField {
      static get _defaults() { return { ...super._defaults, initial: null, nullable: true, min: undefined, max: undefined, step: undefined, integer: false, positive: false, choices: undefined }; }
      _cast(value) { return value === "" ? null : Number(value); }
      _validateType(value) {
        if (typeof value !== "number" || Number.isNaN(value)) return false;
        if (this.integer && !Number.isInteger(value)) return new DataModelValidationFailure({ invalidValue: value, message: `${this.fieldPath || "field"} must be an integer` });
        if (this.positive && value <= 0) return new DataModelValidationFailure({ invalidValue: value, message: `${this.fieldPath || "field"} must be positive` });
        if (this.min !== undefined && value < this.min) return new DataModelValidationFailure({ invalidValue: value, message: `${this.fieldPath || "field"} must be at least ${this.min}` });
        if (this.max !== undefined && value > this.max) return new DataModelValidationFailure({ invalidValue: value, message: `${this.fieldPath || "field"} must be at most ${this.max}` });
        const choices = this._getChoices();
        if (choices && !(Array.isArray(choices) ? choices.map(Number).includes(value) : Object.hasOwn(choices, String(value)))) return false;
        return true;
      }
      _toInput(config) {
        const choices = config.choices ?? this._getChoices();
        if (choices) return createSelectInput({ ...config, options: choices, blank: config.blank ?? (this.nullable && config.blank === undefined ? "" : undefined) });
        if (config.type === "range" || (this.min !== undefined && this.max !== undefined && this.step !== undefined && config.type !== "number" && config.range)) return createRangeInput({ ...config, min: this.min, max: this.max, step: this.step });
        return createNumberInput({ ...config, min: config.min ?? this.min, max: config.max ?? this.max, step: config.step ?? this.step, integer: this.integer });
      }
    }
    class StringField extends DataField {
      static get _defaults() { return { ...super._defaults, initial: "", blank: true, trim: true, nullable: false, choices: undefined, textSearch: false }; }
      constructor(options = {}, context) {
        super(options, context);
        if (options.choices !== undefined && !Object.hasOwn(options, "blank")) this.blank = false;
        if (options.choices !== undefined && !Object.hasOwn(options, "initial") && !this.blank && !this.nullable) {
          const choices = this._getChoices();
          const first = Array.isArray(choices) ? choices[0] : choices ? Object.keys(choices)[0] : undefined;
          if (first !== undefined) this.initial = first;
        }
      }
      _cast(value) { const text = String(value); return this.trim ? text.trim() : text; }
      _validateType(value) {
        if (typeof value !== "string") return false;
        if (value === "") return this.blank ? true : new DataModelValidationFailure({ invalidValue: value, message: `${this.fieldPath || "field"} may not be blank` });
        const choices = this._getChoices();
        if (choices && !(Array.isArray(choices) ? choices.map(String).includes(value) : Object.hasOwn(choices, value))) return false;
        return true;
      }
      _toInput(config) {
        const choices = config.choices ?? this._getChoices();
        if (choices) return createSelectInput({ ...config, options: choices, blank: config.blank ?? (this.blank ? "" : undefined), localize: config.localize ?? true });
        return createTextInput(config);
      }
    }
    class HTMLField extends StringField {
      static get _defaults() { return { ...super._defaults, required: true, blank: true }; }
      _toInput(config) { return createEditorInput(config); }
    }
    class JSONField extends StringField {
      static get _defaults() { return { ...super._defaults, blank: false, trim: false, initial: undefined }; }
      _validateType(value) { try { JSON.parse(value); return true; } catch { return false; } }
      initialize(value) { try { return value === undefined ? undefined : JSON.parse(value); } catch { return undefined; } }
      toObject(value) { return value === undefined ? undefined : JSON.stringify(value); }
      _toInput(config) { return createTextareaInput(config); }
    }
    class ColorField extends StringField {
      static get _defaults() { return { ...super._defaults, nullable: true, initial: null, blank: false }; }
      _cast(value) { return value === "" ? null : String(value).trim().toLowerCase(); }
      _validateType(value) { return /^#[0-9a-f]{6}$/i.test(value) ? true : new DataModelValidationFailure({ invalidValue: value, message: `${this.fieldPath || "field"} must be a #rrggbb color` }); }
      _toInput(config) { return createColorInput(config); }
    }
    class FilePathField extends StringField {
      static get _defaults() { return { ...super._defaults, categories: [], base64: false, wildcard: false, nullable: true, blank: false, initial: null }; }
      _toInput(config) { return createFilePathInput({ ...config, categories: this.categories }); }
    }
    class DocumentIdField extends StringField {
      static get _defaults() { return { ...super._defaults, required: true, blank: false, nullable: true, initial: null, readonly: true }; }
      _cast(value) { return value && typeof value === "object" && "_id" in value ? value._id : value === "" ? null : String(value); }
      /** Foundry ids are 16 alphanumerics; ArenaStar document ids are longer (`actor-…`, uuids), both pass. Short junk does not. */
      _validateType(value) { return typeof value === "string" && (/^[A-Za-z0-9]{16}$/.test(value) || (value.length >= 8 && !/\s/.test(value))); }
    }
    class DocumentUUIDField extends StringField {
      static get _defaults() { return { ...super._defaults, required: true, blank: false, nullable: true, initial: null }; }
    }
    class ForeignDocumentField extends DocumentIdField {
      constructor(model, options = {}, context) { super(options, context); this.model = model; }
      static get _defaults() { return { ...super._defaults, nullable: true, readonly: false, idOnly: false }; }
    }
    class AngleField extends NumberField {
      static get _defaults() { return { ...super._defaults, required: true, nullable: false, initial: 0, min: 0, max: 360, normalize: true }; }
      _cast(value) { let n = Number(value); if (this.options.normalize !== false) { n %= 360; if (n < 0) n += 360; } return n; }
    }
    class AlphaField extends NumberField {
      static get _defaults() { return { ...super._defaults, required: true, nullable: false, initial: 1, min: 0, max: 1 }; }
      _toInput(config) { return createRangeInput({ ...config, min: 0, max: 1, step: config.step ?? 0.05 }); }
    }
    class HueField extends NumberField {
      static get _defaults() { return { ...super._defaults, required: true, nullable: false, initial: 0, min: 0, max: 1 }; }
    }
    class IntegerSortField extends NumberField {
      static get _defaults() { return { ...super._defaults, required: true, nullable: false, integer: true, initial: 0 }; }
    }
    class ObjectField extends DataField {
      static get _defaults() { return { ...super._defaults, required: true, nullable: false, initial: () => ({}) }; }
      _cast(value) { return value && typeof value === "object" ? value : {}; }
      _validateType(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
      _toInput(config) { return createTextareaInput({ ...config, value: JSON.stringify(config.value ?? {}, null, 2) }); }
    }
    class AnyField extends DataField { _validateType() { return true; } }
    class ArrayField extends DataField {
      constructor(element, options = {}, context) { super(options, context); this.element = element; if (element instanceof DataField) { element.parent = this; element.name = element.name ?? "element"; } }
      static get _defaults() { return { ...super._defaults, required: true, nullable: false, initial: () => [], min: 0, max: Infinity }; }
      _cast(value) { return Array.isArray(value) ? value : value instanceof Set ? [...value] : value === "" || value === undefined || value === null ? [] : typeof value === "string" ? value.split(",").map((part) => part.trim()).filter(Boolean) : [value]; }
      _validateType(value) {
        if (!Array.isArray(value)) return false;
        if (this.element instanceof DataField) for (const item of value) { const failure = this.element.validate(item); if (failure) return failure; }
        return true;
      }
      clean(value, options) { const cleaned = super.clean(value, options); return Array.isArray(cleaned) && this.element instanceof DataField ? cleaned.map((item) => this.element.clean(item, options)) : cleaned; }
      _toInput(config) {
        const choices = config.choices ?? this.element?._getChoices?.();
        if (choices) return createMultiSelectInput({ ...config, options: choices, localize: config.localize ?? true });
        return createTextInput({ ...config, value: Array.isArray(config.value) ? config.value.join(", ") : config.value });
      }
    }
    class SetField extends ArrayField {
      _cast(value) { return new Set(super._cast(value instanceof Set ? [...value] : value)); }
      _validateType(value) { return value instanceof Set ? super._validateType([...value]) : false; }
      initialize(value) { return value instanceof Set ? value : new Set(Array.isArray(value) ? value : []); }
      toObject(value) { return value instanceof Set ? [...value] : Array.isArray(value) ? [...value] : []; }
      _toInput(config) { return super._toInput({ ...config, value: config.value instanceof Set ? [...config.value] : config.value }); }
    }
    class SchemaField extends DataField {
      constructor(fields = {}, options = {}, context) {
        super(options, context);
        this.fields = {};
        for (const [name, field] of Object.entries(fields)) { if (!(field instanceof DataField)) continue; field.name = name; field.parent = this; this.fields[name] = field; }
      }
      static recursive = true;
      static get _defaults() { return { ...super._defaults, required: true, nullable: false, initial: undefined }; }
      keys() { return Object.keys(this.fields); }
      values() { return Object.values(this.fields); }
      entries() { return Object.entries(this.fields); }
      has(name) { return Object.hasOwn(this.fields, name); }
      get(name) { return this.fields[name]; }
      getField(path) {
        const parts = Array.isArray(path) ? [...path] : String(path).split(".");
        const first = parts.shift();
        const field = this.fields[first];
        if (!field || parts.length === 0) return field;
        return field instanceof SchemaField ? field.getField(parts) : field instanceof ArrayField && field.element instanceof SchemaField ? field.element.getField(parts) : undefined;
      }
      *[Symbol.iterator]() { yield* Object.values(this.fields); }
      getInitialValue(data) {
        const initial = super.getInitialValue(data);
        if (initial && typeof initial === "object") return initial;
        const out = {};
        for (const [name, field] of Object.entries(this.fields)) { const value = field.getInitialValue(data); if (value !== undefined) out[name] = value; }
        return out;
      }
      _cast(value) { return value && typeof value === "object" ? value : {}; }
      clean(value, options = {}) {
        const source = value === undefined || value === null ? this.getInitialValue(options.source) : this._cast(value);
        const out = {};
        for (const [name, field] of Object.entries(this.fields)) {
          const cleaned = field.clean(source[name], { ...options, source });
          if (cleaned !== undefined) out[name] = cleaned;
        }
        return out;
      }
      _validateType(value, options) {
        if (value === null || typeof value !== "object") return false;
        for (const [name, field] of Object.entries(this.fields)) { const failure = field.validate(value[name], options); if (failure) return failure; }
        return true;
      }
      initialize(value, model) { const out = {}; for (const [name, field] of Object.entries(this.fields)) out[name] = field.initialize(value?.[name], model); return out; }
      toObject(value) { if (!value || typeof value !== "object") return value; const out = {}; for (const [name, field] of Object.entries(this.fields)) if (name in value) out[name] = field.toObject(value[name]); return out; }
      _toInput() { throw new Error("A SchemaField has no single input; render its `fields` individually."); }
    }
    class EmbeddedDataField extends SchemaField {
      constructor(model, options = {}, context) { super(typeof model?.defineSchema === "function" ? model.defineSchema() : {}, options, context); this.model = model; }
      initialize(value, model) {
        if (value === undefined || value === null) return value;
        if (typeof this.model !== "function" || !isDataModelClass(this.model)) return super.initialize(value, model);
        try { return new this.model(value, { parent: model ?? null, strict: false }); } catch { return super.initialize(value, model); }
      }
      toObject(value) { return value && typeof value.toObject === "function" ? value.toObject() : super.toObject(value); }
    }
    class DocumentStatsField extends SchemaField {
      constructor(options = {}, context) {
        super({
          coreVersion: new StringField({ required: true, blank: false, nullable: true, initial: null }), systemId: new StringField({ required: true, blank: false, nullable: true, initial: null }),
          systemVersion: new StringField({ required: true, blank: false, nullable: true, initial: null }), createdTime: new NumberField({ nullable: true, initial: null }),
          modifiedTime: new NumberField({ nullable: true, initial: null }), lastModifiedBy: new StringField({ nullable: true, initial: null }),
          compendiumSource: new StringField({ nullable: true, initial: null }), duplicateSource: new StringField({ nullable: true, initial: null }),
        }, options, context);
      }
    }
    class DocumentOwnershipField extends ObjectField {
      static get _defaults() { return { ...super._defaults, initial: () => ({ default: 0 }) }; }
    }
    class DocumentTypeField extends StringField {
      constructor(documentClass, options = {}, context) { super({ choices: () => documentClass?.TYPES ?? ["base"], blank: false, ...options }, context); this.documentClass = documentClass; }
    }
    class TypedSchemaField extends DataField {
      constructor(types = {}, options = {}, context) { super(options, context); this.types = types; }
      _cast(value) { return value && typeof value === "object" ? value : {}; }
      _validateType(value) { return value !== null && typeof value === "object"; }
    }
    class EmbeddedCollectionField extends ArrayField {}
    class EmbeddedDocumentField extends EmbeddedDataField {}
    class TypedObjectField extends ObjectField {
      constructor(element, options = {}, context) { super(options, context); this.element = element; }
    }
    const fields = Object.freeze({
      DataField, BooleanField, NumberField, StringField, HTMLField, JSONField, ColorField, FilePathField, DocumentIdField, DocumentUUIDField,
      ForeignDocumentField, AngleField, AlphaField, HueField, IntegerSortField, ObjectField, AnyField, ArrayField, SetField, SchemaField,
      EmbeddedDataField, DocumentOwnershipField, DocumentTypeField, TypedSchemaField, EmbeddedCollectionField, EmbeddedDocumentField, TypedObjectField, DocumentStatsField,
    });
    const validation = Object.freeze({ DataModelValidationFailure, DataModelValidationError });

    // ═══════════════════════════ foundry.abstract.DataModel ═══════════════════════════
    const schemaCache = new WeakMap();
    class DataModel {
      constructor(data = {}, { parent = null, strict = true, ...options } = {}) {
        this.parent = parent;
        const schema = this.constructor.schema;
        this._source = this._initializeSource(data, options);
        const failure = strict ? schema.validate(this._source, {}) : undefined;
        if (failure) throw failure.asError(this.constructor.name);
        this.#initialize();
      }
      static defineSchema() { return {}; }
      static get schema() {
        let schema = schemaCache.get(this);
        if (!schema) { schema = new SchemaField(this.defineSchema()); schemaCache.set(this, schema); }
        return schema;
      }
      get schema() { return this.constructor.schema; }
      /** Foundry's order: migrate → clean (schema casts + initial values) → shim. */
      _initializeSource(data, options = {}) {
        let source = data instanceof DataModel ? data.toObject() : data && typeof data === "object" ? data : {};
        try { source = this.constructor.migrateData(source) ?? source; } catch (error) { console.warn(`${this.constructor.name}.migrateData failed`, error); }
        source = this.constructor.cleanData(source, options);
        return this.constructor.shimData(source, options) ?? source;
      }
      static cleanData(source = {}, options = {}) { return this.schema.clean(source, { ...options, source }); }
      static migrateData(source) { return source; }
      static shimData(source) { return source; }
      static fromSource(source, options = {}) { return new this(source, { strict: false, ...options }); }
      static fromJSON(json) { return this.fromSource(JSON.parse(json)); }
      static validateJoint() {}
      #initialize() {
        const initialized = this.schema.initialize(this._source, this);
        for (const [name, value] of Object.entries(initialized)) Object.defineProperty(this, name, { configurable: true, enumerable: true, writable: true, value });
      }
      reset() { this.#initialize(); }
      toObject(source = true) { return source ? deepClone(this._source) : this.schema.toObject(this); }
      toJSON() { return this.toObject(true); }
      clone(data = {}, context = {}) { return new this.constructor({ ...this.toObject(), ...data }, { parent: this.parent, ...context }); }
      validate({ changes, clean = false, fallback = false, strict = true } = {}) {
        const source = changes ? this.constructor.cleanData({ ...this.toObject(), ...changes }) : this._source;
        const failure = this.schema.validate(clean ? this.schema.clean(source) : source, {});
        if (failure && strict && !fallback) throw failure.asError();
        return !failure;
      }
      updateSource(changes = {}, { dryRun = false, fallback = false } = {}) {
        const flat = {};
        // Recurse only through SchemaFields; ObjectField/AnyField/Typed* values are replaced whole.
        const flatten = (object, prefix = "") => { for (const [key, value] of Object.entries(object ?? {})) { if (isPlainObject(value) && this.schema.getField(`${prefix}${key}`) instanceof SchemaField) flatten(value, `${prefix}${key}.`); else flat[`${prefix}${key}`] = value; } };
        flatten(changes);
        const next = deepClone(this._source);
        const diff = {};
        for (const [path, value] of Object.entries(flat)) {
          const parts = path.split("."); const last = parts.pop();
          let cursor = next; for (const part of parts) cursor = (cursor[part] ??= {});
          const field = this.schema.getField(path);
          if (!field) continue; // keys outside the schema are ignored, as Foundry does (a form may carry extra inputs)
          const cleaned = field.clean(value);
          const failure = field.validate(cleaned, { partial: true });
          if (failure && !fallback) throw failure.asError(this.constructor.name);
          if (failure) continue;
          if (JSON.stringify(cursor[last]) !== JSON.stringify(cleaned)) { let d = diff; for (const part of parts) d = (d[part] ??= {}); d[last] = cleaned; }
          cursor[last] = cleaned;
        }
        if (dryRun) return diff;
        this._source = next;
        this.#initialize();
        return diff;
      }
    }
    class TypeDataModel extends DataModel {
      static LOCALIZATION_PREFIXES = [];
      prepareBaseData() {}
      prepareDerivedData() {}
    }
    const isDataModelClass = (value) => typeof value === "function" && Object.prototype.isPrototypeOf.call(DataModel.prototype, value.prototype);

    // ═══════════════════════════ Handlebars-facing renderers ═══════════════════════════
    const asField = (field) => (field instanceof DataField ? field : null);
    /** Render `{{formGroup field …}}` / `{{formInput field …}}` for real fields and for duck-typed plain objects alike. */
    const renderInput = (field, hash = {}) => {
      const real = asField(field);
      const config = { ...hash, name: hash.name ?? real?.fieldPath ?? field?.fieldPath ?? field?.name ?? "" };
      if (real) return real.toInput({ ...config, value: hash.value === undefined ? (hash.name ? undefined : real.getInitialValue()) : hash.value });
      const choices = hash.choices ?? field?.choices;
      const value = hash.value ?? field?.initial ?? "";
      const kind = field?.constructor?.name ?? field?.type ?? "";
      if (choices) return createSelectInput({ ...config, options: choices, value, localize: hash.localize, blank: hash.blank });
      if (kind === "BooleanField" || typeof value === "boolean") return createCheckboxInput({ ...config, value });
      if (kind === "NumberField" || typeof value === "number") return createNumberInput({ ...config, value, min: field?.min, max: field?.max, step: field?.step });
      if (kind === "HTMLField") return createEditorInput({ ...config, value });
      return createTextInput({ ...config, value, placeholder: hash.placeholder });
    };
    const renderGroup = (field, hash = {}) => {
      const real = asField(field);
      const label = hash.label ?? real?.label ?? field?.label ?? (hash.name ?? real?.fieldPath ?? field?.name ?? "");
      const hint = hash.hint ?? real?.hint ?? field?.hint;
      return createFormGroup({ label, hint, localize: hash.localize ?? false, stacked: hash.stacked, classes: hash.classes, rootId: hash.rootId ?? hash.id, units: hash.units, hidden: hash.hidden, input: renderInput(field, hash) });
    };
    const html = (node) => (node instanceof Node ? node.outerHTML : String(node ?? ""));

    return Object.freeze({ fields, validation, DataModel, TypeDataModel, isDataModelClass, applications: applicationsFields, renderInput, renderGroup, html, escapeHTML });
  };
  globalThis.__aisFoundryFields = Object.freeze({ install });
})();
