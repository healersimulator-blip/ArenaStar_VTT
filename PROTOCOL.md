# PROTOCOL — message reference (§13)

Single source of truth for kinds/bytes: `src/core/messages.ts` (`MsgKind`).
A unit test cross-checks this file against that map — **keep both in sync**.

## Framing (§6.1)

```
frame := [u8 MsgKind][msgpack payload]
```

- Encoding: MessagePack (`@msgpack/msgpack`) with the 1-byte type prefix.
- Channels (§6.1), four per peer:

| channel     | reliability                   | carries                                                        |
| ----------- | ----------------------------- | -------------------------------------------------------------- |
| `ops`       | reliable + ordered            | hello/welcome/snapshot/ops/rejected/roll/chat/control/kick/ban |
| `ephemeral` | unreliable, maxRetransmits: 0 | ephemeral (cursors, pings, drags, ruler, typing) ≤ 20 Hz       |
| `assets`    | reliable + ordered            | asset.get / asset.chunk (16–64 KB chunks, backpressure)        |
| `sim`       | reliable + ordered            | sim.delta / sim.snapshot / turn.report (backpressure-aware)    |

- Ephemeral traffic never touches the Document Store or OpLog (§5).
- Binary fields (`Uint8Array`) ride inside the msgpack payload (bin type).
- sim.delta / sim.snapshot `bytes` = fflate-compressed, msgpack-framed
  SimDelta/SimSnapshot per §5A (RLE changed-index runs, quantized values).

## Messages

### hello (0x01 · client → host · ops)

Ed25519/ECDSA pubkey identity; `sig = Sign("vtt:hello:<roomId>:<displayName>:<ts>")` (§6.4, D-007).

```ts
interface HelloMsg {
  kind: "hello";
  pubkey: string;
  displayName: string;
  ts: number;
  sig: string;
  lastSeq?: number; // reconnect: GM/assistant may use ops-since; player gets a projected snapshot
}
```

### intent (0x02 · client → host · ops)

Transaction proposal; host validates (permissions, JSON-schema, invariants), applies with seq++, appends to OpLog, projects, broadcasts `ops` or `rejected` (§5).

```ts
interface IntentMsg {
  kind: "intent";
  txId: TxId;
  ops: Op[];
}
```

### roll (0x03 · client → host · ops)

Rolls execute on the host (§11).

```ts
type RollMode = "roll" | "gmroll" | "blindroll" | "selfroll";
interface RollMsg {
  kind: "roll";
  rollId: string;
  formula: string;
  rollData?: Record<string, Json>;
  mode: RollMode;
  to?: UserId[];
  flavor?: string; // optional breakdown line rendered on the roll card (A06)
}
```

### roll.reveal (0x0d · client → host · ops)

§11 commit-reveal step 3: the client opens its commitment (seed_c) for a
pending committed roll; the host verifies SHA-256(seed_c) against the
recorded commitment before resolving the roll deterministically from both
seeds.

```ts
interface RollRevealMsg {
  kind: "roll.reveal";
  rollId: string;
  seedClient: string;
}
```

### roll.challenge (0x2d · host → client · ops)

§11 commit-reveal step 2: the host's seed (seed_h), chosen and sent BEFORE
the client reveals its own — a malicious host cannot grind the outcome.
Sent only to the session that issued the committed roll.

```ts
interface RollChallengeMsg {
  kind: "roll.challenge";
  rollId: string;
  seedHost: string;
}
```

A dice-log message produced by either host roll path carries
`system.rollEvidence = { v: 1, rollId }`. Clients cannot create that marker or mutate/delete the
marker, roll payload, or roll-id flag. A successful immediate-action verification atomically evolves
it to `{ v: 1, rollId, claimedBy: actionId }`; a roll minted as part of a linked pending-card
transition is born with that same claim. The claimed textual ID remains reserved even if a fresh
host roll later reuses it. This durable fact is consumed only by registered action evidence
adapters; it grants no document-write authority and cannot be claimed a second time.

### roll.pending (0x33 · client → host · ops)

F03 — host-verified resolution of a pending player reaction roll. The
table already shows the *shell* (who → what → target → DC + modifiers,
no total); the owning player presses **Roll** on that chat card and the
client sends `roll.pending` with the `messageId` of the pending card, an
optional stable `pendingId` selector, and the `seedClient` commitment
(commit-reveal, same crypto as `roll`/
`rollVerified`). The host validates the 2-round window + ownership +
`shouldDeferToPlayer` predicate (auto/savesChecksAuto/manual + strategic
gate), reveals with `seedHost`, then re-reads the live selected row, expiry, ownership, and action
revision after async cryptography. It evaluates `d20+mods` vs `DC`/`AC` through
the same pure functions auto-rolls use, and submits one envelope
`[selected pendingRoll resolved + linked action target/revision + dice log + follow-up message]`
atomically — so a rejected follow-up rolls the whole reaction back. The dice-log evidence ID is the
selected pending ID (with the containing message ID retained only for legacy single-roll cards). When
`pendingId` is omitted, compatibility selection succeeds only if the message has exactly one
pending roll. GM Resolve uses the same host path.

```ts
interface RollPendingMsg {
  kind: "roll.pending";
  messageId: DocId;
  pendingId?: string;
  seedClient: string;
  seedClientCommit?: string;
}
```

### roll.reroll (0x30 · client → host · ops)

F01 — host-evaluated reroll of a tactical ledger card (or its delegated player reroll). The client sends the `messageId` of the card whose `system.rollLedger` owns the original rolls + ledgerOps; the host validates the 1–2 round window (`currentTurn - ledger.turnNumber ≤ 2`) + `can(update)` on every touched doc (GM bypasses), re-rolls each stored formula with fresh host RNG (same description, `evaluateFormula` under the host seed), optionally folds `newModifiers` from the card dropdown into the first roll, and commits one atomic envelope `[inverse(old) + ledgerOps(new) + ledger rolls/newTotals + rerollCount++]`. Expired/pruned or already-reverted cards are rejected (`invalid_schema`). Delegated player rerolls ride the same kind — host checks `pendingReroll.playerId === user.id && currentTurn ≤ expiresTurn`.

```ts
interface RollRerollMsg {
  kind: "roll.reroll";
  messageId: DocId;
  newModifiers?: Array<{ label: string; value: number; reason: string }>;
}
```

### roll.revert (0x31 · client → host · ops)

F01 — GM revert of a ledger card. The host validates the same 2-round window and `can(update)` (GM only; players via delegate must use reroll), then commits `[inverse(ledgerOps) + mark reverted]` — reviving dead models at pre-card HP/status as the inverse restores the exact pre-images the OpLog kept. Already-reverted or expired cards are rejected. Strategic mass-battle never creates a ledger, so this path is tactical-only.

```ts
interface RollRevertMsg {
  kind: "roll.revert";
  messageId: DocId;
}
```

### action.revert (0x4c · GM → host · ops)

GM-only Revert of a named, host-authored world-action receipt. The host re-reads its durable private receipt, refuses an in-flight or already reverted run, checks every affected document's committed post-image, and commits the recorded inverses plus the reverted marker atomically. Later edits to any affected document cause a **stale** refusal rather than being overwritten. Receipts survive checkpoint, reconnect and world-file export independently of the capped chat and compacted OpLog. Asynchronous graph scripts/summons append their own successful commits to the same receipt; on failure the partial committed history remains reversible. Already-pruned messages obey the separate bounded chat retention policy: a missing message created by this action needs no inverse delete and cannot block otherwise-safe mechanical Revert. Revert refuses if restoring a previously deleted message would evict newer chat. Visual FX already played cannot be unplayed. Automatic lifecycle events and external side effects are not covered.

```ts
interface ActionRevertMsg {
  kind: "action.revert";
  receiptId: DocId;
}
```

### roll.delegate (0x32 · client → host · ops)

F01 — GM delegates a reroll window to a player. Validates window + GM-only, then commits `[ledger.pendingReroll = {playerId, expiresTurn: currentTurn+2}]`. The delegated card shows **Player Reroll** only to that player, host-evaluated via `roll.reroll` + `canPlayerReroll`. Same window expiry as the card; pruning clears the ledger shell after T+2 regardless.

```ts
interface RollDelegateMsg {
  kind: "roll.delegate";
  messageId: DocId;
  playerId: UserId;
}
```

### roll.apply (0x34 · client → host · ops)

