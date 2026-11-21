# Strategic mode: the full VTT at formation scale

> **Non-negotiable product principle:** **Strategic mode should be the full VTT operating at
> formation scale, not a reduced battle service.**

This principle governs hosted authority, campaign launch, rules integration, document projection,
UI, testing, and migration work. Current pilot limitations are implementation gaps to remove; they
must not be promoted into permanent product boundaries.

## 1. One VTT, two scales

Strategic mode is another scale of the same campaign and PF1e game. A battle remains connected to
its source scene and relevant campaign graph. The hosted service may use different storage,
projection, and resolution adapters for durability and scale, but it must not fork gameplay meaning.

Shared authoritative concepts include:

- scenes, maps, tokens, actors, armies, units, items, inventories, spellbooks, and resources;
- conditions, active effects, initiative, actions, reactions, saves, attacks of opportunity, and
  measured or persistent spell areas;
- walls, doors, terrain, elevation, floors, lighting, vision, fog policy, and targeting;
- journals, roll tables, macros, playlists, authored FX, assets, and compendium-derived content;
- ownership, unit-control grants, private information, chat/action cards, dice provenance, and
  reversible/auditable mutations.

“Supported in strategic mode” means the same authored object and rules definition works through a
formation-scale adapter. It does not mean a separately re-authored strategic approximation unless a
reviewed PF1e scale rule explicitly requires one.

## 2. Authoritative documents plus a high-density projection

The `ModelPool` is an acceleration and checkpoint representation, not an alternative campaign
world. Its rows derive from authoritative campaign documents and retain stable provenance back to
participating armies, units, actors/profiles, items, effects, and scene geometry.

```text
Relevant campaign document graph
              |
      validated battle projection
        /                     \
full document references   dense ModelPool/checkpoint
        \                     /
       one authoritative hosted battle
              |
 audited campaign reconciliation/write-back
```

A formation can use compact rows for tens of thousands of models without turning its caster,
weapon, condition, wall interaction, or campaign consequence into unrelated data.

## 3. Why hosted authority still exists

The Node/PostgreSQL authority supplies durability, reconnects, explicit grants, simultaneous private
orders, filtered views, deterministic freeze/retry, and efficient large-state publication. These are
transport and authority responsibilities—not a license to reduce the VTT rules or content model.

The service receives a signed, versioned, least-privilege projection of every **relevant** referenced
document and asset. Least privilege means omit unrelated private campaign material and filter player
views; it does not mean discard walls, actors, items, spells, effects, templates, or other data that
the battle actually uses.

Arbitrary executable code is a distinct trust boundary. Macros and package automation require a
versioned capability/sandbox policy, but strategic mode still needs to support their authored intent
through vetted shared rules and FX bindings rather than silently ignoring them.

## 4. Shared rules, scale-specific adapters

Rules/content are shared; target enumeration and storage can differ:

```text
regular PF1e Entangle item + caster + slot + ActionArea
                         |
                 shared validated cast
                  /                    \
tactical token/actor adapter    strategic model/formation adapter
```

Both adapters must agree on spell identity, range, shape, radius, duration, DC, saves, conditions,
movement effects, expiry, resources, provenance, and FX. Strategic resolution may fan one effect out
over thousands of models and serialize it in a frozen checkpoint, but it may not invent a second
“strategic Entangle.” The same rule applies to attacks, reactions, terrain, doors, vision, active
effects, items, and future systems.

## 5. Battle projection contract

A launch/freeze must version and sign the transitive, battle-relevant graph, including as applicable:

- source scene revision, grid, bounds, background, walls, doors, floors, terrain, light/vision and
  persistent templates/regions;
- participating faction/army/unit documents and stable source references;
- referenced actor/profile statistics, items, attacks, spellbooks, slots/resources, conditions and
  active effects;
- selected journals, roll tables, playlists, macros, FX bindings, packages and assets required by
  enabled battle behavior;
- ownership, commander membership, unit grants, visibility policy, turn state, pending reactions,
  rules/package versions, seed, and compact model checkpoint.

Every projection field needs validation, size limits, provenance, visibility policy, and versioning.
Unsupported relevant content must produce a named launch/order refusal—not be omitted while the UI
implies that the battle preserved it.

## 6. Live synchronization and reconciliation

Campaign launch is not a one-way lossy import. The design must support controlled synchronization:

1. Freeze source revisions and dependencies at launch or at a documented transactional boundary.
2. Resolve against those exact revisions and record mutations with source/action provenance.
3. Publish permission-filtered live views while retaining complete authoritative state.
4. Synchronize approved in-battle edits and effects through explicit commands and conflict checks.
5. Finish with a GM-visible reconciliation preview of casualties, resources, effects, movement, and
   other campaign mutations.
6. Apply accepted results as one auditable, undoable campaign transaction; never silently overwrite
   newer campaign edits.

Until reconciliation is implemented, aggregate-only finish behavior is a clearly reported pilot gap,
not the intended final workflow.

## 7. UX requirements

Players should use the same conceptual VTT controls at either scale. Strategic UI may aggregate,
LOD, batch, or formation-target operations, but ordinary capabilities remain discoverable:

- actor/unit selection exposes applicable items, spells, actions, reactions, resources and effects;
- measured areas and authored FX render over the strategic scene at correct scale;
- doors, walls, floors, terrain, light and vision affect both presentation and authority;
- actions produce the same action-card, roll-provenance, save, condition, and resource evidence;
- unsupported capabilities are visibly disabled with an exact reason.

## 8. Acceptance gates

A strategic release is not “full VTT” merely because it can import a background and unit anchors.
Capability tests must launch authored campaign content and prove, through real browser identities and
the hosted authority:

- document/resource provenance and authorization;
- scene geometry, walls/doors/floors, terrain, lighting/vision and templates;
- ordinary PF1e items/spells (including Entangle) without strategic re-authoring;
- conditions, active effects, saves, reactions, attacks, movement and hazard avoidance;
- authored FX/assets and relevant campaign content;
- deterministic retry/restart and filtered reconnect views;
- conflict-aware, auditable campaign reconciliation.

Performance qualification must include these enabled features. A schematic or generated-room load
test is useful infrastructure evidence but cannot qualify the product workflow.

## 9. Current pilot status

The current hosted room is a narrow vertical slice. Its allowlisted scenario, standardized profiles,
limited order vocabulary, omitted scene graph, and aggregate-only finish are known gaps against this
design. Keep their operational documentation accurate, but do not describe them as deliberate final
scope. New work should shrink these gaps by extending the shared projection and adapters, not by
adding parallel strategic-only rules or content.
