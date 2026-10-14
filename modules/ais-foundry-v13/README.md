# AIS Foundry v13 feasibility adapter

ArenaStar-authored code, loaded inside the separately approved guest's opaque AIS iframe.
The adapter is a runtime provider, not an in-page module or a replacement game engine.

Profile: `foundry-v13-scene-tags-fx` (experimental, GM-local).

- Synchronous local hooks, scene collections, projected document/tag facades and a small utility API.
- Initialization/hydration over AIS; a fresh command-scoped view for each invocation.
- Tag-only updates with local pre-hook/veto, host revision validation, committed acknowledgement,
  then local post-hook notification.
- A small `Sequence`/manager facade over the existing native transient FX engine.
- Effective rights are the intersection of this package's and the guest's grants.
- `runtime.execute` is required on both packages; it also prevents older kernels from treating a
  cached runtime guest as an ordinary AIS entry and ignoring the composition policy.
- No standalone execution. Disabling, revoking or replacing this provider stops its guests.

Not a full Foundry runtime: settings, applications, parent DOM, renderer handles, player delegation,
all-scene/actor access and persistent guest FX are intentionally unsupported. Keybinding definitions
are recorded for diagnostics, not dispatched into ArenaStar's UI. Unknown calls fail rather than
pretending a feature worked. `game.version` describes the v13 API profile, not a running Foundry build.

Build with `corepack pnpm build:ais-demo` (or `test:fx:prepare`). The build writes this package ZIP,
a separately packaged original Tagger guest and a self-contained demonstration world into `dist/`.
See the repository's `AIS_FOUNDRY_FEASIBILITY.md` for the walkthrough and exact limits.
