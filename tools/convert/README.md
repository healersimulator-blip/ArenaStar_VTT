# PF1e content converter

Converts the pinned Foundry checkouts (`tools/content/vendor/`, gitignored — clone commands
in `tools/adopt/INVENTORY.md`) into the `pf1e-content` data package that the app's
compendium reader consumes.

## Run

```
pnpm content:convert                # → dist/content/pf1e (manifest.json + packs/*.json + OGL.txt + CREDITS.md + REPORT.md)
node tools/convert/index.mjs --only spells-core,feats   # a subset of the 28 packs
```

**Pipeline order matters:** `pnpm build` (vite) empties `dist/`, which also removes
`dist/content/`. Build in this order:

```
pnpm build && pnpm build:systems && pnpm content:convert && pnpm build:worlds
```

`build:worlds` defaults `--content-dir` to `dist/content/pf1e`; when that folder is missing
(fresh clone, or a `build` that ran since the last convert) it builds the plain starter and
notes that the tester starter is skipped.

## Layout

- `mappers.mjs` — the pure mappers (one per target entry kind: spell / feat / class / item /
  actor / roll table / journal) + lookup tables + the drop-report counters. No I/O.
  Typed by `mappers.d.mts`.
- `packs.mjs` — which vendored source directory becomes which of the 28 packs
  (stage 1a = the pf1 system core YAML packs, stage 1b = the pf1e-content expanded JSON
  packs), the target collection per pack (`items` / `actors` / `journals` / `rollTables`),
  and the package descriptor.
- `index.mjs` — the CLI: walks each source dir, maps every entry, writes deterministic
  bytes (sorted entries/files, 2-space JSON), and renders `REPORT.md` (per-pack in/out plus
  every dropped category) and `CREDITS.md`.

## Source-shape detection (pf1 system YAML)

Foundry v11 documents carry a `_key` whose prefix is the document kind. The converter
treats:

- `!folders!` → pack scaffolding, dropped and reported;
- `!macros!` → module-API JavaScript, dropped (P-6 mapping — never ported raw);
- everything else → an entry, dispatched by `type` (spell / feat / class / npc / …) with
  shape fallbacks for type-less documents: `results[]` → roll table, `content` / `pages[]`
  → journal (markdown pages).

pf1e-content JSON dispatches on `type` the same way; the `#[CF_tempEntity]` compendium-folder
stubs in `pf-rules` are dropped and reported.

## Drop policy (plan §2 / P-1)

Mapped fields are the ones the app consumes (the in-repo `systems/pf1e-core/packs/` goldens
are the quality bar); the rest of the Foundry `system` rides under `system.foundry`
(per-kind whitelist — no loss, no bloat). Dropped outright and counted in `REPORT.md`:
`_id`/`_key`/`_stats`, `img` (paths into Foundry's icon library, not shipped), `flags`,
source `items[]`/`effects[]` (per-entry links into other compendia), `scriptCalls`
(module API). Creature AC/saves that the source authored as `0` (derived-from-equipment)
are NOT fabricated — the sheet composes them and the report names each derivation.

## Licensing

The package ships `OGL.txt` (the content's own notice, copied from the vendor checkout) and
`CREDITS.md`. Per D-252, license status is decided case-by-case by Legal; this tooling is
the pipeline that records the facts, not a legal verdict.
