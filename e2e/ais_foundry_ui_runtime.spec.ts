/**
 * D-483 — the adapter's UI runtime layer (hbs.js + jq.js + ui.js) exercised directly in a blank
 * Chromium page with a stub `AIS`/`Hooks`/`i18n`: Handlebars-compatible templates with Foundry's
 * core helpers, the jQuery-compatible subset, Application v1 (FormApplication + Dialog) and
 * ApplicationV2 (HandlebarsApplicationMixin + DialogV2) window behaviour, FormDataExtended casting.
 * The shell-level proof (an unmodified Foundry module opening windows through the GM panel) is
 * `ais_foundry_module.spec.ts`; this spec is the fast regression net for the layer itself.
 */
import { expect, test, type Page } from "@playwright/test";

/** The jQuery subset `runtime/jq.js` implements, as the spec's page code uses it (types only). */
interface Jq extends ArrayLike<Element> {
  on(type: string, selector: string, handler: (this: Element, event: { currentTarget: Element; preventDefault(): void }) => void): Jq;
  find(selector: string): Jq;
  first(): Jq;
  closest(selector: string): Jq;
  is(selector: string): boolean;
  trigger(type: string): Jq;
  val(): unknown;
  val(value: unknown): Jq;
  change(handler: () => void): Jq;
  text(): string;
  map(fn: (this: Element) => unknown): { get(): unknown[] };
  hasClass(name: string): boolean;
  attr(name: string): string | undefined;
  prop(name: string): unknown;
  serializeArray(): unknown;
  data(name: string): unknown;
  toggleClass(names: string): Jq;
  css(name: string): string;
  css(name: string, value: string): Jq;
  each(fn: (this: Element, index: number) => void): Jq;
  remove(): Jq;
}
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runtime = (name: string) => readFileSync(fileURLToPath(new URL(`../modules/ais-foundry-v13/runtime/${name}`, import.meta.url)), "utf8");

