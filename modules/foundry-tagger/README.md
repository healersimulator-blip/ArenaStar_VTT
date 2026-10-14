# Original Tagger 1.5.4 — AIS feasibility guest

The three executable files in `upstream/scripts/` are preserved byte-for-byte from:

- Repository: https://github.com/fantasycalendar/FoundryVTT-Tagger
- Tag: `1.5.4`
- Commit: `e7936bc9ee01e4445624fbc82a11e887e5cd0075`
- Notice: `upstream/LICENSE` (MIT, Fantasy Computerworks).

`PROVENANCE.json` records SHA-256 file digests. The preparation script verifies these before
bundling. `upstream/module.json` is the source-tree manifest, including its original build-time
version placeholder. The executable source is rebundled locally; this is NOT represented as an
untouched published release ZIP. Unused upstream documentation images are not bundled.

`automation/commands.js` is ArenaStar-authored binding code. It calls the original `Tagger` methods;
our native Tagger-style query implementation does not answer these searches or expand their rules.
The guest requires separately enabled/approved `ais-foundry-v13`. Both are ordinary world ZIP
contents; approvals never travel in a world export.

Declared commands:

- `info`, `find`, `set-tags`, `add-tags`, `clear-tags`, `apply-rules`.
- `veto-test`: demonstrate that a local pre-update veto makes no host write.
- `fx-demo`: exercise the adapter's native-backed Sequence API substitute. Upstream Tagger does
  not itself depend on Sequencer; this additional demonstration is explicitly our binding code.

Scope: non-hidden placeables in the currently viewed scene, local GM invocation, tag-only writes.
No Foundry forms/hotkeys, world actors, other scenes, native pre-create integration or player
execution. Numbered rules apply to this authorized view, not to hidden/global tag namespaces.

Build/run instructions are in the repository's `AIS_FOUNDRY_FEASIBILITY.md`.
