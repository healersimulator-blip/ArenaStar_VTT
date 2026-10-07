# ArenaStar FX Authoring Skill

Use this guide when creating a saved visual FX timeline and binding it to a PF1e spell or action.

## Model

ArenaStar FX timelines are **world-stored, validated sequence macros**, not arbitrary JavaScript. They render visuals/audio/camera cues; they do not apply damage, conditions, inventory changes, or other game mechanics. After a PF1e cast, item use, or item-backed attack resolves, the action flow requests its bound timeline; the host then rechecks timeline access and invocation rights before projecting playback. The binding itself grants no access or mechanics.

## Create and test a timeline

1. As a GM or assistant, open **Macros → FX timelines** and choose **New**.
2. Name the timeline and choose its scene and optional source/target tokens. Set its playback **Audience** (`scene`, `caller`, `gm`, `others`, or chosen players).
3. Add one or more **Text**, **Image/video**, **Sound**, **Camera**, or **Wait** sections. Set timing, anchors, and supported visual/audio options. Use **Preview on canvas** for a local-only, non-mutating check; use **Run saved** to test the committed timeline.
4. Save the timeline before attaching it.

Use media only when permitted. The rights to **serve media to players** and to **include it in a world archive** are separate declarations; neither follows from having a local copy.

## Bind to spells

- As a GM or assistant, click **+ FX** beside a prepared spell (or **+ FX for …** beside the named spell in the cast form). Choose a saved timeline, set timeline visibility and whether published players may invoke it, then attach.
- Alternatively, edit a saved timeline in the FX wizard. Select a tactical-effect catalogue spell or enter the exact world/compendium spell name; an optional failed-cast cue can be assigned there.
- Binding uses a canonical catalogue ID or an exact normalized spell-name key—not a fuzzy display-name guess. The same binding is used by PF1e quickbar casts; a spell outside the tactical-effect catalogue still needs a caller-reviewed save/damage profile when adding it to the quickbar. That mechanical profile is separate from FX.

## Bind to items and weapon attacks

- From an item window, attach a cue to the relevant supported item event (such as use).
- Weapon attack cues bind to an **item-backed attack line**. If **+ FX** is disabled, first link the attack line to its weapon item in the actor’s Items/Attack editor; then attach from the attack row or the FX wizard’s actor/item binding controls.
- Choose any failure cue and event/recognition settings in the wizard. Do not bind a cue to a class feature unless that feature has a stable action identity and activation hook; that integration is not currently available.

## Keep the permissions distinct

- **Definition visibility:** document ownership/read access.
- **Player invocation:** the separate “allow published players to trigger” setting.
- **Playback Audience:** who sees/hears a particular run; a callable timeline can still be GM-only playback.
- **Media permissions:** who may receive the bytes and whether they may be exported.

Do not treat one of these choices as granting another. FX is presentation only; PF1e mechanics remain on their authoritative action flow.

## Current gaps

- A cast waiting on a player-owned save or multi-round completion has no deferred “play after final resolution” hook yet. Pending or refused actions must not play either branch; use the binding on resolved outcomes only.
- Direct bindings cover PF1e spell names, item **use**, and item-backed **attack** events. Class features without a stable action identity and activation hook cannot be bound yet.
- This is the supported saved-timeline slice, not full Sequencer/Macros parity. See [the parity spec](MACROS_FX_WIZARD_PARITY_SPEC.md) and [implementation status](MACROS_FX_WIZARD_IMPLEMENTATION_STATUS.md) for broader features and open gaps.