async function bootLayer(page: Page): Promise<void> {
  await page.setContent("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
  for (const file of ["hbs.js", "jq.js", "core.js", "fields.js", "ui.js"]) await page.addScriptTag({ content: runtime(file) });
  await page.evaluate(() => {
    const w = globalThis as unknown as Record<string, unknown>;
    const panel: string[] = [];
    const hooks: Record<string, unknown[][]> = {};
    const translations: Record<string, string> = { "T.Title": "Config window", "T.Save": "Save", "T.Soft": "Soft", "T.Hard": "Hard", "T.Hello": "Hello, {name}", "T.Radius": "Radius", "T.RadiusHint": "In feet", "T.Mode": "Mode", "T.General": "General", "T.Advanced": "Advanced", Yes: "Yes", No: "No" };
    // D-484: like the adapter, the module's own keys win over the emulator's core keys (nested, `COMMON.Yes`).
    const coreLang = (w.__aisFoundryCore as { lang: Record<string, unknown> }).lang;
    const lookup = (key: string): string => {
      if (translations[key] !== undefined) return translations[key];
      const value = key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), coreLang);
      return typeof value === "string" ? value : key;
    };
    const i18n = {
      localize: lookup,
      format: (key: string, data: Record<string, unknown>) => lookup(key).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(data[k])),
      has: (key: string) => lookup(key) !== key,
    };
    const Hooks = {
      callAll: (name: string, ...args: unknown[]) => { (hooks[name] ??= []).push(args); return true; },
      call: (name: string, ...args: unknown[]) => { (hooks[name] ??= []).push(args); return true; },
    };
    const resources = new Map<string, string>([
      ["templates/config.hbs", [
        "<form class=\"fsd-config\" autocomplete=\"off\">",
        "  <h2>{{localize \"T.Title\"}} — {{localize \"T.Hello\" name=user}}</h2>",
        "  {{> \"modules/fsd/templates/parts/row.hbs\" label=\"Radius\"}}",
        "  <div class=\"form-group\"><label>Mode</label><select name=\"mode\">{{selectOptions modes selected=mode localize=true}}</select></div>",
        "  <div class=\"form-group\"><label>Enabled</label><input type=\"checkbox\" name=\"enabled\" {{checked enabled}}></div>",
        "  <ul>{{#each items as |item i|}}<li data-i=\"{{i}}\" class=\"{{#if item.hot}}hot{{/if}}\">{{item.name}}</li>{{else}}<li>none</li>{{/each}}</ul>",
        "  <button type=\"button\" data-action=\"bump\">Bump</button><button type=\"submit\">{{localize \"T.Save\"}}</button>",
        "</form>",
      ].join("\n")],
      ["templates/parts/row.hbs", "<div class=\"form-group\"><label>{{label}}</label><input type=\"number\" name=\"radius\" value=\"{{radius}}\" data-dtype=\"Number\"></div>"],
      ["templates/v2-main.hbs", "<section class=\"v2-main\"><nav class=\"tabs\" data-group=\"primary\">{{#each tabs}}<a data-action=\"tab\" data-group=\"primary\" data-tab=\"{{id}}\" class=\"item {{cssClass}}\">{{label}}</a>{{/each}}</nav>"
        + "<section class=\"tab {{tabs.one.cssClass}}\" data-group=\"primary\" data-tab=\"one\">one:{{count}}</section><section class=\"tab {{tabs.two.cssClass}}\" data-group=\"primary\" data-tab=\"two\">two</section>"
        + "<button type=\"button\" data-action=\"inc\">+</button></section>"],
      ["templates/v2-form.hbs", "<form class=\"v2-form\"><input name=\"label\" value=\"{{label}}\"><input type=\"checkbox\" name=\"flag\" {{checked flag}}><button type=\"submit\">Go</button></form>"],
      // D-484: a module body part that leans entirely on the emulator — DataField helpers + core partial + core i18n keys.
      ["templates/prefs.hbs", "<div class=\"prefs-body\"><section class=\"tab prefs-general {{tabs.general.cssClass}}\" data-group=\"primary\" data-tab=\"general\">"
        + "{{formGroup fields.radius value=source.radius localize=true}}{{formGroup fields.mode value=source.mode localize=true}}{{formField fields.enabled value=source.enabled localize=true label=\"COMMON.Yes\"}}"
        + "{{> \"templates/generic/form-group.hbs\" label=\"DOCUMENT.Actor\" input=actorInput localize=true}}"
        + "</section><section class=\"tab prefs-advanced {{tabs.advanced.cssClass}}\" data-group=\"primary\" data-tab=\"advanced\"><p class=\"hint\">{{localize \"AreYouSure\"}}</p></section></div>"],
    ]);
    const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
    const mergeObject = (original: Record<string, unknown>, other: Record<string, unknown> = {}, options: { inplace?: boolean } = {}): Record<string, unknown> => {
      const target = options.inplace === false ? structuredCloneSafe(original) : original;
      for (const [key, value] of Object.entries(other)) {
        if (isPlain(value) && isPlain(target[key])) mergeObject(target[key] as Record<string, unknown>, value, { inplace: true });
        else target[key] = value;
      }
      return target;
    };
    function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = isPlain(item) ? structuredCloneSafe(item) : Array.isArray(item) ? [...item] : item;
      return out;
    }
    const expandObject = (object: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(object)) {
        const parts = key.split(".");
        let cursor = out;
        for (const part of parts.slice(0, -1)) cursor = (cursor[part] ??= {}) as Record<string, unknown>;
        cursor[parts[parts.length - 1] ?? key] = value;
      }
      return out;
    };
    const escapeHTML = (text: string) => String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
    const hbs = (w.__aisFoundryHbs as { create: () => unknown }).create();
    const $ = (w.__aisFoundryJq as { create: (d: Document) => unknown }).create(document);
    const install = (w.__aisFoundryUi as { install: (deps: unknown) => Record<string, unknown> }).install;
    const layer = install({
      AIS: { ui: { panel: { open: async () => { panel.push("open"); return { open: true }; }, close: async () => { panel.push("close"); return { open: false }; } } } },
      Hooks, i18n, warn: (text: string) => console.warn(text), resources, foundryId: "fsd", Handlebars: hbs, $,
      utils: { mergeObject, expandObject, escapeHTML },
    });
    Object.assign(w, { layer, hooks, panel, Hooks, $, Handlebars: hbs, ui: { notifications: { error: (m: string) => { (w.__errors as string[]).push(m); } } }, __errors: [] });
  });
}

