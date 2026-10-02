# A41 reference-performance harness

This harness is deliberately separate from the ordinary browser smoke suite. It drives the built production app (`file://`), writes fixture documents through the real GM `ClientSync`/host path, renders image-backed tiles and FX on the production Pixi stage, and measures visible `requestAnimationFrame` intervals, host click-to-trace dispatch, and stabilized V8 heap. It does not substitute the PF1e army benchmark or infer acceptance from sandbox timing.

## Exact executable workload

- 800 tokens plus 200 visible image-backed tiles, each carrying the same `a41-load` Tagger tag: exactly 1,000 tagged placeables.
- The 200 tiles load a cached, opaque, deterministic 64×64 PNG so they are real rendered tiles rather than image-less trigger documents.
- Seven persistent image sequences render `15 + 15 + 15 + 15 + 15 + 15 + 10 = 100` simultaneous visuals. Each of the 50 measured cycles starts all seven through the GM client API, verifies all 100 Pixi visuals are present, keeps them visible for multiple frames, then stops them through the scene/macro stop API and waits for visual cleanup. One extra uncounted cycle primes texture/decode paths before the heap baseline.
- A click graph selects the shared tag across tokens and tiles and checks for exactly 1,000 targets. It is invoked 100 times via real visible-tile click intents; each latency sample ends when the GM-only host automation trace arrives. One warm-up click is excluded from the 100 samples.
- A 600-step acyclic run-scope graph plus terminal stop runs once for warm-up and once in the measured window. The private host trace must show that it completed.
- The frame recorder runs during all 50 measured FX cycles, all 100 trigger runs, and the measured long-graph invocation. Heap comparison uses three post-GC warmed-baseline samples and three stabilized post-run samples, with the worst stabilized sample compared to the median baseline.

## Reference profile publication is mandatory for qualification

No reference GPU/device identity is fabricated in this repository. `reference-profile.template.json` is explicitly non-qualifying. Before a qualifying run:

1. Run the built app once on the exact reference machine/browser and record the actual Chromium version, user agent, platform, viewport/device scale, renderer backend, unmasked GPU vendor/renderer, hardware concurrency and device-memory readback. The harness report emits these values in diagnostic mode.
2. Fill a new profile file from the template with the device ID, exact CPU model, system RAM, logical CPU threads, browser/GPU identity, deterministic media SHA-256/byte count and the fixed workload/budget fields. Validate it against `reference-profile.schema.json`.
3. Commit and publish that profile **before** collecting a performance result. Do not edit it after publication. A qualifying run rejects an untracked/dirty profile, verifies its publication commit and timestamp predate measurement, and requires the runner identity environment to match it.
4. Use a non-software GPU backend. SwiftShader, llvmpipe, lavapipe and other software renderers fail qualification. The test checks the live browser/GPU identity before seeding the large workload and stops at the first mismatch.

Required host identity environment values must match the profile exactly:

```sh
A41_DEVICE_ID='the published device ID' \
A41_CPU_MODEL='the exact CPU model in the profile' \
A41_RAM_GIB='the profile systemMemoryGiB value' \
A41_CPU_THREADS='the profile logicalCpuThreads value' \
A41_REFERENCE_PROFILE='performance/a41/reference-profile.json' \
corepack pnpm test:a41
```

The JSON result is attached to the Playwright test and written under its `test-results` output directory. It reports the profile commit, runtime preflight, media bytes/MIME/codec/frame count, exact FX/trigger workload, p50/p95/p99 visible frame intervals, the adaptive-quality state, p95 click-to-trace dispatch, and warmed/stabilized JS heap. The heap field is Chromium V8 `usedSize` after explicit garbage collection and is explicitly **not** GPU-driver memory.

For a non-qualifying measurement in the sandbox or on an unknown device, run:

```sh
A41_DIAGNOSTIC=1 corepack pnpm test:a41
```

Diagnostic mode still exercises the exact app workload and emits the same report, but deliberately does not assert the three device performance budgets and cannot establish A41. Without either opt-in variable the test is skipped by the default E2E suite.