§2.2/G-20 — apply an already-rolled chat card to a token's actor. The player presses **Damage**/**Healing** on a roll card targeting a token they may `update`; the message carries *what* to do, never *how much* — no amount crosses the wire, so a client cannot inflate a hit. The host re-reads `message.roll.total` from its own replica, checks `can(user, "update", actor, "actors")`, refuses a replay via `flags.pf1e.applied[actorId]` (per actor *and* mode), and commits one atomic envelope: the actor diff (temp HP first, then HP floored at 0 for damage; capped at max and stripping an equal amount of nonlethal for healing), the whole `flags` subtree, and a `ledgerFollowUp` note so the change is undoable as one step. The card's row then shows the applied amount to everyone; a card with no roll total or a sealed (player-unreachable) actor is refused.

```ts
interface RollApplyMsg {
  kind: "roll.apply";
  messageId: DocId;
  actorId: DocId;
  mode: "damage" | "healing";
}
```

### automation.request (0x38 · client → host · ops)

**GM/assistant-only** author/debug request: invoke a saved active-zone graph by ID and scene. The request contains **no actions or selectors**. A player cannot use this ID-bearing endpoint, even for a published `click` graph—doing so would bypass hit geometry and disclose private graph IDs. Players use `automation.click` below. The host rechecks the graph, tile, scene, source token and replay guard, then plans/commits mechanical steps. Failed or denied requests cannot emit FX. Movement methods are derived from **committed** token operations on the host, not from this request.

```ts
interface AutomationRequestMsg {
  kind: "automation.request";
  requestId: string;
  automationId: DocId;
  sceneId: DocId;
  method: AutomationMethod;
  tokenId?: DocId;
  dryRun?: boolean; // GM/assistant only, no ops or cue fan-out
}
```

### automation.click (0x3c · client → host · ops)

Canvas interactions name a **visible tile**, the world-space hit point and an optional selected token, **not** a secret graph ID or action list. The host rechecks active scene, tile visibility/ownership, rotated hit geometry, optional token ownership and replay ID before finding published `click` graphs on the tile. Hidden/absent tiles are indistinguishably denied; visible tiles without a published graph do nothing. Graph definitions, counts and traces never return to the player. This supplements the explicit GM `automation.request`/dry-run path and committed movement observation.

```ts
interface AutomationClickMsg {
  kind: "automation.click";
  requestId: string;
  sceneId: DocId;
  tileId: DocId;
  point: { x: number; y: number };
  tokenId?: DocId;
}
```

### tagger.rules (0x4a · GM/assistant → host · ops)

Expand `{#}` and `{id}` templates **already stored** on 1–32 exact scene-qualified refs (including scene documents). This is a host request, not client-generated tag values or a bulk `intent`: the host re-reads every document, validates the GM caller and target scenes, allocates scene-unique ordinals across **all** live placeables (including hidden ones), preflights the entire batch and commits one undoable envelope. Duplicate refs and malformed requests fail without a partial edit. The bounded recent request-ID cache makes repeated sends in the same host lifetime idempotent; it does not promise durable deduplication after a full host restart.

```ts
interface TaggerRulesMsg {
  kind: "tagger.rules";
  requestId: string;
  refs: DocRef[];
}
```

### tagger.rules.result (0x4b · host → requesting GM/assistant · ops)

Success returns the number of changed documents and committed sequence (or the current sequence for a no-op). A denied or invalid request receives `rejected` with the same request ID. Player sessions neither invoke this endpoint nor receive this result. Reviewed-script `api.tags.applyTagRules(refs)` remains a separate, grant-checked path; a player caller cannot allocate `{#}` through GM elevation, since visible ordinal gaps could reveal hidden tags.

```ts
interface TaggerRulesResultMsg {
  kind: "tagger.rules.result";
  requestId: string;
  changed: number;
  seq: number;
}
```

### prefab.place (0x3d · GM/assistant → host · ops)

Place a **saved GM-only prefab** by ID and destination scene anchor/rotation/scale. No placeables, tags, graph source or arbitrary ops are accepted from the placement request. The host validates its saved template, allocates new scene-local IDs and `{#}`/`{id}` tags, remaps internal graph references, validates media/script dependencies and bounds, then commits all cloned placeables and graphs **in one undoable envelope**. A player cannot invoke this endpoint or see the template. A failed/replayed placement makes no world write.

```ts
interface PrefabPlaceMsg {
  kind: "prefab.place";
  requestId: string;
  prefabId: DocId;
  sceneId: DocId;
  at: { x: number; y: number };
  rotation?: number;
  scale?: number;
}
```

### prefab.result (0x3e · host → GM/assistant · ops)

Host result for that placement, including a GM-only instance/root ID after success. Players see only their per-recipient projected cloned scene objects; hidden children, graph bodies and prefab definitions are not replicated.

```ts
interface PrefabResultMsg {
  kind: "prefab.result";
  requestId: string;
  ok: boolean;
  detail: string;
  seq?: number;
  instanceId?: string;
  rootId?: DocId;
}
```

### summon.place (0x46 · client → host · ops)

A GM-reviewed summon macro stores the world actor ID or stable package/pack/entry reference, scene, player publication, grid footprint, maximum placement distance and optional duration. The player transmits **only** a preset ID, scene, point and an owned summoner token ID. The host resolves and snapshots the source without importing/editing it, validates the caller, bounds and range, and atomically creates a fresh actor and scene token. A caller can dismiss their own summon; a GM/assistant can dismiss any. Host expiry and deletion of the token, instance actor or scene clean up the counterpart. Responses contain a public token ID or a generic rejection, never private source data. Summon markers and private preset fields are removed in snapshot and op projections.

```ts
interface SummonPlaceMsg {
  kind: "summon.place"; requestId: string; presetId: DocId; sceneId: DocId;
  at: { x: number; y: number }; summonerTokenId?: DocId;
}
```

### summon.dismiss (0x47 · client → host · ops)

Dismiss a linked summon by scene + token ID. The host verifies caller/owner and
atomically deletes the instance actor, token and any bound FX. Guessing another
player's token does not disclose whether it exists.

```ts
interface SummonDismissMsg { kind: "summon.dismiss"; requestId: string; sceneId: DocId; tokenId: DocId }
```

### summon.result (0x48 · host → caller · ops)

Caller-only status; never carries the private source, actor stats or marker.

```ts
interface SummonResultMsg { kind: "summon.result"; requestId: string; ok: boolean;
  detail: string; seq?: number; tokenId?: DocId }
```

### automation.trace (0x39 · host → GM/assistant · ops)

Private bounded step/gate/result trace of a host evaluation, including dry-run; **never** broadcast to players. Trigger history and definitions are GM-only documents, even if their ownership field is mistakenly made public. Graph Tagger selectors share the public tag API's multi-term, exact/wildcard/safe-regex and case/collection semantics, evaluated against live host state. Show/hide actions target typed tokens, tiles or map pins and use per-recipient grant/revoke projection; a hidden placeable's referenced media manifest entry is also revoked. A concealed graph tile cannot be invoked by guessed ID. A typed door action changes only an existing conditional-axis door's state (locked doors require an explicit unlock), without letting a tag selector open a plain wall. A saved graph may queue a GM-reviewed script by ID with typed literal or event-bound inputs; player-triggered graphs require that script to be separately published and readable to the caller. Host preflights the script before consuming graph history; **only after graph commit** does the host run its Worker, whose own RPCs commit separately and recheck authority. Dry-runs do not run the code. Post-commit failures retain the graph commit and appear as `post-commit-failed` in GM-only traces (there is no claim of an atomic code+graph rollback).

```ts
interface AutomationTraceMsg {
  kind: "automation.trace";
  automationId: DocId;
  method: AutomationMethod;
  result: "committed" | "skipped" | "rejected" | "post-commit-failed";
  detail: string;
  trace: string[];
  seq?: number;
}
```

### macro.request (0x3a · client → host · ops)

Invoke only a saved, GM-reviewed script macro by ID with a bounded record of **declared typed** inputs; clients cannot supply source, grants, run-as, scene or world ops. The host checks the complete source/policy SHA-256 approval, publication and scene/target visibility, then commits a bounded at-most-once invocation marker **before** starting a disposable Worker. Each worker action crosses a separate grant and authority check. Nested calls share a deadline and recursion/action budget. A player-callable GM-authority macro can act on visible scene targets only where the GM approved the corresponding grant. Browser workers are *not* a hostile-code security boundary: only GM-reviewed code may be published. World archive copies **and** restores invalidate script approval, clear player publication and require an explicit review/republish on this host; an approval hash bundled in an archive is not local consent. Script steps commit individually and are not yet an atomic transaction.