test("hbs: Foundry core helpers, partials by module path, jQuery subset", async ({ page }) => {
  await bootLayer(page);
  const out = await page.evaluate(async () => {
    const w = globalThis as unknown as { layer: { renderTemplate: (p: string, d: unknown) => Promise<string> }; $: (s: unknown) => Jq; Handlebars: { compile: (s: string) => (d: unknown) => string } };
    const html = await w.layer.renderTemplate("modules/fsd/templates/config.hbs", {
      user: "GM", radius: 20, mode: "hard", modes: { soft: "T.Soft", hard: "T.Hard" }, enabled: true,
      items: [{ name: "a", hot: true }, { name: "b<", hot: false }],
    });
    const H = w.Handlebars;
    const helpers = {
      concat: H.compile("{{concat 'a' 1 'b' join='-'}}")({}),
      eq: H.compile("{{#if (eq a 1)}}y{{else}}n{{/if}}{{#if (and a b)}}y{{else}}n{{/if}}{{#if (or z b)}}y{{/if}}{{ifThen z 'p' 'q'}}")({ a: 1, b: true, z: 0 }),
      numberFormat: H.compile("{{numberFormat v decimals=1 sign=true}}")({ v: 3.14159 }),
      select: H.compile("<select>{{#select m}}<option value='x'>X</option><option value='y'>Y</option>{{/select}}</select>")({ m: "y" }),
      radio: H.compile("{{radioBoxes 'r' c checked='b'}}")({ c: { a: "A", b: "B" } }),
      range: H.compile("{{rangePicker name='n' value=5 min=0 max=10 step=1}}")({}),
      editor: H.compile("{{editor content target='notes'}}")({ content: "<b>x</b>" }),
      json: H.compile("{{json v}}")({ v: { a: [1] } }),
      filePicker: H.compile("{{filePicker type='image' target='img'}}")({}),
      selectArray: H.compile("<select>{{selectOptions rows selected=sel valueAttr='id' labelAttr='name' blank='—'}}</select>")({ rows: [{ id: 1, name: "One" }, { id: 2, name: "Two" }], sel: 2 }),
      formGroup: H.compile("{{formGroup field value=v label='L' hint='H'}}")({ field: { name: "f", choices: { a: "A", b: "B" } }, v: "b" }),
    };
    // jQuery subset over the rendered form.
    const $form = w.$(html);
    const $ = w.$;
    const clicks: string[] = [];
    document.body.append(...Array.from($form as ArrayLike<Element>));
    $form.on("click", "[data-action]", function (this: Element, event: { currentTarget: Element; preventDefault(): void }) { clicks.push(`${(this as HTMLElement).dataset.action}:${(event.currentTarget as HTMLElement).dataset.action}`); });
    $form.find("[data-action=bump]").trigger("click");
    const radius = $form.find("input[name=radius]");
    radius.val(42);
    const mode = $form.find("select[name=mode]");
    const changed: string[] = [];
    mode.change(() => { changed.push(String(mode.val())); });
    mode.val("soft").trigger("change");
    const jq = {
      length: $form.length, isForm: $form.is("form"), radius: radius.val(), modeText: $form.find("select option:checked").text(), changed, clicks,
      li: $form.find("li").map(function (this: Element) { return `${(this as HTMLElement).dataset.i}:${this.className}:${this.textContent}`; }).get(),
      closest: $form.find("li").first().closest("form").hasClass("fsd-config"),
      hasHot: $form.find("li.hot").length, attr: $form.attr("autocomplete"), checked: $form.find("input[name=enabled]").prop("checked"),
      serialize: $form.serializeArray(), hidden: $("<div hidden>").length, parsed: $("<p>a</p><p>b</p>").length, text: $form.find("h2").text(),
      data: $("<i data-foo-bar='7' data-obj='{\"a\":1}'>").data("fooBar"), dataObj: $("<i data-obj='{\"a\":1}'>").data("obj"),
      toggle: $form.find("ul").toggleClass("x y").hasClass("y"), css: ($form.find("ul").css("display", "flex").css("display")),
      each: (() => { const out: number[] = []; $form.find("li").each(function (this: Element, i: number) { out.push(i); }); return out; })(),
    };
    $form.remove();
    return { html, helpers, jq };
  });
  expect(out.html).toContain("<h2>Config window — Hello, GM</h2>");
  expect(out.html).toContain('<label>Radius</label><input type="number" name="radius" value="20" data-dtype="Number">');
  expect(out.html).toContain('<option value="soft">Soft</option><option value="hard" selected>Hard</option>');
  expect(out.html).toContain('name="enabled" checked>');
  expect(out.html).toContain('<li data-i="0" class="hot">a</li><li data-i="1" class="">b&lt;</li>');
  expect(out.html).toContain(">Save</button>");
  expect(out.helpers).toMatchObject({
    concat: "a-1-b", eq: "yyyq", numberFormat: "+3.1",
    select: "<select><option value='x'>X</option><option value='y' selected>Y</option></select>",
    json: '{"a":[1]}',
  });
  expect(out.helpers.radio).toBe('<label class="checkbox"><input type="radio" name="r" value="a"> A</label><label class="checkbox"><input type="radio" name="r" value="b" checked> B</label>');
  expect(out.helpers.range).toContain('<input type="range" name="n" value="5" min="0" max="10" step="1"><span class="range-value">5</span>');
  expect(out.helpers.editor).toContain('<textarea class="editor-content" name="notes"');
  expect(out.helpers.filePicker).toContain("disabled");
  expect(out.helpers.selectArray).toBe('<select><option value="">—</option><option value="1">One</option><option value="2" selected>Two</option></select>');
  expect(out.helpers.formGroup).toMatch(/<select name="f"><option value="a">A<\/option><option value="b" selected(="")?>B<\/option><\/select>/);
  expect(out.helpers.formGroup).toContain('<p class="hint">H</p>');
  expect(out.jq).toMatchObject({
    length: 1, isForm: true, radius: "42", modeText: "Soft", changed: ["soft"], clicks: ["bump:bump"],
    li: ["0:hot:a", "1::b<"], closest: true, hasHot: 1, attr: "off", checked: true,
    serialize: [{ name: "radius", value: "42" }, { name: "mode", value: "soft" }, { name: "enabled", value: "on" }],
    hidden: 1, parsed: 2, text: "Config window — Hello, GM", data: 7, dataObj: { a: 1 }, toggle: true, css: "flex", each: [0, 1],
  });
});

