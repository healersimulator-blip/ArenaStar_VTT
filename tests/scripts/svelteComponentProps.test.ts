/**
 * Every prop a `.svelte` template passes to a child component must be one the child declares.
 *
 * Svelte 5 drops unknown props silently and `.svelte` templates are not type-checked here
 * (`scripts/checkSvelte.mjs` only compiles), so a renamed or never-added prop produces no error
 * anywhere — `App.svelte` handed `aisModules` and `onOpenAisPanel` to `WindowHost`, which never
 * declared them, and the GM's module settings form stayed dead until a real browser run (D-480).
 * This test parses every component with the Svelte compiler and checks each `<Child attr>` and
 * `bind:attr` against the child's `$props()` destructuring. Children that take a rest prop
 * (`...rest`) or no `$props()` at all accept anything and are skipped.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "svelte/compiler";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = join(repoRoot, "src");

type AstNode = { type: string; [key: string]: unknown };

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) svelteFiles(path, out);
    else if (path.endsWith(".svelte")) out.push(path);
  }
  return out;
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") visit(record as AstNode);
  for (const [key, value] of Object.entries(record)) {
    if (key === "loc" || key === "metadata" || key === "parent") continue;
    if (value && typeof value === "object") walk(value, visit);
  }
}

/** Declared prop names, or null when the component accepts anything (rest prop / no `$props()`). */
function declaredProps(ast: ReturnType<typeof parse>): Set<string> | null {
  let result: Set<string> | null | undefined;
  const modern = ast as unknown as { instance?: { content: unknown } | null; module?: { content: unknown } | null };
  for (const script of [modern.instance, modern.module]) {
    if (!script) continue;
    walk(script.content, (node) => {
      if (node.type !== "VariableDeclarator") return;
      const init = node.init as AstNode | null;
      const callee = init?.type === "CallExpression" ? (init.callee as AstNode) : null;
      if (!callee || callee.type !== "Identifier" || callee.name !== "$props") return;
      const id = node.id as AstNode;
      if (id.type !== "ObjectPattern") { result = null; return; }
      const names = new Set<string>();
      let rest = false;
      for (const property of id.properties as AstNode[]) {
        if (property.type === "RestElement") { rest = true; continue; }
        const key = property.key as AstNode;
        if (key.type === "Identifier") names.add(key.name as string);
        else if (key.type === "Literal") names.add(String(key.value));
      }
      result = rest ? null : names;
    });
  }
  return result === undefined ? null : result;
}

/** `import X from "./X.svelte"` plus `import { X } from "../dir"` barrels (`export { default as X } from "./X.svelte"`). */
function componentImports(file: string, ast: ReturnType<typeof parse>): Map<string, string> {
  const imports = new Map<string, string>();
  const modern = ast as unknown as { instance?: { content: unknown } | null; module?: { content: unknown } | null };
  for (const script of [modern.instance, modern.module]) {
    if (!script) continue;
    walk(script.content, (node) => {
      if (node.type !== "ImportDeclaration") return;
      const source = (node.source as AstNode).value;
      if (typeof source !== "string" || !source.startsWith(".")) return;
      const target = resolve(dirname(file), source);
      for (const specifier of node.specifiers as AstNode[]) {
        const local = (specifier.local as AstNode).name as string;
        if (source.endsWith(".svelte") && specifier.type === "ImportDefaultSpecifier") imports.set(local, target);
        if (specifier.type === "ImportSpecifier") {
          const imported = (specifier.imported as AstNode).name as string;
          const barrel = [`${target}.ts`, join(target, "index.ts")].find((candidate) => existsSync(candidate));
          if (!barrel) continue;
          const match = new RegExp(`export \\{ default as ${imported} \\} from "([^"]+\\.svelte)"`).exec(readFileSync(barrel, "utf8"));
          if (match?.[1]) imports.set(local, resolve(dirname(barrel), match[1]));
        }
      }
    });
  }
  return imports;
}

describe("Svelte component props", () => {
  test("every prop passed to a child component is declared by that component", () => {
    const files = svelteFiles(srcRoot);
    expect(files.length).toBeGreaterThan(50);
    const parsed = new Map(files.map((file) => {
      const source = readFileSync(file, "utf8");
      return [file, { source, ast: parse(source, { modern: true, filename: file }) }] as const;
    }));
    const declared = new Map([...parsed].map(([file, { ast }]) => [file, declaredProps(ast)] as const));
    const violations: string[] = [];
    for (const [file, { source, ast }] of parsed) {
      const imports = componentImports(file, ast);
      walk((ast as unknown as { fragment: unknown }).fragment, (node) => {
        if (node.type !== "Component") return;
        const target = imports.get(node.name as string);
        if (!target) return;
        const props = declared.get(target);
        if (!props) return; // unknown file or a component that accepts anything
        for (const attribute of node.attributes as AstNode[]) {
          const name = attribute.type === "Attribute" || (attribute.type === "BindDirective" && attribute.name !== "this")
            ? (attribute.name as string) : null;
          if (!name || props.has(name)) continue;
          const line = source.slice(0, attribute.start as number).split("\n").length;
          violations.push(`${file.slice(repoRoot.length + 1)}:${line} passes "${name}" to <${String(node.name)}>, which ${target.slice(repoRoot.length + 1)} does not declare`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