```ts
interface MacroRequestMsg {
  kind: "macro.request";
  requestId: string;
  macroId: DocId;
  args: Record<string, Json>;
}
```

### macros.invoke (0x4f · client → host · ops)

TR-12/MC-01: run a saved **automation macro** — a world macro that references one graph. The client
sends only the macro id, never a graph id, action, scene or token, so a player can hold a callable
directory/hotbar entry without ever learning which private graph it names (the projection strips the
binding from every player replica, on snapshots, creates and rebinds alike). The host re-resolves the
binding against live state: the definition must still validate, the graph must still subscribe to
`manual`, and for a player the anchor must be a **tile** the caller can see with the `playerRunnable`
gate and the graph's own scene must be the scene that caller currently has loaded. The macro grants no
authority of its own — it is a second way to ask for an already-published trigger, so nothing here
widens a graph's audience. One fire per `requestId`; the result travels as `macro.result` and never
names the graph, its id or a refusal reason to a non-GM.

**Hotbar preferences (D-392) are not a wire message.** A player may override the five
`flags.core.slot` defaults using a browser-local `{ version: 1, slots: [...] }` record keyed
by the `(worldId, userId)` tuple. Each binding is `null` (inherit the current GM default),
`""` (explicitly empty), or a bounded macro id. No document/source/grant/graph reference is
stored; nothing is submitted, projected, exported with the world or synced to another device.
The shell resolves ids against its current delivered macro catalog, leaves a missing override
inert without falling back to another macro, and issues only the existing caller-scoped
requests when a slot is actually run. A catalog entry is not proof of live publication: the
host still re-resolves and authorizes the request, and the hotbar renders the invoker's own
`macro.result` (neutral for a refused player request) without forwarding private diagnostics.
Denied local storage keeps the arrangement for the visit with explicit unsaved feedback;
it never falls back to a world write.

MC-02: an automation macro may also **declare inputs** (`{ name, type, required?, from? }`, at most
16, of type string/number/boolean/token/actor/item), and a caller then supplies `args`. The declared
schema *is* projected — it is the callable metadata a directory/hotbar needs to prompt for the
values, and it is the one part of the binding a player receives — while `graphId` and everything
else about the binding stay GM-only. The host validates the supplied record against the declaration
(unknown name, missing required, wrong type, over-long string, too many keys, a token the caller
cannot see, an actor the caller cannot read or an unreadable exact item ref all refuse; a player only reads the neutral
"automation macro unavailable"), then exposes the values to the graph as `{{arg.<name>}}` — a dotted
name is deliberately not a legal durable variable, so an argument can never shadow world state.

`from: "selected"` is a **caller-side default** for a `token`, `actor` or `item` input. A shell that
received no explicit value takes the canvas token (`actor` uses its linked actor), or independently
its most recently focused open, non-minimized PF1e item window (`item`). Focusing the macro/chat
surface does not discard that item context; no item is guessed from the selected token's inventory.
A stale/deleted/unreadable top item clears the default rather than falling back; explicitly closing
or minimizing it exposes the next open item window. Item-only context invents no token or actor.
A required blank item default refuses locally with `select an item for <name>`; optional absent
values stay absent and explicit named/positional/picker values always win.

**Item refs (D-393)** are scalar strings, never document bodies: a bare `itemId` names a WORLD item
only, and `actorId/itemId` names exactly that actor's embedded item. Each component is 1–128 ASCII
letters/digits/underscore/hyphen (qualified maximum 257); no inventory-wide search, name fallback,
path traversal or parent guessing. The host re-reads the world item, or both the parent actor and
its embedded item under the **actual caller's** live read rights, with normal parent-ownership
inheritance. The same check runs for a nested `callMacro`, not under the graph author's GM identity.
A local picker contains only readable world and parent-qualified embedded entries. No selection,
picker choice or ref grants mutation/cast authority, widens projection or executes item mechanics.
The resulting ref travels in the existing `args` record with the unchanged 16-field / 8 KiB payload
bounds. Ordinary strings, scalar returns and saved Call Macro literals keep their 256-character
bound; a maximal typed item ref can be forwarded as `{{arg.tool}}` rather than an oversized literal.
A composite takes no arguments.

MC-02 also lets one graph **call another saved automation macro** from inside its own envelope, so a
GM can build a named library of small graphs and compose them. The step is
`{ id, kind: "callMacro", macroId, args?, capture?, onError?, propagateStop? }`, and it is authored
against the **macro**, never a graph id: the host re-resolves `macroId` to the macro's graph on every
run and applies that graph's own rules — same scene, a real anchor in that scene, and `manual` among
its methods — exactly as if the graph were invoked directly. Caller-supplied `args` are interpolated
in the **caller's** context, coerced to the called macro's declared types and re-validated by the same
rule a directory invocation gets (`{{arg.<name>}}` inside the child), so a call cannot hand a child
data that child would never accept from a caller. The child runs **inside this plan**: one envelope,
one undo boundary, and the shared depth/invocation budget that already bounds trigger-tile chains, so
an indirect cycle is refused at run time with a `parent -> child` stack. A failure is transparent —
`call <macroId> (graph <graphId>): <reason>` — and `onError: "continue"` instead records the failure
in the trace and carries on. `capture` stores the child's own Return Value in a run variable for later
steps; only the **root** graph's value is the invocation's result. A `stop` inside the called graph
ends *that graph* (a call is a subroutine, not a chain reaction); `propagateStop` opts into letting it
end the caller as well, the same shape `redirect`/`triggerTile` already use. Nothing here widens a
graph's audience: the whole call runs under the invoker's identity and visibility, and a player's
replica never learns a graph id.

```ts
interface MacroInvokeMsg {
  kind: "macros.invoke";
  requestId: string;
  macroId: DocId;
  args?: Record<string, Json>; // named scalar values, including exact item refs (MC-02)
}
```

### macros.save (0x51 · client → host · ops)

D-394: save personal chat/roll macros or unapproved script drafts in the GM's durable world,
only when the GM has enabled `UserDocument.canSaveMacros` for that actual caller (off by default).
The bounded content request contains no ownership, grants, approval, bindings or execution history.
The host stamps author/ownership (private to the author and GM), checks existing author+owner rights,
visible script scene, per-author quota and replay ID, and commits one undoable world envelope.
A player cannot overwrite another author's or GM's macro, grant their own saving permission,
edit the host-owned author metadata through raw intents or assign a global hotbar slot. Each
player revision clears script review/publication/grants; only normal GM review can enable execution.
The original submitted draft is projected only to its author; later GM executable source/policy
remain redacted even from that author. Replies use the existing caller-only `macro.result`.
Saving places documents in the host world/oplog and next world export, not automatic disk overwrite.

Limits: 64-character normalized names, 4,096 chat / 16,384 script characters, actual serialized
UTF-8 draft ≤32,768 bytes, ≤16 declared script inputs, 64 personal documents per author, and
ASCII request/macro IDs of 1–128 characters. The shared per-session intent bucket rate-limits
requests; the host retains 256 caller-scoped save/delete replies for idempotent acknowledgements
(including reconnects within that bounded window). Host script invocation history survives revisions
and kind switches. Existing valid GM hotbar slots may survive, but cannot be assigned by this request.
The GM/assistant alone changes saving permission or user roles; malformed self-owned User documents
do not allow a player to promote themselves or opt in. Public User list ops now match snapshot
visibility, so saving enablement/revocation reaches the UI immediately. Loss of OWNER rights clears
the original-author DTO while the macro remains readable; loss of read visibility removes it through
the existing host boundary-crossing mechanism. Resolver-less macro diffs conservatively blank all
original-author and executable source/policy paths rather than forwarding unverified content.

```ts
type MacroSaveMsg = { kind: "macros.save"; requestId: string; macroId: DocId } & (
  { action: "save"; draft: PlayerMacroDraft } | { action: "delete" }
);
type PlayerMacroDraft = { name: string; command: string } & (
  { kind: "chat" } | { kind: "script"; sceneId: DocId; inputs: ScriptInput[] }
);
```

### journal.trigger (0x50 · client → host · ops)

