# Authoritative Action System

Status: implemented vertical slice (schema, host lifecycle, chat renderer, PF1e cast producer, pending-save/concentration linkage, and FX projection).

## 1. Goal and authority boundary

An action is a durable fact record attached to one chat message at `message.system.action`. It joins rules resolution, chat, later player-owned rolls, scene references, targets, and presentation without turning an animation into a rules engine.

The boundary is strict:

- **Rules/mechanics** commit ordinary host-authorized Ops (HP, resources, effects, inventory, movement, permissions).
- **The action card** records the result in the same envelope as those Ops. It is not an authorization token and cannot execute a continuation.
- **Provenance** distinguishes host-owned pending/resolution/expiry facts and adapter-verified immediate mechanics from terminal results merely reported on creation. The host overwrites caller-supplied provenance.
- **FX** may observe the bounded `ActionFxContext` emitted after a card revision commits. Unverified targets retain spatial identity only; their outcome/check/damage/healing/condition fields are omitted, so client-invented mechanics cannot drive conditional FX. FX cannot write documents.
- A client-authored card never causes HP, conditions, inventory, movement, or permissions to change. Generic client updates to an existing card or its linked pending rolls are rejected.

This keeps “what happened” separate from “how it looks.”

## 2. Storage and identity

`src/core/action.ts` defines the version-1 contract.

- The containing message is the durable unit.
- On creation the host forces `action.id === message._id`, `revision = 0`, and host timestamps.
- Every independently resolvable target has a stable `target.key`. Its `name` is host-canonical; an optional bounded `label` describes a stage such as “Reflex save” or “spell effect” without masquerading as identity.
- Every player-owned pending check has a unique stable `pendingRoll.id`; the target check points to it with `pendingRollId`, and the pending roll points back with a unique `actionId` and `targetKey` pairing.
- `{ actionId, revision }` is the FX/idempotency key.
- The action and pending-roll parsers use closed vocabularies and exact keys, cap targets/modifiers/notes/conditions, bound text/IDs/areas, and reject contradictory target/check/action states.

An action records:

- kind and label;
- source actor/token/item;
- scene and optional area/template/region reference;
- all target actor/token identities;
- per-target lifecycle (`pending`, `resolved`, `skipped`, `expired`) and host-owned provenance (`host` or `reported`);
- closed outcomes (`saved`, `failedSave`, `hit`, `miss`, `resisted`, and so on);
- check formula/DC/total/save type/automatic result;
- committed damage, healing, conditions, and bounded notes;
- host creation/update times and revision.

## 3. State model

Target rows transition independently:

```text
pending --host roll--> resolved
pending --window closes--> expired
unaffected flow branch --> skipped
```

Aggregate action state is derived:

- any pending row: `pending`;
- all expired: `expired`;
- resolved/skipped plus expired: `partial`;
- otherwise: `resolved`;
- `failed` and `cancelled` are explicit terminal flow outcomes.

Expiry is never converted to a failed save. Pending-roll pruning updates both the roll storage and linked action target in one host envelope.

## 4. Host lifecycle

### Create

For a structured message the host:

1. strictly parses the whole action;
2. validates source/target/scene/token/item/area references and token↔actor agreement against host state, enforces player visibility without turning guessed IDs into canonical names, infers the root scene from an area when omitted, and rejects cross-scene area claims;
3. requires a non-GM author to own the source actor;
4. replaces submitted source/target names with the referenced host document names while preserving separate stage labels;
5. verifies every strictly parsed pending roll’s bidirectional action/target/check identity;
6. host-normalizes identity, revision, timestamps, and target provenance; a known evidence adapter must rederive a terminal result before provenance becomes `host`;
7. authorizes and commits the card together with the mechanical Ops.

Malformed or inconsistent data rejects the whole intent; ordinary chat remains backward compatible.

### Resolve

`roll.pending` optionally carries `pendingId`. Omitting it remains compatible only when a message has exactly one selectable pending roll.

The host rechecks authentication, rate limits, world pending mode, the host-normalized two-round window, roller ownership, formula bounds, and commit/reveal data. Because cryptography yields, it then re-reads the selected pending row, expiry, ownership, and latest action revision before committing; concurrent target resolutions rebase instead of overwriting each other. It commits one envelope containing:

