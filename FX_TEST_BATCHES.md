# FX regression tests — bounded batches

Run **one browser batch at a time**, rather than the long combined suite. Each command uses one
Chromium worker, zero retries, and a **15-minute Playwright global timeout**. A global timeout
fails the command; it does not count unfinished tests as passing. Individual test/assertion
budgets are unchanged. Allow some additional time for browser teardown.

## Prepare once after source changes

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test:fx:prepare
```

Preparation builds the production single-file app and local system/starter-world fixtures.
These tests load `dist/index.html` through `file://`; they do not start a dev server.
Full optional vendor content is still subject to the repository's existing availability rules.

## Choose one batch

```sh
corepack pnpm test:fx:visual
```

```sh
corepack pnpm test:fx:automation
```

```sh
corepack pnpm test:fx:integrations
```

```sh
corepack pnpm test:fx:canvas
```

Do not join these into one long command in environments that freeze during long executions.
Each invocation starts a fresh Playwright browser process. Append `--list` to inspect a batch
without running it.

| Batch | Coverage | Measured D-323 time | Result |
| --- | --- | --- | --- |
| visual | FX sequences, image/audio Stop–Undo lifecycle | 7.2 min | 35 passed / 1 failed |
| automation | Active zones, appearance, movement, world-action Revert | 4.6 min | 25 passed |
| integrations | Item bindings, prefabs, reviewed scripts, summons | 3.2 min | 15 passed |
| canvas | Assets, canvas tools, join, vision, walls, fog | 6.8 min | 24 passed / 1 failed |

These measurements are not runtime guarantees. The global cap bounds test execution on slower
machines, while preserving failures for investigation. The four groups cover the earlier 99-case
regression selection plus the two image/audio lifecycle cases: **101 cases**, not the complete
A01–A41 or cross-browser acceptance matrix.

## Other checks (separate commands)

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm size
```

The full unit run measured about two minutes for D-323.

## Browser availability

Use the installed Playwright Chromium normally. The sandbox fallback was npm
`@sparticuz/chromium@153.0.0`, extracted outside the repository. For that environment only:

```sh
LD_LIBRARY_PATH=/tmp/al2023/lib \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/chromium \
PLAYWRIGHT_CHROMIUM_NO_SANDBOX=1 \
corepack pnpm test:fx:visual
```

The temporary executable/library paths must exist; they are not repository artifacts. The override
is not needed on a normal Playwright installation.

## Open failures at D-323

- Visual: the unsupported-codec report included a late GM viewer as well as the unsupported player;
  the fixture expected only the unsupported player in the corrected report.
- Canvas: the fog save/reload test hit its existing 30-second overall budget at the final disable-fog
  control. Earlier persistence assertions had completed.

No timeout/assertion was relaxed to hide these. Full parity is still incomplete.
