/**
 * D-484: ArenaStar's own Foundry core resource library (`runtime/core.js`) and data layer
 * (`runtime/fields.js`). Foundry modules reference `templates/generic/tab-navigation.hbs`,
 * `templates/hud/dialog.html`, `COMMON.Yes`, `foundry.data.fields.NumberField`… and expect the
 * host to provide them. The emulator provides them from its own implementation — derived from the
 * contract modules depend on (paths, context shapes, DOM markers, key names), never Foundry's files.
 *
 * The scripts are evaluated as the adapter evaluates them inside the module frame (classic
 * scripts publishing `globalThis.__aisFoundryCore` / `globalThis.__aisFoundryFields`). DOM
 * rendering lives in `e2e/ais_foundry_ui_runtime.spec.ts`; here: templates through our engine,
 * aliases, translations and the DataModel/DataField contract that needs no DOM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

interface HbsHelperOptions { hash: Record<string, unknown>; fn(context?: unknown): string; inverse(context?: unknown): string; data?: { root?: unknown } }
interface HbsEngine {
  compile(source: string, options?: { noEscape?: boolean }): (context?: unknown) => string;
  registerHelper(name: string, fn: (...args: unknown[]) => unknown): void;
  registerPartial(name: string, source: string): void;
  SafeString: new (value: string) => { toString(): string };
}
interface CoreLibrary {
  templates: Record<string, string>;
  aliases: Record<string, string>;
  templatePaths: readonly string[];
  resolveTemplate(path: string): string | null;
  lang: Record<string, unknown>;
  css: string;
}
interface DataFieldLike {
  name?: string;
  fieldPath?: string;
  required: boolean;
  nullable: boolean;
  initial: unknown;
  label: string;
  hint: string;
  choices?: unknown;
  fields?: Record<string, DataFieldLike>;
  element?: DataFieldLike;
  getInitialValue(data?: unknown): unknown;
  clean(value: unknown, options?: unknown): unknown;
  validate(value: unknown, options?: unknown): unknown;
}
type FieldCtor = new (...args: unknown[]) => DataFieldLike;
interface DataModelInstance {
  _source: Record<string, unknown>;
  toObject(source?: boolean): Record<string, unknown>;
  toJSON(): Record<string, unknown>;
  updateSource(changes: Record<string, unknown>, options?: unknown): Record<string, unknown>;
  validate(options?: unknown): boolean;
  clone(data?: Record<string, unknown>): DataModelInstance;
  reset(): void;
  [key: string]: unknown;
}
interface DataModelCtor {
  new (data?: unknown, options?: unknown): DataModelInstance;
  defineSchema(): Record<string, DataFieldLike>;
  schema: DataFieldLike & { fields: Record<string, DataFieldLike>; getField(path: string | string[]): DataFieldLike | undefined };
  cleanData(source?: unknown, options?: unknown): Record<string, unknown>;
  fromSource(source: unknown, options?: unknown): DataModelInstance;
  fromJSON(json: string): DataModelInstance;
  migrateData(source: Record<string, unknown>): Record<string, unknown>;
}
interface FieldsLayer {
  fields: Record<string, FieldCtor>;
  validation: Record<string, unknown>;
  DataModel: DataModelCtor;
  TypeDataModel: DataModelCtor;
  isDataModelClass(value: unknown): boolean;
  applications: Record<string, unknown>;
}

const runtime = (name: string) => readFileSync(join(process.cwd(), `modules/ais-foundry-v13/runtime/${name}`), "utf8");
const had = ["__aisFoundryHbs", "__aisFoundryCore", "__aisFoundryFields"].filter((key) => key in globalThis);
for (const file of ["hbs.js", "core.js", "fields.js"]) new Function(runtime(file))();
const g = globalThis as unknown as {
  __aisFoundryHbs: { create(): HbsEngine };
  __aisFoundryCore: CoreLibrary;
  __aisFoundryFields: { install(deps: { i18n: unknown; escapeHTML: (s: unknown) => string; doc: unknown }): FieldsLayer };
};
const core = g.__aisFoundryCore;
afterAll(() => { for (const key of ["__aisFoundryHbs", "__aisFoundryCore", "__aisFoundryFields"]) if (!had.includes(key)) Reflect.deleteProperty(globalThis, key); });

const get = (object: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), object);
const localize = (key: unknown): string => { const value = get(core.lang, String(key)); return typeof value === "string" ? value : String(key); };
const i18nHas = (key: string): boolean => typeof get(core.lang, key) === "string";
const escapeHTML = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The engine the adapter builds, with the Foundry helpers the core templates lean on (ui.js registers the full set). */
function engine(): HbsEngine {
  const H = g.__aisFoundryHbs.create();
  H.registerHelper("localize", (key, ...rest) => {
    const options = rest.pop() as HbsHelperOptions | undefined;
    return localize(key).replace(/\{(\w+)\}/g, (_m, name: string) => String(options?.hash[name] ?? `{${name}}`));
  });
  H.registerHelper("eq", (a, b) => a === b);
  H.registerHelper("timeSince", (value) => `since ${String(value)}`);
  H.registerHelper("formGroup", (field, options) => {
    const hash = (options as HbsHelperOptions).hash;
    const f = field as DataFieldLike;
    return new H.SafeString(`<div class="form-group"><label>${escapeHTML(localize(String(hash.label ?? f.label)))}</label><div class="form-fields"><input name="${escapeHTML(hash.name ?? f.fieldPath)}" value="${escapeHTML(hash.value ?? "")}"></div></div>`);
  });
  H.registerHelper("selectOptions", (choices, options) => {
    const hash = (options as HbsHelperOptions).hash;
    const rows = Array.isArray(choices)
      ? (choices as Record<string, unknown>[]).map((row) => [String(row[String(hash.valueAttr ?? "value")]), String(row[String(hash.labelAttr ?? "label")])])
      : Object.entries(choices as Record<string, string>);
    const html = rows.map(([value, label]) => `<option value="${escapeHTML(value)}"${value === String(hash.selected) ? " selected" : ""}>${escapeHTML(hash.localize ? localize(label) : label)}</option>`);
    if (hash.blank !== undefined) html.unshift(`<option value="">${escapeHTML(hash.blank)}</option>`);
    return new H.SafeString(html.join(""));
  });
  return H;
}

