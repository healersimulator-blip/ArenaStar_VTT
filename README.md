# VTT — serverless browser-only Virtual Tabletop

A Foundry-class virtual tabletop that ships as **one self-contained `index.html`**
(all JS/CSS/wasm/fonts inlined). No dedicated server: the GM's browser tab is the
authoritative host, persister and relay; players join with a link/code. Implements
the architecture spec in `uploads/VTT_Task.txt` (§0–§19) — see `PLAN.md`.

## Quickstart

```sh
pnpm install
pnpm dev          # vite dev server
pnpm build        # → dist/index.html (single file, ≤ 6 MB raw budget)
pnpm test         # vitest unit tests
pnpn typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm size         # prints raw+gzip size of dist/index.html, fails > 6 MB raw
pnpm build:systems # → dist/packages/<id>-<version>.zip (strategic ruleset + content pack)
pnpm build:worlds  # → dist/worlds/<id>-starter-<version>.zip (ready-to-open starter worlds)
pnpm test:e2e     # builds, then runs Playwright against file:// of dist/index.html

# Content (optional — the full PF1e compendium, 28 packs / ~25k entries):
pnpm content:fetch   # clones the pinned sources into tools/content/vendor/ (git-ignored, ~262 MB)
pnpm content:convert # → dist/content/pf1e (manifest + packs + OGL.txt + CREDITS.md)
```

Requires Node 20+ and pnpm 10.

**Play PF1e Mass Battles in three clicks:** `pnpm build && pnpm build:systems && pnpm build:worlds`,
open `dist/index.html`, **Open file (.zip)** → `dist/worlds/pf1e-mass-battles-starter-1.0.0.zip`
→ **Open as new world**. The world boots with the PF1e strategic ruleset active and the PF1e
Core compendia installed; nothing to activate, nothing to reload.

### Content: two ways in

The full converted compendium is **data**, not code: it rides in a world zip and never enters the
app body, so the single-file build stays inside its 6 MB budget.

1. **Build it here** (needs network once). The order matters, because `pnpm build` empties `dist/`:

   ```sh
   pnpm content:fetch                      # pinned checkouts → tools/content/vendor/
   pnpm build && pnpm build:systems && pnpm content:convert && pnpm build:worlds
   pnpm content:package                    # download-ready zip + dist/release/SHA256SUMS
   ```

   `content:fetch` reads `tools/content/sources.json` — every source is a repo URL, an exact
   commit, a sparse path set and the licence fact recorded in `tools/adopt/INVENTORY.md`. It is
   idempotent and verifies what it fetched; `pnpm content:fetch --check` reports the state without
   changing anything, and `--dest <dir>` keeps the 262 MB of sources outside the repo (the
   converter then needs `VTT_CONTENT_VENDOR=<dir>`). If the content directory is missing,
   `build:worlds` still builds the plain starter and says so.

2. **Download the artifacts** (no toolchain, nothing to build). `pnpm content:package` writes the
   installable `dist/packages/pf1e-content-<v>.zip`, `dist/worlds/` holds the ready-made world
   zips, and `dist/release/SHA256SUMS` covers both — that is the file set to attach to a release,
   so a GM without a toolchain downloads one file. Open a zip in the app — **Open file (.zip)** —
   and the packs are installed with the world.

Either way the licence travels with the data: every content package ships `OGL.txt` and
`CREDITS.md` beside its packs, and the app's Help window (**Licences & credits**, `?` in the
canvas rail) names the upstream sources, their pinned commits and the licence. The policy and the
per-asset facts live in `LEGAL.md` and `tools/adopt/INVENTORY.md`.

## Layout

