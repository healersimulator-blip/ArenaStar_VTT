# Foundry UI appearances through AIS

## Open the ready-to-use demo

The live preview serves **`dist/preview/index.html`**, not the empty production start screen.
It contains an inert, integrity-checked copy of the **Alderwatch** world: an illustrated map,
three actors/tokens, example chat, and all four UI packages. It imports a **new copy** on first
open and remembers that copy for subsequent visits. No local ZIP or file picker is required.
Existing campaigns are never replaced, and executable-code approvals are never preloaded.

For offline testing, open **`dist/ui-demo.html`**. It is also self-contained and self-opening.
The normal `dist/index.html` continues to offer the ordinary world picker.

Build everything with:

```sh
corepack pnpm test:fx:prepare
```

Or rebuild only these packages, the world and the preview (after building the main app):

```sh
corepack pnpm build:ui-demo
```

## Choose an interface

The Interface selector opens on the first demo visit. Later, use the **palette button** in the
GM header.

1. Choose **Your Flavor**, **Carolingian**, or **RPG Styled UI**.
2. The first activation shows both the adapter and guest sources/hashes. Review the exact code,
   check the appearance-only consent box, and choose **Approve & activate**.
3. Changes apply **without reloading the world**. Other themes remain independent, not a stack
   of conflicting global stylesheets.
4. Your Flavor and Carolingian offer their upstream palette variants. RPG offers its supported
   shell appearance and original compact-mode behavior.
5. Choose **Compact** or **Comfortable** density and a sidebar width. Compact reduces header,
   window/control and text sizing, and removes redundant chrome metadata—not game functionality.
6. **Native appearance** or **Ctrl+Alt+0** resets the host styling immediately. These recovery and
   consent controls are outside the themed shell. The selector is a keyboard-trapped native modal.

The chosen module, variant, density and sidebar width are saved in a normal world settings
document and travel with exports. Code approvals do not: a copy opened on a different device
uses native styling until the GM approves the required packages there.

## What is actually connected

These are three explicitly bounded **appearance adaptations**, not full Foundry module parity.
The selector reports the source mode and exclusions instead of calling every feature compatible.

| Module | Code/assets actually used | Not implemented by this profile |
| --- | --- | --- |
| **Your Flavor** | Original `createStyleTokens`, `getStyleToken`, `flattenStyleTokens`, configuration normalizer and preset data. The original engine computes 269 tokens; the adapter maps its palette into native UI slots. | Studio/configuration applications, original chat card templates, Foundry DOM restructuring, remote fonts |
| **Carolingian UI** | Original `src/styles/vars.css`, including its theme classes. CSS is evaluated inside an opaque frame and its computed colors are mapped to ArenaStar. | The full Carolingian JavaScript entry, combat carousel, camera dock, taskbar/sidebar rewrites and system sheets |
| **RPG Styled UI** | Original `rpg-ui.js` startup/settings hooks, original shell CSS and selected original WebP artwork. Five original settings register; the original compact-mode hook is exercised. | Foundry branding, system sheets, combat carousel, full navigation reflow and remote fonts |

A separate world package, **`ais-foundry-ui`**, provides the isolated appearance environment and
adapter recipe. It does not bypass AIS or gain direct access to ArenaStar's DOM/store/renderer.
The prepared guest packages are `foundry-ui-your-flavor`, `foundry-ui-crlngn-ui`, and
`foundry-ui-rpg-styled-ui`.

### Important version details

Source is pinned rather than fetched at application startup:

- Your Flavor: `wand-and-widgets/your-flavor` at `fb0bbc87e9a6bb30b7fca8c5a042f15a1eec9b5b`.
- Carolingian UI: `crlngn/crlngn-ui` at `d179e8ab044fc03dffe0a24404e5f686b1c60c56` (4.5.4).
- RPG Styled UI: `Xbozon/rpg-styled-ui` at `ec9d193e145603c163aeeb6411de7ab26fbc9e0e` (v1.3.0;
  its own manifest targets Foundry 11–12, not a full v13/v14 API).

Original files and per-file digests live under each package's `upstream/` and `PROVENANCE.json`.
Preparation verifies those bytes before bundling. The RPG recipe supplies a private lexical
`navigation` binding expected by its legacy script; it does not modify the upstream file.

This is not “run arbitrary CSS in the main page.” External imports/font loads and resource URLs
are removed from prepared sandbox CSS. Original resources remain in the package for inspection.
Selected raster images are encoded as declared text resources, decoded only by the host, checked
as bounded WebP images and rendered using host-created Blob URLs. This is not a general binary
package loader.

## AIS/core changes

- A closed **`ui.theme` contribution** and appearance contract: seven colors, a font category,
  bounded corner radius, density, optional declared raster resources and diagnostic evidence.
- **No guest-supplied selectors, HTML, arbitrary CSS, positioning or hidden controls** enter the
  parent page. ArenaStar owns the CSS selectors and layout implementation.
- Main text must pass the contrast check. Invalid proposals do not replace a valid current style.
- A package-local, allowlisted **`package.resource.read`** RPC transfers UTF-8 resources in bounded
  chunks. No arbitrary file/package reads, filesystem handles, remote imports or shared storage.
- Explicit live activation is limited to reviewed appearance-only runtimes, using the same opaque
  iframe, per-instance port, hash-bound consent and capability intersection as other AIS guests.
- Both packages need `runtime.execute`, `package.resources.read`, and `ui.theme`; no world-edit,
  scene-data or FX capabilities are lent to a UI package by the quick selector.
- Module replacement/revocation stops the runtime and removes the applied appearance. Late or
  cancelled composition/image results cannot restore a reset theme. A source/provider change
  is rechecked before applying output.
- Native density/width controls are independent from the foreign palette. Native world controls,
  local code review and the emergency reset remain available.

This implementation is currently the **GM interface**. It does not hydrate/execute these modules
in player clients, emulate entire Foundry sheets, or promise containment of arbitrary CPU loops.

## Test it

```sh
corepack pnpm test --maxWorkers=2
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test:fx:prepare
corepack pnpm size
corepack pnpm test:e2e:ui-adapters
corepack pnpm test:e2e:ais
```

`e2e/ais_ui.spec.ts` opens the same self-starting preview route a tester uses—no file upload or
test auto-host shortcut. It exercises each source mode on `file://` and HTTPS, upstream preset
changes, original RPG setting/hook execution, native resource-backed styling, density, persistence,
focus trapping, keyboard reset, provider revocation and clean-context export/import consent.

The courtyard illustration is AI-generated specifically for this demo. Token portraits and the
procedural fallback map are original build-time artwork; no external media service is needed at
runtime. Module notices are retained and the previously deferred legal workstream is unchanged.
