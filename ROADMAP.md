# ROADMAP — deferred features with target milestone

Absent-by-design until their milestone (operating rule 2: no fake versions exist earlier).
Milestone assignment mirrors PLAN.md.

- 3D dice (three.js, lazy Blob-URL module) — M3 (§11)
- Commit-reveal dice mode — M3 (§11)
- MQTT-over-WSS / WebTorrent tracker / generic WebSocket signaling adapters — M3 (§6.2)
- QR code for Manual signaling — M3 polish (copy/paste ships in M1) (§6.2)
- Realtime sim mode (tick loop, pause/resume/rate, interpolation) — M3 (§5A)
- TurnReport timeline animation + scrubber — M3 (§9A)
- Logistics documents + panel + forecast — M3 (§10, §12)
- Hero attachment (leaders in ranks) — M3 (§5A)
- Turn-level undo UI — M3 (§5A; OpLog machinery M1)
- After-action replay browser — M3 (§8A)
- Strategic↔tactical scene linking — M3 (§9A)
- File System Access "save to folder" — M3 (§8)
- Peer relay for unreachable players — M4 (§6.3)
- Assistant-GM failover — M4 (§6.5)
- TURN support (user credentials) — M4 (§6.3)
- Tiled maps > 4096 px — M4 (§7)
- Voice/video mesh ≤ 6 — M4 (§1)
- PWA install — M4 (§19)
- 100k-model stress + delta tuning — M4 (§19)
- wasm build of hot RulesModule paths / vision math — M4 optional (§12, §9)
- Fonts subsetting, wasm base64 inlining — as soon as real fonts/wasm enter the bundle (§15)
- Firefox/WebKit Playwright projects — from M2 acceptance (matrix §15)

## Post-M1 carry-overs (from Unit 20 review)

- Scene asset "mid" LOD tier between thumbnail and full (§7); external-URL asset alternative.
- Sidebar tabs beyond Chat + sheets (Scenes/Actors/Items/Settings as tabs, scene navigation,
  player list) — full §10 list; GM join-approval dialog + ban list UI (auto-approve covers M1).
- JoinApp: hide the manual code panel automatically once transportKind()==="nostr" connects.
- Public-relay smoke (damus/nos.lol) as an optional, non-CI e2e; CI keeps the local relay.