- the selected pending roll result;
- exactly its linked action-target transition and revision increment;
- one dice-log message whose roll-evidence identity is the selected pending ID (the containing message ID remains the legacy fallback);
- the existing human-readable follow-up message.

The client never supplies success/failure. The host derives it from the host-evaluated total and DC. A host die roll does not, by itself, prove a client-authored modifier or DC: only a pending row whose inputs passed a recognized evidence adapter retains `provenance: "host"`; an unverified row remains `"reported"` after resolution and cannot drive FX mechanics.

On card creation, the host validates every persisted pending object (including the multi-roll count), requires every one to link bijectively to a pending ActionCard check, canonicalizes actor/target names, and overwrites `turnNumber`/`expiresTurn` with the host's current turn and fixed two-round deadline.

### PF1e mechanical evidence

For deferred normal actor-cast saves, bounded `pf1e.pendingSave.v1` evidence lets the host rederive the save DC and formula from the source and target actors before marking that pending check trusted. Touch, consumable, concentration, and other unsupported pending paths remain reported; rolling them does not upgrade their mechanical authority.

Ordinary dice messages minted by the host now carry immutable `system.rollEvidence`; client creation or mutation of that marker/roll is rejected. A successful immediate verification writes the action ID into that marker in the same envelope, while a roll produced by a linked pending transition is minted already claimed by that action/card. The one-use claim therefore survives later action-card lifecycle pruning. An immediate terminal target may carry bounded, data-only evidence naming `pf1e.spellTarget.v1`. For supported actor-cast spell results the host:

1. resolves each evidence ID to exactly one host-minted roll by the action author and refuses duplicate IDs, a roll already claimed by a verified action, reuse anywhere else in the same request envelope, or a fresh roll that reuses an already-claimed textual ID;
2. rederives caster/defender values, SR, save, evasion, energy resistance, prevented damage, outcome, and HP delta from current host documents;
3. requires the final staged target HP to equal the derived result and, for a fresh successful SR check, requires the matching combat-ledger write in the same intent;
4. rejects conflicting same-envelope mutations of the actor inputs used by the derivation;
5. upgrades the row to `provenance: "host"` only if every fact agrees.

The immediate adapter is deliberately limited to one normal, actor-sourced, noncritical, non-touch target with bounded `NdM` damage. Unknown adapters, replayed rolls, consumable-specific DCs, unsupported paths, mismatched state, or missing Ops do not fail ordinary narration; they remain visibly `reported`, and their lifecycle and mechanics are stripped from FX projection. This is fail-closed presentation authority, not a way for evidence to authorize world writes.

### Post-commit FX hook

`HostEvents["action:committed"]` emits `ActionFxContext` exactly once for a new or changed revision; an ordinary edit to the containing message does not re-emit it. The context contains only bounded, explicitly projected data and omits pending-roll identity/seeds, formulas, notes, evidence payloads, and executable state. A target has `verified: true` only for a non-mechanical host-normalized pending stage, a trusted pending row's host-owned resolution/expiry, or an immediate result whose mechanical inputs passed a recognized evidence adapter. Resolving or expiring a reported check does not upgrade its authority. For `verified: false`, even target lifecycle state is omitted alongside outcome/check/damage/healing/conditions. Root `state` is present only when every target is verified.

Consumers must deduplicate by `{actionId, revision}`, branch on lifecycle or mechanics only when the corresponding `verified === true`, and treat the event as presentation input only.

## 5. Chat UI

`src/ui/chat/ActionCard.svelte` is selected before legacy pending/roll cards when `system.action` validates.

It renders:

- source, action label, state, revision, and scene;
- optional area link;
- every target, canonical identity, stage label, independent outcome, and a visible warning for client-reported terminal results;
- DC/formula/total/pass-fail facts;
- damage, healing, and conditions;
- one Roll button per linked pending ID, gated by owner/GM and expiry;
- initiator, target, and area highlight links.

Legacy `system.pendingRoll` cards and message-only `roll.pending` calls still work.