test("Application v1: FormApplication renders into a window, listeners + submit + hooks + panel lifecycle; Dialog.confirm resolves on click", async ({ page }) => {
  await bootLayer(page);
  await page.evaluate(() => {
    const w = globalThis as unknown as { layer: Record<string, unknown>; updates: unknown[]; app: unknown; bumps: number };
    const { FormApplication, Dialog } = w.layer as { FormApplication: new (o: unknown, opts?: unknown) => unknown; Dialog: { confirm: (o: unknown) => Promise<unknown> } };
    w.updates = [];
    w.bumps = 0;
    type Html = { find: (s: string) => { click: (fn: () => void) => void } };
    class ConfigApp extends (FormApplication as unknown as new (...args: unknown[]) => { options: Record<string, unknown>; object: Record<string, unknown>; render(f?: boolean): unknown; activateListeners(html: Html): void }) {
      static get defaultOptions() { return { ...(FormApplication as unknown as { defaultOptions: Record<string, unknown> }).defaultOptions, id: "fsd-config", title: "T.Title", template: "modules/fsd/templates/config.hbs", width: 420, closeOnSubmit: false, submitOnChange: false }; }
      getData() { return { user: "GM", radius: this.object.radius, mode: this.object.mode, modes: { soft: "T.Soft", hard: "T.Hard" }, enabled: this.object.enabled, items: [{ name: "a", hot: true }] }; }
      override activateListeners(html: Html) {
        super.activateListeners(html);
        html.find("[data-action=bump]").click(() => { (globalThis as unknown as { bumps: number }).bumps += 1; });
      }
      async _updateObject(_event: unknown, formData: unknown) { (globalThis as unknown as { updates: unknown[] }).updates.push(formData); Object.assign(this.object, formData as object); }
    }
    (globalThis as unknown as { ConfigApp: unknown; Dialog: unknown }).ConfigApp = ConfigApp;
    (globalThis as unknown as { Dialog: unknown }).Dialog = Dialog;
    w.app = new ConfigApp({ radius: 20, mode: "hard", enabled: true });
    (w.app as { render: (f: boolean) => void }).render(true);
  });
  const win = page.locator("#fsd-config");
  await expect(win).toBeVisible();
  await expect(win.locator(".window-title")).toHaveText("Config window");
  await expect(win.locator("h2")).toHaveText("Config window — Hello, GM");
  expect(await page.evaluate(() => (globalThis as unknown as { panel: string[] }).panel)).toEqual(["open"]);
  await win.locator("[data-action=bump]").click();
  await win.locator("[data-action=bump]").click();
  expect(await page.evaluate(() => (globalThis as unknown as { bumps: number }).bumps)).toBe(2);
  await win.locator("input[name=radius]").fill("35");
  await win.locator("select[name=mode]").selectOption("soft");
  await win.locator("input[name=enabled]").uncheck();
  await win.locator("button[type=submit]").click();
  expect(await page.evaluate(() => (globalThis as unknown as { updates: unknown[] }).updates)).toEqual([{ radius: 35, mode: "soft", enabled: false }]);
  const hooks = await page.evaluate(() => Object.keys((globalThis as unknown as { hooks: Record<string, unknown> }).hooks));
  expect(hooks).toEqual(expect.arrayContaining(["renderConfigApp", "renderFormApplication", "renderApplication", "getConfigAppHeaderButtons"]));
  // Re-render keeps the same window and reflects the updated object.
  await page.evaluate(() => (globalThis as unknown as { app: { render: () => void } }).app.render());
  await expect(win.locator("input[name=radius]")).toHaveValue("35");
  await expect(page.locator(".window-app")).toHaveCount(1);
  // Dialog.confirm: a second window on top; clicking Yes resolves true and closes it.
  const confirmed = page.evaluate(() => (globalThis as unknown as { Dialog: { confirm: (o: unknown) => Promise<unknown> } }).Dialog.confirm({ title: "Sure?", content: "<p>Delete it?</p>" }));
  const dialog = page.locator(".window-app.dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".window-title")).toHaveText("Sure?");
  await expect(dialog.locator(".dialog-content")).toHaveText("Delete it?");
  await dialog.locator("button.dialog-button.yes").click();
  expect(await confirmed).toBe(true);
  await expect(page.locator(".window-app.dialog")).toHaveCount(0);
  // Closing by the header control fires close hooks and, as the last window, closes the panel.
  await win.locator(".header-button.close").click();
  await expect(page.locator("#fsd-config")).toHaveCount(0);
  const after = await page.evaluate(() => { const g = globalThis as unknown as { panel: string[]; hooks: Record<string, unknown[]>; layer: { ui: { windows: Record<string, unknown> } } }; return { panel: g.panel, closed: Object.keys(g.hooks).filter((k) => k.startsWith("close")), windows: Object.keys(g.layer.ui.windows) }; });
  expect(after).toEqual({ panel: ["open", "close"], closed: ["closeDialog", "closeApplication", "closeConfigApp", "closeFormApplication"], windows: [] });
  expect(await page.evaluate(() => (globalThis as unknown as { __errors: string[] }).__errors)).toEqual([]);
});

test("ApplicationV2 + HandlebarsApplicationMixin: PARTS, data-action handlers, tabs, form handler; DialogV2.prompt/input/confirm", async ({ page }) => {
  await bootLayer(page);
  await page.evaluate(async () => {
    const layer = (globalThis as unknown as { layer: { ApplicationV2: unknown; HandlebarsApplicationMixin: (b: unknown) => unknown; DialogV2: unknown } }).layer;
    const Base = layer.HandlebarsApplicationMixin(layer.ApplicationV2) as new (o?: unknown) => { render(o: unknown): Promise<unknown>; tabGroups: Record<string, string>; changeTab(t: string, g: string): void; _prepareTabs(g: string): unknown };
    class V2App extends Base {
      static DEFAULT_OPTIONS = { id: "v2-{id}", classes: ["v2"], window: { title: "T.Title" }, position: { width: 300 },
        actions: { inc: function (this: V2App) { this.count += 1; void this.render({ parts: ["main"] }); } },
      };
      static PARTS = { main: { template: "templates/v2-main.hbs" }, form: { template: "modules/fsd/templates/v2-form.hbs", forms: { ".v2-form": { handler: V2App.onSubmit, closeOnSubmit: false } } } };
      static TABS = { primary: { tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }], initial: "one" } };
      count = 0;
      static async onSubmit(this: V2App, _event: unknown, _form: unknown, formData: { object: unknown }) { (globalThis as unknown as { submitted: unknown[] }).submitted.push(formData.object); }
      async _prepareContext() { return { count: this.count, tabs: this._prepareTabs("primary"), label: "L", flag: true }; }
    }
    (globalThis as unknown as { submitted: unknown[]; v2: unknown }).submitted = [];
    const app = new V2App();
    (globalThis as unknown as { v2: unknown }).v2 = app;
    await app.render({ force: true });
  });
  const win = page.locator(".application.v2");
  await expect(win).toBeVisible();
  await expect(win.locator(".window-title")).toHaveText("Config window");
  await expect(win.locator('[data-application-part="main"] .tab.active')).toHaveText("one:0");
  await win.locator("[data-action=inc]").click();
  await expect(win.locator('[data-application-part="main"] .tab.active')).toHaveText("one:1");
  await win.locator('[data-action=tab][data-tab="two"]').click();
  await expect(win.locator('[data-application-part="main"] .tab.active')).toHaveText("two");
  expect(await page.evaluate(() => (globalThis as unknown as { v2: { tabGroups: Record<string, string> } }).v2.tabGroups)).toEqual({ primary: "two" });
  await win.locator(".v2-form input[name=label]").fill("changed");
  await win.locator(".v2-form button[type=submit]").click();
  expect(await page.evaluate(() => (globalThis as unknown as { submitted: unknown[] }).submitted)).toEqual([{ label: "changed", flag: true }]);
  const hookNames = await page.evaluate(() => Object.keys((globalThis as unknown as { hooks: Record<string, unknown> }).hooks));
  expect(hookNames).toEqual(expect.arrayContaining(["renderV2App", "renderHandlebarsApplication", "renderApplicationV2"]));
  // DialogV2.prompt with a callback reading the form; DialogV2.input resolving the form data; confirm → false on "No".
  const prompt = page.evaluate(() => (globalThis as unknown as { layer: { DialogV2: { prompt: (o: unknown) => Promise<unknown> } } }).layer.DialogV2.prompt({
    window: { title: "Name?" }, content: '<input name="who" value="x">', ok: { label: "Go", callback: (_e: unknown, button: { form: { elements: { who: { value: string } } } }) => button.form.elements.who.value },
  }));
  const dialog = page.locator(".application.dialog");
  await expect(dialog.locator(".window-title")).toHaveText("Name?");
  await dialog.locator("input[name=who]").fill("Mara");
  await dialog.locator('button[data-action="ok"]').click();
  expect(await prompt).toBe("Mara");
  await expect(page.locator(".application.dialog")).toHaveCount(0);
  const input = page.evaluate(() => (globalThis as unknown as { layer: { DialogV2: { input: (o: unknown) => Promise<unknown> } } }).layer.DialogV2.input({ content: '<input name="n" type="number" value="3"><input type="checkbox" name="c" checked>' }));
  await page.locator(".application.dialog input[name=n]").fill("9");
  await page.locator(".application.dialog input[name=n]").press("Enter");
  expect(await input).toEqual({ n: 9, c: true });
  const confirm = page.evaluate(() => (globalThis as unknown as { layer: { DialogV2: { confirm: (o: unknown) => Promise<unknown> } } }).layer.DialogV2.confirm({ content: "<p>Really?</p>" }));
  await page.locator('.application.dialog button[data-action="no"]').click();
  expect(await confirm).toBe(false);
  // Dismissing with Escape resolves null (rejectClose false) and the window count returns to the app alone.
  const dismissed = page.evaluate(() => (globalThis as unknown as { layer: { DialogV2: { confirm: (o: unknown) => Promise<unknown> } } }).layer.DialogV2.confirm({ content: "<p>Esc?</p>" }));
  await expect(page.locator(".application.dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await dismissed).toBeNull();
  await expect(page.locator(".application")).toHaveCount(1);
  await win.locator('[data-action="close"]').click();
  await expect(page.locator(".application")).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as unknown as { panel: string[] }).panel)).toEqual(["open", "close"]);
  expect(await page.evaluate(() => (globalThis as unknown as { __errors: string[] }).__errors)).toEqual([]);
});