TR-12: a journal page's MATT-style tile link (`@Tile[<anchorId> landing:<name>]{Label}`). The client
sends the journal id, the page id and the link's **ordinal in the text it received** — never a tile,
region, scene or graph id. The host re-reads the page, re-derives the links the caller can click (a
player's list excludes links inside `<secret>` blocks, and player replicas have every target payload
blanked before delivery, so an ordinal means the same link on both sides) and resolves the anchor
itself: every same-scene graph bound to that anchor that validates and subscribes to `manual` fires
with method `manual`, origin source `journal`, at the named landing when the link asks for one, inside
one atomic envelope. A readable page is the publication surface — the anchor need not be visible to
the player or carry the `playerRunnable` gate — but a player's target scene must be the scene that
player currently has loaded, and the paused gate still applies on the host. Silent on success (the
graph's own chat/FX is the feedback) and indistinguishable from a plain tile when no graph matches.
One fire per `requestId`.

```ts
interface JournalTriggerMsg {
  kind: "journal.trigger";
  requestId: string;
  journalId: DocId;
  pageId: DocId;
  index: number;
}
```

### pf1e.poison (0x53 · client → host · ops)

Core PF1e poison intent. The host verifies the target/profile/delivery, derives the current save bonus
and dose-adjusted DC, supplies randomness, and atomically commits course state, effects, spell cost,
chat summary and a private GM Revert receipt. A client cannot send a save result, DC, effect Ops,
cure progress, or course state. Exposure is GM-only; Delay Poison and Neutralize Poison require a
validated source actor plus an available prepared spell row or spontaneous spell slot. Periodic saves,
onset and expiration are host-scheduled from replicated world time and the affected creature's turn.

An `expose` may name a **delivery rider** — the committed D-405 action card whose landed target row
this poison rides on. The host re-reads the card, requires the named row to exist and its outcome to
be landed (`hit`, `failedSave`, `affected`), checks that the caller controls the delivering actor,
inherits the delivering action's source actor/item when the request names none, and attaches the
outcome to that row as an `ActionRider`. When the victim is a player-owned actor the rider's save
becomes a host pending roll (resolved through the ordinary `roll.pending` commit-reveal path) instead
of a host-rolled save; when it is not, the host rolls the save immediately. Only landed interactions
may carry a rider — a miss, a pending row, or a rider on an unrelated card is refused by name.

```ts
// PF1ePoisonActionMsg (union):
{ kind: "pf1e.poison"; requestId: string; action: "expose"; targetActorId: DocId;
  poisonId: string; route?: "injury" | "contact" | "ingested" | "inhaled"; doseCount?: number;
  sourceActorId?: DocId; sourceItemId?: DocId;
  rider?: { actionId: DocId; targetKey: string } }
{ kind: "pf1e.poison"; requestId: string; action: "delay-start" | "neutralize";
  targetActorId: DocId; sourceActorId: DocId;
  spellUse: { kind: "prepared"; index: number } | { kind: "slot"; level: number };
  courseId?: string }
{ kind: "pf1e.poison"; requestId: string; action: "delay-end"; targetActorId: DocId }
```

The `frequency` variant is deliberately not a client command; the host rejects it. `courseId` is
required for `neutralize` (and omitted for `delay-start`) even though the compact example above
shows it optional across the combined spell-source variants.

### pf1e.condition (0x54 · client → host · ops)

Manual condition application/removal uses an intent, never client-created condition documents or
receipt metadata. The host checks actor permission and the supported condition catalog, assigns the
application/source/receipt IDs, and commits the keyed condition change with a private GM Revert
receipt in one transaction. Unsupported labels and stale application IDs are rejected without a
state change.

```ts
{ kind: "pf1e.condition"; requestId: string; action: "apply"; actorId: DocId; condition: string;
  spell?: { effectId: string; actionId: DocId; targetKey: string } }
{ kind: "pf1e.condition"; requestId: string; action: "remove"; actorId: DocId; applicationId: string }
```

D-407 adds the optional `spell` field for a condition a **landed cast** delivers: the client names
the tactical-effect catalogue id and the action card row, and the host re-reads the card, re-checks
the row's outcome against the same catalogue row, derives the source (spell id, card id, caster
actor/item) and attaches a `condition` rider to that card. The field is refused on a `remove`, on an
unknown effect, on a condition the effect does not apply, on a row that did not land, and on a card
that is not a `cast` card; a non-GM caller must control the delivering actor. A producer that needs a
retry to be idempotent passes its own `requestId` (the host digests it into the receipt id).

### pf1e.condition.result (0x55 · host → requester · ops)

Private acknowledgement sent after the condition state and Revert receipt commit. It contains the
host-assigned application/receipt IDs and commit sequence; the condition itself arrives only through
normal projected world Ops.

```ts
{ kind: "pf1e.condition.result"; requestId: string; action: "apply" | "remove";
  actorId: DocId; applicationId: string; receiptId: DocId; seq: number }
```

### codex.purchase (0x56 · client → host · ops)

A player asks the host to purchase a quantity of one published Campaign Codex shop stock row for a character. The request contains identifiers and quantity only; the host rechecks shop/page/item visibility, actor update permission, current stock and PF1e currency, then commits stock, wallet, inventory and the durable Revert receipt atomically. The `requestId` is stable across retries; a duplicate successful request receives a private replay acknowledgement and never transfers a second time.

```ts
{ kind: "codex.purchase"; requestId: string; sheetId: DocId; stockRowId: string;
  quantity: number; actorId: DocId }
```

### codex.purchase.result (0x57 · host → requester · ops)

Private transaction result. It is sent after commit or validation failure and does not replace the authoritative projected world Ops. `replayed` means an earlier request with the same ID already committed.

```ts
{ kind: "codex.purchase.result"; action?: "purchase" | "claim"; requestId: string;
  ok: boolean; detail: string; receiptId?: DocId; totalCopper?: number; replayed?: boolean }
```

### codex.claim (0x58 · client → host · ops)

A player claims a published stock row from a Codex Entry in **loot mode**. The host rechecks the sheet and shop audience, readable source item, selected actor's update permission, and current stock, then atomically decrements stock and transfers the item without charging currency. The request carries identifiers and quantity only; retries are idempotent and use the same private `codex.purchase.result` message with `action: "claim"` and the durable Revert receipt ID.

```ts
{ kind: "codex.claim"; requestId: string; sheetId: DocId; stockRowId: string;
  quantity: number; actorId: DocId }
```

### macro.result (0x3b · host → caller and GMs · ops)

Other GMs see bounded execution traces, errors and JSON return values. The player caller sees only a generic completed/failed status: script output and logs are never a hidden-data read channel.

MC-02 adds one exception that is authored rather than incidental: a graph's **Return Value action** (`{ id, kind: "result", value, audience }` with `audience` `caller` or `gm`) hands a bounded scalar back to whoever invoked the macro, delivered as this message's `result` field and shown by that caller's own status line. It is never broadcast, never becomes a chat message, and is private to the invoker's session; an `audience` of `gm` withholds it from a non-GM invoker entirely (the graph's `{{…}}` interpolation is still the author's, so a value that quotes private state is a disclosure the GM chose). A string value is interpolated and must stay ≤256 characters with no control characters, or the whole invocation is rejected. No recipient executes the code again; mechanical work is singular on the host. The durable invocation marker and op log support reconnect/replay diagnostics, but there is no transactional rollback across multiple script actions yet.

```ts
interface MacroResultMsg {
  kind: "macro.result";
  requestId: string;
  macroId: DocId;
  callerId: UserId;
  ok: boolean;
  detail: string;
  result?: Json;
  trace?: string[];
}
```

### asset.manifest (0x37 · host → client · ops)

After import, removal, publication or a visibility change, the host sends a **full replacement** of the viewer's projected asset metadata (not bytes). Revoked entries disappear immediately from the client manifest; new requests and each queued asset chunk are re-authorized against current host state. GM/assistant ops-since reconnects also receive a fresh manifest because metadata is not an Op. Previously downloaded/cacheable bytes cannot be clawed back.

```ts
interface AssetManifestMsg { kind: "asset.manifest"; manifest: AssetManifest; }
```

### fx.request (0x35 · client → host · ops)

Run an **existing, host-validated** sequence macro. The client cannot send FX sections, asset URLs, world ops or an audience. The host checks caller publication rights, scene and token visibility, media IDs/MIME and rate/idempotency before sending any cue.

