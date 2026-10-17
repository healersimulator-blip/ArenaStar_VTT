# ArenaStar — UI implementation and rework guide

**Version:** 1.0 · **Date:** 2026-10-18  
**Status:** implementation requirements and review standard; not a claim that the current UI complies.  
**Primary references:** Foundry VTT V14 and Roll20.  
**Applies to:** native tabletop, character sheets, automation, strategic mode and compatible module interfaces.

> A mechanic is not a usable feature until a player can find it, understand it,
> perform it, abandon it safely, and understand or reverse its result.

## Contents

1. Product priorities and non-negotiable rules
2. Reference patterns: what to adopt and what not to copy
3. Shared workspace and visual system
4. Interaction sessions, targeting and cancellation
5. Character sheets and common action options
6. Compendium, sharing and FX Wizard
7. Results, automation and Revert
8. Strategic-mode interactions
9. Accessibility, input and performance
10. Implementation architecture and repository seams
11. Rework sequence and acceptance gates
12. Agent task template and release checklist

## 1. Product priorities and non-negotiable rules

Preserve this order when requirements conflict:

1. Lightweight tabletop with extensive automation and dependable Undo/Revert.
2. Strategic play with large units and explainable, bounded autonomous behavior.
3. Compatibility with Foundry modules.

**MUST** is a release requirement for the affected workflow. **SHOULD** is the
normal approach; a departure needs a recorded reason. **MAY** is optional.
Requirements below are ArenaStar decisions unless explicitly attributed to a
reference product. They are not assertions that either reference implements
ArenaStar's automation or action-Revert guarantees.

### Non-negotiable rules

- **MUST:** every uncommitted interaction has a visible exit and a keyboard exit.
- **MUST:** make current tool, acting entity, selected targets and pending state clear.
- **MUST:** distinguish selection, targeting, ownership and visibility.
- **MUST:** explain disabled actions and rejected requests in player language.
- **MUST:** distinguish Cancel, Stop presentation, Undo and committed-action Revert.
- **MUST:** preserve permissions and hidden information in every UI projection.
- **MUST:** provide a discoverable ordinary-control path; shortcuts are accelerators.
- **MUST:** show partial/manual automation honestly. A label is not proof of a workflow.
- **MUST NOT:** require console commands, JSON editing or GM scripts for routine supported play.
- **MUST NOT:** make a UI button invoke a second, competing rules engine.
- **SHOULD:** use established VTT conventions rather than inventing a new interaction per feature.

## 2. Reference patterns: what to adopt and what not to copy

Reference snapshot: 2026-10-18. General help pages may describe multiple versions;
release notes establish V14-specific changes. Do not infer system-module behavior
from Foundry core documentation or treat an optional module as a built-in feature.