Exact per spec §18 — see `src/` (app, core, host, client, net/signaling/_, canvas/_,
ui/*, dice, audio, packages, storage, workers, sim) and `systems/mass-battle-basic/`.
Each module folder has an `index.ts` barrel. Tracking files live in the repo root:
`PLAN.md`, `DECISIONS.md`, `DEVIATIONS.md`, `ROADMAP.md`, `PROTOCOL.md`.

## World files, rulesets and content packs (§8, §12)

A GM handles **one file per campaign**: the world file. Everything else travels inside it
(D-248 format 2, D-249 lifecycle). The app tells the three `.zip` shapes apart by content:

- **World file** — `world.json` at the root. Exported from *Export world (.zip)* /
  *Save to folder…* (in-world) or *Export* on the start screen; it carries the world's
  §12 packages, so a shared world boots the same strategic ruleset on another machine.
  A **starter world** (`pnpm build:worlds`) is a world file with no campaign in it, a
  ruleset active and its content packs installed — it always opens as a fresh copy.
- **Strategic ruleset** — a `manifest.json` with `type: "system"` and `rules.js`
  (e.g. `systems/pf1e-mass-battles`). It drives **strategic** scenes only
  (heroes + units, Settings → Scale); tactical scenes (heroes only) never touch it,
  so one world can mix both kinds. It is chosen in **New world…** and pinned once the
  first strategic turn is resolved.
- **Content pack** — a `manifest.json` with `type: "data"` and packs (e.g.
  `systems/pf1e-core`); its entries appear under Compendia. Chosen in **New world…** or
  added any time under Settings → *Strategic ruleset & content*.

The start screen lists the worlds on this device (**Open / Export / Delete**) and has one
**Open file (.zip)** entry: a world file offers *Open as new world* (a copy under a fresh id,
optionally renamed) or *Restore* (the archive's own id — overwrites that world if present); a
ruleset or content pack is named for what it is and offers *New world with it…*. Inside a
world, **Close world…** returns to the start screen; the sidebar has no importer of its own.

## Fog of war (§9)

Fog is a per-scene switch under **Settings → Scene** (*Fog of war*, with an optional *Sight
range* in squares; 0 = the whole scene, sight-blocking walls and closed doors always apply).
Each player uncovers the map with the tokens they control and keeps what they have seen
(D-250): the explored map is saved per player and scene by the host, comes back on reload or
reconnect, and travels in the world file (`fog.json` + `fog/*.png`). What is in sight right
now is clear; what was seen before is dimmed; what was never seen is black.

Fog also hides tokens (D-251): on a fogged scene a player's canvas draws only the tokens they
control plus whatever stands in their sight right now — a token in a remembered or unexplored
area is not drawn and cannot be selected, opened or right-clicked; it appears the moment it
walks into sight or the player's token walks up to it. The GM is never gated: the GM's fog is
a translucent overlay marking where fog lies while every token and map feature stays visible
under it (**God view**, on by default; switch it off in Settings → Scene or GM extras to
preview the opaque cover players get). The GM's own map is the union of every vision token.

## file:// limitations (§15)

The deliverable must boot from `https://` and `file://`:

- The app boots from `file://` in all supported browsers; the bootstrap screen
  reports which storage/network APIs the current origin provides.
- Storage availability on `file://` varies by browser: IndexedDB and Cache API
  generally work in Chromium; OPFS (`navigator.storage.getDirectory`) requires a
  secure context and may be unavailable; Safari/Firefox restrict some storage on
  `file://` origins. The host persistence layer degrades with a visible warning
  when a required store is missing.
- WebRTC works on `file://` (it is treated as a trustworthy/secure context by the
  supported browsers), but public signaling relays must be reachable over wss/https.
- For long-running hosted worlds we recommend serving `index.html` over `https://`;
  `file://` is fully supported for quick local play.

## Browser matrix (§15)

Chromium ≥ 110, Firefox ≥ 115, Safari ≥ 16.4. Playwright e2e runs Chromium; the
other engines are exercised per the matrix during milestone acceptance.

For an already-installed Chromium when the Playwright browser CDN is unavailable,
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable:

```bash
pnpm build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium \
  pnpm exec playwright test e2e/sheets.spec.ts e2e/windows.spec.ts --project=chromium --workers=1
```

No browser of your own? The npm registry alone is enough — `npm i @sparticuz/chromium`
ships a compressed Chromium plus a tarball of the system libraries it needs; unpack both,
point `LD_LIBRARY_PATH` at the library directory and pass its `executablePath()` to the
variable above. That is how the acceptance runs in this repository's own sandbox were made
(repeatedly, after the CDN turned out to be unreachable).

Containers without user namespaces cannot start the Chromium sandbox; there,
`PLAYWRIGHT_CHROMIUM_NO_SANDBOX=1` is the explicit opt-in that relaxes it. It is the only
case in which the config passes a browser-security flag, it applies only alongside the
executable override above, and CI never sets it. (It was not needed in the sandbox this
repository's own acceptance runs used — the specs pass either way there.)

The override affects only the Chromium project. Without it, Playwright uses its pinned
browser as before. Record the actual browser version when using an alternate binary; this
is not Firefox/WebKit or full supported-matrix acceptance. Browser executables and their
libraries stay outside Git.