```ts
interface FxRequestMsg {
  kind: "fx.request";
  requestId: string;
  macroId: DocId;
  sceneId: DocId;
  sourceTokenId?: DocId;
  targetTokenId?: DocId;
}
```

### fx.start (0x36 · host → client · ops)

Recipient-projected visual/audio timeline with authoritative coordinates and asset MIME. One-shots start at least 300 ms ahead; each client uses the host-clock offset. After a graph commits a visibility-changing envelope, the host rechecks source/target visibility and asset entitlement before sending a cue. Cues do not mutate mechanics and never travel over `ephemeral`.

A saved non-wait one-shot section may carry an exact, trimmed 1–64 character `launchGroup` name. Members with the same name must author the identical absolute start or identical earlier-section finish relation (including offset), plus the identical optional random-delay range. When that range exists, the first authored member consumes one host RNG unit and every peer reuses it, producing one concrete launch time; a one-member group is valid. Duration, replay expansion and conditional inclusion remain per section. The name, range and finish relation are stripped before projection, waits and persistent timelines reject launch membership, and imported durable cues carrying it fail closed. This simultaneous-launch contract is distinct from persistent visual `syncGroup`: launch groups align finite schedule time, while playback sync groups keep each scheduled start and align media/animation phase. Direct Wizard, automation and reviewed `api.fx.play` invocation all converge on this resolver.

A finite section may carry author-only `parallel: { group, lane, offsetMs? }` metadata. One exact 1–64 character group occupies one contiguous block with 2–8 exact 1–64 character lanes. The first member of every lane authors the same fork schedule (absolute or earlier-section finish relation plus the same optional random-delay range) and no lane offset. Each later member has no independent schedule/range: it starts after that lane's previous member's final replay, plus a signed −30,000..30,000 ms offset that may overlap but may not begin before the predecessor. Wait sections may sequence inside a lane, but every lane must contain at least one media or camera section; persistence and simultaneous `launchGroup` membership are refused. A section outside and after the complete block may use exactly one `startAfter` target—`sectionId` or `parallelGroup`—and a group target starts from the latest final-replay end among all lanes, plus its signed offset. This is a longest-lane barrier, not the last section in author order.

The fork consumes one host RNG unit when its shared range exists; all lane-first members reuse that concrete delay. Lane-local conditions remain per section, but skipped sections retain their would-be schedule, so neither serial lane progress nor a join collapses differently by recipient. Validation rejects cosmetic one-lane groups, discontinuous/reopened blocks, mismatched lane-first schedules, lane count overflow, negative-time overlap and joins that target an incomplete/current/unknown block. `parallel`, `randomDelay` and `startAfter` are stripped before recipient projection, durable instances reject forged authoring metadata and preset reminting preserves lanes and group joins while remapping direct section references. Wizard Run, automation and reviewed `api.fx.play` all converge on this scheduler. This is bounded explicit fork/lane/longest-join behavior inside one finite saved timeline, not arbitrary/nested lane graphs, committed-outcome branching or full SQ-02 parity.

A saved non-wait one-shot section may carry `playIf: { kind: "chance", percent: 0..100 }`. The host resolves every section's bounded schedule and media/anchor validity first, then samples each genuine 1–99% predicate exactly once in authored order; 0/100 consume no entropy. One decision includes or removes that section **and all of its replays** for every recipient. Finish-relative dependents retain the skipped section's would-be concrete final-playback schedule rather than collapsing differently by viewer. `playIf` never appears in `ResolvedFxSection`, a persistent timeline rejects it, and an all-skipped run is an accepted requester-private no-op (`fx.run` only, no empty `fx.start`). Direct Wizard, automation and reviewed `api.fx.play` invocation all converge on this same host resolution. This bounded predicate does **not** accept caller-supplied hit/miss/value context and does not claim committed-outcome conditional branching.

D404 extends the same author-only discriminator with `playIf: { kind: "choice", group, option, weight }` for finite non-wait sections. Group and option are exact trimmed 1–64 character names; weight is an integer 1–100. A timeline has at most eight groups, each group has 2–8 distinct options, and every section in one group/option carries the same relative weight. Several sections may belong to one option and are included together. After resolving the complete would-be schedule, the host consumes exactly one RNG unit at the first authored member of each group and selects exactly one option by relative weight for every replay and recipient; all other options are omitted without collapsing dependencies, parallel lanes or joins. The host strips the entire `playIf` object before projection, and durable cues reject it. Wizard Run, automation preflight and reviewed `api.fx.play` share this resolver; local Preview deterministically shows the first option rather than pretending to make an authoritative draw. Choice names and weights are not event results and never accept a caller-supplied hit/miss/save/value. This is bounded host-random alternative selection, not committed-outcome branching or full SQ-02.

Only explicitly persistent cues are durable: the host commits a private `FxInstanceDocument` (`fxInstances` top-level collection) and sends `fx.start` after commit. The viewer receives **only** this resolved cue, not its private instance document. Persistent image/text/audio lanes loop; recipients who re-enter a scene request `fx.sync` to recover the original host-clock phase. A persistent image/text section may author a bounded `syncGroup` name. The host scopes that name to the same scene, saved timeline, owner, effective audience and source/target invocation bindings, chooses the earliest member's absolute origin (or reuses the origin of an active durable run in that scope), strips the name, and sends only `syncAtHostTime` on entitled visual sections. This changes animation/video **phase**, never the section's scheduled start or lifetime: a later member launches at its own `startMs` already caught up to the shared cycle. The private membership and resolved origin survive reconnect; after the final scoped instance ends, the next run establishes a new origin. Scoping prevents a public cue's phase from becoming an oracle for a GM-only/different-owner timeline. An explicitly `follow`ing visual carries only host-verified source/target token IDs, never author-supplied references. The canvas samples **projected, fog-visible** token centers; lost visibility hides playback locally and revokes the persistent cue on the host. Media sharing and permission to embed its bytes in a world ZIP are independent GM declarations; restricted FX media cancels export rather than silently redistributing a premium pack. A **camera section** of a one-shot cue carries its own audience word (`scene` — everyone receiving the run — `gm`, `caller` for the session that requested the run, or `others` for everyone *except* that session; a timeline carries the same vocabulary, and `{ players: [...] }` names users instead); the host builds the payload **per recipient**, so a viewer outside that audience receives the run *without* the section and learns nothing about where someone else's view went. A recipient left with no sections at all receives no cue. A **positioned sound** (D-309) likewise carries host-resolved geometry — `x`/`y` and a `radiusPx` on the scene's own grid: the client measures distance (silent at the rim, full at the source, linear between) and may pan across the stereo field, and a sound with no position stays a global cue at its authored volume. Occlusion is answered **per recipient** as well: `occluded: true` is added to that recipient's copy of a `muffle` sound when the scene's own *sound* axis (with door state) puts a wall between them and the source, tested from that recipient's own token at ownership level 3 — a recipient with nothing of their own on the scene is sent no answer at all. The client is never handed the walls, only the host's answer for it, and a device without Web Audio plays the cue at its distance level and reports the reduction instead.

```ts
interface FxStartMsg {
  kind: "fx.start";
  runId: string;
  macroId: DocId;
  sceneId: DocId;
  atHostTime: number;
  sections: ResolvedFxSection[];
  persistent?: boolean;
}
```

### fx.run (0x52 · host → requesting client · ops)

Private acknowledgement that a saved timeline request became one exact host-approved run. It is sent only to the requesting session after durable commit or finite cue fan-out, including when the saved `others` audience means that session correctly received no `fx.start`. It carries no audience, recipient count, asset, anchor or projection detail, so it cannot be used as a membership oracle. A retry with the same caller/request ID receives the same acknowledgement and never creates a second run.

`endsAtHostTime` is the natural host-clock end of a finite run, including resolved random/relative timing and replay expansion. When every conditional section is skipped it equals `atHostTime`. Persistent runs omit it. The run ID is the opaque reference the owner—or a GM/assistant—may submit to `fx.stop`; it is not authority by itself, and knowing an unauthorized ID grants nothing.

```ts
interface FxRunMsg { kind: "fx.run"; requestId: string; runId: string;
  macroId: DocId; sceneId: DocId; atHostTime: number;
  endsAtHostTime?: number; persistent: boolean }
```

### fx.sync (0x3f · client → host · ops)

