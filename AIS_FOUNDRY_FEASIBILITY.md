# Foundry-through-AIS: runnable feasibility demo

**Experimental, GM-local.** This is a working vertical slice, not general Foundry compatibility.
It runs the original pinned **Tagger 1.5.4** JavaScript inside a world-packaged adapter and uses
ArenaStar's existing FX engine through AIS. Neither package bypasses the AIS broker.

## Build and open

```sh
corepack pnpm test:fx:prepare
```

This builds the app, ordinary starter worlds, and:

- `dist/packages/ais-foundry-v13-0.1.0.zip` — the adapter.
- `dist/packages/foundry-tagger-0.1.0.zip` — the prepared guest with original source and provenance.
- **`dist/worlds/ais-foundry-feasibility-0.1.0.zip`** — the ready-to-import demo world containing both.

`corepack pnpm build:ais-demo` rebuilds just those three archives, offline. No upstream install/build
scripts or module entry points execute during preparation. The compiler only bundles the three
byte-pinned source files, and fails if they differ from `PROVENANCE.json`.

1. Open the newly built `dist/index.html`, from `file://` or a served origin.
2. On the start screen choose **Open file (.zip)** and select the demo world. Open it as a copy.
3. Open **Settings → Packages**. The world requests both packages, but **neither is approved**.
4. Review **Foundry v13 adapter — feasibility profile**, select its four capabilities, and use
   **Review & approve code → Confirm sandboxed-code approval**.
5. Separately review/approve **Original Tagger 1.5.4 — AIS feasibility guest** with the same capabilities.
   The guest preview includes its prepared upstream code and ArenaStar command bindings.
6. **Reload now**. The adapter should report **available**, and the guest **ready**. There is one
   sandbox for the composed guest, not a second in-page engine.

The world has two non-hidden tokens, `beacon-one` and `beacon-two`, tagged `Beacon`. A third token,
`hidden-beacon`, is deliberately excluded from the adapter's view even though the local GM can
inspect it through native controls.

## Exercise actual upstream Tagger

Open **Macros → Scripts**. Choose the demo scene, grant **ais.invoke**, leave player invocation off,
review the exact script revision, and save it. The grant selects reviewed GM authority.
Run one example at a time; when editing code, review/save the new revision again.

Inspect the loaded implementation:

```js
return await api.ais.invoke("foundry-tagger", "info", {});
```

The result identifies the profile, upstream version and source commit
`e7936bc9ee01e4445624fbc82a11e887e5cd0075`, the composed execution hash and registered hooks.

Query with the original Tagger API:

```js
return await api.ais.invoke("foundry-tagger", "find", {
  tags: "bea*",
  caseInsensitive: true
});
```

Expected: `beacon-one` and `beacon-two`, **not** `hidden-beacon`.

Write and then query:

```js
return await api.ais.invoke("foundry-tagger", "add-tags", {
  tokenId: "beacon-one",
  tags: ["adapted"]
});
```

```js
return await api.ais.invoke("foundry-tagger", "find", { tags: "adapted" });
```

Expected: only `beacon-one`. `set-tags`, `clear-tags`, and `apply-rules` are also bound to the
upstream methods. For example, set a token's tags to `["lamp-{#}"]`, then call `apply-rules` on it.
Number allocation is over this **non-hidden active-scene view**, not an assertion of world/global
uniqueness. No native Tagger query/rule engine substitutes for these upstream method calls.

Verify a cancellable local pre-update hook:

```js
return await api.ais.invoke("foundry-tagger", "veto-test", { tokenId: "beacon-one" });
```

Expected: `vetoed: true`, with no `must-not-commit` tag in the real world. The adapter runs local
pre-update handlers over a draft; the host accepts only the narrow tag proposal, checks its
snapshot sequence synchronously with commit, and persists it through normal validation/undo/ops.
A stale snapshot refuses rather than silently overwriting someone else's edit; retry explicitly.

## Exercise the existing FX engine, not another renderer

```js
return await api.ais.invoke("foundry-tagger", "fx-demo", { tokenId: "beacon-one" });
```

The binding uses a `Sequence`-style builder to draw **AIS connected**, then **Native FX**, with
an overlapping timeline. This is an **ArenaStar-authored API substitute**, not original Sequencer
code, and is deliberately distinguished from the real upstream Tagger module.