test("core library (D-484): V2 form from core tab-navigation/form-footer parts + DataField inputs; Dialog v1 through templates/hud/dialog.html; missing core templates fail loudly", async ({ page }) => {
  await bootLayer(page);
  const boot = await page.evaluate(async () => {
    interface FieldLike { fieldPath: string; label: string }
    interface Model { schema: { fields: Record<string, FieldLike> }; toObject(): Record<string, unknown>; updateSource(c: Record<string, unknown>): Record<string, unknown>; radius: number; mode: string; enabled: boolean }
    interface Layer {
      ApplicationV2: unknown; HandlebarsApplicationMixin: (b: unknown) => unknown; Dialog: { confirm(o: unknown): Promise<unknown> };
      renderTemplate(p: string, d: unknown): Promise<string>; describeTemplates(): { compiled: number; core: string[]; missing: string[] };
      fields: { fields: Record<string, new (...a: unknown[]) => FieldLike>; DataModel: new (d?: unknown, o?: unknown) => Model; isDataModelClass(v: unknown): boolean; applications: { createTextInput(c: unknown): HTMLElement } };
      core: { templatePaths: readonly string[] };
    }
    const w = globalThis as unknown as { layer: Layer; submitted: unknown[]; prefs: unknown; dialogHtml: string; missing: string };
    const layer = w.layer;
    const F = layer.fields.fields;
    const NumberField = F.NumberField as new (o: unknown) => FieldLike;
    const StringField = F.StringField as new (o: unknown) => FieldLike;
    const BooleanField = F.BooleanField as new (o: unknown) => FieldLike;
    class Prefs extends layer.fields.DataModel {
      static defineSchema(): Record<string, FieldLike> {
        return {
          radius: new NumberField({ required: true, integer: true, min: 0, max: 60, step: 5, initial: 20, label: "T.Radius", hint: "T.RadiusHint" }),
          mode: new StringField({ required: true, choices: { soft: "T.Soft", hard: "T.Hard" }, initial: "soft", label: "T.Mode" }),
          enabled: new BooleanField({ initial: true }),
        };
      }
    }
    const Base = layer.HandlebarsApplicationMixin(layer.ApplicationV2) as new (o?: unknown) => { render(o: unknown): Promise<unknown>; _prepareTabs(g: string): unknown; model: Model };
    class PrefsApp extends Base {
      static DEFAULT_OPTIONS = { id: "prefs", classes: ["prefs-app"], tag: "form", window: { title: "T.Title" }, position: { width: 380 }, form: { handler: PrefsApp.onSubmit, closeOnSubmit: false } };
      static PARTS = {
        tabs: { template: "templates/generic/tab-navigation.hbs" },
        body: { template: "modules/fsd/templates/prefs.hbs" },
        footer: { template: "templates/generic/form-footer.hbs" },
      };
      static TABS = { primary: { tabs: [{ id: "general", label: "T.General", icon: "fa-solid fa-gear" }, { id: "advanced", label: "T.Advanced" }], initial: "general" } };
      override model: Model = new Prefs({ radius: 25 });
      static async onSubmit(this: PrefsApp, _event: unknown, _form: unknown, formData: { object: Record<string, unknown> }) {
        this.model.updateSource(formData.object);
        w.submitted.push(this.model.toObject());
      }
      async _prepareContext() {
        return {
          tabs: this._prepareTabs("primary"), fields: this.model.schema.fields, source: this.model.toObject(),
          actorInput: layer.fields.applications.createTextInput({ name: "actor", value: "Mara" }).outerHTML,
          buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" }, { type: "button", action: "reset", label: "SETTINGS.Reset" }],
        };
      }
    }
    w.submitted = [];
    const app = new PrefsApp();
    w.prefs = app;
    await app.render({ force: true });
    // A v13 `.hbs` alias and a v11 `.html` name resolve to the same core entry; a core path the library lacks names itself.
    w.dialogHtml = await layer.renderTemplate("templates/hud/dialog.hbs", { content: "<p>Keep?</p>", buttons: { yes: { label: "Yes" }, no: { label: "No" } }, default: "yes" });
    try { await layer.renderTemplate("templates/sidebar/apps/compendium.html", {}); w.missing = "rendered"; } catch (error) { w.missing = (error as Error).message; }
    return { isModel: layer.fields.isDataModelClass(Prefs), corePaths: layer.core.templatePaths.length, diagnostics: layer.describeTemplates() };
  });
  expect(boot.isModel).toBe(true);
  expect(boot.corePaths).toBeGreaterThanOrEqual(10);
  expect(boot.diagnostics.core).toEqual(["templates/generic/form-footer.hbs", "templates/generic/form-group.hbs", "templates/generic/tab-navigation.hbs", "templates/hud/dialog.html"]);
  expect(boot.diagnostics.missing).toEqual(["templates/sidebar/apps/compendium.html"]);
  const win = page.locator("form.application.prefs-app");
  await expect(win).toBeVisible();
  await expect(win.locator(".window-title")).toHaveText("Config window");
  // Core tab-navigation part drives the module's own tab sections through the V2 tab machinery.
  const nav = win.locator('nav.tabs[data-application-part="tabs"][data-group="primary"]');
  await expect(nav.locator("a.item")).toHaveCount(2);
  await expect(nav.locator('a.item.active[data-tab="general"]')).toContainText("General");
  await expect(nav.locator('a.item[data-tab="general"] i.fa-solid.fa-gear')).toHaveCount(1);
  await expect(win.locator(".prefs-general.tab.active")).toBeVisible();
  // DataField-driven inputs: NumberField → number input with constraints, StringField choices → select, BooleanField → checkbox, labels localized through module + core keys.
  const radius = win.locator('input[name="radius"]');
  await expect(radius).toHaveAttribute("type", "number");
  await expect(radius).toHaveAttribute("min", "0");
  await expect(radius).toHaveAttribute("max", "60");
  await expect(radius).toHaveValue("25");
  const radiusGroup = win.locator(".form-group", { has: page.locator('input[name="radius"]') });
  await expect(radiusGroup.locator("label")).toHaveText("Radius");
  await expect(radiusGroup.locator("p.hint")).toHaveText("In feet");
  await expect(win.locator('select[name="mode"] option')).toHaveText(["Soft", "Hard"]);
  await expect(win.locator('select[name="mode"]')).toHaveValue("soft");
  await expect(win.locator('input[name="enabled"]')).toBeChecked();
  await expect(win.locator(".form-group", { has: page.locator('input[name="enabled"]') }).locator("label")).toHaveText("Yes");
  await expect(win.locator(".form-group", { has: page.locator('input[name="actor"]') }).locator("label")).toHaveText("Actor");
  await expect(win.locator('input[name="actor"]')).toHaveValue("Mara");
  // Core form-footer part: localized core keys, icons, data-action on non-submit buttons.
  const footer = win.locator('footer.form-footer[data-application-part="footer"]');
  await expect(footer.locator('button[type="submit"]')).toContainText("Save Changes");
  await expect(footer.locator('button[type="submit"] i.fa-save')).toHaveCount(1);
  await expect(footer.locator('button[type="button"][data-action="reset"]')).toContainText("Reset Defaults");
  await nav.locator('a.item[data-tab="advanced"]').click();
  await expect(win.locator(".prefs-advanced.tab.active p.hint")).toHaveText("Are you sure?");
  await expect(nav.locator('a.item.active[data-tab="advanced"]')).toHaveCount(1);
  await nav.locator('a.item[data-tab="general"]').click();
  // Submit through the core footer: the DataModel validates/casts (number stays a number) and refuses out-of-range values.
  await radius.fill("40");
  await win.locator('select[name="mode"]').selectOption("hard");
  await footer.locator('button[type="submit"]').click();
  expect(await page.evaluate(() => (globalThis as unknown as { submitted: unknown[] }).submitted)).toEqual([{ radius: 40, mode: "hard", enabled: true }]);
  const rejected = await page.evaluate(() => {
    const prefs = (globalThis as unknown as { prefs: { model: { updateSource(c: Record<string, unknown>): unknown; radius: number } } }).prefs;
    try { prefs.model.updateSource({ radius: 999 }); return "accepted"; } catch (error) { return `${(error as Error).message} | radius=${prefs.model.radius}`; }
  });
  expect(rejected).toContain("radius must be at most 60");
  expect(rejected).toContain("radius=40");
  // Dialog v1 renders through the core dialog template (same markup a module gets from renderTemplate).
  const dialogHtml = await page.evaluate(() => (globalThis as unknown as { dialogHtml: string }).dialogHtml);
  expect(dialogHtml).toContain('<div class="dialog-content"><p>Keep?</p></div>');
  expect(dialogHtml).toContain('class="dialog-button yes default bright" data-button="yes"');
  const confirm = page.evaluate(() => (globalThis as unknown as { layer: { Dialog: { confirm: (o: unknown) => Promise<unknown> } } }).layer.Dialog.confirm({ title: "Keep?", content: "<p>Keep it?</p>" }));
  const dialog = page.locator(".window-app.dialog");
  await expect(dialog.locator(".dialog-content")).toHaveText("Keep it?");
  await expect(dialog.locator("button.dialog-button.yes.default")).toContainText("Yes");
  await dialog.locator("button.dialog-button.yes").click();
  expect(await confirm).toBe(true);
  await expect(page.locator(".window-app.dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as unknown as { missing: string }).missing)).toContain("templates/sidebar/apps/compendium.html is not in the AIS Foundry core library yet");
  await win.locator('[data-action="close"]').click();
  await expect(page.locator(".application")).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as unknown as { __errors: string[] }).__errors)).toEqual([]);
});
