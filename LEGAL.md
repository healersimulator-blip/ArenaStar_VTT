# Legal posture, licences and attribution

This file is the **entry point** for “what licence is this, and what is in the content”. It
records facts and the process; it is not legal advice, and it does not adjudicate anything — every
third-party asset is its own case, decided case-by-case (see `tools/adopt/INVENTORY.md`, and
DECISIONS D-252/D-253).

## 1. The application itself

**No licence has been published for this repository yet.** Until one is chosen, the default
copyright position applies (all rights reserved) and there is no grant to copy, modify or
redistribute the application code. This is a recorded open decision — see
`GAP_CLOSURE_ImplementationPlan.md` §7 risk 1 and D-258 — not an oversight.

Community contributions cannot be accepted under clear terms until that decision is made.

## 2. The converted content (PF1e compendium)

The converter (`pnpm content:convert`, `tools/convert/`) reads **pinned checkouts of upstream
sources** and writes *data-only* packs. The pin, the sparse paths and the licence fact for each
source live in one machine-readable file, `tools/content/sources.json`, which is also what
`pnpm content:fetch` materialises and what the in-app credits panel displays.

| Source | Pinned commit | Licence (verified fact, input to the case) | What we take |
|---|---|---|---|
| `gabrieldosprazeres/foundryvtt-pathfinder1` (mirror of the FoundryPF1e pf1 system) | `681929d1` | GPLv3 (code) + OGL 1.0a (content) + Paizo Community-Use Policy | **Content only** — the per-entry YAML packs. No system code is transferred; rule logic that follows this system is transcribed clean-room against SRD/AoN (see `tools/adopt/README.md`). |
| `baileymh/pf1e-content` | `baf5232c` | OGL 1.0a (content) + GPLv3 (code) | **Content only** — the per-entry JSON packs. |

Consequences of that posture:

- **Data, not code.** The converter maps authored data into our own entry shapes; it does not
  translate or embed upstream program code, templates, or Foundry icon paths (`img` is dropped and
  counted in `REPORT.md`).
- **Notices travel with the data.** Every converted package ships, beside its packs:
  - `OGL.txt` — the Open Game License 1.0a text and the Section 15 copyright notice from the
    source checkout;
  - `CREDITS.md` — which upstream source and commit each pack came from.
  Both are inside the world zip, and the app’s Help window repeats the provenance for a reader who
  never opens the zip (canvas rail → **?** → *Licences & credits*).
- **Paizo material.** PF1e content that ships under the OGL (and the Paizo Community-Use Policy
  for names/marks it covers) is used with the notices above; nothing implying Paizo endorsement.
- **No-charge constraint.** The OGL does not permit charging for the Open Game Content itself.
  The single-file app and its content packs are free downloads; any future paid distribution is a
  decision that must re-examine this clause (plan §7 risk 5).
- **Third-party (“3PP”) material** is not shipped. If it ever is, it lands behind an explicit
  opt-in flag and its own inventory row and case.

## 3. Anything else that gets adopted

Code, art, audio or FX from another project is adopted only through the pipeline in
`tools/adopt/README.md`: an inventory row with the licence verified **at a commit hash**, a case
decided by Legal, an adoption card in `DECISIONS.md` citing source + behaviour spec + outcome, and
a conformance fixture that keeps the behaviour honest. Defaults while a case is pending: no
third-party code committed; clean-room re-implementation for GPL-derived logic; MIT code adopted
with attribution; **no** assets from projects without a licence.

## 4. Reporting a problem

If you hold rights to something in this repository and believe it is used incorrectly, open an
issue naming the file (or pack and entry id) and the right you believe is affected. Content packs
can be removed or re-pinned per entry; the converter keeps a per-pack report precisely so a
removal is a one-line pin change rather than a rebuild.