Read-only request to replay currently authorized persistent cues for one scene. The host checks current scene/macro/anchor visibility and **each** media entitlement, then sends only entitled `fx.start` messages; unknown/inaccessible scene IDs get no effect existence oracle. No mechanics or new world op runs on reconnect.

```ts
interface FxSyncMsg { kind: "fx.sync"; sceneId: DocId }
```

### fx.stop (0x44 · client → host · ops)

Host-authoritative exact-run stop/cancellation: GM/assistant may stop any active run; a player may stop only one they started. Unknown, expired and unauthorized IDs all receive the same generic refusal. Direct document intents against `fxInstances` remain forbidden **even for the GM**.

For a persistent run, the host deletes its durable instance through an authoritative transaction; normal Undo can restore it. For a finite one-shot, the host retains a bounded private handle only through its natural end (at most 256 concurrent handles under the existing 60-second timeline limit). Cancellation removes that handle and any pending media receipt, then sends `fx.end` only to sessions that received the cue. It writes no world state and is deliberately not undoable: resuming half-fetched media/camera/audio at a consistent past phase would be a new playback operation, not an Undo. Pending section timers, in-flight fetch/decode, active Pixi visuals, sounds and camera claims all stop through the same recipient-side run epoch.

The field remains named `instanceId` for wire compatibility; for a finite run it is the `runId` from `fx.run`. Source/target-token, macro and scene deletion continue to cascade-bound durable instances in the same transaction and undo group.

```ts
interface FxStopMsg { kind: "fx.stop"; requestId: string; instanceId: DocId }
```

### fx.stopMatching (0x49 · client → host · ops)

GM/assistant-only Live FX manager operation. The client supplies a scene and at least one bounded selector (`name` case-insensitive `*`/`?`, or exact `macroId`/`sourceTokenId`/`targetTokenId`). The host validates the entire request, re-evaluates the live scene/instances (never trusts the UI's preview list), and rejects a match over 16 without stopping anything. Successful matches are removed in **one** authoritative undoable envelope; prior recipients each receive only their permitted opaque `fx.end` signals. Player requests are rejected without enumerating instance IDs.

```ts
interface FxStopMatchingMsg { kind: "fx.stopMatching"; requestId: string;
  sceneId: DocId; filter: FxInstanceFilter }
```

### fx.end (0x45 · host → prior recipients · ops)

A private stop/cancellation/revocation signal with no author, macro, source, asset or scene-graph data. The client cancels pending timers and decode/playback, active sound/visuals and that run's camera claim, then removes only the named run. Visibility and asset-rights changes can revoke (or later regrant) a durable instance without deleting the GM's record; finite cancellation does not regrant or replay.

```ts
interface FxEndMsg { kind: "fx.end"; runId: string; sceneId: DocId }
```

### fx.media (0x4e · client → host · ops)

What **one viewer did with one asset** of a cue it was sent (SQ-13/D-308): the second half
of the delivery story, after `fx.delivery` has said who was *entitled* to the cue. The
bytes still have to arrive and this browser still has to decode them, and until now only
the viewer's own screen knew the answer — a GM could not tell a broken timeline from one
that worked. Sent only by a session the host actually fanned that cue out to, and only
about an asset that cue used; anything else is ignored without a reply (there is nothing
to leak and no one to tell: a session that guessed a `runId` learns nothing).

The client sends at most one ack per (run, asset), as soon as it knows something: an
"already in hand" or "this browser refuses the format" ack at cue start, then the result of
its prefetch, and then a *revision* if the section itself fails to play — a late or failed
ack always outranks an earlier `ready`, because "the bytes arrived and the decoder refused
them" is a failure, not a success. A recipient that never speaks is reported as having
said nothing: `detail` is deliberately absent from the wire, since a fetch error string is
a place for a URL or an asset hash to reach a GM's report.

```ts
type FxMediaAckState = "ready" | "late" | "failed" | "unsupported"
interface FxMediaAckMsg { kind: "fx.media"; runId: string; assetId: string;
  state: FxMediaAckState;
  /* `failed` only: `fetch` = the bytes never arrived, `decode` = they did and were refused. */
  reason?: "fetch" | "decode";
  /* `ready` = ms spent fetching (absent when already in hand); `late` = ms past the start. */
  ms?: number }
```

Bounds: `runId` matches the same `^[a-zA-Z0-9_-]{1,128}$` as a request, `assetId` is 1–128
characters, `state` is one of the four names, `ms` is a finite 0–3 600 000, and the host
keeps at most 32 runs' worth of expectations, so a hostile client can neither flood the
requester with reports nor make the host remember unbounded state.

### fx.delivery (0x4d · host → requesting session · ops)

The host's preflight answer to the requester of a cue (SQ-13/A10): the requested action
already completed exactly once, but the cue reached fewer sessions than the scene has — or
reached them with a *section withheld* because the author targeted it at someone else
(D-300/D-303). Counts only, per reason — an audience/entitlement mismatch must not become a
membership oracle, so no user, document or asset identifier appears in the message. Sent
only to the requesting session, when the requester is a GM/assistant and there is something
to explain (a skip, a reduced payload, or a viewer left with nothing); a player-initiated
request never receives it.

```ts
interface FxDeliverySkips { audience: number; rights: number; anchor: number; media: number }
interface FxDeliveryMsg { kind: "fx.delivery"; requestId: string; runId: string; macroId: DocId;
  recipients: number; skipped: FxDeliverySkips;
  /* Of `recipients`, those whose cue omitted a section targeted elsewhere. */
  targeted?: number;
  /* Entitled viewers who received nothing at all: every section was targeted away. */
  empty?: number }
```

`recipients` counts sessions that received *something*; a viewer whose copy would have no
sections at all is counted in `empty` and receives no cue, so a run the author aimed
entirely at the GM is not reported as having reached the whole table.

### (continued) the media follow-up (D-308)

A cue with image/sound sections gets a **second** `fx.delivery` for the same `runId`, once
the lead time has run out, carrying what the viewers reported through `fx.media`:

```ts
interface FxMediaReportEntry { index: number; kind: "image" | "sound"; mime: string;
  ready: number; late: number; failed: number; unsupported: number; silent: number }
interface FxMediaReport { assets: FxMediaReportEntry[]; viewers: number; spoke: number;
  complete: boolean; slowestReadyMs?: number; corrected?: boolean }
```

The same report carries the states a *device* answered with when it was asked for something it
could not do (D-309): `reduced` — the cue played, but not as authored — with
`reason: spatial-unavailable` when this shell has no Web Audio to pan or dull a positioned
sound with. It is the viewer's own word about its own device, so it travels in this report like
any other per-viewer answer, and a shell that can do it never sends one.

It is sent to the emitting requester's own session when the answer is complete, when a
viewer reports a failure (so the GM can still stop the cue), or when the run's own media
window closes — whichever comes first — and an early answer is corrected **once** if a
later ack changes whether some viewer lacks the media, after which further acks update the
record silently. The asset is named by the requester's own section `index`: the message
carries no asset or user identifier, keeping the "not a membership oracle" rule above. An
all-clear line is still sent — this report was asked for, so "every viewer holds the
media" is the answer, not noise.

### ephemeral (0x04 · both · ephemeral)

Never persisted, rate-limited 20 Hz per peer (§5).

```ts
type EphemeralKind = "cursor" | "ping" | "drag" | "ruler" | "typing";
interface EphemeralMsg {
  kind: "ephemeral";
  from: UserId;
  t: EphemeralKind;
  data: Record<string, Json>;
}
```

### asset.get (0x05 · client → host · assets)

Lazy fetch by sha256 with resume; priority queue order scene > ui > audio > preload (§7).
Requires an authenticated session; per-session rate bucket burst 20 @ 10/s (§16, D-041).
Per-peer bandwidth cap and 32 KB default chunks (D-040).

```ts
type AssetPriority = "scene" | "ui" | "audio" | "preload";
interface AssetGetMsg {
  kind: "asset.get";
  assetId: AssetId;
  offset: number;
  priority: AssetPriority;
}
```

### fog.put (0x06 · client → host · ops)

Per-user explored fog: the sender's explored map of a scene as a PNG (opaque = unexplored,
the fog texture read back at 512 px wide). The host keeps the latest per user + scene and
persists it (§8 key [worldId,sceneId,userId]; the world file carries it under `fog/`, D-250).
A user can only write their own map; empty or > 1 MiB payloads are dropped (§16).

