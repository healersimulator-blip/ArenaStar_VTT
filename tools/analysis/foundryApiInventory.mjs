#!/usr/bin/env node
/**
 * Measure a Foundry VTT package's dependency on the Foundry *framework*.
 *
 * Given a checkout of a Foundry system/module, counts per JavaScript file (non-blank,
 * non-comment LOC) the references to framework families — `foundry.*`, `game.*`, `CONFIG.*`,
 * `CONST.*`, `Hooks.*`, `canvas.*`, `ui.*`, Handlebars/templates, `fromUuid`, document CRUD,
 * flags, bare UI classes, i18n, settings, sockets, jQuery — and prints:
 *   1. a per-directory table (files, LOC, framework refs, refs per 100 LOC);
 *   2. call sites per family (the "edit surface" of a port);
 *   3. a coupling-density histogram (how much code is near-pure versus framework-bound);
 *   4. distinct-member inventories per family (the surface a facade would have to provide).
 *
 *   node tools/analysis/foundryApiInventory.mjs --dir /path/to/foundryvtt-pathfinder1/module [--exclude test]
 *
 * The first run against the pf1 mirror `681929d1` is recorded in
 * `PF1E_FOUNDRY_PORT_COST_ANALYSIS.md`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const dirArg = args[args.indexOf("--dir") + 1];
if (!args.includes("--dir") || !dirArg) {
  console.error("usage: foundryApiInventory.mjs --dir <module dir> [--exclude <subdir>]");
  process.exit(1);
}
const exclude = args.includes("--exclude") ? args[args.indexOf("--exclude") + 1] : null;

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(e)) files.push(p);
  }
})(dirArg);

const families = {
  "foundry.*": /\bfoundry\.[a-zA-Z]/g,
  "game.*": /\bgame\.[a-zA-Z]/g,
  "CONFIG.*": /\bCONFIG\.[A-Za-z]/g,
  "CONST.*": /\bCONST\.[A-Z]/g,
  "Hooks.*": /\bHooks\.(on|once|off|call|callAll)\b/g,
  "canvas.*": /\bcanvas\.[a-zA-Z]/g,
  "ui.*": /\bui\.[a-zA-Z]/g,
  "templates/Handlebars": /\b(renderTemplate|loadTemplates|Handlebars\.|getTemplate)\b/g,
  fromUuid: /\bfromUuid(Sync)?\(/g,
  "document CRUD": /\.(create|update|delete)(Embedded)?Documents?\(|\.(update|delete|create)\(\s*[{[A-Za-z"]/g,
  flags: /\.(get|set|unset)Flag\(/g,
  "bare UI classes": /\b(new\s+)?(Dialog|DialogV2|FilePicker|ContextMenu|DragDrop|TextEditor|SearchFilter|Tabs|Draggable|FormDataExtended|ProseMirror)\b[.(]/g,
  i18n: /\bgame\.i18n\.(localize|format|has)\b/g,
  settings: /\bgame\.settings\.(get|set|register|registerMenu)\b/g,
  socket: /\bgame\.socket\b|\bsocket\.(emit|on)\b/g,
  "jQuery $(": /(^|[^\w$])\$\(/g,
};

const rows = [];
for (const f of files) {
  const relPath = relative(dirArg, f);
  if (exclude && relPath.split("/")[0] === exclude) continue;
  const src = readFileSync(f, "utf8");
  const loc = src.split("\n").filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
  const counts = {};
  let ext = 0;
  for (const [k, re] of Object.entries(families)) {
    const n = (src.match(re) ?? []).length;
    counts[k] = n;
    ext += n;
  }
  rows.push({ file: relPath, dir: relPath.includes("/") ? relPath.split("/")[0] : relPath, loc, ext, counts, src });
}

const byDir = new Map();
for (const r of rows) {
  const d = byDir.get(r.dir) ?? { files: 0, loc: 0, ext: 0 };
  d.files++;
  d.loc += r.loc;
  d.ext += r.ext;
  byDir.set(r.dir, d);
}
const totLoc = rows.reduce((a, r) => a + r.loc, 0);
const totExt = rows.reduce((a, r) => a + r.ext, 0);
console.log("== per directory: files, LOC (non-blank, non-comment), framework refs, refs/100 LOC ==");
for (const [d, v] of [...byDir].sort((a, b) => b[1].loc - a[1].loc)) {
  console.log(d.padEnd(28), String(v.files).padStart(4), String(v.loc).padStart(7), String(v.ext).padStart(6), ((100 * v.ext) / Math.max(v.loc, 1)).toFixed(1).padStart(6));
}
console.log("TOTAL".padEnd(28), String(rows.length).padStart(4), String(totLoc).padStart(7), String(totExt).padStart(6), ((100 * totExt) / Math.max(totLoc, 1)).toFixed(1).padStart(6));

console.log("\n== call sites per family ==");
const famTotals = Object.keys(families).map((k) => [k, rows.reduce((a, r) => a + r.counts[k], 0)]);
for (const [k, n] of famTotals.sort((a, b) => b[1] - a[1])) console.log(k.padEnd(22), String(n).padStart(6));

console.log("\n== coupling-density histogram ==");
const bins = [
  [0, 1, "<1 /100 LOC (near-pure)"],
  [1, 3, "1-3"],
  [3, 6, "3-6"],
  [6, 10, "6-10"],
  [10, Infinity, ">10 (framework-bound)"],
];
for (const [lo, hi, label] of bins) {
  const sel = rows.filter((r) => {
    const d = (100 * r.ext) / Math.max(r.loc, 1);
    return d >= lo && d < hi;
  });
  console.log(label.padEnd(26), String(sel.length).padStart(4), "files", String(sel.reduce((a, r) => a + r.loc, 0)).padStart(7), "LOC");
}

console.log("\n== distinct members per family (surface a facade must provide) ==");
const all = rows.map((r) => r.src).join("\n");
const distinct = (re, norm = (x) => x) => {
  const m = new Map();
  for (const x of all.matchAll(re)) {
    const k = norm(x[1] ?? x[0]);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
};
const inventories = {
  "foundry.<ns>.<member> (non-utils)": distinct(/\bfoundry\.((?!utils)[a-zA-Z]+(?:\.[a-zA-Z]+){1,2})/g, (k) => k.replace(/\.(prototype|name|implementation)$/, "")),
  "foundry.utils.<fn>": distinct(/\bfoundry\.utils\.([a-zA-Z]+)/g),
  "fields.<Type>": distinct(/\b(?:fields|foundry\.data\.fields)\.([A-Z][A-Za-z]+)/g),
  "game.<service>.<member>": distinct(/\bgame\.([a-zA-Z0-9]+\.[a-zA-Z]+)/g),
  "CONFIG.<X>.<y>": distinct(/\bCONFIG\.([A-Za-z]+\.[a-zA-Z]+)/g),
  "canvas.<x>[.<y>]": distinct(/\bcanvas\.([a-zA-Z]+(?:\.[a-zA-Z]+)?)/g),
  "ui.<x>[.<y>]": distinct(/\bui\.([a-zA-Z]+(?:\.[a-zA-Z]+)?)/g),
  "CONST.<X>": distinct(/\bCONST\.([A-Z_]+)/g),
  "core hooks listened (non-own)": distinct(/\bHooks\.(?:on|once)\(\s*"([a-zA-Z.]+)"/g).filter(([k]) => !/^pf1|^sbc/.test(k)),
  "Application lifecycle members": distinct(
    /\b(_prepareContext|_preparePartContext|_onRender|_onFirstRender|_preRender|_onClose|_preClose|_initializeApplicationOptions|_configureRenderOptions|_configureRenderParts|_attachPartListeners|_onChangeForm|_processFormData|_processSubmitData|_onSubmitForm|_replaceHTML|_renderHTML|_renderFrame|_getHeaderControls|_onClickAction|_canRender|_onPosition|_syncPartState|_preSyncPartState|_onDragStart|_onDrop|_onDragOver|_canDragStart|_canDragDrop|_getTabsConfig|_prepareTabs|changeTab|tabGroups|activateListeners|getData|_updateObject|_getSubmitData)\b/g,
  ),
};
for (const [name, list] of Object.entries(inventories)) {
  const uses = list.reduce((a, [, n]) => a + n, 0);
  console.log(`\n${name}: ${list.length} distinct, ${uses} uses`);
  console.log("  " + list.slice(0, 12).map(([k, n]) => `${k}(${n})`).join(" "));
}
