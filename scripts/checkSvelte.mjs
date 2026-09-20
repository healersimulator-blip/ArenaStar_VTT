#!/usr/bin/env node
/**
 * §10 `check:svelte` — compile every `.svelte` with the Svelte compiler and fail on
 * errors plus the compiler warnings that have already caused real bugs here
 * (D-255: a `.svelte` file is invisible to `tsc`, which is how the wrong session
 * property shipped).
 *
 * Blocking warnings:
 *   non_reactive_update — state that does not trigger re-render (the boot race class)
 *   ownership_invalid_mutation — a child mutating a parent's state
 *   invalid_props_id / invalid_rest_props_id / invalid_snippet_id — template correctness
 * Everything else is printed as information (`svelte-check` would type-check the templates
 * themselves; it is not installable in this offline environment — see D-256/T-12).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(root, "src");
const BLOCKING = new Set([
  "non_reactive_update",
  "ownership_invalid_mutation",
  "invalid_props_id",
  "invalid_rest_props_id",
  "invalid_snippet_id",
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".svelte")) out.push(path);
  }
  return out;
}

const files = walk(srcDir).sort();
let failed = 0;
let warned = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const name = relative(root, file);
  let result;
  try {
    result = compile(source, { filename: name, generate: "client" });
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
    continue;
  }
  for (const warning of result.warnings) {
    const line = warning.start ? `:${warning.start.line}` : "";
    const text = `${name}${line} [${warning.code}] ${warning.message}`;
    if (BLOCKING.has(warning.code)) {
      failed++;
      console.error(`FAIL ${text}`);
    } else {
      warned++;
      console.warn(`info ${text}`);
    }
  }
}

console.log(
  `svelte check: ${files.length} component(s), ${failed} blocking issue(s), ${warned} advisory warning(s)`,
);
process.exit(failed === 0 ? 0 : 1);
