# ROADMAP — deferred features with target milestone

Absent-by-design until their milestone (operating rule 2: no fake versions exist earlier).
Milestone assignment mirrors PLAN.md.

- [x] 3D dice (three.js, lazy Blob-URL module) — M3 (§11) [D-092]
- [x] Commit-reveal dice mode — M3 (§11) [D-093]
- [x] MQTT-over-WSS / WebTorrent tracker / generic WebSocket signaling adapters — M3 (§6.2) [D-052..D-054]
- QR code for Manual signaling — M3 polish (copy/paste ships in M1) (§6.2)
- [x] Realtime sim mode (tick loop, pause/resume/rate, interpolation) — M3 (§5A) [D-094]
- [x] TurnReport timeline animation + scrubber — M3 (§9A) [D-095]
- [x] Logistics documents + panel + forecast — M3 (§10, §12) [D-096]
- [x] Hero attachment (leaders in ranks) — M3 (§5A) [D-097]
- [x] Turn-level undo UI — M3 (§5A; OpLog machinery M1) [D-071]
- [x] After-action replay browser — M3 (§8A) [D-098]
- [x] Strategic↔tactical scene linking — M3 (§9A) [D-099]
- [x] File System Access "save to folder" — M3 (§8) [D-100]
- [x] Peer relay for unreachable players — M4 (§6.3) [D-101]
- [x] Assistant-GM failover — M4 (§6.5) [D-103]
- [x] TURN support (user credentials) — M4 (§6.3) [D-102]
- [x] Tiled maps > 4096 px — M4 (§7)
- [x] Voice/video mesh ≤ 6 — M4 (§1) [D-104]
- [x] PWA install — M4 (§19)
- [x] 100k-model stress + delta tuning — M4 (§19)
- wasm build of hot RulesModule paths / vision math — M4 optional (§12, §9)
- Fonts subsetting, wasm base64 inlining — as soon as real fonts/wasm enter the bundle (§15)
- [x] Firefox/WebKit Playwright projects — from M2 acceptance (matrix §15) [D-082]

## Post-M1 carry-overs (from Unit 20 review)

- Scene asset "mid" LOD tier between thumbnail and full (§7); external-URL asset alternative.
- Sidebar tabs beyond Chat + sheets (Scenes/Actors/Items/Settings as tabs, scene navigation,
  player list) — full §10 list; GM join-approval dialog + ban list UI (auto-approve covers M1).
- JoinApp: hide the manual code panel automatically once transportKind()==="nostr" connects.
- Public-relay smoke (damus/nos.lol) as an optional, non-CI e2e; CI keeps the local relay.

## World-file follow-ups (after D-248/D-249 — `WorldFile_Packaging_Proposal.md`)

- Simulate more than one strategic scene at a time (SimBridge/TurnChannel still bind to
  `DEFAULT_SCENE_ID`); the ruleset pin already looks at every scene's checkpoints.
- Per-scene ruleset override (a world carries one strategic ruleset today; §9 open question).
- Starter worlds with seed content (pre-placed factions/armies on a strategic scene) — the
  D-249 starters are documents-empty and self-seed like a new world.
- Retire the in-world **Activate** button once every campaign starts through the wizard or a
  starter (kept for fresh campaigns for now; see D-249).

## Fog follow-ups (after D-250 / D-251 — explored fog of war, token gating)

- Sight bounded by darkness and light sources (today: walls, doors and the optional range in
  squares only; a token sees through darkness).
- Replica-level token gating: today fog hides out-of-sight tokens on the player's canvas
  (D-251, client-side — the position still reaches the player's replica, so a tampered client
  could read it); a host-side projection that withholds a token until it enters a player's
  sight needs the host to run each player's vision (or trust the player's fog.put map).
- Map features above the fog layer (notes, effects) are not gated by sight; drawings, tiles,
  templates and the background sit under the cover and are.
- GM "view as player" for explored fog (the GM's cover is the union of every vision token;
  a per-player preview would request that player's stored map through a GM-only fog.get).
- Fog reset / reveal-all / hide-all brushes for the GM (today: switch fog off and on again to
  start over, or wait for tokens to uncover it).