```ts
interface FogPutMsg {
  kind: "fog.put";
  sceneId: DocId;
  png: Uint8Array;
}
```

### fog.get (0x0e · client → host · ops)

Ask for one's own stored explored map of a scene (D-250). Sent when a fogged scene is
entered and again after every welcome (reconnect); the client merges the answer into its
texture, so repeats are harmless. Answered with `fog.state`.

```ts
interface FogGetMsg {
  kind: "fog.get";
  sceneId: DocId;
}
```

### fog.state (0x2e · host → client · ops)

The asker's stored explored map for `sceneId` — the latest `fog.put` in memory, else the fog
store; `png: null` when nothing is stored (D-250).

```ts
interface FogStateMsg {
  kind: "fog.state";
  sceneId: DocId;
  png: Uint8Array | null;
}
```

### relay.offer (0x07 · client → host · ops · M4)

Offer from a player unreachable directly, forwarded through a connected peer (§6.3).

```ts
interface RelayOfferMsg {
  kind: "relay.offer";
  from: PeerId;
  sdp: string;
}
```

### turn.ready (0x08 · client → host · ops)

Player toggles readiness for the orders phase (§5A).

```ts
interface TurnReadyMsg {
  kind: "turn.ready";
  turnId: DocId;
  ready: boolean;
}
```

### sim.control (0x09 · client → host · ops · GM only)

Pause/resume/rate/advance/next/undoTurn/mode (§5A, §13). Realtime campaigns
start with `action:"start", mode:"realtime"`; the host then runs a sim clock —
ticks at `simHz` (default 5), deltas coalesced into one frame per `flushHz`
interval (default 5), a 1 Hz realtime `turn.report` (bounded events,
`rulesVersion:"realtime"`), and a tick checkpoint every 300 ticks plus on
pause/scene change. `rate` adjusts `simHz` live (flush capped at the original
`flushHz`); `pause` freezes the clock and writes a tick checkpoint (`tick`
non-null in the checkpoints store, distinct from stepwise freezes); `resume`
continues without a catch-up burst.

```ts
type SimControlAction =
  | "pause"
  | "resume"
  | "rate"
  | "advance"
  | "next"
  | "undoTurn"
  | "mode"
  | "start";
interface SimControlMsg {
  kind: "sim.control";
  action: SimControlAction;
  rateHz?: number;
  mode?: "stepwise" | "realtime";
  deadlineMs?: number;
}
```

### report.detail (0x0a · client → host · ops)

Paginated verbose per-model rolls of a TurnReport, fetched on demand (§11).

```ts
interface ReportDetailMsg {
  kind: "report.detail";
  turnId: DocId;
  unitId?: DocId;
  page: number;
}
```

### sim.snapshot.get (0x0b · client → host · sim)

Client detected a version gap and requests a full snapshot (§5A).

```ts
interface SimSnapshotGetMsg {
  kind: "sim.snapshot.get";
  sceneId: DocId;
}
```

### welcome (0x20 · host → client · ops)

After approval: assigned User document info + world info (§6.4).

```ts
interface WelcomeMsg {
  kind: "welcome";
  user: { id: UserId; role: Role; name: string };
  world: { id: WorldId; name: string; system: string; version: string };
  snapshotSeq: number;
  /** §5A: the active strategic battle; clients adopt it before the first
   *  sim frame (joiners never guess schema columns or scene id). */
  sim?: {
    sceneId: DocId;
    schema: {
      readonly [column: string]:
        "f32" | "f64" | "i32" | "u32" | "i16" | "u16" | "i8" | "u8";
    };
    packageId: string | null; // null = built-in mass-battle-basic
    version: string;
  };
}
```

`sim` is the host-announced battle (N01): the active rules package's model
columns and the scene the sim channel serves. On adoption a client without a
replica requests `sim.snapshot.get` for that scene (pre-start requests are a
host-side no-op; `start` broadcasts the first snapshot). When the host
re-announces a _changed_ `sim` (package switch), clients discard replicas
decoded under the old shape and re-pull a snapshot before applying further
deltas; re-announcing identical info (reconnect) is a no-op.

### snapshot (0x21 · host → client · ops)

Projected world snapshot; carries only the asset manifest — assets stream lazily by hash (§5, §7).
Manifest entries may carry image descriptors (D-042/D-043): `width/height`,
`thumb {assetId,width,height}` (≤256 px WebP), `mid` (≤1024 px WebP),
`tiles {size, cols, rows, ids[]}` (row-major, maps >4096 px).

```ts
interface SnapshotMsg {
  kind: "snapshot";
  seq: number;
  world: ProjectedWorld;
  manifest: AssetManifest;
}
```

### ops (0x22 · host → client · ops)

Commit broadcast — the projected OpEnvelope `{ seq, ts, by, ops', txId }` (§5). Late joiners buffer ops with seq > snapshot.seq.

```ts
interface OpsMsg {
  kind: "ops";
  envelope: OpEnvelope;
}
```

### rejected (0x23 · host → client · ops)

Sent to the origin of a failed intent; clients roll back optimistic state (§5). `phase_locked` rejects order ops after turn.advance (§5A).

```ts
type RejectionReason =
  | "forbidden"
  | "invalid_schema"
  | "invariant"
  | "phase_locked"
  | "rate_limited"
  | "error";
interface RejectedMsg {
  kind: "rejected";
  txId: TxId;
  reason: RejectionReason;
  detail: string;
}
```

### asset.chunk (0x24 · host → client · assets)

Chunked transfer with resume (`offset`), 16–64 KB per chunk (§6.1, §7).
Unknown asset → sentinel `{ offset: 0, total: 0, bytes: [], done: true }` (D-039).

```ts
interface AssetChunkMsg {
  kind: "asset.chunk";
  assetId: AssetId;
  offset: number;
  total: number;
  bytes: Uint8Array;
  done: boolean;
}
```

### audio.cmd (0x0c · both · ops)

§7 audio playback command (transfer-once assets, scheduled on the host clock).

Client → host (GM/ASSISTANT request; `atHostTime` absent — the host stamps it):

```ts
interface AudioCmdMsg {
  kind: "audio.cmd";
  playlistId: string;
  soundId: string;
  action: "play" | "stop" | "pause" | "resume";
  atHostTime?: number; // host send time + lead; host-stamped on rebroadcast
  offset: number; // playback offset into the sound (seconds)
}
```

Host → clients: broadcast with `atHostTime = hostNow + 120 ms` lead; clients
start playback at `atHostTime − clockOffset` (NTP-style offset from ping/pong).

### clock (0x25 · host → client · ops)

Host-clock broadcast for audio sync; offset refined NTP-style from ping/pong (§7).

```ts
interface ClockMsg {
  kind: "clock";
  hostTime: number;
}
```

### kick (0x26 · host → client · ops)

```ts
interface KickMsg {
  kind: "kick";
  reason: string;
}
```

### ban (0x27 · host → client · ops)

```ts
interface BanMsg {
  kind: "ban";
  reason: string;
}
```

### sim.delta (0x28 · host → client · sim)

Faction-projected binary delta; clients apply strictly sequentially (§5A). In
realtime mode frames are COALESCED: `to - from` spans every tick merged since
the last flush (e.g. 2 at 10 Hz sim / 5 Hz flush); a client that missed frames
detects the version gap and recovers via `sim.snapshot.get`. Clients smooth
motion by interpolating positions ~240 ms behind the newest state.

```ts
interface SimDeltaMsg {
  kind: "sim.delta";
  sceneId: DocId;
  from: number;
  to: number;
  bytes: Uint8Array;
}
```

### sim.snapshot (0x29 · host → client · sim)

Full compressed pool for late joiners / gap recovery (§5A).

```ts
interface SimSnapshotMsg {
  kind: "sim.snapshot";
  sceneId: DocId;
  version: number;
  bytes: Uint8Array;
}
```

### turn.phase (0x2a · host → client · ops)

Phase announcements with deadline and ready list (§5A, §13). Realtime
campaigns add the optional clock fields: `mode:"realtime"` marks the campaign,
`paused:true` rides the orders-phase frame sent on pause (the phase itself
stays `"orders"`), and `simHz` reports the current tick rate.

```ts
interface TurnPhaseMsg {
  kind: "turn.phase";
  turnId: DocId;
  phase: "orders" | "resolution" | "report";
  deadlineMs: number | null;
  readyUsers: UserId[];
  mode?: "stepwise" | "realtime";
  paused?: boolean;
  simHz?: number;
}
```

