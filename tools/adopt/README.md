# Transfer pipeline (P-1…P-6)

The process for transferring scripts, data, and FX from Foundry (and other sources) into
ArenaStar. Design: `GAP_CLOSURE_ImplementationPlan.md` §5.5. **Legal status of every
asset is a case-by-case decision by Legal** — this pipeline records the verified facts
and carries a status per item; it does not pre-adjudicate anything.

## Flow

```
P-1 inventory row          P-2 adoption card (DECISIONS.md)         P-4 corpora (V-gate)
tools/adopt/INVENTORY.md  →  source citation + behavior spec  →     C1 content-behavior
                              + legal review record (P-3)      →     C2 rule-logic
                                          ↓                              C3 FX playback
                              P-5 fx.json provenance (FX)           C4 module-API conformance
```

1. **P-1 — Inventory** (`INVENTORY.md`): one row per candidate. Columns: license
   **verified at a commit hash** · `legalStatus` · target area · our consumer (phase) ·
   transfer approach. Nothing is transferred without an inventory row.
2. **P-2 — Adoption card**: per item, in `DECISIONS.md` — source citation (repo + commit
   + file/line, or AoN rule ID), behavior spec, **legal review record** (case reference,
   outcome, sign-off), implementation pointer, corpus reference (P-4).
3. **P-3 — Legal review (owner: Legal)**: each asset is its own case, including negotiated
   deals that override any default posture. The one process rule (project policy, not a
   legal verdict): **nothing ships without its case closed** — `legalStatus` set and
   sign-off recorded on the card. Engineering default posture while a case is pending:
   no third-party code committed without a sign-off record; clean-room preferred for
   GPL-derived logic; OGL data packaged with OGL notice + CREDITS.
4. **P-4 — Conformance corpora** (adoption is a *process* because it is regression-tested):
   - **C1 content-behavior** — golden converted items that must derive the same stats
     (seeded from the content pipeline; ~50 items at steady state).
   - **C2 rule-logic** — golden combat/rule sequences (fixtures from primary sources).
   - **C3 FX playback** — per-asset expected frames/duration/palette for `fx.json` packs.
   - **C4 module-API conformance** — adopted behaviors expressed against the §12 module
     API surface (methods + hooks), so a surface change cannot silently break them.
   All four are members of the V-gate (verified-evidence requirement in DECISIONS).
5. **P-5 — `fx.json` v1** (FX packs): versioned manifest; `assets[] {file, license,
   author}`; `entries[] {id, trigger {kind, school}, asset, kind, frames, durationMs,
   palette, scale}`. The loader validates manifest version + per-asset license + trigger
   fields against `fxTables.ts` before playback.
6. **P-6 — scriptCalls mapping**: Foundry module calls (the `scriptCalls[]` Foundry
   items carry) are classified — map to our §12 surface / emulate / drop — with a
   coverage report per conversion. Surface extensions beyond the current 8 RPC methods +
   4 hooks are §16 decisions.

## `legalStatus` values

`pending` → `approved` | `negotiated` | `rejected` — set by Legal, recorded on the
adoption card with the case reference.
