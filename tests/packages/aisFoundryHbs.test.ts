/**
 * D-483 (R-04): the adapter's own Handlebars-compatible template engine (`runtime/hbs.js`).
 * Foundry modules ship `.hbs` templates written for the real Handlebars; this is the compatibility
 * contract the sandbox runtime honours. The script is evaluated as the adapter evaluates it inside
 * the module frame (a plain classic script that publishes `globalThis.__aisFoundryHbs`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

interface HbsHelperOptions { hash: Record<string, unknown>; fn(context?: unknown): string; inverse(context?: unknown): string }
interface HbsEngine {
  compile(source: string, options?: { noEscape?: boolean }): (context?: unknown) => string;
  registerHelper(name: string, fn: (...args: unknown[]) => unknown): void;
  registerPartial(name: string, source: string): void;
  SafeString: new (value: string) => { toString(): string };
}

const scriptPath = join(process.cwd(), "modules/ais-foundry-v13/runtime/hbs.js");
const hadGlobal = "__aisFoundryHbs" in globalThis;
new Function(readFileSync(scriptPath, "utf8"))();
const factory = (globalThis as unknown as { __aisFoundryHbs: { create(): HbsEngine } }).__aisFoundryHbs;
afterAll(() => { if (!hadGlobal) Reflect.deleteProperty(globalThis, "__aisFoundryHbs"); });

function engine(): HbsEngine {
  const H = factory.create();
  H.registerHelper("up", (s) => String(s).toUpperCase());
  H.registerHelper("lower", (s) => String(s).toLowerCase());
  H.registerHelper("join", (...args) => { const options = args.pop() as HbsHelperOptions; return args.join(String(options.hash.sep)); });
  H.registerHelper("helperWithThis", function (this: { v: unknown }) { return this.v; });
  H.registerHelper("block", (options) => `[${(options as HbsHelperOptions).fn({})}]`);
  H.registerPartial("part", "P{{x}}");
  H.registerPartial("quoted", "Q");
  return H;
}

/** [template, context, expected output] — the same 41 cases the engine was developed against. */
const cases: [string, unknown, string][] = [
  ["Hi {{name}}!", { name: "<b>" }, "Hi &lt;b&gt;!"],
  ["{{{html}}} {{&html}}", { html: "<i>" }, "<i> <i>"],
  ["{{#if a}}yes{{else}}no{{/if}}", { a: 0 }, "no"],
  ["{{#if a includeZero=true}}yes{{else}}no{{/if}}", { a: 0 }, "yes"],
  ["{{#unless a}}no{{/unless}}", { a: [] }, "no"],
  ["{{#each items}}{{@index}}:{{this}}{{#unless @last}},{{/unless}}{{/each}}", { items: ["a", "b"] }, "0:a,1:b"],
  ["{{#each obj}}{{@key}}={{this}};{{/each}}", { obj: { x: 1, y: 2 } }, "x=1;y=2;"],
  ["{{#each items as |item i|}}{{i}}-{{item.n}}{{/each}}", { items: [{ n: "p" }, { n: "q" }] }, "0-p1-q"],
  ["{{#each items}}{{../title}}:{{name}} {{/each}}", { title: "T", items: [{ name: "a" }] }, "T:a "],
  ["{{#with inner}}{{v}}{{/with}}", { inner: { v: 5 } }, "5"],
  ["{{#with inner}}{{@root.top}}{{/with}}", { inner: {}, top: "R" }, "R"],
  ["{{a.b.c}} {{a.[b].c}} {{a/b/c}}", { a: { b: { c: 7 } } }, "7 7 7"],
  ["{{#if a}}1{{else if b}}2{{else}}3{{/if}}", { b: true }, "2"],
  ["{{#if a}}1{{else if b}}2{{else}}3{{/if}}", {}, "3"],
  ["{{^missing}}none{{/missing}}", {}, "none"],
  ["{{#list}}{{.}}{{/list}}", { list: [1, 2] }, "12"],
  ["{{#person}}{{name}}{{/person}}", { person: { name: "Z" } }, "Z"],
  ["{{lookup obj key}}", { obj: { k: "v" }, key: "k" }, "v"],
  ["{{up (lower 'ABC')}}", {}, "ABC"],
  ["{{join 'a' 'b' sep='-'}}", {}, "a-b"],
  ["{{> part}}", { x: 1 }, "P1"],
  ["{{> part ctx}}", { ctx: { x: 2 } }, "P2"],
  ["{{> part x=3}}", {}, "P3"],
  ["{{> (lookup . 'p')}}", { p: "part", x: 4 }, "P4"],
  ["{{#> nope}}fallback{{/nope}}", {}, "fallback"],
  ["{{#each items as |it|}}{{#if it}}{{it}}{{/if}}{{/each}}", { items: ["m", ""] }, "m"],
  ["  {{#if a}}\n  x\n  {{/if}}\n", { a: 1 }, "  x\n"],
  ["{{! comment }}a{{!-- long --}}b", {}, "ab"],
  ["a {{~ x ~}} b", { x: "y" }, "ayb"],
  ["{{true}} {{false}} {{null}} {{undefined}} {{1.5}} {{'s'}}", {}, "true false   1.5 s"],
  ["{{fn}}", { fn() { return (this as { v: string }).v; }, v: "V" }, "V"],
  ["{{#each m}}{{this}}{{/each}}", { m: new Set(["a", "b"]) }, "ab"],
  ["{{#each e}}x{{else}}empty{{/each}}", { e: [] }, "empty"],
  ["{{#each outer}}{{#each this}}{{@../index}}.{{@index}} {{/each}}{{/each}}", { outer: [[1, 2]] }, "0.0 0.1 "],
  ["{{this}}", "str", "str"],
  ["{{a}}", { a: "x=y`" }, "x&#x3D;y&#x60;"],
  ['{{> "quoted"}}', {}, "Q"],
  ["{{helperWithThis}}", { v: 9 }, "9"],
  ["{{#block}}B{{/block}}", {}, "[B]"],
  ["{{#each items}}{{@index}}{{/each}}", { items: null }, ""],
];

describe("ais-foundry-v13 runtime/hbs.js — Handlebars compatibility", () => {
  test.each(cases)("%s", (source, context, expected) => {
    expect(engine().compile(source)(context)).toBe(expected);
  });

  test("SafeString output is not escaped; raw blocks are rejected explicitly", () => {
    const H = engine();
    expect(H.compile("{{raw}}")({ raw: new H.SafeString("<ok>") })).toBe("<ok>");
    expect(() => H.compile("{{{{raw}}}}")({})).toThrow();
  });

  test("noEscape templates and partial recursion depth are bounded the way Foundry templates rely on", () => {
    const H = engine();
    expect(H.compile("{{v}}", { noEscape: true })({ v: "<x>" })).toBe("<x>");
    H.registerPartial("loop", "{{> loop}}");
    expect(() => H.compile("{{> loop}}")({})).toThrow();
  });
});