### turn.report (0x2b · host → client · sim)

The projected TurnReport — events referencing undetected units become "unknown enemy" stubs (§5A).

```ts
interface TurnReportMsg {
  kind: "turn.report";
  turnId: DocId;
  report: TurnReport;
}
```

### report.detail.page (0x2c · host → client · ops)

Response to report.detail (§11).

```ts
interface ReportDetailPageMsg {
  kind: "report.detail.page";
  turnId: DocId;
  page: number;
  totalPages: number;
  events: SimEvent[];
}
```

### heartbeat (0x40 · internal · ops)

2 s liveness probe (§6.5).

```ts
interface HeartbeatMsg {
  kind: "heartbeat";
  t: number;
}
```

### ping (0x41 · internal · ops)

Clock probe, client → host (§7).

```ts
interface PingMsg {
  kind: "ping";
  t0: number;
}
```

### pong (0x42 · internal · ops)

Clock reply; offset = ((t1−t0)+(t2−t3))/2 (§7).

```ts
interface PongMsg {
  kind: "pong";
  t0: number;
  t1: number;
  t2: number;
}
```

### relay.frame (0x43 · internal · ops · M4)

Opaque e2e-encrypted frame relayed via a connected peer (§6.3).

```ts
interface RelayFrameMsg {
  kind: "relay.frame";
  from: PeerId;
  to: PeerId;
  bytes: Uint8Array;
}
```

## Structured action records (message system payload · version 1)

An action is not a new wire message. It is a bounded, host-normalized record at
`MessageDocument.system.action`; normal projected message Ops carry it. The host forces
`action.id === message._id`, revision `0`, author identity, and host timestamps on creation. It
infers an omitted root scene from a supplied area and rejects cross-scene area claims.
Every later pending-roll transition updates the selected `system.pendingRoll` or member of
`system.pendingRolls` and the linked action target in the same envelope.

```ts
interface ActionCard {
  v: 1;
  id: string;                  // containing message id after host normalization
  revision: number;            // increments on each host-owned transition
  kind: "attack" | "cast" | "save" | "check" | "ability" | "item" | "movement" | "custom";
  label: string;
  state: "pending" | "resolved" | "partial" | "failed" | "cancelled" | "expired";
  source: { name: string; actorId?: DocId; tokenId?: DocId; itemId?: DocId };
  sceneId?: DocId;
  area?: ActionArea;
  targets: ActionTarget[];     // at most 64, unique stable keys
  notes: string[];
  createdAt: number;           // host clock
  updatedAt: number;           // host clock
}

interface ActionTarget {
  key: string;
  name: string;                // replaced from the referenced host actor/token
  label?: string;              // bounded stage description, not identity
  actorId?: DocId;
  tokenId?: DocId;
  state: "pending" | "resolved" | "skipped" | "expired";
  outcome: "pending" | "saved" | "failedSave" | "hit" | "miss" |
    "succeeded" | "failed" | "resisted" | "affected" | "unaffected" |
    "rolled" | "skipped" | "expired";
  provenance?: "host" | "reported"; // overwritten by the host
  evidence?: { adapter: string; payload: Json }; // bounded; never executable
  check?: ActionCheck;
  damage?: { dealt: number; prevented?: number };
  healing?: { applied: number };
  conditions?: { applied?: string[]; removed?: string[] };
  notes?: string[];
}
```

A pending `ActionCheck.pendingRollId` is bidirectionally linked to exactly one strictly parsed
pending roll's `{id, actionId, targetKey}`; IDs and target keys are unique within the card. The host
rejects mixed/oversized/malformed storage,
canonicalizes names, and replaces the submitted turn window with the current host turn plus the
fixed two-round expiry. Player-authored references must already be visible to that player; guessed
private IDs are never converted into canonical names. Generic client updates to action data or linked pending storage are rejected;
only host resolution/expiry may increment a revision. A host die result does not prove a submitted
modifier or DC: `pf1e.pendingSave.v1` rederives supported normal actor-cast save inputs, while an
unsupported pending check stays `reported` after its host roll or expiry.

Submitted terminal provenance is not trusted: known adapters can upgrade a row to `host` only after
rederiving it. `pf1e.spellTarget.v1` resolves immutable `system.rollEvidence` records and atomically
stamps the successful action claim back onto each roll record, rejects duplicate, same-envelope, already-claimed, or claimed-ID reuse, and rederives a single normal noncritical/non-touch PF1e target
result from host documents, requires final staged HP and fresh-SR ledger agreement, and rejects
conflicting same-envelope actor-input changes. Unsupported or mismatched evidence leaves the row
`reported`.

After a real commit the host emits a local `action:committed` event carrying the data-only
`ActionFxContext`. Every projected target includes `verified`; when false, target state/outcome/
check/damage/healing/conditions are absent. Root `state` is likewise present only when every target
is verified. The event is a presentation input, not an authorization token: FX cannot apply HP,
effects, inventory, movement, or permissions. Consumers deduplicate with `{actionId, revision}` and
branch only on verified lifecycle/mechanics. See
[ACTION_SYSTEM.md](ACTION_SYSTEM.md) and `src/core/action.ts` for the complete exact-key schema,
area/check definitions, bounds, and state invariants.

## Supporting types

Imported from the core contracts (`src/core/*.ts`): `Op`, `OpEnvelope`, `FlatDiff`,
`Json`, `AssetId`, `DocId`, `PeerId`, `TxId`, `UserId`, `WorldId`, `Role`,
`AssetManifest`, `ProjectedWorld`, `SimEvent`, `TurnReport`. Full definitions
live in those modules (§4, §4A, §5A) — see `src/core/documents.ts`,
`src/core/ops.ts`, `src/core/sim.ts`, `src/core/projection.ts`.

`Op` (§4, orders travel as ordinary intent Ops on `unit.orders`):

```ts
type Op =
  | { kind: "create"; coll: CollectionName; parent?: DocRef; data: Doc }
  | { kind: "update"; ref: DocRef; diff: FlatDiff } // dotted keys; "-=key": null deletes
  | { kind: "delete"; ref: DocRef };

interface OpEnvelope {
  seq: number;
  ts: number;
  by: UserId;
  ops: Op[];
  txId: string;
}
```

## Signaling (§6.2)

Adapters exchange opaque, authenticated codes — no relay ever sees plaintext.

```ts
type SignalMsg =
  | { t: "offer"; sdp: string } // non-trickle, pre-gathered ICE
  | { t: "answer"; sdp: string }
  | { t: "ice"; candidate: RTCIceCandidateInit }
  | { t: "leave" };

interface SignalingAdapter {
  open(roomId: string, key: CryptoKey): Promise<void>; // key = HKDF(roomSecret)
  send(to: PeerId, msg: SignalMsg): Promise<void>;
  onMessage(cb: (from: PeerId, msg: SignalMsg) => void): void;
  close(): void;
}
```

Wire code: `vtt1.<base64url(iv[12] || AES-GCM(ct({from, to?, msg})))>` (D-046).
Invite link: `<base>#room=<id>&k=<secret>[&h=<host nostr pubkey hex>]` — fragment only,
never sent to a server. `&h=` opts the joiner into Nostr signaling (kind 20_250, room tag);
without it the invite is manual copy/paste only (D-066).

### Other transports (D-052–D-054)

- **MQTT-over-WSS**: topic `vtt/<sha256(roomId)>`, QoS 0, payload = `vtt1.` code.
- **WebTorrent trackers**: WS tracker protocol, info_hash = sha1(roomId) hex;
  the code rides opaquely inside `offers[]` (broadcast) and `answer`+
  `to_peer_id` (routed once the peer is learned).
- **Generic WebSocket** (self-hosters): code frames over a user-supplied relay
  URL; rooms scoped by URL server-side.
- **Ordering**: SignalingStack tries nostr → mqtt → tracker (configurable),
  first ready wins within 8 s; Manual is always available.

### Nostr transport specifics (D-051)

Ephemeral events, kind **20250** (NIP-01 20000–29999), tag `["t", <roomId>]`,
content = the `vtt1.` code. selfId = nostr pubkey (hex). Sends fan out to every
connected relay; receivers dedupe by event id, drop unverified signatures,
never dispatch their own echoes, and honor the authenticated `to` field.