| Documented reference | ArenaStar interpretation | Boundary |
|---|---|---|
| Foundry distinguishes token selection and targeting in its token tools. [9](https://foundryvtt.com/article/tokens/) | Different outlines/badges and commands for controlled tokens and action targets. | Selected is not automatically targeted or authorized. |
| Foundry V14 provides a layer-sensitive Placeables sidebar and a bulk-edit palette for non-token placeables. [6](https://foundryvtt.com/releases/14.359) | Discover objects through both canvas and searchable lists; provide mixed-value batch editing. | Do not claim V14's palette includes token bulk editing. |
| Foundry V14 adds native application pop-outs. [6](https://foundryvtt.com/releases/14.359) | Resizable sheets and remembered layouts; optional pop-outs after reliable in-window behavior. | Browser permission, focus and reconnect require fallback handling. |
| Foundry V14 replaces Measured Template documents with region-based templates, including richer region behavior and token attachment. [6](https://foundryvtt.com/releases/14.359) | Present areas as inspectable persistent objects with ownership and lifecycle. | ArenaStar need not adopt Foundry's document format or call the old template document a V14 API. |
| Roll20 exposes Select, Measure and other tools through a persistent toolbar. [4](https://help.roll20.net/hc/en-us/articles/360039674753-Toolbar-Overview) | A stable tool rail with visible active state and local options. | Do not reproduce every tool in a crowded permanent toolbar. |
| Roll20 documents measuring movement, waypoints, and measurement visibility choices. [3](https://help.roll20.net/hc/en-us/articles/360039674913-Measure-Tool) | Movement preview with distance/cost and explicit audience. | Native legality and path cost still come from the active rules provider. |
| Roll20 offers character-associated Token Actions and a macro quick bar. [1](https://help.roll20.net/hc/en-us/articles/360037256794-Macros-Token-Actions) | Contextual actions and favorites accessible without opening a whole sheet. | Normal attacks/spells must not require macro programming. |
| Roll20 permits controlled characters to be dragged from the Journal to create their default tokens. [3](https://help.roll20.net/hc/en-us/articles/360039675133-Journal) | Direct content-to-table placement plus an equivalent explicit Add/Place command. | Dragging must not bypass ownership or silently change source content. |
| Foundry and Roll20 document canvas keyboard shortcuts, including canvas Undo. [11](https://foundryvtt.com/article/controls/) [1](https://help.roll20.net/hc/en-us/articles/360039675393-Hotkeys) | Provide documented, remappable accelerators with focus-sensitive Undo. | Canvas Undo is not evidence of complete reversible game actions. |

Adopt workflow conventions, not branding, proprietary artwork or a pixel copy.
Code/assets require separate license review. Do not treat independently designed
UI as evidence that a formal clean-room process has occurred.

### Patterns not to import uncritically

- Shortcut-only access to common operations.
- Unbounded floating-window stacks.
- Cryptic icon-only controls or tiny condition menus.
- A separate dialog for every modifier or target.
- Advanced scripting as the default route to ordinary play.
- Copying conflicting shortcuts from both references simultaneously.

## 3. Shared workspace and visual system

### 3.1 Stable workspace

Use a consistent shell with five recognizable areas:

```text
[Scene / level / play mode]                    [Connection / help]
[Tool rail]       Canvas: the main workspace       [Right dock]
                  [Selection / token HUD]          Chat | Combat
                                                  Actors | Library
                                                  History | Scene
       [Context action bar]  [Targeting / order confirmation]
```

- The canvas is the primary work area; never cover its active target with a modal.
- Keep tool placement and meaning stable between scenes and users.
- Distinguish **Play** and **Scene edit** contexts. Players must not encounter
  irrelevant wall/light/configuration controls during normal play.
- Distinguish **Tactical** and **Strategic** modes visibly. Changing mode must
  end or explicitly resolve any incompatible interaction session.
- Make scene, level/elevation context, grid units and active rules mode discoverable.
- Right-dock tabs remember state per user. They do not silently switch away from
  a draft, pending roll or result the user is reading.
- Fit common actions in the contextual bar; expose the full list through a named
  More actions control. Do not hide Cancel in overflow.

### 3.2 Shared components and visual rules

Use shared buttons, fields, menus, dialogs, tabs, status badges, list rows and
confirmation bars. Reuse existing components where suitable; select one shared
component strategy rather than adding a new UI library per subsystem.

Proposed design targets:

- A 4 px spacing base; consistent 8/12/16/24 px spacing tokens.
- Body text normally 14–16 px; clear headings, readable labels and consistent units.
- Common pointer controls at least 32 px high; larger touch targets when supported.
- Text contrast at least 4.5:1 for normal text and 3:1 for large text; visible
  focus indicators and non-text state contrast. These are acceptance targets,
  not a claim of existing accessibility conformance.
- One primary action per local task. Destructive actions are spatially separated.
- Color reinforces text/icon/shape; it is never the only way to identify a state.
- Use explicit labels such as **Cast**, **Choose targets**, **Cancel**, **Revert action**.
  Avoid repeated **Apply**, **Execute**, **Submit** with unclear objects.
- Tooltips explain shortcuts and consequences, not essential information absent elsewhere.
- Preserve layout under localization, long names and large values.

Build a component/state gallery before changing many screens. Review default,
hover, focus, disabled-with-reason, loading, error, empty and success states.
A dark theme alone is not visual quality.

### 3.3 Windows

Sheets SHOULD be resizable, constrain themselves to the viewport, remember user
layout and offer an obvious close button. Restore focus to the invoking control.
Use modal dialogs only when background interaction genuinely must stop. Prefer a
nonmodal sheet, inspector or inline expander for reference and common editing.

Pop-outs are optional enhancement work, not a prerequisite for fixing trapped
input, inaccessible controls or unusable sheet layouts.

## 4. Interaction sessions, targeting and cancellation

### 4.1 One owner per exclusive canvas interaction

Use one interaction-session service for targeting, movement preview, measurement,
area placement and strategic orders. Do not implement these as independent global
booleans that can all capture the canvas simultaneously.

Proposed session contract, not an existing API:

```ts
interface InteractionSession {
  id: string;
  kind: "target" | "move" | "measure" | "placeArea" | "order";
  phase: "preview" | "validating" | "awaitingCommit";
  ownerRef: string;
  previousTool: string;
  cancel(reason: string): void;
  dispose(): void;
}
```

The service owns pointer capture, cursor, overlays, shortcuts, listeners and
focus restoration. Cleanup is idempotent and executes on replacement, unmount,
scene change, relevant permission loss and disconnect. Pan/zoom can be temporary
sub-interactions without silently abandoning the active targeting preview.

### 4.2 Cancellation contract

| State/event | Required behavior |
|---|---|
| Preview active | Persistent visible Cancel and on-screen Escape hint. |
| Escape | Close the most local dismissible UI first; if none consumes it, cancel the active preview. One press must not trigger multiple unrelated exits. |
| Cancel before submission | Remove preview, restore tool/focus, retain resources and authoritative state. |
| Clear targets | Empty the target set but remain in targeting; distinct from Cancel. |
| Replace spell/tool | End or explicitly replace the prior session; never leave its cursor/listeners behind. |
| Confirmation already sent | Show authoritative pending status; do not pretend local dismissal cancels a possibly committed action. |
| Confirmed action | Use explicit Revert where allowed. Closing its card is not Revert. |
| Scene switch/disconnect | Dispose local preview. On reconnect reconcile submitted action status by request ID rather than resubmitting. |

Ordinary preview cancellation needs no confirmation modal. Unsaved authored
content, such as a changed FX timeline, can require a discard decision.
Right-click behavior must be consistent with panning/waypoint menus; it MUST NOT
be the only cancel route.

### 4.3 Standard casting flow

1. Choose an owned caster and a spell from sheet or contextual actions.
2. Show derived range, cost, save/DC and relevant options without requesting
   values already known to the rules engine.
3. Enter targeting. Mark source, eligible/selected targets, area and invalid
   locations distinctly. Show reasons the user is allowed to know.
4. Permit retargeting, repositioning, pan/zoom, Clear targets and Cancel.
5. Confirm explicitly with a meaningful button such as **Cast Entangle — 1 slot**.
6. Show pending resolution, per-target outcomes and owned effects.
7. Expose applicable follow-up actions and history/Revert status.

Example confirmation bar (proposed):

```text
Entangle · Valtiel · 2 selected · 40-ft area · Cost: 1 prepared use
[Clear targets] [Cancel · Esc]                         [Cast Entangle]
```

Do not disclose hidden targets or private statistics in counts/tooltips.
Changing selection must not silently change the declared caster. Revalidate
resources, permissions and target legality on the host at confirmation.

### 4.4 Selection and movement

- Clicking an owned token selects it; action targeting is explicitly separate.
- Multiple selections show count and scope; destructive batch operations name
  the affected scope. Inspecting an unowned token never grants control.
- Preview movement distance, rule cost and illegal segments. Waypoints are
  editable; cancellation restores the original position before commitment.
- Measurement has an explicit audience setting. Private planning is not broadcast
  merely because an overlay exists.
- Define snap behavior in tool options, with temporary modifier hints where useful.

## 5. Character sheets and common action options

### 5.1 Organize around play, not storage fields

Default sheet hierarchy:

- **Summary:** HP/resources, defenses, initiative, active conditions, urgent issues.
- **Actions:** attacks, abilities and common checks with relevant costs/status.
- **Spells:** search, level/book filters, preparation/uses, cast and details.
- **Inventory:** equipment, quantities, charges and equipped state.
- **Details:** progression and less-frequent configuration.

The exact system can extend this, but raw schema keys are not navigation labels.
Do not turn every data category into another permanent tab.

A spell/action row MUST distinguish available, exhausted, blocked, unsupported and
pending states. Explain why casting is unavailable. Keep commonly referenced
numbers visible without opening multiple accordions. Separate rules text from
editable configuration.

### 5.2 Options inventory before implementation

For each action family, document supported options and their UI location. For a
PF1 spell, investigate preparation/book, casting variant, caster-level adjustments,
metamagic where supported, target/area choice, save behavior, resistance, resource
cost, visibility and FX. This is an inventory requirement, not an assertion that
all these mechanics currently exist.

- Put frequent choices next to the action; put rare overrides under **Advanced**.
- Show derived values as read-only facts with an explanation/breakdown.
- Permission-check overrides and make them explicit in the result/history.
- Never silently drop an option because the current form has no field for it.
- If a mechanic is unsupported, show the supported manual resolution path and
  what it will not automate. Do not add a fake toggle that does nothing.

## 6. Compendium, sharing and FX Wizard

### 6.1 Library and importing

Provide search, useful type/source filters, previews and an **Add to character**
command alongside drag-and-drop. Report destination, duplicates, permission
requirements and unsupported mechanics. Preserve provenance and stable source
identity separately from the owned item ID.

Display capability honestly: **reference only**, **partial automation**, or
**supported automation**, with details. Import success does not prove gameplay
support. A player must be able to use shared supported content without replacing
GM actor IDs in a script.

### 6.2 GM publication

Give the GM a clear **Share / Publish** workflow naming who can discover, use,
edit and view each artifact. Show a player-perspective preview where feasible;
validate with an actual player session during acceptance. Avoid "shared" as one
ambiguous permission bit.

Published ability/FX associations must resolve through source identity, not only
spell names or a demonstration world's actor/item IDs. Never grant broad enemy
ownership to make a cast succeed.

### 6.3 FX Wizard

The Wizard MUST separate:

1. **Appearance:** art/text/particles/audio and timing.
2. **Anchors:** caster, target, area, projectile path or persistent effect.
3. **Trigger phase:** targeting preview, committed cast, target outcome, effect
   start/end. These are required design phases, not a claim that all are presently supported.
4. **Binding and audience:** which supported ability/source and who may use/see it.

Provide a non-mechanical **Preview**, an explicit **Save**, and visible dirty state.
Explain missing assets and permission problems at the field that caused them.
Previewing FX must not spend a slot, create a mechanical condition or publish
private GM content. Closing preview stops its temporary visuals/audio.

The targeting reticule is presentation over rules-owned geometry. The Wizard
does not decide area membership, saves or damage. FX failures do not reverse a
valid mechanical cast. Persistent FX follows durable effect ownership and can
be reconciled after reload.

## 7. Results, automation and Revert

### 7.1 Action results

A useful result card answers **who did what, to whom, what happened, what was
spent, and what can happen next**. Show per-target outcomes without requiring
chat-prose interpretation. Separate **pending**, **resolved**, **partially resolved**,
**failed**, **cancelled** and **reverted** states.

Include source and breakdown on demand. Expose context-valid follow-ups such as
roll a pending save, inspect effect, dismiss an owned area or request Revert.
Avoid another Apply button if the result has already been applied.

### 7.2 Undo is focus- and scope-sensitive

- Text-field Undo edits text; it does not revert a spell.
- A canvas edit Undo names the edit being reversed.
- Game-action Revert acts on an identified action and its captured changes.
- Strategic rewind names the affected turn/tick boundary and consequences.

A player's interface may offer **Request Revert** when only the GM is authorized.
Do not show an enabled Revert that the host will always reject for that role.

Before an authorized Revert, summarize scope and warn about meaningful effects.
If later changes conflict, show an actionable explanation, not a raw receipt
hash. Never approximate Revert with inverse healing or whole-actor replacement.
Retain history marked reverted; replay/redo must not silently reroll results.
Already disclosed information and already heard sound cannot be undone.

## 8. Strategic-mode interactions

Use the same selection/preview/confirm/cancel grammar as tactical play, with
unit-scale controls rather than a character sheet repeated for every model.

The unit inspector SHOULD show strength, cohesion/morale where supported,
formation, current order, standing behavior and a concise **Why this behavior?**
explanation. Show issued orders separately from autonomous decisions.

- Orders preview path, frontage/formation or target scope before commitment.
- Batch orders identify recipients and report units unable to comply.
- Expose explicit Pause/resume and resolution state; animations do not advance
  simulation time by themselves.
- Standing policies are bounded, understandable choices, not an opaque AI switch.
- Allow inspection of known hazards and policy reasons without leaking hidden hazards.
- Reformation, movement and escape share budgets and collision constraints;
  don't present each as an independent free action.
- Large-unit selections use aggregated summaries with drill-down; do not open
  hundreds of windows or emit one UI notification per model.
- Label strategic resolution mode if it uses approximations rather than exact
  per-model tactical semantics.
- Rewind restores the coordinated simulation/document state, not only animation.

## 9. Accessibility, input and performance

### Keyboard/focus

- Every ordinary workflow has a keyboard-operable route and visible focus.
- Handle shortcuts only when their command owns the current context. Respect
  text inputs, contenteditable fields, IME composition and browser-reserved behavior.
- Use Escape's local dismissal hierarchy; never let one event also deselect,
  close a sheet and open a global menu.
- Enter confirms only the focused/clearly active action. Opening a popup must
  not accidentally cast through a default Enter binding.
- Publish shortcuts in a searchable help view; allow remapping and conflict checks.
- Do not copy Ctrl+S as a mandatory canvas shortcut simply because another VTT uses it.

### Layout and feedback

Required review configurations: 1366×768 laptop, 1920×1080 desktop and 200% zoom.
Record supported minimum viewport behavior. Collapse optional chrome rather than
clipping Cancel, primary actions or sheet close controls. Dragging has an explicit
non-drag alternative. Canvas targeting needs keyboard-operable list/coordinate
alternatives where required by the supported interaction model.

Announce important pending/error/result states accessibly. Reduced-motion and
FX/audio controls must not remove mechanical outcome information.

### Lightweight execution

Use immediate local feedback while distinguishing it from host acknowledgement.
Set numerical budgets on named hardware/workloads before claiming performance
success. Suggested initial product target: p95 local selection/hover/typing
feedback within 100 ms; host/network resolution is measured separately.

Virtualize large lists, bound event streams, reuse overlays and avoid full-sheet
rerenders for pointer movement. Load compatible-module runtimes and large assets
on demand where feasible. Input cancellation and the main canvas must remain
responsive during FX and strategic resolution. Profile real workloads; do not
infer performance from code size or a screenshot.

## 10. Implementation architecture and repository seams

These are integration points, not authorization to rewrite everything:

| Existing area | Rework direction |
|---|---|
| `src/ui/sheets/PF1eActorSheet.svelte`, `PF1eSheetWindow.svelte` | Task-first layout, shared fields/states, focus and window lifecycle. |
| `src/ui/sheets/pf1eCastFlow.ts` | Extract authoritative orchestration; do not grow UI-owned rule/write sequencing. |
| `src/packages/pf1e/areaPreview.ts`, `targeting.ts` | Reuse rule geometry behind shared interaction sessions. |
| `src/core/action.ts`, `actionRevert.ts` | Present structured states and real Revert capabilities. |
| `src/core/fxBinding.ts` and FX Wizard consumers | Explicit phase/identity/capability contracts; no invented trigger guarantees. |
| `src/core/rules.ts`, `src/sim/runner.ts`, `src/host/simBridge.ts` | Preserve worker/batch boundaries and coordinated rewind. |
| AIS/Foundry adapter and compatible applications | Optional provider; expose tested capabilities and lifecycle cleanup. |

Keep boundaries explicit:

```text
UI view -> interaction/application controller -> authenticated intent
       -> host validation/rules -> committed result/history
       -> audience-safe view model -> UI + native FX
```

UI state belongs to the session/view; mechanical state belongs to the host.
Views must not fix missing mechanics by directly changing actor fields. Module
sheets need an explicit provider/presentation adapter; rendering their markup is
not evidence they can control native state safely.

## 11. Rework sequence and acceptance gates

### 11.1 Audit before broad redesign

Inventory the top workflows in the current build. For each record entry point,
steps, missing options, hidden states, cancellation, recovery, role and existing
tests. Classify findings:

- **P0:** trapped interaction; wrong actor/target; unauthorized disclosure/write;
  duplicate resource spend; misleading Revert; unrecoverable progress loss.
- **P1:** common task/options unavailable or undiscoverable; inaccessible controls;
  unclear pending/error state.
- **P2:** repeated friction, excessive steps, poor density/consistency.
- **P3:** cosmetic refinement after task completion is reliable.

### 11.2 Implement vertical slices

1. Shared session ownership, Cancel/Escape and component state gallery.
2. Character → spell → targeting → cancel/retry → results → Revert.
3. Selection → move/measure → cancel/commit → history.
4. GM share → player import/use → published FX → multiplayer results.
5. Unit → order → autonomous resolution → pause/inspect → rewind.

Review one representative layout before applying it to many screens. Preserve
working behavior and existing tests during migration; do not replace a native
spec with an unrelated compatibility test under the same filename.

### 11.3 Mandatory test matrix for an affected workflow

| Case | Observable requirement |
|---|---|
| Happy path | Ordinary controls complete the declared task. |
| Cancel | Visible Cancel and Escape remove previews and spend nothing. |
| Clear/retarget | Works without corrupting caster or retaining stale targets. |
| Context switch | Scene/tool/actor changes leave no trapped input or orphan overlays. |
| Pending/disconnect | State reconciles; retry does not duplicate the action. |
| Resources/permissions | Exhaustion and denial are understandable and authoritative. |
| Two targets | Distinct pass/fail outcomes and correct effect ownership. |
| Player session | GM sharing works without privileged console/script intervention. |
| Missing FX asset | Mechanical result remains correct and error is useful. |
| Revert | Real state restored or conflict safely explained; no inverse-healing substitute. |
| Keyboard/layout | Focus, Escape, zoom and required viewports remain usable. |
| Large-unit case | Input responsive; bounded updates and correct rewind scope. |

Use API helpers for setup or deterministic inputs where needed, not to perform
the user interaction whose UI is under test. Mock/native/real-module tests remain
separate evidence. A deterministic save input is not proof that a visible save
control exists. Assert meaningful user-visible state with accessible locators;
inspect authoritative state additionally for mechanical correctness.

Screenshots must cover relevant states, not just the final canvas. Automated
visual diffs protect an approved layout; they do not establish that an unreviewed
layout is usable. Require a human walkthrough with no console and no developer
coaching before closing a substantial UI milestone. If not performed, record that
gate as pending rather than claiming completion.

## 12. Agent task template and release checklist

### Copy into each UI implementation task

```text
User/role:
Task and entry point:
Supported rules/provider and capability limits:
Approved layout/reference patterns:
Acting entity vs selection vs targets:
Required ordinary controls and options:
Preview/commit/pending/result states:
Cancel, Escape and context-change behavior:
Permissions and information visibility:
Error, empty, loading and reconnect states:
Undo/Revert scope:
Keyboard, focus, viewport and performance requirements:
Existing behavior/tests that must remain:
Browser acceptance steps and evidence:
Human review status:
Explicitly unsupported behavior:
```

### Definition of done

- [ ] Task is discoverable without developer instructions.
- [ ] Common options are present; unsupported mechanics are disclosed.
- [ ] Preview has visible Cancel and correct Escape cleanup.
- [ ] Caster, targets, cost and commitment state are unambiguous.
- [ ] No direct UI workaround bypasses host authority.
- [ ] Ordinary player controls, not console calls, prove the workflow.
- [ ] Error, pending, duplicate-request and disconnect paths are covered.
- [ ] Real Revert/rewind behavior matches the UI's promise.
- [ ] Required viewports, focus and keyboard paths have been reviewed.
- [ ] Performance measured where affected; compatibility cost remains optional.
- [ ] Tests and approved-state screenshots preserved/updated intentionally.
- [ ] Human usability review passed, or milestone explicitly remains incomplete.

**Do not close a UI task because the mechanics test passed, the screenshot looks
attractive, or every schema field has a form input. Close it when the specified
person can complete, abandon and recover the task through the shipped interface.**
