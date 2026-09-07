#!/usr/bin/env node
/**
 * §0 `size` script: prints raw + gzip size of dist/index.html.
 * Fails (exit 1) if the raw size exceeds the 6 MB uncompressed budget (§9).
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = resolve(root, "dist/index.html");
const MAX_RAW = 6 * 1024 * 1024;

let bytes;
try {
  bytes = readFileSync(file);
} catch (err) {
  if (err && err.code === "ENOENT") {
    console.error(`FAIL: ${file} not found — run \`pnpm build\` first`);
    process.exit(1);
  }
  throw err;
}

const raw = bytes.length;
const gz = gzipSync(bytes).length;
const mb = (n) => `${(n / 1024 / 1024).toFixed(3)} MB`;
console.log(`dist/index.html  raw: ${mb(raw)} (${raw} bytes)   gzip: ${mb(gz)} (${gz} bytes)`);

if (raw > MAX_RAW) {
  console.error(`FAIL: raw size exceeds the 6 MB budget (§9 quality bar)`);
  process.exit(1);
}
console.log("OK: within the 6 MB raw budget");