For an unobstructed view, assign the saved script to a **Hotbar slot**, close the Macros window,
and trigger the slot. The host schedules the program; the existing Pixi FX layer renders it.
No hidden saved FX macro or persistent FX document is created. Awaiting `.play()` means the
planned host-clock window elapsed, not that every remote device decoded media successfully.

The adapter additionally supports a small text/image/sound builder subset, source/target token
anchors, fades, simple transforms, exact-name owned-effect handles and ending those runs. Images
and sounds must resolve to locally imported asset hashes with normal native rights checks.

## Demonstrate portability and revocation

- Export the world using the normal **Export world** action. Both package file maps, prepared
  guest code, original source, exact profile locks and edited tags travel in the ZIP.
- Import as a copy in a clean browser/context. Tags persist, but local approvals do **not**.
  Review both packages again before any guest code executes.
- Revoke or disable the adapter. Its guest stops immediately; uncommitted work loses authority
  and the guest's active transient FX are cancelled. Already-committed tag writes remain in the
  world and can be undone normally.
- Approve only the guest: it reports **blocked**. Approve the adapter with `runtime.execute` and only `scene.tags.read`:
  queries work, but the guest cannot write merely because its own grant includes write permission.
- Changing adapter bytes invalidates the guest's composition-bound approval too. A stale source
  preview cannot approve a newly changed composition.

## Exactly what is implemented

| Surface | This demo |
| --- | --- |
| Packaging/runtime | Closed `runtimeProvider` / `runtime` extension, `arena.ais.runtime/1`, with prepared classic scripts and bounded JSON configuration |
| Main API compatibility | Existing `arena.ais/1` remains; this is **not** the full proposed AIS 2 API |
| World archive | Format **5** plus an explicit runtime feature marker; formats 1–4 remain supported |
| Data | GM-local, non-hidden placeables in the currently viewed scene, at most 256; only IDs, names, tags and limited position/grid fields |
| Authority | Separate exact-code approval of adapter and guest; effective capabilities are their **intersection**, not their union |
| Downgrade fence | Both runtime packages must declare/grant `runtime.execute`; older kernels reject the unknown capability even when reading an already-imported local world |
| Composition | Guest approval binds to both package hashes and the chosen profile; shared-island aggregation is not implemented |
| Mutations | Tag-only proposals with a global-sequence precondition, host validation, normal undo and committed receipts |
| Hooks | Actual local upstream `init`/`setup`/`ready` registration and local pre/post tag-update dispatch; no global native-action hook installation |
| FX | Reused native scheduler, per-recipient policy, renderer and cancellation; transient programs only, at most 16 active runs per module |
| Isolation | Existing script-only opaque iframe / document-bound port / network-denying CSP; no `allow-same-origin`, parent DOM or live renderer reference |
| Lifetime | Existing boot/command budgets; a guest command timeout stops its entire realm to prevent stale closures being reused |

Explicitly **not** delivered: arbitrary Foundry ZIP loading, binary package resources, general
ES-module/VFS resolution at runtime, Foundry applications/forms, keyboard dispatch, settings
emulation, actors/system logic, player delegation, other-scene queries, persistent foreign FX,
full Sequencer APIs/renderer, a global pre-create/prepare/commit workflow engine, or durable
suspension of arbitrary JavaScript. Existing native features remain available separately.

This is reviewed-code execution, not an infinite-loop or complete cross-browser sandbox guarantee.
Legal review remains a separate workstream; source notices/provenance are retained, and this demo
does not change legal approval statuses or bundle Foundry core.

## Verification and next slice

```sh
corepack pnpm test --maxWorkers=2
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test:fx:prepare
corepack pnpm size
corepack pnpm test:e2e:ais
```

The bounded AIS browser batch includes native AIS regression tests plus `e2e/ais_foundry.spec.ts`.
The latter imports the real world archive, approves both packages through UI, invokes the original
Tagger through a reviewed macro, checks host documents, instruments the **actual drawn FX layer**,
exports/imports in a fresh context, and checks revocation on file and HTTPS origins. It also checks
that an unapproved or read-only adapter cannot lend the guest extra authority.

Next: wire supported native document actions into a real AIS prepare/commit scheduler, then expand
profiles/contracts based on the next real module's needs. Do not treat this small successful slice
as completion of the broader [adapter proposal](FOUNDRY_AIS_ADAPTER_PROPOSAL.md).