## 6. PF1e cast integration

`resolveCastFlow` is the first production producer.

- Immediate resolved casts submit one action message plus resource/HP/SR Ops in **one atomic intent** and attach bounded host-roll references. The `pf1e.spellTarget.v1` adapter rederives supported normal actor-cast outcomes; unsupported variants remain visibly `reported`. Atomic authorization alone is never claimed as rules proof.
- Failed casting gates, multi-round casting, and touch misses now create structured action states and batch their resource/held-charge Ops with the card.
- Manual player saves create one canonical pending action, not a cosmetic narrative card plus a disconnected pending card.
- Multiple concentration declarations create one multi-target card with `system.pendingRolls` and stable selectors.
- Scene and token IDs are taken from explicit invocation context or inferred only from scenes visible to the caller.

### Deliberately explicit deferred mechanics

There is not yet a host-verifiable generic spell-effect continuation. Therefore a deferred save/concentration action includes a separate pending “spell effect” row. Resolving the save updates the host-owned check outcome, but the action remains visibly pending; it does **not** infer damage or conditions from client-authored JSON.

A future continuation must reference host roll records and rederive PF1e target defenses/resistances on the host before it may apply HP/effects and resolve that final row. Until that executor exists, the honest pending state is required behavior, not a cosmetic limitation.

## 7. Implementation map

- `src/core/action.ts` — schema, parser, state derivation, transitions, FX projection.
- `src/host/sync.ts` — create normalization/reference checks, protected updates, pending resolution, post-commit hook.
- `src/packages/pf1e/pendingRoll.ts` — single/multi storage, selected replacement, linked expiry.
- `src/ui/combat/pf1ePendingRollFlow.ts` — canonical linked pending-card builder.
- `src/ui/chat/ActionCard.svelte` and `ChatPanel.svelte` — renderer and dispatch.
- `src/ui/chat/rollHighlight.ts` — generic action location projection.
- `src/ui/sheets/pf1eCastFlow.ts` — atomic PF1e cast producer.

## 8. Verification plan

The implementation is covered at four levels:

1. **Schema/state unit tests:** strict validation, independent targets, expiry, and bounded FX projection.
2. **Pending-roll unit tests:** compatibility plus linked atomic expiry.
3. **Host integration tests:** canonical names, selected multi-target and GM-override resolution, atomic transition, immutable/replay-safe immediate PF1e evidence re-derivation, revision event deduplication, explicit expiry event/timestamp, provenance normalization, linked pending mutation/removal rejection, malformed/link/source rejection, and ordinary-chat compatibility.
4. **PF1e flow tests:** immediate card + mechanics atomicity, spatial identity, stage labels, and linked deferred save construction.
5. **Chromium E2E:** multi-target rendering, per-target buttons, explicit pending effect stage, area highlighting, and GM override through the real chat/host path.

Before release, run typecheck, ESLint, focused tests, the full Vitest suite, build/size gates, and the relevant Chromium specs.

Verified on 2026-10-04: TypeScript/Svelte check (0 blocking issues, one pre-existing advisory), ESLint, and `git diff --check` passed; focused action/PF1e tests passed; full Vitest passed **335 files / 4,960 tests** with 12 expected skips; the production artifact is **4,236,579 raw / 1,209,244 gzip bytes** (SHA-256 `3300da8724f0fb6b2a34b95301c03b401a008c8a1032408ca68a5eeb42535563`), within the 6 MB budget; and the pending-roll Chromium suite passed **3/3**.

## 9. Next extensions

1. Extend host evidence adapters to currently unsupported PF1e variants (consumable-specific DCs and fully evidenced critical/touch chains).
2. Implement a host-owned PF1e deferred-effect continuation and resolve the explicit effect row.
3. Convert attack, item-use, check, and automation result producers to the same atomic contract.
4. Add GM-authored FX bindings that consume only verified `ActionFxContext` mechanics with `{actionId, revision}` deduplication.
5. Add per-viewer field sanitization if future cards may contain identities that are not already public through their containing message.
6. Add migration/version adapters when a version-2 schema is needed; never loosen version 1 in place.