const render = (path: string, context: unknown): string => {
  const canonical = core.resolveTemplate(path);
  if (!canonical) throw new Error(`${path} is not in the core library`);
  const source = core.templates[canonical];
  if (source === undefined) throw new Error(`${canonical} has no template source`);
  return engine().compile(source)(context);
};

describe("core template library (D-484)", () => {
  test("covers the paths the module corpus references most and resolves historical aliases", () => {
    expect(core.templatePaths).toEqual([
      "templates/generic/tab-navigation.hbs", "templates/generic/form-footer.hbs", "templates/generic/form-group.hbs", "templates/generic/form-fields.hbs",
      "templates/hud/dialog.html", "templates/dice/roll.html", "templates/dice/tooltip.html", "templates/dice/table-result.html",
      "templates/sidebar/document-create.html", "templates/sidebar/chat-message.html",
    ]);
    expect(core.resolveTemplate("templates/hud/dialog.hbs")).toBe("templates/hud/dialog.html");
    expect(core.resolveTemplate("/templates/generic/tab-navigation.hbs")).toBe("templates/generic/tab-navigation.hbs");
    expect(core.resolveTemplate("templates\\sidebar\\entity-create.html")).toBe("templates/sidebar/document-create.html");
    expect(core.resolveTemplate("templates/chat/message.hbs")).toBe("templates/sidebar/chat-message.html");
    expect(core.resolveTemplate("templates/nope.hbs")).toBeNull();
    expect(core.resolveTemplate("modules/x/templates/generic/tab-navigation.hbs")).toBeNull();
    for (const target of Object.values(core.aliases)) expect(core.templates[target]).toBeTypeOf("string");
    // The library is our own text: no Foundry copyright banner, no `{{!-- Foundry VTT --}}` provenance.
    for (const source of Object.values(core.templates)) expect(source).not.toMatch(/foundry/i);
  });

  test("tab-navigation renders Foundry's Tabs contract (nav.tabs[data-group] > a.item[data-tab])", () => {
    const html = render("templates/generic/tab-navigation.hbs", {
      tabs: [
        { id: "general", group: "primary", icon: "fa-solid fa-gear", label: "T.General", active: true, cssClass: "active" },
        { id: "rules", group: "primary", label: "T.Rules", active: false, cssClass: "" },
      ],
      tabClasses: "extra",
    });
    expect(html).toContain('<nav class="sheet-tabs tabs extra" data-group="primary"');
    expect(html).toContain('<a class="item active" data-action="tab" data-group="primary" data-tab="general"');
    expect(html).toContain('<i class="fa-solid fa-gear" inert></i>');
    expect(html).toContain('<a class="item" data-action="tab" data-group="primary" data-tab="rules"');
    expect(html).toContain(">T.Rules<");
    // v13 fallback: `active` without `cssClass` still marks the tab.
    expect(render("templates/generic/tab-navigation.hbs", { tabs: [{ id: "a", group: "g", label: "A", active: true }] })).toContain('class="item active"');
  });

  test("form-footer renders the buttons V2 forms declare (type, action, icon, label, disabled)", () => {
    const html = render("templates/generic/form-footer.hbs", {
      buttons: [
        { type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save", cssClass: "primary" },
        { type: "button", action: "reset", label: "Reset", disabled: true },
      ],
    });
    expect(html).toContain('<footer class="form-footer">');
    expect(html).toContain('<button type="submit" class="primary"');
    expect(html).toContain('<i class="fa-solid fa-save" inert></i>');
    expect(html).toContain("<span>Save Changes</span>");
    expect(html).toContain('<button type="button" data-action="reset" disabled>');
  });

  test("dialog.html renders content + ordered buttons with the default highlighted", () => {
    const html = render("templates/hud/dialog.html", {
      content: "<p>Delete <b>it</b>?</p>",
      buttons: { yes: { icon: '<i class="fas fa-check"></i>', label: "Yes" }, no: { icon: '<i class="fas fa-times"></i>', label: "No", cssClass: "secondary" } },
      default: "yes",
    });
    expect(html).toContain('<div class="dialog-content"><p>Delete <b>it</b>?</p></div>');
    expect(html).toContain('<button type="button" class="dialog-button yes default bright" data-button="yes">');
    expect(html).toContain('<button type="button" class="dialog-button no secondary" data-button="no">');
    expect(html.indexOf('data-button="yes"')).toBeLessThan(html.indexOf('data-button="no"'));
  });

  test("dice templates render roll cards and tooltips with the selectors chat modules hook", () => {
    const tooltip = render("templates/dice/tooltip.html", {
      parts: [{ formula: "2d6", total: 9, flavor: "fire", faces: 6, rolls: [{ result: 3 }, { result: 6, classes: "die d6 max" }] }],
    });
    expect(tooltip).toContain('<div class="dice-tooltip">');
    expect(tooltip).toContain('<span class="part-formula">2d6</span>');
    expect(tooltip).toContain('<span class="part-total">9</span>');
    expect(tooltip).toContain('<li class="roll die d6">3</li>');
    expect(tooltip).toContain('<li class="roll die d6 max">6</li>');
    const roll = render("templates/dice/roll.html", { formula: "2d6 + 3", total: 12, tooltip, flavor: "Attack", isPrivate: false });
    expect(roll).toContain('<div class="dice-roll">');
    expect(roll).toContain('<div class="dice-formula">2d6 + 3</div>');
    expect(roll).toContain(tooltip);
    expect(roll).toContain('<h4 class="dice-total">12</h4>');
    const hidden = render("templates/dice/roll.html", { formula: "1d20", total: 7, tooltip: "<b>secret</b>", isPrivate: true });
    expect(hidden).toContain('<div class="dice-formula">???</div>');
    expect(hidden).toContain('<h4 class="dice-total">?</h4>');
    expect(hidden).not.toContain("secret");
    const result = render("templates/dice/table-result.html", { table: { name: "Loot" }, description: "You find", results: [{ text: "<b>gold</b>", icon: "icons/gold.png", range: [1, 3] }] });
    expect(result).toContain('<div class="table-draw">');
    expect(result).toContain('<li class="table-result flexrow">');
    expect(result).toContain('<img class="result-image" src="icons/gold.png"');
    expect(result).toContain("<b>gold</b>");
  });

  test("document-create and chat-message render the sidebar contracts", () => {
    const create = render("templates/sidebar/document-create.html", {
      name: "", defaultName: "New Actor", hasTypes: true, type: "npc", types: { character: "TYPES.Actor.character", npc: "TYPES.Actor.npc" },
      folders: [{ id: "f1", name: "Heroes" }], folder: "f1", content: "<p>extra</p>",
    });
    expect(create).toContain('<form class="document-create standard-form"');
    expect(create).toContain('placeholder="New Actor"');
    expect(create).toContain('<option value="character">Character</option><option value="npc" selected>NPC</option>');
    expect(create).toContain('<select name="folder"><option value=""></option><option value="f1" selected>Heroes</option></select>');
    expect(create).toContain("<p>extra</p>");
    const message = render("templates/sidebar/chat-message.html", {
      message: { _id: "m1", flavor: "Flavor", content: "<p>hello</p>", timestamp: 1000, whisperTo: "", type: "base" },
      alias: "Zed", cssClass: "whisper", borderColor: "#ff0000", isWhisper: true, canDelete: true, user: { color: "#00ff00" },
    });
    expect(message).toContain('<li class="chat-message message flexcol whisper" data-message-id="m1"');
    expect(message).toContain('<h4 class="message-sender">Zed</h4>');
    expect(message).toContain('<span class="flavor-text">Flavor</span>');
    expect(message).toContain('<div class="message-content"><p>hello</p></div>');
  });

  test("form-group / form-fields partials accept both V1 (label+input html) and DataField shapes", () => {
    const html = render("templates/generic/form-group.hbs", { label: "Radius", hint: "In feet", input: '<input name="radius" value="20">', rootId: "r1", classes: "slim", stacked: true });
    expect(html).toMatch(/<div class="form-group (stacked slim|slim stacked)">/);
    expect(html).toContain('<label for="r1">Radius</label>');
    expect(html).toContain('<div class="form-fields"><input name="radius" value="20"></div>');
    expect(html).toContain('<p class="hint">In feet</p>');
    const fields = render("templates/generic/form-fields.hbs", { fields: [{ field: { label: "A", fieldPath: "a" }, value: 1 }, { field: { label: "B", fieldPath: "b" }, value: "x" }] });
    expect(fields).toContain('name="a" value="1"');
    expect(fields).toContain('name="b" value="x"');
  });

  test("ships the core language keys modules reference bare and the base CSS", () => {
    for (const key of ["COMMON.Yes", "COMMON.No", "COMMON.Cancel", "SETTINGS.Save", "SETTINGS.Reset", "DOCUMENT.Actor", "DOCUMENT.Item", "FOLDER.Create", "Yes", "No", "Close", "Save", "Submit", "AreYouSure", "SIDEBAR.Create", "TYPES.Actor.character", "KEYBINDINGS.Title", "PERMISSION.OWNER", "USER.RoleGamemaster"])
      expect(i18nHas(key), key).toBe(true);
    expect(i18nHas("Nope.Missing")).toBe(false);
    expect(localize("Nope.Missing")).toBe("Nope.Missing");
    expect(localize("SETTINGS.Save")).toBe("Save Changes");
    // ui.js owns the window/tab/dialog base rules; core.css adds the classes the library's templates emit.
    for (const selector of [".standard-form", ".form-group", ".form-fields", ".hint", ".flexrow", ".flexcol", ".tabs.vertical", ".dialog-button.bright", ".dice-roll", ".dice-formula", ".dice-tooltip", ".dice-rolls", ".dice-total", ".table-draw", ".table-result", ".form-footer", ".chat-message", ".message-sender", ".message-content", ".document-create", ".color-picker", ".file-picker", ".items-list", ".notification.error"])
      expect(core.css, selector).toContain(selector);
    // Self-contained: no remote fonts, images or imports (the sandbox CSP has no font-src/img-src).
    expect(core.css).not.toMatch(/@import|url\(|@font-face/);
  });
});

describe("foundry.data.fields / DataModel (D-484, no DOM)", () => {
  const i18n = { localize, format: (key: string, data: Record<string, unknown> = {}) => localize(key).replace(/\{(\w+)\}/g, (_m, n: string) => String(data[n] ?? "")), has: i18nHas };
  const layer = g.__aisFoundryFields.install({ i18n, escapeHTML, doc: null });
  const { fields, DataModel, TypeDataModel, isDataModelClass } = layer;
  const ctor = (name: string): FieldCtor => { const found = fields[name]; if (!found) throw new Error(`${name} is missing from foundry.data.fields`); return found; };
  const F = {
    StringField: ctor("StringField"), NumberField: ctor("NumberField"), BooleanField: ctor("BooleanField"), ArrayField: ctor("ArrayField"), SetField: ctor("SetField"),
    ColorField: ctor("ColorField"), SchemaField: ctor("SchemaField"), HTMLField: ctor("HTMLField"), DocumentIdField: ctor("DocumentIdField"), AngleField: ctor("AngleField"),
    AlphaField: ctor("AlphaField"), ObjectField: ctor("ObjectField"), AnyField: ctor("AnyField"), JSONField: ctor("JSONField"), FilePathField: ctor("FilePathField"),
    EmbeddedDataField: ctor("EmbeddedDataField"), DataField: ctor("DataField"),
  };

  class Prefs extends DataModel {
    static override defineSchema(): Record<string, DataFieldLike> {
      return {
        mode: new F.StringField({ required: true, initial: "soft", choices: { soft: "T.Soft", hard: "T.Hard" }, label: "T.Mode" }),
        radius: new F.NumberField({ required: true, integer: true, min: 0, max: 60, initial: 20, step: 5, label: "T.Radius", hint: "T.RadiusHint" }),
        enabled: new F.BooleanField({ initial: true }),
        tags: new F.ArrayField(new F.StringField(), { initial: ["a"] }),
        picks: new F.SetField(new F.StringField({ choices: ["a", "b", "c"] })),
        color: new F.ColorField({ initial: "#ff0000" }),
        nested: new F.SchemaField({ x: new F.NumberField({ initial: 1 }), y: new F.NumberField({ initial: 2, nullable: true }) }),
        notes: new F.HTMLField({ initial: "" }),
        id: new F.DocumentIdField(),
        angle: new F.AngleField({ initial: 0 }),
        alpha: new F.AlphaField({ initial: 1 }),
        raw: new F.ObjectField(),
        any: new F.AnyField(),
        json: new F.JSONField(),
        file: new F.FilePathField({ categories: ["IMAGE"] }),
      };
    }
  }

  test("exposes the field family Foundry modules import from foundry.data.fields", () => {
    for (const name of ["DataField", "SchemaField", "BooleanField", "NumberField", "StringField", "ObjectField", "ArrayField", "SetField", "EmbeddedDataField", "EmbeddedCollectionField", "ColorField", "FilePathField", "AngleField", "AlphaField", "HTMLField", "JSONField", "DocumentIdField", "ForeignDocumentField", "TypedSchemaField", "TypedObjectField", "AnyField", "IntegerSortField", "DocumentOwnershipField", "DocumentStatsField", "DocumentUUIDField", "EmbeddedDocumentField", "DocumentTypeField"])
      expect(fields[name], name).toBeTypeOf("function");
    expect(Object.prototype.isPrototypeOf.call(F.DataField.prototype, F.NumberField.prototype)).toBe(true);
    expect(Object.prototype.isPrototypeOf.call(F.StringField.prototype, F.HTMLField.prototype)).toBe(true);
    expect(layer.validation).toHaveProperty("DataModelValidationFailure");
    expect(layer.validation).toHaveProperty("DataModelValidationError");
  });

  test("SetField cleans elements before deduplicating and preserves strict choices", () => {
    const numbers = new F.SetField(new F.NumberField({ integer: true }));
    expect(numbers.clean(["2", 2, "3"])).toEqual(new Set([2, 3]));
    const choices = new F.SetField(new F.StringField({ choices: ["allowed"] }));
    expect(choices.validate(choices.clean(["forbidden"]))).toBeTruthy();
    expect(choices.validate(choices.clean(["allowed"]))).toBeFalsy();
  });

  test("schema: initial values, casting, cleaning and validation follow the field options", () => {
    const schema = Prefs.schema;
    expect(Object.keys(schema.fields)).toEqual(["mode", "radius", "enabled", "tags", "picks", "color", "nested", "notes", "id", "angle", "alpha", "raw", "any", "json", "file"]);
    expect(schema.getField("nested.x")?.fieldPath).toBe("nested.x");
    expect(schema.getField(["radius"])?.label).toBe("T.Radius");
    const cleaned = Prefs.cleanData({ radius: "12", mode: "hard", nested: { x: "3" }, picks: ["b", "b"], angle: 370 });
    expect(cleaned).toMatchObject({ radius: 12, mode: "hard", enabled: true, tags: ["a"], color: "#ff0000", nested: { x: 3, y: 2 }, angle: 10 });
    expect(Array.from(cleaned.picks as Iterable<string>)).toEqual(["b"]);
    const radius = schema.fields.radius;
    expect(radius).toBeDefined();
    expect(radius?.validate(70)).toBeTruthy();
    expect(radius?.validate(5)).toBeUndefined();
    expect(radius?.validate(2.5)).toBeTruthy();
    expect(schema.fields.mode?.validate("medium")).toBeTruthy();
    expect(schema.fields.color?.validate("red")).toBeTruthy();
    expect(schema.fields.color?.validate("#00ff00")).toBeUndefined();
    expect(schema.fields.id?.validate("abcDEF0123456789")).toBeUndefined();
    expect(schema.fields.id?.validate("short")).toBeTruthy();
    expect(schema.fields.alpha?.validate(1.5)).toBeTruthy();
  });

  test("DataModel instances: construction, strict validation, updateSource, toObject, clone, fromSource", () => {
    const prefs = new Prefs({ radius: 25, nested: { x: 7 }, picks: ["a", "c"] });
    expect(prefs.mode).toBe("soft");
    expect(prefs.radius).toBe(25);
    expect(prefs.nested).toEqual({ x: 7, y: 2 });
    expect(prefs.picks).toBeInstanceOf(Set);
    expect(prefs.toObject()).toMatchObject({ mode: "soft", radius: 25, enabled: true, tags: ["a"], color: "#ff0000", nested: { x: 7, y: 2 } });
    expect(JSON.parse(JSON.stringify(prefs))).toMatchObject({ radius: 25 });
    expect(() => new Prefs({ radius: 999 })).toThrow(/Prefs validation errors[\s\S]*radius must be at most 60/);
    expect(() => new Prefs({ mode: "medium" })).toThrow(/mode/);
    expect(new Prefs({ radius: 999 }, { strict: false }).radius).toBe(999);
    expect(prefs.updateSource({ mode: "hard", nested: { y: null } })).toEqual({ mode: "hard", nested: { y: null } });
    expect(prefs.mode).toBe("hard");
    expect(prefs.nested).toEqual({ x: 7, y: null });
    expect(() => prefs.updateSource({ radius: -1 })).toThrow(/radius/);
    expect(prefs.radius).toBe(25);
    const copy = prefs.clone({ radius: 30 });
    expect(copy).toBeInstanceOf(Prefs);
    expect(copy.radius).toBe(30);
    expect(prefs.radius).toBe(25);
    expect(Prefs.fromSource({ radius: 5 }).radius).toBe(5);
    expect(Prefs.fromJSON('{"radius":10}').radius).toBe(10);
    expect(prefs.validate()).toBe(true);
    expect(isDataModelClass(Prefs)).toBe(true);
    expect(isDataModelClass(TypeDataModel)).toBe(true);
    expect(isDataModelClass(Object)).toBe(false);
    expect(isDataModelClass(prefs)).toBe(false);
  });

  test("migrateData runs before cleaning and embedded models nest", () => {
    class Inner extends DataModel {
      static override defineSchema(): Record<string, DataFieldLike> { return { n: new F.NumberField({ initial: 1 }) }; }
      static override migrateData(source: Record<string, unknown>): Record<string, unknown> {
        if ("oldN" in source) { source.n = source.oldN; Reflect.deleteProperty(source, "oldN"); }
        return source;
      }
    }
    class Outer extends DataModel {
      static override defineSchema(): Record<string, DataFieldLike> {
        return { inner: new F.EmbeddedDataField(Inner), list: new F.ArrayField(new F.EmbeddedDataField(Inner)) };
      }
      static override migrateData(source: Record<string, unknown>): Record<string, unknown> {
        if ("legacy" in source) { source.inner = { n: source.legacy }; Reflect.deleteProperty(source, "legacy"); }
        return source;
      }
    }
    const outer = new Outer({ legacy: 9, list: [{ oldN: 2 }, {}] });
    expect(outer.inner).toBeInstanceOf(Inner);
    expect((outer.inner as DataModelInstance).parent).toBe(outer);
    expect((outer.list as DataModelInstance[])[0]?.parent).toBe(outer);
    expect((outer.inner as DataModelInstance).n).toBe(9);
    expect((outer.list as DataModelInstance[]).map((row) => row.n)).toEqual([2, 1]);
    expect(outer.toObject()).toEqual({ inner: { n: 9 }, list: [{ n: 2 }, { n: 1 }] });
  });
});
